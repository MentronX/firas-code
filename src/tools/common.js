// Small helpers every tool shares: result builders, context defaults, text clipping.
import os from "node:os";
import path from "node:path";
import { t } from "../i18n/index.js";
import "./strings.js";
import { guardPath } from "./pathguard.js";
import { childEnv } from "../util/env.js";

export const CHAR_CAP = 30_000;

/** A successful result. `display` is what the person sees; `content` is what the model reads. */
export function ok(content, display) {
  return display ? { ok: true, content, display } : { ok: true, content };
}

/** A failed result. `code` selects the localized one-line summary shown on the tool card. */
export function fail(code, content, params) {
  return { ok: false, content, display: { summary: t(`tools.err.${code}`, params) } };
}

/** The context fields every tool needs, with safe defaults so a tool can also be called on its own. */
export function settings(ctx = {}) {
  return {
    cwd: ctx.cwd || process.cwd(),
    platform: ctx.platform || process.platform,
    env: ctx.env || process.env,
    fileState: ctx.fileState || (ctx.fileState = new Map()),
  };
}

// Every child the tools start (shell commands, background jobs, the search program, process killers) gets its
// environment through childEnv, so the access code never rides along by accident. It lives in util/env.js.
export { childEnv };

export const pathArg = input => (typeof input?.path === "string" ? input.path : input?.file_path);

/** Guards the path argument of a tool call; returns guardPath's result. */
export function guard(input, ctx, raw = pathArg(input)) {
  const s = settings(ctx);
  return guardPath(raw, { cwd: s.cwd, platform: s.platform });
}

/** Path as shown on cards and in prompts: relative to the project, ~ for home, or absolute. */
export function shown(abs, ctx) {
  const s = settings(ctx);
  const rel = path.relative(s.cwd, abs);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return reveal(rel.split(path.sep).join("/"));
  const home = os.homedir();
  const underHome = path.relative(home, abs);
  if (!underHome.startsWith("..") && !path.isAbsolute(underHome)) return reveal("~" + path.sep + underHome);
  return reveal(abs);
}

/**
 * The first few entries of a list result (paths, matches) for the folded body of its card, with a note saying how
 * many more there are. The model reads the full list in the result's content; this is only what a person glances at.
 */
export function previewBody(entries, total = entries.length, max = 3) {
  const head = entries.slice(0, max);
  return (total > head.length ? [...head, t("tools.more", { n: total - head.length })] : head).join("\n");
}

/** A localized phrase whose wording depends on the count: uses "<key>.one" when n is 1. */
export function tn(key, n, params = {}) { return t(n === 1 ? `${key}.one` : key, { n, ...params }); }

// Characters a terminal does not show as what they are: control codes, a lone carriage return, line separators other
// than \n, zero-width and direction-control characters, invisible "tag" characters. They can make a command or a path
// read differently from what it is, so text shown to a person has them spelled out.
export const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "gu");

/** The text with every hidden character replaced by its escape (\u202e, \r, ...). */
export function reveal(text) {
  return String(text ?? "").replace(HIDDEN_ALL, ch => {
    const cp = ch.codePointAt(0);
    if (cp === 13) return "\\r";
    return cp < 0x10000 ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\u{${cp.toString(16)}}`;
  });
}

export const lineTag = (n, text) => `${String(n).padStart(6)}\t${text}`;

export function clipLine(line, max) {
  return line.length > max ? `${line.slice(0, max)} ... [line cut: ${line.length} characters in total]` : line;
}

/** Keeps the start and the end of a long text, with a marker saying how much was left out of the middle. */
export function headTail(text, max = CHAR_CAP, headShare = 1 / 3) {
  if (text.length <= max) return text;
  const head = Math.floor(max * headShare);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n... [${omitted} characters omitted] ...\n${text.slice(text.length - tail)}`;
}

/** Keeps only the beginning, with a marker. */
export function headOnly(text, max, note = "output cut") {
  return text.length <= max ? text : `${text.slice(0, max)}\n... [${note}: ${text.length - max} more characters]`;
}

export function plural(n, one, many) { return n === 1 ? one : many; }

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function toInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return parseInt(value, 10);
  return NaN;
}

export const isPlainObject = v => !!v && typeof v === "object" && !Array.isArray(v);

/** First line of a text, trimmed and shortened for a card header. */
export function oneLine(text, max = 100) {
  const line = String(text ?? "").split(/\r?\n/).find(l => l.trim()) || "";
  const clean = line.trim().replace(/\s+/g, " ");
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}
