// /help: every command in groups, and the keyboard shortcuts.
//
// Decisions:
//  - The groups name commands by NAME; a name that is not registered (yet) is skipped, and a registered command that
//    no group names is listed under the group its own `group` field gives (or "info"), so the help never loses one.
//  - Newline keys: only the ones that arrive. Alt+Enter is taken by the window itself in Windows Terminal and the
//    classic console (it toggles full screen) and never reaches the program, so it is not offered; Ctrl+J and a
//    trailing backslash work everywhere, Ctrl+Enter wherever the terminal sends it (the editor still accepts Alt+Enter
//    and Shift+Enter where they do arrive).
//  - Arabic: the listing is the mirror of the English one. The label column (a command and its usage, or a key) is on
//    the right, laid out left to right on its own, and the description is right-aligned against its own column to
//    the left of it. Every row is exactly the content width, so the block lines up with the notices around it.
import { c, sym, hasUnicode } from "../ui/theme.js";
import { t, getLang } from "../i18n/index.js";
import { NAME, MAKER, VERSION } from "../brand.js";
import { arabicActive, baseDirection, stringWidth, stripAnsi, toVisual, wrapLogical } from "../text/display.js";
import { contentWidth, vis } from "../ui/views.js";
import { fitLogical, stripBidiMarks } from "../ui/textfit.js";
import "../ui/strings-app.js";
import "../ui/strings-input.js";

const GROUPS = [
  { key: "session", names: ["clear", "compact", "resume", "sessions", "init", "exit"] },
  { key: "settings", names: ["effort", "mode", "lang", "arabic", "model"] },
  { key: "info", names: ["status", "cost", "copy", "help"] },
  // The account's skills live with the account, like the access code and the installed version.
  { key: "account", names: ["skills", "update", "logout"] },
];

const UP_DOWN = hasUnicode ? `${sym.up}/${sym.down}` : "Up/Down";

const SHORTCUTS = [
  ["Enter", "app.help.key.send"],
  ["Ctrl+J", "app.help.key.newline"],
  ["\\ Enter", "term.help.newlineSlash"],
  ["Ctrl+Enter", "term.help.newlineCtrl"],
  ["Esc", "app.help.key.stop"],
  ["Ctrl+C", "app.help.key.ctrlc"],
  ["Ctrl+D", "app.help.key.exitEmpty"],
  ["Shift+Tab", "app.help.key.mode"],
  ["Ctrl+O", "app.help.key.expand"],
  ["/", "term.help.commands"],
  ["@", "app.help.key.files"],
  [UP_DOWN, "app.help.key.history"],
];

const LABEL_COLUMN = 22;
const MIN_TEXT = 12;

/** The Arabic interface mirrors the listing. */
const rtlUi = () => getLang() === "ar" && arabicActive();

// Harakat count as zero cells here but take a cell each in Windows Terminal, which would push a right-aligned row off
// its edge; Arabic reads the same without them.
const HARAKAT = /[\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]/g;

/**
 * A description as plain logical text. It may be a skill's, written by a person: escape sequences, control characters,
 * direction overrides and harakat go, but the isolates our own strings put around a Latin word stay (without them the
 * "/" of a command could land on the wrong side of it inside Arabic).
 */
function cleanDescription(text) {
  return stripAnsi(String(text ?? "")).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/g, " ").replace(HARAKAT, "").replace(/\s+/g, " ").trim();
}

/**
 * One listing entry: the label (a command with its usage, or a key) and its description beside it. A description that is
 * too long goes on further rows under its own column; a label too wide for the column (a command with a long usage) gets
 * a row of its own, so the two never run into each other and nothing is wider than the terminal.
 * opts.rtl (default: the Arabic interface) mirrors the rows; they are then exactly `width` cells.
 */
