import test from "node:test";
import assert from "node:assert/strict";
import {
  setArabicMode, arabicActive, hasRtl, baseDirection, stripAnsi, stringWidth, wrapLogical, toVisual, shapeLine,
  layoutParagraph, layoutInput, moveCursorVisual, visualToLogicalMap,
} from "../../src/text/display.js";
import { shapeArabic as sh } from "../../src/text/arabic.js";

setArabicMode("on");

// A visual line is the shaped logical line read back to front, one run at a time.
const rev = s => [...s].reverse().join("");
const V = (...parts) => parts.join("");
const hex = s => [...s].map(c => c.codePointAt(0).toString(16)).join(" ");

test("the mode switch", () => {
  assert.equal(arabicActive(), true);
  setArabicMode("off");
  assert.equal(arabicActive(), false);
  setArabicMode("auto");
  const saved = process.env.FIRAS_ARABIC;
  try {
    delete process.env.FIRAS_ARABIC;
    assert.equal(arabicActive(), true);
    process.env.FIRAS_ARABIC = "off";
    assert.equal(arabicActive(), false);
    process.env.FIRAS_ARABIC = "0";
    assert.equal(arabicActive(), false);
    process.env.FIRAS_ARABIC = "on";
    assert.equal(arabicActive(), true);
  } finally {
    if (saved === undefined) delete process.env.FIRAS_ARABIC; else process.env.FIRAS_ARABIC = saved;
    setArabicMode("on");
  }
  setArabicMode("bogus");
  assert.equal(arabicActive(), true); // unknown values mean auto
  setArabicMode("on");
});

test("hasRtl and baseDirection", () => {
  assert.equal(hasRtl("abc"), false);
  assert.equal(hasRtl("مرحبا"), true);
  assert.equal(hasRtl("שלום"), true);
  assert.equal(hasRtl("ܐܒܓ"), true); // Syriac
  assert.equal(hasRtl("123 ..."), false);
  assert.equal(hasRtl("\x1b[31mabc\x1b[0m"), false);
  assert.equal(hasRtl("\x1b[31mمرحبا\x1b[0m"), true);
  assert.equal(hasRtl(""), false);
  assert.equal(baseDirection("hello مرحبا"), "ltr");
  assert.equal(baseDirection("123 مرحبا"), "rtl");
  assert.equal(baseDirection("\x1b[31mمرحبا"), "rtl");
  assert.equal(baseDirection(""), "ltr");
  assert.equal(baseDirection("123"), "ltr");
  assert.equal(baseDirection("\u2067مرحبا\u2069 abc"), "ltr");
  assert.equal(stripAnsi("\x1b[1mx\x1b[0m"), "x");
});

test("lines without RTL letters come back byte-identical", () => {
  const samples = ["", "plain ascii line", "  leading", "\x1b[1mbold\x1b[0m text", "日本語 and 😀", "tab\tchar", "a\u200eb",
    "\x1b[31mred", "https://example.com/path?q=1&r=2", "(a) [b] {c} <d>", "\x1b]8;;http://x\x07link\x1b]8;;\x07"];
  for (const s of samples) assert.equal(toVisual(s), s);
  for (const s of samples) assert.equal(toVisual(s, { dir: "ltr", width: 80, align: "end" }), s);
});

test("sample strings come out in visual order", () => {
  assert.equal(toVisual("قم بتشغيل npm test ثم ارجع"),
    V(rev(sh("ارجع")), " ", rev(sh("ثم")), " npm test ", rev(sh("بتشغيل")), " ", rev(sh("قم"))));
  assert.equal(toVisual("ملف src/app.js يحتوي 3 دوال (جيدة)"),
    V("(", rev(sh("جيدة")), ") ", rev(sh("دوال")), " 3 ", rev(sh("يحتوي")), " src/app.js ", rev(sh("ملف"))));
  assert.equal(toVisual("التكلفة: 25 دولار (≈ 37,500 دينار)"),
    V("(", rev(sh("دينار")), " 37,500 ≈) ", rev(sh("دولار")), " 25 :", rev(sh("التكلفة"))));
  assert.equal(toVisual("(مرحبا) [test] {x}"), V("{x} [test] (", rev(sh("مرحبا")), ")"));
});

