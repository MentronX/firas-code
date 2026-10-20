// The effort picker: /effort with no argument shows every level in a box, the arrows choose, Tab jumps to ultracode.
//
//   ┌─ Effort ─────────────────────────────────────────────────────────┐
//   │ How much thinking and checking goes into each turn.              │
//   │                                                                  │
//   │   1  low          ■□□□□□   Quick answers, light checks           │
//   │ › 3  high         ■■■□□□   Reads more before it acts   current   │
//   │   6  ultracode    ■■■■■■   Parallel agents, plans, two reviews   │
//   │                                                                  │
//   │ ↑/↓ choose · Tab ultracode · Enter confirm · Esc cancel          │
//   └──────────────────────────────────────────────────────────────────┘
//
// Decisions:
//  - effortPickerLines() is PURE (the box contents, every row exactly `width` cells); runEffortPicker() owns the keys,
//    the timer and the host, and is built like runMenu in views.js (same subscribe / finish / abort shape), so a picker
//    that closes for any reason leaves no key handler, resize handler, abort listener or timer behind.
//  - Columns are measured from ALL levels (the meter and description columns do not move between rows) and laid out
//    with stringWidth. The single "current" tag follows its own row. When the box is narrow the descriptions go first,
//    then the meter, then the names are shortened; the tag stays as long as anything does, because it is what tells
//    the person where they are.
//  - Arabic: each row is laid out right to left to the full width (pointer and number on the right, as in the other
//    dialogs). The meter is an LTR isolate: it is a quantity that fills from the left in both languages, and its squares
//    are neutral characters that an RTL row would otherwise turn around.
//  - Keys: a digit only MOVES the selection and Enter confirms only after the grace period (the house rule of every
//    dialog: a key typed ahead while the agent worked must never choose for the person). Tab and Shift+Tab both jump to
//    ultracode and back, because the classic console can send Shift+Tab as a plain Tab.
//  - Motion: the ultracode name is always in its rainbow; while that row is SELECTED, colour is on and motion is not
//    reduced, the box is redrawn every 80 ms with a moving phase so the rainbow shimmers. The timer exists only while
//    the ultracode row is selected and never outlives the picker.
import { c, sym, colorLevel } from "./theme.js";
import { t, getLang } from "../i18n/index.js";
import { arabicActive, hasRtl, stringWidth, toVisual } from "../text/display.js";
import { boxWidth, frame, menuHint, padEnd, truncateLogical } from "./views.js";
import { ULTRA, paintUltra, phaseAt } from "./ultra.js";
import { reducedMotion } from "./terminal.js";
import { effortLabel, withLang } from "./strings.js";
import { ltrIsolate, stripBidiMarks } from "./textfit.js";
import { EFFORTS } from "../config.js";
import "./strings-app.js";
import "./strings-effort.js";

const GAP = 3; // between the name, the meter and the description
const TAG_GAP = 2; // in front of the "current" tag
const MIN_DESC = 12; // a description cut shorter than this says nothing: it is dropped instead
const FRAME_MS = 80;
const RLM = "\u200f";

/**
 * `text` shortened with an ellipsis to at most `room` cells. truncateLogical alone can come out a cell too wide: it cuts
 * where a lam-alef pair is one cell (shaped), and with Arabic display off the row is measured with that pair as two. So
 * the cut is measured the way the row is, and made shorter until it fits.
 */
function fit(text, room) {
  for (let cells = room; cells > 0; cells--) {
    const out = truncateLogical(text, cells);
    if (stringWidth(out) <= room) return out;
  }
  return "";
}

/** The short description of a level: the picker's own text, else the plain menu's hint, else nothing. */
function describe(level) {
  for (const key of [`app.effortpick.desc.${level}`, `app.effort.hint.${level}`]) {
    const text = t(key);
    if (text !== key) return text;
  }
  return "";
}

/**
 * Which columns fit in `width`, given the widest entry of each. There is one "current" tag, so it needs no column of
 * its own: it follows its row's last part, and the description of that one row is shortened to make room for it.
 * Returns { nameW, meter, descW, tagGap, tag } (descW 0: no descriptions).
 */
