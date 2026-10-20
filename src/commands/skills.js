// /skills: the skills this session can use, grouped by where they come from (built-in, the person's own, this
// project), where to put new ones, and `/skills new <name>`, which starts one in the person's own folder from a short
// template. Skills themselves are run by typing /name (commands/index.js) or loaded by the agent (tools/skill.js).
//
// Layout: the listing is a two-column table, name and description, like /help. In the Arabic interface it is mirrored
// as the dialogs are: every row is laid against the right edge, the name on the right and its description to its left,
// so an Arabic description reads from the name outwards. Names are typed as they are, so a name is never cut while the
// terminal has room for it: a name wider than its column gets a row of its own.
import fs from "node:fs";
import path from "node:path";
import { c, sym } from "../ui/theme.js";
import { getLang } from "../i18n/index.js";
import { arabicActive, layoutParagraph, stringWidth } from "../text/display.js";
import { contentWidth, para, renderNotice, vis } from "../ui/views.js";
import { dropArabicMarks, fitLogical, fitPathTail, ltrIsolate, stripBidiMarks } from "../ui/textfit.js";
import { MAX_SKILLS, SKILL_FILE, SKILL_NAME, SCOPES, cleanLine, createSkillSource, projectSkillsDir, skillDescription, userSkillsDir } from "../skills/index.js";
import { skillText } from "../skills/strings.js";

const INDENT = 2;
const GAP = 2;
// Below this many columns for a description, the description goes under its name instead of beside it.
const MIN_TEXT = 12;

const rtlInterface = () => getLang() === "ar" && arabicActive();
const spaces = n => " ".repeat(Math.max(0, n));

/** A finished visual line placed on the reading side of a column `width` wide: as it is, or against its right edge. */
function onSide(line, width, rtl) {
  return rtl ? spaces(width - stringWidth(line)) + line : line;
}

/**
 * Plain logical text wrapped to `room` columns, each row ordered for the terminal. Every row takes the direction of the
 * whole text (layoutParagraph's rule), not of its own first letter: in an Arabic description a row that starts with a
 * Latin word ("GitHub Actions ...") is still part of a right-to-left sentence, and so is a description that starts
 * with one ("Git: ...").
 */
function wrapped(text, room) {
  const plain = String(text ?? "").replace(/\s+/g, " ").trim();
  return plain ? layoutParagraph(plain, Math.max(1, room), { align: "none" }).map(row => stripBidiMarks(row).trimEnd()) : [];
}

/** The name column for these labels: as wide as the widest, but never more than 40% of the row. */
export function nameColumn(labels, width) {
  const inner = Math.max(1, width - INDENT);
  return Math.min(Math.max(8, Math.floor(inner * 0.4)), Math.max(0, ...labels.map(label => stringWidth(label))));
}

/**
 * Rows of a name/text table. items: [{ label (LTR, typed as it is), text, labelStyle?, textStyle? }]. Lines are at most
 * `width` columns; in RTL each line is laid against the right edge (name on the right). `nameWidth` lets several
 * tables share one name column (the listing's groups line up).
 */
export function tableRows(items, width, { rtl = rtlInterface(), nameWidth } = {}) {
  if (!items.length) return [];
  const inner = Math.max(1, width - INDENT);
  const nameW = nameWidth ?? nameColumn(items.map(item => item.label), width);
  const room = inner - nameW - GAP;
  const out = [];
  for (const item of items) {
    const paintLabel = item.labelStyle || (s => s);
    const paintText = item.textStyle || c.dim;
    const besideOk = room >= MIN_TEXT && stringWidth(item.label) <= nameW;
    if (besideOk) {
      const rows = wrapped(item.text, room);
      const label = paintLabel(item.label);
      const pad = spaces(nameW - stringWidth(item.label));
      if (!rtl) {
        out.push(spaces(INDENT) + label + (rows.length ? pad + spaces(GAP) + paintText(rows[0]) : ""));
        for (const row of rows.slice(1)) out.push(spaces(INDENT + nameW + GAP) + paintText(row));
      } else {
        out.push(onSide(rows.length ? paintText(rows[0]) : "", room, true) + spaces(GAP) + pad + label);
        for (const row of rows.slice(1)) out.push(onSide(paintText(row), room, true));
      }
      continue;
    }
    // Stacked: the name on a row of its own (cut only when even a whole row cannot hold it), the text under it.
    const label = paintLabel(fitLogical(item.label, inner, sym.ellipsis));
    const textRoom = Math.max(1, (room >= MIN_TEXT ? room : inner - INDENT));
    const rows = wrapped(item.text, textRoom);
    if (!rtl) {
      out.push(spaces(INDENT) + label);
      const lead = room >= MIN_TEXT ? INDENT + nameW + GAP : INDENT * 2;
      for (const row of rows) out.push(spaces(lead) + paintText(row));
    } else {
      out.push(onSide(label, inner, true));
      for (const row of rows) out.push(onSide(paintText(row), textRoom, true));
    }
  }
  return out;
}

