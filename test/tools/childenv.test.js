// The access code (FIRAS_CODE) must never be inherited by a program the tools start: not by shell commands, not by
// background jobs, not by the search program, not by the process killers.
import { test } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./helpers.js";
import { childEnv } from "../../src/tools/common.js";
import { startProcess, runProcess } from "../../src/tools/runner.js";
import { resolveShell, killTree, killTreeSync } from "../../src/tools/shell.js";

const SECRET = "FC2-SECRET-DONOTLEAK";
const PRINT = "node -e \"process.stdout.write('code=[' + (process.env.FIRAS_CODE ?? process.env.firas_code ?? 'none') + ']')\"";

function withSecretInProcessEnv(fn) {
  return async () => {
    const before = process.env.FIRAS_CODE;
    process.env.FIRAS_CODE = SECRET;
    try { await fn(); } finally { if (before === undefined) delete process.env.FIRAS_CODE; else process.env.FIRAS_CODE = before; }
  };
}

test("childEnv removes the access code whatever its case, keeps everything else and leaves its input alone", () => {
  const input = { PATH: "/bin", FIRAS_CODE: SECRET, Firas_Code: SECRET, firas_code: SECRET, FIRAS_CODE_EXTRA: "keep", FIRAS_LANG: "ar", HOME: "/h" };
  const out = childEnv(input);
  assert.deepEqual(Object.keys(out).sort(), ["FIRAS_CODE_EXTRA", "FIRAS_LANG", "HOME", "PATH"]);
  assert.equal(input.FIRAS_CODE, SECRET, "the original is untouched");
  assert.deepEqual(childEnv({}), {});
  assert.ok(!("FIRAS_CODE" in childEnv()), "the default is the real environment");
});

test("childEnv with no argument is the process environment minus the code", withSecretInProcessEnv(() => {
  assert.equal(process.env.FIRAS_CODE, SECRET);
  const out = childEnv();
  assert.ok(!Object.keys(out).some(k => /^FIRAS_CODE$/i.test(k)));
  assert.ok(Object.keys(out).length > 3);
}));

test("startProcess hands its child no access code even when the caller passes one", withSecretInProcessEnv(async () => {
  const shell = resolveShell();
  const chunks = [];
  const done = await runProcess({ info: shell, command: PRINT, cwd: process.cwd(), env: { ...process.env, FIRAS_CODE: SECRET }, timeoutMs: 20_000, onChunk: text => chunks.push(text) });
  assert.equal(done.code, 0, chunks.join(""));
  assert.equal(chunks.join(""), "code=[none]");
  const viaDefault = [];
  await runProcess({ info: shell, command: PRINT, cwd: process.cwd(), env: undefined, timeoutMs: 20_000, onChunk: text => viaDefault.push(text) });
  assert.equal(viaDefault.join(""), "code=[none]", "an omitted environment does not mean 'inherit everything'");
}));

test("Bash (foreground and background) and BashOutput never show a child the access code", withSecretInProcessEnv(async () => {
  const s = setup(undefined, { ctx: { env: { ...process.env, FIRAS_CODE: SECRET, firas_code: SECRET } } });
  try {
    const fg = await s.call("Bash", { command: PRINT });
    assert.equal(fg.ok, true, fg.content);
    assert.match(fg.content, /code=\[none\]/);
    assert.ok(!fg.content.includes(SECRET));
    const bg = await s.call("Bash", { command: PRINT, run_in_background: true });
    assert.equal(bg.ok, true, bg.content);
    const id = /bg\d+/.exec(bg.content)[0];
    const job = s.toolbox.byName.get("Bash").jobs.get(id);
    await job.finished;
    const out = await s.call("BashOutput", { job_id: id });
    assert.match(out.content, /code=\[none\]/);
    assert.ok(!out.content.includes(SECRET));
  } finally { s.cleanup(); }
}));

/** Replaces the spawn functions the tools use with recorders that run nothing. */
function recordSpawns(fn) {
  return async () => {
    const calls = [];
    const original = { spawn: cp.spawn, spawnSync: cp.spawnSync };
    const fakeChild = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      child.pid = 4242;
      setImmediate(() => child.emit("close", 1));
      return child;
    };
    cp.spawn = (file, args, options) => { calls.push({ kind: "spawn", file, args, options }); return fakeChild(); };
    cp.spawnSync = (file, args, options) => { calls.push({ kind: "spawnSync", file, args, options }); return { status: 0 }; };
    syncBuiltinESMExports();
    try { await fn(calls); } finally {
      cp.spawn = original.spawn;
      cp.spawnSync = original.spawnSync;
      syncBuiltinESMExports();
    }
  };
}

test("Grep starts the search program without the access code", withSecretInProcessEnv(recordSpawns(async calls => {
  // A file named rg on a PATH of its own is enough for the tool to decide to use it; nothing is executed.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fc2-fakerg-"));
  const exe = path.join(bin, process.platform === "win32" ? "rg.exe" : "rg");
  fs.writeFileSync(exe, "");
  fs.chmodSync(exe, 0o755);
  const env = { ...process.env, PATH: bin, Path: bin, PATHEXT: ".EXE", FIRAS_NO_RG: "0", FIRAS_CODE: SECRET };
  const s = setup({ "a.txt": "needle\n" }, { ctx: { env } });
  try {
    await s.call("Grep", { pattern: "needle" });
    const rg = calls.find(c => c.kind === "spawn" && path.basename(c.file).toLowerCase().startsWith("rg"));
    assert.ok(rg, "the search program was started");
    assert.ok(rg.options.env, "an explicit environment was given");
    assert.ok(!Object.keys(rg.options.env).some(k => /^FIRAS_CODE$/i.test(k)), "no access code in it");
    assert.equal(rg.options.env.FIRAS_NO_RG, "0", "everything else is passed on");
  } finally { s.cleanup(); fs.rmSync(bin, { recursive: true, force: true }); }
})));

test("the process killers get the system's own program by full path, without the access code", withSecretInProcessEnv(recordSpawns(async calls => {
  await killTree(4242, { platform: "win32" });
  killTreeSync(4242, { platform: "win32" });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.file, /^[A-Za-z]:\\.*\\System32\\taskkill\.exe$/i, "full path: a bare name would be looked up in the current folder first");
    assert.deepEqual(call.args, ["/pid", "4242", "/T", "/F"]);
    assert.ok(call.options.env && !Object.keys(call.options.env).some(k => /^FIRAS_CODE$/i.test(k)));
  }
})));

test("nothing the tools spawn is started with a bare Windows program name or through a shell option", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools");
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    assert.ok(!/shell:\s*true/.test(text), `${name} starts a program through a shell`);
    assert.ok(!/spawn(Sync)?\(\s*["'](taskkill|icacls|whoami|powershell|cmd)["']/.test(text), `${name} starts a Windows program by bare name`);
  }
});
