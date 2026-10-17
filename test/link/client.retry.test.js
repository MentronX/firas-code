import test from "node:test";
import assert from "node:assert/strict";
import { errorReply, midStreamError, textReply } from "../helpers/mock-service.js";
import { createServiceClient } from "../../src/link/client.js";
import { FirasLinkError, abortError, isAbortError } from "../../src/link/errors.js";
import { CODE, REQUEST, recordingSleep, run, runToError, setup, until } from "./util.js";

const posts = service => service.requests.filter(request => request.path.endsWith("/v1/messages"));

test("429 busy then success: one backoff of 800 ms, one clean answer", async () => {
  const { service, client, sleeps } = await setup([errorReply(429, "busy"), textReply("fine now")]);
  try {
    const { acc } = await run(client);
    assert.equal(acc.text, "fine now");
    assert.deepEqual(sleeps, [800]);
    assert.equal(posts(service).length, 2);
  } finally { await service.close(); }
});

test("503 five times gives up after 4 retries with the documented backoff", async () => {
  const script = Array.from({ length: 6 }, () => errorReply(503, "unavailable"));
  const { service, client, sleeps } = await setup(script);
  try {
    const { error } = await runToError(client);
    assert.ok(error instanceof FirasLinkError);
    assert.equal(error.code, "unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.deepEqual(sleeps, [800, 2000, 5000, 10000]);
    assert.equal(posts(service).length, 5, "1 try + 4 retries");
    assert.match(error.userMessage, /temporarily unavailable/);
  } finally { await service.close(); }
});

test("every retryable status is retried, every other 4xx is not", async () => {
  for (const status of [429, 500, 502, 503, 504, 529]) {
    const { service, client, sleeps } = await setup([errorReply(status, "unavailable"), textReply("ok")]);
    try {
      assert.equal((await run(client)).acc.text, "ok", String(status));
      assert.deepEqual(sleeps, [800], String(status));
    } finally { await service.close(); }
  }
  for (const [status, code] of [[400, "invalid_request"], [400, "upstream_refused"], [401, "access_invalid"], [403, "request_rejected"], [404, "not_found"], [413, "request_too_large"], [422, "weird"]]) {
    const { service, client, sleeps } = await setup([errorReply(status, code, "x", { shouldRetry: true }), textReply("must not be used")]);
    try {
      const { error } = await runToError(client);
      assert.equal(error.status, status);
      assert.equal(error.retryable, false, `${status} ${code}`);
      assert.deepEqual(sleeps, []);
      assert.equal(posts(service).length, 1, `${status} ${code}`);
    } finally { await service.close(); }
  }
});

test("x-should-retry: false stops retrying even for a retryable status", async () => {
  const { service, client, sleeps } = await setup([errorReply(503, "unavailable", undefined, { shouldRetry: false }), textReply("not used")]);
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "unavailable");
    assert.equal(error.retryable, false);
    assert.deepEqual(sleeps, []);
    assert.equal(posts(service).length, 1);
  } finally { await service.close(); }
});

test("daily_limit is final and says it resets tomorrow", async () => {
  const { service, client, sleeps } = await setup([errorReply(429, "daily_limit", undefined, { retryAfter: 18000 }), textReply("not used")], { client: { lang: "ar" } });
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "daily_limit");
    assert.equal(error.status, 429);
    assert.equal(error.retryable, false);
    assert.equal(error.retryAfterMs, 18_000_000, "the real figure is kept for the message");
    assert.deepEqual(sleeps, []);
    assert.match(error.userMessage, /غداً/);
    assert.equal(posts(service).length, 1);
  } finally { await service.close(); }
});

test("not_configured is reported at once instead of waiting 18 seconds", async () => {
  const { service, client, sleeps } = await setup([errorReply(503, "not_configured", undefined, { shouldRetry: true }), textReply("not used")]);
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "not_configured");
    assert.deepEqual(sleeps, []);
    assert.equal(posts(service).length, 1);
  } finally { await service.close(); }
});

test("retry-after replaces the backoff, capped at 30 seconds", async () => {
  const { service, client, sleeps } = await setup([
    errorReply(429, "busy", undefined, { retryAfter: 2 }),
    errorReply(429, "busy", undefined, { retryAfter: 99 }),
    errorReply(429, "busy", undefined, { retryAfter: 0 }),
    errorReply(429, "busy"),
    textReply("done"),
  ]);
  try {
    assert.equal((await run(client)).acc.text, "done");
    assert.deepEqual(sleeps, [2000, 30000, 5000, 10000], "attempt 3 and 4 fall back to their own backoff slot");
  } finally { await service.close(); }
});

