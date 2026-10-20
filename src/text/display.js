// The public face of the text layer. Everything else in the app imports ONLY this file.
//
// Pipeline for one logical line:  parse ANSI -> shape Arabic -> split into cells -> wrap (logical order)
// -> per wrapped line: UAX #9 resolve + reorder -> mirror brackets -> re-emit styles.
//
// Decisions:
//  - Arabic mode: "on" always works; "off" never touches text; "auto" is on unless the environment says the terminal
//    does its own bidi: FIRAS_ARABIC=off|0|false|no (or =on|1|true|yes to force on), or TERM=mlterm.
//  - Widths follow the mode: with Arabic off, a lam+alef pair is two cells (nothing merges it), with it on, one.
//  - toVisual strips bidi control characters (LRM, RLM, embeddings, isolates), zero-width joiners and soft hyphens
//    from the RTL lines it rebuilds: after reordering they have no meaning and some terminals draw them as boxes.
//  - A cursor index is a UTF-16 index into the logical text. An index inside a cluster (between a letter and its
//    mark, or inside a lam-alef pair) is drawn at the end of that cluster.
//  - Cursor stops: a logical boundary is drawn at the trailing edge of the character before it (so typing at the end
//    of an Arabic run leaves the caret at the run's LEFT edge); at the very start it is the leading edge of the first.
//  - moveCursorVisual steps between the stops of a row ordered by their drawn x position, so every press moves the
//    caret by exactly one glyph. Where an RTL run touches an LTR one the two logical positions share one drawn spot
//    and only one of them can be reached from each side; the other is reached from the opposite arrow.
//    Past the end of a row it follows the reading flow (LTR rows: left = row above; RTL rows read leftwards, so left =
//    row below), falling back to "left = above, right = below" next to a row of the other direction.
//  - layoutParagraph picks the direction of "auto" paragraphs by the first strong letter, except when that letter
//    is Latin but Arabic/Hebrew letters outnumber Latin ones (a product name leading an Arabic sentence): that is an
//    RTL paragraph. baseDirection() itself is the plain UAX #9 rule.
//  - The rows of a wrapped paragraph are ordered one by one but resolved with the text around them (orderRows): the
//    neutrals a break leaves at the edge of a row take the direction they have in the whole paragraph.
//  - align: "end"/"right" pads on the left, "center" splits the padding, "start"/"left"/"none" never pad. "end" means the
//    right edge whatever the direction; toVisual only pads LTR-only lines when dir is explicitly "rtl".
//  - Escape sequences are passed through (styles, links, other complete sequences); truncated or garbled ones are
//    dropped. Untrusted text (model output) should go through stripAnsi() first; this layer does not judge them.
//  - Tabs are zero-width control characters here: expand them before measuring or wrapping.
import { stripAnsi, hasAnsi, transition } from "./ansi.js";
import { analyze, wrapCells, wrapLogicalWith } from "./wrap.js";
import { stringWidth as measure, isCombining } from "./width.js";
import { hasArabic } from "./arabic.js";
import { bidiClass, resolveParagraph, visualOrder, mirrorOf, firstStrongDirection, L, R, AL, EN, AN, ES, ET, CS, ON, WS, S, B, LRE, PDF, LRI, RLI, FSI, PDI } from "./bidi.js";

export { stripAnsi };

// ---------------------------------------------------------------------------------------------
// Mode

let mode = "auto";

export function setArabicMode(m) {
  mode = m === "on" || m === "off" ? m : "auto";
}

