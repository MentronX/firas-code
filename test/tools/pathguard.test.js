import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { guardPath, isWithin, isSecretPath, isSystemPath, stateKey } from "../../src/tools/pathguard.js";
import { tmpProject } from "./helpers.js";

test("relative and absolute paths inside the project", () => {
  const p = tmpProject({ "src/a.js": "x" });
  try {
    const rel = guardPath("src/a.js", { cwd: p.dir });
    assert.equal(rel.ok, true);
    assert.equal(rel.abs, path.join(p.dir, "src", "a.js"));
    assert.equal(rel.inside, true);
    assert.equal(rel.rel, path.join("src", "a.js"));
    const abs = guardPath(path.join(p.dir, "src", "a.js"), { cwd: p.dir });
    assert.equal(abs.inside, true);
    assert.equal(guardPath(".", { cwd: p.dir }).rel, ".");
  } finally { p.cleanup(); }
});

test("both separators are understood", () => {
  const p = tmpProject({ "src/deep/a.js": "x" });
  try {
    for (const input of ["src/deep/a.js", "src\\deep\\a.js", "./src//deep/a.js"]) {
      const g = guardPath(process.platform === "win32" ? input : input.replace(/\\/g, "/"), { cwd: p.dir });
      assert.equal(g.abs, path.join(p.dir, "src", "deep", "a.js"), input);
      assert.equal(g.inside, true);
    }
  } finally { p.cleanup(); }
});

test("dot-dot escapes are outside", () => {
  const p = tmpProject();
  try {
    assert.equal(guardPath("../x.txt", { cwd: p.dir }).inside, false);
    assert.equal(guardPath("a/../../x.txt", { cwd: p.dir }).inside, false);
    assert.equal(guardPath("a/../b.txt", { cwd: p.dir }).inside, true);
    assert.equal(guardPath(os.tmpdir(), { cwd: p.dir }).inside, false);
  } finally { p.cleanup(); }
});

test("names that only share a prefix with the project are outside", () => {
  const p = tmpProject();
  try {
    const sibling = p.dir + "-evil";
    assert.equal(guardPath(path.join(sibling, "a"), { cwd: p.dir }).inside, false);
    assert.equal(isWithin(p.dir, path.join(p.dir, "..foo")), true);
    assert.equal(isWithin(p.dir, path.join(p.dir, "..", "foo")), false);
  } finally { p.cleanup(); }
});

test("NUL bytes and empty input are rejected", () => {
  assert.equal(guardPath("a\0b").ok, false);
  assert.equal(guardPath("a\0b").code, "nul");
  assert.equal(guardPath("").ok, false);
  assert.equal(guardPath("   ").ok, false);
  assert.equal(guardPath(42).ok, false);
});

test("surrounding quotes are stripped", () => {
  const p = tmpProject();
  try {
    assert.equal(guardPath('"a b/c.txt"', { cwd: p.dir }).abs, path.join(p.dir, "a b", "c.txt"));
    assert.equal(guardPath("'x.txt'", { cwd: p.dir }).abs, path.join(p.dir, "x.txt"));
  } finally { p.cleanup(); }
});

test("home shorthand expands and is outside the project", () => {
  const p = tmpProject();
  try {
    const g = guardPath("~/notes.txt", { cwd: p.dir, home: p.dir + "-home" });
    assert.equal(g.abs, path.join(p.dir + "-home", "notes.txt"));
    assert.equal(g.inside, false);
  } finally { p.cleanup(); }
});

test("Windows rules: UNC, device paths, reserved names, streams", () => {
  const opts = { cwd: "C:\\proj", platform: "win32" };
  assert.equal(guardPath("\\\\server\\share\\f.txt", opts).code, "unc");
  assert.equal(guardPath("//server/share/f.txt", opts).code, "unc");
  assert.equal(guardPath("\\\\.\\PhysicalDrive0", opts).code, "device");
  assert.equal(guardPath("\\\\?\\C:\\x", opts).code, "device");
  for (const name of ["CON", "nul", "NUL.txt", "com1", "COM9.log", "lpt3", "AUX", "prn", "src\\con\\a.js"]) {
    assert.equal(guardPath(name, opts).code, "reserved", name);
  }
  assert.equal(guardPath("file.txt:stream", opts).code, "stream");
  assert.equal(guardPath("name.", opts).code, "trailing");
  assert.equal(guardPath("name ", opts).abs, "C:\\proj\\name", "surrounding spaces are trimmed");
  assert.equal(guardPath("dir \\file.txt", opts).code, "trailing");
  assert.equal(guardPath("a?b.txt", opts).code, "illegal");
  assert.equal(guardPath("console.log", opts).ok, true, "console is not CON");
  assert.equal(guardPath("connect.js", opts).ok, true);
  assert.equal(guardPath("COM10.txt", opts).ok, true, "COM10 is an ordinary name");
});

