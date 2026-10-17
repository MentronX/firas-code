import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setLang } from "../../src/i18n/index.js";
import { stripAnsi, stringWidth } from "../../src/text/display.js";
import { COMMANDS, parseSlash, findCommand, suggestCommands, levenshtein, dispatch, commandMenu } from "../../src/commands/index.js";
import { parseMode } from "../../src/commands/mode.js";
import { parseLang } from "../../src/commands/lang.js";
import { INIT_PROMPT } from "../../src/commands/init.js";
import { updateFailureText } from "../../src/commands/update.js";
import { createPermissionEngine } from "../../src/tools/index.js";
import { createSession } from "../../src/agent/session.js";
import { loadConfig } from "../../src/config.js";
import { useTempHome, tempDir } from "./helpers.js";

const home = useTempHome("firas-commands-");
before(() => { home.reset(); setLang("en"); });
beforeEach(() => { home.reset(); setLang("en"); });
after(() => { setLang("en"); home.restore(); });

function makeCtx(over = {}) {
  const notices = [];
  const printed = [];
  const calls = [];
  const config = loadConfig({ env: {} });
  const state = { effort: "medium", lang: "en" };
  const permissions = createPermissionEngine({ mode: "default" });
  const ui = {
    notice: (level, text) => notices.push([level, stripAnsi(text)]),
    print: lines => printed.push(...[].concat(lines).map(stripAnsi)),
    printRaw: lines => printed.push(...[].concat(lines).map(stripAnsi)),
    lastAnswer: () => over.lastAnswer ?? "",
    pick: async options => { calls.push(["pick", options]); return over.pickIndex ?? -1; },
  };
  const ctx = {
    config,
    session: createSession({ cwd: over.cwd ?? process.cwd(), persist: false }),
    client: over.client ?? { checkAccess: async () => ({ ok: true }) },
    permissions,
    ui,
    screen: { width: () => 80 },
    cwd: over.cwd ?? process.cwd(),
    env: {},
    platform: process.platform,
    get lang() { return state.lang; },
    effort: { get: () => state.effort, set: v => { state.effort = v; calls.push(["effort", v]); } },
    setMode: v => { permissions.setMode(v); calls.push(["mode", v]); },
    setLang: v => { state.lang = v; setLang(v); calls.push(["lang", v]); },
    setArabic: v => { config.arabic = v; calls.push(["arabic", v]); },
    forgetCode: () => calls.push(["forget"]),
    askNewCode: async () => over.newCode ?? false,
    exit: code => calls.push(["exit", code]),
    runAgentTurn: async text => calls.push(["turn", text]),
    busy: async fn => fn(new AbortController().signal),
    clearConversation: () => calls.push(["clear"]),
    resumeSession: session => calls.push(["resume", session.id]),
    copyToClipboard: over.copy,
    runUpdate: over.runUpdate,
    ...over.extra,
  };
  return { ctx, notices, printed, calls, state };
}

test("slash lines: a command is one word after the slash, anything else is a message", () => {
  assert.deepEqual(parseSlash("/help"), { name: "help", args: "" });
  assert.deepEqual(parseSlash("  /Effort   high  "), { name: "effort", args: "high" });
  assert.deepEqual(parseSlash("/compact keep the tests\nand the plan"), { name: "compact", args: "keep the tests\nand the plan" });
  assert.deepEqual(parseSlash("/"), { name: "help", args: "" });
  assert.equal(parseSlash("/usr/bin/node is missing"), null);
  assert.equal(parseSlash("/etc.conf"), null);
  assert.equal(parseSlash("/مرحبا"), null);
  assert.equal(parseSlash("hello /help"), null);
  assert.equal(parseSlash(""), null);
});

