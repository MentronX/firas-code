// Colours and symbols. Everything that paints the terminal goes through here so NO_COLOR,
// 16/256/true-colour terminals and legacy Windows consoles are handled in one place.
//
// Tones, not effects. Secondary text is c.dim, borders and rules are c.gray, the one accent is a signal (the prompt,
// the selected row, a running step). The classic Windows console ignores SGR 2/3/9 - dim, italic and strike would print
// as plain text there and the whole hierarchy would flatten - so on that console they become colours it does draw:
// dim -> a muted gray, italic -> the soft accent, strike -> a fainter gray. Elsewhere they stay the real effects, which
// follow the terminal's own light or dark theme.
//
// Nesting is safe: every wrapper re-opens itself after an inner span closes the same attribute, so
// c.dim("(" + c.accent("x") + ")") keeps the ")" muted and c.bold(.. c.dim(x) ..) keeps the bold after the dim.
//
// Symbols come in three tiers (src/ui/terminal.js glyphTier): "full", "console" (only what Courier New and Consolas
// draw - the classic console has one font and no fallback; checked against both fonts' glyph maps) and "ascii". Every
// symbol is ONE cell in every tier except the prose-only ones (arrow, ellipsis, more), so a layout made with one tier
// lines up in all of them. Draw with sym.*; never hard-code a glyph in a component.
import { ACCENT_RGB } from "../brand.js";
import { glyphTier, isClassicConsole } from "./terminal.js";

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
// Whether SGR 2/3/9 are drawn. Only the classic Windows console on a real terminal ignores them.
let effects = !isClassicConsole({ platform: process.platform, env: process.env, stdout: process.stdout });

export function colorLevel() { return level; }
export function setColorLevel(n) { level = Math.max(0, Math.min(3, n | 0)); }
export function refreshColorLevel(env, stream) {
  level = detectLevel(env, stream);
  effects = !isClassicConsole({ platform: process.platform, env: env || process.env, stdout: stream || process.stdout });
  return level;
}
/** Whether dim, italic and strike are drawn as themselves (false: as colours). */
export function textEffects() { return effects; }
/** For tests: draw dim/italic/strike as themselves (true) or as the classic console's colours (false). */
export function setTextEffects(on) { effects = !!on; }

const ESC = "\x1b[";

/** A wrapper that re-opens `open` wherever the text inside closes it, so spans can nest. */
function sgr(open, close, s) {
  const closeSeq = `${ESC}${close}m`;
  const openSeq = `${ESC}${open}m`;
  const inner = String(s);
  return openSeq + (inner.includes(closeSeq) ? inner.split(closeSeq).join(closeSeq + openSeq) : inner) + closeSeq;
}

const wrap = (open, close) => s => (level ? sgr(open, close, s) : String(s));

function rgbToAnsi256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

const colorCode = (rgb, base, fallback16) =>
  level >= 3 ? `${base};2;${rgb[0]};${rgb[1]};${rgb[2]}` : level === 2 ? `${base};5;${rgbToAnsi256(rgb)}` : String(fallback16);

/** Foreground from RGB, degraded to the terminal's level. */
export function fg(rgb, fallback16 = 37) {
  return s => (level ? sgr(colorCode(rgb, 38, fallback16), 39, s) : String(s));
}
/** Background from RGB, degraded to the terminal's level. */
export function bg(rgb, fallback16 = 47) {
  return s => (level ? sgr(colorCode(rgb, 48, fallback16), 49, s) : String(s));
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
  // What dim and strike become where the terminal cannot draw them (the classic console): a muted and a faint gray
  // on its black background.
  muted: [150, 148, 140],
  faint: [104, 102, 96],
  panel: [38, 38, 36],
  diffAdd: [28, 58, 40],
  diffDel: [66, 34, 34],
});

