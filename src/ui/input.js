// The prompt: a multiline line editor drawn in the screen's live region.
//
// Layering. The editor is a pure state machine, reduce(state, key, ctx) -> { state, effects }, tested key by key.
// render(state, ctx, opts) turns a state into the lines of the live region and the caret position. readPrompt() is the
// thin glue: it feeds Screen keys to reduce(), carries out the effects (submit, hooks, debounced file lookups, timers)
// and calls screen.setLive(). All text geometry (wrapping, bidi, caret) comes from layoutInput / moveCursorVisual in
// src/text/display.js; cursor indexes in the state are LOGICAL UTF-16 indexes into state.text.
//
// Decisions:
//  - The box is two gray rules (top and bottom) with the text between them: no side borders, so nothing can misalign
//    when a terminal draws an Arabic ligature one cell off, and copy/paste of the text stays clean. One row when empty.
//    The prompt glyph (opts.prefix) is on the first row, other rows are indented by its width (or opts.continuationPrefix).
//  - Rows of right-to-left text are right-aligned (layoutInput align "auto"): typing Arabic grows the line to the
//    left from the right edge, which is how a real RTL field behaves. At the very end of such a row a block cursor would
//    cover the letter just typed, so the terminal caret is parked on the free cell left of it (where the next letter
//    will appear).
//  - Enter submits; Enter with ctrl, alt or shift, and Ctrl+J, insert a newline (see keys.js: LF arrives as ctrl+return);
//    a backslash right before the caret turns Enter into a newline too. Blank input is never submitted. (Alt+Enter is
//    taken by the window in Windows Terminal and the classic console, so /help offers Ctrl+J and the backslash.)
//  - The empty box shows a dim hint built from parts (strings-input.js). An Arabic hint is right-aligned and ends on the
//    last cell, where typed Arabic ends too; the caret waits on that cell, the mirror of the English hint.
//  - Large pastes (>= 3 lines or >= 200 characters) are stored aside and appear as ONE private-use character in
//    state.text (U+E000 + n); the view swaps it for the chip "[pasted text · N lines]". The chip is atomic: arrows,
//    Backspace and word jumps treat it as one character, and submit() expands it to the full text. Typed or pasted
//    private-use characters are dropped so a sentinel can never be forged.
//  - Slash menu: opens while the caret is inside the first token of a text that starts with "/". Tab fills the highlighted
//    command ("/name "); Enter fills it too, except when the token already IS that command, then Enter submits - so
//    "/he" + Enter never runs something the user did not finish typing. File picker: an "@" that starts a word opens
//    it; results come from opts.files(query), asked 80 ms after the last keystroke, stale answers are discarded. Enter
//    and Tab insert "@path " (quoted when the path has spaces) and never submit. Esc closes a menu until the text changes.
//  - The menu items may be the account's skills too ({ name, description, kind: "skill" }, after the commands): they
//    filter and fill exactly like commands and carry a dim "skill" tag on the far side of their row.
//  - Menu rows are laid out as COLUMNS measured over every matching item, not only the rows on screen, so the
//    descriptions do not jump sideways while the list scrolls. Each column is ordered on its own (a name, a
//    description, a tag), so an Arabic description can never pull the "/" of a name or a counter across the row. In the
//    Arabic interface the rows are mirrored and right-aligned like the dialogs: pointer and name on the right, the
//    description to their left, the tag and the scroll counter on the far (left) side.
//  - Up/Down move between VISUAL rows keeping the column; at the first/last row they browse history (the draft is
//    kept and comes back after the newest entry). With nothing more to browse they jump to the start/end of the text.
//  - Words (Ctrl+Left/Right, Alt+Left/Right) are skipped in VISUAL direction like the arrows; Alt+B / Alt+F, Ctrl+W,
//    Alt+D work on the LOGICAL order. A word is a run of letters, digits, marks and underscore (so "/" and "." stop it).
//  - Backspace/Delete remove a whole grapheme cluster (letter + marks, surrogate pair, emoji sequence).
//  - Ctrl+C with text clears it and shows "press Ctrl+C again to exit" for 2 s; with no text it exits. Esc clears too.
//  - Secret mode (opts.mask): one mask glyph per code point, no history, menus, chips or backslash continuation, pasted
//    newlines are dropped, nothing is trimmed.
import { arabicActive, layoutInput, layoutParagraph, moveCursorVisual, stringWidth, stripAnsi, toVisual, hasRtl } from "../text/display.js";
import { c, sym } from "./theme.js";
import { t, getLang } from "../i18n/index.js";
import { countText } from "./strings.js";
import { clipLine } from "./screen.js";
import { fitLogical, fitPathTail, stripBidiMarks } from "./textfit.js";
import { paintUltra } from "./ultra.js";
import "./strings-input.js";

const CHIP0 = 0xe000;
const CHIP_MAX = 256;
const CHIP_RE = /[\ue000-\ue0ff]/g;
const MAX_MENU_ROWS = 8;
const MAX_INPUT_ROWS = 12;
const FILE_DEBOUNCE_MS = 80;
const HINT_MS = 2000;

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

// ---------------------------------------------------------------------------------------------
// Text helpers

/** Newlines normalised, tabs expanded, control characters and chip sentinels removed. */
function sanitize(s) {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    // Whole escape sequences first: removing only the ESC byte left "[31m" / "[0m" as literal text
    // when coloured output was pasted into the prompt.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(CHIP_RE, "");
}

