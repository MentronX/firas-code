// MultiEdit: several replacements in one file, applied in order and committed all together or not at all.
import { t } from "../i18n/index.js";
import { ok, fail, guard, pathArg, shown, isPlainObject } from "./common.js";
import { writeVerdict } from "./access.js";
import { loadExisting, saveText, noteWrite, changeSummary } from "./filetool.js";
import { applyEdit, makeDiff } from "./editcore.js";
import { countLines } from "./textfile.js";

export const MULTIEDIT_MAX = 50;

const DESCRIPTION = [
  "Makes several exact-text replacements in ONE file, in order, as a single all-or-nothing change: if any step fails, the file is left untouched.",
  "Each edit has the same rules as Edit (old_string must match exactly and be unique unless replace_all is true), and every edit sees the result of the previous ones.",
  "The file must have been read in full with Read in this session and not changed since.",
  "Use it when you have two or more separate changes in the same file. Do not use it for a single change (use Edit) or for changes spread over several files (make one call per file).",
].join(" ");

const asBool = v => v === true || v === "true";

function normalizeEdits(edits) {
  return edits.map(e => ({ old_string: e.old_string, new_string: e.new_string, replace_all: asBool(e.replace_all) }));
}

/** Applies every edit in order to `text`. Returns { raw, replaced } or { error: failed tool result }. */
function applyAll(text, edits) {
  let current = text;
  let replaced = 0;
  for (let i = 0; i < edits.length; i++) {
    const res = applyEdit(current, edits[i]);
    if (!res.ok) return { error: fail("editFailed", `Edit ${i + 1} of ${edits.length} failed, so NOTHING was changed: ${res.message}`, { i: i + 1, n: edits.length }) };
    current = res.raw;
    replaced += res.count;
  }
  return { raw: current, replaced };
}

export function createMultiEditTool() {
  return {
    name: "MultiEdit",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to change, absolute or relative to the working folder." },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: MULTIEDIT_MAX,
          description: "The replacements, applied in the given order.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "The exact text to replace." },
              new_string: { type: "string", description: "The replacement text." },
              replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
            },
            required: ["old_string", "new_string"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,

    summarize(input, ctx) {
      const g = typeof pathArg(input) === "string" && pathArg(input) ? guard(input, ctx) : null;
      const name = g?.ok ? shown(g.abs, ctx) : String(pathArg(input) ?? "");
      return Array.isArray(input?.edits) ? `${name} (${input.edits.length})` : name;
    },

    validate(input, ctx) {
      if (typeof pathArg(input) !== "string" || !pathArg(input).trim()) return "path is required (a string).";
      if (!Array.isArray(input.edits) || input.edits.length === 0) return "edits must be a non-empty array of { old_string, new_string }.";
      if (input.edits.length > MULTIEDIT_MAX) return `Too many edits (${input.edits.length}); the limit is ${MULTIEDIT_MAX} per call.`;
      for (let i = 0; i < input.edits.length; i++) {
        const e = input.edits[i];
        if (!isPlainObject(e) || typeof e.old_string !== "string" || typeof e.new_string !== "string") return `edits[${i}] needs string fields old_string and new_string.`;
        if (e.old_string === "") return `edits[${i}].old_string must not be empty.`;
        if (e.old_string === e.new_string) return `edits[${i}]: old_string and new_string are identical.`;
      }
      const g = guard(input, ctx);
      return g.ok ? null : g.message;
    },

    permission(input, ctx) {
      const g = guard(input, ctx);
      if (!g.ok) return { decision: "deny", reason: g.message, risk: "low", title: t("tools.perm.badPath") };
      const where = shown(g.abs, ctx);
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      const title = t("tools.perm.multiedit", { file: where, n });
      const loaded = loadExisting(g, ctx, { requireFull: true });
      if (loaded.error || !Array.isArray(input.edits)) return { decision: "allow", reason: "refused", risk: "low", title };
      const done = applyAll(loaded.decoded.text, normalizeEdits(input.edits));
      if (done.error) return { decision: "allow", reason: "refused", risk: "low", title };
      return writeVerdict(g, ctx, { title, diff: makeDiff(where, loaded.decoded.text, done.raw) });
    },

    async run(input, ctx) {
      const g = guard(input, ctx);
      if (!g.ok) return fail("badPath", g.message);
      if (!Array.isArray(input.edits) || input.edits.length === 0) return fail("invalidInput", "edits must be a non-empty array.");
      const loaded = loadExisting(g, ctx, { requireFull: true });
      if (loaded.error) return loaded.error;
      const { decoded, where } = loaded;
      const done = applyAll(decoded.text, normalizeEdits(input.edits));
      if (done.error) return done.error;
      const saved = await saveText(g, ctx, done.raw, { encoding: decoded.encoding, bom: decoded.bom, mode: process.platform === "win32" ? undefined : loaded.stat.mode & 0o7777 });
      if (saved.error) return saved.error;
      noteWrite(ctx, g, saved, countLines(done.raw));
      const n = input.edits.length;
      return ok(`Applied ${n} edit${n === 1 ? "" : "s"} to ${where} (${done.replaced} replacement${done.replaced === 1 ? "" : "s"} in total).`, {
        summary: changeSummary(where, decoded.text, done.raw, { edits: n }),
        diff: makeDiff(where, decoded.text, done.raw),
      });
    },
  };
}
