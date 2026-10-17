// Writes _work/render-check.html: a visual proof that the text layer is right.
//
// For every sample it shows three things side by side:
//   (a) the LOGICAL string drawn normally by the browser (the reference: real shaping and real bidi),
//   (b) toVisual() output inside a bidi-override LTR box, which behaves like a naive terminal
//       (one cell per code point, left to right, no joining, no reordering),
//   (c) the raw logical string in the same naive box, to show what the user would see without this layer.
// (a) and (b) must read the same. The page also checks it automatically: it measures where every character
// lands in (a) and (b) and compares the left-to-right sequences, ignoring marks and mirrored brackets.
//
// Run:  node scripts/render-check.mjs   then open _work/render-check.html in a browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setArabicMode, toVisual, layoutParagraph } from "../src/text/display.js";

setArabicMode("on");

const SAMPLES = [
  "مرحبا بالعالم",
  "قم بتشغيل `npm test` ثم ارجع",
  "ملف src/app.js يحتوي 3 دوال (جيدة)",
  "التكلفة: 25 دولار (≈ 37,500 دينار)",
  "(مرحبا) [test] {x}",
  "بسم الله الرحمن الرحيم",
  "لا إله إلا الله",
  "كِتَابٌ جَمِيلٌ عَلَى الطَّاوِلَةِ",
  "- عنصر أول في القائمة",
  "• عنصر ثانٍ مع `code` داخل السطر",
  "1. الخطوة الأولى: افتح الملف",
  "## عنوان رئيسي (Heading) للقسم",
  "The word مرحبا means hello",
  "Run npm install ثم npm test",
  "اكتب https://firasai.org/docs/arabic في المتصفح",
  "الإصدار 2.0.0 من Firas Code",
  "٣ ملفات و ١٢ مجلد",
  "السعر 50% أقل من 100$",
  "هل تريد المتابعة؟ (نعم/لا)",
  "استخدم `git commit -m \"fix\"` لحفظ التغييرات",
  "نص فيه \"اقتباس\" و 'اقتباس آخر'",
  "تم تعديل 5 ملفات: a.js, b.js, c.js",
  "ملف C:\\Users\\Firas\\app.js غير موجود",
  "الدالة foo() تُرجع القيمة true",
  "فارسی: می\u200cخواهم چای بنوشم",
  "עברית ו-English ביחד",
  "تحذير: لا تحذف الملف!",
  "الوقت 10:30 صباحاً — التاريخ 2026/10/17",
  "[[مرحبا]] ((test)) {{x}}",
  "a < b و b > c",
  "العدد -5 والعدد +7",
  "استخدم الأمر /compact لضغط المحادثة.",
  "ابدأ (من هنا، ثم [هناك]) وانتهِ.",
  "اللهم صل على محمد",
  "\"مرحبا\" said the user",
  "واضح؟ نعم.",
  "x = [١, ٢, ٣] ثم y",
  "ماذا يفعل `Array.map()` في JavaScript؟",
  "النتيجة: ✓ نجح، ✗ فشل",
  "سطر قصير جدا",
  "ولا يوجد أي لا لأ لإ لآ في الكلمات",
  "ئ ؤ ء أ إ آ ى ة في وسط الكلمات: مسؤول، مئة، قراءة",
];

const PARAGRAPH = "هذه فقرة طويلة تحتوي على كلمات عربية وإنجليزية مثل Firas Code و `npm run build` وأرقام مثل 2026 وروابط مثل https://firasai.org/docs وأقواس (مثل هذه) لنرى كيف يتم الالتفاف على أسطر متعددة بشكل صحيح.";

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rows = SAMPLES.map((s, i) => ({ id: i, logical: s, visual: toVisual(s) }));
const para = layoutParagraph(PARAGRAPH, 44, {});

