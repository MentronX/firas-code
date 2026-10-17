import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setLang, getLang } from "../../src/i18n/index.js";
import { stripAnsi } from "../../src/text/display.js";
import { createServiceClient } from "../../src/link/client.js";
import { loadConfig } from "../../src/config.js";
import { runOnboarding, askAccessCode, pickLanguage, parseLanguageAnswer, CODE_ATTEMPTS } from "../../src/onboarding.js";
import { startMockService } from "../helpers/mock-service.js";
import { createFakeScreen, useTempHome } from "./helpers.js";

const home = useTempHome("firas-onboarding-");
before(() => { home.reset(); setLang("en"); });
beforeEach(() => { home.reset(); setLang("en"); });
after(() => { setLang("en"); home.restore(); });

/** A readPrompt that plays a script of answers: strings are submitted text, null is a cancel, functions get the options. */
function scripted(answers) {
  const calls = [];
  const readPrompt = async (screen, options) => {
    calls.push(options);
    if (!answers.length) throw new Error("the prompt was asked more often than scripted");
    const next = answers.shift();
    const value = typeof next === "function" ? next(options) : next;
    return value === null ? { type: "cancel" } : { type: "submit", text: value };
  };
  readPrompt.calls = calls;
  return readPrompt;
}

function fakeUi() {
  const out = { printed: [], notices: [] };
  return {
    out,
    print: lines => out.printed.push(...[].concat(lines).map(stripAnsi)),
    notice: (level, text) => out.notices.push([level, stripAnsi(text)]),
  };
}

const clientFactory = (service, extra = {}) => getCode => createServiceClient({ origin: service.origin, getCode, version: "2.0.0-test", lang: () => getLang(), backoffMs: [1, 1, 1, 1], ...extra });

test("language answers: numbers, names in both scripts, codes", () => {
  for (const [text, lang] of [["1", "ar"], ["2", "en"], ["ar", "ar"], ["EN", "en"], ["Arabic", "ar"], ["english", "en"], ["عربي", "ar"], ["العربية", "ar"], ["انجليزي", "en"], ["1.", "ar"], [" 2 ", "en"]]) {
    assert.equal(parseLanguageAnswer(text), lang, text);
  }
  for (const text of ["", "3", "french", "x"]) assert.equal(parseLanguageAnswer(text), "", text);
});

test("the language question is bilingual and asks again after an unknown answer", async () => {
  const ui = fakeUi();
  const screen = createFakeScreen();
  const readPrompt = scripted(["fr", "2"]);
  assert.equal(await pickLanguage({ screen, readPrompt, ui }), "en");
  const text = ui.out.printed.join("\n");
  assert.match(text, /English/);
  assert.match(ui.out.printed.join("\n"), /[ﭐ-﻿]/, "the Arabic choice is shaped");
  assert.equal(ui.out.notices.length, 1);
  assert.match(ui.out.notices[0][1], /Type 1 for Arabic or 2 for English/);
  assert.equal(readPrompt.calls.length, 2);
  assert.match(stripAnsi(readPrompt.calls[0].footer().join("")), /Choose your language/);
  assert.equal(readPrompt.calls[0].placeholder, "", "no 'type a message / for commands' hint on a question that has no commands");
  assert.equal(await pickLanguage({ screen, readPrompt: scripted([null]), ui }), null, "Ctrl+C leaves");
});

test("a valid code is checked with the service, saved, and followed by a welcome", async () => {
  const service = await startMockService([], { code: "FC2-GOOD0-GOOD0-GOOD0" });
  try {
    const config = loadConfig({ env: {} });
    const ui = fakeUi();
    const readPrompt = scripted(["1", "FC2-GOOD0-GOOD0-GOOD0"]);
    const result = await runOnboarding({ screen: createFakeScreen(), readPrompt, ui, config, makeClient: clientFactory(service) });
    assert.deepEqual(result, { ok: true });
    assert.equal(config.lang, "ar");
    assert.equal(getLang(), "ar", "the language applies at once");
    assert.equal(config.code, "FC2-GOOD0-GOOD0-GOOD0");
    assert.equal(loadConfig({ env: {} }).code, "FC2-GOOD0-GOOD0-GOOD0", "saved to the settings file");
    assert.equal(readPrompt.calls[1].mask, "•", "the code is typed masked");
    assert.equal(readPrompt.calls[1].history.length, 0);
    const models = service.requests.filter(r => r.path.endsWith("/v1/models"));
    assert.equal(models.length, 1);
    assert.equal(models[0].headers.authorization, "Bearer FC2-GOOD0-GOOD0-GOOD0");
    assert.match(ui.out.printed.join("\n"), /[ﭐ-﻿]/, "the welcome is Arabic");
  } finally { await service.close(); }
});

test("only the missing parts are asked: a known language skips the question, a known code skips the code", async () => {
  const service = await startMockService([]);
  try {
    const config = loadConfig({ env: {} });
    const ui = fakeUi();
    const readPrompt = scripted(["abcdefgh12345"]);
    const result = await runOnboarding({ screen: createFakeScreen(), readPrompt, ui, config, makeClient: clientFactory(service), needLanguage: false });
    assert.equal(result.ok, true);
    assert.equal(readPrompt.calls.length, 1);
    const lang = scripted(["en"]);
    const only = await runOnboarding({ screen: createFakeScreen(), readPrompt: lang, ui: fakeUi(), config: loadConfig({ env: {} }), makeClient: clientFactory(service), needCode: false });
    assert.equal(only.ok, true);
    assert.equal(lang.calls.length, 1);
  } finally { await service.close(); }
});

