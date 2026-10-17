// Colours and symbols. Everything that paints the terminal goes through here so NO_COLOR,
// 16/256/true-colour terminals and legacy Windows consoles are handled in one place.
import { ACCENT_RGB } from "../brand.js";

function detectLevel(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  if (env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") return 0;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "";
  if (!forced && !(stream && stream.isTTY)) return 0;
  if (env.FORCE_COLOR === "3") return 3;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || env.WT_SESSION || env.TERM_PROGRAM === "iTerm.app" ||
      env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "ghostty") return 3;
  if (/256color/i.test(env.TERM || "")) return 2;
  if (process.platform === "win32") return 3; // Windows 10+ consoles take 24-bit colour
  return env.TERM && env.TERM !== "dumb" ? 1 : 0;
}

let level = detectLevel();
export function colorLevel() { return level; }
export function setColorLevel(n) { level = Math.max(0, Math.min(3, n | 0)); }
export function refreshColorLevel(env, stream) { level = detectLevel(env, stream); return level; }

const ESC = "\x1b[";
const wrap = (open, close) => s => (level ? `${ESC}${open}m${s}${ESC}${close}m` : String(s));

function rgbToAnsi256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

/** Foreground from RGB, degraded to the terminal's level. */
export function fg(rgb, fallback16 = 37) {
  return s => {
    if (!level) return String(s);
    const open = level >= 3 ? `38;2;${rgb[0]};${rgb[1]};${rgb[2]}` : level === 2 ? `38;5;${rgbToAnsi256(rgb)}` : String(fallback16);
    return `${ESC}${open}m${s}${ESC}39m`;
  };
}
/** Background from RGB, degraded to the terminal's level. */
export function bg(rgb, fallback16 = 47) {
  return s => {
    if (!level) return String(s);
    const open = level >= 3 ? `48;2;${rgb[0]};${rgb[1]};${rgb[2]}` : level === 2 ? `48;5;${rgbToAnsi256(rgb)}` : String(fallback16);
    return `${ESC}${open}m${s}${ESC}49m`;
  };
}

export const PALETTE = Object.freeze({
  accent: ACCENT_RGB,
  accentSoft: [120, 200, 182],
  red: [226, 108, 108],
  green: [126, 200, 140],
  yellow: [229, 192, 123],
  blue: [110, 168, 230],
  magenta: [198, 140, 220],
  gray: [138, 138, 132],
  panel: [38, 38, 36],
  diffAdd: [28, 58, 40],
  diffDel: [66, 34, 34],
});

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  strike: wrap(9, 29),
  accent: fg(PALETTE.accent, 36),
  accentSoft: fg(PALETTE.accentSoft, 36),
  red: fg(PALETTE.red, 31),
  green: fg(PALETTE.green, 32),
  yellow: fg(PALETTE.yellow, 33),
  blue: fg(PALETTE.blue, 34),
  magenta: fg(PALETTE.magenta, 35),
  gray: fg(PALETTE.gray, 90),
  bgAccent: bg(PALETTE.accent, 46),
  bgPanel: bg(PALETTE.panel, 40),
  bgAdd: bg(PALETTE.diffAdd, 42),
  bgDel: bg(PALETTE.diffDel, 41),
};

// Legacy Windows consoles (cmd.exe / old PowerShell host) draw box and arrow glyphs badly; everything else is fine.
function detectUnicode(env = process.env) {
  if (env.FIRAS_ASCII === "1") return false;
  if (process.platform !== "win32") return env.TERM !== "linux";
  return !!(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuTask || env.TERM === "xterm-256color");
}
const unicode = detectUnicode();
export const hasUnicode = unicode;

export const sym = Object.freeze(unicode ? {
  bullet: "●", dot: "·", arrow: "→", prompt: "❯", check: "✓", cross: "✗", warn: "▲", info: "ℹ",
  corner: "└", pipe: "│", tee: "├", hline: "─", ellipsis: "…", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  boxTL: "╭", boxTR: "╮", boxBL: "╰", boxBR: "╯", boxH: "─", boxV: "│", checkbox: "☐", checked: "☑", progress: "▌",
  think: "✻", quote: "▎", mark: "◆",
} : {
  bullet: "*", dot: "-", arrow: "->", prompt: ">", check: "+", cross: "x", warn: "!", info: "i",
  corner: "`-", pipe: "|", tee: "|-", hline: "-", ellipsis: "...", spinner: ["|", "/", "-", "\\"],
  boxTL: "+", boxTR: "+", boxBL: "+", boxBR: "+", boxH: "-", boxV: "|", checkbox: "[ ]", checked: "[x]", progress: "|",
  think: "*", quote: "|", mark: "*",
});
