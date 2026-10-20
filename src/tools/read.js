// Read: line-numbered view of a text file. Records what was seen so Write / Edit can refuse stale changes.
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { t } from "../i18n/index.js";
import { ok, fail, settings, guard, pathArg, shown, lineTag, clipLine, formatBytes, toInt, tn } from "./common.js";
import { readVerdict } from "./access.js";
import { sniffFile, decodeText, fsErrorMessage, recordRead, similarNames, MAX_TEXT_BYTES } from "./textfile.js";

export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 256 * 1024;
export const READ_MAX_LINE_CHARS = 2000;

const DESCRIPTION = [
  "Reads a file from the user's machine and returns it with line numbers (each line is: right-aligned number, a tab, the text).",
  "Use it to look at a file before you change it: Write and Edit refuse to modify an existing file you have not read in this session, or one that changed since you read it.",
  `One call returns at most ${READ_MAX_LINES} lines or ${READ_MAX_BYTES / 1024} KB. For a bigger file pass offset (first line, 1-based) and limit (number of lines) and continue from the hint printed at the end.`,
  `Lines longer than ${READ_MAX_LINE_CHARS} characters are cut. UTF-8 and UTF-16 text are supported. Images, PDFs and other binary files are only described, never dumped.`,
  "Do not use it to list a folder (use LS), to find files by name (use Glob), or to search inside files (use Grep). Do not re-read a file you just read unless it may have changed.",
].join(" ");

function describeBinary(sniff, size, where) {
  const dims = sniff.size ? `, ${sniff.size.w}x${sniff.size.h} pixels` : "";
  const what = sniff.kind === "image" ? "an image" : sniff.kind === "pdf" ? "a PDF document" : "a binary file";
  return `${where} is ${what} (${sniff.label}${dims}, ${formatBytes(size)}). Its contents cannot be shown as text, so nothing was read. `
    + (sniff.kind === "image" ? "Ask the user to describe it if you need its content." : sniff.kind === "pdf" ? "Use a command-line tool such as pdftotext through Bash if one is installed." : "Use a suitable command-line tool through Bash if you need to inspect it.");
}

async function readLargeLines(abs, offset, limit) {
  const handle = await fs.promises.open(abs, "r");
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const sniff = sniffFile(head.subarray(0, bytesRead));
    if (sniff.kind !== "text") return { sniff };
    // A BOM is not the only way UTF-16 arrives: a file saved without one is still UTF-16, and decoding it
    // as UTF-8 would return NUL-interleaved garbage. decodeText's NUL distribution catches both.
    if (decodeText(head.subarray(0, bytesRead)).encoding !== "utf8") return { tooLargeUtf16: true };
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.allocUnsafe(1 << 20);
    const lines = [];
    let lineNo = 1, carry = "", position = 0, eof = false;
    while (lines.length < limit) {
      const { bytesRead: n } = await handle.read(chunk, 0, chunk.length, position);
      if (n === 0) { eof = true; break; }
      position += n;
      let text = carry + decoder.write(chunk.subarray(0, n));
      if (position === n && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const parts = text.split("\n");
      carry = parts.pop();
      for (const line of parts) {
        if (lineNo >= offset && lines.length < limit) lines.push(line.replace(/\r$/, ""));
        lineNo++;
      }
    }
    if (eof && carry && lineNo >= offset && lines.length < limit) lines.push(carry.replace(/\r$/, ""));
    return { lines, eof };
  } finally { await handle.close(); }
}