test("network failures are retried, then reported as network errors", async () => {
  const { service, sleeps } = await setup([textReply("unused")]);
  let calls = 0;
  const failing = createServiceClient({
    origin: service.origin, getCode: () => CODE, lang: "en", sleep: recordingSleep().sleep,
    fetchImpl: async () => { calls++; throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); },
  });
  try {
    const { error } = await runToError(failing);
    assert.equal(error.code, "network_refused");
    assert.equal(error.retryable, true);
    assert.equal(error.status, 0);
    assert.equal(calls, 5);
    assert.match(error.userMessage, /refused/);
    assert.equal(service.requests.length, 0);
    assert.deepEqual(sleeps, []);
  } finally { await service.close(); }
});

test("two network failures then success gives the answer", async () => {
  const { service } = await setup([textReply("third time lucky")]);
  const sleeps = [];
  let calls = 0;
  const flaky = createServiceClient({
    origin: service.origin, getCode: () => CODE, lang: "en",
    sleep: async ms => { sleeps.push(ms); },
    fetchImpl: (url, init) => {
      if (++calls <= 2) return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
      return fetch(url, init);
    },
  });
  try {
    assert.equal((await run(flaky)).acc.text, "third time lucky");
    assert.deepEqual(sleeps, [800, 2000]);
  } finally { await service.close(); }
});

test("a real refused connection is classified as network_refused", async () => {
  const { service } = await setup([]);
  const dead = service.origin;
  await service.close();
  const probe = createServiceClient({ origin: dead, getCode: () => CODE, lang: "en", sleep: recordingSleep().sleep });
  const { error } = await runToError(probe);
  assert.equal(error.code, "network_refused");
  assert.equal(error.retryable, true);
});

test("a service that never answers hits the headers timeout and is retried", async () => {
  const { service, client, sleeps } = await setup(Array.from({ length: 5 }, () => ({ silent: true })), { client: { timeouts: { headersMs: 40 } } });
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "network_timeout");
    assert.equal(posts(service).length, 5);
    assert.equal(sleeps.length, 4);
    await until(() => service.inFlight() === 0, { label: "the silent connections to be closed" });
  } finally { await service.close(); }
});

test("a fetch that ignores the abort signal still cannot hang the stream", async () => {
  const stuck = createServiceClient({
    origin: "https://firasai.org", getCode: () => CODE, sleep: recordingSleep().sleep,
    fetchImpl: () => new Promise(() => {}),
    timeouts: { headersMs: 30 },
  });
  const { error } = await runToError(stuck);
  assert.equal(error.code, "network_timeout");
});

test("an abort before the call sends nothing", async () => {
  const { service, client } = await setup([textReply("never")]);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(run(client, REQUEST, { signal: controller.signal }), error => isAbortError(error) && !(error instanceof FirasLinkError));
    assert.equal(service.requests.length, 0);
  } finally { await service.close(); }
});

test("an abort in the middle of a stream throws AbortError, is not retried and frees the connection", async () => {
  const partial = textReply("this answer is going to be interrupted half way through", { chunk: 5 });
  const { service, client, sleeps } = await setup([{ events: partial.events.slice(0, 8), hang: true }, textReply("must not be used")]);
  try {
    const controller = new AbortController();
    const seen = [];
    await assert.rejects(async () => {
      for await (const event of client.stream(REQUEST, { signal: controller.signal })) {
        seen.push(event.type);
        if (event.type === "text_delta") controller.abort();
      }
    }, error => error.name === "AbortError" && !(error instanceof FirasLinkError));
    assert.ok(seen.includes("text_delta"));
    assert.equal(posts(service).length, 1);
    assert.deepEqual(sleeps, []);
    await until(() => service.inFlight() === 0, { label: "the aborted response to close on the server" });
    await until(() => service.sockets() === 0, { label: "the socket to be released" });
  } finally { await service.close(); }
});

