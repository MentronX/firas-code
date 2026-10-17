// Arabic shaping: logical letters -> Presentation Forms (U+FB50..FDFF, U+FE70..FEFF), because a terminal
// draws one cell per code point and never joins letters by itself.
//
// The tables are derived at load time from Unicode itself: every presentation-form glyph has a compatibility
// decomposition back to its base letter, and within a group the glyphs always come in the order
// isolated, final, initial, medial (right-joining letters have only the first two). Nothing is typed by hand
// except a few documented exceptions, so there is no table that can contain a typo.
//
// Decisions:
//  - Joining type comes from the glyphs available: 4 forms = dual-joining, 2 forms = right-joining, 1 = non-joining.
//    Letters that have no presentation forms (e.g. Kurdish heh U+06D5, Arabic Supplement) are left untouched
//    and treated as non-joining, so we never produce a half-connected word.
//  - U+0649 (alef maksura) is treated as right-joining: Arabic only uses it word-finally.
//  - U+06BA (noon ghunna) has final/isolated glyphs only; its initial/medial forms borrow the noon glyphs.
//  - Combining marks (harakat etc.) are transparent: they never break a join and stay after their base letter.
//  - Lam + alef (alef, madda, hamza above/below) becomes one ligature glyph; marks between the two are kept
//    and emitted after the ligature.
//  - ZWJ forces a join and ZWNJ breaks one; both stay in the output as zero-width characters.
//  - Input that is already shaped is first mapped back to base letters, so shaping is idempotent.
import { isTransparent } from "./width.js";

const ISO = 0, FIN = 1, INI = 2, MED = 3;
const U = 0, D = 1, R = 2, C = 3, T = 4; // joining types

const FORMS = new Map();       // base letter -> [isolated, final, initial, medial] (0 = missing)
const BASE_OF = new Map();     // presentation form -> base letter
const LAM_ALEF = new Map();    // alef variant -> [isolated lig, final lig]
const LIG_PARTS = new Map();   // lam-alef ligature -> [lam, alef variant]

function build() {
  const groups = [];
  let cur = null;
  const scan = (lo, hi) => {
    cur = null;
    for (let cp = lo; cp <= hi; cp++) {
      const ch = String.fromCodePoint(cp);
      const norm = ch.normalize("NFKC");
      const parts = [...norm];
      if (parts.length === 1 && norm !== ch) {
        const base = norm.codePointAt(0);
        if (cur && cur.base === base && cur.forms[cur.forms.length - 1] === cp - 1) cur.forms.push(cp);
        else { cur = { base, forms: [cp] }; groups.push(cur); }
      } else {
        cur = null;
        if (parts.length === 2 && parts[0] === "\u0644" && cp >= 0xfef5 && cp <= 0xfefc) {
          const alef = parts[1].codePointAt(0);
          const slot = LAM_ALEF.get(alef) || [0, 0];
          slot[(cp - 0xfef5) % 2] = cp;
          LAM_ALEF.set(alef, slot);
          LIG_PARTS.set(cp, [0x644, alef]);
        }
      }
    }
  };
  scan(0xfb50, 0xfbff);
  scan(0xfe80, 0xfefc);
  for (const g of groups) {
    for (const f of g.forms) BASE_OF.set(f, g.base);
    if (g.base === 0x649 && g.forms[0] >= 0xfb00 && g.forms[0] < 0xfc00) continue; // Uighur-only alef maksura glyphs
    if (g.forms.length === 4) FORMS.set(g.base, [g.forms[0], g.forms[1], g.forms[2], g.forms[3]]);
    else if (g.forms.length === 2) FORMS.set(g.base, [g.forms[0], g.forms[1], 0, 0]);
  }
  // Noon ghunna joins on both sides but only owns isolated/final glyphs; borrow noon's initial/medial.
  const noon = FORMS.get(0x646);
  const ghunna = FORMS.get(0x6ba);
  if (noon && ghunna) FORMS.set(0x6ba, [ghunna[ISO], ghunna[FIN], noon[INI], noon[MED]]);
}
build();

const QUICK = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;

/** Does this string contain anything the shaper cares about? */
export function hasArabic(s) {
  return QUICK.test(s);
}

function joinType(cp) {
  const f = FORMS.get(cp);
  if (f) return f[INI] ? D : R;
  if (cp === 0x640 || cp === 0x200d) return C;
  if (cp < 0x300) return U;
  if (isTransparent(cp)) return T;
  return U;
}

/** Joining type of a code point: "D" dual, "R" right, "C" join-causing, "T" transparent, "U" non-joining. */
export function joiningType(cp) {
  return "UDRCT"[joinType(cp)];
}

