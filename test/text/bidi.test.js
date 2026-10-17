import test from "node:test";
import assert from "node:assert/strict";
import {
  bidiClass, BIDI_RANGES, mirrorOf, firstStrongDirection, resolveParagraph, visualOrder,
  L, R, AL, EN, ES, ET, AN, CS, NSM, BN, B, S, WS, ON, LRE, LRO, RLE, RLO, PDF, LRI, RLI, FSI, PDI,
} from "../../src/text/bidi.js";
import { visualToLogicalMap, setArabicMode } from "../../src/text/display.js";

setArabicMode("on");

const cp = s => [...s].map(c => c.codePointAt(0));
const classes = s => Uint8Array.from(cp(s).map(bidiClass));
const levelsOf = (s, dir) => [...resolveParagraph(classes(s), cp(s), dir).levels];

test("class table is sorted and non-overlapping", () => {
  let prev = -1;
  for (const [lo, hi, cls] of BIDI_RANGES) {
    assert.ok(lo <= hi, lo.toString(16));
    assert.ok(lo > prev, "overlap at " + lo.toString(16));
    assert.ok(cls >= 0 && cls <= PDI);
    prev = hi;
  }
});

test("bidi classes of common characters", () => {
  const table = [
    ["a", L], ["Z", L], ["é", L], ["日", L], ["א", R], ["ا", AL], ["\ufe8e", AL], ["\ufefb", AL], ["1", EN], ["۱", EN],
    ["١", AN], ["٫", AN], ["+", ES], ["-", ES], ["−", ES], ["$", ET], ["%", ET], [",", CS], [".", CS], [":", CS],
    ["/", CS], ["\u0300", NSM], ["َ", NSM], ["\u200b", BN], ["\u200d", BN], ["\n", B], ["\t", S], [" ", WS], ["　", WS],
    ["(", ON], ["!", ON], ["≈", ON], ["→", ON], ["\u202a", LRE], ["\u202b", RLE], ["\u202c", PDF], ["\u202d", LRO],
    ["\u202e", RLO], ["\u2066", LRI], ["\u2067", RLI], ["\u2068", FSI], ["\u2069", PDI], ["\u200e", L], ["\u200f", R],
    ["\u061c", AL], ["،", CS], ["؟", AL], ["ـ", AL], ["\u{1F600}", ON], ["\u{1EE01}", AL],
  ];
  for (const [ch, want] of table) assert.equal(bidiClass(ch.codePointAt(0)), want, ch.codePointAt(0).toString(16));
});

test("mirroring", () => {
  for (const [a, b] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"], ["«", "»"], ["≤", "≥"], ["∈", "∋"]]) {
    assert.equal(mirrorOf(a.codePointAt(0)), b.codePointAt(0));
    assert.equal(mirrorOf(b.codePointAt(0)), a.codePointAt(0));
  }
  assert.equal(mirrorOf(0x61), 0x61);
  assert.equal(mirrorOf(0x2248), 0x2248);
});

test("first strong direction (P2/P3), skipping isolated text", () => {
  assert.equal(firstStrongDirection("abc"), "ltr");
  assert.equal(firstStrongDirection("123 א"), "rtl");
  assert.equal(firstStrongDirection("123 ..."), null);
  assert.equal(firstStrongDirection("\u2067א\u2069 abc"), "ltr");
  assert.equal(firstStrongDirection("\u2067א abc"), null); // an unterminated isolate swallows the rest
  assert.equal(firstStrongDirection("\u200fabc"), "rtl");
  assert.equal(firstStrongDirection("(ا)"), "rtl");
});

test("levels: paragraph direction, weak numbers, neutrals", () => {
  assert.deepEqual(levelsOf("abc", 0), [0, 0, 0]);
  assert.deepEqual(levelsOf("אב", -1), [1, 1]);
  assert.equal(resolveParagraph(classes("אb"), cp("אb"), -1).paraLevel, 1);
  assert.equal(resolveParagraph(classes("aא"), cp("aא"), -1).paraLevel, 0);
  // Latin, space, Hebrew, space, digits
  assert.deepEqual(levelsOf("ab אב 12", 0), [0, 0, 0, 1, 1, 1, 2, 2]);
  // the same idea in an RTL paragraph: Latin goes to level 2, the space between R and L takes the embedding direction
  assert.deepEqual(levelsOf("א ab", 1), [1, 1, 2, 2]);
  // trailing whitespace goes back to the paragraph level (L1)
  assert.deepEqual(levelsOf("ab אב  ", 0), [0, 0, 0, 1, 1, 0, 0]);
  // digits after Arabic letters become AN (W2) and still read left to right
  assert.deepEqual(levelsOf("ا 12", 1), [1, 1, 2, 2]);
});

