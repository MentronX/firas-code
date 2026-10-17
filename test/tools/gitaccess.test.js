// Two findings of the security review: (1) hooks and settings under .git are never an ordinary in-project edit, and
// (2) the secret / system / .git checks look at where a link leads, not only at the path as written.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setup, fakeUi } from "./helpers.js";
import { createPermissionEngine } from "../../src/tools/permissions.js";
import { isGitInternal } from "../../src/tools/pathguard.js";

const verdictOf = (s, tool, input) => s.toolbox.byName.get(tool).permission(input, s.ctx);

test("isGitInternal: any .git entry, any separator, any case; not look-alikes", () => {
  for (const p of [".git", ".git/config", ".git\\hooks\\pre-commit", "a/b/.git/hooks/x", "C:\\work\\app\\.GIT\\config", "./.git/", "/repo/.Git"]) assert.equal(isGitInternal(p), true, p);
  for (const p of [".gitignore", ".github/workflows/ci.yml", "src/git/index.js", "mygit/.gitattributes", "a/.git-credentials", "", "digit", ".gitmodules"]) assert.equal(isGitInternal(p), false, p);
  assert.equal(isGitInternal(undefined), false);
});

const FILES = {
  "src/a.js": "let a = 1;\n", "docs/n.md": "n\n",
  ".git/config": "[core]\n", ".git/HEAD": "ref: refs/heads/main\n", ".git/hooks/pre-commit.sample": "#!/bin/sh\n", ".git/info/exclude": "x\n",
  "sub/.git/hooks/post-merge": "#!/bin/sh\n",
};

test("Write, Edit and MultiEdit under .git are high risk; ordinary files stay low", async () => {
  const s = setup(FILES);
  try {
    // (Writing over a file nobody has read is refused by the tool itself, so the existing ones are read first.)
    for (const rel of [".git/config", ".git/HEAD", ".git/info/exclude", ".git/hooks/pre-commit.sample", "sub/.git/hooks/post-merge"]) await s.call("Read", { path: rel });
    for (const rel of [".git/hooks/pre-commit", ".git/config", ".git/HEAD", ".git/info/exclude", ".git/hooks/pre-commit.sample", "sub/.git/hooks/post-merge", ".GIT/hooks/x", ".git/refs/new"]) {
      const v = verdictOf(s, "Write", { path: rel, content: "#!/bin/sh\nevil\n" });
      assert.equal(v.decision, "ask", rel);
      assert.equal(v.risk, "high", `${rel} must be high risk`);
      assert.equal(v.sessionKey, undefined, `${rel}: nothing to remember`);
    }
    const hook = verdictOf(s, "Write", { path: ".git/hooks/pre-commit", content: "x" });
    assert.match(hook.title, /internal file.*run programs/);
    assert.ok(hook.title.includes(".git/hooks/pre-commit"));

    for (const rel of [".git/hooks/pre-commit.sample", "sub/.git/hooks/post-merge", ".git/HEAD"]) {
      await s.call("Read", { path: rel });
      const edit = verdictOf(s, "Edit", { path: rel, old_string: s.read(rel), new_string: "zzz\n" });
      assert.equal(edit.risk, "high", `Edit ${rel}`);
      const multi = verdictOf(s, "MultiEdit", { path: rel, edits: [{ old_string: s.read(rel), new_string: "zzz\n" }] });
      assert.equal(multi.risk, "high", `MultiEdit ${rel}`);
    }

    await s.call("Read", { path: "src/a.js" });
    const ordinary = verdictOf(s, "Edit", { path: "src/a.js", old_string: "1", new_string: "2" });
    assert.equal(ordinary.risk, "low");
    assert.equal(ordinary.sessionKey, "Edit:*");
    assert.equal(verdictOf(s, "Write", { path: ".github/workflows/ci.yml", content: "x" }).risk, "low", ".github is not .git");
    assert.equal(verdictOf(s, "Write", { path: ".gitignore", content: "x" }).risk, "low", ".gitignore is not .git");
  } finally { s.cleanup(); }
});

