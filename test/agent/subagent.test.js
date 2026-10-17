import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTool, narrowToolbox, SUBAGENT_MAX_STEPS } from "../../src/agent/subagent.js";
import { runUserTurn } from "../../src/agent/loop.js";
import { createSession } from "../../src/agent/session.js";
import { setLang } from "../../src/i18n/index.js";
import { assertValidHistory, fakeClient, fakePermissions, fakeTool, fakeToolbox, fakeUi, sleep, textReply, toolReply } from "./fakes.js";

setLang("en");

const SUB_PROMPT_START = "You are a sub-agent of";
const isSub = request => request.system[0].text.startsWith(SUB_PROMPT_START);

function buildTools({ onRun } = {}) {
  const run = name => async input => { onRun?.(name, input); return { ok: true, content: `${name} result for ${input.path ?? ""}` }; };
  const schema = { type: "object", properties: { path: { type: "string" } }, required: [] };
  return [
    fakeTool("Read", { readOnly: true, concurrencySafe: true, schema, run: run("Read") }),
    fakeTool("Glob", { readOnly: true, concurrencySafe: true, schema, run: run("Glob") }),
    fakeTool("Grep", { readOnly: true, concurrencySafe: true, schema, run: run("Grep") }),
    fakeTool("UiLibrary", { readOnly: true, concurrencySafe: true, schema, run: run("UiLibrary") }),
    fakeTool("Edit", { schema, run: run("Edit") }),
    fakeTool("Bash", { schema, run: run("Bash") }),
    fakeTool("TodoWrite", { schema, run: run("TodoWrite") }),
    fakeTool("AskUserQuestion", { schema, run: run("AskUserQuestion") }),
    fakeTool("ExitPlanMode", { schema, run: run("ExitPlanMode") }),
  ];
}

function env({ script, decide, effort = "medium", tools } = {}) {
  const client = fakeClient(script);
  const ui = fakeUi();
  const permissions = fakePermissions({ decide });
  const baseTools = tools ?? buildTools();
  const agent = createAgentTool({ client, ui, permissions, getEffort: () => effort, lang: "en" });
  const toolbox = fakeToolbox([...baseTools, agent]);
  const session = createSession({ cwd: process.cwd(), persist: false });
  session.addUser("main conversation message");
  session.addAssistant({ content: [{ type: "text", text: "main answer" }] });
  const progress = [];
  const ctx = {
    cwd: process.cwd(), signal: new AbortController().signal, platform: process.platform, env: process.env, fileState: new Map(),
    ui, client, session, depth: 0, mode: "default", toolbox, toolUseId: "agent-call-1", progress: text => progress.push(text),
  };
  return { client, ui, permissions, agent, toolbox, session, ctx, progress };
}

const toolNames = request => (request.tools || []).map(t => t.name);

test("the Agent tool is described for the model, with when to use it and when not", () => {
  const { agent } = env({ script: [] });
  assert.equal(agent.name, "Agent");
  assert.deepEqual(agent.input_schema.required, ["description", "prompt"]);
  assert.deepEqual(agent.input_schema.properties.kind.enum, ["explore", "general"]);
  assert.match(agent.description, /Use it for/);
  assert.match(agent.description, /broad or open-ended searches/);
  assert.match(agent.description, /reviewing a diff/);
  assert.match(agent.description, /Do not use it for/);
  assert.match(agent.description, /one Glob, Grep or Read/);
  assert.match(agent.description, /knows nothing about this conversation/);
  assert.equal(agent.readOnly, true);
  assert.equal(agent.summarize({ description: "Find auth code" }), "Find auth code");
  assert.equal(agent.permission({ description: "x" }, {}).decision, "allow");
  assert.equal(agent.validate({ description: "x", prompt: "  " }), "prompt must be a non-empty string");
  assert.match(agent.validate({ description: "x", prompt: "p", kind: "wizard" }), /kind must be/);
  assert.equal(agent.validate({ description: "x", prompt: "p" }), null);
  assert.equal(agent.isParallel({ kind: "explore" }), true);
  assert.equal(agent.isParallel({}), true);
  assert.equal(agent.isParallel({ kind: "general" }), false);
});

