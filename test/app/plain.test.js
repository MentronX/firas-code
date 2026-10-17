import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../../src/i18n/index.js";
import { setColorLevel, colorLevel } from "../../src/ui/theme.js";
import { setArabicMode, stripAnsi } from "../../src/text/display.js";
import { createPlainUi } from "../../src/ui/plain.js";
import { createCapture } from "./helpers.js";

const colorBefore = colorLevel();
before(() => { setLang("en"); setArabicMode("on"); });
after(() => { setColorLevel(colorBefore); setArabicMode("auto"); setLang("en"); });

function make(options = {}) {
  const stdout = createCapture({ isTTY: options.tty });
  stdout.columns = options.columns ?? 60;
  const stderr = createCapture({ isTTY: options.errTty });
  const ui = createPlainUi({ stdout, stderr, mode: options.mode });
  return { ui, stdout, stderr };
}

function say(ui, ...pieces) {
  ui.textStart();
  for (const piece of pieces) ui.textDelta(piece);
  ui.textEnd();
}

test("piped output is the raw markdown, exactly as streamed, with a blank line between blocks", () => {
  setColorLevel(3);
  try {
    const { ui, stdout, stderr } = make();
    say(ui, "# Title\n\nSome **bold** text\n", "and `code`\n\tindented with a tab");
    say(ui, "second block");
    ui.finish();
    assert.equal(stdout.text, "# Title\n\nSome **bold** text\nand `code`\n\tindented with a tab\n\nsecond block\n");
    assert.ok(!stdout.text.includes("\x1b"));
    assert.equal(stderr.text, "");
    assert.equal(ui.answer(), "# Title\n\nSome **bold** text\nand `code`\n\tindented with a tab" + "second block");
  } finally { setColorLevel(0); }
});

test("an escape sequence from the model is removed, even when split across two chunks", () => {
  const { ui, stdout } = make();
  say(ui, "a \x1b[3", "1mred\x1b[0m b \x1b]0;title\x07c");
  ui.finish();
  assert.equal(stdout.text, "a red b c\n");
});

test("on a terminal the answer is rendered for reading when the block ends", () => {
  const { ui, stdout } = make({ tty: true, columns: 40 });
  ui.textStart();
  ui.textDelta("# Heading\n\n- one\n- two\n\nمرحبا بالعالم");
  assert.equal(stdout.text, "", "nothing is written until the block is complete");
  ui.textEnd();
  const text = stripAnsi(stdout.text);
  assert.match(text, /Heading/);
  assert.ok(!text.includes("# Heading"), "the markdown marker is gone");
  assert.match(text, /[ﭐ-﻿]/, "Arabic is shaped");
  assert.equal(ui.answer(), "# Heading\n\n- one\n- two\n\nمرحبا بالعالم", "the raw text is still available");
  assert.ok(text.split("\n").every(line => line.length <= 41));
});

test("tool lines, notices and the final task list go to stderr", () => {
  const { ui, stdout, stderr } = make();
  ui.toolStart({ id: "1", name: "Read", summary: "src/app.js" });
  ui.toolEnd({ id: "1", name: "Read", ok: true, summary: "Read 12 lines" });
  ui.toolStart({ id: "2", name: "Bash", summary: "npm test" });
  ui.toolEnd({ id: "2", name: "Bash", ok: false, summary: "Exit code 1" });
  ui.notice("warn", "careful\nnow");
  ui.notice("error", "it broke");
  ui.todos([{ content: "A", status: "completed" }, { content: "B", status: "pending" }]);
  ui.turnEnd({ ms: 10, stopReason: "end_turn", steps: 1 });
  assert.equal(stdout.text, "");
  const lines = stderr.text.trim().split("\n");
  assert.equal(lines.length, 8);
  assert.match(lines[0], /Read\(src\/app\.js\)/);
  assert.match(lines[1], /Read 12 lines/);
  assert.match(lines[3], /Exit code 1/);
  assert.match(lines[4], /careful now/);
  assert.match(lines[6], /\[x\]|☑/);
  assert.match(lines[7], /B/);
});

test("Arabic lines on stderr are logical text in a file and shaped text on a terminal; no direction marks either way", () => {
  setLang("ar");
  try {
    const file = make();
    file.ui.notice("info", "⁦Esc⁩ للإيقاف");
    assert.ok(!/[⁦-⁩]/.test(file.stderr.text));
    assert.ok(file.stderr.text.includes("للإيقاف"), "logical order, unshaped");
    const tty = make({ errTty: true });
    tty.ui.notice("info", "⁦Esc⁩ للإيقاف");
    assert.ok(!/[⁦-⁩]/.test(tty.stderr.text));
    assert.match(tty.stderr.text, /[ﭐ-﻿]/);
  } finally { setLang("en"); }
});

test("permission requests are denied with a line on stderr; bypass lets everything but the dangerous through", async () => {
  const ask = { id: "p", tool: "Bash", title: "Run: npm test", risk: "medium" };
  const normal = make();
  assert.deepEqual(await normal.ui.askPermission(ask), { decision: "deny" });
  assert.match(normal.stderr.text, /Not allowed without a person to approve it: Run: npm test/);
  assert.match(normal.stderr.text, /--yolo/);
  const edits = make({ mode: "acceptEdits" });
  assert.deepEqual(await edits.ui.askPermission(ask), { decision: "deny" });
  const yolo = make({ mode: "bypass" });
  assert.deepEqual(await yolo.ui.askPermission(ask), { decision: "allow" });
  assert.deepEqual(await yolo.ui.askPermission({ ...ask, risk: "high" }), { decision: "deny" });
  assert.equal(yolo.stderr.text.trim().split("\n").length, 1, "only the dangerous one was reported");
});

test("questions and plans cannot be answered, and the model is told how to carry on", async () => {
  const { ui, stderr } = make();
  assert.deepEqual(await ui.askQuestion({ question: "Which one?" }), { answer: "" });
  assert.match(stderr.text, /Nobody is here to answer: Which one\?/);
  const plan = await ui.showPlan({ plan: "x" });
  assert.equal(plan.decision, "reject");
  assert.match(plan.feedback, /write the plan as your final answer/);
});

test("every event the loop can send exists, so it never meets a missing method", () => {
  const { ui } = make();
  for (const name of ["requestStart", "requestEnd", "thinkingStart", "thinkingDelta", "thinkingEnd", "textStart", "textDelta", "textEnd", "toolStart", "toolProgress", "toolEnd", "askPermission", "askQuestion", "showPlan", "todos", "agentStart", "agentEnd", "notice", "usage", "turnEnd"]) {
    assert.equal(typeof ui[name], "function", name);
  }
});
