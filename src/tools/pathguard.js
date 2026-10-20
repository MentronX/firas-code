// Path guard: the single place that turns a path a tool received into a safe absolute path.
// Decisions: paths are resolved against ctx.cwd and then compared twice - once as written (catches ".."),
// once after resolving symlinks / junctions of the deepest existing ancestor (catches a link that leads out
// of the project). `inside` is true only when BOTH agree. Windows rules (reserved device names, trailing
// dots, alternate streams, UNC and device prefixes) are applied by platform flavour, not by the host OS,
// so they can be tested anywhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../util/paths.js";

const flavor = platform => (platform === "win32" ? path.win32 : path.posix);
const fold = (p, platform) => (platform === "win32" ? p.toLowerCase() : p);

const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** True when `child` is `parent` or lies under it. Pure string work, no disk access. */
export function isWithin(parent, child, platform = process.platform) {
  const P = flavor(platform);
  const a = fold(P.resolve(parent), platform);
  const b = fold(P.resolve(child), platform);
  const rel = P.relative(a, b);
  if (rel === "") return true;
  if (P.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + P.sep);
}

/** Key under which a file is remembered in ctx.fileState (case-folded on Windows). */
export function stateKey(abs, platform = process.platform) {
  return fold(flavor(platform).normalize(abs), platform);
}

function bad(code, message) { return { ok: false, code, message }; }

function checkWindowsComponents(abs) {
  const P = path.win32;
  const { root } = P.parse(abs);
  const parts = abs.slice(root.length).split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (/[<>"|?*]/.test(part)) return bad("illegal", `The path contains characters Windows does not allow in file names (${part}).`);
    if (part.includes(":")) return bad("stream", `The path contains ":" in a file name (${part}); alternate data streams are not supported.`);
    if (/[. ]$/.test(part)) return bad("trailing", `File names cannot end with a dot or a space on Windows (${part}).`);
    const stem = part.split(".")[0].replace(/[. ]+$/, "");
    if (WIN_RESERVED.test(stem)) return bad("reserved", `"${part}" is a reserved device name on Windows and cannot be used as a file name.`);
  }
  return null;
}

/** realpath of the deepest ancestor that exists, with the missing tail appended; dangling links are followed. */
function resolveReal(abs, platform, realpath) {
  const P = flavor(platform);
  let current = abs;
  const tail = [];
  for (let hops = 0; hops < 64; hops++) {
    try {
      const real = realpath(current);
      return tail.length ? P.join(real, ...tail.slice().reverse()) : real;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return abs;
    }
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        const target = fs.readlinkSync(current);
        current = P.resolve(P.dirname(current), target);
        continue;
      }
    } catch { /* nothing here yet */ }
    const parent = P.dirname(current);
    if (parent === current) return abs;
    tail.push(P.basename(current));
    current = parent;
  }
  return abs;
}

function expandHome(input, home) {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2));
  return input;
}

/**
 * Resolves a tool path. Returns { ok:true, abs, rel, inside, real, viaLink } or { ok:false, code, message }.
 *   inside   the target is the project folder or below it, even after resolving links
 *   viaLink  it looks inside but a link leads out of the project
 */
export function guardPath(input, { cwd = process.cwd(), platform = process.platform, home = os.homedir(), realpath = fs.realpathSync.native } = {}) {
  if (typeof input !== "string") return bad("empty", "The path must be a string.");
  let raw = input.trim();
  if (raw.length >= 2 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")))) raw = raw.slice(1, -1).trim();
  if (!raw) return bad("empty", "The path is empty.");
  if (raw.includes("\0")) return bad("nul", "The path contains a NUL byte.");
  const P = flavor(platform);
  if (platform === "win32") {
    if (/^[\\/]{2}[.?][\\/]/.test(raw)) return bad("device", "Device paths (\\\\.\\ and \\\\?\\) are not allowed.");
    if (/^[\\/]{2}[^\\/]/.test(raw)) return bad("unc", "Network (UNC) paths are not allowed; map the share to a drive or copy the file into the project.");
  }
  const abs = P.resolve(cwd, expandHome(raw, home));
  if (platform === "win32") {
    const problem = checkWindowsComponents(abs);
    if (problem) return problem;
  }
  const lexicalInside = isWithin(cwd, abs, platform);
  const real = resolveReal(abs, platform, realpath);
  const realCwd = resolveReal(P.resolve(cwd), platform, realpath);
  const realInside = isWithin(realCwd, real, platform);
  const inside = lexicalInside && realInside;
  return { ok: true, abs, rel: P.relative(cwd, abs) || ".", inside, real, viaLink: lexicalInside && !realInside };
}

// ---------------------------------------------------------------------------------------------------
// Sensitive and system locations (shared by the permission engine and the command classifier)

const SECRET_NAME = /^(\.env(\..+)?|.+\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(.*)|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.pgpass|\.htpasswd|\.dockercfg|credentials(\.(json|xml|ya?ml|toml|csv))?|secrets?\.(json|ya?ml|toml)|service-account.*\.json|\.vault-token|\.my\.cnf|\.s3cfg|\.boto|terraform\.tfstate(\.backup)?|.+\.tfvars)$/i;
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults?|schema)$/i;
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".azure"]);