/** Grapheme-cluster boundaries of `text` as UTF-16 indexes, 0 and text.length included. */
function boundaries(text) {
  const out = [0];
  if (!text) return out;
  if (segmenter) {
    for (const seg of segmenter.segment(text)) if (seg.index > 0) out.push(seg.index);
  } else {
    const re = /[\s\S][\p{M}\u200d\ufe0f]*/gu;
    let m;
    while ((m = re.exec(text))) if (m.index > 0) out.push(m.index);
  }
  out.push(text.length);
  return out;
}

function prevBoundary(text, i) {
  if (i <= 0) return 0;
  const a = text.charCodeAt(i - 1);
  if (a < 0x300 && (i === 1 || text.charCodeAt(i - 2) < 0x300) && (i >= text.length || text.charCodeAt(i) < 0x300) && a !== 13) return i - 1;
  const b = boundaries(text);
  let lo = 0;
  for (let k = 0; k < b.length; k++) { if (b[k] < i) lo = b[k]; else break; }
  return lo;
}

function nextBoundary(text, i) {
  if (i >= text.length) return text.length;
  const a = text.charCodeAt(i);
  if (a < 0x300 && (i + 1 >= text.length || text.charCodeAt(i + 1) < 0x300) && a !== 13 && (i === 0 || text.charCodeAt(i - 1) < 0x300)) return i + 1;
  const b = boundaries(text);
  for (let k = 0; k < b.length; k++) if (b[k] > i) return b[k];
  return text.length;
}

const WORD_RE = /^[\p{L}\p{N}\p{M}_\p{Co}]$/u;
function isWordAt(text, i) {
  if (i < 0 || i >= text.length) return false;
  return WORD_RE.test(String.fromCodePoint(text.codePointAt(i)));
}

function wordLeft(text, i) {
  if (i > 0 && text[i - 1] === "\n") return i - 1;
  let j = i;
  while (j > 0) { const p = prevBoundary(text, j); if (isWordAt(text, p) || text[p] === "\n") break; j = p; }
  while (j > 0) { const p = prevBoundary(text, j); if (!isWordAt(text, p)) break; j = p; }
  return j;
}

function wordRight(text, i) {
  if (i < text.length && text[i] === "\n") return i + 1;
  let j = i;
  while (j < text.length) { if (isWordAt(text, j) || text[j] === "\n") break; j = nextBoundary(text, j); }
  while (j < text.length) { if (!isWordAt(text, j)) break; j = nextBoundary(text, j); }
  return j;
}

const lineStart = (text, i) => text.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (text, i) => { const k = text.indexOf("\n", i); return k === -1 ? text.length : k; };

// ---------------------------------------------------------------------------------------------
// Paste chips and the displayed text

// A chip keeps the pasted text and its size, counted once (a label is rebuilt on every keystroke).
function describePaste(text) {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  let lines = 1;
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1)) lines++;
  return { text, lines, chars: lines === 1 ? [...body].length : body.length };
}

function chipLabel(chip) {
  const amount = chip && chip.lines >= 2 ? countText("lines", chip.lines) : countText("chars", chip ? chip.chars : 0);
  return `[${t("term.chip.label")} ${sym.dot} ${amount}]`;
}

const chipText = (state, ch) => (state.chips[ch.charCodeAt(0) - CHIP0] || { text: "" }).text;

/** Expands the chips: what submit() returns. */
export function expandText(state) {
  if (!state.chips.length) return state.text;
  return state.text.replace(CHIP_RE, ch => chipText(state, ch));
}

/**
 * The text as drawn: chips replaced by their label, secret text by mask glyphs. toD(i) maps an editor index to the
 * drawn index; fromD(j, origin) maps back (a drawn index inside a chip snaps across it, away from `origin`).
 */
export function viewOf(state, ctx) {
  const text = state.text;
  const masked = !!ctx.mask;
  if (!masked && !(state.chips.length && /[\ue000-\ue0ff]/.test(text))) {
    return { text, toD: i => i, fromD: j => j, plain: true };
  }
  const glyph = masked ? [...ctx.mask][0] : "";
  const map = new Array(text.length + 1);
  let out = "";
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    map[i] = out.length;
    if (len === 2) map[i + 1] = out.length;
    if (masked) out += glyph;
    else if (cp >= CHIP0 && cp < CHIP0 + CHIP_MAX) out += chipLabel(state.chips[cp - CHIP0]);
    else out += String.fromCodePoint(cp);
    i += len;
  }
  map[text.length] = out.length;
  const fromD = (j, origin) => {
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (map[mid] <= j) lo = mid; else hi = mid - 1;
    }
    let k = lo;
    const lowHalf = text.charCodeAt(k);
    if (k > 0 && lowHalf >= 0xdc00 && lowHalf <= 0xdfff && map[k] === map[k - 1]) k--;
    const next = nextBoundary(text, k);
    if (map[k] < j && j < map[next]) return origin <= k ? next : k;
    return k;
  };
  return { text: out, toD: i => map[Math.max(0, Math.min(text.length, i))], fromD, plain: false };
}

// ---------------------------------------------------------------------------------------------
// State

export function createState({ initial = "", history = [], mask = null } = {}) {
  const text = sanitize(initial);
  return {
    text,
    cursor: text.length,
    chips: [],
    hist: mask ? [] : history.filter(h => typeof h === "string" && h !== "").map(String),
    histIndex: null,
    draft: null,
    goal: null,
    menuOff: false,
    menuSig: "",
    sel: 0,
    menuTop: 0,
    files: null,
    fileSeq: 0,
    killed: "",
    armUntil: 0,
    viewTop: 0,
  };
}