test("every command is complete and its description follows the language", () => {
  const names = new Set();
  for (const cmd of COMMANDS) {
    assert.match(cmd.name, /^[a-z]+$/);
    assert.ok(!names.has(cmd.name), `${cmd.name} twice`);
    names.add(cmd.name);
    assert.equal(typeof cmd.run, "function");
    assert.ok(Array.isArray(cmd.aliases));
    setLang("en");
    const en = cmd.description;
    setLang("ar");
    const ar = cmd.description;
    assert.ok(en && !en.startsWith("app."), `${cmd.name} has no English description`);
    assert.ok(ar && !ar.startsWith("app."), `${cmd.name} has no Arabic description`);
    assert.notEqual(en, ar);
    assert.match(ar, /[؀-ۿ]/);
  }
  for (const needed of ["help", "clear", "compact", "effort", "mode", "lang", "arabic", "model", "status", "cost", "copy", "init", "resume", "sessions", "logout", "update", "exit"]) {
    assert.ok(names.has(needed), `/${needed} is missing`);
  }
  assert.ok(!names.has("thinking"), "there is no way to show the model's reasoning text");
  setLang("en");
});

test("aliases find their command; /quit leaves like /exit", () => {
  assert.equal(findCommand("quit").name, "exit");
  assert.equal(findCommand("q").name, "exit");
  assert.equal(findCommand("?").name, "help");
  assert.equal(findCommand("EXIT").name, "exit");
  assert.equal(findCommand("nope"), null);
});

test("the closest command names are suggested", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(suggestCommands("hlep")[0], "help");
  assert.equal(suggestCommands("sesions")[0], "sessions");
  assert.ok(suggestCommands("eff").includes("effort"), "prefixes count");
  assert.ok(suggestCommands("exti").includes("exit"));
  assert.deepEqual(suggestCommands("qqqqqqqq"), []);
  assert.deepEqual(suggestCommands(""), []);
});

test("an unknown command is answered with a hint and never sent on", async () => {
  const { ctx, notices } = makeCtx();
  const result = await dispatch("/hlep", ctx);
  assert.deepEqual(result, { handled: true, command: null });
  assert.equal(notices[0][0], "warn");
  assert.match(notices[0][1], /Unknown command \/hlep/);
  assert.match(notices[0][1], /\/help/);
  const none = makeCtx();
  await dispatch("/zzzzzzzzzz", none.ctx);
  assert.match(none.notices[0][1], /Unknown command \/zzzzzzzzzz\. Type \//);
  assert.deepEqual(await dispatch("fix the bug", ctx), { handled: false });
});

test("a command that throws gives one friendly line", async () => {
  const { ctx, notices } = makeCtx({ extra: { clearConversation: () => { throw new Error("boom internals"); } } });
  const result = await dispatch("/clear", ctx);
  assert.equal(result.handled, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], "error");
  assert.ok(!/boom|internals/.test(notices[0][1]));
});

test("/effort sets, validates and offers a menu", async () => {
  const a = makeCtx();
  await dispatch("/effort high", a.ctx);
  assert.deepEqual(a.calls, [["effort", "high"]]);
  assert.match(a.notices[0][1], /Effort set to high/);

  const b = makeCtx();
  await dispatch("/effort turbo", b.ctx);
  assert.equal(b.calls.length, 0);
  assert.match(b.notices[0][1], /turbo.*off, low, medium, high, xhigh, max/);

  const c = makeCtx({ pickIndex: 3 });
  await dispatch("/effort", c.ctx);
  assert.equal(c.calls[0][0], "pick");
  assert.equal(c.calls[0][1].items.length, 6);
  assert.equal(c.calls[0][1].initial, 2, "the current level is preselected");
  assert.deepEqual(c.calls[1], ["effort", "high"]);

  const d = makeCtx({ pickIndex: -1 });
  await dispatch("/effort", d.ctx);
  assert.equal(d.calls.filter(call => call[0] === "effort").length, 0, "backing out changes nothing");

  const e = makeCtx();
  await dispatch("/effort MED", e.ctx);
  assert.deepEqual(e.calls, [["effort", "medium"]]);
});

