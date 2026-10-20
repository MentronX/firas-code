import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, glyphs, parseInline, paintRuns, lineDirection, isPlainStart, splitLines, cleanText, createEngine } from "../../src/ui/markdown.js";
import { c, sym, setColorLevel, colorLevel } from "../../src/ui/theme.js";
import { setArabicMode, stripAnsi, stringWidth, layoutParagraph, hasRtl } from "../../src/text/display.js";
import { CORPUS, NAMES } from "./md-corpus.js";

setArabicMode("on");

function withLevel(level, fn) {
  const saved = colorLevel();
  setColorLevel(level);
  try { return fn(); } finally { setColorLevel(saved); }
}

const plain = (md, o) => withLevel(0, () => renderMarkdown(md, { width: 40, ...o }));
const styled = (md, o) => withLevel(3, () => renderMarkdown(md, { width: 40, ...o }));
const text = lines => lines.map(stripAnsi);

// The visual form the text layer gives a word on its own (what a word looks like inside a row).
const visual = (word, dir = "rtl") => layoutParagraph(word, 40, { dir, align: "start" })[0];

test("empty and blank input render nothing", () => {
  assert.deepEqual(plain(""), []);
  assert.deepEqual(plain("\n\n   \n"), []);
  assert.deepEqual(plain(undefined), []);
});