test("an explore sub-agent works in its own history with a read-only toolbox and returns only its final text", async () => {
  const e = env({
    effort: "xhigh",
    script: [
      toolReply([{ id: "r1", name: "Read", input: { path: "src/a.js" } }, { id: "g1", name: "Grep", input: { path: "src" } }]),
      textReply("Auth lives in src/auth.js:42 (login) and src/session.js:7."),
    ],
  });
  const before = JSON.stringify(e.session.messages);
  const result = await e.agent.run({ description: "Find auth", prompt: "Where is authentication handled?" }, e.ctx);

  assert.equal(result.ok, true);
  assert.equal(result.content, "Auth lives in src/auth.js:42 (login) and src/session.js:7.");
  assert.equal(JSON.stringify(e.session.messages), before, "the main history is untouched");

  const [first, second] = e.client.requests;
  assert.equal(first.messages.length, 1, "a fresh history: only the prompt");
  assert.equal(first.messages[0].content[0].text, "Where is authentication handled?");
  assert.ok(!JSON.stringify(first).includes("main conversation message"));
  assert.deepEqual(toolNames(first).sort(), ["Glob", "Grep", "Read"]);
  for (const banned of ["Agent", "TodoWrite", "AskUserQuestion", "ExitPlanMode", "Edit", "Bash", "UiLibrary"]) assert.ok(!toolNames(first).includes(banned), banned);
  assert.match(first.system[0].text, /^You are a sub-agent of/);
  assert.match(first.system[0].text, /You are read-only/);
  assert.equal(first.output_config.effort, "medium", "explorers do not need deep reasoning");
  assert.equal(first.max_tokens, 16000);
  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[2].content.length, 2, "both tool results come back in one message");

  assert.deepEqual(e.ui.of("agentStart"), [[{ id: "agent-call-1", description: "Find auth", kind: "explore" }]]);
  const [[end]] = e.ui.of("agentEnd");
  assert.equal(end.id, "agent-call-1");
  assert.equal(end.ok, true);
  assert.equal(end.summary, "2 tool calls");
  assert.equal(typeof end.ms, "number");
  assert.deepEqual(e.progress, ["Read src/a.js", "Grep src"]);
  assert.ok(!e.ui.names().includes("textDelta"), "the sub-agent's text is not streamed into the main transcript");
  assert.ok(!e.ui.names().includes("toolStart"), "nor are its tool cards");
  assert.equal(e.session.usage.inputTokens, 200, "its tokens are billed to the session");
});

test("a general sub-agent can edit and run commands, keeps the effort, still has no Agent tool", async () => {
  const e = env({ effort: "xhigh", script: [textReply("Edited.")] });
  const result = await e.agent.run({ description: "Fix typo", prompt: "Fix the typo in README", kind: "general" }, e.ctx);
  assert.equal(result.ok, true);
  const req = e.client.requests[0];
  assert.deepEqual(toolNames(req).sort(), ["Bash", "Edit", "Glob", "Grep", "Read", "UiLibrary"]);
  assert.match(req.system[0].text, /may read, edit files and run commands/);
  assert.equal(req.output_config.effort, "xhigh");
  assert.equal(req.max_tokens, 32000);
  assert.equal(e.ui.of("agentStart")[0][0].kind, "general");
});

test("permission prompts of a sub-agent still reach the permission engine, marked as depth 1", async () => {
  const seen = [];
  const e = env({
    script: [toolReply([{ id: "w1", name: "Edit", input: { path: "a.js" } }]), textReply("The user refused the edit.")],
    decide: (tool, input, ctx) => { seen.push({ tool: tool.name, depth: ctx.depth }); return { allowed: false, feedback: "not that file" }; },
  });
  const result = await e.agent.run({ description: "Edit", prompt: "edit a.js", kind: "general" }, e.ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ tool: "Edit", depth: 1 }]);
  assert.match(JSON.stringify(e.client.requests[1].messages), /not that file/);
});

test("a sub-agent cannot start another sub-agent", async () => {
  const e = env({ script: [] });
  const result = await e.agent.run({ description: "x", prompt: "y" }, { ...e.ctx, depth: 1 });
  assert.equal(result.ok, false);
  assert.match(result.content, /cannot start other sub-agents/);
  assert.equal(e.client.calls, 0);
});

