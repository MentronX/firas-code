// ANSI escape handling for the text layer: scanning, stripping and a small SGR state machine.
//
// Why a state machine: bidi reordering moves characters around, so a colour that was "on" for a run
// of characters must travel with them. We therefore turn the SGR stream into a style *per character*
// (an immutable state object) and re-emit the minimal escape codes when the style changes.
//
// Decisions:
//  - Only escape sequences that start with ESC are recognised (7-bit forms). 8-bit C1 controls are
//    treated as ordinary zero-width characters.
//  - Colours and attributes we do not model (framed, ideogram marks, ...) are dropped when a line is rebuilt.
//  - Going back to the plain style emits the precise "off" codes (22, 39, ...) instead of a blanket
//    reset (0) so an outer style the caller wrapped around the line is not wiped.
//  - OSC 8 hyperlinks are part of the state, so a link survives wrapping and reordering.

const ESC = "\x1b";

export const LINK_CLOSE = "\x1b]8;;\x1b\\";

export function hasAnsi(s) {
  return s.indexOf(ESC) !== -1;
}

/**
 * End index (exclusive) of the escape sequence starting at s[i] === ESC.
 * Malformed or unterminated sequences are swallowed up to where they stop making sense,
 * the same way a terminal would, so stripping never leaves half a sequence behind.
 */
export function scanEscape(s, i) {
  const n = s.length;
  if (i + 1 >= n) return n;
  const c = s.charCodeAt(i + 1);
  if (c === 0x1b) return i + 1; // a stray ESC before another sequence: only the stray one is dropped
  if (c === 0x5b) { // CSI
    let j = i + 2;
    while (j < n) { const x = s.charCodeAt(j); if (x >= 0x30 && x <= 0x3f) j++; else break; }
    while (j < n) { const x = s.charCodeAt(j); if (x >= 0x20 && x <= 0x2f) j++; else break; }
    if (j < n) { const x = s.charCodeAt(j); if (x >= 0x40 && x <= 0x7e) return j + 1; }
    return j;
  }
  if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) { // OSC, DCS, SOS, PM, APC
    let j = i + 2;
    while (j < n) {
      const x = s.charCodeAt(j);
      if (x === 0x07 || x === 0x9c) return j + 1;
      if (x === 0x1b && s.charCodeAt(j + 1) === 0x5c) return j + 2;
      j++;
    }
    return n;
  }
  if (c >= 0x20 && c <= 0x2f) { // ESC ( B and friends: intermediates then one final byte
    let j = i + 2;
    while (j < n) { const x = s.charCodeAt(j); if (x >= 0x20 && x <= 0x2f) j++; else break; }
    return j < n && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x7e ? j + 1 : j;
  }
  if (c >= 0x30 && c <= 0x7e) return i + 2; // ESC 7, ESC c, ESC =
  return i + 1; // ESC followed by something that is not part of any sequence: drop just the ESC
}

/** Did scanEscape find a whole sequence (as opposed to a truncated or garbled one)? */
export function isComplete(raw) {
  if (raw.length < 2) return false;
  const c = raw.charCodeAt(1);
  const last = raw.charCodeAt(raw.length - 1);
  if (c === 0x5b) return raw.length >= 3 && last >= 0x40 && last <= 0x7e;
  if (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) {
    return last === 0x07 || last === 0x9c || (last === 0x5c && raw.charCodeAt(raw.length - 2) === 0x1b);
  }
  if (c >= 0x20 && c <= 0x2f) return last >= 0x30 && last <= 0x7e;
  return c >= 0x30 && c <= 0x7e;
}

export function stripAnsi(s) {
  let e = s.indexOf(ESC);
  if (e === -1) return s;
  let out = "";
  let pos = 0;
  const n = s.length;
  while (e !== -1) {
    if (e > pos) out += s.slice(pos, e);
    pos = scanEscape(s, e);
    e = pos < n ? s.indexOf(ESC, pos) : -1;
  }
  if (pos < n) out += s.slice(pos);
  return out;
}

/** Classify one raw escape sequence: SGR, OSC 8 hyperlink or "other" (kept verbatim by callers). */
export function classify(raw) {
  if (raw.charCodeAt(1) === 0x5b && raw.charCodeAt(raw.length - 1) === 0x6d) {
    const params = raw.slice(2, -1);
    if (/^[0-9;:]*$/.test(params)) return { kind: "sgr", params };
  }
  if (raw.startsWith("\x1b]8;")) {
    const body = raw.replace(/(\x07|\x1b\\|\x9c)$/, "");
    const semi = body.indexOf(";", 4);
    const uri = semi === -1 ? "" : body.slice(semi + 1);
    return { kind: "link", open: uri !== "", raw };
  }
  return { kind: "other" };
}

