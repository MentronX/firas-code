import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../../src/i18n/index.js";
import { setColorLevel, colorLevel, sym } from "../../src/ui/theme.js";
import { setArabicMode, stripAnsi, stringWidth } from "../../src/text/display.js";
import { createInteractiveUi } from "../../src/ui/interactive.js";
import { UP, DOWN } from "../../src/ui/views.js";
import { createFakeScreen, waitFor, sleep } from "./helpers.js";

const colorBefore = colorLevel();
before(() => { setLang("en"); setArabicMode("on"); setColorLevel(0); });
after(() => { setColorLevel(colorBefore); setArabicMode("auto"); setLang("en"); });

const rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function setup(options = {}) {
  const screen = createFakeScreen({ width: options.width ?? 80, height: options.height ?? 30 });
  const calls = { abort: 0, exit: 0, cycle: 0, plan: [] };
  const ui = createInteractiveUi({
    screen,
    graceMs: 0,
    cycleMode: () => { calls.cycle++; },
    onPlanDecision: d => calls.plan.push(d),
    now: options.now,
    readPrompt: options.readPrompt,
  });
  const begin = () => ui.turnBegin({ abort: () => { calls.abort++; }, exit: () => { calls.exit++; } });
  return { screen, ui, calls, begin };
}

const text = screen => screen.text();

test("streamed text lands in the scrollback line by line and the raw text is kept for /copy", async () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.requestStart({ step: 1, effort: "medium" });
  ui.textStart();
  ui.textDelta("Hello **wor");
  ui.textDelta("ld**, this is a long sentence that has to wrap somewhere because the terminal is only eighty columns wide, yes.\n");
  ui.textDelta("Second line");
  ui.textEnd();
  ui.requestEnd();
  ui.turnFinish();
  const out = text(screen);
  assert.match(out, /Hello world, this is a long sentence/);
  assert.match(out, /Second line/);
  assert.ok(screen.printed.length >= 3, "wrapped into several lines");
  assert.ok(screen.printed.every(line => stringWidth(line) <= 78), "no line is wider than the content area");
  assert.equal(ui.lastAnswer(), "Hello **world**, this is a long sentence that has to wrap somewhere because the terminal is only eighty columns wide, yes.\nSecond line");
});

test("an escape sequence split across two deltas never shows", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.textStart();
  ui.textDelta("before \x1b[3");
  ui.textDelta("1mcoloured\x1b[0m after\n");
  ui.textEnd();
  ui.turnFinish();
  assert.match(text(screen), /before coloured after/);
  assert.ok(!/\x1b\[3|\[31m/.test(screen.printed.join("\n").replace(/\x1b\[[0-9;]*m/g, "")), "no fragment left");
  assert.equal(ui.lastAnswer(), "before coloured after\n");
});

test("Arabic answers are shaped and ordered, and /copy keeps the logical text", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.textStart();
  const answer = "قم بتشغيل npm test ثم ارجع\n";
  for (const piece of [answer.slice(0, 7), answer.slice(7)]) ui.textDelta(piece);
  ui.textEnd();
  ui.turnFinish();
  const out = screen.printed.join("\n");
  assert.match(out, /[ﭐ-﻿]/, "letters are joined into presentation forms");
  assert.ok(out.includes("npm test"), "Latin stays readable");
  assert.equal(ui.lastAnswer(), answer);
  const line = stripAnsi(screen.printed.find(l => /npm/.test(l)));
  assert.ok(line.indexOf("npm") < line.length - 8, "the RTL part sits right of the Latin snippet");
});

test("while a turn runs the live region shows a spinner; when it ends nothing is left", async () => {
  const { screen, ui, begin } = setup();
  begin();
  await waitFor(() => screen.live.length > 0, { label: "the live region" });
  assert.equal(screen.live.at(-1).trim().length > 0, true, "the last live line is the spinner");
  assert.match(screen.liveText(), /esc to interrupt/i);
  ui.turnFinish();
  assert.deepEqual(screen.live, []);
  assert.equal(screen.subscribers, 0, "the key listener is released");
});

test("the partial line of the answer sits above the spinner", async () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.textStart();
  ui.textDelta("an unfinished sentence without a newline");
  await waitFor(() => /unfinished sentence/.test(screen.liveText()), { label: "the partial line" });
  const live = screen.live.map(stripAnsi);
  assert.ok(live.findIndex(l => /unfinished sentence/.test(l)) < live.findIndex(l => /esc to interrupt/i.test(l)));
  ui.textEnd();
  ui.turnFinish();
  assert.match(text(screen), /an unfinished sentence without a newline/, "committed when the block ends");
});