test("levels: brackets pair up (N0)", () => {
  // RTL paragraph, the brackets enclose Hebrew: they follow the embedding direction
  assert.deepEqual(levelsOf("א(ב)", -1), [1, 1, 1, 1]);
  // LTR paragraph, Hebrew before, Latin inside the brackets: the brackets take the Latin direction
  assert.deepEqual(levelsOf("a א (b) c", 0), [0, 0, 1, 0, 0, 0, 0, 0, 0]);
});

test("levels: explicit embeddings, overrides and isolates", () => {
  const r = resolveParagraph(classes("a\u202bb\u202cc"), cp("a\u202bb\u202cc"), 0);
  assert.deepEqual([...r.removed], [0, 1, 0, 1, 0]);
  assert.deepEqual([r.levels[0], r.levels[2], r.levels[4]], [0, 2, 0]);
  const o = resolveParagraph(classes("\u202eabc\u202c"), cp("\u202eabc\u202c"), 0);
  assert.deepEqual([o.levels[1], o.levels[2], o.levels[3]], [1, 1, 1]);
  const iso = resolveParagraph(classes("a \u2067אב\u2069 c"), cp("a \u2067אב\u2069 c"), 0);
  assert.deepEqual([iso.levels[3], iso.levels[4]], [1, 1]);
  assert.equal(iso.levels[0], 0);
  assert.equal(iso.levels[7], 0);
});

test("visualOrder reverses from the highest level down (L2)", () => {
  assert.deepEqual(visualOrder(Uint8Array.from([0, 1, 1, 0])), [0, 2, 1, 3]);
  assert.deepEqual(visualOrder(Uint8Array.from([1, 1, 2, 2, 1])), [4, 2, 3, 1, 0]);
  assert.deepEqual(visualOrder(Uint8Array.from([0, 0, 0])), [0, 1, 2]);
  assert.deepEqual(visualOrder(Uint8Array.from([1, 1, 1]), Uint8Array.from([0, 1, 0])), [2, 0]);
});

test("visual order of hand-checked strings", () => {
  const map = (s, dir = "auto") => visualToLogicalMap(s, { dir });
  assert.deepEqual(map("אבג"), [2, 1, 0]);
  assert.deepEqual(map("abc אבג def"), [0, 1, 2, 3, 6, 5, 4, 7, 8, 9, 10]);
  assert.deepEqual(map("אבג abc"), [4, 5, 6, 3, 2, 1, 0]);
  assert.deepEqual(map("אב 12 גד"), [7, 6, 5, 3, 4, 2, 1, 0]);
  assert.deepEqual(map("اب 12 جد"), [7, 6, 5, 3, 4, 2, 1, 0]);
  assert.deepEqual(map("a \u2067אב\u2069 c"), [0, 1, 4, 3, 6, 7]);
  assert.deepEqual(map("\u202eabc\u202c"), [3, 2, 1]);
  assert.deepEqual(map("\u202bא\u202c", "ltr"), [1]);
});

