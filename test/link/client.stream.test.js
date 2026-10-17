import test from "node:test";
import assert from "node:assert/strict";
import { textReply, toolReply, midStreamError } from "../helpers/mock-service.js";
import { FirasLinkError } from "../../src/link/errors.js";
import { ROUTE_PREFIX } from "../../src/brand.js";
import { CODE, REQUEST, run, runToError, setup } from "./util.js";

const ROUTE = ROUTE_PREFIX;
const types = events => events.map(event => event.type);

test("a text answer round-trips as normalized events", async () => {
  const { service, client } = await setup([textReply("Hello there, friend.", { usage: { input: 321, output: 9 } })]);
  try {
    const { events, acc } = await run(client);
    assert.deepEqual(types(events).slice(0, 3), ["message_start", "block_start", "text_delta"]);
    assert.equal(events.at(-1).type, "message_stop");
    assert.equal(events.at(-2).type, "message_delta");
    assert.ok(!types(events).includes("ping"), "pings are swallowed");
    assert.deepEqual(events[0].usage, { inputTokens: 321, outputTokens: 1 });
    assert.deepEqual(events.at(-2), { type: "message_delta", stopReason: "end_turn", usage: events.at(-2).usage });
    assert.deepEqual(acc.message(), { role: "assistant", content: [{ type: "text", text: "Hello there, friend." }] });
    assert.equal(acc.stopReason, "end_turn");
    assert.deepEqual(acc.usage, { inputTokens: 321, outputTokens: 9 });
    assert.equal(service.requests.length, 1);
  } finally { await service.close(); }
});

test("the request carries the documented headers and body", async () => {
  const { service, client } = await setup([textReply("ok")]);
  try {
    await run(client, { ...REQUEST, thinking: { type: "adaptive" }, output_config: { effort: "high" }, stream: false });
    const [request] = service.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.path, ROUTE + "/v1/messages");
    assert.equal(request.headers.authorization, "Bearer " + CODE);
    assert.equal(request.headers["x-firas-client"], "cli");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.accept, "text/event-stream");
    assert.match(request.headers["user-agent"], /^firas-code\/1\.2\.3 \((win32|linux|darwin|[a-z0-9]+); node \d+\.\d+\.\d+\)$/);
    assert.equal(request.body.model, "firas-code-2");
    assert.equal(request.body.stream, true, "stream is forced on");
    assert.equal(request.body.max_tokens, 1000);
    assert.deepEqual(request.body.thinking, { type: "adaptive" });
    assert.deepEqual(request.body.output_config, { effort: "high" });
    assert.deepEqual(request.body.messages, REQUEST.messages);
    assert.equal(REQUEST.stream, undefined, "the caller's request object is not modified");
  } finally { await service.close(); }
});

test("thinking then text", async () => {
  const { service, client } = await setup([textReply("The answer is 42.", { thinking: "Let me work it out step by step." })]);
  try {
    const { events, acc } = await run(client);
    const kinds = events.filter(event => event.type === "block_start").map(event => event.block.type);
    assert.deepEqual(kinds, ["thinking", "text"]);
    assert.ok(types(events).includes("thinking_delta"));
    assert.equal(acc.thinkingText, "Let me work it out step by step.");
    assert.equal(acc.message().content.length, 2);
    assert.equal(acc.message().content[1].text, "The answer is 42.");
  } finally { await service.close(); }
});

test("a tool call whose JSON arrives in fragments is rebuilt exactly", async () => {
  const input = { path: "src/دليل/ملف.js", old_string: "a\n\"quoted\"\tb", new_string: "مرحباً 🌍", replace_all: true };
  const { service, client } = await setup([
    toolReply([{ name: "Edit", input, id: "call_A" }, { name: "Read", input: { path: "x" }, id: "call_B" }], { text: "Editing now.", thinking: "plan", fragments: 7, chunk: 3 }),
  ]);
  try {
    const { events, acc } = await run(client);
    const jsonDeltas = events.filter(event => event.type === "tool_json_delta" && event.index === 2);
    assert.ok(jsonDeltas.length >= 5, "the JSON really was fragmented: " + jsonDeltas.length);
    assert.ok(jsonDeltas.every(event => event.json.length > 0), "empty fragments are not forwarded");
    assert.equal(acc.stopReason, "tool_use");
    assert.equal(acc.hasToolUse, true);
    assert.deepEqual(acc.message().content, [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Editing now." },
      { type: "tool_use", id: "call_A", name: "Edit", input },
      { type: "tool_use", id: "call_B", name: "Read", input: { path: "x" } },
    ]);
    const start = events.find(event => event.type === "block_start" && event.block.type === "tool_use");
    assert.deepEqual(start.block, { type: "tool_use", id: "call_A", name: "Edit" });
  } finally { await service.close(); }
});

