// How things look: tool cards, results, diffs, todos, notices, footers, and the dialogs that ask the person something
// (permission, question, plan, picker). Everything here returns VISUAL lines (already shaped and ordered for a terminal
// that has no bidi); interactive.js decides when they are printed. Nothing in this file writes to the terminal, except
// runMenu(), which draws into the host's live region and reads keys from it.
//
// Decisions:
//  - Widths: every function takes the CONTENT width (screen columns minus a 2-column gutter on each side, at most 100).
//    The caller adds the 2-space gutter when it prints.
//  - Structural lines (card headers, results, menu rows, footers) are LTR with the Arabic runs ordered inside them;
//    free text (notices, questions, todos, detail paragraphs) is laid out with layoutParagraph, which right-aligns RTL
//    paragraphs. A marker such as "▲" is part of the paragraph's logical text, so in an RTL paragraph it lands on the
//    right, where the line starts.
//  - Every line of interface text is laid out to the FULL width (para), never with vis() alone: a line without a width
//    cannot be right-aligned, and in the Arabic interface it would hang on the left of a right-aligned column.
//  - Runs whose direction must not leak into the line around them are isolated: a summary or a task label inside a
//    structural line gets its own isolate (first-strong; the rows of a wrapped task all take its whole label's
//    direction), counts ("+4", "↑ 3.2k") and durations are isolated in Arabic lines. The isolates are removed again
//    once the line is ordered (stripBidiMarks).
//  - Hints are built from their parts (" · ") and lose parts from the end when they do not fit. They never wrap: a key
//    on one line and its word on the next reads as two broken hints.
//  - A box takes its width ONCE per draw (runMenu hands it to build()), and its rows, borders, body and hint are all laid
//    out from that one width; every row is padded AND cut to exactly the inner width, and Arabic marks are dropped from
//    it (Windows Terminal gives each a cell). In the Arabic interface the box is mirrored: title, risk edge and pointer
//    on the right.
//  - Model and tool text is untrusted: cleanText() strips escape sequences and control characters (tabs become 4
//    spaces) before anything is measured or laid out.
//  - A number key in a menu only MOVES the selection; Enter confirms. Together with a short grace period after a dialog
//    opens, a stray key typed ahead while the agent was working can never approve an action.
import { c, sym, hasUnicode, colorLevel } from "./theme.js";
import { t, getLang } from "../i18n/index.js";
import { arabicActive, baseDirection, hasRtl, layoutParagraph, stringWidth, stripAnsi, toVisual, wrapLogical } from "../text/display.js";
import { renderDiff } from "./diff.js";
import { autoIsolate, dropArabicMarks, fitLogical, fitPathTail, ltrIsolate, stripBidiMarks } from "./textfit.js";
import { clipLine } from "./screen.js";
import { paintUltra } from "./ultra.js";
import "./strings-app.js";

export const GUTTER = "  ";
export const FOLD_BODY_LINES = 8;
export const FOLD_DIFF_LINES = 12;

// The arrows come from the glyph tier; a plain-ASCII terminal spells the pair out instead.
export const UP = sym.up;
export const DOWN = sym.down;
const UP_DOWN = hasUnicode ? `${sym.up}/${sym.down}` : "Up/Down";

/** A menu hint line with the arrow keys filled in (logical text; lay it out with hintRow). */
export function menuHint(key) { return t(key, { ud: UP_DOWN }); }

// Never below 20: the screen reports at least 20 columns, and the column plus its 2-column gutter must fit in those.
export function contentWidth(columns) { return Math.max(20, Math.min(100, (columns | 0 || 80) - 4)); }

/** The Arabic interface with Arabic handling on: the column is right-aligned and boxes are mirrored. */
export function rtlUi() { return arabicActive() && getLang() === "ar"; }

// ---------------------------------------------------------------------------------------------------------------------
// Text hygiene

const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function expandTabs(line, size = 4) {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(size - (out.length % size)) : ch;
  return out;
}

/**
 * Untrusted text -> plain text that is safe to lay out: no escape sequences, no controls, no direction controls (an
 * override inside a command would make the box show its words in another order than they will run), tabs expanded to
 * `tabs` columns (0 keeps the tabs and the direction marks: print mode hands the text to other programs, and a
 * Makefile needs its tabs).
 */
export function cleanText(text, { tabs = 4 } = {}) {
  let s = stripAnsi(String(text ?? "")).replace(/\r\n/g, "\n");
  if (s.includes("\r")) s = s.split("\n").map(line => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line)).join("\n");
  s = s.replace(CONTROLS, "");
  return tabs > 0 ? stripBidiMarks(s).split("\n").map(line => expandTabs(line, tabs)).join("\n") : s;
}

/**
 * The same for text that arrives in pieces: an escape sequence cut in two by a chunk boundary is held back until its
 * other half comes, so no stray "[31m" ever shows. push() returns clean text; flush() forgets a dangling fragment.
 */
