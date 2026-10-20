import test from "node:test";
import assert from "node:assert/strict";
import { createScreen, clipLine, fitLine } from "../../src/ui/screen.js";
import { setArabicMode, stringWidth } from "../../src/text/display.js";
import { fakeTTY, fakeStdin, fakeClock } from "./term-helpers.js";

setArabicMode("on");

const MODERN = { WT_SESSION: "x", TERM: "xterm-256color" };

function make({ cols = 30, rows = 8, env = MODERN, platform = "linux", stripMarks, clock = fakeClock() } = {}) {
  const { out, vt } = fakeTTY({ cols, rows });
  const sin = fakeStdin();
  const screen = createScreen({ stdin: sin, stdout: out, env, platform, stripMarks, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { screen, out, vt, sin, clock };
}

const lastWrite = out => out.writes[out.writes.length - 1];

test("not a TTY: print writes plain lines, nothing else is ever emitted", () => {
  const chunks = [];
  const stdout = { isTTY: false, write: s => { chunks.push(s); return true; }, on() {}, removeListener() {} };
  const screen = createScreen({ stdin: fakeStdin({ isTTY: false }), stdout, env: {} });
  assert.equal(screen.isTTY, false);
  screen.print(["one", "two"]);
  screen.print("three\nfour");
  screen.setLive(["live"], { row: 0, col: 1 });
  screen.clearLive();
  screen.title("x");
  screen.print([]);
  assert.deepEqual(chunks, ["one\ntwo\n", "three\nfour\n"]);
  assert.equal(screen.width(), 80);
  assert.equal(screen.height(), 24);
  screen.dispose();
  screen.dispose();
  assert.equal(chunks.length, 2);
  assert.ok(!chunks.join("").includes("\x1b"));
});

test("the live region is redrawn in place and print() keeps it at the bottom", () => {
  const { screen, vt, clock } = make();
  screen.setLive(["> hello"], { row: 0, col: 7 });
  assert.deepEqual(vt.all(), ["> hello"]);
  clock.advance(20);
  screen.setLive(["> hello w"], { row: 0, col: 9 });
  assert.deepEqual(vt.all(), ["> hello w"]);
  screen.print(["first", "second"]);
  assert.deepEqual(vt.all(), ["first", "second", "> hello w"]);
  screen.print("third");
  assert.deepEqual(vt.all(), ["first", "second", "third", "> hello w"]);
  clock.advance(20);
  screen.setLive(["a", "b", "c"], null);
  assert.deepEqual(vt.all(), ["first", "second", "third", "a", "b", "c"]);
  clock.advance(20);
  screen.setLive(["only"], null);
  assert.deepEqual(vt.all(), ["first", "second", "third", "only"]);
  screen.clearLive();
  assert.deepEqual(vt.all(), ["first", "second", "third"]);
  screen.print("fourth");
  assert.deepEqual(vt.all(), ["first", "second", "third", "fourth"]);
  screen.dispose();
});

test("the caret lands on the requested row and column; null hides it", () => {
  const { screen, vt, clock } = make();
  screen.setLive(["first row", "second row", "third"], { row: 1, col: 4 });
  assert.deepEqual([vt.y, vt.x, vt.cursorHidden], [1, 4, false]);
  clock.advance(20);
  screen.setLive(["first row", "second row", "third"], { row: 0, col: 0 });
  assert.deepEqual(vt.all(), ["first row", "second row", "third"]);
  assert.deepEqual([vt.y, vt.x, vt.cursorHidden], [0, 0, false]);
  clock.advance(20);
  screen.setLive(["one", "two"], null);
  assert.equal(vt.cursorHidden, true);
  assert.deepEqual(vt.all(), ["one", "two"]);
  clock.advance(20);
  screen.setLive(["one", "two"], { row: 99, col: 999 }); // out of range is clamped, never an error
  assert.deepEqual([vt.y, vt.x], [1, 29]);
  screen.dispose();
});

test("a region that grows and shrinks at the bottom of the screen leaves no residue", () => {
  const { screen, vt, clock } = make({ rows: 6 });
  screen.print(["l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
  for (const n of [1, 3, 5, 2, 4, 1]) {
    clock.advance(20);
    screen.setLive(Array.from({ length: n }, (_, k) => `live ${n}.${k}`), { row: n - 1, col: 2 });
    const all = vt.all();
    assert.deepEqual(all.slice(0, 7), ["l1", "l2", "l3", "l4", "l5", "l6", "l7"], `after ${n} rows`);
    assert.deepEqual(all.slice(7), Array.from({ length: n }, (_, k) => `live ${n}.${k}`), `after ${n} rows`);
  }
  screen.dispose();
});

test("a region taller than the terminal is clipped to the rows that fit, keeping the caret row", () => {
  const { screen, vt } = make({ rows: 5 });
  const lines = Array.from({ length: 12 }, (_, k) => `row ${k}`);
  screen.setLive(lines, { row: 11, col: 3 });
  assert.deepEqual(vt.all(), ["row 8", "row 9", "row 10", "row 11"]);
  assert.deepEqual([vt.y, vt.x], [3, 3]);
  const second = make({ rows: 5 });
  second.screen.setLive(lines, { row: 1, col: 2 });
  assert.deepEqual(second.vt.all(), ["row 1", "row 2", "row 3", "row 4"]);
  assert.deepEqual([second.vt.y, second.vt.x], [0, 2]);
  screen.dispose();
  second.screen.dispose();
});

test("lines are clipped to the width; a full-width line does not add a row", () => {
  const { screen, vt } = make({ cols: 20 });
  screen.setLive(["x".repeat(20), "y".repeat(40), "z"], null);
  assert.deepEqual(vt.all(), ["x".repeat(20), "y".repeat(20), "z"]);
  assert.equal(clipLine("abcdef", 4), "abcd\x1b[0m");
  assert.equal(clipLine("abc", 4), "abc");
  assert.equal(clipLine("\x1b[31mabcdef\x1b[39m", 3), "\x1b[31mabc\x1b[0m");
  assert.equal(stringWidth(clipLine("日本語テキスト", 7)), 6);
  assert.equal(clipLine("e\u0301e\u0301e\u0301", 2), "e\u0301e\u0301\x1b[0m");
  assert.equal(clipLine("abc", 0), "");
  screen.dispose();
});

test("marks the text layer counts as zero columns are counted as one so a line can never wrap", () => {
  const shadda = String.fromCharCode(0x651);
  const beh = String.fromCharCode(0x628);
  const full = "x".repeat(19) + beh + shadda; // 20 columns by our count, 21 by a console that gives the mark a cell
  assert.equal(fitLine(full, 20, "win32"), "x".repeat(19) + "\x1b[0m", "no blanks to give up: the line is cut one column short");
  assert.equal(fitLine(beh + shadda, 20, "win32"), beh + shadda);
  const padded = " ".repeat(18) + beh + shadda + beh; // right-aligned: 20 wide by our count
  assert.equal(fitLine(padded, 20, "win32"), " ".repeat(17) + beh + shadda + beh, "a leading blank makes room");
  const styled = "\x1b[2m" + " ".repeat(10) + "\x1b[22m";
  assert.equal(fitLine(styled, 20, "win32"), styled, "lines without marks are left alone");
  const twice = " ".repeat(18) + beh + shadda + beh + shadda;
  assert.equal(fitLine(twice, 20, "win32"), " ".repeat(16) + beh + shadda + beh + shadda);
  assert.equal(fitLine("x".repeat(40), 20, "win32"), "x".repeat(20) + "\x1b[0m");
  assert.equal(fitLine(full, 20, "linux"), full, "off Windows a mark is zero-width, so the line fits");
  const { screen, vt } = make({ cols: 20, platform: "win32", stripMarks: false });
  screen.setLive([full, padded], null);
  assert.deepEqual(vt.all(), ["x".repeat(19), " ".repeat(17) + beh + shadda + beh]);
  screen.dispose();
});

test("newlines inside a live line cannot break the row bookkeeping", () => {
  const { screen, vt, clock } = make();
  screen.setLive(["a\nb", "c\r\nd"], null);
  assert.deepEqual(vt.all(), ["a b", "c d"]);
  clock.advance(20);
  screen.setLive(["z"], null);
  assert.deepEqual(vt.all(), ["z"]);
  screen.dispose();
});

test("redraws are throttled to one per frame, the newest state always wins", () => {
  const { screen, out, vt, clock } = make();
  screen.setLive(["v1"], null);
  assert.equal(out.writes.length, 1); // first update after a quiet period: immediate
  screen.setLive(["v2"], null);
  screen.setLive(["v3"], null);
  screen.setLive(["v4"], null);
  assert.equal(out.writes.length, 1);
  assert.deepEqual(vt.all(), ["v1"]);
  clock.advance(15);
  assert.equal(out.writes.length, 1);
  clock.advance(2);
  assert.equal(out.writes.length, 2);
  assert.deepEqual(vt.all(), ["v4"]);
  clock.advance(100);
  assert.equal(out.writes.length, 2);
  screen.setLive(["v5"], null);
  assert.equal(out.writes.length, 3);
  screen.setLive(["v6"], null);
  screen.print("committed"); // print flushes synchronously with the newest state
  assert.deepEqual(vt.all(), ["committed", "v6"]);
  clock.advance(100);
  assert.deepEqual(vt.all(), ["committed", "v6"]);
  screen.setLive(["v7"], null);
  screen.dispose(); // dispose never leaves a pending frame behind
  clock.advance(100);
  assert.deepEqual(vt.all(), ["committed"]);
});

test("synchronized output wraps every repaint where it is supported and is skipped on legacy consoles", () => {
  const modern = make();
  modern.screen.setLive(["hi"], { row: 0, col: 1 });
  modern.screen.print("p");
  for (const w of modern.out.writes) {
    assert.ok(w.startsWith("\x1b[?2026h") && w.endsWith("\x1b[?2026l"), JSON.stringify(w));
  }
  modern.screen.dispose();
  assert.equal(modern.vt.syncOpen, false);

  const legacy = make({ env: {}, platform: "win32" });
  legacy.screen.setLive(["hi"], { row: 0, col: 1 });
  legacy.screen.print("p");
  legacy.screen.dispose();
  assert.ok(!legacy.out.writes.join("").includes("2026"));
  assert.deepEqual(legacy.vt.all(), ["p"]);

  const wt = make({ env: { WT_SESSION: "1" }, platform: "win32" });
  wt.screen.setLive(["hi"], null);
  assert.ok(wt.out.writes.join("").includes("?2026h"));
  wt.screen.dispose();

  const noSync = make({ env: { ...MODERN, FIRAS_NO_SYNC: "1" } });
  noSync.screen.setLive(["hi"], null);
  assert.ok(!noSync.out.writes.join("").includes("2026"));
  noSync.screen.dispose();

  const linuxVt = make({ env: { TERM: "linux" } });
  linuxVt.screen.setLive(["hi"], null);
  assert.ok(!linuxVt.out.writes.join("").includes("2026"));
  linuxVt.screen.dispose();
});

test("backpressure: live updates wait for drain (newest only), printed text is never lost or reordered", () => {
  const { screen, out, vt, clock } = make();
  screen.setLive(["a"], null);
  out.refuse = true;
  clock.advance(20);
  screen.setLive(["b"], null); // this write reports a full buffer
  assert.deepEqual(vt.all(), ["b"]);
  clock.advance(20);
  screen.setLive(["c"], null);
  clock.advance(20);
  screen.setLive(["d"], null);
  assert.deepEqual(vt.all(), ["b"]);
  screen.print(["x", "y"]);
  assert.deepEqual(vt.all(), ["x", "y", "d"]);
  screen.print("z");
  assert.deepEqual(vt.all(), ["x", "y", "z", "d"]);
  clock.advance(20);
  screen.setLive(["e"], null);
  assert.deepEqual(vt.all(), ["x", "y", "z", "d"]);
  out.refuse = false;
  out.emit("drain");
  assert.deepEqual(vt.all(), ["x", "y", "z", "e"]);
  screen.dispose();
});

test("onKey turns raw mode and bracketed paste on with the first subscriber and off with the last", () => {
  const { screen, sin, vt } = make();
  assert.equal(sin.raw, false);
  const got = [];
  const off1 = screen.onKey(k => got.push(["one", k.name === "char" ? k.ch : k.name]));
  assert.equal(sin.raw, true);
  assert.equal(vt.paste, true);
  assert.equal(sin.paused, false);
  const off2 = screen.onKey(k => got.push(["two", k.name === "char" ? k.ch : k.name]));
  sin.type("a");
  sin.type("\x1b[A");
  assert.deepEqual(got, [["one", "a"], ["two", "a"], ["one", "up"], ["two", "up"]]);
  off1();
  off1();
  assert.equal(sin.raw, true);
  sin.type("b");
  assert.deepEqual(got.at(-1), ["two", "b"]);
  off2();
  assert.equal(sin.raw, false);
  assert.equal(vt.paste, false);
  assert.equal(sin.paused, true);
  assert.equal(sin.listenerCount("data"), 0);
  sin.type("c");
  assert.equal(got.length, 5);
  screen.dispose();
});

test("keys: paste, split UTF-8 and the lone ESC all arrive through onKey", () => {
  const clock = fakeClock();
  const { screen, sin } = make({ clock });
  const got = [];
  screen.onKey(k => got.push(k));
  const bytes = Buffer.from("م", "utf8");
  sin.type(bytes.subarray(0, 1));
  assert.equal(got.length, 0);
  sin.type(bytes.subarray(1));
  assert.equal(got[0].ch, "م");
  sin.type("\x1b[200~multi\r\nline\x1b[201~");
  assert.equal(got[1].name, "paste");
  assert.equal(got[1].paste, "multi\nline");
  screen.dispose();
});

test("a failing subscriber does not stop the others and is reported", () => {
  const errors = [];
  const { out, vt } = fakeTTY();
  void vt;
  const sin = fakeStdin();
  const screen = createScreen({ stdin: sin, stdout: out, env: MODERN, platform: "linux", onError: e => errors.push(e.message) });
  const seen = [];
  screen.onKey(() => { throw new Error("subscriber broke"); });
  screen.onKey(k => seen.push(k.ch));
  sin.type("qr");
  assert.deepEqual(seen, ["q", "r"]);
  assert.deepEqual(errors, ["subscriber broke", "subscriber broke"]);
  screen.dispose();
});

test("suspend hands the terminal to a child program and resume takes it back", () => {
  const { screen, sin, vt, out, clock } = make();
  const got = [];
  screen.onKey(k => got.push(k.ch));
  screen.print("history");
  clock.advance(20);
  screen.setLive(["> typing"], { row: 0, col: 8 });
  assert.deepEqual(vt.all(), ["history", "> typing"]);
  screen.suspend();
  assert.deepEqual(vt.all(), ["history"]);
  assert.equal(sin.raw, false);
  assert.equal(vt.paste, false);
  assert.equal(vt.cursorHidden, false);
  assert.equal(sin.listenerCount("data"), 0);
  sin.type("x");
  assert.deepEqual(got, []);
  vt.write("child output\r\n"); // the child program writes straight to the terminal
  screen.setLive(["> still typing"], { row: 0, col: 3 }); // state is kept, nothing drawn
  assert.deepEqual(vt.all(), ["history", "child output"]);
  screen.print("while suspended");
  assert.deepEqual(vt.all(), ["history", "child output", "while suspended"]);
  screen.suspend();
  screen.resume();
  assert.equal(sin.raw, true);
  assert.equal(vt.paste, true);
  clock.advance(20);
  assert.deepEqual(vt.all(), ["history", "child output", "while suspended", "> still typing"]);
  sin.type("y");
  assert.deepEqual(got, ["y"]);
  screen.resume();
  assert.ok(out.writes.length > 3);
  screen.dispose();
});

test("dispose restores everything, is idempotent, and printing still works afterwards", () => {
  const { screen, sin, vt, out } = make();
  screen.onKey(() => {});
  screen.setLive(["> unsent"], { row: 0, col: 3 });
  screen.print("kept");
  assert.equal(sin.raw, true);
  screen.dispose();
  assert.deepEqual(vt.all(), ["kept"]); // the transient live region is gone
  assert.equal(sin.raw, false);
  assert.equal(vt.paste, false);
  assert.equal(vt.cursorHidden, false);
  assert.equal(vt.syncOpen, false);
  assert.equal(sin.listenerCount("data"), 0);
  assert.equal(sin.paused, true);
  assert.equal(out.listenerCount("resize"), 0);
  assert.equal(out.listenerCount("drain"), 0);
  const n = out.writes.length;
  screen.dispose();
  assert.equal(out.writes.length, n);
  screen.setLive(["ignored"], null);
  screen.print("after");
  assert.deepEqual(vt.all(), ["kept", "after"]);
  assert.ok(vt.x === 0);
  assert.ok(out.writes.join("").includes("\x1b[0m"));
});

test("resize: width follows the terminal, subscribers hear about it once, the region is redrawn", () => {
  const { screen, out, vt, clock } = make({ cols: 30 });
  let calls = 0;
  const off = screen.onResize(() => { calls++; screen.setLive(["w=" + screen.width()], null); });
  screen.setLive(["w=30"], null);
  assert.equal(screen.width(), 30);
  out.resizeTo(24, 8);
  assert.equal(screen.width(), 24);
  assert.equal(calls, 1);
  clock.advance(20);
  assert.deepEqual(vt.all(), ["w=24"]);
  out.resizeTo(24, 8); // nothing changed
  assert.equal(calls, 1);
  out.columns = 10; // the terminal changed without an event: the next repaint notices
  screen.setLive(["x"], null);
  clock.advance(20);
  return new Promise(r => setImmediate(r)).then(() => {
    assert.equal(calls, 2);
    off();
    out.resizeTo(40, 8);
    assert.equal(calls, 2);
    screen.dispose();
  });
});

test("width() and height() clamp and fall back", () => {
  const { screen, out } = make({ cols: 30 });
  out.columns = 5;
  assert.equal(screen.width(), 20);
  out.columns = undefined;
  assert.equal(screen.width(), 80);
  out.rows = undefined;
  assert.equal(screen.height(), 24);
  screen.dispose();
});

test("a narrower terminal re-wraps the old region: the climb back uses the re-estimated row count", () => {
  const { screen, out, clock } = make({ cols: 40, rows: 20 });
  screen.setLive(["a".repeat(30), "b".repeat(30), "c".repeat(30)], null);
  out.resizeTo(20, 20); // each 30-wide line now takes two rows: 2 + 2 + (cursor on the last line, col 30 -> second row)
  clock.advance(20);
  const w = lastWrite(out);
  assert.ok(w.includes("\x1b[5A"), JSON.stringify(w));
  screen.dispose();
});

test("title and process hooks", () => {
  const before = { exit: process.listenerCount("exit"), unc: process.listenerCount("uncaughtException"), int: process.listenerCount("SIGINT") };
  const a = make();
  const b = make();
  // The hooks are process-wide and installed once. Their presence is proved below by finding the
  // exit hook and watching it restore both screens; a raw listener count is order-dependent because
  // an earlier test may have left the registry installed.
  a.screen.title("Firas\x1b]2;evil\x07 Code");
  assert.equal(a.vt.title, "Firas ]2;evil  Code");
  // the exit hook restores every live screen
  a.screen.onKey(() => {});
  b.screen.setLive(["x"], { row: 0, col: 0 });
  const onExit = process.listeners("exit").find(f => f.name === "onProcessExit");
  onExit();
  assert.equal(a.sin.raw, false);
  assert.equal(b.vt.cursorHidden, false);
  assert.deepEqual(b.vt.all(), []);
  a.screen.dispose();
  b.screen.dispose();
  assert.equal(process.listenerCount("exit"), before.exit);
  assert.equal(process.listenerCount("uncaughtException"), before.unc);
  assert.equal(process.listenerCount("SIGINT"), before.int);
});

test("the uncaught-exception hook restores the terminal before anyone prints", () => {
  const { screen, vt, sin } = make();
  screen.onKey(() => {});
  screen.setLive(["> busy"], { row: 0, col: 2 });
  const hook = process.listeners("uncaughtException").find(f => f.name === "onUncaught");
  assert.ok(hook);
  assert.ok(process.listenerCount("uncaughtException") > 1, "the test runner has its own listener, so the hook must not exit");
  hook(new Error("boom"));
  assert.equal(sin.raw, false);
  assert.equal(vt.cursorHidden, false);
  assert.deepEqual(vt.all(), []);
  screen.dispose();
});

test("clear() scrolls the visible page into the scrollback and starts again on the top row", () => {
  const { screen, vt } = make({ cols: 30, rows: 8 });
  screen.print(["one", "two", "three"]);
  screen.setLive(["prompt"], { row: 0, col: 2 });
  screen.clear();
  assert.deepEqual(vt.rows_().filter(Boolean), [], "nothing of the old page is left on screen (or the live region yet)");
  assert.ok(vt.scrollback.some(line => line.includes("three")), "the old page went to the terminal's scrollback");
  assert.equal(vt.y, 0, "the next output starts on the first row");
  screen.print(["fresh"]);
  assert.equal(vt.rows_()[0], "fresh");
  assert.ok(vt.rows_().some(row => row.includes("prompt")), "the live region comes back under it");
  screen.dispose();
});
