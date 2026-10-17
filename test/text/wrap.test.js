import test from "node:test";
import assert from "node:assert/strict";
import { wrapLogical, stringWidth, stripAnsi, setArabicMode } from "../../src/text/display.js";
import { analyze, wrapWidths } from "../../src/text/wrap.js";

setArabicMode("on");

const widthOk = (lines, w) => lines.every(l => stringWidth(l) <= w);

test("breaks at spaces and never exceeds the width", () => {
  assert.deepEqual(wrapLogical("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
  assert.deepEqual(wrapLogical("exactly ten", 11), ["exactly ten"]);
  assert.deepEqual(wrapLogical("exactly ten", 10), ["exactly", "ten"]);
  assert.deepEqual(wrapLogical("", 10), [""]);
});

test("spaces at a break disappear, spaces inside a line and leading indentation stay", () => {
  assert.deepEqual(wrapLogical("aaa   bbb", 5), ["aaa", "bbb"]);
  assert.deepEqual(wrapLogical("a  b", 10), ["a  b"]);
  assert.deepEqual(wrapLogical("  indented text", 20), ["  indented text"]);
  assert.deepEqual(wrapLogical("trailing   ", 20), ["trailing"]);
});

test("a token wider than the line is hard-broken", () => {
  assert.deepEqual(wrapLogical("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  const url = "https://example.com/a/very/long/path/that/never/ends";
  const lines = wrapLogical(`see ${url} now`, 20);
  assert.equal(lines[0], "see");
  assert.equal(lines.slice(1, -1).concat(lines.at(-1)).join("").replace(/ now$/, ""), url);
  assert.ok(widthOk(lines, 20));
});

test("hard breaks never split surrogate pairs, emoji sequences, marks or lam-alef", () => {
  assert.deepEqual(wrapLogical("😀😀😀😀😀", 4), ["😀😀", "😀😀", "😀"]);
  assert.deepEqual(wrapLogical("e\u0301e\u0301e\u0301e\u0301e\u0301", 2), ["e\u0301e\u0301", "e\u0301e\u0301", "e\u0301"]);
  const family = "👨\u200d👩\u200d👧\u200d👦";
  assert.deepEqual(wrapLogical(family.repeat(3), 4), [family + family, family]);
  const lam = wrapLogical("لالالالالا", 3); // five lam-alef cells
  assert.deepEqual(lam, ["لالالا", "لالا"]);
  assert.equal(lam.join(""), "لالالالالا");
  const marked = wrapLogical("لَالَالَالَا", 2);
  assert.deepEqual(marked, ["لَالَا", "لَالَا"]);
});

test("Arabic is measured by what will be drawn", () => {
  // 'لا' is one cell: ten of them fit in a 10-column line
  assert.deepEqual(wrapLogical("لالالالالالالالالالا", 10), ["لالالالالالالالالالا"]);
  // 4 words of 5 letters: two fit in 11 columns
  assert.deepEqual(wrapLogical("مرحبا مرحبا مرحبا مرحبا", 11), ["مرحبا مرحبا", "مرحبا مرحبا"]);
});

test("CJK wraps between characters and respects line-start punctuation", () => {
  assert.deepEqual(wrapLogical("日本語のテキストです", 8), ["日本語の", "テキスト", "です"]);
  const lines = wrapLogical("これは、テスト文章です。", 8);
  assert.ok(lines.every(l => !/^[、。]/.test(l)), JSON.stringify(lines));
  assert.equal(lines.join(""), "これは、テスト文章です。");
  assert.deepEqual(wrapLogical("日本語abc日本語", 6), ["日本語", "abc日", "本語"]);
});

test("a wide character is placed even when it can never fit", () => {
  assert.deepEqual(wrapLogical("日本", 1), ["日", "本"]);
  assert.deepEqual(wrapLogical("abc", 0), ["a", "b", "c"]);
});

test("firstIndent and indent count toward the width", () => {
  assert.deepEqual(wrapLogical("one two three four", 12, { firstIndent: "- ", indent: "  " }), ["- one two", "  three four"]);
  assert.deepEqual(wrapLogical("  indented text that wraps around the edge", 16, { indent: "    " }),
    ["  indented text", "    that wraps", "    around the", "    edge"]);
  const lines = wrapLogical("a b c d e f g h", 7, { firstIndent: "1. ", indent: "   " });
  assert.ok(widthOk(lines, 7));
  assert.ok(lines[0].startsWith("1. ") && lines.slice(1).every(l => l.startsWith("   ")));
});

test("indents may carry ANSI codes", () => {
  const lines = wrapLogical("one two three four", 12, { firstIndent: "\x1b[2m-\x1b[22m ", indent: "  " });
  assert.equal(lines[0], "\x1b[2m-\x1b[22m one two");
  assert.equal(lines[1], "  three four");
});

test("embedded newlines are hard breaks and the next segment uses the plain indent", () => {
  assert.deepEqual(wrapLogical("a b\nc d", 10, { firstIndent: "* ", indent: "  " }), ["* a b", "  c d"]);
  assert.deepEqual(wrapLogical("a\n\nb", 10), ["a", "", "b"]);
  assert.deepEqual(wrapLogical("a\r\nb", 10), ["a", "b"]);
});

test("a non-finite width means no wrapping", () => {
  const long = "word ".repeat(50).trim();
  assert.deepEqual(wrapLogical(long, Infinity), [long]);
});

test("styles are re-opened on every line and closed at its end", () => {
  const lines = wrapLogical("hello \x1b[31mworld foo bar\x1b[39m baz", 12);
  assert.deepEqual(lines, ["hello \x1b[31mworld\x1b[39m", "\x1b[31mfoo bar\x1b[39m baz"]);
  const bold = wrapLogical("\x1b[1m\x1b[4mone two three\x1b[24m\x1b[22m", 7);
  assert.deepEqual(bold, ["\x1b[1;4mone two\x1b[22;24m", "\x1b[1;4mthree\x1b[22;24m"]);
  for (const l of [...lines, ...bold]) assert.ok(stringWidth(l) <= 12);
  assert.equal(stripAnsi(lines.join(" ")), "hello world foo bar baz");
});

test("an open style at the end of the text is closed", () => {
  assert.deepEqual(wrapLogical("\x1b[32mgreen forever", 8), ["\x1b[32mgreen\x1b[39m", "\x1b[32mforever\x1b[39m"]);
});

test("hyperlinks survive wrapping", () => {
  const open = "\x1b]8;;https://x.example/\x07", close = "\x1b]8;;\x07";
  const lines = wrapLogical(`go ${open}the docs page${close} now`, 9);
  assert.equal(lines.length, 3);
  assert.equal(lines[1], `${open}docs page\x1b]8;;\x1b\\`);
  assert.equal(stripAnsi(lines.join(" ")), "go the docs page now");
});

test("wrapping returns the original characters, never shaped forms", () => {
  const text = "ولا بأس بلا شك في ذلك الأمر أبدا";
  const lines = wrapLogical(text, 12);
  assert.equal(lines.join(" "), text);
  assert.ok(lines.every(l => !/[\ufb50-\ufdff\ufe70-\ufeff]/.test(l)));
});

test("analyze: cells carry width, style and the logical range they came from", () => {
  const m = analyze("a\x1b[31mلاb\u0301\x1b[39m日");
  assert.equal(m.src, "aلاb\u0301日");
  assert.deepEqual(m.cells.map(c => [c.w, c.lo, c.hi]), [[1, 0, 1], [1, 1, 3], [1, 3, 5], [2, 5, 6]]);
  assert.deepEqual(m.cells.map(c => m.styles[c.st].fg), ["", "31", "31", ""]);
  assert.equal(m.cells[1].s, "\ufefb");
});

test("analyze: cell ranges tile the text exactly", () => {
  const text = "ملف\u200c src لَا 😀 e\u0301 كِتَابٌ\u200d";
  const m = analyze(text);
  let at = 0;
  for (const c of m.cells) { assert.equal(c.lo, at); assert.ok(c.hi >= c.lo); at = c.hi; }
  assert.equal(at, text.length);
});

test("the ASCII fast path and the general path agree", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = ["a", "bb", "ccc", "dddd", " ", " ", "  ", "-", "/", "x".repeat(15)];
  for (let n = 0; n < 300; n++) {
    let s = "";
    const parts = 1 + Math.floor(rnd() * 14);
    for (let i = 0; i < parts; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const w = 1 + Math.floor(rnd() * 20);
    const fast = wrapLogical(s, w, { firstIndent: "> ", indent: "  " });
    const slow = wrapLogical(s + "\x1b[0m", w, { firstIndent: "> ", indent: "  " }).map(stripAnsi);
    assert.deepEqual(fast, slow, JSON.stringify([s, w]));
  }
});

test("wrapWidths keeps trailing spaces on request (input editor)", () => {
  const widths = new Uint8Array([1, 1, 1, 1, 1]);
  const kinds = new Uint8Array([0, 0, 1, 1, 1]);
  assert.deepEqual(wrapWidths(widths, kinds, 5, 10, 10, false), [{ a: 0, b: 2, e: 5, w: 2 }]);
  assert.deepEqual(wrapWidths(widths, kinds, 5, 10, 10, true), [{ a: 0, b: 5, e: 5, w: 5 }]);
  assert.deepEqual(wrapWidths(widths, kinds, 5, 3, 3, true), [{ a: 0, b: 3, e: 5, w: 3 }]);
});

test("every wrapped line fits and nothing is lost, on mixed text", () => {
  const text = "قم بتشغيل `npm test` ثم ارجع إلى الملف src/app.js الذي يحتوي 3 دوال (جيدة) 日本語のテキスト 😀 e\u0301";
  for (const w of [5, 8, 13, 21, 40]) {
    const lines = wrapLogical(text, w);
    assert.ok(widthOk(lines, w) || w < 3, `width ${w}`);
    assert.equal(lines.join("").replace(/ /g, ""), text.replace(/ /g, ""), `width ${w}`);
  }
});

// A direction isolate cut by a line break is closed at the end of its row and opened again on the next, like a style.
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

test("an isolate cut by a break is closed on one row and re-opened on the next", () => {
  const rows = wrapLogical(`aa ${LRI}bb cc dd${PDI} ee`, 5);
  assert.deepEqual(rows, [`aa ${LRI}bb${PDI}`, `${LRI}cc dd${PDI}`, "ee"]);
  for (const row of rows) {
    let depth = 0;
    for (const ch of row) { if (ch === LRI) depth++; else if (ch === PDI) depth--; assert.ok(depth >= 0, JSON.stringify(row)); }
    assert.equal(depth, 0, "balanced on every row: " + JSON.stringify(row));
  }
  assert.equal(rows.join(" ").replace(new RegExp(`[${LRI}${PDI}]`, "g"), "").replace(/\s+/g, " "), "aa bb cc dd ee");
});

test("isolates add no width and an isolate inside indentation stays outside the indent", () => {
  assert.equal(stringWidth(`${LRI}abc${PDI}`), 3);
  const rows = wrapLogical(`${LRI}one two three${PDI}`, 7, { firstIndent: "- ", indent: "  " });
  assert.ok(rows[0].startsWith("- ") && rows[1].startsWith("  " + LRI), JSON.stringify(rows));
});
