import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../../src/i18n/index.js";
import { setColorLevel, colorLevel, sym } from "../../src/ui/theme.js";
import { stringWidth, stripAnsi, setArabicMode } from "../../src/text/display.js";
import {
  contentWidth, cleanText, createStreamCleaner, truncateLogical, fmtDuration, fmtTokens, renderNotice, renderTurnFooter,
  renderTodos, toolHeader, renderToolCard, renderRunningCard, frame, menuRows, runMenu, permissionBody, permissionDialog,
  questionDialog, planDialog, pickDialog, FOLD_BODY_LINES, FOLD_DIFF_LINES, UP, DOWN,
} from "../../src/ui/views.js";
import { sleep } from "./helpers.js";

const colorBefore = colorLevel();
before(() => { setLang("en"); setArabicMode("on"); setColorLevel(0); });
after(() => { setColorLevel(colorBefore); setArabicMode("auto"); setLang("en"); });

const plain = lines => lines.map(stripAnsi);
const rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const P = rx(sym.prompt);

function fakeHost(width = 90) {
  const host = {
    shown: [], printed: [], hides: 0, handlers: [],
    width: () => width,
    show(lines, cursor) { host.shown.push({ lines, cursor }); },
    hide() { host.hides++; },
    onKey(cb) { host.handlers.push(cb); return () => { host.handlers = host.handlers.filter(h => h !== cb); }; },
    print(lines) { host.printed.push(...lines); },
    key(key) { for (const cb of [...host.handlers]) cb({ ctrl: false, alt: false, shift: false, seq: "", ...key }); },
    press(name, mods) { host.key({ name, ...mods }); },
    char(ch, mods) { host.key({ name: "char", ch, ...mods }); },
    get last() { return host.shown.at(-1)?.lines ?? []; },
    text: () => stripAnsi(host.last.join("\n")),
  };
  return host;
}

test("content width leaves a 2-column gutter on each side and never exceeds 100", () => {
  assert.equal(contentWidth(80), 76);
  assert.equal(contentWidth(200), 100);
  assert.equal(contentWidth(10), 20);
  assert.equal(contentWidth(undefined), 76);
});

test("cleanText removes escape sequences and controls, expands tabs, keeps what a progress bar ended on", () => {
  assert.equal(cleanText("\x1b[31mred\x1b[0m ok"), "red ok");
  assert.equal(cleanText("a\x00b\x07c\x7fd"), "abcd");
  assert.equal(cleanText("a\tb"), "a   b");
  assert.equal(cleanText("\tx"), "    x");
  assert.equal(cleanText("a\tb", { tabs: 0 }), "a\tb");
  assert.equal(cleanText("one\r\ntwo\r\n"), "one\ntwo\n");
  assert.equal(cleanText("10%\r50%\r100%\nnext"), "100%\nnext");
  assert.equal(cleanText("\x1b]0;evil title\x07text"), "text");
  assert.equal(cleanText("مرحبا‮evil"), "مرحبا‮evil".replace(/[‎‏؜‪-‮⁦-⁩]/g, ""), "direction controls are dropped: they would reorder what the box shows");
  assert.equal(cleanText("مرحبا‮evil", { tabs: 0 }), "مرحبا‮evil", "print mode keeps the text as it is");
  assert.equal(cleanText(null), "");
});

test("a stream cleaner holds back an escape sequence cut by a chunk boundary", () => {
  const cleaner = createStreamCleaner();
  assert.equal(cleaner.push("hello \x1b[3"), "hello ");
  assert.equal(cleaner.push("1mred\x1b[0m and \x1b"), "red and ");
  assert.equal(cleaner.push("[2Jgone"), "gone");
  assert.equal(cleaner.push("tab\there"), "tab    here");
  assert.equal(createStreamCleaner({ tabs: 0 }).push("a\tb"), "a\tb");
  const lonely = createStreamCleaner();
  assert.equal(lonely.push("x\x1b"), "x");
  assert.equal(lonely.flush(), "");
  assert.equal(lonely.push("y"), "y", "a dangling fragment is forgotten after flush");
});