test("brackets and quotation marks mirror in right-to-left runs", () => {
  assert.equal(toVisual("(مرحبا)"), V("(", rev(sh("مرحبا")), ")"));
  assert.equal(toVisual("[مرحبا]"), V("[", rev(sh("مرحبا")), "]"));
  assert.equal(toVisual("{مرحبا}"), V("{", rev(sh("مرحبا")), "}"));
  assert.equal(toVisual("«مرحبا»"), V("«", rev(sh("مرحبا")), "»"));
  assert.equal(toVisual("<مرحبا>"), V("<", rev(sh("مرحبا")), ">"));
  // English inside brackets stays readable in an RTL paragraph
  assert.equal(toVisual("مرحبا (test)"), V("(test) ", rev(sh("مرحبا"))));
  assert.equal(toVisual("(test) مرحبا", { dir: "rtl" }), V(rev(sh("مرحبا")), " (test)"));
});

test("numbers keep their reading order inside right-to-left text", () => {
  assert.equal(toVisual("الإصدار 2.0.0 من Firas"), V("Firas ", rev(sh("من")), " 2.0.0 ", rev(sh("الإصدار"))));
  assert.equal(toVisual("٣ ملفات"), V(rev(sh("ملفات")), " ٣"));
  assert.equal(toVisual("السعر 50% أقل"), V(rev(sh("أقل")), " %50 ", rev(sh("السعر")))); // the percent sign lands left of the digits
  assert.equal(toVisual("-5 والعدد"), V(rev(sh("والعدد")), " 5-")); // read right to left it is still "-5"
});

test("Latin and CJK around Arabic in a left-to-right line", () => {
  assert.equal(toVisual("The word مرحبا means hello"), V("The word ", rev(sh("مرحبا")), " means hello"));
  assert.equal(toVisual("日本語 مرحبا abc"), V("日本語 ", rev(sh("مرحبا")), " abc"));
  assert.equal(toVisual("مرحبا بك", { dir: "ltr" }), rev(sh("مرحبا بك")));
});

test("marks stay after their base letter after reordering", () => {
  // Visual order of clusters is reversed, but each cluster is still base then marks.
  assert.equal(hex(toVisual("كِتَابٌ")), "fe8f 64c fe8e fe98 64e fedb 650");
  assert.equal(hex(toVisual("لَا")), "fefb 64e");
  assert.equal(hex(toVisual("اللَّه")), "feea fee0 64e 651 fedf fe8d");
});

test("direction marks, isolates and joiners are not left in the visual line", () => {
  assert.equal(toVisual("\u200fمرحبا"), rev(sh("مرحبا")));
  assert.equal(toVisual("مرحبا\u200e"), rev(sh("مرحبا")));
  assert.equal(toVisual("a \u2067مرحبا\u2069 b"), V("a ", rev(sh("مرحبا")), " b"));
  assert.ok(!toVisual("می\u200cخواهم").includes("\u200c"));
});

test("ANSI styling travels with its characters", () => {
  const red = s => `\x1b[31m${s}\x1b[39m`;
  const bold = s => `\x1b[1m${s}\x1b[22m`;
  assert.equal(toVisual(`قم ${red("بتشغيل")} npm`), V("npm ", red(rev(sh("بتشغيل"))), " ", rev(sh("قم"))));
  assert.equal(toVisual(bold("مرحبا بك")), bold(rev(sh("مرحبا بك"))));
  // an unclosed style at the end of the logical line is still open at the end of the visual one
  assert.equal(toVisual("\x1b[31mمرحبا"), V("\x1b[31m", rev(sh("مرحبا"))));
  assert.equal(toVisual("\x1b[31mمرحبا\x1b[0m hello"), V("hello ", red(rev(sh("مرحبا")))));
  // two attributes at once, and a background
  assert.equal(toVisual("\x1b[41m\x1b[37mمرحبا بك\x1b[0m"), V("\x1b[37;41m", rev(sh("مرحبا بك")), "\x1b[39;49m"));
  // a style change inside a word keeps the word joined
  assert.equal(toVisual("كت\x1b[1mا\x1b[22mب"), "\ufe8f\x1b[1m\ufe8e\x1b[22m\ufe98\ufedb");
});

