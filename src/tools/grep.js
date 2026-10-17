// Grep: content search. Uses ripgrep (`rg`) when it is installed - spawned with an argument list, never
// through a shell - and an equivalent pure-JS implementation otherwise (or when FIRAS_NO_RG=1).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { t } from "../i18n/index.js";
import { ok, fail, settings, shown, pathArg, isPlainObject, toInt, clipLine, headOnly, tn, childEnv, previewBody } from "./common.js";
import { readVerdict } from "./access.js";
import { guardPath, isSecretPath } from "./pathguard.js";
import { sniffFile, decodeText } from "./textfile.js";
import { compileNameFilter } from "./globmatch.js";
import { ignoredNames, walk, createIgnoreStack, findExecutable, tick } from "./walk.js";
import { PATTERN_MAX, checkPattern, needsGuard } from "./regexguard.js";

export const GREP_DEFAULT_LIMIT = 250;
const GREP_HARD_LIMIT = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const LINE_CAP = 500;
const MATCH_CAP = 20_000;
// Limits of the JavaScript fallback, whose regular expressions backtrack (see regexguard.js).
const SCAN_LINE_MAX = 4000; // characters of one line that are searched
const JS_BUDGET_MS = 20_000; // the whole search
const FILE_BUDGET_MS = 2_000; // one file, for patterns that run under the hard limit
const LONG_LINE = 300; // a line this long is where open-ended repeats start to hurt
const SLOW_FILES_MAX = 3; // files a pattern may time out on before the search gives up

const TYPES = {
  js: [".js", ".mjs", ".cjs", ".jsx"], ts: [".ts", ".tsx", ".mts", ".cts"], py: [".py", ".pyi"], json: [".json", ".jsonc", ".json5"],
  md: [".md", ".markdown", ".mdx"], html: [".html", ".htm", ".xhtml"], css: [".css", ".scss", ".sass", ".less"], java: [".java"],
  kotlin: [".kt", ".kts"], c: [".c", ".h"], cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h"], cs: [".cs"], go: [".go"],
  rust: [".rs"], ruby: [".rb", ".rake", ".gemspec"], php: [".php"], swift: [".swift"], sh: [".sh", ".bash", ".zsh"], ps: [".ps1", ".psm1", ".psd1"],
  sql: [".sql"], yaml: [".yaml", ".yml"], toml: [".toml"], xml: [".xml", ".xsd", ".xsl", ".svg"], txt: [".txt"], vue: [".vue"],
  svelte: [".svelte"], lua: [".lua"], dart: [".dart"], scala: [".scala"], r: [".r"], bat: [".bat", ".cmd"], ini: [".ini", ".cfg", ".conf"],
};
const TYPE_ALIASES = { javascript: "js", typescript: "ts", python: "py", markdown: "md", yml: "yaml", golang: "go", rs: "rust", rb: "ruby", csharp: "cs", shell: "sh", powershell: "ps", kt: "kotlin", "c++": "cpp" };
const RG_TYPE_NAMES = { cs: "csharp", ps: "ps" };

const DESCRIPTION = [
  "Searches file contents for a regular expression and returns matching files, counts or lines.",
  "output_mode: \"files_with_matches\" (default) lists the files that contain a match, newest first; \"content\" prints matching lines as path:line:text (with context lines as path-line-text when -A, -B or -C is set); \"count\" prints path:number.",
  "Narrow the search with path (a folder or one file), glob (for example \"*.js\" or \"src/**/*.ts\") or type (js, ts, py, json, md, html, css, java, go, rust, ...). Matching is case-sensitive unless -i is true. Set multiline to let a pattern span lines.",
  "The pattern is a regular expression, so escape literal braces and parentheses. Binary files, files over 1 MB, and folders such as node_modules, .git, dist and build are skipped. Results are limited by head_limit (default 250).",
  "Use it to find where something is defined or used. Do not use it to find files by name (use Glob) or to read a file you already know (use Read).",
].join(" ");

// ---------------------------------------------------------------------------------------------------
// ripgrep

