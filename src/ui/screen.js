// The terminal: raw input, resize, and the one place that writes to stdout.
//
// Architecture. Finished output scrolls into the terminal's own scrollback (print). A small LIVE region at the bottom
// (spinner line, input box, menu) is redrawn in place. Every byte goes through one function (write), and every repaint
// is ONE string, so a stream of print() calls and live updates can never interleave and tear.
//
//   repaint = hide caret, climb to the live region's first row, erase to the end of the screen, [committed lines],
//             live lines, climb back to the caret row, put the caret in its column, show it.
//
// Decisions:
//  - No alternate screen: the user keeps their scrollback. Nothing is emitted at all when stdout is not a TTY.
//  - A live line must already fit the width (callers lay text out with src/text/display.js); as a safety net every
//    line is clipped by cell width, newlines inside a line become spaces, and the region is never taller than the
//    terminal minus one row (it would scroll and the climb-back arithmetic would break). Marks that the text layer
//    counts as zero columns are counted as one when deciding whether a line fits (see fitLine): the Windows console
//    host gives them a cell, and a line one column too wide makes the region stack a row per redraw.
//  - setLive redraws are coalesced to one per 16 ms: the first update after a quiet period is drawn at once (typing
//    feels instant), later ones wait for the frame boundary and only the newest state is drawn. print(), clearLive(),
//    suspend() and dispose() draw synchronously. While stdout reports backpressure only the newest live state is kept
//    and drawn on 'drain'; print() text is never dropped.
//  - Synchronized output (ESC[?2026h/l) wraps each repaint where the terminal can be expected to know it. Legacy
//    Windows consoles and the Linux VT skip it (FIRAS_NO_SYNC=1 skips it everywhere).
//  - Resize: the width is re-read on every repaint and on the 'resize' event (and SIGWINCH on POSIX). A narrower terminal
//    re-wraps the old region, so the row count to climb is re-estimated from the widths that were drawn (reflowing
//    terminals: Windows Terminal, iTerm, VTE, kitty...). A terminal that clips instead of reflowing can leave one
//    stale row behind after a shrink; the next print() scrolls it away.
//  - dispose() erases the live region (it is transient UI; anything worth keeping was printed) and puts the terminal
//    back: caret visible, raw mode off, bracketed paste off, SGR reset. One set of process hooks (exit, SIGINT, SIGTERM,
//    SIGHUP, SIGBREAK, uncaughtException) serves every screen and is removed again when the last screen is gone. A
//    signal or exception hook only terminates the process when it is the sole listener; otherwise the owner of the
//    other listener decides (the 'exit' hook still restores the terminal as the final backstop).
//  - Keys typed while the process is suspended() belong to the child program: the data listener and raw mode are
//    detached, not merely ignored.
import os from "node:os";
import { stringWidth, stripAnsi } from "../text/display.js";
import { createKeyParser } from "./keys.js";

const CSI = "\x1b[";
const ESC = "\x1b";
const HIDE = CSI + "?25l";
const SHOW = CSI + "?25h";
const SYNC_ON = CSI + "?2026h";
const SYNC_OFF = CSI + "?2026l";
const PASTE_ON = CSI + "?2004h";
const PASTE_OFF = CSI + "?2004l";
const RESET = CSI + "0m";
const FRAME_MS = 16;

const SEQ_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/y;

/**
 * Cuts a styled VISUAL line to `width` cells. Escape sequences before the cut are kept (they cost nothing), a base
 * letter keeps its marks, and a cut line is closed with an SGR reset so its colours cannot leak into the next row.
 */
export function clipLine(line, width) {
  if (width <= 0) return "";
  if (stringWidth(line) <= width) return line;
  const n = line.length;
  let out = "";
  let used = 0;
  let i = 0;
  while (i < n) {
    if (line.charCodeAt(i) === 0x1b) {
      SEQ_RE.lastIndex = i;
      const m = SEQ_RE.exec(line);
      const len = m ? m[0].length : 1;
      out += line.slice(i, i + len);
      i += len;
      continue;
    }
    let j = i + (line.codePointAt(i) > 0xffff ? 2 : 1);
    while (j < n && line.charCodeAt(j) !== 0x1b) {
      const len = line.codePointAt(j) > 0xffff ? 2 : 1;
      if (stringWidth(line.slice(j, j + len)) !== 0) break;
      j += len;
    }
    const cluster = line.slice(i, j);
    const w = stringWidth(cluster);
    if (used + w > width) break;
    out += cluster;
    used += w;
    i = j;
  }
  return out + RESET;
}