test("a tool card: running in the live region, committed as one block when it ends", async () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "t1", name: "Read", summary: "src/app.js", input: { path: "src/app.js" }, readOnly: true });
  assert.match(screen.liveText(), new RegExp(`Read\\(src/app\\.js\\)`));
  assert.equal(text(screen).includes("Read("), false, "nothing committed yet");
  ui.toolEnd({ id: "t1", name: "Read", ok: true, summary: "Read 120 lines", ms: 12 });
  const lines = screen.printed.map(stripAnsi).filter(Boolean);
  assert.deepEqual(lines.slice(-2), [`  ${sym.bullet} Read(src/app.js)`, `    ${sym.corner} Read 120 lines`]);
  assert.ok(!/Read\(src/.test(screen.liveText()), "gone from the live region");
  ui.turnFinish();
});

test("parallel tools never interleave their cards", () => {
  const { screen, ui, begin } = setup();
  begin();
  for (const id of ["a", "b", "c"]) ui.toolStart({ id, name: "Read", summary: `file-${id}.js`, readOnly: true });
  const liveNow = screen.liveText();
  for (const id of ["a", "b", "c"]) assert.ok(liveNow.includes(`file-${id}.js`));
  ui.toolEnd({ id: "c", name: "Read", ok: true, summary: "3 lines" });
  ui.toolEnd({ id: "a", name: "Read", ok: true, summary: "1 line" });
  ui.toolEnd({ id: "b", name: "Read", ok: false, summary: "File not found" });
  const lines = screen.printed.map(stripAnsi).filter(Boolean);
  assert.deepEqual(lines, [
    `  ${sym.bullet} Read(file-c.js)`, `    ${sym.corner} 3 lines`,
    `  ${sym.bullet} Read(file-a.js)`, `    ${sym.corner} 1 line`,
    `  ${sym.bullet} Read(file-b.js)`, `    ${sym.corner} File not found`,
  ]);
  ui.turnFinish();
});

test("live output of a running command shows its last three lines; the Agent tool appends its steps", async () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "b", name: "Bash", summary: "npm test", readOnly: false });
  ui.toolProgress("b", "one\ntwo\nthree\nfour\nfive");
  await waitFor(() => /five/.test(screen.liveText()), { label: "progress" });
  const live = screen.liveText();
  assert.ok(/three/.test(live) && /four/.test(live) && /five/.test(live));
  assert.ok(!/\bone\b|\btwo\b/.test(live));
  ui.toolProgress("b", "six");
  await waitFor(() => /six/.test(screen.liveText()), { label: "snapshot replace" });
  assert.ok(!/five/.test(screen.liveText()), "a shell tool sends snapshots: the latest replaces the earlier");

  ui.toolStart({ id: "g", name: "Agent", summary: "find usages", readOnly: true });
  for (const step of ["Grep foo", "Read a.js", "Read b.js", "Read c.js"]) ui.toolProgress("g", step);
  await waitFor(() => /Read c\.js/.test(screen.liveText()), { label: "agent steps" });
  const agent = screen.liveText();
  assert.ok(/Read a\.js/.test(agent) && /Read c\.js/.test(agent) && !/Grep foo/.test(agent));
  ui.turnFinish();
});

test("progress text cannot inject escape sequences into the live region", async () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "b", name: "Bash", summary: "x" });
  ui.toolProgress("b", "\x1b[2J\x1b[Hbuild started");
  await waitFor(() => /build started/.test(screen.liveText()), { label: "progress" });
  assert.ok(!screen.live.join("").includes("\x1b[2J"));
  ui.turnFinish();
});

