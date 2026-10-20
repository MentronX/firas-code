import { test } from "node:test";
import assert from "node:assert/strict";
import { ULTRA, mentionsUltra, paintUltra, phaseAt, playUltraIntro, rainbow, rainbowAt, rainbowSolid, ultraAnnouncement } from "../../src/ui/ultra.js";
import { colorLevel, setColorLevel } from "../../src/ui/theme.js";
import { setArabicMode, stringWidth, stripAnsi } from "../../src/text/display.js";
import { createSpinner } from "../../src/ui/spinner.js";
import { setLang } from "../../src/i18n/index.js";

setArabicMode("on");
setLang("en");

function withColor(level, fn) {
  const before = colorLevel();
  setColorLevel(level);
  try { return fn(); } finally { setColorLevel(before); }
}

test("the rainbow wraps around and blends between its hues", () => {
  assert.deepEqual(rainbowAt(0), rainbowAt(1));
  assert.deepEqual(rainbowAt(0.25), rainbowAt(1.25));
  assert.deepEqual(rainbowAt(-0.75), rainbowAt(0.25));
  const a = rainbowAt(0);
  const b = rainbowAt(1 / 14);
  assert.notDeepEqual(a, b, "halfway to the next hue is a new colour");
  assert.equal(phaseAt(0), 0);
  assert.equal(phaseAt(1200), 0.5);
  assert.equal(phaseAt(2400), 0);
});