export function arabicActive() {
  if (mode === "on") return true;
  if (mode === "off") return false;
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const v = String(env.FIRAS_ARABIC || "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
  if (/^mlterm/i.test(String(env.TERM || ""))) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Small queries

// Cheap superset test run on every line: anything that can possibly need reordering.
const RTL_QUICK = /[\u0590-\u08ff\u200f\u202b\u202e\u2067\ufb1d-\ufdff\ufe70-\ufeff]|[\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

export function hasRtl(s) {
  if (!RTL_QUICK.test(s)) return false;
  const t = hasAnsi(s) ? stripAnsi(s) : s;
  for (const ch of t) {
    const c = bidiClass(ch.codePointAt(0));
    if (c === R || c === AL) return true;
  }
  return false;
}

export function baseDirection(s) {
  return firstStrongDirection(hasAnsi(s) ? stripAnsi(s) : s) || "ltr";
}

function paragraphDirection(s) {
  const t = hasAnsi(s) ? stripAnsi(s) : s;
  const first = firstStrongDirection(t);
  if (first !== "ltr") return first || "ltr";
  let rtl = 0, ltr = 0;
  for (const ch of t) {
    const c = bidiClass(ch.codePointAt(0));
    if (c === L) ltr++;
    else if (c === R || c === AL) rtl++;
  }
  return rtl > ltr ? "rtl" : "ltr";
}

export function stringWidth(s) {
  return measure(s, { shaped: arabicActive() });
}

export function wrapLogical(s, width, o) {
  return wrapLogicalWith(s, width, o, stringWidth);
}

// ---------------------------------------------------------------------------------------------
// Core: reorder a range of cells and emit it

function dirNumber(dir) {
  return dir === "rtl" ? 1 : dir === "ltr" ? 0 : -1;
}

// Punctuation that ends a sentence belongs to the paragraph, not to the word in front of it.
const SENTENCE_END = new Set([0x2e, 0x2c, 0x3b, 0x3a, 0x21, 0x3f, 0x2026, 0x60c, 0x61b, 0x61f]);

// A word ends at a blank, a separator or any explicit direction control (embeddings and isolates start a new context).
const breaksWord = t => t === WS || t === S || t === B || t >= LRE;

/**
 * A word written in Latin letters keeps its own punctuation on its own side: "@src/app.js", "./run.sh" and "--force"
 * are read left to right as typed, even between Arabic words (the plain algorithm hands the leading "@", "./" or "--"
 * to the right-to-left text around them, so they showed after the word: "src/app.js@").
 * Done on the classes only, so every layout (lines, input box, cursor movement) agrees. A word with right-to-left
 * letters in it, a number on its own, brackets (the algorithm pairs those) and the sentence punctuation at the end of a
 * word are left to the algorithm.
 */
function bindLatinWords(types, cps) {
  const n = types.length;
  let i = 0;
  let depth = 0; // inside an explicit embedding or isolate the text has been given its direction already
  while (i < n) {
    if (breaksWord(types[i])) {
      const t = types[i];
      if (t >= LRE) depth = Math.max(0, depth + (t === PDF || t === PDI ? -1 : 1));
      i++;
      continue;
    }
    let j = i;
    let latin = false;
    let rtl = false;
    while (j < n && !breaksWord(types[j])) {
      const t = types[j];
      if (t === L) latin = true;
      else if (t === R || t === AL || t === AN) rtl = true;
      j++;
    }
    if (latin && !rtl && depth === 0) {
      let end = j;
      while (end > i && SENTENCE_END.has(cps[end - 1])) end--;
      for (let k = i; k < end; k++) {
        const t = types[k];
        // Brackets are left to the algorithm (it pairs them); everything else sticks to the word.
        if ((t === ON || t === ES || t === ET || t === CS) && mirrorOf(cps[k]) === cps[k]) types[k] = L;
      }
    }
    i = j;
  }
}

// No strong letter: the paragraph's own direction stands for the text around a row.
const NONE = -1;
// Left-to-right text followed by an Arabic-Indic number ("--retries ٣"): to the neutrals after it that number is
// right-to-left (N1), while a European number after it still follows the left-to-right letter (W7). No single letter
// says both, so it stands in as a pair.
const L_AN = -2;
// The letters standing in for the text around a row (see orderRows): one of each strong class, and the pair above.
const STAND_IN = new Map([[L, [[L, 0x61]]], [R, [[R, 0x5d0]]], [AL, [[AL, 0x627]]], [L_AN, [[L, 0x61], [AN, 0x661]]]]);

/**
 * Resolves one row of a longer paragraph. `edge` = { before, after, at }: the strong class of the text before the row
 * and after it (NONE at the paragraph's own start and end), and the cell where the row's text starts (after its indent).
 * The algorithm sees a stand-in letter of each class there, so the neutrals at the row's edges are resolved as they
 * would be in the whole paragraph; the levels of the stand-ins themselves are thrown away.
 */
function resolveRow(types, cps, dir, edge) {
  const m = types.length;
  const at = Math.min(edge.at, m);
  const before = edge.before === NONE ? [] : STAND_IN.get(edge.before);
  const pre = before.length;
  const post = edge.after === NONE ? 0 : 1;
  const T = new Uint8Array(m + pre + post);
  const C = new Array(m + pre + post);
  for (let i = 0; i < m; i++) { const j = i < at ? i : i + pre; T[j] = types[i]; C[j] = cps[i]; }
  before.forEach(([type, cp], i) => { T[at + i] = type; C[at + i] = cp; });
  if (post) { T[m + pre] = edge.after; C[m + pre] = STAND_IN.get(edge.after)[0][1]; }
  const r = resolveParagraph(T, C, dir);
  const levels = new Uint8Array(m);
  const removed = new Uint8Array(m);
  for (let i = 0; i < m; i++) { const j = i < at ? i : i + pre; levels[i] = r.levels[j]; removed[i] = r.removed[j]; }
  // L1 again: the stand-in after the row hid the row's trailing blanks from it, and they go back to the paragraph level.
  for (let i = m - 1; post && i >= 0; i--) {
    if (removed[i]) continue;
    const t = types[i];
    if (t === WS || t === S || t === B || t === LRI || t === RLI || t === FSI || t === PDI) levels[i] = r.paraLevel;
    else break;
  }
  return { levels, removed, paraLevel: r.paraLevel };
}

function reorderRange(cells, a, b, dir, edge) {
  const m = b - a;
  const types = new Uint8Array(m);
  const cps = new Array(m);
  for (let i = 0; i < m; i++) {
    const cp = cells[a + i].cp;
    cps[i] = cp;
    types[i] = bidiClass(cp);
  }
  bindLatinWords(types, cps);
  const r = edge && (edge.before !== NONE || edge.after !== NONE) ? resolveRow(types, cps, dir, edge) : resolveParagraph(types, cps, dir);
  // Direction marks and isolates take part in the ordering but are invisible once the line is ordered.
  // A combining mark with no base of its own would glue itself to whatever lands in front of it.
  const hidden = i => isBidiControl(cps[i]) || (cells[a + i].w === 0 && isCombining(cps[i]));
  const order = visualOrder(r.levels, r.removed).filter(k => !hidden(k));
  for (let i = 0; i < m; i++) if (hidden(i)) r.removed[i] = 1;
  return { order, levels: r.levels, removed: r.removed, paraLevel: r.paraLevel };
}

// Isolates only mean something to the reordering; a line that is not reordered must not carry them to the terminal.
const ISOLATES = /[\u2066-\u2069]/g;
const HAS_ISOLATE = /[\u2066-\u2069]/;
const dropIsolates = line => (HAS_ISOLATE.test(line) ? line.replace(ISOLATES, "") : line);

function isBidiControl(cp) {
  return cp === 0x200e || cp === 0x200f || cp === 0x061c || (cp >= 0x2066 && cp <= 0x2069) || (cp >= 0x202a && cp <= 0x202e);
}

function mirrored(c) {
  const m = mirrorOf(c.cp);
  if (m === c.cp) return c.s;
  return String.fromCodePoint(m) + c.s.slice(c.cp > 0xffff ? 2 : 1);
}

function emit(model, a, order, levels) {
  const { cells, styles } = model;
  let out = "", prev = 0, width = 0;
  for (let t = 0; t < order.length; t++) {
    const k = order[t];
    const c = cells[a + k];
    if (c.pre) out += c.pre;
    if (c.st !== prev) { out += transition(styles[prev], styles[c.st]); prev = c.st; }
    out += (levels[k] & 1) ? mirrored(c) : c.s;
    width += c.w;
  }
  return { text: out, width, endStyle: prev };
}

function place(text, used, width, how) {
  if (!(width > used)) return text;
  const gap = width - used;
  if (how === "end" || how === "right") return " ".repeat(gap) + text;
  if (how === "center") return " ".repeat(gap >> 1) + text;
  return text;
}

function padPlain(line, dir, how, width) {
  if (dir === "rtl" && width > 0 && (how === "end" || how === "right" || how === "center")) {
    return place(line, stringWidth(line), width, how);
  }
  return line;
}

/**
 * Shapes and reorders ONE logical line for a terminal that does neither.
 * o: { dir = 'auto'|'ltr'|'rtl', width, align = 'none'|'start'|'end' }
 * A line of a right-to-left paragraph is reordered even when it holds no right-to-left letter (a wrapped link or
 * number): its leading indent and the punctuation at its ends belong to the paragraph's direction, so they move to the
 * other side ("  path." is drawn ".path  "), exactly as in the rows around it. The line is a paragraph of its own; the
 * rows of a wrapped paragraph go through orderRows, which gives each one the text around it.
 */
export function toVisual(line, o) {
  return visualLine(line, o, null);
}

function visualLine(line, o, edge) {
  const dir = (o && o.dir) || "auto";
  const how = (o && o.align) || "none";
  const width = o && o.width;
  if (line.indexOf("\n") !== -1) return line.split("\n").map(l => visualLine(l, o, edge)).join("\n");
  if (!arabicActive()) return padPlain(line, dir, how, width);
  const forced = dir === "rtl";
  if (!forced && !RTL_QUICK.test(line)) return padPlain(dropIsolates(line), dir, how, width);
  const cr = line.charCodeAt(line.length - 1) === 13;
  const body = cr ? line.slice(0, -1) : line;
  const model = analyze(body, true);
  // The quick test also sees text inside escape sequences; what matters is the text that will be drawn.
  if (!model.cells.length || (!forced && !RTL_QUICK.test(model.src))) return padPlain(dropIsolates(line), dir, how, width);
  const { order, levels } = reorderRange(model.cells, 0, model.cells.length, dirNumber(dir), edge);
  const r = emit(model, 0, order, levels);
  return place(withTail(model, r), r.width, width, how) + (cr ? "\r" : "");
}

// The first strong letter or number of a row and its last strong letter, outside its isolates (to the text around it an
// isolate is one neutral, whatever it holds); `tail`: the kind of number (EN or AN) that comes last after that letter.
function rowEdges(row) {
  const t = hasAnsi(row) ? stripAnsi(row) : row;
  let depth = 0, first = NONE, last = NONE, tail = NONE;
  for (const ch of t) {
    const c = bidiClass(ch.codePointAt(0));
    if (c === LRI || c === RLI || c === FSI) depth++;
    else if (c === PDI) { if (depth > 0) depth--; }
    else if (depth === 0) {
      if (c === L || c === R || c === AL) { last = c; tail = NONE; if (first === NONE) first = c; }
      else if (c === EN || c === AN) { tail = c; if (first === NONE) first = c; }
    }
  }
  return { first, last, tail };
}

// What the rows up to and including one leave to the row after it: their last strong letter, or the pair L_AN when an
// Arabic-Indic number follows a left-to-right letter. A European number after left-to-right text is left-to-right
// itself (W7), so after one the text is plain L again.
function leaves(edges, before) {
  const last = edges.last !== NONE ? edges.last : before;
  if (last !== L && last !== L_AN) return last;
  return edges.tail === AN ? L_AN : edges.tail === EN ? L : last;
}

// What a row's end meets: the class of the first strong letter or number after it, as the neutrals before it see it.
// A European number counts as a left-to-right letter after left-to-right text (W7) and as a right-to-left one otherwise.
function meets(next, lastBefore, rtl) {
  if (next === NONE || next === L) return next;
  if (next === EN) return lastBefore === L || lastBefore === L_AN || (lastBefore === NONE && !rtl) ? L : R;
  return R;
}

const cellsOf = s => (s ? analyze(s, true).cells.length : 0);

/**
 * Visual lines for the wrapped rows of ONE paragraph (what wrapLogical returned for it).
 * UAX #9 resolves a paragraph as a whole and only orders it line by line; ordered on its own, every row would take the
 * paragraph's direction at both of its ends, and a "&&", "|" or "2>&1" that a break left at the edge of a row in the
 * middle of a command jumped to the other end of the row, mirrored. So each row is resolved with the text around it:
 * the last strong letter of the rows above, the first strong letter or number of the rows below. The paragraph's first
 * row has nothing before it and its last row nothing after it, so there the paragraph's direction stays (the full stop
 * of an Arabic sentence that ends in a path is drawn on the path's left). An indent belongs to the paragraph whatever
 * the text next to it, so the text before a row is put after the row's indent.
 * o: { dir = 'ltr'|'rtl', width, align, firstIndent = "", indent = "", before, open = false }
 *   before: context[k] of an earlier call, when these rows continue a paragraph whose first k rows are out already.
 *   open:   more of the paragraph will follow, not known yet (a stream); its last rows may then still change.
 * Returns { lines, settled, context }: `settled` rows from the top look the same whatever follows (all of them unless
 * `open`); context[k] is what the rows above row k leave to it.
 */
export function orderRows(rows, o) {
  const n = rows.length;
  const dir = o && o.dir;
  const opts = { dir, width: o && o.width, align: o && o.align };
  const rtl = dir === "rtl";
  const context = new Array(n + 1).fill(o && o.before !== undefined ? o.before : NONE);
  if (!arabicActive()) return { lines: rows.slice(), settled: n, context };
  const edges = rows.map(rowEdges);
  for (let k = 0; k < n; k++) context[k + 1] = leaves(edges[k], context[k]);
  // A left-to-right paragraph with no right-to-left letter is not reordered at all; with no fixed direction every row
  // is a paragraph of its own.
  if (!rtl && (dir !== "ltr" || !rows.some(r => RTL_QUICK.test(r)))) {
    return { lines: rows.map(r => toVisual(r, opts)), settled: n, context };
  }
  const atFirst = cellsOf(o && o.firstIndent), atRest = cellsOf(o && o.indent);
  const lines = new Array(n);
  let settled = n;
  let next = NONE;
  for (let k = n - 1; k >= 0; k--) {
    const edge = { before: context[k], after: meets(next, context[k + 1], rtl), at: k ? atRest : atFirst };
    lines[k] = visualLine(rows[k], opts, edge);
    if (o && o.open && next === NONE) {
      // Nothing strong below this row yet: the text that decides how its end looks may still be on its way.
      const asL = visualLine(rows[k], opts, { ...edge, after: L });
      if (asL !== visualLine(rows[k], opts, { ...edge, after: R })) settled = k;
    }
    if (edges[k].first !== NONE) next = edges[k].first;
  }
  return { lines, settled, context };
}

// Whatever style the logical line ended in (even an unclosed one) is the style the visual line must end in.
function withTail(model, r) {
  const closing = r.endStyle !== model.tailSt ? transition(model.styles[r.endStyle], model.styles[model.tailSt]) : "";
  return r.text + closing + model.tailPre;
}

/** Shapes Arabic in a line but keeps logical order and direction (for code blocks and tables of data). */
export function shapeLine(line) {
  if (!arabicActive() || !hasArabic(line)) return line;
  const model = analyze(line, true);
  const order = model.cells.map((_, i) => i);
  return withTail(model, emit(model, 0, order, new Uint8Array(order.length)));
}

/**
 * Wraps `text` to `width` columns and returns visual lines ready to print.
 * o: { dir = 'auto', align = 'auto', firstIndent = "", indent = "", before }. Blank lines are kept. `before`: when the
 * text continues a paragraph whose first rows are out already, what those rows leave to it (orderRows' context).
 */
export function layoutParagraph(text, width, o) {
  const dir = (o && o.dir) || "auto";
  const alignOpt = (o && o.align) || "auto";
  const wrapOpts = { firstIndent: (o && o.firstIndent) || "", indent: (o && o.indent) || "" };
  const active = arabicActive();
  const out = [];
  const paragraphs = text.split("\n");
  paragraphs.forEach((p, k) => {
    const para = p.endsWith("\r") ? p.slice(0, -1) : p;
    const opts = k === 0 ? wrapOpts : { firstIndent: wrapOpts.indent, indent: wrapOpts.indent };
    if (para === "") { out.push(""); return; }
    if (!active) { out.push(...wrapLogical(para, width, opts)); return; }
    const d = dir !== "auto" ? dir : (RTL_QUICK.test(para) && hasRtl(para) ? paragraphDirection(para) : "ltr");
    const how = alignOpt === "auto" ? (d === "rtl" ? "end" : "start") : alignOpt;
    const before = k === 0 && o ? o.before : undefined;
    out.push(...orderRows(wrapLogical(para, width, opts), { dir: d, width, align: how, ...opts, before }).lines);
  });
  return out;
}

function mapLine(plain, o) {
  if (!arabicActive() || (!(o && o.dir === "rtl") && !RTL_QUICK.test(plain))) {
    // Same characters as toVisual prints: it drops isolates from a line it does not reorder (while Arabic is on).
    const drop = arabicActive();
    const ident = [];
    for (let i = 0; i < plain.length; i++) {
      const u = plain.charCodeAt(i);
      if (!(drop && u >= 0x2066 && u <= 0x2069)) ident.push(i);
    }
    return ident;
  }
  const cr = plain.charCodeAt(plain.length - 1) === 13;
  const model = analyze(cr ? plain.slice(0, -1) : plain, true);
  const { order } = reorderRange(model.cells, 0, model.cells.length, dirNumber(o && o.dir));
  const map = [];
  for (const k of order) {
    const c = model.cells[k];
    let j = c.k0;
    for (const ch of c.s) {
      const logical = model.lo[model.from ? model.from[j] : j];
      for (let u = 0; u < ch.length; u++) map.push(logical);
      j++;
    }
  }
  if (cr) map.push(plain.length - 1);
  return map;
}

/**
 * For each UTF-16 unit of the visual line (ANSI stripped, as toVisual would print it): the logical UTF-16 index
 * it came from. A ligature or a mirrored bracket is one unit; characters toVisual drops have no entry.
 */
export function visualToLogicalMap(line, o) {
  const out = [];
  let base = 0;
  line.split("\n").forEach((raw, i) => {
    const seg = stripAnsi(raw);
    if (i) out.push(base - 1);
    for (const m of mapLine(seg, o)) out.push(base + m);
    base += seg.length + 1;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Input editor support

/**
 * Lays out the text of one logical line as wrapped rows with their visual geometry.
 * Cell indexes in the returned rows are absolute for the line.
 */
function buildLine(segText, start, availFirst, availRest, active) {
  const model = analyze(segText, active);
  const rows = wrapCells(model.cells, availFirst, availRest, true);
  const useBidi = active && RTL_QUICK.test(segText) && hasRtl(segText);
  const flow = useBidi && firstStrongDirection(segText) === "rtl" ? 1 : 0;
  const out = [];
  for (const r of rows) {
    const m = r.b - r.a;
    let order, levels, removed;
    if (useBidi && m > 0) ({ order, levels, removed } = reorderRange(model.cells, r.a, r.b, flow));
    else {
      order = []; levels = new Uint8Array(m); removed = new Uint8Array(m);
      for (let i = 0; i < m; i++) order.push(i);
    }
    const xl = new Int32Array(m).fill(-1);
    let x = 0;
    for (const k of order) { xl[k] = x; x += model.cells[r.a + k].w; }
    out.push({ model, start, len: segText.length, r, order, levels, removed, xl, flow });
  }
  return out;
}

// x position (columns from the row's left edge) of the logical boundary before cell j.
function boundaryX(R_, j) {
  const { model, r, levels, removed, xl } = R_;
  const cells = model.cells;
  for (let k = j - 1; k >= r.a; k--) {
    const rel = k - r.a;
    if (removed[rel]) continue;
    return (levels[rel] & 1) ? xl[rel] : xl[rel] + cells[k].w;
  }
  for (let k = j; k < r.b; k++) {
    const rel = k - r.a;
    if (removed[rel]) continue;
    return (levels[rel] & 1) ? xl[rel] + cells[k].w : xl[rel];
  }
  return 0;
}

// boundary (absolute cell index) for logical offset `rel` inside the row, clamped to the visible part
function boundaryFor(R_, rel) {
  const { model, r } = R_;
  const cells = model.cells;
  let j = r.a;
  while (j < r.e && cells[j].lo < rel) j++;
  return Math.min(j, r.b);
}

function allRows(text, availFirst, availRest, active) {
  const rows = [];
  let start = 0;
  const segs = text.split("\n");
  segs.forEach((seg, si) => {
    for (const row of buildLine(seg, start, si === 0 ? availFirst : availRest, availRest, active)) rows.push(row);
    start += seg.length + 1;
  });
  return rows;
}

function rowOfCursor(rows, c) {
  let best = 0;
  for (let i = 0; i < rows.length; i++) {
    const R_ = rows[i];
    const rel = c - R_.start;
    if (rel < 0) break;
    if (rel > R_.len) continue;
    const firstLo = R_.r.a < R_.model.cells.length ? R_.model.cells[R_.r.a].lo : R_.len;
    const isFirstOfLine = i === 0 || rows[i - 1].start !== R_.start;
    if (isFirstOfLine || rel >= firstLo) best = i;
  }
  return best;
}

/**
 * Layout for the input editor.
 * o: { width, prefix = "", align = 'start'|'end' }.  `cursor` is a logical index into `text`.
 * Returns { lines, cursor: { row, col } }: visual rows (the prefix is on the first row, other rows get blanks of
 * the same width) and the cell where the caret belongs. col is the boundary BEFORE cell `col`, i.e. the number of
 * columns to the left of the caret.
 */
export function layoutInput(text, cursor, o) {
  const width = Math.max(2, Math.floor((o && o.width) || 80));
  const prefix = (o && o.prefix) || "";
  const pw = stringWidth(prefix);
  const blank = " ".repeat(pw);
  const avail = Math.max(1, width - pw);
  const how = (o && o.align) || "start";
  const active = arabicActive();
  const c = Math.max(0, Math.min(text.length, cursor | 0));
  const rows = allRows(text, avail, avail, active);
  const lines = [];
  let cur = { row: 0, col: pw };
  const at = rowOfCursor(rows, c);
  rows.forEach((R_, i) => {
    const { model, r, order, levels } = R_;
    const body = emit(model, r.a, order, levels);
    const rtlRow = R_.flow === 1;
    const pad = (how === "end" || (how === "auto" && rtlRow)) && avail > body.width ? avail - body.width : 0;
    lines.push((i === 0 ? prefix : blank) + " ".repeat(pad) + body.text);
    if (i === at) {
      const j = boundaryFor(R_, c - R_.start);
      cur = { row: i, col: pw + pad + boundaryX(R_, j) };
    }
  });
  if (cur.col >= width) {
    const last = at === rows.length - 1 && c === text.length;
    if (last) { lines.push(blank); cur = { row: lines.length - 1, col: pw }; }
    else cur.col = width - 1;
  }
  return { lines, cursor: cur };
}

/**
 * New logical cursor after one arrow key in VISUAL direction ('left' | 'right').
 * o: { width, prefix } (optional) lets the movement respect wrapped rows; without it the whole logical
 * line is one row.
 */
export function moveCursorVisual(text, cursor, dir, o) {
  const c = Math.max(0, Math.min(text.length, cursor | 0));
  const prefix = (o && o.prefix) || "";
  const avail = o && o.width ? Math.max(1, Math.floor(o.width) - stringWidth(prefix)) : 1e9;
  const rows = allRows(text, avail, avail, arabicActive());
  const at = rowOfCursor(rows, c);
  const R_ = rows[at];
  const stopsOf = row => {
    const cells = row.model.cells;
    const list = [];
    for (let j = row.r.a; j <= row.r.b; j++) {
      list.push({ x: boundaryX(row, j), c: row.start + (j < cells.length ? cells[j].lo : row.len) });
    }
    list.sort((p, q) => p.x - q.x || p.c - q.c);
    return list;
  };
  const stops = stopsOf(R_);
  const here = boundaryFor(R_, c - R_.start);
  const cells = R_.model.cells;
  const hereC = R_.start + (here < cells.length ? cells[here].lo : R_.len);
  const hereX = boundaryX(R_, here);
  const left = dir === "left";
  const pool = stops.filter(s => (left ? s.x < hereX : s.x > hereX));
  if (pool.length) {
    const bestX = left ? pool[pool.length - 1].x : pool[0].x;
    const tied = pool.filter(s => s.x === bestX);
    tied.sort((p, q) => Math.abs(p.c - hereC) - Math.abs(q.c - hereC) || p.c - q.c);
    return tied[0].c;
  }
  // Past the end of this row. Along one reading flow the caret follows it (LTR: left = previous row;
  // RTL rows read leftwards, so left = next row). Next to a row with the other direction it falls back to plain
  // "left = row above, right = row below", which can never ping-pong between the two rows.
  const flowTarget = rows[at + (left === !R_.flow ? -1 : 1)];
  const target = flowTarget && flowTarget.flow === R_.flow ? flowTarget : rows[at + (left ? -1 : 1)];
  if (!target) return c;
  const nStops = stopsOf(target);
  return (left ? nStops[nStops.length - 1] : nStops[0]).c;
}
