// The model's reasoning text is for the model only. It must not reach any output: not the interactive screen, not the
// plain output of print mode (stdout or stderr), not the saved conversation, and not the settings file.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setLang } from "../../src/i18n/index.js";
import { setArabicMode, toVisual } from "../../src/text/display.js";
import { setColorLevel, colorLevel } from "../../src/ui/theme.js";
import { main } from "../../src/cli.js";
import { saveConfig } from "../../src/config.js";
import { createInteractiveUi } from "../../src/ui/interactive.js";
import { createPlainUi } from "../../src/ui/plain.js";
import { startMockService, textReply, toolReply } from "../helpers/mock-service.js";
import { createCapture, createEmptyStdin, createFakeScreen, sleep, tempDir, useTempHome } from "./helpers.js";

const MARKER = "REASONING-MARKER-9d4b";
const ARABIC_MARKER = "علامة-تفكير-سرية";

const home = useTempHome("firas-thinking-");
const colorBefore = colorLevel();
before(() => { home.reset(); setLang("en"); setColorLevel(0); });
beforeEach(() => { home.reset(); setLang("en"); setArabicMode("auto"); });
after(() => { setColorLevel(colorBefore); setLang("en"); setArabicMode("auto"); home.restore(); });

const savedConversations = () => {
  const dir = path.join(home.dir, "sessions");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), "utf8")).join("\n") : "";
};

/** What the loop does with a thinking block: start, many small deltas, end. */
function streamThinking(ui, { ms = 12_000 } = {}) {
  ui.thinkingStart();
  ui.thinkingDelta(`first ${MARKER.slice(0, 8)}`);
  ui.thinkingDelta(MARKER.slice(8));
  ui.thinkingDelta(`\n${MARKER} again, and ${ARABIC_MARKER}`);
  ui.thinkingEnd({ ms, chars: 80 });
}

test("the interactive screen never shows the reasoning text, in the live region or the scrollback, at any moment", async () => {
  const screen = createFakeScreen({ width: 90, height: 30 });
  const ui = createInteractiveUi({ screen, graceMs: 0 });
  const everything = [];
  const look = () => everything.push(screen.allText());
  ui.turnBegin({ abort() {}, exit() {} });
  ui.requestStart({ step: 1 });
  ui.thinkingStart();
  ui.thinkingDelta(MARKER);
  look();
  await sleep(150);
  look();
  ui.thinkingDelta(`\n${ARABIC_MARKER}`);
  screen.ctrl("t");
  await sleep(150);
  look();
  ui.thinkingEnd({ ms: 12_000, chars: 40 });
  look();
  ui.textStart();
  ui.textDelta("The answer.\n");
  ui.textEnd();
  ui.requestEnd();
  streamThinking(ui, { ms: 400 });
  streamThinking(ui, { ms: 20_000 });
  ui.turnEnd({ ms: 9000, stopReason: "end_turn", steps: 1 });
  look();
  ui.turnFinish();
  look();
  for (const text of everything) {
    assert.ok(!text.includes(MARKER) && !text.includes(ARABIC_MARKER), "reasoning text on the screen");
  }
  const final = screen.allText();
  assert.match(final, /thought for 12 s/, "one dim line says how long it took");
  assert.match(final, /thought for 20 s/);
  assert.ok(!/thought for 0/.test(final), "a very short thought leaves nothing");
  assert.match(final, /The answer\./);
  assert.equal(typeof ui.toggleThinking, "undefined", "there is no call that shows it");
});

test("the Arabic interface says the same thing without the text", async () => {
  setLang("ar");
  const screen = createFakeScreen({ width: 90, height: 30 });
  const ui = createInteractiveUi({ screen, graceMs: 0 });
  ui.turnBegin({ abort() {}, exit() {} });
  streamThinking(ui, { ms: 7000 });
  await sleep(150);
  const text = screen.allText();
  assert.ok(!text.includes(MARKER) && !text.includes(ARABIC_MARKER));
  assert.ok(text.includes(toVisual("فكّر", { dir: "rtl" })), "the one-line summary is in Arabic: " + text);
  ui.turnFinish();
});

test("the plain output used by print mode writes nothing for thinking, to stdout or stderr", () => {
  for (const isTTY of [false, true]) {
    const stdout = createCapture({ isTTY });
    const stderr = createCapture({ isTTY });
    const ui = createPlainUi({ stdout, stderr });
    ui.requestStart({ step: 1 });
    streamThinking(ui);
    ui.textStart();
    ui.textDelta("Plain answer");
    ui.textEnd();
    streamThinking(ui, { ms: 50 });
    ui.turnEnd({ ms: 5000 });
    ui.finish();
    const all = stdout.text + stderr.text;
    assert.ok(!all.includes(MARKER) && !all.includes(ARABIC_MARKER) && !all.includes("first"), `tty=${isTTY}: ${all}`);
    assert.match(stdout.text, /Plain answer/);
    assert.equal(stderr.text, "", "not even a summary line in print mode");
  }
});

test("print mode: not on stdout, not on stderr, not in the saved conversation; the loop still sends it back to the service", async () => {
  const service = await startMockService([]);
  const work = tempDir();
  fs.writeFileSync(path.join(work.dir, "a.txt"), "hello\n");
  saveConfig({ code: service.code });
  try {
    for (const stdoutIsTty of [false, true]) {
      // The service hands out its replies in order, one per request: two for each run.
      service.script.push(
        toolReply([{ name: "Read", input: { path: "a.txt" }, id: "call_t1" }], { text: "Reading it.", thinking: `${MARKER} read first` }),
        textReply("All done.", { thinking: `${ARABIC_MARKER} ${MARKER} then answer` }),
      );
      const out = {
        stdin: createEmptyStdin(), stdout: createCapture({ isTTY: stdoutIsTty }), stderr: createCapture(),
        env: { FIRAS_LANG: "en", FIRAS_ORIGIN: service.origin }, cwd: work.dir, process: new EventEmitter(),
        clientOptions: { backoffMs: [1, 1, 1, 1] },
      };
      assert.equal(await main(["-p", "read a.txt"], out), 0);
      const shown = out.stdout.text + out.stderr.text;
      assert.ok(shown.includes("All done."));
      assert.ok(!shown.includes(MARKER) && !shown.includes(ARABIC_MARKER), `tty=${stdoutIsTty}: reasoning text in the output`);
    }
    const posts = service.requests.filter(r => r.method === "POST" && r.path.endsWith("/v1/messages"));
    const second = posts[1].body.messages;
    const echoed = second.find(m => m.role === "assistant" && m.content.some(b => b.type === "thinking"));
    assert.ok(echoed, "the thinking block goes back to the service inside the tool loop");
    assert.ok(echoed.content.find(b => b.type === "thinking").thinking.includes(MARKER));
    const saved = savedConversations();
    assert.ok(saved.includes("All done."));
    assert.ok(!saved.includes(MARKER) && !saved.includes(ARABIC_MARKER) && !saved.includes('"thinking"'), "no reasoning text in the saved conversation");
    assert.ok(!fs.readFileSync(path.join(home.dir, "config.json"), "utf8").includes("hinking"), "and no setting for it");
  } finally {
    await service.close();
    work.remove();
  }
});
