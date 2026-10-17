// AskUserQuestion: a question to the person, with optional answer choices.
import { t } from "../i18n/index.js";
import { ok, fail, isPlainObject, oneLine } from "./common.js";

export const ASK_MAX_OPTIONS = 8;

const DESCRIPTION = [
  "Asks the user one question and waits for the answer. Provide 2-6 options when the answer is a choice (the user can also type their own answer); omit options for a free-text question; set multi to true to allow several choices.",
  "Use it when the request is ambiguous in a way that changes the work, or when a decision belongs to the user (which approach, which of several files, a risky step).",
  "Do not use it for things you can find out by reading the project, for trivial preferences, to ask permission (permission prompts are automatic), or more than once in a row when one question would do.",
].join(" ");

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map(o => (typeof o === "string" ? { label: o } : o)).filter(o => isPlainObject(o) && typeof o.label === "string" && o.label.trim())
    .map(o => ({ label: o.label.trim(), ...(typeof o.description === "string" && o.description.trim() ? { description: o.description.trim() } : {}) }));
}

export function createAskUserTool() {
  return {
    name: "AskUserQuestion",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, complete and self-contained." },
        options: {
          type: "array",
          maxItems: ASK_MAX_OPTIONS,
          description: "Answer choices (optional).",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short choice text." },
              description: { type: "string", description: "One sentence explaining the choice." },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
        multi: { type: "boolean", description: "Allow selecting more than one option. Default false." },
      },
      required: ["question"],
      additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,

    summarize(input) { return oneLine(input?.question, 100); },

    validate(input) {
      if (typeof input?.question !== "string" || !input.question.trim()) return "question is required (a non-empty string).";
      if (input.options !== undefined && !Array.isArray(input.options)) return "options must be an array of { label, description? }.";
      if (Array.isArray(input.options) && input.options.length > ASK_MAX_OPTIONS) return `Too many options (limit ${ASK_MAX_OPTIONS}).`;
      return null;
    },

    permission() { return { decision: "allow", risk: "low", category: "ui", readOnlyCall: true, title: t("tools.perm.ask") }; },

    async run(input, ctx) {
      if (!ctx?.ui || typeof ctx.ui.askQuestion !== "function" || (ctx.depth || 0) > 0) {
        return fail("noUi", "There is no person to ask right now. Choose the most reasonable option yourself, say what you assumed, and continue.");
      }
      const options = normalizeOptions(input.options);
      const answer = await ctx.ui.askQuestion({ question: input.question.trim(), ...(options.length ? { options } : {}), multi: input.multi === true || input.multi === "true" });
      const text = typeof answer?.answer === "string" ? answer.answer.trim() : "";
      if (!text) return { ok: false, content: "The user dismissed the question without answering. Do not repeat it; continue with a sensible default or stop and explain what you need.", display: { summary: t("tools.ask.dismissed") } };
      return ok(`The user answered: ${text}`, { summary: t("tools.ask.answered", { answer: oneLine(text, 60) }) });
    },
  };
}
