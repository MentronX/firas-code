// Copying text to the system clipboard, keeping Arabic and every other character exactly as written.
//
// Windows: clip.exe is NOT used. It reads its input in the console's legacy code page, and when fed UTF-16 it keeps the
// byte-order mark as a character and turns every newline into CRLF. PowerShell's Set-Clipboard is exact: the text is
// piped in as UTF-8 and the shell is told to read stdin as UTF-8 first (a test reads the clipboard back to prove it).
// macOS: pbcopy. Linux: wl-copy under Wayland, else xclip, else xsel. Each candidate is tried in turn; a missing program
// is not an error until all of them are missing.
import { spawn as nodeSpawn } from "node:child_process";
import { childEnv } from "../util/env.js";

const WINDOWS_SCRIPT = "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t";

export function clipboardCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    return [
      { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT] },
      { file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT] },
    ];
  }
  if (platform === "darwin") return [{ file: "pbcopy", args: [] }];
  const list = [];
  if (env.WAYLAND_DISPLAY) list.push({ file: "wl-copy", args: [] });
  list.push({ file: "xclip", args: ["-selection", "clipboard"] }, { file: "xsel", args: ["--clipboard", "--input"] });
  if (!env.WAYLAND_DISPLAY) list.push({ file: "wl-copy", args: [] });
  return list;
}

function tryOne({ file, args }, text, spawn, timeoutMs, env) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    const done = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* gone */ } done(false); }, timeoutMs);
    try {
      child = spawn(file, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, env: childEnv(env) });
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false));
    child.on("close", code => done(code === 0));
    // wl-copy and xclip fork into the background to keep serving the clipboard, so the process we started exits at once.
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(text, "utf8"));
  });
}

/** Resolves { ok, tool }. Never rejects. */
export async function copyToClipboard(text, { platform = process.platform, env = process.env, spawn = nodeSpawn, timeoutMs = 8000 } = {}) {
  for (const candidate of clipboardCandidates({ platform, env })) {
    if (await tryOne(candidate, String(text), spawn, timeoutMs, env)) return { ok: true, tool: candidate.file };
  }
  return { ok: false, tool: "" };
}