test("/mode understands names, spellings and the yolo alias", async () => {
  assert.equal(parseMode("accept-edits"), "acceptEdits");
  assert.equal(parseMode("ACCEPT_EDITS"), "acceptEdits");
  assert.equal(parseMode("yolo"), "bypass");
  assert.equal(parseMode("nonsense"), "");
  const a = makeCtx();
  await dispatch("/mode plan", a.ctx);
  assert.equal(a.ctx.permissions.mode, "plan");
  assert.equal(a.notices[0][0], "info");
  await dispatch("/mode bypass", a.ctx);
  assert.equal(a.ctx.permissions.mode, "bypass");
  assert.equal(a.notices.at(-1)[0], "warn", "turning checks off is a warning, not a pat on the back");
  await dispatch("/mode wat", a.ctx);
  assert.equal(a.ctx.permissions.mode, "bypass");
  assert.match(a.notices.at(-1)[1], /isn't a mode/);
});

test("/lang switches the interface language", async () => {
  assert.equal(parseLang("Arabic"), "ar");
  assert.equal(parseLang("عربي"), "ar");
  assert.equal(parseLang("en"), "en");
  assert.equal(parseLang("klingon"), "");
  const a = makeCtx();
  await dispatch("/lang ar", a.ctx);
  assert.deepEqual(a.calls, [["lang", "ar"]]);
  assert.match(a.notices[0][1], /[؀-ۿ]/, "the confirmation is already in the new language");
  const b = makeCtx();
  await dispatch("/lang klingon", b.ctx);
  assert.equal(b.calls.length, 0);
});

test("/arabic validates and prints a sample line", async () => {
  const a = makeCtx();
  await dispatch("/arabic off", a.ctx);
  assert.deepEqual(a.calls, [["arabic", "off"]]);
  assert.ok(a.printed.some(line => /[؀-ۿﭐ-﻿]/.test(line)), "the sample line is printed");
  const b = makeCtx();
  await dispatch("/arabic maybe", b.ctx);
  assert.equal(b.calls.length, 0);
  assert.match(b.notices[0][1], /auto, on, off/);
});

test("/thinking is not a command any more: it is reported as unknown and nothing changes", async () => {
  const a = makeCtx();
  const result = await dispatch("/thinking on", a.ctx);
  assert.deepEqual(result, { handled: true, command: null });
  assert.equal(a.notices.at(-1)[0], "warn");
  assert.match(a.notices.at(-1)[1], /Unknown command \/thinking/);
  assert.deepEqual(a.calls, []);
});

test("/help lists every command in groups, plus the shortcuts", async () => {
  const { ctx, printed } = makeCtx();
  await dispatch("/help", ctx);
  const text = printed.join("\n");
  for (const cmd of COMMANDS) assert.ok(text.includes(`/${cmd.name}`), `/${cmd.name} missing from the help`);
  for (const heading of ["Conversation", "Settings", "Information", "Account and updates", "Keyboard"]) assert.ok(text.includes(heading), heading);
  for (const key of ["Shift+Tab", "Ctrl+O", "Alt+Enter", "Esc"]) assert.ok(text.includes(key), key);
  assert.ok(!text.includes("Ctrl+T") && !/thinking/i.test(text), "no shortcut or command for the model's reasoning text");
  setLang("ar");
  const ar = makeCtx();
  await dispatch("/help", ar.ctx);
  assert.match(ar.printed.join("\n"), /[ﭐ-﻿]/, "the Arabic help is shaped Arabic");
  assert.ok(!/[⁦-⁩]/.test(ar.printed.join("\n")), "no direction isolate reaches the screen");
});

test("/help never overflows the terminal (English and Arabic, narrow and wide)", async () => {
  for (const lang of ["en", "ar"]) {
    for (const columns of [50, 60, 80, 140]) {
      setLang(lang);
      const { ctx, printed } = makeCtx({ extra: { screen: { width: () => columns } } });
      await dispatch("/help", ctx);
      const wide = printed.flatMap(block => block.split("\n")).filter(line => stringWidth(line) > columns - 2);
      assert.deepEqual(wide, [], `${lang} ${columns}: lines wider than the terminal`);
    }
  }
  setLang("en");
  const { ctx, printed } = makeCtx({ extra: { screen: { width: () => 80 } } });
  await dispatch("/help", ctx);
  const at = printed.findIndex(line => line.includes("/mode [default|acceptEdits|plan|bypass]"));
  assert.ok(at >= 0 && !/\]\s*\S/.test(printed[at].replace("/mode [default|acceptEdits|plan|bypass]", "")), "a long usage has its row to itself");
  assert.ok(/^ {22}\S/.test(printed[at + 1]), "its description starts under the description column");
});

