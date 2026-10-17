// README, LICENSE and the notice about bundled libraries.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { projectRoot, makeTemp, removeTree } from "./helpers.js";
import { PLACEHOLDER, replaceInTree } from "../../scripts/set-repo.mjs";
import { banned, skipNoList, avoidedWordPattern } from "../helpers/banned.js";

const read = rel => fs.readFileSync(path.join(projectRoot, rel), "utf8");
const readme = read("README.md");
const split = readme.indexOf("\n## English");
const arabicPart = readme.slice(0, split);
const englishPart = readme.slice(split);
// Until the owner sets the repository the README carries the placeholder; afterwards it carries owner/repo.
const repoInReadme = /raw\.githubusercontent\.com\/([^/\s]+\/[^/\s]+)\/main\/scripts\/install\.ps1/.exec(readme)?.[1] || "";

describe("README.md", () => {
  test("has the Arabic section first and the English section second", () => {
    assert.ok(split > 0, "English heading missing");
    assert.match(readme.split("\n")[0], /[؀-ۿ]/, "first heading must be Arabic");
    assert.ok((arabicPart.match(/[؀-ۿ]/g) || []).length > 800);
    assert.match(arabicPart, /\(#english\)/);
    assert.ok(!/## (Install|Safety|Troubleshooting)/.test(arabicPart));
  });

  test("offers the three install ways in both languages, short and full", () => {
    assert.ok(repoInReadme === PLACEHOLDER || /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repoInReadme), "repository: " + repoInReadme);
    const commands = [
      "irm firasai.org/get | iex",
      "curl -fsSL firasai.org/get | bash",
      "irm https://raw.githubusercontent.com/" + repoInReadme + "/main/scripts/install.ps1 | iex",
      "[scriptblock]::Create((irm https://raw.githubusercontent.com/" + repoInReadme + "/main/scripts/install.ps1))) -Code FC2-",
      "curl -fsSL https://raw.githubusercontent.com/" + repoInReadme + "/main/scripts/install.sh | bash",
      "npx -y github:" + repoInReadme
    ];
    for (const part of [arabicPart, englishPart]) for (const command of commands) assert.ok(part.includes(command), command);
  });

  test("lists ten example prompts: five Arabic and five English", () => {
    const section = arabicPart.split("## جرّب هذه الطلبات")[1].split("\n## ")[0];
    const [arabicBlock, englishBlock] = section.split("بالإنجليزية:");
    const arabicBullets = arabicBlock.split("\n").filter(l => l.startsWith("- "));
    assert.equal(arabicBullets.length, 5);
    const block = englishBlock.split("```text")[1].split("```")[0].trim().split("\n");
    assert.equal(block.length, 5);
    assert.ok(block.every(l => /^[A-Za-z]/.test(l)));
    const mixed = englishPart.split("### Try these")[1].split("```text")[1].split("```")[0].trim().split("\n");
    assert.equal(mixed.length, 10);
    assert.equal(mixed.filter(l => /[؀-ۿ]/.test(l)).length, 5);
  });

  test("documents every shortcut and slash command in both languages", () => {
    const shortcuts = ["`Enter`", "`Shift+Enter`", "`Esc`", "`Shift+Tab`", "`Ctrl+O`", "`Ctrl+C`", "`@`", "`/`"];
    const commands = ["help", "clear", "compact", "effort", "mode", "lang", "arabic", "status", "cost", "copy", "init", "resume", "sessions", "logout", "update", "exit"];
    for (const part of [arabicPart, englishPart]) {
      for (const key of shortcuts) assert.ok(part.includes(key), key);
      for (const name of commands) assert.ok(part.includes("`/" + name + "`"), "/" + name);
      assert.ok(!part.includes("`Ctrl+T`") && !part.includes("`/thinking`"), "no way to show the model's reasoning text is advertised");
      for (const mode of ["default", "acceptEdits", "plan", "bypass"]) assert.ok(part.includes("`" + mode + "`"), mode);
    }
  });

  test("says the access code is saved on the device after the first successful sign-in", () => {
    assert.ok(arabicPart.includes("بعد أول دخول ناجح يُحفظ في جهازك"));
    assert.ok(englishPart.includes("after the first successful sign-in it is saved on your computer"));
  });

  test("covers Arabic display, troubleshooting and uninstall", () => {
    for (const needle of ["/copy", "/arabic off", "Windows Terminal", "FIRAS_UNINSTALL", "--uninstall", "--purge", "-Purge"]) {
      assert.ok(arabicPart.includes(needle) && englishPart.includes(needle), needle);
    }
  });

  test("has a privacy note in both languages about the access code on a command line", () => {
    const arabicNote = arabicPart.split("## الخصوصية")[1];
    assert.ok(arabicNote, "Arabic privacy section missing");
    const arabicBody = arabicNote.split("\n## ")[0];
    const englishBody = englishPart.split("### Privacy")[1]?.split("\n### ")[0];
    assert.ok(englishBody, "English privacy section missing");
    for (const body of [arabicBody, englishBody]) {
      for (const needle of ["FIRAS_CODE", "--code", "-Code", ".firas-code"]) assert.ok(body.includes(needle), needle);
    }
    assert.ok(readme.indexOf("## الخصوصية") < readme.indexOf("\n## English"), "Arabic first");
  });

  test("contains none of the listed words", { skip: skipNoList }, () => {
    const lower = readme.toLowerCase();
    for (const word of banned.all) assert.ok(!lower.includes(word), `the README contains "${word}"`);
    assert.ok(!avoidedWordPattern().test(readme), "the README uses the listed technical word");
  });

  test("becomes a clean README once the repository is set", () => {
    const dir = makeTemp("fc2-docs-");
    try {
      fs.writeFileSync(path.join(dir, "README.md"), readme.split(repoInReadme).join(PLACEHOLDER));
      replaceInTree(dir, PLACEHOLDER, "firas/firas-code");
      const filled = fs.readFileSync(path.join(dir, "README.md"), "utf8");
      assert.ok(!filled.includes(PLACEHOLDER));
      assert.ok(filled.includes("https://raw.githubusercontent.com/firas/firas-code/main/scripts/install.ps1"));
    } finally {
      removeTree(dir);
    }
  });

  test("links point at scripts that exist", () => {
    for (const rel of ["scripts/install.ps1", "scripts/install.sh"]) assert.ok(fs.existsSync(path.join(projectRoot, rel)), rel);
  });
});

describe("package.json", () => {
  test("lists only what the app needs at runtime: the updater fetches the installers from the repository", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.deepEqual(pkg.files, ["bin", "src", "vendor", "README.md", "LICENSE"]);
    for (const entry of pkg.files) assert.ok(fs.existsSync(path.join(projectRoot, entry)), entry);
    assert.deepEqual(Object.keys(pkg.scripts).sort(), ["start", "test"]);
    assert.ok(Object.values(pkg.bin).every(file => fs.existsSync(path.join(projectRoot, file))));
  });
});

describe("LICENSE and vendor notice", () => {
  test("the licence is the agreed sentence", () => {
    assert.equal(read("LICENSE").trim(), "Copyright (c) 2026 Firas. All rights reserved. Provided free of charge for evaluation; do not redistribute.");
  });

  test("the vendor notice says nothing is bundled", () => {
    assert.match(read("vendor/NOTICES.md"), /bundles no third-party libraries/);
  });
});
