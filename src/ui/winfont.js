// Arabic in the classic Windows console.
//
// The classic console (cmd.exe or Windows PowerShell opened on their own, without Windows Terminal) draws every
// character with the one font of the window and has no fallback. On Arabic Windows that font is often the raster
// "Terminal" font with code page 720, which turns each Arabic letter into a symbol of the old DOS character set; Lucida
// Console and Consolas have no Arabic at all (boxes). Courier New ships with every Windows and carries the Arabic letters
// AND the presentation forms the text layer draws with (src/text/arabic.js), so when the window's font cannot draw them
// THIS window is switched to it: same height, never under 16 px. Measured on the real thing: Terminal 8x12 at code page
// 720 -> Courier New 16, joined letters in the right order. Nothing is saved; the next window opens with its own font.
//
// Modern terminals (Windows Terminal, VS Code, ConEmu, WezTerm, mintty) fall back to another font by themselves and are
// left alone. FIRAS_FONT=keep turns this off.
//
// Node cannot change the console font itself, so a short PowerShell script does it, in the background (a quarter to one and
// a half seconds). It shares this console - no windowsHide, because a hidden child is started without any console - and
// reaches the screen through CONOUT$, since its own output is a pipe. The script contains no double quote, so no quoting
// rule on the way to PowerShell can change it. PowerShell renames the shared window to "Windows PowerShell" as it
// starts (seen on the real thing), so the app's own title travels in FIRAS_TITLE and is put back first thing.
import { spawn as nodeSpawn } from "node:child_process";
import { childEnv } from "../util/env.js";

export const WANTED_FONT = "Courier New";

const NL = String.fromCharCode(10);

