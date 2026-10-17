import test from "node:test";
import assert from "node:assert/strict";
import { renderDiff, diffStats } from "../../src/ui/diff.js";
import { c, setColorLevel, colorLevel } from "../../src/ui/theme.js";
import { setLang, getLang } from "../../src/i18n/index.js";
import { setArabicMode, stripAnsi, stringWidth, toVisual } from "../../src/text/display.js";

setArabicMode("on");

function withLevel(level, fn) {
  const saved = colorLevel();
  setColorLevel(level);
  try { return fn(); } finally { setColorLevel(saved); }
}
function withLang(lang, fn) {
  const saved = getLang();
  setLang(lang);
  try { return fn(); } finally { setLang(saved); }
}

const plain = (d, o) => withLevel(0, () => withLang("en", () => renderDiff(d, { width: 60, ...o })));
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const join = a => a.join("\n") + "\n";
const ELLIPSIS = /^(…|\.\.\.) /;

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// Reference: length of the longest common subsequence of two line arrays.
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j], row[j - 1]);
      diag = above;
    }
  }
  return row[b.length];
}

// What the renderer treats as the lines of a text: split on newlines, one trailing empty line dropped.
function linesOf(text) {
  if (text === "") return [];
  const l = text.split("\n");
  if (l.at(-1) === "") l.pop();
  return l;
}

test("diffStats counts added and removed lines (CRLF-safe, null = empty)", () => {
  assert.deepEqual(diffStats("a\nb\nc\n", "a\nB\nc\nd\n"), { added: 2, removed: 1 });
  assert.deepEqual(diffStats(null, "x\ny\n"), { added: 2, removed: 0 });
  assert.deepEqual(diffStats("x\ny", null), { added: 0, removed: 2 });
  assert.deepEqual(diffStats("a\r\nb\r\n", "a\nb\n"), { added: 0, removed: 0 });
  assert.deepEqual(diffStats("", ""), { added: 0, removed: 0 });
  assert.deepEqual(diffStats("a", "a\n"), { added: 0, removed: 0 }, "a missing final newline is not a change");
});

test("the line diff is minimal (random texts against a reference LCS)", () => {
  const rand = rng(11);
  const pool = ["a", "b", "c", "d", "e", "", "x y", "z"];
  for (let t = 0; t < 300; t++) {
    const make = () => Array.from({ length: Math.floor(rand() * 18) }, () => pool[Math.floor(rand() * pool.length)]).join("\n");
    const oldText = make(), newText = make();
    const A = linesOf(oldText), B = linesOf(newText);
    const common = lcs(A, B);
    const { added, removed } = diffStats(oldText, newText);
    assert.equal(added, B.length - common, JSON.stringify([oldText, newText]));
    assert.equal(removed, A.length - common, JSON.stringify([oldText, newText]));
  }
});

test("very different large inputs fall back to a coarse diff and stay fast", () => {
  const a = Array.from({ length: 4000 }, (_, i) => "old " + i).join("\n");
  const b = Array.from({ length: 4000 }, (_, i) => "new " + i).join("\n");
  const t0 = performance.now();
  assert.deepEqual(diffStats(a, b), { added: 4000, removed: 4000 });
  const rows = plain({ path: "big.txt", oldText: a, newText: b }, { maxLines: 10 });
  assert.equal(rows.length, 1 + 10 + 1);
  assert.ok(performance.now() - t0 < 1500);
  const big = lines(6000);
  const edited = big.slice();
  edited[3000] = "changed";
  const t1 = performance.now();
  assert.deepEqual(diffStats(join(big), join(edited)), { added: 1, removed: 1 });
  assert.ok(performance.now() - t1 < 200, "few changes in a big file is cheap");
});

test("header: path and counts; identical texts say there is nothing to show", () => {
  assert.equal(plain({ path: "src/a.js", oldText: "a\nb\n", newText: "a\nc\nd\n" })[0], "src/a.js  +2 -1");
  assert.deepEqual(plain({ path: "x.js", oldText: "same\n", newText: "same\r\n" }), ["x.js", "No changes"]);
  const ar = withLevel(0, () => withLang("ar", () => renderDiff({ path: "x.js", oldText: "a", newText: "a" }, { width: 60 })));
  assert.equal(ar.length, 2);
  assert.notEqual(ar[1], "No changes", "the note is translated");
});

