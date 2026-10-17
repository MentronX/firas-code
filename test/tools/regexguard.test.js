// The pure-JS fallback of Grep runs the model's regular expression on this thread. These tests pin the guard against
// patterns that would freeze the program (see src/tools/regexguard.js and the fallback in grep.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";
import { checkPattern, needsGuard, PATTERN_MAX } from "../../src/tools/regexguard.js";

const fallback = { env: { ...process.env, FIRAS_NO_RG: "1" } };

// ------------------------------------------------------------------------------------------- the shape check

const CATASTROPHIC = [
  "(a+)+$", "(.*)*", "(a*)*", "(.+)+", "(a|a)*", "(a|ab)+", "(foo|food)*", "(\\w|\\d)+", "(.|\\s)*", "(\\w+\\s?)*", "(\\w+\\s*)+", "(\\s*\\w+)*",
  "(x+x+)+y", "^(([a-z])+.)+[A-Z]([a-z])+$", "(a+){2,}", "((ab)+)+", "(a?)*", "(a|)+", "(?:[a-z]+)+", "([a-zA-Z]+)*", "(\\d+|\\w+)*", "(a+b?)+",
  "(\\r?\\n\\s*)*", "(\\s*,\\s*\\S+)*", "(.*a){25}",
];

const FINE = [
  "foo", "\\bfoo\\w+", "^\\s*import .* from ['\"].*['\"]", "(foo|bar)+", "(\\w+\\.)+\\w+", "(\\d+,)*\\d+", "function\\s+(\\w+)\\s*\\(", "(?:https?|ftp)://[^\\s]+",
  "TODO|FIXME", "[A-Z][a-z]+$", "(a|b|c)*", "(\\.js|\\.ts)+", "([a-z]+-)*[a-z]+", "\\((?:[^()]|\\([^()]*\\))*\\)", "([^\"\\\\]|\\\\.)*",
  "^(?:(?!foo).)*$", "(\\s|\\S)+", "(.|\\n)+", "<(\\w+)[^>]*>", "(\\d{1,3}\\.){3}\\d{1,3}", "a.*b.*c", "(ab)+", "(foo)", "(?<name>\\w+)=\\k<name>",
  "(\\d+)(,\\d+)*", "\\$\\{\\w+\\}", "\\.(js|ts|jsx|tsx)$", "(?:^|\\s)@\\w+", "import\\s+\\{[^}]*\\}\\s+from", "TODO(\\(.*\\))?:", "(a|b)+c", "[(]x[)]",
  "(  )+", "(?:\\r?\\n)+", "\\w+\\s*=\\s*\\w+", "^\\s*(export\\s+)?(async\\s+)?function\\s+\\w+", "(a{2}){3}", "(a+){2}", "x*", "[a-z]+@[a-z]+\\.[a-z]{2,}",
  "(\\w+)\\s+\\1", "(?<=\\$)\\d+(?:\\.\\d+)?", "\\u00e9+", "(مرحبا|أهلا)+", "\\p{L}+",
];

test("checkPattern refuses the shapes that are catastrophic by construction", () => {
  const missed = CATASTROPHIC.filter(p => !checkPattern(p));
  assert.deepEqual(missed, []);
});

test("checkPattern lets ordinary patterns through, including look-alikes that are safe", () => {
  const refused = FINE.filter(p => checkPattern(p)).map(p => `${p}  ->  ${checkPattern(p)}`);
  assert.deepEqual(refused, []);
});

test("checkPattern says what is wrong and never throws on odd input", () => {
  assert.match(checkPattern("(a+)+$"), /repetition inside a repeated group/);
  assert.match(checkPattern("(a|ab)+"), /alternatives that can match the same text/);
  assert.match(checkPattern("(a*)*"), /can match nothing/);
  for (const odd of ["(", ")", "[", "(?", "\\", "a{", "*a", "(?<n", "(?<=", "[a-", "(((", "a||b", "()", "(|)", "(?:)*", "\\u{", "\\p{L"]) {
    assert.doesNotThrow(() => checkPattern(odd), odd);
    assert.doesNotThrow(() => needsGuard(odd), odd);
  }
  assert.equal(checkPattern("(A+)+", { ignoreCase: true }) !== null, true);
  assert.equal(checkPattern("(a|A)+", { ignoreCase: true }) !== null, true, "overlap is judged with the case flag");
  assert.equal(checkPattern("(a|A)+", { ignoreCase: false }), null);
});

test("needsGuard: repeated groups and back-references always, three open-ended repeats only for long lines", () => {
  assert.equal(needsGuard("foo"), false);
  assert.equal(needsGuard("\\bfoo\\w+"), false);
  assert.equal(needsGuard("\\w+\\s*="), false);
  assert.equal(needsGuard("(foo|bar)+"), "always");
  assert.equal(needsGuard("(\\w+)\\s+\\1"), "always");
  assert.equal(needsGuard("(ab){2,5}"), "always");
  assert.equal(needsGuard("a.*b.*c.*d"), "long");
  assert.equal(needsGuard("\\w+\\s*=\\s*\\w+"), "long");
  assert.equal(needsGuard("(oops"), "always", "what cannot be analysed is guarded");
});

// ------------------------------------------------------------------------------------------- through Grep

const BAD_LINE = `${"a".repeat(60)}!\n`;