test("a long result is folded; Ctrl+O prints it in full", () => {
  const { screen, ui, begin } = setup();
  begin();
  const body = Array.from({ length: 30 }, (_, i) => `output line ${i + 1}`).join("\n");
  ui.toolStart({ id: "b", name: "Bash", summary: "npm test" });
  ui.toolEnd({ id: "b", name: "Bash", ok: true, summary: "Done", body });
  const before = text(screen);
  assert.ok(before.includes("output line 8") && !before.includes("output line 9"));
  assert.match(before, /\+22 lines \(Ctrl\+O to expand\)/);
  screen.ctrl("o");
  const after = text(screen);
  assert.ok(after.includes("output line 30"));
  assert.match(after, /Full output/);
  ui.turnFinish();
  const second = setup();
  second.begin();
  second.screen.ctrl("o");
  assert.match(second.screen.text(), /Nothing to expand/);
  second.ui.turnFinish();
});

test("an edit card shows its diff", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "e", name: "Edit", summary: "src/a.js" });
  ui.toolEnd({ id: "e", name: "Edit", ok: true, summary: "Edited 1 place", diff: { path: "src/a.js", oldText: "let a = 1;\nlet b = 2;\n", newText: "let a = 1;\nlet b = 3;\n" } });
  const out = text(screen);
  assert.match(out, /let b = 2;/);
  assert.match(out, /let b = 3;/);
  ui.turnFinish();
});

test("the task list is pinned while the turn runs and committed once at the end", async () => {
  const { screen, ui, begin } = setup();
  begin();
  const items = [{ content: "Write tests", status: "completed" }, { content: "Run build", activeForm: "Running build", status: "in_progress" }, { content: "Ship", status: "pending" }];
  ui.todos(items);
  assert.match(screen.liveText(), /Running build/);
  assert.ok(!text(screen).includes("Write tests"), "not in the scrollback yet");
  ui.todos(items.map(i => ({ ...i, status: "completed" })));
  ui.turnEnd({ ms: 100, stopReason: "end_turn", steps: 2 });
  assert.equal((text(screen).match(/Write tests/g) || []).length, 1);
  assert.match(text(screen), /Ship/);
  ui.turnFinish();
  begin();
  ui.turnEnd({ ms: 100, stopReason: "end_turn", steps: 1 });
  assert.equal((text(screen).match(/Write tests/g) || []).length, 1, "an unchanged list is not printed twice");
  ui.turnFinish();
});

test("TodoWrite: the list is printed once per change of its tasks, a status change is one line, an identical list nothing", () => {
  const { screen, ui, begin } = setup();
  begin();
  const list = statuses => ["Write tests", "Run build", "Ship"].map((content, i) => ({ content, activeForm: `Doing ${content}`, status: statuses[i] }));
  const write = (id, items, summary) => {
    ui.toolStart({ id, name: "TodoWrite", summary: `${items.length} tasks`, input: { todos: items } });
    ui.todos(items);
    ui.toolEnd({ id, name: "TodoWrite", ok: true, summary });
  };
  const count = word => (text(screen).match(new RegExp(word, "g")) || []).length;

  write("t1", list(["pending", "pending", "pending"]), "0 of 3 done");
  assert.equal(count("TodoWrite"), 1);
  assert.equal(count("Write tests"), 1, "the whole list under the first card");
  assert.equal(count("Ship"), 1);

  write("t2", list(["in_progress", "pending", "pending"]), "0 of 3 done");
  assert.equal(count("TodoWrite"), 2, "one compact card for the change");
  assert.equal(count("Ship"), 1, "the list is not printed again");
  assert.match(text(screen), /Doing Write tests/);

  write("t3", list(["completed", "in_progress", "pending"]), "1 of 3 done");
  assert.equal(count("Ship"), 1);
  assert.match(text(screen), /Write tests[^\n]*Doing Run build[^\n]*1 of 3 done/, "the two tasks that moved, and the progress, on one line");

  const before = screen.printed.length;
  write("t4", list(["completed", "in_progress", "pending"]), "1 of 3 done");
  assert.equal(screen.printed.length, before, "an identical list adds nothing");

  const changed = list(["completed", "in_progress", "pending"]);
  changed.push({ content: "Celebrate", activeForm: "Celebrating", status: "pending" });
  write("t5", changed, "1 of 4 done");
  assert.equal(count("Ship"), 2, "new tasks: the list is printed again");
  assert.equal(count("Celebrate"), 1);

  write("t6", changed.map(item => ({ ...item, status: "completed" })), "4 of 4 done");
  assert.equal(count("Celebrate"), 2, "the finished tasks are named on one line");
  assert.equal(count("Ship"), 3);
  ui.turnEnd({ ms: 100, stopReason: "end_turn", steps: 3 });
  assert.equal(count("Celebrate"), 3, "the final state is printed once at the end of the turn");
  ui.turnEnd({ ms: 100, stopReason: "end_turn", steps: 3 });
  assert.equal(count("Celebrate"), 3, "and only once");
  ui.turnFinish();
});

