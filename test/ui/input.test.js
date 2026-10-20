import test from "node:test";
import assert from "node:assert/strict";
import {
  createState, reduce, render, menuOf, viewOf, applyFileResults, expandText, readPrompt,
} from "../../src/ui/input.js";
import { createScreen } from "../../src/ui/screen.js";
import { setArabicMode, stringWidth, stripAnsi, layoutInput, toVisual } from "../../src/text/display.js";
import { setColorLevel, sym } from "../../src/ui/theme.js";
import { setLang } from "../../src/i18n/index.js";
import { fakeScreen, fakeTTY, fakeStdin, fakeClock, normKey } from "./term-helpers.js";
import { parseKeys } from "../../src/ui/keys.js";

setArabicMode("on");
setColorLevel(0);
setLang("en");

const ARABIC_LETTERS = /[\u0600-\u06ff\ufb50-\ufeff]/;

const CHIP0 = String.fromCharCode(0xe000);
const COMMANDS = [
  { name: "help", description: "Show what I can do" },
  { name: "effort", description: "Set how deeply I think" },
  { name: "exit", description: "Leave" },
  { name: "/exit-all", description: "Leave everything" },
  { name: "copy", description: "Copy the last answer" },
  { name: "compact", description: "Summarize the conversation" },
];

const ctxOf = (over = {}) => ({ width: 40, height: 24, prefixWidth: 2, commands: COMMANDS, hasFiles: false, mask: null, now: 1000, ...over });

/** Feeds keys (shorthand strings or key objects) and collects every effect. */
function press(state, ctx, ...keys) {
  let s = state;
  const effects = [];
  for (const k of keys) {
    const r = reduce(s, normKey(k), ctx);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects };
}

function typeText(state, ctx, text) {
  let s = state;
  const effects = [];
  for (const ch of text) {
    // a typed line break arrives as LF = ctrl+return (keys.js)
    const key = ch === "\n" ? { name: "return", ctrl: true, alt: false, shift: false, seq: ch } : { name: "char", ch, ctrl: false, alt: false, shift: false, seq: ch };
    const r = reduce(s, key, ctx);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects };
}

const typed = (text, ctx = ctxOf(), init) => typeText(createState(init), ctx, text).s;
const line = (s, i = 0, ctx = ctxOf(), o = {}) => stripAnsi(render(s, ctx, { prefix: "> ", ...o }).lines[i]);

// ---------------------------------------------------------------------------------------------
// basic editing

test("typing, cursor keys, Home/End, Backspace and Delete", () => {
  const ctx = ctxOf();
  let s = typed("hello", ctx);
  assert.deepEqual([s.text, s.cursor], ["hello", 5]);
  s = press(s, ctx, "left", "left").s;
  assert.equal(s.cursor, 3);
  s = press(s, ctx, "backspace").s;
  assert.deepEqual([s.text, s.cursor], ["helo", 2]);
  s = press(s, ctx, "delete").s;
  assert.deepEqual([s.text, s.cursor], ["heo", 2]);
  s = press(s, ctx, "home").s;
  assert.equal(s.cursor, 0);
  s = press(s, ctx, "backspace", "left").s;
  assert.deepEqual([s.text, s.cursor], ["heo", 0]);
  s = press(s, ctx, "end").s;
  assert.equal(s.cursor, 3);
  s = press(s, ctx, "delete", "right").s;
  assert.deepEqual([s.text, s.cursor], ["heo", 3]);
  s = press(s, ctx, "ctrl+a").s;
  assert.equal(s.cursor, 0);
  s = press(s, ctx, "ctrl+e").s;
  assert.equal(s.cursor, 3);
  s = press(s, ctx, "ctrl+b", "ctrl+b", "ctrl+f").s;
  assert.equal(s.cursor, 2);
  s = press(s, ctx, "ctrl+h").s;
  assert.equal(s.text, "ho");
  s = press(s, ctx, "ctrl+d").s;
  assert.equal(s.text, "h");
});

test("Home/End work on the logical line, not the whole text", () => {
  const ctx = ctxOf();
  let s = typed("one\ntwo\nthree", ctx);
  s = press(s, ctx, "home").s;
  assert.equal(s.cursor, 8);
  s = press(s, ctx, "left", "home").s;
  assert.equal(s.cursor, 4);
  s = press(s, ctx, "end").s;
  assert.equal(s.cursor, 7);
});

test("Backspace and Delete remove whole clusters", () => {
  const ctx = ctxOf();
  let s = typed("a" + "م" + "َ", ctx); // alef, meem + fatha
  assert.equal(s.text.length, 3);
  s = press(s, ctx, "backspace").s;
  assert.equal(s.text, "a", "meem and its mark go together");
  s = typed("x😀y", ctx);
  s = press(s, ctx, "left", "backspace").s;
  assert.equal(s.text, "xy");
  s = typed("😀", ctx);
  s = press(s, ctx, "home", "delete").s;
  assert.equal(s.text, "");
  s = typed("👨\u200d👩\u200d👧!", ctx);
  s = press(s, ctx, "backspace", "backspace").s;
  assert.equal(s.text, "");
  s = typed("e\u0301x", ctx);
  s = press(s, ctx, "home", "delete").s;
  assert.equal(s.text, "x");
  s = typed("لا", ctx); // lam + alef are two code points and go one at a time
  s = press(s, ctx, "backspace").s;
  assert.equal(s.text, "ل");
});

test("control characters never get into the text, tabs become spaces", () => {
  const ctx = ctxOf();
  let s = typed("a", ctx);
  s = press(s, ctx, { name: "char", ch: "\x07" }, { name: "char", ch: "\t" }, { name: "char", ch: "\x1b" }).s;
  assert.equal(s.text, "a  ".slice(0, 1) + "  ".slice(0, 2));
  s = press(createState(), ctx, { name: "char", ch: CHIP0 }).s;
  assert.equal(s.text, "", "a private-use sentinel cannot be typed");
  assert.equal(createState({ initial: "a\r\nb\tc" + CHIP0 }).text, "a\nb  c");
});

// ---------------------------------------------------------------------------------------------
// Enter, newlines, submit

test("Enter submits the trimmed text; blank input is not submitted", () => {
  const ctx = ctxOf();
  let r = press(typed("  fix the bug \n ", ctx), ctx, "enter");
  assert.deepEqual(r.effects, [{ type: "submit", text: "fix the bug" }]);
  r = press(createState(), ctx, "enter");
  assert.deepEqual(r.effects, []);
  r = press(typed("   \n  ", ctx), ctx, "enter");
  assert.deepEqual(r.effects, []);
});

test("newlines: backslash+Enter, Alt+Enter, Shift+Enter, Ctrl+Enter / LF and Ctrl+J", () => {
  const ctx = ctxOf();
  let s = typed("one\\", ctx);
  let r = press(s, ctx, "enter");
  assert.equal(r.s.text, "one\n");
  assert.deepEqual(r.effects, []);
  for (const k of ["alt+enter", "shift+enter", "ctrl+enter", "ctrl+j"]) {
    r = press(typed("a", ctx), ctx, k);
    assert.equal(r.s.text, "a\n", k);
    assert.deepEqual(r.effects, [], k);
  }
  s = typed("ab", ctx);
  s = press(s, ctx, "left", "alt+enter").s;
  assert.deepEqual([s.text, s.cursor], ["a\nb", 2]);
  s = typed("a\\b", ctx);
  s = press(s, ctx, "left", "enter").s; // the backslash is before the caret
  assert.equal(s.text, "a\nb");
  s = typed("path\\to", ctx);
  assert.deepEqual(press(s, ctx, "enter").effects, [{ type: "submit", text: "path\\to" }]);
});