export const PLAIN = Object.freeze({
  b: 0, d: 0, i: 0, u: "", k: 0, v: 0, h: 0, s: 0, o: 0, fg: "", bg: "", uc: "", link: "",
});

function extendedColour(p, k) {
  // 38;5;n  or  38;2;r;g;b  (returns [value, consumedParams])
  const mode = p[k + 1];
  if (mode === "5") return [`${p[k]};5;${p[k + 2] || "0"}`, 2];
  if (mode === "2") return [`${p[k]};2;${p[k + 2] || "0"};${p[k + 3] || "0"};${p[k + 4] || "0"}`, 4];
  return ["", 0];
}

/** New state after applying one SGR parameter string (the part between "ESC[" and "m"). */
export function applySgr(state, params) {
  const p = params === "" ? ["0"] : params.split(";");
  const st = { ...state };
  for (let k = 0; k < p.length; k++) {
    const code = p[k];
    if (code.indexOf(":") !== -1) { // colon sub-parameters: keep whole token for colours, decode underline style
      const head = code.slice(0, code.indexOf(":"));
      if (head === "38") st.fg = code;
      else if (head === "48") st.bg = code;
      else if (head === "58") st.uc = code;
      else if (head === "4") st.u = code === "4:0" ? "" : code;
      continue;
    }
    const n = code === "" ? 0 : parseInt(code, 10);
    if (n === 0) {
      st.b = st.d = st.i = st.k = st.v = st.h = st.s = st.o = 0;
      st.u = st.fg = st.bg = st.uc = "";
    } else if (n === 1) st.b = 1;
    else if (n === 2) st.d = 1;
    else if (n === 3) st.i = 1;
    else if (n === 4) st.u = "4";
    else if (n === 5 || n === 6) st.k = 1;
    else if (n === 7) st.v = 1;
    else if (n === 8) st.h = 1;
    else if (n === 9) st.s = 1;
    else if (n === 21) st.u = "21";
    else if (n === 22) { st.b = 0; st.d = 0; }
    else if (n === 23) st.i = 0;
    else if (n === 24) st.u = "";
    else if (n === 25) st.k = 0;
    else if (n === 27) st.v = 0;
    else if (n === 28) st.h = 0;
    else if (n === 29) st.s = 0;
    else if (n === 53) st.o = 1;
    else if (n === 55) st.o = 0;
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) st.fg = String(n);
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) st.bg = String(n);
    else if (n === 39) st.fg = "";
    else if (n === 49) st.bg = "";
    else if (n === 59) st.uc = "";
    else if (n === 38 || n === 48 || n === 58) {
      const [val, used] = extendedColour(p, k);
      if (val) { if (n === 38) st.fg = val; else if (n === 48) st.bg = val; else st.uc = val; }
      k += used;
    }
  }
  return st;
}

export function withLink(state, open, raw) {
  return { ...state, link: open ? raw : "" };
}

export function styleKey(st) {
  return `${st.b}${st.d}${st.i}${st.k}${st.v}${st.h}${st.s}${st.o}|${st.u}|${st.fg}|${st.bg}|${st.uc}|${st.link}`;
}

/** Escape sequence that turns style `a` into style `b` using as few codes as possible. */
export function transition(a, b) {
  if (a === b) return "";
  const codes = [];
  if ((a.b && !b.b) || (a.d && !b.d)) {
    codes.push("22");
    if (b.b) codes.push("1");
    if (b.d) codes.push("2");
  } else {
    if (b.b && !a.b) codes.push("1");
    if (b.d && !a.d) codes.push("2");
  }
  if (a.i !== b.i) codes.push(b.i ? "3" : "23");
  if (a.u !== b.u) codes.push(b.u || "24");
  if (a.k !== b.k) codes.push(b.k ? "5" : "25");
  if (a.v !== b.v) codes.push(b.v ? "7" : "27");
  if (a.h !== b.h) codes.push(b.h ? "8" : "28");
  if (a.s !== b.s) codes.push(b.s ? "9" : "29");
  if (a.o !== b.o) codes.push(b.o ? "53" : "55");
  if (a.fg !== b.fg) codes.push(b.fg || "39");
  if (a.bg !== b.bg) codes.push(b.bg || "49");
  if (a.uc !== b.uc) codes.push(b.uc || "59");
  let out = codes.length ? `\x1b[${codes.join(";")}m` : "";
  if (a.link !== b.link) out += b.link || LINK_CLOSE;
  return out;
}
