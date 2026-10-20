// Ultracode: the top effort level, and the one thing on screen that is allowed to be loud.
//
//  - The word "ultracode" is painted in a rainbow wherever it is drawn: the footer, the banner, the /effort menu, the
//    prompt box while it is typed, the spinner and the announcement. Painting works on FINISHED rows (after shaping and
//    ordering): the word is Latin, so it reads the same in a visual row, and colour never changes a width.
//  - The spinner of an ultracode turn cycles its glyph and verb through the same rainbow, moving.
//  - Choosing ultracode plays a short charge-up (about a second) in the live region and leaves a short announcement.
//  - The word inside a message runs that one message at ultracode (mentionsUltra), which is why it lights up as it is
//    typed.
//  - Layout follows the rest of the app. ultraAnnouncement() lays its lines out for the CONTENT width (the terminal
//    minus a two-column gutter on each side, as views.js does) and the caller's print adds the gutter, as ui.print does;
//    the title and the sentences share one edge - the left one in English, the right one in Arabic. The charge-up draws
//    straight into the live region, so it puts the same gutter (and in Arabic the same margin that brings the column
//    against the right edge) in front of its rows itself - unless it is handed the interactive UI's dialog host, which
//    places them like any dialog's. Its bar fills from the reading side: from the right in Arabic.
//  - reducedMotion() (src/ui/terminal.js): the charge-up goes straight to its announcement, and the rainbow stands still
//    (paintUltra's default phase is fixed instead of following the clock).
//  - Without colour (NO_COLOR, a pipe) nothing is painted and nothing moves.
import { c, colorLevel, fg, sym } from "./theme.js";
import { t } from "../i18n/index.js";
import { layoutParagraph, stringWidth, stripAnsi } from "../text/display.js";
import { stripBidiMarks } from "./textfit.js";
import { withLang } from "./strings.js";
import { reducedMotion } from "./terminal.js";
import "./strings-app.js";

export const ULTRA = "ultracode";
const TITLE = "U L T R A C O D E";
const CYCLE_MS = 2400;
const GUTTER = 2;

const HUES = [[255, 95, 109], [255, 160, 80], [255, 220, 90], [120, 222, 130], [80, 200, 255], [125, 140, 255], [205, 125, 255]];
const ANSI16 = [31, 33, 33, 32, 36, 34, 35];
const WORD = /ultracode/gi;
const MENTION = /(^|[^\p{L}\p{N}_])ultracode(?=[^\p{L}\p{N}_]|$)/iu;

const lerp = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const wrap01 = x => ((x % 1) + 1) % 1;

/** The text column for a terminal `columns` wide - views.js contentWidth, repeated here because views.js imports this file. */
const contentOf = columns => Math.max(20, Math.min(100, (columns | 0 || 80) - 2 * GUTTER));

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

