// Text analysis and wrapping.
//
// `analyze` turns a string (with ANSI) into display CELLS: one cell per cluster (a base letter with its
// marks, an emoji sequence, a lam-alef ligature...), each knowing its terminal width, its style and
// the range of the logical text it came from. Wrapping works on cells, so it can never split a
// surrogate pair, a ligature or a base+mark, and measures Arabic by what will actually be drawn.
//
// Decisions:
//  - Break opportunities: after spaces (the spaces at the break are dropped), and around CJK ideographs
//    (with a small kinsoku list so closing punctuation never starts a line). Everything else is a hard break
//    only when a single token is wider than the line.
//  - Leading spaces of the very first line are kept (they are indentation); spaces that end a line
//    or start a continuation line are dropped.
//  - `wrapLogical` returns the ORIGINAL logical characters (never shaped), with SGR styles re-opened on
//    every line and closed at its end.
//  - "\n" inside the text is a hard line break; the next segment starts with `indent`.
import { scanEscape, isComplete, classify, PLAIN, applySgr, withLink, styleKey, transition } from "./ansi.js";
import { shapeCodepoints } from "./arabic.js";
import { segmentCodepoints } from "./width.js";

const chrCache = new Map();
function chr(cp) {
  let s = chrCache.get(cp);
  if (s === undefined) {
    s = String.fromCodePoint(cp);
    if (chrCache.size < 20000) chrCache.set(cp, s);
  }
  return s;
}

/**
 * Parses `text` into cells.
 * Returns { src, cells, styles, tailSt, tailPre, from, lo }:
 *   src      the text with ANSI removed (logical order, original characters)
 *   cells    [{ s, w, lo, hi, st, pre, cp, k0, k1 }]  s = text to draw, w = columns, [lo,hi) = range in src,
 *            st = style id, pre = non-style escapes to emit before it, cp = base code point,
 *            [k0,k1) = range in the (shaped) code point list
 *   styles   style id -> state object (id 0 is plain)
 *   tailSt   style in force at the end of the text, tailPre = trailing non-style escapes
 *   from/lo  for logical lookups of a shaped code point: lo[from ? from[k] : k]
 */
export function analyze(text, shape = true) {
  const styles = [PLAIN];
  const ids = new Map([[styleKey(PLAIN), 0]]);
  const intern = st => {
    const k = styleKey(st);
    let id = ids.get(k);
    if (id === undefined) { id = styles.length; styles.push(st); ids.set(k, id); }
    return id;
  };
  const cps = [], lo = [], sty = [];
  let pre = null;
  let state = PLAIN, cur = 0;
  let srcLen = 0;
  let sawArabic = false;
  let parts = null;
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    const e = text.indexOf("\x1b", pos);
    const end = e === -1 ? n : e;
    for (let i = pos; i < end;) {
      const cp = text.codePointAt(i);
      cps.push(cp);
      lo.push(srcLen + i - pos);
      sty.push(cur);
      if ((cp >= 0x600 && cp <= 0x8ff) || (cp >= 0xfb50 && cp <= 0xfeff)) sawArabic = true;
      i += cp > 0xffff ? 2 : 1;
    }
    if (end > pos && e !== -1) (parts || (parts = [])).push(text.slice(pos, end));
    srcLen += end - pos;
    if (e === -1) {
      if (parts && end > pos) parts.push(text.slice(pos, end));
      break;
    }
    const stop = scanEscape(text, e);
    const raw = text.slice(e, stop);
    // Garbled or truncated sequences are dropped: after reordering they could be glued to unrelated text.
    const kind = isComplete(raw) ? classify(raw) : null;
    if (kind && kind.kind === "sgr") { state = applySgr(state, kind.params); cur = intern(state); }
    else if (kind && kind.kind === "link") { state = withLink(state, kind.open, raw); cur = intern(state); }
    else if (kind) {
      if (!pre) pre = new Map();
      pre.set(cps.length, (pre.get(cps.length) || "") + raw);
    }
    if (!parts) parts = [];
    pos = stop;
  }
  const src = parts ? parts.join("") : text;

  let out = cps, from = null, to = null;
  if (shape && sawArabic) {
    const r = shapeCodepoints(cps);
    out = r.out; from = r.from; to = r.to;
  }

  const cells = [];
  let prevHi = 0;
  segmentCodepoints(out, out.length, (a, b, w) => {
    const f0 = from ? from[a] : a;
    let tmax = from ? to[a] : b;
    if (from) for (let j = a + 1; j < b; j++) if (to[j] > tmax) tmax = to[j];
    const last = tmax - 1;
    const cellLo = cells.length ? prevHi : 0;
    let hi = lo[last] + (cps[last] > 0xffff ? 2 : 1);
    if (hi < cellLo) hi = cellLo;
    let s;
    if (b - a === 1) s = chr(out[a]);
    else { s = ""; for (let j = a; j < b; j++) s += chr(out[j]); }
    let p = "";
    if (pre) for (let j = f0; j < tmax; j++) { const x = pre.get(j); if (x) p += x; }
    cells.push({ s, w, lo: cellLo, hi, st: sty[f0], pre: p, cp: out[a], k0: a, k1: b });
    prevHi = hi;
  });
  if (cells.length) cells[cells.length - 1].hi = src.length;
  return {
    src, cells, styles, tailSt: cur, tailPre: pre && pre.get(cps.length) || "", from, lo,
  };
}

