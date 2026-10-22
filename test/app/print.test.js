// Print mode end to end: main(["-p", ...]) against the mock service, with injected streams and the real toolbox.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setLang } from "../../src/i18n/index.js";
import { setArabicMode } from "../../src/text/display.js";
import { main } from "../../src/cli.js";
import { saveConfig } from "../../src/config.js";
import { listSessions, loadSession } from "../../src/agent/session.js";
import { startMockService, textReply, toolReply, errorReply } from "../helpers/mock-service.js";
import { createCapture, createEmptyStdin, tempDir, useTempHome, sleep } from "./helpers.js";

const home = useTempHome("firas-print-");
before(() => { home.reset(); setLang("en"); });
beforeEach(() => { home.reset(); setLang("en"); setArabicMode("auto"); });
after(() => { setLang("en"); setArabicMode("auto"); home.restore(); });

async function session({ script = [], files = {}, fn }) {
  const service = await startMockService(script);
  const work = tempDir();
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work.dir, name)), { recursive: true });
    fs.writeFileSync(path.join(work.dir, name), content);
  }
  saveConfig({ code: service.code });
  const run = async (args, extra = {}) => {
    const out = {
      stdin: createEmptyStdin(),
      stdout: createCapture(),
      stderr: createCapture(),
      env: { FIRAS_LANG: "en", FIRAS_ORIGIN: service.origin, FIRAS_VERIFY: "0" },
      cwd: work.dir,
      process: new EventEmitter(),
      clientOptions: { backoffMs: [1, 1, 1, 1] },
      ...extra,
    };
    out.code = await main(args, out);
    return out;
  };
  try { await fn({ service, work, run }); } finally { await service.close(); work.remove(); }
}

const posts = service => service.requests.filter(r => r.method === "POST" && r.path.endsWith("/v1/messages"));

test("a plain answer goes to stdout, nothing else goes anywhere, and the conversation is saved", () => session({
  script: [textReply("Hello from the service.")],
  fn: async ({ service, work, run }) => {
    const out = await run(["-p", "say hello"]);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.text, "Hello from the service.\n");
    assert.equal(out.stderr.text, "");
    const [request] = posts(service);
    assert.equal(request.headers["x-firas-client"], "cli");
    assert.equal(request.headers.authorization, `Bearer ${service.code}`);
    assert.match(request.headers["user-agent"], /^firas-code\//);
    assert.equal(request.body.model, "firas-code-2");
    assert.equal(request.body.stream, true);
    assert.deepEqual(request.body.thinking, { type: "adaptive" });
    assert.deepEqual(request.body.output_config, { effort: "medium" });
    assert.equal(request.body.messages[0].content[0].text, "say hello");
    assert.ok(request.body.tools.some(tool => tool.name === "Read"));
    assert.ok(request.body.tools.some(tool => tool.name === "Agent"), "the sub-agent tool is registered");
    const saved = listSessions({ cwd: work.dir });
    assert.equal(saved.length, 1);
    assert.equal(loadSession(saved[0].id).messages.at(-1).content[0].text, "Hello from the service.");
  },
}));

