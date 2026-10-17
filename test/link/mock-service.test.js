import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startMockService, textReply, toolReply, errorReply, midStreamError } from "../helpers/mock-service.js";
import { createSseParser } from "../../src/link/sse.js";
import { ROUTE_PREFIX } from "../../src/brand.js";

const ROUTE = ROUTE_PREFIX;
const HEADERS = { authorization: "Bearer FC2-ANY", "x-firas-client": "cli", "content-type": "application/json" };
const post = (service, path, body, headers = HEADERS) => fetch(service.origin + ROUTE + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) });

function rawChunks(service, path) {
  return new Promise((resolve, reject) => {
    const request = http.request(service.origin + ROUTE + path, { method: "POST", headers: HEADERS }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(chunks));
    });
    request.on("error", reject);
    request.end("{}");
  });
}

function eventsOf(text) {
  const parser = createSseParser();
  return [...parser.push(text), ...parser.end()].map(item => ({ event: item.event, data: JSON.parse(item.data) }));
}

test("entries are consumed one per message request, in order, and the script stays live", async () => {
  const script = [textReply("one")];
  const service = await startMockService(script);
  try {
    assert.equal((await post(service, "/v1/messages")).status, 200);
    const exhausted = await post(service, "/v1/messages");
    assert.equal(exhausted.status, 500);
    assert.equal(exhausted.headers.get("x-firas-code2-error"), "mock_exhausted");
    assert.equal(exhausted.headers.get("x-should-retry"), "false");
    script.push(errorReply(429, "busy"));
    assert.equal((await post(service, "/v1/messages")).status, 429);
    assert.equal(service.requests.length, 3);
  } finally { await service.close(); }
});

test("a function entry sees the request record", async () => {
  const service = await startMockService([record => ({ status: 200, json: { echoed: record.body.hello } })]);
  try {
    assert.deepEqual(await (await post(service, "/v1/messages", { hello: "مرحبا" })).json(), { echoed: "مرحبا" });
  } finally { await service.close(); }
});

test("requests are recorded with headers and parsed bodies", async () => {
  const service = await startMockService([textReply("x")]);
  try {
    await (await post(service, "/v1/messages", { a: 1 })).text();
    const [record] = service.requests;
    assert.equal(record.method, "POST");
    assert.equal(record.path, ROUTE + "/v1/messages");
    assert.equal(record.headers.authorization, "Bearer FC2-ANY");
    assert.equal(record.headers["x-firas-client"], "cli");
    assert.deepEqual(record.body, { a: 1 });
    assert.equal(record.rawBody, '{"a":1}');
    assert.equal(record.status, 200);
  } finally { await service.close(); }
});

test("the service checks the authorization and client headers like the live one", async () => {
  const service = await startMockService([textReply("x"), textReply("y")], { code: "FC2-RIGHT-CODE" });
  try {
    const none = await post(service, "/v1/messages", {}, { "x-firas-client": "cli" });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("x-firas-code2-error"), "access_invalid");
    const wrong = await post(service, "/v1/messages", {}, { ...HEADERS, authorization: "Bearer FC2-WRONG" });
    assert.equal(wrong.status, 401);
    const noClient = await post(service, "/v1/messages", {}, { authorization: "Bearer fc2-right-code" });
    assert.equal(noClient.status, 400);
    assert.equal(noClient.headers.get("x-firas-code2-error"), "client_required");
    const ok = await post(service, "/v1/messages", {}, { ...HEADERS, authorization: "Bearer fc2-right-code" });
    assert.equal(ok.status, 200, "case and dashes do not matter");
    await ok.text();
    assert.equal(service.requests.length, 4, "refused requests are recorded too, and they consume no script entry");
  } finally { await service.close(); }
});

test("/v1/models answers 200 or the configured refusal", async () => {
  const script = [];
  const service = await startMockService(script);
  try {
    const ok = await fetch(service.origin + ROUTE + "/v1/models", { headers: HEADERS });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data[0].display_name, "Firas Code 2");
    script.denyModels = true;
    assert.equal((await fetch(service.origin + ROUTE + "/v1/models", { headers: HEADERS })).headers.get("x-firas-code2-error"), "access_invalid");
    script.denyModels = "expired";
    const expired = await fetch(service.origin + ROUTE + "/v1/models", { headers: HEADERS });
    assert.equal(expired.status, 401);
    assert.equal(expired.headers.get("x-firas-code2-error"), "access_expired");
  } finally { await service.close(); }
});

