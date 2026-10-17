import test from "node:test";
import assert from "node:assert/strict";
import { highlight, createLineHighlighter, normalizeLang, paintTokens, paintToken, wrapTokens } from "../../src/ui/highlight.js";
import { c, setColorLevel, colorLevel } from "../../src/ui/theme.js";
import { setArabicMode, stripAnsi, stringWidth } from "../../src/text/display.js";

setArabicMode("on");
setColorLevel(3); // this file runs in its own process; the level-0 checks switch explicitly

function withLevel(level, fn) {
  const saved = colorLevel();
  setColorLevel(level);
  try { return fn(); } finally { setColorLevel(saved); }
}

const hl = (code, lang) => withLevel(3, () => highlight(code, lang));
const kw = s => c.accent(s);
const str = s => c.green(s);
const num = s => c.yellow(s);
const com = s => c.gray(c.italic(s));
const type = s => c.blue(s);
const fn = s => c.accentSoft(s);
const lit = s => c.magenta(s);

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

test("javascript: keywords, strings, numbers, comments, calls, types, constants", () => {
  const out = hl('const x = 1.5e3; // note\nfoo("s", `t`, \'u\'); new Foo(); return null;', "js");
  assert.ok(out.includes(kw("const")));
  assert.ok(out.includes(num("1.5e3")));
  assert.ok(out.includes(com("// note")));
  assert.ok(out.includes(fn("foo")));
  assert.ok(out.includes(str('"s"')) && out.includes(str("`t`")) && out.includes(str("'u'")));
  assert.ok(out.includes(type("Foo")));
  assert.ok(out.includes(kw("return")) && out.includes(lit("null")));
  assert.ok(!out.includes(kw("x")), "plain identifiers stay plain");
});

test("javascript: contextual words are not keywords where they are names", () => {
  const out = hl("const o = { type: 1, of: 2 };\nobj.type = a.from;\nimport x from 'y';\nfor (const k of list) {}", "ts");
  assert.ok(!out.includes(kw("type")));
  assert.ok(out.includes(kw("from")) && out.includes(kw("of")));
  assert.ok(hl("type Foo = string;\ninterface Bar {}", "ts").includes(kw("type")));
  assert.ok(hl("type Foo = string;", "ts").includes(type("string")));
});

test("javascript: template literals and block comments continue over lines", () => {
  const lines = withLevel(3, () => highlight("let a = `one\ntwo ${x}\nthree`; let b = 1;\n/* c1\nc2 */ let d;", "js").split("\n"));
  assert.ok(lines[1].startsWith(str("two ${x}")), "the middle line is still a string");
  assert.ok(lines[2].startsWith(str("three`")) && lines[2].includes(kw("let")), "the string ends and code resumes");
  assert.equal(lines[4].indexOf(com("c2 */")), 0);
  assert.ok(lines[4].includes(kw("let")));
});

test("javascript: regex literals only where an expression can start", () => {
  const out = hl("const r = /ab+c/gi; const q = a / b / c;", "js");
  assert.ok(out.includes(c.magenta("/ab+c/gi")));
  assert.ok(!out.includes(c.magenta("/ b /")), "division is not a regex");
});

test("jsx tags", () => {
  const out = hl("const a = <Button onClick={f}>go</Button>;", "jsx");
  assert.ok(out.includes(c.accent("<Button")) && out.includes(c.accent("</Button")));
  assert.ok(!hl("if (a < b && c > d) {}", "jsx").includes(c.accent("<")));
});

test("json: keys, strings, numbers, literals", () => {
  const out = hl('{"name": "x", "n": -12.5e2, "ok": true, "none": null, "a": [1, "b"]}', "json");
  assert.ok(out.includes(fn('"name"')) && out.includes(str('"x"')));
  assert.ok(out.includes(num("-12.5e2")) && out.includes(lit("true")) && out.includes(lit("null")));
  assert.ok(out.includes(str('"b"')), "strings that are not keys stay strings");
});

test("python: keywords, def/class names, docstrings over lines, decorators, f-strings", () => {
  const out = withLevel(3, () => highlight('@app.route("/x")\ndef handler(a, b=2):\n    """doc\n    more"""\n    return f"{a}" # c\nclass Thing(Base): pass\nTrue', "python").split("\n"));
  assert.ok(out[0].startsWith(fn("@app.route")));
  assert.ok(out[1].includes(kw("def")) && out[1].includes(fn("handler")) && out[1].includes(num("2")));
  assert.ok(out[3].includes(str('    more"""')), "the docstring continues on the next line");
  assert.ok(out[4].includes(kw("return")) && out[4].includes(str('f"{a}"')) && out[4].includes(com("# c")));
  assert.ok(out[5].includes(type("Thing")));
  assert.ok(out[6].includes(lit("True")));
});

