import test from "node:test";
import assert from "node:assert/strict";
import { charWidth, stringWidth as rawWidth, segmentCodepoints, isCombining, isFormat } from "../../src/text/width.js";
import { stringWidth, setArabicMode } from "../../src/text/display.js";

setArabicMode("on");

const cps = s => [...s].map(c => c.codePointAt(0));

test("ASCII is one column per character", () => {
  assert.equal(stringWidth(""), 0);
  assert.equal(stringWidth("hello"), 5);
  assert.equal(stringWidth("a b c"), 5);
});

test("East Asian wide and fullwidth characters take two columns", () => {
  assert.equal(stringWidth("日本語"), 6);
  assert.equal(stringWidth("한글"), 4);
  assert.equal(stringWidth("ＡＢ"), 4);
  assert.equal(stringWidth("中a文"), 5);
  assert.equal(stringWidth("ｱ"), 1); // halfwidth katakana
  assert.equal(charWidth(0x4e2d), 2);
  assert.equal(charWidth(0x20000), 2);
});

test("emoji take two columns, including sequences", () => {
  assert.equal(stringWidth("😀"), 2);
  assert.equal(stringWidth("👍🏽"), 2); // skin tone modifier
  assert.equal(stringWidth("👨\u200d👩\u200d👧\u200d👦"), 2); // ZWJ family
  assert.equal(stringWidth("🇮🇶"), 2); // flag
  assert.equal(stringWidth("❤\ufe0f"), 2); // text heart + VS16
  assert.equal(stringWidth("❤"), 1);
  assert.equal(stringWidth("✔"), 1);
  assert.equal(stringWidth("1\ufe0f\u20e3"), 2); // keycap
  assert.equal(stringWidth("a😀b"), 4);
});

test("combining marks, joiners and format characters take no columns", () => {
  assert.equal(stringWidth("e\u0301"), 1);
  assert.equal(stringWidth("a\u200bb"), 2);
  assert.equal(stringWidth("\u200d"), 0);
  assert.equal(stringWidth("\u200c"), 0);
  assert.equal(stringWidth("\u200e\u200f"), 0);
  assert.equal(stringWidth("\x07"), 0);
  assert.equal(stringWidth("ก\u0e47"), 1); // Thai base + vowel sign
  assert.equal(stringWidth("\u1112\u1161\u11ab"), 2); // conjoining Hangul jamo = one syllable
  assert.equal(isCombining(0x301), true);
  assert.equal(isCombining(0x41), false);
  assert.equal(isFormat(0x200b), true);
  assert.equal(isFormat(0x41), false);
});

test("ANSI sequences count nothing", () => {
  assert.equal(stringWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(stringWidth("\x1b[1;38;2;10;20;30mx\x1b[m"), 1);
  assert.equal(stringWidth("\x1b]8;;https://example.org\x07link\x1b]8;;\x07"), 4);
  assert.equal(stringWidth("\x1b]8;;https://example.org\x1b\\link\x1b]8;;\x1b\\"), 4);
  assert.equal(stringWidth("\x1b]0;window title\x07text"), 4);
  assert.equal(stringWidth("日\x1b[31m本\x1b[0m"), 4);
});

test("Arabic letters are one column; lam-alef is one cell", () => {
  assert.equal(stringWidth("ب"), 1);
  assert.equal(stringWidth("مرحبا"), 5);
  assert.equal(stringWidth("لا"), 1);
  assert.equal(stringWidth("لَا"), 1); // mark between lam and alef
  assert.equal(stringWidth("الله"), 4);
  assert.equal(stringWidth("\ufefb"), 1); // already a ligature
  assert.equal(stringWidth("بلا لأ لإ لآ"), 8);
  assert.equal(stringWidth("كِتَابٌ"), 4); // marks are free
  assert.equal(stringWidth("\ufee3\ufeae\ufea3\ufe92\ufe8e"), 5);
});

test("lam-alef counts once only when Arabic shaping is on", () => {
  assert.equal(rawWidth("لا", { shaped: false }), 2);
  assert.equal(rawWidth("لا"), 1);
  setArabicMode("off");
  try {
    assert.equal(stringWidth("لا"), 2);
  } finally {
    setArabicMode("on");
  }
});

test("segmentCodepoints keeps base+marks and emoji sequences together", () => {
  const clusters = [];
  segmentCodepoints(cps("e\u0301x👨\u200d👩\u200d👧y🇮🇶"), cps("e\u0301x👨\u200d👩\u200d👧y🇮🇶").length, (a, b, w) => clusters.push([a, b, w]));
  assert.deepEqual(clusters, [[0, 2, 1], [2, 3, 1], [3, 8, 2], [8, 9, 1], [9, 11, 2]]);
});

test("ASCII width check is fast", () => {
  const line = "The quick brown fox jumps over the lazy dog";
  stringWidth(line);
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) stringWidth(line);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 100, `20000 calls took ${best.toFixed(1)} ms`);
});