test("/cost and /model and /status print what they should", async () => {
  const { ctx, printed } = makeCtx();
  ctx.session.usage.inputTokens = 12_400;
  ctx.session.usage.outputTokens = 3_100;
  ctx.session.usage.turns = 4;
  await dispatch("/cost", ctx);
  const cost = printed.join("\n");
  assert.match(cost, /12k/);
  assert.match(cost, /3\.1k/);
  assert.match(cost, /Requests\s+4/);

  const model = makeCtx();
  await dispatch("/model", model.ctx);
  assert.match(model.printed.join("\n"), /Firas Code 2/);

  const ok = makeCtx();
  await dispatch("/status", ok.ctx);
  const status = ok.printed.join("\n");
  assert.match(status, /Firas Code 2 2\./);
  assert.match(status, /reachable/);
  assert.ok(status.includes(ok.ctx.session.id));

  const down = makeCtx({ client: { checkAccess: async () => { const e = new Error("x"); e.userMessage = "There is no internet connection."; throw e; } } });
  await dispatch("/status", down.ctx);
  assert.match(down.printed.join("\n"), /no internet connection/);
});

test("/status rows fit the terminal: a long folder keeps its tail, a long service message is cut", async () => {
  const long = "There was a problem connecting to the service. Check your internet and try again in a moment, please.";
  const deep = "C:/Users/Teacher/Documents/Projects/school-management-system/frontend/src/components/dashboard";
  for (const columns of [50, 80]) {
    const { ctx, printed } = makeCtx({ cwd: deep, client: { checkAccess: async () => { const e = new Error("x"); e.userMessage = long; throw e; } }, extra: { screen: { width: () => columns } } });
    await dispatch("/status", ctx);
    const wide = printed.filter(line => stringWidth(line) > columns - 2);
    assert.deepEqual(wide, [], columns + " columns");
    assert.ok(printed.some(line => line.includes("dashboard")), "the end of the folder path stays visible");
  }
  setLang("ar");
  try {
    const ar = makeCtx({ extra: { screen: { width: () => 50 } } });
    await dispatch("/status", ar.ctx);
    assert.ok(ar.printed.every(line => stringWidth(line) <= 48));
  } finally { setLang("en"); }
});

test("/copy sends the last answer, as written, to the clipboard", async () => {
  const seen = [];
  const a = makeCtx({ lastAnswer: "**مرحبا** بك\n```js\nx\n```", copy: async (text, opts) => { seen.push(text); return { ok: true, tool: "x" }; } });
  await dispatch("/copy", a.ctx);
  assert.deepEqual(seen, ["**مرحبا** بك\n```js\nx\n```"]);
  assert.equal(a.notices[0][0], "info");

  const none = makeCtx({ lastAnswer: "  ", copy: async () => { throw new Error("must not be called"); } });
  await dispatch("/copy", none.ctx);
  assert.equal(none.notices[0][0], "warn");

  const fail = makeCtx({ lastAnswer: "x", copy: async () => ({ ok: false, tool: "" }) });
  await dispatch("/copy", fail.ctx);
  assert.equal(fail.notices[0][0], "warn");
});

test("/init hands the agent a prompt that asks for FIRAS.md", async () => {
  const { ctx, calls } = makeCtx();
  await dispatch("/init", ctx);
  assert.equal(calls[0][0], "turn");
  assert.equal(calls[0][1], INIT_PROMPT);
  assert.match(INIT_PROMPT, /FIRAS\.md/);
  assert.match(INIT_PROMPT, /Write tool/);
});

test("/compact has nothing to do on an empty conversation and says so", async () => {
  const { ctx, notices } = makeCtx();
  await dispatch("/compact", ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0][1], /Nothing to compact/);
});

test("/exit, /quit and /clear call the application", async () => {
  const a = makeCtx();
  await dispatch("/exit", a.ctx);
  await dispatch("/quit", a.ctx);
  await dispatch("/clear", a.ctx);
  assert.deepEqual(a.calls, [["exit", 0], ["exit", 0], ["clear"]]);
});

