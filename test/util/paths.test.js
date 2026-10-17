// writePrivate and the Windows file-permission hardening behind it. The hardening is tested with an injected spawn
// function (nothing real is changed) plus one Windows-only test on a folder the test creates itself.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writePrivate, restrictToOwner, forgetRestrictions, windowsSystemTool, isInside } from "../../src/util/paths.js";

const ENV = { USERDOMAIN: "DESKTOP-TEST", USERNAME: "Firas", SystemRoot: "C:\\Windows" };
const ICACLS = "C:\\Windows\\System32\\icacls.exe";

let work;
let prevHome;

beforeEach(() => {
  forgetRestrictions();
  prevHome = process.env.FIRAS_HOME;
  work = fs.mkdtempSync(path.join(os.tmpdir(), "fc2-paths-"));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.FIRAS_HOME; else process.env.FIRAS_HOME = prevHome;
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A spawn stand-in that records every call and answers like a successful icacls (or like whatever `reply` says). */
function recorder(reply = () => ({ status: 0 })) {
  const calls = [];
  const spawnSync = (file, args, options) => { calls.push({ file, args, options, existsThen: typeof args[0] === "string" && fs.existsSync(args[0]) }); return reply(file, args, options); };
  return { calls, spawnSync };
}

test("nothing happens off Windows", () => {
  const spy = recorder();
  assert.equal(restrictToOwner(work, { platform: "linux", env: ENV, spawnSync: spy.spawnSync }), false);
  assert.equal(restrictToOwner(work, { platform: "darwin", env: ENV, spawnSync: spy.spawnSync }), false);
  assert.equal(spy.calls.length, 0);
});

test("a folder is limited to the current user with icacls, called without a shell and by full path", () => {
  const spy = recorder();
  assert.equal(restrictToOwner(work, { platform: "win32", env: ENV, spawnSync: spy.spawnSync, directory: true }), true);
  assert.equal(spy.calls.length, 1);
  const [call] = spy.calls;
  assert.equal(call.file, ICACLS, "the system's icacls by full path: a bare name is looked up in the current folder first");
  assert.deepEqual(call.args, [work, "/inheritance:r", "/grant:r", "DESKTOP-TEST\\Firas:(OI)(CI)(F)"]);
  assert.ok(!call.options.shell, "no shell");
  assert.equal(call.options.windowsHide, true);
  assert.ok(call.options.timeout > 0, "a hung icacls cannot hang a save");
  const withCode = recorder();
  forgetRestrictions();
  restrictToOwner(work, { platform: "win32", env: { ...ENV, FIRAS_CODE: "FC2-NOT-FOR-ICACLS" }, spawnSync: withCode.spawnSync, directory: true, fresh: true });
  assert.ok(!Object.keys(withCode.calls[0].options.env).some(key => /^firas_code$/i.test(key)), "no access code in its environment");
  assert.equal(withCode.calls[0].options.env.SystemRoot, "C:\\Windows");
});

test("a file gets a plain full-control entry, and each path is tried only once", () => {
  const file = path.join(work, "config.json");
  fs.writeFileSync(file, "{}");
  const spy = recorder();
  const options = { platform: "win32", env: ENV, spawnSync: spy.spawnSync };
  assert.equal(restrictToOwner(file, options), true);
  assert.deepEqual(spy.calls[0].args, [file, "/inheritance:r", "/grant:r", "DESKTOP-TEST\\Firas:(F)"]);
  assert.equal(restrictToOwner(file, options), true, "the answer is remembered");
  assert.equal(restrictToOwner(path.join(work, "CONFIG.JSON"), options), true, "case does not matter on Windows");
  assert.equal(spy.calls.length, 1, "a second save costs nothing");
  assert.equal(restrictToOwner(file, { ...options, fresh: true }), true);
  assert.equal(spy.calls.length, 2, "fresh forces another try");
});

test("a failing or missing icacls is silent and never throws", () => {
  const missing = recorder(() => ({ error: Object.assign(new Error("spawn icacls ENOENT"), { code: "ENOENT" }), status: null }));
  assert.equal(restrictToOwner(work, { platform: "win32", env: ENV, spawnSync: missing.spawnSync, directory: true }), false);
  const refused = recorder(() => ({ status: 5 }));
  assert.equal(restrictToOwner(path.join(work, "a"), { platform: "win32", env: ENV, spawnSync: refused.spawnSync, directory: false }), false);
  const exploding = { spawnSync: () => { throw new Error("boom"); } };
  assert.equal(restrictToOwner(path.join(work, "b"), { platform: "win32", env: ENV, spawnSync: exploding.spawnSync, directory: false }), false);
  assert.equal(restrictToOwner(undefined, { platform: "win32", env: ENV, spawnSync: exploding.spawnSync }), false);
});

test("without USERDOMAIN and USERNAME the system is asked who the user is; an odd answer means no change", () => {
  const ask = recorder(file => (file.endsWith("whoami.exe") ? { status: 0, stdout: "CORP\\maryam\r\n" } : { status: 0 }));
  assert.equal(restrictToOwner(work, { platform: "win32", env: { SystemRoot: "C:\\Windows" }, spawnSync: ask.spawnSync, directory: true }), true);
  assert.equal(ask.calls[0].file, "C:\\Windows\\System32\\whoami.exe");
  assert.equal(ask.calls[1].args[3], "CORP\\maryam:(OI)(CI)(F)");
  forgetRestrictions();
  const odd = recorder(file => (file.endsWith("whoami.exe") ? { status: 0, stdout: "not a user name" } : { status: 0 }));
  assert.equal(restrictToOwner(work, { platform: "win32", env: {}, spawnSync: odd.spawnSync, directory: true }), false);
  assert.equal(odd.calls.length, 1, "icacls was never started");
});

test("if the user cannot reach the folder afterwards, the change is undone", () => {
  const notAFolder = path.join(work, "file.txt");
  fs.writeFileSync(notAFolder, "x");
  const spy = recorder();
  // Told it is a folder, the file cannot be listed: it stands for 'we locked ourselves out'.
  assert.equal(restrictToOwner(notAFolder, { platform: "win32", env: ENV, spawnSync: spy.spawnSync, directory: true }), false);
  assert.deepEqual(spy.calls.map(c => c.args[1]), ["/inheritance:r", "/reset"]);
});

test("windowsSystemTool never depends on the current folder or PATH", () => {
  assert.equal(windowsSystemTool("icacls", { SystemRoot: "D:\\WIN" }), "D:\\WIN\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("taskkill", { windir: "E:\\W" }), "E:\\W\\System32\\taskkill.exe");
  assert.equal(windowsSystemTool("whoami", {}), "C:\\Windows\\System32\\whoami.exe");
});

test("writePrivate limits the app's own folder once, before the first file exists", () => {
  const home = path.join(work, ".firas-code");
  process.env.FIRAS_HOME = home;
  const file = path.join(home, "sessions", "one.json");
  let fileExistedWhenLimited = null;
  const spy = recorder(() => { fileExistedWhenLimited = fs.existsSync(file); return { status: 0 }; });
  const acl = { platform: "win32", env: ENV, spawnSync: spy.spawnSync };
  writePrivate(file, "first", { acl });
  assert.equal(fileExistedWhenLimited, false, "the folder was limited before the first secret was written");
  writePrivate(file, "second", { acl });
  writePrivate(path.join(home, "config.json"), "{}", { acl });
  assert.equal(fs.readFileSync(file, "utf8"), "second");
  assert.equal(spy.calls.length, 1, "one icacls call for the whole life of the process");
  assert.equal(spy.calls[0].args[0], home);
  assert.equal(spy.calls[0].args[3], "DESKTOP-TEST\\Firas:(OI)(CI)(F)");
  assert.equal(spy.calls[0].existsThen, true, "the folder exists");
  assert.deepEqual(fs.readdirSync(home).sort(), ["config.json", "sessions"], "no temporary file is left behind");
});

test("a folder that holds anything but the app's own files is not changed as a whole; each new file is limited before it replaces the old one", () => {
  const home = path.join(work, "somebodys-project");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "package.json"), "{}");
  process.env.FIRAS_HOME = home;
  const spy = recorder();
  const acl = { platform: "win32", env: ENV, spawnSync: spy.spawnSync };
  const file = path.join(home, "config.json");
  writePrivate(file, "one", { acl });
  writePrivate(file, "two", { acl });
  assert.equal(spy.calls.length, 2, "the replacement would otherwise bring back the folder's list, so it is done on every write");
  for (const call of spy.calls) {
    assert.notEqual(call.args[0], home, "the folder itself is left alone");
    assert.match(call.args[0], /config\.json\.\d+\.tmp$/, "the new file is limited before it takes the old one's place");
    assert.equal(call.existsThen, true);
    assert.equal(call.args[3], "DESKTOP-TEST\\Firas:(F)");
  }
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.deepEqual(fs.readdirSync(home).sort(), ["config.json", "package.json"]);
});

test("a drive-root-like FIRAS_HOME is never touched as a folder", () => {
  const spy = recorder();
  const acl = { platform: "win32", env: ENV, spawnSync: spy.spawnSync };
  process.env.FIRAS_HOME = path.parse(work).root;
  // The file is written under a folder of our own so nothing real is touched; only the decision about the root matters.
  const target = path.join(work, "x.json");
  writePrivate(target, "{}", { acl });
  assert.ok(spy.calls.every(call => call.args[0] !== path.parse(work).root));
});

test("writePrivate still writes the file when the hardening fails or explodes", () => {
  const home = path.join(work, ".firas-code");
  process.env.FIRAS_HOME = home;
  const file = path.join(home, "config.json");
  writePrivate(file, "a", { acl: { platform: "win32", env: ENV, spawnSync: () => { throw new Error("boom"); } } });
  assert.equal(fs.readFileSync(file, "utf8"), "a");
  forgetRestrictions();
  writePrivate(file, "b", { acl: { platform: "win32", env: ENV, spawnSync: () => ({ error: new Error("ENOENT"), status: null }) } });
  assert.equal(fs.readFileSync(file, "utf8"), "b");
});

test("off Windows writePrivate does exactly what it did before: no icacls, mode 0600", () => {
  const home = path.join(work, ".firas-code");
  process.env.FIRAS_HOME = home;
  const spy = recorder();
  const file = path.join(home, "sessions", "s.json");
  writePrivate(file, "x", { acl: { platform: "linux", env: ENV, spawnSync: spy.spawnSync } });
  assert.equal(spy.calls.length, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "x");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("isInside compares folders, not prefixes", () => {
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a/b"), true);
});

test("on Windows a real folder ends up readable by the current user alone, and new files inherit that", { skip: process.platform !== "win32" && "Windows only" }, () => {
  const home = path.join(work, ".firas-code");
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const old = path.join(home, "sessions", "old.json");
  fs.writeFileSync(old, "old");
  process.env.FIRAS_HOME = home;
  const file = path.join(home, "sessions", "new.json");
  writePrivate(file, "secret");

  const list = target => spawnSync(windowsSystemTool("icacls"), [target], { encoding: "utf8" }).stdout;
  const me = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`.toLowerCase();
  for (const target of [home, file, old]) {
    const text = list(target).toLowerCase();
    assert.ok(text.includes(me), `${target} names the user: ${text}`);
    for (const other of ["builtin\\administrators", "nt authority\\system", "builtin\\users", "everyone", "authenticated users"]) {
      assert.ok(!text.includes(other), `${target} still lists ${other}: ${text}`);
    }
  }
  assert.equal(fs.readFileSync(file, "utf8"), "secret", "the owner can still read it");
  writePrivate(file, "again");
  assert.equal(fs.readFileSync(file, "utf8"), "again");
});
