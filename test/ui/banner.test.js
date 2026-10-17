import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { renderBanner } from "../../src/ui/banner.js";
import { setColorLevel, sym } from "../../src/ui/theme.js";
import { setArabicMode, stringWidth, stripAnsi, toVisual } from "../../src/text/display.js";
import { NAME, NAME_AR } from "../../src/brand.js";
import { tList, withLang, modeLabel, effortLabel } from "../../src/ui/strings.js";

setArabicMode("on");
setColorLevel(0);

const base = { cwd: path.join(os.homedir(), "Projects", "my-app"), effort: "medium", mode: "default", version: "2.0.0", date: new Date(2026, 9, 17) };
const text = lines => lines.map(stripAnsi).join("\n");
const rv = s => toVisual(s, { dir: "rtl" });

test("a blank line before and after, and never wider than the terminal", () => {
  for (const lang of ["en", "ar"]) {
    for (const width of [20, 24, 30, 40, 59, 60, 61, 72, 80, 100, 140, 220]) {
      const lines = renderBanner({ ...base, width, lang });
      assert.equal(lines[0], "");
      assert.equal(lines.at(-1), "");
      assert.ok(lines.length > 4);
      for (const l of lines) assert.ok(stringWidth(l) <= width, `${lang} ${width}: ${JSON.stringify(stripAnsi(l))} is ${stringWidth(l)}`);
      assert.ok(!/[\u2066-\u2069\u200e\u200f]/.test(lines.join("")), "no direction marks may reach the terminal");
    }
  }
});

test("English card: boxed, mark on the left, names in both scripts, version, folder, settings and a tip", () => {
  const lines = renderBanner({ ...base, width: 100, lang: "en" });
  const plain = lines.map(stripAnsi);
  const box = plain.filter(l => l.includes(sym.boxV) || l.includes(sym.boxTL) || l.includes(sym.boxBL));
  assert.ok(plain.some(l => l.trimStart().startsWith(sym.boxTL)));
  assert.ok(plain.some(l => l.trimStart().startsWith(sym.boxBL)));
  const widths = new Set(box.map(l => stringWidth(l)));
  assert.equal(widths.size, 1, "all card rows have the same width");
  assert.ok(box[0].startsWith("  ")); // the gutter
  const all = plain.join("\n");
  assert.ok(all.includes(NAME));
  assert.ok(all.includes(rv(NAME_AR)), all);
  assert.ok(all.includes("v2.0.0"));
  assert.ok(all.includes(path.join("~", "Projects", "my-app")));
  assert.ok(all.includes("effort: medium"));
  assert.ok(all.includes("mode: default"));
  assert.ok(all.includes("Tip: "));
  assert.ok(all.includes("type / for commands"));
  const titleRow = plain.find(l => l.includes(NAME));
  assert.ok(titleRow.indexOf(sym.boxV) < titleRow.indexOf(NAME));
  assert.ok(titleRow.trimEnd().endsWith(`v2.0.0${sym.boxV}`) || titleRow.includes("v2.0.0"));
  // the mark is drawn left of the text on the title row
  assert.ok(/^ {2}\S\s{2}\S{6}\s{3}Firas/.test(titleRow) || titleRow.indexOf(NAME) > 8, titleRow);
});

test("Arabic card is mirrored: mark and text hug the right edge, Arabic text is shaped and ordered", () => {
  const lines = renderBanner({ ...base, width: 100, lang: "ar" });
  const plain = lines.map(stripAnsi);
  const all = plain.join("\n");
  assert.ok(all.includes(rv(NAME_AR)), all);
  assert.ok(all.includes(NAME));
  assert.ok(all.includes(withLang("ar", () => rv(`${"الجهد"}: ${effortLabel("medium")}`)) ) || all.includes(rv(effortLabel("medium"))), all);
  assert.ok(all.includes(rv(withLang("ar", () => modeLabel("default")))));
  assert.ok(all.includes(rv("جلسة")) === false);
  const top = plain.find(l => l.includes(sym.boxTL));
  assert.equal(top.length - 1, stringWidth(top) - 1);
  assert.equal(stringWidth(top), 100 - 2, "the card ends two columns before the right edge");
  const titleRow = plain.find(l => l.includes(NAME));
  const markAt = titleRow.indexOf("█") >= 0 ? titleRow.indexOf("█") : titleRow.indexOf("#");
  assert.ok(markAt > titleRow.indexOf(NAME), "the mark sits on the right of the names");
  assert.ok(titleRow.indexOf("v2.0.0") < titleRow.indexOf(NAME), "the version sits on the far (left) side");
  const hint = plain.at(-2);
  assert.ok(hint.startsWith(" "), "the hint line is right-aligned");
  assert.ok(hint.includes(rv("لعرض الأوامر")), hint);
  assert.ok(hint.includes("/"));
});

test("below 60 columns: compact lines without the box or the mark", () => {
  for (const lang of ["en", "ar"]) {
    const lines = renderBanner({ ...base, width: 59, lang });
    const all = text(lines);
    assert.ok(!all.includes(sym.boxTL) && !all.includes(sym.boxV) && !all.includes("█") && !all.includes("######"));
    assert.ok(all.includes(NAME));
    assert.ok(all.includes("v2.0.0"));
    assert.ok(lines.length >= 6);
  }
  const narrow = text(renderBanner({ ...base, width: 22, lang: "en" }));
  assert.ok(narrow.includes(NAME));
  assert.ok(!narrow.includes("v2.0.0"), "the version gives way before the name is cut");
});

