// Markdown -> styled terminal lines, built so the SAME engine serves the one-shot renderer and the streaming one.
//
// Decisions:
//  - Output model: every function returns finished VISUAL lines (wrapped, shaped, bidi-ordered, RTL right-aligned) that
//    are prefixed with `indent` (the gutter). Content is at most 100 columns wide and never wider than width - indent.
//  - A newline inside a paragraph is a line break (chat answers use it that way), so paragraphs, headings, list items and
//    quote lines are all laid out one SOURCE LINE at a time. That is also what makes streaming exact: a finished line
//    never changes, and only the line still being typed is re-laid out.
//  - Direction is decided per source line from its first 24 letters (code spans and URLs ignored): first strong letter
//    RTL -> RTL; otherwise Arabic letters outnumbering Latin ones -> RTL. `dir: "ltr" | "rtl"` forces it everywhere.
//  - Spacing between blocks: source blank lines are kept (collapsed to one); a blank line is added around headings,
//    tables, rules and code blocks, after lists and quotes, and never inside a list.
//  - A table header row must start with "|" (a delimiter row must follow). Tables are laid out when they end.
//  - No indented code blocks, setext headings, reference links, footnotes or raw HTML (except <br> inside table cells).
//  - Markers dropped from view (#, **, `...`) keep their meaning in colour; with colour level 0 the structure still
//    reads: backticks stay around code, ~~ around struck text, bullets and numbers stay, links print "(url)", H1/H2 get
//    a rule.
//  - Code is always left-to-right and left-aligned. Arabic inside a code line (a string, a comment) is joined AND its
//    own run is put in reading order with toVisual(dir "ltr"); the code around it never moves. (shapeLine alone would
//    show Arabic words back to front on a terminal.)
//  - Model text is untrusted: escape sequences, control characters and bidi controls are removed before layout.
//  - Early commit of a growing paragraph line (stream.js) is exact: rows are released only up to the "stable offset"
//    (before any unclosed *, _, `, [ and before the last unfinished word), see parseInline().
//
// Inline styles, in the two kinds of terminal (theme.js textEffects()). The classic Windows console draws no dim,
// italic or strike (theme.js turns them into colours) and a background as dark as the panel colour does not show on
// its black screen, so each inline style has a second form there. Every pair stays distinct in both:
//                     effects drawn (modern terminal)         effects not drawn (classic console)
//    *em*             italic                                  the soft accent (what c.italic becomes)
//    **strong**       bold                                    bold (the console's bright white)
//    `code`           soft accent on the panel, padded " x "  magenta, no padding: with no background to fill, the
//                                                             padding would only read as a double space
//    [link](url)      underlined, " (url)" dim                the same: the console draws underline
//    ~~strike~~       struck through                          a faint gray AND the ~~ kept: struck text often says
//                                                             "not this", and a colour alone reads as "less important"
//    With no colour at all the ~~ stay too, for the same reason the backticks stay around code.
//  - Block tones (dev/DESIGN.md): headings H1 bold accent + rule, H2 bold accent, H3 bold, H4-H6 bold dim. A quote bar is
//    the soft accent and a code bar gray, so the two differ even where both glyphs are the same "│". Quoted text is dim
//    and, where it can be drawn, italic (on the classic console italic would turn the whole quote the soft accent, the
//    colour of emphasis). Rules, table borders and the code bar are structure: gray. Bullets and numbers are dim: the
//    accent is a signal, and a long list would otherwise put dozens of accent marks on the screen.
//  - Links and URLs are isolated like code spans: a URL (bare, <auto>, or the " (url)" after a label) in a left-to-right
//    isolate, a label in an isolate of its own direction (decided once, from the whole label, so a label cut by a line
//    break keeps it on both rows). Otherwise the ")" of a URL that wraps, or the "!" of a Latin label, takes the
//    direction of the Arabic line around it and lands on the wrong side.
import { c, sym, colorLevel, textEffects } from "./theme.js";
import { registerStrings, t } from "../i18n/index.js";
import { layoutParagraph, orderRows, wrapLogical, stringWidth, stripAnsi, toVisual, arabicActive } from "../text/display.js";
import { createLineHighlighter, paintTokens, wrapTokens } from "./highlight.js";

registerStrings("markdown", {
  ar: { image: "صورة" },
  en: { image: "image" },
});

const MAX_W = 100;
const LIMIT = 800;

export const glyphs = Object.freeze({
  bullets: sym.bullets,
  cont: sym.cont,
  box: Object.freeze({
    h: sym.boxH, v: sym.boxV, tl: sym.boxTL, tr: sym.boxTR, bl: sym.boxBL, br: sym.boxBR,
    tt: sym.boxT, bt: sym.boxB, lt: sym.boxL, rt: sym.boxR, x: sym.boxX,
  }),
});

// ---------------------------------------------------------------------------------------------
// Model text hygiene

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const NEEDS_CLEAN = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/;

/** Removes escape sequences, control and bidi-control characters; expands tabs to 4-column stops. */
export function cleanText(s) {
  let t = s;
  if (t.indexOf("\x1b") !== -1) t = stripAnsi(t);
  if (t.indexOf("\t") !== -1) {
    let out = "";
    let col = 0;
    for (const ch of t) {
      if (ch === "\t") { const n = 4 - (col % 4); out += " ".repeat(n); col += n; } else { out += ch; col++; }
    }
    t = out;
  }
  if (NEEDS_CLEAN.test(t)) t = t.replace(LONE_SURROGATE, "\ufffd").replace(CONTROLS, "");
  return t;
}

/**
 * Splits a buffer into complete lines (LF, CRLF or lone CR) and the unfinished rest. A CR at the very end is kept in
 * the rest because the LF of a CRLF may still be on its way. `from` skips a part already known to hold no line break.
 */
export function splitLines(buf, from = 0) {
  const lines = [];
  let start = 0;
  const re = /\r\n|\n|\r/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(buf))) {
    if (m[0] === "\r" && m.index === buf.length - 1) break;
    lines.push(buf.slice(start, m.index));
    start = m.index + m[0].length;
  }
  return { lines, rest: buf.slice(start) };
}

// ---------------------------------------------------------------------------------------------
// Inline parsing