test("hyperlinks survive reordering", () => {
  const open = "\x1b]8;;https://x.example/\x07", close = "\x1b]8;;\x07";
  const out = toVisual(`اقرأ ${open}الوثائق${close} الآن`);
  assert.equal(stripAnsi(out), V(rev(sh("الآن")), " ", rev(sh("الوثائق")), " ", rev(sh("اقرأ"))));
  assert.ok(out.includes(open) && out.includes("\x1b]8;;\x1b\\"));
  assert.ok(out.indexOf(open) < out.indexOf(rev(sh("الوثائق"))));
});

test("dir and align", () => {
  assert.equal(toVisual("مرحبا", { dir: "rtl", width: 10, align: "end" }), V("     ", rev(sh("مرحبا"))));
  assert.equal(toVisual("مرحبا", { dir: "rtl", width: 10 }), rev(sh("مرحبا")));
  assert.equal(toVisual("مرحبا", { dir: "rtl", width: 10, align: "start" }), rev(sh("مرحبا")));
  assert.equal(toVisual("مرحبا", { width: 3, align: "end" }), rev(sh("مرحبا"))); // never truncates
  assert.equal(toVisual("abc", { dir: "rtl", width: 8, align: "end" }), "     abc"); // explicitly asked
  assert.equal(toVisual("abc", { width: 8, align: "end" }), "abc"); // not asked
  assert.equal(toVisual("مرحبا abc", { dir: "ltr" }), V(rev(sh("مرحبا")), " abc"));
  assert.equal(toVisual("abc مرحبا", { dir: "rtl" }), V(rev(sh("مرحبا")), " abc"));
});

test("a trailing carriage return stays at the end", () => {
  assert.equal(toVisual("مرحبا\r"), V(rev(sh("مرحبا")), "\r"));
});

test("with Arabic switched off nothing is touched", () => {
  setArabicMode("off");
  try {
    const s = "قم بتشغيل npm test";
    assert.equal(toVisual(s), s);
    assert.equal(toVisual(s, { dir: "rtl", width: 40, align: "end" }), " ".repeat(40 - stringWidth(s)) + s);
    assert.deepEqual(layoutParagraph(s, 10), wrapLogical(s, 10));
    assert.equal(shapeLine(s), s);
    assert.equal(stringWidth("لا"), 2);
    assert.deepEqual(visualToLogicalMap("مرحبا"), [0, 1, 2, 3, 4]);
    assert.deepEqual(layoutInput("مرحبا", 5, { width: 20, prefix: "> " }), { lines: ["> مرحبا"], cursor: { row: 0, col: 7 } });
  } finally {
    setArabicMode("on");
  }
});

test("shapeLine shapes but never reorders", () => {
  assert.equal(shapeLine("مرحبا abc"), V(sh("مرحبا"), " abc"));
  assert.equal(shapeLine("plain"), "plain");
  assert.equal(shapeLine("\x1b[1mمرحبا\x1b[22m"), V("\x1b[1m", sh("مرحبا"), "\x1b[22m"));
});

test("visualToLogicalMap", () => {
  assert.deepEqual(visualToLogicalMap("مرحبا"), [4, 3, 2, 1, 0]);
  assert.deepEqual(visualToLogicalMap("ab مرحبا"), [0, 1, 2, 7, 6, 5, 4, 3]);
  assert.deepEqual(visualToLogicalMap("لا ab"), [3, 4, 2, 0]); // the ligature is one visual cell for two letters
  assert.deepEqual(visualToLogicalMap("plain"), [0, 1, 2, 3, 4]);
  assert.deepEqual(visualToLogicalMap("\x1b[31mمرحبا\x1b[0m"), [4, 3, 2, 1, 0]);
  assert.deepEqual(visualToLogicalMap("😀 مرحبا"), [7, 6, 5, 4, 3, 2, 0, 0]); // an Arabic-first line is RTL; both units of the emoji map to it
  assert.deepEqual(visualToLogicalMap("كِتَاب"), [5, 4, 2, 3, 0, 1]); // marks follow their base
});