test("/library answers by default, by function, and refuses like the live route", async () => {
  const script = [];
  const service = await startMockService(script, { code: "FC2-ABC" });
  try {
    const own = { ...HEADERS, authorization: "Bearer FC2-ABC" };
    const plain = await post(service, "/library", { tool: "search" }, own);
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).echo.tool, "search");
    script.library = body => ({ status: 429, body: { ok: false, error: "quota_exceeded", seen: body.tool }, headers: { "retry-after": "5" } });
    const limited = await post(service, "/library", { tool: "component" }, own);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "5");
    assert.deepEqual(await limited.json(), { ok: false, error: "quota_exceeded", seen: "component" });
    const refused = await post(service, "/library", {}, { ...HEADERS, authorization: "Bearer FC2-NOPE" });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("x-firas-code2-error"), null, "the library route reports the code in the body");
    assert.deepEqual(await refused.json(), { ok: false, error: "access_invalid" });
  } finally { await service.close(); }
});

test("unknown paths are 404", async () => {
  const service = await startMockService([]);
  try {
    assert.equal((await fetch(service.origin + "/elsewhere")).status, 404);
    assert.equal((await fetch(service.origin + ROUTE + "/nope", { headers: HEADERS })).status, 404);
  } finally { await service.close(); }
});

test("textReply is a realistic stream: start, ping, thinking, text, delta, stop", async () => {
  const service = await startMockService([textReply("Hello world", { thinking: "hmm", chunk: 4, usage: { input: 50, output: 3 } })]);
  try {
    const response = await post(service, "/v1/messages");
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const events = eventsOf(await response.text());
    assert.deepEqual(events.map(item => item.event), [
      "message_start", "ping",
      "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    assert.equal(events[0].data.message.usage.input_tokens, 50);
    assert.equal(events[2].data.content_block.type, "thinking");
    assert.equal(events[5].data.content_block.type, "text");
    assert.equal(events.at(-2).data.delta.stop_reason, "end_turn");
    assert.equal(events.at(-2).data.usage.output_tokens, 3);
    assert.ok(events.every(item => item.data.type === item.event));
  } finally { await service.close(); }
});

test("toolReply sends an empty first JSON fragment, then the pieces, and stops with tool_use", async () => {
  const service = await startMockService([toolReply([{ name: "Read", input: { path: "src/a.js" }, id: "call_X" }], { fragments: 3 })]);
  try {
    const events = eventsOf(await (await post(service, "/v1/messages")).text());
    const deltas = events.filter(item => item.data.delta?.type === "input_json_delta").map(item => item.data.delta.partial_json);
    assert.equal(deltas[0], "");
    assert.ok(deltas.length >= 4);
    assert.deepEqual(JSON.parse(deltas.join("")), { path: "src/a.js" });
    const start = events.find(item => item.event === "content_block_start");
    assert.deepEqual(start.data.content_block, { type: "tool_use", id: "call_X", name: "Read", input: {} });
    assert.equal(events.at(-2).data.delta.stop_reason, "tool_use");
  } finally { await service.close(); }
});

test("errorReply carries the live service's headers and an English body", async () => {
  const service = await startMockService([
    errorReply(429, "busy", undefined, { retryAfter: 3 }),
    errorReply(429, "daily_limit"),
    errorReply(401, "access_expired", "Custom English message"),
    errorReply(503, "unavailable", undefined, { shouldRetry: false }),
  ]);
  try {
    const busy = await post(service, "/v1/messages");
    assert.equal(busy.headers.get("x-firas-code2-error"), "busy");
    assert.equal(busy.headers.get("retry-after"), "3");
    assert.equal(busy.headers.get("x-should-retry"), null);
    assert.equal((await busy.json()).error.type, "rate_limit_error");
    const daily = await post(service, "/v1/messages");
    assert.equal(daily.headers.get("x-should-retry"), "false");
    const expired = await post(service, "/v1/messages");
    assert.equal((await expired.json()).error.message, "Custom English message");
    assert.equal((await post(service, "/v1/messages")).headers.get("x-should-retry"), "false");
  } finally { await service.close(); }
});

test("midStreamError ends with an error event and no message_stop", async () => {
  const service = await startMockService([midStreamError("partial", { type: "overloaded_error", message: "Boom" })]);
  try {
    const events = eventsOf(await (await post(service, "/v1/messages")).text());
    assert.equal(events.at(-1).event, "error");
    assert.deepEqual(events.at(-1).data.error, { type: "overloaded_error", message: "Boom" });
    assert.ok(!events.some(item => item.event === "message_stop"));
  } finally { await service.close(); }
});

test("splitBytes chops the stream into many small chunks, cutting through multi-byte characters", async () => {
  const text = "مرحبا بالعالم 🌍 ".repeat(6);
  const service = await startMockService([textReply(text), { ...textReply(text), splitBytes: 1 }, { ...textReply(text), splitBytes: [1, 2, 3] }]);
  try {
    const whole = await rawChunks(service, "/v1/messages");
    const single = await rawChunks(service, "/v1/messages");
    const mixed = await rawChunks(service, "/v1/messages");
    assert.ok(single.length > whole.length * 4, `${single.length} vs ${whole.length}`);
    assert.ok(mixed.length > whole.length * 2, `${mixed.length} vs ${whole.length}`);
    let torn = false;
    for (const chunk of single) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(chunk); } catch { torn = true; break; }
    }
    assert.ok(torn, "at least one chunk ends inside a multi-byte character");
    const joined = Buffer.concat(single);
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(joined));
    const got = eventsOf(joined.toString("utf8")).filter(item => item.event === "content_block_delta").map(item => item.data.delta.text).join("");
    assert.equal(got, text);
  } finally { await service.close(); }
});

