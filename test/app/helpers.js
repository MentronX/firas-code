// Shared test doubles for the application layer: a fake Screen that records what is printed and lets a test press
// keys, a temporary FIRAS_HOME, a capture stream, and polling helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripAnsi } from "../../src/text/display.js";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(check, { timeout = 4000, interval = 8, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The Screen interface the application uses, plus test-side helpers. Keys are delivered synchronously. */
export function createFakeScreen({ width = 80, height = 30 } = {}) {
  const state = { printed: [], live: [], cursor: null, titles: [], disposed: false, liveSets: 0, inputStarts: 0 };
  const keySubs = new Set();
  const resizeSubs = new Set();
  const screen = {
    isTTY: true,
    cols: width,
    rows: height,
    width: () => screen.cols,
    height: () => screen.rows,
    print(lines) {
      for (const item of Array.isArray(lines) ? lines : [lines]) for (const line of String(item ?? "").split("\n")) state.printed.push(line);
    },
    setLive(lines, cursor) { state.live = [...lines]; state.cursor = cursor ?? null; state.liveSets++; },
    clearLive() { state.live = []; state.cursor = null; },
    onKey(cb) {
      if (keySubs.size === 0) state.inputStarts += 1;
      keySubs.add(cb);
      return () => { keySubs.delete(cb); };
    },
    onResize(cb) { resizeSubs.add(cb); return () => { resizeSubs.delete(cb); }; },
    suspend() {}, resume() {},
    title(text) { state.titles.push(text); },
    dispose() { state.disposed = true; keySubs.clear(); resizeSubs.clear(); },

    // ---- test side ----
    get printed() { return state.printed; },
    get live() { return state.live; },
    get cursor() { return state.cursor; },
    get titles() { return state.titles; },
    get disposed() { return state.disposed; },
    get subscribers() { return keySubs.size; },
    /** How many times the terminal input was switched on (first listener added to an empty set). */
    get inputStarts() { return state.inputStarts; },
    /** Everything committed so far, escape sequences removed, one string. */
    text: () => stripAnsi(state.printed.join("\n")),
    liveText: () => stripAnsi(state.live.join("\n")),
    allText: () => stripAnsi([...state.printed, ...state.live].join("\n")),
    key(key) {
      const full = { ctrl: false, alt: false, shift: false, seq: "", ...key };
      for (const cb of [...keySubs]) cb(full);
    },
    press(name, mods = {}) { screen.key({ name, ...mods }); },
    /** The terminal gets a new size; resize subscribers are told. */
    resize(cols, rows) {
      screen.cols = cols;
      if (rows) screen.rows = rows;
      for (const cb of [...resizeSubs]) cb();
    },
    ctrl(letter) { screen.key({ name: "char", ch: letter, ctrl: true }); },
    enter() { screen.press("return"); },
    esc() { screen.press("escape"); },
    type(text) { for (const { segment } of segmenter.segment(text)) screen.key({ name: "char", ch: segment }); },
    paste(text) { screen.key({ name: "paste", paste: text }); },
    /** Waits until somebody listens for keys (a prompt or a dialog is up). */
    ready: () => waitFor(() => keySubs.size > 0, { label: "a key listener" }),
  };
  return screen;
}

/** A writable that records what it is given; `isTTY` false like a pipe. */
export function createCapture({ isTTY = false } = {}) {
  const chunks = [];
  return {
    isTTY,
    write(chunk, cb) { chunks.push(String(chunk)); if (typeof cb === "function") cb(); return true; },
    on() { return this; },
    once() { return this; },
    removeListener() { return this; },
    get text() { return chunks.join(""); },
    chunks,
  };
}

/** A readable that has nothing to say and is not a TTY. */
export function createEmptyStdin(text = "") {
  const handlers = {};
  return {
    isTTY: false,
    readable: true,
    on(event, cb) { (handlers[event] ||= []).push(cb); if (event === "data" && text) queueMicrotask(() => { cb(Buffer.from(text)); handlers.end?.forEach(fn => fn()); }); else if (event === "end" && !text) queueMicrotask(() => cb()); return this; },
    resume() {}, pause() {}, setRawMode() {},
  };
}

/** Points FIRAS_HOME at a fresh folder for the rest of the test file; returns { dir, restore }. */
export function useTempHome(prefix = "firas-app-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const before = process.env.FIRAS_HOME;
  process.env.FIRAS_HOME = dir;
  return {
    dir,
    reset() { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); },
    restore() {
      if (before === undefined) delete process.env.FIRAS_HOME; else process.env.FIRAS_HOME = before;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function tempDir(prefix = "firas-work-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
