import test from "node:test";
import assert from "node:assert/strict";
import { createKeyParser, parseKeys, keyLabel } from "../../src/ui/keys.js";
import { fakeClock } from "./term-helpers.js";

const labels = (input, o) => parseKeys(input, o).map(keyLabel);
const one = (input, o) => {
  const keys = parseKeys(input, o);
  assert.equal(keys.length, 1, `expected one key for ${JSON.stringify(input)}, got ${JSON.stringify(keys)}`);
  return keys[0];
};

test("printable ASCII and capitals", () => {
  assert.deepEqual(parseKeys("a"), [{ name: "char", ch: "a", ctrl: false, alt: false, shift: false, seq: "a" }]);
  assert.deepEqual(labels("aB 1"), ["a", "B", "space", "1"]);
  assert.equal(one("B").shift, true);
  assert.equal(one("b").shift, false);
});

test("control keys: Enter, LF, Tab, Backspace (both bytes), Ctrl+letters", () => {
  assert.equal(keyLabel(one("\r")), "return");
  assert.equal(one("\r").ctrl, false);
  const lf = one("\n");
  assert.equal(lf.name, "return");
  assert.equal(lf.ctrl, true); // Ctrl+J / Ctrl+Enter
  assert.equal(keyLabel(one("\t")), "tab");
  assert.equal(keyLabel(one("\x7f")), "backspace");
  assert.equal(keyLabel(one("\b")), "backspace");
  assert.equal(one("\b").ctrl, false);
  assert.deepEqual(labels("\x03\x04\x01\x05\x0b\x15\x17\x0c\x14\x0f"), [
    "ctrl+c", "ctrl+d", "ctrl+a", "ctrl+e", "ctrl+k", "ctrl+u", "ctrl+w", "ctrl+l", "ctrl+t", "ctrl+o",
  ]);
  assert.equal(one("\x03").ch, "c");
  assert.deepEqual(labels("\x00"), ["ctrl+space"]);
  assert.deepEqual(labels("\x1c\x1d\x1f"), ["ctrl+\\", "ctrl+]", "ctrl+_"]);
});

test("arrows, home/end, paging, insert, delete with and without modifiers", () => {
  const table = {
    "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
    "\x1b[H": "home", "\x1b[F": "end", "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
    "\x1bOH": "home", "\x1bOF": "end", "\x1b[1~": "home", "\x1b[4~": "end", "\x1b[7~": "home", "\x1b[8~": "end",
    "\x1b[2~": "insert", "\x1b[3~": "delete", "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
    "\x1b[1;2A": "shift+up", "\x1b[1;3A": "alt+up", "\x1b[1;5A": "ctrl+up", "\x1b[1;5C": "ctrl+right",
    "\x1b[1;5D": "ctrl+left", "\x1b[1;6C": "ctrl+shift+right", "\x1b[1;7D": "ctrl+alt+left", "\x1b[1;4A": "alt+shift+up",
    "\x1b[3;5~": "ctrl+delete", "\x1b[3;3~": "alt+delete", "\x1b[5;5~": "ctrl+pageup", "\x1b[1;5H": "ctrl+home",
    "\x1b[Z": "shift+backtab", "\x1b[1;2Z": "shift+backtab",
  };
  for (const [seq, label] of Object.entries(table)) assert.deepEqual(labels(seq), [label], JSON.stringify(seq));
  assert.equal(one("\x1b[Z").name, "backtab");
  assert.equal(one("\x1b[1;5C").seq, "\x1b[1;5C");
});

test("function keys in every common encoding", () => {
  const table = {
    "\x1bOP": "f1", "\x1bOQ": "f2", "\x1bOR": "f3", "\x1bOS": "f4", "\x1b[11~": "f1", "\x1b[15~": "f5", "\x1b[17~": "f6",
    "\x1b[18~": "f7", "\x1b[19~": "f8", "\x1b[20~": "f9", "\x1b[21~": "f10", "\x1b[23~": "f11", "\x1b[24~": "f12",
    "\x1b[[A": "f1", "\x1b[[E": "f5", "\x1b[1;2P": "shift+f1", "\x1b[15;5~": "ctrl+f5", "\x1b[1;3Q": "alt+f2",
  };
  for (const [seq, label] of Object.entries(table)) assert.deepEqual(labels(seq), [label], JSON.stringify(seq));
});

