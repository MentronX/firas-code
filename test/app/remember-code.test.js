// An access code that arrives in the environment (the installers launch the app that way) is saved once the service has
// accepted it, so the next start needs no environment variable. Invalid, expired or unverifiable codes are never saved,
// print mode never writes the settings, and the code itself is never printed.
import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setLang } from "../../src/i18n/index.js";
import { setArabicMode } from "../../src/text/display.js";
import { main } from "../../src/cli.js";
import { loadConfig, saveConfig } from "../../src/config.js";
import { rememberAccessCode } from "../../src/onboarding.js";
import { startMockService, textReply } from "../helpers/mock-service.js";
import { createCapture, createEmptyStdin, createFakeScreen, sleep, tempDir, useTempHome, waitFor } from "./helpers.js";

const home = useTempHome("firas-remember-");
before(() => { home.reset(); setLang("en"); });
beforeEach(() => { home.reset(); setLang("en"); setArabicMode("on"); });
after(() => { setLang("en"); setArabicMode("auto"); home.restore(); });

const GOOD = "FC2-GOOD0-GOOD0-GOOD0";
const SAVED_LINE = /Access code saved on this device/;
const configPath = () => path.join(home.dir, "config.json");
const modelChecks = service => service.requests.filter(r => r.method === "GET" && r.path.endsWith("/v1/models"));

const open = [];
afterEach(async () => {
  while (open.length) {
    const app = open.pop();
    if (!app.screen.disposed) app.signals.emit("SIGINT");
    await Promise.race([app.done.catch(() => {}), sleep(1500)]);
    await app.close?.();
    app.work.remove();
  }
});

/** An interactive session with the real app, a fake screen, and the environment of the caller's choosing. */
function launch({ origin, env = {}, args = [], io = {} }) {
  const work = tempDir();
  const screen = createFakeScreen({ width: 90, height: 30 });
  const stderr = createCapture();
  const signals = new EventEmitter();
  const done = main(args, {
    screen, stdin: createEmptyStdin(), stdout: createCapture(), stderr, process: signals,
    env: { FIRAS_ORIGIN: origin, FIRAS_LANG: "en", FIRAS_VERIFY: "0", ...env },
    cwd: work.dir, graceMs: 0, clientOptions: { backoffMs: [1, 1, 1, 1] },
    ...io,
  });
  const app = {
    work, screen, stderr, signals, done,
    ready: () => waitFor(() => /Type a message/.test(screen.liveText()), { label: "the prompt" }),
    async leave() {
      await app.ready();
      screen.type("/exit");
      screen.enter();
      return done;
    },
  };
  open.push(app);
  return app;
}

test("a code from FIRAS_CODE is checked, saved once, announced in one quiet line, and never printed", async () => {
  const service = await startMockService([textReply("hi there")], { code: GOOD });
  const app = launch({ origin: service.origin, env: { FIRAS_CODE: GOOD } });
  app.close = () => service.close();
  await app.ready();
  await waitFor(() => SAVED_LINE.test(app.screen.text()), { label: "the quiet line" });
  assert.equal(app.screen.text().match(/Access code saved/g).length, 1);
  assert.equal(modelChecks(service).length, 1, "validated once with the service");
  assert.equal(loadConfig({ env: {} }).code, GOOD, "now on disk");
  if (process.platform !== "win32") assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  assert.ok(!app.screen.allText().includes(GOOD) && !app.stderr.text.includes(GOOD), "the code is never printed");
  assert.equal(await app.leave(), 0);

  // The next start has no environment variable and no flag: the saved code is used and nothing is asked.
  const again = launch({ origin: service.origin });
  again.close = () => {};
  await again.ready();
  assert.ok(!/Paste your access code/.test(again.screen.text()), "no question");
  assert.ok(!SAVED_LINE.test(again.screen.text()), "nothing new to announce");
  again.screen.type("hello");
  again.screen.enter();
  await waitFor(() => /hi there/.test(again.screen.text()), { label: "the answer" });
  const post = service.requests.find(r => r.method === "POST" && r.path.endsWith("/v1/messages"));
  assert.equal(post.headers.authorization, `Bearer ${GOOD}`);
  assert.equal(await again.leave(), 0);
  await service.close();
});

