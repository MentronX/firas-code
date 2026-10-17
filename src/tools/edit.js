// Edit: exact-text replacement inside one file. Works on a file that was Read (a part of it is enough when
// the text to change lies inside the lines that were read).
import { t } from "../i18n/index.js";
import { ok, fail, settings, guard, pathArg, shown } from "./common.js";
import { writeVerdict } from "./access.js";
import { loadExisting, saveText, noteWrite, changeSummary } from "./filetool.js";
import { applyEdit, shiftRanges, makeDiff, snippetAround, prepareText } from "./editcore.js";
import { countLines, recordState } from "./textfile.js";

const DESCRIPTION = [
  "Replaces one exact piece of text in a file. old_string must match the file character for character (indentation, tabs, quotes) and must be unique in the file unless replace_all is true; include a few neighbouring lines to make it unique.",
  "The file must have been read with Read in this session and not changed since; if the call is refused for that reason, Read it again and retry.",
  "Copy old_string from the Read output WITHOUT the line-number prefix. Line endings and encoding of the file are kept. Use replace_all to rename something everywhere in the file.",
  "Prefer it to Write for any change to an existing file. To make several changes to one file in a single step use MultiEdit.",
  "Do not use it to create a file (use Write), and do not guess old_string: read the file first.",
].join(" ");

const asBool = v => v === true || v === "true";

export function createEditTool() {
  return {
    name: "Edit",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to change, absolute or relative to the working folder." },
        old_string: { type: "string", description: "The exact text to replace. Must be unique in the file unless replace_all is true." },
        new_string: { type: "string", description: "The text to put in its place. Must differ from old_string." },
        replace_all: { type: "boolean", description: "Replace every occurrence of old_string instead of requiring a single one. Default false." },
      },
      required: ["path", "old_string", "new_string"],
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
      if (typeof input.old_string !== "string") return "old_string is required (a string).";
      if (typeof input.new_string !== "string") return "new_string is required (a string; use an empty string to delete the text).";
      if (input.old_string === "") return "old_string must not be empty. To create a file use Write.";
      if (input.old_string === input.new_string) return "old_string and new_string are identical, so nothing would change.";
      const g = guard(input, ctx);
      return g.ok ? null : g.message;
    },

    permission(input, ctx) {
      const g = guard(input, ctx);
      if (!g.ok) return { decision: "deny", reason: g.message, risk: "low", title: t("tools.perm.badPath") };
      const where = shown(g.abs, ctx);
      const loaded = loadExisting(g, ctx);
      // An edit that will be refused anyway is not worth a question: run() reports the reason to the model.
      if (loaded.error) return { decision: "allow", reason: "refused", risk: "low", title: t("tools.perm.edit", { file: where }) };
      const res = applyEdit(loaded.decoded.text, { ...input, replace_all: asBool(input.replace_all) }, { readRanges: loaded.state.partial ? loaded.state.ranges : null });
      if (!res.ok) return { decision: "allow", reason: "refused", risk: "low", title: t("tools.perm.edit", { file: where }) };
      return writeVerdict(g, ctx, { title: t("tools.perm.edit", { file: where }), diff: makeDiff(where, loaded.decoded.text, res.raw) });
    },

    async run(input, ctx) {
      const s = settings(ctx);
      const g = guard(input, ctx);
      if (!g.ok) return fail("badPath", g.message);
      const loaded = loadExisting(g, ctx);
      if (loaded.error) return loaded.error;
      const { decoded, state, where } = loaded;
      const res = applyEdit(decoded.text, { ...input, replace_all: asBool(input.replace_all) }, { readRanges: state.partial ? state.ranges : null });
      if (!res.ok) return fail(res.code, res.message, { file: where });

      const saved = await saveText(g, ctx, res.raw, { encoding: decoded.encoding, bom: decoded.bom, mode: process.platform === "win32" ? undefined : loaded.stat.mode & 0o7777 });
      if (saved.error) return saved.error;
      const total = countLines(res.raw);
      if (state.partial) {
        const ranges = res.count === 1
          ? shiftRanges(state.ranges, res)
          : state.ranges.filter(r => r[1] < res.startLine);
        recordState(s.fileState, g.abs, { stat: saved.stat, buf: saved.data, partial: true, ranges, lines: total, lossy: state.lossy, platform: s.platform });
      } else {
        noteWrite(ctx, g, saved, total);
      }

      const lf = prepareText(res.raw).lf;
      const snippet = snippetAround(lf, res.startLine, Math.max(res.startLine, res.newEndLine));
      const head = res.count === 1
        ? `Edited ${where}: replaced 1 occurrence at line ${res.startLine}.`
        : `Edited ${where}: replaced ${res.count} occurrences (the first at line ${res.startLine}).`;
      return ok(`${head}\n${snippet}`, {
        summary: changeSummary(where, decoded.text, res.raw, { places: res.count }),
        diff: makeDiff(where, decoded.text, res.raw),
      });
    },
  };
}