test("a failed TodoWrite still gets its ordinary card", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "t1", name: "TodoWrite", summary: "3 tasks", input: {} });
  ui.toolEnd({ id: "t1", name: "TodoWrite", ok: false, summary: "Invalid arguments" });
  assert.match(text(screen), /TodoWrite/);
  assert.match(text(screen), /Invalid arguments/);
  ui.turnFinish();
});

test("thinking shows the spinner phase and, afterwards, one line with the time; the text is never shown and Ctrl+T does nothing", async () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.thinkingStart();
  ui.thinkingDelta("let me consider the options carefully");
  await sleep(120);
  assert.ok(!/consider the options/.test(screen.allText()), "never in the live region");
  assert.match(screen.liveText(), /esc to interrupt/i);
  const printedBefore = screen.printed.length;
  screen.ctrl("t");
  await sleep(120);
  assert.equal(screen.printed.length, printedBefore, "Ctrl+T prints nothing");
  assert.ok(!/consider the options/.test(screen.allText()), "and shows nothing");
  ui.thinkingEnd({ ms: 12_000, chars: 38 });
  assert.match(text(screen), /thought for 12 s/);
  assert.ok(!/consider the options/.test(screen.allText()), "the text itself never reaches the screen");
  ui.turnFinish();
});

test("a short thought leaves no trace; a long one leaves one line", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.thinkingStart();
  ui.thinkingEnd({ ms: 900, chars: 10 });
  assert.equal(text(screen).trim(), "");
  ui.thinkingStart();
  ui.thinkingEnd({ ms: 6000, chars: 10 });
  assert.match(text(screen), /thought for 6 s/);
  ui.turnFinish();
});

test("Esc aborts the turn; Ctrl+C aborts and a second Ctrl+C within two seconds leaves", () => {
  let clock = 1000;
  const { screen, ui, calls, begin } = setup({ now: () => clock });
  begin();
  screen.esc();
  assert.equal(calls.abort, 1);
  screen.ctrl("c");
  assert.equal(calls.abort, 2);
  assert.equal(calls.exit, 0);
  assert.match(screen.liveText(), /press Ctrl\+C again to leave/, "said on the working line");
  assert.ok(!/press Ctrl\+C again to leave/.test(text(screen)), "and not written into the scrollback");
  clock += 1500;
  screen.ctrl("c");
  assert.equal(calls.exit, 1);
  ui.turnFinish();
  const slow = setup({ now: () => clock });
  slow.begin();
  slow.screen.ctrl("c");
  clock += 2500;
  slow.screen.ctrl("c");
  assert.equal(slow.calls.exit, 0, "too late: it counts as a first press again");
  assert.equal(slow.calls.abort, 2);
  slow.ui.turnFinish();
});

test("Shift+Tab cycles the permission mode during a turn", () => {
  const { screen, ui, calls, begin } = setup();
  begin();
  screen.press("backtab", { shift: true });
  assert.equal(calls.cycle, 1);
  ui.turnFinish();
});

test("keys typed while no turn runs are not ours", () => {
  const { screen, ui, calls, begin } = setup();
  begin();
  ui.turnFinish();
  screen.esc();
  assert.equal(calls.abort, 0);
});

