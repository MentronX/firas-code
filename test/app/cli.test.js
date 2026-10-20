import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setLang } from "../../src/i18n/index.js";
import { sym } from "../../src/ui/theme.js";
import { setArabicMode, stringWidth, stripAnsi } from "../../src/text/display.js";
import { VERSION } from "../../src/brand.js";
import { parseArgs, helpLines, main, retryText, footerLine } from "../../src/cli.js";
import { loadConfig, saveConfig } from "../../src/config.js";
import { startMockService } from "../helpers/mock-service.js";
import { createCapture, createEmptyStdin, tempDir, useTempHome } from "./helpers.js";

const home = useTempHome("firas-cli-");
before(() => { home.reset(); setLang("en"); });
beforeEach(() => { home.reset(); setLang("en"); setArabicMode("auto"); });
after(() => { setLang("en"); setArabicMode("auto"); home.restore(); });

const parse = (...args) => parseArgs(args);

test("flags: every spelling in the usage text is understood", () => {
  const { opts } = parse("-p", "hello there", "-c", "--effort", "HIGH", "--mode=plan", "--yolo", "--lang", "ar", "--no-arabic", "--no-color", "--code", "FC2-AAA", "--origin", "http://127.0.0.1:1");
  assert.equal(opts.print, true);
  assert.equal(opts.prompt, "hello there");
  assert.equal(opts.continue, true);
  assert.equal(opts.effort, "high");
  assert.equal(opts.mode, "plan");
  assert.equal(opts.yolo, true);
  assert.equal(opts.lang, "ar");
  assert.equal(opts.noArabic, true);
  assert.equal(opts.noColor, true);
  assert.equal(opts.code, "FC2-AAA");
  assert.equal(opts.origin, "http://127.0.0.1:1");
  for (const [args, key] of [[["-v"], "version"], [["--version"], "version"], [["-h"], "help"], [["--help"], "help"]]) assert.equal(parse(...args).opts[key], true, args[0]);
});

test("bare words are the first message; with -p they join the prompt", () => {
  assert.equal(parse("fix", "the", "tests").opts.prompt, "fix the tests");
  assert.equal(parse("-p", "fix", "the", "tests").opts.prompt, "fix the tests");
  assert.equal(parse("-p", "one", "two", "three").opts.prompt, "one two three");
  assert.equal(parse("--print=say hi").opts.prompt, "say hi");
  assert.equal(parse("-p").opts.prompt, "");
  assert.equal(parse("-p", "-c").opts.continue, true);
  assert.equal(parse("--", "--not-a-flag").opts.prompt, "--not-a-flag");
  assert.equal(parse("مرحبا", "بالعالم").opts.prompt, "مرحبا بالعالم");
});

test("-r takes a session id only when the next word looks like one", () => {
  assert.equal(parse("-r").opts.resume, true);
  assert.equal(parse("-r", "20261017-120000-abc123").opts.resume, "20261017-120000-abc123");
  assert.equal(parse("--resume", "20261017").opts.resume, "20261017");
  assert.equal(parse("--resume=anything-goes").opts.resume, "anything-goes");
  const swallowed = parse("-r", "fix", "the", "bug").opts;
  assert.equal(swallowed.resume, true);
  assert.equal(swallowed.prompt, "fix the bug");
  assert.equal(parse().opts.resume, undefined);
});

test("`update` as the only word is the subcommand; as part of a prompt it is not", () => {
  assert.equal(parse("update").opts.update, true);
  assert.equal(parse("update", "the", "readme").opts.update, false);
  assert.equal(parse("update", "the", "readme").opts.prompt, "update the readme");
  assert.equal(parse("-p", "update").opts.update, false);
});

test("wrong usage is reported with the flag that caused it", () => {
  assert.deepEqual(parse("--bogus").error, { kind: "unknown", flag: "--bogus" });
  assert.deepEqual(parse("-x").error, { kind: "unknown", flag: "-x" });
  assert.deepEqual(parse("--effort").error, { kind: "missing", flag: "--effort" });
  assert.deepEqual(parse("--effort", "--yolo").error, { kind: "missing", flag: "--effort" });
  assert.equal(parse("--effort", "turbo").error.kind, "value");
  assert.equal(parse("--mode", "wat").error.flag, "--mode");
  assert.equal(parse("--lang", "fr").error.flag, "--lang");
  assert.equal(parse("--mode", "yolo").opts.mode, "bypass");
  assert.equal(parse("--lang", "AR").opts.lang, "ar");
  assert.equal(parse("--lang", "en-US").opts.lang, "en");
});