export function createStreamCleaner({ tabs = 4 } = {}) {
  let carry = "";
  return {
    push(chunk) {
      let s = carry + String(chunk ?? "");
      carry = "";
      const open = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*)?$/.exec(s);
      if (open && open[0].length <= 256) { carry = open[0]; s = s.slice(0, open.index); }
      const clean = cleanText(s, { tabs: 0 });
      return tabs > 0 ? stripBidiMarks(clean).replace(/\t/g, " ".repeat(tabs)) : clean;
    },
    flush() { carry = ""; return ""; },
  };
}

/** Plain logical text shortened to at most `max` cells (with an ellipsis). */
export function truncateLogical(text, max) {
  const plain = String(text ?? "").replace(/\s+/g, " ").trim();
  if (stringWidth(plain) <= max) return plain;
  const row = wrapLogical(plain, Math.max(1, max - stringWidth(sym.ellipsis)))[0] || "";
  return row.trimEnd() + sym.ellipsis;
}

/** A card summary shortened to \`room\` cells: a path keeps its end (the file name), anything else its beginning. */
function fitSummary(text, room) {
  const plain = String(text ?? "").replace(/\s+/g, " ").trim();
  if (stringWidth(plain) <= room) return plain;
  const isPath = !/\s/.test(plain) && (plain.includes("/") || plain.includes(String.fromCharCode(92)));
  return isPath ? fitPathTail(plain, room, sym.ellipsis) : truncateLogical(plain, room);
}

/** A free-text paragraph as visual lines, wrapped to `width`. */
export function para(text, width, opts) {
  // With Arabic handling switched off the direction isolates in the strings would reach the terminal as they are.
  return layoutParagraph(String(text ?? ""), Math.max(8, width), opts).map(stripBidiMarks);
}

/**
 * One line of interface text (anything from t() or typed by a person), shaped and ordered for the terminal. Lines that
 * were already laid out must NOT go through this again: ordering twice would turn them back. It has no width, so it
 * cannot right-align: anything that may be Arabic belongs in para(text, width) instead.
 */
export function vis(text, dir = "auto") { return stripBidiMarks(toVisual(String(text ?? ""), { dir })); }

/**
 * A line under the prompt box (a hint): two columns of gutter, and right-aligned when it is Arabic like the notices
 * above it. Too long, it is shortened at its end (in reading order) rather than cut by the screen, which would take the
 * START of an Arabic line.
 */
export function footerRow(text, width) {
  const room = Math.max(8, (width | 0) - 4);
  const body = stringWidth(String(text ?? "")) > room ? fitLogical(String(text ?? ""), room, sym.ellipsis) : String(text ?? "");
  const line = "  " + body;
  return stripBidiMarks(toVisual(line, hasRtl(line) ? { dir: "rtl", width, align: "end" } : { dir: "ltr" }));
}

/**
 * A hint (the keys of a dialog) as ONE visual line of at most `width` cells. It is built from its parts (" · ") and
 * parts are dropped from the end until it fits, so a key never lands on one line and its word on the next. Drawn dim
 * (pass plain text); an Arabic hint is right-aligned like the rows above it.
 */
export function hintRow(text, width) {
  const room = Math.max(8, width | 0);
  const parts = stripAnsi(String(text ?? "")).split(" · ").map(part => part.trim()).filter(Boolean);
  if (!parts.length) return "";
  const sep = ` ${sym.dot} `;
  let shown = parts;
  while (shown.length > 1 && stringWidth(shown.join(sep)) > room) shown = shown.slice(0, -1);
  return para(c.dim(fitLogical(shown.join(sep), room, sym.ellipsis)), room)[0] ?? "";
}

/** `label` padded to `cells` columns (by width, not by character count), for two-column listings. */
export function padLabel(label, cells) { return padEnd(vis(label), cells); }

export function padEnd(line, width) {
  const gap = width - stringWidth(line);
  return gap > 0 ? line + " ".repeat(gap) : line;
}

/**
 * A visual line made EXACTLY `width` cells: padded when it is short, cut when it is long (padEnd alone never cuts, and a
 * box row one cell too wide pushes its border out). Arabic marks are dropped first: the terminal gives each one a cell.
 */
export function fitRow(line, width) {
  const cells = Math.max(0, width | 0);
  let out = dropArabicMarks(line);
  if (stringWidth(out) > cells) {
    const cut = clipLine(out, cells);
    out = colorLevel() ? cut : stripAnsi(cut);
  }
  return padEnd(out, cells);
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("app.dur.s", { s });
  return t("app.dur.ms", { m: Math.floor(s / 60), s: s % 60 });
}