test("the footer appears for slow turns only, with the tokens of that turn; a stop reason is never repeated in it", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.usage({ inputTokens: 1000, outputTokens: 200, contextTokens: 1200 });
  ui.turnEnd({ ms: 1200, stopReason: "end_turn", steps: 1 });
  assert.equal(text(screen).trim(), "", "a quick normal turn adds nothing");
  ui.turnFinish();

  begin();
  ui.usage({ inputTokens: 4200, outputTokens: 1300, contextTokens: 5500 });
  ui.turnEnd({ ms: 9500, stopReason: "end_turn", steps: 3 });
  assert.match(text(screen), new RegExp(`${rx(sym.think)} 10 s ${rx(sym.dot)} ${rx(UP)} 3\\.2k ${rx(DOWN)} 1\\.1k`));
  ui.turnFinish();

  // The loop prints its own notice for an interrupted or failed turn: the footer neither adds a second "interrupted" nor
  // an "error" line under a red error, however the turn ended.
  for (const stopReason of ["aborted", "error", "empty", "max_steps", "max_tokens"]) {
    begin();
    ui.turnEnd({ ms: 700, stopReason, steps: 1 });
    ui.turnFinish();
  }
  assert.ok(!/interrupted|error|step limit|length limit/.test(text(screen)), text(screen));
  begin();
  ui.turnEnd({ ms: 7000, stopReason: "aborted", steps: 1 });
  assert.ok(!/interrupted/.test(text(screen).split(String.fromCharCode(10)).slice(-2).join(String.fromCharCode(10))), "a long interrupted turn gets the time only");
  ui.turnFinish();
});

test("notices are printed in order and coloured by level", () => {
  setColorLevel(3);
  try {
    const { screen, ui } = setup();
    ui.notice("info", "first");
    ui.notice("warn", "second");
    ui.notice("error", "third");
    const lines = screen.printed;
    assert.equal(lines.length, 3);
    assert.ok(lines[1].includes("\x1b[38;2;229;192;123m"), "warnings are yellow");
    assert.ok(lines[2].includes("\x1b[38;2;226;108;108m"), "errors are red");
    assert.deepEqual(lines.map(stripAnsi).map(l => l.trim().replace(/^\S+ /, "")), ["first", "second", "third"]);
  } finally { setColorLevel(0); }
});

test("a sub-agent without its own card gets a one-line start and end; with a card it just decorates it", async () => {
  const lone = setup();
  lone.ui.agentStart({ id: "x", description: "survey the code", kind: "explore" });
  lone.ui.agentEnd({ id: "x", ok: true, summary: "5 tool calls", ms: 100 });
  assert.match(lone.screen.text(), /Agent\(explore . survey the code\)/);
  assert.match(lone.screen.text(), /5 tool calls/);

  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "a", name: "Agent", summary: "survey the code", readOnly: true });
  ui.agentStart({ id: "a", description: "survey the code", kind: "general" });
  assert.match(screen.liveText(), /task . survey the code/);
  ui.agentEnd({ id: "a", ok: true, summary: "2 tool calls", ms: 5 });
  ui.toolEnd({ id: "a", name: "Agent", ok: true, summary: "2 tool calls" });
  assert.equal((screen.text().match(/2 tool calls/g) || []).length, 1, "reported once");
  ui.turnFinish();
});

