// Compact syntax highlighter: a handful of regex rule tables, one master pattern per language.
//
// Decisions:
//  - The visible text is never changed: every token keeps its characters, so stripAnsi(highlight(x)) === x for any
//    input (CRLF included). Arabic is NOT shaped here; the renderer shapes each finished row it prints.
//  - Multi-line constructs (block comments, template literals, triple-quoted strings, ...) are carried across lines by
//    a tiny state object, which is what createLineHighlighter exposes so streamed code blocks highlight line by line
//    with exactly the colours the whole-block call would give.
//  - Unknown languages fall back to strings, numbers and comments only; "text"-like names are left alone.
//  - A line over LONG_LINE characters is left unpainted: it is minified or generated, and colouring it costs more
//    than it helps.
//  - Colours come from theme.js only: keywords accent, strings green, numbers yellow, comments gray italic, types blue,
//    functions and keys soft accent, constants magenta.
import { c, colorLevel } from "./theme.js";

const R = String.raw;
const LONG_LINE = 4000;
const set = s => new Set(s.split(" "));

const PAINT = {
  kw: s => c.accent(s),
  str: s => c.green(s),
  num: s => c.yellow(s),
  com: s => c.gray(c.italic(s)),
  type: s => c.blue(s),
  fn: s => c.accentSoft(s),
  prop: s => c.accentSoft(s),
  lit: s => c.magenta(s),
  tag: s => c.accent(s),
  attr: s => c.blue(s),
  rx: s => c.magenta(s),
  add: s => c.green(s),
  del: s => c.red(s),
  hunk: s => c.accent(s),
  meta: s => c.bold(s),
};

/** Paints one token with the theme colour of its class ("p" = plain). */
export function paintToken(cls, text) {
  const f = PAINT[cls];
  return f && text !== "" ? f(text) : text;
}

/** Joins [class, text] tokens into one styled string. */
export function paintTokens(tokens) {
  if (!colorLevel()) {
    let plain = "";
    for (const t of tokens) plain += t[1];
    return plain;
  }
  let out = "";
  for (const t of tokens) out += paintToken(t[0], t[1]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scanner engine

function nextChar(line, from) {
  for (let i = from; i < line.length; i++) {
    const ch = line[i];
    if (ch !== " " && ch !== "\t") return ch;
  }
  return "";
}

// Finds the end of a multi-line construct on this line; `close` matches either the closer or an escape pair.
function findClose(line, from, close) {
  let pos = from;
  for (;;) {
    close.lastIndex = pos;
    const m = close.exec(line);
    if (!m) return -1;
    if (m[0].length > 1 && m[0][0] === "\\") { pos = m.index + m[0].length; continue; }
    return m.index + m[0].length;
  }
}

function compile(rules, opts = {}) {
  const parts = [];
  const byKey = Object.create(null);
  rules.forEach(r => {
    parts.push("(" + r.re + ")");
    if (r.key) byKey[r.key] = r;
  });
  return { rules, re: new RegExp(parts.join("|"), "g"), byKey, opts };
}

function scan(sc, line, st) {
  const out = [];
  const n = line.length;
  const track = sc.opts.track;
  const push = (cls, text) => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last && last[0] === cls) last[1] += text; else out.push([cls, text]);
    if (track) { const t = text.trimEnd(); if (t) st.prev = t[t.length - 1]; }
  };
  if (sc.opts.start) sc.opts.start(st, line);
  let i = 0;
  if (st.m) {
    const r = sc.byKey[st.m];
    const end = findClose(line, 0, r.close);
    if (end < 0) { push(r.cls, line); return out; }
    push(r.cls, line.slice(0, end));
    st.m = null;
    i = end;
  }
  if (n - i > LONG_LINE) { push("p", line.slice(i)); return out; }
  const re = sc.re;
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (!m) break;
    if (m.index > i) push("p", line.slice(i, m.index));
    let g = 1;
    while (m[g] === undefined) g++;
    const r = sc.rules[g - 1];
    const text = m[0];
    const end = m.index + text.length;
    if (r.close) {
      const e = findClose(line, end, r.close);
      if (e < 0) { push(r.cls, line.slice(m.index)); st.m = r.key; i = n; break; }
      push(r.cls, line.slice(m.index, e));
      i = e;
      continue;
    }
    let cls = r.cls;
    if (typeof cls === "function") cls = cls(text, line, end, st, m.index);
    if (cls === null) { push("p", text[0]); i = m.index + 1; continue; }
    push(cls, text);
    i = end;
  }
  if (i < n) push("p", line.slice(i));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Shared rule pieces

