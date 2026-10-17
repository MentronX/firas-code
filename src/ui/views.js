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
//  - Model and tool text is untrusted: cleanText() strips escape sequences and control characters (tabs become 4
//    spaces) before anything is measured or laid out.
//  - A number key in a menu only MOVES the selection; Enter confirms. Together with a short grace period after a dialog
//    opens, a stray key typed ahead while the agent was working can never approve an action.
import { c, sym, hasUnicode } from "./theme.js";
import { t, getLang } from "../i18n/index.js";
import { arabicActive, hasRtl, layoutParagraph, stringWidth, stripAnsi, toVisual, wrapLogical } from "../text/display.js";
import { renderDiff } from "./diff.js";
import { fitPathTail, stripBidiMarks } from "./textfit.js";
import "./strings-app.js";

export const GUTTER = "  ";
export const FOLD_BODY_LINES = 8;
export const FOLD_DIFF_LINES = 12;

// Arrow glyphs the legacy Windows console cannot draw are spelled out instead (the theme has no up/down arrows).
export const UP = hasUnicode ? "↑" : "^";
export const DOWN = hasUnicode ? "↓" : "v";
const UP_DOWN = hasUnicode ? "↑/↓" : "Up/Down";

/** A menu hint line with the arrow keys filled in. */
export function menuHint(key) { return t(key, { ud: UP_DOWN }); }

export function contentWidth(columns) { return Math.max(20, Math.min(100, (columns | 0 || 80) - 4)); }

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
 * were already laid out must NOT go through this again: ordering twice would turn them back.
 */
export function vis(text, dir = "auto") { return stripBidiMarks(toVisual(String(text ?? ""), { dir })); }

/** A line under the prompt box (a hint): two columns of gutter, and right-aligned when it is Arabic like the notices above it. */
export function footerRow(text, width) {
  const line = "  " + String(text ?? "");
  return stripBidiMarks(toVisual(line, hasRtl(line) ? { dir: "rtl", width, align: "end" } : { dir: "ltr" }));
}

/** `label` padded to `cells` columns (by width, not by character count), for two-column listings. */
export function padLabel(label, cells) { return padEnd(vis(label), cells); }

export function padEnd(line, width) {
  const gap = width - stringWidth(line);
  return gap > 0 ? line + " ".repeat(gap) : line;
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
  return para(`${style.mark()} ${style.text(body)}`, width, { indent: "  " });
}

/** A dim line under a finished turn: how long it took and what it cost, plus why it stopped when that was not normal. */
export function renderTurnFooter({ ms, inTokens = 0, outTokens = 0, stopReason = "end_turn" }, width) {
  const parts = [];
  const tag = { aborted: "interrupted", max_steps: "stepLimit", max_tokens: "lengthLimit", error: "error", empty: "empty" }[stopReason];
  if (tag) parts.push(t(`app.stop.${tag}`));
  parts.push(fmtDuration(ms));
  if (inTokens || outTokens) parts.push(`${UP} ${fmtTokens(inTokens)} ${DOWN} ${fmtTokens(outTokens)}`);
  const line = `${sym.think} ${parts.join(` ${sym.dot} `)}`;
  return [toVisual(c.dim(truncateLogical(line, width)), { dir: "ltr" })];
}

const todoLabel = item => cleanText(item.status === "in_progress" && item.activeForm ? item.activeForm : item.content).replace(/\s+/g, " ").trim();