test("rxvt-style sequences", () => {
  assert.deepEqual(labels("\x1b[a"), ["shift+up"]);
  assert.deepEqual(labels("\x1bOa"), ["ctrl+up"]);
  assert.deepEqual(labels("\x1b[3^"), ["ctrl+delete"]);
  assert.deepEqual(labels("\x1b[3$"), ["shift+delete"]);
});

test("Alt+key is ESC-prefixed", () => {
  assert.deepEqual(labels("\x1bb\x1bf\x1bd"), ["alt+b", "alt+f", "alt+d"]);
  assert.deepEqual(labels("\x1b\r"), ["alt+return"]);
  assert.deepEqual(labels("\x1b\x7f"), ["alt+backspace"]);
  assert.deepEqual(labels("\x1b\t"), ["alt+tab"]);
  assert.deepEqual(labels("\x1bB"), ["alt+B"]);
  assert.equal(one("\x1bB").shift, true);
  assert.deepEqual(labels("\x1b\x01"), ["ctrl+alt+a"]);
  assert.deepEqual(labels("\x1b\n"), ["ctrl+alt+return"]);
  assert.deepEqual(labels("\x1b[1;3C"), ["alt+right"]);
  assert.deepEqual(labels("\x1b\x1b[A"), ["alt+up"]);
  assert.deepEqual(labels("\x1b\x1b[1;5C"), ["ctrl+alt+right"]);
  assert.deepEqual(labels("\x1bم"), ["alt+م"]);
  assert.deepEqual(labels("\x1b😀"), ["alt+😀"]);
  assert.deepEqual(labels("\x1bOM\x1bOp\x1bOX"), ["return", "0", "="]);
});

test("CSI u and modifyOtherKeys forms", () => {
  assert.deepEqual(labels("\x1b[13;2u"), ["shift+return"]);
  assert.deepEqual(labels("\x1b[13;5u"), ["ctrl+return"]);
  assert.deepEqual(labels("\x1b[13;3u"), ["alt+return"]);
  assert.deepEqual(labels("\x1b[13u"), ["return"]);
  assert.deepEqual(labels("\x1b[27;2;13~"), ["shift+return"]);
  assert.deepEqual(labels("\x1b[27;5;13~"), ["ctrl+return"]);
  assert.deepEqual(labels("\x1b[27u"), ["escape"]);
  assert.deepEqual(labels("\x1b[9;2u"), ["shift+backtab"]);
  assert.deepEqual(labels("\x1b[127;5u"), ["ctrl+backspace"]);
  assert.deepEqual(labels("\x1b[27;5;127~"), ["ctrl+backspace"]);
  assert.deepEqual(labels("\x1b[127;3u"), ["alt+backspace"]);
  assert.deepEqual(labels("\x1b[99;5u"), ["ctrl+c"]);
  assert.deepEqual(labels("\x1b[27;5;99~"), ["ctrl+c"]);
  assert.deepEqual(labels("\x1b[97;3u"), ["alt+a"]);
  assert.deepEqual(labels("\x1b[97;2u"), ["A"]);
  assert.equal(one("\x1b[97:65;2u").ch, "A");
  assert.deepEqual(labels("\x1b[1575u"), ["ا"]);
  assert.deepEqual(labels("\x1b[97;1:3u"), []); // key release is swallowed
  assert.equal(one("\x1b[57344u").name, "unknown");
});

test("replies and reports the terminal may send are swallowed, unknown CSI is reported", () => {
  assert.deepEqual(parseKeys("\x1b[I\x1b[O"), []);
  assert.deepEqual(parseKeys("\x1b[12;40R"), []);
  assert.deepEqual(parseKeys("\x1b[?1;2c"), []);
  assert.deepEqual(parseKeys("\x1b[<0;10;5M"), []);
  assert.deepEqual(labels("\x1b[1;5R"), ["ctrl+f3"]);
  assert.deepEqual(labels("\x1b[201~"), []);
  assert.equal(one("\x1b[99999~").name, "unknown");
  assert.deepEqual(labels("\x1b[?"), ["unknown"]);
  assert.deepEqual(parseKeys("\u0085\u009b"), []);
});

