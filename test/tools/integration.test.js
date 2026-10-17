import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup, fakeUi } from "./helpers.js";
import { createPermissionEngine } from "../../src/tools/index.js";

// What the agent loop does with a tool call: validate -> permission -> run.
function driver(s, engine) {
  return async (name, input, extra = {}) => {
    const tool = s.toolbox.byName.get(name);
    // Like the real loop: a fresh context without the engine; permissions.check attaches it for tool.run.
    const ctx = s.toolbox.context({ mode: engine.mode, ...extra });
    ctx.permissions = undefined;
    const problem = tool.validate?.(input, ctx);
    if (problem) return { ok: false, content: problem, stage: "validate" };
    const decision = await engine.check(tool, input, ctx);
    if (!decision.allowed) return { ok: false, content: decision.message, stage: "permission", by: decision.by };
    const result = await tool.run(input, ctx);
    return { ...result, stage: "run" };
  };
}

test("a realistic session: explore, edit, run, remember, plan", async () => {
  const ui = fakeUi({ permission: [{ decision: "allow" }, { decision: "allow-session" }], plan: { decision: "approve-edits" } });
  const s = setup({
    "calc.js": "export function add(a, b) {\r\n  return a - b;\r\n}\r\n",
    "run.js": "import { add } from './calc.js';\nconsole.log(add(2, 3));\n",
    "package.json": '{ "type": "module" }\n',
  }, { ui });
  try {
    const engine = createPermissionEngine({ mode: "default", ui });
    const go = driver(s, engine);

    const found = await go("Glob", { pattern: "**/*.js" });
    assert.equal(found.ok, true);
    assert.deepEqual(found.content.split("\n").sort(), ["calc.js", "run.js"]);
    assert.equal(ui.asked.length, 0, "exploring inside the project asks nothing");

    // read-only tools run side by side
    const [a, b, c] = await Promise.all([go("Read", { path: "calc.js" }), go("Grep", { pattern: "add", output_mode: "content" }), go("LS", {})]);
    assert.ok(a.ok && b.ok && c.ok);
    assert.match(b.content, /calc\.js:1:export function add/);
    assert.ok(s.toolbox.byName.get("Read").concurrencySafe && s.toolbox.byName.get("Grep").concurrencySafe);

    const fix = await go("Edit", { path: "calc.js", old_string: "return a - b;", new_string: "return a + b;" });
    assert.equal(fix.ok, true, fix.content);
    assert.equal(ui.asked.length, 1);
    assert.equal(ui.asked[0].diff.newText.includes("a + b"), true);
    assert.equal(fs.readFileSync(s.abs("calc.js"), "utf8"), "export function add(a, b) {\r\n  return a + b;\r\n}\r\n");

    const ran = await go("Bash", { command: "node run.js", description: "Run the program" });
    assert.equal(ran.ok, true, ran.content);
    assert.match(ran.content, /^5\n/);
    assert.equal(ui.asked.length, 2);
    assert.equal(ui.asked[1].detail, "Run the program\n\nnode run.js");
    assert.deepEqual([...engine.sessionRules], ["Bash:node run.js"]);

    const again = await go("Bash", { command: "node run.js" });
    assert.equal(again.ok, true);
    assert.equal(ui.asked.length, 2, "remembered for the session");

    const todos = await go("TodoWrite", { todos: [{ content: "Verify", status: "completed", activeForm: "Verifying" }] });
    assert.equal(todos.ok, true);

    engine.setMode("plan");
    const blocked = await go("Write", { path: "x.txt", content: "x" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.stage, "permission");
    assert.equal(blocked.by, "mode");
    assert.match(blocked.content, /ExitPlanMode/);
    const list = await go("Bash", { command: "git status --short" });
    assert.equal(list.stage, "run", "read-only commands still work while planning");

    const approved = await go("ExitPlanMode", { plan: "# Plan\nAdd tests." });
    assert.equal(approved.ok, true);
    assert.equal(engine.mode, "acceptEdits");
    const created = await go("Write", { path: "calc.test.js", content: "// tests\n" });
    assert.equal(created.ok, true);
    assert.equal(ui.asked.length, 2, "edits inside the project no longer ask");

    const bad = await go("Edit", { path: "calc.js", old_string: "nope", new_string: "x" });
    assert.equal(bad.ok, false);
    assert.equal(bad.stage, "run");
    assert.match(bad.content, /not found/);
  } finally { await s.toolbox.dispose(); s.cleanup(); }
});

test("validation errors come back before any question is asked", async () => {
  const ui = fakeUi();
  const s = setup({}, { ui });
  try {
    const go = driver(s, createPermissionEngine({ mode: "default", ui }));
    for (const [name, input] of [["Read", {}], ["Write", { path: "a" }], ["Edit", { path: "a" }], ["Bash", {}], ["Grep", {}], ["Glob", {}], ["WebFetch", {}], ["UiLibrary", {}], ["TodoWrite", {}]]) {
      const r = await go(name, input);
      assert.equal(r.stage, "validate", name);
      assert.equal(r.ok, false);
    }
    assert.equal(ui.asked.length, 0);
  } finally { s.cleanup(); }
});