test("an invalid code is refused in friendly words, three times, and never saved or shown", async () => {
  const service = await startMockService([], { denyModels: "invalid" });
  try {
    const config = loadConfig({ env: {} });
    const ui = fakeUi();
    const codes = ["FC2-WRONG-AAAAA-AAAAA", "FC2-WRONG-BBBBB-BBBBB", "FC2-WRONG-CCCCC-CCCCC"];
    const result = await askAccessCode({ screen: createFakeScreen(), readPrompt: scripted([...codes]), ui, makeClient: clientFactory(service) });
    assert.deepEqual(result, { ok: false, attempts: true });
    assert.equal(CODE_ATTEMPTS, 3);
    const errors = ui.out.notices.filter(n => n[0] === "error").map(n => n[1]);
    assert.equal(errors.length, 4, "three refusals and the final give-up line");
    assert.match(errors[0], /That access code isn't valid/);
    assert.match(errors[3], /Too many attempts/);
    const shown = JSON.stringify(ui.out);
    for (const code of codes) assert.ok(!shown.includes(code), "the typed code is never echoed");
    assert.equal(service.requests.filter(r => r.path.endsWith("/v1/models")).length, 3);
    assert.equal(loadConfig({ env: {} }).code, "");
    await runOnboarding({ screen: createFakeScreen(), readPrompt: scripted(["en", ...codes]), ui: fakeUi(), config, makeClient: clientFactory(service) });
    assert.equal(config.code, "");
  } finally { await service.close(); }
});

test("an expired code says so; a later attempt can still succeed", async () => {
  const script = [];
  script.denyModels = "expired";
  const service = await startMockService(script, { code: "FC2-GOOD0-GOOD0" });
  try {
    const ui = fakeUi();
    const readPrompt = scripted([
      "FC2-GOOD0-GOOD0",
      () => { script.denyModels = false; return "FC2-GOOD0-GOOD0"; },
    ]);
    const result = await askAccessCode({ screen: createFakeScreen(), readPrompt, ui, makeClient: clientFactory(service) });
    assert.equal(result.ok, true);
    assert.equal(result.code, "FC2-GOOD0-GOOD0");
    assert.match(ui.out.notices.find(n => n[0] === "error")[1], /has expired/);
  } finally { await service.close(); }
});

test("when the connection fails, an empty Enter tries the same code again", async () => {
  const service = await startMockService([]);
  try {
    let attempts = 0;
    const fetchImpl = (url, init) => {
      attempts += 1;
      if (attempts <= 3) return Promise.reject(new TypeError("fetch failed"));
      return fetch(url, init);
    };
    const ui = fakeUi();
    const readPrompt = scripted(["FC2-SLOW0-SLOW0", ""]);
    const result = await askAccessCode({ screen: createFakeScreen(), readPrompt, ui, makeClient: clientFactory(service, { fetchImpl }) });
    assert.equal(result.ok, true, JSON.stringify(ui.out.notices));
    assert.equal(result.code, "FC2-SLOW0-SLOW0");
    assert.match(ui.out.notices.find(n => n[0] === "error")[1], /internet|connect|reach/i);
    assert.match(stripAnsi(readPrompt.calls[1].footer().join("")), /Enter to try the same code again/);
  } finally { await service.close(); }
});

test("something that cannot be a code is not even sent", async () => {
  const service = await startMockService([]);
  try {
    const ui = fakeUi();
    const result = await askAccessCode({ screen: createFakeScreen(), readPrompt: scripted(["abc", "FC2-OK000-OK000"]), ui, makeClient: clientFactory(service) });
    assert.equal(result.ok, true);
    assert.match(ui.out.notices[0][1], /doesn't look like an access code/);
    assert.equal(service.requests.filter(r => r.path.endsWith("/v1/models")).length, 1, "only the plausible one reached the service");
  } finally { await service.close(); }
});

test("a pasted code with spaces and a line break is sent clean", async () => {
  const service = await startMockService([]);
  try {
    const result = await askAccessCode({ screen: createFakeScreen(), readPrompt: scripted(["  FC2-ABCDE \n FGHIJ-KLMNO  "]), ui: fakeUi(), makeClient: clientFactory(service) });
    assert.equal(result.code, "FC2-ABCDEFGHIJ-KLMNO");
    assert.equal(service.requests[0].headers.authorization, "Bearer FC2-ABCDEFGHIJ-KLMNO");
  } finally { await service.close(); }
});

test("Ctrl+C at either question leaves cleanly and saves nothing", async () => {
  const service = await startMockService([]);
  try {
    const config = loadConfig({ env: {} });
    const first = await runOnboarding({ screen: createFakeScreen(), readPrompt: scripted([null]), ui: fakeUi(), config, makeClient: clientFactory(service) });
    assert.deepEqual(first, { ok: false, cancelled: true });
    const second = await runOnboarding({ screen: createFakeScreen(), readPrompt: scripted(["en", null]), ui: fakeUi(), config, makeClient: clientFactory(service) });
    assert.deepEqual(second, { ok: false, cancelled: true });
    assert.equal(config.code, "");
    assert.equal(service.requests.length, 0);
  } finally { await service.close(); }
});

test("an empty line at the code prompt just asks again", async () => {
  const service = await startMockService([]);
  try {
    const readPrompt = scripted(["", "   ", "FC2-FINE0-FINE0"]);
    const result = await askAccessCode({ screen: createFakeScreen(), readPrompt, ui: fakeUi(), makeClient: clientFactory(service) });
    assert.equal(result.ok, true);
    assert.equal(readPrompt.calls.length, 3);
  } finally { await service.close(); }
});