test("JSON delivered whole in one delta, and an empty input, both work", async () => {
  const { service, client } = await setup([
    toolReply([{ name: "LS", input: { path: "." }, id: "t1" }], { fragments: 1 }),
    toolReply([{ name: "TodoWrite", input: {}, id: "t2" }], { fragments: 3 }),
    toolReply([{ name: "Bash", input: "", id: "t3" }], { fragments: 1 }),
  ]);
  try {
    assert.deepEqual((await run(client)).acc.message().content[0].input, { path: "." });
    assert.deepEqual((await run(client)).acc.message().content[0].input, {});
    assert.deepEqual((await run(client)).acc.message().content[0].input, {});
  } finally { await service.close(); }
});

test("broken tool JSON surfaces as inputError, not as a transport failure", async () => {
  const { service, client } = await setup([toolReply([{ name: "Write", input: '{"path": "a.js", "content": "never ends', id: "bad" }], { fragments: 4 })]);
  try {
    const { acc } = await run(client);
    const [block] = acc.message().content;
    assert.equal(block.name, "Write");
    assert.deepEqual(block.input, {});
    assert.match(block.inputError, /^invalid JSON/);
  } finally { await service.close(); }
});

test("Arabic text survives a stream chopped into single bytes", async () => {
  const text = "الحمد لله رب العالمين. ثم قم بتشغيل npm test 🌍 وارجع إليّ بالنتيجة";
  const thinking = "أفكّر في الأمر: هل الملف موجود؟";
  const { service, client } = await setup([
    textReply(text, { thinking, chunk: 5, ping: true }),
    toolReply([{ name: "Write", input: { path: "ملف.txt", content: text }, id: "t" }], { text, fragments: 6, chunk: 4 }),
  ], { });
  service.script[0].splitBytes = 1;
  service.script[1].splitBytes = [1, 2, 3];
  try {
    const first = await run(client);
    assert.deepEqual(first.acc.message().content, [{ type: "thinking", thinking }, { type: "text", text }]);
    const second = await run(client);
    assert.deepEqual(second.acc.message().content, [
      { type: "text", text },
      { type: "tool_use", id: "t", name: "Write", input: { path: "ملف.txt", content: text } },
    ]);
  } finally { await service.close(); }
});

test("a stream with CRLF line ends, and one with no event: lines, both read correctly", async () => {
  const { service, client } = await setup([textReply("crlf stream"), textReply("bare data stream")]);
  service.script[0].eol = "\r\n";
  service.script[1].omitEventLine = true;
  try {
    assert.equal((await run(client)).acc.text, "crlf stream");
    assert.equal((await run(client)).acc.text, "bare data stream");
  } finally { await service.close(); }
});

test("comments, unknown events and signature deltas are ignored", async () => {
  const base = textReply("clean").events;
  const noisy = [
    { comment: "keep-alive" },
    base[0],
    { event: "future_event", data: { type: "future_event", x: 1 } },
    ...base.slice(1, 3),
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } } },
    ...base.slice(3),
  ];
  const { service, client } = await setup([{ events: noisy }]);
  try {
    const { events, acc } = await run(client);
    assert.equal(acc.text, "clean");
    assert.deepEqual(new Set(types(events)), new Set(["message_start", "block_start", "text_delta", "block_stop", "message_delta", "message_stop"]));
  } finally { await service.close(); }
});

test("a text block that starts with text, and a tool block that starts with its input, are completed", async () => {
  const { service, client } = await setup([{
    events: [
      { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "head " } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tail" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Read", input: { path: "whole" } } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ],
  }]);
  try {
    const { acc } = await run(client);
    assert.deepEqual(acc.message().content, [{ type: "text", text: "head tail" }, { type: "tool_use", id: "t", name: "Read", input: { path: "whole" } }]);
    assert.deepEqual(acc.usage, { inputTokens: 5, outputTokens: 3 });
  } finally { await service.close(); }
});

test("a stream that closes after message_delta but before message_stop still completes", async () => {
  const events = textReply("nearly").events.slice(0, -1);
  const { service, client } = await setup([{ events }]);
  try {
    const { events: got, acc } = await run(client);
    assert.equal(got.at(-1).type, "message_stop");
    assert.equal(acc.text, "nearly");
    assert.equal(acc.stopReason, "end_turn");
    assert.equal(service.requests.length, 1);
  } finally { await service.close(); }
});

test("the connection is released as soon as message_stop arrives", async () => {
  const { service, client } = await setup([{ ...textReply("done"), hang: true }]);
  try {
    const { acc } = await run(client);
    assert.equal(acc.text, "done");
    // `hang` keeps the server side open forever: finishing at all proves the client did not wait for the close.
  } finally { await service.close(); }
});

test("a plain JSON answer (no stream) is replayed as events", async () => {
  const { service, client } = await setup([{
    json: {
      type: "message", role: "assistant", stop_reason: "tool_use", usage: { input_tokens: 11, output_tokens: 4 },
      content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "Read", input: { path: "a" } }],
    },
  }]);
  try {
    const { events, acc } = await run(client);
    assert.equal(events[0].type, "message_start");
    assert.equal(events.at(-1).type, "message_stop");
    assert.deepEqual(acc.message().content, [
      { type: "thinking", thinking: "hm" }, { type: "text", text: "hi" }, { type: "tool_use", id: "t", name: "Read", input: { path: "a" } },
    ]);
    assert.equal(acc.stopReason, "tool_use");
    assert.deepEqual(acc.usage, { inputTokens: 11, outputTokens: 4 });
  } finally { await service.close(); }
});

