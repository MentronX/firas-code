import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { getLang, setLang, t } from "../../src/i18n/index.js";
import { LINK_MESSAGE_KEYS } from "../../src/link/strings.js";
import { banned, skipNoList, avoidedWordPattern } from "../helpers/banned.js";
import {
  FirasLinkError, abortError, errorFromHttp, errorFromNetwork, errorFromStreamEvent, isAbortError,
  networkKind, parseRetryAfter, redact, redactHeaders, userMessageFor,
} from "../../src/link/errors.js";

const ARABIC = /[\u0600-\u06ff]/;
const URLISH = /https?:\/\//;
const headersOf = map => new Headers(map);

test("every message exists in both languages, differs between them, and uses the right script", () => {
  const before = getLang();
  try {
    for (const key of LINK_MESSAGE_KEYS) {
      setLang("ar");
      const ar = t("link.err." + key, { status: 502 });
      setLang("en");
      const en = t("link.err." + key, { status: 502 });
      assert.notEqual(ar, "link.err." + key, key);
      assert.notEqual(en, "link.err." + key, key);
      assert.match(ar, ARABIC, `${key} Arabic`);
      assert.doesNotMatch(en, ARABIC, `${key} English`);
      assert.ok(ar.length > 15 && en.length > 15, key);
    }
  } finally { setLang(before); }
});

test("no message shows a web address", () => {
  assert.match("see https://x.example/a", URLISH, "the pattern itself works");
  const before = getLang();
  try {
    for (const lang of ["ar", "en"]) {
      setLang(lang);
      for (const key of LINK_MESSAGE_KEYS) assert.doesNotMatch(t("link.err." + key, { status: 502 }), URLISH, `${lang}/${key} shows a URL`);
    }
  } finally { setLang(before); }
});

test("none of the listed words appears in a message", { skip: skipNoList }, () => {
  const term = avoidedWordPattern();
  assert.match("the " + banned.avoided.toUpperCase() + " is down", term, "the pattern itself works");
  const before = getLang();
  try {
    for (const lang of ["ar", "en"]) {
      setLang(lang);
      for (const key of LINK_MESSAGE_KEYS) {
        const text = t("link.err." + key, { status: 502 }).toLowerCase();
        for (const word of banned.all) assert.ok(!text.includes(word), `${lang}/${key} contains a banned word`);
        assert.doesNotMatch(text, term, `${lang}/${key} uses the listed technical word`);
      }
    }
  } finally { setLang(before); }
});

const CODES = {
  access_invalid: /not valid|isn't valid/i,
  access_expired: /expired/i,
  daily_limit: /tomorrow/i,
  busy: /busy/i,
  request_too_large: /\/compact/,
  unavailable: /unavailable/i,
  not_configured: /isn't ready/i,
  request_rejected: /rejected/i,
  invalid_request: /couldn't be read/i,
  upstream_refused: /didn't accept/i,
  client_required: /recognize/i,
};

test("each documented code has a friendly localized message with a next step", () => {
  const before = getLang();
  try {
    for (const [code, english] of Object.entries(CODES)) {
      setLang("en");
      const en = new FirasLinkError(code, { status: 429 });
      setLang("ar");
      const ar = new FirasLinkError(code, { status: 429 });
      assert.match(en.userMessage, english, code);
      assert.match(ar.userMessage, ARABIC, code);
      assert.notEqual(en.userMessage, ar.userMessage);
      assert.doesNotMatch(en.userMessage, /link\.err/);
    }
  } finally { setLang(before); }
});

test("an expired code tells the person to ask for a new one, in both languages", () => {
  assert.match(userMessageFor("access_expired", { lang: "en" }), /new one/);
  assert.match(userMessageFor("access_expired", { lang: "ar" }), /رمزاً جديداً/);
  assert.match(userMessageFor("access_invalid", { lang: "ar" }), /رمزاً جديداً/);
});

test("the daily limit says it resets tomorrow; too large offers /compact", () => {
  assert.match(userMessageFor("daily_limit", { lang: "ar" }), /غداً/);
  assert.match(userMessageFor("request_too_large", { lang: "ar" }), /\/compact/);
});

