// The welcome card shown at start-up.
//
//   ╭────────────────────────────────────────────────────────╮
//   │                                                        │
//   │   ██████   Firas Code 2  ·  فراس كود 2    v2.0.0       │
//   │   ██▀▀▀▀   ~\Projects\my-app                           │
//   │   ██▀▀     effort: medium · mode: default              │
//   │   ██       Tip: Type / to see every command            │
//   │                                                        │
//   ╰────────────────────────────────────────────────────────╯
//   type / for commands
//
// Decisions:
//  - Width: the card is at most 84 columns and starts after a 2-column gutter. Below 60 columns the box and the mark
//    are dropped for a compact stack of lines.
//  - Arabic UI mirrors the whole card: the mark moves to the right edge, the text block is right-aligned beside it, the
//    card itself hugs the right edge (two columns of gutter there). Latin snippets (the folder, the version) are
//    isolated so their slashes and dots stay put inside Arabic text.
//  - The folder is shown relative to the home directory (~) and shortened from the left, because the end of a path is
//    the part that tells projects apart.
//  - The tip changes once a day: the day number (local date) picks one of the tips in strings.js, the same index in
//    both languages. `date` is an optional extra parameter so tests can pin it.
//  - The mark is a 4-row letter F in block characters; the ASCII fallback uses # and =.
import os from "node:os";
import path from "node:path";
import { c, sym, hasUnicode } from "./theme.js";
import { stringWidth, toVisual, wrapLogical } from "../text/display.js";
import { t } from "../i18n/index.js";
import { tList, withLang, modeLabel, effortLabel } from "./strings.js";
import { clipLine } from "./screen.js";
import { fitLogical, fitPathTail, ltrIsolate, stripBidiMarks } from "./textfit.js";
import { isInside } from "../util/paths.js";
import { NAME, NAME_AR } from "../brand.js";
import { paintUltra } from "./ultra.js";

const MARK_W = 6;
const MAX_CARD = 84;
const COMPACT_BELOW = 60;

const MARK = hasUnicode
  ? [c.accent("██████"), c.accent("██") + c.accentSoft("▀▀▀▀"), c.accent("██") + c.accentSoft("▀▀") + "  ", c.accent("██") + "    "]
  : [c.accent("######"), c.accent("##") + c.accentSoft("===="), c.accent("##") + c.accentSoft("==") + "  ", c.accent("##") + "    "];

function shortenHome(dir) {
  const home = os.homedir();
  if (home && isInside(home, dir)) {
    const rel = path.relative(home, dir);
    return rel ? "~" + path.sep + rel : "~";
  }
  return dir;
}