test("--effort changes the next request: an older 'off' means low, max asks for the long limit, ultracode adds its way of working", () => session({
  script: [textReply("a"), textReply("b"), textReply("c"), textReply("d")],
  fn: async ({ service, run }) => {
    await run(["-p", "x", "--effort", "off"]);
    await run(["-p", "x", "--effort", "max"]);
    await run(["-p", "x", "--effort", "low"]);
    await run(["-p", "x", "--effort", "ultra"]);
    const [off, max, low, ultra] = posts(service).map(r => r.body);
    assert.deepEqual(off.output_config, { effort: "low" });
    assert.equal(off.max_tokens, 16000);
    assert.equal(max.max_tokens, 32000);
    assert.deepEqual(max.output_config, { effort: "max" });
    assert.ok(!max.system.map(s => s.text).join("\n").includes("# Ultracode"));
    assert.deepEqual(low.output_config, { effort: "low" });
    assert.deepEqual(ultra.output_config, { effort: "max" });
    assert.equal(ultra.max_tokens, 32000);
    assert.match(ultra.system.map(s => s.text).join("\n"), /# Ultracode/);
  },
}));

test("Arabic answers arrive byte for byte, with no escape sequences", () => session({
  script: [textReply("مرحبا! ملف `src/app.js` يحتوي 3 دوال.\n```js\nconst x = 1;\n```", { chunk: 5 })],
  fn: async ({ run }) => {
    const out = await run(["-p", "ما هذا الملف؟"]);
    assert.equal(out.stdout.text, "مرحبا! ملف `src/app.js` يحتوي 3 دوال.\n```js\nconst x = 1;\n```\n");
    assert.ok(!out.stdout.text.includes("\x1b"));
  },
}));

test("a Read runs without asking; the cards go to stderr, the answer to stdout", () => session({
  files: { "notes.txt": "first line\nsecond line\n" },
  script: [
    toolReply([{ name: "Read", input: { path: "notes.txt" }, id: "call_read_1" }], { text: "Let me look." }),
    textReply("It has two lines."),
  ],
  fn: async ({ service, run }) => {
    const out = await run(["-p", "how long is notes.txt?"]);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.text, "Let me look.\n\nIt has two lines.\n");
    assert.match(out.stderr.text, /Read\(notes\.txt\)/);
    assert.match(out.stderr.text, /└|`-|Read 2 lines|2 lines/);
    const second = posts(service)[1].body;
    const result = second.messages.at(-1).content[0];
    assert.equal(result.type, "tool_result");
    assert.equal(result.tool_use_id, "call_read_1");
    assert.match(result.content, /first line/);
    assert.match(result.content, /second line/);
  },
}));

test("an edit is refused when nobody can approve it, and the model is told so", () => session({
  files: { "a.js": "const a = 1;\n" },
  script: [
    toolReply([{ name: "Read", input: { path: "a.js" } }]),
    toolReply([{ name: "Edit", input: { path: "a.js", old_string: "const a = 1;", new_string: "const a = 2;" }, id: "call_edit_1" }]),
    textReply("I could not edit it."),
  ],
  fn: async ({ service, work, run }) => {
    const out = await run(["-p", "bump a"]);
    assert.equal(out.code, 0);
    assert.equal(fs.readFileSync(path.join(work.dir, "a.js"), "utf8"), "const a = 1;\n", "the file is untouched");
    assert.match(out.stderr.text, /Not allowed without a person to approve it/);
    const result = posts(service)[2].body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /declined|Permission denied/i);
  },
}));

test("--mode acceptEdits lets project edits through; commands still need a person", () => session({
  files: { "a.js": "const a = 1;\n", "hello.js": "console.log('ran');\n" },
  script: [
    toolReply([{ name: "Read", input: { path: "a.js" } }]),
    toolReply([
      { name: "Edit", input: { path: "a.js", old_string: "const a = 1;", new_string: "const a = 2;" } },
      { name: "Bash", input: { command: "node hello.js" }, id: "call_bash_1" },
    ]),
    textReply("Edited; the command was refused."),
  ],
  fn: async ({ service, work, run }) => {
    const out = await run(["-p", "bump a and run hello", "--mode", "acceptEdits"]);
    assert.equal(out.code, 0);
    assert.equal(fs.readFileSync(path.join(work.dir, "a.js"), "utf8"), "const a = 2;\n");
    const results = posts(service)[2].body.messages.at(-1).content;
    assert.equal(results[0].is_error, undefined, "the edit succeeded");
    assert.equal(results[1].is_error, true, "the command was refused");
    assert.match(out.stderr.text, /Not allowed/);
  },
}));

test("--yolo runs commands without asking", () => session({
  files: { "hello.js": "process.stdout.write('ran-hello-script');\n" },
  script: [
    toolReply([{ name: "Bash", input: { command: "node hello.js" }, id: "call_bash_1" }]),
    textReply("Done."),
  ],
  fn: async ({ service, run }) => {
    const out = await run(["-p", "run it", "--yolo"]);
    assert.equal(out.code, 0);
    const result = posts(service)[1].body.messages.at(-1).content[0];
    assert.match(result.content, /ran-hello-script/);
    assert.ok(!result.is_error);
  },
}));

test("a refusal from the service is shown in friendly words and exits 1", () => session({
  script: [errorReply(401, "access_invalid", "raw upstream complaint")],
  fn: async ({ run }) => {
    const out = await run(["-p", "hi"]);
    assert.equal(out.code, 1);
    assert.equal(out.stdout.text, "");
    assert.match(out.stderr.text, /access code isn't valid/);
    assert.ok(!/raw upstream complaint/.test(out.stderr.text));
  },
}));

test("a busy service is retried quietly and the notice goes to stderr", () => session({
  script: [errorReply(529, "busy"), textReply("worth the wait")],
  fn: async ({ service, run }) => {
    const out = await run(["-p", "hi"]);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.text, "worth the wait\n");
    assert.match(out.stderr.text, /busy; trying again in 1 s/);
    assert.equal(posts(service).length, 2);
  },
}));

test("SIGINT stops the turn, leaves a valid saved conversation, and exits 130", () => session({
  script: [{ ...textReply("a very long answer ".repeat(30), { chunk: 4 }), eventDelayMs: 20 }],
  fn: async ({ service, work, run }) => {
    const signals = new EventEmitter();
    const pending = run(["-p", "talk a lot"], { process: signals });
    await sleep(150);
    signals.emit("SIGINT");
    const out = await pending;
    assert.equal(out.code, 130);
    assert.match(out.stderr.text, /interrupted/);
    const [meta] = listSessions({ cwd: work.dir });
    const saved = loadSession(meta.id);
    assert.equal(saved.messages[0].role, "user");
    assert.ok(saved.messages.every(m => m.content.length > 0));
    await sleep(100);
    assert.equal(service.inFlight(), 0, "the connection was released");
  },
}));

test("with no message on the command line, a piped stdin is the message", () => session({
  script: [textReply("got it")],
  fn: async ({ service, run }) => {
    const out = await run(["-p"], { stdin: createEmptyStdin("what is 2+2?\nanswer briefly") });
    assert.equal(out.code, 0);
    assert.equal(posts(service)[0].body.messages[0].content[0].text, "what is 2+2?\nanswer briefly");
  },
}));

test("-c continues the latest conversation of the folder", () => session({
  script: [textReply("first answer"), textReply("second answer")],
  fn: async ({ service, work, run }) => {
    await run(["-p", "first question"]);
    const out = await run(["-p", "second question", "-c"]);
    assert.equal(out.code, 0);
    const second = posts(service)[1].body.messages;
    assert.equal(second[0].content[0].text, "first question");
    assert.equal(second[1].content[0].text, "first answer");
    assert.equal(second.at(-1).content[0].text, "second question");
    assert.equal(listSessions({ cwd: work.dir }).length, 1, "one conversation, not two");
  },
}));

test("-c without an earlier conversation starts a new one and says so", () => session({
  script: [textReply("fresh")],
  fn: async ({ run }) => {
    const out = await run(["-p", "hi", "-c"]);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.text, "fresh\n");
    assert.match(out.stderr.text, /no earlier conversation/);
  },
}));

test("--resume with an id goes back to that conversation", () => session({
  script: [textReply("one"), textReply("two")],
  fn: async ({ service, work, run }) => {
    await run(["-p", "alpha"]);
    const [meta] = listSessions({ cwd: work.dir });
    await run(["-p", "beta", "--resume", meta.id]);
    assert.equal(posts(service)[1].body.messages[0].content[0].text, "alpha");
    const miss = await run(["-p", "gamma", "-r", "20000101-000000-ffffff"]);
    assert.match(miss.stderr.text, /No saved conversation matches/);
  },
}));

test("a plan-mode run ends with the plan as its answer (nobody can approve it)", () => session({
  script: [
    toolReply([{ name: "ExitPlanMode", input: { plan: "1. do it" }, id: "call_plan_1" }]),
    textReply("Plan: 1. do it"),
  ],
  fn: async ({ service, run }) => {
    const out = await run(["-p", "plan it", "--mode", "plan"]);
    assert.equal(out.code, 0);
    assert.equal(out.stdout.text, "Plan: 1. do it\n");
    assert.match(out.stderr.text, /Nobody is here to approve a plan/);
    const result = posts(service)[1].body.messages.at(-1).content[0];
    assert.match(result.content, /write the plan as your final answer/);
  },
}));

test("the code never appears on stdout or stderr, even when things go wrong", () => session({
  script: [errorReply(429, "daily_limit"), errorReply(500, "boom")],
  fn: async ({ service, run }) => {
    const a = await run(["-p", "hi"]);
    const b = await run(["-p", "hi again"]);
    for (const out of [a, b]) {
      assert.ok(!out.stdout.text.includes(service.code));
      assert.ok(!out.stderr.text.includes(service.code));
    }
    assert.match(a.stderr.text, /usage limit/);
  },
}));
