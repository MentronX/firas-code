// File candidates for the `@` picker in the prompt: a quick, bounded scan of the project and a forgiving matcher.
//
// Decisions: the scan is breadth-first (shallow files first, they are the ones people mean), stops at 5,000 entries or
// 1.5 s, skips version-control and dependency/build folders, never follows links to folders, and is cached for 30 s
// per folder. Paths use "/" on every platform (the model and the tools accept both).
import fs from "node:fs";
import path from "node:path";

export const FILE_SCAN_LIMIT = 5000;
const SCAN_MS = 1500;
const CACHE_MS = 30_000;
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  "dist", "build", ".next", ".nuxt", "target", "coverage", ".turbo", ".parcel-cache", ".gradle", ".cache", ".idea", ".vs",
]);

/** Lists up to `limit` files under `root` as relative "/" paths, shallow ones first. */
export async function scanFiles(root, { limit = FILE_SCAN_LIMIT, deadlineMs = SCAN_MS } = {}) {
  const out = [];
  const queue = [""];
  const deadline = Date.now() + deadlineMs;
  let seen = 0;
  while (queue.length && out.length < limit && Date.now() < deadline) {
    const rel = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++seen > limit * 4) return out;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(child);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(child);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

function score(file, query) {
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === query) return 1000;
  if (base.startsWith(query)) return 900 - base.length;
  if (base.includes(query)) return 800 - base.length;
  if (lower.includes(query)) return 600 - lower.length;
  // subsequence: every query letter in order
  let at = 0;
  let gaps = 0;
  for (const ch of query) {
    const next = lower.indexOf(ch, at);
    if (next === -1) return -1;
    gaps += next - at;
    at = next + 1;
  }
  return 400 - Math.min(gaps, 300);
}

/** Best matches first. An empty query returns the first files of the scan (shallow ones). */
export function matchFiles(files, query, max = 12) {
  const q = String(query ?? "").trim().toLowerCase().replace(/\\/g, "/");
  if (!q) return files.slice(0, max);
  const scored = [];
  for (const file of files) {
    const s = score(file, q);
    if (s >= 0) scored.push([s, file]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
  return scored.slice(0, max).map(item => item[1]);
}

/** `files(query)` for readPrompt: scans lazily on first use and again once the cache is stale. */
export function createFileIndex({ cwd, limit = FILE_SCAN_LIMIT } = {}) {
  let cache = null;
  let at = 0;
  let pending = null;
  const load = () => {
    if (cache && Date.now() - at < CACHE_MS) return Promise.resolve(cache);
    if (!pending) {
      pending = scanFiles(cwd, { limit }).then(list => { cache = list; at = Date.now(); return list; }).finally(() => { pending = null; });
    }
    return pending;
  };
  return {
    files: async query => matchFiles(await load(), query),
    warm: () => { load().catch(() => {}); },
  };
}