test("aborting the turn stops the sub-agent and reports it", { timeout: 10000 }, async () => {
  const ctl = new AbortController();
  const e = env({ script: [{ events: textReply("working"), hangAfter: 2 }] });
  setTimeout(() => ctl.abort(), 30);
  const result = await e.agent.run({ description: "x", prompt: "y" }, { ...e.ctx, signal: ctl.signal });
  assert.equal(result.ok, false);
  assert.match(result.content, /interrupted/);
  const [[end]] = e.ui.of("agentEnd");
  assert.equal(end.ok, false);
});

test("a sub-agent stops at 30 steps and says its result may be incomplete", async () => {
  const e = env({ script: (request, n) => toolReply([{ id: `s${n}`, name: "Read", input: { path: `f${n}` } }], { text: n === 29 ? "last notes" : undefined }) });
  const result = await e.agent.run({ description: "x", prompt: "y" }, e.ctx);
  assert.equal(SUBAGENT_MAX_STEPS, 30);
  assert.equal(e.client.calls, 30);
  assert.equal(result.ok, true);
  assert.match(result.content, /last notes/);
  assert.match(result.content, /30-step limit; this result may be incomplete/);
  assert.match(result.display.summary, /30 tool calls/);
});

test("a failing sub-agent reports a failure instead of throwing", async () => {
  const err = Object.assign(new Error("raw"), { userMessage: "The service is busy right now." });
  const e = env({ script: [{ events: [], throwAfter: err }] });
  const result = await e.agent.run({ description: "x", prompt: "y" }, e.ctx);
  assert.equal(result.ok, false);
  assert.match(result.content, /The sub-agent failed: The service is busy right now\./);
  assert.equal(e.ui.of("agentEnd")[0][0].ok, false);

  const silent = env({ script: [textReply("")] });
  const empty = await silent.agent.run({ description: "x", prompt: "y" }, silent.ctx);
  assert.equal(empty.ok, false);
});

test("a main turn can delegate: the sub-agent's report comes back as a tool result, its work stays out of the history", async () => {
  const sessionUi = fakeUi();
  const permissions = fakePermissions();
  const client = fakeClient((request, n) => {
    if (isSub(request)) {
      const subTurn = request.messages.length;
      return subTurn === 1
        ? toolReply([{ id: "sr1", name: "Grep", input: { path: "src" } }])
        : textReply("Found: parser in src/parse.js:10.");
    }
    return request.messages.length === 1
      ? toolReply([{ id: "agent1", name: "Agent", input: { description: "Find parser", prompt: "Find the parser", kind: "explore" } }], { text: "I will delegate this search." })
      : textReply("The parser is in src/parse.js.");
  });
  const agent = createAgentTool({ client, ui: sessionUi, permissions, getEffort: () => "low", lang: "en" });
  const toolbox = fakeToolbox([...buildTools(), agent]);
  const session = createSession({ cwd: process.cwd(), persist: false });
  const result = await runUserTurn({ session, text: "where is the parser?", ui: sessionUi, client, toolbox, permissions, effort: "low", lang: "en", system: "MAIN" });

  assert.equal(result.stopReason, "end_turn");
  assertValidHistory(session.messages);
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages[2].content[0].content, "Found: parser in src/parse.js:10.");
  assert.ok(!JSON.stringify(session.messages).includes("sr1"), "the sub-agent's own tool calls are not in the main history");
  const mainRequests = client.requests.filter(r => !isSub(r));
  assert.ok(mainRequests[0].tools.some(t => t.name === "Agent"));
  const subRequests = client.requests.filter(isSub);
  assert.equal(subRequests.length, 2);
  assert.ok(subRequests.every(r => !r.tools.some(t => t.name === "Agent")));
  assert.equal(sessionUi.of("agentStart")[0][0].id, "agent1", "the card id is the tool_use id");
  assert.equal(sessionUi.of("toolEnd").filter(a => a[0].name === "Agent").length, 1);
});