test("truncating works on logical text and never cuts a letter in half", () => {
  assert.equal(truncateLogical("short", 20), "short");
  const long = truncateLogical("a".repeat(50), 10);
  assert.ok(stringWidth(long) <= 10);
  assert.ok(long.endsWith(sym.ellipsis));
  const ar = truncateLogical("هذا نص عربي طويل جداً يحتاج إلى قص في مكان مناسب", 14);
  assert.ok(stringWidth(ar) <= 14, `${stringWidth(ar)}`);
  assert.ok(ar.endsWith(sym.ellipsis));
  assert.equal(truncateLogical("  many   spaces \n here ", 40), "many spaces here");
});

test("durations and token counts are short and plain", () => {
  setLang("en");
  assert.equal(fmtDuration(0), "0 s");
  assert.equal(fmtDuration(12_400), "12 s");
  assert.equal(fmtDuration(65_000), "1 m 5 s");
  setLang("ar");
  assert.equal(fmtDuration(12_400), "12 ث");
  assert.equal(fmtDuration(125_000), "2 د 5 ث");
  setLang("en");
  assert.deepEqual([0, 842, 1000, 3200, 12_500, 1_400_000].map(fmtTokens), ["0", "842", "1k", "3.2k", "13k", "1.4M"]);
});

test("notices carry a marker and are one paragraph; Arabic ones are right-aligned", () => {
  const info = plain(renderNotice("info", "All good", 60));
  assert.equal(info.length, 1);
  assert.match(info[0], /^. All good$/);
  assert.match(plain(renderNotice("warn", "Careful", 60))[0], /Careful/);
  assert.match(plain(renderNotice("error", "Broke", 60))[0], /Broke/);
  const ar = renderNotice("warn", "تعذّر حفظ الجلسة على القرص.", 60);
  assert.equal(ar.length, 1);
  assert.ok(/^ +/.test(stripAnsi(ar[0])), "padded on the left = right-aligned");
  const wrapped = renderNotice("info", "word ".repeat(40), 30);
  assert.ok(wrapped.length > 3);
  assert.ok(wrapped.every(line => stringWidth(line) <= 30));
});

test("a notice from the model or a tool cannot smuggle escape sequences", () => {
  const out = renderNotice("error", "bad \x1b[2J\x1b]0;x\x07 text", 60).join("\n");
  assert.ok(!out.includes("\x1b[2J") && !out.includes("\x07"));
});

test("the turn footer says how long it took, what it cost, and why it stopped when that was not normal", () => {
  setLang("en");
  assert.equal(stripAnsi(renderTurnFooter({ ms: 12_000, inTokens: 3200, outTokens: 1100 }, 80)[0]), `${sym.think} 12 s ${sym.dot} ${UP} 3.2k ${DOWN} 1.1k`);
  assert.match(stripAnsi(renderTurnFooter({ ms: 800, stopReason: "aborted" }, 80)[0]), new RegExp(`interrupted ${rx(sym.dot)} 1 s`));
  assert.match(stripAnsi(renderTurnFooter({ ms: 800, stopReason: "max_steps" }, 80)[0]), /step limit/);
  assert.ok(renderTurnFooter({ ms: 5000, stopReason: "end_turn" }, 80)[0].length > 0);
});

test("todos: pending, active and done look different and Arabic items wrap", () => {
  const lines = plain(renderTodos([
    { content: "Write tests", status: "completed" },
    { content: "Run the build", activeForm: "Running the build", status: "in_progress" },
    { content: "Ship it", status: "pending" },
  ], 60));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Write tests/);
  assert.match(lines[1], /Running the build/, "the active item shows its -ing form");
  assert.match(lines[2], /Ship it/);
  assert.ok(lines[0].includes(sym.checked) && lines[2].includes(sym.checkbox), "done and pending use different boxes");
  const long = renderTodos([{ content: "مهمة طويلة جداً ".repeat(8), status: "pending" }], 40);
  assert.ok(long.length > 1);
  assert.ok(long.every(line => stringWidth(line) <= 40));
});

