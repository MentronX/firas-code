// Command classifier for the Bash tool.
//
//   classifyCommand(text, opts) -> { risk: "readonly" | "normal" | "high", reasons, keys, remember, secret }
//
// readonly  every part is on a short allowlist of commands that cannot change anything
// normal    anything else: the person is asked (and may allow the same command prefix for the session)
// high      patterns that are asked about even in bypass mode (see HIGH reasons below)
//
// Design: the text is split into parts at ; && || | & newline and groupings, honouring quotes, heredocs and
// substitutions ($( ), backticks), and EVERY part is judged on its own, so a harmless prefix cannot smuggle a
// risky tail. Wrapper commands (sudo, env, bash -c, powershell -Command, eval, xargs, find -exec ...) are
// unwrapped and their payload is judged too. A second, quote-blind pass looks for the high-risk patterns
// anywhere in the text, because over-asking is cheap and a miss is not. When anything cannot be parsed the
// command is "normal" at best, never "readonly".
import path from "node:path";
import { guardPath, isSecretPath, isSystemPath, isGitInternal } from "./pathguard.js";
import { globToRegExp } from "./globmatch.js";

const NAMES = ["readonly", "normal", "high"];

// ---------------------------------------------------------------------------------------------------
// Parsing

const SUBST = "\u0001";
const CONTROL_SKIP = new Set(["then", "else", "elif", "do", "if", "while", "until", "!", "time", "coproc"]);
const CONTROL_IGNORE = new Set(["for", "case", "select", "function", "done", "fi", "esac", "in", "{", "}", "(", ")"]);

function newPart(pipedFrom) { return { words: [], redirects: [], subst: [], bodies: [], pipedFrom: !!pipedFrom }; }

/** Finds the inner texts of $( ) and backtick substitutions in a block of plain text (heredoc bodies, ${ }). */
function scanSubstitutions(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") {
      const end = matchParen(text, i + 1);
      found.push(text.slice(i + 2, end === -1 ? text.length : end));
      if (end === -1) break;
      i = end;
    } else if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      found.push(text.slice(i + 1, end === -1 ? text.length : end));
      if (end === -1) break;
      i = end;
    }
  }
  return found;
}

/** Index of the ")" matching the "(" at `open`, skipping quoted text; -1 when unbalanced. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { const e = text.indexOf("'", i + 1); if (e === -1) return -1; i = e; }
    else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      if (i >= text.length) return -1;
    } else if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Splits a command text into parts. kind: "bash" | "sh" | "powershell" | "cmd".
 * Returns { parts: [{ words, redirects:[{op,target,fd}], subst:[text], pipedFrom }], unparsed }.
 */
export function parseCommand(cmd, kind = "bash") {
  const posix = kind === "bash" || kind === "sh";
  const ps = kind === "powershell";
  const parts = [];
  const heredocs = [];
  let cur = newPart(false);
  let word = null;
  let wordStart = -1;
  let pending = null; // redirect waiting for its target word
  let unparsed = false;
  const n = cmd.length;

  const pushWord = () => {
    if (word === null) return;
    if (pending) {
      if (pending.heredoc) heredocs.push({ delim: word, strip: pending.strip, quoted: pending.quotedDelim, owner: pending.owner });
      else cur.redirects.push({ op: pending.op, target: word, fd: pending.fd });
      pending = null;
    } else cur.words.push(word);
    word = null;
  };
  const endPart = sep => {
    pushWord();
    if (cur.words.length || cur.redirects.length || cur.subst.length) parts.push(cur);
    cur = newPart(sep === "|");
  };
  const append = s => { if (word === null) { word = ""; wordStart = idx; } word += s; };
  let idx = 0;

  for (let i = 0; i < n; i++) {
    idx = i;
    const c = cmd[i];
    const next = cmd[i + 1];

    if (c === " " || c === "\t" || c === "\r") { pushWord(); continue; }
    if (c === "\n") {
      endPart("\n");
      while (heredocs.length) {
        const h = heredocs.shift();
        let pos = i + 1;
        let found = false;
        const body = [];
        while (pos <= n) {
          let eol = cmd.indexOf("\n", pos);
          if (eol === -1) eol = n;
          const raw = cmd.slice(pos, eol).replace(/\r$/, "");
          const line = h.strip ? raw.replace(/^\t+/, "") : raw;
          if (line === h.delim) { found = true; i = Math.min(eol, n); break; }
          body.push(raw);
          if (eol >= n) break;
          pos = eol + 1;
        }
        if (!found) { unparsed = true; i = n; break; }
        const text = body.join("\n");
        h.owner.bodies.push(text);
        if (!h.quoted) for (const inner of scanSubstitutions(text)) h.owner.subst.push(inner);
      }
      continue;
    }
    if (c === "#" && word === null && (i === 0 || /\s|[;&|(]/.test(cmd[i - 1]))) {
      const eol = cmd.indexOf("\n", i);
      if (eol === -1) break;
      i = eol - 1;
      continue;
    }
    if (c === ";") { endPart(";"); continue; }
    if (c === "|") {
      if (next === "|") { endPart("||"); i++; } else if (next === "&") { endPart("|"); i++; } else endPart("|");
      continue;
    }
    if (c === "&") {
      if (next === "&") { endPart("&&"); i++; continue; }
      if (next === ">") {
        pushWord();
        const append2 = cmd[i + 2] === ">";
        pending = { op: append2 ? "&>>" : "&>", fd: null };
        i += append2 ? 2 : 1;
        continue;
      }
      if (ps && word === null && cur.words.length === 0) continue;
      endPart("&");
      continue;
    }
    if (c === ">" || c === "<") {
      // an fd number glued to the operator ("2>") is part of it
      let fd = null;
      if (word !== null && /^\d+$/.test(word) && wordStart === i - word.length) { fd = word; word = null; } else pushWord();
      if (c === "<" && next === "(") { // process substitution <( )
        const end = matchParen(cmd, i + 1);
        cur.subst.push(cmd.slice(i + 2, end === -1 ? n : end));
        if (end === -1) { unparsed = true; break; }
        append(SUBST);
        i = end;
        continue;
      }
      if (c === ">" && next === "(") {
        const end = matchParen(cmd, i + 1);
        cur.subst.push(cmd.slice(i + 2, end === -1 ? n : end));
        if (end === -1) { unparsed = true; break; }
        append(SUBST);
        i = end;
        continue;
      }
      let op = c;
      if (c === "<" && next === "<" && cmd[i + 2] === "<") { op = "<<<"; i += 2; }
      else if (c === "<" && next === "<") {
        op = "<<"; i++;
        let strip = false;
        if (cmd[i + 1] === "-") { strip = true; i++; }
        // quoted delimiters ('EOF', "EOF", \EOF) mean the body is not expanded
        let j = i + 1;
        while (cmd[j] === " " || cmd[j] === "\t") j++;
        pending = { heredoc: true, strip, quotedDelim: /^['"\\]/.test(cmd[j] || ""), owner: cur };
        continue;
      } else if (next === c) { op = c + c; i++; }
      else if (c === ">" && next === "|") { op = ">|"; i++; }
      else if (next === "&") { op = c + "&"; i++; }
      else if (c === "<" && next === ">") { op = "<>"; i++; }
      pending = { op, fd };
      continue;
    }
    if (c === "(") {
      if (ps) {
        const end = matchParen(cmd, i);
        if (end === -1) { unparsed = true; break; }
        cur.subst.push(cmd.slice(i + 1, end));
        append(SUBST);
        i = end;
      } else endPart("(");
      continue;
    }
    if (c === ")") { endPart(")"); continue; }
    if ((c === "{" || c === "}") && word === null && (next === undefined || /\s/.test(next) || c === "}")) { endPart(c); continue; }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) { unparsed = true; append(cmd.slice(i + 1)); break; }
      append(cmd.slice(i + 1, end));
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = "";
      let closed = false;
      for (; j < n; j++) {
        const d = cmd[j];
        if (d === '"') { closed = true; break; }
        if (posix && d === "\\" && j + 1 < n) {
          const e = cmd[j + 1];
          if (e === "$" || e === "`" || e === '"' || e === "\\") { text += e; j++; continue; }
          if (e === "\n") { j++; continue; }
          text += d;
          continue;
        }
        if (d === "$" && cmd[j + 1] === "(") {
          const end = matchParen(cmd, j + 1);
          if (end === -1) { unparsed = true; break; }
          cur.subst.push(cmd.slice(j + 2, end));
          text += SUBST;
          j = end;
          continue;
        }
        if (d === "`") {
          const end = cmd.indexOf("`", j + 1);
          if (end === -1) { unparsed = true; break; }
          cur.subst.push(cmd.slice(j + 1, end));
          text += SUBST;
          j = end;
          continue;
        }
        text += d;
      }
      if (!closed) unparsed = true;
      append(text);
      i = j;
      if (unparsed && !closed) break;
      continue;
    }
    if (c === "\\" && posix) {
      if (next === "\n") { i++; continue; }
      if (next !== undefined) { append(next); i++; }
      continue;
    }
    if (c === "^" && kind === "cmd") {
      if (next !== undefined && next !== "\n") { append(next); i++; }
      continue;
    }
    if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end === -1) { unparsed = true; break; }
      cur.subst.push(cmd.slice(i + 1, end));
      append(SUBST);
      i = end;
      continue;
    }
    if (c === "$" && next === "(") {
      const end = matchParen(cmd, i + 1);
      if (end === -1) { unparsed = true; break; }
      const inner = cmd.slice(i + 2, end);
      if (inner.startsWith("(") && inner.endsWith(")")) { for (const s of scanSubstitutions(inner)) cur.subst.push(s); }
      else cur.subst.push(inner);
      append(SUBST);
      i = end;
      continue;
    }
    if (c === "$" && next === "{") {
      const end = cmd.indexOf("}", i + 2);
      const body = cmd.slice(i, end === -1 ? n : end + 1);
      for (const s of scanSubstitutions(body)) cur.subst.push(s);
      append(body);
      if (end === -1) { unparsed = true; break; }
      i = end;
      continue;
    }
    append(c);
  }
  pushWord();
  if (pending) unparsed = true;
  endPart(null);
  return { parts, unparsed };
}