test("lone ESC and Alt+[ / Alt+O resolve after the timeout", () => {
  assert.deepEqual(labels("\x1b"), ["escape"]);
  assert.deepEqual(labels("\x1b\x1b"), ["alt+escape"]);
  assert.deepEqual(labels("\x1b["), ["alt+["]);
  assert.deepEqual(labels("\x1bO"), ["alt+O"]);
  assert.deepEqual(labels("\x1b[1;"), ["unknown"]);
  assert.deepEqual(labels("\x1b[["), ["alt+[", "["]);
});

test("the ESC timeout: a sequence split across chunks is joined, a lone ESC waits 50 ms", () => {
  const clock = fakeClock();
  const out = [];
  const p = createKeyParser(k => out.push(keyLabel(k)), { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  p.feed("\x1b");
  assert.deepEqual(out, []);
  clock.advance(30);
  assert.deepEqual(out, []);
  p.feed("[A"); // the rest arrives in time
  assert.deepEqual(out, ["up"]);
  clock.advance(100);
  assert.deepEqual(out, ["up"]);
  p.feed("\x1b");
  clock.advance(49);
  assert.deepEqual(out, ["up"]);
  clock.advance(2);
  assert.deepEqual(out, ["up", "escape"]);
  p.feed("\x1b[1;");
  p.feed("5");
  p.feed("C");
  assert.deepEqual(out, ["up", "escape", "ctrl+right"]);
  assert.equal(clock.pending(), 0);
});

test("UTF-8 split across chunks (bytes), surrogate pairs and clusters", () => {
  const bytes = Buffer.from("مرحبا😀é", "utf8");
  for (let cut = 1; cut < bytes.length; cut++) {
    const out = [];
    const p = createKeyParser(k => out.push(k));
    p.feed(bytes.subarray(0, cut));
    p.feed(bytes.subarray(cut));
    p.flush();
    assert.equal(out.map(k => k.ch).join(""), "مرحبا😀é", `cut at ${cut}`);
  }
  assert.deepEqual(parseKeys("😀").map(k => k.ch), ["😀"]);
  assert.deepEqual(parseKeys("e\u0301x").map(k => k.ch), ["e\u0301", "x"]);
  assert.deepEqual(parseKeys("مَرْحَبًا").map(k => k.ch), ["مَ", "رْ", "حَ", "بً", "ا"]);
  assert.deepEqual(parseKeys("لا").map(k => k.ch), ["ل", "ا"]);
  assert.deepEqual(parseKeys("👨\u200d👩\u200d👧").length, 1);
  assert.deepEqual(parseKeys("🇮🇶").map(k => k.ch), ["🇮🇶"]);
  assert.deepEqual(parseKeys("日本").map(k => k.ch), ["日", "本"]);
  // a string chunk that ends between the two halves of a surrogate pair waits for the rest
  const out = [];
  const p = createKeyParser(k => out.push(k.ch));
  p.feed("\ud83d");
  assert.deepEqual(out, []);
  p.feed("\ude00");
  assert.deepEqual(out, ["😀"]);
});

test("bracketed paste: one key, CRLF normalised, markers split anywhere", () => {
  const k = one("\x1b[200~hello\r\nworld\rend\x1b[201~");
  assert.equal(k.name, "paste");
  assert.equal(k.paste, "hello\nworld\nend");
  assert.equal(k.ctrl, false);
  assert.deepEqual(labels("a\x1b[200~x\x1b[201~b"), ["a", "paste", "b"]);
  assert.deepEqual(labels("\x1b[200~\x1b[201~"), []);
  const text = "line one\r\nline two with ESC-ish \x1b[A and \x1b text\r\nمرحبا";
  const stream = "\x1b[200~" + text + "\x1b[201~";
  for (let cut = 1; cut < stream.length; cut++) {
    const out = [];
    const p = createKeyParser(key => out.push(key));
    p.feed(stream.slice(0, cut));
    p.feed(stream.slice(cut));
    p.flush();
    assert.equal(out.length, 1, `cut ${cut}`);
    assert.equal(out[0].paste, text.replace(/\r\n/g, "\n"), `cut ${cut}`);
  }
  // a CR at the end of one chunk and the LF at the start of the next stay one line break
  const out = [];
  const p = createKeyParser(key => out.push(key));
  p.feed("\x1b[200~a\r");
  p.feed("\nb\x1b[201~");
  assert.equal(out[0].paste, "a\nb");
});

test("bracketed paste: huge payloads stay linear and intact", () => {
  const line = "x".repeat(99) + "\n";
  const payload = line.repeat(100_000); // ~10 MB
  const out = [];
  const p = createKeyParser(key => out.push(key));
  const bytes = Buffer.from("\x1b[200~" + payload + "\x1b[201~z", "utf8");
  const started = Date.now();
  for (let i = 0; i < bytes.length; i += 65536) p.feed(bytes.subarray(i, i + 65536));
  p.flush();
  assert.ok(Date.now() - started < 5000, "paste should be parsed in linear time");
  assert.equal(out.length, 2);
  assert.equal(out[0].paste.length, payload.length);
  assert.equal(out[0].paste, payload);
  assert.equal(out[1].ch, "z");
});

test("an unterminated paste is delivered after a stall and input works again", () => {
  const clock = fakeClock();
  const out = [];
  const p = createKeyParser(k => out.push(k), { setTimer: clock.setTimer, clearTimer: clock.clearTimer, pasteStallMs: 1000 });
  p.feed("\x1b[200~half a paste");
  assert.deepEqual(out, []);
  clock.advance(999);
  assert.deepEqual(out, []);
  clock.advance(2);
  assert.equal(out.length, 1);
  assert.equal(out[0].paste, "half a paste");
  p.feed("q");
  assert.equal(out[1].ch, "q");
});

test("terminals without bracketed paste: a multi-line burst is a paste, normal typing is not", () => {
  assert.deepEqual(labels("one\rtwo\rthree"), ["paste"]);
  assert.equal(one("one\rtwo\rthree").paste, "one\ntwo\nthree");
  assert.deepEqual(labels("one\r\ntwo"), ["paste"]);
  assert.deepEqual(labels("a\rb"), ["a", "return", "b"]); // two lines in one read can still be fast typing
  assert.deepEqual(labels("hello\r"), ["h", "e", "l", "l", "o", "return"]);
  assert.deepEqual(labels("ab"), ["a", "b"]);
  assert.deepEqual(labels("one\rtwo\rthree", { heuristicPaste: false }).length, 13);
});

test("flush resolves pending state and dispose forgets it", () => {
  const out = [];
  const p = createKeyParser(k => out.push(keyLabel(k)));
  p.feed("\x1b");
  p.flush();
  assert.deepEqual(out, ["escape"]);
  p.feed("\x1b[");
  p.dispose();
  p.feed("a");
  assert.deepEqual(out, ["escape", "a"]);
});

test("garbled sequences do not swallow what follows", () => {
  assert.deepEqual(labels("\x1b[1;\u0003x"), ["unknown", "ctrl+c", "x"]);
  // a runaway parameter string is given up on instead of waiting forever for its final byte
  const out = [];
  const p = createKeyParser(k => out.push(k));
  p.feed("\x1b[" + "1;".repeat(200));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "unknown");
  p.feed("a");
  assert.equal(out[1].ch, "a");
});

test("the whole keyboard in one burst keeps its order", () => {
  const input = "hi\x1b[A\x1b[1;5C\x1bb\x03مرحبا\x1b[200~p\x1b[201~\x7f";
  assert.deepEqual(labels(input), ["h", "i", "up", "ctrl+right", "alt+b", "ctrl+c", "م", "ر", "ح", "ب", "ا", "paste", "backspace"]);
});