test("echoing what the person typed", () => {
  const { screen, ui } = setup();
  ui.echoUser("fix the failing test");
  assert.equal(screen.printed.map(stripAnsi).filter(Boolean)[0], `  ${sym.prompt} fix the failing test`);
  const long = setup();
  long.ui.echoUser(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
  assert.match(long.screen.text(), /\+\d+ more lines/);
  const ar = setup();
  ar.ui.echoUser("اكتب دالة");
  assert.match(ar.screen.printed.join("\n"), /[ﭐ-﻿]/);
});

test("a permission dialog takes the keys: Esc denies instead of aborting", async () => {
  const { screen, ui, calls, begin } = setup();
  begin();
  const pending = ui.askPermission({ id: "p", tool: "Bash", title: "Run: npm test", summary: "npm test", risk: "medium", detail: "npm test", sessionKey: "Bash:npm test", sessionLabel: "Allow npm test this session" });
  assert.match(screen.liveText(), /Permission needed/);
  assert.match(screen.liveText(), /Allow npm test this session/);
  screen.esc();
  assert.deepEqual(await pending, { decision: "deny" });
  assert.equal(calls.abort, 0, "Esc inside a dialog is not the abort key");
  await waitFor(() => !/Permission needed/.test(screen.liveText()), { label: "the dialog closing" });
  assert.match(screen.liveText(), /esc to interrupt/i, "the spinner is back");
  screen.esc();
  assert.equal(calls.abort, 1, "and Esc aborts again");
  ui.turnFinish();
});

test("allow, allow-for-session and deny-with-feedback come back to the engine", async () => {
  const asked = [];
  const feedbackPrompt = async (screen, options) => { asked.push(options); return { type: "submit", text: "use a smaller change" }; };
  const { screen, ui, begin } = setup({ readPrompt: feedbackPrompt });
  begin();
  const req = { id: "p", tool: "Edit", title: "Edit a.js", summary: "a.js", risk: "low", sessionKey: "Edit:*", sessionLabel: "Allow edits this session" };
  let pending = ui.askPermission(req);
  screen.enter();
  assert.deepEqual(await pending, { decision: "allow" });
  pending = ui.askPermission(req);
  screen.press("down");
  screen.enter();
  assert.deepEqual(await pending, { decision: "allow-session" });
  pending = ui.askPermission(req);
  screen.type("4");
  screen.enter();
  assert.deepEqual(await pending, { decision: "deny", feedback: "use a smaller change" });
  assert.equal(asked[0].placeholder, "", "the feedback box does not suggest typing a message or a command");
  ui.turnFinish();
});

test("aborting the request's signal closes its dialog", async () => {
  const { screen, ui, begin } = setup();
  begin();
  const control = new AbortController();
  const pending = ui.askPermission({ id: "p", tool: "Bash", title: "Run x", risk: "medium", signal: control.signal });
  control.abort();
  assert.deepEqual(await pending, { decision: "deny" });
  await waitFor(() => screen.subscribers === 1, { label: "only the turn handler left" });
  ui.turnFinish();
});

test("a dialog also works with no turn running (commands use it)", async () => {
  const { screen, ui } = setup();
  const pending = ui.pick({ title: "Pick one", items: [{ label: "Alpha" }, { label: "Beta" }] });
  assert.match(screen.liveText(), /Pick one/);
  screen.press("down");
  screen.enter();
  assert.equal(await pending, 1);
  assert.deepEqual(screen.live, []);
  assert.equal(screen.subscribers, 0);
});

test("questions are answered from a menu or typed, and the answer is recorded in the scrollback", async () => {
  const { screen, ui, begin } = setup({ readPrompt: async () => ({ type: "submit", text: "Rust" }) });
  begin();
  let pending = ui.askQuestion({ question: "Which language?", options: [{ label: "TypeScript" }, { label: "JavaScript" }] });
  screen.press("down");
  screen.enter();
  assert.deepEqual(await pending, { answer: "JavaScript" });
  assert.match(screen.text(), /Which language\?/);
  assert.match(screen.text(), new RegExp(`${rx(sym.corner)} JavaScript`));
  pending = ui.askQuestion({ question: "Which one?", options: [{ label: "A" }] });
  screen.type("2");
  screen.enter();
  assert.deepEqual(await pending, { answer: "Rust" });
  pending = ui.askQuestion({ question: "Dismiss me", options: [{ label: "A" }] });
  screen.esc();
  assert.deepEqual(await pending, { answer: "" });
  assert.match(screen.text(), /\(no answer\)/);
  ui.turnFinish();
});

test("a plan is printed as markdown and the three decisions are returned", async () => {
  const { screen, ui, calls, begin } = setup({ readPrompt: async () => ({ type: "submit", text: "add tests first" }) });
  begin();
  let pending = ui.showPlan({ plan: "# Goal\n\n- change `a.js`\n- run the tests" });
  assert.match(screen.text(), /Plan/);
  assert.match(screen.text(), /change .?a\.js.?/);
  assert.match(screen.liveText(), /Start with this plan\?/);
  screen.enter();
  assert.deepEqual(await pending, { decision: "approve" });
  pending = ui.showPlan({ plan: "x" });
  screen.press("down");
  screen.enter();
  assert.deepEqual(await pending, { decision: "approve-edits" });
  pending = ui.showPlan({ plan: "x" });
  screen.type("3");
  screen.enter();
  assert.deepEqual(await pending, { decision: "reject", feedback: "add tests first" });
  assert.deepEqual(calls.plan, ["approve", "approve-edits"], "the application is told so it can switch the mode");
  ui.turnFinish();
});

test("with no real terminal nothing can be asked: requests are denied at once", async () => {
  const { screen, ui } = setup();
  screen.isTTY = false;
  assert.deepEqual(await ui.askPermission({ id: "p", tool: "Bash", title: "x", risk: "low" }), { decision: "deny" });
  assert.deepEqual(await ui.askQuestion({ question: "?" }), { answer: "" });
  assert.deepEqual(await ui.showPlan({ plan: "x" }), { decision: "reject" });
  assert.equal(await ui.pick({ title: "t", items: [{ label: "a" }] }), -1);
});

test("a stray Enter typed ahead does not approve a permission request when a grace period applies", async () => {
  const screen = createFakeScreen();
  const ui = createInteractiveUi({ screen, graceMs: 120 });
  ui.turnBegin({ abort() {}, exit() {} });
  const pending = ui.askPermission({ id: "p", tool: "Bash", title: "Run x", risk: "medium" });
  screen.enter();
  screen.enter();
  await sleep(10);
  assert.match(screen.liveText(), /Permission needed/, "still waiting for a real answer");
  screen.esc();
  assert.deepEqual(await pending, { decision: "deny" });
  ui.turnFinish();
});

test("tool and model text cannot smuggle escape sequences into the scrollback", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "t", name: "Bash", summary: "x\x1b[2J" });
  ui.toolEnd({ id: "t", name: "Bash", ok: true, summary: "ok\x1b]0;pwned\x07", body: "line\x1b[31m red\x1b[0m" });
  ui.notice("warn", "careful \x1b[2J now");
  const raw = screen.printed.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(!raw.includes("\x1b"), JSON.stringify(raw));
  assert.ok(!raw.includes("\x07"));
  ui.turnFinish();
});

