// Terminal cell widths. A terminal gives every cell exactly 0, 1 or 2 columns, so this decides how
// many columns a character, a grapheme-like cluster or a whole string takes.
//
// Decisions:
//  - Control characters, combining marks (Mn/Me), format characters (Cf: ZWJ, ZWNJ, LRM, soft hyphen...)
//    and conjoining Hangul jamo vowels/finals are 0 columns.
//  - East Asian Wide/Fullwidth and Emoji_Presentation characters are 2; "ambiguous" is 1 (non-CJK terminals).
//  - A cluster = base + marks / variation selectors / emoji modifiers / ZWJ-joined pictographs / a flag pair.
//    Its width is the width of the base, widened to 2 for emoji sequences (VS16, ZWJ, skin tones).
//  - Tab is a control character: 0 columns. Expand tabs before measuring.
//  - Arabic letters and presentation forms are 1 column; a lam+alef pair becomes one ligature cell,
//    so stringWidth counts it once (see `shaped`).
import { stripAnsi } from "./ansi.js";

const MARK = 1, FMT = 2, WIDE = 4, PICT = 8, EMOJI = 16;

const RE_MARK = /^[\p{Mn}\p{Me}]$/u;
const RE_FMT = /^\p{Cf}$/u;
const RE_EMOJI_PRES = /^\p{Emoji_Presentation}$/u;
const RE_PICT = /^\p{Extended_Pictographic}$/u;
const RE_EMOJI = /^\p{Emoji}$/u;

// East Asian Wide / Fullwidth blocks that are not Emoji_Presentation (those come from the regex above).
const WIDE_RANGES = [
  0x1100, 0x115f, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0, 0x303e, 0x3041, 0x3096,
  0x3099, 0x30ff, 0x3105, 0x312f, 0x3131, 0x318e, 0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247,
  0x3250, 0x4dbf, 0x4e00, 0xa48c, 0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff,
  0xfe10, 0xfe19, 0xfe30, 0xfe52, 0xfe54, 0xfe66, 0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6,
  0x16fe0, 0x16fe4, 0x16ff0, 0x16ff1, 0x17000, 0x187f7, 0x18800, 0x18cd5, 0x18d00, 0x18d08,
  0x1aff0, 0x1affe, 0x1b000, 0x1b122, 0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155,
  0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1f200, 0x1f202, 0x1f210, 0x1f23b, 0x1f240, 0x1f248,
  0x1f250, 0x1f251, 0x1f260, 0x1f265, 0x20000, 0x2fffd, 0x30000, 0x3fffd,
];

