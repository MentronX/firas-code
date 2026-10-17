import test from "node:test";
import assert from "node:assert/strict";
import { createSseParser, readSse, readBodyText } from "../../src/link/sse.js";
import { FirasLinkError, isAbortError } from "../../src/link/errors.js";

const enc = new TextEncoder();

function parseAll(text) {
  const parser = createSseParser();
  return [...parser.push(text), ...parser.end()];
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const stream = chunks => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
    controller.close();
  },
});

test("parses event/data pairs separated by blank lines", () => {
  const events = parseAll("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  assert.deepEqual(events, [{ event: "a", data: "1" }, { event: "b", data: "2" }]);
});

test("accepts CRLF, lone CR and LF line endings", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    const events = parseAll(`event: x${eol}data: {"a":1}${eol}${eol}event: y${eol}data: two${eol}${eol}`);
    assert.deepEqual(events, [{ event: "x", data: '{"a":1}' }, { event: "y", data: "two" }], JSON.stringify(eol));
  }
});

test("a CRLF cut between two chunks is one line break, not an early dispatch", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push("event: x\r\ndata: 1\r"), []);
  // The "\n" completes the CRLF; the "\r" after it is the blank line that ends event x.
  assert.deepEqual(parser.push("\n\r"), [{ event: "x", data: "1" }]);
  assert.deepEqual(parser.push("\nevent: y\r\ndata: 2\r\n\r\n"), [{ event: "y", data: "2" }]);
});

test("comments and keep-alives are ignored", () => {
  assert.deepEqual(parseAll(": keep-alive\n\n: hello\nevent: a\n: inside\ndata: 1\n\n"), [{ event: "a", data: "1" }]);
});

test("multi-line data is joined with a line feed", () => {
  assert.deepEqual(parseAll("data: one\ndata: two\ndata:\ndata: four\n\n"), [{ event: "message", data: "one\ntwo\n\nfour" }]);
});

test("only one leading space is stripped from a value", () => {
  assert.deepEqual(parseAll("event:  spaced\ndata:  two spaces\n\n"), [{ event: " spaced", data: " two spaces" }]);
  assert.deepEqual(parseAll("event:tight\ndata:x\n\n"), [{ event: "tight", data: "x" }]);
});

test("a missing event line falls back to the type inside the data", () => {
  assert.deepEqual(parseAll('data: {"type":"message_stop"}\n\n'), [{ event: "message_stop", data: '{"type":"message_stop"}' }]);
  assert.deepEqual(parseAll("data: plain text\n\n"), [{ event: "message", data: "plain text" }]);
  assert.deepEqual(parseAll('data: {"nothing":1}\n\n'), [{ event: "message", data: '{"nothing":1}' }]);
});

test("an explicit event line wins over the data type", () => {
  assert.deepEqual(parseAll('event: ping\ndata: {"type":"other"}\n\n'), [{ event: "ping", data: '{"type":"other"}' }]);
});

test("an event with no data is dropped and does not leak its name into the next one", () => {
  assert.deepEqual(parseAll("event: lonely\n\ndata: 1\n\n"), [{ event: "message", data: "1" }]);
});

test("lines without a colon are fields with an empty value; unknown fields are ignored", () => {
  assert.deepEqual(parseAll("data\n\nid: 7\nretry: 100\nweird: x\ndata: ok\n\n"), [{ event: "message", data: "" }, { event: "message", data: "ok" }]);
});

test("a leading byte-order mark is ignored", () => {
  assert.deepEqual(parseAll(String.fromCharCode(0xfeff) + "event: a\ndata: 1\n\n"), [{ event: "a", data: "1" }]);
});

test("an event still open at the end of the stream is delivered", () => {
  assert.deepEqual(parseAll("event: a\ndata: 1\n\nevent: b\ndata: 2"), [{ event: "a", data: "1" }, { event: "b", data: "2" }]);
  assert.deepEqual(parseAll("event: a\ndata: 1\n"), [{ event: "a", data: "1" }]);
});

test("an oversized event is refused instead of eating memory", () => {
  const parser = createSseParser({ maxEventChars: 100 });
  assert.throws(() => parser.push("data: " + "x".repeat(200) + "\n"), error => error instanceof FirasLinkError && error.code === "bad_response");
  const second = createSseParser({ maxEventChars: 100 });
  assert.throws(() => second.push("x".repeat(200)), error => error instanceof FirasLinkError);
});

const SAMPLE = [
  "event: message_start\r\ndata: {\"type\":\"message_start\"}\r\n\r\n",
  ": ping\r\n\r\n",
  "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"مرحباً 🌍 بالعالم\"}}\n\n",
  "data: {\"type\":\"multi\"}\ndata: second line\n\n",
  "\r\r",
  "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
].join("");