test("a write under .git asks in acceptEdits and in bypass mode, and 'allow for this session' never covers it", async () => {
  for (const mode of ["acceptEdits", "bypass"]) {
    const ui = fakeUi({ permission: [{ decision: "allow-session" }, { decision: "allow-session" }, { decision: "allow-session" }] });
    const s = setup(FILES, { ui });
    try {
      const engine = createPermissionEngine({ mode, ui });
      const write = rel => engine.check(s.toolbox.byName.get("Write"), { path: rel, content: "x" }, s.ctx);
      assert.equal((await write(".git/hooks/pre-commit")).allowed, true);
      assert.equal(ui.asked.length, 1, `${mode}: the person was asked`);
      assert.equal(ui.asked[0].risk, "high");
      assert.equal(ui.asked[0].sessionKey, undefined, "no 'for this session' choice was offered");
      assert.equal(engine.sessionRules.size, 0);
      await write(".git/hooks/pre-commit");
      assert.equal(ui.asked.length, 2, `${mode}: asked again for the same file`);
      assert.equal((await write("docs/new.md")).allowed, true);
      assert.equal(ui.asked.length, mode === "acceptEdits" ? 2 : 2, "an ordinary file is silent in both modes");
    } finally { s.cleanup(); }
  }
  // In the default mode "allow for this session" on a normal edit must not make a later .git write silent either.
  const ui = fakeUi({ permission: [{ decision: "allow-session" }, { decision: "deny" }] });
  const s = setup(FILES, { ui });
  try {
    const engine = createPermissionEngine({ mode: "default", ui });
    const write = rel => engine.check(s.toolbox.byName.get("Write"), { path: rel, content: "x" }, s.ctx);
    assert.equal((await write("docs/other.md")).allowed, true);
    assert.ok(engine.sessionRules.has("Edit:*"));
    assert.equal((await write(".git/hooks/pre-commit")).allowed, false, "denied by the second answer: it was asked, not waved through");
    assert.equal(ui.asked.length, 2);
  } finally { s.cleanup(); }
});

test("Bash commands that write into .git or change git settings are high risk and always asked, bypass included", async () => {
  const commands = [
    "echo '#!/bin/sh' > .git/hooks/pre-commit", "echo x >> .git/config", "cp evil.sh .git/hooks/pre-commit", "tee .git/hooks/post-merge",
    "git config core.fsmonitor ./evil.sh", "git config user.name Firas", "git config --global core.hooksPath hooks", "git -C . config core.pager 'sh -c id'",
    "git config --add alias.x '!sh'", "sed -i s/a/b/ .git/config", "mv x .git/hooks/pre-push",
  ];
  for (const mode of ["default", "acceptEdits", "bypass"]) {
    for (const command of commands) {
      const ui = fakeUi({ permission: [{ decision: "deny" }] });
      const s = setup({ "a.txt": "x" }, { ui });
      try {
        const engine = createPermissionEngine({ mode, ui });
        const res = await engine.check(s.toolbox.byName.get("Bash"), { command }, s.ctx);
        assert.equal(res.allowed, false, `${mode}: ${command} slipped through`);
        assert.equal(ui.asked.length, 1, `${mode}: ${command}`);
        assert.equal(ui.asked[0].risk, "high", `${mode}: ${command}`);
        assert.equal(ui.asked[0].sessionKey, undefined);
        assert.match(ui.asked[0].detail, /internal files or settings, which can make git run programs/);
      } finally { s.cleanup(); }
    }
  }
  // Reading settings is not writing them.
  const s = setup({ "a.txt": "x" });
  try {
    for (const command of ["git config --get user.name", "git config --list", "git config user.name"]) {
      const v = verdictOf(s, "Bash", { command });
      assert.notEqual(v.risk, "high", command);
    }
  } finally { s.cleanup(); }
});

// ------------------------------------------------------------------------------------------------ links

