import test from "node:test";
import assert from "node:assert/strict";
import { createSpinner, formatElapsed, formatTokens } from "../../src/ui/spinner.js";
import { setColorLevel, sym } from "../../src/ui/theme.js";
import { setArabicMode, stringWidth, stripAnsi, toVisual } from "../../src/text/display.js";
import { setLang } from "../../src/i18n/index.js";
import { tList as listIn, withLang } from "../../src/ui/strings.js";

const tList = (prefix, lang = "en") => withLang(lang, () => listIn(prefix));
import { fakeClock } from "./term-helpers.js";

setArabicMode("on");
const ARABIC_LETTERS = /[\u0600-\u06ff\ufb50-\ufeff]/;
setColorLevel(0);
setLang("en");

const UP = sym.arrow === "→" ? "↑" : "^";

function make(o = {}) {
  const clock = o.clock || fakeClock();
  const frames = [];
  let language = o.lang || "en";
  const sp = createSpinner({
    onFrame: () => frames.push(clock.now()),
    lang: () => language,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { sp, clock, frames, setLanguage: l => { language = l; } };
}

test("elapsed time and token counts are compact, Latin digits, per-language units", () => {
  assert.equal(formatElapsed(0, "en"), "0s");
  assert.equal(formatElapsed(7400, "en"), "7s");
  assert.equal(formatElapsed(59_999, "en"), "59s");
  assert.equal(formatElapsed(72_000, "en"), "1m 12s");
  assert.equal(formatElapsed(3_600_000 + 125_000, "en"), "1h 2m");
  assert.equal(formatElapsed(-5, "en"), "0s");
  assert.equal(formatElapsed(12_000, "ar"), "12ث");
  assert.equal(formatElapsed(72_000, "ar"), "1د 12ث");
  assert.equal(formatElapsed(7_320_000, "ar"), "2س 2د");
  assert.deepEqual([0, 5, 842, 999].map(formatTokens), ["0", "5", "842", "999"]);
  assert.deepEqual([1000, 1049, 3200, 9949, 9999, 10_000, 12_500, 999_499, 999_500].map(formatTokens),
    ["1k", "1k", "3.2k", "9.9k", "10k", "10k", "13k", "999k", "1m"]);
  assert.deepEqual([1_400_000, 25_000_000].map(formatTokens), ["1.4m", "25m"]);
  assert.equal(formatTokens(undefined), "0");
  assert.equal(formatTokens(NaN), "0");
});

test("the line is empty until started and after stop; isRunning follows", () => {
  const { sp } = make();
  assert.equal(sp.line(60), "");
  assert.equal(sp.isRunning(), false);
  sp.start();
  assert.equal(sp.isRunning(), true);
  assert.notEqual(sp.line(60), "");
  sp.stop();
  assert.equal(sp.isRunning(), false);
  assert.equal(sp.line(60), "");
  sp.stop();
});

test("English line: verb, elapsed time, tokens and the interrupt hint", () => {
  const { sp, clock } = make();
  sp.start({ phase: "thinking", startedAt: clock.now() - 12_000 });
  sp.set({ tokens: 3200 });
  const line = sp.line(100);
  const verbs = tList("verb.thinking");
  assert.ok(verbs.some(v => line.includes(`${v}${sym.ellipsis} (12s ${sym.dot} ${UP} 3.2k)`)), line);
  assert.ok(line.endsWith(`${sym.dot} Esc to interrupt`), line);
  assert.ok(stringWidth(line) <= 100);
});

test("Arabic line is right-aligned, shaped and ordered, with all its pieces", () => {
  const { sp, clock } = make({ lang: "ar" });
  sp.start({ phase: "thinking", startedAt: clock.now() - 12_000 });
  sp.set({ tokens: 3200 });
  const line = sp.line(60);
  assert.equal(stringWidth(line), 60);
  assert.ok(line.startsWith(" "));
  assert.ok(!/[\u2066-\u2069]/.test(line));
  assert.ok(line.includes("12"), line);
  assert.ok(line.includes("3.2k"), line);
  // the same words, shaped and reordered by the display layer, appear in the line
  assert.ok(line.includes(toVisual("للإيقاف", { dir: "rtl" })), line);
  assert.ok(line.includes(toVisual("Esc", { dir: "rtl" })), line);
  const thinking = tList("verb.thinking", "ar");
  assert.ok(thinking.length >= 4);
  assert.ok(thinking.some(v => line.includes(toVisual(v, { dir: "rtl" }))), line);
  assert.ok(line.endsWith(sym.think) || line.endsWith(sym.spinner[0]) || /[^\s]$/.test(line));
  assert.equal(line.trimEnd(), line);
});

test("verbs rotate every 4 s inside a phase, per phase and language", () => {
  const { sp, clock } = make();
  sp.start({ phase: "thinking" });
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const line = sp.line(100);
    const verb = tList("verb.thinking").find(v => line.includes(v + sym.ellipsis));
    assert.ok(verb, line);
    seen.add(verb);
    clock.advance(4000);
  }
  assert.equal(seen.size, tList("verb.thinking").length);
  const a = make();
  a.sp.start({ phase: "thinking" });
  const before = a.sp.line(100);
  a.clock.advance(3900);
  const noStats = l => l.slice(1).replace(/\s*\(.*?\)/, ""); // without the animated glyph and the counters
  assert.equal(noStats(a.sp.line(100)), noStats(before));
  for (const phase of ["waiting", "thinking", "writing", "tool"]) {
    const { sp: s2 } = make();
    s2.start({ phase });
    const line = s2.line(100);
    assert.ok(tList(`verb.${phase}`).some(v => line.includes(v + sym.ellipsis)), `${phase}: ${line}`);
  }
  const ar = make({ lang: "ar" });
  ar.sp.start({ phase: "writing" });
  assert.ok(tList("verb.writing", "ar").length >= 3);
  assert.ok(tList("verb.writing", "ar").some(v => ar.sp.line(100).includes(toVisual(v, { dir: "rtl" }))));
  ar.setLanguage("en");
  assert.ok(tList("verb.writing").some(v => ar.sp.line(100).includes(v)));
});

test("a label replaces the verb and a phase change takes effect at once", () => {
  const { sp } = make();
  sp.start({ phase: "tool", label: "Read(src/app.js)…" });
  assert.ok(sp.line(100).includes(`Read(src/app.js)${sym.ellipsis}`));
  sp.set({ label: "" });
  assert.ok(tList("verb.tool").some(v => sp.line(100).includes(v)));
  sp.set({ phase: "writing" });
  assert.ok(tList("verb.writing").some(v => sp.line(100).includes(v)));
  sp.set({ phase: "nonsense" });
  assert.ok(tList("verb.writing").some(v => sp.line(100).includes(v)));
});

test("the counters appear once there is something to show", () => {
  const { sp, clock } = make();
  sp.start({ phase: "thinking" });
  assert.ok(!sp.line(100).includes("("));
  clock.advance(1000);
  assert.ok(sp.line(100).includes("(1s)"));
  sp.set({ tokens: 12_500 });
  assert.ok(sp.line(100).includes(`(1s ${sym.dot} ${UP} 13k)`));
  sp.set({ tokens: 0 });
  assert.ok(!sp.line(100).includes(UP));
});

test("never wider than the width: parts are dropped, then the verb is cut", () => {
  for (const lang of ["en", "ar"]) {
    const { sp, clock } = make({ lang });
    sp.start({ phase: "thinking", startedAt: clock.now() - 75_000 });
    sp.set({ tokens: 123_456 });
    for (const width of [120, 80, 60, 50, 45, 40, 36, 30, 26, 22, 18, 14, 10, 8, 5, 3, 2, 1]) {
      const line = sp.line(width);
      assert.ok(stringWidth(line) <= width, `${lang} ${width}: ${JSON.stringify(stripAnsi(line))} is ${stringWidth(line)} wide`);
    }
  }
  const { sp } = make();
  sp.start({ phase: "tool", label: "A very long tool description that cannot possibly fit on one line of the terminal" });
  assert.ok(stringWidth(sp.line(40)) <= 40);
  assert.ok(sp.line(40).includes(sym.ellipsis));
  const wide = make({ lang: "ar" });
  wide.sp.start({ phase: "tool", label: "تشغيل الأوامر الطويلة جداً التي لا يمكن أن تتسع في سطر واحد من الطرفية أبداً" });
  for (const w of [60, 40, 25, 12]) assert.ok(stringWidth(wide.sp.line(w)) <= w, String(w));
});

test("the hint goes first when the line is tight, then the counters", () => {
  const { sp, clock } = make();
  sp.start({ phase: "thinking", startedAt: clock.now() - 65_000 });
  sp.set({ tokens: 3200 });
  const full = sp.line(200);
  assert.ok(full.includes("Esc to interrupt"));
  const verb = tList("verb.thinking").find(v => full.includes(v));
  const noHint = sp.line(stringWidth(full) - 4);
  assert.ok(!noHint.includes("interrupt") && noHint.includes("(1m 5s"), noHint);
  const bare = sp.line(stringWidth(`x ${verb}${sym.ellipsis}`) + 1);
  assert.ok(!bare.includes("(") && bare.includes(verb), bare);
});

test("frames tick every 80 ms while running and stop cleanly", () => {
  const { sp, clock, frames } = make();
  sp.start();
  assert.equal(frames.length, 1); // the first frame is immediate
  clock.advance(80);
  clock.advance(80);
  clock.advance(80);
  assert.equal(frames.length, 4);
  sp.stop();
  clock.advance(1000);
  assert.equal(frames.length, 4);
  assert.equal(clock.pending(), 0);
  sp.start();
  assert.equal(frames.length, 5);
  sp.start({ phase: "writing" }); // already running: only updates
  assert.equal(frames.length, 5);
  sp.stop();
});

test("the timer never keeps the process alive", () => {
  let unrefs = 0;
  const sp = createSpinner({
    onFrame() {},
    lang: () => "en",
    setTimer: () => ({ unref() { unrefs++; } }),
    clearTimer() {},
  });
  sp.start();
  assert.equal(unrefs, 1);
  sp.stop();
  const real = createSpinner({ onFrame() {}, lang: () => "en" });
  real.start();
  real.stop();
});

test("without colour the glyph cycles the theme's frames; with colour the star breathes", () => {
  const { sp, clock } = make();
  sp.start({ phase: "thinking" });
  const first = stripAnsi(sp.line(100))[0];
  assert.ok(sym.spinner.includes(first));
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(stripAnsi(sp.line(100))[0]);
    clock.advance(80);
  }
  assert.ok(seen.size >= Math.min(sym.spinner.length, 3));
  setColorLevel(3);
  try {
    const l0 = sp.line(100);
    assert.ok(l0.includes("\x1b[38;2;"), JSON.stringify(l0));
    assert.ok(stripAnsi(l0).startsWith(sym.think));
    clock.advance(1100);
    const l1 = sp.line(100);
    assert.notEqual(l0.slice(0, 30), l1.slice(0, 30));
    assert.ok(stringWidth(l1) <= 100);
  } finally {
    setColorLevel(0);
  }
});

test("the language is read on every line, not captured at creation", () => {
  const { sp, setLanguage } = make();
  sp.start({ phase: "thinking" });
  assert.ok(/[A-Za-z]/.test(sp.line(60)));
  setLanguage("ar");
  assert.ok(ARABIC_LETTERS.test(sp.line(60)));
  setLanguage("en");
  assert.ok(!ARABIC_LETTERS.test(sp.line(60)));
});

test("the interface language outside the spinner is left alone", async () => {
  const { getLang } = await import("../../src/i18n/index.js");
  const { sp } = make({ lang: "ar" });
  sp.start();
  sp.line(60);
  assert.equal(getLang(), "en");
});
