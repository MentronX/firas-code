// Where the app keeps its own files, and small path helpers shared by every module.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { HOME_DIRNAME } from "../brand.js";
import { childEnv } from "./env.js";

export function homeDir() { return process.env.FIRAS_HOME || path.join(os.homedir(), HOME_DIRNAME); }
export function configFile() { return path.join(homeDir(), "config.json"); }
export function sessionsDir() { return path.join(homeDir(), "sessions"); }
export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

/**
 * Full path of a program that ships with Windows. Node looks in the current folder before PATH when it is given a bare
 * name, and that folder is somebody's project, so system programs are always started by their full path.
 */
export function windowsSystemTool(name, env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", `${name}.exe`);
}

// ---------------------------------------------------------------------------------------------------
// Windows file permissions. Mode 0600 does nothing there: a new file simply inherits the folder's list of who may
// read it, which on a shared or older machine can include other accounts. So the app's own folder (or, for a file
// written elsewhere, the file) is limited to the signed-in user with the system's icacls tool. Best effort by design:
// no icacls, an unknown user name or a refusal leaves things as they were and never stops a save.

const tried = new Map(); // normalised path -> whether it was restricted; each path is tried once per run

function userAccount(env, spawnSync) {
  const domain = env.USERDOMAIN;
  const name = env.USERNAME;
  if (domain && name) return `${domain}\\${name}`;
  // Without those variables ask the system; its answer has the same DOMAIN\user shape.
  try {
    const res = spawnSync(windowsSystemTool("whoami", env), [], { encoding: "utf8", windowsHide: true, timeout: 5000, env: childEnv(env) });
    const text = String(res?.stdout ?? "").trim();
    return res?.status === 0 && /^[^\\/:*?"<>|\r\n]+\\[^\\/:*?"<>|\r\n]+$/.test(text) ? text : "";
  } catch { return ""; }
}

/** False when the current process can no longer reach what was just restricted (a wrong account name must not lock the user out). */
function stillReachable(target, isDirectory) {
  try {
    if (isDirectory) fs.readdirSync(target); else fs.accessSync(target, fs.constants.R_OK);
    return true;
  } catch (error) { return error?.code === "ENOENT"; }
}

/**
 * Limits `target` to the current user on Windows; for a folder, also everything that will be created inside it.
 * Returns true when it worked. Does nothing (false) on other systems, for a path already tried, or when anything is
 * missing; never throws. `opts` exists for tests: { platform, env, spawnSync, directory }.
 */
export function restrictToOwner(target, { platform = process.platform, env = process.env, spawnSync = nodeSpawnSync, directory, fresh = false } = {}) {
  if (platform !== "win32") return false;
  try {
    const key = path.resolve(target).toLowerCase();
    if (!fresh && tried.has(key)) return tried.get(key);
    tried.set(key, false);
    const isDirectory = directory ?? fs.statSync(target).isDirectory();
    const user = userAccount(env, spawnSync);
    if (!user) return false;
    const icacls = windowsSystemTool("icacls", env);
    // (OI)(CI): files and folders created inside later are born with the same short list.
    const grant = `${user}:${isDirectory ? "(OI)(CI)(F)" : "(F)"}`;
    // A short timeout: this runs synchronously on the save path, and a hung icacls must not freeze the
    // terminal for ten seconds on every save when the folder's ACL cannot be changed.
    const res = spawnSync(icacls, [target, "/inheritance:r", "/grant:r", grant], { stdio: "ignore", windowsHide: true, timeout: 2000, env: childEnv(env) });
    if (res?.error || res?.status !== 0) return false;
    if (!stillReachable(target, isDirectory)) {
      spawnSync(icacls, [target, "/reset"], { stdio: "ignore", windowsHide: true, timeout: 2000, env: childEnv(env) });
      return false;
    }
    tried.set(key, true);
    return true;
  } catch { return false; }
}

/** Forgets which paths restrictToOwner has already handled (tests only). */
export function forgetRestrictions() { tried.clear(); }

// What the app itself puts in its folder. A folder holding anything else is somebody's, and is left as it is.
const OWN_ENTRIES = /^(config\.json(\.bad)?|sessions|skills|.+\.tmp)$/i;

function isOwnFolder(folder) {
  if (path.dirname(folder) === folder) return false;
  if (path.basename(folder).toLowerCase() === HOME_DIRNAME) return true;
  // FIRAS_HOME may point anywhere, even at a drive root or a project: only a folder that holds nothing but our files counts.
  try { return fs.readdirSync(folder).every(name => OWN_ENTRIES.test(name)); } catch { return false; }
}

/**
 * Writes a file readable only by its owner: mode 0600 where that means something, an icacls restriction on Windows.
 * In the app's own folder the restriction goes on the folder, once, before the first write: a new file is never
 * readable by anyone else even for a moment, and every later file inherits it. Anywhere else each write restricts the
 * new file before it replaces the old one (the replacement would otherwise bring back the folder's list).
 * `opts.acl` ({ platform, env, spawnSync }) is for tests.
 */
export function writePrivate(file, text, opts = {}) {
  const dir = path.dirname(file);
  const acl = opts.acl || {};
  const windows = (acl.platform || process.platform) === "win32";
  const home = homeDir();
  ensureDir(dir);
  // The folder is limited while it is still empty of our files; what it holds already (an older install) follows.
  const folderDone = windows && isInside(home, dir) && isOwnFolder(home) && restrictToOwner(home, { ...acl, directory: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  if (windows && !folderDone) restrictToOwner(tmp, { ...acl, directory: false, fresh: true });
  fs.renameSync(tmp, file);
}

export function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

/** True when `child` is `parent` or inside it. Case-insensitive on Windows. */
export function isInside(parent, child) {
  const norm = p => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `~` for the home directory and a trailing-safe display form of a path for headers. */
export function displayPath(p, cwd = process.cwd()) {
  const abs = path.resolve(cwd, p);
  if (isInside(cwd, abs)) return path.relative(cwd, abs) || ".";
  const home = os.homedir();
  return isInside(home, abs) ? "~" + path.sep + path.relative(home, abs) : abs;
}
