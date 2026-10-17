// A stand-in for the Firas Code 2 service, for tests. It is a real node:http server on 127.0.0.1 (random
// port) that speaks the same wire protocol as the live service: SSE for POST /v1/messages, JSON for
// GET /v1/models and POST /library, the same error headers.
//
//   import { startMockService, textReply, toolReply, errorReply, midStreamError } from "../helpers/mock-service.js";
//
//   const service = await startMockService([ textReply("مرحبا"), errorReply(429, "busy"), toolReply([{ name: "Read", input: { path: "a.js" } }]) ]);
//   const client = createServiceClient({ origin: service.origin, getCode: () => service.code, ... });
//   ...
//   await service.close();
//
// startMockService(script, options?) -> Promise<{ origin, code, requests, script, inFlight(), sockets(), close() }>
//   script    array of entries, consumed one per POST /v1/messages (a live array: push more any time).
//             Properties on the array (or the object form { replies, ...}) tune the rest of the service:
//               script.denyModels   true | "invalid" | "expired"  -> GET /v1/models answers 401 (code access_invalid / access_expired)
//               script.modelName    display name for GET /v1/models (default "Firas Code 2")
//               script.library      POST /library: { status, body, headers? } or (body, request) => that. Default 200 {ok:true,...}
//               script.code         the access code the service accepts; any other code -> 401 access_invalid.
//                                   Default: any non-empty bearer is accepted. options.code works too.
//   requests  every request received, in order: { method, path, headers (lower-case; the authorization header
//             is kept so tests can assert on it), rawBody, body (parsed JSON or null), closed (the client hung
//             up or the response ended), status (what the service answered), at }
//   inFlight()  /v1/messages responses still open  - use it to prove an abort released the connection
//   sockets()   open TCP connections
//
// Script entry (all optional; builders below make the common ones):
//   events      [ { event, data } | { raw } | { comment } | "verbatim text" , ... ]  ->  SSE, 200
//               an event may carry delayMs (wait before writing it) and nothing else the wire would see
//   status, headers, json | body   non-SSE answer: JSON object or raw string with that status and headers
//   delayMs     wait before answering at all
//   eventDelayMs  wait between events
//   splitBytes  chop the whole stream into pieces of N bytes (or a cycling list like [1,2,3]); N=1 puts a
//               boundary inside every multi-byte character. Best effort at the TCP level - the parser tests
//               in test/link/sse.test.js feed exact chunks.
//   eol         line ending of the stream ("\n" default, "\r\n")
//   omitEventLine  write data lines only (clients must read data.type)
//   cutAfter    destroy the connection after N events (a reset in mid-answer)
//   hang        after the events, keep the response open forever (idle / abort tests)
//   silent      never answer (headers timeout / abort-while-connecting tests)
// A function in place of an entry is called with the request record and returns the entry.
//
// Builders (each returns a script entry):
//   textReply(text, { thinking, usage: {input, output}, chunk, stopReason, ping })
//       thinking block (if given) then text, `chunk` characters per delta, a ping after message_start.
//   toolReply([{ name, input, id? }], { text, thinking, usage, fragments, chunk })
//       `input` is an object, or a STRING sent as the raw JSON (a broken one tests inputError);
//       fragments > 1 splits it over that many input_json_delta events after the empty first one.
//   errorReply(status, code, message?, { retryAfter (seconds), shouldRetry, headers })
//       x-firas-code2-error + a JSON error body in English; x-should-retry: false for final codes
//       (override with shouldRetry). No retry-after unless you ask, so retry tests stay fast.
//   midStreamError(text, { type, message, chunk, withText })
//       message_start, the start of a text block, then an `error` event; no message_stop.
import http from "node:http";
import { setImmediate as tick } from "node:timers/promises";
import { ROUTE_PREFIX } from "../../src/brand.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- builders ----------------------------------------------------------------------------------

let counter = 0;
const nextId = prefix => `${prefix}_mock_${++counter}`;
const ev = (event, data) => ({ event, data });

/** Splits on code points, so a surrogate pair is never torn (a byte split can still tear a character). */
function pieces(text, size) {
  const chars = [...String(text)];
  const out = [];
  for (let i = 0; i < chars.length; i += Math.max(1, size)) out.push(chars.slice(i, i + size).join(""));
  return out.length ? out : [""];
}

function usageFor(usage, sample) {
  return {
    input_tokens: usage?.input ?? usage?.input_tokens ?? 25,
    output_tokens: usage?.output ?? usage?.output_tokens ?? Math.max(1, Math.ceil(String(sample).length / 4)),
  };
}

const startEvents = (id, usage, ping) => [
  ev("message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model: "firas-code-2", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } },
  }),
  ...(ping ? [ev("ping", { type: "ping" })] : []),
];

function blockEvents(index, start, deltas) {
  return [
    ev("content_block_start", { type: "content_block_start", index, content_block: start }),
    ...deltas.map(delta => ev("content_block_delta", { type: "content_block_delta", index, delta })),
    ev("content_block_stop", { type: "content_block_stop", index }),
  ];
}