test("a submitted text keeps its inner newlines and loses surrounding blanks", () => {
  const ctx = ctxOf();
  const s = typed("a\n\nb", ctx);
  assert.deepEqual(press(s, ctx, "enter").effects, [{ type: "submit", text: "a\n\nb" }]);
});

// ---------------------------------------------------------------------------------------------
// vertical movement and history

test("Up/Down move between visual rows keeping the column", () => {
  const ctx = ctxOf({ width: 12 });
  let s = typed("aaaa bbbb cccc dddd", ctx);
  assert.equal(s.cursor, 19);
  s = press(s, ctx, "up").s;
  assert.equal(s.cursor, 9);
  s = press(s, ctx, "down").s;
  assert.equal(s.cursor, 19);
  s = press(s, ctx, "home", "up").s;
  assert.equal(s.cursor, 0);
  s = typed("one\ntwo three\nx", ctx);
  s = press(s, ctx, "up").s;
  assert.equal(s.text.slice(0, s.cursor).split("\n").length, 2);
  s = press(s, ctx, "up").s;
  assert.equal(s.cursor, 1, "the column is kept as far as the row allows");
  s = press(s, ctx, "down", "down").s;
  assert.equal(s.cursor, s.text.length);
});

test("the wanted column survives short rows in between", () => {
  const ctx = ctxOf({ width: 40 });
  let s = typed("abcdefgh\nab\nabcdefgh", ctx);
  s = press(s, ctx, "left", "left", "left").s; // col 5 of the last row
  assert.equal(s.cursor - s.text.lastIndexOf("\n") - 1, 5);
  s = press(s, ctx, "up").s;
  assert.equal(s.cursor, 9 + 2, "clamped to the end of the short row");
  s = press(s, ctx, "up").s;
  assert.equal(s.cursor, 5, "and back to the remembered column");
});

test("at the first row Up browses history and keeps the draft; Down comes back", () => {
  const ctx = ctxOf();
  const init = { history: ["first", "second", "third"] };
  let s = typed("draft", ctx, init);
  s = press(s, ctx, "left", "left").s;
  s = press(s, ctx, "up").s;
  assert.equal(s.text, "third");
  s = press(s, ctx, "up").s;
  assert.equal(s.text, "second");
  s = press(s, ctx, "up", "up").s;
  assert.equal(s.text, "first");
  assert.equal(s.cursor, 0, "nothing older: the caret jumps to the start");
  s = press(s, ctx, "down").s;
  assert.equal(s.text, "second");
  s = press(s, ctx, "down", "down").s;
  assert.deepEqual([s.text, s.cursor], ["draft", 3], "the draft and the caret are restored");
  assert.equal(s.histIndex, null);
  s = press(s, ctx, "down").s;
  assert.equal(s.cursor, 5, "nothing newer: the caret jumps to the end");
});

test("history entries with several lines are walked row by row, then entry by entry", () => {
  const ctx = ctxOf();
  let s = createState({ history: ["old", "line1\nline2"] });
  s = press(s, ctx, "up").s;
  assert.equal(s.text, "line1\nline2");
  s = press(s, ctx, "up").s;
  assert.equal(s.text, "line1\nline2");
  assert.equal(s.cursor <= 5, true);
  s = press(s, ctx, "up").s;
  assert.equal(s.text, "old");
  assert.equal(createState({ history: [] }).hist.length, 0);
  const none = press(createState(), ctx, "up", "down").s;
  assert.equal(none.text, "");
});

test("Esc: closes a menu first, otherwise clears the text, otherwise nothing", () => {
  const ctx = ctxOf();
  let s = typed("/he", ctx);
  assert.ok(menuOf(s, ctx));
  s = press(s, ctx, "escape").s;
  assert.equal(menuOf(s, ctx), null);
  assert.equal(s.text, "/he");
  s = press(s, ctx, "escape").s;
  assert.equal(s.text, "");
  const r = press(s, ctx, "escape");
  assert.deepEqual(r.effects, []);
  let h = press(createState({ history: ["old"] }), ctx, "up").s;
  h = press(h, ctx, "escape").s;
  assert.deepEqual([h.text, h.histIndex], ["", null]);
});

// ---------------------------------------------------------------------------------------------
// kill ring and words

test("Ctrl+W, Ctrl+K, Ctrl+U, Alt+D and Ctrl+Y", () => {
  const ctx = ctxOf();
  let s = typed("foo bar baz", ctx);
  s = press(s, ctx, "ctrl+w").s;
  assert.equal(s.text, "foo bar ");
  s = press(s, ctx, "ctrl+w").s;
  assert.equal(s.text, "foo ");
  s = press(s, ctx, "ctrl+y").s;
  assert.equal(s.text, "foo bar ");
  s = typed("one two three", ctx);
  s = press(s, ctx, "alt+b", "alt+b").s;
  assert.equal(s.cursor, 4);
  s = press(s, ctx, "ctrl+k").s;
  assert.equal(s.text, "one ");
  s = press(s, ctx, "ctrl+y", "ctrl+y").s;
  assert.equal(s.text, "one two threetwo three");
  s = typed("a b c", ctx);
  s = press(s, ctx, "home", "alt+d").s;
  assert.equal(s.text, " b c");
  s = typed("line one\nline two", ctx);
  s = press(s, ctx, "ctrl+u").s;
  assert.equal(s.text, "line one\n");
  s = press(s, ctx, "ctrl+u").s;
  assert.equal(s.text, "line one", "at the start of a line Ctrl+U joins it with the previous one");
  s = typed("ab\ncd", ctx);
  s = press(s, ctx, "up", "ctrl+k").s;
  assert.equal(s.text, "abcd", "at the end of a line Ctrl+K joins the next one");
  s = press(s, ctx, "home", "right", "ctrl+k").s;
  assert.equal(s.text, "a");
  s = press(s, ctx, "ctrl+y").s;
  assert.equal(s.text, "abcd", "the killed newline and text come back");
  assert.equal(press(typed("x", ctx), ctx, "ctrl+y").s.text, "x", "nothing killed yet: nothing to yank");
});

test("Ctrl+Backspace / Alt+Backspace delete a word, Ctrl+Delete the next one", () => {
  const ctx = ctxOf();
  let s = typed("alpha beta", ctx);
  s = press(s, ctx, "ctrl+backspace").s;
  assert.equal(s.text, "alpha ");
  s = press(s, ctx, "alt+backspace").s;
  assert.equal(s.text, "");
  s = typed("alpha beta", ctx);
  s = press(s, ctx, "home", "ctrl+delete").s;
  assert.equal(s.text, " beta");
});

test("words: letters, digits and underscore; punctuation stops them; Arabic words count", () => {
  const ctx = ctxOf();
  let s = typed("src/app_main.js:42", ctx);
  const stops = [];
  for (let i = 0; i < 8; i++) { s = press(s, ctx, "alt+b").s; stops.push(s.cursor); }
  assert.deepEqual(stops, [16, 13, 4, 0, 0, 0, 0, 0]);
  s = typed("مرحبا بك في فراس", ctx);
  s = press(s, ctx, "alt+b").s;
  assert.equal(s.cursor, 12);
  s = press(s, ctx, "alt+b").s;
  assert.equal(s.cursor, 9);
  s = press(s, ctx, "alt+f").s;
  assert.equal(s.cursor, 11);
});

