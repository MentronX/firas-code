import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession, loadSession, listSessions, latestSession, titleFrom } from "../../src/agent/session.js";
import { repairMessages } from "../../src/agent/messages.js";
import { assertValidHistory } from "./fakes.js";

const withoutThinking = messages => messages.map(m => ({ ...m, content: m.content.filter(b => b.type !== "thinking") }));

let home;
let prev;

beforeEach(() => {
  prev = process.env.FIRAS_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fc2-sessions-"));
  process.env.FIRAS_HOME = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env.FIRAS_HOME; else process.env.FIRAS_HOME = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

const dir = () => path.join(home, "sessions");

function filled(cwd, text = "hello there") {
  const s = createSession({ cwd });
  s.addUser(text);
  s.addAssistant({ content: [{ type: "text", text: "hi!" }] });
  return s;
}

test("a session survives a save and a load", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fc2-proj-"));
  const s = createSession({ cwd, mode: "acceptEdits" });
  s.addUser("fix the bug in src/app.js");
  s.addAssistant({ content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: { path: "src/app.js" } }] });
  s.addToolResults([{ tool_use_id: "t1", content: "1\tconsole.log(1)", is_error: false }]);
  s.addAssistant({ content: [{ type: "text", text: "Fixed." }] });
  s.addUsage({ inputTokens: 1200, outputTokens: 80 });
  s.usage.turns = 1;
  assert.equal(s.save(), true);

  const back = loadSession(s.id);
  assert.equal(back.id, s.id);
  assert.equal(back.cwd, path.resolve(cwd));
  assert.equal(back.mode, "acceptEdits");
  assert.equal(back.title, "fix the bug in src/app.js");
  assert.deepEqual(back.messages, withoutThinking(s.messages), "the saved copy is the history minus the model's thinking");
  assert.ok(s.messages[1].content.some(b => b.type === "thinking"), "the copy in memory keeps it for the rest of the turn");
  assert.deepEqual(back.usage, { inputTokens: 1200, outputTokens: 80, turns: 1 });
  assert.ok(Date.parse(back.createdAt) <= Date.parse(back.updatedAt));
  assertValidHistory(back.messages);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("files are written privately, atomically, under the sessions folder", () => {
  const s = filled(process.cwd());
  s.save();
  s.save();
  const names = fs.readdirSync(dir());
  assert.deepEqual(names, [`${s.id}.json`], "no temporary files are left behind");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir(), names[0])).mode & 0o777, 0o600);
  assert.equal(s.file, path.join(dir(), `${s.id}.json`));
});

test("the title comes from the first user message and is at most 60 characters", () => {
  const s = createSession({ cwd: process.cwd() });
  s.addUser("   write\n a   very long request about refactoring the whole authentication layer of the application   ");
  assert.ok(s.title.length <= 60);
  assert.ok(s.title.endsWith("…"));
  assert.ok(s.title.startsWith("write a very long request"));
  s.addAssistant({ content: [{ type: "text", text: "ok" }] });
  s.addUser("a different second message");
  assert.ok(s.title.startsWith("write a very"), "the title never changes after the first message");
  assert.equal(titleFrom("short"), "short");
  assert.equal(titleFrom("x".repeat(60)).length, 60);
  assert.equal(titleFrom("اصلح الخطأ في ملف الإعدادات"), "اصلح الخطأ في ملف الإعدادات");
});

test("listSessions is newest first, can filter by folder, and skips empty sessions", () => {
  const a = filled("/proj/a", "first");
  a.updatedAt = "2026-01-01T00:00:00.000Z";
  a.save();
  const b = filled("/proj/b", "second");
  const c = filled("/proj/a", "third");
  c.save();
  b.save();
  createSession({ cwd: "/proj/a" }).save();

  // save() stamps the time; order them explicitly.
  for (const [s, when] of [[a, "2026-01-01T00:00:00.000Z"], [b, "2026-02-01T00:00:00.000Z"], [c, "2026-03-01T00:00:00.000Z"]]) {
    const data = JSON.parse(fs.readFileSync(s.file, "utf8"));
    data.updatedAt = when;
    fs.writeFileSync(s.file, JSON.stringify(data));
  }
  const all = listSessions();
  assert.deepEqual(all.map(x => x.title), ["third", "second", "first"]);
  assert.equal(all[0].messageCount, 2);
  assert.deepEqual(listSessions({ cwd: "/proj/a" }).map(x => x.title), ["third", "first"]);
  assert.equal(listSessions({ limit: 1 }).length, 1);
  assert.deepEqual(listSessions({ cwd: "/nowhere" }), []);
});