export function renderTodos(items, width) {
  const lines = [];
  for (const item of items) {
    const done = item.status === "completed";
    const active = item.status === "in_progress";
    const mark = done ? c.green(sym.checked) : active ? c.accent(sym.arrow) : c.gray(sym.checkbox);
    const label = todoLabel(item);
    const styled = done ? c.dim(c.strike(label)) : active ? c.bold(label) : label;
    lines.push(...para(`${mark} ${styled}`, width, { indent: "  " }));
  }
  return lines;
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
    const mark = item => (item.status === "completed" ? sym.checked : item.status === "in_progress" ? sym.arrow : sym.checkbox);
    const parts = moved.slice(0, 3).map(item => `${mark(item)} ${truncateLogical(todoLabel(item), 40)}`);
    if (moved.length > 3) parts.push(`+${moved.length - 3}`);
    return { lines: renderToolCard(card, { ok: true, summary: [...parts, summary].filter(Boolean).join(` ${sym.dot} `) }, width).lines, full: false };
  }
  const head = renderToolCard(card, { ok: true, summary }, width).lines;
  return { lines: [...head, ...renderTodos(items, Math.max(8, width - 4)).map(line => "    " + line)], full: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool cards

/** `● Read(src/app.js)`. state: "running" | "ok" | "error". */
export function toolHeader({ name, summary, readOnly, risk }, width, state = "running") {
  const bullet = state === "ok" ? c.accent(sym.bullet) : state === "error" ? c.red(sym.bullet)
    : risk === "high" ? c.red(sym.bullet) : readOnly ? c.gray(sym.bullet) : c.yellow(sym.bullet);
  const label = cleanText(name).trim();
  const room = Math.max(8, width - stringWidth(label) - 5);
  const inner = fitSummary(cleanText(summary), room);
  const line = inner ? `${bullet} ${c.bold(label)}${c.dim("(")}${inner}${c.dim(")")}` : `${bullet} ${c.bold(label)}`;
  return toVisual(line, { dir: "ltr" });
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
 * The finished card of one tool call: header, result line, and the folded body or diff.
 * Returns { lines, full, hidden } where `full` is the unfolded version and `hidden` how many lines were folded away.
 */
export function renderToolCard(card, end, width) {
  const state = end.ok ? "ok" : "error";
  const head = toolHeader(card, width, state);
  const summary = truncateLogical(cleanText(end.summary || ""), width - 4);
  const result = summary
    ? `${GUTTER}${c.gray(sym.corner)} ${toVisual(end.ok ? summary : c.red(summary), { dir: "ltr" })}`
    : "";
  const lead = result ? [head, result] : [head];
  const indent = "    ";
  let detail = [];
  if (end.diff) {
    try { detail = renderDiff(end.diff, { width: Math.max(20, width - indent.length), maxLines: 2000 }).map(line => indent + line); } catch { detail = []; }
  }
  if (!detail.length && end.body) detail = bodyLines(end.body, width, indent);
  const limit = end.diff ? FOLD_DIFF_LINES : FOLD_BODY_LINES;
  const hidden = Math.max(0, detail.length - limit);
  const shown = hidden > 1 ? detail.slice(0, limit) : detail;
  const folded = hidden > 1 ? hidden : 0;
  const tail = folded ? [indent + vis(c.dim(t("app.card.more", { n: folded })))] : [];
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

/** Wraps visual `lines` in a rounded box. `edge` colours the left border (risk colour); `title` sits in the top border. */
export function frame(lines, { width, risk = "low", title = "" }) {
  const outer = Math.max(24, Math.min(width, 100));
  const inner = outer - 4;
  const edge = EDGE[risk] || EDGE.low;
  const rule = s => c.gray(s);
  // The title may carry colour (a risk label), so it is only shortened, never cleaned, when it is too long.
  let label = title ? ` ${title} ` : "";
  if (stringWidth(label) > inner - 2) label = ` ${truncateLogical(stripAnsi(title), inner - 4)} `;
  const topFill = Math.max(0, outer - 3 - stringWidth(label));
  const top = edge(sym.boxTL) + edge(sym.boxH) + (label ? c.bold(toVisual(label, { dir: "auto" })) : "") + rule(sym.boxH.repeat(topFill)) + rule(sym.boxTR);
  const bottom = edge(sym.boxBL) + rule(sym.boxH.repeat(outer - 2)) + rule(sym.boxBR);
  const rows = lines.map(line => `${edge(sym.boxV)} ${padEnd(line, inner)} ${rule(sym.boxV)}`);
  return [top, ...rows, bottom];
}

const RLM = String.fromCharCode(0x200f);

/**
 * One row per item; `selected` is highlighted. Labels may be Arabic: they are ordered inside the row. Hints line up in
 * one column. In the Arabic interface the rows are mirrored like the paragraphs and notices around them (pointer and
 * number on the right, text right-aligned); `rtl` forces either way.
 */
export function menuRows(items, selected, { width, multi = false, checked = new Set(), rtl = arabicActive() && getLang() === "ar" }) {
  const limit = Math.max(20, Math.min(width, 100) - 4);
  const lead = 5 + (multi ? 2 : 0);
  const labels = items.map(item => truncateLogical(cleanText(item.label), Math.max(8, limit - lead)));
  const column = Math.max(0, ...items.map((item, i) => (item.hint ? stringWidth(labels[i]) : 0)));
  return items.map((item, i) => {
    const on = i === selected;
    const pointer = on ? c.accent(sym.prompt) : " ";
    const box = multi ? `${checked.has(i) ? c.accent(sym.checked) : c.gray(sym.checkbox)} ` : "";
    const number = c.gray(`${i + 1}.`);
    const room = Math.max(6, limit - lead - column - 2);
    const hint = item.hint ? `${" ".repeat(column - stringWidth(labels[i]))}  ${c.dim(truncateLogical(cleanText(item.hint), room))}` : "";
    const text = on ? c.bold(c.accent(labels[i])) : labels[i];
    // The mark after the number keeps it on the right of a label written in Latin letters too ("3." then "English").
    const logical = `${pointer} ${box}${number}${rtl ? RLM : ""} ${text}${hint}`;
    return rtl ? toVisual(logical, { dir: "rtl", width: limit, align: "end" }) : toVisual(logical, { dir: "ltr" });
  });
}

/**
 * A pick-one (or pick-several) menu in the host's live region.
 * host: { width(), show(lines, cursor?), hide(), onKey(cb) -> off, print(lines), onResize?(cb) -> off }.
 * opts: { items:[{label, hint?}], initial, multi, signal, graceMs, build(rows, {selected}) -> lines }
 * Resolves { cancelled:true } (Esc, Ctrl+C, abort) or { cancelled:false, index, indices }.
 */
export function runMenu(host, { items, initial = 0, multi = false, signal, graceMs = 0, build }) {
  return new Promise(resolve => {
    let selected = Math.max(0, Math.min(items.length - 1, initial));
    const checked = new Set();
    let done = false;
    const openedAt = Date.now();
    const draw = () => {
      const rows = menuRows(items, selected, { width: host.width(), multi, checked });
      host.show(build ? build(rows, { selected }) : rows, null);
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

function foldRows(rows, max) {
  if (rows.length <= max + 1) return rows;
  return [...rows.slice(0, max), vis(c.dim(t("app.fold.more", { n: rows.length - max })))];
}

/** The text part of a permission box (everything above the options), as visual lines no wider than `inner`. */
export function permissionBody(req, inner) {
  const lines = [];
  const title = cleanText(req.title || req.tool || "").trim();
  lines.push(...para(`${c.bold(title)}`, inner));
  const summary = cleanText(req.summary || "").trim();
  if (summary && !title.includes(summary)) lines.push(...para(c.dim(summary), inner));
  // The detail is the full text of what will happen. When the title already shows exactly that (a command, a path) it
  // is not printed a second time: only a longer or multi-line version adds anything.
  const detailText = cleanText(req.detail || "").replace(/\s+$/, "");
  const squash = text => text.replace(/\s+/g, " ").trim();
  const repeated = !detailText || squash(title).includes(squash(detailText)) || (summary !== "" && squash(summary) === squash(detailText));
  if (!repeated) {
    const detail = [];
    // A bullet that wraps keeps its text under the text, not under the bullet.
    for (const raw of detailText.split("\n")) detail.push(...para(raw, inner, /^[•*-] /.test(raw) ? { indent: "  " } : undefined));
    lines.push("", ...foldRows(detail, 14));
  }
  if (req.diff) {
    let preview = [];
    try { preview = renderDiff(req.diff, { width: inner, maxLines: 400 }); } catch { preview = []; }
    if (preview.length) lines.push("", ...foldRows(preview, 24));
  }
  return lines;
}

/**
 * The permission question. `readLine({prefix, hint}) -> Promise<string|null>` collects the optional "tell Firas what to
 * do instead" text. Resolves { decision: "allow"|"allow-session"|"deny", feedback? }; anything unclear is a denial.
 */
export async function permissionDialog(host, req, { readLine, graceMs = 0 } = {}) {
  const width = Math.min(host.width(), 100);
  const inner = width - 4;
  const risk = req.risk === "high" || req.risk === "medium" ? req.risk : "low";
  const body = permissionBody(req, inner);
  const items = [{ label: t("app.perm.allow"), value: "allow" }];
  if (req.sessionKey) items.push({ label: truncateLogical(cleanText(req.sessionLabel || t("app.perm.allowSession")), inner - 8), value: "allow-session" });
  items.push({ label: t("app.perm.deny"), value: "deny" }, { label: t("app.perm.denyWhy"), value: "feedback" });
  const build = rows => frame([...body, "", ...rows, "", ...para(c.dim(menuHint("app.menu.hint")), inner)], { width, risk, title: `${t("app.perm.title")} ${sym.dot} ${riskLabel(risk)}` });
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
  const width = Math.min(host.width(), 100);
  const inner = width - 4;
  const head = para(c.bold(cleanText(question).trim()), inner);
  const typeOwn = async () => {
    const text = readLine ? await readLine({ prefix: c.accent(sym.prompt) + " ", hint: t("app.q.typeHint") }) : null;
    return typeof text === "string" ? text.trim() : "";
  };
  if (!options.length) {
    // Without choices the question goes into the scrollback and the person answers on the prompt line below it.
    host.print(frame([...head], { width, risk: "low", title: t("app.q.title") }));
    return { answer: await typeOwn() };
  }
  const items = options.map(o => ({ label: o.label, hint: o.description }));
  items.push({ label: t("app.q.other") });
  const build = rows => frame([...head, "", ...rows, "", ...para(c.dim(menuHint(multi ? "app.menu.hintMulti" : "app.menu.hintPick")), inner)], { width, risk: "low", title: t("app.q.title") });
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
  const width = Math.min(host.width(), 100);
  const items = [
    { label: t("app.plan.approve") },
    { label: t("app.plan.approveEdits") },
    { label: t("app.plan.reject") },
  ];
  const build = rows => frame([...para(c.bold(t("app.plan.question")), width - 4), "", ...rows, "", ...para(c.dim(menuHint("app.menu.hint")), width - 4)], { width, risk: "low", title: t("app.plan.title") });
  for (;;) {
    const picked = await runMenu(host, { items, signal, graceMs, build });
    if (picked.cancelled) return { decision: "reject" };
    if (picked.index === 0) return { decision: "approve" };
    if (picked.index === 1) return { decision: "approve-edits" };
    const text = readLine ? await readLine({ prefix: c.accent(sym.prompt) + " ", hint: t("app.plan.rejectHint") }) : null;
    if (typeof text === "string" && text.trim()) return { decision: "reject", feedback: text.trim() };
  }
}

/** A plain picker (sessions, language): resolves the chosen index or -1. */
export async function pickDialog(host, { title, items, initial = 0, signal, graceMs = 0, footer }) {
  const width = Math.min(host.width(), 100);
  const build = rows => frame([...rows, "", ...para(c.dim(footer || menuHint("app.menu.hintPick")), width - 4)], { width, risk: "low", title });
  const picked = await runMenu(host, { items, initial, signal, graceMs, build });
  return picked.cancelled ? -1 : picked.index;
}