test("Ctrl+Left/Right jump words in the VISUAL direction", () => {
  const ctx = ctxOf();
  let s = typed("one two three", ctx);
  s = press(s, ctx, "ctrl+left").s;
  assert.equal(s.cursor, 8);
  s = press(s, ctx, "ctrl+left").s;
  assert.equal(s.cursor, 4);
  s = press(s, ctx, "ctrl+right").s;
  assert.equal(s.cursor, 7);
  s = press(s, ctx, "alt+right").s;
  assert.equal(s.cursor, 13);
  s = press(s, ctx, "ctrl+right").s;
  assert.equal(s.cursor, 13);
  // in an Arabic sentence "left" goes towards the END of the text
  const ar = typed("مرحبا بك في", ctx);
  let a = press(ar, ctx, "home").s;
  assert.equal(a.cursor, 0);
  a = press(a, ctx, "ctrl+left").s;
  assert.ok(a.cursor > 0 && a.cursor <= 5, `got ${a.cursor}`);
  a = press(a, ctx, "ctrl+left").s;
  assert.ok(a.cursor > 5, `got ${a.cursor}`);
  const back = press(a, ctx, "ctrl+right").s;
  assert.ok(back.cursor < a.cursor);
});

test("arrow keys in Arabic text move one glyph in the visual direction", () => {
  const ctx = ctxOf();
  let s = typed("مرحبا", ctx);
  s = press(s, ctx, "home").s;
  s = press(s, ctx, "left").s;
  assert.equal(s.cursor, 1);
  s = press(s, ctx, "left", "left").s;
  assert.equal(s.cursor, 3);
  s = press(s, ctx, "right").s;
  assert.equal(s.cursor, 2);
});

// ---------------------------------------------------------------------------------------------
// Ctrl+C / Ctrl+D / hooks

test("Ctrl+C: clears text and arms a 2 s hint; on empty text it exits", () => {
  const ctx = ctxOf();
  let r = press(typed("some draft", ctx), ctx, "ctrl+c");
  assert.equal(r.s.text, "");
  assert.equal(r.s.armUntil, 3000);
  assert.deepEqual(r.effects, [{ type: "hint", ms: 2000 }]);
  r = press(r.s, ctx, "ctrl+c");
  assert.deepEqual(r.effects, [{ type: "exit" }]);
  r = press(createState(), ctx, "ctrl+c");
  assert.deepEqual(r.effects, [{ type: "exit" }]);
  const armed = press(typed("x", ctx), ctx, "ctrl+c").s;
  const other = press(armed, ctx, "a").s;
  assert.equal(other.armUntil, 0, "typing dismisses the hint");
});

test("Ctrl+D exits on empty text and deletes forward otherwise", () => {
  const ctx = ctxOf();
  assert.deepEqual(press(createState(), ctx, "ctrl+d").effects, [{ type: "exit" }]);
  const r = press(typed("abc", ctx), ctx, "home", "ctrl+d");
  assert.equal(r.s.text, "bc");
  assert.deepEqual(r.effects, []);
});

test("Shift+Tab, Ctrl+O and Ctrl+L become effects and leave the text alone; Ctrl+T does nothing", () => {
  const ctx = ctxOf();
  const r = press(typed("abc", ctx), ctx, "backtab", "shift+backtab", "ctrl+t", "ctrl+o", "ctrl+l");
  assert.deepEqual(r.effects.map(e => e.type), ["shiftTab", "shiftTab", "expand", "redraw"]);
  assert.equal(r.s.text, "abc");
});

test("keys the editor does not use are ignored", () => {
  const ctx = ctxOf();
  const base = typed("abc", ctx);
  for (const k of ["pageup", "pagedown", "insert", "ctrl+x", "ctrl+z", "alt+x", "ctrl+alt+a", { name: "f5" }, { name: "unknown" }]) {
    const r = press(base, ctx, k);
    assert.equal(r.s.text, "abc", JSON.stringify(k));
    assert.deepEqual(r.effects, [], JSON.stringify(k));
  }
});

// ---------------------------------------------------------------------------------------------
// paste

test("a small paste is inserted verbatim: CRLF normalised, tabs expanded, control characters dropped", () => {
  const ctx = ctxOf();
  const r = press(typed("x", ctx), ctx, "paste:a\r\nb\tc\x1b[31m\x07d\x00");
  assert.equal(r.s.text, "xa\nb  cd", "the whole ANSI sequence is dropped, not just its ESC byte");
  assert.equal(r.s.chips.length, 0);
  assert.equal(r.s.cursor, r.s.text.length);
});

test("a big paste becomes one atomic chip but is submitted in full", () => {
  const ctx = ctxOf();
  const big = "line one\nline two\nline three\nline four";
  let s = typed("fix: ", ctx);
  s = press(s, ctx, "paste:" + big).s;
  assert.equal(s.text, "fix: " + CHIP0);
  assert.equal(s.chips[0].text, big);
  assert.equal(s.chips[0].lines, 4);
  const view = viewOf(s, ctx);
  assert.equal(view.text, "fix: [pasted text " + sym.dot + " 4 lines]");
  assert.equal(expandText(s), "fix: " + big);
  const r = press(s, ctx, "enter");
  assert.deepEqual(r.effects, [{ type: "submit", text: "fix: " + big }]);
  // atomic: one Backspace removes the chip, one arrow crosses it
  assert.equal(press(s, ctx, "backspace").s.text, "fix: ");
  const left = press(s, ctx, "left").s;
  assert.equal(left.cursor, 5);
  assert.equal(press(left, ctx, "right").s.cursor, 6);
  assert.equal(press(s, ctx, "left", "left").s.cursor, 4);
  assert.equal(press(s, ctx, "alt+b").s.cursor, 5, "a chip is one word");
});

test("chip thresholds: 3 lines or 200 characters", () => {
  const ctx = ctxOf();
  assert.equal(press(createState(), ctx, "paste:a\nb").s.chips.length, 0);
  assert.equal(press(createState(), ctx, "paste:a\nb\nc").s.chips.length, 1);
  assert.equal(press(createState(), ctx, "paste:a\nb\nc\n").s.chips.length, 1);
  assert.equal(press(createState(), ctx, "paste:" + "x".repeat(199)).s.chips.length, 0);
  const one = press(createState(), ctx, "paste:" + "x".repeat(200)).s;
  assert.equal(one.chips.length, 1);
  assert.equal(viewOf(one, ctx).text, "[pasted text " + sym.dot + " 200 chars]");
  const ar = press(createState(), ctx, "paste:" + "ب".repeat(250)).s;
  assert.equal(ar.chips.length, 1);
  const two = press(createState(), ctx, "paste:" + "y".repeat(210) + "\n" + "z".repeat(5)).s;
  assert.equal(viewOf(two, ctx).text, "[pasted text " + sym.dot + " 2 lines]");
});

test("several chips, chips in history navigation, and sentinels pasted by hand are dropped", () => {
  const ctx = ctxOf();
  let s = press(createState(), ctx, "paste:1\n2\n3", "paste:a\nb\nc\nd").s;
  assert.equal(s.chips.length, 2);
  assert.equal(expandText(s), "1\n2\n3a\nb\nc\nd");
  assert.equal(viewOf(s, ctx).text, "[pasted text " + sym.dot + " 3 lines][pasted text " + sym.dot + " 4 lines]");
  s = press(createState(), ctx, "paste:" + CHIP0 + CHIP0 + "plain").s;
  assert.equal(s.text, "plain");
  let h = createState({ history: ["old entry"] });
  h = press(h, ctx, "paste:1\n2\n3", "up").s;
  assert.equal(h.text, "old entry");
  h = press(h, ctx, "down").s;
  assert.equal(expandText(h), "1\n2\n3");
});

test("an empty paste changes nothing", () => {
  const ctx = ctxOf();
  const s = typed("a", ctx);
  assert.equal(press(s, ctx, "paste:").s, s);
  assert.equal(press(s, ctx, "paste:\x1b\x07").s.text, "a");
});