const endEvents = (stopReason, usage) => [
  ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } }),
  ev("message_stop", { type: "message_stop" }),
];

function contentEvents({ thinking, text, chunk }, startIndex = 0) {
  const out = [];
  let index = startIndex;
  if (thinking) out.push(...blockEvents(index++, { type: "thinking", thinking: "" }, pieces(thinking, chunk).map(piece => ({ type: "thinking_delta", thinking: piece }))));
  if (text) out.push(...blockEvents(index++, { type: "text", text: "" }, pieces(text, chunk).map(piece => ({ type: "text_delta", text: piece }))));
  return { events: out, next: index };
}

/** A complete streamed answer: optional thinking block, then text, ending with `stopReason`. */
export function textReply(text, { thinking = "", usage, chunk = 7, stopReason = "end_turn", ping = true } = {}) {
  const used = usageFor(usage, text + thinking);
  const { events } = contentEvents({ thinking, text, chunk });
  return { events: [...startEvents(nextId("resp"), used, ping), ...events, ...endEvents(stopReason, used)] };
}

/**
 * An answer that ends in tool calls: [{ name, input, id? }]. `input` is an object, or a STRING to send as the
 * raw JSON (use a broken one to test inputError). `fragments` > 1 splits the JSON over that many
 * input_json_delta events, after the empty first one the real service sends.
 */
export function toolReply(calls, { text = "", thinking = "", usage, fragments = 3, chunk = 7, ping = true } = {}) {
  const used = usageFor(usage, text + thinking + JSON.stringify(calls));
  const { events, next } = contentEvents({ thinking, text, chunk });
  let index = next;
  for (const call of calls) {
    const json = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {});
    const parts = fragments > 1 ? ["", ...pieces(json, Math.ceil([...json].length / fragments))] : [json];
    events.push(...blockEvents(index++, { type: "tool_use", id: call.id || nextId("call"), name: call.name, input: {} },
      parts.map(partial => ({ type: "input_json_delta", partial_json: partial }))));
  }
  return { events: [...startEvents(nextId("resp"), used, ping), ...events, ...endEvents("tool_use", used)] };
}

const ERROR_TYPES = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 413: "request_too_large", 429: "rate_limit_error", 503: "overloaded_error", 529: "overloaded_error" };
// The live service marks these final with x-should-retry: false.
const FINAL = new Set(["access_invalid", "access_expired", "signin_required", "daily_limit", "request_rejected", "request_too_large", "invalid_request", "client_required", "upstream_refused"]);

/**
 * An HTTP error answer like the live service's: status, `x-firas-code2-error`, and a JSON error body in English
 * that a client does not display. `retryAfter` is in seconds. `shouldRetry: false` adds x-should-retry.
 */
export function errorReply(status, code, message, { retryAfter, shouldRetry, headers = {} } = {}) {
  const out = { "x-firas-code2-error": code, ...headers };
  if (retryAfter !== undefined) out["retry-after"] = String(retryAfter);
  if (shouldRetry === false || (shouldRetry === undefined && FINAL.has(code))) out["x-should-retry"] = "false";
  return {
    status,
    headers: out,
    json: { type: "error", error: { type: ERROR_TYPES[status] || "api_error", message: message || `Mock service refused: ${code}` } },
  };
}

/** A stream that starts like a text answer and then fails with an `error` event (no message_stop). */
export function midStreamError(text = "partial", { type = "overloaded_error", message = "Mock stream failure", chunk = 7, withText = true } = {}) {
  const used = usageFor(undefined, text);
  const body = withText ? contentEvents({ text, chunk }).events.slice(0, -1) : []; // drop the block_stop: the answer never finished
  return { events: [...startEvents(nextId("resp"), used, true), ...body, ev("error", { type: "error", error: { type, message } })] };
}

// ---- the server --------------------------------------------------------------------------------

function serialize(item, { eol, omitEventLine }) {
  if (typeof item === "string") return item;
  if (item.raw !== undefined) return item.raw;
  if (item.comment !== undefined) return `: ${item.comment}${eol}${eol}`;
  const data = typeof item.data === "string" ? item.data : JSON.stringify(item.data);
  const head = item.event && !omitEventLine ? `event: ${item.event}${eol}` : "";
  return head + data.split("\n").map(line => `data: ${line}${eol}`).join("") + eol;
}

const sizesOf = split => (split === undefined || split === null ? null : (Array.isArray(split) ? split : [split]).map(n => Math.max(1, Math.floor(n))));

const OK_MODELS = name => ({
  data: [{ type: "model", id: "firas-code-2", display_name: name, created_at: "2026-10-12T00:00:00Z" }],
  has_more: false, first_id: "firas-code-2", last_id: "firas-code-2",
});

