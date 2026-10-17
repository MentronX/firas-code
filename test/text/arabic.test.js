import test from "node:test";
import assert from "node:assert/strict";
import { shapeArabic, unshapeArabic, joiningType, formsOf, hasArabic, shapeCodepoints, isShapable } from "../../src/text/arabic.js";

const hex = s => [...s].map(c => c.codePointAt(0).toString(16)).join(" ");

test("well-known words shape to the expected presentation forms", () => {
  const cases = [
    ["مرحبا", "fee3 feae fea3 fe92 fe8e"],
    ["بسم الله", "fe91 feb4 fee2 20 fe8d fedf fee0 feea"],
    ["عربي", "fecb feae fe91 fef2"],
    ["يكتب", "fef3 fedc fe98 fe90"],
    ["الله", "fe8d fedf fee0 feea"],
    ["ما", "fee3 fe8e"],
    ["على", "fecb fee0 fef0"],
    ["مدرسة", "fee3 feaa fead feb3 fe94"],
    ["وردة", "feed fead fea9 fe93"],
  ];
  for (const [word, want] of cases) assert.equal(hex(shapeArabic(word)), want, word);
});

test("single letters take the isolated form, and hamza has no joining form", () => {
  assert.equal(hex(shapeArabic("ب")), "fe8f");
  assert.equal(hex(shapeArabic("ء")), "621");
  assert.equal(hex(shapeArabic("ءب")), "621 fe8f");
  assert.equal(hex(shapeArabic("أ")), "fe83");
  assert.equal(hex(shapeArabic("آ")), "fe81");
  assert.equal(hex(shapeArabic("ؤ")), "fe85");
  assert.equal(hex(shapeArabic("ئ")), "fe89");
});

test("lam-alef becomes one ligature, in all four alef variants", () => {
  assert.equal(hex(shapeArabic("لا")), "fefb");
  assert.equal(hex(shapeArabic("لأ")), "fef7");
  assert.equal(hex(shapeArabic("لإ")), "fef9");
  assert.equal(hex(shapeArabic("لآ")), "fef5");
  // after a dual-joining letter the ligature takes its final form
  assert.equal(hex(shapeArabic("بلا")), "fe91 fefc");
  assert.equal(hex(shapeArabic("بلأ")), "fe91 fef8");
  // after a right-joining letter it cannot connect
  assert.equal(hex(shapeArabic("ولا")), "feed fefb");
  // the letter after the ligature starts fresh
  assert.equal(hex(shapeArabic("لاك")), "fefb fed9");
});

test("lam and alef with a mark between still form the ligature, mark kept after it", () => {
  assert.equal(hex(shapeArabic("لَا")), "fefb 64e");
  assert.equal(hex(shapeArabic("لاَ")), "fefb 64e");
});

test("marks never break a join and stay after their base letter", () => {
  assert.equal(hex(shapeArabic("بَيْت")), "fe91 64e fef4 652 fe96");
  assert.equal(hex(shapeArabic("كِتَابٌ")), "fedb 650 fe98 64e fe8e fe8f 64c");
  assert.equal(hex(shapeArabic("اللَّه")), "fe8d fedf fee0 64e 651 feea");
});

test("tatweel joins on both sides and is kept", () => {
  assert.equal(hex(shapeArabic("بـب")), "fe91 640 fe90");
  assert.equal(hex(shapeArabic("ـبـ")), "640 fe92 640");
});

test("joining stops at spaces, digits and punctuation", () => {
  assert.equal(hex(shapeArabic("ب ب")), "fe8f 20 fe8f");
  assert.equal(hex(shapeArabic("ب1ب")), "fe8f 31 fe8f");
  assert.equal(hex(shapeArabic("ب.ب")), "fe8f 2e fe8f");
});

