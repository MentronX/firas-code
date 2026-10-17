// A whole interactive session: main() with a fake Screen and scripted key presses, the real prompt editor, the real
// tools and the mock service.
import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setLang } from "../../src/i18n/index.js";
import { setArabicMode, stripAnsi } from "../../src/text/display.js";
import { main } from "../../src/cli.js";
import { VERSION } from "../../src/brand.js";
import { loadConfig, saveConfig } from "../../src/config.js";
import { loadHistory } from "../../src/ui/history.js";
import { listSessions, loadSession } from "../../src/agent/session.js";
import { startMockService, textReply, toolReply } from "../helpers/mock-service.js";
import { createCapture, createEmptyStdin, createFakeScreen, sleep, tempDir, useTempHome, waitFor } from "./helpers.js";

const home = useTempHome("firas-session-");
before(() => { home.reset(); setLang("en"); });
beforeEach(() => { home.reset(); setLang("en"); setArabicMode("on"); });
after(() => { setLang("en"); setArabicMode("auto"); home.restore(); });

const PROMPT_READY = /Type a message/;

// Every app a test starts is shut down afterwards, whatever the test did, so a failure cannot leave servers or timers
// behind and hang the whole run.
const started = [];
afterEach(async () => {
  while (started.length) {
    const app = started.pop();
    if (!app.screen.disposed) app.signals.emit("SIGINT");
    await Promise.race([app.done.catch(() => {}), sleep(1500)]);
    await app.service.close().catch(() => {});
    app.work.remove();
  }
});

async function start({ script = [], files = {}, config = { lang: "en" }, args = [], io = {}, service: given } = {}) {
  const service = given || await startMockService(script);
  const work = tempDir();
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work.dir, name)), { recursive: true });
    fs.writeFileSync(path.join(work.dir, name), content);
  }
  if (config) saveConfig({ code: service.code, ...config });
  const screen = createFakeScreen({ width: 90, height: 30 });
  const stderr = createCapture();
  const signals = new EventEmitter();
  const run = {
    screen, stdin: createEmptyStdin(), stdout: createCapture(), stderr,
    env: { FIRAS_ORIGIN: service.origin },
    cwd: work.dir, process: signals, graceMs: 0,
    clientOptions: { backoffMs: [1, 1, 1, 1] },
    ...io,
  };
  const done = main(args, run);
  const app = {
    service, work, screen, stderr, signals, done, run,
    posts: () => service.requests.filter(r => r.method === "POST" && r.path.endsWith("/v1/messages")),
    ready: () => waitFor(() => PROMPT_READY.test(screen.liveText()), { label: "the prompt" }),
    say: async text => { await app.ready(); screen.type(text); screen.enter(); },
    saw: (pattern, label) => waitFor(() => (pattern instanceof RegExp ? pattern.test(screen.text()) : screen.text().includes(pattern)), { label: label || String(pattern) }),
    sawLive: (pattern, label) => waitFor(() => pattern.test(screen.liveText()), { label: label || String(pattern) }),
    async finish() {
      if (!screen.disposed) { await app.ready(); screen.type("/exit"); screen.enter(); }
      const code = await done;
      await service.close();
      work.remove();
      return code;
    },
  };
  started.push(app);
  return app;
}

test("start-up shows the banner and the prompt; /exit leaves cleanly and restores the terminal", async () => {
  const app = await start();
  await app.ready();
  const banner = app.screen.text();
  assert.match(banner, /Firas Code 2/);
  assert.ok(banner.includes(`v${VERSION}`));
  assert.ok(banner.includes(path.basename(app.work.dir)) || banner.includes("…"), "the folder is named");
  assert.match(banner, /effort: medium/);
  assert.match(app.screen.liveText(), /default \(Shift\+Tab to switch\)|mode: default/);
  assert.ok(app.screen.titles.length >= 1);
  app.screen.type("/exit");
  app.screen.enter();
  assert.equal(await app.done, 0);
  assert.equal(app.screen.disposed, true);
  assert.equal(app.screen.subscribers, 0);
  await app.service.close();
  app.work.remove();
});

