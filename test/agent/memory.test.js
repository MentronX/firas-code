import test from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "../tools/helpers.js";
import { remember, forget, readMemory, memoryLines } from "../../src/agent/memory.js";

test("project memory saves, dedupes, forgets and reads back", () => {
  const home = tmpProject({});
  const p = tmpProject({});
  const savedHome = process.env.FIRAS_HOME;
  process.env.FIRAS_HOME = home.dir;
  try {
    assert.equal(readMemory(p.dir), "");
    assert.equal(remember(p.dir, "Use npm test for tests.").ok, true);
    assert.equal(remember(p.dir, "Use npm test for tests.").duplicate, true);
    assert.equal(remember(p.dir, "Never touch src/generated.").ok, true);
    assert.match(readMemory(p.dir), /npm test/);
    assert.equal(memoryLines(p.dir).length, 2);
    assert.equal(forget(p.dir, "npm test").removed, 1);
    assert.equal(memoryLines(p.dir).length, 1);
    assert.doesNotMatch(readMemory(p.dir), /npm test/);
  } finally {
    if (savedHome === undefined) delete process.env.FIRAS_HOME; else process.env.FIRAS_HOME = savedHome;
    p.cleanup();
    home.cleanup();
  }
});
