// Skill: loads one of the user's skills (a reusable instruction pack, see src/skills/index.js) so the agent can
// follow it. It takes a NAME, never a path: the user's own and the built-in skills live outside the project, and a path
// would rightly make the permission engine ask about every one of them. Loading changes nothing, so it never asks.
//
// The text it returns is instructions at the trust of project instructions (the system prompt says so when skills
// are installed), still bounded by the safety rules; the block it is wrapped in names the skill, where it comes from
// and the folder its other files are in.
import { t } from "../i18n/index.js";
import { ok, fail, isPlainObject, tn, headOnly } from "./common.js";
import { loadSkill } from "../skills/index.js";

const ARGS_MAX = 4000;

// A loaded skill goes out whole on every request (agent/loop.js), so the model never needs a second copy, until a
// compaction replaces it with a summary: then loading it again is the only way to follow it to the end.
const DESCRIPTION = [
  "Loads a skill: a set of instructions the user installed for a kind of task (reviewing changes, writing tests, a project's own release steps, and so on). The installed skills are listed in the system prompt under Skills.",
  "Call it with the skill's name before you start the work when the request matches a skill's description, or when the user started one by typing /name; then follow the instructions it returns. args carries what the skill should be applied to, when the user said.",
  "Do not call it for a name that is not installed, do not load a skill again while its instructions are still in the conversation, and never pass a path: skills are chosen by name.",
].join(" ");

const attr = value => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function createSkillTool({ getSkills = () => [] } = {}) {
  const known = () => { try { return Array.from(getSkills() || []); } catch { return []; } };
  const keyOf = name => (typeof name === "string" ? name.trim().toLowerCase() : "");
  const find = name => { const key = keyOf(name); return key ? known().find(skill => skill.name === key) || null : null; };
  const nameList = () => known().map(skill => skill.name).join(", ");

  return {
    name: "Skill",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name, as listed under Skills (for example \"review\")." },
        args: { type: "string", description: "Optional: what the skill should be applied to, in the user's words (a file, a failing test, a focus)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    readOnly: true,
    concurrencySafe: true,

    summarize(input) { return keyOf(input?.name).slice(0, 64); },

    validate(input) {
      if (!isPlainObject(input) || !keyOf(input.name)) return "name must be the name of an installed skill.";
      if (input.args !== undefined && typeof input.args !== "string") return "args must be a string.";
      if (!find(input.name)) {
        const names = nameList();
        return names
          ? `There is no skill named ${JSON.stringify(keyOf(input.name).slice(0, 64))}. Installed skills: ${names}.`
          : "No skills are installed, so there is nothing to load.";
      }
      return null;
    },

    permission(input) {
      return { decision: "allow", risk: "low", category: "read", readOnlyCall: true, title: t("tools.perm.skill", { name: keyOf(input?.name).slice(0, 64) }) };
    },

    async run(input) {
      const skill = find(input?.name);
      if (!skill) {
        const names = nameList();
        return fail("noSkill", `There is no skill named ${JSON.stringify(keyOf(input?.name).slice(0, 64))}.${names ? ` Installed skills: ${names}.` : ""}`);
      }
      const loaded = loadSkill(skill);
      if (!loaded) return fail("skillUnreadable", `The skill "${skill.name}" could not be read (${skill.file}). Continue without it.`);
      const text = loaded.text || "(This skill has no instructions yet.)";
      // A skill's text cannot end its own block early: the closing tag inside it is broken up.
      const body = text.replace(/<\/skill/gi, "<\\/skill");
      const files = loaded.files.length
        ? `Other files in the skill's folder (read one with Read when the skill refers to it): ${loaded.files.join(", ")}.`
        : "The skill's folder holds no other files.";
      const task = typeof input.args === "string" && input.args.trim() ? `\nApply it to: ${headOnly(input.args.trim(), ARGS_MAX, "cut")}` : "";
      const content = [
        `<skill name="${attr(skill.name)}" scope="${attr(skill.scope)}" dir="${attr(skill.dir)}">`,
        body,
        "</skill>",
        files,
        `Follow this skill for the current task.${task}`,
      ].join("\n");
      return ok(content, { summary: tn("tools.skill.loaded", text.split("\n").length) });
    },
  };
}
