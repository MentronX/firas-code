import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolveShell, buildInvocation, killTree, processAlive } from "../../src/tools/shell.js";
import { runProcess, cleanOutput, OutputBuffer, RingBuffer } from "../../src/tools/runner.js";
import "./helpers.js";

const winEnv = (extra = {}) => ({
  PATH: "C:\\Windows\\System32;C:\\Windows;C:\\Tools",
  SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ...extra,
});
const present = (...files) => file => files.map(f => f.toLowerCase()).includes(String(file).toLowerCase());

test("Windows: Git Bash from the usual install folder", () => {
  const s = resolveShell({ platform: "win32", env: winEnv(), exists: present("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\bash.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") });
  assert.equal(s.kind, "bash");
  assert.equal(s.name, "Git Bash");
  assert.equal(s.path, "C:\\Program Files\\Git\\bin\\bash.exe");
});

test("Windows: the WSL launcher on PATH is never chosen", () => {
  const env = winEnv({ PATH: "C:\\Windows\\System32;C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps" });
  const s = resolveShell({ platform: "win32", env, exists: present("C:\\Windows\\System32\\bash.exe", "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe") });
  assert.equal(s.kind, "powershell");
});

test("Windows: bash.exe on PATH wins, and so does one found next to git.exe", () => {
  const onPath = resolveShell({ platform: "win32", env: winEnv({ PATH: "C:\\Tools\\bin;C:\\Windows\\System32" }), exists: present("C:\\Tools\\bin\\bash.exe") });
  assert.equal(onPath.path, "C:\\Tools\\bin\\bash.exe");
  const viaGit = resolveShell({ platform: "win32", env: winEnv({ PATH: "D:\\Apps\\Git\\cmd;C:\\Windows\\System32" }), exists: present("D:\\Apps\\Git\\cmd\\git.exe", "D:\\Apps\\Git\\bin\\bash.exe") });
  assert.equal(viaGit.path, "D:\\Apps\\Git\\bin\\bash.exe");
  const mingw = resolveShell({ platform: "win32", env: winEnv({ PATH: "D:\\Apps\\Git\\mingw64\\bin;C:\\Windows\\System32" }), exists: present("D:\\Apps\\Git\\mingw64\\bin\\git.exe", "D:\\Apps\\Git\\bin\\bash.exe") });
  assert.equal(mingw.path, "D:\\Apps\\Git\\bin\\bash.exe");
});

test("Windows: PowerShell 7 is preferred, then Windows PowerShell, then cmd", () => {
  const env = winEnv({ PATH: "C:\\PS7;C:\\Windows\\System32" });
  assert.equal(resolveShell({ platform: "win32", env, exists: present("C:\\PS7\\pwsh.exe", "C:\\Windows\\System32\\powershell.exe") }).path, "C:\\PS7\\pwsh.exe");
  const classic = resolveShell({ platform: "win32", env, exists: present("C:\\Windows\\System32\\powershell.exe") });
  assert.equal(classic.kind, "powershell");
  assert.match(classic.name, /Windows PowerShell/);
  const none = resolveShell({ platform: "win32", env: winEnv({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }), exists: () => false });
  assert.equal(none.kind, "cmd");
  assert.match(none.path, /cmd\.exe$/i);
});

test("POSIX: $SHELL when it is a POSIX shell, else bash, else sh", () => {
  assert.equal(resolveShell({ platform: "linux", env: { SHELL: "/bin/zsh" }, exists: present("/bin/zsh", "/bin/bash") }).kind, "zsh");
  assert.equal(resolveShell({ platform: "linux", env: { SHELL: "/usr/bin/fish" }, exists: present("/usr/bin/fish", "/bin/bash") }).path, "/bin/bash");
  assert.equal(resolveShell({ platform: "linux", env: {}, exists: present("/bin/sh") }).path, "/bin/sh");
  assert.equal(resolveShell({ platform: "darwin", env: { SHELL: "/bin/bash" }, exists: present("/bin/bash") }).kind, "bash");
});