test("aliases share a message and unknown codes get the generic fallback", () => {
  assert.equal(userMessageFor("signin_required", { lang: "en" }), userMessageFor("access_invalid", { lang: "en" }));
  assert.equal(userMessageFor("rate_limited", { lang: "ar" }), userMessageFor("busy", { lang: "ar" }));
  assert.equal(userMessageFor("quota_exceeded", { lang: "en" }), userMessageFor("daily_limit", { lang: "en" }));
  assert.match(userMessageFor("totally_new_code", { status: 418, lang: "en" }), /code 418/);
  assert.match(userMessageFor("totally_new_code", { status: 418, lang: "ar" }), /418/);
  assert.doesNotMatch(userMessageFor("totally_new_code", { lang: "en" }), /\{status\}|code \d/);
  assert.doesNotMatch(userMessageFor("totally_new_code", { lang: "en" }), /totally_new_code/);
});

test("userMessage is fixed at construction time; the lang option does not disturb the global language", () => {
  const before = getLang();
  try {
    setLang("en");
    const english = new FirasLinkError("busy");
    const arabic = new FirasLinkError("busy", { lang: "ar" });
    assert.equal(getLang(), "en");
    setLang("ar");
    assert.match(english.userMessage, /busy/);
    assert.match(arabic.userMessage, ARABIC);
    assert.equal(new FirasLinkError("busy").userMessage, arabic.userMessage);
  } finally { setLang(before); }
});

test("FirasLinkError fields, defaults and message", () => {
  const error = new FirasLinkError("busy", { status: 429, retryAfterMs: 2500.4 });
  assert.equal(error.name, "FirasLinkError");
  assert.ok(error instanceof Error);
  assert.equal(error.code, "busy");
  assert.equal(error.status, 429);
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 2500);
  assert.equal(error.message, "service error: busy (HTTP 429)");
  assert.equal(new FirasLinkError("access_invalid").retryable, false);
  assert.equal(new FirasLinkError("network_dns").retryable, true);
  assert.equal(new FirasLinkError("network_tls").retryable, false);
  assert.equal(new FirasLinkError("busy", { retryable: false }).retryable, false);
  assert.equal(new FirasLinkError("!!bad code!!").code, "unknown");
  assert.equal(new FirasLinkError("x").retryAfterMs, 0);
});

test("toJSON and inspect never expose the cause or the service text", () => {
  const error = errorFromHttp({
    status: 500, headers: headersOf({}), text: JSON.stringify({ error: { message: "secret upstream detail" } }),
  });
  assert.equal(error.detail, "secret upstream detail");
  const json = JSON.stringify(error);
  assert.doesNotMatch(json, /secret upstream detail/);
  assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ["code", "message", "name", "retryAfterMs", "retryable", "status"]);
});

test("errorFromHttp takes the code from the header, then the body, then the status", () => {
  const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "English words" } });
  assert.equal(errorFromHttp({ status: 503, headers: headersOf({ "x-firas-code2-error": "not_configured" }), text: body }).code, "not_configured");
  assert.equal(errorFromHttp({ status: 401, headers: headersOf({}), text: JSON.stringify({ error: { code: "access_expired" } }) }).code, "access_expired");
  assert.equal(errorFromHttp({ status: 401, headers: headersOf({}), text: JSON.stringify({ ok: false, error: "access_invalid" }) }).code, "access_invalid");
  assert.equal(errorFromHttp({ status: 529, headers: headersOf({}), text: body }).code, "busy");
  assert.equal(errorFromHttp({ status: 401, headers: headersOf({}), text: "" }).code, "access_invalid");
  assert.equal(errorFromHttp({ status: 403, headers: headersOf({}), text: "<html>" }).code, "request_rejected");
  assert.equal(errorFromHttp({ status: 413, headers: headersOf({}), text: "" }).code, "request_too_large");
  assert.equal(errorFromHttp({ status: 429, headers: headersOf({}), text: "" }).code, "busy");
  assert.equal(errorFromHttp({ status: 502, headers: headersOf({}), text: "<html>bad gateway</html>" }).code, "unavailable");
  assert.equal(errorFromHttp({ status: 400, headers: headersOf({}), text: "" }).code, "invalid_request");
  assert.equal(errorFromHttp({ status: 418, headers: headersOf({}), text: "" }).code, "unknown");
});

