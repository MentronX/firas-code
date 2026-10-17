// Shell resolution and process-tree control for the Bash tool.
//
// Windows order: Git Bash (bash.exe from PATH - but never the WSL launcher in System32 / WindowsApps - or next
// to git.exe, or in the usual install folders) -> PowerShell (pwsh, else powershell.exe) -> cmd.exe.
// POSIX order: $SHELL when it is a POSIX-style shell -> /bin/bash -> /bin/sh.
// Everything that touches the machine (file existence, PATH) is injectable so the logic is testable anywhere.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { windowsSystemTool } from "../util/paths.js";
import { childEnv } from "./common.js";

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh", "ash"]);

function splitPath(env, platform) {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw.split(platform === "win32" ? ";" : ":").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

const isWslLauncher = file => /[\\/](windows[\\/](system32|syswow64|sysnative)|windowsapps)[\\/]/i.test(file);

function windowsGitBashCandidates(env, entries, exists) {
  const out = [];
  const join = (...p) => path.win32.join(...p);
  for (const dir of entries) {
    const file = join(dir, "bash.exe");
    if (!isWslLauncher(file)) out.push(file);
  }
  for (const dir of entries) {
    if (!exists(join(dir, "git.exe"))) continue;
    for (const rel of [["..", "bin", "bash.exe"], ["..", "usr", "bin", "bash.exe"], ["..", "..", "bin", "bash.exe"], ["..", "..", "usr", "bin", "bash.exe"]]) out.push(path.win32.normalize(join(dir, ...rel)));
  }
  const roots = [env.GIT_INSTALL_ROOT, env.ProgramW6432 && join(env.ProgramW6432, "Git"), env.ProgramFiles && join(env.ProgramFiles, "Git"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git"), env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git"),
    env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "git", "current"), "C:\\Program Files\\Git", "C:\\Git"].filter(Boolean);
  for (const root of roots) out.push(join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe"));
  out.push("C:\\msys64\\usr\\bin\\bash.exe");
  return out;
}

function describe(kind, file, platform) {
  const base = { kind, path: file, platform };
  switch (kind) {
    case "bash": return { ...base, name: platform === "win32" ? "Git Bash" : "bash", syntax: platform === "win32"
      ? "POSIX shell syntax (Git Bash): use forward slashes in paths (D:/proj/src, not D:\\proj\\src), && and ; to chain commands, $VAR for variables. Windows programs such as node and git work as usual, and arguments that start with / are passed through unchanged." : "POSIX shell syntax (bash)." };
    case "sh": return { ...base, name: "sh", syntax: "POSIX shell syntax (sh): no bash-only features." };
    case "zsh": return { ...base, name: "zsh", syntax: "POSIX-style shell syntax (zsh)." };
    case "powershell": return { ...base, name: /pwsh/i.test(file) ? "PowerShell 7" : "Windows PowerShell", syntax: /pwsh/i.test(file)
      ? "PowerShell syntax: $env:NAME for variables, ; or && to chain, Get-ChildItem and friends; paths may use backslashes." : "PowerShell syntax (version 5): $env:NAME for variables, ; to chain (&& and || do not exist), Get-ChildItem and friends; paths may use backslashes." };
    default: return { ...base, name: "cmd", syntax: "Windows cmd.exe syntax: %VAR% for variables, & or && to chain, dir and type for listing and viewing; paths use backslashes." };
  }
}

/**
 * Picks the shell. Returns { kind: "bash"|"sh"|"zsh"|"powershell"|"cmd", name, path, platform, syntax, label }.
 * `exists(file)` and `env` can be injected for tests.
 */
export function resolveShell({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const entries = splitPath(env, platform);
  let info = null;
  if (platform === "win32") {
    const git = windowsGitBashCandidates(env, entries, exists).find(file => exists(file));
    if (git) info = describe("bash", git, platform);
    if (!info) {
      for (const exe of ["pwsh.exe", "powershell.exe"]) {
        const hit = entries.map(dir => path.win32.join(dir, exe)).find(file => exists(file));
        if (hit) { info = describe("powershell", hit, platform); break; }
      }
    }
    if (!info) {
      const root = env.SystemRoot || env.windir || "C:\\Windows";
      const ps = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      if (exists(ps)) info = describe("powershell", ps, platform);
    }
    if (!info) info = describe("cmd", env.ComSpec && exists(env.ComSpec) ? env.ComSpec : path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), platform);
  } else {
    const fromEnv = env.SHELL && POSIX_SHELLS.has(path.posix.basename(env.SHELL)) && exists(env.SHELL) ? env.SHELL : null;
    const file = fromEnv || ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"].find(p => exists(p)) || "/bin/sh";
    const base = path.posix.basename(file);
    info = describe(base === "bash" ? "bash" : base === "zsh" ? "zsh" : "sh", file, platform);
  }
  info.label = `${info.name} (${info.path})`;
  return Object.freeze(info);
}

/** The file, arguments and spawn options that run `command` in the given shell. */
export function buildInvocation(info, command) {
  switch (info.kind) {
    case "powershell": {
      const script = [
        "$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'",
        "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding } catch {}",
        command,
        "if ($?) { exit 0 } elseif ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }",
      ].join("\n");
      return {
        file: info.path,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        options: {},
      };
    }
    case "cmd":
      return { file: info.path, args: ["/d", "/s", "/c", `"chcp 65001>nul & ${command}"`], options: { windowsVerbatimArguments: true } };
    default:
      return { file: info.path, args: ["-c", command], options: {} };
  }
}

// ---------------------------------------------------------------------------------------------------
// Process trees

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** Kills `pid` and everything it started. Resolves when the kill was issued (and, on POSIX, confirmed or forced). */
export async function killTree(pid, { platform = process.platform } = {}) {
  if (!pid) return;
  if (platform === "win32") {
    await new Promise(resolve => {
      const killer = spawn(windowsSystemTool("taskkill"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, env: childEnv() });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }
  const signalGroup = signal => { try { process.kill(-pid, signal); return true; } catch { try { process.kill(pid, signal); return true; } catch { return false; } } };
  if (!signalGroup("SIGTERM")) return;
  for (let waited = 0; waited < 800; waited += 50) {
    await sleep(50);
    if (!alive(pid)) { signalGroup("SIGKILL"); return; }
  }
  signalGroup("SIGKILL");
}

/** Synchronous version for process-exit hooks. */
export function killTreeSync(pid, { platform = process.platform } = {}) {
  if (!pid) return;
  if (platform === "win32") {
    try { spawnSync(windowsSystemTool("taskkill"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3000, env: childEnv() }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

export { alive as processAlive };
