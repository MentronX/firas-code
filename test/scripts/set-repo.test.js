// set-repo: validates the argument, fills the placeholder everywhere it should, and is safe to run twice.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseRepo, replaceInTree, findPlaceholders, main, PLACEHOLDER } from "../../scripts/set-repo.mjs";
import { makeTemp, removeTree, run, projectRoot } from "./helpers.js";

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

describe("set-repo", () => {
  let work;
  let count = 0;
  before(() => { work = makeTemp("fc2-repo-"); });
  after(() => removeTree(work));

  const sample = () => {
    const root = path.join(work, `t${count++}`);
    fs.mkdirSync(root);
    writeTree(root, {
      ".gitignore": "_work/\nignored.txt\n",
      "README.md": `curl https://raw.githubusercontent.com/${PLACEHOLDER}/main/x\nnpx -y github:${PLACEHOLDER}\n`,
      "scripts/install.ps1": `$u = 'https://codeload.github.com/${PLACEHOLDER}/zip/refs/heads/main'\r\n`,
      "scripts/install.sh": `U="https://codeload.github.com/${PLACEHOLDER}/tar.gz/refs/heads/main"\n`,
      "src/brand.js": `export const REPO = "${PLACEHOLDER}";\n`,
      "src/other.js": "export const nothing = 1;\n",
      "_work/scratch.txt": PLACEHOLDER,
      "ignored.txt": PLACEHOLDER,
      "node_modules/pkg/index.js": PLACEHOLDER,
      "assets/logo.png": Buffer.concat([Buffer.from([137, 80, 78, 71, 0]), Buffer.from(PLACEHOLDER)])
    });
    return root;
  };

  test("parseRepo accepts the usual spellings and rejects nonsense", () => {
    assert.equal(parseRepo("firas/firas-code"), "firas/firas-code");
    assert.equal(parseRepo("  Firas-X/code.v2 "), "Firas-X/code.v2");
    assert.equal(parseRepo("https://github.com/firas/firas-code"), "firas/firas-code");
    assert.equal(parseRepo("https://github.com/firas/firas-code.git"), "firas/firas-code");
    assert.equal(parseRepo("git@github.com:firas/firas-code.git"), "firas/firas-code");
    assert.equal(parseRepo("github:firas/firas-code"), "firas/firas-code");
    for (const bad of ["", "firas", "firas/", "/code", "a/b/c", "fi ras/code", "firas/co de", "-x/code", "x/..", "x/.", "firas/code;rm", "firas/$(x)", null, undefined, 5]) {
      assert.equal(parseRepo(bad), null, String(bad));
    }
  });

  test("replaces the placeholder in every publishable text file and nowhere else", () => {
    const root = sample();
    const changed = replaceInTree(root, PLACEHOLDER, "firas/firas-code");
    assert.deepEqual(changed.map(c => [c.file, c.count]), [["README.md", 2], ["scripts/install.ps1", 1], ["scripts/install.sh", 1], ["src/brand.js", 1]]);
    assert.match(read(root, "README.md"), /githubusercontent\.com\/firas\/firas-code\/main\/x/);
    assert.match(read(root, "README.md"), /github:firas\/firas-code/);
    assert.equal(read(root, "scripts/install.ps1"), "$u = 'https://codeload.github.com/firas/firas-code/zip/refs/heads/main'\r\n", "line endings must survive");
    assert.match(read(root, "src/brand.js"), /REPO = "firas\/firas-code"/);
    assert.ok(read(root, "ignored.txt").includes(PLACEHOLDER), "ignored files are left alone");
    assert.ok(read(root, "_work/scratch.txt").includes(PLACEHOLDER));
    assert.ok(read(root, "node_modules/pkg/index.js").includes(PLACEHOLDER));
    assert.ok(fs.readFileSync(path.join(root, "assets/logo.png")).includes(Buffer.from(PLACEHOLDER)), "binary files are left alone");
    assert.deepEqual(findPlaceholders(root), []);
  });

  test("running it twice changes nothing the second time", () => {
    const root = sample();
    const lines = [];
    const out = s => lines.push(s);
    assert.equal(main(["firas/firas-code", "--root", root], { out }), 0);
    const snapshot = ["README.md", "scripts/install.ps1", "scripts/install.sh", "src/brand.js"].map(f => read(root, f));
    lines.length = 0;
    assert.equal(main(["firas/firas-code", "--root", root], { out }), 0);
    assert.match(lines.join("\n"), /Nothing to change/);
    assert.deepEqual(["README.md", "scripts/install.ps1", "scripts/install.sh", "src/brand.js"].map(f => read(root, f)), snapshot);
  });

  test("--check fails while the placeholder is present and passes after it is set", () => {
    const root = sample();
    const quiet = { out: () => {}, err: () => {} };
    assert.equal(main(["--check", "--root", root], quiet), 1);
    assert.equal(main(["firas/firas-code", "--root", root], quiet), 0);
    assert.equal(main(["--check", "--root", root], quiet), 0);
  });

  test("--dry-run reports but writes nothing", () => {
    const root = sample();
    const lines = [];
    assert.equal(main(["firas/firas-code", "--dry-run", "--root", root], { out: s => lines.push(s) }), 0);
    assert.match(lines[0], /Would set firas\/firas-code in 4 files/);
    assert.equal(findPlaceholders(root).length, 4);
  });

  test("--from corrects an earlier value", () => {
    const root = sample();
    const quiet = { out: () => {}, err: () => {} };
    main(["firas/typo", "--root", root], quiet);
    assert.equal(main(["firas/right", "--from", "firas/typo", "--root", root], quiet), 0);
    assert.match(read(root, "src/brand.js"), /firas\/right/);
    assert.doesNotMatch(read(root, "src/brand.js"), /typo/);
  });

  test("bad input exits 2 and touches nothing", () => {
    const root = sample();
    const errors = [];
    const opts = { out: () => {}, err: s => errors.push(s) };
    assert.equal(main(["not a repo", "--root", root], opts), 2);
    assert.equal(main([], opts), 2);
    assert.equal(main(["a/b", "c/d", "--root", root], opts), 2);
    assert.equal(main(["--wat"], opts), 2);
    assert.equal(findPlaceholders(root).length, 4);
    assert.ok(errors.length >= 4);
  });

  test("the script does not rewrite itself, and works from the command line", async () => {
    const root = path.join(work, `cli${count++}`);
    fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    for (const rel of ["scripts/set-repo.mjs", "scripts/lib/tree.mjs"]) fs.copyFileSync(path.join(projectRoot, rel), path.join(root, rel));
    writeTree(root, { "README.md": `see ${PLACEHOLDER}\n` });
    const before = read(root, "scripts/set-repo.mjs");
    const res = await run(process.execPath, [path.join(root, "scripts", "set-repo.mjs"), "firas/firas-code"], { cwd: root });
    assert.equal(res.status, 0, res.out);
    assert.match(res.stdout, /Set firas\/firas-code in 1 file/);
    assert.equal(read(root, "scripts/set-repo.mjs"), before);
    assert.equal(read(root, "README.md"), "see firas/firas-code\n");
    const check = await run(process.execPath, [path.join(root, "scripts", "set-repo.mjs"), "--check"], { cwd: root });
    assert.equal(check.status, 0);
  });
});
