// Glob with ".." (or a link) at the start of its pattern lists a place other than the search folder. The permission
// question has to be about the place the walk really starts, not only about the folder named in `path`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup, fakeUi } from "./helpers.js";
import { createPermissionEngine } from "../../src/tools/permissions.js";

const glob = s => s.toolbox.byName.get("Glob");

function withSibling(files, fn) {
  return async () => {
    const s = setup(files);
    const sibling = fs.mkdtempSync(path.join(path.dirname(s.dir), "fc2-sibling-"));
    fs.writeFileSync(path.join(sibling, "secret-name.js"), "x");
    try { await fn(s, sibling, path.basename(sibling)); } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
      s.cleanup();
    }
  };
}

test("a pattern that climbs out of the project asks, however the climb is written", withSibling({ "src/a.js": "1", "lib/b.js": "2" }, async (s, sibling, name) => {
  const asks = [
    { pattern: "../*.js" }, { pattern: "../" + name + "/*.js" }, { pattern: "src/../../*.js" }, { pattern: "{..,src}/*.js" },
    { pattern: "..\\" + name + "\\*.js" }, { pattern: "./../*.js" }, { pattern: "../../**/*.js" }, { pattern: "src/{a,../..}/*.js" },
    { pattern: "../../*.js", path: "src" },
    { pattern: path.join(s.dir, "{..,src}", "*.js").replace(/\\/g, "/") },
  ];
  for (const input of asks) {
    const v = glob(s).permission(input, s.ctx);
    assert.equal(v.decision, "ask", JSON.stringify(input));
    assert.equal(v.category, "read");
    assert.equal(v.inside, false, JSON.stringify(input));
    assert.equal(glob(s).validate(input, s.ctx), null, "asking is the right answer, not refusing");
  }
}));

test("a pattern that stays inside the project is still silent, even with .. in it", withSibling({ "src/a.js": "1", "lib/b.js": "2" }, async (s, sibling, name) => {
  const here = path.basename(s.dir);
  const silent = [
    { pattern: "**/*.js" }, { pattern: "src/*.js" }, { pattern: "src/../lib/*.js" }, { pattern: "../lib/*.js", path: "src" }, { pattern: "{src,lib}/*.js" },
    { pattern: "../" + here + "/src/*.js" }, { pattern: "src/**/../*.js" },
  ];
  for (const input of silent) assert.equal(glob(s).permission(input, s.ctx).decision, "allow", JSON.stringify(input));
}));

test("the engine asks (and a refusal stops the listing) before a climbing pattern is run", withSibling({ "src/a.js": "1" }, async (s, sibling, name) => {
  const ui = fakeUi({ permission: [{ decision: "deny" }, { decision: "allow" }] });
  const engine = createPermissionEngine({ mode: "default", ui });
  const refused = await engine.check(glob(s), { pattern: "../" + name + "/*.js" }, s.ctx);
  assert.equal(refused.allowed, false);
  assert.equal(ui.asked.length, 1);
  assert.match(ui.asked[0].title, /Read outside the project/);
  assert.ok(ui.asked[0].detail.includes(name), "the dialog names the folder that would be listed");
  const granted = await engine.check(glob(s), { pattern: "../" + name + "/*.js" }, s.ctx);
  assert.equal(granted.allowed, true);
  const quiet = await engine.check(glob(s), { pattern: "src/*.js" }, s.ctx);
  assert.equal(quiet.allowed, true);
  assert.equal(ui.asked.length, 2, "an ordinary pattern asks nothing");
}));

test("approving an outside folder does not approve what is above it", withSibling({ "src/a.js": "1" }, async (s, sibling, name) => {
  const inside = glob(s).permission({ pattern: "*.js", path: sibling }, s.ctx);
  assert.equal(inside.decision, "ask");
  const upward = glob(s).permission({ pattern: "../*.js", path: sibling }, s.ctx);
  assert.equal(upward.decision, "ask");
  assert.notEqual(upward.sessionKey, inside.sessionKey, "the rule for the folder does not cover the folder above it");
  const sameFolder = glob(s).permission({ pattern: "sub/../*.js", path: sibling }, s.ctx);
  assert.equal(sameFolder.sessionKey, inside.sessionKey, "a detour that comes back is still the same folder");
}));

test("a link at the start of the pattern is judged by where it leads", withSibling({ "src/a.js": "1" }, async (s, sibling, name) => {
  try { fs.symlinkSync(sibling, s.abs("away"), process.platform === "win32" ? "junction" : "dir"); } catch { return; }
  try {
    const v = glob(s).permission({ pattern: "away/*.js" }, s.ctx);
    assert.equal(v.decision, "ask");
    assert.equal(v.inside, false);
    assert.equal(glob(s).permission({ pattern: "src/*.js" }, s.ctx).decision, "allow");
  } finally {
    try { fs.unlinkSync(s.abs("away")); } catch { try { fs.rmdirSync(s.abs("away")); } catch { /* not there */ } }
  }
}));

test("a malformed pattern is reported by the search, not by a crash in the permission check", withSibling({ "src/a.js": "1" }, async s => {
  const input = { pattern: "src/[z-a]/*.js" };
  assert.doesNotThrow(() => glob(s).permission(input, s.ctx));
  assert.doesNotThrow(() => glob(s).validate(input, s.ctx));
}));
