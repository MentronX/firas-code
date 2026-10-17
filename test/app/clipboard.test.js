import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { clipboardCandidates, copyToClipboard } from "../../src/commands/clipboard.js";

function fakeSpawn(plan) {
  const calls = [];
  const spawn = (file, args, options) => {
    const step = plan[file] ?? { missing: true };
    calls.push({ file, args, options });
    const child = new EventEmitter();
    const chunks = [];
    child.stdin = new EventEmitter();
    child.stdin.end = buf => { chunks.push(buf); child.input = Buffer.concat(chunks).toString("utf8"); setImmediate(() => child.emit(step.missing ? "error" : "close", step.missing ? new Error("ENOENT") : step.code ?? 0)); };
    child.kill = () => {};
    spawn.last = child;
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test("each platform has its own list of clipboard programs", () => {
  assert.deepEqual(clipboardCandidates({ platform: "win32" }).map(c => c.file), ["powershell.exe", "pwsh"]);
  assert.deepEqual(clipboardCandidates({ platform: "darwin" }).map(c => c.file), ["pbcopy"]);
  assert.deepEqual(clipboardCandidates({ platform: "linux", env: { WAYLAND_DISPLAY: "w0" } }).map(c => c.file), ["wl-copy", "xclip", "xsel"]);
  assert.deepEqual(clipboardCandidates({ platform: "linux", env: {} }).map(c => c.file), ["xclip", "xsel", "wl-copy"]);
});

test("Windows reads its input as UTF-8 and never uses clip.exe", () => {
  const [first] = clipboardCandidates({ platform: "win32" });
  assert.match(first.args.join(" "), /UTF8Encoding/);
  assert.ok(!clipboardCandidates({ platform: "win32" }).some(c => /clip/i.test(c.file)));
});

test("the text is sent to the program as UTF-8, whole, with nothing added", async () => {
  const spawn = fakeSpawn({ pbcopy: { code: 0 } });
  const text = "مرحبا بالعالم 123\nline two `npm test`\n";
  const result = await copyToClipboard(text, { platform: "darwin", spawn });
  assert.deepEqual(result, { ok: true, tool: "pbcopy" });
  assert.equal(spawn.last.input, text);
});

test("a missing program falls through to the next one; all missing is a clean failure", async () => {
  const spawn = fakeSpawn({ xsel: { code: 0 } });
  assert.deepEqual(await copyToClipboard("x", { platform: "linux", env: {}, spawn }), { ok: true, tool: "xsel" });
  assert.deepEqual(spawn.calls.map(c => c.file), ["xclip", "xsel"]);
  const none = fakeSpawn({});
  assert.deepEqual(await copyToClipboard("x", { platform: "linux", env: {}, spawn: none }), { ok: false, tool: "" });
});

test("the clipboard program is started without the access code", async () => {
  const spawn = fakeSpawn({ pbcopy: { code: 0 } });
  await copyToClipboard("x", { platform: "darwin", env: { PATH: "/bin", FIRAS_CODE: "FC2-NOT-FOR-THE-CLIPBOARD" }, spawn });
  const { env } = spawn.calls[0].options;
  assert.equal(env.PATH, "/bin");
  assert.ok(!Object.keys(env).some(key => /^firas_code$/i.test(key)), "no access code in the environment");
});

test("a program that exits with an error counts as missing", async () => {
  const spawn = fakeSpawn({ pbcopy: { code: 1 } });
  assert.equal((await copyToClipboard("x", { platform: "darwin", spawn })).ok, false);
});

test("on Windows the real clipboard gets the exact text back, Arabic and newlines included", { skip: process.platform !== "win32" }, async () => {
  const read = () => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"], { encoding: "utf8" }).stdout;
  const before = read();
  const text = "مرحبا بالعالم — ملف src/app.js يحتوي 3 دوال\nسطر ثانٍ with `code` and emoji 😀\n";
  try {
    const result = await copyToClipboard(text, {});
    assert.equal(result.ok, true);
    // Get-Clipboard -Raw prints the text followed by one extra line break of its own.
    assert.equal(read().replace(/\r?\n$/, ""), text);
  } finally {
    // put the person's own clipboard text back
    const restore = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t";
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", restore], { input: Buffer.from(before.replace(/\r?\n$/, ""), "utf8") });
  }
});