/** The phase a row is painted at when the caller names none: the clock's, or a fixed one under reduced motion. */
function livePhase() {
  return reducedMotion() ? 0 : phaseAt();
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

/**
 * A finished row with every "ultracode" in it painted. Rows without the word come back unchanged.
 * Each painted letter ends with the default foreground (SGR 39). Inside a span that has a colour of its own - dim is
 * one on the classic console - paint the word FIRST and style the span afterwards: the span then opens its colour again
 * after every letter, where painting the styled span would leave the rest of it at full strength.
 */
export function paintUltra(row, phase = livePhase()) {
  const s = String(row ?? "");
  if (!colorLevel() || s.search(WORD) === -1) return s;
  return s.replace(WORD, word => rainbow(word, phase));
}

/** Does a message ask for ultracode by naming it (as a word of its own, any case)? */
export function mentionsUltra(text) {
  return MENTION.test(String(text ?? ""));
}

/** A finished row in a column `width` wide: as it is in English, against the right edge in Arabic. */
function placeRow(line, width, rtl) {
  const w = stringWidth(stripAnsi(line));
  return rtl ? " ".repeat(Math.max(0, width - w)) + line : line;
}

/** "✦ U L T R A C O D E ✦" - the second star, then the first, give way on a column too narrow for them. */
function titleRow(phase, width) {
  const title = c.bold(rainbow(TITLE, phase + 0.1));
  const star = sym.star;
  const room = stringWidth(TITLE);
  if (room + 2 * (stringWidth(star) + 1) <= width) return `${rainbow(star, phase)} ${title} ${rainbow(star, phase + 0.8)}`;
  if (room + stringWidth(star) + 1 <= width) return `${rainbow(star, phase)} ${title}`;
  return title;
}

/**
 * A sentence wrapped to the column, dimmed, on the same edge as the title (the right one in Arabic). The word is painted
 * before the row is dimmed, so the dim wrapper opens itself again after each letter (see paintUltra).
 */
function sentence(text, width, rtl, phase) {
  const rows = layoutParagraph(text, width, rtl ? { dir: "rtl", align: "end" } : { dir: "ltr", align: "start" });
  return rows.map(row => c.dim(paintUltra(stripBidiMarks(row), phase)));
}

/**
 * The lines left on screen once ultracode is on, for a CONTENT column `width` wide (the printer adds the gutter, as
 * ui.print does). The text is in `lang`, whatever the interface language is at the moment.
 */
export function ultraAnnouncement({ width = 80, lang = "en", phase = 0 } = {}) {
  const rtl = lang === "ar";
  const w = Math.max(10, Math.floor(width) || 80);
  return withLang(lang, () => [
    "",
    placeRow(titleRow(phase, w), w, rtl),
    ...sentence(t("app.effort.ultra.on"), w, rtl, phase),
    ...sentence(t("app.effort.ultra.word"), w, rtl, phase),
    "",
  ]);
}

/**
 * The charge-up: a bar fills along the rainbow while the title lights up letter by letter, then the announcement stays.
 * screen: { isTTY, width(), setLive(lines), clearLive() }; print(lines) writes finished lines above the live region and
 * adds the gutter to them (ui.print). The extra `still` (reduced motion; by default reducedMotion() of the environment)
 * skips the frames, and an aborted `signal` ends them early.
 * host (instead of the screen's live region): a dialog host of the interactive UI ({ width(), show(lines) }), which puts
 * the rows in the text column itself. The frames are left on it: whoever opened the dialog hides it.
 */
export async function playUltraIntro({ screen, host, print, lang = "en", frames = 18, frameMs = 55, sleep, signal, still = reducedMotion() } = {}) {
  const wait = sleep || (ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  const onHost = !!(host && typeof host.show === "function");
  const columns = Math.max(24, (screen && typeof screen.width === "function" ? screen.width() : 80) || 80);
  const width = onHost ? Number(host.width()) || contentOf(columns) : contentOf(columns);
  const rtl = lang === "ar";
  const live = !still && colorLevel() > 0 && (onHost || !!(screen && screen.isTTY && typeof screen.setLive === "function"));
  if (live) {
    // In front of every live row: the gutter, and in Arabic the margin that puts the column against the right edge. A
    // dialog host adds both itself.
    const lead = onHost ? "" : " ".repeat(GUTTER + (rtl ? Math.max(0, columns - 2 * GUTTER - width) : 0));
    const draw = onHost ? rows => host.show(rows, null) : rows => screen.setLive(rows);
    const barW = Math.max(10, Math.min(40, width - 2));
    const titleW = stringWidth(stripAnsi(titleRow(0, width)));
    const full = sym.barFull;
    const empty = sym.barEmpty;
    const star = sym.star;
    try {
      for (let k = 1; k <= frames && !signal?.aborted; k++) {
        const done = k / frames;
        const n = Math.round(barW * done);
        const shown = TITLE.slice(0, Math.ceil(TITLE.length * done));
        // The title keeps the place it ends in while it lights up (it is padded to its final width).
        const lit = `${rainbow(star, done * 2)} ${c.bold(rainbow(shown, done * 1.5))}`;
        const head = lit + " ".repeat(Math.max(0, titleW - stringWidth(stripAnsi(lit))));
        const filled = rainbow(full.repeat(n), done * 2, 1 / barW);
        const rest = c.gray(empty.repeat(barW - n));
        const bar = rtl ? rest + filled : filled + rest;
        draw([lead + placeRow(head, width, rtl), lead + placeRow(bar, width, rtl)]);
        await wait(frameMs);
      }
    } finally {
      if (!onHost) screen.clearLive?.();
    }
  }
  if (typeof print === "function") print(ultraAnnouncement({ width, lang, phase: 0 }));
}
