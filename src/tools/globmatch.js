// A small glob engine (no dependencies): **, *, ?, [abc] / [!abc], {a,b} (nested), case-insensitive on request.
// Patterns are matched against forward-slash relative paths. A backslash in a pattern is treated as a
// path separator, because that is what people on Windows type.
import path from "node:path";

const MAGIC = /[*?[\]{}]/;

export const hasMagic = pattern => MAGIC.test(pattern);

export function normalizePattern(pattern) {
  let p = String(pattern).trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p.replace(/\/{2,}/g, "/");
}

/** Expands {a,b} groups (nested allowed). A brace group without a top-level comma is kept literally. */
export function expandBraces(pattern, limit = 256) {
  const out = [];
  const walk = text => {
    if (out.length >= limit) return;
    let depth = 0, open = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "{") { if (depth === 0) open = i; depth++; }
      else if (c === "}" && depth > 0) {
        depth--;
        if (depth === 0) {
          const inner = text.slice(open + 1, i);
          const parts = [];
          let d = 0, last = 0;
          for (let j = 0; j < inner.length; j++) {
            if (inner[j] === "{") d++;
            else if (inner[j] === "}") d--;
            else if (inner[j] === "," && d === 0) { parts.push(inner.slice(last, j)); last = j + 1; }
          }
          parts.push(inner.slice(last));
          if (parts.length > 1) {
            for (const part of parts) walk(text.slice(0, open) + part + text.slice(i + 1));
            return;
          }
        }
      }
    }
    out.push(text);
  };
  walk(pattern);
  return out;
}

const escapeRe = ch => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function segmentToRegex(seg) {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") { while (seg[i + 1] === "*") i++; re += "[^/]*"; }
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = seg.indexOf("]", i + 2);
      if (close === -1) { re += "\\["; continue; }
      let body = seg.slice(i + 1, close);
      let negate = false;
      if (body[0] === "!" || body[0] === "^") { negate = true; body = body.slice(1); }
      re += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")}${negate ? "/" : ""}]`;
      i = close;
    } else re += escapeRe(c);
  }
  return re;
}

/** One brace-free pattern to a RegExp over a whole relative path. */
export function globToRegExp(pattern, { caseInsensitive = false } = {}) {
  const segs = normalizePattern(pattern).split("/");
  let re = "^";
  for (let i = 0; i < segs.length; i++) {
    const last = i === segs.length - 1;
    if (segs[i] === "**") re += last ? ".*" : "(?:[^/]+/)*";
    else { re += segmentToRegex(segs[i]); if (!last) re += "/"; }
  }
  return new RegExp(re + "$", caseInsensitive ? "iu" : "u");
}

/**
 * Compiles a pattern (with braces) into { test(relPath), prefixes, literal }.
 * prefixes: the literal leading folders of each alternative, where a walk can start.
 */
export function compileGlob(pattern, { caseInsensitive = false } = {}) {
  const alternatives = expandBraces(normalizePattern(pattern));
  const compiled = alternatives.map(alt => {
    const segs = alt.split("/");
    const fixed = [];
    for (const seg of segs.slice(0, -1)) { if (hasMagic(seg)) break; fixed.push(seg); }
    return { alt, regex: globToRegExp(alt, { caseInsensitive }), prefix: fixed.join("/"), literal: !hasMagic(alt) };
  });
  return {
    test: rel => compiled.some(c => c.regex.test(rel.normalize("NFC"))),
    prefixes: [...new Set(compiled.map(c => c.prefix))],
    alternatives: compiled.map(c => c.alt),
    literal: compiled.every(c => c.literal),
  };
}

/** Longest list of prefixes where none is inside another (so a walk never visits a folder twice). */
export function minimalPrefixes(prefixes) {
  const sorted = [...new Set(prefixes)].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const p of sorted) if (!kept.some(k => k === "" || p === k || p.startsWith(k + "/"))) kept.push(p);
  return kept;
}

/**
 * gitignore-flavoured filter used by Grep's glob argument and LS's ignore list: a pattern without a slash
 * matches the file or folder name at any depth; a pattern with a slash matches the path from the root.
 */
export function compileNameFilter(pattern, opts = {}) {
  const p = normalizePattern(pattern);
  const anchored = p.includes("/");
  const glob = compileGlob(anchored ? p.replace(/^\//, "") : p, opts);
  return rel => {
    const text = anchored ? rel : path.posix.basename(rel);
    return glob.test(text) || (anchored && glob.test(rel));
  };
}