function dayNumber(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** One styled LOGICAL line -> one visual line exactly `width` columns wide (padded on the reading-end side). */
function visual(styled, rtl, width) {
  let v = stripBidiMarks(toVisual(styled, rtl ? { dir: "rtl", width, align: "end" } : { dir: "ltr" }));
  if (stringWidth(v) > width) v = clipLine(v, width);
  const gap = width - stringWidth(v);
  return rtl || gap <= 0 ? v : v + " ".repeat(gap);
}

/** "label: value" pieces as one styled string, cut to `room` columns when it does not fit. */
function labelled(pairs, room, rtl) {
  const plain = pairs.map(([label, value]) => `${label}: ${value}`).join(` ${sym.dot} `);
  if (stringWidth(plain) > room) return c.dim(fitLogical(plain, room, sym.ellipsis));
  return pairs.map(([label, value]) => `${c.dim(label + ":")} ${rtl ? ltrIsolate(value) : value}`).join(c.dim(` ${sym.dot} `));
}

function content(o, room) {
  const rtl = o.l === "ar";
  const names = rtl ? [NAME_AR, NAME] : [NAME, NAME_AR];
  const title = c.bold(names[0]) + c.dim(` ${sym.dot} `) + (rtl ? ltrIsolate(names[1]) : names[1]);
  const version = c.dim(rtl ? ltrIsolate(`v${o.version}`) : `v${o.version}`);
  const rows = { title, version };

  const dir = fitPathTail(shortenHome(o.cwd), room, sym.ellipsis);
  rows.folder = rtl ? ltrIsolate(dir) : dir;

  rows.settings = labelled([
    [t("term.banner.effort"), effortLabel(o.effort || "medium")],
    [t("term.banner.mode"), modeLabel(o.mode || "default")],
  ], room, rtl);

  if (o.resumed) rows.resumed = c.accent(fitLogical(t("term.banner.resumed"), room, sym.ellipsis));

  const tips = tList("tip");
  const tip = tips.length ? tips[((dayNumber(o.date) % tips.length) + tips.length) % tips.length] : "";
  const tipText = `${t("term.banner.tip")}: ${tip}`;
  const lines = wrapLogical(tipText, room);
  if (lines.length > 2) lines.splice(1, lines.length, fitLogical(lines.slice(1).join(" "), room, sym.ellipsis));
  rows.tip = lines.map(l => c.dim(l));
  return rows;
}

function card(o, width) {
  const rtl = o.l === "ar";
  const cardW = Math.min(width - 2, MAX_CARD);
  const textW = cardW - 15;
  const rows = content(o, textW);
  const border = s => c.gray(s);
  const edge = border(sym.boxV);

  // title row: names on the reading side, version on the far side
  const titleW = stringWidth(stripBidiMarks(toVisual(rows.title, { dir: rtl ? "rtl" : "ltr" })));
  const versionW = stringWidth(stripBidiMarks(toVisual(rows.version, { dir: "ltr" })));
  let titleRow;
  if (titleW + 2 + versionW <= textW) {
    const gap = " ".repeat(textW - titleW - versionW);
    const t1 = stripBidiMarks(toVisual(rows.title, { dir: rtl ? "rtl" : "ltr" }));
    const v1 = stripBidiMarks(toVisual(rows.version, { dir: "ltr" }));
    titleRow = rtl ? v1 + gap + t1 : t1 + gap + v1;
  } else titleRow = visual(rows.title, rtl, textW);

  const body = [titleRow, visual(rows.folder, rtl, textW)];
  if (rows.resumed) body.push(visual(rows.resumed, rtl, textW));
  body.push(visual(rows.settings, rtl, textW));
  for (const l of rows.tip) body.push(visual(l, rtl, textW));

  const blank = " ".repeat(textW);
  const count = Math.max(body.length, MARK.length);
  const lines = [];
  const side = (text, k) => {
    const mark = k < MARK.length ? MARK[k] : " ".repeat(MARK_W);
    return rtl
      ? edge + "  " + text + "   " + mark + "  " + edge
      : edge + "  " + mark + "   " + text + "  " + edge;
  };
  const inner = cardW - 2;
  lines.push(border(sym.boxTL + sym.boxH.repeat(inner) + sym.boxTR));
  lines.push(edge + " ".repeat(inner) + edge);
  for (let k = 0; k < count; k++) lines.push(side(k < body.length ? body[k] : blank, k));
  lines.push(edge + " ".repeat(inner) + edge);
  lines.push(border(sym.boxBL + sym.boxH.repeat(inner) + sym.boxBR));
  lines.push(rtl ? visual(c.dim(t("term.banner.hint")), true, cardW) : stripBidiMarks(toVisual(c.dim(t("term.banner.hint")), { dir: "ltr" })));

  const lead = rtl ? " ".repeat(Math.max(0, width - 2 - cardW)) : "  ";
  return lines.map(l => lead + l);
}

function compact(o, width) {
  const rtl = o.l === "ar";
  const total = width - 2;
  const rows = content(o, Math.max(8, total - 4));
  const names = rtl ? [NAME_AR, NAME] : [NAME, NAME_AR];
  const mark = `${c.accent(sym.mark)} ${c.bold(names[0])}`;
  const both = `${mark}${c.dim(` ${sym.dot} `)}${rtl ? ltrIsolate(names[1]) : names[1]}`;
  const head = [`${both} ${rows.version}`, both, mark].find(v => stringWidth(v) <= total) || mark;
  const lines = [head, rows.folder];
  if (rows.resumed) lines.push(rows.resumed);
  lines.push(rows.settings, ...rows.tip);
  lines.push(c.dim(t("term.banner.hint")));
  return lines.map((l, i) => {
    if (rtl) return visual(l, true, i === 0 ? total : total - 2);
    return "  " + (i === 0 ? "" : "  ") + stripBidiMarks(toVisual(l, { dir: "ltr" }));
  }).map(l => clipLine(l, width));
}

/**
 * renderBanner({ width, cwd, effort, mode, lang, version, resumed }) -> string[]  
 * Finished visual lines, with a blank line before and after.
 */
export function renderBanner({ width = 80, cwd, effort, mode, lang, version, resumed = false, date } = {}) {
  const l = lang === "ar" ? "ar" : "en";
  const w = Math.max(20, Math.floor(width) || 80);
  const o = { l, cwd: cwd || process.cwd(), effort, mode, version: String(version ?? "").replace(/^v/i, ""), resumed: !!resumed, date };
  const lines = withLang(l, () => (w < COMPACT_BELOW ? compact(o, w) : card(o, w)));
  return ["", ...lines.map(line => paintUltra(line)), ""];
}
