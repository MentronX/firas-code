// Unified-diff rendering for tool cards and permission previews.
//
// Decisions:
//  - One line-number column: removed rows show the OLD number, added and unchanged rows the NEW one. The marker column
//    carries "+" / "-" so the diff reads without colour.
//  - Lines are compared with Myers' O(ND) algorithm after trimming the common head and tail; when the edit distance is
//    beyond MAX_D (huge rewrites) the middle is shown coarsely as "all removed, then all added".
//  - An unchanged run is folded when more than one line would be hidden, so a fold marker never replaces a single line.
//  - Inside a removed/added pair of equal length the changed middle gets a brighter background (word boundaries
//    respected); pairs that share almost nothing are left as plain row colour.
//  - maxLines counts body rows (wrapped rows included, header and footer not). The footer reports the lines left out;
//    a fold counts as the unchanged lines it hides.
//  - File text is untrusted: escape sequences and control characters are stripped, tabs become 4 spaces, CRLF is
//    normalised. Code is always left-to-right and left-aligned; an Arabic string or comment inside a line is joined and
//    its own run put in reading order (toVisual with an LTR base), the code around it never moves.
import { c, bg, PALETTE, colorLevel, hasUnicode } from "./theme.js";
import { registerStrings, t } from "../i18n/index.js";
import { stripAnsi, stringWidth, toVisual } from "../text/display.js";
import { wrapTokens } from "./highlight.js";

registerStrings("diff", {
  ar: {
    noChanges: "لا توجد تغييرات",
    newFile: "ملف جديد",
    same1: "سطر واحد دون تغيير",
    same2: "سطران دون تغيير",
    sameFew: "{n} أسطر دون تغيير",
    sameMany: "{n} سطرًا دون تغيير",
    more1: "سطر آخر",
    more2: "سطران آخران",
    moreFew: "{n} أسطر أخرى",
    moreMany: "{n} سطرًا آخر",
  },
  en: {
    noChanges: "No changes",
    newFile: "new file",
    same1: "1 unchanged line",
    same2: "{n} unchanged lines",
    sameFew: "{n} unchanged lines",
    sameMany: "{n} unchanged lines",
    more1: "+1 more line",
    more2: "+{n} more lines",
    moreFew: "+{n} more lines",
    moreMany: "+{n} more lines",
  },
});

const MAX_D = 1500;
const TAB = 4;

function plural(n) {
  return n === 1 ? "1" : n === 2 ? "2" : n <= 10 ? "Few" : "Many";
}

// ---------------------------------------------------------------------------------------------
// Text preparation

const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function cleanLine(line) {
  let s = line.indexOf("\x1b") === -1 ? line : stripAnsi(line);
  if (s.indexOf("\t") !== -1) {
    let out = "";
    for (const ch of s) out += ch === "\t" ? " ".repeat(TAB - (out.length % TAB)) : ch;
    s = out;
  }
  return s.replace(UNSAFE, "");
}