export function helpRows(label, text, width, labelWidth = LABEL_COLUMN, { rtl = rtlUi() } = {}) {
  // A narrow terminal narrows the label column first, so a description keeps about 24 cells (12 at the very least).
  const column = Math.max(4, Math.min(labelWidth, Math.max(width - 2 * MIN_TEXT, Math.min(MIN_TEXT, width - MIN_TEXT))));
  const room = Math.max(MIN_TEXT, width - column);
  const plain = cleanDescription(text);
  const lines = plain ? wrapLogical(plain, room) : [""];
  const indent = label.length - label.trimStart().length;
  const name = label.trimStart();
  const own = stringWidth(label) + 2 > column;
  // A label wider than the terminal (a long usage on a narrow one) wraps after a "|" or a space, never mid-word.
  const keys = own ? labelRows(name, Math.max(4, width - indent - 2)).map((row, i) => (i ? "  " : "") + row) : [name];
  if (!rtl) {
    const body = lines.map(line => stripBidiMarks(toVisual(line, { dir: "auto" })));
    const blank = " ".repeat(column);
    if (own) return [...keys.map(key => c.accent(" ".repeat(indent) + key)), ...body.map(line => blank + line)];
    return body.map((line, i) => (i === 0 ? c.accent(label) + " ".repeat(column - stringWidth(label)) : blank) + line);
  }
  // Mirrored: the indent is on the right, the label reads left to right on its own, the description is ordered as
  // ONE paragraph (its direction from its first strong letter) and right-aligned against the label column.
  // (baseDirection skips what is inside an isolate, so `${L("/x")} يفعل` is an Arabic sentence.)
  const dir = baseDirection(plain);
  const body = lines.map(line => stripBidiMarks(toVisual(line, { dir })));
  const placed = line => " ".repeat(Math.max(0, width - column - stringWidth(line))) + line;
  const keyRow = (key, fill) => {
    const shown = stripBidiMarks(toVisual(key, { dir: "ltr" }));
    return " ".repeat(Math.max(0, fill - stringWidth(shown) - indent)) + c.accent(shown) + " ".repeat(indent);
  };
  if (own) return [...keys.map(key => keyRow(key, width)), ...body.filter(Boolean).map(line => placed(line) + " ".repeat(column))];
  return body.map((line, i) => placed(line) + (i === 0 ? keyRow(name, column) : " ".repeat(column)));
}

/** A label cut into rows of at most `room` cells after a "|" or a space; a single piece that is still too wide is shortened. */
function labelRows(name, room) {
  if (stringWidth(name) <= room) return [name];
  const rows = [];
  let row = "";
  for (const piece of name.split(/(?<=[|\s])/)) {
    if (row && stringWidth(row + piece) > room) { rows.push(row.trimEnd()); row = piece; } else row += piece;
  }
  if (row.trim()) rows.push(row.trimEnd());
  return rows.map(r => fitLogical(r, room, sym.ellipsis));
}

/** The commands of each group, in the group's order, then whatever registered command no group names. */
function groupedCommands(commands) {
  const byName = new Map(commands.map(cmd => [cmd.name, cmd]));
  const named = new Set(GROUPS.flatMap(group => group.names));
  const home = cmd => (GROUPS.some(group => group.key === cmd.group) ? cmd.group : "info");
  return GROUPS.map(group => ({
    key: group.key,
    commands: [
      ...group.names.map(name => byName.get(name)).filter(Boolean),
      ...commands.filter(cmd => !named.has(cmd.name) && home(cmd) === group.key),
    ],
  })).filter(group => group.commands.length);
}

export const helpCommand = {
  name: "help",
  aliases: ["?"],
  group: "info",
  get description() { return t("app.cmd.help"); },
  run(ctx) {
    const width = contentWidth(ctx.screen?.width?.() ?? 80);
    const rtl = rtlUi();
    // A heading or the title: in the Arabic interface right-aligned to the content width, like the rows under it.
    const head = text => (rtl ? stripBidiMarks(toVisual(text, { dir: "rtl", width, align: "end" })) : vis(text));
    // The title loses the maker, then the version, before it would be cut.
    const title = [`${MAKER} · ${VERSION}`, VERSION, ""]
      .map(tail => (tail ? `${c.bold(NAME)} ${c.dim(tail)}` : c.bold(fitLogical(NAME, width, sym.ellipsis))))
      .find(text => stringWidth(text) <= width);
    const lines = ["", rtl ? " ".repeat(Math.max(0, width - stringWidth(title))) + title : title, ""];
    for (const group of groupedCommands(ctx.commands())) {
      lines.push(head(c.bold(t(`app.help.group.${group.key}`))));
      for (const cmd of group.commands) {
        const usage = cmd.usage ? ` ${cmd.usage}` : "";
        lines.push(...helpRows(`  /${cmd.name}${usage}`, cmd.description, width, LABEL_COLUMN, { rtl }));
      }
      lines.push("");
    }
    lines.push(head(c.bold(t("app.help.group.keys"))));
    for (const [key, id] of SHORTCUTS) lines.push(...helpRows(`  ${key}`, t(id), width, LABEL_COLUMN, { rtl }));
    lines.push("");
    ctx.ui.print(lines);
  },
};
