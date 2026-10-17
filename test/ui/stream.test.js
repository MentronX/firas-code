import test from "node:test";
import assert from "node:assert/strict";
import { createMarkdownStream } from "../../src/ui/stream.js";
import { renderMarkdown } from "../../src/ui/markdown.js";
import { setColorLevel, colorLevel } from "../../src/ui/theme.js";
import { setArabicMode, stripAnsi } from "../../src/text/display.js";
import { CORPUS, NAMES } from "./md-corpus.js";

setArabicMode("on");

// Small deterministic generator, so a failure can be replayed.
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function collect(text, chunks, { width = 52, indent = "  ", dir = "auto", widthFn } = {}) {
  const out = [];
  const partials = [];
  const s = createMarkdownStream({
    getWidth: widthFn || (() => width),
    indent,
    dir,
    onLines: lines => out.push(...lines),
    onPartial: p => partials.push(p),
  });
  for (const c of chunks) s.push(c);
  s.finish();
  return { out, partials };
}

function randomChunks(text, rand, max) {
  const chunks = [];
  for (let i = 0; i < text.length;) {
    const n = 1 + Math.floor(rand() * max);
    chunks.push(text.slice(i, i + n));
    i += n;
  }
  return chunks;
}

for (const level of [0, 3]) {
  test(`property: any chunking gives exactly renderMarkdown (colour level ${level})`, () => {
    const saved = colorLevel();
    setColorLevel(level);
    try {
      const rand = rng(1234 + level);
      for (const name of NAMES) {
        const text = CORPUS[name];
        for (const width of [30, 52, 90]) {
          const expected = renderMarkdown(text, { width, indent: "  " });
          const tries = [
            [...text],
            [text],
            ...Array.from({ length: 8 }, () => randomChunks(text, rand, 1 + Math.floor(rand() * 40))),
          ];
          for (const chunks of tries) {
            const { out } = collect(text, chunks, { width });
            assert.deepEqual(out, expected, `${name} @${width} in ${chunks.length} chunks`);
          }
        }
      }
    } finally {
      setColorLevel(saved);
    }
  });
}

test("property: forced directions and no gutter", () => {
  const saved = colorLevel();
  setColorLevel(3);
  try {
    const rand = rng(77);
    for (const dir of ["ltr", "rtl"]) {
      for (const name of ["english", "mixed", "tables", "nested"]) {
        const text = CORPUS[name];
        const expected = renderMarkdown(text, { width: 44, dir });
        const { out } = collect(text, randomChunks(text, rand, 9), { width: 44, indent: "", dir });
        assert.deepEqual(out, expected, `${name} dir=${dir}`);
      }
    }
  } finally {
    setColorLevel(saved);
  }
});

// Random markdown made of block starts, inline markers and words in two scripts.
test("property: random documents, random chunks (including surrogate halves and CRLF)", () => {
  const saved = colorLevel();
  setColorLevel(3);
  try {
    const rand = rng(99);
    const pick = a => a[Math.floor(rand() * a.length)];
    const words = ["hello", "world", "npm", "src/app.js", "مرحبا", "بالعالم", "كلمة", "الملف", "لا", "😀", "a", "123", "(paren)", "[brk]", "end."];
    const marks = ["**", "*", "_", "`", "``", "[", "](", "](http://u.rl)", ")", "~~", "|", "\\*", "&amp;", "http://x.y/z_w", "<https://q.r>", "![", "***", "[x](y)", "`c`"];
    const starts = ["", "", "", "# ", "- ", "  - ", "1. ", "> ", "- [ ] ", "| ", "```", "```js", "---", "|---|---|", "| a | b |", "  "];
    const makeLine = () => {
      let s = pick(starts);
      const n = Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) { s += rand() < 0.2 ? pick(marks) : pick(words); if (rand() < 0.85) s += " "; }
      return s;
    };
    for (let t = 0; t < 250; t++) {
      const lines = Array.from({ length: 1 + Math.floor(rand() * 8) }, makeLine);
      const text = lines.join(rand() < 0.15 ? "\r\n" : "\n") + (rand() < 0.5 ? "\n" : "");
      const width = pick([24, 40, 80]);
      const expected = renderMarkdown(text, { width, indent: "  " });
      const { out } = collect(text, randomChunks(text, rand, 1 + Math.floor(rand() * 30)), { width });
      assert.deepEqual(out, expected, JSON.stringify(text));
    }
  } finally {
    setColorLevel(saved);
  }
});

