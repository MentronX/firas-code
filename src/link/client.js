// The service client: one object per session, three calls.
//
//   const client = createServiceClient({ origin, getCode, version, lang });
//   for await (const ev of client.stream(request, { signal })) ...   // normalized StreamEvents
//   await client.checkAccess({ signal })                              // { ok: true, modelName }
//   await client.library(body, { signal })                            // { status, body }
//
// Further options: `lang` may be a string or a function (so /lang changes apply at once);
// `onRetry({ attempt, max, delayMs, error })` is called before each automatic retry wait (also settable per
// stream call) so the screen can say "busy, trying again in 2 s"; and `sleep(ms, signal)`, `backoffMs`,
// `timeouts: { headersMs, idleMs, jsonMs }`, `platform` and `nodeVersion` exist so tests run instantly.
//
// Retry policy: before the first content event arrives, 429/500/502/503/504/529 and
// network failures are retried up to 4 times, waiting 0.8 s, 2 s, 5 s, 10 s (or the service's
// `retry-after`, at most 30 s). Never when the service said `x-should-retry: false`, never for other 4xx
// answers, never for codes that cannot heal in seconds (daily limit, server not set up). The stream's first
// event (`message_start`) is held back until a second event shows the answer is really coming, so a stream
// that opens and then fails (the service retries those itself) can still be retried without the caller ever
// seeing a half-started message. After a content event has gone out, a failure is thrown, not retried.
//
// The access code only ever travels in the `authorization` header. It is not stored, not logged and not
// put into any error; free-form text from the service is scrubbed of it before it is kept at all.
import { CLIENT_ID, DEFAULT_ORIGIN, MODEL_ID, NAME, ROUTE_PREFIX, VERSION } from "../brand.js";
import { FirasLinkError, abortError, errorFromHttp, errorFromNetwork, errorFromStreamEvent, isAbortError, userMessageFor } from "./errors.js";
import { SSE_IDLE_MS, readBodyText, readSse } from "./sse.js";
import { normalizeUsage } from "./accumulator.js";

export const BACKOFF_MS = Object.freeze([800, 2000, 5000, 10000]);
export const RETRY_AFTER_CAP_MS = 30_000;
const HEADERS_MS = 120_000;
// The library can spend ~45 s upstream for one component, plus its handshake.
const JSON_MS = 90_000;
const MAX_JSON_CHARS = 32 * 1024 * 1024;
const MAX_ERROR_CHARS = 16 * 1024;

// Library answers that are about the account or the app (who you are, which app you are), not about the library: thrown.
const ACCOUNT_CODES = new Set([
  "signin_required", "access_invalid", "access_expired", "client_required", "desktop_client_required",
  "approval_required", "owner_only", "not_configured",
]);

const isLoopback = host => host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);

/**
 * `firasai.org`, `https://firasai.org/` and `HTTPS://FirasAI.org/x?y#z` all become `https://firasai.org`.
 * Only http(s) is accepted, and plain http only for this machine, so the access code never crosses the
 * internet unencrypted. Throws FirasLinkError("bad_origin").
 */
