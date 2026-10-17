// A differential / property test of the Bash gate. Instead of listing the commands somebody thought of, it throws
// thousands of pseudo-random strings (and thousands of damaged copies of known-good commands) at the classifier and
// checks the relations that must hold for ALL of them:
//
//   isStrictReadonly(x)                  =>  isPlainCommand(x)  and  x has no character a shell treats specially
//   classifyCommand(x).risk==="readonly" =>  isStrictReadonly(x)
//   classifyCommand(x).remember          =>  isPlainCommand(x)
//
// The generator is seeded, so a failure is reproducible: the message carries the exact string.
// (The exotic characters are written as code points so that this file stays plain ASCII.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";
import { classifyCommand, isPlainCommand, isStrictReadonly } from "../../src/tools/classify.js";
import { HIDDEN } from "../../src/tools/common.js";

/** Small, fast, deterministic generator (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const chars = (...codes) => codes.map(code => String.fromCodePoint(code));

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
// Typographic quotes (single and double, low and high, guillemets), then the invisible and direction-changing characters.
const TYPOGRAPHIC = chars(0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x201e, 0x201f, 0x2039, 0x203a, 0xab, 0xbb);
const EXOTIC = chars(0x0b, 0x0c, 0x85, 0xa0, 0x2028, 0x2029, 0x200b, 0x202e, 0x2066, 0xfeff, 0xe9, 0x628, 0x4e2d, 0x1f600, 0xe0041);
// Every character a shell or a path gives a meaning to, quotes of every kind included.
const ASCII_SPECIAL = [" ", "'", "\"", "`", "$", "(", ")", "{", "}", "[", "]", "<", ">", "|", "&", ";", "\\", "~", "^", "!", "#", "%", "*", "?", "=", ",", ":", "@", "+", "-", ".", "/", "\r", "\n", "\t", "\0"];
const SPECIAL = [...ASCII_SPECIAL, ...TYPOGRAPHIC, ...EXOTIC];
const ALPHABET = [...LETTERS, ...DIGITS, ...SPECIAL];

// Characters that make a command anything but a plain list of words: a strict-readonly command has none of them.
const FORBIDDEN = new RegExp("['\"`$(){}\\[\\]<>|&;\\\\!#%*?\\r\\n\\t\\0\\u{b}\\u{c}\\u{80}-\\u{10ffff}]", "u");
const ALLOWED = /^[A-Za-z0-9_./:=@+,~^-]+( [A-Za-z0-9_./:=@+,~^-]+)*$/;

const GOOD = [
  "pwd", "whoami", "hostname", "date", "date -u", "uname -a", "echo hello", "which node", "ls", "ls -la", "ls src", "ls -1 src/app.js",
  "cat package.json", "cat -n src/app.js", "head -n 5 a.txt", "tail -20 a.txt", "wc -l a.txt", "type a.txt", "dir src", "gci src",
  "git status", "git status --short --branch", "git log --oneline -n 5", "git diff --stat", "git diff HEAD~1", "git diff --cached -- src/app.js", "git show HEAD",
  "git branch", "git branch --list", "git rev-parse --show-toplevel", "git ls-files src", "git describe --tags", "git --version",
  "node --version", "npm -v", "python --version", "Get-ChildItem src", "Get-Content a.txt -TotalCount 5", "Get-Content README.md -Raw", "get-content a.txt",
];

const KINDS = ["bash", "sh", "powershell", "cmd"];

function pick(rand, list) { return list[Math.floor(rand() * list.length)]; }

function randomString(rand) {
  const length = 1 + Math.floor(rand() * 24);
  let out = "";
  for (let i = 0; i < length; i++) out += pick(rand, ALPHABET);
  return out;
}

// A string made of plausible words, so that the interesting (nearly valid) region is explored as well.
const WORDS = ["git", "status", "log", "diff", "show", "ls", "cat", "head", "tail", "wc", "pwd", "echo", "node", "npm", "-v", "-n", "-la", "--version", "--stat",
  "src", "a.txt", "package.json", "README.md", ".env", ".git", "..", "/etc/passwd", "HEAD~1", "main", "--", "-c", "-C", "--output=x", "Get-Content", "Get-ChildItem", "-Raw"];

function mutate(rand, text) {
  const at = Math.floor(rand() * (text.length + 1));
  switch (Math.floor(rand() * 6)) {
    case 0: return text.slice(0, at) + pick(rand, ALPHABET) + text.slice(at);
    case 1: return text.slice(0, at) + pick(rand, ALPHABET) + text.slice(at + 1);
    case 2: return text.slice(0, at) + text.slice(at + 1);
    case 3: return text.slice(0, at) + pick(rand, SPECIAL) + pick(rand, ALPHABET) + text.slice(at);
    case 4: return text + pick(rand, SPECIAL) + pick(rand, WORDS);
    default: return pick(rand, SPECIAL) + text;
  }
}

function wordy(rand) {
  const count = 1 + Math.floor(rand() * 5);
  const words = [];
  for (let i = 0; i < count; i++) words.push(pick(rand, WORDS));
  let text = words.join(" ");
  for (let i = Math.floor(rand() * 3); i > 0; i--) text = mutate(rand, text);
  return text;
}

function damaged(rand, base) {
  let text = base;
  for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) text = mutate(rand, text);
  return text;
}

function show(x) { return String(JSON.stringify(x)).replace(/[^\x20-\x7e]/gu, ch => `\\u{${ch.codePointAt(0).toString(16)}}`); }

test("the generator is deterministic, covers the alphabet it claims to, and the known-good list is really good", () => {
  const draw = seed => { const rand = prng(seed); return Array.from({ length: 5 }, () => randomString(rand)); };
  assert.deepEqual(draw(7), draw(7));
  assert.notDeepEqual(draw(7), draw(8));
  assert.ok(ALPHABET.length > 120);
  for (const ch of ["'", "\"", "`", String.fromCodePoint(0x2019), String.fromCodePoint(0x201c), "$", "(", "{", "[", "<", ">", "|", "&", ";", "\\", "~", "^", "!", "#", "%", "*", "?", "=", ",", ":", "@", "+", "-", ".", "/", "\r", "\n", "\t", "\0", String.fromCodePoint(0xe9)]) {
    assert.ok(ALPHABET.includes(ch), show(ch));
  }
  assert.ok(FORBIDDEN.test("a;b") && FORBIDDEN.test("a" + String.fromCodePoint(0x2019)) && !FORBIDDEN.test("git log --oneline HEAD~1"));
  // This is what keeps the property from being vacuous: plenty of undamaged commands really are accepted.
  const project = tmpProject({ "a.txt": "x", "package.json": "{}", "src/app.js": "x", "README.md": "x" });
  try {
    for (const kind of ["bash", "powershell"]) {
      const ctx = { kind, cwd: project.dir, platform: process.platform, env: process.env };
      const accepted = GOOD.filter(c => isStrictReadonly(c, ctx));
      assert.ok(accepted.length >= 25, `${kind}: only ${accepted.length} of the known-good commands are accepted; refused: ${show(GOOD.filter(c => !accepted.includes(c)))}`);
    }
  } finally { project.cleanup(); }
});

test("~3,000 random strings and ~3,000 damaged known-good commands never break the gate's relations", () => {
  const project = tmpProject({ "a.txt": "x\n", "package.json": "{}", "README.md": "x", "src/app.js": "x", ".env": "SECRET=1\n" });
  const started = Date.now();
  const rand = prng(0xf1a5c0de);
  const stats = { checked: 0, strict: 0, readonly: 0 };

  function check(command, kind) {
    const ctx = { kind, cwd: project.dir, platform: process.platform, env: process.env };
    const strict = isStrictReadonly(command, ctx);
    const classified = classifyCommand(command, { shellKind: kind, cwd: project.dir, platform: process.platform, env: process.env });
    stats.checked++;
    if (strict) {
      stats.strict++;
      assert.equal(isPlainCommand(command), true, `strict but not plain [${kind}] ${show(command)}`);
      assert.ok(!FORBIDDEN.test(command), `strict command with a shell-significant character [${kind}] ${show(command)}`);
      assert.ok(ALLOWED.test(command), `strict command outside the plain alphabet [${kind}] ${show(command)}`);
      assert.ok(!HIDDEN.test(command), `strict command with a hidden character [${kind}] ${show(command)}`);
      assert.ok(command === command.trim() && !command.includes("  "), `strict command with odd spacing [${kind}] ${show(command)}`);
    }
    if (classified.risk === "readonly") {
      stats.readonly++;
      // The one exception is a command of nothing but ASCII white space: it runs nothing (and Bash refuses it up front).
      if (!/^[ \t\r\n]*$/.test(command)) assert.equal(strict, true, `classified read-only but not strict [${kind}] ${show(command)}`);
    }
    if (classified.remember) assert.equal(isPlainCommand(command), true, `remembered but not plain [${kind}] ${show(command)}`);
    if (!isPlainCommand(command)) assert.deepEqual(classified.keys, [], `keys offered for a command that is not plain [${kind}] ${show(command)}`);
    assert.ok(["readonly", "normal", "high"].includes(classified.risk));
  }

  try {
    for (let i = 0; i < 3000; i++) {
      const command = i % 3 === 0 ? wordy(rand) : randomString(rand);
      check(command, pick(rand, KINDS));
    }
    for (let i = 0; i < 750; i++) {
      const base = pick(rand, GOOD);
      for (const kind of KINDS) check(damaged(rand, base), kind);
    }
    // The undamaged commands too, so that it is the damage that flips the answer.
    for (const base of GOOD) for (const kind of ["bash", "sh", "powershell"]) check(base, kind);
  } finally { project.cleanup(); }

  assert.ok(stats.checked >= 6000, `checked only ${stats.checked}`);
  assert.ok(stats.strict >= 100, `the corpus produced only ${stats.strict} strict read-only commands, too few for the property to mean anything`);
  assert.ok(stats.readonly >= 50, `only ${stats.readonly} read-only classifications`);
  assert.ok(Date.now() - started < 30_000, "the property test must stay fast");
});

test("only ASCII white space counts as an empty command; a no-break space, NEL or a byte order mark is a real character to a shell", () => {
  for (const kind of KINDS) {
    for (const code of [0xa0, 0x85, 0x2028, 0x2029, 0xfeff, 0x3000]) {
      const text = String.fromCodePoint(code);
      assert.notEqual(classifyCommand(text, { shellKind: kind }).risk, "readonly", `${kind} U+${code.toString(16)}`);
    }
    assert.equal(classifyCommand("  \n", { shellKind: kind }).risk, "readonly", "nothing to run");
  }
});

test("classifyCommand and isStrictReadonly are total: odd input never throws", () => {
  const project = tmpProject({ "a.txt": "x" });
  try {
    const odd = ["", " ", "\n", "\0", "\\", "'", "\"", "`", "$(", "${", "<<", "<<EOF", "(((", ")))", "|", "&&", ";;", "a".repeat(5000), String.fromCodePoint(0x202e).repeat(50), "ls " + "a/".repeat(500), undefined, null, 42];
    for (const kind of KINDS) {
      const ctx = { kind, cwd: project.dir, platform: process.platform, env: process.env };
      for (const command of odd) {
        assert.doesNotThrow(() => classifyCommand(command, { shellKind: kind, cwd: project.dir }), show(command));
        assert.doesNotThrow(() => isStrictReadonly(command, ctx), show(command));
        assert.doesNotThrow(() => isPlainCommand(command), show(command));
      }
    }
  } finally { project.cleanup(); }
});
