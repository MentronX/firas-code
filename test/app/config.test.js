import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig, updateConfig, validateConfig, DEFAULTS, cleanCode } from "../../src/config.js";
import { configFile } from "../../src/util/paths.js";
import { useTempHome } from "./helpers.js";

const home = useTempHome("firas-config-");
before(() => home.reset());
beforeEach(() => home.reset());
after(() => home.restore());

const file = () => configFile();
const read = () => JSON.parse(fs.readFileSync(file(), "utf8"));

test("a missing file gives the defaults and says it is the first run", () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.firstRun, true);
  assert.equal(config.recovered, false);
  for (const key of Object.keys(DEFAULTS)) assert.equal(config[key], DEFAULTS[key], key);
  assert.deepEqual(Object.keys(config).sort(), Object.keys(DEFAULTS).sort(), "bookkeeping fields stay out of enumeration");
});

test("saveConfig writes only known, valid fields and loadConfig reads them back", () => {
  const result = saveConfig({ code: "FC2-AAAAA-BBBBB", lang: "ar", effort: "high", arabic: "off", bogus: 1, mode: "plan" });
  assert.equal(result.ok, true);
  assert.deepEqual(read(), { code: "FC2-AAAAA-BBBBB", lang: "ar", effort: "high", arabic: "off", mode: "plan" });
  const config = loadConfig({ env: {} });
  assert.equal(config.firstRun, false);
  assert.equal(config.code, "FC2-AAAAA-BBBBB");
  assert.equal(config.lang, "ar");
  assert.equal(config.effort, "high");
});

test("a setting that older versions saved for showing the model's reasoning is ignored, and the next save drops it", () => {
  fs.writeFileSync(file(), JSON.stringify({ code: "FC2-GOOD0-GOOD0", lang: "en", showThinking: true }));
  const config = loadConfig({ env: {} });
  assert.equal(config.code, "FC2-GOOD0-GOOD0");
  assert.equal(config.lang, "en");
  assert.ok(!("showThinking" in config), "it is not a setting any more");
  assert.equal(config.recovered, false);
  saveConfig({ effort: "low" });
  assert.deepEqual(read(), { code: "FC2-GOOD0-GOOD0", lang: "en", effort: "low" });
  assert.ok(!("showThinking" in loadConfig({ env: {} })));
});

test("the settings file is private on systems that have file modes", { skip: process.platform === "win32" }, () => {
  saveConfig({ code: "FC2-AAAAA-BBBBB" });
  assert.equal(fs.statSync(file()).mode & 0o777, 0o600);
});

test("invalid values are dropped one by one, valid neighbours survive", () => {
  fs.writeFileSync(file(), JSON.stringify({ code: "FC2-GOOD0-GOOD0", lang: "fr", effort: "turbo", arabic: "maybe", mode: "bypass", origin: "ftp://x" }));
  const config = loadConfig({ env: {} });
  assert.equal(config.code, "FC2-GOOD0-GOOD0");
  assert.equal(config.lang, DEFAULTS.lang);
  assert.equal(config.effort, DEFAULTS.effort);
  assert.equal(config.arabic, DEFAULTS.arabic);
  assert.equal(config.mode, "default", "bypass is never taken from a file");
  assert.equal(config.origin, "");
  assert.equal(config.recovered, false);
});

test("bypass is never persisted", () => {
  saveConfig({ mode: "bypass", effort: "low" });
  assert.deepEqual(read(), { effort: "low" });
});

test("a corrupt file is moved to config.json.bad and the app starts fresh", () => {
  fs.writeFileSync(file(), "{ this is not json");
  const config = loadConfig({ env: {} });
  assert.equal(config.recovered, true);
  assert.equal(config.code, "");
  assert.equal(fs.existsSync(file()), false);
  assert.equal(fs.readFileSync(file() + ".bad", "utf8"), "{ this is not json");
  // saving afterwards works and does not resurrect the bad content
  saveConfig({ effort: "max" });
  assert.deepEqual(read(), { effort: "max" });
});

