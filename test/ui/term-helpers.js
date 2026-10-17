// Test helpers for the terminal widgets: a tiny VT100 interpreter (just enough of xterm to check what a real
// terminal would show after our escape sequences), fake stdin/stdout streams, and a fake Screen for the editor tests.
import { EventEmitter } from "node:events";
import { stringWidth } from "../../src/text/display.js";

/** Minimal terminal: printable text with autowrap (deferred, like xterm), CR/LF, CUU/CUD/CUF/CUB/CHA/CUP, ED, EL, modes. */
export class VT {
  constructor(cols = 40, rows = 10) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.scrollback = [];
    this.x = 0;
    this.y = 0;
    this.wrapPending = false;
    this.cursorHidden = false;
    this.syncOpen = false;
    this.paste = false;
    this.title = "";
  }

  lineFeed() {
    this.wrapPending = false;
    if (this.y === this.rows - 1) {
      this.scrollback.push(this.rowText(this.grid.shift()));
      this.grid.push(Array(this.cols).fill(" "));
    } else this.y++;
  }

  rowText(row) {
    return row.join("").replace(/\s+$/, "");
  }

  put(ch) {
    const w = stringWidth(ch);
    if (w === 0) {
      if (this.x > 0) this.grid[this.y][this.wrapPending ? this.x : this.x - 1] += ch;
      return;
    }
    if (this.wrapPending) { this.x = 0; this.lineFeed(); }
    this.grid[this.y][this.x] = ch;
    if (w === 2 && this.x + 1 < this.cols) this.grid[this.y][this.x + 1] = "";
    this.x += w;
    if (this.x >= this.cols) { this.x = this.cols - 1; this.wrapPending = true; }
  }

  csi(params, final) {
    const nums = params.replace(/^\?/, "").split(";").map(v => (v === "" ? undefined : parseInt(v, 10)));
    const n = nums[0] === undefined ? 1 : nums[0];
    const priv = params.startsWith("?");
    this.wrapPending = false;
    switch (final) {
      case "A": this.y = Math.max(0, this.y - n); break;
      case "B": this.y = Math.min(this.rows - 1, this.y + n); break;
      case "C": this.x = Math.min(this.cols - 1, this.x + n); break;
      case "D": this.x = Math.max(0, this.x - n); break;
      case "G": this.x = Math.max(0, Math.min(this.cols - 1, n - 1)); break;
      case "H": case "f":
        this.y = Math.max(0, Math.min(this.rows - 1, (nums[0] || 1) - 1));
        this.x = Math.max(0, Math.min(this.cols - 1, (nums[1] || 1) - 1));
        break;
      case "J": {
        const mode = nums[0] || 0;
        if (mode === 0) {
          for (let c = this.x; c < this.cols; c++) this.grid[this.y][c] = " ";
          for (let r = this.y + 1; r < this.rows; r++) this.grid[r].fill(" ");
        } else if (mode === 2) {
          for (const row of this.grid) row.fill(" ");
        }
        break;
      }
      case "K": {
        const mode = nums[0] || 0;
        const from = mode === 0 ? this.x : 0;
        const to = mode === 1 ? this.x + 1 : this.cols;
        for (let c = from; c < to; c++) this.grid[this.y][c] = " ";
        break;
      }
      case "m": break;
      case "h": case "l": {
        const on = final === "h";
        if (priv && nums[0] === 25) this.cursorHidden = !on;
        if (priv && nums[0] === 2026) this.syncOpen = on;
        if (priv && nums[0] === 2004) this.paste = on;
        break;
      }
      default: break;
    }
  }

  write(s) {
    const chars = [...s];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === "\x1b") {
        if (chars[i + 1] === "[") {
          let j = i + 2;
          let params = "";
          while (j < chars.length && /[0-?]/.test(chars[j])) params += chars[j++];
          while (j < chars.length && /[ -/]/.test(chars[j])) j++;
          this.csi(params, chars[j]);
          i = j;
        } else if (chars[i + 1] === "]") {
          let j = i + 2;
          let text = "";
          while (j < chars.length && chars[j] !== "\x07" && !(chars[j] === "\x1b" && chars[j + 1] === "\\")) text += chars[j++];
          this.title = text.replace(/^\d+;/, "");
          i = chars[j] === "\x07" ? j : j + 1;
        }
        continue;
      }
      if (ch === "\r") { this.x = 0; this.wrapPending = false; continue; }
      if (ch === "\n") { this.lineFeed(); continue; }
      if (ch === "\x07") continue;
      this.put(ch);
    }
  }

  /** The visible rows, right-trimmed. */
  rows_() {
    return this.grid.map(r => this.rowText(r));
  }

  /** Scrollback + visible rows, without the trailing empty ones. */
  all() {
    const lines = [...this.scrollback, ...this.rows_()];
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
}