test("the Arabic interface says it in Arabic", async () => {
  const service = await startMockService([], { code: GOOD });
  const app = launch({ origin: service.origin, env: { FIRAS_CODE: GOOD, FIRAS_LANG: "ar" } });
  app.close = () => service.close();
  await waitFor(() => loadConfig({ env: {} }).code === GOOD, { label: "the code to be saved" });
  await waitFor(() => /[ﭐ-﻿]/.test(app.screen.text()), { label: "Arabic text" });
  assert.ok(!SAVED_LINE.test(app.screen.text()), "not the English line");
  assert.ok(!app.screen.allText().includes(GOOD));
  app.signals.emit("SIGINT");
  assert.equal(await app.done, 130);
});

test("a code the service refuses is not saved, nothing is announced, and the session still starts", async () => {
  const service = await startMockService([], { code: GOOD });
  const app = launch({ origin: service.origin, env: { FIRAS_CODE: "FC2-WRONG-WRONG-WRONG" } });
  app.close = () => service.close();
  await app.ready();
  await waitFor(() => modelChecks(service).length === 1, { label: "the check" });
  await sleep(50);
  assert.equal(loadConfig({ env: {} }).code, "");
  assert.ok(!SAVED_LINE.test(app.screen.text()));
  assert.ok(!app.screen.allText().includes("WRONG") && !app.stderr.text.includes("WRONG"));
  assert.equal(await app.leave(), 0);
});

test("an expired code is not saved either", async () => {
  const script = [];
  script.denyModels = "expired";
  const service = await startMockService(script, { code: GOOD });
  const app = launch({ origin: service.origin, env: { FIRAS_CODE: GOOD } });
  app.close = () => service.close();
  await app.ready();
  await waitFor(() => modelChecks(service).length >= 1, { label: "the check" });
  await sleep(50);
  assert.equal(loadConfig({ env: {} }).code, "");
  assert.ok(!SAVED_LINE.test(app.screen.text()));
  assert.equal(await app.leave(), 0);
});

test("when the service cannot be reached nothing is saved and nothing fails; the session carries on", async () => {
  const service = await startMockService([], { code: GOOD });
  const origin = service.origin;
  await service.close();
  const app = launch({ origin, env: { FIRAS_CODE: GOOD } });
  app.close = async () => {};
  await app.ready();
  assert.equal(loadConfig({ env: {} }).code, "");
  assert.ok(!SAVED_LINE.test(app.screen.text()));
  assert.equal(fs.existsSync(configPath()) ? loadConfig({ env: {} }).code : "", "");
  assert.equal(await app.leave(), 0);
});

test("a service that never answers is given up on quickly, and the prompt appears", async () => {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on("error", () => {}); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const app = launch({ origin: `http://127.0.0.1:${server.address().port}`, env: { FIRAS_CODE: GOOD }, io: { rememberTimeoutMs: 150 } });
  app.close = () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
  const started = Date.now();
  await app.ready();
  assert.ok(Date.now() - started < 3000, "no long wait before the prompt");
  assert.equal(loadConfig({ env: {} }).code, "");
  assert.equal(await app.leave(), 0);
});