// ---------------------------------------------------------------------------------------------
// Line breaking over widths

const SP = 1, IDEO = 2, CLOSER = 4, OPENER = 8;

const CJK_CLOSERS = new Set([0x3001, 0x3002, 0xff0c, 0xff0e, 0xff1a, 0xff1b, 0xff01, 0xff1f, 0xff09, 0xff3d, 0xff5d, 0x3015,
  0x3009, 0x300b, 0x300d, 0x300f, 0x3011, 0x3019, 0x3017, 0x301f, 0x30fc, 0x2019, 0x201d]);
const CJK_OPENERS = new Set([0xff08, 0xff3b, 0xff5b, 0x3014, 0x3008, 0x300a, 0x300c, 0x300e, 0x3010, 0x3018, 0x3016, 0x301d, 0x2018, 0x201c]);

function isIdeographic(cp) {
  return (cp >= 0x2e80 && cp < 0xa4d0) || (cp >= 0xf900 && cp < 0xfb00) || (cp >= 0xfe30 && cp < 0xfe70) ||
    (cp >= 0xff00 && cp < 0xff61) || (cp >= 0xffe0 && cp < 0xffe7) || (cp >= 0x20000 && cp < 0x40000);
}

function isSpaceCp(cp) {
  return cp === 0x20 || cp === 0x09 || cp === 0x3000 || cp === 0x1680 || cp === 0x205f ||
    (cp >= 0x2000 && cp <= 0x200a && cp !== 0x2007);
}

function kindOfCodepoint(cp, width) {
  if (isSpaceCp(cp)) return SP;
  let k = 0;
  if (width === 2 && isIdeographic(cp)) k |= IDEO;
  if (CJK_CLOSERS.has(cp)) k |= CLOSER;
  if (CJK_OPENERS.has(cp)) k |= OPENER;
  return k;
}

/**
 * Greedy line breaker over per-cell widths and kinds.
 * Returns rows { a, b, e, w }: cells [a,b) are shown, cells [b,e) are the spaces swallowed by the break
 * (the next row starts at e), w = columns used by [a,b).
 * `keepTrailing` keeps trailing spaces that still fit (the input editor needs the caret to move over them).
 */
export function wrapWidths(widths, kinds, n, avail1, availRest, keepTrailing) {
  const rows = [];
  if (n === 0) return [{ a: 0, b: 0, e: 0, w: 0 }];
  const first = Math.max(1, avail1), rest = Math.max(1, availRest);
  let rowA = 0, rowB = 0, rowW = 0, hasWord = false;
  const close = e => {
    rows.push({ a: rowA, b: rowB, e, w: rowW });
    hasWord = false;
  };
  let i = 0;
  while (i < n) {
    const gs = i;
    let gapW = 0;
    while (i < n && (kinds[i] & SP)) { gapW += widths[i]; i++; }
    const ge = i;
    const avail = rows.length ? rest : first;
    if (ge >= n) {
      if (keepTrailing) {
        for (let p = rowB; p < ge; p++) {
          if (rowW + widths[p] > avail) break;
          rowB = p + 1;
          rowW += widths[p];
        }
      }
      break;
    }
    let ae = ge + 1;
    let atomW = widths[ge];
    while (ae < n && !(kinds[ae] & SP)) {
      const p = kinds[ae - 1], q = kinds[ae];
      if (((p | q) & IDEO) && !(q & CLOSER) && !(p & OPENER)) break;
      atomW += widths[ae];
      ae++;
    }
    const empty = rowB === rowA;
    if (empty) {
      if (rows.length === 0 && gs < ge && gapW + widths[ge] <= avail) { rowA = gs; rowB = ge; rowW = gapW; }
      else { rowA = ge; rowB = ge; rowW = 0; }
    } else if (rowW + gapW + atomW <= avail) {
      rowB = ge;
      rowW += gapW;
    } else {
      close(ge);
      rowA = ge; rowB = ge; rowW = 0;
    }
    for (let p = ge; p < ae; p++) {
      const cw = widths[p];
      const room = rows.length ? rest : first;
      if (hasWord && rowW + cw > room) {
        close(p);
        rowA = p; rowB = p; rowW = 0;
      }
      rowB = p + 1;
      rowW += cw;
      hasWord = true;
    }
    i = ae;
  }
  rows.push({ a: rowA, b: rowB, e: n, w: rowW });
  return rows;
}

