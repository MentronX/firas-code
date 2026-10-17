// Shared by set-repo.mjs and the developer tools: lists the files that would be published (everything .gitignore does not exclude)
// without needing git, and tells text files from binary ones. Pure node: built-ins only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules"]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".icns", ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf", ".exe", ".dll", ".so", ".dylib", ".node", ".wasm", ".mp3", ".mp4", ".mov", ".wav"
]);

/** One .gitignore line as a matcher, or null for blanks and comments. */
export function compileIgnoreLine(rawLine) {
  let line = rawLine.replace(/\r$/, "");
  if (!line.trim() || line.startsWith("#")) return null;
  line = line.replace(/(?<!\\)\s+$/, "");
  let negate = false;
  if (line.startsWith("!")) { negate = true; line = line.slice(1); }
  if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
  let dirOnly = false;
  if (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }
  if (!line) return null;
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);

  let source = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "*") {
      if (line[i + 1] === "*") {
        const atStart = i === 0 || line[i - 1] === "/";
        if (line[i + 2] === "/" && atStart) { source += "(?:.*/)?"; i += 2; continue; }
        if (i + 2 === line.length && atStart) { source += ".*"; i += 1; continue; }
        source += ".*"; i += 1; continue;
      }
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      const end = line.indexOf("]", i + 2);
      if (end < 0) { source += "\\["; continue; }
      let body = line.slice(i + 1, end);
      if (body.startsWith("!")) body = "^" + body.slice(1);
      source += "[" + body.replace(/\\/g, "\\\\") + "]";
      i = end;
    } else if (ch === "\\" && i + 1 < line.length) {
      source += line[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i += 1;
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return { negate, dirOnly, anchored, regex: new RegExp("^" + source + "$") };
}

function loadIgnoreFile(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map(compileIgnoreLine).filter(Boolean);
  } catch {
    return [];
  }
}

/** Is `rel` (posix, relative to the folder holding the rules) excluded by these rules? Last match wins. */
function decide(rules, rel, isDir, current) {
  let ignored = current;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const target = rule.anchored ? rel : base;
    if (rule.regex.test(target)) ignored = !rule.negate;
  }
  return ignored;
}

export function looksBinary(name, buffer) {
  if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
  const probe = buffer.subarray(0, 8000);
  return probe.includes(0);
}

/**
 * Relative posix paths of every file under `root` that git would publish. `.git` and `node_modules` are always skipped.
 * Nested .gitignore files apply to their own folder.
 */
export function listPublishedFiles(root) {
  const out = [];
  const stack = [{ dir: root, rel: "", scopes: [{ rel: "", rules: loadIgnoreFile(path.join(root, ".gitignore")) }] }];
  while (stack.length) {
    const { dir, rel, scopes } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (ALWAYS_SKIP_DIRS.has(entry.name) && entry.isDirectory()) continue;
      const childRel = rel ? rel + "/" + entry.name : entry.name;
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue;
      let ignored = false;
      for (const scope of scopes) {
        const local = scope.rel ? childRel.slice(scope.rel.length + 1) : childRel;
        ignored = decide(scope.rules, local, isDir, ignored);
      }
      if (ignored) continue;
      if (isDir) {
        const nested = loadIgnoreFile(path.join(dir, entry.name, ".gitignore"));
        stack.push({ dir: path.join(dir, entry.name), rel: childRel, scopes: nested.length ? [...scopes, { rel: childRel, rules: nested }] : scopes });
      } else {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

/** True when the module is the one node was started with (drive-letter case and symlinks do not matter). */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const norm = p => (process.platform === "win32" ? p.toLowerCase() : p);
  const here = fileURLToPath(metaUrl);
  const started = path.resolve(process.argv[1]);
  try { return norm(fs.realpathSync(here)) === norm(fs.realpathSync(started)); } catch { return norm(here) === norm(started); }
}