test("layoutParagraph: Arabic paragraphs are right-aligned, English ones left-aligned", () => {
  const text = "هذا نص عربي طويل جدا يحتاج إلى التفاف على عدة أسطر لنرى كيف يعمل";
  const ar = layoutParagraph(text, 30);
  assert.ok(ar.length >= 3);
  for (const l of ar) assert.equal(stringWidth(l), 30, JSON.stringify(l)); // padded on the left up to the full width
  assert.deepEqual(ar, wrapLogical(text, 30).map(l => toVisual(l, { dir: "rtl", width: 30, align: "end" })));
  const en = layoutParagraph("The quick brown fox jumps over the lazy dog again and again", 20);
  assert.deepEqual(en, ["The quick brown fox", "jumps over the lazy", "dog again and again"]);
});

test("layoutParagraph: direction of auto paragraphs", () => {
  // first strong letter decides
  assert.ok(layoutParagraph("مرحبا", 20)[0].startsWith(" "));
  assert.equal(layoutParagraph("hello مرحبا", 20)[0].startsWith(" "), false);
  // a Latin first word in mostly-Arabic text is still an RTL paragraph
  assert.ok(layoutParagraph("Git هو نظام للتحكم في الإصدارات", 40)[0].startsWith(" "));
  // one Arabic word in an English sentence is not
  assert.equal(layoutParagraph("This is an English sentence with مرحبا inside", 60)[0].startsWith(" "), false);
  // explicit direction
  assert.deepEqual(layoutParagraph("hello", 10, { dir: "rtl" }), ["     hello"]);
  assert.deepEqual(layoutParagraph("مرحبا", 10, { dir: "ltr" }), [rev(sh("مرحبا"))]);
  assert.deepEqual(layoutParagraph("مرحبا", 10, { align: "start" }), [rev(sh("مرحبا"))]);
  assert.deepEqual(layoutParagraph("مرحبا", 11, { align: "center" }), [V("   ", rev(sh("مرحبا")))]);
});

test("layoutParagraph: bullets and indents go on the right of RTL text", () => {
  const lines = layoutParagraph("عنصر أول طويل جدا يحتاج التفاف على سطرين على الأقل", 24, { firstIndent: "• ", indent: "  " });
  assert.ok(lines.length >= 2);
  assert.ok(lines[0].endsWith("•"), JSON.stringify(lines[0]));
  for (const l of lines.slice(1)) assert.ok(l.endsWith("  "), JSON.stringify(l));
  for (const l of lines) assert.equal(stringWidth(l), 24);
  const en = layoutParagraph("first item that wraps around", 16, { firstIndent: "• ", indent: "  " });
  assert.deepEqual(en, ["• first item", "  that wraps", "  around"]);
});

test("layoutParagraph: blank lines and several paragraphs", () => {
  assert.deepEqual(layoutParagraph("", 10), [""]);
  assert.deepEqual(layoutParagraph("a\n\nب", 10), ["a", "", V(" ".repeat(9), sh("ب"))]);
  assert.deepEqual(layoutParagraph("one\ntwo", 10), ["one", "two"]);
});

test("layoutParagraph never emits a line wider than asked and keeps every word", () => {
  const text = "قم بتشغيل `npm test` ثم ارجع إلى الملف src/app.js الذي يحتوي 3 دوال (جيدة) والتكلفة: 25 دولار (≈ 37,500 دينار)";
  for (const w of [12, 20, 33, 60, 100]) {
    const lines = layoutParagraph(text, w);
    for (const l of lines) assert.ok(stringWidth(l) <= w, `${w}: ${JSON.stringify(l)}`);
    const count = s => [...s].filter(c => !/\s/.test(c)).length;
    assert.equal(lines.reduce((n, l) => n + count(l), 0), count(sh(text)), `width ${w}`);
  }
});

