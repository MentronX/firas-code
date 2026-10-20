// The single animated status line:   ✻ Thinking… (12s · ↑ 3.2k) · Esc to interrupt
//                                   ✻ يفكر… (12ث · ↑ 3.2k) · Esc للإيقاف
//
// Decisions:
//  - The verb comes from the phase (waiting / thinking / writing / tool) and changes gently every 4 s inside it; the
//    starting verb differs per run (seeded by the start time) so repeated turns do not all open with the same word.
//    A caller-supplied label (for example the tool being run) replaces the verb and is shown as given.
//  - One ellipsis after the verb or the label, never two: a label that already ends in one keeps it (written in the
//    glyph tier's form), and a label that ends with a closing bracket gets none - "Stopping (press Ctrl+C again to
//    leave)…" reads as a stray mark.
//  - The glyph: in the full glyph tier on terminals with at least 256 colours the star (sym.think) breathes slowly
//    between two teals. Everywhere else the theme's spinner frames turn (slowed down for the 4-frame sets): the console
//    tier's star is a plain sun that cannot show motion, and its frames ∙ • ● • can; with 256 colours or more they take
//    the same breathing colour. Nothing else on the line moves.
//  - reducedMotion() (src/ui/terminal.js): one glyph, the star, in the plain accent; nothing turns or breathes, and the
//    clock still ticks (four times a second: it only shows seconds).
//  - Time and counters keep Latin digits in both languages; units are s/m/h or ث/د/س, the arrow comes from the glyph
//    tier. The parenthesis shows once a second has passed or tokens are known. In Arabic every number-and-unit run
//    ("1د", "12ث") and the token count ("↑ 3.2k") sit in their own left-to-right isolates: a run keeps its shape and the
//    count keeps its arrow in front, while the parts themselves follow the line from the right.
//  - Width fitting drops parts in this order: the interrupt hint, the counters, then the verb is cut with an ellipsis.
//    The LOGICAL text is fitted before it is shaped and ordered, so a line is never a half-reversed fragment and an
//    ordered line is never cut (in Arabic its left columns are the end of the sentence).
//  - In Arabic the line is right-aligned and the glyph sits at the right edge, where the line starts. The glyph is put
//    there after the text is ordered: a line with no Arabic letter in it (a tool label once the counters are dropped)
//    is not reordered at all, and the glyph would otherwise stay on its left.
//  - now() and the timer are injectable for tests; the timer is unref'd, so a forgotten spinner never keeps the
//    process alive.
//  - An ultracode turn (set({ ultra: true })) is the exception to "nothing else moves": the glyph and the verb cycle
//    through the rainbow and a painted "ultracode" tag sits before the counters (src/ui/ultra.js). The verb is one colour
//    at a time, so Arabic shaping is untouched; the tag is painted letter by letter on the finished line. Under
//    reducedMotion the rainbow stands still.
import { c, sym, tier, colorLevel, fg, PALETTE } from "./theme.js";
import { ULTRA, paintUltra, phaseAt, rainbowSolid } from "./ultra.js";
import { stringWidth, toVisual } from "../text/display.js";
import { t } from "../i18n/index.js";
import { tList, withLang } from "./strings.js";
import { fitLogical, ltrIsolate, stripBidiMarks } from "./textfit.js";
import { reducedMotion } from "./terminal.js";

const TICK_MS = 80;
const STILL_TICK_MS = 250;
const VERB_MS = 4000;
const SHIMMER_MS = 2200;
const PHASES = ["waiting", "thinking", "writing", "tool"];
const UP = sym.up;
// What already ends a label: an ellipsis (three dots or the single glyph) or a closing bracket or quote.
const ENDS_ELLIPSIS = /(?:\.{2,}|\u2026)+$/;
const ENDS_CLOSED = /[)\]}\u00bb\u201d\u2019]$/;

const lerp = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

/** "7s", "1m 12s", "1h 2m"  (ث / د / س in Arabic). */
export function formatElapsed(ms, lang) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return withLang(lang, () => {
    const u = { s: t("term.unit.s"), m: t("term.unit.m"), h: t("term.unit.h") };
    if (total < 60) return `${total}${u.s}`;
    if (total < 3600) return `${Math.floor(total / 60)}${u.m} ${total % 60}${u.s}`;
    return `${Math.floor(total / 3600)}${u.h} ${Math.floor((total % 3600) / 60)}${u.m}`;
  });
}

/** 842 -> "842", 3200 -> "3.2k", 12500 -> "13k", 1_400_000 -> "1.4m". */
export function formatTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  const strip = x => x.replace(/\.0$/, "");
  if (v < 10_000) return strip((v / 1000).toFixed(1)) + "k";
  const k = Math.round(v / 1000);
  if (k < 1000) return k + "k";
  return strip((v / 1e6).toFixed(1)) + "m";
}

/** `text` followed by one ellipsis: never a second one, and none after a closing bracket. */
function trailed(text) {
  const s = String(text).trimEnd();
  if (ENDS_ELLIPSIS.test(s)) return s.replace(ENDS_ELLIPSIS, "").trimEnd() + sym.ellipsis;
  if (ENDS_CLOSED.test(s)) return s;
  return s + sym.ellipsis;
}