test("an unknown header code is kept as the code but shown with the generic message", () => {
  const error = errorFromHttp({ status: 500, headers: headersOf({ "x-firas-code2-error": "brand_new_thing" }), text: "{}", lang: "en" });
  assert.equal(error.code, "brand_new_thing");
  assert.match(error.userMessage, /code 500/);
  assert.equal(errorFromHttp({ status: 500, headers: headersOf({ "x-firas-code2-error": "Not A Code!" }), text: "{}" }).code, "unavailable");
});

test("retryable follows the status table, x-should-retry and final codes", () => {
  const make = (status, h = {}, code) => errorFromHttp({ status, headers: headersOf({ ...(code ? { "x-firas-code2-error": code } : {}), ...h }), text: "" });
  for (const status of [429, 500, 502, 503, 504, 529]) assert.equal(make(status).retryable, true, String(status));
  for (const status of [400, 401, 402, 403, 404, 413, 422]) assert.equal(make(status).retryable, false, String(status));
  assert.equal(make(503, { "x-should-retry": "false" }).retryable, false);
  assert.equal(make(503, { "x-should-retry": "FALSE" }).retryable, false);
  assert.equal(make(429, { "x-should-retry": "true" }).retryable, true);
  assert.equal(make(429, {}, "daily_limit").retryable, false);
  assert.equal(make(503, {}, "not_configured").retryable, false);
  assert.equal(make(429, {}, "busy").retryable, true);
});

test("parseRetryAfter reads seconds and dates", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter("0.5"), 500);
  assert.equal(parseRetryAfter(""), 0);
  assert.equal(parseRetryAfter(null), 0);
  assert.equal(parseRetryAfter("soon"), 0);
  const now = Date.parse("2026-10-17T10:00:00Z");
  assert.equal(parseRetryAfter("Sat, 17 Oct 2026 10:00:07 GMT", now), 7000);
  assert.equal(parseRetryAfter("Sat, 17 Oct 2026 09:00:00 GMT", now), 0);
  assert.equal(errorFromHttp({ status: 429, headers: headersOf({ "retry-after": "4" }), text: "" }).retryAfterMs, 4000);
});

test("the service's own message is kept only as redacted debug detail", () => {
  const code = "FC2-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH";
  const error = errorFromHttp({
    status: 400, headers: headersOf({}), secrets: [code],
    text: JSON.stringify({ error: { message: `bad code ${code} and ${code.toLowerCase()} and Bearer abc.def-ghi plus FC2-ZZZZZ-ZZZZZ` } }),
  });
  assert.ok(!error.detail.includes("ABCDE"), error.detail);
  assert.ok(!error.detail.toLowerCase().includes("abcde"), error.detail);
  assert.ok(!/abc\.def/.test(error.detail), error.detail);
  assert.ok(!error.userMessage.includes("bad code"));
});

test("errorFromStreamEvent maps error types and never exposes the English message", () => {
  const overloaded = errorFromStreamEvent({ type: "error", error: { type: "overloaded_error", message: "English words here" } });
  assert.equal(overloaded.code, "busy");
  assert.equal(overloaded.retryable, true);
  assert.ok(!overloaded.userMessage.includes("English words"));
  assert.equal(errorFromStreamEvent({ type: "error", error: { type: "api_error" } }).code, "unavailable");
  const odd = errorFromStreamEvent({ type: "error", error: { type: "mystery", message: "x" } });
  assert.equal(odd.code, "stream_error");
  assert.equal(odd.retryable, false);
  assert.equal(errorFromStreamEvent({ type: "error", error: { code: "daily_limit" } }).code, "daily_limit");
  assert.equal(errorFromStreamEvent({}).code, "stream_error");
});

const sysError = (code, message = code) => Object.assign(new Error(message), { code });
const fetchFailed = cause => Object.assign(new TypeError("fetch failed"), { cause });

