// The text engine behind Edit and MultiEdit. Matching happens on a line-feed-only view of the file, and the
// result is spliced back into the ORIGINAL text, so files with CRLF (or a mix) keep every untouched byte.
import { toLf, countLines, dice } from "./textfile.js";

const err = (code, message) => ({ ok: false, code, message });

/** LF view of `raw` plus the positions (in that view) of the line breaks that were CRLF. */
export function prepareText(raw) {
  const crAt = [];
  let lf = "";
  let last = 0;
  let i = raw.indexOf("\r\n");
  while (i !== -1) {
    lf += raw.slice(last, i);
    crAt.push(lf.length);
    last = i + 1;
    i = raw.indexOf("\r\n", last + 1);
  }
  lf += raw.slice(last);
  const newlines = [];
  for (let k = lf.indexOf("\n"); k !== -1; k = lf.indexOf("\n", k + 1)) newlines.push(k);
  const crlf = crAt.length;
  const dominant = crlf > 0 && crlf >= newlines.length - crlf ? "\r\n" : "\n";
  const countBefore = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
  return {
    lf, dominant,
    toRaw: index => index + countBefore(crAt, index),
    lineOf: index => 1 + countBefore(newlines, index),
  };
}

const clipText = (s, n = 160) => (s.length > n ? s.slice(0, n) + "…" : s);
const normalizeChars = s => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, " ");
const squash = s => normalizeChars(s).replace(/\s+/g, " ").trim();

function missMessage(lf, old) {
  const head = "old_string was not found in the file.";
  const oldLines = old.split("\n");
  const prefixed = oldLines.filter(l => l.trim()).length > 0 && oldLines.filter(l => l.trim()).every(l => /^\s*\d+(\t|→)/.test(l));
  if (prefixed) {
    const stripped = oldLines.map(l => l.replace(/^\s*\d+(\t|→)/, "")).join("\n");
    if (lf.includes(stripped)) return `${head} It looks like you copied the line-number prefixes from the Read output. Remove the "number then tab" at the start of every line; they are not part of the file.`;
  }
  const fileLines = lf.split("\n");
  const wanted = oldLines.map(squash);
  while (wanted.length && wanted[0] === "") wanted.shift();
  while (wanted.length && wanted[wanted.length - 1] === "") wanted.pop();
  if (wanted.length === 1 && wanted[0]) {
    const at = fileLines.findIndex(l => squash(l).includes(wanted[0]));
    if (at !== -1) {
      return `${head} The same text exists at line ${at + 1} but differs in whitespace, indentation or quote characters. The file has: ${JSON.stringify(clipText(fileLines[at]))}. Copy the text exactly from the Read output.`;
    }
  } else if (wanted.length > 1) {
    const keys = fileLines.map(squash);
    for (let i = 0; i + wanted.length <= keys.length; i++) {
      let all = true;
      for (let j = 0; j < wanted.length; j++) if (keys[i + j] !== wanted[j]) { all = false; break; }
      if (all) {
        const show = fileLines.slice(i, i + Math.min(wanted.length, 4)).map(l => JSON.stringify(clipText(l, 120))).join(", ");
        return `${head} The same lines exist at line ${i + 1} but differ in whitespace, indentation or quote characters. The file has: ${show}${wanted.length > 4 ? ", ..." : ""}. Copy them exactly from the Read output.`;
      }
    }
  }
  const anchor = wanted.slice().sort((a, b) => b.length - a.length)[0] || "";
  if (anchor.length >= 6) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < fileLines.length; i++) {
      const score = dice(squash(fileLines[i]), anchor);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best !== -1 && bestScore >= 0.6) {
      return `${head} The closest line in the file is line ${best + 1} (${Math.round(bestScore * 100)}% similar): ${JSON.stringify(clipText(fileLines[best]))}. Read the file again and copy the exact text.`;
    }
  }
  return `${head} Nothing similar was found; the file may have changed or you may be thinking of another file. Read it again and copy the exact text.`;
}

/**
 * Applies one replacement to `raw` (the decoded file text, native line endings).
 * edit: { old_string, new_string, replace_all? }
 * opts.readRanges: when set, every match must lie inside these 1-based inclusive line ranges.
 * Returns { ok:true, raw, count, startLine, oldEndLine, newEndLine, delta } or { ok:false, code, message }.
 */