test("Grep (fallback): a classic catastrophic pattern is refused at once, with advice, and nothing is searched", async () => {
  const s = setup({ "f.txt": BAD_LINE, "g.txt": "aaa\n" }, { ctx: fallback });
  try {
    for (const pattern of ["(a+)+$", "(.*)*x", "(a|aa)+$", "^(\\w+\\s?)*$", "(x+x+)+y"]) {
      const started = Date.now();
      const r = await s.call("Grep", { pattern });
      assert.ok(Date.now() - started < 2000, `${pattern} took ${Date.now() - started} ms`);
      assert.equal(r.ok, false, pattern);
      assert.match(r.content, /can take exponential time/);
      assert.match(r.content, /Rewrite it/);
      assert.equal(r.display.summary, "Invalid search pattern");
    }
    assert.equal((await s.call("Grep", { pattern: "(a+)+$", multiline: true })).ok, false, "also in multiline mode");
    assert.equal((await s.call("Grep", { pattern: "(a+)+$", path: "f.txt", output_mode: "content" })).ok, false, "also for one file");
  } finally { s.cleanup(); }
});

test("Grep (fallback): ordinary patterns behave exactly as before", async () => {
  const s = setup({
    "a.js": "import fs from 'fs';\nfunction go(x) { return x; }\nconst v = foo.bar.baz;\n",
    "b.txt": "id: 1,2,3\nfoo bar foo\n",
  }, { ctx: fallback });
  try {
    const lines = r => r.content.split("\n");
    assert.deepEqual(lines(await s.call("Grep", { pattern: "(\\w+\\.)+\\w+", output_mode: "content" })), ["a.js:3:const v = foo.bar.baz;"]);
    assert.deepEqual(lines(await s.call("Grep", { pattern: "(foo|bar)+", output_mode: "count" })), ["a.js:1", "b.txt:1"]);
    assert.deepEqual(lines(await s.call("Grep", { pattern: "(\\d+,)*\\d+$", output_mode: "content" })), ["b.txt:1:id: 1,2,3"]);
    assert.deepEqual(lines(await s.call("Grep", { pattern: "^function\\s+\\w+\\(", output_mode: "content" })), ["a.js:2:function go(x) { return x; }"]);
    assert.deepEqual(lines(await s.call("Grep", { pattern: "(foo) bar \\1", output_mode: "content" })), ["b.txt:2:foo bar foo"]);
  } finally { s.cleanup(); }
});

test("Grep (fallback): a pattern that gets past the shape check still cannot freeze the search", async () => {
  // Five open-ended repeats on a 4000-character line: polynomial, but far too slow. It is not a refused shape, so the
  // hard time limit is what stops it.
  const long = "a".repeat(3900);
  const s = setup({ "one.txt": `${long}\n`, "two.txt": "short\n" }, { ctx: fallback });
  try {
    const started = Date.now();
    const r = await s.call("Grep", { pattern: ".*.*.*.*.*=", output_mode: "content" });
    const took = Date.now() - started;
    assert.ok(took < 9000, `took ${took} ms`);
    assert.equal(r.ok, true);
    assert.match(r.content, /^No matches/);
    assert.match(r.content, /The pattern was too slow on 1 file, which was skipped/);
    assert.match(r.content, /simpler pattern/);
  } finally { s.cleanup(); }
});

test("Grep (fallback): a multiline pattern with three open-ended repeats over a big file stops at the limit too", async () => {
  const s = setup({ "big.txt": `${"line of text\n".repeat(12_000)}` }, { ctx: fallback });
  try {
    const started = Date.now();
    const r = await s.call("Grep", { pattern: "[\\s\\S]*[\\s\\S]*[\\s\\S]*ZZZ", multiline: true });
    assert.ok(Date.now() - started < 9000);
    assert.equal(r.ok, true);
    assert.match(r.content, /too slow/);
  } finally { s.cleanup(); }
});

test("Grep (fallback): only the first 4000 characters of a line are searched, and the person is told", async () => {
  const s = setup({
    "wide.txt": `${"x".repeat(5000)}needle-late\nshort line with needle-early\n${"y".repeat(100)} needle-near-start ${"z".repeat(5000)}\n`,
  }, { ctx: fallback });
  try {
    const r = await s.call("Grep", { pattern: "needle-late", output_mode: "content" });
    assert.match(r.content, /^No matches/, "past the cut: not seen");
    assert.match(r.content, /\[2 lines were longer than 4000 characters and only the first 4000 characters of each were searched\.\]/);
    const early = await s.call("Grep", { pattern: "needle-(early|near-start)", output_mode: "count" });
    assert.match(early.content, /^wide\.txt:2\n/);
    assert.match(early.content, /2 lines were longer than 4000 characters/);
    const normal = await s.call("Grep", { pattern: "early", path: "wide.txt", output_mode: "content" });
    assert.match(normal.content, /wide\.txt:2:short line with needle-early/);
  } finally { s.cleanup(); }
});

test("Grep: a pattern longer than the limit is refused by validation, one at the limit is accepted", () => {
  const s = setup({ "a.txt": "x" });
  try {
    const grep = s.toolbox.byName.get("Grep");
    assert.equal(grep.validate({ pattern: "a".repeat(PATTERN_MAX) }, s.ctx), null);
    assert.match(grep.validate({ pattern: "a".repeat(PATTERN_MAX + 1) }, s.ctx), /too long.*limit is 1000/);
  } finally { s.cleanup(); }
});