/** The breathing teal at time `at`. */
function breathing(at) {
  const k = 0.5 - 0.5 * Math.cos(((at % SHIMMER_MS) / SHIMMER_MS) * 2 * Math.PI);
  const low = lerp(PALETTE.accent, [0, 0, 0], 0.4);
  const high = lerp(PALETTE.accentSoft, [255, 255, 255], 0.2);
  return fg(lerp(low, high, k), 36);
}

/**
 * createSpinner({ onFrame, lang }) -> { start, stop, isRunning, set, line }
 * onFrame() is called about every 80 ms while running (the caller redraws the live region); lang() returns "ar" | "en".
 * Extra optional parameters, for tests: now(), setTimer(fn, ms), clearTimer(handle), still() (reduced motion; by
 * default reducedMotion() of the environment, read on every frame).
 */
export function createSpinner({ onFrame = () => {}, lang = () => "en", now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, still = () => reducedMotion() } = {}) {
  let running = false;
  let timer = null;
  let phase = "waiting";
  let phaseSince = 0;
  let label;
  let tokens = 0;
  let startedAt = 0;
  let ultra = false;

  function schedule() {
    timer = setTimer(() => {
      timer = null;
      if (!running) return;
      try {
        onFrame();
      } finally {
        if (running && !timer) schedule();
      }
    }, still() ? STILL_TICK_MS : TICK_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function set(o = {}) {
    if (o.phase !== undefined && PHASES.includes(o.phase) && o.phase !== phase) {
      phase = o.phase;
      phaseSince = now();
    }
    if ("label" in o) label = o.label ? String(o.label) : undefined;
    if (typeof o.tokens === "number" && Number.isFinite(o.tokens)) tokens = Math.max(0, o.tokens);
    if (typeof o.startedAt === "number" && Number.isFinite(o.startedAt)) startedAt = o.startedAt;
    if ("ultra" in o) ultra = !!o.ultra;
  }

  /** Where the rainbow of an ultracode turn is: moving, or held still under reduced motion. */
  const rainbowPhase = (at, calm) => (calm ? 0 : phaseAt(at));

  function glyph(at, calm) {
    const level = colorLevel();
    if (calm) return ultra && level ? rainbowSolid(sym.think, 0) : c.accent(sym.think);
    const frames = sym.spinner;
    const char = tier === "full" && level >= 2
      ? sym.think
      : frames[Math.floor(Math.max(0, at - startedAt) / TICK_MS / (frames.length <= 4 ? 2 : 1)) % frames.length];
    if (ultra && level) return rainbowSolid(char, phaseAt(at));
    return level >= 2 ? breathing(at)(char) : c.accent(char);
  }

  function verb(at) {
    if (label) return trailed(label);
    const list = tList(`verb.${phase}`);
    if (!list.length) return "";
    const step = Math.floor(Math.max(0, at - phaseSince) / VERB_MS) + Math.floor(startedAt / 1000);
    return trailed(list[((step % list.length) + list.length) % list.length]);
  }

  function build(width, l) {
    const at = now();
    const calm = still();
    const rtl = l === "ar";
    const elapsed = Math.max(0, at - startedAt);
    const mark = glyph(at, calm);
    const markW = stringWidth(sym.think);
    if (width < markW + 2) return width < markW ? "" : rtl ? " ".repeat(width - markW) + mark : mark;

    // Logical pieces; in Arabic the runs that must keep their own order are isolated.
    const keep = s => (rtl ? ltrIsolate(s) : s);
    let stats = "";
    if (elapsed >= 1000 || tokens > 0) {
      const parts = [formatElapsed(elapsed, l).split(" ").map(keep).join(" ")];
      if (tokens > 0) parts.push(keep(`${UP} ${formatTokens(tokens)}`));
      stats = ` (${parts.join(` ${sym.dot} `)})`;
    }
    const hint = ` ${sym.dot} ${t("term.spinner.interrupt")}`;
    const tag = ultra ? ` ${ULTRA}` : "";

    // Fitted as logical text: parts go from the end, then the verb is shortened.
    const room = width - markW - 1;
    let head = verb(at);
    let tail = "";
    if (stringWidth(head + tag + stats + hint) <= room) tail = tag + c.dim(stats + hint);
    else if (stringWidth(head + tag + stats) <= room) tail = tag + c.dim(stats);
    else if (tag && stringWidth(head + tag) <= room) tail = tag;
    else head = fitLogical(head, room, sym.ellipsis);

    const phase0 = rainbowPhase(at, calm);
    const paintHead = ultra && colorLevel() ? s => rainbowSolid(s, phase0 + 0.2) : c.accent;
    const body = `${paintHead(head)}${tail}`;
    const line = rtl
      ? stripBidiMarks(toVisual(body, { dir: "rtl", width: room, align: "end" })) + " " + mark
      : stripBidiMarks(toVisual(`${mark} ${body}`, { dir: "ltr" }));
    return ultra ? paintUltra(line, phase0) : line;
  }

  return {
    start(o) {
      if (!running) {
        running = true;
        phase = "waiting";
        label = undefined;
        tokens = 0;
        ultra = false;
        startedAt = now();
        phaseSince = startedAt;
        set(o);
        schedule();
        onFrame();
        return;
      }
      set(o);
    },
    stop() {
      running = false;
      if (timer) { clearTimer(timer); timer = null; }
    },
    isRunning: () => running,
    set,
    line(width) {
      if (!running) return "";
      return withLang(lang(), () => build(Math.max(1, width | 0), lang() === "ar" ? "ar" : "en"));
    },
  };
}
