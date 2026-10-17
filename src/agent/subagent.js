// The `Agent` tool: runs a nested loop with its own history and returns only the final text, so a broad search
// does not fill the main conversation. Depth is 1: a sub-agent never gets Agent, TodoWrite, AskUserQuestion or
// ExitPlanMode. Permission prompts still reach the user because the nested loop uses the same permission engine.
import { t } from "../i18n/index.js";
import "./strings.js";
import { runAgentLoop } from "./loop.js";
import { buildSubagentPrompt, defaultShellLabel, formatDate, loadProjectInstructions } from "./prompt.js";
import { createSession } from "./session.js";
import { randomId, safeUi } from "./support.js";

export const SUBAGENT_MAX_STEPS = 30;
const NEVER_FOR_SUBAGENTS = new Set(["Agent", "AskUserQuestion", "ExitPlanMode", "TodoWrite"]);
const EXPLORE_EXCLUDED = new Set(["UiLibrary"]);
const EFFORT_ORDER = ["off", "low", "medium", "high", "xhigh", "max"];

const DESCRIPTION = `Launch a sub-agent to handle a task on its own and report back. It has its own conversation and tools; only its final message returns to you, so your context stays small.

Use it for:
- broad or open-ended searches ("where is authentication handled?", "find every caller of X") that would take many Glob, Grep and Read calls;
- independent investigations you can run in parallel (launch several in one message);
- reviewing a diff or a module and reporting problems.

Do not use it for:
- a lookup one Glob, Grep or Read can answer, or reading a file whose path you already know;
- a small change you can make directly;
- anything that needs the user's input: sub-agents cannot ask questions or keep a TodoWrite plan.

Kinds: "explore" (default) is read-only: it searches and reads but cannot edit files or run commands. "general" can also edit files and run commands; launch general agents one at a time and never two on the same files.

The sub-agent knows nothing about this conversation. Write a complete, self-contained prompt: the goal, the relevant paths and background, what to look for, and the shape of the answer you want (for example "list path:line and a one-line reason for each"). Its report is not shown to the user, so summarize what matters yourself, and spot-check important claims in the files it cites.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string", description: "A short label for the task (3 to 7 words)." },
    prompt: { type: "string", description: "The full, self-contained task for the sub-agent." },
    kind: { type: "string", enum: ["explore", "general"], description: "explore (default): read-only search and analysis. general: may also edit files and run commands." },
  },
  required: ["description", "prompt"],
};

function clampEffort(effort, kind) {
  // Searching rarely needs deep reasoning; keep explorers fast.
  if (kind !== "explore") return effort;
  const cap = EFFORT_ORDER.indexOf("medium");
  const at = EFFORT_ORDER.indexOf(effort);
  return at > cap ? "medium" : effort;
}

/** A read-only or full view of the real toolbox that never contains the tools a sub-agent must not have. */
export function narrowToolbox(toolbox, kind) {
  const tools = (toolbox.tools || []).filter(tool => {
    if (NEVER_FOR_SUBAGENTS.has(tool.name)) return false;
    if (kind === "explore") return !!tool.readOnly && !EXPLORE_EXCLUDED.has(tool.name);
    return true;
  });
  const names = new Set(tools.map(tool => tool.name));
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return {
    tools,
    byName,
    shell: toolbox.shell,
    has: name => names.has(name),
    definitions: () => toolbox.definitions().filter(def => names.has(def.name)),
  };
}

/**
 * The Agent tool. `toolbox` may be the toolbox, a function returning it, or omitted: the loop always puts the
 * running toolbox on ctx, which resolves the chicken-and-egg of a toolbox that must contain this tool.
 */
export function createAgentTool({ client, ui, permissions, toolbox, getEffort, lang }) {
  const resolveToolbox = ctx => (typeof toolbox === "function" ? toolbox() : toolbox) || ctx?.toolbox;

  return {
    name: "Agent",
    description: DESCRIPTION,
    input_schema: INPUT_SCHEMA,
    readOnly: true,
    concurrencySafe: true,
    // Parallel explorers are the point; parallel writers on the same files are not.
    isParallel: input => (input?.kind || "explore") !== "general",
    summarize: input => String(input?.description || "sub-agent"),
    validate(input) {
      if (typeof input?.prompt !== "string" || !input.prompt.trim()) return "prompt must be a non-empty string";
      if (input.kind !== undefined && input.kind !== "explore" && input.kind !== "general") return 'kind must be "explore" or "general"';
      return null;
    },
    permission: input => ({ decision: "allow", risk: "low", title: `Agent: ${input?.description || ""}` }),

    async run(input, ctx) {
      if ((ctx?.depth ?? 0) >= 1) return { ok: false, content: "Sub-agents cannot start other sub-agents." };
      const real = resolveToolbox(ctx);
      if (!real) return { ok: false, content: "The Agent tool has no toolbox to work with." };

      const kind = input.kind === "general" ? "general" : "explore";
      const sub = narrowToolbox(real, kind);
      const cwd = ctx?.cwd || process.cwd();
      const id = ctx?.toolUseId || randomId("agent");
      const startedAt = Date.now();
      const realUi = safeUi(ui || ctx?.ui);
      const session = createSession({ cwd, mode: ctx?.mode, persist: false });
      session.addUser(input.prompt);

      let toolCalls = 0;
      let lastError = "";
      // The nested loop talks to this stand-in: its text and thinking stay out of the main transcript, each tool
      // it starts becomes one progress line on the Agent card, and its token use is billed to the main session.
      const subUi = {
        toolStart: ({ name, summary }) => {
          toolCalls += 1;
          ctx?.progress?.(summary ? `${name} ${summary}` : name);
        },
        notice: (level, text) => { if (level === "error") lastError = text; },
        usage: () => {},
      };

      realUi.agentStart({ id, description: input.description, kind });
      const system = buildSubagentPrompt({
        kind,
        cwd,
        platform: ctx?.platform || process.platform,
        shell: sub.shell || defaultShellLabel(),
        date: formatDate(new Date()),
        lang,
        toolNames: sub.tools.map(tool => tool.name),
        projectInstructions: loadProjectInstructions(cwd),
      });

      let outcome;
      try {
        outcome = await runAgentLoop({
          session,
          ui: subUi,
          client: client || ctx?.client,
          toolbox: sub,
          permissions,
          config: ctx?.config,
          effort: clampEffort(getEffort ? getEffort() : "medium", kind),
          signal: ctx?.signal,
          system,
          depth: 1,
          maxSteps: SUBAGENT_MAX_STEPS,
          turn: ctx?.turn,
          fileState: new Map(),
        });
      } catch (err) {
        outcome = { stopReason: "error", text: "", usage: { inputTokens: 0, outputTokens: 0 } };
        lastError = err?.message || String(err);
      }
      ctx?.session?.addUsage?.(outcome.usage);

      const ms = Date.now() - startedAt;
      const finish = (ok, content, summary) => {
        realUi.agentEnd({ id, ok, summary, ms });
        return { ok, content, display: { summary } };
      };
      const steps = t("agent.agentSteps", { n: toolCalls });
      switch (outcome.stopReason) {
        case "end_turn":
          if (!outcome.text.trim()) return finish(false, "The sub-agent finished without writing a result. Ask again with a more specific prompt.", `${steps} · ${t("agent.agentNoResult")}`);
          return finish(true, outcome.text, steps);
        case "max_steps":
          return finish(true, `${outcome.text || "(no text yet)"}\n\n[The sub-agent stopped at its ${SUBAGENT_MAX_STEPS}-step limit; this result may be incomplete.]`, `${steps} · ${t("agent.agentLimit", { n: SUBAGENT_MAX_STEPS })}`);
        case "max_tokens":
          return finish(true, `${outcome.text || "(no text yet)"}\n\n[The sub-agent's last reply hit the output limit; this result may be incomplete.]`, steps);
        case "aborted":
          return finish(false, "[interrupted by the user]", t("agent.agentInterrupted"));
        default:
          return finish(false, `The sub-agent failed${lastError ? `: ${lastError}` : "."}`, t("agent.agentFailed"));
      }
    },
  };
}
