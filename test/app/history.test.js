import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadHistory, appendHistory, historyFile, looksSecret, HISTORY_LIMIT } from "../../src/ui/history.js";
import { useTempHome } from "./helpers.js";

const home = useTempHome("firas-history-");
before(() => home.reset());
beforeEach(() => home.reset());
after(() => home.restore());

test("entries come back oldest first, multi-line and Arabic intact", () => {
  assert.equal(appendHistory("first"), true);
  assert.equal(appendHistory("سطر أول\nسطر ثانٍ"), true);
  assert.equal(appendHistory("third"), true);
  assert.deepEqual(loadHistory(), ["first", "سطر أول\nسطر ثانٍ", "third"]);
});

test("consecutive duplicates are stored once, later repeats are kept", () => {
  appendHistory("a");
  assert.equal(appendHistory("a"), false);
  appendHistory("b");
  appendHistory("a");
  assert.deepEqual(loadHistory(), ["a", "b", "a"]);
});

test("empty text and text that looks like an access code are never stored", () => {
  assert.equal(appendHistory("   "), false);
  assert.equal(appendHistory("FC2-ABCDE-FGHIJ-KLMNO"), false);
  assert.equal(appendHistory("here is my code fc2-abcde-fghij-klmno ok"), false);
  assert.equal(looksSecret("FC2 is a name"), false);
  assert.deepEqual(loadHistory(), []);
});

test("the file keeps at most 500 entries and stays valid when trimmed", () => {
  const seed = Array.from({ length: HISTORY_LIMIT + 99 }, (_, i) => JSON.stringify({ text: `message ${i}` })).join("\n") + "\n";
  fs.writeFileSync(historyFile(), seed);
  assert.equal(loadHistory().length, HISTORY_LIMIT, "reading never returns more than the limit");
  for (let i = 0; i < 5; i++) appendHistory(`new ${i}`);
  const entries = loadHistory();
  assert.equal(entries.length, HISTORY_LIMIT);
  assert.equal(entries.at(-1), "new 4");
  const lines = fs.readFileSync(historyFile(), "utf8").trim().split("\n");
  assert.ok(lines.length <= HISTORY_LIMIT + 100, "the file itself is trimmed too");
  for (const line of lines) JSON.parse(line);
});

test("a torn or foreign line is skipped, not fatal", () => {
  fs.writeFileSync(historyFile(), `{"text":"ok one"}\n{"text":"tor\n"plain string"\n12\n{"text":"ok two"}\n`);
  assert.deepEqual(loadHistory(), ["ok one", "plain string", "ok two"]);
});

test("a missing file is an empty history", () => {
  assert.deepEqual(loadHistory(), []);
});

test("the history file is private on systems that have file modes", { skip: process.platform === "win32" }, () => {
  appendHistory("x");
  assert.equal(fs.statSync(historyFile()).mode & 0o777, 0o600);
});

test("a home that cannot be written does not throw", () => {
  const blocker = path.join(home.dir, "a-file");
  fs.writeFileSync(blocker, "x");
  assert.equal(appendHistory("x", { file: path.join(blocker, "sub", "history.jsonl") }), false);
});