test("Windows rules: comparison ignores case and accepts both separators", () => {
  const opts = { cwd: "C:\\Proj", platform: "win32" };
  const g = guardPath("c:/proj/SRC/a.js", opts);
  assert.equal(g.ok, true);
  assert.equal(g.inside, true);
  assert.equal(guardPath("D:\\other\\a.js", opts).inside, false);
  assert.equal(guardPath("..\\x.js", opts).inside, false);
  assert.equal(stateKey("C:\\Proj\\A.JS", "win32"), stateKey("c:/proj/a.js", "win32"));
  assert.notEqual(stateKey("/p/A.js", "linux"), stateKey("/p/a.js", "linux"));
});

test("a link that leaves the project is detected", () => {
  const p = tmpProject();
  const outside = tmpProject({ "secret.txt": "s" });
  try {
    const link = path.join(p.dir, "linked");
    try { fs.symlinkSync(outside.dir, link, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { return; /* no permission to make links here */ }
    const existing = guardPath("linked/secret.txt", { cwd: p.dir });
    assert.equal(existing.inside, false);
    assert.equal(existing.viaLink, true);
    const missing = guardPath("linked/new/file.txt", { cwd: p.dir });
    assert.equal(missing.inside, false, "a file that does not exist yet still resolves through the link");
    assert.equal(guardPath("plain/new.txt", { cwd: p.dir }).inside, true);
  } finally { p.cleanup(); outside.cleanup(); }
});

test("isSecretPath", () => {
  const yes = [".env", ".env.local", "app/.env.production", "key.pem", "server.key", "id_rsa", "id_rsa.pub", "id_ed25519", "~/.ssh/config",
    "C:\\Users\\a\\.ssh\\known_hosts", ".npmrc", ".git-credentials", "credentials.json", "home/.aws/credentials", "secrets.yaml", "cert.pfx", ".netrc", ".git/config", "repo/.git/config", "C:\\work\\app\\.git\\config", ".vault-token", "infra/terraform.tfstate", "prod.tfvars", ".my.cnf"];
  const no = [".env.example", ".env.sample", "environment.ts", "src/envelope.js", "README.md", "keyboard.js", "monkey.txt", "pem.txt", "package.json", "src/credentials-form.tsx", ".git/HEAD", ".gitignore", ".github/config", "docs/git/config.md", "terraform.tf"];
  for (const p of yes) assert.equal(isSecretPath(p), true, p);
  for (const p of no) assert.equal(isSecretPath(p), false, p);
});

test("isSystemPath", () => {
  const win = { platform: "win32", env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" } };
  for (const p of ["C:\\Windows", "C:\\Windows\\System32\\drivers\\etc\\hosts", "c:/program files/x/y.dll", "C:\\Program Files (x86)\\Z", "C:\\"]) assert.equal(isSystemPath(p, win), true, p);
  for (const p of ["C:\\Users\\a\\proj", "D:\\code", "C:\\Windows.old2\\x"]) assert.equal(isSystemPath(p, win), p === "C:\\Windows.old2\\x" ? false : false, p);
  const nix = { platform: "linux", env: {} };
  for (const p of ["/etc/passwd", "/usr/bin/node", "/", "/boot/vmlinuz", "/dev/sda", "/System/Library/x"]) assert.equal(isSystemPath(p, nix), true, p);
  for (const p of ["/home/a/proj", "/tmp/x", "/var/tmp/y", "/opt/app"]) assert.equal(isSystemPath(p, nix), false, p);
});