test("networkKind reads the error codes under a failed fetch", () => {
  const cases = {
    dns: [sysError("ENOTFOUND"), sysError("EAI_AGAIN")],
    refused: [sysError("ECONNREFUSED")],
    offline: [sysError("ENETUNREACH"), sysError("EHOSTUNREACH")],
    timeout: [sysError("ETIMEDOUT"), sysError("UND_ERR_CONNECT_TIMEOUT"), Object.assign(new Error("slow"), { name: "TimeoutError" })],
    reset: [sysError("ECONNRESET"), sysError("UND_ERR_SOCKET", "other side closed"), new TypeError("terminated")],
    tls: [sysError("CERT_HAS_EXPIRED"), sysError("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), sysError("DEPTH_ZERO_SELF_SIGNED_CERT")],
    other: [new Error("who knows"), "just a string", null, undefined],
  };
  for (const [kind, causes] of Object.entries(cases)) {
    for (const cause of causes) {
      assert.equal(networkKind(fetchFailed(cause)), kind, `${kind}: ${cause?.code || cause?.message || cause}`);
    }
  }
  const aggregate = fetchFailed(Object.assign(new AggregateError([sysError("ECONNREFUSED"), sysError("ECONNREFUSED")]), { code: "ECONNREFUSED" }));
  assert.equal(networkKind(aggregate), "refused");
  assert.equal(networkKind(fetchFailed(new AggregateError([sysError("ENOTFOUND")]))), "dns");
});

test("errorFromNetwork gives a network_* code, retryable except for certificate trouble", () => {
  const dns = errorFromNetwork(fetchFailed(sysError("ENOTFOUND")), { lang: "en" });
  assert.equal(dns.code, "network_dns");
  assert.equal(dns.retryable, true);
  assert.equal(dns.status, 0);
  assert.match(dns.userMessage, /address/);
  assert.equal(errorFromNetwork(fetchFailed(sysError("CERT_HAS_EXPIRED"))).retryable, false);
  assert.equal(errorFromNetwork(new Error("???")).code, "network");
  assert.equal(errorFromNetwork(fetchFailed(sysError("ECONNRESET"))).code, "network_reset");
  assert.equal(errorFromNetwork(fetchFailed(sysError("ENETUNREACH"))).code, "network_offline");
  assert.equal(errorFromNetwork(fetchFailed(sysError("ETIMEDOUT"))).code, "network_timeout");
  assert.equal(errorFromNetwork(fetchFailed(sysError("ECONNREFUSED"))).code, "network_refused");
});

test("abort errors are recognizable and distinct from link errors", () => {
  const error = abortError();
  assert.equal(error.name, "AbortError");
  assert.ok(isAbortError(error));
  assert.ok(!(error instanceof FirasLinkError));
  assert.ok(isAbortError(new DOMException("x", "AbortError")));
  assert.ok(!isAbortError(new FirasLinkError("busy")));
  assert.ok(!isAbortError(null));
});

test("redact removes known codes, code-shaped text and bearer tokens", () => {
  const code = "FC2-23456-789AB-CDEFG-HJKMN-PQRST-VWXYZ-23456-789AB";
  assert.equal(redact(`x ${code} y`, [code]), "x [redacted] y");
  assert.equal(redact(`x ${code.toLowerCase()} y`, [code]), "x [redacted] y");
  assert.equal(redact("see FC2-AAAAA-BBBBB-CCCCC end"), "see [redacted] end");
  assert.equal(redact("Authorization: Bearer abc123.def"), "Authorization: Bearer [redacted]");
  assert.equal(redact("nothing here"), "nothing here");
  assert.equal(redact(undefined), "");
  assert.equal(redact("a.b*c", ["a.b*c-long"]), "a.b*c");
});

test("redactHeaders masks credentials and keeps the rest", () => {
  const out = redactHeaders({ Authorization: "Bearer FC2-SECRET", "x-firas-client": "cli", cookie: "a=b", accept: "application/json" });
  assert.deepEqual(out, { Authorization: "[redacted]", "x-firas-client": "cli", cookie: "[redacted]", accept: "application/json" });
  assert.deepEqual(redactHeaders(undefined), {});
});

test("inspecting an error does not print a secret placed only in the request", () => {
  const code = "FC2-23456-789AB-CDEFG-HJKMN-PQRST-VWXYZ-23456-789AB";
  const error = errorFromNetwork(fetchFailed(sysError("ECONNRESET")));
  assert.ok(!inspect(error, { depth: 6 }).includes(code));
});

test("redact drops the whole text when any 8 characters of a code survive", () => {
  const code = "FC2-ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH";
  assert.equal(redact("it contained fghjkmnp somewhere", [code]), "[redacted]");
  assert.equal(redact("it contained FGHJ-KMNP somewhere", [code]), "[redacted]");
  assert.equal(redact("a short fghjkmn tail is fine", [code]), "a short fghjkmn tail is fine");
});