// ---------------------------------------------------------------------------------------------------
// Vocabulary

const WIN_EXT = /\.(exe|cmd|bat|com)$/i;
const baseOf = word => String(word).split(/[\\/]/).pop().replace(WIN_EXT, "").toLowerCase();

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh"]);
const POWERSHELLS = new Set(["powershell", "pwsh", "powershell_ise"]);
const SCRIPT_RUNNERS = new Set(["python", "python3", "py", "node", "deno", "bun", "perl", "ruby", "php", "lua"]);
const INTERPRETERS = new Set([...SHELLS, ...POWERSHELLS, ...SCRIPT_RUNNERS, "cmd", "iex", "invoke-expression", "wsl"]);
const DOWNLOADERS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "start-bitstransfer", "bitsadmin", "aria2c"]);
const ELEVATORS = new Set(["sudo", "doas", "runas", "pkexec", "gsudo", "su"]);
const DISK_TOOLS = new Set(["fdisk", "sfdisk", "cfdisk", "parted", "gparted", "sgdisk", "wipefs", "diskpart", "mkswap", "bcdedit", "clear-disk", "initialize-disk", "format-volume", "remove-partition", "set-disk", "mke2fs", "mkntfs", "newfs", "diskutil"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff", "telinit", "restart-computer", "stop-computer", "logoff", "tsshutdn"]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "del", "erase", "rd", "remove-item", "ri", "rimraf", "srm"]);
const WRITERS = new Set(["cp", "mv", "ln", "tee", "touch", "mkdir", "install", "truncate", "rsync", "copy", "move", "xcopy", "robocopy", "mklink", "new-item", "set-content", "out-file", "add-content", "copy-item", "move-item", "rename-item", "ren", "rename", "ni", "cpi", "mi", "attrib"]);

const PS_READONLY = new Set([
  "get-childitem", "gci", "get-content", "gc", "get-location", "gl", "get-item", "gi", "get-itemproperty", "gp", "select-string", "sls",
  "test-path", "resolve-path", "rvpa", "get-process", "gps", "get-date", "get-filehash", "get-command", "gcm", "get-help", "get-alias", "gal",
  "get-host", "get-psdrive", "gdr", "get-variable", "gv", "get-member", "gm", "get-computerinfo", "get-service", "gsv", "get-netipaddress",
  "get-hotfix", "get-acl", "get-eventlog", "get-winevent", "get-volume", "get-disk", "measure-object", "measure", "select-object", "select",
  "sort-object", "format-table", "ft", "format-list", "fl", "format-wide", "out-string", "write-output", "write-host", "convertto-json",
  "convertfrom-json", "split-path", "join-path", "compare-object", "get-childitemproperty", "get-timezone", "get-culture", "set-location", "sl",
]);

const SIMPLE_READONLY = new Set([
  "ls", "dir", "pwd", "cd", "chdir", "echo", "printf", "cat", "type", "head", "tail", "wc", "nl", "tac", "rev", "file", "stat", "du", "df",
  "which", "whoami", "uname", "id", "groups", "uptime", "arch", "nproc", "free", "basename", "dirname", "realpath", "readlink", "cut", "tr",
  "comm", "column", "fold", "expand", "unexpand", "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "b2sum", "grep",
  "egrep", "fgrep", "true", "false", "test", "[", "[[", ":", "ps", "locale", "sleep", "tasklist",
  "systeminfo", "ver", "vol", "findstr", "fc", "netstat", "getconf", "lsb_release",
]);
// Read-only only for some argument shapes; readonlyArgsOk() decides.
const CONDITIONAL_READONLY = new Set(["sort", "uniq", "date", "hostname", "find", "tree", "where", "ipconfig", "rg", "ag", "ack"]);

// Commands whose arguments are not file names, so an absolute-looking word there is not "reading outside".
const NO_PATH_ARGS = new Set(["echo", "printf", "true", "false", "test", "[", "[[", ":", "write-output", "write-host", "sleep", "uname", "id"]);

const VERSION_TOOLS = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3", "py", "pip", "pip3", "ruby", "gem", "go", "cargo", "rustc", "rustup", "dotnet", "java", "javac", "git", "gcc", "g++", "clang", "make", "cmake", "php", "composer", "tsc", "eslint", "prettier", "docker", "kubectl", "terraform", "uv", "poetry", "pytest", "vite", "next", "jest", "mocha", "gh", "ruff", "black"]);
const VERSION_ARGS = new Set(["--version", "-v", "-V", "-version", "version", "--help", "-h", "-?"]);

const GIT_READONLY_SUBS = new Set(["status", "log", "diff", "show", "show-branch", "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "describe", "blame", "annotate", "shortlog", "whatchanged", "cat-file", "diff-tree", "diff-index", "diff-files", "for-each-ref", "name-rev", "merge-base", "count-objects", "check-ignore", "check-attr", "var", "version", "help", "grep", "verify-commit", "verify-tag", "fsck", "range-diff", "cherry", "show-ref"]);
const GIT_UNSAFE_ARGS = /^(--output(=.*)?|--ext-diff|--open-files-in-pager.*|--exec(=.*)?|-O.*)$/;
const NPM_READONLY_SUBS = new Set(["ls", "list", "ll", "la", "why", "explain", "view", "info", "show", "v", "outdated", "root", "prefix", "bin", "help", "search", "whoami", "ping", "fund", "licenses"]);

// Flags that hand the interpreter a piece of code on the command line.
const INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-command", "/c", "/k", "-encodedcommand", "-enc", "-ec"]);

// Names that are not catastrophic to delete from but whose parameters look like flags.
const PS_PATH_PARAMS = /^-(path|literalpath|include|exclude|filter)$/i;

// ---------------------------------------------------------------------------------------------------
// Targets

function toNativeLike(word) {
  // Git Bash writes drive letters as /c/Users/...
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(word);
  return m ? { text: `${m[1]}:${m[2] || "/"}`, windows: true } : { text: word, windows: /^[a-zA-Z]:([\\/]|$)/.test(word) };
}

const ROOTISH_VARS = /^(\$\{?home\}?|\$\{?env:(userprofile|homedrive|homepath|systemroot|windir|programfiles|programdata|systemdrive|allusersprofile|public)\}?|%(userprofile|homedrive|homepath|systemroot|windir|programfiles|programdata|systemdrive|allusersprofile|public)%|\$pshome)$/i;
const CWD_GLOBS = new Set(["*", "*.*", ".", "./*", ".*", "./.*", "./"]);

/**
 * True for targets whose recursive removal / permission change would be a disaster: filesystem and drive roots,
 * home, first-level folders, user folders, system folders, and (unless `cwdGlobs` is false) bare "*" and ".".
 */
export function isDangerousTarget(raw, { env = process.env, cwdGlobs = true } = {}) {
  let t = String(raw ?? "").trim().replace(/^["']+|["']+$/g, "").replace(/[;)\]}]+$/, "");
  if (!t || t.includes(SUBST)) return false;
  t = t.replace(/\\/g, "/");
  // "/tmp/../" and "C:/Users/x/.." are the places they lead to.
  if (/^(\/|[a-zA-Z]:)/.test(t) && t.includes("..")) t = path.posix.normalize(t);
  let lower = t.toLowerCase();
  if (lower.length > 1) lower = lower.replace(/\/+$/, "") || "/";
  if (CWD_GLOBS.has(t.toLowerCase()) || CWD_GLOBS.has(lower)) return cwdGlobs;
  if (["/", "/*", "~", "~/*", "~/.*", "..", "../*", "../..", "../../*"].includes(lower)) return true;
  const wildcardTail = /\/\*(\.\*)?$/;
  if (wildcardTail.test(lower)) return isDangerousTarget(lower.replace(wildcardTail, "") || "/", { env, cwdGlobs: false });
  const bare = lower;
  if (ROOTISH_VARS.test(bare)) return true;
  if (/^\/[a-z]$/.test(bare) || /^\/[^/*]+$/.test(bare)) return true;
  if (/^\/(home|users)\/[^/*]+$/.test(bare)) return true;
  // Drive paths, also in the Git Bash spelling /c/Users
  const mount = /^\/([a-z])(\/.*)?$/.exec(bare);
  const drive = mount ? `${mount[1]}:${mount[2] || "/"}` : bare;
  if (/^[a-z]:\/?\*?$/.test(drive) || /^[a-z]:\/[^/*]+$/.test(drive) || /^[a-z]:\/users\/[^/*]+$/.test(drive)) return true;
  const native = toNativeLike(t);
  if (/^(\/|[a-zA-Z]:)/.test(native.text)) {
    try { if (isSystemPath(native.windows ? native.text.replace(/\//g, "\\") : native.text, { platform: native.windows ? "win32" : "linux", env })) return true; } catch { return false; }
  }
  return false;
}

function isSystemLike(word, env) {
  const w = String(word ?? "").replace(/^["']+|["']+$/g, "");
  if (!/^(\/|[a-zA-Z]:|%|\$env:)/.test(w)) return false;
  if (/^(%|\$env:)(systemroot|windir|programfiles)/i.test(w)) return true;
  const native = toNativeLike(w.replace(/\\/g, "/"));
  try { return isSystemPath(native.windows ? native.text.replace(/\//g, "\\") : native.text, { platform: native.windows ? "win32" : "linux", env }); } catch { return false; }
}

const NULL_TARGETS = new Set(["/dev/null", "nul", "$null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty"]);

// ---------------------------------------------------------------------------------------------------
// Judging one command (a list of words)

function mkResult() { return { level: 0, reasons: [], keys: [], remember: true, secret: false }; }
function raise(res, level, reason, { forget = false } = {}) {
  if (level > res.level) res.level = level;
  if (reason && !res.reasons.includes(reason)) res.reasons.push(reason);
  if (forget) res.remember = false;
}
function merge(into, from) {
  if (from.level > into.level) into.level = from.level;
  for (const r of from.reasons) if (!into.reasons.includes(r)) into.reasons.push(r);
  for (const k of from.keys) if (!into.keys.includes(k)) into.keys.push(k);
  if (!from.remember) into.remember = false;
  if (from.secret) into.secret = true;
}

const isFlag = w => /^-/.test(w);

// What "allow for this session" remembers. For project scripts and build steps the key is the program and its first
// word ("npm test", "git commit", "cargo build"): a later run with other arguments is the same kind of action.
// For anything else the key is the WHOLE command text, because the words after the first two change what it does
// (rm -rf a ../b, curl url -o file, npm install some-package, ssh host rm -rf x, docker run -v /:/host ...).
const PREFIX_SUBS = {
  npm: ["test", "t", "start", "build", "lint", "format", "typecheck", "check", "dev"],
  pnpm: ["test", "t", "start", "build", "lint", "format", "typecheck", "check", "dev"],
  yarn: ["test", "start", "build", "lint", "format", "typecheck", "check", "dev"],
  bun: ["test", "build"],
  cargo: ["build", "test", "check", "clippy", "fmt", "doc", "bench", "clean"],
  go: ["build", "test", "vet", "fmt"],
  dotnet: ["build", "test", "format"],
  git: ["add", "commit", "fetch", "pull", "status", "diff", "log", "show"],
};
const RUN_SUBS = new Set(["run", "run-script"]);
const SCRIPT_TOOLS = new Set(["pytest", "jest", "vitest", "mocha", "tsc", "eslint", "prettier", "ruff", "black", "mypy"]);
const SCRIPT_RUNNERS_KEYED = new Set(["node", "python", "python3", "py", "deno", "ruby", "php", "perl"]);
const SAFE_PY_MODULES = new Set(["pytest", "unittest", "black", "ruff", "mypy", "flake8", "pylint", "isort"]);

function keyFor(base, words) {
  const exact = () => { const text = words.join(" "); return text.length <= 200 ? text : null; };
  const rest = words.slice(1);
  if (INTERPRETERS.has(base) && rest.some(w => INLINE_FLAGS.has(w.toLowerCase()))) return null;
  const sub = rest[0];
  if (sub === undefined) return base;
  if (SCRIPT_TOOLS.has(base)) return base;
  if (isFlag(sub) || (base === "cmd" && /^\/[a-z]$/i.test(sub))) {
    if (SCRIPT_RUNNERS_KEYED.has(base) && sub === "-m" && SAFE_PY_MODULES.has(rest[1])) return `${base} -m ${rest[1]}`;
    return exact();
  }
  if (PREFIX_SUBS[base]) {
    if (PREFIX_SUBS[base].includes(sub)) return `${base} ${sub}`;
    if (RUN_SUBS.has(sub) && rest[1] && !isFlag(rest[1])) return `${base} ${sub} ${rest[1]}`;
    return exact();
  }
  if (base === "make") return `make ${sub}`;
  if (SCRIPT_RUNNERS_KEYED.has(base) && (/\.[A-Za-z0-9]{1,5}$/.test(sub) || sub.includes("/"))) return `${base} ${sub}`;
  return exact();
}

function gitSub(args) {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-C" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") { i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(a) || ["--no-pager", "--no-optional-locks", "-p", "--paginate", "--bare", "--literal-pathspecs"].includes(a)) { i++; continue; }
    if (a === "-c" || /^--config-env/.test(a) || a === "--exec-path" || /^--exec-path=/.test(a) || a === "--super-prefix") return { sub: "", rest: [], unsafeGlobal: true };
    break;
  }
  return { sub: args[i] || "", rest: args.slice(i + 1), unsafeGlobal: false };
}

function gitReadonly(args) {
  const { sub, rest, unsafeGlobal } = gitSub(args);
  if (unsafeGlobal || !sub) return false;
  if (rest.some(a => GIT_UNSAFE_ARGS.test(a))) return false;
  if (GIT_READONLY_SUBS.has(sub)) return true;
  const flags = rest.filter(isFlag);
  const positional = rest.filter(a => !isFlag(a));
  switch (sub) {
    case "branch":
      if (flags.some(f => /^(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|-f|--force|-u|--set-upstream-to.*|--unset-upstream|--edit-description|-t|--track|--no-track)$/.test(f))) return false;
      return positional.length === 0 || flags.some(f => f === "--list" || f === "-l");
    case "tag":
      if (flags.some(f => /^(-d|--delete|-a|-s|-m|-f|--force|-u|--annotate|--sign|-F|-e|-v|--verify)$/.test(f))) return false;
      return positional.length === 0 || flags.some(f => f === "-l" || f === "--list");
    case "remote": return positional.length === 0 || positional[0] === "show" || positional[0] === "get-url";
    case "stash": return positional[0] === "list" || positional[0] === "show";
    case "config": {
      const reads = flags.some(f => /^(--get|--get-all|--show-origin|--show-scope|--name-only)$/.test(f));
      const writes = flags.some(f => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section|--file|-f|--system)$/.test(f));
      return reads && !writes;
    }
    case "reflog": return positional.length === 0 || positional[0] === "show";
    case "worktree": return positional[0] === "list";
    case "notes": return positional[0] === "list" || positional[0] === "show";
    case "submodule": return positional[0] === "status";
    default: return false;
  }
}

function npmReadonly(args) {
  const positional = args.filter(a => !isFlag(a));
  const sub = positional[0];
  if (!sub) return false;
  if (NPM_READONLY_SUBS.has(sub)) return true;
  if (sub === "config" && ["get", "list", "ls"].includes(positional[1])) return true;
  if (sub === "pkg" && positional[1] === "get") return true;
  return sub === "audit" && !positional.includes("fix");
}

function readonlyArgsOk(base, args, kind) {
  const lower = args.map(a => a.toLowerCase());
  switch (base) {
    case "sort": return !args.some(a => /^-[a-zA-Z]*o/.test(a) || /^--(output|compress-program)/.test(a));
    case "rg": case "ag": case "ack": return !args.some(a => /^--(pre|pre-glob|pager|hostname-bin)(=|$)/.test(a));
    case "tree": return !args.some(a => /^-[a-zA-Z]*o/.test(a) && !/^--/.test(a));
    case "uniq": return args.filter(a => !isFlag(a)).length <= 1;
    case "date": return !args.some(a => /^(-s|--set)/.test(a)) && (kind !== "cmd" || lower.includes("/t"));
    case "hostname": return args.length === 0 || args.every(a => /^-[a-zA-Z]$/.test(a) && a !== "-F");
    case "find": return !args.some(a => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a));
    case "ipconfig": return args.length === 0 || (args.length === 1 && lower[0] === "/all");
    case "where": return kind !== "powershell";
    default: return true;
  }
}

const HOME_VARS = /^(\$\{?|%|\$env:)(HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|PROGRAMFILES|TEMP|TMP|TMPDIR)/i;

/** Outside-the-project check for the arguments of read-only commands (links and ".." included). */
function pointsOutside(words, { cwd, platform, kind }) {
  for (const raw of words) {
    let w = raw;
    if (kind !== "bash" && kind !== "sh" && /^\/[a-z?](:\S*)?$/i.test(w)) continue; // /b, /s, /a:d are switches here
    const eq = /^--?[A-Za-z][\w-]*=(.*)$/.exec(w);
    if (eq) w = eq[1];
    else if (isFlag(w)) continue;
    if (!w || w.includes(SUBST) || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) continue;
    if (NULL_TARGETS.has(w.toLowerCase())) continue;
    if (HOME_VARS.test(w)) return true;
    // Only the literal part before a wildcard names a place.
    const magic = w.search(/[*?[\]{}|<>"]/);
    let probe = magic === -1 ? w : w.slice(0, magic);
    if (!probe) continue;
    if (platform === "win32") {
      const m = /^\/([a-zA-Z])(\/.*)?$/.exec(probe);
      if (m) probe = `${m[1]}:${m[2] || "/"}`;
    }
    // A word the platform cannot use as a path at all (reserved names, stray colons) is not one.
    const g = guardPath(probe, { cwd, platform });
    if (g.ok && !g.inside) return true;
  }
  return false;
}

// Reading an environment variable that smells like a credential (or listing the Env: drive) exposes a secret.
const SENSITIVE_VAR = /(\$\{?(env:)?|%)[A-Za-z_]*(token|secret|key|pass|pwd|credential|auth|cookie|session)[A-Za-z_]*|^env:/i;

// Names a wildcard in a command that reads file contents might stand for.
const SECRET_SAMPLES = [".env", ".env.local", ".env.production", ".env.development", ".npmrc", ".netrc", ".pgpass", ".pypirc", ".htpasswd", ".git-credentials",
  "id_rsa", "id_ed25519", "id_ecdsa", "credentials", "credentials.json", "secrets.json", "secrets.yaml", "server.pem", "private.key", "cert.pfx", "keystore.jks"];
// Commands that only list names or print their own arguments: a wildcard there reads no contents.
const NAMES_ONLY = new Set(["ls", "dir", "gci", "get-childitem", "echo", "printf", "write-output", "write-host", "test", "[", "[[", "true", "false", "pwd", "cd", "chdir", "set-location", "sl", "which", "where", "find"]);

function wildcardReachesSecret(word) {
  const last = word.split(/[\\/]/).pop();
  if (!/[*?[]/.test(last) || /^\*+(\.\*+)?$/.test(last)) return false; // a bare * says nothing about secrets
  let re;
  try { re = globToRegExp(last); } catch { return false; }
  return SECRET_SAMPLES.some(name => re.test(name));
}

function secretWord(w, platform, { globs = false } = {}) {
  let word = String(w).replace(/^--?[A-Za-z][\w-]*=/, "");
  if (SENSITIVE_VAR.test(word)) return true;
  // Windows ignores a trailing dot or space and opens "name::$DATA" or "name:stream" as "name".
  word = word.replace(/:[^\\/]*$/, "").replace(/[. ]+$/, "");
  if (globs && wildcardReachesSecret(word)) return true;
  if (!word || word.includes(SUBST) || /[*+?|^$()[\]{}]/.test(word.replace(/^\.\//, ""))) return false;
  const bare = !/[\\/]/.test(word);
  if (bare && /^credentials$/i.test(word)) return false;
  if (bare && !/^(\.|id_)/.test(word) && !/\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i.test(word) && !/^(secrets?\.(json|ya?ml|toml)|credentials\.\w+)$/i.test(word)) return false;
  return isSecretPath(word, platform);
}

function deletionJudge(base, args, res, env, kind) {
  const targets = [];
  let recursive = false, force = false, noPreserve = false;
  const cmdStyle = base === "del" || base === "erase" || base === "rd" || (base === "rmdir" && kind === "cmd");
  for (const a of args) {
    const la = a.toLowerCase();
    if (a === "--") continue;
    if (la === "--no-preserve-root") { noPreserve = true; continue; }
    if (la === "--recursive") { recursive = true; continue; }
    if (la === "--force") { force = true; continue; }
    if (cmdStyle && /^\/[a-z](:.*)?$/i.test(a)) { if (la === "/s") recursive = true; if (la === "/q" || la === "/f") force = true; continue; }
    if (/^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(a)) { recursive = true; continue; }
    if (/^-f(o(r(c(e)?)?)?)?$/i.test(a)) { force = true; continue; }
    if (PS_PATH_PARAMS.test(a)) continue;
    if (/^-[a-zA-Z]+$/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      if (/f/.test(a)) force = true;
      continue;
    }
    targets.push(a);
  }
  const wild = targets.some(t => /^(\.\/)?\*(\.\*)?$/.test(t));
  const registry = targets.some(t => /^(hklm|hkcu|hkcr|hku|registry::)/i.test(t));
  const dangerous = targets.some(t => isDangerousTarget(t, { env }));
  if (noPreserve || registry || (dangerous && (recursive || force || wild || base === "rimraf"))) raise(res, 2, registry ? "registry" : "recursiveDelete", { forget: true });
  else raise(res, 1, "");
  if (targets.some(t => isSystemLike(t, env))) raise(res, 2, "systemWrite", { forget: true });
}

function judgeGit(args, res) {
  const { sub, rest, unsafeGlobal } = gitSub(args);
  if (unsafeGlobal) { raise(res, 1, "gitConfigOverride", { forget: true }); return; }
  const flags = rest.filter(isFlag);
  const positional = rest.filter(a => !isFlag(a));
  if (sub === "push" && (flags.some(f => /^(--force|--force-with-lease(=.*)?|--force-if-includes|--mirror)$/.test(f) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) || positional.some(p => /^\+/.test(p)))) raise(res, 2, "forcePush", { forget: true });
  else if (sub === "push" && (flags.some(f => f === "--delete" || f === "-d") || positional.some(p => p.startsWith(":")))) raise(res, 2, "remoteDelete", { forget: true });
  else if (sub === "reset" && flags.includes("--hard")) raise(res, 2, "hardReset", { forget: true });
  else if (sub === "clean" && flags.some(f => /^(--force|-[a-zA-Z]*f[a-zA-Z]*)$/.test(f))) raise(res, 2, "gitClean", { forget: true });
  else if ((sub === "checkout" || sub === "switch" || sub === "restore") && flags.some(f => f === "--force" || f === "-f" || f === "--discard-changes")) raise(res, 2, "discardChanges", { forget: true });
  else if (sub === "filter-branch" || sub === "filter-repo") raise(res, 2, "rewriteHistory", { forget: true });
  else if (sub === "config") {
    // Settings such as core.fsmonitor or core.hooksPath make git start programs on later, harmless-looking commands.
    const reads = flags.some(f => /^(--get(-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l|--show-origin|--show-scope|--name-only|--help|-h)$/.test(f));
    const writes = flags.some(f => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(f));
    if (writes || (!reads && positional.length >= 2)) raise(res, 2, "gitInternal", { forget: true });
  }
}

/** Does this interpreter invocation take its program from standard input (so a pipe feeds it code)? */
function readsProgramFromStdin(base, args) {
  const positional = args.filter(a => !isFlag(a));
  const lower = args.map(a => a.toLowerCase());
  if (base === "iex" || base === "invoke-expression") return true;
  if (SHELLS.has(base)) return !args.some(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) && positional.length === 0;
  if (POWERSHELLS.has(base)) return !lower.some(a => /^-(f|file|enc|encodedcommand|e)$/.test(a)) && !lower.some((a, i) => /^-(c|command)$/.test(a) && lower[i + 1] && lower[i + 1] !== "-");
  if (base === "cmd") return !lower.some(a => /^\/[ck]/.test(a));
  if (SCRIPT_RUNNERS.has(base)) return positional.length === 0 && !args.some(a => /^-(c|e|m|p|r)$/.test(a) || a === "--eval" || a === "--print") || args.includes("-");
  return false;
}

/** Judges one command given as words. Returns a result object; recursion handles wrappers. */
function judgeWords(input, ctx, depth) {
  const res = mkResult();
  const words = input.slice();
  const { kind, env, cwd, platform } = ctx;
  if (depth > 5) { raise(res, 1, "nested", { forget: true }); return res; }

  // NAME=value prefixes
  let sawAssign = false;
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const name = words.shift().split("=")[0];
    sawAssign = true;
    if (/^(PATH|LD_.*|DYLD_.*|NODE_OPTIONS|PYTHON.*|GIT_.*|BASH_ENV|ENV|PROMPT_COMMAND|IFS|SHELL|PS4|PSModulePath)$/i.test(name)) raise(res, 1, "envOverride", { forget: true });
  }
  while (words.length && CONTROL_SKIP.has(words[0])) words.shift();
  if (words.length && CONTROL_IGNORE.has(words[0])) return res;
  if (!words.length) return res;

  const first = words[0];
  const base = baseOf(first);
  const args = words.slice(1);
  const lowerArgs = args.map(a => a.toLowerCase());

  // secrets: any word that names a credential file
  for (const w of args) if (secretWord(w, platform, { globs: !NAMES_ONLY.has(base) })) { res.secret = true; raise(res, 2, "secret", { forget: true }); }

  // --- elevation
  if (ELEVATORS.has(base)) {
    raise(res, 2, "elevated", { forget: true });
    let i = 0;
    while (i < args.length && isFlag(args[i])) i += /^-(u|g|h|p|C|r|t|U)$/.test(args[i]) ? 2 : 1;
    if (i < args.length) merge(res, judgeWords(args.slice(i), ctx, depth + 1));
    return res;
  }
  // --- wrappers that run another command
  if (base === "env" && args.length) {
    let i = 0;
    while (i < args.length && (isFlag(args[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]))) i += /^-(u|C|S)$/.test(args[i]) ? 2 : 1;
    if (i >= args.length) return res;
    merge(res, judgeWords(args.slice(i), ctx, depth + 1));
    return res;
  }
  if (["nohup", "nice", "ionice", "time", "command", "builtin", "exec", "setsid", "stdbuf", "timeout", "unbuffer", "caffeinate", "start", "call"].includes(base) && args.length) {
    if (base === "command" && (lowerArgs[0] === "-v" || lowerArgs[0] === "-V")) return res;
    let i = 0;
    while (i < args.length && (isFlag(args[i]) || (kind === "cmd" && /^\/[a-z]+$/i.test(args[i])))) i += /^-(n|p|c|s|k|o|e|i|l)$/.test(args[i]) && ["nice", "ionice", "timeout", "stdbuf"].includes(base) ? 2 : 1;
    if (base === "timeout" && i < args.length) i++;
    if (i >= args.length) return res;
    merge(res, judgeWords(args.slice(i), ctx, depth + 1));
    return res;
  }
  if (base === "xargs" && args.length) {
    let i = 0;
    while (i < args.length && isFlag(args[i])) i += /^-(n|I|P|d|L|s|E|a|l|i)$/.test(args[i]) ? 2 : 1;
    if (i < args.length) {
      const inner = judgeWords(args.slice(i), ctx, depth + 1);
      inner.level = Math.max(inner.level, 1);
      inner.remember = false;
      merge(res, inner);
    } else raise(res, 1, "", { forget: true });
    return res;
  }
  if (base === "wsl" && args.length) {
    let i = 0;
    while (i < args.length && isFlag(args[i]) && args[i] !== "--") i += /^(-d|--distribution|-u|--user|--cd)$/.test(args[i]) ? 2 : 1;
    if (args[i] === "--") i++;
    if (i < args.length) merge(res, judgeWords(args.slice(i), ctx, depth + 1));
    raise(res, 1, "", { forget: true });
    return res;
  }
  if (SHELLS.has(base)) {
    const ci = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (ci !== -1 && args[ci + 1] !== undefined) {
      merge(res, inner(args.slice(ci + 1).join(" "), "bash"));
      raise(res, 1, "");
      return res;
    }
    raise(res, 1, "");
    const script = args.find(a => !isFlag(a));
    res.keys.push(script ? `${base} ${script}` : base);
    return res;
  }
  if (POWERSHELLS.has(base)) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (/^-(c|co|com|comm|comma|comman|command)$/.test(a) && args[i + 1] !== undefined) {
        merge(res, inner(args.slice(i + 1).join(" "), "powershell"));
        raise(res, 1, "");
        return res;
      }
      if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/.test(a) && args[i + 1] !== undefined) {
        let decoded = null;
        try { decoded = Buffer.from(args[i + 1], "base64").toString("utf16le"); } catch { decoded = null; }
        if (decoded && !decoded.includes("\ufffd")) merge(res, inner(decoded, "powershell"));
        else raise(res, 2, "unparsed", { forget: true });
        raise(res, 1, "", { forget: true });
        return res;
      }
    }
    raise(res, 1, "");
    const fileAt = lowerArgs.findIndex(a => a === "-file" || a === "-f");
    const script = fileAt !== -1 ? args[fileAt + 1] : args.find(a => !isFlag(a));
    res.keys.push(script ? `${base} ${script}` : base);
    return res;
  }
  if (base === "cmd") {
    const ci = args.findIndex(a => /^\/[ck]/i.test(a));
    if (ci !== -1) {
      const payload = [args[ci].slice(2), ...args.slice(ci + 1)].filter(Boolean).join(" ");
      merge(res, inner(payload, "cmd"));
      raise(res, 1, "");
      return res;
    }
    raise(res, 1, "");
    res.keys.push("cmd");
    return res;
  }
  if (base === "eval" || base === "iex" || base === "invoke-expression") {
    if (args.length) merge(res, inner(args.join(" ").replace(new RegExp(SUBST, "g"), " "), ctx.kind));
    raise(res, 1, "", { forget: true });
    return res;
  }
  if (base === "find") {
    const execAt = args.findIndex(a => /^-(exec|execdir|ok|okdir)$/.test(a));
    if (execAt !== -1) {
      const end = args.findIndex((a, i) => i > execAt && (a === ";" || a === "\\;" || a === "+"));
      merge(res, judgeWords(args.slice(execAt + 1, end === -1 ? args.length : end), ctx, depth + 1));
      raise(res, 1, "", { forget: true });
    }
    if (args.includes("-delete")) {
      const firstPredicate = args.findIndex(a => isFlag(a) || a === "!" || a === "(");
      const roots = args.slice(0, firstPredicate === -1 ? args.length : firstPredicate);
      const filtered = args.some(a => /^-(name|iname|path|ipath|regex|iregex|type|newer|mtime|mmin|atime|ctime|size|user|group|perm|empty|samefile|wholename)$/.test(a));
      const hit = (roots.length ? roots : ["."]).some(r => isDangerousTarget(r, { env, cwdGlobs: !filtered }));
      if (hit) raise(res, 2, "recursiveDelete", { forget: true });
      else raise(res, 1, "", { forget: true });
    }
  }

  function inner(text, shellKind) {
    return classifyInternal(text, { ...ctx, kind: shellKind }, depth + 1);
  }

  // --- always-high commands
  if (DISK_TOOLS.has(base) || base.startsWith("mkfs") || base === "format" || base === "format.com") { raise(res, 2, "diskTool", { forget: true }); return res; }
  if (POWER.has(base) || (base === "init" && /^[06]$/.test(args[0] || ""))) { raise(res, 2, "shutdown", { forget: true }); return res; }
  if (base === "dd") {
    const of = args.find(a => /^of=/i.test(a));
    if (of && /^of=(\/dev\/|\\\\\.\\|\/\/\.\/)/i.test(of)) raise(res, 2, "diskTool", { forget: true });
    else raise(res, 1, "");
    if (of && isSystemLike(of.slice(3), env)) raise(res, 2, "systemWrite", { forget: true });
  }
  if (base === "reg") {
    const sub = lowerArgs[0];
    if (sub === "delete" || sub === "import" || sub === "restore" || (sub === "add" && args.some(a => /^hk(lm|ey_local_machine)/i.test(a)))) raise(res, 2, "registry", { forget: true });
  }
  if (["remove-itemproperty", "set-itemproperty", "new-itemproperty", "clear-itemproperty"].includes(base) && args.some(a => /^(hklm|hkcu|hkcr|hku|registry::)/i.test(a))) raise(res, 2, "registry", { forget: true });
  if (base === "set-executionpolicy" || (base === "vssadmin" && lowerArgs[0] === "delete") || (base === "cipher" && lowerArgs.some(a => a.startsWith("/w")))) raise(res, 2, "systemChange", { forget: true });
  if ((base === "schtasks" && lowerArgs.some(a => /^\/(create|delete|change)$/.test(a))) || (base === "sc" && kind !== "powershell" && /^(create|delete|config|stop)$/.test(lowerArgs[0] || "")) || (base === "net" && /^(user|localgroup|accounts)$/.test(lowerArgs[0] || "")) || (base === "netsh" && /^(advfirewall|firewall)$/.test(lowerArgs[0] || ""))) raise(res, 2, "systemChange", { forget: true });
  if (base === "git") judgeGit(args, res);
  if (["chmod", "chown", "chgrp", "icacls", "takeown"].includes(base)) {
    const recursive = args.some(a => /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive|\/t|\/r)$/i.test(a));
    if (recursive && args.some(a => !isFlag(a) && isDangerousTarget(a, { env, cwdGlobs: false }))) raise(res, 2, "permissions", { forget: true });
    else raise(res, 1, "");
  }
  if (DELETERS.has(base)) deletionJudge(base, args, res, env, kind);
  if (WRITERS.has(base) && args.some(a => !isFlag(a) && isSystemLike(a, env))) raise(res, 2, "systemWrite", { forget: true });
  const sedInPlace = base === "sed" && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
  if (sedInPlace && args.some(a => isSystemLike(a, env))) raise(res, 2, "systemWrite", { forget: true });
  // Hooks and settings under .git are run by git later; a command that writes there is never routine.
  if ((WRITERS.has(base) || sedInPlace || base === "dd") && args.some(a => isGitInternal(a.replace(/^of=/i, "")))) raise(res, 2, "gitInternal", { forget: true });

  if (res.level >= 2) return res;

  // --- inline code is never remembered
  if (INTERPRETERS.has(base) && lowerArgs.some(a => INLINE_FLAGS.has(a))) raise(res, 1, "", { forget: true });

  // --- read-only?
  let readonly = false;
  // A command given with a path (./ls) is whatever that file is, not the trusted tool of that name.
  if (/[\\/]/.test(first)) readonly = false;
  else if (PS_READONLY.has(base)) readonly = !args.some(a => /[{}]/.test(a));
  else if (SIMPLE_READONLY.has(base)) readonly = true;
  else if (CONDITIONAL_READONLY.has(base)) readonly = readonlyArgsOk(base, args, kind);
  else if (base === "git") readonly = gitReadonly(args);
  else if (["npm", "pnpm", "yarn"].includes(base)) readonly = npmReadonly(args) || (args.length === 1 && VERSION_ARGS.has(args[0]));
  else if (base === "pip" || base === "pip3") readonly = /^(list|show|freeze|check|--version|-V)$/.test(args[0] || "x") && args.length <= 3;
  else if (base === "docker") readonly = /^(ps|images|version|info|logs|--version|-v)$/.test(lowerArgs[0] || "x");
  else if (base === "go") readonly = /^(version|env|list)$/.test(lowerArgs[0] || "x");
  else if (base === "cargo") readonly = /^(tree|metadata|version|locate-project|pkgid|--version|-V)$/.test(args[0] || "x");
  else if (base === "dotnet") readonly = /^(--version|--info|--list-sdks|--list-runtimes)$/.test(lowerArgs[0] || "x");
  else if (VERSION_TOOLS.has(base)) readonly = args.length === 1 && VERSION_ARGS.has(args[0]);
  if (readonly && res.level === 0) {
    if (kind === "cmd" && args.some(a => a.includes("%"))) readonly = false;
    if (readonly && !NO_PATH_ARGS.has(base) && pointsOutside(args, { cwd, platform, kind })) {
      raise(res, 1, "outsideRead");
      readonly = false;
    }
    if (readonly) return res;
  }

  // --- everything else: ask, and remember by command prefix
  if (res.level < 1) raise(res, 1, "");
  if (res.remember) {
    const key = keyFor(base, words);
    if (key) { if (!res.keys.includes(key)) res.keys.push(key); } else res.remember = false;
  }
  if (sawAssign) res.remember = res.remember && res.keys.length > 0;
  return res;
}

// ---------------------------------------------------------------------------------------------------
// Whole commands

/** Removes heredoc bodies: they are data (unless fed to an interpreter, which is judged separately). */
function withoutHeredocBodies(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<(-?)\s*(['"\\]?)([A-Za-z_][\w.-]*)\2/.exec(lines[i].replace(/<<</g, ""));
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && (m[1] ? lines[j].replace(/^\t+/, "") : lines[j]).replace(/\r$/, "") !== m[3]) j++;
    if (j < lines.length) { out.push(lines[j]); i = j; }
  }
  return out.join("\n");
}

/** Text with quotes dissolved and every separator turned into a line break, for the quote-blind pass. */
function flatSegments(text) {
  return withoutHeredocBodies(text)
    .replace(/\$\(|`|<\(|>\(/g, "\n")
    .replace(/['"]/g, " ")
    .split(/[;&|(){}\n\r]+/)
    .map(seg => seg.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^[({]+|[)}\];]+$/g, "")).filter(Boolean))
    .filter(words => words.length);
}

const RAW_HIGH = [
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, "forkBomb"],
  [/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&\n]*\|\s*(sudo\s+|env\s+\S+\s+)?(ba|z|da|k|a|c|tc)?sh\b\s*(-s\b[^|;&\n]*|-\s*|$|[;&|)])/i, "downloadExec"],
  [/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&\n]*\|\s*(iex|invoke-expression)\b/i, "downloadExec"],
  [/\b(iex|invoke-expression)\b[^\n]*(\birm\b|\biwr\b|invoke-webrequest|invoke-restmethod|downloadstring|\bcurl\b|\bwget\b|net\.webclient)/i, "downloadExec"],
  [/\b(ba|z|da|k)?sh\b\s+<\(\s*(curl|wget)/i, "downloadExec"],
  [/\b(ba|z|da|k)?sh\b\s+-c\s+["']?\$\(\s*(curl|wget)/i, "downloadExec"],
  [/\beval\b[^\n]*\$\(\s*(curl|wget)/i, "downloadExec"],
  [/>\s*\/dev\/(sd[a-z]|nvme\d|hd[a-z]|disk\d|mmcblk)/i, "diskTool"],
];

const isDownloader = (base, args) => DOWNLOADERS.has(base) || (base === "certutil" && args.some(a => /urlcache/i.test(a)));

/** Internal worker: returns the running total (with numeric level). */
function classifyInternal(text, ctx, depth) {
  const total = mkResult();
  total.parts = [];
  if (!text.trim()) return total;
  if (depth > 5) { raise(total, 1, "nested", { forget: true }); return total; }

  const scanned = withoutHeredocBodies(text);
  for (const [re, reason] of RAW_HIGH) if (re.test(scanned)) raise(total, 2, reason, { forget: true });

  const parsed = parseCommand(text, ctx.kind);
  if (parsed.unparsed) raise(total, 1, "unparsed", { forget: true });

  let pipelineDownload = false;
  let pipelineBodies = [];
  for (const part of parsed.parts) {
    if (!part.pipedFrom) { pipelineDownload = false; pipelineBodies = []; }
    const res = part.words.length ? judgeWords(part.words, ctx, depth) : mkResult();
    const effective = part.words.slice();
    while (effective.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(effective[0]) || CONTROL_SKIP.has(effective[0]))) effective.shift();
    const base = effective.length ? baseOf(effective[0]) : "";
    const args = effective.slice(1);
    total.parts.push(part.words.join(" "));

    // output redirections write files; input redirections of secrets are reads of secrets
    for (const r of part.redirects) {
      const target = String(r.target ?? "");
      if (/^[<>]&$/.test(r.op) || r.op === "<<<") continue;
      if (secretWord(target, ctx.platform)) { res.secret = true; raise(res, 2, "secret", { forget: true }); }
      if (r.op.includes(">") && !NULL_TARGETS.has(target.toLowerCase())) {
        raise(res, 1, "", { forget: true });
        if (isSystemLike(target, ctx.env) || /^\/dev\/(sd|nvme|hd|disk|mmcblk)/i.test(target)) raise(res, 2, "systemWrite", { forget: true });
        if (isGitInternal(target)) raise(res, 2, "gitInternal", { forget: true });
      }
    }
    // substitutions run commands too
    for (const sub of part.subst) {
      const subRes = classifyInternal(sub, ctx, depth + 1);
      if (subRes.level === 2) merge(res, { level: 2, reasons: subRes.reasons, keys: [], remember: false, secret: subRes.secret });
      else raise(res, 1, "", { forget: true });
      if (subRes.secret) res.secret = true;
      if (INTERPRETERS.has(base) && /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b/i.test(sub)) raise(res, 2, "downloadExec", { forget: true });
    }
    // heredoc text handed to an interpreter is code
    const bodies = [...part.bodies, ...(INTERPRETERS.has(base) && part.pipedFrom ? pipelineBodies : [])];
    if (INTERPRETERS.has(base) && bodies.length && readsProgramFromStdin(base, args)) {
      for (const body of bodies) merge(res, classifyInternal(body, { ...ctx, kind: SHELLS.has(base) ? "bash" : POWERSHELLS.has(base) ? "powershell" : base === "cmd" ? "cmd" : ctx.kind }, depth + 1));
      raise(res, 1, "", { forget: true });
    }
    if (pipelineDownload && INTERPRETERS.has(base) && readsProgramFromStdin(base, args)) raise(res, 2, "downloadExec", { forget: true });
    // Whatever is piped into a shell is run as commands.
    else if (part.pipedFrom && (SHELLS.has(base) || POWERSHELLS.has(base) || base === "iex" || base === "invoke-expression") && readsProgramFromStdin(base, args)) raise(res, 2, "pipeToShell", { forget: true });
    if (isDownloader(base, args)) pipelineDownload = true;
    if (part.bodies.length) pipelineBodies = pipelineBodies.concat(part.bodies);
    merge(total, res);
  }

  // quote-blind second pass: it only ever raises the verdict to "high"
  for (const words of flatSegments(text)) {
    const r = judgeWords(words, ctx, depth + 1);
    if (r.level === 2) {
      for (const reason of r.reasons) raise(total, 2, reason, { forget: true });
      if (r.secret) total.secret = true;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------
// The strict gate (added after the security review)
//
// The parser above is a best-effort model of three different shells. Review showed that every gap between that model
// and the real shell (heredoc-versus-arithmetic, typographic quotes, a lone carriage return, ...) lets a "read-only"
// verdict carry a hidden second command, and that several "read-only" programs have flags that write files or reach
// the network. So the parser may still RAISE a verdict, but a command runs without asking only when it is also a
// PLAIN command - ASCII words separated by spaces, none of the characters any shell treats specially - whose program,
// flags and paths are on the short fixed list below. The same restriction applies to "allow for this session": only a
// plain command can be remembered, so a remembered prefix can never vouch for a compound or oddly quoted command.

const PLAIN_WORD = /^[A-Za-z0-9_.\/-][A-Za-z0-9_.\/:=@+,~^-]*$/; // ~ and ^ are inert in the middle of a word (HEAD~1, HEAD^)

/** Words of letters, digits and `_ . / : = @ + , -` only, single-spaced; no quote, operator, expansion or non-ASCII character. */
export function isPlainCommand(command) {
  const text = String(command ?? "");
  if (!text || text.length > 400 || text !== text.trim() || !/^[\x20-\x7e]+$/.test(text)) return false;
  return text.split(/ +/).every(word => PLAIN_WORD.test(word));
}

const VERSION_FLAGS = {
  node: ["-v"], npm: ["-v"], pnpm: ["-v"], yarn: ["-v"], deno: [], bun: ["-v"], python: ["-V"], python3: ["-V"], py: ["-V"],
  pip: ["-V"], pip3: ["-V"], ruby: ["-v"], php: ["-v"], java: ["-version"], javac: ["-version"], tsc: ["-v"],
};
const VERSION_OK = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python", "python3", "py", "pip", "pip3", "ruby", "gem", "cargo", "rustc", "dotnet", "java", "javac", "git", "gcc", "g++", "clang", "make", "cmake", "php", "composer", "tsc", "go", "uv"]);
const POSIX_LS_FLAGS = /^-[1AaFhlRrStdgGLopx]+$/;
const PS_LS_FLAGS = new Set(["-force", "-recurse", "-name", "-directory", "-file", "-hidden"]);
const GIT_AUTO_SUBS = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "describe", "shortlog"]);
const GIT_AUTO_FLAGS = /^(--(short|branch|porcelain|oneline|stat|numstat|shortstat|name-only|name-status|graph|decorate|all|cached|staged|patch|no-color|abbrev-commit|no-merges|merges|first-parent|summary|list|verbose|show-toplevel|is-inside-work-tree|abbrev-ref|tags|dirty|always|show-current|(short|abbrev|max-count)=\d+|porcelain=v?\d)|-[sbanpvrlS]|-vv|-\d+)$/;
const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9_.\/~^-]*$/;

/** A path argument that stays inside the project, away from credentials, `.git` internals, devices and stream tricks. */
function safeProjectPath(arg, ctx) {
  if (!arg || arg.startsWith("-") || arg.startsWith("/") || arg.includes(":") || arg.length > 200) return false;
  if (arg.split("/").some(seg => seg === ".." || seg.toLowerCase() === ".git")) return false;
  if (/(^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^/]*)?(\/|$)/i.test(arg) || /[. ]$/.test(arg)) return false;
  if (isSecretPath(arg, ctx.platform)) return false;
  const guard = guardPath(arg, { cwd: ctx.cwd, platform: ctx.platform });
  return !!(guard && guard.ok && guard.inside && !guard.viaLink && !isSecretPath(guard.abs, ctx.platform) && !isSystemPath(guard.abs, { platform: ctx.platform, env: ctx.env }));
}

const numeric = word => /^\d{1,6}$/.test(word || "");

function strictArgs(base, args, ctx) {
  const paths = (list, { min = 0, max = 20 } = {}) => list.length >= min && list.length <= max && list.every(arg => safeProjectPath(arg, ctx));
  switch (base) {
    case "pwd": return args.every(a => a === "-L" || a === "-P");
    case "whoami": case "hostname": return args.length === 0;
    case "date": return args.length === 0 || (args.length === 1 && args[0] === "-u");
    case "uname": return args.every(a => /^-[asrmno]+$/.test(a));
    case "echo": case "write-output": return true;
    case "which": case "where": return args.length >= 1 && args.length <= 4 && args.every(a => /^[A-Za-z0-9_.-]+$/.test(a));
    case "ls": case "dir": case "gci": case "get-childitem": {
      const rest = args.filter(a => a.startsWith("-"));
      const flagsOk = rest.every(a => POSIX_LS_FLAGS.test(a) || PS_LS_FLAGS.has(a.toLowerCase()));
      return flagsOk && paths(args.filter(a => !a.startsWith("-")));
    }
    case "cat": return paths(args.filter(a => !/^-[nbs]+$/.test(a)), { min: 1 }) && args.every(a => !a.startsWith("-") || /^-[nbs]+$/.test(a));
    case "type": return paths(args, { min: 1 });
    case "get-content": case "gc": {
      const files = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i].toLowerCase();
        if (a === "-raw") continue;
        if (a === "-totalcount" || a === "-tail" || a === "-head") { if (!numeric(args[i + 1])) return false; i++; continue; }
        if (a.startsWith("-")) return false;
        files.push(args[i]);
      }
      return paths(files, { min: 1 });
    }
    case "head": case "tail": {
      const files = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-n" || a === "-c") { if (!numeric(args[i + 1])) return false; i++; continue; }
        if (/^-(n|c)?\d{1,6}$/.test(a)) continue;
        if (a.startsWith("-")) return false;
        files.push(a);
      }
      return paths(files, { min: 1 });
    }
    case "wc": return paths(args.filter(a => !/^-[lwcm]+$/.test(a)), { min: 1 }) && args.every(a => !a.startsWith("-") || /^-[lwcm]+$/.test(a));
    case "git": {
      if (args.length === 1 && args[0] === "--version") return true;
      const sub = args[0];
      if (!GIT_AUTO_SUBS.has(sub)) return false;
      const rest = args.slice(1);
      let pathsOnly = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--") { pathsOnly = true; continue; }
        if (!pathsOnly && a === "-n") { if (!numeric(rest[i + 1])) return false; i++; continue; }
        if (!pathsOnly && a.startsWith("-")) { if (!GIT_AUTO_FLAGS.test(a)) return false; continue; }
        if (sub === "branch") return false; // a name after `branch` creates one
        if (isSecretPath(a, ctx.platform) || a.includes(":") || a.split("/").some(seg => seg === ".." || seg.toLowerCase() === ".git")) return false;
        if (!pathsOnly && GIT_REF.test(a)) continue;
        if (!safeProjectPath(a, ctx)) return false;
      }
      return true;
    }
    default: {
      const flags = VERSION_FLAGS[base];
      return VERSION_OK.has(base) && args.length === 1 && (args[0] === "--version" || (flags || []).includes(args[0]));
    }
  }
}

/** True when the command is plain AND on the short list of things that cannot change anything or leave the machine. */
export function isStrictReadonly(command, ctx) {
  // cmd.exe runs ls.bat / git.cmd from the current folder before looking at PATH, so nothing is trusted there.
  if (ctx.kind === "cmd" || !isPlainCommand(command)) return false;
  const words = String(command).split(/ +/);
  const base = ctx.kind === "powershell" ? words[0].toLowerCase() : words[0];
  if (base !== base.toLowerCase()) return false;
  return strictArgs(base, words.slice(1), ctx);
}

/**
 * Classifies a command text.
 * opts: { shellKind = "bash" | "sh" | "powershell" | "cmd", cwd, platform, env }
 * Returns { risk, reasons, keys, remember, secret, parts }:
 *   keys      session-rule keys of the parts that need approval (what "allow for this session" remembers)
 *   remember  true when those keys may be remembered
 */
export function classifyCommand(command, opts = {}) {
  const ctx = {
    kind: opts.shellKind || "bash",
    cwd: opts.cwd || process.cwd(),
    platform: opts.platform || process.platform,
    env: opts.env || process.env,
  };
  const text = String(command ?? "");
  const total = classifyInternal(text, ctx, 0);
  const plain = isPlainCommand(text);
  // The parser said "nothing to ask about": believe it only for a command on the strict list.
  // Text that is nothing but ASCII white space runs nothing. Other characters that trim() calls blank (a no-break space,
  // NEL, U+2028, a byte order mark) are ordinary characters to a shell, so they do not count as an empty command.
  const blank = /^[ \t\r\n]*$/.test(text);
  if (total.level === 0 && !blank && !isStrictReadonly(text, ctx)) {
    raise(total, 1, "unlisted");
    const words = text.split(/ +/);
    if (plain && words.length) { const key = keyFor(baseOf(words[0]), words); if (key) total.keys.push(key); }
    else total.remember = false;
  }
  // Only a plain command can be remembered for the session.
  if (!plain) { total.remember = false; total.keys = []; }
  const risk = NAMES[total.level];
  const keys = risk === "normal" && total.remember ? total.keys : [];
  return { risk, reasons: total.reasons, keys, remember: keys.length > 0, secret: total.secret, parts: total.parts };
}

/** The session key for a classification (`Bash:<first two words>` per part, joined), or undefined. */
export function sessionKeyOf(classification) {
  return classification.remember ? "Bash:" + classification.keys.join(" && ") : undefined;
}

export { baseOf };
