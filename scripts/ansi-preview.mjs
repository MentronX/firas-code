// Draws terminal output (ANSI text) as an HTML page the way a naive terminal would: one fixed-width cell per code
// point, left to right, no joining and no reordering. That is exactly what the user's terminal does with our
// already-shaped, already-ordered Arabic, so what you see here is what they see.
//
//   node scripts/ansi-preview.mjs path/to/output.txt [--out _work/preview.html] [--title "name"]
//   some-command | node scripts/ansi-preview.mjs --out _work/preview.html
//   node scripts/ansi-preview.mjs --demo            (showcase documents at widths 60 and 100 -> _work/preview.html)
//
// Cell widths are measured one code point at a time, so the Arabic mode never matters for them.
// SGR support: bold, dim, italic, underline, inverse, strike, 16/256/true colours. Other escape sequences are skipped.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setArabicMode, stringWidth } from "../src/text/display.js";
import { setColorLevel } from "../src/ui/theme.js";
import { renderMarkdown } from "../src/ui/markdown.js";
import { renderDiff } from "../src/ui/diff.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------
// ANSI -> HTML

const BASE16 = ["#1e1e1c", "#e06c75", "#7ec88c", "#e5c07b", "#6ea8e6", "#c68cdc", "#57ae9c", "#c8c6bf",
  "#6b6a66", "#ef8a92", "#9bdca6", "#f0d197", "#8cbcf0", "#d8a6ea", "#78c8b6", "#f4f2ec"];
const DEFAULT_FG = "#e8e6df";
const DEFAULT_BG = "#1e1e1c";

function xterm256(n) {
  if (n < 16) return BASE16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16;
  const f = k => (k === 0 ? 0 : 55 + k * 40);
  return `rgb(${f(Math.floor(i / 36))},${f(Math.floor((i % 36) / 6))},${f(i % 6)})`;
}

function applySgr(st, params) {
  const p = params === "" ? [0] : params.split(/[;:]/).map(x => (x === "" ? 0 : Number(x)));
  for (let k = 0; k < p.length; k++) {
    const n = p[k];
    if (n === 0) { st.b = st.d = st.i = st.u = st.v = st.s = false; st.fg = st.bg = null; }
    else if (n === 1) st.b = true;
    else if (n === 2) st.d = true;
    else if (n === 3) st.i = true;
    else if (n === 4) st.u = true;
    else if (n === 7) st.v = true;
    else if (n === 9) st.s = true;
    else if (n === 22) { st.b = false; st.d = false; }
    else if (n === 23) st.i = false;
    else if (n === 24) st.u = false;
    else if (n === 27) st.v = false;
    else if (n === 29) st.s = false;
    else if (n >= 30 && n <= 37) st.fg = BASE16[n - 30];
    else if (n >= 90 && n <= 97) st.fg = BASE16[n - 90 + 8];
    else if (n >= 40 && n <= 47) st.bg = BASE16[n - 40];
    else if (n >= 100 && n <= 107) st.bg = BASE16[n - 100 + 8];
    else if (n === 39) st.fg = null;
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      let col = null;
      if (p[k + 1] === 5) { col = xterm256(p[k + 2] | 0); k += 2; }
      else if (p[k + 1] === 2) { col = `rgb(${p[k + 2] | 0},${p[k + 3] | 0},${p[k + 4] | 0})`; k += 4; }
      if (col) { if (n === 38) st.fg = col; else st.bg = col; }
    }
  }
}

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function styleOf(st) {
  let fg = st.fg || DEFAULT_FG;
  let bg = st.bg || null;
  if (st.v) { const t = fg; fg = bg || DEFAULT_BG; bg = t; }
  const css = [`color:${fg}`];
  if (bg) css.push(`background:${bg}`);
  if (st.b) css.push("font-weight:700");
  if (st.i) css.push("font-style:italic");
  const deco = [st.u ? "underline" : "", st.s ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) css.push(`text-decoration:${deco}`);
  if (st.d) css.push("opacity:.62");
  return css.join(";");
}

const MARK = /^[\p{M}\p{Cf}]$/u;

// Every distinct style becomes one CSS class, which keeps the page small.
const classes = new Map();
function classFor(css) {
  let id = classes.get(css);
  if (id === undefined) { id = classes.size; classes.set(css, id); }
  return "s" + id;
}
function styleSheet() {
  return [...classes].map(([css, id]) => `.s${id}{${css}}`).join("");
}

