// Slash commands: the registry, the parser and the dispatcher. Each command lives in its own file:
//
//   { name, aliases, group, description (a getter: follows /lang), usage?, run(ctx, args) }
//
// `ctx` is built by cli.js and holds what a command may use: { config, session, client, toolbox, permissions, ui,
// screen, cwd, effort: {get, set}, lang, setLang(lang), exit(code), runAgentTurn(text), busy(fn(signal)), ... } plus
// `commands()` (the registry) added here for /help.
//
// Decisions:
//  - "/" followed by one word of letters, digits, "-" or "_" is a command. Anything else that starts with a slash
//    (a path like /usr/bin/x, or Arabic text) goes to the model as an ordinary message.
//  - A lone "/" shows the help. An unknown command is never sent to the model: the person gets the closest names.
//  - A command that throws is reported in one friendly line (details only with FIRAS_DEBUG=1) and the prompt carries on.
//  - Skills (src/skills/index.js) answer to /name too, after the commands: a command always wins a name, and a skill
//    with a command's name never reaches the menu. Running one is an agent turn (skillMessage) in which the model loads
//    the skill with the Skill tool. ctx.skills is the session's skill source ({ list(), find(name) }), when there is one.
import { t } from "../i18n/index.js";
import "../ui/strings-app.js";
import "../skills/strings.js";
import { SKILL_NAME, skillDescription, skillMessage } from "../skills/index.js";
import { helpCommand } from "./help.js";
import { clearCommand } from "./clear.js";
import { compactCommand } from "./compact.js";
import { effortCommand } from "./effort.js";
import { modeCommand } from "./mode.js";
import { langCommand } from "./lang.js";
import { arabicCommand } from "./arabic.js";
import { modelCommand } from "./model.js";
import { statusCommand } from "./status.js";
import { costCommand } from "./cost.js";
import { copyCommand } from "./copy.js";
import { initCommand } from "./init.js";
import { resumeCommand } from "./resume.js";
import { sessionsCommand } from "./sessions.js";
import { logoutCommand } from "./logout.js";
import { updateCommand } from "./update.js";
import { exitCommand } from "./exit.js";
import { skillsCommand } from "./skills.js";

export const COMMANDS = Object.freeze([
  helpCommand, clearCommand, compactCommand, effortCommand, modeCommand, langCommand, arabicCommand, modelCommand,
  statusCommand, costCommand, copyCommand, initCommand, skillsCommand, resumeCommand, sessionsCommand, logoutCommand,
  updateCommand, exitCommand,
]);

/** { name, args } for a slash command line, or null when the text is an ordinary message. */
export function parseSlash(text) {
  const match = /^\/([A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  return { name: match[1].toLowerCase() || "help", args: (match[2] || "").trim() };
}

export function findCommand(name) {
  const key = String(name || "").toLowerCase();
  return COMMANDS.find(cmd => cmd.name === key || cmd.aliases?.includes(key)) || null;
}

export function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = up;
    }
  }
  return row[b.length];
}

/** True when `name` is a command or one of its aliases (a skill cannot take it). */
export function isCommandName(name) { return !!findCommand(name); }

/** The command names closest to what was typed (prefix matches first), at most `max`. `extra`: more names (skills). */
export function suggestCommands(name, max = 3, extra = []) {
  const key = String(name || "").toLowerCase();
  if (!key) return [];
  const scored = [];
  const score = labels => {
    let best = Infinity;
    for (const label of labels) {
      if (label.startsWith(key)) best = Math.min(best, 0);
      else best = Math.min(best, levenshtein(key, label));
    }
    return best;
  };
  const limit = Math.max(2, Math.floor(key.length / 2));
  for (const cmd of COMMANDS) {
    const best = score([cmd.name, ...(cmd.aliases || [])]);
    if (best <= limit) scored.push([best, cmd.name]);
  }
  for (const label of new Set(extra || [])) {
    if (typeof label !== "string" || !label || findCommand(label)) continue;
    const best = score([label]);
    if (best <= limit) scored.push([best, label]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]));
  return scored.slice(0, max).map(item => item[1]);
}

/**
 * Entries for the prompt's "/" menu: the commands, then one { name, description, kind: "skill" } per skill (its
 * Arabic description in the Arabic interface when it has one). A skill whose name a command holds is left out.
 */
export function commandMenu({ slash = false, skills = [] } = {}) {
  const items = COMMANDS.map(cmd => ({ name: slash ? `/${cmd.name}` : cmd.name, description: cmd.description }));
  const seen = new Set();
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = typeof skill?.name === "string" ? skill.name : "";
    if (!SKILL_NAME.test(name) || seen.has(name) || findCommand(name)) continue;
    seen.add(name);
    items.push({ name: slash ? `/${name}` : name, description: skillDescription(skill), kind: "skill" });
  }
  return items;
}

/** The skill of the session named `name`, or null (no source, no such skill, or a source that failed). */
function findSkill(ctx, name) {
  try { return ctx?.skills?.find?.(name) || null; } catch { return null; }
}

function skillNames(ctx) {
  try { return (ctx?.skills?.list?.() || []).map(skill => skill.name); } catch { return []; }
}

/** Runs a slash command. Resolves { handled } (false = not a command, send the text to the model). */
export async function dispatch(text, ctx) {
  const parsed = parseSlash(text);
  if (!parsed) return { handled: false };
  const cmd = findCommand(parsed.name);
  if (!cmd) {
    const skill = findSkill(ctx, parsed.name);
    if (skill) {
      try {
        await ctx.runAgentTurn(skillMessage(skill, parsed.args));
      } catch (error) {
        ctx.ui.notice("error", t("app.cmd.failed", { name: skill.name }) + (process.env.FIRAS_DEBUG ? ` (${error?.stack || error})` : ""));
      }
      return { handled: true, command: `skill:${skill.name}` };
    }
    const near = suggestCommands(parsed.name, 3, skillNames(ctx));
    ctx.ui.notice("warn", near.length
      ? t("app.cmd.unknownNear", { name: parsed.name, near: near.map(n => `/${n}`).join(" ") })
      : t("app.cmd.unknown", { name: parsed.name }));
    return { handled: true, command: null };
  }
  try {
    await cmd.run({ ...ctx, commands: () => COMMANDS }, parsed.args);
  } catch (error) {
    ctx.ui.notice("error", t("app.cmd.failed", { name: cmd.name }) + (process.env.FIRAS_DEBUG ? ` (${error?.stack || error})` : ""));
  }
  return { handled: true, command: cmd.name };
}

export { chooseOption } from "./pick.js";
