import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup } from "./helpers.js";
import { findExecutable } from "../../src/tools/walk.js";

const haveRg = !!findExecutable("rg");

// Every scenario runs on the JS fallback (FIRAS_NO_RG=1) and, when ripgrep is installed, on ripgrep, and must
// give the same answer.
const engines = [["js fallback", { FIRAS_NO_RG: "1" }], ...(haveRg ? [["ripgrep", { FIRAS_NO_RG: "0" }]] : [])];

function scenario(name, files, fn) {
  for (const [label, envExtra] of engines) {
    test(`Grep (${label}): ${name}`, async () => {
      const s = setup(files, { ctx: { env: { ...process.env, ...envExtra } } });
      try { await fn(s, label); } finally { s.cleanup(); }
    });
  }
}

const out = r => r.content.split("\n");

const SRC = {
  "src/app.js": "const alpha = 1;\nfunction Beta() {\n  return alpha + 2;\n}\n// TODO: refactor\n",
  "src/util.ts": "export const beta = 2;\nexport function gamma() {}\n// todo later\n",
  "README.md": "# Project\nAlpha release notes\n",
};

scenario("lists files with matches, newest first (the default mode)", SRC, async s => {
  const now = Date.now() / 1000;
  fs.utimesSync(s.abs("README.md"), now - 500, now - 500);
  fs.utimesSync(s.abs("src/app.js"), now - 100, now - 100);
  fs.utimesSync(s.abs("src/util.ts"), now - 300, now - 300);
  const r = await s.call("Grep", { pattern: "alpha|beta" });
  assert.equal(r.ok, true);
  assert.deepEqual(out(r), ["src/app.js", "src/util.ts"]);
  assert.equal(r.display.summary, "2 files");
});

scenario("content mode prints path:line:text, sorted by path, with line numbers by default", SRC, async s => {
  const r = await s.call("Grep", { pattern: "alpha", output_mode: "content" });
  assert.deepEqual(out(r), ["src/app.js:1:const alpha = 1;", "src/app.js:3:  return alpha + 2;"]);
  assert.equal(r.display.summary, "2 matches");
  const noNumbers = await s.call("Grep", { pattern: "alpha", output_mode: "content", "-n": false });
  assert.deepEqual(out(noNumbers), ["src/app.js:const alpha = 1;", "src/app.js:  return alpha + 2;"]);
});

scenario("the card body previews the first three entries, with a note for the rest, and never the context separators", {
  "a.txt": "hit 1\nx\nhit 2\n", "b.txt": "hit 3\n", "c.txt": "hit 4\n", "d.txt": "hit 5\n",
}, async s => {
  const files = await s.call("Grep", { pattern: "hit" });
  assert.equal(files.display.body.split("\n").length, 4);
  assert.match(files.display.body.split("\n")[3], /^… \+1 more$/);
  assert.ok(files.display.body.startsWith("a.txt\n") || files.display.body.split("\n").slice(0, 3).every(line => /\.txt$/.test(line)));
  const content = await s.call("Grep", { pattern: "hit", output_mode: "content", "-C": 1 });
  const body = content.display.body.split("\n");
  assert.equal(body.length, 4);
  assert.ok(!body.includes("--"));
  assert.match(body[3], /^… \+\d+ more$/);
  const one = await s.call("Grep", { pattern: "hit 3" });
  assert.equal(one.display.body, "b.txt");
  assert.equal((await s.call("Grep", { pattern: "absent-text" })).display.body, undefined);
});

scenario("-i ignores case; matching is case-sensitive otherwise", SRC, async s => {
  assert.deepEqual(out(await s.call("Grep", { pattern: "alpha", output_mode: "count" })), ["src/app.js:2"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "alpha", output_mode: "count", "-i": true })), ["README.md:1", "src/app.js:2"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "todo", output_mode: "content", "-i": true })).sort(), ["src/app.js:5:// TODO: refactor", "src/util.ts:3:// todo later"]);
});

scenario("context lines use '-' and groups are separated by --", { "f.txt": "a1\nb2\nMATCH one\nc4\nd5\ne6\nf7\nMATCH two\nh9\n" }, async s => {
  const r = await s.call("Grep", { pattern: "MATCH", output_mode: "content", "-C": 1 });
  assert.deepEqual(out(r), ["f.txt-2-b2", "f.txt:3:MATCH one", "f.txt-4-c4", "--", "f.txt-7-f7", "f.txt:8:MATCH two", "f.txt-9-h9"]);
  const after = await s.call("Grep", { pattern: "MATCH one", output_mode: "content", "-A": 2 });
  assert.deepEqual(out(after), ["f.txt:3:MATCH one", "f.txt-4-c4", "f.txt-5-d5"]);
  const before = await s.call("Grep", { pattern: "MATCH two", output_mode: "content", "-B": 1 });
  assert.deepEqual(out(before), ["f.txt-7-f7", "f.txt:8:MATCH two"]);
  const joined = await s.call("Grep", { pattern: "MATCH", output_mode: "content", "-C": 3 });
  assert.ok(!out(joined).includes("--"), "overlapping context makes one group");
});

