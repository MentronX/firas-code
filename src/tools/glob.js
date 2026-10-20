// Glob: find files by name pattern with our own matcher.
import fs from "node:fs";
import path from "node:path";
import { t } from "../i18n/index.js";
import { ok, fail, settings, shown, pathArg, isPlainObject, tn, previewBody } from "./common.js";
import { readVerdict } from "./access.js";
import { guardPath, isWithin } from "./pathguard.js";
import { compileGlob, hasMagic, minimalPrefixes, normalizePattern } from "./globmatch.js";
import { ignoredNames, walk } from "./walk.js";

export const GLOB_MAX_RESULTS = 200;
const SORT_CAP = 20_000;

const DESCRIPTION = [
  "Finds files by name pattern and returns their paths relative to the working folder, most recently modified first (at most 200).",
  "Pattern syntax: ** matches any number of folders, * any characters inside one name, ? one character, [abc] a set, {a,b} alternatives. Examples: \"**/*.js\", \"src/**/*.{ts,tsx}\", \"**/test_*.py\".",
  "A pattern without ** only looks inside the search folder itself. Folders such as .git, node_modules, dist, build, target and coverage are skipped unless the pattern or path names them.",
  "Use it to locate files by name or extension. Do not use it to search inside files (use Grep) or to list one folder (use LS).",
].join(" ");

const isAbsolutePattern = p => /^([a-zA-Z]:\/|\/|~\/|~$)/.test(p);

/** Splits an absolute pattern into the folder where its literal part ends and the rest. */
function splitAbsolute(pattern) {
  const segs = pattern.split("/");
  const fixed = [];
  let i = 0;
  for (; i < segs.length - 1; i++) { if (hasMagic(segs[i])) break; fixed.push(segs[i]); }
  const prefix = fixed.join("/") || "/";
  return { prefix: /^[a-zA-Z]:$/.test(prefix) ? prefix + "/" : prefix, rest: segs.slice(i).join("/") };
}

/**
 * Where the walk really starts. A pattern may begin with literal folders, ".." included (or hide one in a brace group),
 * so "../../other/*.js" lists a place the search folder is not. Every start has to be covered by what the search folder
 * was judged to be: inside the project, or (for a folder outside it that the person approved) inside that folder, links
 * followed. Returns the guard of the first start that is not, else `g` itself.
 */
/** The deepest folder that contains both paths, so one permission question covers every start. */
function commonAncestor(a, b, P) {
  const as = P.resolve(a).split(P.sep);
  const bs = P.resolve(b).split(P.sep);
  const out = [];
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i].toLowerCase() !== bs[i].toLowerCase()) break;
    out.push(as[i]);
  }
  return out.join(P.sep) || P.sep;
}

function reach(g, pattern, s) {
  if (!g.ok) return g;
  const P = s.platform === "win32" ? path.win32 : path.posix;
  let prefixes;
  try { prefixes = compileGlob(pattern).prefixes; } catch { return g; } // a malformed pattern is reported by the search itself
  let uncovered = null;
  for (const prefix of prefixes) {
    if (!prefix) continue;
    const start = guardPath(P.resolve(g.abs, prefix), { cwd: s.cwd, platform: s.platform });
    if (!start.ok) return start;
    const covered = g.inside ? start.inside : isWithin(g.abs, start.abs, s.platform) && isWithin(g.real, start.real, s.platform);
    if (!covered) {
      // The search visits every prefix, so the question must cover every uncovered start, not just the first.
      uncovered = uncovered ? guardPath(commonAncestor(uncovered.abs, start.abs, P), { cwd: s.cwd, platform: s.platform }) : start;
    }
  }
  return uncovered || g;
}

function plan(input, ctx) {
  const s = settings(ctx);
  const pattern = normalizePattern(input.pattern);
  let g;
  let rest = pattern;
  if (isAbsolutePattern(pattern)) {
    const split = splitAbsolute(pattern);
    g = guardPath(split.prefix, { cwd: s.cwd, platform: s.platform });
    rest = split.rest;
  } else {
    g = guardPath(pathArg(input) || ".", { cwd: s.cwd, platform: s.platform });
  }
  // `g` stays the search folder; `where` is the place a permission question is about.
  return { g, pattern: rest, where: reach(g, rest, s) };
}

