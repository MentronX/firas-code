import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runUserTurn, requestShape, checkInput, MAX_STEPS, MAX_RESULT_CHARS } from "../../src/agent/loop.js";
import { FirasLinkError } from "../../src/link/errors.js";
import { createSession } from "../../src/agent/session.js";
import { t, setLang } from "../../src/i18n/index.js";
import {
  abortError, assertValidHistory, emptyReply, fakeClient, fakePermissions, fakeTool, fakeToolbox, fakeUi,
  sleep, textOfMessage, textReply, toolReply,
} from "./fakes.js";

setLang("en");

const readSchema = { type: "object", properties: { path: { type: "string" }, ms: { type: "number" } }, required: ["path"] };
const readTool = (extra = {}) => fakeTool("Read", { readOnly: true, concurrencySafe: true, schema: readSchema, ...extra });

function setup({ tools, script, decide, mode, ui } = {}) {
  return {
    session: createSession({ cwd: process.cwd(), persist: false }),
    ui: ui ?? fakeUi(),
    client: fakeClient(script ?? []),
    toolbox: fakeToolbox(tools ?? [readTool()]),
    permissions: fakePermissions({ decide, mode }),
  };
}

function run(env, text = "hello", extra = {}) {
  return runUserTurn({
    session: env.session, text, ui: env.ui, client: env.client, toolbox: env.toolbox, permissions: env.permissions,
    effort: "medium", lang: "en", system: "SYSTEM PROMPT", ...extra,
  });
}

function assertSubsequence(actual, expected) {
  let at = 0;
  for (const name of actual) if (name === expected[at]) at++;
  assert.equal(at, expected.length, `expected ${expected.join(" > ")} within ${actual.join(" > ")}`);
}

const toolResults = message => message.content.filter(b => b.type === "tool_result");

test("a full multi-step turn: text, tool_use, tool_result, final text", async () => {
  const env = setup({
    script: [
      toolReply([{ id: "call_a", name: "Read", input: { path: "src/app.js" } }], { text: "Let me look." }),
      textReply("The file is fine."),
    ],
  });
  const result = await run(env, "check src/app.js");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.steps, 2);

  const msgs = env.session.messages;
  assert.equal(msgs.length, 4);
  assertValidHistory(msgs);
  assert.deepEqual(msgs[1].content.map(b => b.type), ["text", "tool_use"]);
  assert.deepEqual(msgs[1].content[1], { type: "tool_use", id: "call_a", name: "Read", input: { path: "src/app.js" } });
  assert.equal(toolResults(msgs[2])[0].tool_use_id, "call_a");
  assert.match(toolResults(msgs[2])[0].content, /Read ok/);
  assert.equal(textOfMessage(msgs[3]), "The file is fine.");

  // The second request carries the whole exchange so far.
  assert.equal(env.client.requests[1].messages.length, 3);
  assert.equal(env.session.title, "check src/app.js");

  const names = env.ui.names();
  assertSubsequence(names, ["requestStart", "textStart", "textDelta", "textEnd", "requestEnd", "usage", "toolStart", "toolEnd", "requestStart", "textStart", "textDelta", "textEnd", "requestEnd", "usage", "turnEnd"]);
  const [start] = env.ui.of("toolStart");
  assert.deepEqual(start[0], { id: "call_a", name: "Read", summary: "src/app.js", input: { path: "src/app.js" }, readOnly: true });
  const [end] = env.ui.of("toolEnd");
  assert.equal(end[0].ok, true);
  assert.equal(end[0].id, "call_a");
  assert.equal(typeof end[0].ms, "number");
  const [turnEnd] = env.ui.of("turnEnd");
  assert.equal(turnEnd[0].stopReason, "end_turn");
  assert.equal(turnEnd[0].steps, 2);
  assert.equal(env.ui.text(), "Let me look.The file is fine.");
});