function inRanges(table, cp) {
  let lo = 0, hi = (table.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < table[mid * 2]) hi = mid - 1;
    else if (cp > table[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function compute(cp) {
  const ch = String.fromCodePoint(cp);
  let f = 0;
  if (RE_MARK.test(ch) || (cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) f |= MARK;
  if (RE_FMT.test(ch)) f |= FMT;
  if (RE_EMOJI_PRES.test(ch) || inRanges(WIDE_RANGES, cp)) f |= WIDE;
  if (RE_PICT.test(ch)) f |= PICT;
  if (RE_EMOJI.test(ch)) f |= EMOJI;
  return f;
}

const bmpCache = new Uint8Array(0x10000); // flags | 0x80 once computed
const astralCache = new Map();

function props(cp) {
  if (cp < 0x10000) {
    const v = bmpCache[cp];
    if (v) return v & 0x7f;
    const f = compute(cp);
    bmpCache[cp] = f | 0x80;
    return f;
  }
  let f = astralCache.get(cp);
  if (f === undefined) {
    f = compute(cp);
    astralCache.set(cp, f);
  }
  return f;
}

/** True for combining marks, variation selectors and other characters that attach to the previous one. */
export function isCombining(cp) {
  return cp >= 0x300 && (props(cp) & MARK) !== 0;
}

const DIRECTION_FORMAT = new Set([0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

/** Characters Arabic joining looks straight through: combining marks and direction marks. */
export function isTransparent(cp) {
  return (cp >= 0x300 && (props(cp) & MARK) !== 0) || DIRECTION_FORMAT.has(cp);
}

/** True for zero-width format characters (ZWJ, ZWNJ, LRM, RLM, bidi controls, soft hyphen...). */
export function isFormat(cp) {
  return cp === 0xad || (cp >= 0x200b && (props(cp) & FMT) !== 0);
}

function isPict(cp) {
  return cp === 0xa9 || cp === 0xae || (cp >= 0x203c && (props(cp) & PICT) !== 0);
}

/** Columns used by one code point on its own: 0, 1 or 2. */
export function charWidth(cp) {
  if (cp < 0x7f) return cp < 0x20 ? 0 : 1;
  if (cp < 0xa0 || cp === 0xad) return 0;
  if (cp < 0x300) return 1;
  const f = props(cp);
  if (f & (MARK | FMT)) return 0;
  return f & WIDE ? 2 : 1;
}

/**
 * Splits a code point array into display clusters and reports each as emit(start, end, width).
 * Clusters never split a base from its marks, an emoji ZWJ sequence, a flag or a modifier sequence.
 */
export function segmentCodepoints(cps, n, emit) {
  let i = 0;
  while (i < n) {
    const start = i;
    const base = cps[i++];
    let width = charWidth(base);
    const pict = isPict(base);
    const ri = base >= 0x1f1e6 && base <= 0x1f1ff;
    let riPair = false, vs16 = false, joined = false, modifier = false;
    while (i < n) {
      const c = cps[i];
      if (c < 0x300) break;
      if (c === 0x200d) {
        if (!pict) break;
        i++;
        joined = true;
        if (i < n && isPict(cps[i])) i++;
        continue;
      }
      if (c === 0xfe0f) { vs16 = true; i++; continue; }
      if (c >= 0x1f3fb && c <= 0x1f3ff) {
        if (!pict) break;
        modifier = true;
        i++;
        continue;
      }
      if (c >= 0xe0020 && c <= 0xe007f) {
        if (!pict) break;
        i++;
        continue;
      }
      if (ri && !riPair && c >= 0x1f1e6 && c <= 0x1f1ff) { riPair = true; i++; continue; }
      if (props(c) & MARK) { i++; continue; }
      break;
    }
    if (pict && (joined || modifier)) width = 2;
    else if (vs16 && width === 1 && (props(base) & EMOJI)) width = 2;
    emit(start, i, width);
  }
}

const PLAIN_ASCII = /^[\x20-\x7e]*$/;

function isAlefForLigature(cp) {
  return cp === 0x627 || cp === 0x622 || cp === 0x623 || cp === 0x625;
}

/**
 * Terminal columns of a string. ANSI sequences count 0. With `shaped` (default) a lam followed by an alef
 * (marks may sit between them) counts as ONE cell because the shaper turns the pair into a single ligature.
 */
export function stringWidth(s, o) {
  const t = stripAnsi(s);
  if (PLAIN_ASCII.test(t)) return t.length;
  const shaped = !o || o.shaped !== false;
  const cps = [];
  for (let i = 0; i < t.length; i++) {
    const cp = t.codePointAt(i);
    if (cp > 0xffff) i++;
    cps.push(cp);
  }
  const n = cps.length;
  let list = cps;
  if (shaped && t.indexOf("\u0644") !== -1) {
    // Drop the alef of every lam+alef pair (marks may sit between them): the pair is one ligature cell.
    list = [];
    for (let i = 0; i < n; i++) {
      const cp = cps[i];
      list.push(cp);
      if (cp !== 0x644) continue;
      let j = i + 1;
      while (j < n && isTransparent(cps[j])) j++;
      if (j < n && isAlefForLigature(cps[j])) {
        for (let k = i + 1; k < j; k++) list.push(cps[k]);
        i = j;
      }
    }
  }
  let total = 0;
  segmentCodepoints(list, list.length, (_a, _b, width) => { total += width; });
  return total;
}
