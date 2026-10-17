// The single animated status line:   ✻ Thinking… (12s · ↑ 3.2k) · esc to interrupt
//                                   ✻ يفكر… (12ث · ↑ 3.2k) · Esc للإيقاف
//
// Decisions:
//  - The verb comes from the phase (waiting / thinking / writing / tool) and changes gently every 4 s inside it; the
//    starting verb differs per run (seeded by the start time) so repeated turns do not all open with the same word.
//    A caller-supplied label (for example the tool being run) replaces the verb and is shown as given.
//  - The glyph: on terminals with at least 256 colours the star breathes slowly between two teals; on poorer terminals
//    it cycles the theme's spinner frames (slowed down for the 4-frame ASCII set). Nothing else on the line moves.
//  - Time and counters keep Latin digits in both languages; units are s/m/h or ث/د/س. The arrow is "^" when the
//    terminal cannot draw it. The parenthesis shows once a second has passed or tokens are known.
//  - Width fitting drops parts in this order: the interrupt hint, the counters, then the verb is cut with an
//    ellipsis. The text is cut BEFORE it is shaped and ordered, so a line is never a half-reversed fragment.
//  - In Arabic the line is right-aligned (the glyph sits at the right edge, like every Arabic paragraph); in English it
//    is left-aligned.
//  - now() and the timer are injectable for tests; the timer is unref'd, so a forgotten spinner never keeps the
//    process alive.
//  - An ultracode turn (set({ ultra: true })) is the exception to "nothing else moves": the glyph and the verb cycle
//    through the rainbow and a painted "ultracode" tag sits before the counters (src/ui/ultra.js). The verb is one colour
//    at a time, so Arabic shaping is untouched; the tag is painted letter by letter on the finished line.
import { c, sym, hasUnicode, colorLevel, fg, PALETTE } from "./theme.js";
import { ULTRA, paintUltra, phaseAt, rainbowSolid } from "./ultra.js";
import { stringWidth, toVisual } from "../text/display.js";
import { t } from "../i18n/index.js";
import { tList, withLang } from "./strings.js";
import { clipLine } from "./screen.js";
import { fitLogical, stripBidiMarks } from "./textfit.js";

const TICK_MS = 80;
const VERB_MS = 4000;
const SHIMMER_MS = 2200;
const PHASES = ["waiting", "thinking", "writing", "tool"];
const UP = hasUnicode ? "↑" : "^";

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

/**
 * createSpinner({ onFrame, lang }) -> { start, stop, isRunning, set, line }  
 * onFrame() is called about every 80 ms while running (the caller redraws the live region); lang() returns "ar" | "en".
 * Extra optional parameters, for tests: now(), setTimer(fn, ms), clearTimer(handle).
 */
export function createSpinner({ onFrame = () => {}, lang = () => "en", now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
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
    }, TICK_MS);
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

  function glyph(at) {
    if (ultra && colorLevel()) {
      const frames = sym.spinner;
      const char = colorLevel() >= 2 ? sym.think : frames[Math.floor(Math.max(0, at - startedAt) / TICK_MS / 2) % frames.length];
      return rainbowSolid(char, phaseAt(at));
    }
    if (colorLevel() >= 2) {
      const k = 0.5 - 0.5 * Math.cos(((at % SHIMMER_MS) / SHIMMER_MS) * 2 * Math.PI);
      const low = lerp(PALETTE.accent, [0, 0, 0], 0.4);
      const high = lerp(PALETTE.accentSoft, [255, 255, 255], 0.2);
      return fg(lerp(low, high, k), 36)(sym.think);
    }
    const frames = sym.spinner;
    const step = Math.floor(Math.max(0, at - startedAt) / TICK_MS / (frames.length <= 4 ? 2 : 1));
    return c.accent(frames[step % frames.length]);
  }

  function verb(at) {
    if (label) return label.replace(/(\.{2,}|…)+$/, "");
    const list = tList(`verb.${phase}`);
    if (!list.length) return "";
    const step = Math.floor(Math.max(0, at - phaseSince) / VERB_MS) + Math.floor(startedAt / 1000);
    return list[((step % list.length) + list.length) % list.length];
  }

  function build(width, l) {
    const at = now();
    const elapsed = Math.max(0, at - startedAt);
    const mark = glyph(at);
    const markW = stringWidth(sym.think);
    const stats = [];
    if (elapsed >= 1000 || tokens > 0) {
      const parts = [formatElapsed(elapsed, l)];
      if (tokens > 0) parts.push(`${UP} ${formatTokens(tokens)}`);
      stats.push(`(${parts.join(` ${sym.dot} `)})`);
    }
    const hint = t("term.spinner.interrupt");
    const room = Math.max(1, width - markW - 1);
    let head = `${verb(at)}${sym.ellipsis}`;
    let tail = "";
    const tag = ultra ? ` ${ULTRA}` : "";
    const withStats = stats.length ? ` ${stats[0]}` : "";
    const withHint = ` ${sym.dot} ${hint}`;
    if (stringWidth(head + tag + withStats + withHint) <= room) tail = tag + c.dim(withStats + withHint);
    else if (stringWidth(head + tag + withStats) <= room) tail = tag + c.dim(withStats);
    else if (tag && stringWidth(head + tag) <= room) tail = tag;
    else head = fitLogical(head, room, sym.ellipsis);
    const paintHead = ultra && colorLevel() ? s => rainbowSolid(s, phaseAt(at) + 0.2) : c.accent;
    const plain = `${mark} ${paintHead(head)}${tail}`;
    const out = toVisual(plain, l === "ar" ? { dir: "rtl", width, align: "end" } : { dir: "ltr" });
    const clean = stripBidiMarks(out);
    const fitted = stringWidth(clean) > width ? clipLine(clean, width) : clean;
    return ultra ? paintUltra(fitted, phaseAt(at)) : fitted;
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