test("the help lists the flags in both languages and does not mention the hidden one", () => {
  const en = helpLines("en", false).join("\n");
  const ar = helpLines("ar", false).join("\n");
  for (const flag of ["--print", "--continue", "--resume", "--code", "--effort", "--mode", "--yolo", "--lang", "--no-arabic", "--no-color", "--version", "--help", "update"]) {
    assert.ok(en.includes(flag), `English help misses ${flag}`);
    assert.ok(ar.includes(flag), `Arabic help misses ${flag}`);
  }
  assert.ok(!en.includes("--origin") && !ar.includes("--origin"));
  assert.match(ar, /[؀-ۿ]/);
  assert.ok(!/[⁦-⁩]/.test(ar), "no direction marks in plain output");
  assert.match(helpLines("ar", true).join("\n"), /[ﭐ-﻿]/, "a terminal gets shaped Arabic");
});

function io(extra = {}) {
  return {
    stdin: createEmptyStdin(),
    stdout: createCapture(),
    stderr: createCapture(),
    env: { FIRAS_LANG: "en" },
    process: new EventEmitter(),
    clientOptions: { backoffMs: [1, 1, 1, 1] },
    ...extra,
  };
}

test("--version prints just the version and touches nothing", async () => {
  const run = io();
  assert.equal(await main(["--version"], run), 0);
  assert.equal(run.stdout.text, `${VERSION}\n`);
  assert.equal(run.stderr.text, "");
  assert.deepEqual(fs.readdirSync(home.dir), [], "no settings file was created");
  assert.equal(await main(["-v"], io({ stdout: run.stdout })), 0);
});

test("--help prints the usage and exits 0; Arabic when the language says so", async () => {
  const en = io();
  assert.equal(await main(["--help"], en), 0);
  assert.match(en.stdout.text, /^Firas Code 2 - a coding agent/);
  assert.match(en.stdout.text, /--print/);
  const ar = io({ env: { FIRAS_LANG: "ar" } });
  assert.equal(await main(["-h"], ar), 0);
  assert.match(ar.stdout.text, /الاستخدام/);
  const flagged = io();
  assert.equal(await main(["--lang", "ar", "-h"], flagged), 0);
  assert.match(flagged.stdout.text, /الخيارات/);
});

test("unknown flags and bad values are usage errors: one friendly line, exit 2", async () => {
  for (const args of [["--bogus"], ["--effort", "turbo"], ["--mode"], ["--lang", "fr"]]) {
    const run = io();
    assert.equal(await main(args, run), 2, args.join(" "));
    assert.equal(run.stdout.text, "");
    const lines = run.stderr.text.trim().split("\n");
    assert.equal(lines.length, 2, run.stderr.text);
    assert.match(lines[1], /firas --help/);
  }
  const run = io();
  await main(["--bogus"], run);
  assert.match(run.stderr.text, /Unknown option --bogus/);
});

test("without -p a terminal is required", async () => {
  const run = io();
  assert.equal(await main([], run), 2);
  assert.match(run.stderr.text, /needs a terminal/);
  assert.match(run.stderr.text, /firas -p/);
});

test("print mode with no access code says so in one line and exits 1", async () => {
  const run = io();
  assert.equal(await main(["-p", "hello"], run), 1);
  assert.equal(run.stdout.text, "");
  assert.equal(run.stderr.text.trim().split("\n").length, 1);
  assert.match(run.stderr.text, /no access code/);
  const nothing = io({ env: { FIRAS_LANG: "en", FIRAS_CODE: "FC2-TEST0-TEST0" } });
  assert.equal(await main(["-p"], nothing), 2);
  assert.match(nothing.stderr.text, /no message to send/);
});