test("print mode never writes the settings, even for a code that works", async () => {
  const service = await startMockService([textReply("printed answer")], { code: GOOD });
  const work = tempDir();
  const out = {
    stdin: createEmptyStdin(), stdout: createCapture(), stderr: createCapture(), process: new EventEmitter(),
    env: { FIRAS_ORIGIN: service.origin, FIRAS_LANG: "en", FIRAS_CODE: GOOD, FIRAS_VERIFY: "0" },
    cwd: work.dir, clientOptions: { backoffMs: [1, 1, 1, 1] },
  };
  try {
    assert.equal(await main(["-p", "hi"], out), 0);
    assert.equal(out.stdout.text, "printed answer\n");
    assert.equal(fs.existsSync(configPath()), false, "no settings file was created");
    assert.equal(modelChecks(service).length, 0, "and the code was not even checked separately");
    // Same when a file exists: it stays byte for byte as it was.
    saveConfig({ lang: "en" });
    const before = fs.readFileSync(configPath(), "utf8");
    service.script.push(textReply("again"));
    const second = { ...out, stdout: createCapture(), stderr: createCapture() };
    assert.equal(await main(["-p", "hi"], second), 0);
    assert.equal(fs.readFileSync(configPath(), "utf8"), before);
  } finally {
    await service.close();
    work.remove();
  }
});

test("a code that is already saved is not checked again; a different one in the environment replaces it after the check", async () => {
  const service = await startMockService([], { code: GOOD });
  saveConfig({ code: GOOD, lang: "en" });
  const same = launch({ origin: service.origin, env: { FIRAS_CODE: GOOD } });
  same.close = () => {};
  await same.ready();
  await sleep(50);
  assert.equal(modelChecks(service).length, 0, "nothing to verify: it is on disk already");
  assert.ok(!SAVED_LINE.test(same.screen.text()));
  assert.equal(await same.leave(), 0);

  saveConfig({ code: "FC2-OLD00-OLD00-OLD00" });
  const different = launch({ origin: service.origin, env: { FIRAS_CODE: GOOD } });
  different.close = () => service.close();
  await waitFor(() => SAVED_LINE.test(different.screen.text()), { label: "the quiet line" });
  assert.equal(loadConfig({ env: {} }).code, GOOD);
  assert.equal(await different.leave(), 0);
});

test("--code in an interactive start is checked and saved once, up front, and not checked a second time", async () => {
  const service = await startMockService([], { code: GOOD });
  const app = launch({ origin: service.origin, args: ["--code", GOOD] });
  app.close = () => service.close();
  await app.ready();
  assert.equal(loadConfig({ env: {} }).code, GOOD);
  assert.equal(modelChecks(service).length, 1, "one check in all");
  assert.ok(!app.screen.allText().includes(GOOD));
  assert.equal(await app.leave(), 0);
});

test("the first-run language question still comes first, and the code is saved after it", async () => {
  const service = await startMockService([], { code: GOOD });
  const app = launch({ origin: service.origin, env: { FIRAS_CODE: GOOD, FIRAS_LANG: "" } });
  app.close = () => service.close();
  await waitFor(() => /Choose your language/.test(app.screen.liveText()), { label: "the language question" });
  assert.equal(loadConfig({ env: {} }).code, "");
  app.screen.type("2");
  app.screen.enter();
  await app.ready();
  await waitFor(() => loadConfig({ env: {} }).code === GOOD, { label: "the saved code" });
  assert.equal(loadConfig({ env: {} }).lang, "en");
  assert.equal(await app.leave(), 0);
});

test("rememberAccessCode on its own: false without a code or when it is on disk, an abort ends the wait", async () => {
  const notices = [];
  const ui = { notice: (level, text) => notices.push([level, text]) };
  const never = () => ({ checkAccess: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(await rememberAccessCode({ config: { code: "" }, makeClient: never, ui }), false);
  assert.equal(await rememberAccessCode({ config: { code: "FC2-A", stored: { code: "FC2-A" } }, makeClient: never, ui }), false);
  const started = Date.now();
  assert.equal(await rememberAccessCode({ config: { code: "FC2-A", stored: {} }, makeClient: never, ui, timeoutMs: 40 }), false);
  assert.ok(Date.now() - started < 1500);
  const control = new AbortController();
  const pending = rememberAccessCode({ config: { code: "FC2-A", stored: {} }, makeClient: never, ui, signal: control.signal, timeoutMs: 60_000 });
  control.abort();
  assert.equal(await pending, false);
  assert.deepEqual(notices, []);
});