test("the live region never grows past the screen", async () => {
  const { screen, ui, begin } = setup({ height: 12 });
  begin();
  for (let i = 0; i < 20; i++) ui.toolStart({ id: `t${i}`, name: "Read", summary: `f${i}.js`, readOnly: true });
  await sleep(100);
  assert.ok(screen.live.length <= 11, `${screen.live.length} rows`);
  assert.match(stripAnsi(screen.live.at(-1)), /esc to interrupt/i, "the spinner stays at the bottom");
  ui.turnFinish();
});

test("a new terminal size recomposes the live region and an open dialog at once", async () => {
  const { screen, ui, begin } = setup({ width: 100 });
  begin();
  ui.toolStart({ id: "t", name: "Bash", summary: "x".repeat(120) });
  const wide = Math.max(...screen.live.map(stringWidth));
  assert.ok(wide > 60);
  screen.resize(50);
  assert.ok(Math.max(...screen.live.map(stringWidth)) <= 50, "the card is cut to the new width");
  const pending = ui.askPermission({ id: "p", tool: "Bash", title: "Run something", summary: "x", risk: "medium" });
  const boxWide = Math.max(...screen.live.map(stringWidth));
  screen.resize(70);
  const boxNarrow = Math.max(...screen.live.map(stringWidth));
  assert.ok(boxNarrow >= boxWide, "the box follows the terminal");
  screen.esc();
  await pending;
  ui.turnFinish();
});

test("what is typed during a turn is kept, shown, and handed over once", async () => {
  const { screen, ui, begin } = setup();
  begin();
  screen.type("next ");
  screen.type("step");
  screen.paste("pasted\n");
  screen.press("backspace");
  await waitFor(() => /next steppaste/.test(screen.liveText()), { label: "the typed-ahead text" });
  ui.turnFinish();
  assert.equal(ui.takeTypeAhead(), "next steppaste");
  assert.equal(ui.takeTypeAhead(), "", "handed over only once");
});

test("Enter during a turn sends the typed text as steering", async () => {
  const { screen, ui, begin } = setup();
  begin();
  screen.type("focus on the tests");
  screen.press("return");
  assert.deepEqual(ui.takeSteering(), ["focus on the tests"]);
  assert.equal(ui.takeTypeAhead(), "", "steering is not left for the next prompt");
  ui.turnFinish();
});

test("dispose releases everything", () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.dispose();
  assert.equal(screen.subscribers, 0);
  assert.deepEqual(screen.live, []);
});

test("a committed line never meets the old unfinished tail it came from (no repeated words while streaming)", async () => {
  const { screen, ui, begin } = setup();
  const seen = [];
  const print = screen.print;
  screen.print = lines => { seen.push({ lines: [...lines], live: screen.live.map(stripAnsi) }); print(lines); };
  begin();
  ui.textStart();
  ui.textDelta("one two three four five");
  await sleep(120);
  assert.ok(screen.liveText().includes("one two three four five"), "the unfinished tail is shown in the live region");
  ui.textDelta(" six\nseven eight");
  assert.equal(seen.length, 1);
  assert.ok(stripAnsi(seen[0].lines.join("\n")).includes("one two three four five six"));
  assert.ok(!seen[0].live.join("\n").includes("one two three"), "the live region was already updated when the line was printed: " + JSON.stringify(seen[0].live));
  ui.textEnd();
  ui.turnFinish();
  assert.ok(text(screen).includes("seven eight"));
});