test("rows: one number column (old for removed, new otherwise), +/- marker, context rows", () => {
  const out = plain({ path: "f", oldText: join(["a", "b", "c", "d", "e"]), newText: join(["a", "b", "X", "d", "e"]) });
  assert.deepEqual(out.slice(1), [" 1   a", " 2   b", " 3 - c", " 3 + X", " 4   d", " 5   e"]);
  const wide = plain({ path: "f", oldText: join(lines(120)), newText: join(lines(120).map((l, i) => (i === 99 ? "edited" : l))) });
  assert.ok(wide.some(l => l.startsWith("100 + edited")), "the number column widens with the file");
  assert.ok(wide.some(l => l.startsWith("100 - line 100")));
});

test("unchanged runs fold; one hidden line is shown instead of a fold", () => {
  const a = lines(30), b = a.slice();
  b[2] = "first change";
  b[25] = "second change";
  const out = plain({ path: "f", oldText: join(a), newText: join(b) });
  const folds = out.filter(l => /unchanged/.test(l));
  assert.equal(folds.length, 1);
  assert.match(folds[0].trim(), /^(⋯|\.\.\.) 16 unchanged lines$/);
  assert.ok(out.some(l => l.includes("line 6")) && !out.some(l => l.includes("line 7")), "three context lines after a change");
  assert.ok(out.some(l => l.includes("line 23")) && !out.some(l => l.includes("line 22")), "three context lines before one");

  const between = n => plain({ path: "f", oldText: join(["A", ...lines(n), "B"]), newText: join(["a", ...lines(n), "b"]) });
  assert.equal(between(7).filter(l => /unchanged/.test(l)).length, 0, "only one line would hide");
  assert.ok(between(8).some(l => l.endsWith("2 unchanged lines")));

  const ctx0 = plain({ path: "f", oldText: join(["a", ...lines(10), "z"]), newText: join(["A", ...lines(10), "Z"]) }, { context: 0 });
  assert.equal(ctx0.filter(l => /unchanged/.test(l)).length, 1, "context 0 hides the whole middle");
  assert.equal(ctx0.length, 1 + 4 + 1);
});

test("fold and footer wording follows the language (Arabic plurals)", () => {
  const fold = n => withLevel(0, () => withLang("ar", () => renderDiff({ path: "f", oldText: join(["x", ...lines(n), "y"]), newText: join(["X", ...lines(n), "Y"]) }, { width: 60, context: 0 })))[3];
  const forms = [2, 5, 20].map(fold);
  assert.equal(new Set(forms).size, 3, "two, a few and many are worded differently");
  assert.ok(forms.every(f => /[؀-ۿﭐ-﻿]/.test(f)), "and they are Arabic");
  assert.ok(stripAnsi(forms[2]).includes("20"));
});

test("new file: every line added, limited by maxLines with a footer", () => {
  const out = plain({ path: "new.js", oldText: null, newText: join(lines(100)) }, { maxLines: 8 });
  assert.equal(out[0], "new.js  (new file)  +100");
  assert.equal(out.length, 1 + 8 + 1);
  assert.equal(out[1], "  1 + line 1");
  assert.match(out.at(-1).trim(), new RegExp(ELLIPSIS.source + "\\+92 more lines$"));
  assert.deepEqual(plain({ path: "n", oldText: null, newText: "only\n" }).slice(1), [" 1 + only"]);
});

test("footer counts the lines that were left out", () => {
  const a = lines(200), b = a.slice();
  for (const i of [5, 60, 120, 180]) b[i] = "edit " + i;
  const out = plain({ path: "f", oldText: join(a), newText: join(b) }, { maxLines: 10 });
  assert.equal(out.length, 1 + 10 + 1);
  assert.match(out.at(-1), /\+\d+ more lines$/);
});