function makeLink(target, link) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("a link inside the project that leads into a protected folder is as protected as the folder, and the dialog shows both", async t => {
  const s = setup({ "src/a.js": "x\n" });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "fc2 away-"));
  try {
    fs.mkdirSync(path.join(elsewhere, ".ssh"));
    fs.mkdirSync(path.join(elsewhere, "plain"));
    fs.mkdirSync(path.join(s.dir, ".git", "hooks"), { recursive: true });
    try {
      makeLink(path.join(elsewhere, ".ssh"), s.abs("keys"));
      makeLink(path.join(elsewhere, "plain"), s.abs("away"));
      makeLink(path.join(s.dir, ".git", "hooks"), s.abs("hooks"));
    } catch (error) { t.skip(`cannot create a link here: ${error.code}`); return; }

    // A secret folder behind a link
    const write = verdictOf(s, "Write", { path: "keys/known_hosts", content: "x" });
    assert.equal(write.risk, "high");
    assert.match(write.title, /may hold secrets/);
    assert.ok(write.title.includes("keys/known_hosts") && write.title.includes(".ssh"), `both the link and its target are shown: ${write.title}`);
    assert.ok(write.detail.includes(" -> "), write.detail);
    const read = verdictOf(s, "Read", { path: "keys/known_hosts" });
    assert.equal(read.risk, "high");
    assert.match(read.title, /secrets/);
    assert.ok(read.detail.includes("keys/known_hosts") && read.detail.includes(".ssh"), read.detail);
    for (const tool of ["LS", "Grep", "Glob"]) {
      const input = tool === "LS" ? { path: "keys" } : tool === "Grep" ? { pattern: "x", path: "keys" } : { pattern: "*", path: "keys" };
      assert.equal(verdictOf(s, tool, input).risk, "high", `${tool} through the link`);
    }

    // The project's own .git behind a link
    const hook = verdictOf(s, "Write", { path: "hooks/pre-commit", content: "x" });
    assert.equal(hook.risk, "high");
    assert.match(hook.title, /internal file/);
    assert.ok(hook.title.includes("hooks/pre-commit") && hook.title.includes(".git"), hook.title);

    // A harmless folder behind a link: a plain outside write, remembered by where it really is
    const away = verdictOf(s, "Write", { path: "away/n.txt", content: "x" });
    assert.equal(away.risk, "medium");
    assert.equal(away.inside, false);
    assert.match(away.detail, /away[^\n]*\n-> .*plain/, "the dialog names the link on one line and its target on the next");
    const realDir = fs.realpathSync(path.join(elsewhere, "plain"));
    assert.equal(away.sessionKey, `Edit:dir:${realDir}`, "the rule is bound to the real folder, not to a link that can be pointed elsewhere later");
    const readAway = verdictOf(s, "LS", { path: "away" });
    assert.equal(readAway.risk, "low");
    assert.equal(readAway.sessionKey, `Read:dir:${realDir}`);

    // An ordinary file in the project is untouched by all of this
    assert.equal(verdictOf(s, "Write", { path: "src/new.js", content: "x" }).risk, "low");
    assert.equal(verdictOf(s, "Read", { path: "src/a.js" }).decision, "allow");
  } finally {
    for (const name of ["keys", "away", "hooks"]) { try { fs.unlinkSync(s.abs(name)); } catch { try { fs.rmdirSync(s.abs(name)); } catch { /* not created */ } } }
    fs.rmSync(elsewhere, { recursive: true, force: true });
    s.cleanup();
  }
});

test("a link that leads into a system folder is a high-risk write", async t => {
  const s = setup({ "a.txt": "x" });
  const system = process.platform === "win32" ? (process.env.SystemRoot || "C:\\Windows") : "/etc";
  try {
    try { makeLink(system, s.abs("sys")); } catch (error) { t.skip(`cannot create a link here: ${error.code}`); return; }
    const v = verdictOf(s, "Write", { path: "sys/x.txt", content: "x" });
    assert.equal(v.risk, "high");
    assert.match(v.title, /system file/);
  } finally {
    try { fs.unlinkSync(s.abs("sys")); } catch { try { fs.rmdirSync(s.abs("sys")); } catch { /* not created */ } }
    s.cleanup();
  }
});
