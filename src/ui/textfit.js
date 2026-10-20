// Small width and direction helpers shared by the terminal widgets (spinner, banner, input editor, views).
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
 * Keeps a run in one piece and lets ITS OWN first letter decide its direction (a first-strong isolate). For text of
 * unknown direction inside a structural line: an Arabic summary that starts with a number ("1 \u0645\u0646 3") would otherwise
 * hand that number to the left-to-right line around it and read backwards.
 */
export function autoIsolate(s) {
  return "\u2068" + s + "\u2069";
}

// The Arabic marks (harakat, tanween, shadda, sukun, the superscript alef and the Quranic signs). The text layer gives
// them no column; Windows Terminal and the classic console give each one a cell of its own, so a framed row that holds
// one pushes its border out. Letters are already shaped and in place, so dropping them moves nothing.
const ARABIC_MARK = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]/;
const ARABIC_MARKS = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e4\u06e7\u06e8\u06ea-\u06ed]/g;

/** Removes the Arabic combining marks (see above). Escape sequences hold none of them and pass through. */
export function dropArabicMarks(s) {
  const text = String(s ?? "");
  return ARABIC_MARK.test(text) ? text.replace(ARABIC_MARKS, "") : text;
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
