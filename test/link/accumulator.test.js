import test from "node:test";
import assert from "node:assert/strict";
import { createAccumulator, mergeUsage, normalizeUsage, wireMessage } from "../../src/link/accumulator.js";

const feed = (events, acc = createAccumulator()) => { for (const event of events) acc.add(event); return acc; };

const start = usage => ({ type: "message_start", usage: usage ?? { input_tokens: 100, output_tokens: 1 } });
const end = (stopReason, usage) => [{ type: "message_delta", stopReason, usage: usage ?? { input_tokens: 100, output_tokens: 42 } }, { type: "message_stop" }];

test("collects text, joining deltas in order", () => {
  const acc = feed([
    start(),
    { type: "block_start", index: 0, block: { type: "text" } },
    { type: "text_delta", index: 0, text: "مرح" },
    { type: "text_delta", index: 0, text: "با " },
    { type: "text_delta", index: 0, text: "world" },
    { type: "block_stop", index: 0 },
    ...end("end_turn"),
  ]);
  assert.deepEqual(acc.message(), { role: "assistant", content: [{ type: "text", text: "مرحبا world" }] });
  assert.equal(acc.stopReason, "end_turn");
  assert.equal(acc.hasToolUse, false);
  assert.equal(acc.text, "مرحبا world");
  assert.equal(acc.finished, true);
});

test("thinking comes first and is exposed as thinkingText", () => {
  const acc = feed([
    start(),
    { type: "block_start", index: 0, block: { type: "thinking" } },
    { type: "thinking_delta", index: 0, text: "Let me " },
    { type: "thinking_delta", index: 0, text: "think." },
    { type: "block_stop", index: 0 },
    { type: "block_start", index: 1, block: { type: "text" } },
    { type: "text_delta", index: 1, text: "Done" },
    { type: "block_stop", index: 1 },
    ...end("end_turn"),
  ]);
  assert.deepEqual(acc.message().content, [{ type: "thinking", thinking: "Let me think." }, { type: "text", text: "Done" }]);
  assert.equal(acc.thinkingText, "Let me think.");
});

test("joins fragmented tool JSON and parses it at block_stop", () => {
  const acc = feed([
    start(),
    { type: "block_start", index: 0, block: { type: "tool_use", id: "call_1", name: "Edit" } },
    { type: "tool_json_delta", index: 0, json: '{"path":"src/' },
    { type: "tool_json_delta", index: 0, json: 'app.js","old_string":"a\\nb",' },
    { type: "tool_json_delta", index: 0, json: '"new_string":"مرحبا","replace_all":false}' },
    { type: "block_stop", index: 0 },
    ...end("tool_use"),
  ]);
  const [block] = acc.message().content;
  assert.deepEqual(block, { type: "tool_use", id: "call_1", name: "Edit", input: { path: "src/app.js", old_string: "a\nb", new_string: "مرحبا", replace_all: false } });
  assert.equal(acc.hasToolUse, true);
  assert.equal(acc.stopReason, "tool_use");
  assert.ok(!("inputError" in block));
});

test("an empty JSON string means {} and no error", () => {
  const acc = feed([
    { type: "block_start", index: 0, block: { type: "tool_use", id: "t", name: "LS" } },
    { type: "tool_json_delta", index: 0, json: "" },
    { type: "block_stop", index: 0 },
  ]);
  assert.deepEqual(acc.message().content[0], { type: "tool_use", id: "t", name: "LS", input: {} });
  const none = feed([{ type: "block_start", index: 0, block: { type: "tool_use", id: "t", name: "LS" } }, { type: "block_stop", index: 0 }]);
  assert.deepEqual(none.message().content[0].input, {});
  assert.ok(!("inputError" in none.message().content[0]));
});

test("unparsable JSON gives input {} and an inputError; other blocks are unaffected", () => {
  const acc = feed([
    start(),
    { type: "block_start", index: 0, block: { type: "text" } },
    { type: "text_delta", index: 0, text: "calling" },
    { type: "block_stop", index: 0 },
    { type: "block_start", index: 1, block: { type: "tool_use", id: "bad", name: "Write" } },
    { type: "tool_json_delta", index: 1, json: '{"path": "a.js", "content": "unterminated' },
    { type: "block_stop", index: 1 },
    { type: "block_start", index: 2, block: { type: "tool_use", id: "good", name: "Read" } },
    { type: "tool_json_delta", index: 2, json: '{"path":"b.js"}' },
    { type: "block_stop", index: 2 },
    ...end("tool_use"),
  ]);
  const [text, bad, good] = acc.message().content;
  assert.equal(text.text, "calling");
  assert.equal(bad.id, "bad");
  assert.deepEqual(bad.input, {});
  assert.match(bad.inputError, /^invalid JSON: /);
  assert.deepEqual(good.input, { path: "b.js" });
  assert.ok(!("inputError" in good));
});

test("JSON that is not an object is an input error too", () => {
  for (const json of ["[1,2]", '"text"', "42", "null"]) {
    const acc = feed([
      { type: "block_start", index: 0, block: { type: "tool_use", id: "t", name: "X" } },
      { type: "tool_json_delta", index: 0, json },
      { type: "block_stop", index: 0 },
    ]);
    const block = acc.message().content[0];
    assert.deepEqual(block.input, {}, json);
    assert.equal(block.inputError, "tool input must be a JSON object", json);
  }
});

