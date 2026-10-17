// The loop against the real service client and the mock service (a loopback HTTP server), with fake tools.
// Skipped when the link modules are not present in the tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runUserTurn } from "../../src/agent/loop.js";
import { createSession } from "../../src/agent/session.js";
import { setLang } from "../../src/i18n/index.js";
import { assertValidHistory, fakePermissions, fakeTool, fakeToolbox, fakeUi, textOfMessage } from "./fakes.js";

setLang("en");

let createServiceClient;
let mock;
try {
  ({ createServiceClient } = await import("../../src/link/client.js"));
  mock = await import("../helpers/mock-service.js");
} catch {
  mock = null;
}
const skip = !mock && "the link modules are not available";

async function withService(script, fn) {
  const service = await mock.startMockService(script);
  const client = createServiceClient({ origin: service.origin, getCode: () => service.code, lang: "en", backoffMs: [5, 5, 5, 5] });
  try { await fn({ service, client }); } finally { await service.close(); }
}

function parts(client) {
  return {
    client,
    session: createSession({ cwd: process.cwd(), persist: false }),
    ui: fakeUi(),
    toolbox: fakeToolbox([fakeTool("Read", { readOnly: true, concurrencySafe: true, schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, run: async input => ({ ok: true, content: `contents of ${input.path}` }) })]),
    permissions: fakePermissions(),
  };
}

test("a tool turn over real HTTP streaming", { skip }, () => withService(
  [
    mock.toolReply([{ name: "Read", input: { path: "src/app.js" }, id: "call_http_1" }], { text: "Reading it.", thinking: "need the file" }),
    mock.textReply("مرحبا، الملف سليم."),
  ],
  async ({ service, client }) => {
    const p = parts(client);
    const result = await runUserTurn({ ...p, text: "افحص الملف", effort: "medium", lang: "ar", system: "SYSTEM" });
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.steps, 2);
    assertValidHistory(p.session.messages);
    assert.equal(textOfMessage(p.session.messages[3]), "مرحبا، الملف سليم.");
    assert.equal(p.session.messages[2].content[0].tool_use_id, "call_http_1");
    assert.equal(p.session.messages[2].content[0].content, "contents of src/app.js");

    const posts = service.requests.filter(r => r.method === "POST" && r.path.endsWith("/v1/messages"));
    assert.equal(posts.length, 2);
    const body = posts[1].body;
    assert.equal(body.model, "firas-code-2");
    assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.deepEqual(body.messages[1].content.map(b => b.type), ["thinking", "text", "tool_use"]);
    assert.equal(body.messages[2].content[0].type, "tool_result");
    assert.equal(posts[0].headers["x-firas-client"], "cli");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(service.inFlight(), 0, "finished streams are closed too");
  },
));

test("aborting mid-stream releases the connection and keeps a valid history", { skip, timeout: 15000 }, () => withService(
  // The answer stops short of message_stop and the service keeps the connection open, like a stalled service.
  [(() => { const reply = mock.textReply("a long answer that never finishes"); return { ...reply, events: reply.events.slice(0, -2), hang: true }; })()],
  async ({ service, client }) => {
    const ctl = new AbortController();
    const p = parts(client);
    p.ui = fakeUi({ onCall: name => { if (name === "textDelta") setTimeout(() => ctl.abort(), 5); } });
    const result = await runUserTurn({ ...p, text: "go", effort: "off", lang: "en", system: "SYSTEM", signal: ctl.signal });
    assert.equal(result.stopReason, "aborted");
    assertValidHistory(p.session.messages);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(service.inFlight(), 0, "the aborted request was closed");
  },
));

test("a service refusal is shown in friendly words, never raw", { skip }, () => withService(
  [mock.errorReply(401, "access_invalid", "raw upstream complaint")],
  async ({ client }) => {
    const p = parts(client);
    const result = await runUserTurn({ ...p, text: "hi", effort: "low", lang: "en", system: "SYSTEM" });
    assert.equal(result.stopReason, "error");
    const last = p.ui.notices().at(-1);
    assert.equal(last.level, "error");
    assert.ok(last.text.length > 10);
    assert.ok(!/raw upstream complaint/.test(last.text));
    assertValidHistory(p.session.messages);
  },
));
