import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { errorReply, midStreamError, textReply } from "../helpers/mock-service.js";
import { createServiceClient, normalizeOrigin } from "../../src/link/client.js";
import { FirasLinkError, redactHeaders } from "../../src/link/errors.js";
import { setLang } from "../../src/i18n/index.js";
import { ROUTE_PREFIX } from "../../src/brand.js";
import { CODE, REQUEST, recordingSleep, run, runToError, setup } from "./util.js";

const ROUTE = ROUTE_PREFIX;

// ---- checkAccess -------------------------------------------------------------------------------

test("checkAccess returns the model's display name", async () => {
  const { service, client } = await setup([]);
  try {
    assert.deepEqual(await client.checkAccess(), { ok: true, modelName: "Firas Code 2" });
    const [request] = service.requests;
    assert.equal(request.method, "GET");
    assert.equal(request.path, ROUTE + "/v1/models");
    assert.equal(request.headers.authorization, "Bearer " + CODE);
    assert.equal(request.headers["x-firas-client"], "cli");
    assert.equal(request.headers["content-type"], undefined, "a GET has no body type");
    assert.equal(request.headers.accept, "application/json");
  } finally { await service.close(); }
});

test("checkAccess uses whatever display name the service reports", async () => {
  const script = [];
  script.modelName = "Firas Code 2 Preview";
  const { service, client } = await setup(script);
  try {
    assert.equal((await client.checkAccess()).modelName, "Firas Code 2 Preview");
  } finally { await service.close(); }
});

test("checkAccess maps a refused code to access_invalid, and an old one to access_expired", async () => {
  for (const [deny, code, pattern] of [[true, "access_invalid", /isn't valid/], ["invalid", "access_invalid", /isn't valid/], ["expired", "access_expired", /expired/]]) {
    const script = [];
    script.denyModels = deny;
    const { service, client, sleeps } = await setup(script);
    try {
      await assert.rejects(client.checkAccess(), error => {
        assert.ok(error instanceof FirasLinkError);
        assert.equal(error.code, code);
        assert.equal(error.status, 401);
        assert.equal(error.retryable, false);
        assert.match(error.userMessage, pattern);
        return true;
      });
      assert.equal(service.requests.length, 1, "a refused code is not retried");
      assert.deepEqual(sleeps, []);
    } finally { await service.close(); }
  }
});

test("a code the service does not know is refused with access_invalid", async () => {
  const { service, client } = await setup([], { service: { code: "FC2-RIGHT-RIGHT-RIGHT-RIGHT-RIGHT-RIGHT-RIGHT-RIGHT" } });
  try {
    await assert.rejects(client.checkAccess(), error => error.code === "access_invalid");
  } finally { await service.close(); }
});

test("the service accepts the code however it was typed (case, dashes, spaces)", async () => {
  const messy = ` ${CODE.toLowerCase()}\n`;
  const { service } = await setup([]);
  try {
    const client = createServiceClient({ origin: service.origin, getCode: () => messy, sleep: recordingSleep().sleep });
    assert.equal((await client.checkAccess()).ok, true);
    assert.equal(service.requests[0].headers.authorization, "Bearer " + CODE.toLowerCase(), "whitespace is removed, nothing else is changed");
  } finally { await service.close(); }
});

test("getCode is read for every call, and may be async", async () => {
  const { service } = await setup([textReply("a"), textReply("b")], { service: { code: undefined } });
  try {
    let current = "FC2-AAAAA-AAAAA";
    const client = createServiceClient({ origin: service.origin, getCode: async () => current, sleep: recordingSleep().sleep });
    await run(client);
    current = "FC2-BBBBB-BBBBB";
    await run(client);
    assert.deepEqual(service.requests.map(request => request.headers.authorization), ["Bearer FC2-AAAAA-AAAAA", "Bearer FC2-BBBBB-BBBBB"]);
  } finally { await service.close(); }
});