function splitLines(text) {
  if (text === null || text === undefined) return [];
  const s = String(text).replace(/\r\n?/g, "\n");
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Line diff

function myers(a, b, lo, hiA, hiB) {
  const n = hiA - lo, m = hiB - lo;
  const lim = Math.min(n + m, MAX_D);
  const o = lim + 1;
  let v = new Int32Array(2 * lim + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= lim && found < 0; d++) {
    trace.push(v.slice(o - d - 1, o + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[o + k - 1] < v[o + k + 1])) x = v[o + k + 1];
      else x = v[o + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[lo + x] === b[lo + y]) { x++; y++; }
      v[o + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const s = trace[d];
    const at = k => s[d + 1 + k];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(["=", lo + x - 1, lo + y - 1]); x--; y--; }
    if (x === prevX) { ops.push(["+", -1, lo + y - 1]); y--; }
    else { ops.push(["-", lo + x - 1, -1]); x--; }
  }
  while (x > 0 && y > 0) { ops.push(["=", lo + x - 1, lo + y - 1]); x--; y--; }
  return ops.reverse();
}

// Returns [kind, oldIndex, newIndex][] covering both texts line by line.
function diffLines(oldLines, newLines) {
  const ids = new Map();
  const id = s => { let k = ids.get(s); if (k === undefined) { k = ids.size; ids.set(s, k); } return k; };
  const a = oldLines.map(id), b = newLines.map(id);
  let head = 0;
  const minLen = Math.min(a.length, b.length);
  while (head < minLen && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < minLen - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops = [];
  for (let i = 0; i < head; i++) ops.push(["=", i, i]);
  const endA = a.length - tail, endB = b.length - tail;
  let mid = endA > head && endB > head ? myers(a, b, head, endA, endB) : null;
  if (mid === null) {
    // One side is empty, or the edit distance is beyond MAX_D: show the middle as removed, then added.
    mid = [];
    for (let i = head; i < endA; i++) mid.push(["-", i, -1]);
    for (let j = head; j < endB; j++) mid.push(["+", -1, j]);
  }
  for (const op of mid) ops.push(op);
  for (let i = 0; i < tail; i++) ops.push(["=", endA + i, endB + i]);
  return ops;
}

/** Number of added and removed lines between two texts (CRLF-safe; null = empty). */
export function diffStats(oldText, newText) {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let added = 0, removed = 0;
  for (const op of ops) { if (op[0] === "+") added++; else if (op[0] === "-") removed++; }
  return { added, removed };
}

// ---------------------------------------------------------------------------------------------
// Rendering

const isWord = ch => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

// Splits a removed/added pair into [text, changed] segments, or null when they share too little to be worth it.
function pairSegments(oldLine, newLine) {
  const max = Math.min(oldLine.length, newLine.length);
  let p = 0;
  while (p < max && oldLine[p] === newLine[p]) p++;
  let s = 0;
  while (s < max - p && oldLine[oldLine.length - 1 - s] === newLine[newLine.length - 1 - s]) s++;
  while (p > 0 && isWord(oldLine[p - 1]) && (isWord(oldLine[p]) || isWord(newLine[p]))) p--;
  while (s > 0 && isWord(oldLine[oldLine.length - s]) && isWord(oldLine[oldLine.length - s - 1])) s--;
  if (p + s < 0.3 * Math.max(oldLine.length, newLine.length)) return null;
  const build = line => {
    const out = [];
    if (p > 0) out.push([line.slice(0, p), false]);
    const mid = line.slice(p, line.length - s);
    if (mid !== "") out.push([mid, true]);
    if (s > 0) out.push([line.slice(line.length - s), false]);
    return out;
  };
  return [build(oldLine), build(newLine)];
}

const brighten = ([r, g, b]) => [Math.min(255, Math.round(r * 1.9 + 14)), Math.min(255, Math.round(g * 1.9 + 14)), Math.min(255, Math.round(b * 1.9 + 14))];
const hiAdd = bg(brighten(PALETTE.diffAdd), 42);
const hiDel = bg(brighten(PALETTE.diffDel), 41);

function paint(text, kind, changed, fg) {
  let s = text;
  if (fg) s = fg(s);
  if (kind === "+") s = changed ? (colorLevel() >= 2 ? hiAdd(s) : c.underline(s)) : c.bgAdd(s);
  else if (kind === "-") s = changed ? (colorLevel() >= 2 ? hiDel(s) : c.underline(s)) : c.bgDel(s);
  return s;
}

function note(text) {
  return toVisual(text, { dir: "ltr" });
}

/**
 * Renders a diff as styled lines.
 * diff = { path, oldText, newText } (oldText null = new file); o = { width = 80, context = 3, maxLines = 60 }.
 */
export function renderDiff(diff, o) {
  const width = Math.max(30, Math.floor((o && o.width) || 80));
  const context = Math.max(0, (o && o.context) ?? 3);
  const maxLines = Math.max(1, (o && o.maxLines) || 60);
  const isNew = diff.oldText === null || diff.oldText === undefined;
  const oldLines = splitLines(diff.oldText).map(cleanLine);
  const newLines = splitLines(diff.newText).map(cleanLine);
  const ops = diffLines(oldLines, newLines);
  let added = 0, removed = 0;
  for (const op of ops) { if (op[0] === "+") added++; else if (op[0] === "-") removed++; }

  const path = cleanLine(String(diff.path || ""));
  const counts = (added ? c.green(`+${added}`) : "") + (added && removed ? " " : "") + (removed ? c.red(`-${removed}`) : "");
  const head = [c.bold(note(path)) + (isNew ? "  " + c.dim(`(${t("diff.newFile")})`) : "") + (counts ? "  " + counts : "")];
  if (!added && !removed) return [...head, c.dim(note(t("diff.noChanges")))];

  // Which rows are shown: changes plus `context` unchanged rows around them; longer unchanged runs fold.
  const n = ops.length;
  const near = new Uint8Array(n);
  let last = -1e9;
  for (let i = 0; i < n; i++) { if (ops[i][0] !== "=") last = i; near[i] = i - last <= context ? 1 : 0; }
  last = 1e9;
  for (let i = n - 1; i >= 0; i--) { if (ops[i][0] !== "=") last = i; if (last - i <= context) near[i] = 1; }
  const rows = [];
  for (let i = 0; i < n;) {
    if (ops[i][0] !== "=" || near[i]) { rows.push({ op: ops[i] }); i++; continue; }
    let j = i;
    while (j < n && ops[j][0] === "=" && !near[j]) j++;
    if (j - i === 1) rows.push({ op: ops[i] });
    else rows.push({ fold: j - i });
    i = j;
  }

  // Intra-line highlights for removed/added pairs.
  const segs = new Map();
  for (let i = 0; i < rows.length;) {
    if (!rows[i].op || rows[i].op[0] !== "-") { i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].op && rows[j].op[0] === "-") j++;
    let k = j;
    while (k < rows.length && rows[k].op && rows[k].op[0] === "+") k++;
    if (j - i === k - j) {
      for (let q = 0; q < j - i; q++) {
        const pair = pairSegments(oldLines[rows[i + q].op[1]], newLines[rows[j + q].op[2]]);
        if (pair) { segs.set(rows[i + q], pair[0]); segs.set(rows[j + q], pair[1]); }
      }
    }
    i = Math.max(k, i + 1);
  }

  const maxNum = Math.max(oldLines.length, newLines.length);
  const numW = Math.max(2, String(maxNum).length);
  const gutterW = numW + 3;
  const contentW = Math.max(10, width - gutterW);
  const level = colorLevel();
  const out = [...head];
  let shown = 0;
  let consumed = 0;
  const blankNum = " ".repeat(numW);

  for (const row of rows) {
    if (shown >= maxLines) break;
    consumed++;
    if (row.fold) {
      const text = t("diff.same" + plural(row.fold), { n: row.fold });
      out.push(c.dim(blankNum + " " + note((hasUnicode ? "⋯ " : "... ") + text)));
      shown++;
      continue;
    }
    const [kind, oi, ni] = row.op;
    const text = kind === "-" ? oldLines[oi] : newLines[ni];
    const num = String(kind === "-" ? oi + 1 : ni + 1).padStart(numW);
    const parts = segs.get(row) || [[text, false]];
    const tokens = parts.map(([s, ch]) => [ch ? "h" : "n", s]);
    const wrapped = wrapTokens(tokens.length ? tokens : [["n", ""]], contentW, contentW, stringWidth);
    wrapped.forEach((tokRow, idx) => {
      if (shown >= maxLines) return;
      let body = "";
      let used = 0;
      for (const [cls, s] of tokRow) {
        body += paint(s, kind, cls === "h", kind === "=" ? c.dim : null);
        used += stringWidth(s);
      }
      body = toVisual(body, { dir: "ltr" });
      const marker = kind === "+" ? c.bold(c.green("+")) : kind === "-" ? c.bold(c.red("-")) : " ";
      const gut = idx === 0 ? c.gray(num) : blankNum;
      let line;
      if (kind === "=") {
        line = gut + "   " + body;
      } else {
        const mk = idx === 0 ? marker : " ";
        line = paint(gut + " ", kind, false) + paint(mk, kind, false) + paint(" ", kind, false) + body;
        if (level) line += paint(" ".repeat(Math.max(0, contentW - used)), kind, false);
      }
      out.push(line);
      shown++;
    });
  }

  if (rows.length > consumed) {
    const hidden = rows.slice(consumed).reduce((sum, r) => sum + (r.fold ? r.fold : 1), 0);
    const text = t("diff.more" + plural(hidden), { n: hidden });
    out.push(c.dim(blankNum + " " + note((hasUnicode ? "… " : "... ") + text)));
  }
  return out;
}