test("request fields follow the effort ladder", async () => {
  assert.deepEqual(requestShape("low"), { max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  assert.deepEqual(requestShape("off"), requestShape("low"), "an older 'off' is the bottom of the ladder now");
  assert.equal(requestShape("xhigh").max_tokens, 32000);
  assert.equal(requestShape("max").max_tokens, 32000);
  assert.deepEqual(requestShape("ultracode"), { max_tokens: 32000, thinking: { type: "adaptive" }, output_config: { effort: "max" } }, "ultracode travels as the service's top level");
  assert.equal(requestShape("nonsense").output_config.effort, "medium");

  const on = setup({ script: [textReply("a")] });
  await run(on, "x", { effort: "high" });
  const req = on.client.requests[0];
  assert.equal(req.model, "firas-code-2");
  assert.equal(req.stream, true);
  assert.deepEqual(req.system, [{ type: "text", text: "SYSTEM PROMPT" }]);
  assert.equal(req.tools[0].name, "Read");
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.deepEqual(req.output_config, { effort: "high" });
  assert.equal(req.max_tokens, 16000);

  const low = setup({ script: [textReply("a")] });
  await run(low, "x", { effort: "low" });
  assert.deepEqual(low.client.requests[0].output_config, { effort: "low" });
  assert.deepEqual(low.client.requests[0].system, [{ type: "text", text: "SYSTEM PROMPT" }], "no ultracode text below the top level");

  const big = setup({ script: [textReply("a")] });
  await run(big, "x", { effort: "max" });
  assert.equal(big.client.requests[0].max_tokens, 32000);
});

test("an ultracode turn adds its way of working to the prompt and gets a larger step budget", async () => {
  const env = setup({ script: [textReply("done")] });
  await run(env, "x", { effort: "ultracode" });
  const req = env.client.requests[0];
  assert.deepEqual(req.output_config, { effort: "max" });
  const system = req.system[0].text;
  assert.ok(system.startsWith("SYSTEM PROMPT\n\n# Ultracode"), system.slice(0, 80));
  assert.match(system, /Agent sub-agents in ONE message/);
  assert.match(system, /TodoWrite/);

  // A function prompt (the real one follows mid-turn changes) keeps working, with the note after it.
  const fn = setup({ script: [textReply("ok")] });
  await run(fn, "x", { effort: "ultracode", system: () => "LIVE" });
  assert.ok(fn.client.requests[0].system[0].text.startsWith("LIVE\n\n# Ultracode"));

  // 100 steps end an ordinary turn; an ultracode turn goes on.
  const loopScript = n => Array.from({ length: n }, (_, i) => toolReply([{ id: `c${i}`, name: "Read", input: { path: `f${i}` } }]));
  const plain = setup({ script: [...loopScript(MAX_STEPS + 5), textReply("end")] });
  assert.equal((await run(plain, "x", { effort: "max" })).stopReason, "max_steps");
  const ultra = setup({ script: [...loopScript(MAX_STEPS + 5), textReply("end")] });
  const r = await run(ultra, "x", { effort: "ultracode" });
  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.steps, MAX_STEPS + 6);
});

test("read-only tools run in parallel, others one at a time, results keep the original order", async () => {
  const log = [];
  const read = readTool({
    run: async input => { log.push(`start ${input.path}`); await sleep(input.ms); log.push(`end ${input.path}`); return { ok: true, content: `content of ${input.path}` }; },
  });
  const write = fakeTool("Write", { run: async input => { log.push(`start ${input.path}`); await sleep(5); log.push(`end ${input.path}`); return { ok: true, content: "written" }; } });
  const env = setup({
    tools: [read, write],
    script: [
      toolReply([
        { id: "t1", name: "Read", input: { path: "a", ms: 60 } },
        { id: "t2", name: "Read", input: { path: "b", ms: 10 } },
        { id: "t3", name: "Write", input: { path: "w" } },
        { id: "t4", name: "Read", input: { path: "c", ms: 5 } },
      ]),
      textReply("done"),
    ],
  });
  await run(env);
  assert.deepEqual(log.slice(0, 2).sort(), ["start a", "start b"], "both reads start before either finishes");
  assert.ok(log.indexOf("end b") < log.indexOf("end a"));
  assert.ok(log.indexOf("start w") > log.indexOf("end a"), "the write waits for the parallel group");
  assert.ok(log.indexOf("start c") > log.indexOf("end w"), "the read after the write waits for it");

  const results = toolResults(env.session.messages[2]);
  assert.deepEqual(results.map(r => r.tool_use_id), ["t1", "t2", "t3", "t4"]);
  assert.equal(results[0].content, "content of a");
  const ended = env.ui.of("toolEnd").map(a => a[0].id);
  assert.ok(ended.indexOf("t2") < ended.indexOf("t1"), "cards finish in completion order");
});

test("a denied permission becomes an error result carrying the user's feedback", async () => {
  let ran = false;
  const edit = fakeTool("Edit", { run: async () => { ran = true; return { ok: true, content: "edited" }; } });
  const env = setup({
    tools: [edit],
    script: [toolReply([{ id: "e1", name: "Edit", input: { path: "x.js" } }]), textReply("understood")],
    decide: () => ({ allowed: false, feedback: "use the other file" }),
  });
  const result = await run(env);
  assert.equal(ran, false);
  assert.equal(result.stopReason, "end_turn");
  const [res] = toolResults(env.session.messages[2]);
  assert.equal(res.is_error, true);
  assert.match(res.content, /Permission denied for Edit/);
  assert.match(res.content, /use the other file/);
  assert.match(res.content, /Do not retry/);
  const [end] = env.ui.of("toolEnd");
  assert.equal(end[0].ok, false);
  assert.match(end[0].summary, /use the other file/);
  assert.equal(env.permissions.checks.length, 1);
  assert.equal(env.permissions.checks[0].name, "Edit");
});

test("a denial without feedback and a permission engine that throws", async () => {
  const edit = fakeTool("Edit");
  const env = setup({
    tools: [edit],
    script: [toolReply([{ id: "e1", name: "Edit", input: {} }, { id: "e2", name: "Edit", input: {} }]), textReply("ok")],
    decide: (tool, input, ctx) => { throw new Error("engine broke"); },
  });
  await run(env);
  const results = toolResults(env.session.messages[2]);
  assert.equal(results.length, 2);
  assert.match(results[0].content, /permission check failed \(engine broke\)/);

  const plain = setup({ tools: [edit], script: [toolReply([{ id: "e1", name: "Edit", input: {} }]), textReply("ok")], decide: () => ({ allowed: false }) });
  await run(plain);
  assert.match(toolResults(plain.session.messages[2])[0].content, /The user declined/);
});

test("a failing tool is reported to the model and never crashes the loop", async () => {
  const boom = fakeTool("Boom", { run: async () => { throw new Error("disk exploded"); } });
  const soft = fakeTool("Soft", { run: async () => ({ ok: false, content: "exit code 2\nsomething failed", display: { summary: "exit 2" } }) });
  const env = setup({
    tools: [boom, soft],
    script: [toolReply([{ id: "b1", name: "Boom", input: {} }, { id: "s1", name: "Soft", input: {} }]), textReply("handled")],
  });
  const result = await run(env);
  assert.equal(result.stopReason, "end_turn");
  const [a, b] = toolResults(env.session.messages[2]);
  assert.equal(a.is_error, true);
  assert.match(a.content, /Tool "Boom" failed: disk exploded/);
  assert.equal(b.is_error, true);
  assert.match(b.content, /exit code 2/);
  const ends = env.ui.of("toolEnd").map(x => x[0]);
  assert.equal(ends.find(e => e.id === "s1").summary, "exit 2");
  assert.equal(ends.find(e => e.id === "b1").ok, false);
  assertValidHistory(env.session.messages);
});

test("bad tool JSON is reported so the model can retry, and never reaches the stored history", async () => {
  const env = setup({
    script: [
      toolReply([{ id: "j1", name: "Read", rawJson: '{"path": "a.t' }]),
      toolReply([{ id: "j2", name: "Read", input: { path: "a.txt" } }]),
      textReply("fixed"),
    ],
  });
  const result = await run(env);
  assert.equal(result.stopReason, "end_turn");
  const [first] = toolResults(env.session.messages[2]);
  assert.equal(first.is_error, true);
  assert.match(first.content, /could not be read: invalid JSON/);
  assert.match(first.content, /valid JSON object/);
  assert.deepEqual(env.session.messages[1].content[0].input, {});
  assert.ok(!("inputError" in env.session.messages[1].content[0]));
  assert.match(toolResults(env.session.messages[4])[0].content, /Read ok/);
  assertValidHistory(env.session.messages);
});

test("unknown tools list the valid names, with a hint for case mistakes", async () => {
  const env = setup({
    tools: [readTool(), fakeTool("Write")],
    script: [toolReply([{ id: "u1", name: "read", input: { path: "x" } }, { id: "u2", name: "Teleport", input: {} }]), textReply("ok")],
  });
  await run(env);
  const [a, b] = toolResults(env.session.messages[2]);
  assert.match(a.content, /Unknown tool "read"\. Did you mean "Read"\?/);
  assert.match(a.content, /Available tools: Read, Write\./);
  assert.match(b.content, /Unknown tool "Teleport"\. Available tools: Read, Write\./);
  assert.equal(a.is_error, true);
});

test("input is validated against the schema and mild type slips are coerced", async () => {
  assert.deepEqual(checkInput({ n: "5", flag: "true", list: "[1,2]" }, { properties: { n: { type: "integer" }, flag: { type: "boolean" }, list: { type: "array" } } }).input, { n: 5, flag: true, list: [1, 2] });
  assert.match(checkInput({}, { required: ["path"] }).error, /missing required parameter: path/);
  assert.match(checkInput({ mode: "x" }, { properties: { mode: { type: "string", enum: ["a", "b"] } } }).error, /must be one of: a, b/);
  assert.match(checkInput({ n: "abc" }, { properties: { n: { type: "number" } } }).error, /must be number/);
  assert.match(checkInput([], {}).error, /JSON object/);

  let seen;
  const timed = fakeTool("Timed", { schema: { type: "object", properties: { timeout: { type: "integer" }, path: { type: "string" } }, required: ["path"] }, run: async input => { seen = input; return { ok: true, content: "ok" }; } });
  const env = setup({
    tools: [timed],
    script: [toolReply([{ id: "v1", name: "Timed", input: { timeout: "5000" } }, { id: "v2", name: "Timed", input: { path: "p", timeout: "5000" } }]), textReply("ok")],
  });
  await run(env);
  const [missing, fine] = toolResults(env.session.messages[2]);
  assert.match(missing.content, /missing required parameter: path\. Required parameters: path\./);
  assert.equal(fine.is_error, undefined);
  assert.deepEqual(seen, { timeout: 5000, path: "p" });
});

test("a tool's own validate() problem is returned without running the tool", async () => {
  let ran = false;
  const strict = fakeTool("Strict", { validate: () => "path must be inside the project", run: async () => { ran = true; return { ok: true, content: "x" }; } });
  const env = setup({ tools: [strict], script: [toolReply([{ id: "s1", name: "Strict", input: {} }]), textReply("ok")] });
  await run(env);
  assert.equal(ran, false);
  assert.match(toolResults(env.session.messages[2])[0].content, /path must be inside the project/);
});

test("tools get the documented context", async () => {
  let ctx;
  const spy = fakeTool("Spy", { run: async (input, c) => { ctx = c; c.progress("working"); return { ok: true, content: "ok" }; } });
  const env = setup({ tools: [spy], script: [toolReply([{ id: "c1", name: "Spy", input: {} }]), textReply("ok")] });
  const config = { effort: "low" };
  await run(env, "go", { config });
  assert.equal(ctx.cwd, env.session.cwd);
  assert.ok(ctx.signal instanceof AbortSignal);
  assert.equal(ctx.platform, process.platform);
  assert.ok(ctx.fileState instanceof Map);
  assert.equal(ctx.client, env.client);
  assert.equal(ctx.config, config);
  assert.equal(ctx.session, env.session);
  assert.equal(ctx.depth, 0);
  assert.equal(ctx.mode, "default");
  assert.equal(ctx.toolUseId, "c1");
  assert.equal(ctx.toolbox, env.toolbox);
  assert.deepEqual(env.ui.of("toolProgress"), [["c1", "working"]]);
});

test("abort while the answer is streaming keeps what was shown and leaves a valid history", { timeout: 10000 }, async () => {
  const ctl = new AbortController();
  let deltas = 0;
  const ui = fakeUi({ onCall: name => { if (name === "textDelta" && ++deltas === 1) ctl.abort(); } });
  const env = setup({ ui, script: [{ events: textReply("partial answer here"), hangAfter: 4 }] });
  const result = await run(env, "question", { signal: ctl.signal });
  assert.equal(result.stopReason, "aborted");
  assertValidHistory(env.session.messages);
  assert.equal(env.session.messages.length, 2);
  assert.equal(env.session.messages[1].role, "assistant");
  assert.match(textOfMessage(env.session.messages[1]), /^partial/);
  assertSubsequence(env.ui.names(), ["textStart", "textDelta", "textEnd", "notice", "turnEnd"]);
  assert.equal(env.ui.notices().at(-1).text, t("agent.interrupted"));
  assert.equal(env.ui.of("turnEnd")[0][0].stopReason, "aborted");
});

test("abort before any output stops promptly, and the next message folds into the dangling one", { timeout: 10000 }, async () => {
  const ctl = new AbortController();
  const env = setup({ script: [{ events: textReply("never"), hangAfter: 0 }, textReply("second answer")] });
  setTimeout(() => ctl.abort(), 20);
  const first = await run(env, "first", { signal: ctl.signal });
  assert.equal(first.stopReason, "aborted");
  assert.equal(env.session.messages.length, 1);
  assertValidHistory(env.session.messages);

  const second = await run(env, "second");
  assert.equal(second.stopReason, "end_turn");
  assertValidHistory(env.session.messages);
  assert.deepEqual(env.session.messages[0].content.map(b => b.text), ["first", "second"]);
});

test("abort during tools answers every tool_use with a result", { timeout: 10000 }, async () => {
  const ctl = new AbortController();
  const fast = readTool({ run: async () => ({ ok: true, content: "fast result" }) });
  const hangsHonestly = fakeTool("Wait", { readOnly: true, concurrencySafe: true, run: (input, ctx) => new Promise((resolve, reject) => ctx.signal.addEventListener("abort", () => reject(abortError()))) });
  const hangsForever = fakeTool("Stuck", { readOnly: true, concurrencySafe: true, run: () => new Promise(() => {}) });
  const queued = fakeTool("Write", { run: async () => { throw new Error("must never start"); } });
  const env = setup({
    tools: [fast, hangsHonestly, hangsForever, queued],
    script: [toolReply([
      { id: "k1", name: "Read", input: { path: "a" } },
      { id: "k2", name: "Wait", input: {} },
      { id: "k3", name: "Stuck", input: {} },
      { id: "k4", name: "Write", input: { path: "z" } },
    ])],
  });
  setTimeout(() => ctl.abort(), 40);
  const result = await run(env, "go", { signal: ctl.signal });
  assert.equal(result.stopReason, "aborted");
  assertValidHistory(env.session.messages);
  const results = toolResults(env.session.messages[2]);
  assert.deepEqual(results.map(r => r.tool_use_id), ["k1", "k2", "k3", "k4"]);
  assert.equal(results[0].content, "fast result");
  assert.equal(results[0].is_error, undefined);
  for (const r of results.slice(1)) {
    assert.equal(r.is_error, true);
    assert.match(r.content, /interrupted by the user/);
  }
  const startedIds = env.ui.of("toolStart").map(a => a[0].id);
  assert.ok(!startedIds.includes("k4"), "a call that never ran gets no card");
  assert.equal(env.ui.notices().at(-1).text, t("agent.interrupted"));
});

test("abort while a permission prompt is open", { timeout: 10000 }, async () => {
  const ctl = new AbortController();
  const edit = fakeTool("Edit", { run: async () => { throw new Error("must not run"); } });
  const env = setup({
    tools: [edit],
    script: [toolReply([{ id: "p1", name: "Edit", input: {} }])],
    decide: () => new Promise(() => {}),
  });
  setTimeout(() => ctl.abort(), 30);
  const result = await run(env, "go", { signal: ctl.signal });
  assert.equal(result.stopReason, "aborted");
  assertValidHistory(env.session.messages);
  assert.match(toolResults(env.session.messages[2])[0].content, /interrupted/);
});

test("permission prompts of parallel tools are asked one at a time", async () => {
  let open = 0;
  let peak = 0;
  const env = setup({
    script: [toolReply([{ id: "a", name: "Read", input: { path: "1" } }, { id: "b", name: "Read", input: { path: "2" } }, { id: "c", name: "Read", input: { path: "3" } }]), textReply("ok")],
    decide: async () => { open++; peak = Math.max(peak, open); await sleep(10); open--; return { allowed: true }; },
  });
  await run(env);
  assert.equal(env.permissions.checks.length, 3);
  assert.equal(peak, 1);
});

test("max_tokens continues automatically, at most twice", async () => {
  const env = setup({ script: [textReply("part one ", { stop: "max_tokens" }), textReply("part two ", { stop: "max_tokens" }), textReply("part three")] });
  const result = await run(env, "write a lot");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(env.client.calls, 3);
  assertValidHistory(env.session.messages);
  assert.equal(env.session.messages.length, 6);
  assert.match(textOfMessage(env.session.messages[2]), /^Continue exactly/);
  assert.equal(env.ui.notices().filter(n => n.text === t("agent.maxTokens")).length, 2);

  const stubborn = setup({ script: [textReply("a", { stop: "max_tokens" }), textReply("b", { stop: "max_tokens" }), textReply("c", { stop: "max_tokens" }), textReply("never")] });
  const capped = await run(stubborn);
  assert.equal(capped.stopReason, "max_tokens");
  assert.equal(stubborn.client.calls, 3);
  assert.equal(stubborn.ui.notices().at(-1).text, t("agent.maxTokensGiveUp"));
  assertValidHistory(stubborn.session.messages);
});

test("a tool call cut off by the length limit is reported as such", async () => {
  const env = setup({
    script: [toolReply([{ id: "w1", name: "Read", rawJson: '{"path": "' + "x".repeat(50) }], { stop: "max_tokens" }), textReply("ok, smaller")],
  });
  await run(env);
  const [res] = toolResults(env.session.messages[2]);
  assert.equal(res.is_error, true);
  assert.match(res.content, /output length limit/);
  assert.equal(env.client.calls, 2, "no extra continue message is needed");
  assertValidHistory(env.session.messages);
});

test("an empty response is retried once", async () => {
  const env = setup({ script: [emptyReply(), textReply("now I answer")] });
  const result = await run(env);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(env.client.calls, 2);
  assert.equal(env.session.messages.length, 2);

  const hopeless = setup({ script: [emptyReply(), emptyReply(), textReply("never")] });
  const failed = await run(hopeless);
  assert.equal(failed.stopReason, "empty");
  assert.equal(hopeless.client.calls, 2);
  assert.equal(hopeless.ui.notices().at(-1).text, t("agent.emptyResponse"));
  assertValidHistory(hopeless.session.messages);

  const thinkingOnly = setup({ script: [textReply("", { thinking: "hmm" }), textReply("ok")] });
  await run(thinkingOnly);
  assert.equal(thinkingOnly.client.calls, 2);
  assert.ok(thinkingOnly.session.messages.every(m => !m.content.some(b => b.type === "thinking" && m.role === "assistant" && m.content.length === 1)));
});

test("the 100 step ceiling stops a runaway turn with a clear notice and a valid history", async () => {
  const env = setup({ script: (request, n) => (n < 100
    ? toolReply([{ id: `loop_${n}`, name: "Read", input: { path: `f${n}` } }])
    : textReply("Here is where I stopped.")) });
  const result = await run(env, "never ends");
  assert.equal(MAX_STEPS, 100);
  assert.equal(result.stopReason, "max_steps");
  assert.equal(result.steps, 100);
  assert.equal(env.client.calls, 101, "the closing summary request is the 101st call");
  assertValidHistory(env.session.messages);
  assert.equal(env.session.messages.length, 202);
  assert.equal(textOfMessage(env.session.messages.at(-1)), "Here is where I stopped.");
  assert.equal(env.ui.notices().at(-1).text, t("agent.maxSteps", { n: 100 }));
});

test("tool output sent to the model is capped with a visible note", async () => {
  const huge = readTool({ run: async () => ({ ok: true, content: "A".repeat(300000) + "THE END" }) });
  const env = setup({ tools: [huge], script: [toolReply([{ id: "h1", name: "Read", input: { path: "big" } }]), textReply("ok")] });
  await run(env);
  const [res] = toolResults(env.session.messages[2]);
  assert.ok(res.content.length < MAX_RESULT_CHARS + 300);
  assert.ok(res.content.length > MAX_RESULT_CHARS - 300);
  assert.match(res.content, /tool output truncated: \d+ characters omitted/);
  assert.ok(res.content.endsWith("THE END"), "the tail survives");
  assert.equal(typeof res.content, "string");
});

test("thinking stays only inside the current turn's tool loop", async () => {
  const env = setup({
    script: [
      toolReply([{ id: "x1", name: "Read", input: { path: "a" } }], { thinking: "first thought" }),
      textReply("done one", { thinking: "second thought" }),
      textReply("done two"),
    ],
  });
  await run(env, "turn one");
  const inLoop = env.client.requests[1].messages[1];
  assert.equal(inLoop.content[0].type, "thinking");
  assert.equal(inLoop.content[0].thinking, "first thought");
  assert.ok(!("signature" in inLoop.content[0]));

  await run(env, "turn two");
  const later = env.client.requests[2].messages;
  assert.ok(later.every(m => m.content.every(b => b.type !== "thinking")), "finished turns lose their thinking");
  assert.ok(env.session.messages[1].content.some(b => b.type === "thinking"), "the stored history is untouched");
  assertValidHistory(later);
});

test("thinking and text events reach the UI", async () => {
  const env = setup({ script: [textReply("answer", { thinking: "pondering" })] });
  await run(env);
  assertSubsequence(env.ui.names(), ["thinkingStart", "thinkingDelta", "thinkingEnd", "textStart", "textDelta", "textEnd"]);
  const [end] = env.ui.of("thinkingEnd");
  assert.equal(end[0].chars, "pondering".length);
  assert.equal(typeof end[0].ms, "number");
});

test("usage is accounted from the reported counts", async () => {
  const env = setup({ script: [toolReply([{ id: "u", name: "Read", input: { path: "a" } }], { usage: { input: 1000, output: 50 } }), textReply("ok", { usage: { input: 1200, output: 30 } })] });
  const result = await run(env);
  assert.deepEqual(result.usage, { inputTokens: 2200, outputTokens: 80 });
  assert.equal(env.session.usage.inputTokens, 2200);
  assert.equal(env.session.usage.outputTokens, 80);
  assert.equal(env.session.usage.turns, 1);
  const last = env.ui.of("usage").at(-1)[0];
  assert.deepEqual(last, { inputTokens: 2200, outputTokens: 80, contextTokens: 1230 });
});

test("a service error is shown in friendly words and the history stays valid", async () => {
  const err = Object.assign(new Error("raw upstream text"), { code: "busy", userMessage: "The service is busy right now." });
  const env = setup({ script: [{ events: [], throwAfter: err }] });
  const result = await run(env);
  assert.equal(result.stopReason, "error");
  assert.deepEqual(env.ui.notices().at(-1), { level: "error", text: "The service is busy right now." });
  assertValidHistory(env.session.messages);
  assert.ok(!JSON.stringify(env.ui.calls).includes("raw upstream text"));

  const mid = setup({ script: [{ events: textReply("half an answer").slice(0, 4), throwAfter: new Error("socket closed") }] });
  const cut = await run(mid);
  assert.equal(cut.stopReason, "error");
  assert.equal(mid.ui.notices().at(-1).text, t("agent.serviceError"));
  assertValidHistory(mid.session.messages);
  assert.match(textOfMessage(mid.session.messages[1]), /half/);
});

test("a stream that drops before any text is retried automatically", async () => {
  const env = setup({
    script: [
      { events: [
        { type: "block_start", index: 0, block: { type: "thinking" } },
        { type: "thinking_delta", index: 0, text: "thinking..." },
      ], throwAfter: new FirasLinkError("network_reset") },
      textReply("Recovered."),
    ],
  });
  const result = await run(env, "hard task", { retryDelayMs: () => 0 });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(env.client.calls, 2, "the same request is sent again");
  assert.equal(env.session.messages.length, 2);
  assert.equal(textOfMessage(env.session.messages[1]), "Recovered.");
  assert.ok(env.ui.notices().some(n => n.level === "info" && n.text === t("agent.retryingStream")));
});

test("a stream that drops after text is continued instead of ending the turn", async () => {
  const env = setup({
    script: [
      { events: [
        { type: "block_start", index: 0, block: { type: "text" } },
        { type: "text_delta", index: 0, text: "Half an answer" },
      ], throwAfter: new FirasLinkError("network_reset") },
      textReply(" and the rest."),
    ],
  });
  const result = await run(env, "hard task", { retryDelayMs: () => 0 });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(env.client.calls, 2);
  assert.equal(env.session.messages.length, 4, "user, partial answer, continue, final answer");
  assert.match(textOfMessage(env.session.messages[1]), /Half an answer/);
  assert.match(textOfMessage(env.session.messages[3]), /and the rest/);
  assert.ok(env.ui.notices().some(n => n.level === "info" && n.text === t("agent.retryingStream")));
});

test("a UI that throws cannot break the turn", async () => {
  const ui = fakeUi();
  const flaky = new Proxy(ui, { get: (t, k) => (k === "textDelta" || k === "toolEnd" ? () => { throw new Error("render bug"); } : t[k]) });
  const env = setup({ ui: flaky, script: [toolReply([{ id: "r", name: "Read", input: { path: "a" } }]), textReply("fine")] });
  const result = await run(env);
  assert.equal(result.stopReason, "end_turn");
  assertValidHistory(env.session.messages);
});

test("a session that cannot be saved warns once", async () => {
  const env = setup({ script: [toolReply([{ id: "r", name: "Read", input: { path: "a" } }]), textReply("fine")] });
  env.session.save = () => false;
  await run(env);
  assert.equal(env.ui.notices().filter(n => n.text === t("agent.saveFailed")).length, 1);
});

test("a dangling tool_use from an earlier crash is repaired before the next request", async () => {
  const env = setup({ script: [textReply("recovered")] });
  env.session.addUser("old request");
  env.session.messages.push({ role: "assistant", content: [{ type: "tool_use", id: "dangling", name: "Read", input: { path: "a" } }] });
  await run(env, "new request");
  assertValidHistory(env.client.requests[0].messages);
  const results = toolResults(env.client.requests[0].messages[2]);
  assert.equal(results[0].tool_use_id, "dangling");
  assert.equal(results[0].is_error, true);
  assertValidHistory(env.session.messages);
});

test("compaction runs automatically when the context is too big", async () => {
  const env = setup({
    script: (request) => (request.system[0].text.startsWith("You write compact")
      ? textReply("## Goal\nBuild the thing.\n## Files touched\n- src/a.js - added the function that parses input\n## Pending\n- finish tests")
      : textReply("continuing after compaction")),
  });
  const filler = "x".repeat(100000);
  for (let i = 0; i < 4; i++) {
    env.session.addUser(`${filler} user ${i}`);
    env.session.messages.push({ role: "assistant", content: [{ type: "text", text: `${filler} assistant ${i}` }] });
  }
  const before = env.session.messages.length;
  const result = await run(env, "keep going");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(env.client.calls, 2, "one summary request and one real request");
  const real = env.client.requests[1].messages;
  assert.match(textOfMessage(real[0]), /Summary of the earlier conversation/);
  assert.match(textOfMessage(real[0]), /Build the thing/);
  assertValidHistory(real);
  assertValidHistory(env.session.messages);
  assert.ok(env.session.messages.length < before + 2);
  assert.ok(env.ui.notices().some(n => n.text === t("agent.compacting")));
});

test("a too-large request triggers a forced compaction and one retry", async () => {
  const tooLarge = Object.assign(new Error("413"), { code: "request_too_large", userMessage: "Too large." });
  let main = 0;
  const env = setup({
    script: (request) => {
      if (request.system[0].text.startsWith("You write compact")) return textReply("## Goal\nShort summary of the earlier work, long enough to be accepted.");
      return main++ === 0 ? { events: [], throwAfter: tooLarge } : textReply("worked after compaction");
    },
  });
  for (let i = 0; i < 6; i++) {
    env.session.addUser(`question ${i}`);
    env.session.messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
  }
  const result = await run(env, "one more");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(env.client.calls, 3);
  assert.ok(env.ui.notices().some(n => n.text === t("agent.tooLarge")));
  assertValidHistory(env.session.messages);
});

test("the real prompt is built from the working directory, project files and git state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fc2-loop-"));
  const prevHome = process.env.FIRAS_HOME;
  process.env.FIRAS_HOME = path.join(root, "home");
  try {
    fs.writeFileSync(path.join(root, "FIRAS.md"), "Always use tabs for indentation.");
    const session = createSession({ cwd: root, persist: false });
    const env = { session, ui: fakeUi(), client: fakeClient([textReply("hi")]), toolbox: fakeToolbox([readTool()]), permissions: fakePermissions({ mode: "acceptEdits" }) };
    await runUserTurn({ session, text: "hello", ui: env.ui, client: env.client, toolbox: env.toolbox, permissions: env.permissions, effort: "low", lang: "ar" });
    const system = env.client.requests[0].system[0].text;
    assert.match(system, /You are Firas Code 2/);
    assert.ok(system.includes(root));
    assert.match(system, /Always use tabs for indentation\./);
    assert.match(system, /Permission mode: acceptEdits/);
    assert.match(system, /Tools available: Read\./);
    assert.match(system, /use Arabic \(the interface language\)/);
  } finally {
    if (prevHome === undefined) delete process.env.FIRAS_HOME; else process.env.FIRAS_HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a loop bug is reported as a friendly error, not thrown", async () => {
  const env = setup({ script: [textReply("x")] });
  env.toolbox.definitions = () => { throw new Error("toolbox broke"); };
  const result = await run(env);
  assert.equal(result.stopReason, "error");
  assert.equal(env.ui.notices().at(-1).text, t("agent.internalError"));
  assert.equal(env.ui.of("turnEnd").length, 1);
});