test("layoutInput: left-to-right text", () => {
  assert.deepEqual(layoutInput("hello", 5, { width: 20, prefix: "> " }), { lines: ["> hello"], cursor: { row: 0, col: 7 } });
  assert.deepEqual(layoutInput("hello", 0, { width: 20, prefix: "> " }).cursor, { row: 0, col: 2 });
  assert.deepEqual(layoutInput("hello", 3, { width: 20, prefix: "> " }).cursor, { row: 0, col: 5 });
  assert.deepEqual(layoutInput("", 0, { width: 20, prefix: "> " }), { lines: ["> "], cursor: { row: 0, col: 2 } });
  assert.deepEqual(layoutInput("hello", 99, { width: 20 }).cursor, { row: 0, col: 5 }); // clamped
  assert.deepEqual(layoutInput("hello", -4, { width: 20 }).cursor, { row: 0, col: 0 });
  assert.deepEqual(layoutInput("日本", 1, { width: 20, prefix: "> " }).cursor, { row: 0, col: 4 });
});

test("layoutInput: typing Arabic leaves the caret at the left edge of what was typed", () => {
  const word = "مرحبا";
  for (let k = 1; k <= word.length; k++) {
    const typed = word.slice(0, k);
    const r = layoutInput(typed, k, { width: 40, prefix: "> " });
    assert.deepEqual(r.lines, ["> " + rev(sh(typed))], typed);
    assert.deepEqual(r.cursor, { row: 0, col: 2 }, typed);
  }
});

test("layoutInput: caret positions inside right-to-left and mixed text", () => {
  // pure RTL: logical start is the right edge, logical end the left edge
  assert.deepEqual(layoutInput("مرحبا", 0, { width: 40, prefix: "> " }).cursor, { row: 0, col: 7 });
  assert.deepEqual(layoutInput("مرحبا", 2, { width: 40, prefix: "> " }).cursor, { row: 0, col: 5 });
  assert.deepEqual(layoutInput("مرحبا", 5, { width: 40, prefix: "> " }).cursor, { row: 0, col: 2 });
  // LTR line, Arabic typed at the end: caret at the left edge of the Arabic run
  assert.deepEqual(layoutInput("hello مرحبا", 11, { width: 40, prefix: "> " }), {
    lines: ["> " + V("hello ", rev(sh("مرحبا")))], cursor: { row: 0, col: 8 },
  });
  // a space typed after Arabic in an LTR line goes to the right end
  assert.deepEqual(layoutInput("hello مرحبا ", 12, { width: 40, prefix: "> " }).cursor, { row: 0, col: 2 + 6 + 5 + 1 });
  // the ligature is one cell; a caret inside it is drawn at its end
  assert.deepEqual(layoutInput("لا", 2, { width: 40 }).cursor, { row: 0, col: 0 });
  assert.deepEqual(layoutInput("لا", 1, { width: 40 }).cursor, { row: 0, col: 0 });
  assert.deepEqual(layoutInput("لا", 0, { width: 40 }).cursor, { row: 0, col: 1 });
});

test("layoutInput: wrapping, newlines and the full-row edge", () => {
  const long = "this is a fairly long line that must wrap around";
  assert.deepEqual(layoutInput(long, long.length, { width: 22, prefix: "> " }), {
    lines: ["> this is a fairly", "  long line that must", "  wrap around"], cursor: { row: 2, col: 13 },
  });
  assert.deepEqual(layoutInput("ab\ncd", 4, { width: 20, prefix: "> " }), { lines: ["> ab", "  cd"], cursor: { row: 1, col: 3 } });
  assert.deepEqual(layoutInput("ab\n", 3, { width: 20, prefix: "> " }), { lines: ["> ab", "  "], cursor: { row: 1, col: 2 } });
  // a caret that would sit past the right edge moves to a fresh row
  assert.deepEqual(layoutInput("abcdefghij", 10, { width: 12, prefix: "> " }), { lines: ["> abcdefghij", "  "], cursor: { row: 1, col: 2 } });
  // Arabic wraps the same way, each row ordered on its own
  const ar = "مرحبا بك في العالم";
  const r = layoutInput(ar, ar.length, { width: 11 });
  assert.deepEqual(r.lines, [rev(sh("مرحبا بك في")), rev(sh("العالم"))]);
  assert.deepEqual(r.cursor, { row: 1, col: 0 });
});