// Prints one line: keep|<face>, set|<from>|<to>, nofont|<face>, failed|<face>, unknown, noconsole or error|<message>.
// The probe letters: lam, and the isolated alef, initial lam and lam-alef presentation forms.
export const FONT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$want = '${WANTED_FONT}'
$probe = 0x0644, 0xFE8D, 0xFEDF, 0xFEFB
try {
  if ($env:FIRAS_TITLE) { [Console]::Title = $env:FIRAS_TITLE }
  $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'FirasFont'), 'Run')
  $tb = $ab.DefineDynamicModule('FirasFont').DefineType('FirasFontNative', 'Public,Class,Abstract,Sealed')
  function Add-Native([string]$name, [Type]$ret, [Type[]]$sig) {
    $m = $tb.DefinePInvokeMethod($name, 'kernel32.dll', [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $ret, $sig, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  Add-Native 'CreateFileW' ([IntPtr]) @([string], [int], [int], [IntPtr], [int], [int], [IntPtr])
  Add-Native 'GetCurrentConsoleFontEx' ([bool]) @([IntPtr], [bool], [byte[]])
  Add-Native 'SetCurrentConsoleFontEx' ([bool]) @([IntPtr], [bool], [byte[]])
  Add-Native 'CloseHandle' ([bool]) @([IntPtr])
  $native = $tb.CreateType()
  function Read-Font {
    $b = New-Object byte[] 84
    [BitConverter]::GetBytes([int]84).CopyTo($b, 0)
    if (-not $native::GetCurrentConsoleFontEx($h, $false, $b)) { return $null }
    $face = [Text.Encoding]::Unicode.GetString($b, 20, 64)
    $cut = $face.IndexOf([char]0)
    if ($cut -ge 0) { $face = $face.Substring(0, $cut) }
    return @{ H = [BitConverter]::ToInt16($b, 10); Family = [BitConverter]::ToInt32($b, 12); Face = $face }
  }
  function Test-Arabic([string]$face) {
    try {
      Add-Type -AssemblyName PresentationCore
      foreach ($tf in (New-Object Windows.Media.FontFamily($face)).GetTypefaces()) {
        $g = $null
        if (-not $tf.TryGetGlyphTypeface([ref]$g)) { continue }
        if (-not ($g.Win32FamilyNames.Values -contains $face)) { continue }
        foreach ($c in $probe) { if (-not $g.CharacterToGlyphMap.ContainsKey($c)) { return $false } }
        return $true
      }
    } catch { }
    return $false
  }
  $h = $native::CreateFileW('CONOUT$', -1073741824, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h.ToInt64() -le 0) { 'noconsole' }
  else {
    $cur = Read-Font
    if (-not $cur) { 'unknown' }
    elseif ((($cur.Family -band 4) -ne 0) -and (Test-Arabic $cur.Face)) { 'keep|' + $cur.Face }
    elseif (-not (Test-Arabic $want)) { 'nofont|' + $cur.Face }
    else {
      $b = New-Object byte[] 84
      [BitConverter]::GetBytes([int]84).CopyTo($b, 0)
      [BitConverter]::GetBytes([int16][Math]::Max(16, [int]$cur.H)).CopyTo($b, 10)
      [BitConverter]::GetBytes([int]54).CopyTo($b, 12)
      [BitConverter]::GetBytes([int]400).CopyTo($b, 16)
      $name = [Text.Encoding]::Unicode.GetBytes($want)
      [Array]::Copy($name, 0, $b, 20, [Math]::Min(62, $name.Length))
      $ok = $native::SetCurrentConsoleFontEx($h, $false, $b)
      $after = Read-Font
      if ($ok -and $after -and $after.Face -eq $want) { 'set|' + $cur.Face + '|' + $want } else { 'failed|' + $cur.Face }
    }
    [void]$native::CloseHandle($h)
  }
} catch { 'error|' + $_.Exception.Message }
`;

/** Terminals that pick another font for a letter their own font lacks. */
export function isModernTerminal(env = {}) {
  const term = String(env.TERM || "");
  return !!(env.WT_SESSION || env.TERM_PROGRAM || env.WEZTERM_EXECUTABLE || env.ConEmuANSI || env.ConEmuTask ||
    env.ALACRITTY_LOG || /xterm|rxvt|tmux|screen|cygwin|msys/i.test(term));
}

/** Only the classic Windows console, only on a real terminal, and never when FIRAS_FONT says to keep the font. */
export function shouldFixConsoleFont({ platform = process.platform, env = process.env, stdout = process.stdout } = {}) {
  if (platform !== "win32" || !stdout || !stdout.isTTY) return false;
  const pref = String(env.FIRAS_FONT || "").trim().toLowerCase();
  if (pref === "keep" || pref === "off" || pref === "0" || pref === "no" || pref === "false") return false;
  return !isModernTerminal(env);
}

/** The script's one line as { status, from, to }. Anything unexpected is "error". */
export function parseFontResult(text) {
  const line = String(text ?? "").split(NL).map(s => s.trim()).find(Boolean) || "";
  const [status, a = "", b = ""] = line.split("|");
  switch (status) {
    case "keep": return { status, from: a, to: a };
    case "set": return { status, from: a, to: b };
    case "nofont": case "failed": return { status, from: a, to: "" };
    case "unknown": case "noconsole": return { status, from: "", to: "" };
    default: return { status: "error", from: "", to: "", detail: status === "error" ? a : line };
  }
}

/** A font that still cannot draw Arabic once the script is done. */
export function fontStillBroken(result) {
  return !!result && (result.status === "nofont" || result.status === "failed");
}

/**
 * Switches this console window to a font that draws Arabic when its own cannot. Resolves { status, from, to } and never
 * rejects; the caller does not wait for it (the console redraws the whole window when its font changes).
 */
export function fixConsoleFont({ env = process.env, title = "", spawn = nodeSpawn, timeoutMs = 20000 } = {}) {
  return new Promise(resolve => {
    let child;
    let out = "";
    let settled = false;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* gone */ } done({ status: "timeout", from: "", to: "" }); }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", FONT_SCRIPT], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...childEnv(env), ...(title ? { FIRAS_TITLE: String(title) } : {}) },
      });
    } catch {
      done({ status: "error", from: "", to: "" });
      return;
    }
    child.on("error", () => done({ status: "error", from: "", to: "" }));
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", chunk => { if (out.length < 4096) out += chunk; });
    child.on("close", () => done(parseFontResult(out)));
    // Leaving the app while the script runs must not wait for it.
    child.unref?.();
    child.stdout?.unref?.();
  });
}
