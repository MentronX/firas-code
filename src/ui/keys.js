// Keyboard input: turns the bytes a terminal sends on stdin into Key objects.
//
//   Key = { name, ch?, paste?, ctrl, alt, shift, seq }
//
// Decisions:
//  - Enter. "\r" is Enter. "\n" (LF) is what Ctrl+J sends everywhere and what Windows consoles send for Ctrl+Enter;
//    the two cannot be told apart, so LF is reported as { name: "return", ctrl: true }. The editor treats every Enter
//    that carries ctrl, alt or shift as "insert a newline". Terminals that report modifiers (CSI u / modifyOtherKeys)
//    give Shift+Enter as { name: "return", shift: true }, Alt+Enter also arrives as ESC + "\r".
//  - Backspace. 0x7f and 0x08 are both plain Backspace. Windows Terminal sends 0x08 for Ctrl+Backspace and 0x7f for
//    Backspace while xterm-style setups do the opposite, so a guess would erase a word on every Backspace somewhere.
//    Ctrl+Backspace / Alt+Backspace are only recognised where the terminal says so (ESC DEL, CSI 127;5u,
//    CSI 27;5;127~); Ctrl+W deletes a word everywhere.
//  - Ctrl+letters are ordinary char keys with ctrl:true and a lowercase ch ("c" for 0x03); raw mode turns off SIGINT.
//  - ASCII capitals have shift:true. Alt+x arrives as ESC + x and is { name: "char", alt: true }.
//  - A char key holds one grapheme cluster (letter + marks, surrogate pair, emoji sequence), never half of one.
//  - Lone ESC is held for escMs (50 ms) in case the rest of a sequence is in flight, then reported as "escape".
//  - Bracketed paste becomes ONE key { name: "paste", paste: "<text>" } with CRLF / CR normalised to LF. Its seq is
//    only the start marker (copying a 50 MB payload into seq would double the memory for nothing). A paste whose
//    end marker never arrives is delivered after pasteStallMs of silence so the editor can never freeze.
//  - Terminals without bracketed paste (legacy Windows consoles) deliver pasted text as one burst of typed
//    characters. A chunk of three or more non-empty lines, or text on both sides of a CRLF, cannot be typing and is
//    delivered as a paste key as well (heuristicPaste, on by default).
//  - Focus reports, cursor-position replies, mouse reports and key-release events are swallowed (no key). Unknown
//    sequences come out as { name: "unknown", seq }. Stray C1 control characters are dropped.
import { StringDecoder } from "node:string_decoder";

const ESC = "\x1b";
const PASTE_END = "\x1b[201~";
const MAX_SEQ = 256;

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const CLUSTER_RE = /^(?:[\ud800-\udbff][\udc00-\udfff]|[^])[\p{M}\u200d\ufe0f\u{1f3fb}-\u{1f3ff}]*/u;

function key(name, seq, m, ch) {
  const k = { name };
  if (ch !== undefined) k.ch = ch;
  k.ctrl = !!(m && m.ctrl);
  k.alt = !!(m && m.alt);
  k.shift = !!(m && m.shift);
  k.seq = seq;
  return k;
}

/** xterm modifier parameter (1 + bitmask: shift 1, alt 2, ctrl 4) as flags. */
function mods(param) {
  const b = (param || 1) - 1;
  return { shift: !!(b & 1), alt: !!(b & 2), ctrl: !!(b & 4) };
}

const int = v => {
  if (v === undefined || v === "") return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
};

const ARROWS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const FKEYS = { P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12",
};
const RXVT_ARROWS = { a: "up", b: "down", c: "right", d: "left" };
const KEYPAD = { j: "*", k: "+", l: ",", m: "-", n: ".", o: "/", X: "=" };

function controlKey(code, seq) {
  if (code === 0x0d) return key("return", seq);
  if (code === 0x0a) return key("return", seq, { ctrl: true });
  if (code === 0x09) return key("tab", seq);
  if (code === 0x08 || code === 0x7f) return key("backspace", seq);
  if (code === 0) return key("char", seq, { ctrl: true }, " ");
  if (code >= 1 && code <= 26) return key("char", seq, { ctrl: true }, String.fromCharCode(code + 96));
  return key("char", seq, { ctrl: true }, "\\]^_"[code - 28]);
}

