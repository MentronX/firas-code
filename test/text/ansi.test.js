import test from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, hasAnsi, scanEscape, classify, PLAIN, applySgr, withLink, transition, styleKey, LINK_CLOSE } from "../../src/text/ansi.js";

test("stripAnsi removes SGR, cursor, OSC and charset sequences", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripAnsi("\x1b[1;38;2;1;2;3mx\x1b[m"), "x");
  assert.equal(stripAnsi("a\x1b[2Kb\x1b[10;5Hc"), "abc");
  assert.equal(stripAnsi("\x1b]8;;http://a.b\x07link\x1b]8;;\x07"), "link");
  assert.equal(stripAnsi("\x1b]8;id=1;http://a.b\x1b\\link\x1b]8;;\x1b\\"), "link");
  assert.equal(stripAnsi("\x1b]0;title\x07text"), "text");
  assert.equal(stripAnsi("\x1b(Bx\x1b=y\x1b7z"), "xyz");
  assert.equal(stripAnsi("\x1b[?25lhidden\x1b[?25h"), "hidden");
});

test("malformed or truncated sequences never leave debris", () => {
  assert.equal(stripAnsi("a\x1b"), "a");
  assert.equal(stripAnsi("x\x1b[31"), "x");
  assert.equal(stripAnsi("x\x1b]8;;unterminated"), "x");
  assert.equal(stripAnsi("\x1b\x1b[31mq"), "q");
});

test("strings without escapes are returned as is", () => {
  const s = "plain مرحبا text";
  assert.equal(stripAnsi(s), s);
  assert.equal(hasAnsi(s), false);
  assert.equal(hasAnsi("a\x1b[0m"), true);
});

test("scanEscape returns the end of the sequence", () => {
  assert.equal(scanEscape("\x1b[31mabc", 0), 5);
  assert.equal(scanEscape("ab\x1b[0m", 2), 6);
  assert.equal(scanEscape("\x1b]8;;u\x07z", 0), 7);
  assert.equal(scanEscape("\x1b]8;;u\x1b\\z", 0), 8);
});

test("classify tells styles, links and everything else apart", () => {
  assert.deepEqual(classify("\x1b[1;31m"), { kind: "sgr", params: "1;31" });
  assert.deepEqual(classify("\x1b[m"), { kind: "sgr", params: "" });
  assert.equal(classify("\x1b[2K").kind, "other");
  assert.equal(classify("\x1b[?25l").kind, "other");
  assert.equal(classify("\x1b]8;;http://x\x07").kind, "link");
  assert.equal(classify("\x1b]8;;http://x\x07").open, true);
  assert.equal(classify("\x1b]8;;\x07").open, false);
  assert.equal(classify("\x1b]0;t\x07").kind, "other");
});

test("applySgr tracks attributes and colours", () => {
  let st = applySgr(PLAIN, "1;31");
  assert.equal(st.b, 1);
  assert.equal(st.fg, "31");
  st = applySgr(st, "3;4");
  assert.equal(st.i, 1);
  assert.equal(st.u, "4");
  st = applySgr(st, "22;39");
  assert.equal(st.b, 0);
  assert.equal(st.fg, "");
  assert.equal(st.i, 1);
  assert.equal(styleKey(applySgr(st, "0")), styleKey(PLAIN));
  assert.equal(styleKey(applySgr(st, "")), styleKey(PLAIN));
  assert.equal(applySgr(PLAIN, "38;2;10;20;30").fg, "38;2;10;20;30");
  assert.equal(applySgr(PLAIN, "48;5;200").bg, "48;5;200");
  assert.equal(applySgr(PLAIN, "90").fg, "90");
  assert.equal(applySgr(PLAIN, "103").bg, "103");
  assert.equal(applySgr(PLAIN, "1;38;5;9;4").u, "4");
  assert.equal(applySgr(applySgr(PLAIN, "2"), "22").d, 0);
});

test("applySgr does not mutate the previous state", () => {
  const a = applySgr(PLAIN, "1");
  const b = applySgr(a, "31");
  assert.equal(a.fg, "");
  assert.equal(PLAIN.b, 0);
  assert.equal(b.b, 1);
});

test("transition emits only what changed", () => {
  const boldRed = applySgr(PLAIN, "1;31");
  assert.equal(transition(PLAIN, PLAIN), "");
  assert.equal(transition(PLAIN, boldRed), "\x1b[1;31m");
  assert.equal(transition(boldRed, PLAIN), "\x1b[22;39m");
  assert.equal(transition(boldRed, applySgr(boldRed, "32")), "\x1b[32m");
  const dimBold = applySgr(PLAIN, "1;2");
  assert.equal(transition(dimBold, applySgr(PLAIN, "1")), "\x1b[22;1m");
  assert.equal(transition(applySgr(PLAIN, "41"), PLAIN), "\x1b[49m");
});

test("transition handles hyperlinks", () => {
  const link = withLink(PLAIN, true, "\x1b]8;;http://x\x07");
  assert.equal(transition(PLAIN, link), "\x1b]8;;http://x\x07");
  assert.equal(transition(link, PLAIN), LINK_CLOSE);
  const bold = applySgr(link, "1");
  assert.equal(transition(link, bold), "\x1b[1m");
});
