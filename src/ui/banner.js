import os from "node:os";
import path from "node:path";
import { c, sym } from "./theme.js";
import { hasRtl, stringWidth, toVisual, wrapLogical } from "../text/display.js";
import { t } from "../i18n/index.js";
import { tList, withLang, modeLabel, effortLabel } from "./strings.js";
import { fitLogical, fitPathTail, ltrIsolate, stripBidiMarks } from "./textfit.js";
import { isInside } from "../util/paths.js";
import { MAKER, NAME, NAME_AR } from "../brand.js";
import { ULTRA, paintUltra } from "./ultra.js";

// Banner layout constants. MAX_CARD caps the card width, COMPACT_BELOW switches to the bare header.
const MARK_W = 7;
const PAD = 4;
const GAP = 4;
const INSET = 2;
const MAX_CARD = 88;
const COMPACT_BELOW = 56;
const KEYS = [["/help", "help"], ["/effort", "effort"], ["Shift+Tab", "mode"]];
const SPACING = [[" ", ` ${sym.dot} `], ["  ", `  ${sym.dot}  `], ["  ", `   ${sym.dot}   `]];
const plain = s => s;
const bar = width => c.gray(sym.boxH.repeat(width));

// One shape, both languages: a stylised F that is exactly MARK_W cells wide on every row.
function markRows() {
  const core = n => c.accent(sym.block.repeat(n));
  const pad = n => " ".repeat(n);
  const fit = s => s + pad(Math.max(0, MARK_W - stringWidth(s)));
  // Only full blocks; every terminal draws them the same way, so the F never breaks into half-height pieces.
  return [fit(core(7)), fit(core(2)), fit(core(5)), fit(core(2)), fit(core(2))];
}

function shortenHome(dir) {
  const home = os.homedir();
  if (home && isInside(home, dir)) {
    const rel = path.relative(home, dir);
    return rel ? "~" + path.sep + rel : "~" + path.sep + path.basename(home || dir);
  }
  return dir;
}