async function searchWithRg({ rg, root, isFile, pattern, ignoreCase, glob, type, mode, before, after, multiline, ignore, env, signal }) {
  const args = ["--no-config", "--no-require-git", "--crlf", "--hidden", "--color", "never", "--max-filesize", "1M"];
  for (const name of ignore) args.push("--glob", `!${name}`);
  if (ignoreCase) args.push("-i");
  if (glob) args.push("--glob", glob);
  if (type) args.push("--type", RG_TYPE_NAMES[type] || type);
  if (multiline) args.push("-U", "--multiline-dotall");
  if (mode === "files_with_matches") args.push("--files-with-matches");
  else if (mode === "count") args.push("--count", "--with-filename");
  else {
    args.push("--json");
    if (before) args.push("-B", String(before));
    if (after) args.push("-A", String(after));
  }
  args.push("-e", pattern, "--", isFile ? path.basename(root) : ".");
  const cwd = isFile ? path.dirname(root) : root;

  return new Promise(resolve => {
    let child;
    try { child = spawn(rg, args, { cwd, env: childEnv(env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ unavailable: true, error }); return; }
    const out = [];
    let outBytes = 0, errText = "", truncated = false, timedOut = false;
    const kill = () => { try { child.kill(); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 30_000);
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", chunk => {
      outBytes += chunk.length;
      if (outBytes > 64 * 1024 * 1024) { truncated = true; kill(); return; }
      out.push(chunk);
    });
    child.stderr.on("data", chunk => { if (errText.length < 4000) errText += chunk.toString("utf8"); });
    child.on("error", error => { clearTimeout(timer); resolve({ unavailable: true, error }); });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: errText.trim(), truncated: truncated || timedOut, timedOut });
    });
  });
}

const rgPathText = field => (field?.text !== undefined ? field.text : field?.bytes ? Buffer.from(field.bytes, "base64").toString("utf8") : "");

function parseRg({ stdout, mode, root, isFile }) {
  const toAbs = p => path.resolve(isFile ? path.dirname(root) : root, p);
  const files = new Map();
  const entry = abs => {
    if (!files.has(abs)) files.set(abs, { abs, rows: [], count: 0 });
    return files.get(abs);
  };
  if (mode === "files_with_matches") {
    for (const line of stdout.split(/\r?\n/)) if (line) entry(toAbs(line));
  } else if (mode === "count") {
    for (const line of stdout.split(/\r?\n/)) {
      const at = line.lastIndexOf(":");
      if (at > 0) entry(toAbs(line.slice(0, at))).count = parseInt(line.slice(at + 1), 10) || 0;
    }
  } else {
    for (const raw of stdout.split("\n")) {
      if (!raw) continue;
      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type !== "match" && ev.type !== "context") continue;
      const data = ev.data;
      const text = rgPathText(data.lines).replace(/\r?\n$/, "");
      const file = entry(toAbs(rgPathText(data.path)));
      const first = data.line_number;
      text.split("\n").forEach((piece, i) => file.rows.push({ line: first + i, text: piece.replace(/\r$/, ""), kind: ev.type === "match" ? "match" : "context" }));
      if (ev.type === "match") file.count++;
    }
  }
  return [...files.values()];
}

// ---------------------------------------------------------------------------------------------------
// JS fallback

/**
 * Compiles the pattern for the fallback. Returns { regex, guard } or { error, slow }:
 *   guard  how much hard time limit the matching needs (see needsGuard)
 *   slow   true when the pattern was refused for its shape (not for a syntax error)
 */
function buildRegex(pattern, ignoreCase, multiline) {
  let source = pattern;
  let flags = ignoreCase ? "i" : "";
  const inline = /^\(\?([a-z]+)\)/.exec(source);
  if (inline) { source = source.slice(inline[0].length); if (inline[1].includes("i")) flags += flags.includes("i") ? "" : "i"; }
  if (multiline) flags += "ms";
  let regex;
  try { regex = new RegExp(source, flags + "u"); }
  catch {
    try { regex = new RegExp(source, flags); }
    catch (error) { return { error: String(error.message || error) }; }
  }
  const why = checkPattern(source, { ignoreCase: flags.includes("i") });
  if (why) {
    return {
      slow: true,
      error: `This pattern can take exponential time on some lines (${why}), so it was not run and nothing was searched. Rewrite it without the nested repetition or the overlapping alternatives, for example use a+ instead of (a+)+ or [\\w-]+ instead of (\\w|-)+, or search for a simpler literal first and narrow the results afterwards.`,
    };
  }
  return { regex, guard: needsGuard(source) };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}
function lineAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

// The two loops that run the model's regular expression. They are plain functions with no outside references so that the
// very same text can also run inside a node:vm context, where a time limit really interrupts a regular expression.
function scanLines(re, lines, cap, first, limit, deadline) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if ((i & 127) === 127 && Date.now() > deadline) return { found, timedOut: true };
    const line = lines[i];
    if (re.test(line.length > cap ? line.slice(0, cap) : line)) {
      found.push(i);
      if (first || found.length > limit) break;
    }
  }
  return { found, timedOut: false };
}

function scanText(re, text, first, limit) {
  const spans = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    spans.push(m.index, m[0].length);
    if (m[0].length === 0) re.lastIndex++;
    if (first || spans.length > limit * 2) break;
  }
  return spans;
}

const sandbox = vm.createContext({ args: null });
const scripts = new Map();

/** Runs fn(...args) directly, or under a hard time limit. Returns { value } or { timedOut: true }. */
function runScan(fn, args, limitMs) {
  if (!limitMs) return { value: fn(...args) };
  let script = scripts.get(fn);
  if (!script) { script = new vm.Script(`(${fn.toString()})(...args)`); scripts.set(fn, script); }
  sandbox.args = args;
  try { return { value: script.runInContext(sandbox, { timeout: limitMs }) }; }
  catch (error) {
    if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { timedOut: true };
    throw error;
  } finally { sandbox.args = null; }
}

/** Searches one file. Returns null (no match / skipped), a hit, or { slow: true } when the pattern timed out on it. */
function searchFileJs(abs, matcher, { mode, multiline, deadline, stats }) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  if (sniffFile(buf).kind !== "text") return null;
  const text = decodeText(buf).text.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const first = mode === "files_with_matches";
  let longest = 0;
  let cut = 0;
  for (const line of lines) {
    if (line.length > longest) longest = line.length;
    if (line.length > SCAN_LINE_MAX) cut++;
  }
  const guarded = matcher.guard === "always" || (matcher.guard === "long" && (multiline || longest > LONG_LINE));
  const limitMs = guarded ? Math.min(FILE_BUDGET_MS, Math.max(100, deadline - Date.now())) : 0;
  const matched = new Set();
  if (multiline) {
    const res = runScan(scanText, [matcher.global, text, first, MATCH_CAP], limitMs);
    if (res.timedOut) return { slow: true };
    const starts = lineStarts(text);
    for (let k = 0; k < res.value.length; k += 2) {
      const index = res.value[k];
      const length = res.value[k + 1];
      const from = lineAt(starts, index);
      const to = lineAt(starts, Math.max(index, index + length - 1));
      for (let n = from; n <= to; n++) matched.add(n);
      if (matched.size > MATCH_CAP) break;
    }
  } else {
    const res = runScan(scanLines, [matcher.regex, lines, SCAN_LINE_MAX, first, MATCH_CAP, deadline], limitMs);
    if (res.timedOut) return { slow: true };
    for (const index of res.value.found) matched.add(index + 1);
    if (res.value.timedOut) stats.stopped = true;
  }
  stats.longLines += cut;
  if (!matched.size) return null;
  return { abs, mtime: stat.mtimeMs, matched, lines, count: matched.size };
}