test("a tool card is separated from the message above it by one blank line", () => {
  const { screen, ui, begin } = setup();
  ui.echoUser("read the file");
  begin();
  ui.toolStart({ id: "r1", name: "Read", summary: "a.js", input: { path: "a.js" }, readOnly: true });
  ui.toolEnd({ id: "r1", name: "Read", ok: true, summary: "3 lines", ms: 4 });
  ui.toolStart({ id: "r2", name: "Read", summary: "b.js", input: { path: "b.js" }, readOnly: true });
  ui.toolEnd({ id: "r2", name: "Read", ok: true, summary: "5 lines", ms: 4 });
  ui.turnFinish();
  const lines = screen.printed.map(stripAnsi);
  const first = lines.findIndex(line => line.includes("Read(a.js)"));
  assert.equal(lines[first - 1], "", "blank between the echoed message and the first card");
  assert.ok(lines[first - 2].includes("read the file"));
  const second = lines.findIndex(line => line.includes("Read(b.js)"));
  assert.equal(second, first + 2, "consecutive cards stay together");
});

test("a question is written down once: the tool's own card does not repeat it", async () => {
  const { screen, ui, begin } = setup();
  begin();
  ui.toolStart({ id: "q1", name: "AskUserQuestion", summary: "Which format?", input: {}, readOnly: true });
  const pending = ui.askQuestion({ question: "Which format?", options: [{ label: "Iraqi dinar" }, { label: "USD" }] });
  screen.enter();
  assert.deepEqual(await pending, { answer: "Iraqi dinar" });
  ui.toolEnd({ id: "q1", name: "AskUserQuestion", ok: true, summary: "Answer: Iraqi dinar", ms: 3 });
  ui.toolStart({ id: "w1", name: "Write", summary: "a.js", input: { path: "a.js" } });
  ui.toolEnd({ id: "w1", name: "Write", ok: true, summary: "Created a.js", ms: 3 });
  ui.turnFinish();
  const shown = text(screen);
  assert.equal(shown.split("Which format?").length - 1, 1, shown);
  assert.equal(shown.split("Iraqi dinar").length - 1, 1, shown);
  assert.ok(!shown.includes("AskUserQuestion"));
  assert.match(shown, /Write\(a\.js\)/, "other tools keep their cards");
});

test("Arabic interface on a wide terminal: the text column sits against the right edge, English stays on the left", async () => {
  setLang("ar");
  try {
    const { screen, ui, begin } = setup({ width: 140 });
    ui.notice("info", "مرحبا بك في فراس كود");
    begin();
    ui.textStart();
    ui.textDelta("هذا جواب قصير.\nوهذا سطر ثان");
    await sleep(120);
    const live = screen.live.map(stripAnsi).filter(line => line.trim());
    ui.textEnd();
    ui.turnFinish();
    const printed = screen.printed.map(stripAnsi).filter(line => line.trim());
    ui.printText(["  ready", ""]);
    assert.ok(screen.printed.at(-2).startsWith(" ".repeat(36 + 2)), "printText shifts finished lines into the column too");
    assert.ok(printed.length >= 3);
    for (const line of printed) assert.equal(stringWidth(line), 138, "ends two columns before the edge: " + JSON.stringify(line));
    assert.ok(live.length >= 2 && live.every(line => stringWidth(line) >= 100), "the live region is shifted too: " + JSON.stringify(live));
  } finally { setLang("en"); }
  const en = setup({ width: 140 });
  en.ui.notice("info", "hello there");
  assert.ok(stringWidth(stripAnsi(en.screen.printed[0])) < 30, "no margin in English");
  setLang("ar");
  try {
    const narrow = setup({ width: 80 });
    narrow.ui.notice("info", "مرحبا");
    assert.ok(narrow.screen.printed[0].startsWith(" ".repeat(60)) && !narrow.screen.printed[0].startsWith(" ".repeat(78)), "no extra margin at 80 columns");
  } finally { setLang("en"); }
});