const IDENT = R`[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff]*`;
const NUM = R`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,3}\b`;
const DQ = R`"(?:[^"\\]|\\.)*"?`;
const SQ = R`'(?:[^'\\]|\\.)*'?`;
const COM_SLASH = { cls: "com", re: R`\/\/.*` };
const COM_BLOCK = { cls: "com", re: R`\/\*`, close: /\*\//g, key: "bc" };
const COM_HASH = { cls: "com", re: R`(?<![^\s;|&(])#.*` };
const NUM_RULE = { cls: "num", re: NUM };

/**
 * Classifier for identifiers. cfg: kw, lit, types, ctx (contextual keywords), pascal (PascalCase = type),
 * bang (name! is a macro), fold (keywords are case-insensitive), defs (keyword -> class of the next name).
 */
function identClass(cfg) {
  const pascal = cfg.pascal !== false;
  return (word, line, end, st, idx) => {
    const key = cfg.fold ? word.toLowerCase() : word;
    const nx = nextChar(line, end);
    if (idx > 0 && line[idx - 1] === "." && !cfg.dotWords) return nx === "(" ? "fn" : "p";
    if (st.next) { const k = st.next; st.next = null; if (!cfg.kw.has(key)) return k; }
    if (cfg.ctx && cfg.ctx.has(key)) return /[\w{"'`\[*$]/.test(nx) ? "kw" : "p";
    if (cfg.kw.has(key)) {
      if (cfg.defs && cfg.defs[key] && /[A-Za-z_$]/.test(nx)) st.next = cfg.defs[key];
      return "kw";
    }
    if (cfg.lit && cfg.lit.has(key)) return "lit";
    if (cfg.types && cfg.types.has(word)) return "type";
    if (cfg.bang && nx === "!" && line[end] === "!") return "fn";
    if (pascal && /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word)) return "type";
    if (nx === "(") return "fn";
    return "p";
  };
}

// ---------------------------------------------------------------------------------------------
// Language tables

function jsSpec(ts, jsx) {
  const kw = set("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await static" +
    (ts ? " interface enum implements declare abstract private public protected readonly" : ""));
  const ctx = set("from of as" + (ts ? " type is module namespace keyof infer satisfies override" : ""));
  const lit = set("true false null undefined NaN Infinity");
  const types = ts ? set("string number boolean any unknown never object symbol bigint void") : null;
  const idc = identClass({ kw, ctx, lit, types, defs: { function: "fn", class: "type" } });
  const exprStart = p => p === undefined || p === "" || "(,=:?[{&|!;>+-*%<~^".includes(p);
  const rules = [
    COM_SLASH, COM_BLOCK,
    { cls: "str", re: R`\``, close: /\\.|`/g, key: "tpl" },
    { cls: "str", re: DQ }, { cls: "str", re: SQ },
    { cls: (_t, _l, _e, st) => (exprStart(st.prev) ? "rx" : null), re: R`\/(?![*/])(?:[^/\\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuvy]*` },
  ];
  if (jsx) {
    rules.push({
      cls: (t, _l, _e, st) => (t === "/>" || t.startsWith("</") || exprStart(st.prev) ? "tag" : null),
      re: R`<\/?(?:[A-Za-z][\w.:-]*)?(?=[\s/>])|\/>`,
    });
  }
  rules.push(NUM_RULE, { cls: idc, re: IDENT });
  return compile(rules, { track: true });
}

function pySpec() {
  const kw = set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield");
  const lit = set("True False None");
  const idc = identClass({ kw, lit, defs: { def: "fn", class: "type" } });
  const P = "(?:[rRbBuUfF]{1,2})?";
  return compile([
    { cls: "com", re: R`#.*` },
    { cls: "str", re: P + '"""', close: /\\.|"""/g, key: "tq1" },
    { cls: "str", re: P + "'''", close: /\\.|'''/g, key: "tq2" },
    { cls: "str", re: P + DQ }, { cls: "str", re: P + SQ },
    { cls: "fn", re: R`(?<=^[ \t]*)@[\w.]+` },
    NUM_RULE, { cls: idc, re: IDENT },
  ]);
}

function jsonSpec() {
  const keyOrString = (_t, line, end) => (/^\s*:/.test(line.slice(end, end + 200)) ? "prop" : "str");
  return compile([
    COM_SLASH, COM_BLOCK,
    { cls: keyOrString, re: R`"(?:[^"\\]|\\.)*"?` },
    { cls: "num", re: R`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b` },
    { cls: "lit", re: R`\b(?:true|false|null)\b` },
  ]);
}

function shSpec() {
  const kw = set("if then else elif fi for while until do done case esac in function select time export local readonly declare unset return exit break continue source alias");
  const keepCmd = set("if then else elif while until do time sudo exec nohup env xargs command ! doas");
  const word = (w, line, end, st) => {
    const nx = line[end];
    const cmd = st.cmd;
    if (nx === "=" && /^[A-Za-z_]\w*$/.test(w)) return "var";
    st.cmd = keepCmd.has(w);
    if (kw.has(w)) return "kw";
    return cmd ? "fn" : "p";
  };
  return compile([
    COM_HASH,
    { cls: "str", re: '"', close: /\\.|"/g, key: "dq" },
    { cls: "str", re: "'", close: /'/g, key: "sq" },
    { cls: "var", re: R`\$\{[^}]*\}?|\$[A-Za-z_]\w*|\$[0-9@#?!$*-]` },
    { cls: (_t, _l, _e, st) => { st.cmd = true; return "p"; }, re: R`\|\||&&|[|;&(){}]|\$\(` },
    { cls: "type", re: R`(?<=\s)--?[A-Za-z][\w-]*` },
    NUM_RULE,
    { cls: word, re: R`[A-Za-z_./~!][\w./+:@%~-]*` },
  ], { start: st => { if (!st.m) st.cmd = true; } });
}

function psSpec() {
  const kw = set("begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow");
  const idc = identClass({ kw, fold: true, pascal: false });
  const variable = t => (/^\$(true|false|null)$/i.test(t) ? "lit" : "var");
  return compile([
    { cls: "com", re: "<#", close: /#>/g, key: "bc" },
    COM_HASH,
    { cls: "str", re: R`"(?:[^"\x60]|\x60.)*"?` },
    { cls: "str", re: R`'(?:[^']|'')*'?` },
    { cls: variable, re: R`\$\{[^}]*\}|\$[\w:?^]+` },
    { cls: "type", re: R`(?<=\s|^)-[A-Za-z]\w*` },
    { cls: "fn", re: R`\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b` },
    NUM_RULE, { cls: idc, re: IDENT },
  ]);
}

function htmlSpec() {
  const inTag = (cls) => (_t, _l, _e, st) => (st.tag ? cls : null);
  return compile([
    { cls: "com", re: "<!--", close: /-->/g, key: "hc" },
    { cls: (_t, _l, _e, st) => { st.tag = true; return "tag"; }, re: R`<\/?[A-Za-z][\w:.-]*|<!DOCTYPE|<\?[\w-]+` },
    { cls: (_t, _l, _e, st) => { if (!st.tag) return null; st.tag = false; return "tag"; }, re: R`\??\/?>` },
    { cls: inTag("str"), re: R`"[^"]*"?|'[^']*'?` },
    { cls: inTag("attr"), re: R`[A-Za-z_:@#.][\w:.@#-]*(?=\s*=)` },
    { cls: "lit", re: R`&#?\w+;` },
  ]);
}

function cssSpec(nested) {
  const sel = (st, idx) => st.depth === 0 || (st.brace >= 0 && idx < st.brace);
  const rules = [COM_BLOCK];
  if (nested) rules.push(COM_SLASH);
  rules.push(
    { cls: "str", re: DQ }, { cls: "str", re: SQ },
    { cls: "kw", re: R`@[\w-]+` },
    { cls: (_t, _l, _e, st, idx) => (sel(st, idx) ? "fn" : "num"), re: R`#[0-9a-fA-F]{3,8}\b(?![\w-])|#[\w-]+` },
    { cls: (_t, _l, _e, st, idx) => (sel(st, idx) ? "fn" : null), re: R`\.[A-Za-z_][\w-]*` },
    { cls: (_t, _l, _e, st, idx) => (sel(st, idx) ? "p" : "prop"), re: R`--[\w-]+|[A-Za-z-]+(?=\s*:)` },
    { cls: (_t, _l, _e, st, idx) => (sel(st, idx) ? "type" : null), re: R`::?[A-Za-z-]+` },
    { cls: "num", re: R`(?<![\w-])-?\d*\.?\d+(?:[a-zA-Z]+|%)?` },
    { cls: "kw", re: R`!\s*important` },
    { cls: "fn", re: R`[A-Za-z-]+(?=\()` },
    { cls: (t, _l, _e, st) => { if (t === "{") st.depth++; else if (t === "}") st.depth = Math.max(0, st.depth - 1); return "p"; }, re: R`[{}]` },
  );
  return compile(rules, { start: (st, line) => { if (st.depth === undefined) st.depth = 0; st.brace = line.indexOf("{"); } });
}

function sqlSpec() {
  const kw = set("select from where and or not in is null like between exists join inner left right full outer cross on as group by order having limit offset union all distinct insert into values update set delete create alter drop table index view database schema primary key foreign references constraint default unique check add column if then else case when end begin commit rollback transaction with returning using asc desc truncate grant revoke");
  const types = set("int integer bigint smallint tinyint serial varchar char text boolean bool date time timestamp datetime decimal numeric float double real blob json jsonb uuid");
  const idc = (word, line, end) => {
    const w = word.toLowerCase();
    if (kw.has(w)) return "kw";
    if (types.has(w)) return "type";
    if (w === "true" || w === "false" || w === "null") return "lit";
    return nextChar(line, end) === "(" ? "fn" : "p";
  };
  return compile([
    { cls: "com", re: R`--.*` }, COM_BLOCK,
    { cls: "str", re: R`'(?:[^']|'')*'?` },
    NUM_RULE, { cls: idc, re: R`[A-Za-z_][\w$]*` },
  ]);
}

function yamlSpec() {
  return compile([
    COM_HASH,
    { cls: "prop", re: R`(?<=^[ \t]*(?:-[ \t]+)*)(?:"[^"\n]*"|'[^'\n]*'|(?!-[ \t])[^\s#:'"{}\[\],&*!|>%@][^:#\n]*?)(?=[ \t]*:(?:[ \t]|$))` },
    { cls: "str", re: DQ }, { cls: "str", re: SQ },
    { cls: "kw", re: R`^(?:---|\.\.\.)(?=\s|$)|[|>][+-]?\d*[ \t]*$` },
    { cls: "lit", re: R`\b(?:true|false|null|yes|no|on|off|True|False|Null)\b` },
    { cls: "fn", re: R`[&*][\w-]+` },
    { cls: "type", re: R`!{1,2}[\w!-]+` },
    NUM_RULE,
  ]);
}

function tomlSpec() {
  return compile([
    COM_HASH,
    { cls: "type", re: R`^[ \t]*\[\[?[^\]\n]*\]\]?` },
    { cls: "prop", re: R`(?<=^[ \t]*)[\w.-]+(?=[ \t]*=)|(?<=^[ \t]*)"[^"\n]*"(?=[ \t]*=)` },
    { cls: "str", re: '"""', close: /\\.|"""/g, key: "t1" },
    { cls: "str", re: "'''", close: /'''/g, key: "t2" },
    { cls: "str", re: DQ }, { cls: "str", re: R`'[^'\n]*'?` },
    { cls: "lit", re: R`\b(?:true|false)\b` },
    { cls: "num", re: R`\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?` },
    NUM_RULE,
  ]);
}

function mdSpec() {
  const inner = compile([
    { cls: "str", re: R`\x60[^\x60\n]+\x60` },
    { cls: "kw", re: R`\*\*[^*\n]+\*\*|__[^_\n]+__` },
    { cls: "fn", re: R`\[[^\]\n]*\]\([^)\n]*\)` },
    { cls: "type", re: R`(?<=^[ \t]*)(?:[-*+]|\d+[.)])(?=[ \t])` },
  ]);
  return {
    custom(line, st) {
      if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) { st.f = !st.f; return [["com", line]]; }
      if (st.f) return [["str", line]];
      if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) return [["kw", line]];
      if (/^\s{0,3}>/.test(line)) return [["com", line]];
      if (/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return [["com", line]];
      return scan(inner, line, st);
    },
  };
}

function diffSpec() {
  return {
    custom(line) {
      if (/^(?:diff |index |new file|deleted file|similarity|rename |old mode|new mode|\+\+\+ |--- )/.test(line)) return [["meta", line]];
      if (line.startsWith("@@")) return [["hunk", line]];
      if (line.startsWith("+")) return [["add", line]];
      if (line.startsWith("-")) return [["del", line]];
      return [["p", line]];
    },
  };
}

function cSpec(cfg) {
  const idc = identClass({ ...cfg, kw: set(cfg.kw), lit: set(cfg.lit), types: set(cfg.types) });
  const rules = [];
  if (cfg.hash) rules.push({ cls: "com", re: R`#.*` });
  rules.push(COM_SLASH, COM_BLOCK);
  if (cfg.raw) rules.push({ cls: "str", re: R`\``, close: /`/g, key: "raw" });
  if (cfg.pre) rules.push({ cls: "kw", re: R`(?<=^[ \t]*)#[ \t]*\w+` }, { cls: "str", re: R`(?<=#[ \t]*include[ \t]*)<[^>\n]*>` });
  if (cfg.attr) rules.push({ cls: "fn", re: cfg.attr });
  if (cfg.php) rules.push({ cls: "kw", re: R`<\?(?:php|=)?|\?>` }, { cls: "var", re: R`\$\w+` });
  if (cfg.lifetime) rules.push({ cls: "type", re: R`'[a-z_]\w*\b(?!')` });
  rules.push({ cls: "str", re: DQ });
  rules.push({ cls: "str", re: cfg.chars ? R`'(?:\\.[^']*|[^'\\])'` : SQ });
  rules.push(NUM_RULE, { cls: idc, re: IDENT });
  return compile(rules);
}

function rubySpec() {
  const kw = set("alias and begin break case class def do else elsif end ensure for if in module next not or redo rescue retry return super then undef unless until when while yield");
  const lit = set("true false nil self");
  const idc = identClass({ kw, lit, defs: { def: "fn", class: "type", module: "type" } });
  return compile([
    COM_HASH,
    { cls: "str", re: DQ }, { cls: "str", re: SQ },
    { cls: "lit", re: R`(?<![\w:]):[A-Za-z_]\w*[?!]?` },
    { cls: "var", re: R`@@?\w+|\$\w+` },
    NUM_RULE, { cls: idc, re: R`[A-Za-z_]\w*[?!]?` },
  ]);
}

function genericSpec() {
  return compile([
    COM_SLASH, COM_BLOCK, COM_HASH,
    { cls: "str", re: DQ }, { cls: "str", re: SQ }, { cls: "str", re: R`\`(?:[^\`\\]|\\.)*\`?` },
    NUM_RULE,
  ]);
}

const C_KW = "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while";
const C_TYPES = "int char short long float double void signed unsigned bool size_t ssize_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t FILE";
const CPP_KW = C_KW + " class namespace template typename public private protected virtual override final new delete this using try catch throw operator explicit constexpr noexcept decltype static_cast dynamic_cast reinterpret_cast const_cast mutable friend";

const BUILDERS = {
  js: () => jsSpec(false, false),
  jsx: () => jsSpec(false, true),
  ts: () => jsSpec(true, false),
  tsx: () => jsSpec(true, true),
  json: jsonSpec,
  py: pySpec,
  sh: shSpec,
  ps: psSpec,
  html: htmlSpec,
  css: () => cssSpec(false),
  scss: () => cssSpec(true),
  sql: sqlSpec,
  yaml: yamlSpec,
  toml: tomlSpec,
  md: mdSpec,
  diff: diffSpec,
  c: () => cSpec({ kw: C_KW, types: C_TYPES, lit: "true false NULL", pre: true, chars: true }),
  cpp: () => cSpec({ kw: CPP_KW, types: C_TYPES + " string vector map set unique_ptr shared_ptr", lit: "true false NULL nullptr", pre: true, chars: true }),
  java: () => cSpec({
    kw: "abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield",
    types: "int long short byte float double boolean char void String Object Integer Long Double List Map Set",
    lit: "true false null", attr: R`@[A-Za-z_]\w*`, chars: true,
  }),
  go: () => cSpec({
    kw: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    types: "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any",
    lit: "true false nil iota", raw: true, chars: true, defs: { type: "type" },
  }),
  rust: () => cSpec({
    kw: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    types: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box",
    lit: "true false None Some Ok Err", attr: R`#!?\[[^\]\n]*\]`, lifetime: true, chars: true, bang: true, defs: { fn: "fn", struct: "type", enum: "type", trait: "type" },
  }),
  php: () => cSpec({
    kw: "abstract and as break callable case catch class clone const continue declare default do echo else elseif empty extends final finally fn for foreach function global goto if implements include include_once instanceof interface isset list match namespace new or print private protected public require require_once return static switch throw trait try unset use var while xor yield",
    types: "int float string bool array object mixed void self parent iterable callable",
    lit: "true false null TRUE FALSE NULL", hash: true, php: true,
  }),
  clike: () => cSpec({
    kw: "abstract as async await base break by case catch class companion const constructor continue data default defer delegate do else enum event explicit extends extension extern fileprivate final finally fixed fun func for foreach get guard if implements import in inline init inout interface internal is lateinit let lazy lock namespace new object open operator out override package params partial private protected public readonly record ref required return sealed set static struct subscript super switch this throw throws try typealias typeof unsafe using val var virtual volatile when where while with yield",
    types: "Int Long Short Byte Float Double Boolean Char String Unit Any Nothing void int long short byte float double bool char string object decimal",
    lit: "true false null nil undefined", attr: R`@[A-Za-z_]\w*`, chars: true,
  }),
  ruby: rubySpec,
  generic: genericSpec,
};

const ALIASES = {
  js: "js", javascript: "js", node: "js", mjs: "js", cjs: "js", jsx: "jsx",
  ts: "ts", typescript: "ts", mts: "ts", cts: "ts", tsx: "tsx",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", geojson: "json",
  py: "py", python: "py", python3: "py", py3: "py", pyi: "py",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", shellscript: "sh", console: "sh", terminal: "sh", fish: "sh", dockerfile: "sh",
  ps: "ps", ps1: "ps", psm1: "ps", powershell: "ps", pwsh: "ps",
  html: "html", htm: "html", xhtml: "html", xml: "html", svg: "html", xsl: "html", xsd: "html", plist: "html", xaml: "html", vue: "html", svelte: "html", rss: "html", csproj: "html",
  css: "css", scss: "scss", sass: "scss", less: "scss",
  sql: "sql", mysql: "sql", postgres: "sql", postgresql: "sql", sqlite: "sql", plsql: "sql", tsql: "sql", pgsql: "sql",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "toml", cfg: "toml", conf: "toml", properties: "toml", env: "toml",
  md: "md", markdown: "md", mdx: "md",
  diff: "diff", patch: "diff",
  c: "c", h: "c", cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", go: "go", golang: "go", rust: "rust", rs: "rust", php: "php",
  ruby: "ruby", rb: "ruby",
  cs: "clike", csharp: "clike", kotlin: "clike", kt: "clike", swift: "clike", dart: "clike", scala: "clike", objc: "clike",
};

const PLAIN_NAMES = new Set(["", "text", "txt", "plain", "plaintext", "log", "logs", "output", "stdout", "stderr", "none", "raw"]);

const compiled = new Map();
function specFor(name) {
  let sp = compiled.get(name);
  if (!sp) { sp = BUILDERS[name](); compiled.set(name, sp); }
  return sp;
}

/** Canonical language name for a fence label, "plain" for text-like labels, "generic" for unknown ones. */
export function normalizeLang(lang) {
  const raw = String(lang || "").trim().toLowerCase().replace(/^language-/, "").replace(/^\{\s*/, "").replace(/^\./, "");
  const first = raw.split(/[\s{},:;]/)[0];
  if (PLAIN_NAMES.has(first)) return "plain";
  return ALIASES[first] || "generic";
}

/**
 * Highlighter that remembers multi-line state between lines.
 * tokens(line, peek) -> [class, text][]; with peek the state is left untouched (used for a half-typed line).
 */
export function createLineHighlighter(lang) {
  const name = normalizeLang(lang);
  if (name === "plain") return { name, tokens: line => [["p", line]] };
  const sp = specFor(name);
  let st = {};
  return {
    name,
    tokens(line, peek) {
      const state = peek ? { ...st } : st;
      let cr = "";
      let body = line;
      if (body.endsWith("\r")) { cr = "\r"; body = body.slice(0, -1); }
      let out;
      try {
        out = sp.custom ? sp.custom(body, state) : scan(sp, body, state);
      } catch {
        out = [["p", body]];
      }
      if (cr) out.push(["p", cr]);
      return out;
    },
  };
}

/** Highlights a whole snippet; returns an ANSI-styled string whose visible text equals `code`. */
export function highlight(code, lang) {
  const text = typeof code === "string" ? code : String(code ?? "");
  const hl = createLineHighlighter(lang);
  if (hl.name === "plain") return text;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) lines[i] = paintTokens(hl.tokens(lines[i]));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Wrapping helper shared by code blocks and diffs

const CLUSTER = /(?:\P{M}\p{M}*)(?:\u200d\P{M}\p{M}*)*/gu;
const ALEF_BASE = new Set([0x622, 0x623, 0x625, 0x627]);

/**
 * Cuts [class, text] tokens into rows of at most `first` columns for the first row and `rest` for the others.
 * Cuts fall between clusters (a base and its marks, an emoji sequence and a lam-alef pair stay together) and never
 * drop or add a character. `width` measures a piece of text (display.js stringWidth).
 */
export function wrapTokens(tokens, first, rest, width) {
  const rows = [[]];
  let used = 0;
  let limit = Math.max(1, first);
  const roomFor = w => used + w <= limit;
  for (const [cls, text] of tokens) {
    const clusters = text.match(CLUSTER) || [];
    let piece = "";
    const flush = () => {
      if (piece === "") return;
      const row = rows[rows.length - 1];
      const last = row[row.length - 1];
      if (last && last[0] === cls) last[1] += piece; else row.push([cls, piece]);
      piece = "";
    };
    for (let i = 0; i < clusters.length; i++) {
      let cl = clusters[i];
      if (cl === "ل" && i + 1 < clusters.length && ALEF_BASE.has(clusters[i + 1].codePointAt(0))) cl += clusters[++i];
      const w = cl.length === 1 && cl < "\x7f" ? 1 : width(cl);
      if (!roomFor(w) && used > 0) {
        flush();
        rows.push([]);
        used = 0;
        limit = Math.max(1, rest);
      }
      piece += cl;
      used += w;
    }
    flush();
  }
  return rows;
}