export function fmtTokens(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 10_000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (v < 1_000_000) return Math.round(v / 1000) + "k";
  return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

// The direction a paragraph of plain text will be laid out in: its first strong letter, or right-to-left when a Latin
// word leads a sentence that is mostly Arabic (the same rule layoutParagraph applies, so the two always agree).
function textDirection(text) {
  if (!arabicActive() || !hasRtl(text)) return "ltr";
  if (baseDirection(text) === "rtl") return "rtl";
  const plain = stripAnsi(text);
  const rtl = (plain.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) || []).length;
  const ltr = (plain.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  return rtl > ltr ? "rtl" : "ltr";
}

// The right-to-left counterpart of ltrIsolate, for a run whose direction was already decided (textDirection).
const rtlIsolate = s => String.fromCharCode(0x2067) + s + String.fromCharCode(0x2069);

// ---------------------------------------------------------------------------------------------------------------------
// Notices, footers, todos

const NOTICE_STYLE = {
  info: { mark: () => c.accent(sym.info), text: s => c.gray(s) },
  warn: { mark: () => c.yellow(sym.warn), text: s => c.yellow(s) },
  error: { mark: () => c.red(sym.cross), text: s => c.red(s) },
};

export function renderNotice(level, text, width) {
  const style = NOTICE_STYLE[level] || NOTICE_STYLE.info;
  const body = cleanText(text).trim();
  const mark = style.mark();
  // The hanging indent is the mark and its space, so a wrapped notice lines up under its text in every glyph tier.
  return para(`${mark} ${style.text(body)}`, width, { indent: " ".repeat(stringWidth(mark) + 1) });
}

/**
 * A dim line under a finished turn: how long it took and what it cost, plus why it stopped when that was not normal.
 * The duration and each count are isolated, so in the Arabic interface "1 د 12 ث" and "↑ 3.2k" keep their order (an
 * Arabic letter in front of "3.2k" would otherwise split it); there the line is right-aligned like the column above it.
 */
export function renderTurnFooter({ ms, inTokens = 0, outTokens = 0, stopReason = "end_turn" }, width) {
  const parts = [];
  const tag = { aborted: "interrupted", max_steps: "stepLimit", max_tokens: "lengthLimit", error: "error", empty: "empty" }[stopReason];
  if (tag) parts.push(t(`app.stop.${tag}`));
  parts.push(autoIsolate(fmtDuration(ms)));
  if (inTokens || outTokens) parts.push(`${ltrIsolate(`${UP} ${fmtTokens(inTokens)}`)} ${ltrIsolate(`${DOWN} ${fmtTokens(outTokens)}`)}`);
  const room = Math.max(8, width | 0);
  const sep = ` ${sym.dot} `;
  const compose = list => `${sym.think} ${list.join(sep)}`;
  let shown = parts;
  while (shown.length > 1 && stringWidth(compose(shown)) > room) shown = shown.slice(0, -1);
  const line = c.dim(fitLogical(compose(shown), room, sym.ellipsis));
  return [stripBidiMarks(toVisual(line, rtlUi() ? { dir: "rtl", width: room, align: "end" } : { dir: "ltr" }))];
}

const todoLabel = item => cleanText(item.status === "in_progress" && item.activeForm ? item.activeForm : item.content).replace(/\s+/g, " ").trim();

/** The status mark of a task: done, running now, waiting. Shape AND colour, so it reads without colour too. */
function todoMark(item) {
  if (item.status === "completed") return c.green(sym.checked);
  if (item.status === "in_progress") return c.accent(sym.active);
  return c.gray(sym.checkbox);
}

/**
 * The task list as free text (Arabic tasks right-aligned, the mark on the right), or, with `structural`, as part of the
 * card it is printed under: left-to-right like the card's header, the mark on the left and every label isolated so it
 * keeps its own direction. Without that, under a left-to-right card, an Arabic list sat at the far edge of the screen,
 * away from the card it belongs to.
 */
export function renderTodos(items, width, { structural = false } = {}) {
  const lines = [];
  for (const item of items) {
    const mark = todoMark(item);
    const label = todoLabel(item);
    const style = item.status === "completed" ? c.dim : item.status === "in_progress" ? c.bold : s => s;
    // Hanging indent = the mark's own width + its space: a wrapped task lines up under its text in every glyph tier.
    const hang = " ".repeat(stringWidth(mark) + 1);
    if (structural) {
      // A label is one paragraph, so its direction is decided once, from all of it, and every wrapped row is isolated
      // in that direction. Left to each row's own first letter, a row that started with "README" turned left-to-right
      // in the middle of an Arabic task and read in the wrong order.
      const isolate = textDirection(label) === "rtl" ? rtlIsolate : ltrIsolate;
      const rows = wrapLogical(label, Math.max(4, width - hang.length));
      rows.forEach((row, i) => lines.push(stripBidiMarks(toVisual(`${i ? hang : `${mark} `}${isolate(style(row))}`, { dir: "ltr" }))));
      continue;
    }
    lines.push(...para(`${mark} ${style(label)}`, width, { indent: hang }));
  }
  return lines;
}

/**
 * The one result line of a status change: `└ ✓ build · ● tests · 1 of 3 done`. Each mark and its task are isolated
 * together, and the task label gets its own direction inside: in Arabic the neutral marks and dots between two Arabic
 * labels would otherwise join one right-to-left run, and a mark would end up next to the other task.
 */
function todoStatusLine(moved, summary, width) {
  const room = Math.max(8, width - 4);
  const pair = (item, cap) => ltrIsolate(`${todoMark(item)} ${autoIsolate(truncateLogical(todoLabel(item), cap))}`);
  const tail = cleanText(summary || "").replace(/\s+/g, " ").trim();
  const sep = ` ${sym.dot} `;
  const compose = (n, cap) => {
    const parts = moved.slice(0, n).map(item => pair(item, cap));
    if (moved.length > n) parts.push(ltrIsolate(`+${moved.length - n}`));
    if (tail) parts.push(autoIsolate(tail));
    return parts.join(sep);
  };
  // Shorter labels first, fewer tasks after: the tasks that moved are the news, the count of the rest says the remainder.
  let text = "";
  for (let n = Math.min(3, moved.length); n >= 1 && !text; n--) {
    for (const cap of [40, 24, 14]) {
      if (stringWidth(compose(n, cap)) <= room) { text = compose(n, cap); break; }
    }
  }
  // Narrower still: the first task alone, its label as long as the line allows.
  text = text || pair(moved[0], Math.max(4, room - 2));
  return `${GUTTER}${c.gray(sym.corner)} ${stripBidiMarks(toVisual(text, { dir: "ltr" }))}`;
}

/**
 * What one TodoWrite call adds to the scrollback, given the list its last card showed (`before`, or null). The task
 * list is pinned on screen while it changes, so the scrollback only needs:
 *  - nothing, when the list is the same as before;
 *  - one result line naming the tasks that moved, when only statuses changed (one finished, the next one started);
 *  - the whole list under the card, when it is new or its tasks changed.
 * Returns { lines, full } (full: the whole list was printed) or null.
 */
export function renderTodoCard(card, items, before, summary, width) {
  const same = Array.isArray(before) && before.length === items.length && items.every((item, i) => before[i].content === item.content);
  if (same && items.every((item, i) => before[i].status === item.status)) return null;
  if (same) {
    const moved = items.filter((item, i) => before[i].status !== item.status);
    return { lines: [toolHeader(card, width, "ok"), todoStatusLine(moved, summary, width)], full: false };
  }
  const head = renderToolCard(card, { ok: true, summary }, width).lines;
  return { lines: [...head, ...renderTodos(items, Math.max(8, width - 4), { structural: true }).map(line => "    " + line)], full: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool cards

/** `● Read(src/app.js)`: the bullet says how it went, the name is bold, the argument dim. state: "running" | "ok" | "error". */
export function toolHeader({ name, summary, readOnly, risk }, width, state = "running") {
  const bullet = state === "ok" ? c.accent(sym.bullet) : state === "error" ? c.red(sym.bullet)
    : risk === "high" ? c.red(sym.bullet) : readOnly ? c.gray(sym.bullet) : c.yellow(sym.bullet);
  const label = truncateLogical(cleanText(name).trim(), Math.max(4, width - 2));
  const room = width - stringWidth(label) - 5;
  const inner = room >= 4 ? fitSummary(cleanText(summary), room) : "";
  const line = inner ? `${bullet} ${c.bold(label)}${c.dim(`(${inner})`)}` : `${bullet} ${c.bold(label)}`;
  return stripBidiMarks(toVisual(line, { dir: "ltr" }));
}

/**
 * The line under a card, `└ summary`. A card's result is structural: left-to-right, with the summary isolated so it
 * keeps its own direction inside (an Arabic summary starting with a number still reads right), cut to one line.
 * With `prose` (an answer, a sub-agent's result standing on its own) an Arabic summary is laid out as an Arabic
 * paragraph instead: right-aligned, the corner at its start, wrapped under itself. `paint` styles the text (default:
 * plain when ok, red when not).
 */
export function resultRows(summary, width, { ok = true, prose = false, paint } = {}) {
  const text = cleanText(summary || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const style = paint || (ok ? s => s : s => c.red(s));
  if (prose) {
    const dir = textDirection(text);
    const rows = para(`${c.gray(sym.corner)} ${style(text)}`, Math.max(8, width - GUTTER.length), { dir, indent: "  " });
    // Indented by the gutter on the reading side: on the left in English, on the right (by the narrower width) in Arabic.
    return dir === "rtl" ? rows : rows.map(line => GUTTER + line);
  }
  const fitted = truncateLogical(text, Math.max(4, width - 4));
  return [`${GUTTER}${c.gray(sym.corner)} ${stripBidiMarks(toVisual(style(autoIsolate(fitted)), { dir: "ltr" }))}`];
}

function bodyLines(body, width, indent) {
  const text = cleanText(body).replace(/\s+$/, "");
  if (!text) return [];
  const out = [];
  for (const raw of text.split("\n")) {
    const rows = wrapLogical(raw, Math.max(8, width - indent.length));
    for (const row of rows.length ? rows : [""]) out.push(indent + toVisual(c.dim(row), { dir: "auto" }));
  }
  return out;
}

/**
 * A dim fold note ("… +22 lines (Ctrl+O to expand)") as ONE line at the full width: right-aligned when it is Arabic.
 * Where it does not fit, the explanation in brackets goes first ("… +22 lines" still says what happened), then the end
 * of the words.
 */
function foldNote(text, width) {
  const room = Math.max(8, width);
  let line = String(text ?? "");
  if (stringWidth(line) > room && line.includes(" (")) line = line.slice(0, line.indexOf(" ("));
  if (stringWidth(line) > room) line = fitLogical(line, room, sym.ellipsis);
  return para(c.dim(line), room);
}

/**
 * The finished card of one tool call: header, result line, and the folded body or diff.
 * Returns { lines, full, hidden } where `full` is the unfolded version and `hidden` how many lines were folded away.
 */
export function renderToolCard(card, end, width) {
  const state = end.ok ? "ok" : "error";
  const head = toolHeader(card, width, state);
  const lead = [head, ...resultRows(end.summary, width, { ok: end.ok })];
  const indent = "    ";
  let detail = [];
  if (end.diff) {
    try { detail = renderDiff(end.diff, { width: Math.max(10, width - indent.length), maxLines: 2000 }).map(line => indent + line); } catch { detail = []; }
  }
  if (!detail.length && end.body) detail = bodyLines(end.body, width, indent);
  const limit = end.diff ? FOLD_DIFF_LINES : FOLD_BODY_LINES;
  const hidden = Math.max(0, detail.length - limit);
  const shown = hidden > 1 ? detail.slice(0, limit) : detail;
  const folded = hidden > 1 ? hidden : 0;
  const tail = folded ? foldNote(t("app.card.more", { n: folded }), width - indent.length).map(line => indent + line) : [];
  return { lines: [...lead, ...shown, ...tail], full: [...lead, ...detail], hidden: folded };
}

/** The lines shown for a running tool: its header and the last few lines of live output. */
export function renderRunningCard(card, tail, width) {
  const lines = [toolHeader(card, width, "running")];
  for (const row of tail.slice(-3)) {
    const clipped = truncateLogical(cleanText(row), Math.max(8, width - 6));
    lines.push(`${GUTTER}${c.gray(sym.pipe)} ${toVisual(c.dim(clipped), { dir: "auto" })}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Boxes and menus

const EDGE = { low: s => c.accent(s), medium: s => c.yellow(s), high: s => c.red(s) };

/**
 * The outer and inner width of a box drawn in `width` columns. The one rule for the box, its rows, its body and its
 * hint, so they can never disagree (at most 100; never below 16, the narrowest content width).
 */
export function boxWidth(width) {
  const outer = Math.max(16, Math.min(width | 0 || 80, 100));
  return { outer, inner: outer - 4 };
}

/**
 * Wraps visual `lines` in a box. `risk` colours the edge on the reading side (the left; the right in the Arabic
 * interface) and its corners; `title` sits in the top border on that side. Every row is exactly the inner width.
 */
export function frame(lines, { width, risk = "low", title = "", rtl = rtlUi() } = {}) {
  const { outer, inner } = boxWidth(width);
  const edge = EDGE[risk] || EDGE.low;
  const rule = s => c.gray(s);
  // The title may carry colour (a risk label), so it is only shortened, never cleaned, when it is too long.
  let label = title ? ` ${title} ` : "";
  if (stringWidth(label) > inner - 2) label = ` ${truncateLogical(stripAnsi(title), inner - 4)} `;
  const shown = label ? c.bold(dropArabicMarks(stripBidiMarks(toVisual(label, { dir: rtl ? "rtl" : "auto" })))) : "";
  const fill = rule(sym.boxH.repeat(Math.max(0, outer - 3 - stringWidth(shown))));
  const top = rtl
    ? rule(sym.boxTL) + fill + shown + edge(sym.boxH) + edge(sym.boxTR)
    : edge(sym.boxTL) + edge(sym.boxH) + shown + fill + rule(sym.boxTR);
  const bottom = rtl
    ? rule(sym.boxBL) + rule(sym.boxH.repeat(outer - 2)) + edge(sym.boxBR)
    : edge(sym.boxBL) + rule(sym.boxH.repeat(outer - 2)) + rule(sym.boxBR);
  const [left, right] = rtl ? [rule, edge] : [edge, rule];
  const rows = lines.map(line => `${left(sym.boxV)} ${fitRow(line, inner)} ${right(sym.boxV)}`);
  return [top, ...rows, bottom];
}

const RLM = String.fromCharCode(0x200f);

/**
 * One row per item; `selected` is highlighted. Labels may be Arabic: they are ordered inside the row. Hints line up in
 * one column, and are left out when the row has no room for them (a row never grows past the box). Numbers take their
 * real width ("10." is three cells) and are padded to the widest, so the labels line up. In the Arabic interface the
 * rows are mirrored like the paragraphs and notices around them (pointer and number on the right, text right-aligned);
 * `rtl` forces either way.
 */
export function menuRows(items, selected, { width, multi = false, checked = new Set(), rtl = rtlUi() } = {}) {
  const { inner: limit } = boxWidth(width);
  const digits = String(items.length).length;
  const pointerW = stringWidth(sym.prompt);
  const boxW = multi ? stringWidth(sym.checked) + 1 : 0;
  const lead = pointerW + 1 + boxW + digits + 1 + 1;
  const avail = Math.max(4, limit - lead);
  const labels = items.map(item => truncateLogical(cleanText(item.label), avail));
  const hints = items.map(item => cleanText(item.hint || "").replace(/\s+/g, " ").trim());
  const column = Math.max(0, ...labels.map((label, i) => (hints[i] ? stringWidth(label) : 0)));
  const room = avail - column - 2;
  const withHints = room >= 6;
  return items.map((item, i) => {
    const on = i === selected;
    const pointer = on ? c.accent(sym.prompt) : " ".repeat(pointerW);
    const box = multi ? `${checked.has(i) ? c.accent(sym.checked) : c.gray(sym.checkbox)} ` : "";
    // Padded on the far side of the pointer: "10." and " 9." in English, "10." and "9. " in Arabic (labels line up).
    const num = `${i + 1}.`;
    const pad = " ".repeat(digits + 1 - num.length);
    const number = c.gray(rtl ? num : pad + num) + (rtl ? pad : "");
    const hint = withHints && hints[i] ? `${" ".repeat(column - stringWidth(labels[i]))}  ${c.dim(truncateLogical(hints[i], room))}` : "";
    const text = on ? c.bold(c.accent(labels[i])) : labels[i];
    // The mark after the number keeps it on the right of a label written in Latin letters too ("3." then "English").
    const logical = `${pointer} ${box}${number}${rtl ? RLM : ""} ${text}${hint}`;
    return paintUltra(stripBidiMarks(rtl ? toVisual(logical, { dir: "rtl", width: limit, align: "end" }) : toVisual(logical, { dir: "ltr" })));
  });
}

/**
 * A pick-one (or pick-several) menu in the host's live region.
 * host: { width(), height?(), show(lines, cursor?), hide(), onKey(cb) -> off, print(lines), onResize?(cb) -> off }.
 * opts: { items:[{label, hint?}], initial, multi, signal, graceMs, build(rows, {selected, width}) -> lines }
 * The width is read ONCE per draw and handed to build() with the rows, so a box drawn after a resize is laid out from
 * the same width as its rows.
 * Resolves { cancelled:true } (Esc, Ctrl+C, abort) or { cancelled:false, index, indices }.
 */
export function runMenu(host, { items, initial = 0, multi = false, signal, graceMs = 0, build }) {
  return new Promise(resolve => {
    let selected = Math.max(0, Math.min(items.length - 1, initial));
    const checked = new Set();
    let done = false;
    const openedAt = Date.now();
    const draw = () => {
      if (done) return;
      const width = host.width();
      const rows = menuRows(items, selected, { width, multi, checked });
      host.show(build ? build(rows, { selected, width }) : rows, null);
    };
    const finish = result => {
      if (done) return;
      done = true;
      off();
      offResize?.();
      signal?.removeEventListener("abort", onAbort);
      host.hide();
      resolve(result);
    };
    const onAbort = () => finish({ cancelled: true });
    const onKey = key => {
      const grace = Date.now() - openedAt < graceMs;
      const letter = key.name === "char" && !key.alt ? String(key.ch || "") : "";
      if (key.name === "escape" || (key.ctrl && letter.toLowerCase() === "c")) { finish({ cancelled: true }); return; }
      if (key.name === "up" || (key.ctrl && letter.toLowerCase() === "p")) { selected = (selected + items.length - 1) % items.length; draw(); return; }
      if (key.name === "down" || key.name === "tab" || (key.ctrl && letter.toLowerCase() === "n")) { selected = (selected + 1) % items.length; draw(); return; }
      if (key.name === "backtab") { selected = (selected + items.length - 1) % items.length; draw(); return; }
      if (key.name === "home") { selected = 0; draw(); return; }
      if (key.name === "end") { selected = items.length - 1; draw(); return; }
      if (!key.ctrl && /^[1-9]$/.test(letter) && Number(letter) <= items.length) {
        if (!grace) { selected = Number(letter) - 1; draw(); }
        return;
      }
      if (multi && !key.ctrl && letter === " ") {
        if (!grace) { if (checked.has(selected)) checked.delete(selected); else checked.add(selected); draw(); }
        return;
      }
      if (key.name === "return" && !grace) {
        finish({ cancelled: false, index: selected, indices: multi ? [...checked].sort((a, b) => a - b) : [selected] });
      }
    };
    const off = host.onKey(onKey);
    const offResize = host.onResize?.(draw);
    if (signal?.aborted) { finish({ cancelled: true }); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    draw();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Permission dialog

function riskLabel(risk) {
  const text = t(`app.risk.${risk === "high" || risk === "medium" ? risk : "low"}`);
  return risk === "high" ? c.red(text) : risk === "medium" ? c.yellow(text) : c.accent(text);
}

function foldRows(rows, max, width) {
  if (rows.length <= max + 1) return rows;
  return [...rows.slice(0, max), ...foldNote(t("app.fold.more", { n: rows.length - max }), width)];
}

/**
 * The text part of a permission box (everything above the options), as visual lines no wider than `inner` and, when
 * `maxRows` is given, no more than that many.
 */
export function permissionBody(req, inner, maxRows = Infinity) {
  const lines = [];
  // The English box reads left to right like its title, "Run: echo مرحبا بالعالم": each line takes the direction of its
  // own first letter. The paragraph rule (a Latin word leading a mostly Arabic sentence makes it Arabic) is for prose;
  // here it put the command after its Arabic argument and the label in the middle of a path.
  const own = rtlUi() ? () => ({}) : text => ({ dir: baseDirection(text) });
  const title = cleanText(req.title || req.tool || "").trim();
  lines.push(...para(`${c.bold(title)}`, inner, own(title)));
  const summary = cleanText(req.summary || "").trim();
  if (summary && !title.includes(summary)) lines.push(...para(c.dim(summary), inner, own(summary)));
  // The detail is the full text of what will happen. When the title already shows exactly that (a command, a path) it
  // is not printed a second time: only a longer or multi-line version adds anything.
  const squash = text => text.replace(/\s+/g, " ").trim();
  const whole = cleanText(req.detail || "").replace(/\s+$/, "");
  const repeated = !whole || squash(title).includes(squash(whole)) || (summary !== "" && squash(summary) === squash(whole));
  // A detail made of paragraphs ("what it is for", blank line, the command) loses the paragraph the title already ends
  // with, so a short command is not shown twice; a longer or multi-line version is a paragraph of its own and stays.
  const detailText = repeated ? "" : whole.split(/\n[ \t]*\n/)
    .filter(part => { const p = squash(part); return p && !squash(title).endsWith(p) && p !== squash(summary); })
    .join("\n\n");
  // The detail and the diff, each shown up to `keep` rows (14 and 24) and folded after that.
  const parts = [];
  if (detailText) {
    const detail = [];
    // A bullet that wraps keeps its text under the text, not under the bullet.
    for (const raw of detailText.split("\n")) detail.push(...para(raw, inner, { ...own(raw), ...(/^[•*-] /.test(raw) ? { indent: "  " } : {}) }));
    parts.push({ rows: detail, keep: Math.min(14, detail.length - 1) });
  }
  if (req.diff) {
    let preview = [];
    try { preview = renderDiff(req.diff, { width: inner, maxLines: 400 }); } catch { preview = []; }
    if (preview.length) parts.push({ rows: preview, keep: Math.min(24, preview.length - 1) });
  }
  // A box taller than the screen loses its TOP (the live region keeps the bottom rows), and that is the border with the
  // risk and the title, the one line that says which file or command is being approved. So past `maxRows` the detail
  // and the diff give up rows, the longer of the two first, down to one row each.
  const height = () => lines.length + parts.reduce((n, p) => n + 1 + Math.min(p.rows.length, p.keep + 1), 0);
  while (height() > maxRows && parts.some(p => p.keep > 1)) parts.reduce((a, b) => (b.keep > a.keep ? b : a)).keep -= 1;
  if (height() <= maxRows) {
    for (const p of parts) lines.push("", ...foldRows(p.rows, p.keep, inner));
    return lines;
  }
  // Shorter still: as much of the title as fits (its first row at least) and one line for everything under it.
  const shown = Math.max(1, Math.min(lines.length, maxRows - 1));
  const hidden = lines.length - shown + parts.reduce((n, p) => n + p.rows.length, 0);
  return [...lines.slice(0, shown), ...foldNote(t("app.fold.more", { n: hidden }), inner)];
}

/**
 * Remembers what was laid out for one size (the inner width, and the rows when they matter): a redraw at the same size
 * (every key press) costs nothing.
 */
function perWidth(make) {
  let at = "";
  let value;
  return (...size) => {
    const key = size.join("x");
    if (key !== at) { value = make(...size); at = key; }
    return value;
  };
}

/**
 * The permission question. `readLine({prefix, hint}) -> Promise<string|null>` collects the optional "tell Firas what to
 * do instead" text. Resolves { decision: "allow"|"allow-session"|"deny", feedback? }; anything unclear is a denial.
 */
export async function permissionDialog(host, req, { readLine, graceMs = 0 } = {}) {
  const risk = req.risk === "high" || req.risk === "medium" ? req.risk : "low";
  const body = perWidth((inner, rows) => permissionBody(req, inner, rows));
  const items = [{ label: t("app.perm.allow"), value: "allow" }];
  if (req.sessionKey) items.push({ label: cleanText(req.sessionLabel || t("app.perm.allowSession")), value: "allow-session" });
  items.push({ label: t("app.perm.deny"), value: "deny" }, { label: t("app.perm.denyWhy"), value: "feedback" });
  const title = `${t("app.perm.title")} ${sym.dot} ${riskLabel(risk)}`;
  const build = (rows, { width = host.width() } = {}) => {
    const { inner } = boxWidth(width);
    // The whole box must fit the live region, which is one row shorter than the screen. The borders, the two blank
    // lines, the choices and the hint are never folded; the body gets the rows that are left.
    const room = (Number(host.height?.()) || Infinity) - 1 - (rows.length + 5);
    return frame([...body(inner, room), "", ...rows, "", hintRow(menuHint("app.menu.hint"), inner)], { width, risk, title });
  };
  for (;;) {
    const picked = await runMenu(host, { items, initial: 0, signal: req.signal, graceMs, build });
    if (picked.cancelled) return { decision: "deny" };
    const choice = items[picked.index].value;
    if (choice === "allow" || choice === "allow-session" || choice === "deny") return { decision: choice };
    const text = readLine ? await readLine({ prefix: c.accent(sym.prompt) + " ", hint: t("app.perm.denyHint") }) : null;
    if (req.signal?.aborted) return { decision: "deny" };
    if (typeof text === "string" && text.trim()) return { decision: "deny", feedback: text.trim() };
    // Esc or an empty line in the feedback box goes back to the choices.
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Question and plan dialogs

/** AskUserQuestion. Resolves { answer } ("" when the person dismissed it). */
export async function questionDialog(host, { question, options = [], multi = false }, { readLine, graceMs = 0, signal } = {}) {
  const head = perWidth(inner => para(c.bold(cleanText(question).trim()), inner));
  const title = t("app.q.title");
  const typeOwn = async () => {
    const text = readLine ? await readLine({ prefix: c.accent(sym.prompt) + " ", hint: t("app.q.typeHint") }) : null;
    return typeof text === "string" ? text.trim() : "";
  };
  if (!options.length) {
    // Without choices the question goes into the scrollback and the person answers on the prompt line below it.
    const width = host.width();
    host.print(frame([...head(boxWidth(width).inner)], { width, risk: "low", title }));
    return { answer: await typeOwn() };
  }
  const items = options.map(o => ({ label: o.label, hint: o.description }));
  items.push({ label: t("app.q.other") });
  const build = (rows, { width = host.width() } = {}) => {
    const { inner } = boxWidth(width);
    return frame([...head(inner), "", ...rows, "", hintRow(menuHint(multi ? "app.menu.hintMulti" : "app.menu.hintPick"), inner)], { width, risk: "low", title });
  };
  for (;;) {
    const picked = await runMenu(host, { items, multi, signal, graceMs, build });
    if (picked.cancelled) return { answer: "" };
    const other = items.length - 1;
    const chosen = picked.indices.filter(i => i !== other).map(i => options[i].label);
    if (picked.indices.includes(other) || (picked.index === other && !chosen.length)) {
      const own = await typeOwn();
      if (own) return { answer: [...chosen, own].join(", ") };
      continue;
    }
    return { answer: chosen.join(", ") };
  }
}

/** ExitPlanMode. The plan itself is printed by the caller before this is asked. */
export async function planDialog(host, { readLine, graceMs = 0, signal } = {}) {
  const items = [
    { label: t("app.plan.approve") },
    { label: t("app.plan.approveEdits") },
    { label: t("app.plan.reject") },
  ];
  const build = (rows, { width = host.width() } = {}) => {
    const { inner } = boxWidth(width);
    return frame([...para(c.bold(t("app.plan.question")), inner), "", ...rows, "", hintRow(menuHint("app.menu.hint"), inner)], { width, risk: "low", title: t("app.plan.title") });
  };
  for (;;) {
    const picked = await runMenu(host, { items, signal, graceMs, build });
    if (picked.cancelled) return { decision: "reject" };
    if (picked.index === 0) return { decision: "approve" };
    if (picked.index === 1) return { decision: "approve-edits" };
    const text = readLine ? await readLine({ prefix: c.accent(sym.prompt) + " ", hint: t("app.plan.rejectHint") }) : null;
    if (typeof text === "string" && text.trim()) return { decision: "reject", feedback: text.trim() };
  }
}

/** A plain picker (sessions, language): resolves the chosen index or -1. `footer` replaces the hint (plain text). */
export async function pickDialog(host, { title, items, initial = 0, signal, graceMs = 0, footer }) {
  const build = (rows, { width = host.width() } = {}) => {
    const { inner } = boxWidth(width);
    return frame([...rows, "", hintRow(footer || menuHint("app.menu.hintPick"), inner)], { width, risk: "low", title });
  };
  const picked = await runMenu(host, { items, initial, signal, graceMs, build });
  return picked.cancelled ? -1 : picked.index;
}