test("eol, omitEventLine, raw items, comments and per-event delays shape the wire", async () => {
  const service = await startMockService([
    {
      eol: "\r\n",
      events: [{ comment: "hi" }, { event: "x", data: { type: "x" } }, { raw: 'data: {"type":"y"}\r\n\r\n' }, { delayMs: 30, event: "z", data: { type: "z" } }, 'data: {"type":"w"}\r\n\r\n'],
    },
    { omitEventLine: true, events: [{ event: "ignored", data: { type: "t" } }] },
  ]);
  try {
    const started = Date.now();
    const text = await (await post(service, "/v1/messages")).text();
    assert.ok(Date.now() - started >= 25);
    assert.equal(text, ': hi\r\n\r\nevent: x\r\ndata: {"type":"x"}\r\n\r\ndata: {"type":"y"}\r\n\r\nevent: z\r\ndata: {"type":"z"}\r\n\r\ndata: {"type":"w"}\r\n\r\n');
    assert.equal(await (await post(service, "/v1/messages")).text(), 'data: {"type":"t"}\n\n');
  } finally { await service.close(); }
});

test("inFlight and sockets show a held-open stream and its release", async () => {
  const service = await startMockService([{ events: [], hang: true }]);
  try {
    const controller = new AbortController();
    const response = await fetch(service.origin + ROUTE + "/v1/messages", { method: "POST", headers: HEADERS, body: "{}", signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(service.inFlight(), 1);
    assert.ok(service.sockets() >= 1);
    controller.abort();
    const started = Date.now();
    while (service.inFlight() !== 0 && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.inFlight(), 0);
  } finally { await service.close(); }
});

test("close() frees the port", async () => {
  const service = await startMockService([]);
  const origin = service.origin;
  await service.close();
  await assert.rejects(fetch(origin + ROUTE + "/v1/models"));
});

test("the object form of the script works too", async () => {
  const service = await startMockService({ replies: [textReply("object form")], denyModels: false, modelName: "Custom Name" });
  try {
    assert.equal((await (await fetch(service.origin + ROUTE + "/v1/models", { headers: HEADERS })).json()).data[0].display_name, "Custom Name");
    assert.equal((await post(service, "/v1/messages")).status, 200);
  } finally { await service.close(); }
});
