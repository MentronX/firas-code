import test from "node:test";
import assert from "node:assert/strict";
import {
  setArabicMode, stripAnsi, stringWidth, wrapLogical, toVisual, shapeLine, layoutParagraph, layoutInput, moveCursorVisual,
  visualToLogicalMap, hasRtl,
} from "../../src/text/display.js";

setArabicMode("on");

// Garbage in, no crash and sane numbers out: random strings built from the awkward parts of Unicode.
const CODES = [
  0x61, 0x62, 0x20, 0x20, 0x645, 0x631, 0x62d, 0x628, 0x627, 0x644, 0x623, 0x64e, 0x651, 0x640, 0x5d0, 0x5d1, 0x31, 0x32, 0x663,
  0x28, 0x29, 0x5b, 0x5d, 0x3c, 0x3e, 0x22, 0x2c, 0x2e, 0x3a, 0x2d, 0x25, 0x24, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b,
  0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x301, 0xd83d, 0xde00, 0x1f600, 0x1f468, 0x1f3fd, 0xfe0f, 0x65e5, 0x672c,
  0x0a, 0x09, 0xad, 0xfefb, 0x2248, 0xe01, 0xe47, 0x1112, 0x1161, 0x11ab, 0x1f1ee, 0x1f1f6,
];
const PIECES = ["\x1b[31m", "\x1b[0m", "\x1b[1m", "\x1b[22m", "\x1b]8;;http://x\x07", "\x1b]8;;\x07", "\x1b[2K", "\x1b", "\x1b["];
const POOL = [...CODES.map(c => String.fromCodePoint(c)), ...PIECES];
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random garbage never crashes and keeps its invariants", () => {
  for (const seed of [1, 2, 3]) {
    const rnd = prng(seed);
    for (let n = 0; n < 700; n++) {
      let s = "";
      const len = Math.floor(rnd() * 25);
      for (let i = 0; i < len; i++) s += POOL[Math.floor(rnd() * POOL.length)];
      const w = 1 + Math.floor(rnd() * 30);
      const ctx = JSON.stringify({ s, w });

      for (const l of wrapLogical(s, w, { firstIndent: rnd() < 0.3 ? "- " : "", indent: rnd() < 0.3 ? "  " : "" })) {
        assert.ok(stringWidth(l) <= Math.max(w, 4), "wrap " + ctx);
      }
      for (const l of layoutParagraph(s, w)) assert.ok(stringWidth(l) <= Math.max(w, 4), "paragraph " + ctx);

      const map = visualToLogicalMap(s);
      for (const m of map) assert.ok(m >= 0 && m <= s.length, "map range " + ctx);
      if (hasRtl(s) && !LONE_SURROGATE.test(s)) {
        const visual = s.split("\n").map(l => stripAnsi(toVisual(l)).replace(/\r$/, "")).join("\n");
        assert.equal(map.length, visual.length, "map length " + ctx);
      }

      const cursor = Math.floor(rnd() * (s.length + 1));
      const width = Math.max(3, w);
      const r = layoutInput(s, cursor, { width, prefix: rnd() < 0.5 ? "> " : "" });
      assert.ok(r.cursor.row >= 0 && r.cursor.row < r.lines.length, "cursor row " + ctx);
      assert.ok(r.cursor.col >= 0 && r.cursor.col <= width, "cursor col " + ctx);
      for (const dir of ["left", "right"]) {
        const m = moveCursorVisual(s, cursor, dir, rnd() < 0.5 ? { width } : undefined);
        assert.ok(Number.isInteger(m) && m >= 0 && m <= s.length, "move " + ctx);
      }
      shapeLine(s);
    }
  }
});