function plan(width, m) {
  const lead = 4 + m.numW; // pointer, space, number, two spaces
  const base = lead + m.nameW;
  const withMeter = base + GAP + m.meterW;
  const descRoom = width - withMeter - GAP;
  const tagRoom = GAP + m.tagW;
  if (m.descW > 0 && descRoom - tagRoom >= Math.min(m.descW, MIN_DESC)) {
    return { nameW: m.nameW, meter: true, descW: Math.min(m.descW, descRoom), tagGap: GAP, tag: true };
  }
  if (withMeter + tagRoom <= width) return { nameW: m.nameW, meter: true, descW: 0, tagGap: GAP, tag: true };
  if (base + TAG_GAP + m.tagW <= width) return { nameW: m.nameW, meter: false, descW: 0, tagGap: TAG_GAP, tag: true };
  const nameRoom = width - lead - TAG_GAP - m.tagW;
  if (nameRoom >= 4) return { nameW: nameRoom, meter: false, descW: 0, tagGap: TAG_GAP, tag: true };
  return { nameW: Math.max(1, width - lead), meter: false, descW: 0, tagGap: 0, tag: false };
}

/** A finished line of the box: shaped, ordered, exactly `width` cells, mirrored in the Arabic interface. */
function place(logical, width, rtl) {
  const line = rtl ? toVisual(logical, { dir: "rtl", width, align: "end" }) : toVisual(logical, { dir: "ltr" });
  return padEnd(stripBidiMarks(line), width);
}

/**
 * The key hint from its parts; parts are dropped from the end, never wrapped, when the box is narrow. The word
 * ultracode is painted BEFORE the hint is dimmed: painted afterwards, each letter's colour reset would end the muted
 * colour the classic console uses for dim, and the rest of the hint would print at full strength.
 */
function hintLine(levels, width, phase, onUltra = false) {
  const parts = [menuHint("app.effortpick.key.choose")];
  // On ultracode, Tab goes back to the row it came from: the hint says what the key does NOW.
  if (levels.includes(ULTRA)) parts.push(t(onUltra ? "app.effortpick.key.tabBack" : "app.effortpick.key.tab"));
  parts.push(t("app.effortpick.key.confirm"), t("app.effortpick.key.cancel"));
  const sep = ` ${sym.dot} `;
  let shown = parts;
  while (shown.length > 1 && stringWidth(shown.join(sep)) > width) shown = shown.slice(0, -1);
  const text = stringWidth(shown.join(sep)) > width ? fit(shown[0], width) : shown.join(sep);
  return c.dim(paintUltra(text, phase));
}

/**
 * The box contents of the picker, as visual lines that are all exactly `width` cells wide.
 * o: { levels = EFFORTS, selected (index or level), current (level), width, lang, phase (rainbow phase, 0..1) }
 */
export function effortPickerLines({ levels = EFFORTS, selected = 0, current, width = 60, lang, phase = 0 } = {}) {
  const list = Array.from(levels || []);
  const w = Math.max(1, width | 0);
  return withLang(lang || getLang(), () => {
    const rtl = getLang() === "ar" && arabicActive();
    const at = typeof selected === "string" ? list.indexOf(selected) : selected | 0;
    // The names are measured and shortened without their direction isolates (a cut inside one would leave it open and
    // pull the rest of the row into it); a Latin name gets its isolate back once it has its final length.
    const names = list.map(level => stripBidiMarks(effortLabel(level)));
    const descs = list.map(describe);
    const tag = t("app.effortpick.current");
    const m = {
      numW: String(list.length).length,
      nameW: Math.max(0, ...names.map(name => stringWidth(name))),
      meterW: list.length,
      descW: Math.max(0, ...descs.map(text => stringWidth(text))),
      tagW: stringWidth(tag),
    };
    const p = plan(w, m);
    const blank = " ".repeat(w);
    const rows = list.map((level, i) => {
      const on = i === at;
      const isCurrent = p.tag && level === current;
      const pointer = on ? c.accent(sym.prompt) : " ";
      const number = c.gray(String(i + 1).padStart(m.numW));
      const name = stringWidth(names[i]) > p.nameW ? fit(names[i], p.nameW) : names[i];
      const shown = rtl && !hasRtl(name) ? ltrIsolate(name) : name;
      let logical = `${pointer} ${number}${rtl ? RLM : ""}  ${on ? c.bold(c.accent(shown)) : shown}`;
      const fillTo = cells => " ".repeat(Math.max(0, cells));
      if (p.meter || isCurrent) logical += fillTo(p.nameW - stringWidth(name));
      if (p.meter) {
        const fill = Math.min(m.meterW, i + 1);
        const filled = sym.meterOn.repeat(fill);
        const meter = (on ? c.accent(filled) : c.dim(filled)) + (fill < m.meterW ? c.gray(sym.meterOff.repeat(m.meterW - fill)) : "");
        logical += " ".repeat(GAP) + (rtl ? ltrIsolate(meter) : meter);
      }
      if (p.descW) {
        // The one row that carries the tag gives its description the room the tag takes.
        const room = isCurrent ? Math.min(p.descW, w - (4 + m.numW + p.nameW + GAP + m.meterW + GAP) - p.tagGap - m.tagW) : p.descW;
        const text = fit(descs[i], room);
        if (text) logical += " ".repeat(GAP) + c.dim(text);
      }
      if (isCurrent) logical += " ".repeat(p.tagGap) + c.dim(tag);
      // The ultracode name is painted on the finished row (the word is Latin, so it reads the same once ordered).
      return paintUltra(place(logical, w, rtl), phase);
    });
    const subtitle = c.dim(fit(t("app.effortpick.subtitle"), w));
    return [place(subtitle, w, rtl), blank, ...rows, blank, place(hintLine(list, w, phase, list[at] === ULTRA), w, rtl)];
  });
}