test("resumed sessions say so, in both languages", () => {
  const en = text(renderBanner({ ...base, width: 100, lang: "en", resumed: true }));
  assert.ok(en.includes("resumed session"));
  assert.ok(!text(renderBanner({ ...base, width: 100, lang: "en" })).includes("resumed session"));
  const ar = text(renderBanner({ ...base, width: 100, lang: "ar", resumed: true }));
  assert.ok(ar.includes(rv("جلسة مستأنفة")), ar);
  const small = text(renderBanner({ ...base, width: 40, lang: "en", resumed: true }));
  assert.ok(small.includes("resumed session"));
});

test("the tip changes once a day, deterministically, and cycles through all of them", () => {
  const tipOf = (date, lang = "en") => text(renderBanner({ ...base, width: 100, lang, date })).split("\n").filter(l => l.includes("Tip:") || l.includes(rv("نصيحة")));
  const day = n => new Date(2026, 0, 1 + n, 15, 30);
  assert.deepEqual(tipOf(day(0)), tipOf(new Date(2026, 0, 1, 2, 5)));
  const seen = new Set();
  for (let n = 0; n < 8; n++) seen.add(tipOf(day(n)).join("|"));
  assert.equal(seen.size, 8);
  assert.deepEqual(tipOf(day(0)), tipOf(day(8)));
  assert.notDeepEqual(tipOf(day(0)), tipOf(day(1)));
  assert.equal(withLang("en", () => tList("tip")).length, 8);
  assert.equal(withLang("ar", () => tList("tip")).length, 8);
  assert.ok(tipOf(day(2), "ar").length >= 1);
  assert.deepEqual(text(renderBanner({ ...base, width: 100, lang: "en", date: day(3).getTime() })), text(renderBanner({ ...base, width: 100, lang: "en", date: day(3) })));
});

test("every tip fits and is readable at the narrowest card", () => {
  for (const lang of ["en", "ar"]) {
    for (let n = 0; n < 8; n++) {
      const lines = renderBanner({ ...base, width: 60, lang, date: new Date(2026, 0, 1 + n) });
      for (const l of lines) assert.ok(stringWidth(l) <= 60);
      const all = text(lines);
      assert.ok(!all.includes(sym.ellipsis), `day ${n} ${lang}: a tip was cut short\n${all}`);
    }
  }
});

test("folder: ~ for the home directory, long paths keep their tail", () => {
  assert.ok(text(renderBanner({ ...base, width: 100, lang: "en", cwd: os.homedir() })).includes("~"));
  const outside = path.parse(os.homedir()).root + path.join("srv", "data");
  assert.ok(text(renderBanner({ ...base, width: 100, lang: "en", cwd: outside })).includes(path.join("srv", "data")));
  const deep = path.join(os.homedir(), "a".repeat(30), "b".repeat(30), "c".repeat(30), "final-folder");
  const shown = text(renderBanner({ ...base, width: 70, lang: "en", cwd: deep }));
  assert.ok(shown.includes(sym.ellipsis));
  assert.ok(shown.includes("final-folder"));
  const arabic = text(renderBanner({ ...base, width: 100, lang: "ar", cwd: outside }));
  assert.ok(arabic.includes(path.join("srv", "data")), "a Latin path stays in one piece inside the Arabic card");
});

test("effort and mode are shown in the reader's language", () => {
  const en = text(renderBanner({ ...base, width: 100, lang: "en", effort: "xhigh", mode: "acceptEdits" }));
  assert.ok(en.includes("effort: extra high") && en.includes("mode: accept edits"), en);
  const ar = text(renderBanner({ ...base, width: 100, lang: "ar", effort: "max", mode: "plan" }));
  assert.ok(ar.includes(rv("الأقصى")) && ar.includes(rv("تخطيط")), ar);
  const unknown = text(renderBanner({ ...base, width: 100, lang: "en", effort: "turbo", mode: "custom" }));
  assert.ok(unknown.includes("turbo") && unknown.includes("custom"));
  const defaults = text(renderBanner({ width: 100, lang: "en", version: "1" }));
  assert.ok(defaults.includes("effort: medium") && defaults.includes("mode: default"));
});

test("works with Arabic shaping switched off and with colours", () => {
  setArabicMode("off");
  try {
    const lines = renderBanner({ ...base, width: 80, lang: "ar" });
    for (const l of lines) assert.ok(stringWidth(l) <= 80);
    assert.ok(!/[\u2066-\u2069]/.test(lines.join("")));
  } finally {
    setArabicMode("on");
  }
  setColorLevel(3);
  try {
    const lines = renderBanner({ ...base, width: 80, lang: "en" });
    assert.ok(lines.join("").includes("\x1b[38;2;"));
    for (const l of lines) assert.ok(stringWidth(l) <= 80);
    const widths = new Set(lines.filter(l => stripAnsi(l).includes(sym.boxV)).map(stringWidth));
    assert.equal(widths.size, 1);
  } finally {
    setColorLevel(0);
  }
});

test("the version may arrive with a leading v and the width may be missing", () => {
  assert.ok(text(renderBanner({ ...base, version: "v3.1.4", lang: "en" })).includes("v3.1.4"));
  assert.ok(!text(renderBanner({ ...base, version: "v3.1.4", lang: "en" })).includes("vv3"));
  const lines = renderBanner({ lang: "en", version: "1.0.0" });
  assert.ok(lines.length > 4);
});
