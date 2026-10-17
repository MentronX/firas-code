// The permission engine: turns a tool's verdict (what the call would do and how risky it is) into a decision
// for the active mode, asks the person when needed, and remembers "allow for this session" rules.
//
// A verdict, as returned by tool.permission(input, ctx):
//   { decision: "allow"|"ask"|"deny", risk: "low"|"medium"|"high", title, detail?, diff?, reason?,
//     sessionKey?, sessionKeys?, sessionLabel?,
//     category?: "read"|"edit"|"exec"|"net"|"ui",   inside?: boolean (the target is inside the project),
//     readOnlyCall?: boolean (this particular call changes nothing - allowed in plan mode) }
//
// Rules, in order:
//   deny verdict            -> denied
//   plan mode               -> only read-only tools / read-only calls / ExitPlanMode; the rest is denied with a hint
//   allow verdict           -> allowed
//   bypass mode             -> asks are allowed, EXCEPT risk "high" (destructive commands, system folders, secrets)
//   acceptEdits mode        -> edits inside the project are allowed
//   session rule            -> allowed (never for risk "high")
//   otherwise               -> ask the person
import { t } from "../i18n/index.js";
import "./strings.js";

export const MODES = Object.freeze(["default", "acceptEdits", "plan", "bypass"]);
const CYCLE = ["default", "acceptEdits", "plan"];

const PLAN_MESSAGE = "Plan mode is active: you may only read and explore (Read, Glob, Grep, LS, WebFetch, read-only commands). Do not change files or run commands that change anything. When your plan is ready, call ExitPlanMode with the plan so the user can approve it.";

const denied = (by, message, feedback) => ({ allowed: false, by, message, ...(feedback ? { feedback } : {}) });

export function createPermissionEngine({ mode = "default", ui } = {}) {
  let current = MODES.includes(mode) ? mode : "default";
  const sessionRules = new Set();
  let counter = 0;
  let queue = Promise.resolve();

  const keysOf = verdict => {
    if (Array.isArray(verdict.sessionKeys) && verdict.sessionKeys.length) return verdict.sessionKeys;
    return verdict.sessionKey ? [verdict.sessionKey] : [];
  };
  const covered = keys => keys.length > 0 && keys.every(key => sessionRules.has(key));

  const engine = {
    get mode() { return current; },

    setMode(next) {
      if (!MODES.includes(next)) throw new RangeError(`Unknown permission mode: ${next}`);
      current = next;
      return current;
    },

    /** default -> acceptEdits -> plan -> default. Bypass is never reached by cycling, and cycling leaves it. */
    cycleMode() {
      const at = CYCLE.indexOf(current);
      current = at === -1 ? "default" : CYCLE[(at + 1) % CYCLE.length];
      return current;
    },

    sessionRules,

    reset() { sessionRules.clear(); counter = 0; },

    /** Resolves to { allowed, feedback?, by?, message? }. `message` is a ready sentence for the model when denied. */
    async check(tool, input, ctx = {}) {
      // The same ctx object is handed to tool.run afterwards: ExitPlanMode needs the engine there to leave plan mode.
      if (ctx && typeof ctx === "object") { ctx.permissions = engine; ctx.mode = current; }
      let verdict;
      try {
        verdict = await tool.permission(input, ctx);
      } catch (error) {
        return denied("tool", `The permission check failed (${error?.message || "error"}), so the action was not run.`);
      }
      verdict = verdict || { decision: "ask", risk: "medium", title: tool.name };
      const risk = verdict.risk || "medium";

      if (verdict.decision === "deny") {
        const reason = verdict.reason || t("tools.perm.denied");
        return denied("tool", reason, reason);
      }
      if (current === "plan" && !(tool.readOnly || verdict.readOnlyCall || tool.name === "ExitPlanMode")) {
        return denied("mode", PLAN_MESSAGE, PLAN_MESSAGE);
      }
      if (verdict.decision === "allow") return { allowed: true };
      if (current === "bypass" && risk !== "high") return { allowed: true };
      if (current === "acceptEdits" && verdict.category === "edit" && verdict.inside && risk !== "high") return { allowed: true };

      const keys = risk === "high" ? [] : keysOf(verdict);
      if (covered(keys)) return { allowed: true };

      const run = async () => {
        if (covered(keys)) return { allowed: true }; // an earlier prompt in the queue may have settled it
        if (!ui || typeof ui.askPermission !== "function") return denied("user", "No one is available to approve this action, so it was not run.");
        const request = {
          id: ctx.toolUseId || `perm-${++counter}`,
          tool: tool.name,
          title: verdict.title || tool.name,
          summary: typeof tool.summarize === "function" ? tool.summarize(input, ctx) : "",
          ...(verdict.detail ? { detail: verdict.detail } : {}),
          ...(verdict.diff ? { diff: verdict.diff } : {}),
          risk,
          ...(keys.length ? { sessionKey: verdict.sessionKey || keys.join(" && "), sessionLabel: verdict.sessionLabel } : {}),
        };
        let answer;
        try { answer = await ui.askPermission(request); } catch { answer = { decision: "deny" }; }
        if (answer?.decision === "allow") return { allowed: true };
        if (answer?.decision === "allow-session") {
          for (const key of keys) sessionRules.add(key);
          return { allowed: true };
        }
        const note = typeof answer?.feedback === "string" ? answer.feedback.trim() : "";
        return denied("user", note
          ? `The user declined this action and said: ${note}`
          : "The user declined this action. Do not retry it unchanged; ask what they would prefer or choose another approach.", note);
      };
      // One question at a time, even when tools run in parallel.
      const next = queue.then(run, run);
      queue = next.catch(() => {});
      return next;
    },
  };
  return engine;
}