/** Presentation forms of a base letter as [isolated, final, initial, medial] or null. */
export function formsOf(cp) {
  const f = FORMS.get(cp);
  return f ? f.slice() : null;
}

function needsUnshape(cps) {
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if ((cp >= 0xfb50 && cp <= 0xfbff) || (cp >= 0xfe80 && cp <= 0xfefc)) return true;
  }
  return false;
}

/**
 * Shapes an array of code points. Returns { out, from, to }: output code points, and for each the
 * half-open range [from, to) of INPUT indexes it came from (a ligature covers two letters; consumed
 * joiners simply do not appear).
 */
export function shapeCodepoints(cps) {
  const n = cps.length;
  let b = cps;
  let map = null;
  if (needsUnshape(cps)) {
    b = [];
    map = [];
    for (let i = 0; i < n; i++) {
      const cp = cps[i];
      const lig = LIG_PARTS.get(cp);
      if (lig) { b.push(lig[0], lig[1]); map.push(i, i); continue; }
      const base = BASE_OF.get(cp);
      b.push(base === undefined ? cp : base);
      map.push(i);
    }
  }
  const m = b.length;
  const types = new Uint8Array(m);
  for (let i = 0; i < m; i++) types[i] = joinType(b[i]);
  // nxt[i] = index of the next non-transparent character after i, or -1
  const nxt = new Int32Array(m);
  let next = -1;
  for (let i = m - 1; i >= 0; i--) {
    nxt[i] = next;
    if (types[i] !== T) next = i;
  }
  const out = [], from = [], to = [];
  const push = (cp, f, t) => {
    out.push(cp);
    from.push(map ? map[f] : f);
    to.push(map ? map[t - 1] + 1 : t);
  };
  let prevConnects = false; // the previous non-transparent letter can join forward
  let prevLetter = false;   // ...and was an Arabic letter we know
  for (let k = 0; k < m; k++) {
    const cp = b[k], ty = types[k];
    if (ty === T) { push(cp, k, k + 1); continue; }
    const f = FORMS.get(cp);
    if (!f) {
      const nIdx = nxt[k];
      if (cp === 0x200c || cp === 0x200d) {
        const nextLetter = nIdx >= 0 && FORMS.has(b[nIdx]);
        if (prevLetter || nextLetter) {
          // Kept in the output (zero width, bidi class BN) so shaping stays idempotent: re-shaping the
          // result must see the same joiner. The display layer drops it when it builds a visual line.
          push(cp, k, k + 1);
          prevConnects = cp === 0x200d;
          prevLetter = false;
          continue;
        }
      }
      push(cp, k, k + 1);
      prevConnects = ty === C; // tatweel keeps the word connected
      prevLetter = false;
      continue;
    }
    const nIdx = nxt[k];
    const nTy = nIdx >= 0 ? types[nIdx] : U;
    const joinsPrev = prevConnects;
    if (cp === 0x644 && nIdx >= 0) {
      const lig = LAM_ALEF.get(b[nIdx]);
      if (lig) {
        push(joinsPrev ? lig[1] : lig[0], k, nIdx + 1);
        for (let t = k + 1; t < nIdx; t++) push(b[t], t, t + 1);
        prevConnects = false;
        prevLetter = true;
        k = nIdx;
        continue;
      }
    }
    const joinsNext = ty === D && (nTy === D || nTy === R || nTy === C);
    const form = joinsPrev ? (joinsNext ? MED : FIN) : (joinsNext ? INI : ISO);
    push(f[form] || cp, k, k + 1);
    prevConnects = ty === D;
    prevLetter = true;
  }
  return { out, from, to };
}

function fromCodepoints(cps) {
  let s = "";
  for (let i = 0; i < cps.length; i += 4096) s += String.fromCodePoint(...cps.slice(i, i + 4096));
  return s;
}

function toCodepoints(s) {
  const cps = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xffff) i++;
    cps.push(cp);
  }
  return cps;
}

/** Shapes plain text (no ANSI). Idempotent: shaping already-shaped text returns it unchanged. */
export function shapeArabic(s) {
  if (!QUICK.test(s)) return s;
  return fromCodepoints(shapeCodepoints(toCodepoints(s)).out);
}

/** Maps presentation forms (and lam-alef ligatures) back to base letters. */
export function unshapeArabic(s) {
  if (!QUICK.test(s)) return s;
  const out = [];
  for (const cp of toCodepoints(s)) {
    const lig = LIG_PARTS.get(cp);
    if (lig) { out.push(lig[0], lig[1]); continue; }
    const base = BASE_OF.get(cp);
    out.push(base === undefined ? cp : base);
  }
  return fromCodepoints(out);
}

/** Is this one of the Arabic-script letters the shaper can join (including the ones with presentation forms)? */
export function isShapable(cp) {
  return FORMS.has(cp);
}