test("no code at all: access_missing, and nothing is sent", async () => {
  const { service } = await setup([textReply("never")]);
  try {
    for (const getCode of [() => "", () => "   ", () => undefined, async () => null, undefined]) {
      const client = createServiceClient({ origin: service.origin, getCode, lang: "en", sleep: recordingSleep().sleep });
      await assert.rejects(client.checkAccess(), error => error.code === "access_missing" && /access code/.test(error.userMessage));
      await assert.rejects(runToError(client).then(({ error }) => { throw error; }), error => error.code === "access_missing");
      await assert.rejects(client.library({ tool: "search" }), error => error.code === "access_missing");
    }
    assert.equal(service.requests.length, 0);
  } finally { await service.close(); }
});

test("a code with characters that cannot travel in a header is refused locally", async () => {
  const { service } = await setup([]);
  try {
    const client = createServiceClient({ origin: service.origin, getCode: () => "FC2-ÄÖÜ-مرحبا", lang: "en", sleep: recordingSleep().sleep });
    await assert.rejects(client.checkAccess(), error => error.code === "access_invalid" && error.status === 0);
    assert.equal(service.requests.length, 0);
  } finally { await service.close(); }
});

// ---- library -----------------------------------------------------------------------------------

test("library posts the body and returns {status, body}", async () => {
  const script = [];
  script.library = (body) => ({ status: 200, body: { ok: true, text: "found " + body.query, count: 2 } });
  const { service, client } = await setup(script);
  try {
    const result = await client.library({ tool: "search", query: "نموذج تسجيل الدخول", limit: 3 });
    assert.deepEqual(result, { status: 200, body: { ok: true, text: "found نموذج تسجيل الدخول", count: 2 } });
    const [request] = service.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.path, ROUTE + "/library");
    assert.equal(request.headers.authorization, "Bearer " + CODE);
    assert.equal(request.headers["x-firas-client"], "cli");
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(request.body, { tool: "search", query: "نموذج تسجيل الدخول", limit: 3 });
  } finally { await service.close(); }
});

test("library-level errors with 4xx/5xx statuses are returned, not thrown, and never retried", async () => {
  const cases = [
    { status: 400, body: { ok: false, error: "invalid_request" } },
    { status: 402, body: { ok: false, error: "locked" } },
    { status: 404, body: { ok: false, error: "not_found" } },
    { status: 413, body: { ok: false, error: "request_too_large" } },
    { status: 429, body: { ok: false, error: "quota_exceeded" }, headers: { "retry-after": "10" } },
    { status: 429, body: { ok: false, error: "rate_limited" }, headers: { "retry-after": "10" } },
    { status: 502, body: { ok: false, error: "upstream_failed" } },
    { status: 503, body: { ok: false, error: "library_unavailable" } },
  ];
  for (const answer of cases) {
    const script = [];
    script.library = answer;
    const { service, client, sleeps } = await setup(script);
    try {
      assert.deepEqual(await client.library({ tool: "component" }), { status: answer.status, body: answer.body }, answer.body.error);
      assert.equal(service.requests.length, 1);
      assert.deepEqual(sleeps, []);
    } finally { await service.close(); }
  }
});

