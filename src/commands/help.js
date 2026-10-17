// /help: every command in groups, and the keyboard shortcuts.
import { c } from "../ui/theme.js";
import { t } from "../i18n/index.js";
import { NAME, MAKER, VERSION } from "../brand.js";
import { stringWidth, toVisual, wrapLogical } from "../text/display.js";
import { cleanText, contentWidth, vis } from "../ui/views.js";
import "../ui/strings-app.js";

const GROUPS = [
  { key: "session", names: ["clear", "compact", "resume", "sessions", "init", "exit"] },
  { key: "settings", names: ["effort", "mode", "lang", "arabic", "model"] },
  { key: "info", names: ["status", "cost", "copy", "help"] },
  { key: "account", names: ["update", "logout"] },
];

const SHORTCUTS = [
  ["Enter", "send"], ["Alt+Enter", "newline"], ["Esc", "stop"], ["Ctrl+C", "ctrlc"], ["Ctrl+D", "exitEmpty"],
  ["Shift+Tab", "mode"], ["Ctrl+O", "expand"], ["/", "commands"], ["@", "files"], ["↑ ↓", "history"],
];

const LABEL_COLUMN = 22;

/**
 * One listing entry: the label (a command with its usage, or a key) and its description beside it. A description that is
 * too long goes on further rows under its own column; a label too wide for the column (a command with a long usage) gets
 * a row of its own, so the two never run into each other and nothing is wider than the terminal.
 */
export function helpRows(label, text, width, labelWidth = LABEL_COLUMN) {
  const room = Math.max(12, width - labelWidth);
  const words = wrapLogical(cleanText(text).replace(/\s+/g, " ").trim(), room);
  const body = words.map(line => toVisual(line, { dir: "auto" }));
  const left = c.accent(label);
  const blank = " ".repeat(labelWidth);
  if (stringWidth(label) + 2 > labelWidth) return [left, ...body.map(line => blank + line)];
  return body.map((line, i) => (i === 0 ? left + " ".repeat(labelWidth - stringWidth(label)) : blank) + line);
}

export const helpCommand = {
  name: "help",
  aliases: ["?"],
  group: "info",
  get description() { return t("app.cmd.help"); },
  run(ctx) {
    const width = contentWidth(ctx.screen?.width?.() ?? 80);
    const byName = new Map(ctx.commands().map(cmd => [cmd.name, cmd]));
    const lines = ["", `${c.bold(NAME)} ${c.dim(`${MAKER} · ${VERSION}`)}`, ""];
    for (const group of GROUPS) {
      lines.push(vis(c.bold(t(`app.help.group.${group.key}`))));
      for (const name of group.names) {
        const cmd = byName.get(name);
        if (!cmd) continue;
        const usage = cmd.usage ? ` ${cmd.usage}` : "";
        lines.push(...helpRows(`  /${cmd.name}${usage}`, cmd.description, width));
      }
      lines.push("");
    }
    lines.push(vis(c.bold(t("app.help.group.keys"))));
    for (const [key, id] of SHORTCUTS) lines.push(...helpRows(`  ${key}`, t(`app.help.key.${id}`), width));
    lines.push("");
    ctx.ui.print(lines);
  },
};