test("a bad service address is reported without a stack and exits 2", async () => {
  saveConfig({ code: "FC2-TEST0-TEST0" });
  const run = io();
  assert.equal(await main(["-p", "hi", "--origin", "http://example.com"], run), 2);
  assert.match(run.stderr.text, /address isn't valid/);
});

test("`firas update` runs the installer through update.js and reports the result", async () => {
  const seen = [];
  const good = io({ runUpdate: async options => { seen.push(options); options.onOutput("downloading\n", "stdout"); options.onOutput("careful\n", "stderr"); return { ok: true, code: 0, reason: "" }; } });
  assert.equal(await main(["update"], good), 0);
  assert.match(good.stdout.text, /downloading/);
  assert.match(good.stderr.text, /careful/);
  assert.match(good.stdout.text, /Updated/);
  assert.equal(seen.length, 1);
  const bad = io({ runUpdate: async () => ({ ok: false, code: null, reason: "inside_app" }) });
  assert.equal(await main(["update"], bad), 1);
  assert.match(bad.stderr.text, /another folder/);
});

test("--code is validated first; a good one is saved and used, a bad one is refused and not saved", async () => {
  const service = await startMockService([{ events: [] }], { code: "FC2-GOOD0-GOOD0" });
  const work = tempDir();
  try {
    const bad = io({ cwd: work.dir });
    assert.equal(await main(["--code", "FC2-WRONG-WRONG", "--origin", service.origin, "-p", "hi"], bad), 1);
    assert.match(bad.stderr.text, /isn't valid/);
    assert.equal(loadConfig({ env: {} }).code, "");
    assert.ok(!bad.stderr.text.includes("FC2-WRONG"), "the code is never echoed");

    const script = service.script;
    script.length = 0;
    const { textReply } = await import("../helpers/mock-service.js");
    script.push(textReply("hello back"));
    const good = io({ cwd: work.dir });
    assert.equal(await main(["--code", "FC2-GOOD0-GOOD0", "--origin", service.origin, "-p", "hi"], good), 0);
    assert.equal(good.stdout.text, "hello back\n");
    assert.equal(loadConfig({ env: {} }).code, "FC2-GOOD0-GOOD0");
  } finally {
    await service.close();
    work.remove();
  }
});

test("the settings file path is under FIRAS_HOME", () => {
  assert.equal(path.dirname(loadConfig({ env: {} }).file), home.dir);
});

test("the quiet retry line says busy for a busy service and connection problem for a lost connection", () => {
  assert.match(retryText({ delayMs: 2000, error: { code: "busy" } }), /busy; trying again in 2 s/);
  assert.match(retryText({ delayMs: 900, error: { code: "network_refused" } }), /Connection problem; trying again in 1 s/);
  assert.match(retryText({ delayMs: 0, error: { code: "network" } }), /Connection problem; trying again in 1 s/);
  assert.match(retryText({ delayMs: 5000 }), /busy/);
  setLang("ar");
  try { assert.match(retryText({ delayMs: 2000, error: { code: "network_dns" } }), /الاتصال/); } finally { setLang("en"); }
});

test("the footer under the prompt drops its hint, then its effort, instead of being cut in a word; Arabic is right-aligned", () => {
  const perms = { mode: "acceptEdits" };
  const effort = { value: "medium" };
  const plain = line => stripAnsi(line);
  assert.equal(plain(footerLine(perms, effort, 80)), `  accept edits ${sym.dot} effort: medium ${sym.dot} Shift+Tab mode`);
  const narrow = plain(footerLine(perms, effort, 50));
  assert.ok(stringWidth(narrow) <= 48 && narrow.startsWith("  accept edits"), narrow);
  assert.ok(!narrow.includes("Shift+Tab mo") || narrow.includes("Shift+Tab mode"), "never cut mid-word: " + narrow);
  assert.equal(plain(footerLine(perms, effort, 30)), "  accept edits");
  assert.ok(stringWidth(plain(footerLine(perms, effort, 12))) <= 12);
  setLang("ar");
  try {
    for (const width of [40, 50, 80]) {
      const line = plain(footerLine(perms, effort, width));
      assert.ok(stringWidth(line) <= width, width + ": " + line);
      assert.ok(line.endsWith("  "), "two columns of gutter on the right: " + JSON.stringify(line));
    }
    const wide = plain(footerLine(perms, effort, 80));
    assert.equal(stringWidth(wide), 80, "right-aligned: padded on the left up to the edge");
  } finally { setLang("en"); }
});