test("shell: commands, options, variables, quotes, comments", () => {
  const out = hl('if [ -f "$HOME/x" ]; then\n  echo "a $B" | grep -n foo && ls --all # done\nfi\nFOO=1 make', "bash");
  assert.ok(out.includes(kw("if")) && out.includes(kw("then")) && out.includes(kw("fi")));
  assert.ok(out.includes(fn("echo")) && out.includes(fn("grep")) && out.includes(fn("ls")));
  assert.ok(out.includes(type("-n")) && out.includes(type("--all")));
  assert.ok(out.includes(str('"a $B"')) && out.includes(com("# done")));
  assert.ok(!hl("curl http://x.y/#frag", "sh").includes(com("#frag")), "a # inside a word is not a comment");
});

test("powershell: cmdlets, parameters, variables, comments", () => {
  const out = hl("Get-ChildItem -Path $env:TEMP | Where-Object { $_.Length -gt 10 } # c\n<# block\nmore #> $true", "powershell");
  assert.ok(out.includes(fn("Get-ChildItem")) && out.includes(fn("Where-Object")));
  assert.ok(out.includes(type("-Path")) && out.includes(type("-gt")));
  assert.ok(out.includes(com("# c")) && out.includes(lit("$true")));
});

test("html and xml: tags, attributes, strings, comments, entities", () => {
  const out = hl('<!-- c -->\n<div class="a" id=\'b\'>x "q" &amp; <br/></div>', "html");
  assert.ok(out.includes(com("<!-- c -->")));
  assert.ok(out.includes(kw("<div")) && out.includes(type("class")) && out.includes(str('"a"')));
  assert.ok(out.includes(lit("&amp;")));
  assert.ok(!out.includes(str('"q"')), "quotes in text content are not attribute values");
  assert.ok(hl("<?xml version=\"1.0\"?>\n<a b='1'/>", "xml").includes(kw("<a")));
});

test("css and scss: selectors, properties, values, at-rules", () => {
  const out = hl(".card:hover, #id {\n  color: #fff; margin: 0 10px !important;\n  background: url(x.png);\n}\n@media (max-width: 600px) { a { b: c } }", "css");
  assert.ok(out.includes(fn(".card")) && out.includes(type(":hover")) && out.includes(fn("#id")));
  assert.ok(out.includes(fn("color")) && out.includes(num("#fff")) && out.includes(num("10px")) && out.includes(kw("!important")));
  assert.ok(out.includes(fn("url")) && out.includes(kw("@media")));
  const scss = hl("// note\n.a { &:hover { color: red; } }", "scss");
  assert.ok(scss.includes(com("// note")));
});

test("sql: keywords in any case, strings with doubled quotes, functions, comments", () => {
  const out = hl("select a, Count(*) from t where x = 'it''s' -- c\nGROUP by a;", "sql");
  assert.ok(out.includes(kw("select")) && out.includes(kw("from")) && out.includes(kw("where")) && out.includes(kw("GROUP")) && out.includes(kw("by")));
  assert.ok(out.includes(fn("Count")) && out.includes(str("'it''s'")) && out.includes(com("-- c")));
});

test("yaml and toml", () => {
  const y = hl("name: foo # c\nlist:\n  - a: 1\n  - \"b\": true\nkey: |\n  text", "yaml");
  assert.ok(y.includes(fn("name")) && y.includes(com("# c")) && y.includes(fn("a")) && y.includes(num("1")) && y.includes(lit("true")));
  assert.ok(!y.includes(fn("- a")), "the list dash is not part of the key");
  const t = hl('[server]\nport = 8080\nname = "x" # c\nok = true', "toml");
  assert.ok(t.includes(type("[server]")) && t.includes(fn("port")) && t.includes(num("8080")) && t.includes(str('"x"')) && t.includes(lit("true")));
});

test("markdown and diff", () => {
  const md = withLevel(3, () => highlight("# Title\n- item **b** `c` [l](u)\n```js\nx\n```\n> q", "md").split("\n"));
  assert.equal(md[0], kw("# Title"));
  assert.ok(md[1].includes(kw("**b**")) && md[1].includes(str("`c`")) && md[1].includes(fn("[l](u)")));
  assert.equal(md[3], str("x"), "inside a fence the line is code");
  const d = withLevel(3, () => highlight("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx", "diff").split("\n"));
  assert.equal(d[0], c.bold("--- a/x"));
  assert.equal(d[2], c.accent("@@ -1 +1 @@"));
  assert.equal(d[3], c.red("-old"));
  assert.equal(d[4], c.green("+new"));
  assert.equal(d[5], " ctx");
});