test("every shell description names the shell and its syntax", () => {
  for (const s of [resolveShell({ platform: "linux", env: {}, exists: present("/bin/bash") }), resolveShell({ platform: "win32", env: winEnv(), exists: () => false })]) {
    assert.ok(s.label.includes(s.path));
    assert.ok(s.syntax.length > 20);
  }
});

test("invocations: bash, PowerShell (encoded, UTF-8, exit code), cmd (verbatim)", () => {
  const bash = buildInvocation({ kind: "bash", path: "/bin/bash" }, "echo 'a b'");
  assert.deepEqual(bash.args, ["-c", "echo 'a b'"]);
  const ps = buildInvocation({ kind: "powershell", path: "powershell.exe" }, "Write-Output \"مرحبا\"");
  assert.equal(ps.args[ps.args.indexOf("-EncodedCommand") - 1], "Bypass");
  assert.ok(ps.args.includes("-NoProfile") && ps.args.includes("-NonInteractive"));
  const script = Buffer.from(ps.args[ps.args.length - 1], "base64").toString("utf16le");
  assert.ok(script.includes("Write-Output \"مرحبا\""));
  assert.ok(script.includes("UTF8Encoding"));
  assert.ok(script.includes("$LASTEXITCODE"));
  const cmd = buildInvocation({ kind: "cmd", path: "cmd.exe" }, "dir");
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  assert.deepEqual(cmd.args.slice(0, 3), ["/d", "/s", "/c"]);
});

test("cleanOutput strips colour codes and collapses carriage-return progress", () => {
  assert.equal(cleanOutput("\u001b[31mred\u001b[0m text"), "red text");
  assert.equal(cleanOutput("a\r\nb"), "a\nb");
  assert.equal(cleanOutput("10%\r50%\r100%\ndone"), "100%\ndone");
  assert.equal(cleanOutput("ok\u0007\u0000"), "ok");
});

test("OutputBuffer keeps the head and the tail of a long stream", () => {
  const b = new OutputBuffer(100, 200);
  for (let i = 0; i < 50; i++) b.push(`line ${String(i).padStart(3, "0")} ${"x".repeat(20)}\n`);
  const out = b.render();
  assert.ok(out.startsWith("line 000"));
  assert.ok(out.includes("characters omitted"));
  assert.ok(out.trimEnd().endsWith(`line 049 ${"x".repeat(20)}`));
  assert.ok(out.length < 100 + 200 + 80);
  const small = new OutputBuffer(100, 200);
  small.push("short");
  assert.equal(small.render(), "short");
});

test("RingBuffer hands out only new output", () => {
  const r = new RingBuffer(10);
  r.push("12345");
  assert.deepEqual(r.readNew(), { text: "12345", dropped: 0 });
  assert.deepEqual(r.readNew(), { text: "", dropped: 0 });
  r.push("abcdefghijklmnop");
  const next = r.readNew();
  assert.equal(next.text, "ghijklmnop");
  assert.equal(next.dropped, 6);
});

const nodeBin = process.execPath;

test("runProcess runs a command through a real shell and reports the exit code", async () => {
  const info = resolveShell();
  const out = [];
  const res = await runProcess({ info, command: "node -e \"console.log('hi'); process.exit(3)\"", cwd: process.cwd(), env: process.env, timeoutMs: 20_000, onChunk: t => out.push(t) });
  assert.equal(res.code, 3);
  assert.match(out.join(""), /hi/);
  assert.equal(res.timedOut, false);
});

test("killTree stops a process and its children", async () => {
  const parent = spawn(nodeBin, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    console.log(child.pid);
    setInterval(()=>{},1000);
  `], { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
  const childPid = await new Promise(resolve => parent.stdout.once("data", d => resolve(Number(String(d).trim()))));
  assert.ok(processAlive(parent.pid) && processAlive(childPid));
  await killTree(parent.pid);
  for (let i = 0; i < 40 && (processAlive(parent.pid) || processAlive(childPid)); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(processAlive(parent.pid), false, "parent is gone");
  assert.equal(processAlive(childPid), false, "child is gone");
});