test("an abort while waiting for the first answer closes the connection", async () => {
  const { service, client } = await setup([{ silent: true }]);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(run(client, REQUEST, { signal: controller.signal }), isAbortError);
    await until(() => service.inFlight() === 0, { label: "the silent request to be closed" });
  } finally { await service.close(); }
});

test("an abort during the backoff pause ends the call without another request", async () => {
  const controller = new AbortController();
  const { service, client } = await setup([errorReply(503, "unavailable"), textReply("never")], {
    client: {
      sleep: (ms, signal) => new Promise((resolve, reject) => {
        queueMicrotask(() => controller.abort());
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
    },
  });
  try {
    await assert.rejects(run(client, REQUEST, { signal: controller.signal }), isAbortError);
    assert.equal(posts(service).length, 1);
  } finally { await service.close(); }
});

test("a sleep that ignores the signal still cannot outlive an abort", async () => {
  const controller = new AbortController();
  const { service, client } = await setup([errorReply(503, "unavailable"), textReply("never")], {
    client: { sleep: async () => { controller.abort(); } },
  });
  try {
    await assert.rejects(run(client, REQUEST, { signal: controller.signal }), isAbortError);
    assert.equal(posts(service).length, 1);
  } finally { await service.close(); }
});

test("leaving the loop early closes the connection", async () => {
  const partial = textReply("a long answer that the consumer abandons after the first piece", { chunk: 4 });
  const { service, client } = await setup([{ events: partial.events.slice(0, 7), hang: true }]);
  try {
    for await (const event of client.stream(REQUEST)) { if (event.type === "text_delta") break; }
    await until(() => service.inFlight() === 0, { label: "the abandoned stream to close" });
  } finally { await service.close(); }
});

test("a failure that is not a retry-worthy one carries the localized message in both languages", async () => {
  for (const [lang, pattern] of [["en", /isn't valid/], ["ar", /[\u0600-\u06ff]/]]) {
    const { service, client } = await setup([errorReply(401, "access_invalid", "Your key is wrong, English text")], { client: { lang } });
    try {
      const { error } = await runToError(client);
      assert.equal(error.code, "access_invalid");
      assert.equal(error.status, 401);
      assert.match(error.userMessage, pattern);
      assert.ok(!error.userMessage.includes("English text"));
    } finally { await service.close(); }
  }
});

test("a mid-stream busy error before content and then a hard failure is reported once", async () => {
  const { service, client, sleeps } = await setup([
    midStreamError("", { withText: false }), midStreamError("", { withText: false }),
    errorReply(401, "access_expired"),
  ]);
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "access_expired");
    assert.deepEqual(sleeps, [800, 2000]);
    assert.equal(posts(service).length, 3);
  } finally { await service.close(); }
});

test("onRetry hears about every wait before it starts, with the attempt count and the reason", async () => {
  const { service, client } = await setup([errorReply(429, "busy", undefined, { retryAfter: 3 }), errorReply(503, "unavailable"), textReply("ok")]);
  try {
    const heard = [];
    const { acc } = await run(client, REQUEST, { onRetry: info => heard.push({ attempt: info.attempt, max: info.max, delayMs: info.delayMs, code: info.error.code }) });
    assert.equal(acc.text, "ok");
    assert.deepEqual(heard, [
      { attempt: 1, max: 4, delayMs: 3000, code: "busy" },
      { attempt: 2, max: 4, delayMs: 2000, code: "unavailable" },
    ]);
  } finally { await service.close(); }
});

test("a throwing onRetry cannot break the retry, and a client-level onRetry is the default", async () => {
  const heard = [];
  const { service, client } = await setup([errorReply(429, "busy"), textReply("ok")], {
    client: { onRetry: info => { heard.push(info.attempt); throw new Error("status line crashed"); } },
  });
  try {
    assert.equal((await run(client)).acc.text, "ok");
    assert.deepEqual(heard, [1]);
  } finally { await service.close(); }
});

test("a redirect is never followed (the code must not wander) and is reported as a bad address", async () => {
  const { service, client, sleeps } = await setup([{ status: 302, headers: { location: "http://example.invalid/steal" }, body: "" }, textReply("not used")]);
  try {
    const { error } = await runToError(client);
    assert.equal(error.code, "bad_origin");
    assert.equal(error.retryable, false);
    assert.deepEqual(sleeps, []);
    assert.equal(posts(service).length, 1);
  } finally { await service.close(); }
});
