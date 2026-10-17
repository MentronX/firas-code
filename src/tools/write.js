// Write: create a file or replace one wholesale. Existing files must have been Read in full and be unchanged.
import fs from "node:fs";
import { t } from "../i18n/index.js";
import { ok, fail, guard, pathArg, shown, formatBytes, tn } from "./common.js";
import { writeVerdict } from "./access.js";
import { loadExisting, saveText, noteWrite, ensureParent, changeSummary } from "./filetool.js";
import { makeDiff } from "./editcore.js";
import { detectEol, withEol, countLines, MAX_TEXT_BYTES } from "./textfile.js";

const DESCRIPTION = [
  "Creates a new file, or replaces the entire content of an existing file, with the text you give.",
  "An existing file must have been read in full with Read in this session and not changed since, otherwise the call is refused; read it again if that happens.",
  "Parent folders are created as needed. The line endings (LF or CRLF) and byte-order mark of an existing file are kept.",
  "Prefer Edit or MultiEdit for changing part of a file: they send only the change and cannot drop content by accident.",
  "Do not create files nobody asked for (extra documentation, scratch files, backups). Never use it for binary data.",
].join(" ");

/** The text that will be on disk, given what was asked and what is there now. */
function finalContent(content, existing) {
  return existing ? withEol(content, detectEol(existing.decoded.text)) : content;
}

export function createWriteTool() {
  return {
    name: "Write",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to create or replace, absolute or relative to the working folder." },
        content: { type: "string", description: "The complete new content of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,

    summarize(input, ctx) {
      const g = typeof pathArg(input) === "string" && pathArg(input) ? guard(input, ctx) : null;
      return g?.ok ? shown(g.abs, ctx) : String(pathArg(input) ?? "");
    },

    validate(input, ctx) {
      if (typeof pathArg(input) !== "string" || !pathArg(input).trim()) return "path is required (a string).";
      if (typeof input.content !== "string") return "content is required (a string; use an empty string for an empty file).";
      if (input.content.includes("\0")) return "content contains NUL characters; Write only handles text.";
      if (Buffer.byteLength(input.content) > MAX_TEXT_BYTES) return `content is too large (${formatBytes(Buffer.byteLength(input.content))}); split the work or generate the file with a command.`;
      const g = guard(input, ctx);
      return g.ok ? null : g.message;
    },

    permission(input, ctx) {
      const g = guard(input, ctx);
      if (!g.ok) return { decision: "deny", reason: g.message, risk: "low", title: t("tools.perm.badPath") };
      const where = shown(g.abs, ctx);
      let exists = false;
      try { exists = fs.statSync(g.abs).isFile(); } catch { exists = false; }
      if (!exists) {
        return writeVerdict(g, ctx, { title: t("tools.perm.writeNew", { file: where }), diff: { path: where, oldText: null, newText: String(input.content ?? "") } });
      }
      const loaded = loadExisting(g, ctx, { requireFull: true });
      if (loaded.error) return { decision: "allow", reason: "refused", risk: "low", title: t("tools.perm.write", { file: where }) };
      const next = finalContent(String(input.content ?? ""), loaded);
      return writeVerdict(g, ctx, { title: t("tools.perm.writeOver", { file: where }), diff: makeDiff(where, loaded.decoded.text, next) });
    },

    async run(input, ctx) {
      const g = guard(input, ctx);
      if (!g.ok) return fail("badPath", g.message);
      const where = shown(g.abs, ctx);
      if (typeof input.content !== "string") return fail("invalidInput", "content must be a string.");
      let isFile = false, isDir = false;
      try { const st = fs.statSync(g.abs); isFile = st.isFile(); isDir = st.isDirectory(); } catch { /* does not exist yet */ }
      if (isDir) return fail("isDir", `${where} is a folder, not a file.`, { file: where });

      if (isFile) {
        const loaded = loadExisting(g, ctx, { requireFull: true });
        if (loaded.error) return loaded.error;
        const next = finalContent(input.content, loaded);
        if (next === loaded.decoded.text) return ok(`No change: ${where} already has exactly this content.`, { summary: t("tools.write.same") });
        const saved = await saveText(g, ctx, next, { encoding: loaded.decoded.encoding, bom: loaded.decoded.bom, mode: process.platform === "win32" ? undefined : loaded.stat.mode & 0o7777 });
        if (saved.error) return saved.error;
        const before = countLines(loaded.decoded.text);
        const after = countLines(next);
        noteWrite(ctx, g, saved, after);
        return ok(`Updated ${where} (${before} -> ${after} lines).`, {
          summary: changeSummary(where, loaded.decoded.text, next),
          diff: makeDiff(where, loaded.decoded.text, next),
        });
      }

      const parent = ensureParent(g, ctx);
      if (parent) return parent;
      const saved = await saveText(g, ctx, input.content);
      if (saved.error) return saved.error;
      const lines = countLines(input.content);
      noteWrite(ctx, g, saved, lines);
      return ok(`Created ${where} (${lines} line${lines === 1 ? "" : "s"}).`, {
        summary: tn("tools.write.createdFile", lines, { file: where }),
        diff: { path: where, oldText: null, newText: input.content },
      });
    },
  };
}
