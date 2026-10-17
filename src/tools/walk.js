// Directory walking shared by Glob, Grep (JS fallback) and LS: default-ignored folders, .gitignore rules,
// and a finder for executables on PATH.
import fs from "node:fs";
import path from "node:path";
import { globToRegExp, expandBraces, normalizePattern } from "./globmatch.js";

export const DEFAULT_IGNORES = Object.freeze([
  ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  "dist", "build", ".next", ".nuxt", "target", "coverage", ".turbo", ".parcel-cache", ".gradle", ".cache",
]);

/**
 * The folder names to skip: the defaults, except those the caller names explicitly (a literal segment of the
 * pattern) or is already working inside (a component of the search root's path).
 */
export function ignoredNames({ rootAbs = "", patterns = [] } = {}) {
  const named = new Set();
  for (const pattern of patterns) for (const alt of expandBraces(normalizePattern(pattern))) for (const seg of alt.split("/")) named.add(seg);
  const inside = new Set(String(rootAbs).split(/[\\/]+/).filter(Boolean));
  return new Set(DEFAULT_IGNORES.filter(name => !named.has(name) && !inside.has(name)));
}

/** Lets the event loop run (timers, the spinner) before the caller carries on. */
export const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * Walks `root` depth-first without blocking the event loop for long (the spinner keeps turning).
 * visit(relPosixPath, entry, isDir) (may be async) -> false to stop. Directories whose name is in `ignore` (or rejected by
 * `skipDir(rel)`) are not entered; symbolic links to folders are never followed.
 * Returns { visited, stopped, timedOut }.
 */
export async function walk(root, { ignore = new Set(), skipDir = null, visit, maxEntries = 500_000, deadline = Infinity, signal = null }) {
  const stack = [""];
  let visited = 0;
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    if (entries.length > 2000) await tick();
    for (const entry of entries) {
      if (++visited > maxEntries || Date.now() > deadline || signal?.aborted) return { visited, stopped: false, timedOut: true };
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (isDir) {
        if (ignore.has(entry.name) || (skipDir && skipDir(childRel))) continue;
        stack.push(childRel);
      }
      if ((await visit(childRel, entry, isDir)) === false) return { visited, stopped: true, timedOut: false };
    }
  }
  return { visited, stopped: false, timedOut: false };
}

// ---------------------------------------------------------------------------------------------------
// .gitignore

function parseRule(line) {
  let text = line.replace(/\r$/, "");
  if (!text.trim() || text.startsWith("#")) return null;
  text = text.replace(/(?<!\\)\s+$/, "");
  let negate = false;
  if (text.startsWith("!")) { negate = true; text = text.slice(1); }
  if (text.startsWith("\\#") || text.startsWith("\\!")) text = text.slice(1);
  let dirOnly = false;
  if (text.endsWith("/")) { dirOnly = true; text = text.slice(0, -1); }
  if (!text) return null;
  const anchored = text.includes("/");
  text = text.replace(/^\//, "");
  const regexes = expandBraces(text).map(alt => globToRegExp(anchored ? alt : `**/${alt}`));
  return { negate, dirOnly, regexes };
}

/** Rules from the .gitignore files met while walking; ask isIgnored(relPath, isDir) for any path. */
export function createIgnoreStack(rootAbs) {
  const layers = []; // { base: "" | "sub/dir", rules }
  const loaded = new Set();
  const load = relDir => {
    if (loaded.has(relDir)) return;
    loaded.add(relDir);
    try {
      const rules = fs.readFileSync(path.join(rootAbs, relDir, ".gitignore"), "utf8").split("\n").map(parseRule).filter(Boolean);
      if (rules.length) layers.push({ base: relDir, rules });
    } catch { /* no .gitignore here */ }
  };
  load("");
  return {
    enter: load,
    isIgnored(rel, isDir) {
      let ignored = false;
      for (const layer of layers) {
        let sub = rel;
        if (layer.base) {
          if (!rel.startsWith(layer.base + "/")) continue;
          sub = rel.slice(layer.base.length + 1);
        }
        for (const rule of layer.rules) {
          if (rule.dirOnly && !isDir) continue;
          if (rule.regexes.some(re => re.test(sub))) ignored = !rule.negate;
        }
      }
      return ignored;
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// PATH lookup

const whichCache = new Map();

/** Absolute path of an executable on PATH, or null. */
export function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  const pathValue = env.PATH ?? env.Path ?? "";
  const cacheKey = `${platform}|${name}|${pathValue}`;
  if (whichCache.has(cacheKey)) return whichCache.get(cacheKey);
  const exts = platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  let found = null;
  for (const dir of pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
      try { if (fs.statSync(file).isFile()) { found = file; break; } } catch { /* keep looking */ }
    }
    if (found) break;
  }
  whichCache.set(cacheKey, found);
  return found;
}
