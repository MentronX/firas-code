// Settings kept between runs: one small JSON file under homeDir() (mode 0600).
//
//   const config = loadConfig();                    // { code, lang, arabic, effort, mode, origin, ... }
//   updateConfig(config, { effort: "high" });       // saves AND updates the object in memory
//
// Decisions:
//  - Environment variables win over the file but are never written back by loadConfig/updateConfig: FIRAS_CODE,
//    FIRAS_ORIGIN, FIRAS_LANG, FIRAS_ARABIC. `config.env` says which fields currently come from the environment (so
//    /logout can explain why it cannot forget a code that lives in an environment variable). The one exception is
//    deliberate and lives in cli.js: a code from the environment that the service accepts is saved once, so the next
//    start does not ask for it again.
//  - The file is read field by field. A value of the wrong type or outside its list is dropped and the default
//    stands, so one bad field never costs the person their access code. Fields this version no longer knows (an
//    older file may hold one) are ignored, and the next save leaves them out.
//  - A file that is not JSON at all is moved to config.json.bad (once; an older .bad is replaced) and the app starts
//    fresh, with `config.recovered` set so the caller can say so. The code is never printed anywhere.
//  - `mode: "bypass"` is never persisted and is ignored when found in the file: skipping every permission prompt
//    must be asked for again each run (flag --yolo or /mode).
//  - `firstRun` is true when the file did not exist (no language chosen yet, either).
import fs from "node:fs";
import { configFile, readJsonSafe, writePrivate } from "./util/paths.js";
import { langFromLocale } from "./i18n/index.js";

export const EFFORTS = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]);
export const ARABIC_MODES = Object.freeze(["auto", "on", "off"]);
export const PERSISTED_MODES = Object.freeze(["default", "acceptEdits", "plan"]);

export const DEFAULTS = Object.freeze({ code: "", lang: "", arabic: "auto", effort: "medium", mode: "default", origin: "" });

const CODE_SHAPE = /^[\x21-\x7e]{1,300}$/;

/** A pasted code often carries line-wrap spaces; the service ignores them too. */
export function cleanCode(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "") : "";
}

const validators = {
  code: v => { const code = cleanCode(v); return CODE_SHAPE.test(code) ? code : undefined; },
  lang: v => (v === "ar" || v === "en" ? v : undefined),
  arabic: v => (ARABIC_MODES.includes(v) ? v : undefined),
  effort: v => (EFFORTS.includes(v) ? v : undefined),
  mode: v => (PERSISTED_MODES.includes(v) ? v : undefined),
  origin: v => (typeof v === "string" && /^https?:\/\/\S{1,300}$/i.test(v.trim()) ? v.trim() : undefined),
};

/** Keeps only valid, known fields of `raw`. Empty strings for code/lang/origin mean "unset" and are kept out. */
export function validateConfig(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, check] of Object.entries(validators)) {
    if (!(key in raw)) continue;
    const value = check(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function arabicFromEnv(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(v)) return "off";
  if (["on", "1", "true", "yes"].includes(v)) return "on";
  if (v === "auto") return "auto";
  return undefined;
}

function envOverrides(env) {
  const out = {};
  const code = validators.code(env.FIRAS_CODE);
  if (code) out.code = code;
  const origin = validators.origin(env.FIRAS_ORIGIN);
  if (origin) out.origin = origin;
  if (String(env.FIRAS_LANG ?? "").trim()) out.lang = langFromLocale(env.FIRAS_LANG);
  const arabic = arabicFromEnv(env.FIRAS_ARABIC);
  if (arabic) out.arabic = arabic;
  return out;
}

function backUpCorrupt(file) {
  try { fs.renameSync(file, file + ".bad"); return true; } catch { /* a locked or read-only file: start fresh in memory */ }
  return false;
}

/**
 * Reads the settings. Never throws. `file` and `env` exist for tests.
 * Returns the persisted fields plus { env: {code,lang,arabic,origin}, firstRun, recovered, file }.
 */
export function loadConfig({ env = process.env, file = configFile() } = {}) {
  let stored = {};
  let firstRun = false;
  let recovered = false;
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch { firstRun = !fs.existsSync(file); }
  if (text !== null) {
    let parsed = null;
    try { parsed = JSON.parse(text.replace(/^﻿/, "")); } catch { parsed = null; }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = validateConfig(parsed);
    else if (text.trim()) {
      recovered = true;
      backUpCorrupt(file);
    }
  }
  const forced = envOverrides(env || {});
  const config = { ...DEFAULTS, ...stored, ...forced };
  Object.defineProperties(config, {
    env: { value: { code: "code" in forced, lang: "lang" in forced, arabic: "arabic" in forced, origin: "origin" in forced }, writable: true, enumerable: false },
    firstRun: { value: firstRun, writable: true, enumerable: false },
    recovered: { value: recovered, writable: true, enumerable: false },
    file: { value: file, enumerable: false },
    // What the file itself holds (without environment overrides): saveConfig merges into this.
    stored: { value: stored, writable: true, enumerable: false },
  });
  return config;
}

/**
 * Merges `patch` into the settings file. Invalid values are ignored; a value of null/"" removes a field.
 * Returns { ok, saved } where `saved` is what the file holds afterwards. Never throws.
 */
export function saveConfig(patch, { file = configFile() } = {}) {
  const current = validateConfig(readJsonSafe(file, {}));
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in validators)) continue;
    if (value === null || value === "") { delete next[key]; continue; }
    const clean = validators[key](value);
    if (clean !== undefined) next[key] = clean;
  }
  try {
    writePrivate(file, JSON.stringify(next, null, 2) + "\n");
    return { ok: true, saved: next };
  } catch {
    return { ok: false, saved: current };
  }
}

/** saveConfig + the same change applied to the in-memory object. Environment overrides stay in force. */
export function updateConfig(config, patch) {
  const result = saveConfig(patch, { file: config.file });
  const clean = validateConfig(patch);
  for (const key of Object.keys(patch || {})) {
    if (!(key in validators)) continue;
    const empty = patch[key] === null || patch[key] === "";
    if (config.env?.[key]) continue;
    if (empty) config[key] = DEFAULTS[key];
    else if (key in clean) config[key] = clean[key];
  }
  config.stored = result.saved;
  config.firstRun = false;
  return result;
}