export function fakeTTY({ cols = 40, rows = 10 } = {}) {
  const vt = new VT(cols, rows);
  const out = new EventEmitter();
  out.isTTY = true;
  out.columns = cols;
  out.rows = rows;
  out.writes = [];
  out.refuse = false;
  out.write = s => {
    out.writes.push(s);
    vt.write(s);
    return !out.refuse;
  };
  out.resizeTo = (c, r) => {
    out.columns = c;
    out.rows = r;
    out.emit("resize");
  };
  return { out, vt };
}

export function fakeStdin({ isTTY = true } = {}) {
  const sin = new EventEmitter();
  sin.isTTY = isTTY;
  sin.raw = false;
  sin.paused = true;
  sin.setRawMode = on => { sin.raw = !!on; return sin; };
  sin.resume = () => { sin.paused = false; return sin; };
  sin.pause = () => { sin.paused = true; return sin; };
  sin.type = data => sin.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  return sin;
}

/** Manual clock + timers so throttling can be tested without waiting. */
export function fakeClock() {
  let time = 1000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: time + ms, fn });
      return { id, unref() {} };
    },
    clearTimer(h) { if (h) timers.delete(h.id); },
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) if (t.at <= end && (!pick || t.at < pick[1].at)) pick = [id, t];
        if (!pick) break;
        timers.delete(pick[0]);
        time = Math.max(time, pick[1].at);
        pick[1].fn();
      }
      time = end;
    },
    pending: () => timers.size,
  };
}

/** A Screen stand-in that records what the editor draws and lets a test press keys. */
export function fakeScreen({ width = 40, height = 20 } = {}) {
  const subs = new Set();
  const resizers = new Set();
  const s = {
    isTTY: true,
    w: width,
    h: height,
    live: [],
    cursor: null,
    history: [],
    printed: [],
    cleared: 0,
    width: () => s.w,
    height: () => s.h,
    print(l) { s.printed.push(...(Array.isArray(l) ? l : [l])); },
    setLive(lines, cursor) { s.live = lines; s.cursor = cursor || null; s.history.push({ lines, cursor }); },
    clearLive() { s.live = []; s.cursor = null; s.cleared++; },
    onKey(cb) { subs.add(cb); return () => subs.delete(cb); },
    onResize(cb) { resizers.add(cb); return () => resizers.delete(cb); },
    suspend() {}, resume() {}, title() {}, dispose() {},
    press(...keys) { for (const k of keys) for (const cb of [...subs]) cb(normKey(k)); },
    resizeTo(w, h = s.h) { s.w = w; s.h = h; for (const cb of [...resizers]) cb(); },
    subscribers: () => subs.size,
  };
  return s;
}

/** Shorthand for key objects in tests: "a", "ctrl+a", "alt+enter", "shift+tab", "up", "paste:text". */
export function normKey(k) {
  if (typeof k !== "string") return { ctrl: false, alt: false, shift: false, seq: "", ...k };
  if (k.startsWith("paste:")) return { name: "paste", paste: k.slice(6), ctrl: false, alt: false, shift: false, seq: "" };
  const parts = k === "+" ? ["+"] : k.split(/\+(?=.)/);
  const base = parts.pop();
  const mods = new Set(parts);
  const names = {
    enter: "return", return: "return", esc: "escape", escape: "escape", tab: "tab", backtab: "backtab", backspace: "backspace",
    delete: "delete", up: "up", down: "down", left: "left", right: "right", home: "home", end: "end", pageup: "pageup",
    pagedown: "pagedown", insert: "insert", space: "char",
  };
  const key = { ctrl: mods.has("ctrl"), alt: mods.has("alt"), shift: mods.has("shift"), seq: "" };
  if (base === "space") return { name: "char", ch: " ", ...key };
  if (names[base]) return { name: names[base], ...key };
  return { name: "char", ch: base, ...key };
}
