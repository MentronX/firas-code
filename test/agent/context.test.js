import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, pruneForRequest, maybeCompact, COMPACT_THRESHOLD_TOKENS } from "../../src/agent/context.js";
import { createSession } from "../../src/agent/session.js";
import { t, setLang } from "../../src/i18n/index.js";
import { assertValidHistory, fakeClient, fakeUi, textOfMessage, textReply } from "./fakes.js";

setLang("en");

const user = text => ({ role: "user", content: [{ type: "text", text }] });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });
const use = (id, name = "Read") => ({ type: "tool_use", id, name, input: { path: id } });
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content });

function sessionWith(messages) {
  const s = createSession({ cwd: process.cwd(), persist: false });
  s.messages = messages;
  return s;
}

/** n plain question/answer pairs. */
function pairs(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(user(`question ${i}`), assistant(`answer ${i}`));
  return out;
}

const GOOD_SUMMARY = "## Goal\nRefactor the parser.\n## Files touched\n- src/parser.js - split into two functions\n## Pending work\n- add tests";

test("estimateTokens is chars / 3.5 over system, tools and messages", () => {
  assert.equal(estimateTokens([], "", []), 0);
  assert.equal(estimateTokens([], "x".repeat(350)), 100);
  assert.equal(estimateTokens([], [{ type: "text", text: "x".repeat(350) }]), 100);
  const tools = [{ name: "Read", description: "d", input_schema: { type: "object" } }];
  assert.equal(estimateTokens([], "", tools), Math.ceil(JSON.stringify(tools).length / 3.5));
  const message = { role: "user", content: [{ type: "text", text: "x".repeat(700) }] };
  const base = estimateTokens([message]);
  assert.ok(base >= 200 && base <= 205);
  assert.ok(estimateTokens([{ role: "assistant", content: [use("abc")] }]) > 0);
  assert.ok(estimateTokens([{ role: "user", content: [result("a", "y".repeat(3500))] }]) >= 1000);
  const withImage = { role: "user", content: [{ type: "image", source: { type: "base64", data: "z".repeat(100000) } }, { type: "text", text: "hi" }] };
  assert.ok(estimateTokens([withImage]) < 10, "images are ignored");
  assert.ok(estimateTokens(pairs(20)) > estimateTokens(pairs(2)));
});

test("pruneForRequest drops thinking from finished turns only", () => {
  const think = text => ({ type: "thinking", thinking: text });
  const s = sessionWith([
    user("turn one"),
    { role: "assistant", content: [think("old thought"), use("a")] },
    { role: "user", content: [result("a", "r")] },
    { role: "assistant", content: [think("old thought 2"), { type: "text", text: "done one" }] },
    user("turn two"),
    { role: "assistant", content: [think("current thought"), use("b")] },
    { role: "user", content: [result("b", "r")] },
  ]);
  const out = pruneForRequest(s);
  assert.equal(out.length, 7);
  assert.ok(out.slice(0, 4).every(m => m.content.every(b => b.type !== "thinking")));
  assert.equal(out[5].content[0].type, "thinking", "the current turn keeps its thinking");
  assert.ok(s.messages[1].content.some(b => b.type === "thinking"), "the stored history is not modified");
  assertValidHistory(out);
});

test("pruneForRequest leaves a thinking-only message non-empty", () => {
  const s = sessionWith([user("a"), { role: "assistant", content: [{ type: "thinking", thinking: "only thoughts" }] }, user("b")]);
  const out = pruneForRequest(s);
  assert.ok(out[1].content.length > 0);
});

test("pruneForRequest shrinks old, large tool results once the conversation is big, keeping ids", () => {
  const big = "L".repeat(30000);
  const messages = [user("start")];
  for (let i = 0; i < 6; i++) {
    messages.push({ role: "assistant", content: [use(`id${i}`)] });
    messages.push({ role: "user", content: [result(`id${i}`, big)] });
  }
  messages.push(assistant("all read"));
  const s = sessionWith(messages);
  const out = pruneForRequest(s);

  const shrunk = out.flatMap(m => m.content).filter(b => b.type === "tool_result");
  assert.equal(shrunk.length, 6);
  const [oldest, , , , , newest] = shrunk;
  assert.ok(oldest.content.length < 600);
  assert.match(oldest.content, /removed to save context/);
  assert.equal(oldest.tool_use_id, "id0");
  assert.equal(newest.content.length, big.length, "recent results stay intact");
  assert.deepEqual(out.flatMap(m => m.content).filter(b => b.type === "tool_use").map(b => b.id), ["id0", "id1", "id2", "id3", "id4", "id5"]);
  assertValidHistory(out);
  assert.equal(s.messages[2].content[0].content.length, big.length, "the stored history is not modified");

  const small = sessionWith(messages.map(m => m).slice(0, 3));
  small.messages[2] = { role: "user", content: [result("id0", "short result")] };
  assert.equal(pruneForRequest(small)[2].content[0].content, "short result");
  assert.equal(pruneForRequest(sessionWith(messages), { shrinkAbove: 10 ** 9 })[2].content[0].content.length, big.length, "a small conversation keeps everything");
});