test("a 200 JSON error object is an error, not an answer", async () => {
  const { service, client } = await setup([{ json: { type: "error", error: { type: "overloaded_error", message: "English words" } } }, textReply("second")]);
  try {
    const { events, acc } = await run(client);
    assert.equal(acc.text, "second", "the busy error was retried");
    assert.equal(types(events).filter(type => type === "message_start").length, 1);
  } finally { await service.close(); }
});

test("a body that is neither a stream nor a message is a bad_response", async () => {
  const { service, client } = await setup([{ body: "not json" }, { body: "not json" }, { body: "not json" }, { body: "not json" }, { body: "not json" }]);
  try {
    const { error } = await runToError(client);
    assert.ok(error instanceof FirasLinkError);
    assert.equal(error.code, "bad_response");
    assert.equal(service.requests.length, 5);
  } finally { await service.close(); }
});

test("a long answer streams through without loss", async () => {
  const text = "كلمة ".repeat(4000) + "end";
  const { service, client } = await setup([textReply(text, { chunk: 3 })]);
  try {
    const started = Date.now();
    const { events, acc } = await run(client);
    assert.ok(events.length > 6000, String(events.length));
    assert.equal(acc.text, text);
    assert.ok(Date.now() - started < 8000, "took " + (Date.now() - started) + " ms");
  } finally { await service.close(); }
});

test("parallel streams on one client do not mix", async () => {
  const { service, client } = await setup([textReply("one"), textReply("two"), textReply("three")]);
  try {
    const results = await Promise.all([run(client), run(client), run(client)]);
    assert.deepEqual(results.map(result => result.acc.text).sort(), ["one", "three", "two"]);
  } finally { await service.close(); }
});

test("a mid-stream error event after content throws a FirasLinkError and is not retried", async () => {
  const { service, client } = await setup([midStreamError("The beginning of an answer", { type: "overloaded_error", message: "English only words" }), textReply("never used")]);
  try {
    const { error, events } = await runToError(client);
    assert.ok(error instanceof FirasLinkError);
    assert.equal(error.code, "busy");
    assert.equal(error.retryable, true);
    assert.ok(!error.userMessage.includes("English only words"));
    assert.equal(service.requests.length, 1, "no retry once content has been delivered");
    assert.ok(events.some(event => event.type === "text_delta"), "the caller saw what arrived before the failure");
  } finally { await service.close(); }
});

test("an error right after message_start is retried, and the caller sees one clean message", async () => {
  const { service, client, sleeps } = await setup([midStreamError("", { withText: false }), textReply("recovered")]);
  try {
    const { events, acc } = await run(client);
    assert.equal(acc.text, "recovered");
    assert.equal(types(events).filter(type => type === "message_start").length, 1);
    assert.deepEqual(sleeps, [800]);
    assert.equal(service.requests.length, 2);
  } finally { await service.close(); }
});

test("a mid-stream error with an unknown type is a generic, non-retryable failure", async () => {
  const { service, client } = await setup([midStreamError("some text", { type: "mystery_error" })]);
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "stream_error");
    assert.equal(error.retryable, false);
    assert.match(error.userMessage, /couldn't be completed/);
  } finally { await service.close(); }
});

test("a connection cut after content throws stream_broken without retrying", async () => {
  const entry = { ...textReply("a long answer that never finishes", { chunk: 4 }) };
  entry.cutAfter = 6;
  const { service, client } = await setup([entry, textReply("not used")]);
  try {
    const { error, events } = await runToError(client);
    assert.ok(error instanceof FirasLinkError);
    assert.ok(["stream_broken", "network_reset"].includes(error.code), error.code);
    assert.equal(error.retryable, true);
    assert.equal(service.requests.length, 1);
    assert.ok(events.length >= 3);
  } finally { await service.close(); }
});

test("a connection cut before any content is retried silently", async () => {
  const cut = { ...textReply("x"), cutAfter: 1 };
  const { service, client, sleeps } = await setup([cut, textReply("second try")]);
  try {
    const { events, acc } = await run(client);
    assert.equal(acc.text, "second try");
    assert.equal(types(events).filter(type => type === "message_start").length, 1);
    assert.deepEqual(sleeps, [800]);
  } finally { await service.close(); }
});

test("an empty 200 stream is retried, then reported as stream_broken", async () => {
  const empty = () => ({ events: [] });
  const { service, client } = await setup([empty(), empty(), empty(), empty(), empty()]);
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "stream_broken");
    assert.equal(service.requests.length, 5);
  } finally { await service.close(); }
});

test("the idle timeout ends a stream that goes silent", async () => {
  const { service, client } = await setup([{ ...textReply("part"), events: textReply("part").events.slice(0, 5), hang: true }], { client: { timeouts: { idleMs: 120 } } });
  try {
    const { error, events } = await runToError(client);
    assert.equal(error.code, "stream_idle");
    assert.equal(error.retryable, true);
    assert.equal(service.requests.length, 1, "content had been delivered, so no retry");
    assert.ok(events.length >= 2);
  } finally { await service.close(); }
});
