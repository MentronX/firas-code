// ExitPlanMode: presents the finished plan; on approval the permission mode is switched so work can begin.
// It relies on ctx.permissions (the permission engine) to switch modes.
import { t } from "../i18n/index.js";
import { ok, fail } from "./common.js";

const DESCRIPTION = [
  "Use this only in plan mode, when your plan is complete: it shows the plan to the user and asks for approval to start working.",
  "Write the plan as concise markdown: the goal, the files you will change and how, and how you will verify the result. Do not start the work before the user approves.",
  "If the user rejects the plan, read their feedback, revise the plan and call this tool again.",
  "Do not use it when plan mode is not active, for research questions, or to ask an open question (use AskUserQuestion for that).",
].join(" ");

export function createExitPlanTool() {
  return {
    name: "ExitPlanMode",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: { plan: { type: "string", description: "The plan, in markdown." } },
      required: ["plan"],
      additionalProperties: false,
    },
    readOnly: false,
    concurrencySafe: false,

    summarize() { return t("tools.plan.header"); },

    validate(input) {
      return typeof input?.plan === "string" && input.plan.trim() ? null : "plan is required (a non-empty markdown string).";
    },

    // The plan dialog is the question; no separate prompt. Allowed in plan mode by definition.
    permission() { return { decision: "allow", risk: "low", category: "ui", readOnlyCall: true, title: t("tools.perm.plan") }; },

    async run(input, ctx) {
      if (!ctx?.ui || typeof ctx.ui.showPlan !== "function" || (ctx.depth || 0) > 0) {
        return fail("noUi", "There is no person to approve a plan right now. Continue carefully with the smallest safe steps.");
      }
      const current = ctx.permissions?.mode ?? ctx.mode;
      if (current !== "plan") {
        return ok("Plan mode is not active, so no approval is needed. Continue with the work.", { summary: t("tools.plan.notActive") });
      }
      const answer = await ctx.ui.showPlan({ plan: input.plan.trim() });
      const decision = answer?.decision;
      if (decision === "approve" || decision === "approve-edits") {
        const next = decision === "approve" ? "default" : "acceptEdits";
        try { ctx.permissions?.setMode?.(next); } catch { /* the engine refuses nothing here; ignore a stub */ }
        try { ctx.ui.notice?.("info", t(decision === "approve" ? "tools.plan.switchedDefault" : "tools.plan.switchedEdits")); } catch { /* cosmetic */ }
        return ok(decision === "approve"
          ? "The user approved the plan. Plan mode is off: you can now change files and run commands (each will still ask for permission). Carry out the plan step by step."
          : "The user approved the plan and agreed that edits inside the project need no further confirmation. Plan mode is off. Carry out the plan step by step; commands still ask for permission.",
        { summary: t("tools.plan.approved") });
      }
      const feedback = typeof answer?.feedback === "string" && answer.feedback.trim() ? ` The user's feedback: ${answer.feedback.trim()}` : "";
      return { ok: false, content: `The user did not approve the plan.${feedback} Plan mode stays on: revise the plan and call ExitPlanMode again, or ask what they want changed.`, display: { summary: t("tools.plan.rejected") } };
    },
  };
}
