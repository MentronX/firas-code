// LS: a tidy listing of a folder - folders first, sizes for files, optional ignore globs and depth.
import fs from "node:fs";
import path from "node:path";
import { t } from "../i18n/index.js";
import { ok, fail, settings, shown, pathArg, isPlainObject, toInt, formatBytes, tn } from "./common.js";
import { readVerdict } from "./access.js";
import { guardPath } from "./pathguard.js";
import { compileNameFilter } from "./globmatch.js";
import { DEFAULT_IGNORES } from "./walk.js";

export const LS_MAX_PER_FOLDER = 300;
const LS_MAX_TOTAL = 800;

const DESCRIPTION = [
  "Lists the contents of a folder: sub-folders first (with the number of items inside), then files (with sizes). Hidden files are included.",
  "depth (1-3, default 1) also lists the contents of sub-folders; folders like node_modules and .git are shown but not opened. ignore takes glob patterns for names to leave out.",
  "Use it to get your bearings in a folder. Do not use it to find files by pattern (use Glob), to search inside files (use Grep), or to read a file (use Read).",
].join(" ");

const compareNames = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

export function createLsTool() {
  return {
    name: "LS",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder to list (absolute or relative to the working folder). Default: the working folder." },
        ignore: { type: "array", items: { type: "string" }, description: "Glob patterns of names to leave out, e.g. [\"*.log\", \"tmp\"]." },
        depth: { type: "integer", minimum: 1, maximum: 3, description: "How many levels to list. Default 1." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    concurrencySafe: true,

    summarize(input, ctx) {
      const raw = pathArg(input);
      if (!raw) return ".";
      const g = guardPath(raw, { cwd: settings(ctx).cwd, platform: settings(ctx).platform });
      return g.ok ? shown(g.abs, ctx) : String(raw);
    },

    validate(input, ctx) {
      if (!isPlainObject(input)) return "input must be an object.";
      if (input.ignore !== undefined && !(Array.isArray(input.ignore) && input.ignore.every(p => typeof p === "string"))) return "ignore must be an array of glob strings.";
      if (input.depth !== undefined && !(toInt(input.depth) >= 1)) return "depth must be 1, 2 or 3.";
      const g = guardPath(pathArg(input) || ".", { cwd: settings(ctx).cwd, platform: settings(ctx).platform });
      return g.ok ? null : g.message;
    },

    permission(input, ctx) {
      const s = settings(ctx);
      const g = guardPath(pathArg(input) || ".", { cwd: s.cwd, platform: s.platform });
      if (!g.ok) return { decision: "deny", reason: g.message, risk: "low", title: t("tools.perm.badPath") };
      return readVerdict(g, ctx, { directory: true });
    },

    async run(input, ctx) {
      const s = settings(ctx);
      const g = guardPath(pathArg(input) || ".", { cwd: s.cwd, platform: s.platform });
      if (!g.ok) return fail("badPath", g.message);
      const where = shown(g.abs, ctx);
      let stat;
      try { stat = fs.statSync(g.abs); } catch { return fail("notFound", `The folder ${where} does not exist.`, { file: where }); }
      if (!stat.isDirectory()) return fail("notDir", `${where} is a file, not a folder. Use Read to see its content.`, { file: where });

      const depth = Math.min(3, Math.max(1, toInt(input.depth) || 1));
      const filters = (input.ignore || []).map(p => compileNameFilter(p, { caseInsensitive: s.platform === "win32" }));
      const skipped = rel => filters.some(f => f(rel));
      const lines = [];
      let entriesShown = 0, clipped = false;

      const listing = (dirAbs, rel, level) => {
        let names;
        try { names = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (error) { lines.push(`${"  ".repeat(level)}(cannot open: ${error.code || "error"})`); return; }
        const rows = [];
        for (const entry of names) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (skipped(childRel)) continue;
          let isDir = entry.isDirectory();
          let link = null;
          if (entry.isSymbolicLink()) {
            try { link = fs.readlinkSync(path.join(dirAbs, entry.name)); isDir = fs.statSync(path.join(dirAbs, entry.name)).isDirectory(); } catch { link = link || "?"; }
          }
          rows.push({ name: entry.name, rel: childRel, isDir, link });
        }
        rows.sort((a, b) => (a.isDir === b.isDir ? compareNames(a.name, b.name) : a.isDir ? -1 : 1));
        const indent = "  ".repeat(level);
        let count = 0;
        for (const row of rows) {
          if (count >= LS_MAX_PER_FOLDER || entriesShown >= LS_MAX_TOTAL) {
            clipped = true;
            lines.push(`${indent}... ${rows.length - count} more`);
            return;
          }
          count++; entriesShown++;
          const abs = path.join(dirAbs, row.name);
          const arrow = row.link ? ` -> ${row.link}` : "";
          if (row.isDir) {
            let items = "";
            const expand = level + 1 < depth && !row.link && !DEFAULT_IGNORES.includes(row.name);
            // A link can point outside the project; counting its entries would leak what is there.
            if (!expand && !row.link) { try { items = ` (${fs.readdirSync(abs).length} items)`; } catch { items = ""; } }
            lines.push(`${indent}${row.name}/${arrow}${items}${level + 1 < depth && DEFAULT_IGNORES.includes(row.name) ? " (not opened)" : ""}`);
            if (expand) listing(abs, row.rel, level + 1);
          } else {
            let size = "";
            try { size = `  ${formatBytes(fs.lstatSync(abs).size)}`; } catch { size = ""; }
            lines.push(`${indent}${row.name}${arrow}${size}`);
          }
        }
      };
      listing(g.abs, "", 0);

      const header = `${where} (${entriesShown} ${entriesShown === 1 ? "entry" : "entries"}${clipped ? ", list shortened" : ""})`;
      if (!lines.length) return ok(`${header}\n(empty)`, { summary: t("tools.ls.empty") });
      return ok(`${header}\n${lines.join("\n")}`, { summary: tn("tools.ls.items", entriesShown) });
    },
  };
}