async function collectJs({ root, isFile, matcher, mode, multiline, ignore, glob, typeExts, gitignore, signal }) {
  const hits = [];
  const deadline = Date.now() + JS_BUDGET_MS;
  const stats = { longLines: 0, slow: 0, stopped: false };
  const notes = () => {
    const out = [];
    if (stats.longLines) out.push(`[${stats.longLines} line${stats.longLines === 1 ? " was" : "s were"} longer than ${SCAN_LINE_MAX} characters and only the first ${SCAN_LINE_MAX} characters of ${stats.longLines === 1 ? "it were" : "each were"} searched.]`);
    if (stats.slow) out.push(`[The pattern was too slow on ${stats.slow} file${stats.slow === 1 ? "" : "s"}${stats.slow >= SLOW_FILES_MAX ? " and the search was stopped" : `, which ${stats.slow === 1 ? "was" : "were"} skipped`}. Use a simpler pattern (no nested repetition, fewer .* parts) or a narrower path.]`);
    return out;
  };
  const wanted = rel => {
    if (typeExts && !typeExts.includes(path.extname(rel).toLowerCase())) return false;
    if (glob && !glob(rel)) return false;
    return true;
  };
  const options = { mode, multiline, deadline, stats };
  const take = file => {
    const hit = searchFileJs(file, matcher, options);
    if (hit?.slow) { stats.slow++; return null; }
    return hit;
  };
  if (isFile) {
    const hit = take(root);
    if (hit) hits.push(hit);
    return { hits, timedOut: stats.stopped, notes: notes() };
  }
  let total = 0;
  let scanned = 0;
  const stack = gitignore;
  const r = await walk(root, {
    ignore, deadline, signal,
    skipDir: rel => { stack?.enter(rel); return !!stack?.isIgnored(rel, true); },
    async visit(rel, entry, isDir) {
      if (isDir) return true;
      if (!entry.isFile() && !entry.isSymbolicLink()) return true;
      if (stack?.isIgnored(rel, false)) return true;
      if (!wanted(rel)) return true;
      if (Date.now() > deadline) { stats.stopped = true; return false; }
      const hit = take(path.join(root, rel));
      if (hit) { hits.push(hit); total += hit.count; if (total > MATCH_CAP * 2) return false; }
      if (stats.slow >= SLOW_FILES_MAX) return false;
      // Searching reads files synchronously: give the event loop a turn every so often.
      if (++scanned % 64 === 0) await tick();
      return true;
    },
  });
  return { hits, timedOut: r.timedOut || stats.stopped, notes: notes() };
}

/** Rows (matches plus context) for one file, in line order. */
function rowsFor(hit, before, after) {
  const keep = new Map();
  for (const n of [...hit.matched].sort((a, b) => a - b)) {
    for (let k = Math.max(1, n - before); k <= Math.min(hit.lines.length, n + after); k++) keep.set(k, hit.matched.has(k) ? "match" : "context");
  }
  return [...keep.entries()].sort((a, b) => a[0] - b[0]).map(([line, kind]) => ({ line, kind, text: hit.lines[line - 1] }));
}

// ---------------------------------------------------------------------------------------------------

