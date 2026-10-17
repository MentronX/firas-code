// `firas update` and /update: run the installer again for this platform. The installer replaces the app folder as a
// whole and keeps settings and sessions (they live next to app/, never inside it), so an update loses nothing.
//
// Decisions:
//  - The installer is run, never reimplemented: Windows -> powershell.exe -NoProfile -Command "irm <raw url> | iex";
//    macOS/Linux -> bash -c "curl -fsSL <raw url> | bash -s -- --no-launch --no-path-update". The environment twins
//    FIRAS_NO_LAUNCH=1 and FIRAS_NO_PATH_UPDATE=1 are set as well, so the plain `| iex` form obeys them too.
//  - TLS 1.2 is switched on first in the Windows command: Windows PowerShell 5.1 does not use it by default and GitHub
//    refuses older protocols.
//  - Refused (with a friendly reason, nothing is spawned) when: the repository name was never filled in
//    (scripts/set-repo.mjs has not run), the working folder is inside the app folder (the installer replaces that
//    folder and Windows cannot while a process stands in it), or this copy is a source checkout (a .git folder next
//    to src/: updating it is `git pull`, and the installer would put a second copy elsewhere).
//  - The child's output is shown as it comes (`onOutput`), and its exit code is returned. stdin is closed so the
//    installer can never wait for a keypress.
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { REPO } from "./brand.js";
import { isInside } from "./util/paths.js";
import { childEnv } from "./util/env.js";

const REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The folder that holds bin/ and src/ of the running copy. */
export function appRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function rawUrl(repo, file) {
  return `https://raw.githubusercontent.com/${repo}/main/scripts/${file}`;
}

/** The program, arguments and extra environment that run the installer. */
export function installerCommand({ platform = process.platform, repo = REPO } = {}) {
  if (platform === "win32") {
    const script = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm ${rawUrl(repo, "install.ps1")} | iex`;
    return { file: "powershell.exe", args: ["-NoProfile", "-Command", script] };
  }
  const script = `curl -fsSL ${rawUrl(repo, "install.sh")} | bash -s -- --no-launch --no-path-update`;
  return { file: "bash", args: ["-c", script] };
}

/** Why an update cannot start from here, or "" when it can. */
export function updateBlocker({ repo = REPO, cwd = process.cwd(), root = appRoot() } = {}) {
  if (!REPO_SHAPE.test(String(repo))) return "not_configured";
  if (isInside(root, cwd)) return "inside_app";
  if (fs.existsSync(path.join(root, ".git"))) return "dev_checkout";
  return "";
}

/**
 * Runs the installer. Resolves { ok, code, reason } and never rejects.
 *   reason: "" | "not_configured" | "inside_app" | "dev_checkout" | "spawn_failed" | "failed" | "aborted"
 * Options: { platform, env, cwd, repo, root, spawn, onOutput(text, stream), signal } (the last five are for tests/callers).
 */
export function runUpdate({ platform = process.platform, env = process.env, cwd = process.cwd(), repo = REPO, root = appRoot(), spawn = nodeSpawn, onOutput, signal } = {}) {
  const blocked = updateBlocker({ repo, cwd, root });
  if (blocked) return Promise.resolve({ ok: false, code: null, reason: blocked });
  const { file, args } = installerCommand({ platform, repo });
  return new Promise(resolve => {
    let child;
    let done = false;
    const finish = result => { if (!done) { done = true; signal?.removeEventListener("abort", onAbort); resolve(result); } };
    const onAbort = () => { try { child?.kill(); } catch { /* already gone */ } finish({ ok: false, code: null, reason: "aborted" }); };
    try {
      child = spawn(file, args, {
        cwd,
        env: childEnv({ ...env, FIRAS_NO_LAUNCH: "1", FIRAS_NO_PATH_UPDATE: "1" }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish({ ok: false, code: null, reason: "spawn_failed" });
      return;
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", chunk => { try { onOutput?.(chunk.toString("utf8"), "stdout"); } catch { /* cosmetic */ } });
    child.stderr?.on("data", chunk => { try { onOutput?.(chunk.toString("utf8"), "stderr"); } catch { /* cosmetic */ } });
    child.on("error", () => finish({ ok: false, code: null, reason: "spawn_failed" }));
    child.on("close", code => finish(code === 0 ? { ok: true, code: 0, reason: "" } : { ok: false, code: code ?? null, reason: "failed" }));
  });
}