/** True for files that commonly hold credentials: .env*, keys, .ssh/, .npmrc, credentials, this app's own settings. */
export function isSecretPath(p, platform = process.platform) {
  if (typeof p !== "string" || !p) return false;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || "";
  if (ENV_TEMPLATE.test(name)) return false;
  if (SECRET_NAME.test(name)) return true;
  for (const part of parts.slice(0, -1)) if (SECRET_DIRS.has(part.toLowerCase())) return true;
  if (SECRET_DIRS.has(name.toLowerCase())) return true;
  const lower = p.replace(/\\/g, "/").toLowerCase();
  // A repository's own settings often carry a token inside a remote URL.
  if (/(^|\/)\.git\/config$/.test(lower) || /(^|\/)\.docker\/config\.json$/.test(lower) || /(^|\/)\.config\/(gcloud|gh)\//.test(lower)) return true;
  try {
    const own = fold(flavor(platform).resolve(homeDir()), platform);
    const abs = fold(flavor(platform).resolve(p), platform);
    const rel = flavor(platform).relative(own, abs);
    if (rel === "") return true;
    // The app's own folder also holds its source and skills; only the settings and the saved
    // conversations are secrets. Marking the whole folder made every project under it look secret.
    const first = rel.split(/[\\/]+/)[0].toLowerCase();
    if (first === "config.json" || first === "config.json.bad" || first === "sessions") return true;
  } catch { /* relative junk is not ours */ }
  return false;
}

/**
 * True for anything inside a repository's `.git` entry (or that entry itself: a worktree's `.git` is a file that
 * points elsewhere). Hooks and settings there make git start programs later, so changing them is never an ordinary edit.
 */
export function isGitInternal(p) {
  return typeof p === "string" && p.split(/[\\/]+/).some(part => part.toLowerCase() === ".git");
}

function systemRoots(platform, env) {
  if (platform === "win32") {
    const drive = (env.SystemDrive || "C:").replace(/[\\/]+$/, "");
    const list = [env.SystemRoot || env.windir || drive + "\\Windows", env.ProgramFiles || drive + "\\Program Files",
      env["ProgramFiles(x86)"] || drive + "\\Program Files (x86)", drive + "\\Boot", drive + "\\Recovery", drive + "\\System Volume Information"];
    return list.map(p => path.win32.resolve(p));
  }
  return ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/boot", "/sys", "/proc", "/dev", "/root",
    "/System", "/Library", "/Applications", "/private/etc", "/private/var/db"];
}

/** True for the operating system's own folders or a drive / filesystem root itself. */
export function isSystemPath(p, { platform = process.platform, env = process.env, realpath = fs.realpathSync.native } = {}) {
  if (typeof p !== "string" || !p) return false;
  const P = flavor(platform);
  let abs = P.resolve(p);
  // Windows 8.3 short names and trailing dots/spaces name the same folder; resolve before comparing.
  // Only on the host platform: a simulated platform's paths cannot be resolved by this machine.
  if (platform === process.platform) {
    try { abs = realpath(abs); } catch { /* a path that does not exist keeps its lexical form */ }
  }
  if (fold(abs, platform) === fold(P.parse(abs).root, platform)) return true;
  return systemRoots(platform, env).some(dir => isWithin(dir, abs, platform));
}