test("latestSession returns the newest session of that folder only", () => {
  const cwdA = path.join(os.tmpdir(), "fc2-a");
  const cwdB = path.join(os.tmpdir(), "fc2-b");
  const old = filled(cwdA, "old one");
  old.save();
  const other = filled(cwdB, "other folder");
  other.save();
  const fresh = filled(cwdA, "fresh one");
  fresh.save();
  const data = JSON.parse(fs.readFileSync(old.file, "utf8"));
  data.updatedAt = "2020-01-01T00:00:00.000Z";
  fs.writeFileSync(old.file, JSON.stringify(data));

  assert.equal(latestSession(cwdA).id, fresh.id);
  assert.equal(latestSession(cwdB).id, other.id);
  assert.equal(latestSession(path.join(os.tmpdir(), "fc2-none")), null);
  if (process.platform === "win32") assert.equal(latestSession(cwdA.toUpperCase()).id, fresh.id, "paths compare case-insensitively on Windows");
  assert.equal(latestSession(cwdA + path.sep).id, fresh.id, "a trailing separator does not matter");
});

test("corrupt, foreign and misnamed files are skipped everywhere", () => {
  const good = filled(process.cwd(), "the good one");
  good.save();
  fs.writeFileSync(path.join(dir(), "garbage.json"), "{not json at all");
  fs.writeFileSync(path.join(dir(), "empty.json"), "");
  fs.writeFileSync(path.join(dir(), "array.json"), "[1,2,3]");
  fs.writeFileSync(path.join(dir(), "noid.json"), JSON.stringify({ messages: [] }));
  fs.writeFileSync(path.join(dir(), "readme.txt"), "not a session");
  fs.writeFileSync(path.join(dir(), "wrongname.json"), fs.readFileSync(good.file, "utf8"));
  fs.writeFileSync(path.join(dir(), "binary.json"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

  assert.deepEqual(listSessions().map(s => s.id), [good.id]);
  assert.equal(loadSession("garbage"), null);
  assert.equal(loadSession("empty"), null);
  assert.equal(loadSession("array"), null);
  assert.equal(loadSession("missing-id"), null);
  assert.equal(loadSession(good.id).title, "the good one");
  assert.equal(latestSession(process.cwd()).id, good.id);
});

test("ids that could escape the folder are refused", () => {
  filled(process.cwd()).save();
  fs.writeFileSync(path.join(home, "secret.json"), JSON.stringify({ id: "secret", messages: [{ role: "user", content: "x" }] }));
  assert.equal(loadSession("../secret"), null);
  assert.equal(loadSession("..\\secret"), null);
  assert.equal(loadSession(""), null);
  assert.equal(loadSession(undefined), null);
  assert.equal(loadSession("a/b"), null);
});

test("a header-only read works for big sessions and the full parse covers foreign layouts", () => {
  const s = filled(process.cwd(), "big one");
  s.addUser("filler");
  s.messages[s.messages.length - 1].content[0].text = "y".repeat(200000);
  s.save();
  assert.equal(listSessions()[0].title, "big one");

  // A file whose keys come in another order (written by hand or another version) is still listed.
  const foreign = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], id: "foreign-1", cwd: process.cwd(), title: "foreign", createdAt: "2026-01-01T00:00:00.000Z" };
  fs.writeFileSync(path.join(dir(), "foreign-1.json"), JSON.stringify(foreign));
  assert.ok(listSessions().some(x => x.id === "foreign-1" && x.title === "foreign"));
  assert.equal(loadSession("foreign-1").messages.length, 1);
});

test("loading repairs a history that a crash left with an unanswered tool call", () => {
  const s = createSession({ cwd: process.cwd() });
  s.addUser("do it");
  s.messages.push({ role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "lost", name: "Bash", input: { command: "ls" } }] });
  s.save();
  const back = loadSession(s.id);
  assertValidHistory(back.messages);
  assert.equal(back.messages.length, 3);
  assert.equal(back.messages[2].content[0].tool_use_id, "lost");
  assert.equal(back.messages[2].content[0].is_error, true);
});

test("addUser folds into a dangling user message instead of creating two in a row", () => {
  const s = createSession({ cwd: process.cwd() });
  s.addUser("first");
  s.addUser("second");
  assert.equal(s.messages.length, 1);
  assert.deepEqual(s.messages[0].content.map(b => b.text), ["first", "second"]);
});

test("addAssistant stores only what the service accepts", () => {
  const s = createSession({ cwd: process.cwd() });
  s.addUser("go");
  const stored = s.addAssistant({
    content: [
      { type: "thinking", thinking: "   " },
      { type: "text", text: "" },
      { type: "text", text: "real" },
      { type: "tool_use", id: "x", name: "Read", input: { path: "a" }, inputError: "bad", extra: 1 },
      { type: "mystery", foo: 1 },
    ],
  });
  assert.deepEqual(stored.content, [{ type: "text", text: "real" }, { type: "tool_use", id: "x", name: "Read", input: { path: "a" } }]);
  assert.equal(s.addAssistant({ content: [{ type: "text", text: "  " }] }), null);
  assert.equal(s.messages.length, 2);
});