scenario("glob and type filters", SRC, async s => {
  assert.deepEqual(out(await s.call("Grep", { pattern: "const", glob: "*.ts" })), ["src/util.ts"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "const", glob: "src/**/*.{js,ts}" })).sort(), ["src/app.js", "src/util.ts"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "const", type: "js" })), ["src/app.js"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "export", type: "typescript" })), ["src/util.ts"]);
  assert.match((await s.call("Grep", { pattern: "x", type: "klingon" })).content, /Unknown file type/);
});

scenario("path can be a folder or a single file", SRC, async s => {
  assert.deepEqual(out(await s.call("Grep", { pattern: "beta", path: "src", "-i": true })).sort(), ["src/app.js", "src/util.ts"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "beta", path: "src/util.ts", output_mode: "content" })), ["src/util.ts:1:export const beta = 2;"]);
  assert.match((await s.call("Grep", { pattern: "x", path: "nope" })).content, /does not exist/);
});

scenario("regular expressions: classes, anchors, alternation, escapes", { "f.txt": "id: 42\nname: Ada\nx = (a+b)\nend.\n" }, async s => {
  assert.deepEqual(out(await s.call("Grep", { pattern: "^id: \\d+$", output_mode: "content" })), ["f.txt:1:id: 42"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "name|end\\.", output_mode: "count" })), ["f.txt:2"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "\\(a\\+b\\)", output_mode: "content" })), ["f.txt:3:x = (a+b)"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "[A-Z][a-z]+$", output_mode: "content" })), ["f.txt:2:name: Ada"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "-?\\d+", output_mode: "count" })), ["f.txt:1"]);
});

scenario("multiline patterns span lines", { "f.js": "function a() {\n  return 1;\n}\nfunction b() {}\n" }, async s => {
  const r = await s.call("Grep", { pattern: "function a\\(\\) \\{\\n  return", multiline: true, output_mode: "content" });
  assert.deepEqual(out(r), ["f.js:1:function a() {", "f.js:2:  return 1;"]);
  const implied = await s.call("Grep", { pattern: "a\\(\\) \\{\\n  return", output_mode: "content" });
  assert.deepEqual(out(implied), ["f.js:1:function a() {", "f.js:2:  return 1;"], "a pattern with \\n implies multiline");
  assert.match((await s.call("Grep", { pattern: "a\\(\\) \\{ return" })).content, /No matches/);
});

scenario("Arabic patterns, content and file names", { "مجلد/ملف.txt": "السلام عليكم\nمرحبا بالعالم\nشكرا جزيلا\n" }, async s => {
  const r = await s.call("Grep", { pattern: "مرحبا", output_mode: "content" });
  assert.deepEqual(out(r), ["مجلد/ملف.txt:2:مرحبا بالعالم"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "ش.را" })), ["مجلد/ملف.txt"]);
});

scenario("CRLF files and a UTF-8 BOM give clean lines", {}, async s => {
  fs.writeFileSync(s.abs("w.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\nsecond target\r\nthird\r\n")]));
  assert.deepEqual(out(await s.call("Grep", { pattern: "target", output_mode: "content" })), ["w.txt:2:second target"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "^first$", output_mode: "content" })), ["w.txt:1:first"]);
});

scenario("binary files, huge files and default-ignored folders are skipped", {
  "ok.txt": "needle here\n", "node_modules/p/i.js": "needle\n", "dist/o.js": "needle\n", ".git/config": "needle\n", "build/b.js": "needle\n",
}, async s => {
  fs.writeFileSync(s.abs("img.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from("needle")]));
  fs.writeFileSync(s.abs("huge.txt"), "needle\n" + "x".repeat(1_100_000));
  assert.deepEqual(out(await s.call("Grep", { pattern: "needle" })), ["ok.txt"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "needle", path: "node_modules" })), ["node_modules/p/i.js"]);
});

scenario("a root .gitignore is respected", { "keep.txt": "needle\n", "skip.txt": "needle\n", "logs/a.log": "needle\n", ".gitignore": "skip.txt\nlogs/\n" }, async s => {
  assert.deepEqual(out(await s.call("Grep", { pattern: "needle" })), ["keep.txt"]);
});

scenario("head_limit cuts the output and says how much is missing", { "f.txt": Array.from({ length: 40 }, (_, i) => `hit ${i + 1}`).join("\n") }, async s => {
  const r = await s.call("Grep", { pattern: "hit", output_mode: "content", head_limit: 10 });
  assert.equal(out(r).filter(l => l.startsWith("f.txt:")).length, 10);
  assert.match(r.content, /Output limited to 10 lines \(head_limit\); 30 more not shown/);
  const many = await s.call("Grep", { pattern: "hit", output_mode: "content" });
  assert.equal(out(many).filter(l => l.startsWith("f.txt:")).length, 40, "the default limit is 250");
});