/** A heading or a sentence of the interface, on its side of the column. */
function headingLine(text, width, rtl, style = c.bold) {
  return onSide(style(vis(fitLogical(String(text), width, sym.ellipsis))), width, rtl);
}

// A description is written by a person, often with harakat. The text layer counts each mark as no cell but Windows
// Terminal gives it one, so a mirrored row would end past its column: they go, as in /help and the "/" menu.
function describe(skill) {
  const tag = skill.replaces ? ` (${skillText(`replaces.${skill.replaces === "builtin" ? "builtin" : "user"}`)})` : "";
  return dropArabicMarks(cleanLine(skillDescription(skill))) + tag;
}

const SCOPE_ORDER = ["builtin", "user", "project"];

/**
 * The /skills listing as lines for ui.print (no gutter; at most `width` columns each).
 * { skills, skipped } is a scan (src/skills/index.js); cwd names this project's folder.
 */
export function renderSkillsList({ skills = [], skipped = [] } = {}, { width = 76, cwd = process.cwd(), rtl = rtlInterface(), max } = {}) {
  const lines = [""];
  // One name column for every group, so the descriptions of all three line up.
  const nameWidth = nameColumn(skills.map(skill => `/${skill.name}`), width);
  for (const scope of SCOPE_ORDER) {
    const mine = skills.filter(skill => skill.scope === scope);
    if (scope === "builtin" && !mine.length) continue;
    lines.push(headingLine(skillText(`scope.${scope}`), width, rtl));
    if (mine.length) lines.push(...tableRows(mine.map(skill => ({ label: `/${skill.name}`, text: describe(skill) })), width, { rtl, nameWidth }));
    else {
      const none = c.dim(vis(skillText("none")));
      lines.push(rtl ? onSide(none, width - INDENT, true) : spaces(INDENT) + none);
    }
    lines.push("");
  }
  const notes = skipped.filter(item => SCOPES.includes(item.scope));
  for (const item of notes) {
    const why = skillText(`why.${item.reason}`, { n: max ?? MAX_SKILLS });
    const name = item.name ? (item.name.startsWith("/") ? item.name : `/${item.name}`) : fitPathTail(item.dir, 40, sym.ellipsis);
    lines.push(...renderNotice("warn", skillText("skipped", { name: ltrIsolate(name), why }), width));
  }
  if (notes.length) lines.push("");
  lines.push(...para(skillText("where"), width, { dir: rtl ? "rtl" : "ltr", align: rtl ? "end" : "start" }).map(line => c.dim(line)));
  const where = [
    { label: skillText("where.user"), path: userSkillsDir() },
    { label: skillText("where.project"), path: projectSkillsDir(cwd) },
  ];
  lines.push(...pathRows(where, width, rtl));
  lines.push(...para(skillText("newHint"), width, { dir: rtl ? "rtl" : "ltr", align: rtl ? "end" : "start" }).map(line => c.dim(line)));
  lines.push("");
  return lines;
}

/**
 * "label   path" rows. A path is never wrapped (it is copied as a whole): when it does not fit beside its label it gets
 * a row of its own, indented under the label while it fits, then less, and cut at the front only when even a whole row
 * cannot hold it.
 */