const bold = wrap(1, 22);
const dimEffect = wrap(2, 22);
const italicEffect = wrap(3, 23);
const strikeEffect = wrap(9, 29);
const accent = fg(PALETTE.accent, 36);
const accentSoft = fg(PALETTE.accentSoft, 36);
const muted = fg(PALETTE.muted, 90);
const faint = fg(PALETTE.faint, 90);

export const c = {
  bold,
  dim: s => (effects ? dimEffect(s) : muted(s)),
  italic: s => (effects ? italicEffect(s) : accentSoft(s)),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  strike: s => (effects ? strikeEffect(s) : faint(s)),
  accent,
  accentSoft,
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

// The three glyph sets. Keys are the same in each; see the header for the one-cell rule.
export const GLYPHS = Object.freeze({
  full: Object.freeze({
    bullet: "●", dot: "·", arrow: "→", prompt: "❯", check: "✓", cross: "✗", warn: "▲", info: "ℹ",
    corner: "└", pipe: "│", tee: "├", hline: "─", ellipsis: "…", more: "⋯",
    spinner: Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]),
    boxTL: "╭", boxTR: "╮", boxBL: "╰", boxBR: "╯", boxH: "─", boxV: "│",
    boxT: "┬", boxB: "┴", boxL: "├", boxR: "┤", boxX: "┼",
    checkbox: "☐", checked: "☑", progress: "▌", think: "✻", quote: "▎", mark: "◆",
    active: "●", pending: "○", radioOn: "●", radioOff: "○", meterOn: "■", meterOff: "□",
    star: "✦", barFull: "━", barEmpty: "─", cont: "↪", up: "↑", down: "↓",
    bullets: Object.freeze(["•", "◦", "▪"]), block: "█", half: "▀",
  }),
  console: Object.freeze({
    bullet: "●", dot: "·", arrow: "→", prompt: "›", check: "√", cross: "×", warn: "▲", info: "•",
    corner: "└", pipe: "│", tee: "├", hline: "─", ellipsis: "…", more: "…",
    spinner: Object.freeze(["∙", "•", "●", "•"]),
    boxTL: "┌", boxTR: "┐", boxBL: "└", boxBR: "┘", boxH: "─", boxV: "│",
    boxT: "┬", boxB: "┴", boxL: "├", boxR: "┤", boxX: "┼",
    checkbox: "□", checked: "■", progress: "▌", think: "☼", quote: "│", mark: "♦",
    active: "●", pending: "○", radioOn: "●", radioOff: "○", meterOn: "■", meterOff: "□",
    star: "♦", barFull: "█", barEmpty: "░", cont: "»", up: "↑", down: "↓",
    bullets: Object.freeze(["•", "◦", "▪"]), block: "█", half: "▀",
  }),
  ascii: Object.freeze({
    bullet: "*", dot: "|", arrow: "->", prompt: ">", check: "+", cross: "x", warn: "!", info: "i",
    corner: "`", pipe: "|", tee: "|", hline: "-", ellipsis: "...", more: "...",
    spinner: Object.freeze(["|", "/", "-", "\\"]),
    boxTL: "+", boxTR: "+", boxBL: "+", boxBR: "+", boxH: "-", boxV: "|",
    boxT: "+", boxB: "+", boxL: "+", boxR: "+", boxX: "+",
    checkbox: "o", checked: "x", progress: "|", think: "*", quote: "|", mark: "*",
    active: ">", pending: "o", radioOn: "*", radioOff: "o", meterOn: "#", meterOff: ".",
    star: "*", barFull: "=", barEmpty: "-", cont: ">", up: "^", down: "v",
    bullets: Object.freeze(["*", "-", "+"]), block: "#", half: "=",
  }),
});

/** The glyph tier in use: "full", "console" or "ascii". Chosen once, at start. */
export const tier = glyphTier();
/** Anything beyond ASCII can be drawn (the "full" and "console" tiers). */
export const hasUnicode = tier !== "ascii";
export const sym = GLYPHS[tier];
