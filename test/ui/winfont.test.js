import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FONT_SCRIPT, WANTED_FONT, fixConsoleFont, fontStillBroken, isModernTerminal, parseFontResult, shouldFixConsoleFont } from "../../src/ui/winfont.js";

const tty = { isTTY: true };

test("only the classic Windows console on a real terminal is touched", () => {
  assert.equal(shouldFixConsoleFont({ platform: "win32", env: {}, stdout: tty }), true);
  assert.equal(shouldFixConsoleFont({ platform: "linux", env: {}, stdout: tty }), false);
  assert.equal(shouldFixConsoleFont({ platform: "darwin", env: {}, stdout: tty }), false);
  assert.equal(shouldFixConsoleFont({ platform: "win32", env: {}, stdout: { isTTY: false } }), false, "a pipe has no font");
  assert.equal(shouldFixConsoleFont({ platform: "win32", env: {}, stdout: null }), false);
  for (const env of [{ WT_SESSION: "1" }, { TERM_PROGRAM: "vscode" }, { ConEmuANSI: "ON" }, { TERM: "xterm-256color" }, { WEZTERM_EXECUTABLE: "x" }]) {
    assert.equal(isModernTerminal(env), true, JSON.stringify(env));
    assert.equal(shouldFixConsoleFont({ platform: "win32", env, stdout: tty }), false, "modern terminals pick a fallback font themselves");
  }
  for (const value of ["keep", "KEEP", "off", "0", "no"]) {
    assert.equal(shouldFixConsoleFont({ platform: "win32", env: { FIRAS_FONT: value }, stdout: tty }), false, value);
  }
});

test("the script's one line is read whatever surrounds it", () => {
  assert.deepEqual(parseFontResult("set|Terminal|Courier New\r\n"), { status: "set", from: "Terminal", to: "Courier New" });
  assert.deepEqual(parseFontResult("\r\n  keep|Courier New  \r\n"), { status: "keep", from: "Courier New", to: "Courier New" });
  assert.deepEqual(parseFontResult("nofont|Consolas"), { status: "nofont", from: "Consolas", to: "" });
  assert.deepEqual(parseFontResult("failed|Terminal"), { status: "failed", from: "Terminal", to: "" });
  assert.deepEqual(parseFontResult("noconsole"), { status: "noconsole", from: "", to: "" });
  assert.equal(parseFontResult("error|Access is denied").detail, "Access is denied");
  assert.equal(parseFontResult("").status, "error");
  assert.equal(parseFontResult("something else").status, "error");
  assert.equal(fontStillBroken({ status: "nofont" }), true);
  assert.equal(fontStillBroken({ status: "failed" }), true);
  for (const status of ["set", "keep", "error", "timeout", "noconsole"]) assert.equal(fontStillBroken({ status }), false, status);
  assert.equal(fontStillBroken(null), false);
});

test("the script survives any quoting on the way: no double quotes, no backticks, nothing left to fill in", () => {
  assert.equal(FONT_SCRIPT.includes('"'), false);
  assert.equal(FONT_SCRIPT.includes("`"), false);
  assert.ok(FONT_SCRIPT.includes(`$want = '${WANTED_FONT}'`));
  assert.ok(FONT_SCRIPT.includes("'CONOUT$'"), "it reaches the screen itself, its own output is a pipe");
  assert.ok(FONT_SCRIPT.includes("SetCurrentConsoleFontEx") && FONT_SCRIPT.includes("GetCurrentConsoleFontEx"));
  assert.equal(/undefined|\$\{/.test(FONT_SCRIPT), false);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdout.unref = () => { child.stdoutUnref = true; };
  child.unref = () => { child.unrefd = true; };
  child.kill = () => { child.killed = true; };
  return child;
}

test("fixConsoleFont runs the script in this console and reports what it did", async () => {
  const calls = [];
  const child = fakeChild();
  const spawn = (file, args, options) => { calls.push({ file, args, options }); return child; };
  const pending = fixConsoleFont({ spawn, env: { PATH: "x", FIRAS_CODE: "FC2-SECRET" } });
  child.stdout.emit("data", "set|Terminal|");
  child.stdout.emit("data", "Courier New\r\n");
  child.emit("close", 0);
  assert.deepEqual(await pending, { status: "set", from: "Terminal", to: "Courier New" });
  const [{ file, args, options }] = calls;
  assert.equal(file, "powershell.exe");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(args[3], FONT_SCRIPT);
  assert.equal(options.windowsHide, undefined, "a hidden child gets no console, and this one must change ours");
  assert.equal(options.stdio[0], "ignore");
  assert.equal(options.stdio[1], "pipe");
  assert.equal(options.env.FIRAS_CODE, undefined, "the access code never reaches a child process");
  assert.equal(options.env.PATH, "x");
  assert.equal(options.env.FIRAS_TITLE, undefined, "no title to put back unless the app has one");
  assert.ok(child.unrefd && child.stdoutUnref, "leaving the app never waits for it");
  assert.ok(FONT_SCRIPT.indexOf("[Console]::Title = $env:FIRAS_TITLE") < FONT_SCRIPT.indexOf("DefineDynamicAssembly"), "the title is put back first thing");

  const titled = fakeChild();
  let seen;
  const p = fixConsoleFont({ spawn: (f, a, o) => { seen = o; return titled; }, env: {}, title: "Firas Code 2 - my-app" });
  titled.emit("close", 0);
  await p;
  assert.equal(seen.env.FIRAS_TITLE, "Firas Code 2 - my-app");
});

test("fixConsoleFont never rejects: a missing program, a failure to start and a hang all resolve", async () => {
  const broken = fakeChild();
  const p1 = fixConsoleFont({ spawn: () => broken });
  broken.emit("error", new Error("ENOENT"));
  assert.equal((await p1).status, "error");

  const p2 = fixConsoleFont({ spawn: () => { throw new Error("spawn EPERM"); } });
  assert.equal((await p2).status, "error");

  const stuck = fakeChild();
  const p3 = fixConsoleFont({ spawn: () => stuck, timeoutMs: 20 });
  assert.equal((await p3).status, "timeout");
  assert.equal(stuck.killed, true);
});