test("library: refusals about the caller throw, with the right localized error", async () => {
  for (const [status, name, code] of [[401, "access_invalid", "access_invalid"], [401, "access_expired", "access_expired"], [403, "approval_required", "approval_required"], [400, "client_required", "client_required"]]) {
    const script = [];
    script.library = { status, body: { ok: false, error: name } };
    const { service, client } = await setup(script);
    try {
      await assert.rejects(client.library({ tool: "search" }), error => {
        assert.ok(error instanceof FirasLinkError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        return true;
      });
    } finally { await service.close(); }
  }
});

test("library: a service-level refusal (code mismatch at the service itself) throws access_invalid", async () => {
  const { service } = await setup([], { service: { code: "FC2-RIGHT-RIGHT" } });
  try {
    const client = createServiceClient({ origin: service.origin, getCode: () => "FC2-WRONG-WRONG", lang: "en", sleep: recordingSleep().sleep });
    await assert.rejects(client.library({ tool: "search" }), error => error.code === "access_invalid" && error.status === 401);
  } finally { await service.close(); }
});

test("library: a proxy's HTML error page is a transport problem and is retried", async () => {
  const script = [];
  script.library = { status: 502, body: "<html>Bad gateway</html>" };
  const { service, client, sleeps } = await setup(script);
  try {
    await assert.rejects(client.library({ tool: "search" }), error => error.code === "unavailable" && error.status === 502);
    assert.equal(service.requests.length, 3, "1 try + 2 retries");
    assert.deepEqual(sleeps, [800, 2000]);
  } finally { await service.close(); }
});

test("library: a 200 that is not a JSON object is a bad_response", async () => {
  const script = [];
  script.library = { status: 200, body: "[1,2,3]" };
  const { service, client } = await setup(script);
  try {
    await assert.rejects(client.library({}), error => error.code === "bad_response");
  } finally { await service.close(); }
});

test("library: a large answer comes through whole", async () => {
  const text = "كود ".repeat(100_000);
  const script = [];
  script.library = { status: 200, body: { ok: true, text } };
  const { service, client } = await setup(script);
  try {
    assert.equal((await client.library({ tool: "component" })).body.text, text);
  } finally { await service.close(); }
});

// ---- origin ------------------------------------------------------------------------------------

test("origins are normalized: trailing slash, https by default, lower case, no path", () => {
  const cases = {
    "https://firasai.org": "https://firasai.org",
    "https://firasai.org/": "https://firasai.org",
    "firasai.org": "https://firasai.org",
    "  FirasAI.org/some/path?x=1#y  ": "https://firasai.org",
    "https://firasai.org:8443/": "https://firasai.org:8443",
    "https://firasai.org:443": "https://firasai.org",
    "http://localhost:3000/": "http://localhost:3000",
    "http://127.0.0.1:8080": "http://127.0.0.1:8080",
    "http://[::1]:9000": "http://[::1]:9000",
    "http://dev.localhost": "http://dev.localhost",
    "": "https://firasai.org",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(normalizeOrigin(input), expected, JSON.stringify(input));
});

test("origins that are not http(s), or would send the code in clear over the internet, are refused", () => {
  for (const bad of ["ftp://firasai.org", "file:///etc/passwd", "javascript:alert(1)", "ws://firasai.org", "http://firasai.org", "http://192.168.1.5:3000", "https://", "https://exa mple.com", "://x", "data:text/html,hi"]) {
    assert.throws(() => normalizeOrigin(bad), error => error instanceof FirasLinkError && error.code === "bad_origin", bad);
  }
  assert.throws(() => createServiceClient({ origin: "ftp://x", getCode: () => CODE }), error => error.code === "bad_origin");
  assert.match(new FirasLinkError("bad_origin", { lang: "ar" }).userMessage, /https/);
});

test("the client exposes its normalized origin and builds URLs from it", async () => {
  const { service } = await setup([]);
  try {
    const client = createServiceClient({ origin: service.origin + "/", getCode: () => CODE, sleep: recordingSleep().sleep });
    assert.equal(client.origin, service.origin);
    await client.checkAccess();
    assert.equal(service.requests[0].path, ROUTE + "/v1/models");
  } finally { await service.close(); }
});

// ---- language ----------------------------------------------------------------------------------

test("lang may be a string or a function, and is independent of the global language", async () => {
  setLang("en");
  let lang = "ar";
  const { service, client } = await setup([errorReply(401, "access_invalid"), errorReply(401, "access_invalid")], { client: { lang: () => lang } });
  try {
    const first = await runToError(client);
    assert.match(first.error.userMessage, /[\u0600-\u06ff]/);
    lang = "en";
    const second = await runToError(client);
    assert.doesNotMatch(second.error.userMessage, /[\u0600-\u06ff]/);
  } finally { await service.close(); setLang("en"); }
});

test("errors born while reading the stream use the client's language too", async () => {
  setLang("en");
  const entry = { events: textReply("partial text").events.slice(0, 5), hang: true };
  const { service, client } = await setup([entry], { client: { lang: "ar", timeouts: { idleMs: 80 } } });
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "stream_idle");
    assert.match(error.userMessage, /[\u0600-\u06ff]/);
  } finally { await service.close(); }
});

