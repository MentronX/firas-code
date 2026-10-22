// Remember: durable project memory. The model saves a short fact the person wants kept across sessions,
// forgets one that is no longer true, or lists what is saved. The file is .firas/memory.md in the project;
// the system prompt carries it on every later turn.
import { t } from "../i18n/index.js";
import { ok, fail, settings, isPlainObject } from "./common.js";
import { remember, forget, memoryLines, MEMORY_MAX_CHARS } from "../agent/memory.js";

const DESCRIPTION = [
  "Saves, forgets or lists durable facts about this project that must survive across sessions (for example: the test command, a naming rule, a folder that must not be touched).",
  "Actions: remember (text: one short fact), forget (text: a phrase that identifies the saved fact), list.",
  "Use it when the person says to remember something, or when a fact will matter in later sessions. Do not save secrets, one-off details, or anything already in the project instructions.",
  `The memory is small (${MEMORY_MAX_CHARS} characters); keep each fact to one line and forget stale ones.`,
].join(" ");

export function createRememberTool() {
  return {
    name: "Remember",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["remember", "forget", "list"], description: "What to do." },
        text: { type: "string", maxLength: 500, description: "remember: the fact, one short line. forget: a phrase that identifies it." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,

    summarize(input) {
      if (!isPlainObject(input)) return "";
      return input.action === "remember" ? `remember: ${String(input.text || "").slice(0, 60)}` : input.action;
    },

    validate(input) {
      if (!isPlainObject(input) || !["remember", "forget", "list"].includes(input.action)) return "action must be remember, forget or list.";
      if (input.action !== "list" && (typeof input.text !== "string" || !input.text.trim())) return `text is required for ${input.action}.`;
      if (typeof input.text === "string" && input.text.length > 500) return "text is too long (limit 500 characters).";
      return null;
    },

    // It writes one small file inside the project and nothing else; the person asked for it by name.
    permission() { return { decision: "allow", risk: "low", category: "write", title: t("tools.perm.remember") }; },

    async run(input, ctx) {
      const s = settings(ctx);
      if (input.action === "list") {
        const lines = memoryLines(s.cwd);
        return ok(lines.length ? lines.join("\n") : "No project memory yet.", { summary: t("tools.remember.listed", { n: lines.length }) });
      }
      if (input.action === "remember") {
        const result = remember(s.cwd, input.text);
        if (!result.ok) {
          return result.reason === "full"
            ? fail("memoryFull", `The project memory is full (${MEMORY_MAX_CHARS} characters). Forget a stale fact first.`)
            : fail("empty", "The fact is empty.");
        }
        return ok(result.duplicate ? "That fact is already saved." : "Saved to the project memory.", { summary: t("tools.remember.saved") });
      }
      const result = forget(s.cwd, input.text);
      if (!result.ok) return fail("notFound", "No saved fact matches that text. Use list to see what is saved.");
      return ok(`Forgot ${result.removed} fact${result.removed === 1 ? "" : "s"}.`, { summary: t("tools.remember.forgot", { n: result.removed }) });
    },
  };
}