test("a tool header reads Name(summary) and fits its width", () => {
  assert.equal(stripAnsi(toolHeader({ name: "Read", summary: "src/app.js", readOnly: true }, 60)), `${sym.bullet} Read(src/app.js)`);
  const long = toolHeader({ name: "Bash", summary: "x".repeat(200) }, 50);
  assert.ok(stringWidth(long) <= 50);
  assert.ok(stripAnsi(long).endsWith(`${sym.ellipsis})`));
  assert.equal(stripAnsi(toolHeader({ name: "TodoWrite", summary: "" }, 50)), `${sym.bullet} TodoWrite`);
  const ar = stripAnsi(toolHeader({ name: "Agent", summary: "ابحث عن الملفات" }, 60));
  assert.ok(ar.startsWith(`${sym.bullet} Agent(`), "the card keeps its left-to-right structure");
  assert.ok(stringWidth(ar) <= 60);
});

test("the bullet colour says how it went", () => {
  setColorLevel(3);
  try {
    const running = toolHeader({ name: "Bash", summary: "ls" }, 40, "running");
    const ok = toolHeader({ name: "Bash", summary: "ls" }, 40, "ok");
    const bad = toolHeader({ name: "Bash", summary: "ls" }, 40, "error");
    const risky = toolHeader({ name: "Bash", summary: "ls", risk: "high" }, 40, "running");
    assert.equal(new Set([running, ok, bad]).size, 3);
    assert.notEqual(risky, running);
  } finally { setColorLevel(0); }
});

test("a finished card: header, result line, and a folded body with a way to the rest", () => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const card = renderToolCard({ name: "Bash", summary: "npm test" }, { ok: true, summary: "Done in 2.1 s", body }, 70);
  const lines = plain(card.lines);
  assert.equal(lines[0], `${sym.bullet} Bash(npm test)`);
  assert.equal(lines[1], `  ${sym.corner} Done in 2.1 s`);
  assert.equal(lines.filter(l => /^ {4}line \d+$/.test(l)).length, FOLD_BODY_LINES);
  assert.match(lines.at(-1), /\+22/);
  assert.match(lines.at(-1), /Ctrl\+O/);
  assert.equal(card.hidden, 22);
  assert.equal(card.full.length, 2 + 30);
  assert.equal(plain(card.full).at(-1), "    line 30");
});

test("a short body is shown whole; a body one line over the fold is not folded for a single line", () => {
  const nine = Array.from({ length: FOLD_BODY_LINES + 1 }, (_, i) => `row ${i}`).join("\n");
  const card = renderToolCard({ name: "Bash", summary: "x" }, { ok: true, summary: "ok", body: nine }, 70);
  assert.equal(card.hidden, 0, "a fold marker never replaces a single line");
  assert.equal(card.lines.length, 2 + FOLD_BODY_LINES + 1);
  const few = renderToolCard({ name: "Bash", summary: "x" }, { ok: true, summary: "ok", body: "a\nb" }, 70);
  assert.equal(few.hidden, 0);
  assert.equal(plain(few.lines).length, 4);
});

test("a failed tool shows its message in red and still shows its output", () => {
  setColorLevel(3);
  try {
    const card = renderToolCard({ name: "Bash", summary: "npm test" }, { ok: false, summary: "Exit code 1", body: "boom" }, 70);
    assert.ok(card.lines[1].includes("\x1b[38;2;226;108;108m"), "the message is red");
    assert.equal(plain(card.lines).at(-1), "    boom");
  } finally { setColorLevel(0); }
});