test("a stream that forgets block_stop is finalized by message_stop", () => {
  const acc = feed([
    start(),
    { type: "block_start", index: 0, block: { type: "tool_use", id: "t", name: "Read" } },
    { type: "tool_json_delta", index: 0, json: '{"path":"x"}' },
    { type: "block_start", index: 1, block: { type: "text" } },
    { type: "text_delta", index: 1, text: "ok" },
    ...end("tool_use"),
  ]);
  assert.deepEqual(acc.message().content, [{ type: "tool_use", id: "t", name: "Read", input: { path: "x" } }, { type: "text", text: "ok" }]);
});

test("message() mid-stream is a consistent snapshot and does not freeze the block", () => {
  const acc = feed([
    { type: "block_start", index: 0, block: { type: "tool_use", id: "t", name: "Read" } },
    { type: "tool_json_delta", index: 0, json: '{"path":' },
  ]);
  assert.match(acc.message().content[0].inputError, /invalid JSON/);
  acc.add({ type: "tool_json_delta", index: 0, json: '"x"}' });
  acc.add({ type: "block_stop", index: 0 });
  assert.deepEqual(acc.message().content[0].input, { path: "x" });
});

test("blocks are ordered by index, parallel tool calls keep their ids", () => {
  const acc = feed([
    { type: "block_start", index: 1, block: { type: "tool_use", id: "b", name: "Read" } },
    { type: "block_start", index: 0, block: { type: "text" } },
    { type: "tool_json_delta", index: 1, json: '{"path":"b"}' },
    { type: "text_delta", index: 0, text: "two files" },
    { type: "block_start", index: 2, block: { type: "tool_use", id: "c", name: "Read" } },
    { type: "tool_json_delta", index: 2, json: '{"path":"c"}' },
    { type: "block_stop", index: 0 }, { type: "block_stop", index: 1 }, { type: "block_stop", index: 2 },
  ]);
  assert.deepEqual(acc.message().content.map(block => block.type + ":" + (block.id || "")), ["text:", "tool_use:b", "tool_use:c"]);
});

test("empty text and thinking blocks are left out; an empty reply has empty content", () => {
  const acc = feed([
    start(),
    { type: "block_start", index: 0, block: { type: "thinking" } }, { type: "block_stop", index: 0 },
    { type: "block_start", index: 1, block: { type: "text" } }, { type: "block_stop", index: 1 },
    ...end("end_turn"),
  ]);
  assert.deepEqual(acc.message(), { role: "assistant", content: [] });
  assert.equal(acc.thinkingText, "");
});

test("a delta for a block that never started still lands somewhere sensible", () => {
  const acc = feed([{ type: "text_delta", index: 3, text: "stray" }]);
  assert.deepEqual(acc.message().content, [{ type: "text", text: "stray" }]);
});

test("a tool block without an id gets a local one", () => {
  const acc = feed([{ type: "block_start", index: 0, block: { type: "tool_use", name: "LS" } }, { type: "block_stop", index: 0 }]);
  assert.match(acc.message().content[0].id, /^call_local_/);
});

test("usage is merged from message_start and message_delta", () => {
  const acc = feed([start({ input_tokens: 1200, output_tokens: 1 }), ...end("end_turn", { output_tokens: 87 })]);
  assert.deepEqual(acc.usage, { inputTokens: 1200, outputTokens: 87 });
  assert.equal(acc.usage.input_tokens, 1200);
  assert.equal(acc.usage.output_tokens, 87);
  assert.equal(JSON.stringify(acc.usage), '{"inputTokens":1200,"outputTokens":87}');
});

test("a later usage report wins, but a zero never erases a real figure", () => {
  assert.deepEqual(mergeUsage({ input_tokens: 10, output_tokens: 5 }, { input_tokens: 30, output_tokens: 9 }), { inputTokens: 30, outputTokens: 9 });
  assert.deepEqual(mergeUsage({ input_tokens: 10, output_tokens: 5 }, { input_tokens: 0, output_tokens: 9 }), { inputTokens: 10, outputTokens: 9 });
  assert.deepEqual(mergeUsage({}, { output_tokens: 3 }), { inputTokens: 0, outputTokens: 3 });
  assert.deepEqual(normalizeUsage({ input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 2 }), { inputTokens: 25, outputTokens: 2 });
  assert.deepEqual(normalizeUsage(undefined), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(normalizeUsage({ input_tokens: "x", output_tokens: -4 }), { inputTokens: 0, outputTokens: 0 });
});

test("a second message_start starts a fresh message", () => {
  const acc = feed([
    start(), { type: "block_start", index: 0, block: { type: "text" } }, { type: "text_delta", index: 0, text: "old" },
    start({ input_tokens: 7, output_tokens: 1 }), { type: "block_start", index: 0, block: { type: "text" } }, { type: "text_delta", index: 0, text: "new" },
  ]);
  assert.deepEqual(acc.message().content, [{ type: "text", text: "new" }]);
  assert.equal(acc.usage.inputTokens, 7);
});

test("wireMessage drops local-only fields and leaves everything else", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "a" }, { type: "tool_use", id: "t", name: "X", input: {}, inputError: "invalid JSON: nope" }],
  };
  const wire = wireMessage(message);
  assert.deepEqual(wire.content[1], { type: "tool_use", id: "t", name: "X", input: {} });
  assert.equal(wire.content[0], message.content[0]);
  assert.equal("inputError" in message.content[1], true, "the original is untouched");
});

test("unknown events are ignored", () => {
  const acc = feed([{ type: "something_new" }, null, undefined, 5, start()]);
  assert.deepEqual(acc.message().content, []);
});