test("long single-line paragraphs are released row by row before their newline arrives", () => {
  setColorLevel(0);
  const text = "word ".repeat(120) + "\n";
  let before = -1;
  const out = [];
  const s = createMarkdownStream({ getWidth: () => 40, indent: "", onLines: l => { out.push(...l); }, onPartial: () => {} });
  for (let i = 0; i < text.length; i += 7) {
    s.push(text.slice(i, i + 7));
    if (before < 0 && out.length >= 3) before = i;
  }
  s.finish();
  assert.ok(before >= 0 && before < text.length - 50, "rows were committed while the line was still growing");
  assert.deepEqual(out, renderMarkdown(text, { width: 40 }));
});

test("rows never wait for a word that is still being typed, and are never repeated", () => {
  setColorLevel(0);
  const rand = rng(5);
  const text = CORPUS.longline + CORPUS.english;
  const seen = [];
  const s = createMarkdownStream({ getWidth: () => 50, indent: "", onLines: l => seen.push(...l), onPartial: () => {} });
  for (const c of randomChunks(text, rand, 13)) s.push(c);
  s.finish();
  assert.deepEqual(seen, renderMarkdown(text, { width: 50 }));
});

test("onPartial: unfinished tail as styled text, plain for unclosed markers, '' when nothing is pending", () => {
  setColorLevel(3);
  const partials = [];
  const lines = [];
  const s = createMarkdownStream({ getWidth: () => 60, indent: "", onLines: l => lines.push(...l), onPartial: p => partials.push(p) });
  s.push("Hello **wor");
  assert.equal(partials.at(-1), "Hello **wor", "an unclosed ** is shown as plain text");
  assert.equal(lines.length, 0);
  s.push("ld** and `co");
  assert.equal(stripAnsi(partials.at(-1)), "Hello world and `co");
  assert.ok(partials.at(-1).includes("\x1b[1m"), "the closed ** is bold");
  s.push("de` done\n");
  assert.equal(partials.at(-1), "", "the partial is cleared once the line is committed");
  assert.equal(lines.length, 1);
  assert.equal(stripAnsi(lines[0]), "Hello world and  code  done");
  s.push("# Head");
  assert.equal(stripAnsi(partials.at(-1)).includes("#"), false, "no # is shown for a heading being typed");
  assert.ok(stripAnsi(partials.at(-1)).includes("Head"));
  s.finish();
  assert.equal(partials.at(-1), "");
  setColorLevel(0);
});

test("headings and list items are committed when their source line is complete", () => {
  setColorLevel(0);
  const lines = [];
  const s = createMarkdownStream({ getWidth: () => 60, indent: "", onLines: l => lines.push(...l), onPartial: () => {} });
  s.push("## A heading that is\n");
  assert.ok(lines.some(l => l.includes("A heading that is")));
  const n = lines.length;
  s.push("- an item that keeps going for quite a while without a newline in sight, so long that it wraps around the row");
  assert.equal(lines.length, n, "a list item waits for its newline");
  s.push("\n");
  assert.ok(lines.length > n);
  s.finish();
});

test("fenced code is committed line by line; an unterminated fence is flushed by finish()", () => {
  setColorLevel(0);
  const lines = [];
  const partials = [];
  const s = createMarkdownStream({ getWidth: () => 60, indent: "", onLines: l => lines.push(...l), onPartial: p => partials.push(p) });
  s.push("```js\nconst a = 1;\nconst b");
  assert.ok(lines.some(l => l.includes("const a = 1;")), "a finished code line is out");
  assert.ok(!lines.some(l => l.includes("const b")));
  assert.ok(partials.at(-1).includes("const b"), "the half-typed code line is the partial");
  s.push(" = 2;\n");
  assert.ok(lines.some(l => l.includes("const b = 2;")));
  s.push("let c");
  s.finish();
  assert.ok(lines.some(l => l.includes("let c")), "finish() flushes the open code line");
  assert.equal(partials.at(-1), "");
});

