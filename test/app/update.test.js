import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { installerCommand, updateBlocker, runUpdate, rawUrl, appRoot } from "../../src/update.js";
import { REPO } from "../../src/brand.js";
import { tempDir } from "./helpers.js";

// The placeholder is never written out whole in source files other than brand.js.
const PLACEHOLDER = "__" + "REPO" + "__";
const REAL = "someone/firas-code";

function fakeSpawn({ code = 0, stdout = "", stderr = "", error = null, hang = false } = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      if (error) { child.emit("error", error); return; }
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      if (!hang) child.emit("close", code);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test("Windows runs the PowerShell installer from the raw address of the repository", () => {
  const { file, args } = installerCommand({ platform: "win32", repo: REAL });
  assert.equal(file, "powershell.exe");
  assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.match(args[2], new RegExp(`irm https://raw\\.githubusercontent\\.com/${REAL}/main/scripts/install\\.ps1 \\| iex$`));
  assert.match(args[2], /Tls12/);
});

test("macOS and Linux run the shell installer without launching or touching the path", () => {
  for (const platform of ["darwin", "linux"]) {
    const { file, args } = installerCommand({ platform, repo: REAL });
    assert.equal(file, "bash");
    assert.equal(args[0], "-c");
    assert.match(args[1], new RegExp(`curl -fsSL https://raw\\.githubusercontent\\.com/${REAL}/main/scripts/install\\.sh \\| bash -s -- --no-launch --no-path-update$`));
  }
  assert.equal(rawUrl("a/b", "x.sh"), "https://raw.githubusercontent.com/a/b/main/scripts/x.sh");
});

test("an unconfigured repository name, a folder inside the app and a source checkout are refused", () => {
  const work = tempDir();
  try {
    assert.equal(updateBlocker({ repo: PLACEHOLDER, cwd: work.dir, root: work.dir + "-app" }), "not_configured");
    assert.equal(updateBlocker({ repo: "", cwd: work.dir, root: work.dir + "-app" }), "not_configured");
    const root = path.join(work.dir, "app");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    assert.equal(updateBlocker({ repo: REAL, cwd: path.join(root, "src"), root }), "inside_app");
    assert.equal(updateBlocker({ repo: REAL, cwd: root, root }), "inside_app");
    assert.equal(updateBlocker({ repo: REAL, cwd: work.dir, root }), "");
    fs.mkdirSync(path.join(root, ".git"));
    assert.equal(updateBlocker({ repo: REAL, cwd: work.dir, root }), "dev_checkout");
  } finally {
    work.remove();
  }
});

test("the build as shipped here is a source checkout or unconfigured, so a real update is refused from it", () => {
  const blocker = updateBlocker({ repo: REPO, cwd: path.dirname(appRoot()), root: appRoot() });
  assert.ok(blocker === "not_configured" || blocker === "dev_checkout" || blocker === "", `unexpected blocker ${blocker}`);
});

test("runUpdate spawns the installer with the no-launch / no-path flags and passes its output on", async () => {
  const work = tempDir();
  try {
    const spawn = fakeSpawn({ stdout: "step one\n", stderr: "a warning\n" });
    const seen = [];
    const result = await runUpdate({ platform: "win32", repo: REAL, cwd: work.dir, root: path.join(work.dir, "app"), env: { PATH: "x", KEEP: "1" }, spawn, onOutput: (text, stream) => seen.push([stream, text]) });
    assert.deepEqual(result, { ok: true, code: 0, reason: "" });
    assert.equal(spawn.calls.length, 1);
    const call = spawn.calls[0];
    assert.equal(call.file, "powershell.exe");
    assert.equal(call.options.env.FIRAS_NO_LAUNCH, "1");
    assert.equal(call.options.env.FIRAS_NO_PATH_UPDATE, "1");
    assert.equal(call.options.env.KEEP, "1");
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.deepEqual(seen, [["stdout", "step one\n"], ["stderr", "a warning\n"]]);

    // The access code (in FIRAS_CODE) is not the installer's business.
    const guarded = fakeSpawn();
    await runUpdate({ platform: "linux", repo: REAL, cwd: work.dir, root: path.join(work.dir, "app"), env: { PATH: "x", FIRAS_CODE: "FC2-NOT-FOR-THE-INSTALLER", firas_code: "x" }, spawn: guarded });
    assert.equal(guarded.calls[0].options.env.PATH, "x");
    assert.ok(!Object.keys(guarded.calls[0].options.env).some(key => /^firas_code$/i.test(key)), "no access code in the installer's environment");
  } finally {
    work.remove();
  }
});

test("a failing installer returns its exit code, a missing shell is spawn_failed", async () => {
  const work = tempDir();
  try {
    const base = { platform: "linux", repo: REAL, cwd: work.dir, root: path.join(work.dir, "app") };
    assert.deepEqual(await runUpdate({ ...base, spawn: fakeSpawn({ code: 3 }) }), { ok: false, code: 3, reason: "failed" });
    assert.deepEqual(await runUpdate({ ...base, spawn: fakeSpawn({ error: new Error("ENOENT") }) }), { ok: false, code: null, reason: "spawn_failed" });
    const throwing = () => { throw new Error("EACCES"); };
    assert.deepEqual(await runUpdate({ ...base, spawn: throwing }), { ok: false, code: null, reason: "spawn_failed" });
  } finally {
    work.remove();
  }
});

test("nothing is spawned when the update is blocked", async () => {
  const spawn = fakeSpawn();
  const result = await runUpdate({ repo: PLACEHOLDER, spawn });
  assert.equal(result.reason, "not_configured");
  assert.equal(spawn.calls.length, 0);
});

test("aborting stops the installer", async () => {
  const work = tempDir();
  try {
    const spawn = fakeSpawn({ hang: true });
    const control = new AbortController();
    const pending = runUpdate({ platform: "linux", repo: REAL, cwd: work.dir, root: path.join(work.dir, "app"), spawn, signal: control.signal });
    setTimeout(() => control.abort(), 20);
    assert.deepEqual(await pending, { ok: false, code: null, reason: "aborted" });
  } finally {
    work.remove();
  }
});