function charKey(ch, seq, alt) {
  const upper = ch.length === 1 && ch >= "A" && ch <= "Z";
  return key("char", seq, { alt, shift: upper }, ch);
}

/** A key reported by number (CSI u, modifyOtherKeys): code point + modifiers. */
function codeKey(code, m, seq, shifted) {
  const md = mods(m);
  if (code === 13) return key("return", seq, md);
  if (code === 9) return md.shift ? key("backtab", seq, md) : key("tab", seq, md);
  if (code === 27) return key("escape", seq, md);
  if (code === 127 || code === 8) return key("backspace", seq, md);
  if (code < 32 || (code >= 0xe000 && code <= 0xf8ff) || code > 0x10ffff) return key("unknown", seq, md);
  let ch = String.fromCodePoint(code);
  if (md.shift) ch = shifted || ch.toUpperCase();
  if (md.ctrl && /^[A-Za-z]$/.test(ch)) ch = ch.toLowerCase();
  return key("char", seq, md, ch);
}

function decodeCsi(body, fc, seq) {
  const lead = body.charAt(0);
  if (lead === "<" || lead === ">" || lead === "?" || lead === "=") return null; // mouse, device replies, mode reports
  const parts = body.split(";");
  const n0 = int(parts[0]);
  const n1 = int(parts[1]);
  if (fc === "I" || fc === "O") return null; // focus in / out
  if (ARROWS[fc]) return key(ARROWS[fc], seq, mods(n1));
  if (FKEYS[fc]) {
    if (fc === "R" && parts.length === 2 && n0 !== 1) return null; // cursor position report, not Ctrl+F3
    return key(FKEYS[fc], seq, mods(n1));
  }
  if (fc === "Z") return key("backtab", seq, { ...mods(n1), shift: true });
  if (fc === "~") {
    if (n0 === 27) return int(parts[2]) === undefined ? key("unknown", seq) : codeKey(int(parts[2]), n1, seq);
    return TILDE[n0] ? key(TILDE[n0], seq, mods(n1)) : key("unknown", seq);
  }
  if (fc === "u") {
    const code = parts[0].split(":");
    if (int(code[0]) === undefined) return key("unknown", seq);
    const shifted = int(code[1]) === undefined ? undefined : String.fromCodePoint(int(code[1]));
    const m = (parts[1] || "").split(":");
    if (int(m[1]) === 3) return null; // key release
    return codeKey(int(code[0]), int(m[0]), seq, shifted);
  }
  if (RXVT_ARROWS[fc]) return key(RXVT_ARROWS[fc], seq, { shift: true });
  if ((fc === "^" || fc === "$" || fc === "@") && TILDE[n0]) {
    return key(TILDE[n0], seq, { ctrl: fc !== "$", shift: fc !== "^" });
  }
  return key("unknown", seq);
}

function decodeSs3(body, fc, seq) {
  const m = mods(int(body.split(";").pop()));
  if (ARROWS[fc]) return key(ARROWS[fc], seq, m);
  if (FKEYS[fc]) return key(FKEYS[fc], seq, m);
  if (fc === "M") return key("return", seq, m);
  if (RXVT_ARROWS[fc]) return key(RXVT_ARROWS[fc], seq, { ctrl: true });
  if (KEYPAD[fc]) return key("char", seq, m, KEYPAD[fc]);
  if (fc >= "p" && fc <= "y") return key("char", seq, m, String.fromCharCode(fc.charCodeAt(0) - 112 + 48));
  return key("unknown", seq);
}

/** End index of the grapheme cluster starting at s[i], or -1 when the text stops in the middle of a surrogate pair. */
function clusterEnd(s, i, final) {
  const c = s.charCodeAt(i);
  if (c < 0x80 && (i + 1 >= s.length || s.charCodeAt(i + 1) < 0x300)) return i + 1; // nothing can attach to it
  if (c >= 0xd800 && c <= 0xdbff && i + 1 >= s.length) return final ? s.length : -1;
  const window = s.slice(i, i + 48);
  if (segmenter) {
    const first = segmenter.segment(window)[Symbol.iterator]().next();
    if (!first.done) return i + first.value.segment.length;
  }
  const m = CLUSTER_RE.exec(window);
  return i + (m ? m[0].length : 1);
}