test("c, cpp, java, go, rust, php, ruby and friends", () => {
  assert.ok(hl('#include <stdio.h>\nint main(void) { return 0; }', "c").includes(kw("#include")));
  assert.ok(hl("int main(void) { return 0; }", "c").includes(type("int")));
  assert.ok(hl("class A : public B { virtual void f() override; };", "cpp").includes(kw("virtual")));
  assert.ok(hl('@Override\npublic String name() { return "x"; }', "java").includes(fn("@Override")));
  assert.ok(hl("func main() { x := `raw\nstring` }", "go").includes(kw("func")));
  assert.ok(hl("fn main() { println!(\"{}\", 1); let r: &'a str = x; }", "rust").includes(fn("println")));
  assert.ok(hl("let r: &'a str = x;", "rust").includes(type("'a")));
  assert.ok(hl("<?php\n$x = 1; echo \"a\"; // c", "php").includes(kw("<?php")));
  assert.ok(hl("def hi\n  puts :sym # c\nend", "ruby").includes(lit(":sym")));
  assert.ok(hl("fun main() { val x = 1 }", "kotlin").includes(kw("val")));
});

test("unknown languages: strings, numbers and comments only; text-like labels are untouched", () => {
  const out = hl('foo = "x" + 12 # c\nbar // d', "somethingelse");
  assert.ok(out.includes(str('"x"')) && out.includes(num("12")) && out.includes(com("# c")) && out.includes(com("// d")));
  assert.ok(!out.includes(kw("foo")) && !out.includes(fn("bar")), "identifiers are left alone");
  for (const name of ["text", "txt", "plaintext", "log", "output", "", undefined, "none"]) {
    assert.equal(hl('const x = "y"; // z', name), 'const x = "y"; // z', String(name));
  }
});

