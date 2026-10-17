// TodoWrite: the visible task list. Pure interface state, nothing on disk.
import { t } from "../i18n/index.js";
import { ok, isPlainObject, tn } from "./common.js";

export const TODO_MAX = 50;
const STATUSES = ["pending", "in_progress", "completed"];

const DESCRIPTION = [
  "Creates or replaces the task list shown to the user. Send the complete list every time (it replaces the previous one).",
  "Use it for work with three or more distinct steps, or when the user gives several tasks: write the steps first, set exactly one item to in_progress while you work on it, and mark it completed as soon as it is done (do not batch updates).",
  "Each item has content (imperative, e.g. \"Run the tests\"), activeForm (present continuous, e.g. \"Running the tests\") and status.",
  "Do not use it for a single simple step, for conversation, or to store notes: it has no effect on files.",
].join(" ");

export function createTodoTool() {
  return {
    name: "TodoWrite",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: TODO_MAX,
          description: "The complete task list.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What to do, in the imperative." },
              status: { type: "string", enum: STATUSES, description: "pending, in_progress (only one at a time) or completed." },
              activeForm: { type: "string", description: "The same task in present continuous, shown while it runs." },
            },
            required: ["content", "status", "activeForm"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,

    summarize(input) { return Array.isArray(input?.todos) ? tn("tools.todo.count", input.todos.length) : ""; },

    validate(input) {
      if (!Array.isArray(input?.todos)) return "todos must be an array of { content, status, activeForm }.";
      if (input.todos.length > TODO_MAX) return `Too many items (${input.todos.length}); keep the list under ${TODO_MAX}.`;
      for (let i = 0; i < input.todos.length; i++) {
        const item = input.todos[i];
        if (!isPlainObject(item) || typeof item.content !== "string" || !item.content.trim()) return `todos[${i}].content must be a non-empty string.`;
        if (item.content.length > 300) return `todos[${i}].content is too long (limit 300 characters).`;
        if (!STATUSES.includes(item.status)) return `todos[${i}].status must be one of ${STATUSES.join(", ")}.`;
      }
      return null;
    },

    permission() { return { decision: "allow", risk: "low", category: "ui", readOnlyCall: true, title: t("tools.perm.todo") }; },

    async run(input, ctx) {
      const items = input.todos.map(item => ({
        content: item.content.trim(),
        status: item.status,
        activeForm: typeof item.activeForm === "string" && item.activeForm.trim() ? item.activeForm.trim() : item.content.trim(),
      }));
      try { ctx?.ui?.todos?.(items); } catch { /* the list is cosmetic; the model's copy is what counts */ }
      if (ctx?.session && typeof ctx.session === "object") { try { ctx.session.todos = items; } catch { /* frozen session */ } }
      const done = items.filter(i => i.status === "completed").length;
      const active = items.filter(i => i.status === "in_progress").length;
      const notes = [];
      if (active > 1) notes.push("More than one item is in_progress; keep exactly one.");
      if (items.length && done === items.length) notes.push("Every item is completed.");
      return ok(`Task list updated: ${items.length} item${items.length === 1 ? "" : "s"} (${done} completed, ${active} in progress, ${items.length - done - active} pending). ${notes.join(" ")} Continue with the current task.`.replace(/\s+/g, " ").trim(), {
        summary: t("tools.todo.done", { done, n: items.length }),
      });
    },
  };
}
