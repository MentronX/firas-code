// The toolbox: builds every tool, resolves the shell once, and hands the agent loop the wire definitions.
//
// What tools expect in their ToolContext (ctx): { cwd, signal, platform, env, fileState, ui, client, config,
// session, depth, mode, progress, permissions }. `permissions` is the permission engine (ExitPlanMode uses it
// to leave plan mode); everything has a safe default, and toolbox.context(extra) builds a ready context.
import "./strings.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createMultiEditTool } from "./multiedit.js";
import { createBashTool } from "./bash.js";
import { createBashOutputTool, createKillShellTool } from "./bashoutput.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createWebFetchTool } from "./webfetch.js";
import { createTodoTool } from "./todo.js";
import { createAskUserTool } from "./askuser.js";
import { createExitPlanTool } from "./exitplan.js";
import { createLibraryTool } from "./library.js";
import { createJobs } from "./jobs.js";
import { resolveShell } from "./shell.js";
import { reveal } from "./common.js";

export { createPermissionEngine, MODES } from "./permissions.js";
export { resolveShell, buildInvocation, killTree } from "./shell.js";
export { classifyCommand } from "./classify.js";
export { guardPath, isSecretPath, isSystemPath } from "./pathguard.js";

/** The shell commands run in on this machine (also named in the Bash tool's description). */
export const shellInfo = resolveShell();

/** Tools that cannot change anything on the machine: the set an exploring sub-agent may use. */
export const READ_ONLY_TOOL_NAMES = Object.freeze(["Read", "Glob", "Grep", "LS", "WebFetch", "BashOutput", "UiLibrary"]);

/** Whatever a tool puts in a card header, text the model wrote included, shows hidden characters spelled out. */
function revealSummaries(tool) {
  const summarize = tool.summarize;
  tool.summarize = (input, ctx) => reveal(summarize.call(tool, input, ctx));
  return tool;
}

const REQUIRED = ["name", "description", "input_schema", "run", "permission"];

/**
 * createToolbox({ cwd, ui, client, config, session, mode, extraTools, shell?, jobs?, permissions?, webFetch? })
 *   extraTools  more tools (the sub-agent tool is added this way)
 *   shell       a resolveShell() result; default is the one resolved for this machine
 *   webFetch    { allowLoopback, lookup } test hooks for WebFetch - never reachable from tool input
 */
export function createToolbox({ cwd = process.cwd(), ui, client, config, session, mode = "default", extraTools = [], shell = shellInfo, jobs = createJobs(), permissions, webFetch } = {}) {
  const fileState = new Map();
  const tools = [
    createReadTool(), createWriteTool(), createEditTool(), createMultiEditTool(),
    createBashTool({ shell, jobs }), createBashOutputTool({ jobs }), createKillShellTool({ jobs }),
    createGlobTool(), createGrepTool(), createLsTool(), createWebFetchTool(webFetch),
    createTodoTool(), createAskUserTool(), createExitPlanTool(), createLibraryTool(),
  ].map(revealSummaries).concat(extraTools);
  const byName = new Map();
  for (const tool of tools) {
    const missing = REQUIRED.filter(key => tool?.[key] === undefined);
    if (missing.length) throw new TypeError(`Tool ${tool?.name ?? "(unnamed)"} is missing: ${missing.join(", ")}`);
    if (byName.has(tool.name)) throw new Error(`Two tools are named ${tool.name}`);
    byName.set(tool.name, tool);
  }
  const wire = new Map(tools.map(tool => [tool.name, { name: tool.name, description: tool.description, input_schema: tool.input_schema }]));

  return {
    tools,
    byName,
    cwd,
    mode,
    shell,
    jobs,
    fileState,

    has: name => byName.has(name),

    /**
     * Wire tool definitions [{ name, description, input_schema }].
     * filter: a predicate (tool) => boolean, an array of names, or { readOnly?, only?, exclude? }.
     */
    definitions(filter) {
      let list = tools;
      if (typeof filter === "function") list = tools.filter(filter);
      else if (Array.isArray(filter)) { const keep = new Set(filter); list = tools.filter(tool => keep.has(tool.name)); }
      else if (filter && typeof filter === "object") {
        if (filter.readOnly) list = list.filter(tool => tool.readOnly);
        if (Array.isArray(filter.only)) list = list.filter(tool => filter.only.includes(tool.name));
        if (Array.isArray(filter.exclude)) list = list.filter(tool => !filter.exclude.includes(tool.name));
      }
      return list.map(tool => ({ ...wire.get(tool.name) }));
    },

    /** A ToolContext with defaults filled in; pass { signal, progress, depth, toolUseId, ... } as `extra`. */
    context(extra = {}) {
      return {
        cwd, platform: process.platform, env: process.env, fileState, ui, client, config, session, depth: 0,
        mode: permissions?.mode ?? mode, permissions, progress: () => {}, ...extra,
      };
    },

    /** Stops every background job. Call it when the app exits. */
    async dispose() { await jobs.killAll(); },
  };
}
