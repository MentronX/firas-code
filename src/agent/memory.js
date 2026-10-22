// Durable project memory: short facts the person (or the agent, with the Remember tool) wants kept
// across sessions. One Markdown file per project, `.firas/memory.md`, plus an optional global file in
// the app's own folder. It is read once per turn and put in the system prompt, so it costs tokens only
// while it is short; the writer refuses to grow it past MAX_CHARS.
import fs from "node:fs";
import path from "node:path";
import { homeDir, writePrivate } from "../util/paths.js";

export const MEMORY_MAX_CHARS = 8000;
const BULLET = /^\s*[-*]\s+/;

export function memoryFile(cwd) { return path.join(cwd, ".firas", "memory.md"); }
export function globalMemoryFile() { return path.join(homeDir(), "memory.md"); }

/** The project memory followed by the global one, trimmed to the cap. */
export function readMemory(cwd) {
  const parts = [];
  for (const file of [memoryFile(cwd), globalMemoryFile()]) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) parts.push(text);
    } catch { /* no memory yet */ }
  }
  return parts.join("\n\n").slice(0, MEMORY_MAX_CHARS);
}

/** The bullet lines of the project memory, for listing and forgetting. */
export function memoryLines(cwd) {
  try {
    return fs.readFileSync(memoryFile(cwd), "utf8").split(/\r?\n/).map(line => line.trim()).filter(line => BULLET.test(line));
  } catch { return []; }
}

function writeLines(cwd, lines) {
  const file = memoryFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = lines.length ? lines.join("\n") + "\n" : "";
  writePrivate(file, text);
}

/** Adds one fact. Returns { ok, duplicate?, reason? }. */
export function remember(cwd, text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, reason: "empty" };
  const line = `- ${clean}`;
  const lines = memoryLines(cwd);
  if (lines.some(existing => existing.toLowerCase() === line.toLowerCase())) return { ok: true, duplicate: true };
  const next = [...lines, line];
  if (next.join("\n").length > MEMORY_MAX_CHARS) return { ok: false, reason: "full" };
  writeLines(cwd, next);
  return { ok: true };
}

/** Empties the project memory. Returns true when the file was written. */
export function clearMemory(cwd) {
  try { writeLines(cwd, []); return true; } catch { return false; }
}

/** Removes the bullet whose text contains `text` (case-insensitive). Returns { ok, removed }. */
export function forget(cwd, text) {
  const needle = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return { ok: false, removed: 0 };
  const lines = memoryLines(cwd);
  const kept = lines.filter(line => !line.replace(BULLET, "").toLowerCase().includes(needle));
  const removed = lines.length - kept.length;
  if (removed) writeLines(cwd, kept);
  return { ok: removed > 0, removed };
}
