// Ultracode: the top effort level, and the one thing on screen that is allowed to be loud.
//
//  - The word "ultracode" is painted in a rainbow wherever it is drawn: the footer, the banner, the /effort menu, the
//    prompt box while it is typed, the spinner and the announcement. Painting works on FINISHED rows (after shaping and
//    ordering): the word is Latin, so it reads the same in a visual row, and colour never changes a width.
//  - The spinner of an ultracode turn cycles its glyph and verb through the same rainbow, moving.
//  - Choosing ultracode plays a short charge-up (about a second) in the live region and leaves a short announcement.
//  - The word inside a message runs that one message at ultracode (mentionsUltra), which is why it lights up as it is
//    typed.
//  - Without colour (NO_COLOR, a pipe) nothing is painted and nothing moves.
import { c, colorLevel, fg, hasUnicode } from "./theme.js";
import { t } from "../i18n/index.js";
import { layoutParagraph, stringWidth, stripAnsi } from "../text/display.js";
import { stripBidiMarks } from "./textfit.js";
import "./strings-app.js";

export const ULTRA = "ultracode";
const TITLE = "U L T R A C O D E";
const CYCLE_MS = 2400;

const HUES = [[255, 95, 109], [255, 160, 80], [255, 220, 90], [120, 222, 130], [80, 200, 255], [125, 140, 255], [205, 125, 255]];
const ANSI16 = [31, 33, 33, 32, 36, 34, 35];
const WORD = /ultracode/gi;
const MENTION = /(^|[^\p{L}\p{N}_])ultracode(?=[^\p{L}\p{N}_]|$)/iu;

const lerp = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const wrap01 = x => ((x % 1) + 1) % 1;

/** The rainbow at `pos` (0..1, wraps around), blended smoothly between its seven hues. */
export function rainbowAt(pos) {
  const p = wrap01(pos) * HUES.length;
  const i = Math.floor(p);
  return lerp(HUES[i % HUES.length], HUES[(i + 1) % HUES.length], p - i);
}

/** Where the rainbow is at time `at`: one full turn every 2.4 s. */
export function phaseAt(at = Date.now()) {
  return wrap01(at / CYCLE_MS);
}

/** Every character of `text` in its own colour along the rainbow, starting at `phase`. Spaces stay plain. */
export function rainbow(text, phase = 0, spread = 0.09) {
  const s = String(text ?? "");
  if (!colorLevel()) return s;
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (ch === " ") { out += ch; i += 1; continue; }
    const pos = wrap01(phase + i * spread);
    out += fg(rainbowAt(pos), ANSI16[Math.floor(pos * ANSI16.length) % ANSI16.length])(ch);
    i += 1;
  }
  return out;
}

/** One colour from the rainbow for a whole piece of text (safe for Arabic: one style run, shaping is untouched). */
export function rainbowSolid(text, phase = 0) {
  if (!colorLevel()) return String(text ?? "");
  const pos = wrap01(phase);
  return fg(rainbowAt(pos), ANSI16[Math.floor(pos * ANSI16.length) % ANSI16.length])(String(text ?? ""));
}

/** A finished row with every "ultracode" in it painted. Rows without the word come back unchanged. */
export function paintUltra(row, phase = phaseAt()) {
  const s = String(row ?? "");
  if (!colorLevel() || s.search(WORD) === -1) return s;
  return s.replace(WORD, word => rainbow(word, phase));
}

/** Does a message ask for ultracode by naming it (as a word of its own, any case)? */
export function mentionsUltra(text) {
  return MENTION.test(String(text ?? ""));
}

function placeRow(line, width, rtl) {
  const w = stringWidth(stripAnsi(line));
  return rtl ? " ".repeat(Math.max(0, width - 1 - w)) + line : line;
}

/** A sentence wrapped to the terminal, dimmed, with the same two-column gutter as the title (on the right in Arabic). */
function sentence(text, width, rtl) {
  const rows = layoutParagraph(text, Math.max(10, width - 3), rtl ? { dir: "rtl", align: "end" } : { dir: "ltr", align: "start" });
  return rows.map(row => paintUltra(c.dim(stripBidiMarks(rtl ? row : "  " + row))));
}

/** The lines left on screen once ultracode is on. */
export function ultraAnnouncement({ width = 80, lang = "en", phase = 0 } = {}) {
  const rtl = lang === "ar";
  const star = hasUnicode ? "✦" : "*";
  const head = `  ${rainbow(star, phase)} ${c.bold(rainbow(TITLE, phase + 0.1))} ${rainbow(star, phase + 0.8)}`;
  return ["", placeRow(head, width, rtl), ...sentence(t("app.effort.ultra.on"), width, rtl), ...sentence(t("app.effort.ultra.word"), width, rtl), ""];
}

/**
 * The charge-up: a bar fills along the rainbow while the title lights up letter by letter, then the announcement stays.
 * screen: { isTTY, width(), setLive(lines), clearLive() }; print(lines) writes finished lines above the live region.
 */
export async function playUltraIntro({ screen, print, lang = "en", frames = 18, frameMs = 55, sleep } = {}) {
  const wait = sleep || (ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  const width = Math.max(24, (screen && typeof screen.width === "function" ? screen.width() : 80) || 80);
  const rtl = lang === "ar";
  const live = !!(screen && screen.isTTY && typeof screen.setLive === "function" && colorLevel() > 0);
  if (live) {
    const barW = Math.max(10, Math.min(40, width - 8));
    const full = hasUnicode ? "━" : "=";
    const empty = hasUnicode ? "─" : "-";
    const star = hasUnicode ? "✦" : "*";
    try {
      for (let k = 1; k <= frames; k++) {
        const done = k / frames;
        const n = Math.round(barW * done);
        const shown = TITLE.slice(0, Math.ceil(TITLE.length * done));
        const head = `  ${rainbow(star, done * 2)} ${c.bold(rainbow(shown, done * 1.5))}`;
        const bar = `  ${rainbow(full.repeat(n), done * 2, 1 / barW)}${c.gray(empty.repeat(barW - n))}`;
        screen.setLive([placeRow(head, width, rtl), placeRow(bar, width, rtl)]);
        await wait(frameMs);
      }
    } finally {
      screen.clearLive?.();
    }
  }
  if (typeof print === "function") print(ultraAnnouncement({ width, lang, phase: 0 }));
}