function parseCsi(s, i, final) {
  const n = s.length;
  if (s.charAt(i + 2) === "[") { // Linux console F1-F5: ESC [ [ A..E
    if (i + 3 >= n) {
      if (!final) return null;
      return { len: 2, key: charKey("[", ESC + "[", true) }; // Alt+[ ; the second "[" is read as a key of its own
    }
    const f = "ABCDE".indexOf(s.charAt(i + 3));
    if (f !== -1) return { len: 4, key: key("f" + (f + 1), s.slice(i, i + 4)) };
  }
  let j = i + 2;
  while (j < n && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
  // rxvt ends its shifted navigation keys (ESC[3$) with a "$" that is an intermediate byte by the book; we never ask
  // the terminal a question whose reply uses one, so right after the digits it is the final byte.
  if (s.charAt(j) !== "$") while (j < n && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
  if (j >= n) {
    if (!final && j - i < MAX_SEQ) return null;
    if (j === i + 2) return { len: 2, key: charKey("[", ESC + "[", true) };
    return { len: j - i, key: key("unknown", s.slice(i, j)) };
  }
  const f = s.charCodeAt(j);
  if ((f < 0x40 || f > 0x7e) && s[j] !== "$") return { len: j - i, key: key("unknown", s.slice(i, j)) }; // garbled: the offender is read next
  const body = s.slice(i + 2, j);
  if (body === "200" && s[j] === "~") return { len: j + 1 - i, paste: true };
  if (body === "201" && s[j] === "~") return { len: j + 1 - i, key: null };
  return { len: j + 1 - i, key: decodeCsi(body, s[j], s.slice(i, j + 1)) };
}

function parseSs3(s, i, final) {
  const n = s.length;
  let j = i + 2;
  while (j < n && (s[j] === ";" || (s[j] >= "0" && s[j] <= "9"))) j++;
  if (j >= n) {
    if (!final && j - i < MAX_SEQ) return null;
    if (j === i + 2) return { len: 2, key: charKey("O", ESC + "O", true) };
    return { len: j - i, key: key("unknown", s.slice(i, j)) };
  }
  return { len: j + 1 - i, key: decodeSs3(s.slice(i + 2, j), s[j], s.slice(i, j + 1)) };
}

/** One escape-introduced item at s[i]. null = the item is not complete yet (and !final). */
function parseEscape(s, i, final) {
  const n = s.length;
  if (i + 1 >= n) return final ? { len: 1, key: key("escape", ESC) } : null;
  const c = s[i + 1];
  if (c === "[") return parseCsi(s, i, final);
  if (c === "O") return parseSs3(s, i, final);
  if (c === ESC) {
    if (i + 2 >= n) return final ? { len: 2, key: key("escape", ESC + ESC, { alt: true }) } : null;
    const inner = parseEscape(s, i + 1, final);
    if (!inner) return null;
    if (inner.paste) return { len: 1, key: key("escape", ESC) };
    return { len: inner.len + 1, key: inner.key ? { ...inner.key, alt: true, seq: ESC + inner.key.seq } : null };
  }
  const code = c.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return { len: 2, key: { ...controlKey(code, ESC + c), alt: true } };
  if (code >= 0x80 && code <= 0x9f) return { len: 2, key: null };
  const end = clusterEnd(s, i + 1, final);
  if (end < 0) return null;
  return { len: end - i, key: charKey(s.slice(i + 1, end), s.slice(i, end), true) };
}

function looksLikeMultilinePaste(s) {
  if (s.length < 3 || s.indexOf(ESC) !== -1) return false;
  const lines = s.replace(/\r\n?/g, "\n").split("\n").filter(l => l !== "");
  if (lines.length >= 3) return true;
  return lines.length === 2 && /\S\r\n\S/.test(s);
}

function normalizePaste(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Stateful parser. feed() takes stdin chunks (Buffer or string) and calls onKey for every complete key.
 * o: { escMs = 50, pasteStallMs = 3000, heuristicPaste = true, setTimer, clearTimer } (timers are injectable for tests)
 * Returns { feed(chunk), flush(), dispose() }; flush() resolves anything still pending (a lone ESC, a paste without an end).
 */
export function createKeyParser(onKey, o = {}) {
  const escMs = o.escMs ?? 50;
  const pasteStallMs = o.pasteStallMs ?? 3000;
  const heuristic = o.heuristicPaste !== false;
  const setTimer = o.setTimer || setTimeout;
  const clearTimer = o.clearTimer || clearTimeout;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let paste = null;
  let timer = null;

  const stop = () => { if (timer) { clearTimer(timer); timer = null; } };
  const arm = (ms, fn) => {
    stop();
    timer = setTimer(() => { timer = null; fn(); }, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  function emitPaste(text) {
    const norm = normalizePaste(text);
    if (norm) onKey({ name: "paste", paste: norm, ctrl: false, alt: false, shift: false, seq: "\x1b[200~" });
  }

  function endPaste() {
    const text = paste.parts.join("") + buf;
    paste = null;
    buf = "";
    emitPaste(text);
  }

  // Inside a paste only the last few bytes can be the start of the end marker; everything before them is final.
  // Keeping the scan this small keeps a multi-megabyte paste linear.
  function pastePhase() {
    const at = buf.indexOf(PASTE_END);
    if (at !== -1) {
      paste.parts.push(buf.slice(0, at));
      const rest = buf.slice(at + PASTE_END.length);
      const text = paste.parts.join("");
      paste = null;
      buf = rest;
      emitPaste(text);
      return true;
    }
    const keep = PASTE_END.length - 1;
    if (buf.length > keep) {
      paste.parts.push(buf.slice(0, buf.length - keep));
      buf = buf.slice(buf.length - keep);
    }
    return false;
  }

  function drain(final) {
    const s = buf;
    const n = s.length;
    let i = 0;
    while (i < n) {
      const code = s.charCodeAt(i);
      if (code === 0x1b) {
        const r = parseEscape(s, i, final);
        if (!r) break;
        if (r.paste) {
          buf = s.slice(i + r.len);
          paste = { parts: [] };
          return "paste";
        }
        i += r.len;
        if (r.key) onKey(r.key);
        continue;
      }
      if (code < 0x20 || code === 0x7f) { onKey(controlKey(code, s[i])); i++; continue; }
      if (code >= 0x80 && code <= 0x9f) { i++; continue; }
      const end = clusterEnd(s, i, final);
      if (end < 0) break;
      const ch = s.slice(i, end);
      onKey(charKey(ch, ch, false));
      i = end;
    }
    buf = s.slice(i);
    return buf ? "more" : "done";
  }

  function run(final) {
    for (;;) {
      if (paste) {
        if (pastePhase()) continue;
        arm(pasteStallMs, () => { if (paste) endPaste(); });
        return;
      }
      const r = drain(final);
      if (r === "paste") continue;
      if (r === "more") arm(escMs, () => run(true));
      return;
    }
  }

  return {
    feed(chunk) {
      const s = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (!s) return;
      stop();
      if (!paste && !buf && heuristic && looksLikeMultilinePaste(s)) { emitPaste(s); return; }
      buf += s;
      run(false);
    },
    flush() {
      stop();
      if (paste) endPaste();
      run(true);
    },
    dispose() {
      stop();
      buf = "";
      paste = null;
    },
  };
}

/** Parses a complete string of input in one go (tests, tools). */
export function parseKeys(input, o) {
  const out = [];
  const p = createKeyParser(k => out.push(k), o);
  p.feed(input);
  p.flush();
  return out;
}

/** "ctrl+alt+x", "shift+return", "paste": a short readable name for a key (demo and diagnostics). */
export function keyLabel(k) {
  const base = k.name === "char" ? (k.ch === " " ? "space" : k.ch) : k.name;
  const parts = [];
  if (k.ctrl) parts.push("ctrl");
  if (k.alt) parts.push("alt");
  if (k.shift && k.name !== "char") parts.push("shift");
  parts.push(base);
  return parts.join("+");
}