export function normalizeOrigin(input) {
  let text = String(input ?? "").trim();
  if (!text) text = DEFAULT_ORIGIN;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = "https://" + text;
  let url;
  try { url = new URL(text); } catch { throw new FirasLinkError("bad_origin"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FirasLinkError("bad_origin");
  if (!url.hostname) throw new FirasLinkError("bad_origin");
  if (url.protocol === "http:" && !isLoopback(url.hostname)) throw new FirasLinkError("bad_origin");
  return url.origin;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const throwIfAborted = signal => { if (signal?.aborted) throw abortError(); };
const noop = () => {};

export function createServiceClient({
  origin = DEFAULT_ORIGIN,
  getCode,
  version = VERSION,
  lang,
  fetchImpl = fetch,
  sleep = defaultSleep,
  backoffMs = BACKOFF_MS,
  timeouts = {},
  platform = process.platform,
  nodeVersion = process.versions.node,
  onRetry,
} = {}) {
  const base = normalizeOrigin(origin);
  const root = base + ROUTE_PREFIX;
  const userAgent = `firas-code/${version} (${platform}; node ${nodeVersion})`;
  const limits = { headersMs: HEADERS_MS, idleMs: SSE_IDLE_MS, jsonMs: JSON_MS, ...timeouts };
  const currentLang = () => (typeof lang === "function" ? lang() : lang);
  const fail = (code, options) => new FirasLinkError(code, { lang: currentLang(), ...options });

  // The code is read fresh for every request, so /logout and a re-entered code take effect at once.
  async function readCode() {
    const raw = typeof getCode === "function" ? await getCode() : getCode;
    // Pasted codes often carry line-wrap spaces; the service ignores them too.
    const code = String(raw ?? "").replace(/\s+/g, "");
    if (!code) throw fail("access_missing");
    if (!/^[\x21-\x7e]+$/.test(code)) throw fail("access_invalid");
    return code;
  }

  async function prepare({ method, path, body, accept, totalMs = 0 }) {
    const code = await readCode();
    const headers = {
      "x-firas-client": CLIENT_ID,
      "user-agent": userAgent,
      authorization: "Bearer " + code,
      accept,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return { spec: { method, url: root + path, headers, body, totalMs }, secrets: [code] };
  }

  /** One request up to its response headers. The caller owns `release()`. */
  async function connect({ method, url, headers, body, totalMs }, outer) {
    throwIfAborted(outer);
    const controller = new AbortController();
    const state = { timedOut: false };
    const timeout = () => { state.timedOut = true; controller.abort(); };
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    const totalTimer = totalMs > 0 ? setTimeout(timeout, totalMs) : null;
    const headersTimer = setTimeout(timeout, limits.headersMs);
    const release = () => {
      clearTimeout(totalTimer);
      clearTimeout(headersTimer);
      outer?.removeEventListener("abort", onOuterAbort);
      // Aborting a finished exchange does nothing; aborting an unfinished one closes its socket.
      controller.abort();
    };
    const gone = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(abortError()), { once: true }));
    gone.catch(noop);
    let lost = false;
    let response;
    try {
      const pending = Promise.resolve(fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: "error" }));
      // A response that arrives after we gave up must still be closed.
      pending.then(late => { if (lost) Promise.resolve(late?.body?.cancel?.()).catch(noop); }, noop);
      response = await Promise.race([pending, gone]);
    } catch (error) {
      lost = true;
      release();
      if (outer?.aborted) throw abortError();
      if (state.timedOut) throw fail("network_timeout");
      throw errorFromNetwork(error, { lang: currentLang() });
    }
    clearTimeout(headersTimer);
    return { response, controller, state, release };
  }

  /** What a failure becomes: AbortError when the caller aborted, else a FirasLinkError. */
  function classify(caught, conn, signal) {
    if (signal?.aborted) return abortError();
    if (conn?.state.timedOut) return fail("network_timeout");
    if (caught instanceof FirasLinkError) {
      // Errors born in sse.js know nothing of this client's language setting.
      const wanted = currentLang();
      if (wanted) caught.userMessage = userMessageFor(caught.code, { status: caught.status, lang: wanted });
      return caught;
    }
    if (isAbortError(caught)) return fail("network");
    return errorFromNetwork(caught, { lang: currentLang() });
  }

  const retryDelay = (error, attempt) => (error.retryAfterMs > 0
    ? Math.min(error.retryAfterMs, RETRY_AFTER_CAP_MS)
    : backoffMs[Math.min(attempt, backoffMs.length - 1)]);

  /** Tells the caller (so a screen can say "busy, retrying in 2 s"), then waits. An abort ends the wait. */
  async function waitToRetry(error, attempt, max, signal, notify) {
    const delayMs = retryDelay(error, attempt);
    try { notify?.({ attempt: attempt + 1, max, delayMs, error }); } catch { /* a broken status line must not break the retry */ }
    await sleep(delayMs, signal);
    throwIfAborted(signal);
  }

  /** An error answer's body is read (capped) and turned into the error to throw. */
  async function failureOf(conn, secrets, signal) {
    let text = "";
    try {
      ({ text } = await readBodyText(conn.response.body, { signal: conn.controller.signal, idleMs: 15_000, limit: MAX_ERROR_CHARS }));
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
    }
    return errorFromHttp({ status: conn.response.status, headers: conn.response.headers, text, secrets, lang: currentLang() });
  }

  /** A request/response exchange with the retry policy, for the calls that are not streams. */
  async function exchange(spec, signal, maxRetries, handle) {
    throwIfAborted(signal);
    for (let attempt = 0; ; attempt++) {
      let conn = null;
      try {
        conn = await connect(spec, signal);
        return await handle(conn);
      } catch (caught) {
        const error = classify(caught, conn, signal);
        if (isAbortError(error) || !error.retryable || attempt >= maxRetries) throw error;
        conn?.release();
        await waitToRetry(error, attempt, maxRetries, signal, onRetry);
      } finally {
        conn?.release();
      }
    }
  }

  // ---- stream -----------------------------------------------------------------------------------

  // A plain JSON answer (the service normally streams): replayed as the same events a stream would carry.
  async function* wholeMessage(conn, secrets) {
    const { text, truncated } = await readBodyText(conn.response.body, { signal: conn.controller.signal, idleMs: limits.idleMs, limit: MAX_JSON_CHARS });
    let message = null;
    try { message = JSON.parse(text); } catch { message = null; }
    if (truncated || !message || typeof message !== "object") throw fail("bad_response");
    if (message.type === "error") throw errorFromStreamEvent(message, { secrets, lang: currentLang() });
    if (message.type !== "message" || !Array.isArray(message.content)) throw fail("bad_response");
    yield { type: "message_start", usage: normalizeUsage(message.usage) };
    for (const [index, block] of message.content.entries()) {
      if (block?.type === "text") {
        yield { type: "block_start", index, block: { type: "text" } };
        if (block.text) yield { type: "text_delta", index, text: block.text };
      } else if (block?.type === "thinking") {
        yield { type: "block_start", index, block: { type: "thinking" } };
        if (block.thinking) yield { type: "thinking_delta", index, text: block.thinking };
      } else if (block?.type === "tool_use") {
        yield { type: "block_start", index, block: { type: "tool_use", id: block.id, name: block.name } };
        yield { type: "tool_json_delta", index, json: JSON.stringify(block.input ?? {}) };
      } else continue;
      yield { type: "block_stop", index };
    }
    yield { type: "message_delta", stopReason: message.stop_reason ?? null, usage: normalizeUsage(message.usage) };
    yield { type: "message_stop" };
  }

  async function* normalized(conn, secrets) {
    if (!/event-stream/i.test(conn.response.headers.get("content-type") || "")) {
      yield* wholeMessage(conn, secrets);
      return;
    }
    let held = null;
    let stopReason = null;
    for await (const raw of readSse(conn.response.body, { signal: conn.controller.signal, idleMs: limits.idleMs })) {
      if (raw.data === "[DONE]") continue;
      let data;
      try { data = JSON.parse(raw.data); } catch { throw fail("stream_broken"); }
      if (!data || typeof data !== "object") continue;
      const kind = typeof data.type === "string" ? data.type : raw.event;
      const index = Number.isInteger(data.index) ? data.index : 0;
      let out = [];
      switch (kind) {
        case "error":
          throw errorFromStreamEvent(data, { secrets, lang: currentLang() });
        case "message_start":
          held = { type: "message_start", usage: normalizeUsage(data.message?.usage) };
          break;
        case "content_block_start": {
          const block = data.content_block || {};
          const info = { type: block.type || "text" };
          if (block.type === "tool_use") { info.id = block.id; info.name = block.name; }
          out = [{ type: "block_start", index, block: info }];
          if (block.type === "text" && block.text) out.push({ type: "text_delta", index, text: block.text });
          if (block.type === "thinking" && block.thinking) out.push({ type: "thinking_delta", index, text: block.thinking });
          if (block.type === "tool_use" && block.input && typeof block.input === "object" && Object.keys(block.input).length) {
            out.push({ type: "tool_json_delta", index, json: JSON.stringify(block.input) });
          }
          break;
        }
        case "content_block_delta": {
          const delta = data.delta || {};
          if (delta.type === "text_delta" && delta.text) out = [{ type: "text_delta", index, text: delta.text }];
          else if (delta.type === "thinking_delta" && delta.thinking) out = [{ type: "thinking_delta", index, text: delta.thinking }];
          else if (delta.type === "input_json_delta" && delta.partial_json) out = [{ type: "tool_json_delta", index, json: delta.partial_json }];
          break;
        }
        case "content_block_stop":
          out = [{ type: "block_stop", index }];
          break;
        case "message_delta":
          stopReason = data.delta?.stop_reason ?? stopReason;
          out = [{ type: "message_delta", stopReason, usage: normalizeUsage(data.usage) }];
          break;
        case "message_stop":
          out = [{ type: "message_stop" }];
          break;
        default:
          break; // ping, signature_delta and anything newer are not part of the contract
      }
      if (!out.length) continue;
      if (held) { yield held; held = null; }
      yield* out;
      if (kind === "message_stop") return;
    }
    // The connection closed without message_stop. A complete answer that only lost its last line is kept;
    // anything else is a broken stream.
    if (!stopReason) throw fail("stream_broken");
    if (held) yield held;
    yield { type: "message_stop" };
  }

  async function* stream(request, { signal, onRetry: notify = onRetry } = {}) {
    throwIfAborted(signal);
    const { spec, secrets } = await prepare({
      method: "POST",
      path: "/v1/messages",
      body: JSON.stringify({ model: MODEL_ID, ...request, stream: true }),
      accept: "text/event-stream",
    });
    for (let attempt = 0; ; attempt++) {
      let conn = null;
      let delivered = false;
      try {
        conn = await connect(spec, signal);
        if (!conn.response.ok) throw await failureOf(conn, secrets, signal);
        for await (const event of normalized(conn, secrets)) {
          delivered = true;
          yield event;
        }
        return;
      } catch (caught) {
        const error = classify(caught, conn, signal);
        if (isAbortError(error) || delivered || !error.retryable || attempt >= backoffMs.length) throw error;
        conn?.release();
        await waitToRetry(error, attempt, backoffMs.length, signal, notify);
      } finally {
        conn?.release();
      }
    }
  }

  // ---- the other calls --------------------------------------------------------------------------

  async function checkAccess({ signal } = {}) {
    const { spec, secrets } = await prepare({ method: "GET", path: "/v1/models", accept: "application/json", totalMs: limits.jsonMs });
    return exchange(spec, signal, 2, async conn => {
      if (!conn.response.ok) throw await failureOf(conn, secrets, signal);
      const { text, truncated } = await readBodyText(conn.response.body, { signal: conn.controller.signal, idleMs: limits.idleMs, limit: MAX_ERROR_CHARS * 4 });
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      if (truncated || !body || typeof body !== "object") throw fail("bad_response");
      const models = Array.isArray(body.data) ? body.data : [];
      const model = models.find(item => item?.id === MODEL_ID) || models[0];
      return { ok: true, modelName: typeof model?.display_name === "string" && model.display_name ? model.display_name : NAME };
    });
  }

  async function library(body, { signal } = {}) {
    const { spec, secrets } = await prepare({
      method: "POST",
      path: "/library",
      body: JSON.stringify(body ?? {}),
      accept: "application/json",
      totalMs: limits.jsonMs,
    });
    return exchange(spec, signal, 2, async conn => {
      const status = conn.response.status;
      const { text, truncated } = await readBodyText(conn.response.body, { signal: conn.controller.signal, idleMs: limits.idleMs, limit: MAX_JSON_CHARS });
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      const isObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
      if (status >= 400) {
        const named = isObject ? (typeof parsed.error === "string" ? parsed.error : parsed.error?.code) : "";
        const aboutAccount = status === 401 || conn.response.headers.has("x-firas-code2-error") || ACCOUNT_CODES.has(named) || !isObject;
        if (aboutAccount) throw errorFromHttp({ status, headers: conn.response.headers, text: text.slice(0, MAX_ERROR_CHARS), secrets, lang: currentLang() });
        return { status, body: parsed };
      }
      if (truncated || !isObject) throw fail("bad_response");
      return { status, body: parsed };
    });
  }

  return { stream, checkAccess, library, origin: base };
}