test("repairMessages leaves a valid history alone and fixes the common breakages", () => {
  const valid = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "r" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const same = repairMessages(valid);
  assert.equal(same.changed, false);
  assert.equal(same.messages, valid);

  const broken = repairMessages([
    { role: "assistant", content: [{ type: "text", text: "starts with assistant" }] },
    { role: "user", content: "string content" },
    { role: "user", content: [{ type: "text", text: "two users" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Read", input: {} }, { type: "tool_use", id: "b", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ra" }, { type: "tool_result", tool_use_id: "ghost", content: "orphan" }] },
    { role: "assistant", content: [{ type: "text", text: "end" }] },
  ]);
  assert.equal(broken.changed, true);
  assertValidHistory(broken.messages);
  const results = broken.messages[2].content.map(b => b.tool_use_id);
  assert.deepEqual(results.sort(), ["a", "b"]);
});

// ------------------------------------------------------------------------------------------ thinking is not kept

function thinkingSession(cwd = process.cwd()) {
  const s = createSession({ cwd });
  s.addUser("read the file and fix it");
  s.addAssistant({ content: [{ type: "thinking", thinking: "SECRET-REASONING-ONE: the file probably has a bug" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: { path: "a.js" } }] });
  s.addToolResults([{ tool_use_id: "t1", content: "1\tlet a = 1" }]);
  s.addAssistant({ content: [{ type: "thinking", thinking: "SECRET-REASONING-TWO: now edit it", signature: "sig" }, { type: "tool_use", id: "t2", name: "Edit", input: { path: "a.js" } }] });
  s.addToolResults([{ tool_use_id: "t2", content: "done" }]);
  s.addAssistant({ content: [{ type: "thinking", thinking: "SECRET-REASONING-THREE" }, { type: "text", text: "Fixed." }] });
  return s;
}

test("thinking blocks never reach the disk, but stay in memory for the running turn", () => {
  const s = thinkingSession();
  assert.equal(s.save(), true);
  const raw = fs.readFileSync(s.file, "utf8");
  assert.ok(!raw.includes("SECRET-REASONING"), "the reasoning text is not in the file");
  assert.ok(!raw.includes('"thinking"'), "no thinking block of any kind is in the file");
  assert.ok(raw.includes("Looking.") && raw.includes("Fixed.") && raw.includes('"tool_use"') && raw.includes('"tool_result"'), "everything else is kept");
  assert.equal(s.messages.filter(m => m.content.some(b => b.type === "thinking")).length, 3, "memory is untouched");
  assert.equal(s.messages.length, 6);
});

test("resuming a saved session gives a valid history: alternating roles and every tool call answered", () => {
  const s = thinkingSession();
  s.save();
  const back = loadSession(s.id);
  assertValidHistory(back.messages);
  assert.equal(back.messages.length, 6);
  assert.deepEqual(back.messages.map(m => m.content.map(b => b.type)), [["text"], ["text", "tool_use"], ["tool_result"], ["tool_use"], ["tool_result"], ["text"]]);
  assert.equal(listSessions()[0].messageCount, 6, "the header count is the saved count");
});

test("a message that held nothing but thinking disappears, and its neighbours fold so roles still alternate", () => {
  const s = createSession({ cwd: process.cwd() });
  s.addUser("first question");
  s.addAssistant({ content: [{ type: "text", text: "first answer" }] });
  s.addUser("second question");
  s.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "only thoughts, then the turn was interrupted" }] });
  s.messages.push({ role: "user", content: [{ type: "text", text: "third question" }] });
  s.save();
  const back = loadSession(s.id);
  assertValidHistory(back.messages);
  assert.deepEqual(back.messages.map(m => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(back.messages[2].content.map(b => b.text), ["second question", "third question"]);
  assert.equal(JSON.parse(fs.readFileSync(s.file, "utf8")).messageCount, 3);
});

test("a file written by an older version, with thinking in it, is cleaned when it is loaded", () => {
  const old = {
    version: 1, id: "older-1", cwd: process.cwd(), createdAt: "2026-01-01T00:00:00.000Z", title: "old", messageCount: 3,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-REASONING-OLD" }, { type: "tool_use", id: "x", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "r" }] },
    ],
  };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), "older-1.json"), JSON.stringify(old));
  const back = loadSession("older-1");
  assert.ok(!JSON.stringify(back.messages).includes("SECRET-REASONING-OLD"));
  assertValidHistory([...back.messages, { role: "assistant", content: [{ type: "text", text: "ok" }] }]);
  back.save();
  assert.ok(!fs.readFileSync(back.file, "utf8").includes("SECRET-REASONING-OLD"), "saving it again rewrites the file without the reasoning");
});

test("a session without any thinking is saved exactly as before", () => {
  const s = filled(process.cwd(), "plain one");
  s.save();
  const data = JSON.parse(fs.readFileSync(s.file, "utf8"));
  assert.deepEqual(data.messages, s.messages);
  assert.equal(data.messageCount, 2);
});
