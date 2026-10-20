// The line under the prompt box: the permission mode, the effort, and the key that switches the mode.
//
//   default · effort high · Shift+Tab mode
//
// Decisions:
//  - Three PARTS. The mode's name comes first, in the mode's colour (plan accent, accept edits yellow, bypass red; the
//    default mode is as quiet as the rest); the effort and the key are dim. The word "mode" lives in the key's part, so
//    the line explains its first word without a "mode:" label in front of it.
//  - On a narrow terminal the parts go from the end (the key first, then the effort) instead of being cut in the
//    middle of a word; only the mode's name itself is ever shortened, with an ellipsis.
//  - In the Arabic interface the line is right-aligned like everything else, with the same two-column gutter as the
//    English one, and every part is isolated right to left (RLI ... PDI) before the line is ordered: a Latin word at
//    the edge of one part ("ultracode", "Shift+Tab") can then never join a Latin word of the next part into one run
//    and swap the two, and a part that starts with a Latin key still reads as the Arabic phrase it is. (First-strong
//    isolation would lay out "Shift+Tab <Arabic>" left to right and put the Arabic word first for an Arabic reader.)
//    The isolates are removed once the line is ordered (a console font draws them as boxes; screen.js would strip them
//    on the classic console anyway).
import { c, sym } from "./theme.js";
import { t, getLang } from "../i18n/index.js";
import { stringWidth, toVisual } from "../text/display.js";
import { modeLabel, effortLabel } from "./strings.js";
import { fitLogical, stripBidiMarks } from "./textfit.js";
import { paintUltra } from "./ultra.js";
import "./strings-app.js";
import "./strings-input.js";

const MODE_TONE = { plan: c.accent, acceptEdits: c.yellow, bypass: c.red };
const isolate = s => "\u2067" + s + "\u2069";

/** The footer's parts in order, as plain logical text: [mode, effort, key]. */
export function footerParts(permissions, effortRef) {
  return [
    modeLabel(permissions?.mode),
    `${t("term.banner.effort")} ${effortLabel(effortRef?.value)}`,
    t("term.footer.cycle"),
  ];
}

/**
 * The footer line for `width` terminal columns (styled, already ordered for the terminal).
 * permissions: { mode }; effortRef: { value }.
 */
export function footerLine(permissions, effortRef, width = 80) {
  const paint = MODE_TONE[permissions?.mode] || c.dim;
  const parts = footerParts(permissions, effortRef);
  const sep = ` ${sym.dot} `;
  const room = Math.max(4, width - 4);
  let shown = parts;
  while (shown.length > 1 && stringWidth(shown.join(sep)) > room) shown = shown.slice(0, -1);
  const rtl = getLang() === "ar";
  const wrap = rtl ? isolate : s => s;
  // The word ultracode is painted BEFORE the parts are styled: painted on the finished line, each letter's colour reset
  // would end the muted colour the classic console uses for dim, and the rest of the line would print at full strength.
  const first = paint(wrap(paintUltra(fitLogical(shown[0], room, sym.ellipsis))));
  const rest = shown.slice(1).map(part => wrap(paintUltra(part)));
  const styled = first + (rest.length ? c.dim(sep + rest.join(sep)) : "");
  return stripBidiMarks(toVisual(`  ${styled}`, rtl ? { dir: "rtl", width, align: "end" } : { dir: "ltr" }));
}
