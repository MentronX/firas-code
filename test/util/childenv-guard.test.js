// Every program the app starts gets its environment through childEnv (no access code in it). A new spawn that forgets
// it fails here, so the secret cannot start leaking by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "../../src/util/env.js";
import * as common from "../../src/tools/common.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

// Names that start a program. `.exec(` (a regular expression) is not one: the lookbehind skips member calls.
const START = /(?<![.\w$])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|nodeSpawn|nodeSpawnSync)\s*\(/g;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith(".js") ? [full] : [];
  });
}

/** The text between the parenthesis at `open` and its partner (quotes and template strings are skipped over). */
function balanced(text, open, left = "(", right = ")") {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === left) depth++;
    else if (ch === right && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Top-level pieces of an argument list. */
function splitArgs(args) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < args.length && args[i] !== ch; i++) if (args[i] === "\\") i++;
    } else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) { out.push(args.slice(from, i)); from = i + 1; }
  }
  out.push(args.slice(from));
  return out.map(part => part.trim()).filter(Boolean);
}

/** Does `text` start a child process whose options carry a childEnv(...) environment? Returns the offending lines. */
export function startsWithoutChildEnv(text) {
  if (!/child_process/.test(text)) return [];
  const bad = [];
  for (const match of text.matchAll(START)) {
    const open = match.index + match[0].length - 1;
    const args = balanced(text, open);
    const pieces = splitArgs(args);
    const covered = pieces.some(piece => {
      if (/\bchildEnv\s*\(/.test(piece)) return true;
      // Options kept in a variable declared just before the call.
      if (!/^[A-Za-z_$][\w$]*$/.test(piece)) return false;
      const declared = new RegExp(`(?:const|let|var)\\s+${piece}\\s*=\\s*`).exec(text.slice(0, match.index));
      if (!declared) return false;
      const from = declared.index + declared[0].length;
      const body = text[from] === "{" ? balanced(text, from, "{", "}") : text.slice(from, text.indexOf(";", from));
      return /\bchildEnv\s*\(/.test(body);
    });
    if (!covered) bad.push(text.slice(0, match.index).split("\n").length);
  }
  return bad;
}

test("childEnv lives in util/env.js and the tools' own helper module still exports it", () => {
  assert.equal(common.childEnv, childEnv);
  assert.deepEqual(childEnv({ A: "1", firas_code: "x", FIRAS_CODE: "y" }), { A: "1" });
});

test("every child process started anywhere in src/ gets its environment from childEnv", () => {
  const files = walk(SRC);
  const starters = files.filter(file => /child_process/.test(fs.readFileSync(file, "utf8")));
  assert.ok(starters.length >= 6, "the scan sees the files that start programs: " + starters.map(f => path.basename(f)).join(", "));
  for (const file of files) {
    const bad = startsWithoutChildEnv(fs.readFileSync(file, "utf8"));
    assert.deepEqual(bad, [], `${path.relative(SRC, file)} starts a program without childEnv at line(s) ${bad.join(", ")}`);
  }
});

test("the scan itself: it flags a start without childEnv and accepts the shapes the code uses", () => {
  const head = 'import { spawn } from "node:child_process";\n';
  assert.deepEqual(startsWithoutChildEnv(head + 'spawn("x", [], { stdio: "ignore" });'), [2]);
  assert.deepEqual(startsWithoutChildEnv(head + 'spawn("x", [], { env: process.env });'), [2]);
  assert.deepEqual(startsWithoutChildEnv(head + 'spawn("x", [], { env: childEnv(env) });'), []);
  assert.deepEqual(startsWithoutChildEnv(head + 'const options = { cwd, env: { ...childEnv(), A: "1" } };\nexecFile("git", ["status"], options, cb);'), []);
  assert.deepEqual(startsWithoutChildEnv(head + 'const options = { cwd };\nexecFile("git", [], options, cb);'), [3]);
  assert.deepEqual(startsWithoutChildEnv(head + 'const m = /a/.exec(text);'), [], "a regular expression is not a program start");
  assert.deepEqual(startsWithoutChildEnv('spawn("x");'), [], "a file that never imports child_process is out of scope");
  assert.deepEqual(startsWithoutChildEnv(head + 'const r = spawnSync(file, [")"], { env: childEnv(e) });'), [], "a bracket inside a string does not confuse it");
});