function pathRows(items, width, rtl) {
  const inner = Math.max(1, width - INDENT);
  const labels = items.map(item => vis(item.label));
  const labelW = Math.max(...labels.map(label => stringWidth(label)));
  const room = inner - labelW - GAP;
  const out = [];
  items.forEach((item, i) => {
    const label = labels[i];
    const beside = room >= MIN_TEXT && stringWidth(item.path) <= room;
    if (beside) {
      const pad = spaces(labelW - stringWidth(label));
      const where = c.dim(item.path);
      out.push(rtl ? onSide(where, room, true) + spaces(GAP) + pad + label : spaces(INDENT) + label + pad + spaces(GAP) + where);
      return;
    }
    // Stacked: the label (wrapped when even that is too wide), then the path on a row of its own.
    const lead = [INDENT * 2, INDENT, 0].find(n => stringWidth(item.path) <= width - n) ?? 0;
    const pathRoom = Math.max(1, width - lead);
    const where = c.dim(fitPathTail(item.path, pathRoom, sym.ellipsis));
    const labelRows = wrapped(item.label, inner);
    if (rtl) { for (const row of labelRows) out.push(onSide(row, inner, true)); out.push(onSide(where, pathRoom, true)); }
    else { for (const row of labelRows) out.push(spaces(INDENT) + row); out.push(spaces(lead) + where); }
  });
  return out;
}

/** The SKILL.md a new skill starts from: a header to fill in and the shape of a playbook. */
export function skillTemplate(name, lang = getLang()) {
  return [
    "---",
    `name: ${name}`,
    "description: What this skill does and when to use it",
    ...(lang === "ar" ? ["description-ar: ما تفعله هذه المهارة ومتى تستخدم"] : []),
    "---",
    "",
    `# ${name}`,
    "",
    "The steps to follow when this skill is used. Replace this text with your own.",
    "",
    "1. What to look at first.",
    "2. How to do the work.",
    "3. How to check the result before finishing.",
    "",
  ].join("\n");
}

const isCommandName = (ctx, name) => {
  try { return (ctx.commands?.() || []).some(cmd => cmd.name === name || cmd.aliases?.includes(name)); } catch { return false; }
};

function sourceFor(ctx) {
  if (ctx.skills && typeof ctx.skills.scan === "function") return ctx.skills;
  return createSkillSource(ctx.cwd || process.cwd(), { reserved: name => isCommandName(ctx, name) });
}

function createSkill(ctx, raw) {
  const name = String(raw ?? "").trim().toLowerCase();
  if (!SKILL_NAME.test(name)) {
    ctx.ui.notice("warn", skillText("new.badName", { name: cleanLine(raw, 64) }));
    return;
  }
  if (isCommandName(ctx, name)) {
    ctx.ui.notice("warn", skillText("new.command", { name }));
    return;
  }
  const dir = path.join(userSkillsDir(), name);
  const file = path.join(dir, SKILL_FILE);
  if (fs.existsSync(dir)) {
    ctx.ui.notice("warn", skillText("new.exists", { name, path: dir }));
    return;
  }
  // The name, not only the folder: /name would still run this project's skill of that name, and one of the person's
  // own in another folder (its header names it) would lose its name to a template sorted before it.
  const taken = sourceFor(ctx).scan().skills.find(skill => skill.name === name && skill.scope !== "builtin");
  if (taken) {
    ctx.ui.notice("warn", skillText("new.exists", { name, path: taken.dir }));
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // "wx": never over an existing file, even one that appeared since the check above.
    fs.writeFileSync(file, skillTemplate(name), { flag: "wx" });
  } catch {
    ctx.ui.notice("error", skillText("new.failed", { path: file }));
    return;
  }
  ctx.ui.notice("info", skillText("new.created", { path: file, name }));
  const shadowed = sourceFor(ctx).scan().skills.find(skill => skill.name === name && skill.scope === "user" && skill.replaces === "builtin");
  if (shadowed) ctx.ui.notice("info", skillText("new.replaces", { name }));
}

export const skillsCommand = {
  name: "skills",
  aliases: [],
  // /help lists it with the account (the skills in the person's own folder go with them from project to project).
  group: "account",
  usage: "[new <name>]",
  get description() { return skillText("cmd"); },
  run(ctx, args = "") {
    const [sub = "", ...rest] = String(args).trim().split(/\s+/);
    const verb = sub.toLowerCase();
    if (verb === "new" || verb === "add" || verb === "create") {
      if (!rest.length) { ctx.ui.notice("info", skillText("usage")); return; }
      createSkill(ctx, rest.join(" "));
      return;
    }
    if (verb && verb !== "list") { ctx.ui.notice("info", skillText("usage")); return; }
    const width = contentWidth(ctx.screen?.width?.() ?? 80);
    ctx.ui.print(renderSkillsList(sourceFor(ctx).scan(), { width, cwd: ctx.cwd || process.cwd() }));
  },
};