/** One line of ANSI text -> HTML made of fixed-width cells. */
export function lineToHtml(line) {
  const st = { b: false, d: false, i: false, u: false, v: false, s: false, fg: null, bg: null };
  let out = "";
  const cells = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const m = /^\x1b\[([0-9;:]*)([\x20-\x2f]*[\x40-\x7e])/.exec(line.slice(i, i + 80));
      if (m) { if (m[2] === "m") applySgr(st, m[1]); i += m[0].length; continue; }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(line.slice(i, i + 600));
      if (osc) { i += osc[0].length; continue; }
      i++;
      continue;
    }
    const cp = line.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (MARK.test(ch) && cells.length) { cells[cells.length - 1].t += ch; continue; }
    cells.push({ t: ch, w: Math.max(1, stringWidth(ch)), cls: classFor(styleOf(st)) });
  }
  for (const c of cells) {
    out += `<span class="c ${c.cls}${c.w === 2 ? " w" : ""}">${esc(c.t)}</span>`;
  }
  return out;
}

export function ansiToHtmlBlock(text) {
  return text.replace(/\r\n/g, "\n").split("\n").map(l => `<div class="l">${lineToHtml(l) || "&nbsp;"}</div>`).join("");
}

const PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; padding: 18px 22px 60px; background: #151514; color: #cfcdc6; font: 14px/1.4 'Segoe UI', Tahoma, sans-serif; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
  h2 { font-size: 13px; font-weight: 600; margin: 26px 0 8px; color: #9a988f; }
  nav a { color: #7ec8b6; margin-right: 12px; font-size: 12px; text-decoration: none; }
  .pair { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  .t { direction: ltr; unicode-bidi: bidi-override; background: ${DEFAULT_BG}; color: ${DEFAULT_FG};
       font-family: 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace; font-size: 15px; line-height: 1.32;
       padding: 12px 16px; white-space: pre; width: max-content; border-radius: 6px; border: 1px solid #2c2c29; }
  .l { height: 1.32em; white-space: pre; }
  .c { display: inline-block; width: 1ch; text-align: center; overflow: visible; white-space: pre; }
  .c.w { width: 2ch; }
`;

export function buildPage(title, sections) {
  const body = sectionsHtml(sections);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_CSS}${styleSheet()}</style></head><body>
<h1>${esc(title)}</h1>
<nav>${sections.map((s, i) => `<a href="#s${i}">${esc(s.title)}</a>`).join("")}</nav>
${body}
</body></html>`;
}

function sectionsHtml(sections) {
  return sections.map((s, i) => `<h2 id="s${i}">${esc(s.title)}</h2><div class="pair">${s.blocks.map(b => `<div><div class="t" data-width="${b.width}">${ansiToHtmlBlock(b.text)}</div></div>`).join("")}</div>`).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Demo documents

const DOCS = [
  ["English overview", `# Project overview

Firas Code reads your files, **edits** them with your approval and runs *commands* for you. It keeps \`diffs\` small and says what it did, with a [short guide](https://example.com/guide/start) for the details.

## What it can do

- Read and search files (\`Read\`, \`Grep\`, \`Glob\`)
- Edit files with small, reviewable diffs
- Run commands, but only after you say yes
  - tests such as \`npm test\`
  - builds and linters

### Good to know

> The agent never runs a destructive command without asking first, and it treats text found in files as data.

1. Describe the change you want
2. Review the diff
3. Approve or decline

---

Visit https://example.com/docs for more.`],
  ["Arabic paragraph + inline code", `# فراس كود

يقرأ فراس كود ملفات مشروعك ويعدّلها بعد موافقتك، ويشغّل الأوامر مثل \`npm test\` ثم يعرض لك النتيجة بشكل واضح ومرتب. افتح الملف \`src/app.js\` وسترى أن الدالة \`main()\` تبدأ التطبيق، أما **الإعدادات** فتجدها في *ملف خاص* بها.

للمزيد زر [صفحة التوثيق](https://example.com/docs) أو اكتب /help داخل البرنامج.

> ملاحظة: لا ينفّذ البرنامج أي أمر خطير دون سؤالك أولاً.`],
  ["Mixed Arabic / English", `قم بتشغيل \`npm test\` ثم ارجع إلى الملف src/app.js الذي يحتوي على 3 دوال (جيدة) وأخرى [سيئة] ثم {x}.

The Arabic word مرحبا means hello, and بسم الله الرحمن الرحيم is a common phrase in Arabic text.

Firas Code هو وكيل برمجة يعمل داخل الطرفية ويدعم اللغة العربية بشكل كامل.

التكلفة: 25 دولار (≈ 37,500 دينار) والإصدار 2.0.0 من Firas Code.`],
  ["Arabic lists (bullets on the right)", `## الميزات

- قراءة الملفات والبحث فيها
- تعديل الملفات بتغييرات صغيرة
  - تعديل سطر واحد
  - تعديل عدة ملفات مع \`MultiEdit\`
- تشغيل الأوامر بعد الموافقة

## الخطوات

1. افتح المجلد الذي فيه المشروع
2. اكتب طلبك بالعربية أو الإنجليزية
3. راجع التغييرات ثم وافق عليها

- [x] تثبيت البرنامج
- [ ] كتابة أول طلب`],
  ["English table", `Comparison of modes:

| Mode | Reads | Edits | Commands |
|------|:-----:|:-----:|---------:|
| default | silent | asks | asks |
| acceptEdits | silent | silent | asks |
| plan | silent | denied | denied |
| bypass | silent | silent | silent |

A table with long cells:

| Name | Description |
|------|-------------|
| alpha | A rather long description that needs to wrap inside its own column when the terminal is narrow |
| beta | Short |`],
  ["Arabic table (mirrored)", `| الوضع | القراءة | التعديل | الأوامر |
|:------|:-------:|:-------:|--------:|
| الافتراضي | بصمت | يسأل | يسأل |
| قبول التعديلات | بصمت | بصمت | يسأل |
| التخطيط | بصمت | مرفوض | مرفوض |

| Name | الوصف |
|------|-------|
| alpha | وصف طويل نسبيا يحتاج إلى الالتفاف داخل العمود عندما تكون الشاشة ضيقة |
| beta | قصير |`],
  ["Code blocks", `Here is a script:

\`\`\`js
// Parse the config and start the server
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config.json", "utf8"));
async function main(port = 3000) {
  const message = \`listening on \${port}\`; // a long trailing comment that will need to wrap at narrow widths
  return { ok: true, count: 42, message };
}
\`\`\`

\`\`\`python
def total(items):
    """Sum the prices."""
    return sum(i["price"] for i in items)  # مرحبا
\`\`\`

\`\`\`bash
npm install --save-dev typescript && npm test
\`\`\`

\`\`\`json
{ "name": "demo", "version": "1.0.0", "private": true }
\`\`\``],
  ["Nested lists and steps", `1. Install the tools:
   \`\`\`bash
   npm install
   \`\`\`
2. Run the build
   - substep a
   - substep b
     more text that belongs to substep b and is long enough to wrap onto another row
3. Done

* star item
  * nested star
    * third level

- [ ] open task
- [x] finished task`],
  ["Streaming-ish edge cases", `Unclosed **bold and some more words that keep going without ever closing the marker at all
Next line with \`unclosed code and a [broken link](http://x and 2 * 3 * 4 plain.

Escapes: \\*not italic\\* &amp; 5 < 6.

Autolink <https://example.com/a> and image ![logo](logo.png).`],
];

function demoSections() {
  const sections = [];
  setArabicMode("on");
  setColorLevel(3);
  for (const [title, md] of DOCS) {
    sections.push({ title, blocks: [60, 100].map(width => ({ width, text: renderMarkdown(md, { width, indent: "  " }).join("\n") })) });
  }
  const oldText = `import { a } from "./a.js";

export function area(w, h) {
  const result = w * h;
  return result;
}

export function name() {
  return "box";
}

export const VERSION = "1.0";
export const AUTHOR = "Firas";
export const LICENSE = "MIT";
// end of file
`;
  const newText = `import { a, b } from "./a.js";

export function area(w, h, scale = 1) {
  const result = w * h * scale;
  return result;
}

export function name() {
  return "box";
}

export const VERSION = "1.1";
export const AUTHOR = "Firas";
export const LICENSE = "MIT";
// نهاية الملف
`;
  sections.push({
    title: "Diff (edit) and new file",
    blocks: [60, 100].map(width => ({
      width,
      text: [
        ...renderDiff({ path: "src/shapes.js", oldText, newText }, { width }),
        "",
        ...renderDiff({ path: "src/new-file.js", oldText: null, newText: "export const x = 1;\nexport const y = 2;\n// ملف جديد\n" }, { width, maxLines: 4 }),
      ].join("\n"),
    })),
  });
  return sections;
}

// ---------------------------------------------------------------------------------------------
// CLI

function main(argv) {
  const args = argv.slice(2);
  let file = null, out = join(root, "_work", "preview.html"), title = "Terminal preview", demo = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--demo") demo = true;
    else if (a === "--out") out = resolve(args[++k]);
    else if (a === "--title") title = args[++k];
    else if (!a.startsWith("--")) file = a;
  }
  let html;
  if (demo) {
    const sections = demoSections();
    html = buildPage("Markdown and diff showcase", sections);
    // One small page per showcase document as well: quicker to open and to screenshot.
    sections.forEach((sec, i) => writeFileSync(join(dirname(out), `preview-${i}.html`), buildPage(sec.title, [sec]), "utf8"));
  } else {
    const text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
    html = buildPage(title, [{ title: file || "stdin", blocks: [{ width: 0, text }] }]);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  process.stdout.write(`wrote ${out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