test("language names: aliases, case, fence info strings", () => {
  const cases = {
    JavaScript: "js", mjs: "js", node: "js", jsx: "jsx", TypeScript: "ts", tsx: "tsx", json5: "json", python3: "py", Bash: "sh", zsh: "sh", console: "sh",
    pwsh: "ps", PowerShell: "ps", htm: "html", svg: "html", sass: "scss", postgres: "sql", yml: "yaml", markdown: "md", patch: "diff", "c++": "cpp",
    golang: "go", rs: "rust", rb: "ruby", csharp: "clike", "language-python": "py", "js title=a.js": "js", "{.rust}": "rust", ".sql": "sql",
    nothing_like_this: "generic", text: "plain", "": "plain",
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(normalizeLang(name), want, name);
});

test("without colour the output is exactly the input", () => {
  const code = 'const a = "x"; // y\n/* z\nw */ if (a) { return `t\nu`; }\r\n';
  withLevel(0, () => {
    for (const lang of ["js", "python", "bash", "css", "html", "sql", "json", "yaml", "rust", "unknown"]) assert.equal(highlight(code, lang), code, lang);
  });
});

test("line highlighter keeps state across lines; peek leaves it alone", () => {
  withLevel(3, () => {
    const h = createLineHighlighter("js");
    h.tokens("let a = 1; /* start");
    const peeked = h.tokens("still comment */ let b", true);
    assert.deepEqual(peeked[0], ["com", "still comment */"]);
    const real = h.tokens("middle", false);
    assert.deepEqual(real, [["com", "middle"]], "peeking did not consume the open comment");
    const end = h.tokens("end */ x");
    assert.deepEqual(end[0], ["com", "end */"]);
    assert.equal(paintTokens([["kw", "a"], ["p", " b"]]), kw("a") + " b");
    assert.equal(paintToken("p", "x"), "x");
    assert.equal(paintToken("nonsense", "x"), "x");
  });
  withLevel(3, () => {
    const code = "let a = `x\ny`; /* c\nd */ z";
    const h = createLineHighlighter("js");
    const per = code.split("\n").map(l => paintTokens(h.tokens(l))).join("\n");
    assert.equal(per, highlight(code, "js"), "the stateful and the whole-snippet paths agree");
  });
});

test("the visible text never changes (fuzz, Arabic, CRLF, tabs, odd bytes)", () => {
  const rand = rng(2024);
  const bits = ['"', "'", "`", "/", "*", "\\", "#", "<", ">", "=", "-", "$", "{", "}", "(", ")", "[", "]", ":", ";", "!", "@", "%", "&", "|", " ", "  ", "\t", "\n", "\r\n",
    "a", "foo", "Foo", "123", "1.5e3", "0xFF", "if", "const", "def", "return", "select", "true", "null", "/*", "*/", "//", "<!--", "-->", "<?php", "```", '"""', "'''", "<#", "#>",
    "مرحبا", "لا", "كِتَابٌ", "😀", "日本", "é", "\u0000", "\u007f", "‍"];
  const langs = ["js", "jsx", "ts", "tsx", "json", "py", "sh", "ps", "html", "css", "scss", "sql", "yaml", "toml", "md", "diff", "c", "cpp", "java", "go", "rust", "php", "ruby", "clike", "generic", "weird name"];
  for (const lang of langs) {
    for (let t = 0; t < 60; t++) {
      let code = "";
      for (let k = Math.floor(rand() * 60); k > 0; k--) code += bits[Math.floor(rand() * bits.length)];
      const out = hl(code, lang);
      assert.equal(stripAnsi(out), code, `${lang}: ${JSON.stringify(code)}`);
    }
  }
});

test("never throws, whatever it is given", () => {
  const nasty = ["", "\n", "\r", "\r\n\r\n", "x".repeat(50_000), '"'.repeat(5000), "/*".repeat(3000), "`".repeat(4000), "<".repeat(4000), "\\".repeat(4001), "a\n".repeat(5000)];
  for (const lang of ["js", "py", "sh", "ps", "html", "css", "sql", "yaml", "toml", "md", "diff", "rust", "ruby", "x"]) {
    for (const code of nasty) assert.equal(stripAnsi(hl(code, lang)), code, `${lang} ${code.length}`);
  }
  assert.equal(highlight(undefined, "js"), "");
  assert.equal(highlight(null, "js"), "");
  assert.equal(stripAnsi(highlight(42, "js")), "42");
});

test("performance: 100 KB in well under 50 ms", () => {
  const sample = {
    js: 'const x = `a ${b}`; // comment\nfunction foo(a, b) { return a + b * 12.5 /* c */ + "str\\n"; }\nclass Foo extends Bar { static x = [1, 2, 3] }\n',
    python: 'def foo(a, b):\n    """doc"""\n    return {"k": [1, 2.5, None], "s": f"{a}"}  # c\n',
    css: ".a:hover > b { color: #fff; margin: 0 10px; background: url(x.png) } /* c */\n",
    html: '<div class="a" id="b">text &amp; <b>x</b></div> <!-- c -->\n',
    json: '{"a": [1, 2, true, null], "b": {"c": "d", "e": 1.5e3}}\n',
  };
  withLevel(3, () => {
    for (const [lang, unit] of Object.entries(sample)) {
      const code = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
      highlight(code.slice(0, 3000), lang);
      let best = Infinity;
      for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        highlight(code, lang);
        best = Math.min(best, performance.now() - t0);
      }
      assert.ok(best < 50, `${lang}: ${best.toFixed(1)} ms`);
    }
  });
});

test("wrapTokens: nothing lost, width respected, clusters kept whole", () => {
  const joined = rows => rows.map(r => r.map(t => t[1]).join("")).join("");
  const toks = [["kw", "const "], ["p", "abcdefghijklmnopqrstuvwxyz"], ["str", '"مرحبا بالعالم لا"']];
  const rows = wrapTokens(toks, 10, 8, stringWidth);
  assert.equal(joined(rows), toks.map(t => t[1]).join(""));
  rows.forEach((r, i) => assert.ok(stringWidth(r.map(t => t[1]).join("")) <= (i ? 8 : 10), `row ${i}`));
  assert.equal(rows[0][0][0], "kw", "classes survive the cut");
  // lam + alef is one cell and must stay together; a base letter keeps its mark; an emoji family stays whole.
  const awkward = wrapTokens([["p", "xلاy"]], 2, 2, stringWidth);
  const rowText = r => r.map(t => t[1]).join("");
  assert.equal(joined(awkward), "xلاy");
  assert.ok(awkward.some(r => rowText(r).includes("لا")), "the lam-alef pair is never split over two rows");
  const marks = wrapTokens([["p", "بَبَبَبَ"]], 2, 2, stringWidth);
  assert.ok(marks.every(r => !/^[ً-ٟ]/.test(r.map(t => t[1]).join(""))), "a mark never starts a row");
  const fam = "👨‍👩‍👧";
  assert.ok(wrapTokens([["p", "a" + fam + "b"]], 2, 2, stringWidth).some(r => r.map(t => t[1]).join("").includes(fam)));
  assert.deepEqual(wrapTokens([], 5, 5, stringWidth), [[]]);
});
