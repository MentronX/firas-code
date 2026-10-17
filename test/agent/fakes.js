// Test doubles for the agent core: a scripted service client, a recording UI, tools, a toolbox and a permission
// engine. They follow the shapes of the real modules, which can replace them later.
import assert from "node:assert/strict";

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
});

export function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

// --- normalized stream events --------------------------------------------------------------

const usageOf = (usage = {}) => ({ input_tokens: usage.input ?? 100, output_tokens: usage.output ?? 20 });

export function textReply(text, { stop = "end_turn", thinking, usage } = {}) {
  const events = [{ type: "message_start", usage: { input_tokens: usage?.input ?? 100, output_tokens: 1 } }];
  let index = 0;
  if (thinking) {
    events.push({ type: "block_start", index, block: { type: "thinking" } });
    events.push({ type: "thinking_delta", index, text: thinking });
    events.push({ type: "block_stop", index });
    index++;
  }
  if (text !== undefined && text !== "") {
    events.push({ type: "block_start", index, block: { type: "text" } });
    const mid = Math.ceil(text.length / 2);
    events.push({ type: "text_delta", index, text: text.slice(0, mid) });
    events.push({ type: "text_delta", index, text: text.slice(mid) });
    events.push({ type: "block_stop", index });
  }
  events.push({ type: "message_delta", stopReason: stop, usage: usageOf(usage) });
  events.push({ type: "message_stop" });
  return events;
}

export function toolReply(calls, { text, thinking, stop = "tool_use", usage, rawJson } = {}) {
  const events = [{ type: "message_start", usage: { input_tokens: usage?.input ?? 100, output_tokens: 1 } }];
  let index = 0;
  if (thinking) {
    events.push({ type: "block_start", index, block: { type: "thinking" } });
    events.push({ type: "thinking_delta", index, text: thinking });
    events.push({ type: "block_stop", index });
    index++;
  }
  if (text) {
    events.push({ type: "block_start", index, block: { type: "text" } });
    events.push({ type: "text_delta", index, text });
    events.push({ type: "block_stop", index });
    index++;
  }
  calls.forEach((call, n) => {
    events.push({ type: "block_start", index, block: { type: "tool_use", id: call.id ?? `call_${index}_${n}`, name: call.name } });
    const json = call.rawJson ?? rawJson ?? JSON.stringify(call.input ?? {});
    // The service may deliver the JSON whole or in fragments: split it to exercise the joiner.
    const cut = Math.floor(json.length / 2);
    if (json.length > 1) {
      events.push({ type: "tool_json_delta", index, json: json.slice(0, cut) });
      events.push({ type: "tool_json_delta", index, json: json.slice(cut) });
    } else if (json) events.push({ type: "tool_json_delta", index, json });
    if (call.noStop !== true) events.push({ type: "block_stop", index });
    index++;
  });
  events.push({ type: "message_delta", stopReason: stop, usage: usageOf(usage) });
  events.push({ type: "message_stop" });
  return events;
}

export function emptyReply({ stop = "end_turn" } = {}) {
  return [
    { type: "message_start", usage: { input_tokens: 50, output_tokens: 0 } },
    { type: "message_delta", stopReason: stop, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ];
}

/**
 * A client whose stream() plays a script. An entry is an events array, `{ events, delayMs, hangAfter, throwAfter }`
 * or a function (request, n) returning either. `hangAfter: k` plays k events and then waits for the abort signal.
 */
export function fakeClient(script) {
  const requests = [];
  let n = 0;
  const client = {
    requests,
    get calls() { return requests.length; },
    async *stream(request, { signal } = {}) {
      requests.push(JSON.parse(JSON.stringify(request)));
      const raw = typeof script === "function" ? script(request, n) : script[n];
      n++;
      if (raw === undefined) throw new Error(`fake client: no scripted reply for request ${n}`);
      const entry = Array.isArray(raw) ? { events: raw } : raw;
      if (signal?.aborted) throw abortError();
      let played = 0;
      for (const event of entry.events) {
        if (entry.hangAfter !== undefined && played >= entry.hangAfter) {
          await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(abortError()), { once: true }));
        }
        if (entry.delayMs) await sleep(entry.delayMs, signal);
        if (signal?.aborted) throw abortError();
        yield event;
        played++;
      }
      if (entry.hangAfter !== undefined && played >= entry.hangAfter) {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(abortError()), { once: true }));
      }
      if (entry.throwAfter) throw entry.throwAfter;
    },
  };
  return client;
}