test("the terminal input is switched on once for the whole session, not once per prompt and per turn", async () => {
  // Switching it off and on between a turn and the prompt leaves Windows consoles that cannot end the process.
  const app = await start({ script: [textReply("one"), textReply("two")] });
  await app.say("first");
  await app.saw("one");
  await app.say("/help");
  await app.say("second");
  await app.saw("two");
  await app.ready();
  assert.equal(app.screen.inputStarts, 1);
  assert.ok(app.screen.subscribers >= 2, "the session holds a listener of its own besides the prompt's");
  assert.equal(await app.finish(), 0);
  assert.equal(app.screen.subscribers, 0);
});

test("what is typed while the agent works is kept and shows up in the next prompt", async () => {
  const slow = { ...textReply("a slow answer that takes a while ".repeat(6), { chunk: 3 }), eventDelayMs: 20 };
  const app = await start({ script: [slow] });
  await app.say("go");
  await app.saw(/a slow answer/);
  app.screen.type("and then");
  app.screen.type("!");
  app.screen.press("backspace");
  app.screen.type(" fix it");
  app.screen.enter();
  await app.sawLive(/and then fix it/, "the typed-ahead text in the live region");
  await waitFor(() => /and then fix it/.test(app.screen.liveText()) && !/esc to interrupt/i.test(app.screen.liveText()), { label: "the prompt holding it" });
  assert.equal(app.posts().length, 1, "Enter during the turn sent nothing");
  app.screen.ctrl("u");
  assert.equal(await app.finish(), 0);
});

test("Ctrl+D and Ctrl+C on an empty prompt leave too", async () => {
  const a = await start();
  await a.ready();
  a.screen.ctrl("d");
  assert.equal(await a.done, 0);
  await a.service.close(); a.work.remove();
  const b = await start();
  await b.ready();
  b.screen.ctrl("c");
  assert.equal(await b.done, 0);
  await b.service.close(); b.work.remove();
});

test("an Arabic prompt goes out as typed and the streamed Arabic answer comes back shaped", async () => {
  const app = await start({ script: [textReply("بالطبع! إليك الدالة:\n\n```js\nfunction add(a, b) { return a + b; }\n```\n\nملف `src/add.js` جاهز.", { chunk: 4 })] });
  await app.say("اكتب دالة تجمع رقمين");
  await app.saw("function add(a, b)", "the code block");
  await app.ready();
  const [request] = app.posts();
  assert.equal(request.body.messages[0].content[0].text, "اكتب دالة تجمع رقمين");
  const out = app.screen.printed.join("\n");
  assert.match(out, /[ﭐ-﻿]/, "Arabic is shaped");
  assert.ok(out.includes("src/add.js"), "the Latin file name stays readable");
  assert.ok(!/[ا-ي]{3}/.test(stripAnsi(out).replace(/[ﭐ-﻿]+/g, "")), "no unshaped runs are left behind");
  assert.deepEqual(loadHistory(), ["اكتب دالة تجمع رقمين"], "saved in the prompt history");
  assert.equal(await app.finish(), 0);
});