test("maybeCompact does nothing below the threshold", async () => {
  const client = fakeClient([]);
  const s = sessionWith(pairs(5));
  const r = await maybeCompact({ session: s, client, ui: fakeUi() });
  assert.equal(r.compacted, false);
  assert.equal(client.calls, 0);
  assert.equal(s.messages.length, 10);
  assert.equal(COMPACT_THRESHOLD_TOKENS, 150000);
});

test("forced compaction replaces older messages with a summary and keeps the last six verbatim", async () => {
  const client = fakeClient([textReply(GOOD_SUMMARY)]);
  const ui = fakeUi();
  const s = sessionWith(pairs(7)); // 14 messages: the last six start with a user message, so an acknowledgement follows the summary
  const lastSix = s.messages.slice(-6);
  const r = await maybeCompact({ session: s, client, ui, force: true });
  assert.equal(r.compacted, true);
  assert.equal(client.calls, 1);

  const [summary, ack, ...tail] = s.messages;
  assert.equal(summary.role, "user");
  assert.match(textOfMessage(summary), /Summary of the earlier conversation/);
  assert.match(textOfMessage(summary), /Refactor the parser/);
  assert.equal(ack.role, "assistant");
  assert.deepEqual(tail, lastSix);
  assertValidHistory(s.messages);
  assert.ok(ui.notices().some(n => n.text === t("agent.compacting")));
  assert.ok(ui.notices().some(n => /^Conversation compacted/.test(n.text)));

  const sent = client.requests[0];
  assert.ok(!("tools" in sent));
  assert.ok(!("thinking" in sent));
  assert.match(sent.messages[0].content[0].text, /question 0/);
  assert.match(sent.messages[0].content[0].text, /<conversation>/);
});

test("when the verbatim tail starts with an assistant message no acknowledgement is inserted", async () => {
  const s = sessionWith([...pairs(6), user("latest question")]); // 13 messages: the last six start with an assistant
  const lastSix = s.messages.slice(-6);
  await maybeCompact({ session: s, client: fakeClient([textReply(GOOD_SUMMARY)]), ui: fakeUi(), force: true });
  assert.equal(s.messages.length, 7);
  assert.equal(s.messages[0].role, "user");
  assert.deepEqual(s.messages.slice(1), lastSix);
  assertValidHistory(s.messages);
});

test("compaction never separates a tool_result from its tool_use", async () => {
  const plainStart = [user("q0"), assistant("a0"), user("q1"), assistant("a1"), user("do the thing")];
  const loop = [
    { role: "assistant", content: [use("t1"), use("t2")] },
    { role: "user", content: [result("t1", "r1"), result("t2", "r2")] },
    { role: "assistant", content: [use("t3")] },
    { role: "user", content: [result("t3", "r3")] },
    { role: "assistant", content: [use("t4")] },
    { role: "user", content: [result("t4", "r4")] },
  ];
  // Different lengths put the cut on an assistant message, a plain user message or a tool_result message.
  let cutsOnToolResults = 0;
  for (let pad = 0; pad < 4; pad++) {
    for (const take of [2, 4, 6]) {
      const messages = [...pairs(pad), ...plainStart, ...loop.slice(0, take), assistant("final")];
      const k = messages.length - 6;
      if (k > 0 && messages[k].role === "user" && messages[k].content[0].type === "tool_result") cutsOnToolResults++;
      const s = sessionWith(messages);
      const r = await maybeCompact({ session: s, client: fakeClient([textReply(GOOD_SUMMARY)]), ui: fakeUi(), force: true });
      if (r.compacted) assertValidHistory(s.messages);
      else assert.deepEqual(s.messages, messages);
    }
  }
  assert.ok(cutsOnToolResults >= 3, "the scenarios really exercise a cut on tool results");

  // A tool_result message that also carries the next turn's text (an interrupted turn followed by a new request).
  const merged = [
    ...plainStart,
    { role: "assistant", content: [use("m1")] },
    { role: "user", content: [result("m1", "partial"), { type: "text", text: "actually do this instead" }] },
    assistant("ok"), user("next"), assistant("fine"), user("more"), assistant("sure"),
  ];
  const s = sessionWith(merged);
  const r = await maybeCompact({ session: s, client: fakeClient([textReply(GOOD_SUMMARY)]), ui: fakeUi(), force: true });
  assert.equal(r.compacted, true);
  assertValidHistory(s.messages);
});