// Cases checked against a real browser's implementation of UAX #9: hex code points, paragraph direction,
// then the logical indexes of the visible characters in left-to-right order (zero-width controls are not listed).
const BROWSER_CASES = [
  ["202b 20 33 202e 32 24 32 628 5d1", "ltr", "2 8 7 6 5 4 1"],
  ["62a 20 63 2e 2067 20 5d2", "rtl", "6 5 3 2 1 0"],
  ["5d0 20 2067 663 3e 664 664 5d0 2067", "rtl", "7 5 6 4 3 1 0"],
  ["2068 20 2068 5d2 20 62", "ltr", "1 5 4 3"],
  ["20 3a 2b 3e 664 202b 62 5d2", "ltr", "0 1 2 3 7 4 6"],
  ["62 2d 664 202c 62a 202c 663 663", "rtl", "6 7 4 2 1 0"],
  ["61 664 3e 20 5d 5d0 32 2069 24 62", "ltr", "0 6 5 4 3 2 1 8 9"],
  ["21 20 663 202d 5d0 2d 663 202c 24 7b", "rtl", "9 8 2 4 5 6 1 0"],
  ["202d 62a 663 28 645 202e", "rtl", "1 2 3 4"],
  ["202c 25 5d0 202d 20 2068 2c 25 32 2c", "ltr", "1 4 6 7 8 9 2"],
  ["202c 28 62a 2d 25 24 628 33 20", "rtl", "8 7 6 5 4 3 2 1"],
  ["202a 5d1 664 5d1 2e 5d 3e", "auto", "3 2 1 4 5 6"],
  ["202a 25 20 31 5d0", "rtl", "1 2 3 4"],
  ["2b 5d1 202a 2d 2069 202d", "auto", "3 1 0"],
  ["61 202c 25 2066 31 24 628 202a 2069", "ltr", "0 2 4 5 6"],
  ["2067 2069 2b 2068 5d1 33 202c", "rtl", "5 4 2"],
  ["3c 62 20 5d1 202e 5d1 202e", "auto", "0 1 2 5 3"],
  ["2d 664 20 3a 202b 63 2b 202c 31 5d0", "rtl", "9 6 5 8 3 2 1 0"],
  ["33 25 62a 202c 61 25 3e 21", "ltr", "0 1 2 4 5 6 7"],
  ["5d2 2d 61 20 202d 2069 5b 3c 5b", "rtl", "2 3 6 7 8 1 0"],
  ["25 202a 2d 2068 663 663 5d1 645 202a", "rtl", "2 7 6 4 5 0"],
  ["31 202d 2c 31 5d0 2d 20", "ltr", "0 2 3 4 5 6"],
  ["2069 5d0 202a 5d0 2b", "rtl", "3 4 1"],
  ["29 202c 645 61 33 2b 2e 645", "ltr", "0 2 3 4 5 6 7"],
  ["31 202b 628 3a 628 32", "auto", "0 5 4 3 2"],
  ["2e 2c 25 32 5d1 25 20 2066 2067 20", "rtl", "9 6 5 4 2 3 1 0"],
  ["20 20 3c 32 2b 645 20 202b 202a 663", "auto", "9 6 5 4 3 2 1 0"],
  ["2069 24 645 3a 2b 61", "ltr", "1 2 3 4 5"],
  ["5b 202c 2d 5d2 202b", "ltr", "0 2 3"],
  ["24 33 202d 645 25 3e 628 3c", "auto", "0 1 3 4 5 6 7"],
  ["25 7b 5d0 2d 31 5d0 202d 24 202e 62", "rtl", "7 9 5 4 3 2 1 0"],
  ["2e 2069 5b 5d2 21 61 5d0", "rtl", "6 5 4 3 2 0"],
  ["2066 33 202e 5d2 2b 2067 2c 24", "ltr", "1 7 6 4 3"],
  ["28 20 2067 61 33 5d2", "rtl", "5 3 4 1 0"],
  ["2c 33 29 5d1 645 63 202b 22 32 628", "rtl", "5 9 8 7 4 3 2 1 0"],
  ["5d0 202c 62 202d 202c 2b", "ltr", "0 2 5"],
  ["20 62a 33 2c 2069", "auto", "3 2 1 0"],
  ["663 25 2b 31 2066 202c 2067 5d1", "rtl", "7 3 2 1 0"],
  ["62 202b 25 2d 3a 645", "ltr", "0 5 4 3 2"],
  ["2c 20 62 5d1 2b 2068 628", "ltr", "0 1 2 3 4 6"],
  ["664 3a 31 7d 3e 645", "ltr", "0 1 2 3 4 5"],
  ["664 3a 31 7d 3e 645", "auto", "5 4 3 2 1 0"],
  ["20 25 2c 5b 628 20", "rtl", "5 4 3 2 1 0"],
  ["32 62a 663 61 25 61 24 31 5d", "ltr", "0 2 1 3 4 5 6 7 8"],
  ["32 62a 663 61 25 61 24 31 5d", "auto", "8 2 3 4 5 6 7 1 0"],
  ["2b 5d 25 5d0 5d0 22 20 5d0 5d2 5d0", "rtl", "9 8 7 6 5 4 3 2 1 0"],
  ["20 628 2c 663 2c 28 663 20 645 20", "ltr", "0 8 7 6 5 4 3 2 1 9"],
  ["20 628 2c 663 2c 28 663 20 645 20", "auto", "9 8 7 6 5 4 3 2 1 0"],
  ["5d1 7d 2c 5d1 61 62a", "rtl", "5 4 3 2 1 0"],
  ["29 5d0 2d 24 664 25", "ltr", "0 4 3 2 1 5"],
  ["29 5d0 2d 24 664 25", "auto", "5 4 3 2 1 0"],
  ["7d 628 663 21 62 664 62a", "rtl", "6 4 5 3 2 1 0"],
  ["28 664 61 664 2b 645", "ltr", "0 1 2 5 4 3"],
  ["28 664 61 664 2b 645", "auto", "0 1 2 5 4 3"],
  ["25 62a 2e 7d 2e 2d", "rtl", "5 4 3 2 1 0"],
  ["2d 2d 7b 61 5d1 2b", "ltr", "0 1 2 3 4 5"],
  ["2d 2d 7b 61 5d1 2b", "auto", "0 1 2 3 4 5"],
  ["61 33 7d 31 2d 32 2e 2e 62a", "rtl", "8 7 6 0 1 2 3 4 5"],
  ["5d1 663 20 2c 5d 3a 645 2c", "ltr", "6 5 4 3 2 1 0 7"],
  ["5d1 663 20 2c 5d 3a 645 2c", "auto", "7 6 5 4 3 2 1 0"],
  ["33 5d0 5d 628 5d0 663", "rtl", "5 4 3 2 1 0"],
  ["5d2 22 5b 5d1 63 645 5d1 663", "ltr", "3 2 1 0 4 7 6 5"],
  ["5d2 22 5b 5d1 63 645 5d1 663", "auto", "7 6 5 4 3 2 1 0"],
  ["25 5d2 20 2b 29 5d1", "rtl", "5 4 3 2 1 0"],
  ["24 29 63 664 20 2b 5d 2c 24 5d0", "ltr", "0 1 2 9 8 7 6 5 4 3"],
  ["24 29 63 664 20 2b 5d 2c 24 5d0", "auto", "0 1 2 9 8 7 6 5 4 3"],
  ["20 2b 29 20 663 2b 5d2", "rtl", "6 5 4 3 2 1 0"],
  ["664 2b 28 3e 2c 31 61 645 2b", "ltr", "0 1 2 3 4 5 6 7 8"],
  ["664 2b 28 3e 2c 31 61 645 2b", "auto", "0 1 2 3 4 5 6 7 8"],
  ["5d0 61 62 628 20 62a 29 25", "rtl", "7 6 5 4 3 1 2 0"],
  ["5d0 62a 32 20 628 663 62a 31", "ltr", "7 6 5 4 3 2 1 0"],
  ["25 5d1 33 2b 20", "ltr", "0 2 1 3 4"],
  ["2c 24 5d1 31 25 663", "ltr", "0 1 3 4 5 2"],
  ["2b 63 62a 20 62 32 24", "ltr", "0 1 2 3 4 5 6"],
  ["61 628 62a 5d1 24 20", "ltr", "0 3 2 1 4 5"],
  ["645 20 20 645 2e 5d2 62", "ltr", "5 4 3 2 1 0 6"],
  ["5d0 62 5d2 61 663 5d0 62a 24 24", "ltr", "0 1 2 3 6 5 4 7 8"],
  ["20 2c 2d 5d0 31 20 664 2e 2b 31", "ltr", "0 1 2 9 8 7 6 5 4 3"],
  ["5d2 2d 2b 2e 62a 664 645 663", "ltr", "7 6 5 4 3 2 1 0"],
  ["2c 33 5d2 2b 25", "ltr", "0 1 2 3 4"],
  ["664 628 5d0 25 33 31 61", "ltr", "3 4 5 2 1 0 6"],
  ["628 628 2c 20 24", "ltr", "1 0 2 3 4"],
  ["663 20 2e 62a 3f 3a 3a", "ltr", "3 2 1 0 4 5 6"],
  ["664 20 663 61 62a 628 22", "ltr", "2 1 0 3 5 4 6"],
  ["2e 2b 3e 664 628 31 3a 5d1", "ltr", "0 1 2 7 6 5 4 3"],
  ["32 61 5d1 24 5d2 2c 24 61", "ltr", "0 1 4 3 2 5 6 7"],
  ["62 3a 645 3c 5d1 664", "ltr", "0 1 5 4 3 2"],
  ["628 3a 31 2d 20", "ltr", "2 1 0 3 4"],
  ["664 62a 62a 664 5d0 5d1 2d 645 645 25", "ltr", "8 7 6 5 4 3 2 1 0 9"],
  ["24 2b 628 20 628", "ltr", "0 1 4 3 2"],
  ["2d 628 31 3a 2b", "ltr", "0 2 1 3 4"],
  ["2b 5d2 3e 25 62", "ltr", "0 1 2 3 4"],
  ["663 2c 2c 645 2e 5d1 61 5d1 32", "ltr", "5 4 3 2 1 0 6 8 7"],
  ["62 20 25 33 5d2 20 628", "ltr", "0 1 2 3 6 5 4"],
  ["628 2e 32 3a 20 24 2d 20", "ltr", "2 1 0 3 4 5 6 7"],
  ["61 20 5d1 3a 20 3a 645 32 5d1", "ltr", "0 1 8 7 6 5 4 3 2"],
  ["21 2b 5d1 5d0 2c", "ltr", "0 1 3 2 4"],
  ["31 2b 645 33 2d 25", "ltr", "0 1 3 2 4 5"],
  ["2d 2d 5d1 20 20 20 33 628", "ltr", "0 1 7 6 5 4 3 2"],
  ["33 2b 62 5d1 5d1", "ltr", "0 1 2 4 3"],
];

test("agrees with a browser on mixed, embedded and bracketed text", () => {
  for (const [hex, dir, order] of BROWSER_CASES) {
    const s = String.fromCodePoint(...hex.split(" ").map(h => parseInt(h, 16)));
    const want = order === "" ? [] : order.split(" ").map(Number);
    assert.deepEqual(visualToLogicalMap(s, { dir }), want, hex + " " + dir);
  }
});