export function createGrepTool() {
  return {
    name: "Grep",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Folder or file to search (absolute or relative to the working folder). Default: the working folder." },
        glob: { type: "string", description: "Only search files whose name matches this glob, e.g. \"*.ts\" or \"src/**/*.{js,jsx}\"." },
        type: { type: "string", description: "Only search this kind of file: js, ts, py, json, md, html, css, java, go, rust, ruby, php, sh, sql, yaml, ..." },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "What to return. Default files_with_matches." },
        "-i": { type: "boolean", description: "Ignore case." },
        "-n": { type: "boolean", description: "Show line numbers in content mode. Default true." },
        "-A": { type: "integer", minimum: 0, maximum: 50, description: "Lines of context after each match (content mode)." },
        "-B": { type: "integer", minimum: 0, maximum: 50, description: "Lines of context before each match (content mode)." },
        "-C": { type: "integer", minimum: 0, maximum: 50, description: "Lines of context before and after each match (content mode)." },
        multiline: { type: "boolean", description: "Let the pattern match across line breaks (. also matches a newline)." },
        head_limit: { type: "integer", minimum: 1, maximum: GREP_HARD_LIMIT, description: `Maximum number of output lines or entries. Default ${GREP_DEFAULT_LIMIT}.` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    readOnly: true,
    concurrencySafe: true,

    summarize(input) { return input?.path ? `${input.pattern} (${input.path})` : String(input?.pattern ?? ""); },

    validate(input, ctx) {
      if (!isPlainObject(input) || typeof input.pattern !== "string" || input.pattern === "") return "pattern is required (a non-empty string).";
      if (input.pattern.length > PATTERN_MAX) return `pattern is too long (${input.pattern.length} characters; the limit is ${PATTERN_MAX}). Search for a shorter, simpler pattern.`;
      if (input.output_mode !== undefined && !["content", "files_with_matches", "count"].includes(input.output_mode)) return "output_mode must be content, files_with_matches or count.";
      for (const key of ["-A", "-B", "-C", "head_limit"]) if (input[key] !== undefined && !(toInt(input[key]) >= 0)) return `${key} must be a non-negative integer.`;
      if (input.type !== undefined) {
        const name = TYPE_ALIASES[String(input.type).toLowerCase()] || String(input.type).toLowerCase();
        if (!TYPES[name]) return `Unknown file type "${input.type}". Known types: ${Object.keys(TYPES).join(", ")}.`;
      }
      const g = guardPath(pathArg(input) || ".", { cwd: settings(ctx).cwd, platform: settings(ctx).platform });
      return g.ok ? null : g.message;
    },

    permission(input, ctx) {
      const s = settings(ctx);
      const g = guardPath(pathArg(input) || ".", { cwd: s.cwd, platform: s.platform });
      if (!g.ok) return { decision: "deny", reason: g.message, risk: "low", title: t("tools.perm.badPath") };
      return readVerdict(g, ctx, { directory: true });
    },

    async run(input, ctx) {
      const s = settings(ctx);
      const g = guardPath(pathArg(input) || ".", { cwd: s.cwd, platform: s.platform });
      if (!g.ok) return fail("badPath", g.message);
      const where = shown(g.abs, ctx);
      let stat;
      try { stat = fs.statSync(g.abs); } catch { return fail("notFound", `${where} does not exist.`, { file: where }); }

      const mode = input.output_mode || "files_with_matches";
      const context = toInt(input["-C"]) || 0;
      const before = Math.min(50, toInt(input["-B"]) || context);
      const after = Math.min(50, toInt(input["-A"]) || context);
      const showNumbers = input["-n"] !== false && input["-n"] !== "false";
      const limit = Math.min(GREP_HARD_LIMIT, Math.max(1, toInt(input.head_limit) || GREP_DEFAULT_LIMIT));
      const ignoreCase = input["-i"] === true || input["-i"] === "true";
      // A pattern that mentions a line break can only match across lines, so ask for that mode.
      const wantsLines = /(^|[^\\])(\\\\)*\\n/.test(input.pattern) || /[\r\n]/.test(input.pattern);
      const multiline = input.multiline === true || input.multiline === "true" || wantsLines;
      const typeName = input.type ? (TYPE_ALIASES[String(input.type).toLowerCase()] || String(input.type).toLowerCase()) : null;
      const isFile = stat.isFile();
      const ignore = isFile ? new Set() : ignoredNames({ rootAbs: g.abs, patterns: input.glob ? [input.glob] : [] });

      const wantRg = !(s.env.FIRAS_NO_RG === "1" || process.env.FIRAS_NO_RG === "1");
      const rg = wantRg ? findExecutable("rg", { env: s.env, platform: s.platform }) : null;
      let files = null;
      let incomplete = false;
      let searchNotes = [];

      if (rg) {
        const res = await searchWithRg({ rg, root: g.abs, isFile, pattern: input.pattern, ignoreCase, glob: input.glob, type: typeName, mode, before, after, multiline, ignore, env: s.env, signal: ctx?.signal });
        if (!res.unavailable && !(res.code === 2 && /unrecognized file type/i.test(res.stderr))) {
          if (res.code === 2 && !res.stdout.trim()) return fail("badPattern", `Search failed: ${res.stderr.split("\n").slice(0, 6).join("\n") || "invalid pattern"}`, { pattern: input.pattern });
          files = parseRg({ stdout: res.stdout, mode, root: g.abs, isFile });
          incomplete = res.truncated;
          for (const f of files) { try { f.mtime = fs.statSync(f.abs).mtimeMs; } catch { f.mtime = 0; } }
        }
      }

      if (!files) {
        const built = buildRegex(input.pattern, ignoreCase, multiline);
        if (built.error) return fail("badPattern", built.slow ? built.error : `Invalid regular expression: ${built.error}`, { pattern: input.pattern });
        const matcher = {
          regex: built.regex, guard: built.guard,
          global: multiline ? new RegExp(built.regex.source, built.regex.flags.includes("g") ? built.regex.flags : built.regex.flags + "g") : null,
        };
        const gitignore = isFile ? null : createIgnoreStack(g.abs);
        const found = await collectJs({
          root: g.abs, isFile, matcher, mode, multiline, ignore, gitignore, signal: ctx?.signal,
          glob: input.glob ? compileNameFilter(input.glob, { caseInsensitive: s.platform === "win32" }) : null,
          typeExts: typeName ? TYPES[typeName] : null,
        });
        incomplete = found.timedOut;
        searchNotes = found.notes;
        files = found.hits.map(hit => ({
          abs: hit.abs, mtime: hit.mtime, count: hit.count,
          rows: mode === "content" ? rowsFor(hit, before, after) : [],
        }));
      }

      // A search of a folder must not be a way round the rule that secrets are only read with the person's say-so
      // (Read asks about them). Naming one such file as the path is a different matter: that is asked above.
      let leftOut = 0;
      if (!isFile) {
        const kept = files.filter(f => !isSecretPath(f.abs, s.platform));
        leftOut = files.length - kept.length;
        files = kept;
      }
      const secretNote = leftOut
        ? `[${leftOut} file${leftOut === 1 ? "" : "s"} that may hold secrets (.env files, keys, credentials) also matched and ${leftOut === 1 ? "is" : "are"} left out. If the user asked for one, use Read on it.]`
        : "";

      const display = abs => {
        const rel = path.relative(s.cwd, abs);
        return !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
      };
      const stopNotes = [...(incomplete ? ["[The search stopped early (time or size limit); results may be incomplete.]"] : []), ...searchNotes];
      if (!files.length) {
        const tail = [...(secretNote ? [secretNote] : []), ...stopNotes].join(" ");
        return ok(`No matches for "${input.pattern}" in ${where}.${tail ? " " + tail : ""}`, { summary: t("tools.grep.none") });
      }

      let lines;
      let total;
      if (mode === "files_with_matches") {
        files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || (display(a.abs) < display(b.abs) ? -1 : 1));
        total = files.length;
        lines = files.map(f => display(f.abs));
      } else if (mode === "count") {
        files.sort((a, b) => (display(a.abs) < display(b.abs) ? -1 : 1));
        total = files.length;
        lines = files.map(f => `${display(f.abs)}:${f.count}`);
      } else {
        files.sort((a, b) => (display(a.abs) < display(b.abs) ? -1 : 1));
        lines = [];
        total = files.reduce((n, f) => n + f.count, 0);
        const useSep = before > 0 || after > 0;
        for (const f of files) {
          const name = display(f.abs);
          let prev = null;
          for (const row of f.rows) {
            if (useSep && lines.length && (prev === null || row.line > prev + 1)) lines.push("--");
            const sep = row.kind === "match" ? ":" : "-";
            lines.push(showNumbers ? `${name}${sep}${row.line}${sep}${clipLine(row.text, LINE_CAP)}` : `${name}${sep}${clipLine(row.text, LINE_CAP)}`);
            prev = row.line;
          }
        }
      }
      const unit = mode === "content" ? "lines" : "entries";
      const cut = lines.length > limit;
      const shownLines = cut ? lines.slice(0, limit) : lines;
      const notes = [];
      if (cut) notes.push(`[Output limited to ${limit} ${unit} (head_limit); ${lines.length - limit} more not shown. Narrow the search or raise head_limit.]`);
      notes.push(...stopNotes);
      if (secretNote) notes.push(secretNote);
      const body = headOnly(shownLines.join("\n"), 120_000, "output cut");
      return ok(notes.length ? `${body}\n${notes.join("\n")}` : body, {
        summary: mode === "content" ? tn("tools.grep.matches", total) : tn("tools.grep.files", files.length),
        body: previewBody(lines.filter(line => line !== "--")),
      });
    },
  };
}