test("layoutInput: align puts rows against the right edge", () => {
  const end = layoutInput("مرحبا", 5, { width: 20, prefix: "> ", align: "end" });
  assert.equal(stringWidth(end.lines[0]), 20);
  assert.equal(end.cursor.col, 20 - 5);
  assert.equal(layoutInput("abc", 3, { width: 20, prefix: "> ", align: "end" }).lines[0], V("> ", " ".repeat(15), "abc"));
  // auto: only right-to-left rows move
  assert.equal(layoutInput("abc", 3, { width: 20, prefix: "> ", align: "auto" }).lines[0], "> abc");
  assert.equal(stringWidth(layoutInput("مرحبا", 5, { width: 20, prefix: "> ", align: "auto" }).lines[0]), 20);
});

test("layoutInput keeps a styled prefix intact", () => {
  const prefix = "\x1b[36m>\x1b[39m ";
  const r = layoutInput("مرحبا", 5, { width: 20, prefix });
  assert.equal(r.lines[0], prefix + rev(sh("مرحبا")));
  assert.equal(r.cursor.col, 2);
});

// follow a series of key presses and report every logical position visited
function walk(text, from, dir, o) {
  const seen = [from];
  let c = from;
  for (let i = 0; i < 60; i++) {
    const n = moveCursorVisual(text, c, dir, o);
    if (n === c) break;
    seen.push(n);
    c = n;
  }
  return seen;
}

test("moveCursorVisual: left-to-right text moves by one", () => {
  assert.equal(moveCursorVisual("abc", 1, "left"), 0);
  assert.equal(moveCursorVisual("abc", 1, "right"), 2);
  assert.equal(moveCursorVisual("abc", 0, "left"), 0);
  assert.equal(moveCursorVisual("abc", 3, "right"), 3);
  assert.deepEqual(walk("abc", 0, "right"), [0, 1, 2, 3]);
  assert.deepEqual(walk("abc", 3, "left"), [3, 2, 1, 0]);
});

test("moveCursorVisual: in Arabic, left means towards the end of the text", () => {
  assert.equal(moveCursorVisual("مرحبا", 0, "left"), 1);
  assert.equal(moveCursorVisual("مرحبا", 2, "left"), 3);
  assert.equal(moveCursorVisual("مرحبا", 2, "right"), 1);
  assert.equal(moveCursorVisual("مرحبا", 5, "left"), 5);
  assert.equal(moveCursorVisual("مرحبا", 0, "right"), 0);
  assert.deepEqual(walk("مرحبا", 0, "left"), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(walk("مرحبا", 5, "right"), [5, 4, 3, 2, 1, 0]);
});

test("moveCursorVisual: a mark or a ligature is one step", () => {
  assert.deepEqual(walk("كِتَاب", 0, "left"), [0, 2, 4, 5, 6]);
  assert.deepEqual(walk("لا", 0, "left"), [0, 2]);
  assert.deepEqual(walk("لا", 2, "right"), [2, 0]);
});

test("moveCursorVisual: mixed text never gets stuck and never repeats", () => {
  const text = "hello مرحبا world";
  assert.deepEqual(walk(text, 0, "right").slice(0, 11), [0, 1, 2, 3, 4, 5, 6, 10, 9, 8, 7]);
  const left = walk("hello مرحبا", 11, "left");
  assert.deepEqual(left, [11, 5, 4, 3, 2, 1, 0]);
  for (const t of [text, "abعر", "ثم abc ثم", "(مرحبا) [test] {x}", "قم بتشغيل npm test ثم ارجع"]) {
    for (const dir of ["left", "right"]) {
      for (let c = 0; c <= t.length; c++) {
        const path = walk(t, c, dir);
        assert.equal(new Set(path).size, path.length, `${t} ${dir} from ${c}: ${path}`);
      }
    }
  }
});

test("moveCursorVisual: across lines", () => {
  const t = "abc\nمرحبا";
  assert.deepEqual(walk(t, 0, "right"), [0, 1, 2, 3, 9, 8, 7, 6, 5, 4]);
  assert.equal(moveCursorVisual("ab\ncd", 3, "left"), 2);
  assert.equal(moveCursorVisual("ab\ncd", 2, "right"), 3);
});

test("moveCursorVisual: wrapped Arabic follows the reading flow", () => {
  const t = "مرحبا بك في العالم";
  // row 0 ends (visually, on its left) where row 1 begins (on its right)
  assert.equal(moveCursorVisual(t, 11, "left", { width: 11 }), 12);
  assert.equal(moveCursorVisual(t, 12, "right", { width: 11 }), 11);
  // without a width the whole line is one row
  assert.equal(moveCursorVisual(t, 11, "left"), 12);
});

test("shaping and reordering are pure: the same line gives the same answer", () => {
  const s = "قم بتشغيل `npm test` ثم ارجع (جيدة)";
  const a = toVisual(s);
  assert.equal(toVisual(s), a);
  assert.deepEqual(layoutParagraph(s, 20), layoutParagraph(s, 20));
});

test("a 10,000 character mixed paragraph lays out well under 50 ms", () => {
  const unit = "قم بتشغيل `npm test` ثم ارجع إلى الملف src/app.js الذي يحتوي 3 دوال (جيدة) والتكلفة: 25 دولار (≈ 37,500 دينار) لا بأس. ";
  let text = "";
  while (text.length < 10000) text += unit;
  layoutParagraph(unit, 40); // warm up regexes and caches
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const lines = layoutParagraph(text, 90);
    best = Math.min(best, performance.now() - t0);
    assert.ok(lines.length > 100);
  }
  assert.ok(best < 50, `took ${best.toFixed(1)} ms`);
  let bestInput = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    layoutInput(text, text.length, { width: 100, prefix: "> " });
    bestInput = Math.min(bestInput, performance.now() - t0);
  }
  assert.ok(bestInput < 50, `layoutInput took ${bestInput.toFixed(1)} ms`);
});