// ---------------------------------------------------------------------------------------------
// slash menu

test("the slash menu opens at the start, filters by prefix, and closes after the first space", () => {
  const ctx = ctxOf();
  let s = typed("/", ctx);
  let m = menuOf(s, ctx);
  assert.deepEqual(m.items.map(i => i.label), ["/help", "/effort", "/exit", "/exit-all", "/copy", "/compact"]);
  s = typed("/e", ctx);
  assert.deepEqual(menuOf(s, ctx).items.map(i => i.label), ["/effort", "/exit", "/exit-all", "/help"], "prefix matches first, then the ones that merely contain it");
  s = typed("/ex", ctx);
  assert.deepEqual(menuOf(s, ctx).items.map(i => i.label), ["/exit", "/exit-all"]);
  s = typed("/exit", ctx);
  m = menuOf(s, ctx);
  assert.equal(m.items[0].label, "/exit");
  assert.equal(m.items[0].exact, true);
  assert.equal(m.items[1].exact, false);
  s = typed("/EX", ctx);
  assert.equal(menuOf(s, ctx).items.length, 2);
  s = typed("/pac", ctx);
  assert.deepEqual(menuOf(s, ctx).items.map(i => i.label), ["/compact"], "a substring match also counts, after prefix matches");
  assert.equal(menuOf(typed("/zzz", ctx), ctx), null);
  assert.equal(menuOf(typed("/help ", ctx), ctx), null);
  assert.equal(menuOf(typed("hello /h", ctx), ctx), null);
  assert.equal(menuOf(typed("/", ctxOf({ commands: [] })), ctxOf({ commands: [] })), null);
  s = press(typed("/he", ctx), ctx, "left", "left", "left").s;
  assert.equal(menuOf(s, ctx), null, "the caret is before the slash");
  s = press(typed("/help", ctx), ctx, "left").s;
  assert.ok(menuOf(s, ctx), "the caret inside the command word keeps the menu");
});

test("Up/Down/Ctrl+P/Ctrl+N move the highlight (wrapping); typing resets it", () => {
  const ctx = ctxOf();
  let s = typed("/", ctx);
  assert.equal(menuOf(s, ctx).sel, 0);
  s = press(s, ctx, "down", "down").s;
  assert.equal(menuOf(s, ctx).sel, 2);
  s = press(s, ctx, "up", "up", "up").s;
  assert.equal(menuOf(s, ctx).sel, 5);
  s = press(s, ctx, "ctrl+n").s;
  assert.equal(menuOf(s, ctx).sel, 0);
  s = press(s, ctx, "ctrl+p").s;
  assert.equal(menuOf(s, ctx).sel, 5);
  s = press(s, ctx, "e").s;
  assert.equal(menuOf(s, ctx).sel, 0);
  assert.equal(s.histIndex, null, "Up/Down did not touch history while the menu was open");
});

test("Tab fills the highlighted command; Enter fills it too unless it is already typed in full", () => {
  const ctx = ctxOf();
  let r = press(typed("/ef", ctx), ctx, "tab");
  assert.equal(r.s.text, "/effort ");
  assert.equal(r.s.cursor, 8);
  assert.equal(menuOf(r.s, ctx), null);
  assert.deepEqual(r.effects, []);
  r = press(typed("/he", ctx), ctx, "enter");
  assert.equal(r.s.text, "/help ");
  assert.deepEqual(r.effects, [], "a half-typed command is completed, not run");
  r = press(typed("/help", ctx), ctx, "enter");
  assert.deepEqual(r.effects, [{ type: "submit", text: "/help" }]);
  r = press(typed("/e", ctx), ctx, "down", "tab");
  assert.equal(r.s.text, "/exit ");
  r = press(typed("/exit", ctx), ctx, "down", "enter");
  assert.equal(r.s.text, "/exit-all ", "a highlighted other item is selected, not the typed one submitted");
  r = press(typed("/ef", ctx), ctx, "tab", "x");
  assert.equal(r.s.text, "/effort x");
  r = press(typed("/ef high", ctx), ctx, "home", "right", "right", "tab");
  assert.equal(r.s.text, "/effort high", "the whole first word is replaced, the arguments stay");
});

test("Esc closes the menu until the text changes; the menu shows at most 8 rows and scrolls", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: "cmd" + String(i).padStart(2, "0"), description: "d" + i }));
  const ctx = ctxOf({ commands: many });
  let s = typed("/", ctx);
  s = press(s, ctx, "escape").s;
  assert.equal(menuOf(s, ctx), null);
  s = press(s, ctx, "c").s;
  assert.ok(menuOf(s, ctx), "typing reopens it");
  s = press(createState(), ctx, "/").s;
  for (let i = 0; i < 9; i++) s = press(s, ctx, "down").s;
  assert.equal(menuOf(s, ctx).sel, 9);
  assert.equal(s.menuTop, 2);
  const out = render(s, ctx, { prefix: "> " }).lines.map(stripAnsi);
  const rows = out.filter(l => /cmd\d\d/.test(l));
  assert.equal(rows.length, 8);
  assert.ok(rows.some(r => r.startsWith(sym.prompt + " ") && r.includes("cmd09")));
  assert.ok(rows.at(-1).includes("cmd09") || rows.some(r => r.includes("cmd09")));
  assert.ok(!rows.some(r => r.includes("cmd00")));
  assert.ok(rows.some(r => r.includes("10/20")));
});

test("command names may come with or without a leading slash, duplicates are ignored", () => {
  const ctx = ctxOf({ commands: [{ name: "/a", description: "A" }, { name: "a", description: "dup" }, { name: "b" }, { name: "" }, null] });
  assert.deepEqual(menuOf(typed("/", ctx), ctx).items.map(i => i.label), ["/a", "/b"]);
});

// ---------------------------------------------------------------------------------------------
// file picker

test("an @ that starts a word asks for files; only the newest answer counts", () => {
  const ctx = ctxOf({ hasFiles: true });
  let r = typeText(createState(), ctx, "see @");
  const first = r.effects.filter(e => e.type === "files");
  assert.deepEqual(first, [{ type: "files", query: "", seq: 1 }]);
  r = typeText(r.s, ctx, "sr");
  const queries = r.effects.filter(e => e.type === "files");
  assert.deepEqual(queries.map(e => e.query), ["s", "sr"]);
  assert.deepEqual(queries.map(e => e.seq), [2, 3]);
  let s = r.s;
  assert.equal(menuOf(s, ctx), null, "nothing to show until the answer arrives");
  s = applyFileResults(s, 2, ["stale/one.js"]);
  assert.equal(menuOf(s, ctx), null, "an answer to an older question is dropped");
  s = applyFileResults(s, 3, ["src/a.js", "src/b.js"]);
  assert.deepEqual(menuOf(s, ctx).items.map(i => i.label), ["src/a.js", "src/b.js"]);
  assert.equal(menuOf(s, ctx).kind, "file");
  assert.equal(menuOf(s, ctx).query, "sr");
});

test("emails and plain text with @ inside a word do not open the picker; neither does a missing files()", () => {
  const ctx = ctxOf({ hasFiles: true });
  assert.equal(typeText(createState(), ctx, "mail me@x").effects.filter(e => e.type === "files").length, 0);
  assert.equal(typeText(createState(), ctxOf(), "@src").effects.length, 0);
  const lone = typeText(createState(), ctx, "a @").effects.filter(e => e.type === "files");
  assert.equal(lone.length, 1);
  assert.equal(typeText(createState(), ctx, "@a b").effects.filter(e => e.type === "files").length, 2, "the picker closes at the space");
});