const edited = (s, patch) => ({ ...s, ...patch, goal: null, menuOff: false });
const moved = (s, cursor) => ({ ...s, cursor: Math.max(0, Math.min(s.text.length, cursor)), goal: null });

function insert(s, str) {
  if (!str) return s;
  return edited(s, { text: s.text.slice(0, s.cursor) + str + s.text.slice(s.cursor), cursor: s.cursor + str.length });
}

function removeRange(s, a, b, keep) {
  if (a >= b) return s;
  const gone = s.text.slice(a, b);
  return edited(s, { text: s.text.slice(0, a) + s.text.slice(b), cursor: a, killed: keep ? expandRange(s, gone) : s.killed });
}

function expandRange(s, str) {
  return str.replace(CHIP_RE, ch => chipText(s, ch));
}

const clearAll = s => edited(s, { text: "", cursor: 0, chips: [], histIndex: null, draft: null, viewTop: 0 });

// ---------------------------------------------------------------------------------------------
// Menus

function normCommands(list) {
  const seen = new Set();
  const out = [];
  for (const cmd of list || []) {
    const name = String(cmd && cmd.name != null ? cmd.name : "").replace(/^\//, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const item = { name, description: String((cmd && cmd.description) || "") };
    if (cmd.kind === "skill") item.kind = "skill";
    out.push(item);
  }
  return out;
}

function filterCommands(list, query) {
  const q = query.toLowerCase();
  const scored = [];
  normCommands(list).forEach((cmd, order) => {
    const n = cmd.name.toLowerCase();
    const score = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : -1;
    if (score >= 0) scored.push({ cmd, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.map(x => ({ ...x.cmd, exact: x.score === 0 }));
}

/** The word under the caret that a menu cares about: { kind, query, start, end } or null. */
function tokenOf(s, ctx) {
  if (ctx.mask || s.menuOff) return null;
  const text = s.text;
  const cur = s.cursor;
  if (text[0] === "/" && ctx.commands && ctx.commands.length) {
    let end = 0;
    while (end < text.length && !/\s/.test(text[end])) end++;
    if (cur >= 1 && cur <= end) return { kind: "slash", query: text.slice(1, cur), start: 0, end };
  }
  return ctx.hasFiles ? fileToken(text, cur) : null;
}

// "@query" at the start of a word, or the quoted form @"some path" (spaces allowed until the closing quote).
function fileToken(text, cur) {
  const q = text.lastIndexOf('@"', cur - 2);
  if (q !== -1 && q + 2 <= cur && (q === 0 || /\s/.test(text[q - 1])) && !text.slice(q + 2, cur).includes('"')) {
    const close = text.indexOf('"', cur);
    return { kind: "file", query: text.slice(q + 2, cur), start: q, end: close === -1 ? lineEnd(text, cur) : close + 1 };
  }
  let k = cur;
  while (k > 0 && !/\s/.test(text[k - 1])) k--;
  if (text[k] !== "@" || k >= cur) return null;
  let end = cur;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return { kind: "file", query: text.slice(k + 1, cur), start: k, end };
}

/** The open menu with its items, or null (also while a file lookup has nothing to show). */
export function menuOf(s, ctx) {
  const token = tokenOf(s, ctx);
  if (!token) return null;
  const items = token.kind === "slash"
    ? filterCommands(ctx.commands, token.query).map(x => ({ label: "/" + x.name, name: x.name, desc: x.description, exact: x.exact, ...(x.kind ? { kind: x.kind } : {}) }))
    : ((s.files && s.files.items) || []).map(p => ({ label: p, path: p }));
  if (!items.length) return null;
  return { ...token, items, sel: Math.max(0, Math.min(s.sel, items.length - 1)) };
}

function menuCapacity(ctx) {
  const h = ctx.height || 24;
  return Math.max(0, Math.min(MAX_MENU_ROWS, h - 8));
}

/** Applies the choice highlighted in `menu` to the text. */
function selectItem(s, menu) {
  const item = menu.items[menu.sel];
  const rest = s.text.slice(menu.end);
  if (menu.kind === "slash") {
    const head = "/" + item.name;
    const gap = /^[ \t]/.test(rest) ? "" : " ";
    return edited(s, { text: head + gap + rest, cursor: head.length + 1 });
  }
  const ref = /\s/.test(item.path) ? `@"${item.path}"` : "@" + item.path;
  const gap = /^[ \t]/.test(rest) ? "" : " ";
  return edited(s, { text: s.text.slice(0, menu.start) + ref + gap + rest, cursor: menu.start + ref.length + 1 });
}

/** A lookup answer for the file picker. Answers to an older query are ignored. */
export function applyFileResults(s, seq, items) {
  if (seq !== s.fileSeq) return s;
  return { ...s, files: { items }, sel: 0, menuTop: 0 };
}

// ---------------------------------------------------------------------------------------------
// Movement that needs the layout

const padOf = ctx => " ".repeat(ctx.prefixWidth);

function visualStep(s, view, ctx, from, dir) {
  const j = moveCursorVisual(view.text, view.toD(from), dir, { width: ctx.width, prefix: padOf(ctx) });
  return view.fromD(j, from);
}

function stepArrow(s, ctx, dir) {
  const view = viewOf(s, ctx);
  return moved(s, visualStep(s, view, ctx, s.cursor, dir));
}

function wordArrow(s, ctx, dir) {
  const view = viewOf(s, ctx);
  let cur = s.cursor;
  let seenWord = false;
  for (let n = 0; n < s.text.length * 2 + 4; n++) {
    const next = visualStep(s, view, ctx, cur, dir);
    if (next === cur) break;
    const word = isWordAt(s.text, Math.min(cur, next));
    if (!seenWord && !word) { cur = next; continue; }
    if (seenWord && !word) break;
    seenWord = true;
    cur = next;
  }
  return moved(s, cur);
}

function geometry(view, cursor, ctx) {
  return layoutInput(view.text, view.toD(cursor), { width: ctx.width, prefix: padOf(ctx), align: "auto" }).cursor;
}

/** Editor index on visual row `row` whose column is closest to `goal`, or -1. */
function locate(s, view, ctx, row, goal) {
  const b = boundaries(s.text);
  let lo = 0;
  let hi = b.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (geometry(view, b[mid], ctx).row >= row) hi = mid; else lo = mid + 1;
  }
  let best = -1;
  let bestD = Infinity;
  for (let k = lo; k < b.length; k++) {
    const g = geometry(view, b[k], ctx);
    if (g.row !== row) break;
    const d = Math.abs(g.col - goal);
    if (d < bestD) { best = b[k]; bestD = d; }
  }
  return best;
}

function histUp(s) {
  if (!s.hist.length) return null;
  if (s.histIndex === null) {
    const idx = s.hist.length - 1;
    return { ...s, draft: { text: s.text, cursor: s.cursor, chips: s.chips }, histIndex: idx, text: s.hist[idx], cursor: s.hist[idx].length, chips: [], goal: null, menuOff: false };
  }
  if (s.histIndex === 0) return null;
  const idx = s.histIndex - 1;
  return { ...s, histIndex: idx, text: s.hist[idx], cursor: s.hist[idx].length, chips: [], goal: null, menuOff: false };
}

function histDown(s) {
  if (s.histIndex === null) return null;
  if (s.histIndex < s.hist.length - 1) {
    const idx = s.histIndex + 1;
    return { ...s, histIndex: idx, text: s.hist[idx], cursor: s.hist[idx].length, chips: [], goal: null, menuOff: false };
  }
  const d = s.draft || { text: "", cursor: 0, chips: [] };
  return { ...s, histIndex: null, draft: null, text: d.text, cursor: d.cursor, chips: d.chips, goal: null, menuOff: false };
}

function vertical(s, ctx, dir) {
  const view = viewOf(s, ctx);
  const here = layoutInput(view.text, view.toD(s.cursor), { width: ctx.width, prefix: padOf(ctx), align: "auto" });
  const rows = here.lines.length;
  const goal = s.goal ?? here.cursor.col;
  if (dir === "up") {
    if (here.cursor.row === 0) return histUp(s) || (s.cursor > 0 ? moved(s, 0) : s);
    const at = locate(s, view, ctx, here.cursor.row - 1, goal);
    return at < 0 ? s : { ...s, cursor: at, goal };
  }
  if (here.cursor.row >= rows - 1) return histDown(s) || (s.cursor < s.text.length ? moved(s, s.text.length) : s);
  const at = locate(s, view, ctx, here.cursor.row + 1, goal);
  return at < 0 ? s : { ...s, cursor: at, goal };
}

// ---------------------------------------------------------------------------------------------
// The reducer

function onChar(s, key, ctx, fx) {
  const ch = key.ch || "";
  if (key.ctrl && !key.alt) return onCtrl(s, ch.toLowerCase(), ctx, fx);
  if (key.alt && !key.ctrl) return onAlt(s, ch.toLowerCase());
  if (key.ctrl || key.alt) return s;
  const clean = sanitize(ch).replace(/\n/g, "");
  return clean ? insert(s, clean) : s;
}

function onCtrl(s, ch, ctx, fx) {
  switch (ch) {
    case "a": return moved(s, lineStart(s.text, s.cursor));
    case "e": return moved(s, lineEnd(s.text, s.cursor));
    case "b": return stepArrow(s, ctx, "left");
    case "f": return stepArrow(s, ctx, "right");
    case "p": return menuOf(s, ctx) ? moveSel(s, ctx, -1) : vertical(s, ctx, "up");
    case "n": return menuOf(s, ctx) ? moveSel(s, ctx, 1) : vertical(s, ctx, "down");
    case "d":
      if (!s.text) { fx.push({ type: "exit" }); return s; }
      return removeRange(s, s.cursor, nextBoundary(s.text, s.cursor), false);
    case "h": return removeRange(s, prevBoundary(s.text, s.cursor), s.cursor, false);
    case "k": {
      const end = lineEnd(s.text, s.cursor);
      return removeRange(s, s.cursor, end === s.cursor && end < s.text.length ? end + 1 : end, true);
    }
    case "u": {
      const start = lineStart(s.text, s.cursor);
      return removeRange(s, start === s.cursor && start > 0 ? start - 1 : start, s.cursor, true);
    }
    case "w": return removeRange(s, wordLeft(s.text, s.cursor), s.cursor, true);
    case "y": return s.killed ? insert(s, s.killed) : s;
    case "j": return insert(s, "\n");
    case "l": fx.push({ type: "redraw" }); return s;
    case "o": fx.push({ type: "expand" }); return s;
    case "c": return onCtrlC(s, ctx, fx);
    default: return s;
  }
}

function onAlt(s, ch) {
  switch (ch) {
    case "b": return moved(s, wordLeft(s.text, s.cursor));
    case "f": return moved(s, wordRight(s.text, s.cursor));
    case "d": return removeRange(s, s.cursor, wordRight(s.text, s.cursor), true);
    default: return s;
  }
}

function onCtrlC(s, ctx, fx) {
  if (!s.text) { fx.push({ type: "exit" }); return s; }
  fx.push({ type: "hint", ms: HINT_MS });
  return { ...clearAll(s), armUntil: ctx.now + HINT_MS };
}

function moveSel(s, ctx, delta) {
  const menu = menuOf(s, ctx);
  if (!menu) return s;
  const n = menu.items.length;
  return { ...s, sel: (menu.sel + delta + n) % n };
}

function onReturn(s, key, ctx, fx) {
  if (key.ctrl || key.alt || key.shift) return insert(s, "\n");
  const menu = menuOf(s, ctx);
  if (menu && !(menu.kind === "slash" && menu.items[menu.sel].exact)) return selectItem(s, menu);
  if (!ctx.mask && s.cursor > 0 && s.text[s.cursor - 1] === "\\") {
    return edited(s, { text: s.text.slice(0, s.cursor - 1) + "\n" + s.text.slice(s.cursor), cursor: s.cursor });
  }
  const full = expandText(s);
  const text = ctx.mask ? full : full.trim();
  if (!text) return s;
  fx.push({ type: "submit", text });
  return s;
}

function onPaste(s, raw, ctx) {
  let text = sanitize(raw);
  if (ctx.mask) text = text.replace(/\n/g, "");
  if (!text) return s;
  if (!ctx.mask && s.chips.length < CHIP_MAX) {
    const chip = describePaste(text);
    if (chip.lines >= 3 || text.length >= 200) {
      return insert({ ...s, chips: [...s.chips, chip] }, String.fromCharCode(CHIP0 + s.chips.length));
    }
  }
  return insert(s, text);
}

function step(s, key, ctx, fx) {
  switch (key.name) {
    case "char": return onChar(s, key, ctx, fx);
    case "paste": return onPaste(s, key.paste || "", ctx);
    case "return": return onReturn(s, key, ctx, fx);
    case "tab": {
      const menu = menuOf(s, ctx);
      return menu ? selectItem(s, menu) : s;
    }
    case "backtab": fx.push({ type: "shiftTab" }); return s;
    case "escape":
      if (menuOf(s, ctx)) return { ...s, menuOff: true };
      return s.text ? clearAll(s) : s;
    case "backspace":
      if (key.ctrl || key.alt) return removeRange(s, wordLeft(s.text, s.cursor), s.cursor, true);
      return removeRange(s, prevBoundary(s.text, s.cursor), s.cursor, false);
    case "delete":
      if (key.ctrl || key.alt) return removeRange(s, s.cursor, wordRight(s.text, s.cursor), true);
      return removeRange(s, s.cursor, nextBoundary(s.text, s.cursor), false);
    case "left": case "right":
      return key.ctrl || key.alt ? wordArrow(s, ctx, key.name) : stepArrow(s, ctx, key.name);
    case "up": case "down":
      if (menuOf(s, ctx)) return moveSel(s, ctx, key.name === "up" ? -1 : 1);
      return vertical(s, ctx, key.name);
    case "home": return moved(s, lineStart(s.text, s.cursor));
    case "end": return moved(s, lineEnd(s.text, s.cursor));
    default: return s;
  }
}

// After every key: keep the cursor legal, notice a menu opening / changing, scroll the menu to the selection.
function settle(s, ctx, fx) {
  let out = s;
  if (out.cursor > out.text.length || out.cursor < 0) out = { ...out, cursor: Math.max(0, Math.min(out.text.length, out.cursor)) };
  const token = tokenOf(out, ctx);
  const sig = token ? `${token.kind}:${token.query}` : "";
  if (sig !== out.menuSig) {
    out = { ...out, menuSig: sig, sel: 0, menuTop: 0, files: token && token.kind === "file" ? out.files : null };
    if (token && token.kind === "file") {
      out = { ...out, fileSeq: out.fileSeq + 1 };
      fx.push({ type: "files", query: token.query, seq: out.fileSeq });
    }
  }
  const menu = menuOf(out, ctx);
  if (menu) {
    const rows = Math.max(1, menuCapacity(ctx));
    let top = Math.min(out.menuTop, Math.max(0, menu.items.length - rows));
    if (menu.sel < top) top = menu.sel;
    else if (menu.sel >= top + rows) top = menu.sel - rows + 1;
    if (top !== out.menuTop) out = { ...out, menuTop: top };
  }
  return out;
}

/**
 * reduce(state, key, ctx) -> { state, effects }
 * ctx = { width, height, prefixWidth, commands, hasFiles, mask, now }
 * effects: { type: "submit", text } | { type: "exit" } | { type: "shiftTab" } |
 *          { type: "expand" } | { type: "redraw" } | { type: "hint", ms } | { type: "files", query, seq }
 */
export function reduce(state, key, ctx) {
  const effects = [];
  let s = state;
  if (s.armUntil && !(key.name === "char" && key.ctrl && key.ch === "c")) s = { ...s, armUntil: 0 };
  s = step(s, key, ctx, effects);
  s = settle(s, ctx, effects);
  return { state: s, effects };
}

// ---------------------------------------------------------------------------------------------
// The view

/** The Arabic interface mirrors the menus, the rule labels and the hints (typed text still decides its own direction). */
const rtlUi = () => getLang() === "ar" && arabicActive();

// What a menu row may show of a name or a description. A skill is written by a person, so its text is untrusted:
// escape sequences, control characters and direction overrides go. So do the harakat: the text layer counts them as
// zero cells but Windows Terminal gives each one a cell of its own, and a mirrored row is exactly as wide as the
// terminal, so one mark would wrap it. Only what is SHOWN changes; the name that Tab fills in is untouched.
const HARAKAT = /[\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]/g;
const menuText = s => stripAnsi(String(s ?? "")).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/g, " ").replace(HARAKAT, "").replace(/\s+/g, " ").trim();

/** One logical piece of a row, ordered on its own: nothing next to it can pull its characters across. */
const piece = (text, dir = "auto") => stripBidiMarks(toVisual(text, { dir }));

/**
 * A description, ordered on its own as one paragraph: its direction comes from layoutParagraph's rule, as in the
 * dialogs, not from its first letter, so an Arabic sentence that starts with a Latin word ("Git: ...") still reads
 * from the name outwards. The text is one line that already fits its column.
 */
const sentencePiece = text => stripBidiMarks(layoutParagraph(text, Infinity, { align: "none" })[0] ?? "");

/**
 * A gray rule across the box; a label ("3 more above") sits dim near the far end: the right in English, the left in
 * the Arabic interface.
 */
function ruleLine(width, label) {
  const bar = sym.hline;
  if (!label || width < 8) return c.gray(bar.repeat(width));
  const text = piece(fitLogical(label, width - 4, sym.ellipsis));
  const long = c.gray(bar.repeat(Math.max(0, width - stringWidth(text) - 4)));
  const mid = " " + c.dim(text) + " ";
  return rtlUi() ? c.gray(bar.repeat(2)) + mid + long : long + mid + c.gray(bar.repeat(2));
}

/** The character drawn in terminal column `col` of a plain row ("" past the end). Marks ride on their base letter. */
function cellAt(plain, col) {
  let x = 0;
  for (const ch of plain) {
    const w = stringWidth(ch);
    if (w === 0) continue;
    if (col < x + w) return col >= x ? ch : "";
    x += w;
  }
  return "";
}

function uiLine(text, width, style) {
  const plain = stripBidiMarks(toVisual(style(text), hasRtl(text) ? { dir: "rtl", width, align: "end" } : { dir: "ltr" }));
  return stringWidth(plain) > width ? clipLine(plain, width) : plain;
}

/**
 * The empty box's own hint (logical text, at most `room` cells). It is built from parts that are dropped from the end
 * on a narrow terminal ("Type a message · / for commands and skills" before "Type a message"), never cut inside one. In the
 * Arabic interface each part is isolated right to left, so a Latin "/" or "@" at its edge can never join the part
 * beside it, and a part that starts with one ("@ for a file") still reads as an Arabic phrase.
 */
function placeholderText(room) {
  const iso = rtlUi() ? p => "\u2067" + p + "\u2069" : p => p;
  const parts = [t("term.input.ask"), t("term.input.askSlash"), t("term.input.askFile")].map(iso);
  const sep = t("term.input.askSep");
  let n = parts.length;
  while (n > 1 && stringWidth(parts.slice(0, n).join(sep)) > room) n--;
  return n > 1 ? parts.slice(0, n).join(sep) : fitLogical(parts[0], room, sym.ellipsis);
}

// Which optional columns a menu gets, best first: [description, skill tag, scroll counter]. The first one that fits the
// width is used for every row, so the columns never move while the selection scrolls.
const MENU_PLANS = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0], [0, 1, 1], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
const MIN_DESC = 6;
// The far side of a row (tag, counter) stays within reach of the names on a very wide terminal, like the text column.
const MENU_MAX = 100;

/**
 * The rows of the open menu, `rows` of them from menu.items starting at the scroll position. Every width is taken from
 * ALL matching items (name column, description room, tag and counter columns), not from the rows on screen.
 */
function menuRows(menu, s, ctx, rows) {
  const rtl = rtlUi();
  const width = Math.min(ctx.width, MENU_MAX);
  // A mirrored menu is right-aligned: what a wide terminal has beyond the menu's width goes in front of every row.
  const margin = rtl ? " ".repeat(ctx.width - width) : "";
  const items = menu.items;
  const slash = menu.kind === "slash";
  const top = Math.max(0, Math.min(s.menuTop, items.length - rows));
  const pointerW = stringWidth(sym.prompt);
  const lead = pointerW + 1;

  const labels = items.map(it => menuText(it.label));
  const counterW = items.length > rows ? stringWidth(`${items.length}/${items.length}`) : 0;
  const tag = piece(menuText(t("term.menu.skillTag")));
  const tagW = slash && items.some(it => it.kind === "skill") ? stringWidth(tag) : 0;
  const hasDesc = slash && items.some(it => menuText(it.desc));
  // A command is a short word; a path is worth all the room the row has.
  const cap = slash ? Math.max(8, Math.min(30, Math.floor(width / 2))) : Math.max(8, width - lead - (counterW ? counterW + 2 : 0));
  const nameW = Math.max(1, Math.min(cap, width - lead, Math.max(1, ...labels.map(l => stringWidth(l)))));
  const after = width - lead - nameW;

  const trailOf = (withTag, withCount) => (withTag && withCount ? tagW + 2 + counterW : withTag ? tagW : withCount ? counterW : 0);
  let plan = [0, 0, 0];
  for (const p of MENU_PLANS) {
    if ((p[0] && !hasDesc) || (p[1] && !tagW) || (p[2] && !counterW)) continue;
    const trail = trailOf(p[1], p[2]);
    const free = after - (trail ? trail + 2 : 0) - (p[0] ? 2 : 0);
    if (free >= (p[0] ? MIN_DESC : 0)) { plan = p; break; }
  }
  const [withDesc, withTag, withCount] = plan;
  const trail = trailOf(withTag, withCount);
  const descRoom = withDesc ? after - 2 - (trail ? trail + 2 : 0) : 0;
  // In a mirrored row the pointer is mirrored with it, as the dialogs draw it (where Unicode has a mirror image).
  const pointer = c.accent(rtl ? piece("\u200f" + sym.prompt, "rtl") : sym.prompt);

  return items.slice(top, top + rows).map((it, k) => {
    const index = top + k;
    const on = index === menu.sel;
    let name;
    let nameCells;
    if (slash) {
      const text = piece(fitLogical(labels[index], nameW, sym.ellipsis));
      name = on ? c.bold(c.accent(text)) : text;
      nameCells = stringWidth(text);
    } else {
      const path = fitPathTail(labels[index], nameW, sym.ellipsis);
      const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
      name = piece(c.dim(path.slice(0, cut)) + (on ? c.bold(c.accent(path.slice(cut))) : path.slice(cut)), "ltr");
      nameCells = stringWidth(path);
    }
    const pad = " ".repeat(Math.max(0, nameW - nameCells));
    const descText = withDesc ? sentencePiece(fitLogical(menuText(it.desc), descRoom, sym.ellipsis)) : "";
    const desc = descText ? c.dim(descText) : "";
    const descCells = descText ? stringWidth(descText) + 2 : 0;

    const cells = [];
    if (withTag) cells.push(it.kind === "skill" ? c.dim(tag) : " ".repeat(tagW));
    if (withCount) {
      const count = `${index + 1}/${items.length}`;
      const gap = " ".repeat(counterW - stringWidth(count));
      cells.push(on ? (rtl ? c.dim(count) + gap : gap + c.dim(count)) : " ".repeat(counterW));
    }
    const far = (rtl ? cells.reverse() : cells).join("  ");
    const farCells = stripAnsi(far).trim() ? trail : 0;
    const mark = on ? pointer : " ".repeat(pointerW);

    if (rtl) {
      const near = (desc ? desc + "  " : "") + pad + name + " " + mark;
      const fill = " ".repeat(Math.max(0, width - farCells - descCells - nameW - lead));
      return margin + clipLine((farCells ? far : "") + fill + near, width);
    }
    const near = mark + " " + name + (desc || farCells ? pad : "") + (desc ? "  " + desc : "");
    if (!farCells) return clipLine(near, width);
    return clipLine(near + " ".repeat(Math.max(0, width - lead - nameW - descCells - farCells)) + far, width);
  });
}

function footerFor(o, s, ctx) {
  let lines = [];
  try {
    const f = typeof o.footer === "function" ? o.footer() : null;
    if (Array.isArray(f)) lines = f.map(l => String(l ?? ""));
  } catch {
    lines = [];
  }
  lines = lines.map(l => clipLine(l, ctx.width));
  if (s.armUntil > ctx.now) {
    const hint = uiLine("  " + t("term.input.exitHint"), ctx.width, c.yellow);
    if (lines.length) lines[0] = hint; else lines.push(hint);
  }
  return lines;
}

/** Dim the chips in already laid-out rows (best effort: the label is found as drawn, or shaped and ordered). */
function paintChips(rows, view, s) {
  if (view.plain) return rows;
  const labels = new Set();
  for (const ch of s.text.match(CHIP_RE) || []) labels.add(chipLabel(s.chips[ch.charCodeAt(0) - CHIP0]));
  if (!labels.size) return rows;
  return rows.map(row => {
    let out = row;
    for (const label of labels) {
      for (const form of new Set([label, stripBidiMarks(toVisual(label, { dir: "rtl" })), stripBidiMarks(toVisual(label, { dir: "ltr" }))])) {
        const at = out.indexOf(form);
        if (at !== -1) { out = out.slice(0, at) + c.dim(form) + out.slice(at + form.length); break; }
      }
    }
    return out;
  });
}

/**
 * render(state, ctx, opts) -> { lines, cursor, viewTop }
 * opts = { prefix, continuationPrefix, footer, placeholder }
 */
export function render(s, ctx, o = {}) {
  const width = ctx.width;
  const prefix = o.prefix ?? "";
  const pw = ctx.prefixWidth;
  const view = viewOf(s, ctx);
  const footer = footerFor(o, s, ctx);
  const menu = menuOf(s, ctx);
  const height = ctx.height || 24;
  const spare = Math.max(0, height - 1 - 2 - footer.length);
  const menuN = menu ? Math.min(menu.items.length, menuCapacity(ctx), Math.max(0, spare - 1)) : 0;
  const maxInput = Math.max(1, Math.min(MAX_INPUT_ROWS, spare - menuN));

  const lay = layoutInput(view.text, view.toD(s.cursor), { width, prefix, align: "auto" });
  let rows = lay.lines;
  let caret = { ...lay.cursor };

  if (o.continuationPrefix) {
    const cont = clipLine(o.continuationPrefix, pw);
    const fill = cont + " ".repeat(Math.max(0, pw - stringWidth(cont)));
    rows = rows.map((r, i) => (i === 0 ? r : fill + r.slice(pw)));
  }
  rows = paintChips(rows, view, s);
  // The word that runs a message at ultracode lights up while it is typed (src/ui/ultra.js).
  if (!ctx.mask) rows = rows.map(row => paintUltra(row));

  // At the end of text whose last letters are right-to-left the next letter appears on the LEFT of the run, so the
  // caret waits on the free cell there instead of covering the letter just typed.
  if (s.cursor === s.text.length && caret.col > pw) {
    const plain = stripAnsi(lay.lines[caret.row] || "");
    if (cellAt(plain, caret.col - 1) === " " && hasRtl(cellAt(plain, caret.col))) caret.col -= 1;
  }

  if (!s.text && !ctx.mask && o.placeholder !== "" && o.placeholder !== false) {
    // One blank cell always separates the hint from the prompt glyph.
    const room = Math.max(0, width - pw - 1);
    const hint = o.placeholder ? fitLogical(String(o.placeholder), room, sym.ellipsis) : placeholderText(room);
    if (hasRtl(hint)) {
      // An Arabic hint ends on the last cell, exactly where typed Arabic ends (layoutInput right-aligns to the full
      // width), and the caret waits on that cell, where the first letter will appear: the mirror image of the English
      // hint, whose first letter the caret sits on.
      // One cell stays free at the right edge for the caret, exactly as the English hint leaves the cell
      // after the prompt glyph; filling it put the caret on top of the last letter.
      rows = [prefix + c.dim(stripBidiMarks(toVisual(hint, { dir: "rtl", width: Math.max(1, width - pw - 1), align: "end" })))];
      caret = { row: 0, col: Math.max(pw, width - 1) };
    } else {
      rows = [prefix + c.dim(piece(hint, "ltr"))];
      caret = { row: 0, col: pw };
    }
  }

  const total = rows.length;
  let top = Math.max(0, Math.min(s.viewTop, total - maxInput));
  if (total <= maxInput) top = 0;
  else if (caret.row < top) top = caret.row;
  else if (caret.row >= top + maxInput) top = caret.row - maxInput + 1;
  const shown = rows.slice(top, top + maxInput).map(r => clipLine(r, width));
  const above = top;
  const below = Math.max(0, total - top - shown.length);

  const lines = [
    ruleLine(width, above ? t("term.input.moreAbove", { n: above }) : ""),
    ...shown,
    ruleLine(width, below ? t("term.input.moreBelow", { n: below }) : ""),
  ];
  if (menu && menuN > 0) lines.push(...menuRows(menu, s, ctx, menuN));
  lines.push(...footer);
  return { lines, cursor: { row: 1 + (caret.row - top), col: Math.max(0, Math.min(width - 1, caret.col)) }, viewTop: top };
}

// ---------------------------------------------------------------------------------------------
// readPrompt

function normalizeFiles(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (typeof p !== "string" || !p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 200) break;
  }
  return out;
}

/**
 * readPrompt(screen, opts) -> Promise<{ type: "submit", text } | { type: "exit" } | { type: "cancel" }>  
 * opts: prefix, continuationPrefix, history, commands, files, footer, onShiftTab, onExpand, mask,
 *       initial, signal, and the extra placeholder (text for the empty box; "" or false turns it off).
 */
export function readPrompt(screen, opts = {}) {
  const o = { ...opts };
  const commands = Array.isArray(o.commands) ? o.commands : [];
  const mask = typeof o.mask === "string" && o.mask ? o.mask : null;
  const prefix = o.prefix ?? c.accent(sym.prompt) + " ";
  const prefixWidth = stringWidth(prefix);
  const renderOpts = { prefix, continuationPrefix: o.continuationPrefix, footer: o.footer, placeholder: mask ? "" : o.placeholder };

  return new Promise(resolve => {
    if (o.signal && o.signal.aborted) { resolve({ type: "cancel" }); return; }
    let state = createState({ initial: o.initial, history: o.history, mask });
    let finished = false;
    let hintTimer = null;
    let filesTimer = null;

    const ctx = () => ({
      width: Math.max(8, screen.width()),
      height: typeof screen.height === "function" ? screen.height() : 24,
      prefixWidth,
      commands,
      hasFiles: typeof o.files === "function" && !mask,
      mask,
      now: Date.now(),
    });

    function draw() {
      if (finished) return;
      const r = render(state, ctx(), renderOpts);
      if (r.viewTop !== state.viewTop) state = { ...state, viewTop: r.viewTop };
      screen.setLive(r.lines, r.cursor);
    }

    function finish(result) {
      if (finished) return;
      finished = true;
      offKey();
      offResize();
      if (hintTimer) clearTimeout(hintTimer);
      if (filesTimer) clearTimeout(filesTimer);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
      screen.clearLive();
      resolve(result);
    }

    function lookup(fx) {
      if (filesTimer) clearTimeout(filesTimer);
      filesTimer = setTimeout(async () => {
        filesTimer = null;
        let found;
        try {
          found = await o.files(fx.query);
        } catch {
          found = [];
        }
        if (finished) return;
        state = applyFileResults(state, fx.seq, normalizeFiles(found));
        draw();
      }, FILE_DEBOUNCE_MS);
    }

    function run(fx) {
      switch (fx.type) {
        case "submit": finish({ type: "submit", text: fx.text }); break;
        case "exit": finish({ type: "exit" }); break;
        case "shiftTab": if (o.onShiftTab) o.onShiftTab(); break;
        case "expand": if (o.onExpand) o.onExpand(); break;
        case "redraw": screen.clearLive(); break;
        case "hint":
          if (hintTimer) clearTimeout(hintTimer);
          hintTimer = setTimeout(() => { hintTimer = null; draw(); }, fx.ms + 20);
          break;
        case "files": lookup(fx); break;
        default: break;
      }
    }

    function onKey(key) {
      if (finished) return;
      const r = reduce(state, key, ctx());
      state = r.state;
      for (const fx of r.effects) {
        if (finished) return;
        run(fx);
      }
      draw();
    }

    function onAbort() { finish({ type: "cancel" }); }

    const offKey = screen.onKey(onKey);
    const offResize = screen.onResize(draw);
    if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true });
    draw();
  });
}