export function createGlobTool() {
  return {
    name: "Glob",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern, for example \"**/*.js\" or \"src/**/*.test.ts\"." },
        path: { type: "string", description: "Folder to search in (absolute or relative to the working folder). Default: the working folder." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    readOnly: true,
    concurrencySafe: true,

    summarize(input) { return input?.path ? `${input.pattern} (${input.path})` : String(input?.pattern ?? ""); },

    validate(input, ctx) {
      if (!isPlainObject(input) || typeof input.pattern !== "string" || !input.pattern.trim()) return "pattern is required (a non-empty string).";
      const { where } = plan(input, ctx);
      return where.ok ? null : where.message;
    },

    permission(input, ctx) {
      const { where } = plan(input, ctx);
      if (!where.ok) return { decision: "deny", reason: where.message, risk: "low", title: t("tools.perm.badPath") };
      return readVerdict(where, ctx, { directory: true });
    },

    async run(input, ctx) {
      const s = settings(ctx);
      const { g, pattern: initial } = plan(input, ctx);
      if (!g.ok) return fail("badPath", g.message);
      const where = shown(g.abs, ctx);
      let stat;
      try { stat = fs.statSync(g.abs); } catch { return fail("notFound", `The folder ${where} does not exist.`, { file: where }); }
      if (!stat.isDirectory()) return fail("notDir", `${where} is a file, not a folder. Pass a folder as path.`, { file: where });

      const caseInsensitive = s.platform === "win32";
      const deadline = Date.now() + 20_000;
      const search = async pattern => {
        const glob = compileGlob(pattern, { caseInsensitive });
        const ignore = ignoredNames({ rootAbs: g.abs, patterns: [pattern] });
        const found = new Set();
        let timedOut = false;
        for (const start of minimalPrefixes(glob.prefixes)) {
          const startAbs = start ? path.join(g.abs, start) : g.abs;
          let st;
          try { st = fs.statSync(startAbs); } catch { continue; }
          if (st.isFile()) { if (glob.test(start)) found.add(start); continue; }
          const r = await walk(startAbs, {
            ignore, deadline, signal: ctx?.signal,
            visit(rel, entry, isDir) {
              if (isDir) return true;
              const full = start ? `${start}/${rel}` : rel;
              if ((entry.isFile() || entry.isSymbolicLink()) && glob.test(full)) { found.add(full); if (found.size >= SORT_CAP) return false; }
              return true;
            },
          });
          if (r.timedOut) timedOut = true;
        }
        return { found, timedOut };
      };

      let { found, timedOut } = await search(initial);
      let widened = false;
      if (found.size === 0 && !timedOut && !initial.includes("/")) {
        const again = await search(`**/${initial}`);
        if (again.found.size) { found = again.found; widened = true; }
      }

      const rows = [];
      for (const rel of found) {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(g.abs, rel)).mtimeMs; } catch { /* vanished */ }
        rows.push({ rel, mtime });
      }
      rows.sort((a, b) => b.mtime - a.mtime || (a.rel < b.rel ? -1 : 1));
      const shownRows = rows.slice(0, GLOB_MAX_RESULTS);
      const label = abs => {
        const rel = path.relative(s.cwd, abs);
        return !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
      };
      const lines = shownRows.map(r => label(path.join(g.abs, r.rel)));

      if (!lines.length) {
        const hints = [];
        if (!initial.includes("/") && !initial.includes("**")) hints.push("The pattern has no folder part, so it only matches directly inside the search folder; use \"**/\" in front to search subfolders.");
        hints.push("Folders such as node_modules, dist, build and .git are skipped unless you name them in the pattern or path.");
        if (timedOut) hints.push("The search stopped early because it took too long; narrow the path.");
        return ok(`No files matched "${input.pattern}" in ${where}. ${hints.join(" ")}`, { summary: t("tools.glob.none") });
      }
      const notes = [];
      if (widened) notes.push(`(No match directly in the search folder; showing matches in subfolders for "**/${initial}".)`);
      if (rows.length > GLOB_MAX_RESULTS || found.size >= SORT_CAP) notes.push(`(Showing the ${GLOB_MAX_RESULTS} most recently modified of ${found.size >= SORT_CAP ? "more than " + SORT_CAP : rows.length} matches. Narrow the pattern or the path to see the rest.)`);
      if (timedOut) notes.push("(The search stopped early because it took too long; the list may be incomplete.)");
      return ok([...lines, ...notes].join("\n"), { summary: tn("tools.glob.found", rows.length), body: previewBody(lines, rows.length) });
    },
  };
}