test("Tab and Enter insert the path and never submit; paths with spaces are quoted", () => {
  const ctx = ctxOf({ hasFiles: true });
  const prepared = answers => {
    let s = typeText(createState(), ctx, "open @sr").s;
    return applyFileResults(s, s.fileSeq, answers);
  };
  let s = prepared(["src/app.js", "src/lib.js"]);
  let r = press(s, ctx, "tab");
  assert.equal(r.s.text, "open @src/app.js ");
  assert.equal(r.s.cursor, r.s.text.length);
  r = press(s, ctx, "down", "enter");
  assert.equal(r.s.text, "open @src/lib.js ");
  assert.deepEqual(r.effects.filter(e => e.type === "submit"), []);
  r = press(prepared(["my docs/read me.md"]), ctx, "tab");
  assert.equal(r.s.text, 'open @"my docs/read me.md" ');
  s = typeText(createState(), ctx, "a @s b").s;
  s = press(s, ctx, "left", "left", "left").s;
  s = applyFileResults(s, s.fileSeq, ["src/x.js"]);
  assert.equal(press(s, ctx, "tab").s.text, "a @src/x.js b");
  // the quoted form keeps the picker open across spaces
  s = typeText(createState(), ctx, 'see @"my d').s;
  assert.equal(menuOf(applyFileResults(s, s.fileSeq, ["my docs/a.md"]), ctx).query, "my d");
});

test("the file picker is off in secret mode", () => {
  const ctx = ctxOf({ hasFiles: true, mask: "*" });
  const r = typeText(createState({ mask: "*" }), ctx, "@src");
  assert.equal(r.effects.length, 0);
});

// ---------------------------------------------------------------------------------------------
// secret mode

test("secret mode: one glyph per code point, no menus, no history, no chips, no newline pastes", () => {
  const ctx = ctxOf({ mask: "•", commands: COMMANDS, hasFiles: true });
  let s = createState({ mask: "•", history: ["old"] });
  assert.deepEqual(s.hist, []);
  s = typeText(s, ctx, "/ab😀مرحبا").s;
  const view = viewOf(s, ctx);
  assert.equal(view.text, "•".repeat([..."/ab😀مرحبا"].length));
  assert.equal(menuOf(s, ctx), null);
  s = press(s, ctx, "paste:12\n34\n56\n78" + "x".repeat(300)).s;
  assert.equal(s.chips.length, 0);
  assert.ok(!s.text.includes("\n"));
  const r = press(s, ctx, "enter");
  assert.equal(r.effects[0].type, "submit");
  assert.equal(r.effects[0].text, s.text, "nothing is trimmed in secret mode");
  assert.equal(press(createState({ mask: "•" }), ctx, "enter").effects.length, 0);
  const drawn = render(s, ctx, { prefix: "> " }).lines.map(stripAnsi).join("\n");
  assert.ok(!drawn.includes("ab") && !drawn.includes("مرحبا") && drawn.includes("•••"));
  assert.ok(!drawn.includes("pasted"));
  assert.equal(press(s, ctx, "up").s.text, s.text);
  const bs = press(typeText(createState({ mask: "•" }), ctx, "a😀").s, ctx, "backspace").s;
  assert.equal(bs.text, "a");
  assert.equal(press(typeText(createState({ mask: "•" }), ctx, "a\\").s, ctx, "enter").effects[0].text, "a\\", "no backslash continuation");
});

test("secret mode keeps the caret on the right glyph", () => {
  const ctx = ctxOf({ mask: "•" });
  let s = typeText(createState({ mask: "•" }), ctx, "😀ab").s;
  s = press(s, ctx, "left").s;
  const r = render(s, ctx, { prefix: "> " });
  assert.equal(r.cursor.col, 2 + 2);
  s = press(s, ctx, "home").s;
  assert.equal(render(s, ctx, { prefix: "> " }).cursor.col, 2);
});

// ---------------------------------------------------------------------------------------------
// rendering

test("empty box: two rules and one row with the prefix and a dim hint", () => {
  const r = render(createState(), ctxOf(), { prefix: "> " });
  assert.equal(r.lines.length, 3);
  assert.equal(stripAnsi(r.lines[0]), sym.hline.repeat(40));
  assert.equal(stripAnsi(r.lines[2]), sym.hline.repeat(40));
  assert.ok(stripAnsi(r.lines[1]).startsWith("> Type a message"));
  assert.deepEqual(r.cursor, { row: 1, col: 2 });
  const plain = render(createState(), ctxOf(), { prefix: "> ", placeholder: "" });
  assert.equal(stripAnsi(plain.lines[1]), "> ");
  const custom = render(createState(), ctxOf(), { prefix: "> ", placeholder: "Say something" });
  assert.equal(stripAnsi(custom.lines[1]), "> Say something");
  const narrow = render(createState(), ctxOf({ width: 12 }), { prefix: "> " });
  assert.ok(stringWidth(narrow.lines[1]) <= 12);
});

test("typed text, wrapping and caret position", () => {
  const ctx = ctxOf({ width: 12 });
  let s = typed("aaaa bbbb cccc dddd", ctx);
  let r = render(s, ctx, { prefix: "> " });
  assert.deepEqual(r.lines.slice(1, 3).map(stripAnsi), ["> aaaa bbbb", "  cccc dddd"]);
  assert.deepEqual(r.cursor, { row: 2, col: 11 });
  s = press(s, ctx, "home").s;
  r = render(s, ctx, { prefix: "> " });
  assert.deepEqual(r.cursor, { row: 1, col: 2 });
  s = press(typed("ab\ncd", ctx), ctx, "up").s;
  r = render(s, ctx, { prefix: "> " });
  assert.deepEqual(r.cursor, { row: 1, col: 4 });
  const wide = render(typed("x".repeat(50), ctxOf()), ctxOf(), { prefix: "> " });
  assert.ok(wide.lines.every(l => stringWidth(l) <= 40));
  assert.equal(wide.lines.length, 4);
  assert.equal(render(typed("x".repeat(30), ctxOf()), ctxOf(), { prefix: "> " }).lines.length, 3);
});

test("a continuation prefix replaces the indent of the later rows", () => {
  const ctx = ctxOf();
  const s = typed("one\ntwo", ctx);
  const r = render(s, ctx, { prefix: "> ", continuationPrefix: ". " });
  assert.deepEqual(r.lines.slice(1, 3).map(stripAnsi), ["> one", ". two"]);
});

test("footer lines are re-evaluated on every render and sit under the box", () => {
  let n = 0;
  const footer = () => [`mode line ${++n}`, "second"];
  const ctx = ctxOf();
  const a = render(createState(), ctx, { prefix: "> ", footer });
  const b = render(createState(), ctx, { prefix: "> ", footer });
  assert.deepEqual(a.lines.slice(-2).map(stripAnsi), ["mode line 1", "second"]);
  assert.deepEqual(b.lines.slice(-2).map(stripAnsi), ["mode line 2", "second"]);
  assert.equal(a.lines.length, 5);
  const broken = render(createState(), ctx, { prefix: "> ", footer: () => { throw new Error("x"); } });
  assert.equal(broken.lines.length, 3);
  const long = render(createState(), ctx, { prefix: "> ", footer: () => ["y".repeat(100)] });
  assert.ok(stringWidth(long.lines.at(-1)) <= 40);
});