test("every two-way split of the stream gives the same events (string chunks)", () => {
  const expected = parseAll(SAMPLE);
  assert.equal(expected.length, 4);
  for (let cut = 0; cut <= SAMPLE.length; cut++) {
    const parser = createSseParser();
    const got = [...parser.push(SAMPLE.slice(0, cut)), ...parser.push(SAMPLE.slice(cut)), ...parser.end()];
    assert.deepEqual(got, expected, `cut at ${cut}`);
  }
});

test("one character at a time gives the same events", () => {
  const expected = parseAll(SAMPLE);
  const parser = createSseParser();
  const got = [];
  for (const char of SAMPLE) got.push(...parser.push(char));
  got.push(...parser.end());
  assert.deepEqual(got, expected);
});

test("readSse decodes UTF-8 characters cut at every byte boundary", async () => {
  const bytes = enc.encode(SAMPLE);
  const expected = parseAll(SAMPLE);
  for (let cut = 0; cut <= bytes.length; cut++) {
    const got = await collect(readSse(stream([bytes.subarray(0, cut), bytes.subarray(cut)])));
    assert.deepEqual(got, expected, `cut at byte ${cut}`);
  }
});

test("readSse works byte by byte, with Arabic and emoji intact", async () => {
  const bytes = enc.encode(SAMPLE);
  const chunks = [...bytes].map(byte => Uint8Array.of(byte));
  const got = await collect(readSse(stream(chunks)));
  assert.deepEqual(got, parseAll(SAMPLE));
  assert.match(got[1].data, /مرحباً 🌍 بالعالم/);
});

test("readSse accepts an array of string chunks and an async iterable", async () => {
  const expected = parseAll(SAMPLE);
  assert.deepEqual(await collect(readSse([SAMPLE.slice(0, 40), SAMPLE.slice(40)])), expected);
  async function* chunks() { yield enc.encode(SAMPLE.slice(0, 50)); yield enc.encode(SAMPLE.slice(50)); }
  assert.deepEqual(await collect(readSse(chunks())), expected);
});

test("readSse ends cleanly on an empty body", async () => {
  assert.deepEqual(await collect(readSse(stream([]))), []);
  assert.deepEqual(await collect(readSse(null)), []);
});

test("readSse times out after the idle limit with a stream_idle error and cancels the body", async () => {
  let cancelled = false;
  const silent = new ReadableStream({ start(controller) { controller.enqueue(enc.encode("data: 1\n\n")); }, cancel() { cancelled = true; } });
  const seen = [];
  await assert.rejects(async () => { for await (const event of readSse(silent, { idleMs: 40 })) seen.push(event); },
    error => error instanceof FirasLinkError && error.code === "stream_idle" && error.retryable === true);
  assert.deepEqual(seen, [{ event: "message", data: "1" }]);
  assert.equal(cancelled, true);
});

test("an abort ends readSse with an AbortError and cancels the body", async () => {
  let cancelled = false;
  const silent = new ReadableStream({ cancel() { cancelled = true; } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(async () => { for await (const _ of readSse(silent, { signal: controller.signal })) { /* nothing arrives */ } },
    error => isAbortError(error) && error.name === "AbortError");
  assert.equal(cancelled, true);
});

test("an already aborted signal throws at once", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => { for await (const _ of readSse(stream(["data: 1\n\n"]), { signal: controller.signal })) { /* unreachable */ } }, isAbortError);
});

test("stopping early (break) cancels the underlying stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(enc.encode("data: 1\n\ndata: 2\n\n")); },
    cancel() { cancelled = true; },
  });
  for await (const event of readSse(body)) { assert.equal(event.data, "1"); break; }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
});

test("a stream that errors becomes a network error", async () => {
  let pulls = 0;
  const broken = new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(enc.encode("data: 1\n\n"));
      else controller.error(new TypeError("terminated"));
    },
  });
  const seen = [];
  await assert.rejects(async () => { for await (const event of readSse(broken)) seen.push(event.data); },
    error => error instanceof FirasLinkError && error.code === "network_reset");
  assert.deepEqual(seen, ["1"]);
});

test("readBodyText reads a whole body and caps it", async () => {
  assert.deepEqual(await readBodyText(stream(["مرحبا ", "بك"])), { text: "مرحبا بك", truncated: false });
  const capped = await readBodyText(stream(["x".repeat(50), "y".repeat(50)]), { limit: 60 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.text.length, 60);
});
