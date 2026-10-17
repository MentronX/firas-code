import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup } from "./helpers.js";
import { setLang } from "../../src/i18n/index.js";
import { expandBraces, globToRegExp, compileGlob, compileNameFilter, minimalPrefixes } from "../../src/tools/globmatch.js";

const lines = r => r.content.split("\n").filter(l => l && !l.startsWith("("));

test("matcher: ** * ? [abc] {a,b}", () => {
  const m = (pattern, rel, opts) => globToRegExp(pattern, opts).test(rel);
  assert.ok(m("**/*.js", "a.js") && m("**/*.js", "src/deep/a.js") && !m("**/*.js", "a.ts"));
  assert.ok(m("*.js", "a.js") && !m("*.js", "src/a.js"));
  assert.ok(m("src/**/*.ts", "src/a.ts") && m("src/**/*.ts", "src/x/y/a.ts") && !m("src/**/*.ts", "lib/a.ts"));
  assert.ok(m("src/**", "src/x/y.txt") && !m("src/**", "other/y.txt"));
  assert.ok(m("a?c.txt", "abc.txt") && !m("a?c.txt", "ac.txt") && !m("a?c.txt", "a/c.txt"));
  assert.ok(m("[abc].txt", "b.txt") && !m("[abc].txt", "d.txt"));
  assert.ok(m("[a-c]x", "bx") && m("[!a]x", "bx") && !m("[!a]x", "ax") && !m("[!a]x", "/x"));
  assert.ok(m("test_*.py", "test_foo.py") && !m("test_*.py", "foo_test.py"));
  assert.ok(m("*.JS", "a.js", { caseInsensitive: true }) && !m("*.JS", "a.js"));
  assert.ok(m("a.b+c(1).txt", "a.b+c(1).txt"), "regex characters are literal");
  assert.ok(m("**/مجلد/*.txt", "x/مجلد/ملف.txt"));
  assert.ok(m("src\\**\\*.js", "src/a/b.js"), "backslashes are separators");
});

test("matcher: braces expand, nested and literal", () => {
  assert.deepEqual(expandBraces("a.{js,ts}"), ["a.js", "a.ts"]);
  assert.deepEqual(expandBraces("{a,b}/{c,d}").sort(), ["a/c", "a/d", "b/c", "b/d"]);
  assert.deepEqual(expandBraces("x{a,b{c,d}}y").sort(), ["xay", "xbcy", "xbdy"]);
  assert.deepEqual(expandBraces("{solo}"), ["{solo}"]);
  assert.deepEqual(expandBraces("plain"), ["plain"]);
  const g = compileGlob("src/**/*.{ts,tsx}");
  assert.ok(g.test("src/a.ts") && g.test("src/x/a.tsx") && !g.test("src/a.js"));
  assert.deepEqual(g.prefixes, ["src"]);
  assert.deepEqual(minimalPrefixes(["src/a", "src", "lib"]).sort(), ["lib", "src"]);
  const name = compileNameFilter("*.log");
  assert.ok(name("a.log") && name("x/y/a.log") && !name("a.txt"));
  const anchored = compileNameFilter("build/out");
  assert.ok(anchored("build/out") && !anchored("x/build/out/z"));
});

test("Glob finds files recursively, newest first, with forward slashes", async () => {
  const s = setup({ "a.js": "1", "src/b.js": "2", "src/deep/c.js": "3", "src/d.ts": "4", "README.md": "5" });
  try {
    const now = Date.now() / 1000;
    fs.utimesSync(s.abs("a.js"), now - 300, now - 300);
    fs.utimesSync(s.abs("src/b.js"), now - 100, now - 100);
    fs.utimesSync(s.abs("src/deep/c.js"), now - 200, now - 200);
    const r = await s.call("Glob", { pattern: "**/*.js" });
    assert.equal(r.ok, true);
    assert.deepEqual(lines(r), ["src/b.js", "src/deep/c.js", "a.js"]);
    assert.equal(r.display.summary, "3 files");
    assert.deepEqual(lines(await s.call("Glob", { pattern: "src/**/*.{js,ts}" })).sort(), ["src/b.js", "src/d.ts", "src/deep/c.js"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: "*.md" })), ["README.md"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: "**/*.js", path: "src" })).sort(), ["src/b.js", "src/deep/c.js"]);
  } finally { s.cleanup(); }
});

