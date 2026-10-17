// Errors of the service link.
//
// One class, FirasLinkError, carries everything a caller needs: a stable `code`, the HTTP `status` (0 when
// there was none), whether the SAME request is worth sending again (`retryable`), how long the service
// asked us to wait (`retryAfterMs`, 0 when it did not) and `userMessage`, a sentence for the person in
// the current language (fixed with t() when the error is created, so a later /lang does not rewrite
// history). `.message` is a short English technical line for logs and never holds a secret.
//
// The service answers errors in English. That text is never shown: the code picks a message from
// strings.js. It is kept (redacted, capped) in `.detail` for FIRAS_DEBUG only.
import { getLang, setLang, t } from "../i18n/index.js";
import { LINK_MESSAGE_KEYS } from "./strings.js";

/** Statuses worth sending again before the first answer arrives. */
export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

// Codes whose status says "retry" but which cannot heal in seconds: a day's allowance, a server that was
// never set up. Waiting 18 s to learn that again is worse than telling the person now.
const FINAL_CODES = new Set(["daily_limit", "not_configured", "quota_exceeded", "plan_limit", "plan_required"]);

const RETRYABLE_CODES = new Set([
  "busy", "unavailable", "stream_idle", "stream_broken", "bad_response",
  "network", "network_dns", "network_refused", "network_timeout", "network_reset", "network_offline",
]);

// Codes the service (or the library route) may send that share another code's message.
const MESSAGE_ALIAS = Object.freeze({
  signin_required: "access_invalid",
  approval_required: "access_denied",
  owner_only: "access_denied",
  plan_required: "access_denied",
  plan_limit: "daily_limit",
  quota_exceeded: "daily_limit",
  rate_limited: "busy",
  library_unavailable: "unavailable",
  upstream_failed: "unavailable",
  desktop_client_required: "client_required",
});

// Error `type` strings of the service's JSON error body, for when no code was sent.
const TYPE_TO_CODE = Object.freeze({
  authentication_error: "access_invalid",
  permission_error: "request_rejected",
  invalid_request_error: "invalid_request",
  request_too_large: "request_too_large",
  rate_limit_error: "busy",
  overloaded_error: "busy",
  api_error: "unavailable",
  billing_error: "access_denied",
});

const CODE_SHAPE = /^[a-z][a-z0-9_]{0,39}$/;
const KNOWN_KEYS = new Set(LINK_MESSAGE_KEYS);

/** A service-supplied code, or "" when it is not a plain lowercase identifier. */
function cleanCode(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CODE_SHAPE.test(text) ? text : "";
}

function messageKey(code) {
  const key = MESSAGE_ALIAS[code] || code;
  return KNOWN_KEYS.has(key) && key !== "generic" && key !== "generic_plain" ? key : "";
}

function translate(key, params, lang) {
  if (!lang || lang === getLang()) return t(key, params);
  const previous = getLang();
  setLang(lang);
  try { return t(key, params); } finally { setLang(previous); }
}

/** The sentence for a person, in `lang` (default: the current language). Unknown codes get the generic one. */
export function userMessageFor(code, { status = 0, lang } = {}) {
  const key = messageKey(code);
  if (key) return translate("link.err." + key, undefined, lang);
  return status > 0
    ? translate("link.err.generic", { status }, lang)
    : translate("link.err.generic_plain", undefined, lang);
}

export class FirasLinkError extends Error {
  /**
   * @param {string} code      stable identifier, e.g. "busy", "access_expired", "network_dns"
   * @param {object} [o]       { status, retryable, retryAfterMs, detail, cause, lang }
   */
  constructor(code, o = {}) {
    const clean = cleanCode(code) || "unknown";
    const status = Number.isInteger(o.status) && o.status > 0 ? o.status : 0;
    super(`service error: ${clean}${status ? ` (HTTP ${status})` : ""}`, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "FirasLinkError";
    this.code = clean;
    this.status = status;
    this.retryable = typeof o.retryable === "boolean" ? o.retryable : RETRYABLE_CODES.has(clean);
    this.retryAfterMs = Number.isFinite(o.retryAfterMs) && o.retryAfterMs > 0 ? Math.round(o.retryAfterMs) : 0;
    this.userMessage = userMessageFor(clean, { status, lang: o.lang });
    if (o.detail) this.detail = String(o.detail).slice(0, 300);
  }

  /** Safe to log or send anywhere: no cause, no detail, no stack. */
  toJSON() {
    return { name: this.name, code: this.code, status: this.status, retryable: this.retryable, retryAfterMs: this.retryAfterMs, message: this.message };
  }
}

// ---- aborts ------------------------------------------------------------------------------------

/** The error an aborted operation throws (name "AbortError", like fetch's own). */
export function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function isAbortError(error) {
  return !!error && error.name === "AbortError";
}

// ---- secrets -----------------------------------------------------------------------------------

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text with every access code removed: the codes in `secrets`, anything shaped like one, and any bearer
 * token. Used for the only free-form text we keep (the service's own error message).
 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  const known = secrets.filter(secret => typeof secret === "string" && secret.length >= 6);
  for (const secret of known) out = out.replace(new RegExp(escapeRegExp(secret), "gi"), "[redacted]");
  out = out
    .replace(/FC2[-\s]?[0-9A-Za-z][0-9A-Za-z-]{5,}/gi, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  // A fragment of a code is as good as a code to someone guessing: if any 8 characters of one survive
  // (case and dashes ignored), nothing of the text is kept.
  const flat = out.replace(/[^0-9a-z]/gi, "").toUpperCase();
  for (const secret of known) {
    const code = secret.replace(/[^0-9a-z]/gi, "").toUpperCase();
    for (let i = 0; i + 8 <= code.length; i++) if (flat.includes(code.slice(i, i + 8))) return "[redacted]";
  }
  return out;
}

/** A copy of a header map that is safe to print: the credential is masked entirely. */
export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = /^(authorization|proxy-authorization|cookie|x-firas-code)$/i.test(name) ? "[redacted]" : value;
  }
  return out;
}