/** Rows for a cell array (see wrapWidths). */
export function wrapCells(cells, avail1, availRest, keepTrailing) {
  const n = cells.length;
  const widths = new Uint8Array(n), kinds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    widths[i] = c.w;
    kinds[i] = kindOfCodepoint(c.cp, c.w);
  }
  return wrapWidths(widths, kinds, n, avail1, availRest, keepTrailing);
}

/**
 * Source text of a row, with styles re-opened at the start and closed at the end. `head` and `tail` are direction
 * isolates carried over from the previous row / left open for the next one (see wrapSegment).
 */
function rowToString(model, a, b, head = "", tail = "") {
  const { src, cells, styles } = model;
  let out = head;
  let prev = 0;
  let p = a;
  while (p < b) {
    const st = cells[p].st;
    let q = p + 1;
    while (q < b && cells[q].st === st && !cells[q].pre) q++;
    if (cells[p].pre) out += cells[p].pre;
    if (st !== prev) { out += transition(styles[prev], styles[st]); prev = st; }
    out += src.slice(cells[p].lo, cells[q - 1].hi);
    p = q;
  }
  if (prev !== 0) out += transition(styles[prev], PLAIN);
  return out + tail;
}

const PDI = String.fromCharCode(0x2069);
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function limit(width) {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1e9;
}

function wrapSegment(seg, width, firstIndent, indent, widthOf) {
  const w1 = limit(width) - widthOf(firstIndent);
  const w2 = limit(width) - widthOf(indent);
  if (PRINTABLE_ASCII.test(seg)) {
    const n = seg.length;
    const widths = new Uint8Array(n).fill(1);
    const kinds = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (seg.charCodeAt(i) === 32) kinds[i] = SP;
    return wrapWidths(widths, kinds, n, w1, w2, false)
      .map((r, k) => (k ? indent : firstIndent) + seg.slice(r.a, r.b));
  }
  const model = analyze(seg, true);
  // A direction isolate (U+2066-2068 ... U+2069) that a break cuts in two is closed at the end of its row and opened
  // again at the start of the next, like a style: every row is ordered on its own, so a row that only held the end
  // of a left-to-right isolate would otherwise let its trailing punctuation take the paragraph's direction.
  const open = [];
  return wrapCells(model.cells, w1, w2, false).map((r, k) => {
    const head = open.map(cp => String.fromCodePoint(cp)).join("");
    for (let p = r.a; p < r.b; p++) {
      const cp = model.cells[p].cp;
      if (cp >= 0x2066 && cp <= 0x2068) open.push(cp);
      else if (cp === 0x2069 && open.length) open.pop();
    }
    return (k ? indent : firstIndent) + rowToString(model, r.a, r.b, head, PDI.repeat(open.length));
  });
}

/**
 * Wraps logical text to `width` columns. Returns LOGICAL lines (original characters, not shaped, not reordered).
 * o: { firstIndent = "", indent = "" }. `widthOf` measures the indents (display.js passes stringWidth).
 */
export function wrapLogicalWith(s, width, o, widthOf) {
  const firstIndent = (o && o.firstIndent) || "";
  const indent = (o && o.indent) || "";
  const segs = s.split("\n");
  const lines = [];
  segs.forEach((seg, k) => {
    const clean = seg.endsWith("\r") ? seg.slice(0, -1) : seg;
    lines.push(...wrapSegment(clean, width, k ? indent : firstIndent, indent, widthOf));
  });
  return lines;
}