test("Glob's card body shows the first three paths and how many more there are", async () => {
  const files = {};
  for (let i = 1; i <= 6; i++) files[`src/f${i}.js`] = String(i);
  const s = setup(files);
  try {
    const now = Date.now() / 1000;
    for (let i = 1; i <= 6; i++) fs.utimesSync(s.abs(`src/f${i}.js`), now - i * 10, now - i * 10);
    const r = await s.call("Glob", { pattern: "src/*.js" });
    assert.equal(r.display.body, "src/f1.js\nsrc/f2.js\nsrc/f3.js\n… +3 more");
    assert.equal(r.content.split("\n").length, 6, "the model still reads every path");
    const few = await s.call("Glob", { pattern: "src/f[12].js" });
    assert.equal(few.display.body, "src/f1.js\nsrc/f2.js", "no note when everything is shown");
    assert.equal((await s.call("Glob", { pattern: "*.nothing" })).display.body, undefined);
    setLang("ar");
    try { assert.equal((await s.call("Glob", { pattern: "src/*.js" })).display.body.split("\n").pop(), "… +3 أخرى"); } finally { setLang("en"); }
  } finally { s.cleanup(); }
});

test("Glob skips node_modules, .git, dist and friends unless named", async () => {
  const s = setup({
    "app.js": "1", "node_modules/pkg/index.js": "2", ".git/hooks/x.js": "3", "dist/out.js": "4", "build/b.js": "5", "target/t.js": "6",
    "coverage/c.js": "7", "__pycache__/p.js": "8", ".venv/v.js": "9", ".next/n.js": "a", "src/dist/ok.js": "b",
  });
  try {
    assert.deepEqual(lines(await s.call("Glob", { pattern: "**/*.js" })), ["app.js"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: "node_modules/**/*.js" })), ["node_modules/pkg/index.js"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: "**/*.js", path: "node_modules" })), ["node_modules/pkg/index.js"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: "dist/*.js" })), ["dist/out.js"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: "**/{dist,build}/*.js" })).sort(), ["build/b.js", "dist/out.js", "src/dist/ok.js"]);
  } finally { s.cleanup(); }
});

test("Glob includes dotfiles, Arabic names and names with spaces", async () => {
  const s = setup({ ".eslintrc.json": "{}", ".github/workflows/ci.yml": "x", "مستند/ملف عربي.md": "م", "my docs/read me.md": "r" });
  try {
    assert.deepEqual(lines(await s.call("Glob", { pattern: ".*" })), [".eslintrc.json"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: ".github/**/*.yml" })), [".github/workflows/ci.yml"]);
    assert.deepEqual(lines(await s.call("Glob", { pattern: "**/*.md" })).sort(), ["my docs/read me.md", "مستند/ملف عربي.md"].sort());
    assert.deepEqual(lines(await s.call("Glob", { pattern: "مستند/*" })), ["مستند/ملف عربي.md"]);
  } finally { s.cleanup(); }
});

test("Glob limits to 200 results and says so", async () => {
  const files = {};
  for (let i = 0; i < 230; i++) files[`many/f${String(i).padStart(3, "0")}.txt`] = "x";
  const s = setup(files);
  try {
    const r = await s.call("Glob", { pattern: "many/*.txt" });
    assert.equal(lines(r).length, 200);
    assert.match(r.content, /Showing the 200 most recently modified of 230 matches/);
  } finally { s.cleanup(); }
});

test("Glob with no match explains why, and widens a bare pattern", async () => {
  const s = setup({ "src/only.ts": "x" });
  try {
    const widened = await s.call("Glob", { pattern: "*.ts" });
    assert.deepEqual(lines(widened), ["src/only.ts"]);
    assert.match(widened.content, /No match directly in the search folder/);
    const none = await s.call("Glob", { pattern: "src/**/*.rs" });
    assert.equal(none.ok, true);
    assert.match(none.content, /No files matched "src\/\*\*\/\*\.rs"/);
    assert.match(none.content, /node_modules, dist, build and \.git are skipped/);
    assert.equal(none.display.summary, "No files found");
  } finally { s.cleanup(); }
});