test("/logout forgets the code and leaves when no new one is given", async () => {
  const a = makeCtx();
  await dispatch("/logout", a.ctx);
  assert.deepEqual(a.calls, [["forget"], ["exit", 0]]);

  const b = makeCtx({ newCode: true });
  await dispatch("/logout", b.ctx);
  assert.deepEqual(b.calls, [["forget"]]);
  assert.match(b.notices.at(-1)[1], /New access code saved/);

  const c = makeCtx();
  c.ctx.config.env = { code: true };
  await dispatch("/logout", c.ctx);
  assert.deepEqual(c.calls, [], "a code from the environment cannot be forgotten");
  assert.match(c.notices[0][1], /FIRAS_CODE/);
});

test("/update runs the installer, then ends the program; failures are explained", async () => {
  const good = makeCtx({ runUpdate: async options => { options.onOutput("line one\nline two\n", "stdout"); return { ok: true, code: 0, reason: "" }; } });
  await dispatch("/update", good.ctx);
  assert.deepEqual(good.calls.at(-1), ["exit", 0]);
  assert.ok(good.printed.some(line => line.includes("line two")), "installer output is shown");

  for (const [reason, pattern] of [["not_configured", /where to update from/], ["inside_app", /another folder/], ["dev_checkout", /git/], ["failed", /code 5/]]) {
    const bad = makeCtx({ runUpdate: async () => ({ ok: false, code: 5, reason }) });
    await dispatch("/update", bad.ctx);
    assert.equal(bad.calls.some(call => call[0] === "exit"), false);
    assert.equal(bad.notices.at(-1)[0], "error");
    assert.match(bad.notices.at(-1)[1], pattern, reason);
    assert.match(updateFailureText({ reason, code: 5 }), pattern);
  }
});

test("/resume and /sessions: pick, resume by id, refuse other folders", async () => {
  const work = tempDir();
  const other = tempDir();
  try {
    const mine = createSession({ cwd: work.dir });
    mine.addUser("first conversation about parsing");
    mine.addAssistant({ content: [{ type: "text", text: "ok" }] });
    mine.save();
    const theirs = createSession({ cwd: other.dir });
    theirs.addUser("a conversation elsewhere");
    theirs.addAssistant({ content: [{ type: "text", text: "ok" }] });
    theirs.save();

    const a = makeCtx({ cwd: work.dir, pickIndex: 0 });
    await dispatch("/resume", a.ctx);
    const menu = a.calls[0][1];
    assert.equal(menu.items.length, 1, "only this folder's conversations are listed");
    assert.match(menu.items[0].label, /first conversation/);
    assert.deepEqual(a.calls[1], ["resume", mine.id]);

    const byId = makeCtx({ cwd: work.dir });
    await dispatch(`/resume ${mine.id.slice(0, 22)}`, byId.ctx);
    assert.deepEqual(byId.calls, [["resume", mine.id]], "a unique prefix is enough");

    const missing = makeCtx({ cwd: work.dir });
    await dispatch("/resume 19990101-000000-abcdef", missing.ctx);
    assert.equal(missing.calls.length, 0);
    assert.match(missing.notices[0][1], /No saved conversation matches/);

    const all = makeCtx({ cwd: work.dir, pickIndex: 0 });
    await dispatch("/sessions", all.ctx);
    assert.equal(all.calls[0][1].items.length, 2, "/sessions lists every folder");

    const foreign = makeCtx({ cwd: work.dir });
    await dispatch(`/resume ${theirs.id}`, foreign.ctx);
    assert.equal(foreign.calls.length, 0, "a conversation of another folder is not resumed");
    assert.match(foreign.notices[0][1], /belongs to/);
    assert.ok(foreign.notices[0][1].includes(other.dir));

    fs.rmSync(process.env.FIRAS_HOME, { recursive: true, force: true });
    fs.mkdirSync(process.env.FIRAS_HOME, { recursive: true });
    const none = makeCtx({ cwd: work.dir });
    await dispatch("/resume", none.ctx);
    assert.match(none.notices[0][1], /no saved conversations/i);
  } finally {
    work.remove();
    other.remove();
  }
});

test("the prompt's command menu has a name and a description for each command", () => {
  const bare = commandMenu();
  const slashed = commandMenu({ slash: true });
  assert.equal(bare.length, COMMANDS.length);
  assert.ok(bare.every(entry => !entry.name.startsWith("/") && entry.description));
  assert.ok(slashed.every(entry => entry.name.startsWith("/")));
});