test("rainbow colours each letter, keeps spaces plain, and is plain text without colour", () => {
  withColor(3, () => {
    const out = rainbow("U L T");
    assert.equal(stripAnsi(out), "U L T");
    assert.equal((out.match(/\x1b\[38;2;/g) || []).length, 3, "one colour per letter, none for spaces");
    assert.notEqual(rainbow("abc", 0), rainbow("abc", 0.5), "the phase moves the colours");
  });
  withColor(1, () => assert.match(rainbow("ab"), /\x1b\[3[1-7]m/, "16-colour terminals get the nearest basic colour"));
  withColor(0, () => {
    assert.equal(rainbow("ultracode"), "ultracode");
    assert.equal(rainbowSolid("x"), "x");
  });
});

test("paintUltra paints the word in finished rows, never changes what is read or its width, and does nothing twice", () => {
  withColor(3, () => {
    const row = "  mode: default · effort: ultracode · Shift+Tab to switch";
    const painted = paintUltra(row, 0.2);
    assert.notEqual(painted, row);
    assert.equal(stripAnsi(painted), row);
    assert.equal(stringWidth(stripAnsi(painted)), stringWidth(row));
    assert.equal(paintUltra(painted, 0.2), painted, "a painted word is not painted again");
    assert.equal(stripAnsi(paintUltra("ULTRACODE and Ultracode", 0)), "ULTRACODE and Ultracode");
    assert.equal((paintUltra("ULTRACODE and Ultracode", 0).match(/\x1b\[38;2;/g) || []).length, 18, "any case");
    const other = "  effort: max";
    assert.equal(paintUltra(other), other, "rows without the word come back as they were");
  });
  withColor(0, () => assert.equal(paintUltra("effort: ultracode"), "effort: ultracode"));
});

test("a message names ultracode only as a word of its own", () => {
  for (const yes of ["ultracode", "fix the parser ultracode", "ULTRACODE: refactor this", "Ultracode, please", "اصلح الخطأ ultracode", "(ultracode)"]) {
    assert.equal(mentionsUltra(yes), true, yes);
  }
  for (const no of ["", "ultra code", "ultracodes", "myultracode", "ultracode2", "ultra_code"]) {
    assert.equal(mentionsUltra(no), false, no);
  }
  assert.equal(ULTRA, "ultracode");
});

test("the announcement says what ultracode does, in both languages, right-aligned in Arabic", () => {
  const en = ultraAnnouncement({ width: 100, lang: "en" }).map(stripAnsi);
  assert.equal(en[0], "");
  assert.ok(en.some(l => l.includes("U L T R A C O D E")));
  assert.ok(en.some(l => l.includes("ultracode is on")));
  setLang("ar");
  try {
    const ar = ultraAnnouncement({ width: 100, lang: "ar" }).map(stripAnsi);
    const title = ar.find(l => l.includes("U L T R A C O D E"));
    assert.ok(title.startsWith(" ".repeat(20)), "the title sits on the right in the Arabic interface");
    const said = ar.filter(l => l.trim() && !l.includes("U L T R A"));
    assert.ok(said.length >= 2 && said.some(l => l.includes("ultracode")));
    for (const line of said) {
      assert.ok(/[ﹰ-﻿]/.test(line), "the Arabic sentences are shaped for the terminal");
      assert.ok(stringWidth(line) <= 100, "and wrapped to the width");
      assert.ok(stringWidth(line.trimEnd()) >= 95, "and right-aligned: " + line);
    }
  } finally {
    setLang("en");
  }
});

test("the charge-up animates in the live region, then leaves the announcement", async () => {
  await withColor(3, async () => {
    const frames = [];
    const raw = [];
    let cleared = 0;
    const printed = [];
    const screen = { isTTY: true, width: () => 80, setLive: lines => { frames.push(lines.map(stripAnsi)); raw.push(lines); }, clearLive: () => { cleared += 1; } };
    await playUltraIntro({ screen, print: lines => printed.push(...lines.map(stripAnsi)), lang: "en", frames: 6, frameMs: 0, sleep: async () => {} });
    assert.equal(frames.length, 6);
    assert.equal(cleared, 1);
    assert.ok(raw[0][0] !== raw[5][0], "the title lights up letter by letter");
    assert.ok(frames[5][0].includes("U L T R A C O D E"));
    assert.ok(frames[5][1].includes("━".repeat(10)) || frames[5][1].includes("=".repeat(10)), "the bar ends full");
    assert.ok(printed.some(l => l.includes("ultracode is on")));
  });
});

test("without a terminal (or without colour) there is no animation, only the announcement", async () => {
  const printed = [];
  let live = 0;
  await playUltraIntro({ screen: { isTTY: false, width: () => 80, setLive: () => { live += 1; } }, print: lines => printed.push(...lines), lang: "en", sleep: async () => {} });
  assert.equal(live, 0);
  assert.ok(printed.map(stripAnsi).some(l => l.includes("U L T R A C O D E")));
  await withColor(0, async () => {
    await playUltraIntro({ screen: { isTTY: true, width: () => 80, setLive: () => { live += 1; }, clearLive() {} }, print: () => {}, sleep: async () => {} });
  });
  assert.equal(live, 0);
});

function fakeClock(start = 100000) {
  let at = start;
  return { now: () => at, advance: ms => { at += ms; }, setTimer: () => ({ unref() {} }), clearTimer: () => {} };
}

test("an ultracode turn's spinner carries the painted word and moves through the rainbow; other turns do not", () => {
  withColor(3, () => {
    const clock = fakeClock();
    const spinner = createSpinner({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    spinner.start();
    assert.ok(!stripAnsi(spinner.line(80)).includes("ultracode"));
    spinner.set({ ultra: true });
    clock.advance(2000);
    const one = spinner.line(80);
    assert.ok(stripAnsi(one).includes(" ultracode"), stripAnsi(one));
    assert.ok(stringWidth(stripAnsi(one)) <= 80);
    clock.advance(600);
    const two = spinner.line(80);
    assert.equal(stripAnsi(two), stripAnsi(one), "the words stay put");
    assert.notEqual(two, one, "the colours move");
    assert.ok(stringWidth(stripAnsi(spinner.line(24))) <= 24, "a narrow line still fits");
    spinner.stop();
    spinner.start();
    assert.ok(!stripAnsi(spinner.line(80)).includes("ultracode"), "a new turn starts plain again");
    spinner.stop();
  });
});