test("Glob: absolute patterns, bad folders, files given as folders", async () => {
  const s = setup({ "src/a.js": "x", "f.txt": "y" });
  try {
    const abs = (s.dir + "/src/**/*.js").replace(/\\/g, "/");
    assert.deepEqual(lines(await s.call("Glob", { pattern: abs })), ["src/a.js"]);
    assert.match((await s.call("Glob", { pattern: "*", path: "nope" })).content, /does not exist/);
    assert.match((await s.call("Glob", { pattern: "*", path: "f.txt" })).content, /is a file, not a folder/);
    assert.match((await s.call("Glob", {})).content, /pattern is required/);
    const glob = s.toolbox.byName.get("Glob");
    const outside = glob.permission({ pattern: "**/*.js", path: path.dirname(s.dir) }, s.ctx);
    assert.equal(outside.decision, "ask");
    const absOutside = glob.permission({ pattern: path.join(path.dirname(s.dir), "**", "*.js").replace(/\\/g, "/") }, s.ctx);
    assert.equal(absOutside.decision, "ask", "an absolute pattern cannot dodge the outside-folder question");
    assert.equal(glob.permission({ pattern: "**/*.js" }, s.ctx).decision, "allow");
  } finally { s.cleanup(); }
});

test("Glob matches case-insensitively on Windows", { skip: process.platform !== "win32" }, async () => {
  const s = setup({ "Src/Readme.MD": "x" });
  try {
    assert.deepEqual(lines(await s.call("Glob", { pattern: "src/*.md" })).map(l => l.toLowerCase()), ["src/readme.md"]);
  } finally { s.cleanup(); }
});

// ----------------------------------------------------------------------------------------------- LS

test("LS lists folders first, then files with sizes", async () => {
  const s = setup({ "zeta/inner.txt": "x", "alpha/a.txt": "x", "b.txt": "12345", "a10.txt": "x", "a2.txt": "x", ".hidden": "h" });
  try {
    const r = await s.call("LS", { path: "." });
    assert.equal(r.ok, true);
    const rows = r.content.split("\n");
    assert.match(rows[0], /^\. \(6 entries\)$/);
    assert.deepEqual(rows.slice(1), ["alpha/ (1 items)", "zeta/ (1 items)", ".hidden  1 B", "a2.txt  1 B", "a10.txt  1 B", "b.txt  5 B"]);
    assert.equal(r.display.summary, "6 entries");
  } finally { s.cleanup(); }
});

test("LS depth, ignore patterns, default-ignored folders, empty folders", async () => {
  const s = setup({ "src/a.js": "x", "src/lib/b.js": "y", "src/x.log": "z", "node_modules/pkg/i.js": "n" });
  fs.mkdirSync(s.abs("empty"));
  try {
    const deep = await s.call("LS", { depth: 2 });
    assert.match(deep.content, /\nsrc\/\n  lib\/ \(1 items\)\n  a\.js/);
    assert.match(deep.content, /node_modules\/ \(1 items\) \(not opened\)/);
    assert.ok(!deep.content.includes("pkg"));
    const ignored = await s.call("LS", { path: "src", ignore: ["*.log", "lib"] });
    assert.ok(!ignored.content.includes("x.log") && !ignored.content.includes("lib"));
    assert.ok(ignored.content.includes("a.js"));
    const empty = await s.call("LS", { path: "empty" });
    assert.match(empty.content, /\(empty\)/);
    assert.equal(empty.display.summary, "Empty folder");
  } finally { s.cleanup(); }
});

test("LS shows Arabic names, failures, and clips huge folders", async () => {
  const files = { "مجلد/ملف.txt": "م" };
  for (let i = 0; i < 320; i++) files[`big/f${i}.txt`] = "";
  const s = setup(files);
  try {
    assert.ok((await s.call("LS", { path: "مجلد" })).content.includes("ملف.txt  2 B"));
    assert.match((await s.call("LS", { path: "missing" })).content, /does not exist/);
    assert.match((await s.call("LS", { path: "big/f1.txt" })).content, /is a file/);
    const big = await s.call("LS", { path: "big" });
    assert.match(big.content, /list shortened/);
    assert.match(big.content, /\.\.\. 20 more/);
    const ls = s.toolbox.byName.get("LS");
    assert.equal(ls.permission({ path: path.dirname(s.dir) }, s.ctx).decision, "ask");
    assert.equal(ls.permission({}, s.ctx).decision, "allow");
    assert.equal(ls.validate({ ignore: "x" }, s.ctx), "ignore must be an array of glob strings.");
  } finally { s.cleanup(); }
});