// --- UI -------------------------------------------------------------------------------------------------------

export function fakeUi({ onCall } = {}) {
  const calls = [];
  const target = {
    calls,
    names: () => calls.map(c => c.name),
    of: name => calls.filter(c => c.name === name).map(c => c.args),
    text: () => calls.filter(c => c.name === "textDelta").map(c => c.args[0]).join(""),
    notices: () => calls.filter(c => c.name === "notice").map(c => ({ level: c.args[0], text: c.args[1] })),
  };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key === "symbol" || key === "then") return undefined;
      return (...args) => {
        calls.push({ name: key, args });
        onCall?.(key, args);
        return undefined;
      };
    },
  });
}

// --- tools ----------------------------------------------------------------------------------------------------

export function fakeTool(name, opts = {}) {
  return {
    name,
    description: opts.description ?? `${name} tool`,
    input_schema: opts.schema ?? { type: "object", properties: { path: { type: "string" } }, required: [] },
    readOnly: opts.readOnly ?? false,
    concurrencySafe: opts.concurrencySafe ?? false,
    summarize: opts.summarize ?? (input => String(input?.path ?? name)),
    ...(opts.validate ? { validate: opts.validate } : {}),
    ...(opts.isParallel ? { isParallel: opts.isParallel } : {}),
    permission: opts.permission ?? (() => ({ decision: "allow", risk: "low", title: name })),
    run: opts.run ?? (async input => ({ ok: true, content: `${name} ok ${JSON.stringify(input)}` })),
  };
}

export function fakeToolbox(tools) {
  return {
    tools,
    byName: new Map(tools.map(tool => [tool.name, tool])),
    has: name => tools.some(tool => tool.name === name),
    definitions: () => tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
  };
}

export function fakePermissions({ decide, mode = "default" } = {}) {
  const engine = {
    mode,
    checks: [],
    async check(tool, input, ctx) {
      engine.checks.push({ name: tool.name, input, depth: ctx?.depth });
      return decide ? decide(tool, input, ctx) : { allowed: true };
    },
  };
  return engine;
}

// --- assertions -----------------------------------------------------------------------------------------------

/** Roles alternate from user, every tool_use is answered by the next user message, no orphan tool_result. */
export function assertValidHistory(messages) {
  assert.ok(messages.length > 0, "history is empty");
  messages.forEach((m, i) => {
    assert.equal(m.role, i % 2 === 0 ? "user" : "assistant", `role at ${i} is ${m.role}`);
    assert.ok(Array.isArray(m.content) && m.content.length > 0, `message ${i} has no content`);
    if (m.role === "user") {
      const results = m.content.filter(b => b.type === "tool_result");
      const prev = messages[i - 1];
      const uses = prev ? prev.content.filter(b => b.type === "tool_use").map(b => b.id) : [];
      assert.deepEqual(results.map(b => b.tool_use_id).sort(), uses.slice().sort(), `tool results at ${i} do not match the tool calls before them`);
    }
    if (m.role === "assistant") {
      const uses = m.content.filter(b => b.type === "tool_use");
      if (uses.length) {
        const next = messages[i + 1];
        assert.ok(next, `tool_use at ${i} has no following user message`);
        const answered = next.content.filter(b => b.type === "tool_result").map(b => b.tool_use_id);
        for (const u of uses) assert.ok(answered.includes(u.id), `tool_use ${u.id} unanswered`);
      }
      for (const b of m.content) {
        assert.ok(["text", "thinking", "tool_use"].includes(b.type), `unexpected block ${b.type}`);
        if (b.type === "text") assert.ok(b.text.trim(), "empty text block");
        if (b.type === "tool_use") assert.ok(!("inputError" in b), "inputError leaked into history");
      }
    }
  });
  assert.equal(messages[0].role, "user");
}

export function textOfMessage(m) {
  return m.content.filter(b => b.type === "text").map(b => b.text).join("");
}
