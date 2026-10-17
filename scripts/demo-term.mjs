#!/usr/bin/env node
// Manual demo of the terminal widgets: banner, input editor, menus, spinner, secret entry.
//
//   node scripts/demo-term.mjs               English UI
//   node scripts/demo-term.mjs --lang ar     Arabic UI
//   node scripts/demo-term.mjs --no-arabic   leave Arabic shaping to the terminal
//   node scripts/demo-term.mjs --auto        plays a scripted session by itself (to look at the result);
//                                            add --slow 4 to make it four times slower
//
// Things to try: type / (command menu), @ (file picker), Enter, Alt+Enter or a trailing \ then Enter (new line),
// Up/Down (history and rows), Ctrl+Left/Right (words), paste several lines (chip), type Arabic, Shift+Tab (mode),
// /spin (spinner; Esc stops it), /secret (masked entry), Ctrl+C twice or /exit to leave.
import fs from "node:fs";
import path from "node:path";
import { createScreen } from "../src/ui/screen.js";
import { readPrompt } from "../src/ui/input.js";
import { createSpinner, formatTokens } from "../src/ui/spinner.js";
import { renderBanner } from "../src/ui/banner.js";
import { modeLabel } from "../src/ui/strings.js";
import { setLang } from "../src/i18n/index.js";
import { setArabicMode, layoutParagraph, toVisual } from "../src/text/display.js";
import { c, sym } from "../src/ui/theme.js";
import { VERSION } from "../src/brand.js";

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const valueOf = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };

let lang = valueOf("--lang") === "ar" ? "ar" : "en";
const auto = flag("--auto");
if (flag("--no-arabic")) setArabicMode("off");
setLang(lang);

const screen = createScreen();
if (!screen.isTTY) {
  process.stderr.write("This demo needs a terminal.\n");
  process.exit(1);
}

const MODES = ["default", "acceptEdits", "plan", "bypass"];
let mode = 0;
const history = [];

const COMMANDS = [
  { name: "help", description: lang === "ar" ? "اعرض الأوامر المتاحة" : "Show what this demo can do" },
  { name: "spin", description: lang === "ar" ? "جرب مؤشر الانتظار" : "Run the spinner for a few seconds" },
  { name: "secret", description: lang === "ar" ? "إدخال سري بنجوم" : "Masked entry" },
  { name: "lang", description: lang === "ar" ? "بدل لغة الواجهة" : "Switch the interface language" },
  { name: "banner", description: lang === "ar" ? "اعرض بطاقة الترحيب مجددا" : "Show the welcome card again" },
  { name: "exit", description: lang === "ar" ? "اخرج" : "Leave the demo" },
];

function files(query) {
  const out = [];
  const q = query.toLowerCase();
  const skip = new Set(["node_modules", ".git", "_work", "_probe"]);
  (function walk(dir, depth) {
    if (depth > 3 || out.length >= 40) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const rel = path.relative(process.cwd(), path.join(dir, e.name)).split(path.sep).join("/");
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      else if (rel.toLowerCase().includes(q)) out.push(rel);
    }
  })(process.cwd(), 0);
  return out.slice(0, 40);
}

// say() takes finished visual lines; sayText() lays plain (logical) text out first, which is what Arabic needs.
function say(lines) {
  screen.print(lines);
}

function sayText(texts) {
  say([].concat(texts).flatMap(text => layoutParagraph(text, screen.width() - 4, { firstIndent: "  ", indent: "  " })));
}

function showBanner(resumed = false) {
  say(renderBanner({ width: screen.width(), cwd: process.cwd(), effort: "medium", mode: MODES[mode], lang, version: VERSION, resumed }));
}

// Footer lines are drawn as given, so they must already be visual (shaped and ordered) lines.
function footer() {
  const rtl = lang === "ar";
  const visual = text => toVisual(c.dim(text), rtl ? { dir: "rtl", width: screen.width(), align: "end" } : { dir: "ltr" });
  return [visual(`${modeLabel(MODES[mode])} ${sym.dot} Shift+Tab`)];
}

async function runSpinner() {
  const spinner = createSpinner({ onFrame: () => screen.setLive([spinner.line(screen.width())], null), lang: () => lang });
  const stopped = new Promise(resolve => {
    const off = screen.onKey(k => { if (k.name === "escape") { off(); resolve(true); } });
    setTimeout(() => { off(); resolve(false); }, 6000).unref();
  });
  spinner.start({ phase: "thinking" });
  const steps = [[0, { phase: "thinking" }], [1800, { phase: "writing", tokens: 1250 }], [3600, { phase: "tool", label: "Read(src/ui/screen.js)", tokens: 3200 }], [4800, { phase: "writing", tokens: 12500 }]];
  const timers = steps.map(([at, patch]) => setTimeout(() => spinner.set(patch), at));
  const interrupted = await stopped;
  timers.forEach(clearTimeout);
  spinner.stop();
  screen.clearLive();
  sayText(c.dim(interrupted ? (lang === "ar" ? "تم الإيقاف." : "Interrupted.") : `${lang === "ar" ? "انتهى" : "Done"} (${formatTokens(12500)})`));
}

function echo(text) {
  say(["", ...layoutParagraph(text, Math.min(screen.width() - 4, 100), { firstIndent: c.accent(sym.prompt) + " ", indent: "  " }), ""]);
}

async function session() {
  showBanner();
  for (;;) {
    const r = await readPrompt(screen, {
      prefix: c.accent(sym.prompt) + " ",
      history,
      commands: COMMANDS,
      files,
      footer,
      onShiftTab: () => { mode = (mode + 1) % MODES.length; },
      onExpand: () => say(c.dim("Ctrl+O")),
    });
    if (r.type !== "submit") break;
    history.push(r.text);
    const word = r.text.split(/\s+/)[0];
    if (word === "/exit") break;
    if (word === "/help") { sayText(COMMANDS.map(x => "/" + x.name + "  " + c.dim(x.description))); continue; }
    if (word === "/banner") { showBanner(true); continue; }
    if (word === "/lang") { lang = lang === "ar" ? "en" : "ar"; setLang(lang); showBanner(); continue; }
    if (word === "/spin") { await runSpinner(); continue; }
    if (word === "/secret") {
      const s = await readPrompt(screen, { prefix: "code: ", mask: "•", footer: () => [] });
      sayText(c.dim(s.type === "submit" ? `got ${[...s.text].length} characters` : "cancelled"));
      continue;
    }
    echo(r.text);
  }
}

// --auto: type a scripted session into the real input path (stdin 'data' events), so the whole stack runs for real.
function playScript() {
  const keys = [
    [400, "/he"], [500, "\t"], [500, "\x15"], [300, "hello "], [300, "مرحبا بك"],
    [700, "\x1b[200~line one\r\nline two\r\nline three\x1b[201~"], [600, "\x15"], [300, "@scr"], [900, "\x1b"], [300, "\x15"],
    [300, "/spin\r"], [3200, "\x1b"], [800, "\x03"], [400, "\x03"],
  ];
  const slow = Number(valueOf("--slow")) || 1;
  let at = 0;
  for (const [delay, data] of keys) {
    at += delay * slow;
    setTimeout(() => process.stdin.emit("data", Buffer.from(data, "utf8")), at).unref();
  }
}

if (auto) playScript();
try {
  await session();
} finally {
  screen.dispose();
}