test("a table is buffered and committed as one block when it ends; its rows show raw meanwhile", () => {
  setColorLevel(0);
  const lines = [];
  const partials = [];
  const s = createMarkdownStream({ getWidth: () => 60, indent: "", onLines: l => lines.push(...l), onPartial: p => partials.push(p) });
  s.push("| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(lines.length, 0, "nothing committed while the table may still grow");
  assert.ok(partials.at(-1).includes("| 1 | 2 |"), "raw rows are the partial");
  s.push("| 3 | 4 |\n\nafter");
  assert.ok(lines.length >= 6, "the whole box is committed when the table ends");
  assert.ok(lines.some(l => l.includes("3")));
  s.finish();
  assert.equal(lines.at(-1).trim(), "after");
});

test("CR and LF split across chunks count as one line break", () => {
  setColorLevel(0);
  const text = "one\r\ntwo\r\n\r\nthree";
  const expected = renderMarkdown(text, { width: 40 });
  for (let cut = 1; cut < text.length; cut++) {
    const { out } = collect(text, [text.slice(0, cut), text.slice(cut)], { width: 40, indent: "" });
    assert.deepEqual(out, expected, `cut at ${cut}`);
  }
});

test("a split surrogate pair or Arabic letter never shows garbage in the partial", () => {
  setColorLevel(0);
  const text = "ok \u{1F600} fine مرحبا";
  const partials = [];
  const s = createMarkdownStream({ getWidth: () => 40, indent: "", onLines: () => {}, onPartial: p => partials.push(p) });
  const cut = text.indexOf("\u{1F600}") + 1;
  s.push(text.slice(0, cut));
  assert.doesNotMatch(partials.at(-1), /[\ud800-\udbff]/);
  s.push(text.slice(cut));
  s.finish();
});

test("width changes between pushes are tolerated: committed lines stay, later ones use the new width", () => {
  setColorLevel(0);
  let width = 80;
  const out = [];
  const s = createMarkdownStream({ getWidth: () => width, indent: "", onLines: l => out.push(...l), onPartial: () => {} });
  const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega ".repeat(4) + "\n";
  s.push(text.slice(0, 120));
  const firstBatch = out.slice();
  width = 30;
  s.push(text.slice(120));
  s.finish();
  assert.deepEqual(out.slice(0, firstBatch.length), firstBatch, "lines already committed are not redone");
  const tail = out.slice(firstBatch.length);
  assert.ok(tail.length > 0 && tail.every(l => l.length <= 30), "later rows use the new width");
  assert.equal(out.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
});

test("reset() starts a new document and finish() on an empty stream is harmless", () => {
  setColorLevel(0);
  const out = [];
  const s = createMarkdownStream({ getWidth: () => 40, indent: "", onLines: l => out.push(...l), onPartial: () => {} });
  s.finish();
  assert.deepEqual(out, []);
  s.push("first\n\n");
  s.reset();
  s.push("second");
  s.finish();
  assert.deepEqual(out, ["first", "second"]);
});

test("garbage in the stream never throws and never lets an escape sequence through", () => {
  setColorLevel(0);
  const rand = rng(31337);
  const alphabet = ["a", "ب", " ", "\n", "\r", "\t", "*", "`", "[", "]", "(", ")", "|", "-", "#", ">", "1", ".", "\x1b[31m", "\x1b]8;;x\x07", "\u0007", "‮", "\u{1F600}", "\ud83d", "\ude00", "~", "_", "<", "&"];
  for (let t = 0; t < 300; t++) {
    let text = "";
    const n = Math.floor(rand() * 80);
    for (let i = 0; i < n; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
    const { out, partials } = collect(text, randomChunks(text, rand, 6), { width: 30 });
    for (const l of [...out, ...partials]) assert.equal(/[\x00-\x09\x0b-\x1f\x7f]/.test(l), false, JSON.stringify(l));
  }
});

test("performance: a 50 KB answer pushed 20 characters at a time", () => {
  setColorLevel(3);
  let doc = "";
  const parts = [CORPUS.english, CORPUS.mixed, CORPUS.code, CORPUS.arabic, CORPUS.nested, CORPUS.tables];
  while (doc.length < 50_000) doc += parts[Math.floor(doc.length / 997) % parts.length] + "\n\n";
  doc = doc.slice(0, 50_000);
  const run = () => {
    let count = 0;
    const s = createMarkdownStream({ getWidth: () => 90, indent: "  ", onLines: l => { count += l.length; }, onPartial: () => {} });
    const t0 = performance.now();
    for (let i = 0; i < doc.length; i += 20) s.push(doc.slice(i, i + 20));
    s.finish();
    return { ms: performance.now() - t0, count };
  };
  run();
  const best = Math.min(run().ms, run().ms, run().ms);
  assert.ok(best < 300, `took ${best.toFixed(0)} ms`);
  setColorLevel(0);
});

test("performance: one enormous line stays linear", () => {
  setColorLevel(0);
  const doc = "This is a paragraph with `code` and **bold** text that never ends with a newline. ".repeat(450);
  const s = createMarkdownStream({ getWidth: () => 90, indent: "", onLines: () => {}, onPartial: () => {} });
  const t0 = performance.now();
  for (let i = 0; i < doc.length; i += 20) s.push(doc.slice(i, i + 20));
  s.finish();
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});