export function applyEdit(raw, edit, { readRanges = null } = {}) {
  if (typeof edit?.old_string !== "string" || typeof edit?.new_string !== "string") return err("invalidInput", "old_string and new_string must both be strings.");
  const old = toLf(edit.old_string);
  const neu = toLf(edit.new_string);
  if (old === "") return err("emptyOld", "old_string must not be empty. To create a file use Write; to insert text, put some neighbouring text in old_string and repeat it in new_string.");
  if (old === neu) return err("sameString", "old_string and new_string are identical, so nothing would change.");

  const prep = prepareText(raw);
  const hits = [];
  for (let i = prep.lf.indexOf(old); i !== -1; i = prep.lf.indexOf(old, i + old.length)) hits.push(i);
  if (hits.length === 0) return err("noMatch", missMessage(prep.lf, old));
  if (hits.length > 1 && !edit.replace_all) {
    const lines = hits.slice(0, 6).map(h => prep.lineOf(h)).join(", ");
    return err("multiMatch", `old_string matches ${hits.length} places in the file (lines ${lines}${hits.length > 6 ? ", ..." : ""}). Include more surrounding lines so it identifies exactly one place, or set replace_all to true to change every occurrence.`);
  }
  if (readRanges) {
    const outside = hits.find(h => !readRanges.some(r => r[0] <= prep.lineOf(h) && r[1] >= prep.lineOf(h + old.length - 1)));
    if (outside !== undefined) {
      const seen = readRanges.length ? readRanges.map(r => `${r[0]}-${r[1]}`).join(", ") : "none";
      return err("unread", `The text is at line ${prep.lineOf(outside)}, which you have not read (you read lines ${seen}). Read that part of the file first.`);
    }
  }

  let out = raw;
  for (const hit of hits.slice().reverse()) {
    const start = hit;
    let end = hit + old.length;
    // Deleting whole lines should not leave an empty line behind.
    if (neu === "" && (start === 0 || prep.lf[start - 1] === "\n") && prep.lf[end] === "\n") end += 1;
    const rawStart = prep.toRaw(start);
    const rawEnd = prep.toRaw(end);
    const region = raw.slice(rawStart, rawEnd);
    const eol = region.includes("\r\n") ? "\r\n" : region.includes("\n") ? "\n" : prep.dominant;
    out = out.slice(0, rawStart) + (eol === "\r\n" ? neu.replace(/\n/g, "\r\n") : neu) + out.slice(rawEnd);
  }

  const first = hits[0];
  const startLine = prep.lineOf(first);
  const oldEndLine = prep.lineOf(first + old.length - 1);
  const newEndLine = neu === "" ? startLine - 1 : startLine + (neu.replace(/\n$/, "").split("\n").length - 1);
  return { ok: true, raw: out, count: hits.length, startLine, oldEndLine, newEndLine, delta: countLines(out) - countLines(raw) };
}

/** Moves the "already seen" line ranges across an edit that replaced old lines [start, oldEnd] with [start, newEnd]. */
export function shiftRanges(ranges, { startLine, oldEndLine, newEndLine, delta }) {
  const out = [];
  for (const [a, b] of ranges) {
    if (b < startLine) { out.push([a, b]); continue; }
    if (a > oldEndLine) { out.push([a + delta, b + delta]); continue; }
    if (a < startLine) out.push([a, startLine - 1]);
    out.push([startLine, newEndLine]);
    if (b > oldEndLine) out.push([oldEndLine + 1 + delta, b + delta]);
  }
  return out;
}

const WINDOW_AFTER = 600;

/**
 * The Diff object for display: whole texts for ordinary files, a window around the change (with startLine)
 * for big ones so a permission prompt never has to carry megabytes.
 */
export function makeDiff(displayName, oldRaw, newRaw) {
  const oldText = oldRaw === null ? null : toLf(oldRaw);
  const newText = toLf(newRaw);
  if (oldText === null) return { path: displayName, oldText, newText };
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length <= WINDOW_AFTER && b.length <= WINDOW_AFTER) return { path: displayName, oldText, newText };
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const from = Math.max(0, head - 6);
  const slice = (lines, end) => lines.slice(from, Math.min(lines.length, end + 6)).join("\n");
  return { path: displayName, oldText: slice(a, a.length - tail), newText: slice(b, b.length - tail), startLine: from + 1 };
}

/** cat -n style snippet of `lf` around [from, to] (1-based), at most `max` lines. */
export function snippetAround(lf, from, to, pad = 3, max = 30) {
  const lines = lf.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const begin = Math.max(1, from - pad);
  const end = Math.min(lines.length, Math.max(to, from) + pad, begin + max - 1);
  const rows = [];
  for (let n = begin; n <= end; n++) rows.push(`${String(n).padStart(6)}\t${lines[n - 1].replace(/\r$/, "").slice(0, 300)}`);
  return rows.join("\n");
}