test("the Ctrl+C hint replaces the first footer line for as long as it is armed", () => {
  const ctx = ctxOf();
  const s = press(typed("draft", ctx), ctx, "ctrl+c").s;
  const footer = () => ["mode line"];
  const during = render(s, ctx, { prefix: "> ", footer }).lines.map(stripAnsi);
  assert.equal(during.at(-1), "  Press Ctrl+C again to exit");
  assert.equal(during.length, 4);
  const after = render(s, { ...ctx, now: 3001 }, { prefix: "> ", footer }).lines.map(stripAnsi);
  assert.equal(after.at(-1), "mode line");
  const bare = render(s, ctx, { prefix: "> " }).lines.map(stripAnsi);
  assert.equal(bare.at(-1), "  Press Ctrl+C again to exit");
});

test("a tall input is windowed around the caret with 'more above / below' labels", () => {
  const ctx = ctxOf({ height: 12 });
  const text = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
  let s = typed(text, ctx);
  let r = render(s, ctx, { prefix: "> " });
  assert.ok(r.lines.length <= 11, `${r.lines.length} lines`);
  const plain = r.lines.map(stripAnsi);
  assert.ok(plain.some(l => l.includes("row 29")));
  assert.ok(!plain.some(l => l.includes("row 0 ") || l.endsWith("row 0")));
  assert.ok(plain[0].includes("more above"), plain[0]);
  assert.ok(!plain.at(-1).includes("more below"));
  assert.equal(r.cursor.row, plain.findIndex(l => l.includes("row 29")));
  s = { ...s, viewTop: r.viewTop };
  s = press(s, ctx, ...Array(29).fill("up")).s;
  r = render(s, ctx, { prefix: "> " });
  const up = r.lines.map(stripAnsi);
  assert.ok(up.some(l => l.endsWith("row 0")));
  assert.ok(up.at(-1).includes("more below"), up.at(-1));
  assert.ok(!up[0].includes("more above"));
});

test("the whole box fits every width and height, in both scripts", () => {
  for (const text of ["", "hello world", "مرحبا بك في فراس كود", "mixed مرحبا text 123 ثم", "a\nb\n\nc", "x".repeat(300), "ل".repeat(100)]) {
    for (const width of [8, 10, 20, 33, 40, 80, 200]) {
      for (const height of [3, 6, 12, 40]) {
        const ctx = ctxOf({ width, height });
        const s = typed(text, ctx);
        const r = render(s, ctx, { prefix: "> ", footer: () => ["f"] });
        for (const l of r.lines) assert.ok(stringWidth(l) <= width, `w${width} h${height} ${JSON.stringify(text.slice(0, 12))}: ${JSON.stringify(stripAnsi(l))}`);
        assert.ok(r.cursor.row >= 0 && r.cursor.row < r.lines.length);
        assert.ok(r.cursor.col >= 0 && r.cursor.col < width);
      }
    }
  }
});

test("the menu is drawn under the box with the highlighted row marked", () => {
  const ctx = ctxOf();
  const s = press(typed("/e", ctx), ctx, "down").s;
  const lines = render(s, ctx, { prefix: "> " }).lines.map(stripAnsi);
  assert.equal(lines.length, 3 + 4);
  assert.ok(lines[3].startsWith("  /effort"));
  assert.ok(lines[4].startsWith(sym.prompt + " /exit"), lines[4]);
  assert.ok(lines[3].includes("Set how deeply I think"));
  assert.ok(lines.every(l => stringWidth(l) <= 40));
  const narrow = render(s, ctxOf({ width: 14 }), { prefix: "> " }).lines;
  assert.ok(narrow.every(l => stringWidth(l) <= 14));
  const short = render(typed("/", ctxOf({ height: 7 })), ctxOf({ height: 7 }), { prefix: "> " }).lines;
  assert.ok(short.length <= 6, `${short.length}`);
});

test("file menu rows show the path with the directory dimmed and a counter when it scrolls", () => {
  const ctx = ctxOf({ hasFiles: true });
  let s = typeText(createState(), ctx, "@s").s;
  const files = Array.from({ length: 12 }, (_, i) => `src/dir/file${i}.js`);
  s = applyFileResults(s, s.fileSeq, files);
  const lines = render(s, ctx, { prefix: "> " }).lines.map(stripAnsi);
  const rows = lines.filter(l => l.includes("file"));
  assert.equal(rows.length, 8);
  assert.ok(rows[0].startsWith(sym.prompt + " src/dir/file0.js"));
  assert.ok(rows[0].trimEnd().endsWith("1/12"));
  const deep = applyFileResults(s, s.fileSeq, ["a/".repeat(30) + "target.js"]);
  const cut = render(deep, ctxOf({ hasFiles: true, width: 30 }), { prefix: "> " }).lines.map(stripAnsi);
  assert.ok(cut.some(l => l.includes("target.js") && l.includes(sym.ellipsis)), cut.join("|"));
});

test("chips are drawn dim", () => {
  setColorLevel(3);
  try {
    const ctx = ctxOf();
    const s = press(createState(), ctx, "paste:a\nb\nc").s;
    const row = render(s, ctx, { prefix: "> " }).lines[1];
    assert.ok(row.includes("\x1b[2m[pasted text"), JSON.stringify(row));
    assert.equal(stripAnsi(row), "> [pasted text " + sym.dot + " 3 lines]");
  } finally {
    setColorLevel(0);
  }
});

// ---------------------------------------------------------------------------------------------
// Arabic

test("typing Arabic: the line is right-aligned, shaped and ordered, and the caret waits left of the last letter", () => {
  const ctx = ctxOf({ width: 30 });
  let s = createState();
  for (const word of ["م", "ر", "ح", "ب", "ا"]) {
    s = typed(word, ctx, { initial: s.text });
    const r = render(s, ctx, { prefix: "> " });
    const row = stripAnsi(r.lines[1]);
    assert.equal(stringWidth(row), 30, "right-aligned to the full width");
    assert.ok(row.startsWith("> "));
    const shaped = toVisual(s.text, { dir: "rtl" });
    assert.ok(row.endsWith(shaped), `${JSON.stringify(row)} ends with ${JSON.stringify(shaped)}`);
    const letters = [...s.text].length;
    assert.equal(r.cursor.col, 30 - letters - 1, "one free cell to the left of the run");
    assert.equal(r.cursor.row, 1);
  }
});

test("Arabic caret positions line up with layoutInput away from the end", () => {
  const ctx = ctxOf({ width: 30 });
  const s0 = typed("مرحبا بك", ctx);
  for (let k = 0; k < s0.text.length; k++) {
    const s = { ...s0, cursor: k };
    const r = render(s, ctx, { prefix: "> " });
    const expected = layoutInput(s.text, k, { width: 30, prefix: "  ", align: "auto" }).cursor;
    assert.deepEqual(r.cursor, { row: 1 + expected.row, col: expected.col }, `cursor ${k}`);
  }
});

test("mixed text: the caret after Arabic that follows Latin waits on the separating space", () => {
  const ctx = ctxOf();
  const s = typed("hello مرحبا", ctx);
  const r = render(s, ctx, { prefix: "> " });
  const row = stripAnsi(r.lines[1]);
  assert.equal(r.cursor.col, 2 + 5, "on the space between the two words");
  assert.equal(row[r.cursor.col], " ");
  const latin = render(typed("hello", ctx), ctx, { prefix: "> " });
  assert.equal(latin.cursor.col, 7, "Latin text keeps the caret after the last letter");
});

test("an Arabic paragraph wraps and stays right-aligned on every row", () => {
  const ctx = ctxOf({ width: 20 });
  const s = typed("مرحبا بك في فراس كود وهذا نص طويل جدا يلتف على عدة أسطر", ctx);
  const r = render(s, ctx, { prefix: "> " });
  const rows = r.lines.slice(1, -1);
  assert.ok(rows.length >= 3);
  for (const row of rows) assert.equal(stringWidth(row), 20);
  assert.equal(r.cursor.row, rows.length);
});

