// Load-check-save plumbing shared by Write, Edit and MultiEdit.
import fs from "node:fs";
import path from "node:path";
import { t } from "../i18n/index.js";
import { diffStats } from "../ui/diff.js";
import { fail, settings, shown, formatBytes } from "./common.js";
import { stateKey } from "./pathguard.js";
import {
  sniffFile, decodeText, encodeText, fsErrorMessage, writeFileAtomic, staleProblem, similarNames,
  MAX_TEXT_BYTES, recordWrite,
} from "./textfile.js";

/**
 * Reads an existing file for modification and enforces the read-first rules.
 * Returns { stat, buf, decoded, state, where } or { error: <failed tool result> }.
 */
export function loadExisting(g, ctx, { requireFull = false } = {}) {
  const s = settings(ctx);
  const where = shown(g.abs, ctx);
  let stat;
  try { stat = fs.statSync(g.abs); }
  catch (error) {
    if (error.code === "ENOENT") {
      const like = similarNames(g.abs).map(p => shown(p, ctx));
      return { error: fail("notFound", `File not found: ${where}.${like.length ? ` Did you mean: ${like.join(", ")}?` : " Use Glob to find the right name, or Write to create a new file."}`, { file: where }) };
    }
    return { error: fail("failed", fsErrorMessage(error, where)) };
  }
  if (stat.isDirectory()) return { error: fail("isDir", `${where} is a folder, not a file.`, { file: where }) };
  if (!stat.isFile()) return { error: fail("notFile", `${where} is not a regular file.`, { file: where }) };
  if (stat.size > MAX_TEXT_BYTES) return { error: fail("tooBig", `${where} is too large to change with these tools (${formatBytes(stat.size)}).`, { file: where }) };
  let buf;
  try { buf = fs.readFileSync(g.abs); }
  catch (error) { return { error: fail("failed", fsErrorMessage(error, where)) }; }
  const sniff = sniffFile(buf);
  if (sniff.kind !== "text") return { error: fail("binary", `${where} is a binary file (${sniff.label}); these tools only change text files.`, { file: where }) };
  const problem = staleProblem(s.fileState, g.abs, buf, s.platform);
  if (problem) return { error: fail(problem.code, `${problem.message} (${where})`, { file: where }) };
  const state = s.fileState.get(stateKey(g.abs, s.platform));
  if (requireFull && state.partial) {
    return { error: fail("partial", `You only read part of ${where}. Read the whole file first (use offset and limit to cover every line), or use Edit for a change inside the part you have read.`, { file: where }) };
  }
  const decoded = decodeText(buf);
  if (decoded.invalid) return { error: fail("notUtf8", `${where} is not valid UTF-8 (it may use a legacy encoding), so it cannot be changed safely with these tools.`, { file: where }) };
  return { stat, buf, decoded, state, where };
}

/** Writes `text` in the file's own encoding. Returns { buf, stat } of what is now on disk, or { error }. */
export async function saveText(g, ctx, text, { encoding = "utf8", bom = false, mode } = {}) {
  const s = settings(ctx);
  const where = shown(g.abs, ctx);
  const data = encodeText(text, { encoding, bom });
  try {
    await writeFileAtomic(g.real || g.abs, data, { mode });
    const stat = fs.statSync(g.abs);
    return { data, stat, platform: s.platform };
  } catch (error) {
    return { error: fail("failed", `Could not write ${where}: ${fsErrorMessage(error, where)}`, { file: where }) };
  }
}

/**
 * The result line of a change to an existing file, as a person reads it on the card: which file and how many lines
 * came and went ("src/a.js: +3 -1 lines"). `places` (several occurrences replaced by one Edit) and `edits` (a
 * MultiEdit) add the count when it is more than one.
 */
export function changeSummary(where, oldText, newText, { places = 1, edits = 1 } = {}) {
  const { added, removed } = diffStats(oldText, newText);
  const key = edits > 1 ? "tools.edit.changedEdits" : places > 1 ? "tools.edit.changedPlaces" : "tools.edit.changed";
  return t(key, { file: where, added, removed, n: edits > 1 ? edits : places });
}

export function noteWrite(ctx, g, saved, totalLines) {
  const s = settings(ctx);
  recordWrite(s.fileState, g.abs, { stat: saved.stat, buf: saved.data, totalLines, platform: s.platform });
}

export function ensureParent(g, ctx) {
  const where = shown(g.abs, ctx);
  const dir = path.dirname(g.real || g.abs);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return null;
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTDIR") return fail("parentIsFile", `Cannot create the folder for ${where}: a file with the same name as one of its parent folders already exists.`, { file: where });
    return fail("failed", `Could not create the folder for ${where}: ${fsErrorMessage(error, where)}`, { file: where });
  }
}