test("the system prompt follows the permission mode as it changes during a turn", async () => {
  const env = setup({ mode: "plan" });
  const exitPlan = fakeTool("ExitPlanMode", { run: async () => { env.permissions.mode = "acceptEdits"; return { ok: true, content: "plan approved" }; } });
  env.toolbox = fakeToolbox([exitPlan]);
  env.client = fakeClient([toolReply([{ id: "x1", name: "ExitPlanMode", input: {} }]), textReply("starting")]);
  const result = await runUserTurn({ session: env.session, text: "plan then build", ui: env.ui, client: env.client, toolbox: env.toolbox, permissions: env.permissions, effort: "low", lang: "en" });
  assert.equal(result.stopReason, "end_turn");
  const [first, second] = env.client.requests.map(r => r.system[0].text);
  assert.match(first, /Permission mode: plan\./);
  assert.match(second, /Permission mode: acceptEdits\./);
  assert.ok(!/Permission mode: plan\./.test(second));
});

test("a function can supply the system prompt", async () => {
  const env = setup({ script: [textReply("a")] });
  let calls = 0;
  await run(env, "x", { system: () => `PROMPT ${++calls}` });
  assert.equal(env.client.requests[0].system[0].text, "PROMPT 1");
});

test("an empty message never reaches the service", async () => {
  const env = setup({ script: [textReply("never")] });
  for (const text of ["", "   \n", null]) {
    const result = await run(env, text);
    assert.equal(result.steps, 0);
  }
  assert.equal(env.client.calls, 0);
  assert.equal(env.session.messages.length, 0);
});

test("an internal failure while preparing a tool call still answers the call", async () => {
  const env = setup({ script: [toolReply([{ id: "i1", name: "Read", input: { path: "a" } }, { id: "i2", name: "Read", input: { path: "b" } }]), textReply("recovered")] });
  let broken = true;
  Object.defineProperty(env.permissions, "mode", { get() { if (broken) { broken = false; throw new Error("mode lookup failed"); } return "default"; } });
  const result = await run(env);
  assert.equal(result.stopReason, "end_turn");
  assertValidHistory(env.session.messages);
  const results = toolResults(env.session.messages[2]);
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.is_error && /failed internally: mode lookup failed/.test(r.content)));
});
