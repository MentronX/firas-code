import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";

test("Remember saves, lists and forgets project facts", async () => {
  const s = setup({});
  try {
    const saved = await s.call("Remember", { action: "remember", text: "Use npm test for the test suite." });
    assert.equal(saved.ok, true);
    const duplicate = await s.call("Remember", { action: "remember", text: "Use npm test for the test suite." });
    assert.match(duplicate.content, /already saved/);
    const listed = await s.call("Remember", { action: "list" });
    assert.match(listed.content, /npm test/);
    const forgot = await s.call("Remember", { action: "forget", text: "npm test" });
    assert.equal(forgot.ok, true);
    const empty = await s.call("Remember", { action: "list" });
    assert.match(empty.content, /No project memory/);
  } finally { s.cleanup(); }
});

test("Remember validates its input", async () => {
  const s = setup({});
  try {
    assert.match((await s.call("Remember", { action: "remember" })).content, /VALIDATION/);
    assert.match((await s.call("Remember", { action: "nope" })).content, /VALIDATION/);
  } finally { s.cleanup(); }
});
