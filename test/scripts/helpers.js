// Shared helpers for the installer tests: temp folders, a tiny fake app archive, a loopback file server and an async process runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeZip, writeTarGz } from "./zip-util.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const scriptsDir = path.join(projectRoot, "scripts");

export function makeTemp(prefix = "fc2-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** The fake app prints its arguments and its node path, and exits with FAKE_EXIT, so shims can be checked end to end. */
export const FAKE_CLI = [
  "const args = process.argv.slice(2);",
  "console.log('fake-firas ' + args.join('|'));",
  "console.log('node=' + process.execPath);",
  "console.log('env-code=' + (process.env.FIRAS_CODE || ''));",
  "process.exit(Number(process.env.FAKE_EXIT || 0));",
  ""
].join("\n");

export function fakeAppEntries(top = "fake-main", { version = "9.9.9", extra = [] } = {}) {
  return [
    { name: top + "/" },
    { name: top + "/bin/" },
    { name: top + "/bin/firas.js", data: Buffer.from(FAKE_CLI) },
    { name: top + "/package.json", data: Buffer.from(JSON.stringify({ name: "fake", version })) },
    { name: top + "/README.md", data: Buffer.from("fake app\n") },
    ...extra
  ];
}

export function writeFakeApp(file, options = {}) {
  writeZip(file, fakeAppEntries(options.top, options));
}

/** Serves files and records every request path. `routes` maps a path to a Buffer/string or a function(req,res). */
export async function startServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const hit = routes[req.url.split("?")[0]];
    if (hit === undefined) { res.statusCode = 404; res.end("not found"); return; }
    if (typeof hit === "function") { hit(req, res); return; }
    res.statusCode = 200;
    res.end(hit);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

/** Node refuses to spawn .cmd files directly on Windows, so those go through cmd.exe with hand-quoted arguments. */
function launch(command, args, options) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const quote = value => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const line = [command, ...args].map(quote).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(command, args, options);
}

export function run(command, args, { env = process.env, cwd, input, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out: ${command} ${args.join(" ")}\n${stdout}\n${stderr}`)); }, timeout);
    child.stdout.setEncoding("utf8").on("data", d => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr, out: stdout + stderr }); });
    child.stdin.end(input ?? "");
  });
}

/** A copy of the environment without any FIRAS_* variable, optionally with a PATH that has no node on it. */
export function cleanEnv(extra = {}, { withoutNode = false } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(firas_|no_color$)/i.test(key)) continue;
    if (withoutNode && /^path$/i.test(key)) continue;
    env[key] = value;
  }
  if (withoutNode) {
    const windir = process.env.SystemRoot || "C:\\Windows";
    env.Path = `${windir}\\System32;${windir};${windir}\\System32\\Wbem;${windir}\\System32\\WindowsPowerShell\\v1.0`;
  }
  return { ...env, ...extra };
}

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** `C:\Users\x` becomes `/c/Users/x` for Git Bash; other platforms keep the path. */
export function toPosix(p) {
  if (process.platform !== "win32") return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

/** Same layout as `fakeAppEntries`, as a gzip tar (what the shell installer downloads from GitHub). */
export function writeFakeAppTar(file, { top = "fake-main", version = "9.9.9", extra = [] } = {}) {
  writeTarGz(file, [
    { name: top + "/" },
    { name: top + "/bin/" },
    { name: top + "/bin/firas.js", data: Buffer.from(FAKE_CLI) },
    { name: top + "/package.json", data: Buffer.from(JSON.stringify({ name: "fake", version })) },
    ...extra
  ]);
}

/** Finds a real Git Bash (the bash.exe on PATH is often the Windows Subsystem launcher, which is not what we want). */
export function findBash() {
  if (process.platform !== "win32") return "bash";
  const roots = [];
  for (const dir of (process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, "git.exe"))) roots.push(path.resolve(dir, ".."));
  }
  for (const root of roots) {
    for (const rel of ["bin/bash.exe", "usr/bin/bash.exe"]) {
      const candidate = path.join(root, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}