test("a file holding a JSON array or a string counts as corrupt too", () => {
  fs.writeFileSync(file(), "[1,2,3]");
  assert.equal(loadConfig({ env: {} }).recovered, true);
  fs.writeFileSync(file(), '"hello"');
  assert.equal(loadConfig({ env: {} }).recovered, true);
});

test("a byte-order mark in front of the JSON is tolerated", () => {
  fs.writeFileSync(file(), "﻿" + JSON.stringify({ lang: "en" }));
  const config = loadConfig({ env: {} });
  assert.equal(config.lang, "en");
  assert.equal(config.recovered, false);
});

test("environment variables override the file but are never written back", () => {
  saveConfig({ code: "FC2-FILE0-FILE0", lang: "en", arabic: "on", origin: "https://file.example" });
  const env = { FIRAS_CODE: "FC2-ENV00-ENV00", FIRAS_LANG: "ar_IQ.UTF-8", FIRAS_ARABIC: "off", FIRAS_ORIGIN: "http://127.0.0.1:9" };
  const config = loadConfig({ env });
  assert.equal(config.code, "FC2-ENV00-ENV00");
  assert.equal(config.lang, "ar");
  assert.equal(config.arabic, "off");
  assert.equal(config.origin, "http://127.0.0.1:9");
  assert.deepEqual(config.env, { code: true, lang: true, arabic: true, origin: true });
  updateConfig(config, { effort: "low", code: "FC2-NEW00-NEW00" });
  const onDisk = read();
  assert.equal(onDisk.effort, "low");
  assert.equal(onDisk.code, "FC2-NEW00-NEW00", "the file is updated");
  assert.equal(config.code, "FC2-ENV00-ENV00", "but the environment still wins in memory");
  assert.equal(onDisk.lang, "en");
  assert.equal(onDisk.arabic, "on");
});

test("FIRAS_ARABIC accepts the usual spellings", () => {
  for (const [value, expected] of [["0", "off"], ["no", "off"], ["false", "off"], ["1", "on"], ["yes", "on"], ["auto", "auto"]]) {
    assert.equal(loadConfig({ env: { FIRAS_ARABIC: value } }).arabic, expected, value);
  }
  assert.equal(loadConfig({ env: { FIRAS_ARABIC: "banana" } }).arabic, "auto");
});

test("updateConfig saves and updates the object; null removes a field", () => {
  const config = loadConfig({ env: {} });
  updateConfig(config, { code: "FC2-AAAAA-BBBBB", effort: "xhigh" });
  assert.equal(config.code, "FC2-AAAAA-BBBBB");
  assert.equal(config.effort, "xhigh");
  assert.equal(config.firstRun, false);
  updateConfig(config, { code: null });
  assert.equal(config.code, "");
  assert.equal("code" in read(), false);
});

test("invalid patches change nothing", () => {
  const config = loadConfig({ env: {} });
  updateConfig(config, { effort: "turbo", lang: "fr" });
  assert.equal(config.effort, "medium");
  assert.equal(config.lang, "");
});

test("a code pasted with spaces and line breaks is stored without them", () => {
  assert.equal(cleanCode("  FC2-AAAAA \n BBBBB\t"), "FC2-AAAAABBBBB");
  assert.deepEqual(validateConfig({ code: "FC2-AAAAA BBBBB" }), { code: "FC2-AAAAABBBBB" });
  assert.deepEqual(validateConfig({ code: "has\u0000nul" }), {});
  assert.deepEqual(validateConfig({ code: "x".repeat(400) }), {});
});

test("a read-only location does not throw", () => {
  const blocked = path.join(home.dir, "not-a-folder");
  fs.writeFileSync(blocked, "x");
  const result = saveConfig({ effort: "low" }, { file: path.join(blocked, "config.json") });
  assert.equal(result.ok, false);
});
