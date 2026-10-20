import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { renderBanner } from "../../src/ui/banner.js";
import { setColorLevel, sym } from "../../src/ui/theme.js";
import { setArabicMode, stringWidth, stripAnsi } from "../../src/text/display.js";
import { NAME, NAME_AR } from "../../src/brand.js";

setArabicMode("on");
setColorLevel(0);

const base = { cwd: path.join(os.homedir(), "Projects", "my-app"), effort: "medium", mode: "default", version: "2.0.0", date: new Date(2026, 9, 17) };
const text = lines => lines.map(stripAnsi).join("\n");

test("banner is aligned and readable in both languages", () => {
  for (const lang of ['en','ar']) {
    const lines = renderBanner({ ...base, width: 100, lang });
    assert.equal(lines[0], '');
    assert.ok(lines.length > 4);
    assert.ok(lines.every(line => stringWidth(line) <= 100));
    assert.ok(lines.some(line => line.includes(NAME)));
    assert.ok(lines.some(line => line.includes('v2.0.0')));
  }
});

test("the welcome mark is an F, not an E", () => {
  // The mark is the only run of full blocks in the card. Its rows are the F's five strokes:
  // top bar, stem, middle bar, stem, stem. A full bottom row would turn it into an E, and half
  // blocks (▀) break into pieces in terminals that draw them with a gap.
  for (const lang of ['en','ar']) {
    const lines = renderBanner({ ...base, width: 100, lang }).map(stripAnsi);
    const rows = lines.map(line => (line.match(/█+/g) || [])[0]?.length).filter(Boolean);
    assert.deepEqual(rows.slice(0, 5), [7, 2, 5, 2, 2], `${lang}: F strokes`);
    assert.ok(!lines.some(line => line.includes('▀')), `${lang}: no half blocks in the mark`);
  }
});