export function createReadTool() {
  return {
    name: "Read",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to read, absolute or relative to the working folder." },
        offset: { type: "integer", minimum: 1, description: "First line to return (1-based). Default 1." },
        limit: { type: "integer", minimum: 1, maximum: READ_MAX_LINES, description: `Maximum number of lines to return. Default and maximum ${READ_MAX_LINES}.` },
      },
      required: ["path"],
      additionalProperties: false,
    },
    readOnly: true,
    concurrencySafe: true,

    summarize(input, ctx) {
      const raw = pathArg(input);
      const g = typeof raw === "string" && raw ? guard(input, ctx) : null;
      const where = g?.ok ? shown(g.abs, ctx) : String(raw ?? "");
      const extra = input?.offset ? `:${input.offset}${input.limit ? `-${toInt(input.offset) + toInt(input.limit) - 1}` : ""}` : "";
      return where + extra;
    },

    validate(input, ctx) {
      if (typeof pathArg(input) !== "string" || !pathArg(input).trim()) return "path is required (a string).";
      const g = guard(input, ctx);
      if (!g.ok) return g.message;
      for (const key of ["offset", "limit"]) {
        if (input[key] === undefined || input[key] === null) continue;
        const n = toInt(input[key]);
        if (!Number.isInteger(n) || n < 1) return `${key} must be a positive integer.`;
      }
      return null;
    },

    permission(input, ctx) {
      const g = guard(input, ctx);
      if (!g.ok) return { decision: "deny", reason: g.message, risk: "low", title: t("tools.perm.badPath") };
      return readVerdict(g, ctx);
    },

    async run(input, ctx) {
      const s = settings(ctx);
      const g = guard(input, ctx);
      if (!g.ok) return fail("badPath", g.message);
      const where = shown(g.abs, ctx);
      const offset = input.offset === undefined || input.offset === null ? 1 : Math.max(1, toInt(input.offset));
      const limit = input.limit === undefined || input.limit === null ? READ_MAX_LINES : Math.min(READ_MAX_LINES, Math.max(1, toInt(input.limit)));

      let stat;
      try { stat = fs.statSync(g.abs); }
      catch (error) {
        if (error.code === "ENOENT") {
          const like = similarNames(g.abs).map(p => shown(p, ctx));
          return fail("notFound", `File not found: ${where}.${like.length ? ` Did you mean: ${like.join(", ")}?` : " Use Glob to find the right name."}`, { file: where });
        }
        return fail("failed", fsErrorMessage(error, where));
      }
      if (stat.isDirectory()) return fail("isDir", `${where} is a folder, not a file. Use LS to list it.`, { file: where });
      if (!stat.isFile()) return fail("notFile", `${where} is not a regular file (device or pipe) and cannot be read.`, { file: where });

      if (stat.size > MAX_TEXT_BYTES) {
        let big;
        try { big = await readLargeLines(g.abs, offset, limit); }
        catch (error) { return fail("failed", fsErrorMessage(error, where)); }
        if (big.sniff) return ok(describeBinary(big.sniff, stat.size, where), { summary: t("tools.read.binary", { kind: big.sniff.label }) });
        if (big.tooLargeUtf16) return fail("tooBig", `${where} is a very large UTF-16 file (${formatBytes(stat.size)}); use Grep or a command-line tool instead.`);
        if (!big.lines.length) return fail("offsetPastEnd", `Offset ${offset} is past the end of the file.`);
        const body = big.lines.map((line, i) => lineTag(offset + i, clipLine(line, READ_MAX_LINE_CHARS))).join("\n");
        const last = offset + big.lines.length - 1;
        const more = big.eof ? "" : `\n[Large file (${formatBytes(stat.size)}). Showing lines ${offset}-${last}. Call Read again with offset=${last + 1} to continue.]`;
        return ok(body + more, { summary: tn("tools.read.lines", big.lines.length) });
      }

      let buf;
      try { buf = fs.readFileSync(g.abs); }
      catch (error) { return fail("failed", fsErrorMessage(error, where)); }
      const sniff = sniffFile(buf);
      if (sniff.kind !== "text") return ok(describeBinary(sniff, stat.size, where), { summary: t("tools.read.binary", { kind: sniff.label }) });

      const decoded = decodeText(buf);
      if (decoded.text === "") {
        recordRead(s.fileState, g.abs, { stat, buf, totalLines: 0, ranges: [], platform: s.platform });
        return ok(`The file ${where} exists but is empty (0 bytes).`, { summary: t("tools.read.empty") });
      }
      const all = decoded.text.split("\n");
      if (all[all.length - 1] === "") all.pop();
      const total = all.length;
      if (offset > total) return fail("offsetPastEnd", `Offset ${offset} is past the end of the file, which has ${total} line${total === 1 ? "" : "s"}.`, { total });

      const picked = [];
      let bytes = 0, lossy = false, byteCapHit = false;
      for (let i = offset - 1; i < total && picked.length < limit; i++) {
        let line = all[i];
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > READ_MAX_LINE_CHARS) lossy = true;
        const text = lineTag(i + 1, clipLine(line, READ_MAX_LINE_CHARS));
        bytes += Buffer.byteLength(text) + 1;
        if (bytes > READ_MAX_BYTES && picked.length > 0) { byteCapHit = true; break; }
        picked.push(text);
      }
      const last = offset + picked.length - 1;
      recordRead(s.fileState, g.abs, { stat, buf, totalLines: total, ranges: [[offset, last]], lossy, platform: s.platform });

      let out = picked.join("\n");
      const notes = [];
      if (last < total) {
        notes.push(`[Showing lines ${offset}-${last} of ${total}${byteCapHit ? ` (stopped at the ${READ_MAX_BYTES / 1024} KB limit)` : ""}. Call Read again with offset=${last + 1} to continue.]`);
      }
      if (decoded.encoding !== "utf8") notes.push(`[This file is ${decoded.encoding === "utf16le" ? "UTF-16 little-endian" : "UTF-16 big-endian"}; it is shown as text and edits keep that encoding.]`);
      if (decoded.invalid) notes.push("[Some bytes are not valid UTF-8 and show as replacement characters; this file cannot be edited safely with these tools.]");
      if (lossy) notes.push(`[Some lines were longer than ${READ_MAX_LINE_CHARS} characters and were cut.]`);
      if (notes.length) out += "\n" + notes.join("\n");
      return ok(out, { summary: tn("tools.read.lines", picked.length) });
    },
  };
}
