// What kind of terminal this is, decided once, in one place.
//
// Three cases matter to how the app draws:
//  - A modern terminal (Windows Terminal, VS Code, ConEmu, WezTerm, mintty, any xterm-like terminal on Linux or macOS):
//    full Unicode, font fallback, SGR 2/3/9 (dim, italic, strike) all work.
//  - The classic Windows console (cmd.exe or Windows PowerShell opened on their own): one font for the whole window
//    and no fallback, so only what Courier New draws can be used (src/ui/winfont.js switches the window to it). It
//    ignores dim, italic and strike, but draws 24-bit colour. MEASURED on the real thing (Courier New, conhost): every
//    combining mark - shadda, the tanween, the other harakat - takes a cell of its own, and so do the bidi controls
//    (LRI/PDI/RLM...), each drawn as a box or a dotted circle. The text layer counts them as zero, so a line holding
//    them is wider on screen than it was laid out, and a framed row pushes its border out.
//  - A plain glyph-poor terminal (FIRAS_ASCII=1, the Linux text console): ASCII only.
//
// On Windows TERM says nothing about the window. The MSYS and Cygwin runtimes (Git Bash, MSYS2, Cygwin) set it
// themselves, xterm-256color or cygwin, whatever window they run in, so bash started inside a classic console window
// would pass for a modern terminal. The terminals themselves say so in variables of their own: WT_SESSION for Windows
// Terminal, TERM_PROGRAM for VS Code, mintty and WezTerm.
//
// FIRAS_GLYPHS=full|console|ascii overrides the glyph choice for a terminal guessed wrong.
import { dropArabicMarks } from "./textfit.js";

/** Terminals that pick another font for a letter their own font lacks. */
export function isModernTerminal(env = {}, platform = process.platform) {
  const term = String(env.TERM || "");
  return !!(env.WT_SESSION || env.TERM_PROGRAM || env.WEZTERM_EXECUTABLE || env.ConEmuANSI || env.ConEmuTask ||
    env.ALACRITTY_LOG || (platform !== "win32" && /xterm|rxvt|tmux|screen/i.test(term)));
}

/** The classic Windows console window (cmd.exe or Windows PowerShell without Windows Terminal), on a real terminal. */
export function isClassicConsole({ platform = process.platform, env = process.env, stdout = process.stdout } = {}) {
  return platform === "win32" && !!stdout && !!stdout.isTTY && !isModernTerminal(env, platform);
}

/**
 * FIRAS_NO_MOTION=1 (or NO_MOTION=1): nothing moves on its own. The spinner keeps one glyph and only its clock ticks,
 * the ultracode charge-up goes straight to its announcement, nothing shimmers.
 */
export function reducedMotion(env = process.env) {
  const on = v => v === "1" || /^(true|yes|on)$/i.test(String(v || ""));
  return on(env.FIRAS_NO_MOTION) || on(env.NO_MOTION);
}

export const GLYPH_TIERS = Object.freeze(["full", "console", "ascii"]);

/**
 * Which glyph set this terminal can draw: "full", "console" (what Courier New has: box lines with square corners,
 * ● ○ ► √ × ▲ · …) or "ascii". The classic console is "console" whether or not stdout is a terminal right now, because
 * the set is chosen once at start and a redirected run prints no symbols that matter.
 */
export function glyphTier({ platform = process.platform, env = process.env } = {}) {
  const forced = String(env.FIRAS_GLYPHS || "").trim().toLowerCase();
  if (GLYPH_TIERS.includes(forced)) return forced;
  if (env.FIRAS_ASCII === "1") return "ascii";
  if (platform !== "win32") return env.TERM === "linux" ? "ascii" : "full";
  return isModernTerminal(env, platform) ? "full" : "console";
}

// Combining and enclosing marks (the harakat, superscript alef, Latin accents left decomposed, variation selectors)
// and format controls (LRM/RLM/ALM, embeddings, overrides, isolates, zero-width joiners, soft hyphen, BOM). The
// spacing forms U+FE70..FE7F are letters to the console - one cell each, measured - and are kept.
const ZERO_CELL = /[\p{Mn}\p{Me}\p{Cf}]/u;
const ZERO_CELL_ALL = /[\p{Mn}\p{Me}\p{Cf}]/gu;

/**
 * Removes what the classic console would draw as an extra cell. The text layer counted these as zero columns and has
 * already put every letter where it belongs, so dropping them moves nothing - it only stops the console from drawing a
 * box or a dotted circle in a cell the layout never gave out. Text is composed first (NFC), so a letter written as base
 * plus accent keeps its accent. Escape sequences hold none of these characters and pass through untouched.
 */
export function stripConsoleMarks(text) {
  const s = String(text ?? "");
  return ZERO_CELL.test(s) ? s.normalize("NFC").replace(ZERO_CELL_ALL, "") : s;
}

const COMBINING = /[\p{Mn}\p{Me}]/u;

/**
 * For a modern terminal on Windows: composes the text (NFC, so an accent written as base plus mark becomes one
 * letter, and a hamza written as a mark joins its alef), then drops the Arabic marks that are left - the harakat, the
 * shadda, the tanween. Such a terminal still sits behind the console host (ConPTY), which gives each of them a cell of
 * its own, and the layout counted them as zero. Only Arabic: the marks of other scripts (Devanagari vowel signs, Thai
 * tones, Hebrew points) carry letters and sounds, and dropping them would change the words; the joiners and format
 * characters are drawn as the layout counted them.
 */
export function dropHarakat(text) {
  const s = String(text ?? "");
  return COMBINING.test(s) ? dropArabicMarks(s.normalize("NFC")) : s;
}

const keepAll = s => s;

/**
 * What a line loses on its way to `stream`, as a function. Every terminal on Windows writes through the console host:
 * the classic window itself, or ConPTY behind Windows Terminal, VS Code and the rest. The console host gives each
 * combining mark a cell of its own, so text written to a Windows terminal loses its Arabic marks whatever the terminal
 * is, while the layout keeps counting them as zero (the letters are already where they belong). The classic window,
 * where one font draws everything, also loses the other marks, the bidi controls and the joiners, all drawn there as
 * boxes. A file, a pipe and the other platforms keep it all.
 */
export function markFilter({ platform = process.platform, env = process.env, stream = process.stdout } = {}) {
  if (platform !== "win32" || !stream || !stream.isTTY) return keepAll;
  return isModernTerminal(env, platform) ? dropHarakat : stripConsoleMarks;
}