const html = `<!doctype html>
<html lang="ar"><head><meta charset="utf-8"><title>Text layer render check</title>
<style>
  body { font: 15px/1.5 'Segoe UI', Tahoma, sans-serif; margin: 20px; background: #faf9f5; color: #1f1e1d; }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #d8d5cc; padding: 6px 10px; vertical-align: top; text-align: left; }
  th { background: #efece3; font-weight: 600; }
  .a { font-size: 17px; white-space: pre; }
  .naive { direction: ltr; unicode-bidi: bidi-override; font-family: 'Segoe UI', Tahoma, monospace; font-size: 17px; white-space: pre; }
  .raw { color: #9a2f2f; }
  .ok { color: #1b7a4b; font-weight: 600; } .bad { color: #b3261e; font-weight: 600; }
  #summary { font-size: 16px; margin: 10px 0; }
  .term { direction: ltr; unicode-bidi: bidi-override; background: #1e1e1c; color: #e8e6df; font-family: Consolas, 'Cascadia Mono', monospace; font-size: 16px; padding: 10px 14px; white-space: pre; width: max-content; }
</style></head><body>
<h1>Text layer render check</h1>
<div id="summary">checking...</div>
<table><thead><tr><th>#</th><th>(a) logical, browser</th><th>(b) toVisual, naive terminal</th><th>(c) raw, naive terminal</th><th>auto check</th></tr></thead><tbody>
${rows.map(r => `<tr id="r${r.id}"><td>${r.id + 1}</td><td><div class="a" dir="auto" data-s="${esc(r.logical).replace(/"/g, "&quot;")}">${esc(r.logical)}</div></td><td><div class="naive" data-v="${esc(r.visual).replace(/"/g, "&quot;")}">${esc(r.visual)}</div></td><td><div class="naive raw">${esc(r.logical)}</div></td><td class="chk">...</td></tr>`).join("\n")}
</tbody></table>
<h2>layoutParagraph, width 44 (right-aligned Arabic paragraph, as a terminal would show it)</h2>
<div class="term">${esc(para.join("\n"))}</div>
<script>
// Where does each character land? Wrap each in a span and sort by x. Ordinary ligatures are switched off for
// the probe only: with the Allah ligature on, three letters share one glyph and have no position of their own.
function sequence(container, text, isVisual) {
  const probe = document.createElement("div");
  probe.style.cssText = container.getAttribute("class").includes("naive")
    ? "direction:ltr;unicode-bidi:bidi-override;font:17px 'Segoe UI',Tahoma,monospace;font-feature-settings:'liga' 0;white-space:pre;width:max-content;position:absolute;left:0;top:0"
    : "font:17px 'Segoe UI',Tahoma,sans-serif;font-feature-settings:'liga' 0;white-space:pre;width:max-content;position:absolute;left:0;top:0";
  if (!isVisual) probe.setAttribute("dir", "auto");
  [...text].forEach(ch => { const s = document.createElement("span"); s.textContent = ch; probe.appendChild(s); });
  document.body.appendChild(probe);
  const items = [];
  probe.querySelectorAll("span").forEach(s => { const r = s.getBoundingClientRect(); if (r.width > 0) items.push([s.textContent, r.left]); });
  document.body.removeChild(probe);
  items.sort((x, y) => x[1] - y[1]);
  return items.map(x => x[0]);
}
const MARKS = /\\p{M}/u;
function key(ch, fromVisual) {
  if (MARKS.test(ch) || ch === "\\u200c" || ch === "\\u200d") return "";
  if ("()[]{}<>«»".includes(ch)) return "B";
  let n = ch.normalize("NFKC");
  if (fromVisual && [...n].length === 2 && n[0] === "\\u0644") n = n[1] + n[0]; // lam-alef ligature reads alef-lam
  if (n === "\\u0640") return "";
  return n;
}
let ok = 0;
document.querySelectorAll("tbody tr").forEach(tr => {
  const a = tr.querySelector(".a"), b = tr.querySelector(".naive:not(.raw)");
  const A = sequence(a, a.dataset.s, false).map(c => key(c, false)).join("");
  const B = sequence(b, b.dataset.v, true).map(c => key(c, true)).join("");
  const same = A === B;
  if (same) ok++;
  const cell = tr.querySelector(".chk");
  cell.textContent = same ? "same" : "DIFFERENT";
  cell.className = "chk " + (same ? "ok" : "bad");
  if (!same) cell.title = A + "\\n" + B;
});
const total = document.querySelectorAll("tbody tr").length;
document.getElementById("summary").innerHTML = ok === total ? '<span class="ok">All ' + total + ' samples read the same in (a) and (b).</span>' : '<span class="bad">' + (total - ok) + ' of ' + total + ' samples differ.</span>';
document.title = "render-check " + ok + "/" + total;
</script></body></html>`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "_work"), { recursive: true });
const out = join(root, "_work", "render-check.html");
writeFileSync(out, html, "utf8");
process.stdout.write(`wrote ${out}\n`);