test("the Arabic UI language shows the Arabic hint, right-aligned", () => {
  setLang("ar");
  try {
    const ctx = ctxOf({ width: 50 });
    const s = press(typed("x", ctx), ctx, "ctrl+c").s;
    const hint = stripAnsi(render(s, ctx, { prefix: "> " }).lines.at(-1));
    assert.equal(stringWidth(hint), 50);
    assert.ok(hint.includes(toVisual("مرة أخرى للخروج", { dir: "rtl" })), hint);
    assert.ok(!/[\u2066-\u2069]/.test(hint));
    const empty = render(createState(), ctx, { prefix: "> " });
    const placeholder = stripAnsi(empty.lines[1]);
    assert.ok(placeholder.includes(toVisual("اكتب رسالتك", { dir: "rtl" })), placeholder);
    assert.ok(ARABIC_LETTERS.test(placeholder));
  } finally {
    setLang("en");
  }
});

test("the Arabic placeholder is right-aligned and the caret waits at the right edge, where the first letter will appear", () => {
  setLang("ar");
  try {
    for (const width of [50, 24, 12]) {
      const ctx = ctxOf({ width });
      const empty = render(createState(), ctx, { prefix: "> " });
      const row = stripAnsi(empty.lines[1]);
      assert.ok(stringWidth(row) <= width - 1, `${width}: the last cell is left for the caret (${stringWidth(row)})`);
      assert.equal(empty.cursor.col, width - 1, `${width}: caret on the last cell`);
      assert.equal(empty.cursor.row, 1);
      assert.ok(row.startsWith("> "), "the prompt mark stays on the left");
      if (width === 50) {
        assert.equal(row.length, width - 1);
        assert.ok(row.trimEnd().length >= width - 2, "text is pushed to the right: " + row);
      }
    }
    // The first Arabic letter goes where the caret was.
    const ctx = ctxOf({ width: 50 });
    const typedOne = render(typed("م", ctx), ctx, { prefix: "> " });
    assert.equal(stringWidth(stripAnsi(typedOne.lines[1])), 50);
  } finally {
    setLang("en");
  }
  const ctx = ctxOf({ width: 50 });
  const english = render(createState(), ctx, { prefix: "> " });
  assert.ok(stripAnsi(english.lines[1]).startsWith("> Type a message"), "the English hint is untouched");
  assert.deepEqual(english.cursor, { row: 1, col: 2 });
  const custom = render(createState(), ctx, { prefix: "> ", placeholder: "اكتب هنا" });
  assert.equal(custom.cursor.col, 49, "any Arabic hint is placed the same way");
});

// ---------------------------------------------------------------------------------------------
// readPrompt (glue)

const tick = ms => new Promise(r => setTimeout(r, ms));

test("readPrompt: typing, history, submit; the live region is cleared and the key listener removed", async () => {
  const screen = fakeScreen({ width: 40 });
  const p = readPrompt(screen, { prefix: "> ", history: ["old one"], commands: COMMANDS });
  assert.equal(screen.subscribers(), 1);
  assert.equal(screen.live.length, 3);
  screen.press("h", "i");
  assert.equal(stripAnsi(screen.live[1]), "> hi");
  assert.deepEqual(screen.cursor, { row: 1, col: 4 });
  screen.press("up");
  assert.equal(stripAnsi(screen.live[1]), "> old one");
  screen.press("down");
  assert.equal(stripAnsi(screen.live[1]), "> hi");
  screen.press("enter");
  assert.deepEqual(await p, { type: "submit", text: "hi" });
  assert.equal(screen.subscribers(), 0);
  assert.equal(screen.cleared, 1);
  assert.deepEqual(screen.live, []);
  screen.press("x");
  assert.equal(screen.history.length > 0, true);
});

test("readPrompt: exit via Ctrl+C on empty, Ctrl+D on empty; Ctrl+C on text only clears", async () => {
  let screen = fakeScreen();
  let p = readPrompt(screen, {});
  screen.press("ctrl+c");
  assert.deepEqual(await p, { type: "exit" });
  screen = fakeScreen();
  p = readPrompt(screen, {});
  screen.press("ctrl+d");
  assert.deepEqual(await p, { type: "exit" });
  screen = fakeScreen();
  p = readPrompt(screen, { prefix: "> " });
  screen.press("a", "b", "ctrl+c");
  assert.equal(stripAnsi(screen.live[1]).startsWith("> "), true);
  assert.ok(screen.live.map(stripAnsi).some(l => l.includes("Press Ctrl+C again")));
  screen.press("ctrl+c");
  assert.deepEqual(await p, { type: "exit" });
});

test("readPrompt: an abort signal cancels, also when it is already aborted", async () => {
  const ac = new AbortController();
  const screen = fakeScreen();
  const p = readPrompt(screen, { signal: ac.signal });
  ac.abort();
  assert.deepEqual(await p, { type: "cancel" });
  assert.equal(screen.subscribers(), 0);
  assert.equal(screen.cleared, 1);
  const done = new AbortController();
  done.abort();
  const s2 = fakeScreen();
  assert.deepEqual(await readPrompt(s2, { signal: done.signal }), { type: "cancel" });
  assert.equal(s2.subscribers(), 0);
});

test("readPrompt: hooks for Shift+Tab and Ctrl+O; the footer is asked again afterwards", async () => {
  const screen = fakeScreen();
  let mode = "default";
  const calls = [];
  const p = readPrompt(screen, {
    prefix: "> ",
    footer: () => [`mode: ${mode}`],
    onShiftTab: () => { calls.push("tab"); mode = "plan"; },
    onExpand: () => calls.push("expand"),
  });
  assert.ok(stripAnsi(screen.live.at(-1)).includes("mode: default"));
  screen.press("backtab");
  assert.ok(stripAnsi(screen.live.at(-1)).includes("mode: plan"));
  screen.press("ctrl+t", "ctrl+o", "shift+backtab");
  assert.deepEqual(calls, ["tab", "expand", "tab"]);
  screen.press("ctrl+c");
  await p;
});

test("readPrompt: initial text, a custom prefix and resize", async () => {
  const screen = fakeScreen({ width: 40 });
  const p = readPrompt(screen, { prefix: "$ ", initial: "start" });
  assert.equal(stripAnsi(screen.live[1]), "$ start");
  assert.deepEqual(screen.cursor, { row: 1, col: 7 });
  screen.resizeTo(20);
  assert.equal(stringWidth(screen.live[0]), 20);
  screen.press("enter");
  assert.deepEqual(await p, { type: "submit", text: "start" });
});

test("readPrompt: slash menu through the glue - Enter on a prefix fills, a second Enter submits", async () => {
  const screen = fakeScreen();
  const p = readPrompt(screen, { prefix: "> ", commands: COMMANDS });
  screen.press("/", "h", "e");
  assert.ok(screen.live.map(stripAnsi).some(l => l.includes("/help")));
  screen.press("enter");
  assert.equal(stripAnsi(screen.live[1]), "> /help ");
  screen.press("enter");
  assert.deepEqual(await p, { type: "submit", text: "/help" });
});

test("readPrompt: file lookups are debounced, stale answers dropped, results shown", async () => {
  const screen = fakeScreen();
  const asked = [];
  const p = readPrompt(screen, {
    prefix: "> ",
    files: async q => {
      asked.push(q);
      if (q === "s") await tick(60);
      return [`src/${q || "root"}.js`];
    },
  });
  screen.press("@");
  screen.press("s");
  assert.deepEqual(asked, [], "nothing is asked while the user is still typing");
  await tick(120);
  assert.deepEqual(asked, ["s"], "only the newest query was sent");
  screen.press("r");
  await tick(150);
  assert.deepEqual(asked, ["s", "sr"]);
  assert.ok(screen.live.map(stripAnsi).some(l => l.includes("src/sr.js")));
  screen.press("tab");
  assert.equal(stripAnsi(screen.live[1]), "> @src/sr.js ");
  screen.press("enter");
  assert.deepEqual(await p, { type: "submit", text: "@src/sr.js" });
});