test("pure ASCII lines are nearly free", () => {
  const line = "The quick brown fox jumps over the lazy dog, again and again.";
  toVisual(line);
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) toVisual(line);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 100, `20000 calls took ${best.toFixed(1)} ms`);
});

test("isolates of a line that is not reordered are dropped (while Arabic is on) and the position map follows", () => {
  const LRI = String.fromCharCode(0x2066);
  const PDI = String.fromCharCode(0x2069);
  const line = `run ${LRI}foo()${PDI} now`;
  assert.equal(toVisual(line), "run foo() now");
  assert.deepEqual(visualToLogicalMap(line).length, "run foo() now".length);
  setArabicMode("off");
  try { assert.equal(toVisual(line), line, "Arabic off never touches the text"); } finally { setArabicMode("on"); }
});

test("a Latin word keeps its leading punctuation on its own side between Arabic words", () => {
  const v = text => toVisual(text, { dir: "rtl" });
  // Arabic reads right to left, so the word in front comes LAST (on the right) in the visual line.
  assert.ok(v("اقرأ @src/app.js").startsWith("@src/app.js "), "@mention");
  assert.ok(v("افتح ./src/app.js الآن").includes(" ./src/app.js "), "relative path");
  assert.ok(v("شغّل --force الآن").includes(" --force "), "flag");
  assert.ok(v("اكتب /help للمساعدة").includes(" /help "), "slash command");
  assert.ok(v("استخدم $HOME و #tag").startsWith("#tag ") && v("استخدم $HOME و #tag").includes(" $HOME "), "symbols");
  // The full stop that ends the sentence stays with the Arabic text, at the left end of the line.
  assert.ok(v("افتح ~/proj/app.js.").startsWith(".~/proj/app.js "), "sentence punctuation stays out of the word");
  // Brackets are still paired by the algorithm, and a word with Arabic letters in it is not touched.
  assert.equal(v("(مرحبا) [test] {x}"), "{x} [test] (" + sh("مرحبا").split("").reverse().join("") + ")");
  // Same layout for the cursor maths: the position map agrees with what was drawn.
  const line = "اقرأ @src/app.js";
  assert.equal(visualToLogicalMap(line).length, stripAnsi(toVisual(line)).length);
});