test("without a lang option the current global language is used", async () => {
  setLang("ar");
  const { service, client } = await setup([errorReply(401, "access_invalid")], { client: { lang: undefined } });
  try {
    const { error } = await runToError(client);
    assert.match(error.userMessage, /[\u0600-\u06ff]/);
  } finally { await service.close(); setLang("en"); }
});

// ---- the access code never leaks ---------------------------------------------------------------

function everythingPrintable(error) {
  const parts = [
    String(error), error.message, error.userMessage, error.stack || "", error.detail || "",
    JSON.stringify(error), inspect(error, { depth: 10, showHidden: true }),
    inspect({ error }, { depth: 10, showHidden: true }),
  ];
  try { parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error))); } catch { /* circular */ }
  return parts.join("\n").toLowerCase();
}

test("the access code appears in no error, however the failure happened", async () => {
  const echoing = `You sent Bearer ${CODE} / ${CODE.toLowerCase()} / ${CODE.slice(4, 20)}`;
  const failures = [];
  const scripts = [
    [errorReply(401, "access_invalid", echoing)],
    [errorReply(401, "access_expired", echoing)],
    [errorReply(400, "invalid_request", echoing)],
    Array.from({ length: 5 }, () => errorReply(503, "unavailable", echoing)),
    [errorReply(429, "daily_limit", echoing)],
    [{ ...midStreamError("text", { message: echoing }) }],
    [{ status: 502, body: echoing }, { status: 502, body: echoing }, { status: 502, body: echoing }, { status: 502, body: echoing }, { status: 502, body: echoing }],
  ];
  for (const script of scripts) {
    const { service, client } = await setup(script);
    try { failures.push((await runToError(client)).error); } finally { await service.close(); }
  }
  const dead = await setup([]);
  const origin = dead.service.origin;
  await dead.service.close();
  const probe = createServiceClient({ origin, getCode: () => CODE, lang: "en", sleep: recordingSleep().sleep });
  failures.push((await runToError(probe)).error);
  const refused = await setup([], { service: { code: "FC2-OTHER-OTHER" } });
  try { failures.push(await refused.client.checkAccess().catch(error => error)); } finally { await refused.service.close(); }
  const libraryScript = [];
  libraryScript.library = { status: 401, body: { ok: false, error: echoing } };
  const lib = await setup(libraryScript);
  try { failures.push(await lib.client.library({}).catch(error => error)); } finally { await lib.service.close(); }

  assert.ok(failures.length >= 10);
  const pieces = [CODE, CODE.slice(4, 20), CODE.slice(10, 30)].map(piece => piece.toLowerCase());
  for (const error of failures) {
    assert.ok(error instanceof FirasLinkError, String(error));
    const printed = everythingPrintable(error);
    for (const piece of pieces) assert.ok(!printed.includes(piece), `${error.code} leaked "${piece}"`);
    assert.ok(!/bearer\s+fc2/.test(printed), `${error.code} leaked a bearer header`);
  }
});

test("redactHeaders is how request headers are shown anywhere", () => {
  const shown = JSON.stringify(redactHeaders({ authorization: "Bearer " + CODE, "x-firas-client": "cli" }));
  assert.ok(!shown.includes(CODE.slice(4, 14)));
  assert.match(shown, /x-firas-client/);
});

test("a stream that succeeds reveals nothing either", async () => {
  const { service, client } = await setup([textReply("fine")]);
  try {
    const { events, acc } = await run(client);
    const printed = JSON.stringify([events, acc.message(), acc.usage]);
    assert.ok(!printed.includes(CODE.slice(4, 14)));
  } finally { await service.close(); }
});

test("requests carry the request unchanged except for model default and stream", async () => {
  const { service, client } = await setup([textReply("x")]);
  try {
    const request = { ...REQUEST, model: "explicit-model", tools: [{ name: "Read", description: "d", input_schema: { type: "object", properties: {} } }] };
    await run(client, request);
    assert.equal(service.requests[0].body.model, "explicit-model");
    assert.deepEqual(service.requests[0].body.tools, request.tools);
  } finally { await service.close(); }
});