const BOLD = 1, ITALIC = 2, STRIKE = 4, CODE = 8, LINK = 16, DIM = 32, ACCENT = 64;
// Not styles: where the bidi isolates go (paintRuns). HREF = a URL, LABEL = part of a link label, LABEL_RTL = that
// label reads right to left.
const HREF = 128, LABEL = 256, LABEL_RTL = 512;
// A code span's padding blank (PAD) and the content between the two (BODY), kept in runs of their own (Arabic only,
// see paintRun) so that where a stream cuts the span can never decide which blank lands inside the span's isolate.
const PAD = 1024, BODY = 2048;
const LABELS = LABEL | LABEL_RTL;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeText(raw) {
  if (raw.indexOf("\\") === -1 && raw.indexOf("&") === -1) return raw;
  return raw.replace(/\\([!-/:-@[-`{-~])|&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m, esc, ent) => (esc !== undefined ? esc : ENTITIES[ent]));
}

const SPECIAL = /[\\`*_~[<]|https?:\/\/|www\./gi;
const isSpace = ch => ch === undefined || /\s/.test(ch);
const isPunct = ch => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
const isAsciiPunct = ch => ch !== undefined && /[!-/:-@[-`{-~]/.test(ch);

function findBacktickClose(src, from, n) {
  const limit = Math.min(src.length, from + LIMIT);
  let j = from;
  while (j < limit) {
    const q = src.indexOf("`", j);
    if (q === -1 || q >= limit) return -1;
    let r = q;
    while (src[r] === "`") r++;
    if (r - q === n) return q;
    j = r;
  }
  return -1;
}

// Index of the "]" matching the "[" at p (nesting and code spans respected), -1 when there is none, or "pending" when
// a code span inside could still be closed by text that has not arrived (the answer would change).
function findBracketClose(src, p) {
  let depth = 0;
  const limit = Math.min(src.length, p + 500);
  for (let j = p; j < limit; j++) {
    const ch = src[j];
    if (ch === "\\") { j++; continue; }
    if (ch === "`") {
      let r = j;
      while (src[r] === "`") r++;
      const close = findBacktickClose(src, r, r - j);
      if (close !== -1) j = close + (r - j) - 1;
      else if (src.length - r < LIMIT) return "pending";
      else j = r - 1;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// Parses "(destination "title")" starting at the "(" at p. Returns { url, end } (end = index after ")"), or null / "pending".
function parseDestination(src, p) {
  const limit = Math.min(src.length, p + 1500);
  let depth = 0;
  for (let j = p; j < limit; j++) {
    const ch = src[j];
    if (ch === "\\") { j++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        let dest = src.slice(p + 1, j).trim();
        if (dest.startsWith("<")) { const e = dest.indexOf(">"); dest = e > 0 ? dest.slice(1, e) : dest.slice(1); }
        else dest = dest.split(/\s+/)[0] || "";
        return { url: decodeText(dest), end: j + 1 };
      }
    }
  }
  return src.length - p < 1500 ? "pending" : null;
}

// Punctuation that ends a sentence, not a URL. The Arabic comma, semicolon, question mark and full stop are glued to
// the word before them as often as the Latin ones; kept in the URL they would be drawn inside its left-to-right isolate,
// on the wrong side of it.
const URL_TAIL = /[.,;:!?'"*_~\]}>\u060c\u061b\u061f\u06d4]+$/;

function trimUrl(url) {
  let u = url.replace(URL_TAIL, "");
  for (;;) {
    if (!u.endsWith(")")) break;
    const open = (u.match(/\(/g) || []).length, close = (u.match(/\)/g) || []).length;
    if (close > open) u = u.slice(0, -1).replace(URL_TAIL, ""); else break;
  }
  return u;
}

function tokenize(src, from) {
  const toks = [];
  const pend = [];
  const len = src.length;
  let i = from, ts = from;
  const flush = end => { if (end > ts) toks.push({ k: "t", a: ts, b: end, f: 0 }); };
  for (;;) {
    SPECIAL.lastIndex = i;
    const m = SPECIAL.exec(src);
    if (!m) break;
    const p = m.index;
    const ch = src[p];
    if (ch === "\\") { i = p + (isAsciiPunct(src[p + 1]) ? 2 : 1); continue; }
    if (ch === "`") {
      let r = p;
      while (src[r] === "`") r++;
      const n = r - p;
      const close = findBacktickClose(src, r, n);
      if (close === -1) {
        if (len - r < LIMIT) pend.push(p);
        i = r;
        continue;
      }
      let s = src.slice(r, close);
      if (s.length > 2 && s.startsWith(" ") && s.endsWith(" ") && s.trim() !== "") s = s.slice(1, -1);
      flush(p);
      toks.push({ k: "c", a: p, b: close + n, s, f: 0 });
      i = ts = close + n;
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let r = p;
      while (src[r] === ch) r++;
      const n = r - p;
      if (ch === "~" && n !== 2) { i = r; continue; }
      const pc = p > 0 ? src[p - 1] : undefined;
      const nc = r < len ? src[r] : undefined;
      const left = !isSpace(nc) && (!isPunct(nc) || isSpace(pc) || isPunct(pc));
      const right = !isSpace(pc) && (!isPunct(pc) || isSpace(nc) || isPunct(nc));
      let open = left, close = right;
      if (ch === "_") { open = left && (!right || isPunct(pc)); close = right && (!left || isPunct(nc)); }
      flush(p);
      toks.push({ k: "d", ch, n, a: p, b: r, open, close, rem: n, dead: false, f: 0 });
      i = ts = r;
      continue;
    }
    if (ch === "[") {
      const image = p > 0 && src[p - 1] === "!" && p - 1 >= ts && !(p > 1 && src[p - 2] === "\\");
      const at = image ? p - 1 : p;
      const j = findBracketClose(src, p);
      if (j === "pending") { pend.push(at); i = p + 1; continue; }
      if (j === -1) { if (len - p < 500) pend.push(at); i = p + 1; continue; }
      if (j + 1 >= len) { pend.push(at); i = p + 1; continue; }
      if (src[j + 1] !== "(") { i = p + 1; continue; }
      const dest = parseDestination(src, j + 1);
      if (dest === "pending") { pend.push(at); i = p + 1; continue; }
      if (dest === null) { i = p + 1; continue; }
      const start = image ? p - 1 : p;
      flush(start);
      const label = src.slice(p + 1, j);
      toks.push({ k: "l", a: start, b: dest.end, label: parseInline(label, { final: true, nested: true }).runs, alt: image && label.trim() === "" ? t("markdown.image") : null, url: dest.url, f: 0 });
      i = ts = dest.end;
      continue;
    }
    if (ch === "<") {
      const tail = src.slice(p, p + 600);
      let mm = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(tail);
      if (mm) {
        flush(p);
        toks.push({ k: "u", a: p, b: p + mm[0].length, s: mm[1], f: 0 });
        i = ts = p + mm[0].length;
        continue;
      }
      mm = /^<br\s*\/?>/i.exec(tail);
      if (mm) {
        flush(p);
        toks.push({ k: "br", a: p, b: p + mm[0].length, f: 0 });
        i = ts = p + mm[0].length;
        continue;
      }
      i = p + 1;
      continue;
    }
    // bare URL
    if (m[0].length > 1) {
      const pc = p > 0 ? src[p - 1] : undefined;
      if (p > 0 && !/[\s(["'>*_~]/.test(pc)) { i = p + 1; continue; }
      const um = /^[^\s<]+/.exec(src.slice(p, p + 2000));
      const url = trimUrl(um[0]);
      if (url.length <= m[0].length) { i = p + m[0].length; continue; }
      flush(p);
      toks.push({ k: "u", a: p, b: p + url.length, s: url, f: 0 });
      i = ts = p + url.length;
      continue;
    }
    i = p + 1;
  }
  flush(len);
  return { toks, pend };
}

// CommonMark-style emphasis matching over the delimiter runs; returns the matched [opener, closer] token pairs.
function matchEmphasis(toks) {
  const pairs = [];
  for (let ci = 0; ci < toks.length; ci++) {
    const cl = toks[ci];
    if (cl.k !== "d" || !cl.close || cl.dead) continue;
    while (cl.rem > 0) {
      let oi = -1;
      for (let q = ci - 1; q >= 0; q--) {
        const op = toks[q];
        if (op.k !== "d" || op.ch !== cl.ch || !op.open || op.dead || op.rem === 0) continue;
        if (cl.a - op.b > LIMIT) break;
        if (cl.ch !== "~" && (op.close || cl.open) && (op.n + cl.n) % 3 === 0 && !(op.n % 3 === 0 && cl.n % 3 === 0)) continue;
        oi = q;
        break;
      }
      if (oi < 0) break;
      const op = toks[oi];
      const use = cl.ch === "~" ? 2 : (cl.rem >= 2 && op.rem >= 2 ? 2 : 1);
      const flag = cl.ch === "~" ? STRIKE : use === 2 ? BOLD : ITALIC;
      for (let q = oi + 1; q < ci; q++) {
        toks[q].f |= flag;
        if (toks[q].k === "d") toks[q].dead = true;
      }
      op.rem -= use;
      cl.rem -= use;
      // A ~~ run is used whole (n is 2), so it is in one pair at most; parseInline may print it again.
      if (flag === STRIKE) op.struck = cl.struck = true;
      pairs.push([oi, ci]);
    }
  }
  return pairs;
}

/**
 * Parses one line of inline markdown.
 * Returns { runs: [{ t, f }], stable, stableR }: `runs` is the styled text, `stable` the source offset up to which the
 * result can no longer change when more text is appended (only meaningful when !o.final), `stableR` the same position
 * in the rendered text (runs concatenated). o: { final = false, br = " " (text for <br>), from = 0 }.
 * With `from` (a previous `stable`) only src[from..] is parsed and returned: nothing before a stable offset can
 * interact with what follows it, which keeps a growing line linear instead of quadratic and lets a line whose first
 * rows are already out be finished at a new width.
 */
export function parseInline(src, o) {
  const final = !!(o && o.final);
  const br = o && o.br !== undefined ? o.br : " ";
  const from = (o && o.from) || 0;
  const { toks, pend } = tokenize(src, from);
  const pairs = matchEmphasis(toks);
  let S = null;
  if (!final) {
    S = src.length;
    while (S > from && !/\s/.test(src[S - 1])) S--;
    for (const p of pend) if (p < S) S = p;
    for (const tk of toks) if (tk.k === "d" && tk.open && tk.rem > 0 && !tk.dead && src.length - tk.b < LIMIT && tk.a < S) S = tk.a;
    let changed = true;
    while (changed) {
      changed = false;
      for (const [oi, ci] of pairs) {
        const a = toks[oi].a, b = toks[ci].b;
        if (a < S && S < b) { S = a; changed = true; }
      }
      for (const tk of toks) {
        if ((tk.k === "c" || tk.k === "l" || tk.k === "u") && tk.a < S && S < tk.b) { S = tk.a; changed = true; }
      }
    }
  }
  const runs = [];
  let rlen = 0;
  let stableR = -1;
  const push = (t, f) => {
    if (t === "") return;
    const last = runs[runs.length - 1];
    if (last && last.f === f) last.t += t; else runs.push({ t, f });
    rlen += t.length;
  };
  const level = colorLevel();
  // See the header: where strike cannot be drawn its ~~ stay; where a background cannot be seen code is not padded.
  const effects = level > 0 && textEffects();
  const code = s => (effects ? ` ${s} ` : level ? s : `\`${s}\``);
  for (const tk of toks) {
    if (stableR < 0 && S !== null) {
      if (tk.a >= S) stableR = rlen;
      else if (tk.k === "t" && S < tk.b) {
        push(decodeText(src.slice(tk.a, S)), tk.f);
        stableR = rlen;
        push(decodeText(src.slice(S, tk.b)), tk.f);
        continue;
      }
    }
    if (tk.k === "t") push(decodeText(src.slice(tk.a, tk.b)), tk.f);
    else if (tk.k === "d") push(tk.struck && !effects ? "~~" : tk.ch.repeat(tk.rem), tk.struck ? tk.f | STRIKE : tk.f);
    else if (tk.k === "c") {
      if (effects && arabicActive()) { push(" ", tk.f | CODE | PAD); push(tk.s, tk.f | CODE | BODY); push(" ", tk.f | CODE | PAD); }
      else push(code(tk.s), tk.f | CODE);
    }
    else if (tk.k === "u") push(tk.s, tk.f | LINK | HREF);
    else if (tk.k === "br") push(br, tk.f);
    else if (tk.k === "l") {
      const label = tk.label.map(r => r.t).join("");
      const text = tk.alt || label;
      const iso = LABEL | (lineDirection(label + (tk.alt || ""), null, true) === "rtl" ? LABEL_RTL : 0);
      for (const r of tk.label) push(r.t, r.f | tk.f | LINK | iso);
      if (tk.alt) push(tk.alt, tk.f | LINK | iso);
      if (tk.url && tk.url !== text && tk.url.replace(/^https?:\/\//, "") !== text) push(` (${tk.url})`, DIM | HREF);
    }
  }
  if (stableR < 0) stableR = rlen;
  return { runs, stable: S === null ? src.length : S, stableR };
}

// Code is left-to-right whatever surrounds it. Inside a right-to-left paragraph its trailing punctuation (a closing
// quote, "()", ";", "/") would otherwise take the paragraph's direction and jump to the front of the span, so a span is
// wrapped in a left-to-right isolate (invisible: toVisual drops it; wrapLogical re-opens it on a continuation row).
// URLs get the same isolate, link labels one of their own direction (see the header).
const LRI = "\u2066";
const RLI = "\u2067";
const PDI = "\u2069";
const ISOLATES = new RegExp(`[${LRI}-${PDI}]`, "g");

function paintRun(t, f) {
  if (t === "") return "";
  if (t.indexOf("\n") !== -1) return t.split("\n").map(x => paintRun(x, f)).join("\n");
  if (!(f & (CODE | HREF)) || !arabicActive() || (f & PAD)) return paintStyled(t, f);
  // The padding blanks stay outside the isolate: next to the blank that follows the span they must remain one run of
  // spaces, or a line break would no longer swallow them together. A padded span's blanks are PAD runs of their own,
  // so its content goes into the isolate whole - its own leading blank included, wherever a stream cut the span.
  if (f & BODY) return paintStyled(LRI + t + PDI, f);
  const lead = t.startsWith(" ") ? 1 : 0;
  const tail = t.length > lead && t.endsWith(" ") ? 1 : 0;
  const body = t.slice(lead, t.length - tail);
  // Nothing but blanks (a "` `" span on the classic console): there is no order to keep, and an isolate of nothing or
  // of blanks would be a word that a line break can neither split nor swallow, stranded on a row of its own.
  if (/^ *$/.test(body)) return paintStyled(t, f);
  return paintStyled(t.slice(0, lead) + LRI + body + PDI + t.slice(t.length - tail), f);
}

function paintStyled(t, f) {
  if (!colorLevel()) return t;
  let s = t;
  if (f & CODE) s = textEffects() ? c.bgPanel(c.accentSoft(s)) : c.magenta(s);
  if (f & STRIKE) s = c.strike(s);
  if (f & ITALIC) s = c.italic(s);
  if (f & BOLD) s = c.bold(s);
  if (f & LINK) s = c.underline(s);
  if (f & DIM) s = c.dim(s);
  if (f & ACCENT) s = c.accent(s);
  return s;
}

/** Runs -> one logical styled string; `base` flags are added to every run. */
export function paintRuns(runs, base = 0) {
  let out = "";
  if (!arabicActive()) {
    for (const r of runs) out += paintRun(r.t, r.f | base);
    return out;
  }
  // The runs of one link label (bold inside it, an image's alt text) share ONE isolate: an isolate per run would let
  // the paragraph order the pieces, and a Latin label inside Arabic would come out word by word backwards. Blanks at
  // either end of the label stay outside it, for the reason given in paintRun.
  for (let i = 0; i < runs.length;) {
    const g = runs[i].f & LABELS;
    if (!g) { out += paintRun(runs[i].t, runs[i].f | base); i++; continue; }
    let j = i;
    while (j < runs.length && (runs[j].f & LABELS) === g) j++;
    const parts = runs.slice(i, j).map(r => ({ t: r.t, f: r.f | base }));
    let pre = "", post = "";
    while (parts.length && parts[0].t.startsWith(" ")) {
      const p = parts[0], lead = /^ +/.exec(p.t)[0];
      pre += paintRun(lead, p.f);
      if (lead === p.t) parts.shift(); else parts[0] = { t: p.t.slice(lead.length), f: p.f };
    }
    while (parts.length && parts[parts.length - 1].t.endsWith(" ")) {
      const p = parts[parts.length - 1], trail = / +$/.exec(p.t)[0];
      post = paintRun(trail, p.f) + post;
      if (trail === p.t) parts.pop(); else parts[parts.length - 1] = { t: p.t.slice(0, -trail.length), f: p.f };
    }
    let body = "";
    for (const p of parts) body += paintRun(p.t, p.f);
    out += pre + (body ? (g & LABEL_RTL ? RLI : LRI) + body + PDI : "") + post;
    i = j;
  }
  return out;
}

function cutRuns(runs, from, to) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.t.length;
    if (end > from && pos < to) out.push({ t: r.t.slice(Math.max(from, pos) - pos, Math.min(to, end) - pos), f: r.f });
    pos = end;
    if (pos >= to) break;
  }
  return out;
}

function trimEndRuns(runs) {
  while (runs.length) {
    const last = runs[runs.length - 1];
    const t = last.t.replace(/\s+$/, "");
    if (t === "") { runs.pop(); continue; }
    last.t = t;
    break;
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------
// Direction

const K_LETTERS = 24;
const DIRECTION_WINDOW = 400;
const RTL_LETTER = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
const LETTER = /\p{L}/u;

/**
 * Paragraph direction of one source line, or null when the first 24 letters are not in yet (streaming) and the first
 * strong letter is not RTL. `forced` ("ltr" | "rtl") wins over detection.
 */
export function lineDirection(src, forced, final) {
  if (forced === "ltr" || forced === "rtl") return forced;
  // Only the first 400 characters count, so a very long line is decided as soon as it is that long.
  let t = src.length > DIRECTION_WINDOW ? src.slice(0, DIRECTION_WINDOW) : src;
  let open = false;
  if (!final && t.length === src.length) {
    // The word still being typed may turn into a URL or a code span: only finished words count until the line ends.
    let e = t.length;
    while (e > 0 && !/\s/.test(t[e - 1])) e--;
    t = t.slice(0, e);
    open = true;
  }
  if (t.indexOf("`") !== -1) t = t.replace(/`[^`]*`?/g, " ");
  if (t.indexOf("http") !== -1 || t.indexOf("www.") !== -1) t = t.replace(/(?:https?:\/\/|www\.)\S*/gi, " ");
  let r = 0, l = 0, first = -1;
  for (let i = 0; i < t.length; i++) {
    let ch = t[i];
    const cc = t.charCodeAt(i);
    if (cc < 0x41) continue;
    if (cc >= 0xd800 && cc <= 0xdbff) { ch = t.slice(i, i + 2); i++; }
    const ascii = cc < 0x80;
    if (ascii ? !((cc >= 0x41 && cc <= 0x5a) || (cc >= 0x61 && cc <= 0x7a)) : !LETTER.test(ch)) continue;
    const rtl = !ascii && RTL_LETTER.test(ch);
    if (first < 0) first = rtl ? 1 : 0;
    if (rtl) r++; else l++;
    if (r + l >= K_LETTERS) break;
  }
  if (first === 1) return "rtl";
  if (open && r + l < K_LETTERS) return null;
  return r > l ? "rtl" : "ltr";
}

// ---------------------------------------------------------------------------------------------
// Line classification

const FENCE = /^(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HRULE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^([-+*]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const DELIM_ROW = /^ *\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/**
 * True when the unfinished line can only be paragraph text: nothing typed after this point can turn it into a heading,
 * list item, quote, fence, rule or table row.
 */
export function isPlainStart(s) {
  if (s === "") return false;
  const ch = s[0];
  switch (ch) {
    case " ": case "\t": case ">": case "|": return false;
    case "#": {
      let n = 0;
      while (s[n] === "#") n++;
      if (n > 6) return true;
      return n < s.length && s[n] !== " " && s[n] !== "\t";
    }
    case "*":
      if (s.length === 1 || s[1] === " " || s[1] === "\t") return false;
      return /[^*\s]/.test(s);
    case "_":
      return /[^_\s]/.test(s) && s.length > 1;
    case "-":
      if (s.length === 1 || s[1] === " " || s[1] === "\t") return false;
      return /[^-\s]/.test(s);
    case "+":
      return s.length > 1 && s[1] !== " " && s[1] !== "\t";
    case "`": case "~": {
      let n = 0;
      while (s[n] === ch) n++;
      return n < 3 && n < s.length;
    }
    default:
      if (ch >= "0" && ch <= "9") {
        let i = 0;
        while (i < s.length && i < 10 && s[i] >= "0" && s[i] <= "9") i++;
        if (i >= 10) return true;
        if (i === s.length) return false;
        if (s[i] === "." || s[i] === ")") return i + 1 < s.length && s[i + 1] !== " " && s[i + 1] !== "\t";
        return true;
      }
      return true;
  }
}

/**
 * Visual rows for logical rows of one paragraph: what layoutParagraph does after wrapping, with an explicit direction.
 * `before` (the rows of the paragraph already out) and `open` (more of it to come) as in orderRows; returns its result.
 */
// How many finished rows of a streamed paragraph may wait for the letter that decides how their ends look (earlyPara).
const HOLD_ROWS = 6;

function visualRows(lrows, dir, cw, before, open) {
  return orderRows(lrows, { dir, width: cw, align: dir === "rtl" ? "end" : "start", before, open });
}

// ---------------------------------------------------------------------------------------------
// Engine

/**
 * The incremental renderer behind renderMarkdown() and createMarkdownStream().
 *   line(raw)     -> one complete source line in, finished lines out
 *   partial(raw)  -> the unfinished last line: { lines (rows that are final already), tail (what is still pending) }
 *   finish(raw)   -> flush: `raw` is the unfinished last line (or ""), then close every open block
 *   reset()
 */
export function createEngine({ getWidth, indent = "", dir = "auto" }) {
  const gutter = indent;
  const gutterW = stringWidth(indent);
  const forced = dir === "ltr" || dir === "rtl" ? dir : null;

  let started, pendingBlank, prevKind, list, mode, fence, tbl, held, pl, sink;
  reset();

  function reset() {
    started = false; pendingBlank = false; prevKind = null; list = []; mode = "base";
    fence = null; tbl = null; held = null; pl = null; sink = null;
  }

  const width = () => {
    const w = Math.floor(Number(getWidth()));
    return Math.max(10, Math.min((Number.isFinite(w) ? w : 80) - gutterW, MAX_W));
  };
  const emit = row => { sink.push(row === "" ? "" : gutter + row); };
  const hline = n => sym.hline.repeat(Math.max(0, n));

  // ---- spacing -------------------------------------------------------------------------------
  function wantBlank(kind, nested, fresh) {
    if (!started) return false;
    const p = prevKind;
    if (kind === "list" && p === "list") return fresh === true && pendingBlank;
    if (kind === "head" || kind === "table" || kind === "hr") return true;
    if (kind === "code") return nested ? pendingBlank || p === "code" || p === "table" : true;
    if (p === "code" || p === "table" || p === "hr") return true;
    if (p === "list" && kind !== "list") return true;
    if ((p === "quote") !== (kind === "quote")) return true;
    return pendingBlank;
  }
  function begin(kind, nested, fresh) {
    if (wantBlank(kind, nested, fresh)) sink.push("");
    started = true;
    pendingBlank = false;
    prevKind = kind;
  }

  // ---- row builders (pure) -------------------------------------------------------------------
  function textRows(text, base, cw, firstIndent, indentStr) {
    const P = parseInline(text, { final: true });
    // Emphasis inside italic text (a quote) is set upright, the typographer's rule: italic in italic would not show.
    const runs = base & ITALIC ? P.runs.map(r => ({ t: r.t, f: r.f ^ ITALIC })) : P.runs;
    const logical = paintRuns(runs, base & ~ITALIC);
    if (logical === "") return [firstIndent.replace(/\s+$/, "")];
    return layoutParagraph(logical, cw, { dir: lineDirection(text, forced, true), align: "auto", firstIndent, indent: indentStr });
  }

  // Four looks, each made only of what every terminal draws (bold, colour, a rule): H1 bold accent over a rule, H2 bold
  // accent, H3 bold, H4-H6 bold dim. Without colour H2 takes the rule too, so it still stands apart from the text.
  function headingRows(level, text, cw) {
    const base = level <= 2 ? BOLD | ACCENT : level === 3 ? BOLD : BOLD | DIM;
    const rows = textRows(text, base, cw, "", "");
    if (level <= 2 && (level === 1 || !colorLevel()) && text.trim() !== "") {
      const ruleW = Math.min(cw, Math.max(3, ...rows.map(r => stringWidth(r.trimStart()))));
      const d = lineDirection(text, forced, true);
      rows.push((d === "rtl" ? " ".repeat(cw - ruleW) : "") + c.gray(hline(ruleW)));
    }
    return rows;
  }

  function planItem(ind, marker, rest) {
    const stack = list.slice();
    while (stack.length && stack[stack.length - 1].ind > ind) stack.pop();
    if (stack.length && stack[stack.length - 1].ind === ind) stack.pop();
    const markerCol = stack.length ? stack[stack.length - 1].content : 0;
    const depth = stack.length;
    const ordered = marker[0] >= "0" && marker[0] <= "9";
    let text = rest || "";
    let box = null;
    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(text);
    if (task) { box = task[1] === " " ? c.dim(sym.checkbox) : c.green(sym.checked); text = text.slice(task[0].length); }
    let label;
    if (ordered) label = c.dim(marker) + (box ? " " + box : "");
    else label = box || c.dim(glyphs.bullets[depth % glyphs.bullets.length]);
    const content = markerCol + stringWidth(label) + 1;
    const kind = ordered ? "1" : marker;
    stack.push({ ind, content, kind });
    // An item that changes the kind of the top-level list (bullet <-> number, "-" <-> "*") starts a new list.
    const fresh = depth === 0 && list.length > 0 && list[0].kind !== kind;
    return { stack, markerCol, label, content, text, fresh };
  }

  function itemRows(plan, cw) {
    const first = " ".repeat(plan.markerCol) + plan.label + " ";
    return textRows(plan.text.trim(), 0, cw, first, " ".repeat(plan.content));
  }

  function quoteRows(depth, text, cw) {
    const bar = (c.accentSoft(sym.quote) + " ").repeat(depth);
    return textRows(text.trim(), textEffects() ? DIM | ITALIC : DIM, cw, bar, bar);
  }

  function codeRows(tokens, cw, pad) {
    const bar = c.gray(sym.quote);
    const avail = Math.max(4, cw - pad - 2);
    const plain = tokens.map(x => x[1]).join("");
    let rows;
    if (plain === "") return [" ".repeat(pad) + bar];
    if (stringWidth(plain) <= avail) rows = [tokens];
    else rows = wrapTokens(tokens, avail, Math.max(2, avail - 2), stringWidth);
    return rows.map((r, i) => " ".repeat(pad) + bar + " " + (i ? c.gray(glyphs.cont) + " " : "") + toVisual(paintTokens(r), { dir: "ltr" }));
  }

  // ---- tables --------------------------------------------------------------------------------
  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const split = codeAware => {
      const cells = [];
      let cur = "", open = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
        if (ch === "`" && codeAware) {
          let r = i;
          while (s[r] === "`") r++;
          const n = r - i;
          if (open === 0) open = n; else if (open === n) open = 0;
          cur += s.slice(i, r);
          i = r - 1;
          continue;
        }
        if (ch === "|" && open === 0) { cells.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      cells.push(cur.trim());
      return { cells, open };
    };
    const first = split(true);
    return first.open === 0 ? first.cells : split(false).cells;
  }

  function parseDelimiter(line) {
    if (line.indexOf("|") === -1 || !DELIM_ROW.test(line)) return null;
    return splitRow(line).map(x => (x.startsWith(":") && x.endsWith(":") ? "center" : x.endsWith(":") ? "right" : x.startsWith(":") ? "left" : null));
  }

  const isTableRow = l => l.trim() !== "" && l.indexOf("|") !== -1 && ["text", "tablecand"].includes(analyze(l).k);

  function stackedRows(headers, rows, cw) {
    const out = [];
    rows.forEach((row, ri) => {
      if (ri) out.push("");
      headers.forEach((h, ci) => {
        const v = row[ci] || "";
        if (v === "") return;
        const hl = paintRuns(parseInline(h, { final: true }).runs, BOLD);
        const vl = paintRuns(parseInline(v, { final: true, br: " " }).runs, 0);
        const d = lineDirection(v + " " + h, forced, true);
        out.push(...layoutParagraph(hl + ": " + vl, cw, { dir: d, align: "auto", firstIndent: "", indent: "  " }));
      });
    });
    return out;
  }

  function tableRows(header, aligns, body, cw) {
    const ncol = header.length;
    const norm = r => { const x = r.slice(0, ncol); while (x.length < ncol) x.push(""); return x; };
    const all = [norm(header), ...body.map(norm)];
    const cells = all.map((row, ri) => row.map(txt => {
      const logical = paintRuns(parseInline(txt, { final: true, br: "\n" }).runs, ri === 0 ? BOLD : 0);
      return { logical, lines: logical.split("\n"), dir: lineDirection(txt, forced, true), has: /\p{L}/u.test(txt) };
    }));
    let rtlN = 0, ltrN = 0;
    for (const row of cells) for (const cell of row) if (cell.has) { if (cell.dir === "rtl") rtlN++; else ltrN++; }
    const mirrored = forced ? forced === "rtl" : rtlN > ltrN;
    const natural = new Array(ncol).fill(1);
    const longest = new Array(ncol).fill(1);
    for (const row of cells) {
      row.forEach((cell, ci) => {
        for (const ln of cell.lines) {
          natural[ci] = Math.max(natural[ci], stringWidth(ln));
          for (const w of stripAnsi(ln).split(/\s+/)) longest[ci] = Math.max(longest[ci], stringWidth(w));
        }
      });
    }
    const border = 3 * ncol + 1;
    const avail = cw - border;
    const widths = natural.slice();
    let sum = widths.reduce((a, b) => a + b, 0);
    if (sum > avail) {
      const floors = natural.map((n, ci) => Math.min(n, Math.max(6, Math.min(longest[ci], 24))));
      if (floors.reduce((a, b) => a + b, 0) > avail) return null;
      while (sum > avail) {
        let pick = -1;
        for (let ci = 0; ci < ncol; ci++) if (widths[ci] > floors[ci] && (pick < 0 || widths[ci] > widths[pick])) pick = ci;
        widths[pick]--;
        sum--;
      }
    }
    const tw = sum + border;
    const b = glyphs.box;
    const order = [...widths.keys()];
    if (mirrored) order.reverse();
    const bar = x => c.gray(x);
    const rule = (l, m, r) => bar(l + order.map(ci => b.h.repeat(widths[ci] + 2)).join(m) + r);
    const lead = mirrored && tw < cw ? " ".repeat(cw - tw) : "";
    const visual = all.map((_, ri) => {
      const laid = cells[ri].map((cell, ci) => {
        const rows = [];
        for (const ln of cell.lines) rows.push(...layoutParagraph(ln, widths[ci], { dir: cell.dir, align: "start" }));
        return rows;
      });
      const h = Math.max(1, ...laid.map(r => r.length));
      const lines = [];
      for (let k = 0; k < h; k++) {
        let line = "";
        for (const ci of order) {
          const cell = cells[ri][ci];
          const text = laid[ci][k] || "";
          const gap = Math.max(0, widths[ci] - stringWidth(text));
          const al = aligns[ci] || (cell.dir === "rtl" || mirrored ? "right" : "left");
          const left = al === "right" ? gap : al === "center" ? gap >> 1 : 0;
          line += bar(b.v) + " " + " ".repeat(left) + text + " ".repeat(gap - left) + " ";
        }
        lines.push(line + bar(b.v));
      }
      return lines;
    });
    const multi = visual.slice(1).some(l => l.length > 1);
    const out = [rule(b.tl, b.tt, b.tr), ...visual[0], rule(b.lt, b.x, b.rt)];
    visual.slice(1).forEach((lines, i) => {
      if (multi && i) out.push(rule(b.lt, b.x, b.rt));
      out.push(...lines);
    });
    out.push(rule(b.bl, b.bt, b.br));
    return out.map(l => lead + l);
  }

  function renderTable(t, cw) {
    return tableRows(t.header, t.aligns, t.rows, cw) || stackedRows(t.header, t.rows.map(r => r.slice(0, t.header.length)), cw);
  }

  // ---- classification (reads state, changes none) --------------------------------------------
  function analyze(line) {
    if (line.trim() === "") return { k: "blank" };
    const ind = /^ */.exec(line)[0].length;
    const body = line.slice(ind);
    let m;
    if (ind <= (list.length ? 99 : 3) && (m = FENCE.exec(body)) && !(m[1][0] === "`" && m[2].indexOf("`") !== -1)) {
      return { k: "fence", ind, ch: m[1][0], len: m[1].length, info: m[2].trim() };
    }
    if (ind <= 3 && (m = HEADING.exec(body))) {
      return { k: "head", level: m[1].length, text: (m[2] || "").replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+$/, "") };
    }
    if (ind <= 3 && HRULE.test(body)) return { k: "hr" };
    if (ind <= 3 && body[0] === ">") {
      let depth = 0, rest = body;
      for (let mm; (mm = /^ {0,3}>[ ]?/.exec(rest));) { depth++; rest = rest.slice(mm[0].length); }
      return { k: "quote", depth, text: rest };
    }
    if ((m = ITEM.exec(body))) return { k: "item", ind, marker: m[1], rest: m[2] || "" };
    if ((ind <= 3 || list.length > 0) && body[0] === "|") return { k: "tablecand", ind, text: line };
    return { k: "text", ind, text: body.trim() };
  }

  // ---- committing ----------------------------------------------------------------------------
  function commitText(d) {
    const cw = width();
    if (list.length && d.ind > 0) {
      begin("list");
      const pad = " ".repeat(list[list.length - 1].content);
      for (const r of textRows(d.text, 0, cw, pad, pad)) emit(r);
      return;
    }
    list = [];
    if (pl && pl.begun) {
      // Rows of this line are already out: lay out only what is left of it, at the width in force now.
      const rest = paintRuns(pl.runs.concat(parseInline(d.text, { final: true, from: pl.at }).runs), 0);
      if (rest !== "") for (const r of layoutParagraph(rest, cw, { dir: pl.dir, align: "auto", before: pl.before })) emit(r);
      return;
    }
    begin("para");
    for (const r of textRows(d.text, 0, cw, "", "")) emit(r);
  }

  function flushTable() {
    const rows = renderTable(tbl, width());
    begin("table");
    for (const r of rows) emit(r);
    tbl = null;
    mode = "base";
  }

  // A closing fence may sit up to three columns deeper than its opener (a fence inside a list item).
  function closesFence(line) {
    const m = /^( *)(`{3,}|~{3,})[ \t]*$/.exec(line);
    return !!m && m[1].length <= fence.ind + 3 && m[2][0] === fence.ch && m[2].length >= fence.len;
  }

  function fenceLine(line) {
    if (closesFence(line)) {
      mode = "base";
      fence = null;
      return;
    }
    const lead = /^ */.exec(line)[0].length;
    const code = line.slice(Math.min(fence.ind, lead));
    if (!fence.begun) { fence.begun = true; begin("code", fence.pad > 0); }
    for (const r of codeRows(fence.hl.tokens(code), width(), fence.pad)) emit(r);
  }

  function handle(d, line) {
    const cw = width();
    switch (d.k) {
      case "blank":
        if (started) pendingBlank = true;
        return;
      case "fence": {
        const nested = list.length > 0 && d.ind > 0;
        const pad = nested ? list[list.length - 1].content : 0;
        if (!nested) list = [];
        const lang = d.info.replace(/^\{\s*/, "").replace(/^\./, "").split(/[\s{},;]/)[0];
        fence = { ch: d.ch, len: d.len, ind: d.ind, pad, hl: createLineHighlighter(lang), begun: false };
        mode = "fence";
        if (lang) {
          fence.begun = true;
          begin("code", nested);
          emit(" ".repeat(pad) + c.gray(sym.quote) + " " + c.dim(lang));
        }
        return;
      }
      case "head":
        list = [];
        if (d.text.trim() === "") return;
        begin("head");
        for (const r of headingRows(d.level, d.text.trim(), cw)) emit(r);
        return;
      case "hr":
        list = [];
        begin("hr");
        emit(c.gray(hline(cw)));
        return;
      case "quote":
        list = [];
        begin("quote");
        for (const r of quoteRows(d.depth, d.text, cw)) emit(r);
        return;
      case "item": {
        const plan = planItem(d.ind, d.marker, d.rest);
        list = plan.stack;
        begin("list", false, plan.fresh);
        for (const r of itemRows(plan, cw)) emit(r);
        return;
      }
      case "tablecand":
        held = line;
        return;
      default:
        commitText(d);
    }
  }

  function consume(line) {
    if (mode === "fence") { fenceLine(line); return; }
    if (mode === "table") {
      if (isTableRow(line)) { tbl.rows.push(splitRow(line)); tbl.raw.push(line); return; }
      flushTable();
    }
    if (held !== null) {
      const h = held;
      held = null;
      const aligns = parseDelimiter(line);
      if (aligns) {
        list = [];
        const header = splitRow(h);
        const al = aligns.slice(0, header.length);
        while (al.length < header.length) al.push(null);
        tbl = { header, aligns: al, rows: [], raw: [h, line] };
        mode = "table";
        return;
      }
      commitText({ ind: 0, text: h.trim() });
    }
    handle(analyze(line), line);
  }

  // ---- public ----------------------------------------------------------------------------------
  function run(fn) {
    sink = [];
    try { fn(); return sink; } finally { sink = null; }
  }

  function line(raw) {
    return run(() => { consume(cleanText(raw)); pl = null; });
  }

  function finish(raw) {
    return run(() => {
      if (raw !== "") consume(cleanText(raw));
      if (mode === "fence") { mode = "base"; fence = null; }
      if (mode === "table") flushTable();
      if (held !== null) { const h = held; held = null; commitText({ ind: 0, text: h.trim() }); }
      pl = null;
      pendingBlank = false;
    });
  }

  // ---- partial line ----------------------------------------------------------------------------
  const clip = (text, cw) => {
    const row = wrapTokens([["p", text]], cw, cw, stringWidth)[0] || [];
    return row.map(x => x[1]).join("");
  };
  // A table row still being typed, shown as its dim source, cut to the width. It is shaped and its Arabic put in reading
  // order (an LTR line, like code): the cut measured the joined letters, and unjoined ones would be wider on screen.
  const rawRow = (text, cw) => c.dim(toVisual(clip(text.trim(), cw), { dir: "ltr" }));

  function rowStarts(plain, lrows) {
    const starts = [];
    let pos = 0;
    for (const row of lrows) {
      const t = stripAnsi(row).replace(ISOLATES, "");
      // The blanks a line break swallowed are in no row. Skip as many as it takes for the row to match: the row itself
      // may start with a blank the break could not reach (one inside an isolate, such as a code span's own space).
      while (pos < plain.length && plain[pos] === " " && (t === "" || !plain.startsWith(t, pos))) pos++;
      starts.push(pos);
      pos += t.length;
    }
    return starts;
  }

  // Early release of the finished rows of a growing paragraph line. Returns the visual rows still pending.
  // `pl` keeps the part of the line that can no longer change (pl.runs, from the start of the last released row up to
  // source offset pl.at), so each call parses and lays out only what has arrived since.
  // A row is final when the word after it cannot fit on it, and only the stable part may be used to decide that: text
  // glued to the last stable word (an unclosed ` or [ in the middle of a word) may still change that word's width.
  // The end of a row takes its direction from the first strong letter after it (see orderRows), so a row is out for good
  // only once that letter is in the stable text; pl.before carries what the rows already out leave to the next one.
  // At most HOLD_ROWS finished rows wait for that letter: rows with no letter at all (a long run of arrows, emoji or
  // a bare link) would otherwise be held, and wrapped and ordered again on every push, until the line ended. The oldest
  // is then let out with its end in the paragraph's direction, the only place the stream can differ from the final
  // render, and only for such rows.
  function earlyPara(text, cw) {
    if (!pl) pl = { at: 0, runs: [], dir: null, begun: false, before: undefined };
    if (pl.dir === null) pl.dir = lineDirection(text, forced, false);
    const P = parseInline(text, { final: false, from: pl.at });
    let region = pl.runs.concat(cutRuns(P.runs, 0, P.stableR));
    const pending = cutRuns(P.runs, P.stableR, Infinity);
    const dir = pl.dir || lineDirection(text, forced, true);
    pl.at = P.stable;
    let rows = null;
    const release = (ordered, starts, last) => {
      if (!pl.begun) { begin("para"); pl.begun = true; }
      for (let j = 0; j < last; j++) emit(ordered.lines[j]);
      pl.before = ordered.context[last];
      region = cutRuns(region, starts[last], Infinity);
    };
    if (pl.dir !== null && region.length) {
      const trimmed = trimEndRuns(region.map(r => ({ t: r.t, f: r.f })));
      const regionLen = trimmed.reduce((n, r) => n + r.t.length, 0);
      if (pending.length === 0 || /\s$/.test(region[region.length - 1].t)) {
        // The pending text starts a new word: one wrap of everything decides which rows are final and shows the rest.
        const all = region.concat(pending);
        const lrows = wrapLogical(paintRuns(all, 0), cw, {});
        const vrows = visualRows(lrows, dir, cw, pl.before);
        const starts = rowStarts(all.map(r => r.t).join(""), lrows);
        // A plain word can only get wider, so a row it did not fit on is final even while the word is unfinished;
        // one that holds markup characters may shrink (a ** pair, an entity), so then only the stable text counts.
        const word = pending.length ? pending.map(r => r.t).join("").split(/\s/, 1)[0] : "";
        const wordStart = all.reduce((n, r, i) => (i < region.length ? n + r.t.length : n), 0);
        const plainWord = word !== "" && !/[\\&*_~`[<!]/.test(word);
        let ready = 0;
        while (ready + 1 < starts.length && (plainWord ? starts[ready + 1] <= wordStart : starts[ready + 1] < regionLen)) ready++;
        // Those rows hold stable text only, and the stable text wrapped on its own gives the same rows.
        let last = ready, from = vrows;
        if (last > 0) {
          const stable = visualRows(wrapLogical(paintRuns(trimmed, 0), cw, {}), dir, cw, pl.before, true);
          last = Math.min(ready, stable.settled);
          // More than HOLD_ROWS rows wait for that letter: the oldest go out as the stable text alone orders them, their
          // ends in the paragraph's direction. Not as the text still arriving orders them: a link being typed is plain
          // letters now and one neutral isolate once it is complete.
          if (ready - HOLD_ROWS > last) { last = ready - HOLD_ROWS; from = stable; }
        }
        if (last > 0) release(from, starts, last);
        rows = vrows.lines.slice(last);
      } else {
        const lrows = wrapLogical(paintRuns(trimmed, 0), cw, {});
        if (lrows.length >= 2) {
          const ordered = visualRows(lrows, dir, cw, pl.before, true);
          const last = Math.max(Math.min(lrows.length - 1, ordered.settled), lrows.length - 1 - HOLD_ROWS);
          if (last > 0) release(ordered, rowStarts(trimmed.map(r => r.t).join(""), lrows), last);
        }
      }
    }
    pl.runs = region;
    if (rows === null) {
      const tail = paintRuns(region.concat(pending), 0);
      rows = tail === "" ? [] : visualRows(wrapLogical(tail, cw, {}), dir, cw, pl.before).lines;
    }
    // The blank line that will precede the paragraph is part of what is pending until its first row is released.
    if (rows.length && !pl.begun && wantBlank("para", false)) rows = ["", ...rows];
    return rows;
  }

  function tentative(text, cw) {
    const d = analyze(text);
    const rows = [];
    const lead = kind => { if (wantBlank(kind, false)) rows.push(""); };
    switch (d.k) {
      case "blank": case "fence": return [];
      case "head":
        lead("head");
        if (d.text.trim() !== "") rows.push(...headingRows(d.level, d.text.trim(), cw));
        return rows;
      case "hr": lead("hr"); rows.push(c.gray(hline(cw))); return rows;
      case "quote": lead("quote"); rows.push(...quoteRows(d.depth, d.text, cw)); return rows;
      case "item": {
        const plan = planItem(d.ind, d.marker, d.rest);
        if (wantBlank("list", false, plan.fresh)) rows.push("");
        rows.push(...itemRows(plan, cw));
        return rows;
      }
      case "tablecand": return [rawRow(text, cw)];
      default:
        if (list.length && d.ind > 0) {
          lead("list");
          const pad = " ".repeat(list[list.length - 1].content);
          rows.push(...textRows(d.text, 0, cw, pad, pad));
        } else {
          lead("para");
          rows.push(...textRows(d.text, 0, cw, "", ""));
        }
        return rows;
    }
  }

  function partial(raw) {
    let text = cleanText(raw);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    const cw = width();
    let tail = [];
    const lines = run(() => {
      if (mode === "fence") {
        // A line that is just backticks or tildes is most likely the closing fence being typed: show nothing yet.
        const closing = /^( *)(`+|~+)[ \t]*$/.exec(text);
        if (text.trim() !== "" && !(closing && closing[1].length <= fence.ind + 3 && closing[2][0] === fence.ch)) {
          const lead = /^ */.exec(text)[0].length;
          const code = text.slice(Math.min(fence.ind, lead));
          const rows = codeRows(fence.hl.tokens(code, true), cw, fence.pad);
          tail = !fence.begun && wantBlank("code", fence.pad > 0) ? ["", ...rows] : rows;
        }
      } else if (mode === "table") {
        tail = [...tbl.raw.slice(-3), text].filter(x => x.trim() !== "").map(x => rawRow(x, cw));
      } else {
        if (held !== null) tail.push(rawRow(held, cw));
        if (text.trim() !== "") {
          if (held === null && isPlainStart(text)) tail.push(...earlyPara(text, cw));
          else tail.push(...tentative(text, cw));
        }
      }
    });
    return { lines, tail: tail.map(r => (r === "" ? "" : gutter + r)).join("\n") };
  }

  return { line, partial, finish, reset };
}

/**
 * Renders a whole markdown document to visual lines.
 * o: { width = 80, dir = "auto" | "ltr" | "rtl", indent = "" } (indent = gutter prefixed to every non-empty line).
 */
export function renderMarkdown(md, o) {
  const width = (o && o.width) || 80;
  const engine = createEngine({ getWidth: () => width, indent: (o && o.indent) || "", dir: (o && o.dir) || "auto" });
  const { lines, rest } = splitLines(String(md ?? ""));
  const out = [];
  for (const l of lines) out.push(...engine.line(l));
  out.push(...engine.finish(rest));
  return out;
}