const ZERO_CELL_RE = /[\p{Mn}\p{Me}\p{Cf}\p{Variation_Selector}]/gu;
const LEADING_RE = /^((?:\x1b\[[0-9;:]*m)*)( +)/;

/**
 * Fits a visual line into `cols` columns the way the terminal may count it. Characters the text layer gives no
 * column (combining marks, joiners) are counted as one: the Windows console host gives a mark a cell of its own, and a
 * line that is wider than the terminal thinks it is wraps - then every redraw of the live region stacks a new row
 * (seen on the real thing with a single shadda in a full-width, right-aligned line). A line that would wrap loses
 * leading blanks first (right-aligned text), and is cut only when that is not enough.
 */
export function fitLine(line, cols) {
  let out = clipLine(line, cols);
  const extra = (stripAnsi(out).match(ZERO_CELL_RE) || []).length;
  if (!extra) return out;
  const over = stringWidth(out) + extra - cols;
  if (over <= 0) return out;
  const lead = LEADING_RE.exec(out);
  const cut = lead ? Math.min(over, lead[2].length) : 0;
  if (cut) out = lead[1] + lead[2].slice(cut) + out.slice(lead[0].length);
  return cut === over ? out : clipLine(out, cols - extra);
}

function toLines(lines) {
  const list = Array.isArray(lines) ? lines : [lines];
  const out = [];
  for (const item of list) {
    for (const l of String(item ?? "").split("\n")) out.push(l.endsWith("\r") ? l.slice(0, -1) : l);
  }
  return out;
}

function supportsSync(env, platform) {
  if (env.FIRAS_NO_SYNC === "1") return false;
  const term = String(env.TERM || "");
  if (term === "linux" || term === "dumb") return false;
  if (platform === "win32") {
    return !!(env.WT_SESSION || env.TERM_PROGRAM || env.WEZTERM_EXECUTABLE || env.ConEmuANSI || env.ALACRITTY_LOG || /xterm|rxvt|tmux|screen/.test(term));
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Process-wide restore hooks, shared by every screen

const registry = new Set();
let hooks = null;

function disposeAll() {
  for (const s of [...registry]) {
    try { s.dispose(); } catch { /* restoring must never throw */ }
  }
}

function onProcessExit() {
  disposeAll();
}

function installHooks() {
  if (hooks) return;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  if (process.platform === "win32") signals.push("SIGBREAK");
  hooks = { signals: {}, uncaught: null };
  process.on("exit", onProcessExit);
  for (const sig of signals) {
    const handler = function onSignal() {
      const sole = process.listenerCount(sig) <= 1; // counted first: disposing removes our own listener
      if (!sole) return;
      disposeAll();
      process.exit(128 + (os.constants.signals[sig] || 0));
    };
    hooks.signals[sig] = handler;
    process.on(sig, handler);
  }
  hooks.uncaught = function onUncaught(err) {
    const sole = process.listenerCount("uncaughtException") <= 1; // counted first: disposing removes our own listener
    disposeAll();
    if (!sole) return;
    try { process.stderr.write(String((err && err.stack) || err) + "\n"); } catch { /* nothing left to tell */ }
    process.exit(1);
  };
  process.on("uncaughtException", hooks.uncaught);
}

function removeHooks() {
  if (!hooks) return;
  process.removeListener("exit", onProcessExit);
  for (const [sig, handler] of Object.entries(hooks.signals)) process.removeListener(sig, handler);
  process.removeListener("uncaughtException", hooks.uncaught);
  hooks = null;
}

// ---------------------------------------------------------------------------------------------

/**
 * createScreen({ stdin, stdout, env }) -> Screen  
 * Extra optional parameters, for tests: platform, now(), setTimer(fn, ms), clearTimer(handle), onError(err).
 * onError receives what a failing key or resize subscriber throws; by default it is rethrown on the next tick so a bug
 * is loud, but it never reaches the other subscribers or the parser.
 */
export function createScreen(o = {}) {
  const stdin = o.stdin || process.stdin;
  const stdout = o.stdout || process.stdout;
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const now = o.now || Date.now;
  const setTimer = o.setTimer || setTimeout;
  const clearTimer = o.clearTimer || clearTimeout;
  const reportError = o.onError || (e => { queueMicrotask(() => { throw e; }); });

  const isTTY = !!stdout.isTTY;
  const useSync = isTTY && supportsSync(env, platform);

  const keySubs = new Set();
  const resizeSubs = new Set();
  let disposed = false;
  let suspended = false;
  let inputOn = false;
  let rawOn = false;
  let parser = null;
  let blocked = false;
  let dirty = false;
  let drawTimer = null;
  let lastDraw = -Infinity;

  let live = [];
  let liveCursor = null;
  let drawn = { any: false, phys: 0, col: 0, widths: [] };

  const readDims = () => ({
    cols: Math.max(20, stdout.columns > 0 ? stdout.columns | 0 : 80),
    rows: stdout.rows > 0 ? stdout.rows | 0 : 24,
  });
  let { cols, rows } = readDims();

  // -- output ----------------------------------------------------------------------------------

  function write(s) {
    if (!s) return;
    try {
      if (stdout.write(s) === false) blocked = true;
    } catch { /* a closed pipe must not take the terminal restore down with it */ }
  }

  const frame = s => (useSync ? SYNC_ON + s + SYNC_OFF : s);

  function eraseRegion() {
    if (!drawn.any) return "";
    const up = Math.min(drawn.phys, Math.max(0, rows - 1));
    return (up > 0 ? CSI + up + "A" : "") + "\r" + CSI + "J";
  }

  function fitLive() {
    const maxRows = Math.max(1, rows - 1);
    let lines = live;
    let caret = liveCursor
      ? {
        row: Math.max(0, Math.min(liveCursor.row | 0, Math.max(0, lines.length - 1))),
        col: Math.max(0, Math.min(liveCursor.col | 0, cols - 1)),
      }
      : null;
    if (lines.length > maxRows) {
      let start = lines.length - maxRows;
      if (caret && caret.row < start) start = caret.row;
      lines = lines.slice(start, start + maxRows);
      if (caret) caret = { row: Math.min(caret.row - start, lines.length - 1), col: caret.col };
    }
    return { lines: lines.map(l => fitLine(l, cols)), caret };
  }

  // One complete repaint (optionally preceded by committed lines) as a single string.
  function paint(committed) {
    let s = HIDE + eraseRegion();
    drawn = { any: false, phys: 0, col: 0, widths: [] };
    if (committed && committed.length) {
      for (const l of committed) s += l + (l.indexOf(ESC) !== -1 ? RESET : "") + "\r\n";
    }
    const { lines, caret } = fitLive();
    if (lines.length) {
      s += lines.map(l => l + (l.indexOf(ESC) !== -1 ? RESET : "")).join("\r\n");
      const widths = lines.map(stringWidth);
      let phys = lines.length - 1;
      let col = widths[phys];
      if (caret) {
        const up = lines.length - 1 - caret.row;
        if (up > 0) s += CSI + up + "A";
        s += CSI + (caret.col + 1) + "G" + SHOW;
        phys = caret.row;
        col = caret.col;
      }
      drawn = { any: true, phys, col, widths };
    }
    return s;
  }

  function syncDims() {
    const d = readDims();
    if (d.cols === cols && d.rows === rows) return false;
    const old = cols;
    cols = d.cols;
    rows = d.rows;
    if (drawn.any && cols < old) {
      const per = w => Math.max(1, Math.ceil(w / cols));
      let r = 0;
      for (let k = 0; k < drawn.phys; k++) r += per(drawn.widths[k]);
      r += Math.min(per(drawn.widths[drawn.phys] || 0) - 1, Math.floor(drawn.col / cols));
      drawn = { ...drawn, phys: r };
    }
    return true;
  }

  function notifyResize() {
    for (const cb of [...resizeSubs]) fire(cb);
  }

  function fire(cb, arg) {
    try {
      cb(arg);
    } catch (e) {
      reportError(e);
    }
  }

  function drawNow() {
    if (drawTimer) { clearTimer(drawTimer); drawTimer = null; }
    dirty = false;
    lastDraw = now();
    if (syncDims()) queueMicrotask(notifyResize);
    write(frame(paint(null)));
  }

  function requestDraw() {
    if (!isTTY || disposed || suspended) return;
    if (blocked) { dirty = true; return; }
    const wait = lastDraw + FRAME_MS - now();
    if (wait <= 0) { drawNow(); return; }
    dirty = true;
    if (!drawTimer) {
      drawTimer = setTimer(() => { drawTimer = null; if (dirty && !blocked) drawNow(); }, wait);
      if (drawTimer && typeof drawTimer.unref === "function") drawTimer.unref();
    }
  }

  function onDrain() {
    blocked = false;
    if (dirty) requestDraw();
  }

  // -- input -----------------------------------------------------------------------------------

  function dispatch(key) {
    for (const cb of [...keySubs]) fire(cb, key);
  }

  function onData(chunk) {
    if (parser) parser.feed(chunk);
  }

  function startInput() {
    if (inputOn || disposed || suspended) return;
    inputOn = true;
    parser = createKeyParser(dispatch);
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      try { stdin.setRawMode(true); rawOn = true; } catch { rawOn = false; }
    }
    stdin.on("data", onData);
    if (typeof stdin.resume === "function") stdin.resume();
    if (isTTY) write(PASTE_ON);
  }

  function stopInput() {
    if (!inputOn) return;
    inputOn = false;
    if (isTTY) write(PASTE_OFF);
    stdin.removeListener("data", onData);
    if (rawOn) {
      try { stdin.setRawMode(false); } catch { /* already gone */ }
      rawOn = false;
    }
    if (typeof stdin.pause === "function") stdin.pause();
    if (parser) { parser.dispose(); parser = null; }
  }

  // -- resize ----------------------------------------------------------------------------------

  function onResizeEvent() {
    if (disposed) return;
    if (syncDims()) {
      notifyResize();
      requestDraw();
    }
  }
  const onWinch = () => { setImmediate(onResizeEvent); };

  if (isTTY && typeof stdout.on === "function") {
    stdout.on("resize", onResizeEvent);
    stdout.on("drain", onDrain);
    stdout.on("error", onStdoutError);
  }
  function onStdoutError(err) {
    if (err && err.code === "EPIPE") return;
    throw err;
  }
  if (isTTY && platform !== "win32") process.on("SIGWINCH", onWinch);

  const screen = {
    isTTY,
    width: () => readDims().cols,
    height: () => readDims().rows,

    print(lines) {
      const list = toLines(lines);
      if (!isTTY) {
        if (list.length) write(list.join("\n") + "\n");
        return;
      }
      if (disposed || suspended) {
        if (list.length) write(list.join("\r\n") + "\r\n");
        return;
      }
      if (!list.length) {
        if (dirty) drawNow();
        return;
      }
      if (drawTimer) { clearTimer(drawTimer); drawTimer = null; }
      dirty = false;
      lastDraw = now();
      if (syncDims()) queueMicrotask(notifyResize);
      write(frame(paint(list)));
    },

    setLive(lines, cursor) {
      if (!isTTY || disposed) return;
      live = (Array.isArray(lines) ? lines : []).map(l => String(l ?? "").replace(/[\r\n]+/g, " "));
      liveCursor = cursor ? { row: cursor.row, col: cursor.col } : null;
      requestDraw();
    },

    clearLive() {
      if (!isTTY || disposed) return;
      live = [];
      liveCursor = null;
      if (suspended) return;
      drawNow();
    },

    /**
     * Starts a fresh page: everything visible is scrolled up into the terminal's own scrollback (not erased, so the
     * person can still scroll back to it) and the next output begins on the top row.
     */
    clear() {
      if (!isTTY || disposed || suspended) return;
      if (drawTimer) { clearTimer(drawTimer); drawTimer = null; }
      dirty = false;
      lastDraw = now();
      syncDims();
      write(frame(HIDE + eraseRegion() + "\r\n".repeat(rows) + CSI + "H"));
      drawn = { any: false, phys: 0, col: 0, widths: [] };
      if (live.length) requestDraw();
    },

    onKey(cb) {
      keySubs.add(cb);
      startInput();
      return () => {
        if (keySubs.delete(cb) && keySubs.size === 0) stopInput();
      };
    },

    onResize(cb) {
      resizeSubs.add(cb);
      return () => { resizeSubs.delete(cb); };
    },

    suspend() {
      if (suspended || disposed) return;
      if (isTTY) {
        if (drawTimer) { clearTimer(drawTimer); drawTimer = null; }
        dirty = false;
        const save = live;
        live = [];
        write(frame(paint(null)) + SHOW + RESET);
        live = save;
      }
      stopInput();
      suspended = true;
    },

    resume() {
      if (!suspended || disposed) return;
      suspended = false;
      drawn = { any: false, phys: 0, col: 0, widths: [] };
      if (keySubs.size) startInput();
      if (isTTY) requestDraw();
    },

    title(text) {
      if (!isTTY || disposed) return;
      const clean = String(text ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 120);
      write(`${ESC}]0;${clean}\x07`);
    },

    dispose() {
      if (disposed) return;
      if (drawTimer) { clearTimer(drawTimer); drawTimer = null; }
      live = [];
      liveCursor = null;
      if (isTTY) write((suspended ? "" : frame(paint(null))) + RESET + SHOW);
      disposed = true;
      stopInput();
      keySubs.clear();
      resizeSubs.clear();
      if (isTTY && typeof stdout.removeListener === "function") {
        stdout.removeListener("resize", onResizeEvent);
        stdout.removeListener("drain", onDrain);
        stdout.removeListener("error", onStdoutError);
      }
      if (isTTY && platform !== "win32") process.removeListener("SIGWINCH", onWinch);
      registry.delete(screen);
      if (!registry.size) removeHooks();
    },
  };

  registry.add(screen);
  installHooks();
  return screen;
}