test("output with escape sequences or wide lines cannot break the layout", () => {
  const card = renderToolCard({ name: "Bash", summary: "x" }, { ok: true, summary: "ok", body: "\x1b[2J\x1b[Hscreen wipe\n" + "w".repeat(300) }, 50);
  const lines = plain(card.lines);
  assert.ok(!card.lines.join("").includes("\x1b[2J"));
  assert.ok(lines.every(line => stringWidth(line) <= 50), lines.map(stringWidth).join(","));
});

test("an edit card renders its diff and folds it at 12 lines", () => {
  const oldText = Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`).join("\n");
  const newText = Array.from({ length: 40 }, (_, i) => `const a${i} = ${i + 1};`).join("\n");
  const small = renderToolCard({ name: "Edit", summary: "src/a.js" }, { ok: true, summary: "Edited", diff: { path: "src/a.js", oldText: "a\nb\nc", newText: "a\nB\nc" } }, 70);
  assert.match(plain(small.lines).join("\n"), /B/);
  assert.equal(small.hidden, 0);
  const big = renderToolCard({ name: "Edit", summary: "src/a.js" }, { ok: true, summary: "Edited", diff: { path: "src/a.js", oldText, newText } }, 70);
  assert.ok(big.hidden > 5);
  assert.equal(big.lines.length, 2 + FOLD_DIFF_LINES + 1);
  assert.ok(big.full.length > big.lines.length);
});

test("a running card shows the last three lines of live output", () => {
  const lines = plain(renderRunningCard({ name: "Bash", summary: "npm test" }, ["1", "2", "3", "4", "5"], 60));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(1).map(l => l.trim().replace(new RegExp(`^${rx(sym.pipe)} `), "")), ["3", "4", "5"]);
  assert.equal(plain(renderRunningCard({ name: "Read", summary: "a.js" }, [], 60)).length, 1);
});

test("a frame is a rounded box whose rows all have the same width", () => {
  const box = frame(["one", "مرحبا بالعالم", ""], { width: 40, risk: "high", title: "Title here" });
  const widths = new Set(box.map(stringWidth));
  assert.equal(widths.size, 1, [...widths].join(","));
  assert.equal([...widths][0], 40);
  const text = plain(box);
  assert.ok(text[0].startsWith(sym.boxTL) && text[0].endsWith(sym.boxTR));
  assert.ok(text.at(-1).startsWith(sym.boxBL) && text.at(-1).endsWith(sym.boxBR));
  assert.ok(text[0].includes("Title here"));
});

test("the left edge of a frame takes the risk colour", () => {
  setColorLevel(3);
  try {
    const edges = ["low", "medium", "high"].map(risk => frame(["x"], { width: 30, risk })[1].slice(0, 22));
    assert.equal(new Set(edges).size, 3);
  } finally { setColorLevel(0); }
});

test("menu rows number the choices and mark the selected one", () => {
  const rows = plain(menuRows([{ label: "Yes" }, { label: "Later", hint: "ask again" }, { label: "No" }], 1, { width: 60 }));
  assert.equal(rows[0], "  1. Yes");
  assert.equal(rows[1], `${sym.prompt} 2. Later  ask again`);
  assert.equal(rows[2], "  3. No");
  const multi = plain(menuRows([{ label: "A" }, { label: "B" }], 0, { width: 60, multi: true, checked: new Set([1]) }));
  assert.ok(multi[1].includes(sym.checked) && multi[0].includes(sym.checkbox));
});

test("a card header that is too long keeps the end of a path (the file name) and the start of anything else", () => {
  const path = "src/features/very/deeply/nested/directory/structure/component-name-that-keeps-going.test.js";
  const header = plain([toolHeader({ name: "Read", summary: path, readOnly: true }, 50, "ok")])[0];
  assert.ok(stringWidth(header) <= 50 && header.includes(sym.ellipsis));
  assert.ok(header.includes("keeps-going.test.js)"), header);
  const win = "C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "Teacher" + String.fromCharCode(92) + "Documents" + String.fromCharCode(92) + "very-long-folder-name" + String.fromCharCode(92) + "file.tsx";
  assert.ok(plain([toolHeader({ name: "Edit", summary: win, readOnly: false }, 40, "ok")])[0].includes("file.tsx)"));
  const command = plain([toolHeader({ name: "Bash", summary: "npm run build -- --watch --verbose --config ./webpack.config.js", readOnly: false }, 40, "ok")])[0];
  assert.ok(command.includes("npm run build") && command.includes(sym.ellipsis) && !command.includes("config.js"), command);
});

test("menu hints line up in one column; in the Arabic interface the rows are mirrored and right-aligned", () => {
  const items = [{ label: "off", hint: "no thinking" }, { label: "medium (current)", hint: "balanced" }, { label: "max" }];
  const rows = plain(menuRows(items, 0, { width: 60, rtl: false }));
  assert.equal(rows[0].indexOf("no thinking"), rows[1].indexOf("balanced"), "hints share a column");
  assert.equal(rows[2], "  3. max");

  const arabic = [{ label: "نعم، مرة واحدة" }, { label: "لا", hint: "رفض" }, { label: "Allow edits" }];
  const mirrored = plain(menuRows(arabic, 0, { width: 60, rtl: true }));
  for (const row of mirrored) assert.equal(stringWidth(row), 56, "right-aligned in the box: " + JSON.stringify(row));
  assert.ok(/\.1 \S$/.test(mirrored[0].trimEnd()), "the number and the (mirrored) pointer are on the right: " + JSON.stringify(mirrored[0]));
  assert.ok(mirrored[1].trimEnd().endsWith(".2"), "numbers sit at the right edge: " + JSON.stringify(mirrored[1]));
  assert.ok(mirrored[2].trimEnd().endsWith(".3"), "also in front of a label written in Latin letters: " + JSON.stringify(mirrored[2]));
  setLang("ar");
  try {
    const auto = plain(menuRows(arabic, 1, { width: 60 }));
    assert.equal(stringWidth(auto[0]), 56, "the Arabic interface mirrors by itself");
  } finally { setLang("en"); }
  assert.ok(plain(menuRows(arabic, 1, { width: 60 }))[0].startsWith(" "), "and the English interface does not");
});

test("a menu moves with the arrows, digits only move, Enter confirms, Esc cancels", async () => {
  const host = fakeHost();
  const items = [{ label: "One" }, { label: "Two" }, { label: "Three" }];
  const pending = runMenu(host, { items });
  assert.match(host.text(), new RegExp(P + String.raw` 1\. One`));
  host.press("down");
  host.press("down");
  assert.match(host.text(), new RegExp(P + String.raw` 3\. Three`));
  host.press("down");
  assert.match(host.text(), new RegExp(P + String.raw` 1\. One`), "wraps around");
  host.press("up");
  assert.match(host.text(), new RegExp(P + String.raw` 3\. Three`));
  host.char("2");
  assert.match(host.text(), new RegExp(P + String.raw` 2\. Two`));
  host.char("9");
  assert.match(host.text(), new RegExp(P + String.raw` 2\. Two`), "a number past the end is ignored");
  host.press("return");
  const result = await pending;
  assert.deepEqual(result, { cancelled: false, index: 1, indices: [1] });
  assert.equal(host.handlers.length, 0, "the key listener is released");
  assert.equal(host.hides, 1);

  const second = fakeHost();
  const cancelled = runMenu(second, { items });
  second.press("escape");
  assert.deepEqual(await cancelled, { cancelled: true });
  const third = fakeHost();
  const ctrlC = runMenu(third, { items });
  third.char("c", { ctrl: true });
  assert.deepEqual(await ctrlC, { cancelled: true });
});

test("a multi-choice menu ticks with Space", async () => {
  const host = fakeHost();
  const pending = runMenu(host, { items: [{ label: "A" }, { label: "B" }, { label: "C" }], multi: true });
  host.char(" ");
  host.press("down");
  host.press("down");
  host.char(" ");
  host.press("return");
  assert.deepEqual(await pending, { cancelled: false, index: 2, indices: [0, 2] });
});

test("Enter and digits are ignored while the grace period runs; Esc never is", async () => {
  const host = fakeHost();
  const pending = runMenu(host, { items: [{ label: "A" }, { label: "B" }], graceMs: 80 });
  host.press("return");
  host.char("2");
  assert.match(host.text(), new RegExp(P + String.raw` 1\. A`), "type-ahead did not move or confirm anything");
  assert.equal(host.handlers.length, 1);
  await sleep(100);
  host.char("2");
  host.press("return");
  assert.equal((await pending).index, 1);
  const quick = fakeHost();
  const esc = runMenu(quick, { items: [{ label: "A" }], graceMs: 500 });
  quick.press("escape");
  assert.equal((await esc).cancelled, true);
});

test("aborting the signal closes a menu", async () => {
  const host = fakeHost();
  const control = new AbortController();
  const pending = runMenu(host, { items: [{ label: "A" }], signal: control.signal });
  control.abort();
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(host.handlers.length, 0);
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await runMenu(fakeHost(), { items: [{ label: "A" }], signal: already.signal }), { cancelled: true });
});

const EDIT_REQUEST = {
  id: "t1", tool: "Edit", title: "Edit src/app.js", summary: "src/app.js", risk: "medium",
  diff: { path: "src/app.js", oldText: "const a = 1;\nconst b = 2;\n", newText: "const a = 1;\nconst b = 3;\n" },
  sessionKey: "Edit:*", sessionLabel: "Allow edits in this project for this session",
};

test("the permission box shows the title, the detail and the diff", () => {
  const lines = plain(permissionBody({ ...EDIT_REQUEST, detail: "Because the model said so\nSecond line" }, 80));
  const text = lines.join("\n");
  assert.match(text, /Edit src\/app\.js/);
  assert.match(text, /Because the model said so/);
  assert.match(text, /const b = 3;/);
  assert.ok(!text.includes("\nsrc/app.js\n"), "a summary already in the title is not repeated");
  const bash = plain(permissionBody({ tool: "Bash", title: "Run: npm test", summary: "npm test --coverage", risk: "medium", detail: "x" }, 80)).join("\n");
  assert.match(bash, /npm test --coverage/);
  const folded = plain(permissionBody({ tool: "Bash", title: "t", detail: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") }, 80)).join("\n");
  assert.match(folded, /\+26 more lines/);
});

test("a wrapped bullet in the permission box keeps its text under the text", () => {
  const detail = "• Contains invisible or text-direction characters that can hide part of the command; their codes are spelled out below\n• second";
  const lines = plain(permissionBody({ tool: "Bash", title: "t", detail, risk: "high" }, 50));
  const start = lines.findIndex(line => line.startsWith("• Contains"));
  assert.ok(lines[start + 1].startsWith("  that can hide"), JSON.stringify(lines));
  assert.ok(lines.includes("• second"));
});

test("a direction override in a command cannot change the order in which the box shows it", () => {
  const RLO = String.fromCharCode(0x202e);
  const LRI = String.fromCharCode(0x2066);
  const RLM = String.fromCharCode(0x200f);
  const command = "echo hello " + RLO + "fdp.txt" + LRI + " rm -rf ~" + RLM;
  const shown = plain(permissionBody({ tool: "Bash", title: "Run: " + command, summary: "", risk: "medium", detail: command }, 70)).join(String.fromCharCode(10));
  assert.equal(shown, "Run: echo hello fdp.txt rm -rf ~");
  assert.ok(![RLO, LRI, RLM].some(mark => shown.includes(mark)));
});

test("the permission box does not print the command or path a second time when the title already shows it", () => {
  const command = "Remove-Item -Recurse -Force node_modules";
  const once = plain(permissionBody({ tool: "Bash", title: "Run: " + command, summary: "delete modules", risk: "medium", detail: command }, 80)).join("\n");
  assert.equal(once.split(command).length - 1, 1, once);
  assert.match(once, /delete modules/);
  const path = plain(permissionBody({ ...EDIT_REQUEST, title: "Edit src/utils/format.js", summary: "src/utils/format.js", detail: "src/utils/format.js", diff: undefined }, 80)).join("\n");
  assert.equal(path.split("src/utils/format.js").length - 1, 1, path);
  const longer = plain(permissionBody({ tool: "Bash", title: "Run: npm run build", summary: "", risk: "medium", detail: "npm run build\nnpm test" }, 80)).join("\n");
  assert.match(longer, /npm test/, "a longer or multi-line detail is still shown");
});

test("the permission dialog offers allow, allow for the session, no, and no with a reason", async () => {
  const host = fakeHost();
  const pending = permissionDialog(host, EDIT_REQUEST, { readLine: async () => null });
  const text = host.text();
  assert.match(text, new RegExp(`Permission needed ${rx(sym.dot)} medium risk`));
  assert.match(text, /1\. Yes, allow once/);
  assert.match(text, /2\. Allow edits in this project for this session/);
  assert.match(text, /3\. No\b/);
  assert.match(text, /4\. No, and tell Firas what to do instead/);
  assert.match(text, /Esc deny/);
  host.press("return");
  assert.deepEqual(await pending, { decision: "allow" });
});

test("the session choice only appears when the request can be remembered", async () => {
  const host = fakeHost();
  const { sessionKey, sessionLabel, ...once } = EDIT_REQUEST;
  const pending = permissionDialog(host, once, { readLine: async () => null });
  assert.ok(!/for this session/.test(host.text()));
  assert.match(host.text(), /2\. No\b/);
  host.press("escape");
  assert.deepEqual(await pending, { decision: "deny" });
});

test("choosing allow-for-this-session, no, and Esc", async () => {
  const a = fakeHost();
  const first = permissionDialog(a, EDIT_REQUEST, {});
  a.press("down");
  a.press("return");
  assert.deepEqual(await first, { decision: "allow-session" });
  const b = fakeHost();
  const second = permissionDialog(b, EDIT_REQUEST, {});
  b.char("3");
  b.press("return");
  assert.deepEqual(await second, { decision: "deny" });
  const c = fakeHost();
  const third = permissionDialog(c, EDIT_REQUEST, {});
  c.press("escape");
  assert.deepEqual(await third, { decision: "deny" });
});

test("denying with a reason hands the text back; an empty reason returns to the choices", async () => {
  const host = fakeHost();
  const answers = ["", "use a smaller change"];
  const asked = [];
  const pending = permissionDialog(host, EDIT_REQUEST, { readLine: async options => { asked.push(options); return answers.shift(); } });
  host.char("4");
  host.press("return");
  await sleep(5);
  assert.equal(asked.length, 1, "asked once");
  assert.match(host.text(), /Permission needed/, "back at the choices after an empty answer");
  host.char("4");
  host.press("return");
  const result = await pending;
  assert.deepEqual(result, { decision: "deny", feedback: "use a smaller change" });
  assert.match(asked[0].hint, /what Firas should do instead/);
});

test("aborting the request closes the dialog with a denial", async () => {
  const host = fakeHost();
  const control = new AbortController();
  const pending = permissionDialog(host, { ...EDIT_REQUEST, signal: control.signal }, {});
  control.abort();
  assert.deepEqual(await pending, { decision: "deny" });
  assert.equal(host.handlers.length, 0);
});

test("a stray Enter right after the dialog appears does not approve anything", async () => {
  const host = fakeHost();
  const pending = permissionDialog(host, EDIT_REQUEST, { graceMs: 60 });
  host.press("return");
  host.press("return");
  assert.equal(host.handlers.length, 1, "still waiting");
  await sleep(80);
  host.press("escape");
  assert.deepEqual(await pending, { decision: "deny" });
});

test("a high-risk request is labelled as such", async () => {
  const host = fakeHost();
  const pending = permissionDialog(host, { id: "x", tool: "Bash", title: "Run a dangerous command: rm -rf build", risk: "high", detail: "• deletes many files" }, {});
  assert.match(host.text(), /high risk/);
  assert.match(host.text(), /deletes many files/);
  host.press("escape");
  await pending;
});

test("an Arabic permission box keeps the box straight", async () => {
  setLang("ar");
  try {
    const host = fakeHost(70);
    const pending = permissionDialog(host, { id: "x", tool: "Edit", title: "تعديل src/app.js", summary: "src/app.js", risk: "medium", sessionKey: "k", sessionLabel: "السماح بالتعديل داخل هذا المشروع في هذه الجلسة" }, {});
    const widths = new Set(host.last.map(stringWidth));
    assert.equal(widths.size, 1, [...widths].join(","));
    assert.match(host.text(), /[ﭐ-﻿]/, "Arabic comes out shaped");
    assert.ok(!/[⁦-⁩]/.test(host.text()), "no direction isolate leaks to the screen");    host.press("escape");
    await pending;
  } finally { setLang("en"); }
});

test("questions: choices, a typed answer, several answers, dismissal", async () => {
  const options = [{ label: "TypeScript", description: "typed" }, { label: "JavaScript" }];
  const a = fakeHost();
  const first = questionDialog(a, { question: "Which language?", options }, {});
  assert.match(a.text(), /Which language\?/);
  assert.match(a.text(), /1\. TypeScript\s+typed/);
  assert.match(a.text(), /3\. Something else…/);
  a.press("down");
  a.press("return");
  assert.deepEqual(await first, { answer: "JavaScript" });

  const b = fakeHost();
  const second = questionDialog(b, { question: "Which?", options }, { readLine: async () => "Rust" });
  b.char("3");
  b.press("return");
  assert.deepEqual(await second, { answer: "Rust" });

  const c = fakeHost();
  const third = questionDialog(c, { question: "Which?", options, multi: true }, {});
  c.char(" ");
  c.press("down");
  c.char(" ");
  c.press("return");
  assert.deepEqual(await third, { answer: "TypeScript, JavaScript" });

  const d = fakeHost();
  const fourth = questionDialog(d, { question: "Which?", options }, {});
  d.press("escape");
  assert.deepEqual(await fourth, { answer: "" });

  const e = fakeHost();
  const free = await questionDialog(e, { question: "Your name?" }, { readLine: async () => "  Firas " });
  assert.deepEqual(free, { answer: "Firas" });
  assert.match(stripAnsi(e.printed.join("\n")), /Your name\?/, "a free-text question is printed above the prompt");
});

test("the plan dialog: approve, approve with edits, reject with feedback, Esc", async () => {
  const run = async (script, readLine) => {
    const host = fakeHost();
    const pending = planDialog(host, { readLine });
    script(host);
    return pending;
  };
  assert.deepEqual(await run(h => h.press("return")), { decision: "approve" });
  assert.deepEqual(await run(h => { h.press("down"); h.press("return"); }), { decision: "approve-edits" });
  assert.deepEqual(await run(h => { h.char("3"); h.press("return"); }, async () => "also add tests"), { decision: "reject", feedback: "also add tests" });
  assert.deepEqual(await run(h => h.press("escape")), { decision: "reject" });
});

test("the picker returns the chosen index or -1", async () => {
  const host = fakeHost();
  const pending = pickDialog(host, { title: "Pick", items: [{ label: "A" }, { label: "B", hint: "second" }], initial: 1 });
  assert.match(host.text(), /Pick/);
  assert.match(host.text(), new RegExp(P + String.raw` 2\. B\s+second`));
  host.press("return");
  assert.equal(await pending, 1);
  const none = fakeHost();
  const cancelled = pickDialog(none, { title: "Pick", items: [{ label: "A" }] });
  none.press("escape");
  assert.equal(await cancelled, -1);
});
