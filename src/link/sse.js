// Server-Sent Events, read incrementally off a fetch body.
//
//   createSseParser()   push(text) -> events[]   end() -> events[]      (the pure part; easy to test)
//   readSse(body, o)    async generator of { event, data } over a ReadableStream (or any async iterable)
//   readBodyText(body, o)  the whole body as capped text, with the same idle/abort rules (error bodies, JSON answers)
//
// Decisions worth knowing:
//  - A line ends at LF, CRLF or a lone CR. A CR at the very end of a chunk is remembered, so a CRLF that
//    is cut between two chunks is still ONE line break (otherwise it would look like a blank line and
//    dispatch the event early).
//  - Bytes are decoded with a streaming TextDecoder, so an Arabic letter cut between two chunks is not
//    damaged.
//  - `event` is the `event:` field; when the server sends none it is the `type` inside the JSON data,
//    else "message". `data` is always a string (multi-line data joined with LF).
//  - An event still open when the stream ends is delivered if it has data (a truncated JSON then fails in
//    the caller, which is the honest outcome) instead of being dropped silently.
//  - `idleMs` of silence (no bytes at all, pings included) ends the read with a FirasLinkError so a dead
//    connection cannot hang the terminal forever. An AbortSignal ends it with an AbortError.
import { FirasLinkError, abortError, errorFromNetwork, isAbortError } from "./errors.js";

/** No bytes for this long = the connection is dead (the service itself gives up at the same number). */
export const SSE_IDLE_MS = 180_000;
const MAX_EVENT_CHARS = 32 * 1024 * 1024;

function inferEvent(data) {
  try {
    const type = JSON.parse(data)?.type;
    return typeof type === "string" && type ? type : "message";
  } catch {
    return "message";
  }
}

export function createSseParser({ maxEventChars = MAX_EVENT_CHARS } = {}) {
  let partial = "";
  let pendingCr = false;
  let atStart = true;
  let eventName = "";
  let dataLines = [];
  let dataChars = 0;
  let ready = [];

  const reset = () => { eventName = ""; dataLines = []; dataChars = 0; };

  function dispatch() {
    if (!dataLines.length) { reset(); return; }
    const data = dataLines.join("\n");
    ready.push({ event: eventName || inferEvent(data), data });
    reset();
  }

  function line(text) {
    if (text === "") { dispatch(); return; }
    if (text.charCodeAt(0) === 58) return; // ":" comment (keep-alive)
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") {
      dataLines.push(value);
      dataChars += value.length + 1;
      if (dataChars > maxEventChars) throw new FirasLinkError("bad_response", { detail: "event too large" });
    }
    // id: and retry: are not used; reconnection is the client's own retry policy.
  }

  function take() {
    const out = ready;
    ready = [];
    return out;
  }

  return {
    push(text) {
      if (!text) return take();
      if (atStart) {
        atStart = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      let from = 0;
      if (pendingCr) {
        pendingCr = false;
        if (text.charCodeAt(0) === 10) from = 1;
      }
      let start = from;
      for (let i = from; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch !== 10 && ch !== 13) continue;
        line(partial + text.slice(start, i));
        partial = "";
        if (ch === 13) {
          if (i + 1 < text.length) { if (text.charCodeAt(i + 1) === 10) i++; }
          else pendingCr = true;
        }
        start = i + 1;
      }
      partial += text.slice(start);
      if (partial.length > maxEventChars) throw new FirasLinkError("bad_response", { detail: "line too long" });
      return take();
    },
    end() {
      if (partial) { line(partial); partial = ""; }
      dispatch();
      return take();
    },
  };
}

// ---- reading -----------------------------------------------------------------------------------

/** Wraps a ReadableStream, an async iterable, a string/bytes or an array of chunks as { read(), cancel() }. */
function openSource(body) {
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    return { read: () => reader.read(), cancel: () => { reader.cancel().catch(() => {}); } };
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const iterator = body[Symbol.asyncIterator]();
    return {
      read: () => iterator.next(),
      cancel: () => { try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* already finished */ } },
    };
  }
  const chunks = body == null ? [] : Array.isArray(body) ? body : [body];
  let at = 0;
  return {
    read: async () => (at < chunks.length ? { value: chunks[at++], done: false } : { value: undefined, done: true }),
    cancel: () => {},
  };
}

/** One read(), raced against the idle timer and the abort signal. */
function nextChunk(source, signal, idleMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError());
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (idleMs > 0) timer = setTimeout(() => finish(reject, new FirasLinkError("stream_idle")), idleMs);
    source.read().then(result => finish(resolve, result), error => finish(reject, error));
  });
}

/** nextChunk() with its failures turned into the link's own errors (AbortError, stream_idle, network_*). */
async function pull(source, signal, idleMs) {
  try {
    return await nextChunk(source, signal, idleMs);
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw abortError();
    throw error instanceof FirasLinkError ? error : errorFromNetwork(error);
  }
}

/**
 * The whole body as text, up to `limit` characters (`truncated` says whether more was left behind).
 * Same idle/abort rules as readSse. Used for error bodies and plain JSON answers.
 */
export async function readBodyText(body, { signal, idleMs = 60_000, limit = 8 * 1024 * 1024 } = {}) {
  const source = openSource(body);
  const decoder = new TextDecoder("utf-8");
  let text = "";
  try {
    for (;;) {
      const result = await pull(source, signal, idleMs);
      if (result.done) break;
      text += typeof result.value === "string" ? result.value : decoder.decode(result.value, { stream: true });
      if (text.length > limit) break;
    }
    text += decoder.decode();
  } finally {
    source.cancel();
  }
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}

/**
 * Yields `{ event, data }` for each Server-Sent Event in `body`. Stops quietly after the last event; throws
 * FirasLinkError (stream_idle, or a network_* code if the connection breaks) or an AbortError. Whatever
 * the ending, the underlying stream is cancelled so the socket is released.
 */
export async function* readSse(body, { signal, idleMs = SSE_IDLE_MS, maxEventChars } = {}) {
  const source = openSource(body);
  const parser = createSseParser({ maxEventChars });
  const decoder = new TextDecoder("utf-8");
  let finished = false;
  try {
    for (;;) {
      const result = await pull(source, signal, idleMs);
      if (result.done) break;
      const chunk = result.value;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      for (const event of parser.push(text)) yield event;
    }
    for (const event of parser.push(decoder.decode())) yield event;
    for (const event of parser.end()) yield event;
    finished = true;
  } finally {
    if (!finished) source.cancel();
  }
}