test("/effort changes the next request body; ultracode announces itself and asks for the top level", async () => {
  const app = await start({ script: [textReply("one"), textReply("two"), textReply("three"), textReply("four")] });
  await app.say("first");
  await app.saw("one");
  await app.say("/effort high");
  await app.saw("Effort set to high.");
  await app.say("second");
  await app.saw("two");
  await app.say("/effort ultracode");
  await app.saw("U L T R A C O D E");
  await app.saw("two independent reviews");
  await app.say("third");
  await app.saw("three");
  await app.say("/effort low");
  await app.saw("Effort set to low.");
  await app.say("then ultracode please");
  await app.saw("four");
  const [a, b, c, d] = app.posts().map(r => r.body);
  assert.deepEqual(a.output_config, { effort: "medium" });
  assert.deepEqual(b.output_config, { effort: "high" });
  assert.deepEqual(c.output_config, { effort: "max" });
  assert.match(c.system.map(s => s.text).join("\n"), /# Ultracode/);
  assert.deepEqual(d.output_config, { effort: "max" }, "naming ultracode in a message runs that message at ultracode");
  assert.match(d.system.map(s => s.text).join("\n"), /# Ultracode/);
  assert.equal(loadConfig({ env: {} }).effort, "low", "the setting itself is not changed by the word");
  assert.equal(await app.finish(), 0);
});

test("a Read runs without asking; an Edit asks, shows the diff, and runs once approved", async () => {
  const app = await start({
    files: { "a.js": "const a = 1;\nconst b = 2;\n" },
    script: [
      toolReply([{ name: "Read", input: { path: "a.js" } }], { text: "Looking." }),
      toolReply([{ name: "Edit", input: { path: "a.js", old_string: "const b = 2;", new_string: "const b = 3;" }, id: "call_edit_1" }]),
      textReply("All set."),
    ],
  });
  await app.say("change b to 3");
  await app.sawLive(/Permission needed/, "the permission box");
  assert.ok(!/Permission needed/.test(app.screen.text()), "the question is not in the scrollback");
  assert.match(app.screen.text(), /Read\(a\.js\)/, "the Read card is already done");
  const box = app.screen.liveText();
  assert.match(box, /Edit a\.js/);
  assert.match(box, /const b = 3;/, "the diff is previewed");
  assert.match(box, /1\. Yes, allow once/);
  assert.equal(app.posts().length, 2);
  app.screen.enter();
  await app.saw("All set.");
  assert.equal(fs.readFileSync(path.join(app.work.dir, "a.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
  assert.match(app.screen.text(), /Edit\(a\.js\)/);
  assert.equal(await app.finish(), 0);
});

test("denying with feedback sends the feedback to the model, and nothing is changed", async () => {
  const app = await start({
    files: { "a.js": "const a = 1;\n" },
    script: [
      toolReply([{ name: "Read", input: { path: "a.js" } }]),
      toolReply([{ name: "Edit", input: { path: "a.js", old_string: "const a = 1;", new_string: "var a = 1;" }, id: "call_edit_1" }]),
      textReply("Understood, I will keep const."),
    ],
  });
  await app.say("use var");
  await app.sawLive(/Permission needed/);
  app.screen.type("4");
  app.screen.enter();
  await app.sawLive(/what Firas should do instead/, "the feedback line");
  app.screen.esc();
  await app.sawLive(/Permission needed/, "Esc goes back to the choices");
  assert.equal(app.posts().length, 2, "and the turn was not aborted");
  app.screen.type("4");
  app.screen.enter();
  await app.sawLive(/what Firas should do instead/);
  app.screen.type("keep const please");
  app.screen.enter();
  await app.saw("Understood, I will keep const.");
  assert.equal(fs.readFileSync(path.join(app.work.dir, "a.js"), "utf8"), "const a = 1;\n");
  const result = app.posts()[2].body.messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /keep const please/);
  assert.equal(await app.finish(), 0);
});

test("Esc on a permission box denies and does not abort the turn", async () => {
  const app = await start({
    files: { "a.js": "x\n" },
    script: [
      toolReply([{ name: "Read", input: { path: "a.js" } }]),
      toolReply([{ name: "Write", input: { path: "new.js", content: "y" }, id: "call_w" }]),
      textReply("Fine, skipped."),
    ],
  });
  await app.say("make new.js");
  await app.sawLive(/Permission needed/);
  app.screen.esc();
  await app.saw("Fine, skipped.");
  assert.equal(fs.existsSync(path.join(app.work.dir, "new.js")), false);
  assert.equal(await app.finish(), 0);
});

test("allow for this session: the second identical request does not ask again", async () => {
  const edit = id => toolReply([{ name: "Edit", input: { path: "a.js", old_string: id === 1 ? "one" : "two", new_string: id === 1 ? "two" : "three" }, id: `call_e${id}` }]);
  const app = await start({
    files: { "a.js": "one\n" },
    script: [toolReply([{ name: "Read", input: { path: "a.js" } }]), edit(1), textReply("first done"), edit(2), textReply("second done")],
  });
  await app.say("step one");
  await app.sawLive(/Permission needed/);
  app.screen.press("down");
  app.screen.enter();
  await app.saw("first done");
  await app.say("step two");
  await app.saw("second done");
  assert.equal(fs.readFileSync(path.join(app.work.dir, "a.js"), "utf8"), "three\n");
  assert.equal(await app.finish(), 0);
});

test("/clear starts a fresh conversation; the old one stays on disk", async () => {
  const app = await start({ script: [textReply("answer one"), textReply("answer two")] });
  await app.say("first topic");
  await app.saw("answer one");
  const before = app.screen.printed.length;
  await app.say("/clear");
  await waitFor(() => app.screen.printed.length > before + app.screen.height(), { label: "the screen being scrolled clear" });
  assert.match(app.screen.printed.slice(before).map(stripAnsi).join("\n"), /Firas Code 2/, "the banner is shown again");
  await app.say("second topic");
  await app.saw("answer two");
  const [first, second] = app.posts();
  assert.equal(first.body.messages.length, 1);
  assert.equal(second.body.messages.length, 1, "the earlier conversation is forgotten");
  assert.equal(listSessions({ cwd: app.work.dir }).length, 2);
  assert.equal(await app.finish(), 0);
});

test("Esc during the answer stops it, leaves a valid saved conversation, and the prompt works again", async () => {
  const slow = { ...textReply("a very long answer that keeps going ".repeat(12), { chunk: 3 }), eventDelayMs: 25 };
  const app = await start({ script: [slow, textReply("back again")] });
  await app.say("talk a lot");
  await app.saw(/a very long answer/, "the stream starting");
  app.screen.esc();
  await app.saw("[interrupted]");
  await app.ready();
  await sleep(50);
  assert.equal(app.service.inFlight(), 0, "the connection was released");
  const [meta] = listSessions({ cwd: app.work.dir });
  const saved = loadSession(meta.id);
  assert.equal(saved.messages[0].role, "user");
  assert.ok(saved.messages.every(m => m.content.length > 0));
  await app.say("hello again");
  await app.saw("back again");
  const followUp = app.posts()[1].body.messages;
  assert.equal(followUp.at(-1).content.at(-1).text, "hello again");
  assert.equal(await app.finish(), 0);
});

test("Ctrl+C twice during a turn leaves with 130", async () => {
  const slow = { ...textReply("long ".repeat(200), { chunk: 3 }), eventDelayMs: 30 };
  const app = await start({ script: [slow] });
  await app.say("go");
  await app.saw("long");
  app.screen.ctrl("c");
  app.screen.ctrl("c");
  assert.equal(await app.done, 130);
  assert.equal(app.screen.disposed, true);
  await app.service.close();
  app.work.remove();
});

test("SIGINT at the prompt leaves with 130 and restores the terminal", async () => {
  const app = await start();
  await app.ready();
  app.signals.emit("SIGINT");
  assert.equal(await app.done, 130);
  assert.equal(app.screen.disposed, true);
  await app.service.close();
  app.work.remove();
});

test("an unknown slash command gets a hint and is never sent to the model", async () => {
  const app = await start({ script: [] });
  await app.say("/hlep");
  await app.saw(/Unknown command \/hlep\. Did you mean \/help\?/);
  assert.equal(app.posts().length, 0);
  assert.equal(await app.finish(), 0);
});

test("/help, /status, /cost and /model print and keep the prompt", async () => {
  const app = await start({ script: [textReply("hi there")] });
  await app.say("hello");
  await app.saw("hi there");
  await app.say("/help");
  await app.saw("Keyboard");
  await app.say("/status");
  await app.saw(/Service\s+reachable/);
  await app.say("/cost");
  await app.saw(/Requests\s+1/);
  await app.say("/model");
  assert.equal(await app.finish(), 0);
});

test("/copy hands the last answer, as the model wrote it, to the clipboard", async () => {
  const copied = [];
  const answer = "هذا **مهم**: شغّل `npm test`";
  const app = await start({ script: [textReply(answer)], io: { copyToClipboard: async (text) => { copied.push(text); return { ok: true, tool: "fake" }; } } });
  await app.say("ما الأمر؟");
  await app.saw(/npm test/);
  await app.say("/copy");
  await app.saw(/Copied my last answer/);
  assert.deepEqual(copied, [answer]);
  assert.equal(await app.finish(), 0);
});

test("the first message can come from the command line", async () => {
  const app = await start({ script: [textReply("started with it")], args: ["fix", "the", "bug"] });
  await app.saw("started with it");
  assert.equal(app.posts()[0].body.messages[0].content[0].text, "fix the bug");
  assert.match(app.screen.text(), /fix the bug/, "echoed");
  assert.equal(await app.finish(), 0);
});

test("the prompt history survives a restart: Up brings the last message back", async () => {
  const first = await start({ script: [textReply("ok")] });
  await first.say("remember me");
  await first.saw("ok");
  assert.equal(await first.finish(), 0);
  const second = await start();
  await second.ready();
  second.screen.press("up");
  await waitFor(() => /\/exit/.test(second.screen.liveText()), { label: "the newest entry (the /exit that ended the first run)" });
  second.screen.esc();
  second.screen.press("up");
  await waitFor(() => /remember me/.test(second.screen.liveText()), { label: "the recalled message" });
  second.screen.ctrl("c");
  second.screen.ctrl("c");
  await second.done;
  await second.service.close();
  second.work.remove();
});

test("Shift+Tab at the prompt cycles the permission mode and the footer follows", async () => {
  const app = await start();
  await app.ready();
  assert.match(app.screen.liveText(), /mode: default/);
  app.screen.press("backtab", { shift: true });
  await waitFor(() => /mode: accept edits/.test(app.screen.liveText()), { label: "accept edits" });
  app.screen.press("backtab", { shift: true });
  await waitFor(() => /mode: plan/.test(app.screen.liveText()), { label: "plan" });
  assert.equal(await app.finish(), 0);
});

test("/mode bypass warns; --yolo starts in bypass", async () => {
  const app = await start({ args: ["--yolo"] });
  await app.ready();
  assert.match(app.screen.liveText(), /mode: bypass/);
  await app.say("/mode default");
  await waitFor(() => /mode: default/.test(app.screen.liveText()), { label: "default" });
  await app.say("/mode bypass");
  await app.saw(/Almost nothing will ask first/);
  assert.equal(await app.finish(), 0);
});

test("a plan is shown, approved, and the mode switches so work can begin", async () => {
  const app = await start({
    args: ["--mode", "plan"],
    script: [toolReply([{ name: "ExitPlanMode", input: { plan: "# Plan\n\n- change a.js" }, id: "call_plan" }]), textReply("Starting now.")],
  });
  await app.ready();
  assert.match(app.screen.liveText(), /mode: plan/);
  await app.say("plan it");
  await app.sawLive(/Start with this plan\?/);
  assert.match(app.screen.text(), /change a\.js/);
  app.screen.press("down");
  app.screen.enter();
  await app.saw("Starting now.");
  await app.ready();
  assert.match(app.screen.liveText(), /mode: accept edits/);
  const result = app.posts()[1].body.messages.at(-1).content[0];
  assert.match(result.content, /approved the plan/);
  assert.equal(await app.finish(), 0);
});

test("a question from the model is asked in a menu and the answer goes back", async () => {
  const app = await start({
    script: [
      toolReply([{ name: "AskUserQuestion", input: { question: "Which framework?", options: [{ label: "React" }, { label: "Vue" }] }, id: "call_q" }]),
      textReply("Using Vue."),
    ],
  });
  await app.say("build a ui");
  await app.sawLive(/Which framework\?/);
  app.screen.press("down");
  app.screen.enter();
  await app.saw("Using Vue.");
  assert.match(app.posts()[1].body.messages.at(-1).content[0].content, /The user answered: Vue/);
  assert.equal(await app.finish(), 0);
});

test("a task list pinned during the turn is committed at its end", async () => {
  const app = await start({
    script: [
      toolReply([{ name: "TodoWrite", input: { todos: [{ content: "Do A", activeForm: "Doing A", status: "in_progress" }, { content: "Do B", activeForm: "Doing B", status: "pending" }] } }]),
      textReply("Working on it."),
    ],
  });
  await app.say("two things");
  await app.saw("Working on it.");
  await app.ready();
  assert.match(app.screen.text(), /Doing A/);
  assert.match(app.screen.text(), /Do B/);
  assert.equal(await app.finish(), 0);
});

test("/resume brings an earlier conversation back with its recap", async () => {
  const first = await start({ script: [textReply("earlier answer here")] });
  const workDir = first.work.dir;
  await first.say("an earlier question");
  await first.saw("earlier answer here");
  assert.equal(await first.finish(), 0);
  const service = await startMockService([textReply("continuing now")]);
  fs.mkdirSync(workDir, { recursive: true });
  const app = await start({ service, config: { lang: "en" }, io: { cwd: workDir } });
  await app.say("/resume");
  await app.sawLive(/Resume a conversation/);
  assert.match(app.screen.liveText(), /an earlier question/);
  app.screen.enter();
  await app.saw(/Resumed: an earlier question/);
  assert.match(app.screen.text(), /earlier answer here/, "the recap shows the last answer");
  const shown = app.screen.printed.map(line => line.replace(/[[0-9;]*m/g, ""));
  const at = shown.findIndex(line => line.includes("earlier answer here"));
  assert.equal(shown[at - 1].trim(), "", "a blank line between the recapped question and the answer, as in a live turn");
  await app.say("and now?");
  await app.saw("continuing now");
  const body = app.posts()[0].body.messages;
  assert.equal(body[0].content[0].text, "an earlier question");
  assert.equal(body.at(-1).content.at(-1).text, "and now?");
  assert.equal(await app.finish(), 0);
});

test("--continue resumes the latest conversation of the folder at start-up", async () => {
  const first = await start({ script: [textReply("saved answer")] });
  const workDir = first.work.dir;
  await first.say("saved question");
  await first.saw("saved answer");
  assert.equal(await first.finish(), 0);
  fs.mkdirSync(workDir, { recursive: true });
  const app = await start({ script: [textReply("carry on")], args: ["-c"], io: { cwd: workDir } });
  await app.ready();
  assert.match(app.screen.text(), /resumed session/);
  assert.match(app.screen.text(), /saved answer/);
  await app.say("next");
  await app.saw("carry on");
  assert.equal(app.posts()[0].body.messages[0].content[0].text, "saved question");
  assert.equal(await app.finish(), 0);
});

test("first run: pick a language, paste the code (hidden), and land at the prompt", async () => {
  const service = await startMockService([textReply("welcome aboard")], { code: "FC2-NEWBIE-CODE00" });
  const app = await start({ service, config: null, io: { env: { FIRAS_ORIGIN: service.origin } } });
  await waitFor(() => /Choose your language/.test(app.screen.liveText()), { label: "the language question" });
  assert.match(app.screen.text(), /English/);
  app.screen.type("2");
  app.screen.enter();
  await waitFor(() => /Paste your access code/.test(app.screen.text()), { label: "the code question" });
  await waitFor(() => app.screen.subscribers > 0);
  const secret = "FC2-NEWBIE-CODE00";
  app.screen.type(secret);
  assert.ok(!app.screen.allText().includes(secret), "the code is not visible on screen while typing");
  assert.match(app.screen.liveText(), /•{8,}/);
  app.screen.enter();
  await app.saw(/Welcome to Firas Code 2/);
  assert.ok(!app.screen.allText().includes(secret), "nor afterwards");
  await app.ready();
  const config = loadConfig({ env: {} });
  assert.equal(config.code, secret);
  assert.equal(config.lang, "en");
  await app.say("hello");
  await app.saw("welcome aboard");
  assert.equal(app.posts()[0].headers.authorization, `Bearer ${secret}`);
  assert.equal(await app.finish(), 0);
});

test("first run with a wrong code: friendly refusal, three attempts, then a clean exit with 1", async () => {
  const service = await startMockService([], { code: "FC2-REALCODE-000000" });
  const app = await start({ service, config: null, io: { env: { FIRAS_ORIGIN: service.origin } } });
  await waitFor(() => /Choose your language/.test(app.screen.liveText()));
  app.screen.type("1");
  app.screen.enter();
  const checks = () => service.requests.filter(r => r.path.endsWith("/v1/models")).length;
  for (let i = 1; i <= 3; i++) {
    // The masked prompt is up once its box (two rules and a line) is in the live region.
    await waitFor(() => app.screen.subscribers > 0 && app.screen.live.length >= 3 && checks() === i - 1, { label: `the code prompt, attempt ${i}` });
    await sleep(20);
    app.screen.type(`FC2-WRONG-CODE-${i}${i}${i}${i}`);
    app.screen.enter();
    await waitFor(() => checks() === i, { label: `request ${i}` });
  }
  assert.equal(await app.done, 1);
  assert.equal(loadConfig({ env: {} }).code, "");
  assert.match(app.screen.text(), /[ﭐ-﻿]/, "the messages are in the language that was picked");
  await service.close();
  app.work.remove();
});

test("/logout forgets the code; an empty answer to the new-code question ends the program", async () => {
  const app = await start();
  await app.say("/logout");
  await waitFor(() => /Paste your access code/.test(app.screen.text()), { label: "the code question" });
  assert.equal(loadConfig({ env: {} }).code, "");
  await waitFor(() => app.screen.subscribers > 0);
  app.screen.ctrl("c");
  assert.equal(await app.done, 0);
  await app.service.close();
  app.work.remove();
});

test("a code in FIRAS_CODE is used and /logout explains it cannot forget it", async () => {
  const service = await startMockService([textReply("fine")]);
  const app = await start({ service, config: { lang: "en" }, io: { env: { FIRAS_ORIGIN: service.origin, FIRAS_CODE: service.code } } });
  await app.say("/logout");
  await app.saw(/FIRAS_CODE/);
  await app.say("hi");
  await app.saw("fine");
  assert.equal(await app.finish(), 0);
});

test("a corrupt settings file is replaced with a notice, and the session still starts", async () => {
  const service = await startMockService([]);
  fs.writeFileSync(path.join(home.dir, "config.json"), "{ not json");
  const app = await start({ service, config: null, io: { env: { FIRAS_ORIGIN: service.origin, FIRAS_LANG: "en", FIRAS_CODE: service.code } } });
  await app.ready();
  assert.match(app.screen.text(), /settings file was damaged/);
  assert.ok(fs.existsSync(path.join(home.dir, "config.json.bad")));
  assert.equal(await app.finish(), 0);
});

test("a service error in the middle of a conversation is explained and the prompt comes back", async () => {
  const { errorReply } = await import("../helpers/mock-service.js");
  const app = await start({ script: [errorReply(429, "daily_limit"), textReply("tomorrow it is")] });
  await app.say("hi");
  await app.saw(/usage limit/);
  await app.ready();
  await app.say("hi again");
  await app.saw("tomorrow it is");
  assert.equal(await app.finish(), 0);
});

test("the model's reasoning text never reaches the screen or the saved conversation; there is no command or key for it", async () => {
  const MARKER = "REASONING-MARKER-5c1e";
  const app = await start({
    files: { "a.txt": "hello\n" },
    script: [
      toolReply([{ name: "Read", input: { path: "a.txt" }, id: "call_r1" }], { text: "Reading.", thinking: `${MARKER} first` }),
      textReply("answer", { thinking: `${MARKER} second` }),
    ],
  });
  await app.say("/thinking on");
  await app.saw(/Unknown command \/thinking/);
  await app.say("question");
  await app.saw("answer");
  app.screen.ctrl("t");
  await app.ready();
  assert.ok(!app.screen.allText().includes(MARKER), "the text itself never reaches the screen");
  assert.ok(!app.screen.allText().includes("Thinking text"), "and nothing offers to show it");
  // Inside the turn's tool loop the thinking block still goes back to the service, exactly as before.
  const second = app.posts()[1].body;
  assert.ok(second.messages.some(m => m.role === "assistant" && m.content.some(b => b.type === "thinking" && b.thinking.includes(MARKER))));
  assert.equal(await app.finish(), 0);
  const saved = fs.readdirSync(path.join(home.dir, "sessions")).map(name => fs.readFileSync(path.join(home.dir, "sessions", name), "utf8")).join("\n");
  assert.ok(saved.includes("answer") && !saved.includes(MARKER), "the saved conversation holds no reasoning text");
});