test("Persian letters and ZWNJ", () => {
  assert.equal(hex(shapeArabic("پژ گچ")), "fb58 fb8b 20 fb94 fb7b");
  assert.equal(hex(shapeArabic("ی")), "fbfc");
  assert.equal(hex(shapeArabic("می")), "fee3 fbfd");
  // ZWNJ stops the join and stays in the output as a zero-width character
  assert.equal(hex(shapeArabic("می\u200cخواهم")), "fee3 fbfd 200c fea7 feee fe8d feeb fee2");
});

test("ZWJ forces a join", () => {
  assert.equal(hex(shapeArabic("ب\u200d")), "fe91 200d");
  assert.equal(hex(shapeArabic("\u200dب")), "200d fe90");
});

test("text without Arabic letters is returned untouched", () => {
  const s = "hello 123 日本語 😀 ٣٤٥";
  assert.equal(shapeArabic(s), s);
  assert.equal(hasArabic(s), true); // Arabic-Indic digits live in the Arabic block
  assert.equal(hasArabic("plain ascii"), false);
});

test("shaping is idempotent", () => {
  const samples = ["مرحبا بالعالم", "لا إله إلا الله", "كِتَابٌ", "بسم الله الرحمن الرحيم", "می\u200cخواهم", "ـبـ", "x ولا y", "اللَّه", "ئ ؤ ء"];
  for (const s of samples) {
    const once = shapeArabic(s);
    assert.equal(shapeArabic(once), once, s);
  }
  assert.equal(shapeArabic("\ufee3\ufeae\ufea3\ufe92\ufe8e"), "\ufee3\ufeae\ufea3\ufe92\ufe8e");
});

test("unshape maps presentation forms back to base letters", () => {
  assert.equal(unshapeArabic("\ufee3\ufeae\ufea3\ufe92\ufe8e"), "مرحبا");
  assert.equal(unshapeArabic("\ufefb"), "لا");
  assert.equal(unshapeArabic("\ufef8"), "لأ");
  assert.equal(unshapeArabic("hello"), "hello");
  for (const w of ["مرحبا", "بسم الله", "لا إله إلا الله", "عربي"]) assert.equal(unshapeArabic(shapeArabic(w)), w);
});

test("joining types", () => {
  assert.equal(joiningType(0x628), "D");
  assert.equal(joiningType(0x627), "R");
  assert.equal(joiningType(0x621), "U");
  assert.equal(joiningType(0x640), "C");
  assert.equal(joiningType(0x64e), "T");
  assert.equal(joiningType(0x61), "U");
  assert.equal(joiningType(0x6ba), "D");
});

test("forms tables", () => {
  assert.deepEqual(formsOf(0x628), [0xfe8f, 0xfe90, 0xfe91, 0xfe92]);
  assert.deepEqual(formsOf(0x627), [0xfe8d, 0xfe8e, 0, 0]);
  assert.equal(formsOf(0x41), null);
  assert.equal(isShapable(0x645), true);
  assert.equal(isShapable(0x41), false);
});

test("every dual-joining letter has four distinct forms in the right order", () => {
  for (let cp = 0x621; cp <= 0x64a; cp++) {
    const f = formsOf(cp);
    if (!f) continue;
    assert.equal(new Set(f.filter(Boolean)).size, f.filter(Boolean).length, cp.toString(16));
    for (const g of f) if (g) assert.equal(String.fromCodePoint(g).normalize("NFKC"), String.fromCodePoint(cp));
  }
});

test("shapeCodepoints reports where each glyph came from", () => {
  const cps = [...("ملاك")].map(c => c.codePointAt(0));
  const r = shapeCodepoints(cps);
  assert.deepEqual(r.out, [0xfee3, 0xfefc, 0xfed9]);
  assert.deepEqual(r.from, [0, 1, 3]);
  assert.deepEqual(r.to, [1, 3, 4]);
});

test("a long paragraph shapes quickly", () => {
  const text = "مرحبا بالعالم ".repeat(1000);
  shapeArabic("warm up مرحبا");
  const t0 = performance.now();
  const out = shapeArabic(text);
  const ms = performance.now() - t0;
  assert.equal(out.length, text.length);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});