scenario("very long lines are cut at 500 characters", { "f.txt": `start ${"z".repeat(900)} end\n` }, async s => {
  const r = await s.call("Grep", { pattern: "start", output_mode: "content" });
  assert.ok(r.content.length < 700);
  assert.match(r.content, /line cut: 910 characters in total/);
});

scenario("no match and bad patterns", SRC, async s => {
  const none = await s.call("Grep", { pattern: "zzzz-not-here" });
  assert.equal(none.ok, true);
  assert.match(none.content, /No matches for "zzzz-not-here"/);
  assert.equal(none.display.summary, "No matches");
  const bad = await s.call("Grep", { pattern: "(unclosed" });
  assert.equal(bad.ok, false);
  assert.match(bad.content, /(Invalid regular expression|Search failed)/);
  assert.equal(bad.display.summary, "Invalid search pattern");
});

scenario("names with spaces", { "my folder/a file.txt": "needle\n" }, async s => {
  assert.deepEqual(out(await s.call("Grep", { pattern: "needle" })), ["my folder/a file.txt"]);
  assert.deepEqual(out(await s.call("Grep", { pattern: "needle", path: "my folder" })), ["my folder/a file.txt"]);
});

scenario("searching a folder never reveals files that may hold secrets", {
  ".env": "DATABASE_PASSWORD=hunter2\n", ".env.local": "PASSWORD=local\n", ".env.example": "PASSWORD=\n", "config.js": "const PASSWORD = process.env.PASSWORD;\n",
  "keys/server.pem": "PASSWORD\n", "keys/id_rsa": "PASSWORD\n", "credentials.json": '{"PASSWORD":"x"}\n', ".npmrc": "PASSWORD=t\n", "docs/notes.md": "PASSWORD reminder\n",
}, async s => {
  const list = await s.call("Grep", { pattern: "PASSWORD" });
  assert.deepEqual(out(list).filter(l => !l.startsWith("[")).sort(), [".env.example", "config.js", "docs/notes.md"]);
  assert.match(list.content, /\[6 files that may hold secrets \(.env files, keys, credentials\) also matched and are left out\. If the user asked for one, use Read on it\.\]/);
  const withoutNote = r => r.content.replace(/\n\[\d+ files? that may hold secrets[^\n]*$/, "");
  const secretNames = /(^|[/:])\.env(\.local)?[:\s]|server\.pem|id_rsa|\.npmrc|credentials\.json|hunter2/;
  const content = await s.call("Grep", { pattern: "PASSWORD", output_mode: "content" });
  assert.ok(!secretNames.test(withoutNote(content)), withoutNote(content));
  assert.ok(content.content.includes("config.js:1:const PASSWORD"));
  const count = await s.call("Grep", { pattern: "PASSWORD", output_mode: "count" });
  assert.ok(!secretNames.test(withoutNote(count)), withoutNote(count));
  assert.deepEqual(out(count).filter(l => !l.startsWith("[")).sort(), [".env.example:1", "config.js:1", "docs/notes.md:1"]);
  const only = await s.call("Grep", { pattern: "hunter2" });
  assert.equal(only.ok, true);
  assert.match(only.content, /^No matches for "hunter2" in \.\. \[1 file that may hold secrets .* is left out\./);
  // Naming the secret file itself is a different request: the permission engine asks (high risk) before it can run.
  const grep = s.toolbox.byName.get("Grep");
  const verdict = grep.permission({ pattern: "PASSWORD", path: ".env" }, s.ctx);
  assert.equal(verdict.decision, "ask");
  assert.equal(verdict.risk, "high");
  const direct = await s.call("Grep", { pattern: "PASSWORD", path: ".env", output_mode: "content" });
  assert.deepEqual(out(direct), [".env:1:DATABASE_PASSWORD=hunter2"]);
});

test("Grep validation and permissions", () => {
  const s = setup(SRC);
  try {
    const grep = s.toolbox.byName.get("Grep");
    assert.match(grep.validate({}, s.ctx), /pattern is required/);
    assert.match(grep.validate({ pattern: "x", output_mode: "lines" }, s.ctx), /output_mode/);
    assert.match(grep.validate({ pattern: "x", "-A": -1 }, s.ctx), /-A/);
    assert.equal(grep.validate({ pattern: "x" }, s.ctx), null);
    assert.equal(grep.permission({ pattern: "x" }, s.ctx).decision, "allow");
    assert.equal(grep.permission({ pattern: "x", path: process.platform === "win32" ? "C:\\" : "/" }, s.ctx).decision, "ask");
    assert.equal(grep.readOnly, true);
    assert.ok(grep.input_schema.properties["-i"] && grep.input_schema.properties["-C"]);
  } finally { s.cleanup(); }
});

test("ripgrep availability is reported honestly", () => {
  assert.equal(typeof haveRg, "boolean");
});