test("explore agents launched together run in parallel; general agents run one after another", async () => {
  const log = [];
  const permissions = fakePermissions();
  const ui = fakeUi();
  const timedRead = fakeTool("Read", {
    readOnly: true,
    concurrencySafe: true,
    schema: { type: "object", properties: { path: { type: "string" } } },
    run: async input => { log.push(`start ${input.path}`); await sleep(40); log.push(`end ${input.path}`); return { ok: true, content: input.path }; },
  });
  const agents = kind => [
    { id: "a1", name: "Agent", input: { description: "A", prompt: "task alpha", kind } },
    { id: "a2", name: "Agent", input: { description: "B", prompt: "task beta", kind } },
  ];
  const client = fakeClient(request => {
    if (isSub(request)) {
      const label = /task (\w+)/.exec(request.messages[0].content[0].text)[1];
      return request.messages.length === 1 ? toolReply([{ id: `t_${label}`, name: "Read", input: { path: label } }]) : textReply(`report ${label}`);
    }
    if (request.messages.length > 1) return textReply("both done");
    return toolReply(agents(request.messages[0].content[0].text.startsWith("parallel") ? "explore" : "general"));
  });
  const agent = createAgentTool({ client, ui, permissions, getEffort: () => "low", lang: "en" });
  const toolbox = fakeToolbox([timedRead, agent]);

  const par = createSession({ cwd: process.cwd(), persist: false });
  await runUserTurn({ session: par, text: "parallel please", ui, client, toolbox, permissions, effort: "low", system: "MAIN" });
  assert.deepEqual(log.slice(0, 2).sort(), ["start alpha", "start beta"], "explorers overlap");
  const results = par.messages[2].content;
  assert.deepEqual(results.map(r => r.tool_use_id), ["a1", "a2"]);
  assert.deepEqual(results.map(r => r.content), ["report alpha", "report beta"]);

  log.length = 0;
  const seq = createSession({ cwd: process.cwd(), persist: false });
  await runUserTurn({ session: seq, text: "sequential please", ui, client, toolbox, permissions, effort: "low", system: "MAIN" });
  assert.deepEqual(log, ["start alpha", "end alpha", "start beta", "end beta"], "general agents never overlap");
});

test("permission questions from parallel sub-agents are asked one at a time", async () => {
  let open = 0;
  let peak = 0;
  const permissions = fakePermissions({ decide: async () => { open++; peak = Math.max(peak, open); await sleep(15); open--; return { allowed: true }; } });
  const ui = fakeUi();
  const client = fakeClient((request) => {
    if (isSub(request)) {
      const label = /task (\w+)/.exec(request.messages[0].content[0].text)[1];
      return request.messages.length === 1 ? toolReply([{ id: `t_${label}`, name: "Read", input: { path: label } }]) : textReply(`report ${label}`);
    }
    return request.messages.length === 1
      ? toolReply([{ id: "a1", name: "Agent", input: { description: "A", prompt: "task alpha" } }, { id: "a2", name: "Agent", input: { description: "B", prompt: "task beta" } }, { id: "a3", name: "Agent", input: { description: "C", prompt: "task gamma" } }])
      : textReply("done");
  });
  const agent = createAgentTool({ client, ui, permissions, getEffort: () => "low", lang: "en" });
  const toolbox = fakeToolbox([...buildTools(), agent]);
  const session = createSession({ cwd: process.cwd(), persist: false });
  await runUserTurn({ session, text: "go", ui, client, toolbox, permissions, effort: "low", system: "MAIN" });
  assert.equal(peak, 1);
  assert.ok(permissions.checks.filter(c => c.depth === 1).length >= 3);
  assert.equal(session.messages[2].content.length, 3);
});

test("narrowToolbox keeps the shell hint and works with a function or a late-bound toolbox", async () => {
  const base = fakeToolbox(buildTools());
  base.shell = "PowerShell";
  const narrow = narrowToolbox(base, "explore");
  assert.equal(narrow.shell, "PowerShell");
  assert.equal(narrow.has("Edit"), false);
  assert.equal(narrow.has("Read"), true);
  assert.deepEqual(narrow.definitions().map(d => d.name).sort(), ["Glob", "Grep", "Read"]);
  assert.equal(narrow.byName.get("Read"), base.byName.get("Read"));

  const client = fakeClient([textReply("ok")]);
  const lateBound = createAgentTool({ client, ui: fakeUi(), permissions: fakePermissions(), toolbox: () => base, getEffort: () => "low", lang: "en" });
  const result = await lateBound.run({ description: "x", prompt: "y" }, { cwd: process.cwd(), signal: new AbortController().signal, depth: 0, progress() {} });
  assert.equal(result.ok, true);
  assert.match(client.requests[0].system[0].text, /Shell: PowerShell\./);
});