test("added and removed rows have backgrounds, padded to the width; changed words are brighter", () => {
  const out = withLevel(3, () => withLang("en", () => renderDiff({ path: "f.js", oldText: "const alpha = 1;\nsame\n", newText: "const alpha = 2;\nsame\n" }, { width: 50 })));
  const [del, add] = [out[1], out[2]];
  assert.equal(stringWidth(del), 50);
  assert.equal(stringWidth(add), 50);
  assert.ok(del.includes(c.bgDel(" ")) && add.includes(c.bgAdd(" ")));
  const backgrounds = row => new Set(row.match(/\x1b\[48;2;[0-9;]+m/g) || []);
  assert.equal(backgrounds(add).size, 2, "base background plus a brighter one for the changed word");
  assert.equal(backgrounds(del).size, 2);
  assert.ok(stripAnsi(out[3]).trim().length > 0 && !/\x1b\[48;2/.test(out[3]), "context rows have no background");
  const level1 = withLevel(1, () => renderDiff({ path: "f.js", oldText: "const alpha = 1;\n", newText: "const alpha = 2;\n" }, { width: 50 }));
  assert.ok(level1[2].includes(c.underline("2")), "without 256 colours the changed word is underlined instead");
  const unrelated = withLevel(3, () => renderDiff({ path: "f", oldText: "alpha beta gamma\n", newText: "one two three four\n" }, { width: 50 }));
  assert.equal(new Set(unrelated[2].match(/\x1b\[48;2;[0-9;]+m/g) || []).size, 1, "lines that share nothing get no word-level highlight");
});

test("long lines wrap inside the code column and keep the gutter", () => {
  const long = "const value = computeSomething(argumentNumberOne, argumentNumberTwo, argumentNumberThree);";
  const out = plain({ path: "f", oldText: null, newText: long + "\n" }, { width: 40 });
  assert.ok(out.length > 3 && out.slice(1).every(l => stringWidth(l) <= 40));
  assert.ok(out[1].startsWith(" 1 + "));
  assert.ok(out.slice(2).every(l => l.startsWith("     ") && !/^ {5}[+-]/.test(l)), "continuation rows have a blank gutter");
  assert.equal(out.slice(1).map(l => l.slice(5)).join(""), long);
});

test("Arabic: letters are joined and words read correctly inside the LTR code line; header path too", () => {
  const out = plain({ path: "docs/ملف.md", oldText: "// مرحبا بالعالم\nx = 1\n", newText: "// مرحبا يا عالم\nx = 1\n" });
  assert.ok(!out.join("\n").includes("م"), "plain Arabic letters are replaced by joined forms");
  const wanted = toVisual("// مرحبا بالعالم", { dir: "ltr" });
  assert.ok(out.some(l => l.includes(wanted)), "the old line shows the Arabic words in reading order after the //");
  assert.ok(out[0].startsWith(toVisual("docs/ملف.md", { dir: "ltr" })));
});

test("file text is untrusted: escapes and control characters are removed, tabs expand, CRLF is normalised", () => {
  const out = plain({ path: "p\x1b[31m.js", oldText: "a\r\n\tb\x1b[2J\r\n", newText: "a\r\n\tB\x07\r\n" });
  assert.doesNotMatch(out.join("\n"), /[\x00-\x09\x0b-\x1f\x7f]/);
  assert.ok(out.some(l => l.includes("-     b")) && out.some(l => l.includes("+     B")), "a tab is four columns");
  assert.ok(out[0].startsWith("p.js"));
});

test("odd arguments never throw", () => {
  assert.doesNotThrow(() => renderDiff({ path: undefined, oldText: undefined, newText: undefined }, undefined));
  assert.doesNotThrow(() => renderDiff({ path: "x", oldText: 5, newText: { toString: () => "y" } }, { width: 3, context: -1, maxLines: 0 }));
  assert.doesNotThrow(() => renderDiff({ path: "x", oldText: "a".repeat(100_000), newText: "b".repeat(100_000) }, { width: 80 }));
  assert.ok(renderDiff({ path: "x", oldText: "a", newText: "b" }, { width: 3 }).length >= 3);
});

test("rows stay within the width (colour on and off)", () => {
  const rand = rng(5);
  const bits = ["مرحبا", "const x = 1;", "", "emoji 😀 line", "\ttab", "word ".repeat(30)];
  for (const level of [0, 3]) {
    for (let t = 0; t < 40; t++) {
      const make = () => Array.from({ length: 1 + Math.floor(rand() * 12) }, () => bits[Math.floor(rand() * bits.length)]).join("\n");
      const width = 30 + Math.floor(rand() * 70);
      const out = withLevel(level, () => renderDiff({ path: "f", oldText: make(), newText: make() }, { width }));
      for (const l of out) assert.ok(stringWidth(l) <= width, `${level}/${width}: ${JSON.stringify(stripAnsi(l))}`);
    }
  }
});