test("compaction in the middle of a tool loop keeps the loop's pairing", async () => {
  const messages = [user("big task")];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "assistant", content: [use(`s${i}`)] });
    messages.push({ role: "user", content: [result(`s${i}`, `output ${i}`)] });
  }
  const s = sessionWith(messages);
  const client = fakeClient([textReply(GOOD_SUMMARY)]);
  const r = await maybeCompact({ session: s, client, ui: fakeUi(), force: true });
  assert.equal(r.compacted, true);
  assertValidHistory(s.messages);
  assert.equal(s.messages[0].role, "user");
  assert.equal(s.messages[1].role, "assistant");
  assert.ok(s.messages.length <= 8);
});

test("automatic compaction triggers on the estimate and a bigger real context size", async () => {
  const filler = "z".repeat(60000);
  const msgs = [];
  for (let i = 0; i < 5; i++) msgs.push(user(`${filler} ${i}`), assistant(`${filler} ${i}`));
  const s = sessionWith(msgs);
  assert.ok(estimateTokens(s.messages) > COMPACT_THRESHOLD_TOKENS);
  const client = fakeClient([textReply(GOOD_SUMMARY)]);
  assert.equal((await maybeCompact({ session: s, client, ui: fakeUi() })).compacted, true);

  const small = sessionWith(pairs(6));
  small.contextTokens = 170000;
  const c2 = fakeClient([textReply(GOOD_SUMMARY)]);
  assert.equal((await maybeCompact({ session: small, client: c2, ui: fakeUi() })).compacted, true, "the server-reported size counts too");
  assert.equal(small.contextTokens, 0, "and is forgotten afterwards");
});

test("a failed or useless summary leaves the history exactly as it was", async () => {
  const original = [...pairs(6), user("q")];
  for (const script of [[textReply("")], [textReply("too short")], [{ events: [], throwAfter: new Error("down") }]]) {
    const s = sessionWith(original.map(m => m));
    const ui = fakeUi();
    const r = await maybeCompact({ session: s, client: fakeClient(script), ui, force: true });
    assert.equal(r.compacted, false);
    assert.equal(r.failed, true);
    assert.deepEqual(s.messages, original);
    assert.equal(ui.notices().at(-1).text, t("agent.compactFailed"));
  }
});

test("forced compaction of a tiny conversation says there is nothing to do", async () => {
  const s = sessionWith(pairs(2));
  const ui = fakeUi();
  const client = fakeClient([]);
  const r = await maybeCompact({ session: s, client, ui, force: true });
  assert.equal(r.compacted, false);
  assert.equal(client.calls, 0);
  assert.equal(ui.notices().at(-1).text, t("agent.compactNothing"));
});

test("compaction can be aborted and reports it", { timeout: 10000 }, async () => {
  const ctl = new AbortController();
  const s = sessionWith([...pairs(6), user("q")]);
  const client = fakeClient([{ events: textReply(GOOD_SUMMARY), hangAfter: 1 }]);
  setTimeout(() => ctl.abort(), 20);
  const r = await maybeCompact({ session: s, client, ui: fakeUi(), force: true, signal: ctl.signal });
  assert.equal(r.compacted, false);
  assert.equal(r.aborted, true);
  assert.equal(s.messages.length, 13);
});

test("a huge conversation is trimmed before it is sent for summarizing", async () => {
  const msgs = [];
  for (let i = 0; i < 40; i++) msgs.push(user(`${i}: ${"w".repeat(8000)}`), assistant(`${i}: ${"v".repeat(8000)}`));
  const s = sessionWith(msgs);
  const client = fakeClient([textReply(GOOD_SUMMARY)]);
  await maybeCompact({ session: s, client, ui: fakeUi(), force: true });
  const sent = client.requests[0].messages[0].content[0].text;
  assert.ok(sent.length < 400000);
  assert.match(sent, /omitted/);
  assert.match(sent, /USER:\n0: w/, "the opening is kept");
});