export async function startMockService(script = [], options = {}) {
  const list = Array.isArray(script) ? script : (Array.isArray(script?.replies) ? script.replies : []);
  const setting = name => (Array.isArray(script) ? script[name] : script?.[name]) ?? options[name];
  const requests = [];
  const sockets = new Set();
  let cursor = 0;
  let inFlight = 0;

  const expectedCode = () => String(setting("code") ?? "").replace(/[\s-]+/g, "").toUpperCase();

  function sendJson(res, record, status, body, headers = {}) {
    record.status = status;
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  // Service-level refusals look like the live ones: the error header on the model service, a bare code in the body on /library.
  function refuse(res, record, status, code, library = false) {
    const headers = { "x-should-retry": "false", ...(library ? {} : { "x-firas-code2-error": code }) };
    const body = library ? { ok: false, error: code } : { type: "error", error: { type: ERROR_TYPES[status] || "api_error", message: `Mock service refused: ${code}` } };
    sendJson(res, record, status, body, headers);
  }

  function authProblem(headers) {
    const match = /^Bearer\s+(\S.*)$/i.exec(String(headers.authorization || ""));
    if (!match) return { status: 401, code: "access_invalid" };
    const wanted = expectedCode();
    if (wanted && match[1].replace(/[\s-]+/g, "").toUpperCase() !== wanted) return { status: 401, code: "access_invalid" };
    if (headers["x-firas-client"] !== "cli") return { status: 400, code: "client_required" };
    return null;
  }

  async function writeStream(res, record, entry) {
    const eol = entry.eol || "\n";
    const sizes = sizesOf(entry.splitBytes);
    let pending = Buffer.alloc(0);
    let sizeAt = 0;
    const alive = () => !res.destroyed && !res.writableEnded;

    async function flush(all) {
      while (alive() && pending.length && (all || (sizes && pending.length >= sizes[sizeAt % sizes.length]))) {
        const size = sizes ? Math.min(sizes[sizeAt++ % sizes.length], pending.length) : pending.length;
        res.write(pending.subarray(0, size));
        pending = pending.subarray(size);
        await tick();
      }
    }

    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...(entry.headers || {}) });
    res.flushHeaders();
    let written = 0;
    for (const item of entry.events || []) {
      if (!alive()) return;
      if (typeof item === "object" && item.delayMs) { await flush(true); await sleep(item.delayMs); }
      else if (written && entry.eventDelayMs) { await flush(true); await sleep(entry.eventDelayMs); }
      pending = Buffer.concat([pending, Buffer.from(serialize(item, { eol, omitEventLine: entry.omitEventLine }), "utf8")]);
      await flush(!sizes);
      written++;
      if (entry.cutAfter !== undefined && written >= entry.cutAfter) { await flush(true); await sleep(15); res.socket?.destroy(); return; }
    }
    await flush(true);
    record.status = 200;
    if (entry.hang) { await new Promise(resolve => res.once("close", resolve)); return; }
    res.end();
  }

  async function messages(req, res, record) {
    inFlight++;
    res.once("close", () => { inFlight--; record.closed = true; });
    const picked = list[cursor];
    if (picked !== undefined) cursor++; // an exhausted script stays exhausted until someone pushes more
    const entry = typeof picked === "function" ? await picked(record) : picked;
    if (!entry) { refuse(res, record, 500, "mock_exhausted"); return; }
    if (entry.delayMs) await sleep(entry.delayMs);
    if (entry.silent) { await new Promise(resolve => res.once("close", resolve)); return; }
    if (entry.events) { await writeStream(res, record, entry); return; }
    const body = entry.json !== undefined ? entry.json : (entry.body !== undefined ? entry.body : { ok: true });
    sendJson(res, record, entry.status || 200, body, entry.headers);
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://mock");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = null; }
    const record = { method: req.method, path: url.pathname, headers: { ...req.headers }, rawBody, body, closed: false, status: null, at: Date.now() };
    requests.push(record);
    res.once("close", () => { record.closed = true; });

    const library = url.pathname === ROUTE_PREFIX + "/library";
    const route = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : "";
    if (!route) { sendJson(res, record, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } }); return; }

    const problem = authProblem(record.headers);
    if (problem) { refuse(res, record, problem.status, problem.code, library); return; }

    if (route === "/v1/models" && req.method === "GET") {
      const deny = setting("denyModels");
      if (deny) { refuse(res, record, 401, deny === "expired" ? "access_expired" : "access_invalid"); return; }
      sendJson(res, record, 200, OK_MODELS(setting("modelName") || "Firas Code 2"));
      return;
    }
    if (route === "/v1/messages" && req.method === "POST") { await messages(req, res, record); return; }
    if (library && req.method === "POST") {
      const handler = setting("library");
      const answer = typeof handler === "function" ? await handler(body, record) : handler;
      const { status = 200, body: out = { ok: true, text: "mock library answer", echo: body }, headers = {} } = answer || {};
      sendJson(res, record, status, out, headers);
      return;
    }
    sendJson(res, record, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { res.destroy(); } catch { /* already gone */ } });
  });
  server.on("connection", socket => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    code: String(setting("code") ?? "") || "FC2-TEST0-TEST0-TEST0-TEST0-TEST0-TEST0-TEST0-TEST0",
    requests,
    script: list,
    inFlight: () => inFlight,
    sockets: () => sockets.size,
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}
