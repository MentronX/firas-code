// Prompt history kept between runs: JSON lines in <home>/history.jsonl, newest last, at most 500 entries.
//
// Rules: consecutive duplicates are stored once; nothing that looks like an access code is ever stored (a code pasted
// into the wrong box must not outlive the screen it was typed on); secrets entered in mask mode never reach this
// file because the caller never offers them. The file is created with mode 0600 and rewritten (shortened) whenever it
// grows past a few hundred entries beyond the limit. Every function is best effort: a read-only home never breaks the
// prompt.
import fs from "node:fs";
import path from "node:path";
import { homeDir, ensureDir } from "../util/paths.js";

export const HISTORY_LIMIT = 500;
const SLACK = 100;
const ENTRY_MAX_CHARS = 20_000;
// FC2-XXXXX-XXXXX-... : the shape of an access code anywhere inside a line.
const CODE_LIKE = /\bFC2-[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+/i;

export function historyFile() { return path.join(homeDir(), "history.jsonl"); }

export function looksSecret(text) { return CODE_LIKE.test(String(text ?? "")); }

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    if (typeof value === "string") return value;
    if (value && typeof value.text === "string") return value.text;
  } catch { /* a torn line from a crash: skip it */ }
  return null;
}

function readAll(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const text = parseLine(line);
    if (text !== null && text !== "") out.push(text);
  }
  return out;
}

/** Oldest first, at most `limit` entries. */
export function loadHistory({ file = historyFile(), limit = HISTORY_LIMIT } = {}) {
  const all = readAll(file);
  return all.length > limit ? all.slice(all.length - limit) : all;
}

function rewrite(file, entries) {
  const body = entries.map(text => JSON.stringify({ text })).join("\n") + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Returns true when the entry was stored. */
export function appendHistory(text, { file = historyFile(), limit = HISTORY_LIMIT } = {}) {
  const entry = String(text ?? "").replace(/\s+$/, "");
  if (!entry.trim() || entry.length > ENTRY_MAX_CHARS || looksSecret(entry)) return false;
  try {
    ensureDir(path.dirname(file));
    const entries = readAll(file);
    if (entries.length && entries[entries.length - 1] === entry) return false;
    if (entries.length + 1 > limit + SLACK) {
      rewrite(file, [...entries.slice(entries.length + 1 - limit), entry]);
    } else {
      fs.appendFileSync(file, JSON.stringify({ text: entry, at: Date.now() }) + "\n", { mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}
