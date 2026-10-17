// Small width helpers shared by the terminal widgets (spinner, banner, input editor).
//
// Everything here works on PLAIN or already-styled text and never emits an escape code itself:
// the one function that has to (clipping a visual line) lives in screen.js.
import { stringWidth, wrapLogical } from "../text/display.js";

const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

/** Direction marks and isolates steer the reordering; once a line is ordered some terminals would draw them as boxes. */
export function stripBidiMarks(s) {
  return s.replace(BIDI_MARKS, "");
}

/** Keeps a Latin snippet (a command, a path) in one piece inside Arabic text, with its own punctuation. */
export function ltrIsolate(s) {
  return "\u2066" + s + "\u2069";
}

/**
 * Shortens LOGICAL plain text to at most `cells` columns, ending in an ellipsis. Cutting happens before the text is
 * shaped and ordered, so it can never split a ligature or leave a visual line half reversed.
 */
export function fitLogical(text, cells, ellipsis = "…") {
  if (cells <= 0) return "";
  if (stringWidth(text) <= cells) return text;
  const room = Math.max(0, cells - stringWidth(ellipsis));
  if (room === 0) return ellipsis.length && stringWidth(ellipsis) <= cells ? ellipsis : "";
  const first = wrapLogical(text, room)[0] || "";
  return first.trimEnd() + ellipsis;
}

/** Same idea for a file path: the tail (the file name) is the part worth keeping. */
export function fitPathTail(path, cells, ellipsis = "…") {
  if (cells <= 0) return "";
  if (stringWidth(path) <= cells) return path;
  const chars = [...path];
  let out = "";
  let used = stringWidth(ellipsis);
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = stringWidth(chars[i]);
    if (used + w > cells) break;
    out = chars[i] + out;
    used += w;
  }
  return out ? ellipsis + out : "";
}