test("headings: no # shown, levels distinct, rule under H1, blank line before", () => {
  const out = plain("intro\n# Title\ntext\n## Sub\n### Third\n#### Fourth\n#hashtag\n####### seven");
  assert.deepEqual(out.slice(0, 5), ["intro", "", "Title", sym.hline.repeat(5), "text"]);
  assert.ok(out.includes("Sub") && out.includes("Third") && out.includes("Fourth"));
  assert.ok(out.includes("#hashtag") && out.includes("####### seven"), "not headings");
  assert.equal(out.filter(l => /^#+ /.test(l) && l !== "####### seven").length, 0);
  const hs = styled("# One\n\n## Two\n\n### Three\n\n#### Four");
  const sgr = l => l.match(/\x1b\[[0-9;]*m/g)?.join("") || "";
  const bold = l => /\x1b\[(?:[0-9;]*;)?1(?:;[0-9;]*)?m/.test(l);
  const [h1, h2, h3, h4] = ["One", "Two", "Three", "Four"].map(w => hs.find(l => stripAnsi(l).includes(w)));
  assert.ok(sgr(h1).includes("38;2;87;174;156") && bold(h1), "H1 is bold + accent");
  assert.ok(sgr(h2).includes("38;2;87;174;156"), "H2 is accent");
  assert.ok(bold(h3) && !sgr(h3).includes("38;2;87"), "H3 is plain bold");
  assert.notEqual(sgr(h3), sgr(h4), "levels differ");
  assert.equal(text(hs).filter(l => l.startsWith(sym.hline)).length, 1, "only H1 gets a rule in colour");
  assert.deepEqual(plain("## Sub"), ["Sub", sym.hline.repeat(3)], "without colour H2 gets a rule too");
});

test("headings: closing hashes are dropped and an empty heading prints nothing", () => {
  assert.deepEqual(plain("### Title ###\n#"), ["Title"]);
});

test("paragraphs wrap at the width, line breaks stay, gutter and width cap", () => {
  const long = "word ".repeat(40).trim();
  const rows = plain(long, { width: 30 });
  assert.ok(rows.length > 4 && rows.every(l => stringWidth(l) <= 30));
  assert.equal(rows.join(" "), long);
  assert.deepEqual(plain("one\ntwo\n\nthree"), ["one", "two", "", "three"]);
  const gutter = plain(long, { width: 30, indent: "  " });
  assert.ok(gutter.every(l => l.startsWith("  ") && stringWidth(l) <= 30), "indent counts against the width");
  const wide = plain(long.repeat(3), { width: 300 });
  assert.ok(wide.every(l => stringWidth(l) <= 100), "content never exceeds 100 columns");
  assert.ok(wide.some(l => stringWidth(l) > 90));
  assert.deepEqual(plain("a\r\nb\r\n\r\nc"), plain("a\nb\n\nc"));
});

test("inline styles: bold, italic, strike, code, links", () => {
  const s = styled("**b** *i* ~~s~~ `x` ***bi*** __b2__ _i2_", { width: 80 })[0];
  assert.ok(s.includes(c.bold("b")));
  assert.ok(s.includes(c.italic("i")));
  assert.ok(s.includes(c.strike("s")));
  assert.ok(s.includes(c.bgPanel(c.accentSoft(" x "))), "code gets the panel colour");
  assert.ok(s.includes(c.italic(c.bold("bi"))));
  assert.ok(s.includes(c.bold("b2")) && s.includes(c.italic("i2")));
  assert.equal(stripAnsi(s), "b i s  x  bi b2 i2");
  assert.deepEqual(plain("**b** *i* `x`"), ["b i `x`"], "no colour: code keeps its backticks");
});

test("inline: links, bare URLs, autolinks, images, escapes and entities", () => {
  assert.deepEqual(plain("see [the docs](https://example.com/a) now", { width: 80 }), ["see the docs (https://example.com/a) now"]);
  assert.deepEqual(plain("[https://x.org](https://x.org)", { width: 80 }), ["https://x.org"], "text = url prints once");
  const l = styled("[docs](https://example.com)", { width: 80 })[0];
  assert.ok(l.includes(c.underline("docs")) && l.includes(c.dim(" (https://example.com)")));
  const b = styled("go to https://example.com/path. Now", { width: 80 })[0];
  assert.ok(b.includes(c.underline("https://example.com/path")), "trailing period is not part of the URL");
  assert.deepEqual(plain("<https://auto.link/x>", { width: 80 }), ["https://auto.link/x"]);
  assert.deepEqual(plain("![alt text](pic.png)", { width: 80 }), ["alt text (pic.png)"]);
  assert.deepEqual(plain("![](pic.png)", { width: 80 }), ["image (pic.png)"]);
  assert.deepEqual(plain("\\*not italic\\* &amp; &lt;b&gt;", { width: 80 }), ["*not italic* & <b>"]);
  assert.deepEqual(plain("snake_case_name and 5 * 6 and a * b", { width: 80 }), ["snake_case_name and 5 * 6 and a * b"]);
});

test("inline: unclosed markers are literal text, never an error", () => {
  assert.deepEqual(plain("an **unclosed bold", { width: 80 }), ["an **unclosed bold"]);
  assert.deepEqual(plain("an `unclosed code", { width: 80 }), ["an `unclosed code"]);
  assert.deepEqual(plain("a [broken](link and more", { width: 80 }), ["a [broken](link and more"]);
  assert.deepEqual(plain("*a **b* c**", { width: 80 }).length, 1);
});

test("inline: code spans can hold markers, multiple backticks and spaces", () => {
  assert.deepEqual(plain("`a*b*c` and ``x ` y``", { width: 80 }), ["`a*b*c` and `x ` y`"]);
  assert.deepEqual(text(styled("a `b` c", { width: 80 })), ["a  b  c"], "one padding space each side in colour");
});

test("code blocks: label, bar, content untouched, highlighted in colour", () => {
  const out = plain("```js\nconst a = 1;\n\n  indented();\n```\nafter");
  assert.deepEqual(out, [`${sym.quote} js`, `${sym.quote} const a = 1;`, sym.quote, `${sym.quote}   indented();`, "", "after"]);
  const hl = styled("```js\nconst a = 'x'; // note\n```")[1];
  assert.ok(hl.includes(c.accent("const")) && hl.includes(c.green("'x'")) && hl.includes(c.gray(c.italic("// note"))));
  assert.deepEqual(plain("```\nno label\n```"), [`${sym.quote} no label`]);
  assert.deepEqual(plain("~~~sh\nls\n~~~"), [`${sym.quote} sh`, `${sym.quote} ls`]);
  assert.deepEqual(plain("````\n```\ninside\n```\n````"), [`${sym.quote} \`\`\``, `${sym.quote} inside`, `${sym.quote} \`\`\``], "a longer fence needs a longer closer");
  assert.deepEqual(plain("```js\nlet unterminated = 1;"), [`${sym.quote} js`, `${sym.quote} let unterminated = 1;`]);
});

test("code blocks: long lines wrap with a marker and lose nothing", () => {
  const line = "const value = computeSomething(argumentNumberOne, argumentNumberTwo, argumentNumberThree);";
  const out = plain("```js\n" + line + "\n```", { width: 36 });
  assert.ok(out.length > 3 && out.slice(1).every(l => stringWidth(l) <= 36));
  assert.ok(out.slice(2).every(l => l.startsWith(`${sym.quote} ${glyphs.cont} `)), "continuation rows carry the marker");
  const joined = out.slice(1).map((l, i) => l.slice(i ? `${sym.quote} ${glyphs.cont} `.length : `${sym.quote} `.length)).join("");
  assert.equal(joined, line);
});

test("code blocks: tabs expand, escapes are stripped, Arabic inside is joined and readable", () => {
  assert.deepEqual(plain("```\n\tx\n```"), [`${sym.quote}     x`]);
  assert.deepEqual(plain("```\n\x1b[31mred\x1b[0m\n```"), [`${sym.quote} red`]);
  const ar = plain("```js\nlet s = \"مرحبا\"; // ok\n```")[1];
  assert.ok(ar.includes(visual("مرحبا", "ltr")), "the word is shaped and in reading order inside the LTR line");
  assert.ok(ar.startsWith(`${sym.quote} let s = "`) && ar.endsWith('"; // ok'), "the code around it does not move");
});

test("code blocks are always left-aligned, even in an RTL document", () => {
  const out = plain("قم بتشغيل الأمر التالي الآن\n\n```bash\nnpm test\n```");
  assert.equal(out.at(-1), `${sym.quote} npm test`);
});

test("code inside a list item sits under the item", () => {
  const out = plain("1. Run:\n   ```bash\n   npm i\n   ```\n2. Next");
  assert.deepEqual(out, ["1. Run:", `   ${sym.quote} bash`, `   ${sym.quote} npm i`, "", "2. Next"]);
});

test("lists: bullets change with depth, numbers stay, hanging indent, tasks", () => {
  const out = plain("- a\n  - b\n    - c\n      - d\n1. x\n2. y\n   cont\n- [ ] t1\n- [x] t2");
  assert.deepEqual(out.slice(0, 4), [`${glyphs.bullets[0]} a`, `  ${glyphs.bullets[1]} b`, `    ${glyphs.bullets[2]} c`, `      ${glyphs.bullets[0]} d`]);
  assert.deepEqual(out.slice(4, 7), ["1. x", "2. y", "   cont"]);
  assert.deepEqual(out.slice(-2), [`${sym.checkbox} t1`, `${sym.checked} t2`]);
  const wrap = plain("- " + "word ".repeat(12), { width: 24 });
  assert.ok(wrap.length > 2 && wrap.slice(1).every(l => l.startsWith("  ") && !l.startsWith("   ")), "continuation rows hang under the text");
  assert.deepEqual(plain("-\n1.\ntext"), [glyphs.bullets[0], "1.", "", "text"]);
});

test("lists: tight inside a list, a blank line between different kinds of list and after the list", () => {
  assert.deepEqual(plain("- a\n\n- b\n\n\n- c"), ["• a", "• b", "• c"].map(s => s.replace("•", glyphs.bullets[0])));
  const out = plain("1. one\n2. two\n\n- dash\n\n* star\n\ntext");
  assert.deepEqual(out, ["1. one", "2. two", "", `${glyphs.bullets[0]} dash`, "", `${glyphs.bullets[0]} star`, "", "text"]);
});

test("block quotes: bar per level, dim italic in colour, blank quote line", () => {
  assert.deepEqual(plain("> a\n> > b\n>\n> c\n\nnormal"), [`${sym.quote} a`, `${sym.quote} ${sym.quote} b`, sym.quote, `${sym.quote} c`, "", "normal"]);
  const q = styled("> quoted **text**")[0];
  assert.ok(q.includes(c.dim(c.italic("quoted "))) || q.includes(c.italic(c.dim("quoted "))), "quote text is dim italic");
});

test("horizontal rule spans the content width", () => {
  const out = plain("a\n\n---\n\nb", { width: 50 });
  assert.deepEqual(out, ["a", "", sym.hline.repeat(50), "", "b"]);
  assert.deepEqual(plain("x\n***\ny")[2], sym.hline.repeat(40));
});

test("spacing: blanks collapse, none at the ends, blocks are separated", () => {
  assert.deepEqual(plain("\n\n a \n\n\n\n b \n\n\n"), ["a", "", "b"]);
  const out = plain("text\n```js\nx\n```\nmore\n| a |\n|---|\n| 1 |\nend");
  const blanks = out.map((l, i) => (l === "" ? i : -1)).filter(i => i >= 0);
  assert.equal(blanks.length, 4, "a blank line before and after the code block and the table");
});

test("tables: box, header, alignment, equal row widths", () => {
  const out = plain("|a|b|c|\n|:--|:-:|--:|\n|1|22|333|\n|long cell here|x|y|");
  assert.ok(out.length === 6 && out.every(l => stringWidth(l) === stringWidth(out[0])));
  assert.equal(out[0][0], glyphs.box.tl);
  assert.equal(out.at(-1)[0], glyphs.box.bl);
  const hdr = out[1];
  assert.ok(hdr.startsWith(`${glyphs.box.v} a `) && hdr.endsWith(` c ${glyphs.box.v}`));
  assert.ok(out[3].includes(` ${glyphs.box.v}   333 ${glyphs.box.v}`) || out[3].endsWith(`333 ${glyphs.box.v}`), "right-aligned column");
  const ctr = out[4];
  assert.ok(ctr.includes(" x  ") || ctr.includes(" x "), "centered cell");
  const bold = styled("|h|\n|-|\n|v|").find(l => l.includes("h"));
  assert.ok(bold.includes(c.bold("h")), "header is bold");
});

test("tables: cells wrap, escaped pipes and <br> work, short rows are padded", () => {
  const out = plain("|k|text|\n|-|-|\n|a|one two three four five six seven eight nine ten|\n|b|x \\| y<br>second|", { width: 30 });
  assert.ok(out.every(l => stringWidth(l) <= 30));
  assert.ok(out.some(l => l.includes("x | y")) && out.some(l => l.includes("second")));
  const short = plain("|a|b|c|\n|-|-|-|\n|1|");
  assert.ok(short.every(l => stringWidth(l) === stringWidth(short[0])));
});

test("tables: too wide for the terminal -> stacked key: value records", () => {
  const out = plain("|one|two|three|four|five|six|\n|-|-|-|-|-|-|\n|aaaaaaaaaaaaaaaaaaaa|bbbbbbbbbbbbbbbbbbbb|cccccccccccccccccccc|dddddddddddddddddddd|eeeeeeeeeeeeeeeeeeee|ffffffffffffffffffff|\n|1|2|3|4|5|6|", { width: 50 });
  assert.ok(out.includes("one: " + "a".repeat(20)));
  assert.ok(out.includes("six: 6"));
  assert.ok(out.every(l => stringWidth(l) <= 50) && !out.some(l => l.includes(glyphs.box.tl)));
  const narrow = plain(CORPUS.wideTable, { width: 80 });
  assert.ok(narrow.every(l => stringWidth(l) <= 80));
});

test("tables: a pipe line without a delimiter row is plain text", () => {
  assert.deepEqual(plain("| not | a table |\nfollowed by text", { width: 60 }), ["| not | a table |", "followed by text"]);
});

test("RTL paragraphs: right-aligned, same rows as the text layer", () => {
  const samples = [
    "مرحبا بالعالم هذا نص عربي طويل نسبيا ويحتاج إلى الالتفاف على أكثر من سطر واحد في هذا المثال",
    "قم بتشغيل npm test ثم ارجع إلى الملف src/app.js الذي يحتوي على 3 دوال (جيدة) وأخرى [سيئة]",
    "الإصدار 2.0.0 من Firas Code والتكلفة 25 دولار (≈ 37,500 دينار) والوقت 10:30 صباحاً",
    "The word مرحبا means hello and بسم الله الرحمن الرحيم is a common phrase in Arabic text",
  ];
  for (const s of samples) {
    const got = plain(s, { width: 46 });
    const want = withLevel(0, () => layoutParagraph(s, 46, {}));
    assert.deepEqual(got, want, s);
  }
  const rtl = plain(samples[0], { width: 46 });
  assert.ok(rtl.length >= 2 && rtl.every(l => stringWidth(l) === 46), "every row is padded on the left up to the content width");
  assert.ok(rtl.every(l => /\S$/.test(l)), "rows end at the right edge");
  assert.ok(plain("The word مرحبا here", { width: 46 })[0].startsWith("The"), "a Latin-led paragraph stays left-aligned");
});

test("RTL paragraph with inline code: the code stays an LTR island", () => {
  const row = plain("قم بتشغيل `npm test` ثم ارجع إلى الملف", { width: 60 })[0];
  assert.ok(row.includes("`npm test`"));
  const shaped = w => visual(w);
  // Reading right to left: قم بتشغيل first (rightmost), then the code, then the rest.
  assert.ok(row.indexOf(shaped("قم")) > row.indexOf(shaped("بتشغيل")));
  assert.ok(row.indexOf(shaped("بتشغيل")) > row.indexOf("`npm test`"));
  assert.ok(row.indexOf("`npm test`") > row.indexOf(shaped("ثم")));
});

// The closing quote, brackets and separators of a code span used to take the paragraph's direction and jump in front of
// the span (git commit -m "x" came out with its last quote first; foo() as ()foo; [1, 2, 3] as [3 ,2 ,1]).
const ISOLATE = new RegExp("[" + String.fromCharCode(0x2066) + "-" + String.fromCharCode(0x2069) + "]");

test("RTL paragraph: a code span keeps its own punctuation in place", () => {
  for (const code of ['git commit -m "fix bug"', "echo 'hi'", "npm test;", "foo()", "[1, 2, 3]", "ls -la /tmp/", "a < b && c > d"]) {
    for (const level of [0, 3]) {
      const row = withLevel(level, () => renderMarkdown("شغّل `" + code + "` الآن", { width: 60 }))[0];
      const shown = stripAnsi(row).trim();
      const inner = level ? " " + code + " " : "`" + code + "`";
      assert.ok(shown.includes(inner), `level ${level}: ${code} -> ${shown}`);
    }
  }
});

test("a code span cut by a line break is ordered as code on both rows", () => {
  const md = 'شغّل الأمر `git commit -m "fix a very long message here that wraps"` ثم `foo()` الآن';
  const rows = text(plain(md, { width: 34 }));
  assert.ok(rows.length >= 3);
  assert.ok(rows.some(row => row.includes('wraps"`')), "the closing quote stays after the last word of the span");
  assert.ok(rows.join("\n").includes("foo()"));
  for (const row of rows) assert.ok(!ISOLATE.test(row), "no isolate control reaches the terminal: " + JSON.stringify(row));
  assert.ok(rows.every(row => stringWidth(row) <= 34));
});

test("isolate controls never reach the terminal: LTR paragraphs, Arabic off, tables", () => {
  const md = "Run `foo()` then `bar;`\n\n| a | b |\n|---|---|\n| `x;` | `y()` |\n\nشغّل `foo()`";
  for (const mode of ["on", "off"]) {
    setArabicMode(mode);
    try {
      for (const level of [0, 3]) {
        for (const row of withLevel(level, () => renderMarkdown(md, { width: 40 }))) assert.ok(!ISOLATE.test(row), mode + ": " + JSON.stringify(row));
      }
    } finally { setArabicMode("on"); }
  }
});

test("RTL lists: bullets and numbers on the right, hanging indent on the right", () => {
  const out = plain("- عنصر أول\n- عنصر ثان طويل جدا حتى يلتف إلى السطر التالي في هذا المثال الطويل\n  - فرعي\n\n1. رقم\n2. رقم آخر", { width: 40 });
  assert.ok(out[0].endsWith(glyphs.bullets[0]) && stringWidth(out[0]) === 40);
  assert.ok(out[1].endsWith(glyphs.bullets[0]));
  assert.ok(out[2].endsWith("  ") && !out[2].endsWith("   "), "a wrapped row leaves the bullet column empty on the right");
  const nested = out.find(l => l.includes(visual("فرعي")));
  assert.ok(nested.endsWith(`${glyphs.bullets[1]}  `), "the nested bullet is two columns further in, still on the right");
  assert.ok(out.at(-2).endsWith(".1") && out.at(-1).endsWith(".2"), "numbers stay LTR digits, at the right edge");
});

test("RTL quote, heading and rule", () => {
  const out = plain("# عنوان\n\n> اقتباس");
  assert.ok(stringWidth(out[0]) === 40 && out[0].startsWith(" "), "heading is right-aligned");
  assert.ok(out[1].endsWith(sym.hline) && out[1].startsWith(" "), "the rule is right-aligned too");
  assert.ok(out.at(-1).trimEnd().endsWith(sym.quote), "quote bar on the right");
});

test("direction option forces every paragraph", () => {
  assert.ok(plain("hello world", { width: 30, dir: "rtl" })[0].startsWith(" "), "forced RTL right-aligns English");
  assert.ok(!plain("مرحبا", { width: 30, dir: "ltr" })[0].startsWith(" "), "forced LTR keeps Arabic at the left");
});

test("Arabic mirrored table: first column on the right, cells right-aligned", () => {
  const out = plain("| الاسم | العمر |\n|--|--|\n| أحمد | 25 |", { width: 40 });
  assert.ok(out.every(l => stringWidth(l) <= 40));
  const hdr = out[1];
  assert.ok(hdr.indexOf(visual("الاسم")) > hdr.indexOf(visual("العمر")), "the first column is the rightmost");
  const row = out[3];
  assert.ok(row.indexOf(visual("أحمد")) > row.indexOf("25"));
  const mixed = plain("| Name | الوصف |\n|--|--|\n| a | وصف |", { width: 40 });
  assert.ok(mixed[1].indexOf("Name") < mixed[1].indexOf(visual("الوصف")), "a balanced table keeps its order");
});

test("untrusted text: escapes, control and bidi characters never reach the output", () => {
  const evil = "a\x1b[31mred\x1b[0m\x1b]0;title\x07 b\u0007c" + String.fromCharCode(0x202e) + "d" + String.fromCharCode(0x2066) + "e" + String.fromCharCode(0x200f);
  for (const md of [evil, "# " + evil, "- " + evil, "> " + evil, "```\n" + evil + "\n```", "|" + evil + "|\n|-|\n|" + evil + "|"]) {
    const out = plain(md, { width: 80 }).join("\n");
    assert.doesNotMatch(out, /[\x00-\x09\x0b-\x1f\x7f]/);
    assert.equal(out.includes(String.fromCharCode(0x202e)), false);
    assert.equal(out.includes(String.fromCharCode(0x2066)), false);
  }
  assert.deepEqual(plain("a\x1b[31mb", { width: 80 }), ["ab"]);
  assert.equal(cleanText("x" + String.fromCharCode(0xd83d) + "y"), "x" + String.fromCharCode(0xfffd) + "y", "a lone surrogate becomes U+FFFD");
  assert.equal(cleanText("a\tb"), "a   b");
  assert.deepEqual(plain("one\ttwo", { width: 80 }), ["one two"], "a tab moves to the next multiple of 4");
});

test("line splitting: LF, CRLF and lone CR; a trailing CR waits for its LF", () => {
  assert.deepEqual(splitLines("a\nb\r\nc\rd"), { lines: ["a", "b", "c"], rest: "d" });
  assert.deepEqual(splitLines("a\r"), { lines: [], rest: "a\r" });
  assert.deepEqual(splitLines("a\r\n"), { lines: ["a"], rest: "" });
  assert.deepEqual(splitLines("xxabc\ndef", 2), { lines: ["xxabc"], rest: "def" });
});

test("the corpus renders without a line wider than the terminal (colour and no colour)", () => {
  for (const level of [0, 3]) {
    for (const name of NAMES) {
      for (const width of [24, 40, 100]) {
        const out = withLevel(level, () => renderMarkdown(CORPUS[name], { width, indent: "  " }));
        for (const l of out) assert.ok(stringWidth(l) <= width, `${name}@${width}: ${JSON.stringify(stripAnsi(l))}`);
        if (level === 0) for (const l of out) assert.equal(l.includes("\x1b"), false);
      }
    }
  }
});

test("random input never throws and level 0 output has no escape codes", () => {
  let seed = 4242;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const alphabet = ["a", "ب", "ل", "ا", " ", "\n", "*", "_", "`", "[", "]", "(", ")", "|", "-", ":", "#", ">", "1", ".", "~", "<", "!", "\\", "&", "\t", "😀", "\x1b[1m", "http://x.y/z"];
  for (let i = 0; i < 400; i++) {
    let md = "";
    for (let k = Math.floor(rand() * 120); k > 0; k--) md += alphabet[Math.floor(rand() * alphabet.length)];
    const out = plain(md, { width: 20 + Math.floor(rand() * 60), indent: rand() < 0.5 ? "  " : "" });
    for (const l of out) {
      assert.equal(l.includes("\x1b"), false, JSON.stringify(md));
      assert.ok(stringWidth(l) <= 80);
    }
  }
});

test("parseInline: the stable prefix of a growing line never changes", () => {
  const lines = [
    "Hello **bold text** and *italic* with `code span` and [a link](http://x.y/z) end",
    "an **unclosed bold *nested italic* and `code with a [link](u) inside` more text here and there",
    "نص عربي **عريض** مع `كود` و [رابط](http://u.rl) وبقية الكلام هنا ![img](a.png) <https://q.r> ok",
    "***both*** __under__ _it_ ~~gone~~ \\*x\\* a_b_c 2*3*4 http://a.b/c_d_e. next",
    "``a ` b`` and [x [nested] y](z) and ![alt `c` t](p) tail",
  ];
  const flat = runs => runs.flatMap(r => [...r.t].map(ch => ch + ":" + r.f));
  for (const line of lines) {
    const full = flat(parseInline(line, { final: true }).runs);
    for (let n = 1; n <= line.length; n++) {
      const part = line.slice(0, n);
      const p = parseInline(part, { final: false });
      const stable = flat(paintRunsCut(p.runs, p.stableR));
      assert.deepEqual(stable, full.slice(0, stable.length), `${JSON.stringify(part)} (of ${JSON.stringify(line)})`);
      // Resuming from the stable offset gives the same remainder.
      const resumed = flat(parseInline(part, { final: false, from: p.stable }).runs);
      assert.deepEqual(resumed, flat(p.runs).slice(stable.length), `resume ${JSON.stringify(part)}`);
    }
  }
});

function paintRunsCut(runs, to) {
  const out = [];
  let pos = 0;
  for (const r of runs) {
    if (pos >= to) break;
    out.push({ t: r.t.slice(0, Math.max(0, to - pos)), f: r.f });
    pos += r.t.length;
  }
  return out;
}

test("lineDirection: first strong letter, Arabic majority, forced, undecided while streaming", () => {
  assert.equal(lineDirection("مرحبا بالعالم", null, true), "rtl");
  assert.equal(lineDirection("Hello world", null, true), "ltr");
  assert.equal(lineDirection("Firas Code هو وكيل برمجة يعمل داخل الطرفية", null, true), "rtl", "a leading product name does not make it LTR");
  assert.equal(lineDirection("npm test ثم", null, true), "ltr");
  assert.equal(lineDirection("123 !!!", null, true), "ltr");
  assert.equal(lineDirection("`code` مرحبا", null, true), "rtl", "code spans are ignored");
  assert.equal(lineDirection("https://example.com/path مرحبا", null, true), "rtl");
  assert.equal(lineDirection("abc", "rtl", true), "rtl");
  assert.equal(lineDirection("Hello wor", null, false), null, "fewer than 24 letters and still typing");
  assert.equal(lineDirection("مرحبا ", null, false), "rtl", "an RTL first letter decides as soon as its word is finished");
  assert.equal(lineDirection("مرحبا", null, false), null, "the word still being typed does not count yet");
  assert.equal(lineDirection("Hello world and a lot of other words here ", null, false), "ltr");
});

test("isPlainStart: only text that cannot turn into another block", () => {
  for (const s of ["Hello", "مرحبا", "**bold", "*it", "`code", "2026 was", "(paren", "[link", "1.5 is", "-5 degrees", "#tag", "~~x"]) assert.equal(isPlainStart(s), true, s);
  for (const s of ["", " ", "#", "## ", "- ", "-", "--", "* ", "*", "**", "1", "1.", "1. ", "12)", "```", "``", "~~~", ">", "|", "+ ", "___", "  x"]) assert.equal(isPlainStart(s), false, s);
});

test("the engine can be driven directly: line / partial / finish", () => {
  withLevel(0, () => {
    const e = createEngine({ getWidth: () => 30, indent: "" });
    assert.deepEqual(e.line("# Hi"), ["Hi", sym.hline.repeat(3)]);
    const p = e.partial("some words that will soon need to wrap around the row because they are many");
    assert.ok(p.lines.length >= 1 && typeof p.tail === "string");
    const rest = e.finish("");
    assert.deepEqual(rest, []);
    e.reset();
    assert.deepEqual(e.line("x"), ["x"]);
  });
});

test("hasRtl sanity: the renderer outputs shaped presentation forms, not the raw letters", () => {
  const out = plain("مرحبا", { width: 20 })[0];
  assert.ok(hasRtl(out));
  assert.ok(!out.includes("م"), "the plain Arabic letter is replaced by its positional form");
});

test("paintRuns keeps styles apart per run", () => {
  withLevel(3, () => {
    const s = paintRuns([{ t: "a", f: 1 }, { t: "b", f: 2 }]);
    assert.equal(s, c.bold("a") + c.italic("b"));
  });
});

test("finished lines never contain line breaks", () => {
  for (const name of NAMES) {
    for (const l of plain(CORPUS[name], { width: 50 })) assert.doesNotMatch(l, /[\r\n]/, name);
  }
});

test("the ASCII fallback draws everything with plain characters", async () => {
  const { spawnSync } = await import("node:child_process");
  const md = new URL("../../src/ui/markdown.js", import.meta.url).href;
  const df = new URL("../../src/ui/diff.js", import.meta.url).href;
  const th = new URL("../../src/ui/theme.js", import.meta.url).href;
  const letters = "abcdefghijk".split("");
  const payload = {
    doc: ["# Title", "", "- a", "  - b", "    - c", "1. x", "", "> quote", "", "---", "", "|a|b|", "|-|-|", "|1|2|", "", "```js", "let a = 1;", "```", "", "- [x] done"].join("\n"),
    oldText: letters.join("\n") + "\n",
    newText: letters.map((x, i) => (i === 0 || i === 10 ? x.toUpperCase() : x)).join("\n") + "\n",
  };
  const script = [
    `import { renderMarkdown } from ${JSON.stringify(md)};`,
    `import { renderDiff } from ${JSON.stringify(df)};`,
    `import { setColorLevel } from ${JSON.stringify(th)};`,
    "setColorLevel(0);",
    "const { doc, oldText, newText } = JSON.parse(process.argv[1]);",
    "const out = [...renderMarkdown(doc, { width: 40 }), ...renderDiff({ path: 'f', oldText, newText }, { width: 40, context: 1 })];",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(payload)], { env: { ...process.env, FIRAS_GLYPHS: "ascii", FIRAS_ASCII: "1", NO_COLOR: "1" }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.ok(out.length > 20);
  for (const l of out) assert.doesNotMatch(l, /[^\x20-\x7e]/, l);
  assert.ok(out.some(l => l.startsWith("+--")) && out.some(l => l.includes("| a")), "box drawn with + - |");
  assert.ok(out.some(l => l.includes("... ")), "the fold marker is ASCII too");
});

test("a fence inside a deeply indented list item still closes", () => {
  const doc = ["10. Run it:", "    ```bash", "    npm i", "    ```", "11. Next", "", "- a", "  ```js", "  x", "  ```", "- b"].join("\n");
  assert.deepEqual(plain(doc), ["10. Run it:", `    ${sym.quote} bash`, `    ${sym.quote} npm i`, "", "11. Next", "", `${glyphs.bullets[0]} a`, `  ${sym.quote} js`, `  ${sym.quote} x`, "", `${glyphs.bullets[0]} b`]);
});

test("a heading with no text prints nothing and does not add a blank line", () => {
  assert.deepEqual(plain("a\n#\nb"), ["a", "b"]);
});

test("a table indented under a list item is still a table", () => {
  const out = plain(["1. Compare:", "   | a | b |", "   |---|---|", "   | 1 | 2 |", "2. Done"].join("\n"));
  assert.ok(out.some(l => l.startsWith(glyphs.box.tl)) && out.some(l => l.includes("1")) && out.includes("2. Done"));
});

test("with Arabic mode off nothing is shaped, reordered or right-aligned", () => {
  setArabicMode("off");
  try {
    assert.deepEqual(plain("مرحبا بالعالم", { width: 30 }), ["مرحبا بالعالم"]);
    assert.deepEqual(plain("- عنصر", { width: 30 }), [`${glyphs.bullets[0]} عنصر`]);
  } finally {
    setArabicMode("on");
  }
});