function dayNumber(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

const iso = (s, rtl) => (rtl && !hasRtl(s) ? ltrIsolate(s) : s);

function order(styled, rtl, width) {
  return stripBidiMarks(toVisual(styled, rtl ? { dir: "rtl", width, align: "end" } : { dir: "ltr" }));
}

function row(styled, rtl, width, hang = 0) {
  if (hang > 0) {
    const rest = row(styled, rtl, width - hang);
    return rtl ? rest + " ".repeat(hang) : " ".repeat(hang) + rest;
  }
  let v = order(stringWidth(styled) > width ? fitLogical(styled, width, sym.ellipsis) : styled, rtl, width);
  for (let room = width - 1; stringWidth(v) > width && room > 0; room--) v = order(fitLogical(styled, room, sym.ellipsis), rtl, width);
  const gap = width - stringWidth(v);
  if (gap <= 0) return v;
  return rtl ? " ".repeat(gap) + v : v + " ".repeat(gap);
}

function pairLine(items, room, rtl) {
  for (let n = items.length; n > 0; n--) {
    const shown = items.slice(0, n);
    for (const [inner, sep] of SPACING) {
      if (stringWidth(shown.map(p => p.a + inner + p.b).join(sep)) > room) continue;
      return shown.map(p => p.pa(iso(p.a, rtl)) + inner + p.pb(iso(p.b, rtl))).join(c.dim(sep));
    }
  }
  return "";
}

function settingsLine(o, room, rtl) {
  const effort = o.effort || "medium";
  return pairLine([
    { a: t("term.banner.effort"), b: effortLabel(effort), pa: c.dim, pb: effort === ULTRA ? plain : c.accentSoft },
    { a: t("term.banner.mode"), b: modeLabel(o.mode || "default"), pa: c.dim, pb: plain },
  ], room, rtl);
}

function keyLine(room, rtl) {
  return pairLine(KEYS.map(([key, what]) => ({ a: key, b: t(`term.banner.key.${what}`), pa: plain, pb: c.dim })), room, rtl);
}

function tipRows(o, room) {
  const tips = tList("tip");
  if (!tips.length) return [];
  const tip = tips[((dayNumber(o.date) % tips.length) + tips.length) % tips.length];
  const label = t("term.banner.tip");
  const lead = stringWidth(label) + 2;
  const labelled = room - lead >= 12;
  const textRoom = labelled ? room - lead : room;
  let lines = wrapLogical(tip, textRoom);
  if (lines.length > 2) lines = [lines[0], fitLogical(lines.slice(1).join(" "), textRoom, sym.ellipsis)];
  if (!labelled) return lines.map(text => ({ text, hang: 0 }));
  return lines.map((line, i) => (i === 0 ? { text: c.dim(label) + "  " + line, hang: 0 } : { text: line, hang: lead }));
}

function folderText(o, room, rtl) {
  return iso(fitPathTail(shortenHome(o.cwd), room, sym.ellipsis), rtl);
}

function names(rtl) {
  return rtl ? [NAME_AR, NAME] : [NAME, MAKER];
}

function titleRow(o, room, rtl) {
  const [first, second] = names(rtl);
  const title = [c.bold(first) + c.dim(` ${sym.dot} `) + iso(second, rtl), c.bold(first)].find(s => stringWidth(s) <= room) || c.bold(first);
  const version = o.version ? c.dim(iso(`v${o.version}`, rtl)) : "";
  const tw = stringWidth(title);
  const vw = stringWidth(version);
  if (!version || tw + 2 + vw > room) return row(title, rtl, room);
  const gap = " ".repeat(room - tw - vw);
  const name = order(title, rtl);
  const ver = order(version, false);
  return rtl ? ver + gap + name : name + gap + ver;
}

function card(o, width) {
  const rtl = o.l === "ar";
  const cardW = Math.min(width - 2, MAX_CARD);
  const inner = cardW - 2;
  const textW = inner - 2 * PAD - MARK_W - GAP;
  const ruleW = Math.max(0, textW - 2 * INSET);
  const accentRun = Math.min(8, Math.max(0, ((textW / 3) | 0)));
  const ruleRow = " ".repeat(INSET) + c.accent(sym.boxH.repeat(accentRun)) + bar(ruleW - accentRun);
  const body = [
    titleRow(o, textW, rtl),
    row(ruleRow, rtl, textW),
    row(folderText(o, textW, rtl), rtl, textW),
    row(settingsLine(o, textW, rtl), rtl, textW),
  ];
  if (o.resumed) body.push(row(c.accent(t("term.banner.resumed")), rtl, textW));
  for (const tip of tipRows(o, textW)) body.push(row(tip.text, rtl, textW, tip.hang));

  const mark = markRows();
  const edge = c.gray(sym.boxV);
  const pad = " ".repeat(PAD);
  const gap = " ".repeat(GAP);
  const side = (text, k) => {
    const m = k < mark.length ? mark[k] : " ".repeat(MARK_W);
    const content = edge + pad + (rtl ? text + gap + m : m + gap + text) + pad + edge;
    return c.bgPanel(content);
  };

  const lines = [c.gray(sym.boxTL + sym.boxH.repeat(inner) + sym.boxTR)];
  for (let k = 0; k < Math.max(body.length, mark.length); k++) lines.push(side(k < body.length ? body[k] : " ".repeat(textW), k));
  lines.push(side(" ".repeat(textW), mark.length), c.gray(sym.boxBL + sym.boxH.repeat(inner) + sym.boxBR));

  const keys = keyLine(cardW - 4, rtl);
  if (keys) lines.push(rtl ? row(keys, true, cardW - 2) : "  " + order(keys, false));

  const lead = rtl ? " ".repeat(Math.max(0, width - 2 - cardW)) : "  ";
  return lines.map(l => lead + l);
}

function compact(o, width) {
  const rtl = o.l === "ar";
  const total = width - 2;
  const room = total - 2;
  const [first, second] = names(rtl);
  const mark = `${c.accent(sym.mark)} ${c.bold(first)}`;
  const both = `${mark}${c.dim(` ${sym.dot} `)}${iso(second, rtl)}`;
  const version = o.version ? c.dim(iso(`v${o.version}`, rtl)) : "";
  const head = [version && `${both}  ${version}`, both, mark].find(v => v && stringWidth(v) <= total) || mark;

  const rows = [{ text: folderText(o, room, rtl), hang: 0 }];
  if (o.resumed) rows.push({ text: c.accent(t("term.banner.resumed")), hang: 0 });
  rows.push({ text: settingsLine(o, room, rtl), hang: 0 }, ...tipRows(o, room));
  const keys = keyLine(room, rtl);
  if (keys) rows.push({ text: keys, hang: 0 });
  if (rtl) return [row(head, true, total), ...rows.map(r => row(r.text, true, room, r.hang))];
  return ["  " + row(head, false, total).trimEnd(), ...rows.map(r => "    " + row(r.text, false, room, r.hang).trimEnd())];
}

export function renderBanner({ width = 80, cwd, effort, mode, lang, version, resumed = false, date } = {}) {
  const l = lang === "ar" ? "ar" : "en";
  const w = Math.max(20, Math.floor(width) || 80);
  const o = { l, cwd: cwd || process.cwd(), effort, mode, version: String(version ?? "").replace(/^v/i, ""), resumed: !!resumed, date };
  const lines = withLang(l, () => (w < COMPACT_BELOW ? compact(o, w) : card(o, w)));
  return ["", ...lines.map(line => paintUltra(line)), ""];
}