// ---- building errors ---------------------------------------------------------------------------

/** "Retry-After" as milliseconds: whole seconds or an HTTP date. 0 when absent or unreadable. */
export function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const when = Date.parse(text);
  return Number.isFinite(when) ? Math.max(0, when - now) : 0;
}

function codeFromStatus(status) {
  if (status === 401) return "access_invalid";
  if (status === 403) return "request_rejected";
  if (status === 413) return "request_too_large";
  if (status === 429 || status === 529) return "busy";
  if (status === 400) return "invalid_request";
  if (status >= 500) return "unavailable";
  return "";
}

const headerOf = (headers, name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) ?? "";

/**
 * The error for a non-2xx answer. The code comes from the `x-firas-code2-error` header, else from the
 * body (`error.code`, a bare `error` string as the library route sends, or `error.type`), else from the
 * status. `text` is the (already size-capped) body; `secrets` are the access codes to scrub from it.
 */
export function errorFromHttp({ status, headers, text = "", secrets = [], lang }) {
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const inner = body && typeof body.error === "object" && body.error ? body.error : null;
  const code = cleanCode(headerOf(headers, "x-firas-code2-error"))
    || cleanCode(inner?.code)
    || (typeof body?.error === "string" ? cleanCode(body.error) : "")
    || TYPE_TO_CODE[inner?.type]
    || codeFromStatus(status)
    || "unknown";
  const shouldRetry = String(headerOf(headers, "x-should-retry")).trim().toLowerCase() !== "false";
  const retryable = RETRY_STATUSES.has(status) && shouldRetry && !FINAL_CODES.has(code);
  const message = typeof inner?.message === "string" ? inner.message : typeof body?.message === "string" ? body.message : "";
  return new FirasLinkError(code, {
    status,
    retryable,
    retryAfterMs: parseRetryAfter(headerOf(headers, "retry-after")),
    detail: message ? redact(message, secrets) : "",
    lang,
  });
}

/** The error for an `error` event inside an otherwise healthy stream: `{ type:"error", error:{ type, message } }`. */
export function errorFromStreamEvent(data, { secrets = [], lang } = {}) {
  const inner = data && typeof data.error === "object" && data.error ? data.error : (data || {});
  const code = cleanCode(inner.code) || TYPE_TO_CODE[inner.type] || "stream_error";
  const message = typeof inner.message === "string" ? inner.message : "";
  return new FirasLinkError(code, {
    retryable: code === "busy" || code === "unavailable",
    detail: message ? redact(message, secrets) : "",
    lang,
  });
}

function chainOf(error) {
  const seen = new Set();
  const out = [];
  const queue = [error];
  while (queue.length && out.length < 12) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (item.cause) queue.push(item.cause);
    if (Array.isArray(item.errors)) queue.push(...item.errors);
  }
  return out;
}

/** What went wrong underneath a failed fetch: dns | refused | offline | timeout | reset | tls | redirect | other. */
export function networkKind(error) {
  const items = chainOf(error);
  const codes = items.map(item => String(item.code || ""));
  const has = (...names) => codes.some(code => names.includes(code));
  const text = items.map(item => String(item.message || "")).join(" | ").toLowerCase();
  if (codes.some(code => /^(CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_(GET|VERIFY)_)/.test(code))) return "tls";
  if (/unexpected redirect/.test(text)) return "redirect";
  if (has("ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_FAIL", "EAI_NONAME")) return "dns";
  if (has("ECONNREFUSED")) return "refused";
  if (has("ENETUNREACH", "EHOSTUNREACH", "ENETDOWN")) return "offline";
  if (has("ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT")
    || items.some(item => item.name === "TimeoutError")) return "timeout";
  if (has("ECONNRESET", "EPIPE", "ECONNABORTED", "ENETRESET", "UND_ERR_SOCKET", "UND_ERR_CLOSED")
    || /terminated|other side closed|socket hang up|premature close/.test(text)) return "reset";
  return "other";
}

/** The error for a request that never got an answer (or lost it). Network trouble is worth retrying; a certificate problem is not. */
export function errorFromNetwork(error, { lang } = {}) {
  const kind = networkKind(error);
  // The client never follows redirects (the code must not travel anywhere unexpected): the configured address is wrong.
  if (kind === "redirect") return new FirasLinkError("bad_origin", { retryable: false, cause: error, lang });
  return new FirasLinkError(kind === "other" ? "network" : "network_" + kind, { retryable: kind !== "tls", cause: error, lang });
}