test("readPrompt: a slow answer to an old query never overwrites a newer one", async () => {
  const screen = fakeScreen();
  const release = {};
  const p = readPrompt(screen, {
    prefix: "> ",
    files: q => new Promise(resolve => { release[q] = () => resolve([`${q}-result.js`]); }),
  });
  screen.press("@", "a");
  await tick(120);
  screen.press("b");
  await tick(120);
  release.ab();
  await tick(10);
  release.a();
  await tick(10);
  const rows = screen.live.map(stripAnsi).join("\n");
  assert.ok(rows.includes("ab-result.js"));
  assert.ok(!rows.includes("a-result.js"));
  screen.press("ctrl+c", "ctrl+c");
  await p;
});

test("readPrompt: a failing or silly files() just means no menu", async () => {
  const screen = fakeScreen();
  const p = readPrompt(screen, { prefix: "> ", files: () => { throw new Error("boom"); } });
  screen.press("@", "x");
  await tick(150);
  assert.equal(screen.live.length, 3);
  const q = fakeScreen();
  const p2 = readPrompt(q, { prefix: "> ", files: () => "not an array" });
  q.press("@", "x");
  await tick(150);
  assert.equal(q.live.length, 3);
  screen.press("ctrl+c", "ctrl+c");
  q.press("ctrl+c", "ctrl+c");
  await Promise.all([p, p2]);
});

test("readPrompt: finishing while a lookup is in flight is safe", async () => {
  const screen = fakeScreen();
  const p = readPrompt(screen, { prefix: "> ", files: async () => { await tick(30); return ["a.js"]; } });
  screen.press("@", "a");
  await tick(100);
  screen.press("ctrl+c", "ctrl+c");
  await p;
  const draws = screen.history.length;
  await tick(60);
  assert.equal(screen.history.length, draws, "no drawing after the prompt is finished");
});

test("readPrompt: secret entry returns the secret, shows glyphs, and has no placeholder", async () => {
  const screen = fakeScreen();
  const p = readPrompt(screen, { prefix: "code: ", mask: "•" });
  assert.equal(stripAnsi(screen.live[1]), "code: ");
  screen.press("a", "b", "c");
  assert.equal(stripAnsi(screen.live[1]), "code: •••");
  assert.deepEqual(screen.cursor, { row: 1, col: 9 });
  screen.press("paste:xy\nz");
  screen.press("enter");
  assert.deepEqual(await p, { type: "submit", text: "abcxyz" });
});

// ---------------------------------------------------------------------------------------------
// the real screen, end to end

test("end to end on a terminal emulator: typing Arabic, wrapping, the menu and a clean exit", async () => {
  const clock = fakeClock();
  const { out, vt } = fakeTTY({ cols: 30, rows: 14 });
  const sin = fakeStdin();
  const screen = createScreen({ stdin: sin, stdout: out, env: { WT_SESSION: "1" }, platform: "linux", now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  screen.print(["earlier output"]);
  const p = readPrompt(screen, { prefix: "> ", commands: COMMANDS, footer: () => ["footer line"] });
  const settle = () => clock.advance(20);
  settle();
  const first = vt.all();
  assert.deepEqual([first[0], first[1], first[3], first[4]], ["earlier output", sym.hline.repeat(30), sym.hline.repeat(30), "footer line"]);
  assert.ok(first[2].startsWith("> Type a message"), first[2]);
  sin.type("مرحبا");
  settle();
  const rows = vt.rows_();
  assert.equal(rows[2], "> " + " ".repeat(30 - 2 - 5) + toVisual("مرحبا", { dir: "rtl" }));
  assert.deepEqual([vt.y, vt.x], [2, 30 - 5 - 1]);
  sin.type("\x15/co");
  settle();
  const lines = vt.all();
  assert.ok(lines.some(l => l.startsWith(sym.prompt + " /copy")));
  assert.ok(lines.some(l => l.includes("/compact")));
  sin.type("\x1b"); // a lone Esc is held for 50 ms in case it starts a sequence
  await tick(80);
  settle();
  assert.ok(!vt.all().some(l => l.includes("/compact")), "Esc closed the menu");
  sin.type("\x1b");
  await tick(80);
  settle();
  assert.ok(vt.all().some(l => l.startsWith("> Type a message")), "a second Esc cleared the text");
  sin.type("done\r");
  assert.deepEqual(await p, { type: "submit", text: "done" });
  assert.deepEqual(vt.all(), ["earlier output"]);
  screen.dispose();
  assert.equal(vt.cursorHidden, false);
});

// ---------------------------------------------------------------------------------------------
// raw terminal bytes -> keys -> editor

function typeBytes(bytes, ctx = ctxOf(), init) {
  let s = createState(init);
  const effects = [];
  for (const key of parseKeys(bytes)) {
    const r = reduce(s, key, ctx);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects };
}

test("what real terminals send: Alt+Enter, LF, backslash+Enter and Enter all do the right thing", () => {
  assert.deepEqual(typeBytes("one\x1b\rtwo\r").effects, [{ type: "submit", text: "one\ntwo" }]);
  assert.deepEqual(typeBytes("one\ntwo\r").effects, [{ type: "submit", text: "one\ntwo" }]);
  assert.deepEqual(typeBytes("one\\\rtwo\r").effects, [{ type: "submit", text: "one\ntwo" }]);
  assert.deepEqual(typeBytes("one\x1b[13;2utwo\r").effects, [{ type: "submit", text: "one\ntwo" }]);
  assert.deepEqual(typeBytes("one\x1b[27;5;13~two\r").effects, [{ type: "submit", text: "one\ntwo" }]);
  assert.deepEqual(typeBytes("one\r").effects, [{ type: "submit", text: "one" }]);
});

test("what real terminals send: editing keys, bracketed paste, Arabic", () => {
  assert.equal(typeBytes("abc\x1b[D\x1b[D\x7fX").s.text, "Xbc");
  assert.equal(typeBytes("abc\x08").s.text, "ab", "both Backspace bytes work");
  assert.equal(typeBytes("one two\x1b[1;5D\x1b[3~").s.text, "one wo");
  assert.equal(typeBytes("one two\x1bb\x17").s.text, "two", "Alt+B then Ctrl+W");
  assert.equal(typeBytes("x\x1b[200~a\r\nb\r\nc\x1b[201~").s.chips.length, 1);
  assert.equal(expandText(typeBytes("x\x1b[200~a\r\nb\r\nc\x1b[201~").s), "x" + "a\nb\nc");
  const ar = typeBytes("مرحبا بك");
  assert.equal(ar.s.text, "مرحبا بك");
  assert.deepEqual(typeBytes("مرحبا\r").effects, [{ type: "submit", text: "مرحبا" }]);
  assert.equal(typeBytes("a\x1b[1;5Cb\x15").s.text, "");
});

test("readPrompt: Ctrl+L repaints the region from scratch", async () => {
  const screen = fakeScreen();
  const p = readPrompt(screen, { prefix: "> " });
  screen.press("a");
  const before = screen.cleared;
  const draws = screen.history.length;
  screen.press("ctrl+l");
  assert.equal(screen.cleared, before + 1);
  assert.ok(screen.history.length > draws);
  assert.equal(stripAnsi(screen.live[1]), "> a");
  screen.press("ctrl+c", "ctrl+c");
  await p;
});
