// The application's strings: every key used in the source exists in both languages, the two tables match, and Arabic
// lines survive the layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, setLang } from "../../src/i18n/index.js";
import "../../src/ui/strings-app.js";
import "../../src/ui/strings-effort.js";
import { EFFORTS } from "../../src/config.js";
import { banned, skipNoList, avoidedWordPattern } from "../helpers/banned.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

const MY_FILES = [
  "src/cli.js", "src/config.js", "src/onboarding.js", "src/update.js",
  "src/ui/views.js", "src/ui/interactive.js", "src/ui/plain.js", "src/ui/history.js", "src/ui/files.js", "src/ui/strings-app.js",
  ...fs.readdirSync(path.join(root, "src/commands")).map(name => `src/commands/${name}`),
];

function tableKeys(lang) {
  const source = read("src/ui/strings-app.js");
  const start = source.indexOf(`\n  ${lang}: {`);
  assert.ok(start > 0, `${lang} table not found`);
  const next = lang === "en" ? source.indexOf("\n  ar: {") : source.length;
  const block = source.slice(start, next);
  return [...block.matchAll(/^\s{4}"([A-Za-z0-9_.]+)":/gm)].map(match => match[1]);
}

test("the English and Arabic tables hold exactly the same keys", () => {
  const en = tableKeys("en");
  const ar = tableKeys("ar");
  assert.ok(en.length > 150);
  assert.deepEqual([...new Set(en)].sort(), [...new Set(ar)].sort());
  assert.equal(new Set(en).size, en.length, "no key defined twice");
});

test("every app.* key used in the source resolves in both languages", () => {
  const used = new Set();
  for (const file of MY_FILES) {
    for (const match of read(file).matchAll(/["'`](app\.[A-Za-z0-9_.]+)["'`]/g)) used.add(match[1]);
  }
  // keys built from a value at run time
  for (const tag of ["interrupted", "stepLimit", "lengthLimit", "error", "empty"]) used.add(`app.stop.${tag}`);
  for (const risk of ["low", "medium", "high"]) used.add(`app.risk.${risk}`);
  for (const group of ["session", "settings", "info", "account", "keys"]) used.add(`app.help.group.${group}`);
  for (const id of ["send", "newline", "stop", "ctrlc", "exitEmpty", "mode", "expand", "commands", "files", "history"]) used.add(`app.help.key.${id}`);
  for (const level of EFFORTS) used.add(`app.effort.hint.${level}`);
  for (const mode of ["default", "acceptEdits", "plan", "bypass"]) used.add(`app.mode.hint.${mode}`);
  for (const mode of ["auto", "on", "off"]) used.add(`app.arabic.hint.${mode}`);
  for (const key of ["notConfigured", "insideApp", "devCheckout", "spawnFailed", "aborted", "failed", "running", "done"]) used.add(`app.update.${key}`);
  for (const kind of ["explore", "general"]) used.add(`app.agent.${kind}`);
  const sameInBoth = new Set(["app.arabic.sample"]);
  const problems = [];
  for (const key of [...used].sort()) {
    setLang("en");
    const en = t(key, {});
    setLang("ar");
    const ar = t(key, {});
    if (en === key) problems.push(`${key}: missing in English`);
    if (ar === key) problems.push(`${key}: missing in Arabic`);
    if (en === ar && !sameInBoth.has(key)) problems.push(`${key}: Arabic is the English text`);
    if (!/[؀-ۿ]/.test(ar)) problems.push(`${key}: the Arabic text has no Arabic letters`);
  }
  setLang("en");
  assert.deepEqual(problems, []);
});

test("every {placeholder} in English exists in the Arabic text and the other way round", () => {
  const source = read("src/ui/strings-app.js");
  const enBlock = source.slice(source.indexOf("\n  en: {"), source.indexOf("\n  ar: {"));
  const arBlock = source.slice(source.indexOf("\n  ar: {"));
  const names = block => {
    const map = new Map();
    for (const line of block.split("\n")) {
      const m = /^\s{4}"([A-Za-z0-9_.]+)":\s*(.*)$/.exec(line);
      if (m) map.set(m[1], new Set([...m[2].matchAll(/\{(\w+)\}/g)].map(x => x[1])));
    }
    return map;
  };
  const en = names(enBlock);
  const ar = names(arBlock);
  for (const [key, set] of en) assert.deepEqual([...(ar.get(key) || [])].sort(), [...set].sort(), key);
});

test("none of the listed words appears in a source file of the application layer", { skip: skipNoList }, () => {
  for (const file of MY_FILES) {
    const text = read(file).toLowerCase();
    for (const word of banned.all) assert.ok(!text.includes(word), `${file} contains "${word}"`);
    assert.ok(!avoidedWordPattern().test(text), `${file} contains the listed technical word`);
  }
});

test("Latin snippets in Arabic strings sit inside direction isolates", () => {
  setLang("ar");
  for (const key of ["app.card.more", "app.menu.hint", "app.cmd.unknown", "app.ctrlc.again", "app.code.hint", "app.footer.cycle", "app.cli.tryHelp"]) {
    const text = t(key, { n: 3 });
    assert.ok(text.includes("⁦") && text.includes("⁩"), key);
  }
  setLang("en");
});

test("there are no strings for showing or hiding the model's reasoning text, only the one-line summary", () => {
  for (const lang of ["en", "ar"]) {
    setLang(lang);
    for (const key of ["app.thinking.on", "app.thinking.off", "app.thinking.invalid", "app.thinking.header", "app.cmd.thinking", "app.help.key.thinking"]) {
      assert.equal(t(key, {}), key, `${key} still exists in ${lang}`);
    }
    assert.notEqual(t("app.thinking.thought", { time: "12 s" }), "app.thinking.thought");
  }
  setLang("en");
});

test("the repository placeholder is written only in brand.js", () => {
  const needle = "__" + "REPO" + "__";
  for (const file of MY_FILES) assert.ok(!read(file).includes(needle), file);
});