/**
 * Runs the picker in the interactive UI's dialog host and resolves the chosen level, or null (Esc, Ctrl+C, abort).
 * host: { width(), show(lines, cursor), hide(), onKey(cb) -> off, onResize?(cb) -> off }.
 * o: { levels, current, graceMs, signal, lang, now, setTimer, clearTimer, env } (the last four for tests: the clock,
 *    the frame timer, and the environment reducedMotion() reads).
 */
export function runEffortPicker(host, { levels = EFFORTS, current, graceMs = 250, signal, lang, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, env = process.env } = {}) {
  return new Promise(resolve => {
    const list = Array.from(levels || []);
    if (!list.length) { resolve(null); return; }
    const count = list.length;
    const ultraAt = list.indexOf(ULTRA);
    const currentAt = list.indexOf(current);
    let selected = Math.max(0, currentAt);
    let cameFrom = null; // the row that was selected just before ultracode was
    let done = false;
    let timer = null;
    const openedAt = now();
    const title = withLang(lang || getLang(), () => t("app.effortpick.title"));

    const moving = () => !done && selected === ultraAt && colorLevel() > 0 && !reducedMotion(env);
    const stopTimer = () => { if (timer) { clearTimer(timer); timer = null; } };
    const syncTimer = () => {
      if (!moving()) { stopTimer(); return; }
      if (timer) return;
      timer = setTimer(() => { timer = null; if (!done) draw(); }, FRAME_MS);
      if (timer && typeof timer.unref === "function") timer.unref();
    };
    function draw() {
      // The width is read on every draw: a resize redraws the box at the new size, borders and rows alike. The box
      // follows the rule every dialog shares (boxWidth): a floor of its own would push it past a narrow terminal.
      const { outer, inner } = boxWidth(Number(host.width()) || 80);
      const phase = moving() ? phaseAt(now()) : 0;
      const body = effortPickerLines({ levels: list, selected, current, width: inner, lang, phase });
      host.show(frame(body, { width: outer, title, risk: "low" }), null);
      syncTimer();
    }
    const move = to => {
      if (to === ultraAt && selected !== ultraAt) cameFrom = selected;
      selected = to;
      draw();
    };
    const toggleUltra = () => {
      if (ultraAt < 0) return;
      if (selected !== ultraAt) { move(ultraAt); return; }
      const fallback = currentAt >= 0 && currentAt !== ultraAt ? currentAt : Math.max(0, ultraAt - 1);
      move(cameFrom !== null && cameFrom !== ultraAt ? cameFrom : fallback);
    };
    const finish = result => {
      if (done) return;
      done = true;
      stopTimer();
      off();
      offResize?.();
      signal?.removeEventListener("abort", onAbort);
      host.hide();
      resolve(result);
    };
    const onAbort = () => finish(null);
    const onKey = key => {
      if (done || !key) return;
      const grace = now() - openedAt < graceMs;
      const letter = key.name === "char" && !key.alt ? String(key.ch || "") : "";
      const ctrl = ch => key.ctrl && letter.toLowerCase() === ch;
      if (key.name === "escape" || ctrl("c")) { finish(null); return; }
      if (key.name === "up" || ctrl("p")) { move((selected + count - 1) % count); return; }
      if (key.name === "down" || ctrl("n")) { move((selected + 1) % count); return; }
      if (key.name === "home") { move(0); return; }
      if (key.name === "end") { move(count - 1); return; }
      if (key.name === "tab" || key.name === "backtab") { toggleUltra(); return; }
      if (!key.ctrl && /^[1-9]$/.test(letter) && Number(letter) <= count) {
        if (!grace) move(Number(letter) - 1);
        return;
      }
      if (key.name === "return" && !grace) finish(list[selected]);
      // Anything else (a paste, a letter, an unknown sequence) is ignored.
    };
    const off = host.onKey(onKey);
    const offResize = host.onResize?.(draw);
    if (signal?.aborted) { finish(null); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    draw();
  });
}
