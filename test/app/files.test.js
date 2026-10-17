import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scanFiles, matchFiles, createFileIndex } from "../../src/ui/files.js";
import { tempDir } from "./helpers.js";

function project() {
  const work = tempDir();
  const put = rel => { const full = path.join(work.dir, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, "x"); };
  ["package.json", "README.md", "src/app.js", "src/ui/screen.js", "src/ui/input.js", "test/app.test.js", "ملف.txt",
    "node_modules/dep/index.js", ".git/config", "dist/out.js", "build/x.js", "src/.cache/skip.js"].forEach(put);
  return work;
}

test("the scan skips version control and dependency folders and lists shallow files first", async () => {
  const work = project();
  try {
    const files = await scanFiles(work.dir);
    assert.ok(files.includes("src/ui/screen.js"));
    assert.ok(files.includes("ملف.txt"));
    assert.ok(!files.some(f => /node_modules|\.git\/|^dist|^build|\.cache/.test(f)), files.join(","));
    assert.ok(files.indexOf("README.md") < files.indexOf("src/ui/screen.js"), "breadth first");
  } finally { work.remove(); }
});

test("the scan stops at the limit", async () => {
  const work = tempDir();
  try {
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(work.dir, `f${i}.txt`), "x");
    assert.equal((await scanFiles(work.dir, { limit: 25 })).length, 25);
  } finally { work.remove(); }
});

test("matching prefers the file name, then the path, then a loose subsequence", () => {
  const files = ["src/ui/screen.js", "src/ui/input.js", "test/screen.test.js", "docs/notes.md", "README.md"];
  assert.equal(matchFiles(files, "screen.js")[0], "src/ui/screen.js");
  assert.deepEqual(matchFiles(files, "scr").slice(0, 2), ["src/ui/screen.js", "test/screen.test.js"]);
  assert.deepEqual(matchFiles(files, "ui/in"), ["src/ui/input.js"]);
  assert.deepEqual(matchFiles(files, "srcinp"), ["src/ui/input.js"], "subsequence");
  assert.deepEqual(matchFiles(files, "zzz"), []);
  assert.deepEqual(matchFiles(files, "SCREEN").length, 2, "case-insensitive");
  assert.equal(matchFiles(files, "").length, 5);
  assert.equal(matchFiles(files, "", 2).length, 2);
});

test("the index is built once and cached", async () => {
  const work = project();
  try {
    const index = createFileIndex({ cwd: work.dir });
    assert.deepEqual(await index.files("app.js"), ["src/app.js", "test/app.test.js"]);
    fs.writeFileSync(path.join(work.dir, "late.js"), "x");
    assert.deepEqual(await index.files("late"), [], "the cache is still fresh");
  } finally { work.remove(); }
});
