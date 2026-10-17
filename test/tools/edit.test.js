import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup } from "./helpers.js";
import { setLang } from "../../src/i18n/index.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ------------------------------------------------------------------------------------------- Write

test("Write creates a file and its parent folders, and reports a diff for a new file", async () => {
  const s = setup();
  try {
    const r = await s.call("Write", { path: "a/b c/new file.txt", content: "one\ntwo\n" });
    assert.equal(r.ok, true);
    assert.equal(s.read("a/b c/new file.txt"), "one\ntwo\n");
    assert.match(r.content, /Created a\/b c\/new file\.txt \(2 lines\)/);
    assert.deepEqual(r.display.diff, { path: "a/b c/new file.txt", oldText: null, newText: "one\ntwo\n" });
    assert.equal(r.display.summary, "a/b c/new file.txt: new file, 2 lines");
    const one = await s.call("Write", { path: "one.txt", content: "just this\n" });
    assert.equal(one.display.summary, "one.txt: new file, 1 line");
  } finally { s.cleanup(); }
});

test("Write, Edit and MultiEdit say which file changed and by how many lines, in both languages", async () => {
  const s = setup({ "a.txt": "one\ntwo\nthree\n" });
  try {
    await s.call("Read", { path: "a.txt" });
    const edit = await s.call("Edit", { path: "a.txt", old_string: "two", new_string: "2\n2b" });
    assert.equal(edit.display.summary, "a.txt: +2 -1 lines");
    const many = await s.call("Edit", { path: "a.txt", old_string: "2", new_string: "x", replace_all: true });
    assert.equal(many.display.summary, "a.txt: +2 -2 lines in 2 places");
    const multi = await s.call("MultiEdit", { path: "a.txt", edits: [{ old_string: "one", new_string: "1" }, { old_string: "three", new_string: "3" }] });
    assert.equal(multi.display.summary, "a.txt: +2 -2 lines in 2 edits");
    const rewritten = await s.call("Write", { path: "a.txt", content: "only\n" });
    assert.match(rewritten.display.summary, /^a\.txt: \+1 -\d lines$/);
    assert.ok(!/applied/i.test(JSON.stringify([edit, many, multi].map(r => r.display.summary))), "no vague wording");
    setLang("ar");
    try {
      await s.call("Read", { path: "a.txt" });
      const ar = await s.call("Edit", { path: "a.txt", old_string: "only", new_string: "فقط" });
      assert.equal(ar.display.summary, "a.txt: الأسطر +1 -1");
      const created = await s.call("Write", { path: "b.txt", content: "x\ny\n" });
      assert.equal(created.display.summary, "b.txt: ملف جديد، الأسطر: 2");
    } finally { setLang("en"); }
  } finally { s.cleanup(); }
});

test("Write refuses to overwrite a file that was not read", async () => {
  const s = setup({ "f.txt": "original\n" });
  try {
    const r = await s.call("Write", { path: "f.txt", content: "new\n" });
    assert.equal(r.ok, false);
    assert.match(r.content, /not read this file.*Read it first/s);
    assert.equal(s.read("f.txt"), "original\n");
  } finally { s.cleanup(); }
});

test("Write works after a full Read, keeps line endings and BOM, and shows an old-to-new diff", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("c.txt"), Buffer.concat([BOM, Buffer.from("a\r\nb\r\nc\r\n")]));
    await s.call("Read", { path: "c.txt" });
    const r = await s.call("Write", { path: "c.txt", content: "x\ny\n" });
    assert.equal(r.ok, true);
    const bytes = s.readBuf("c.txt");
    assert.deepEqual([...bytes.subarray(0, 3)], [...BOM]);
    assert.equal(bytes.subarray(3).toString("utf8"), "x\r\ny\r\n");
    assert.equal(r.display.diff.oldText, "a\nb\nc\n");
    assert.equal(r.display.diff.newText, "x\ny\n");
    assert.match(r.content, /3 -> 2 lines/);
  } finally { s.cleanup(); }
});

test("Write keeps UTF-16 files in UTF-16", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("u.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("old\r\n", "utf16le")]));
    await s.call("Read", { path: "u.txt" });
    await s.call("Write", { path: "u.txt", content: "نص جديد\n" });
    const bytes = s.readBuf("u.txt");
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
    assert.equal(bytes.subarray(2).toString("utf16le"), "نص جديد\r\n");
  } finally { s.cleanup(); }
});

test("Write is refused when the file changed after it was read", async () => {
  const s = setup({ "f.txt": "v1\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    fs.writeFileSync(s.abs("f.txt"), "v2 changed elsewhere\n");
    const r = await s.call("Write", { path: "f.txt", content: "mine\n" });
    assert.equal(r.ok, false);
    assert.match(r.content, /changed on disk after you read it/);
    assert.equal(s.read("f.txt"), "v2 changed elsewhere\n");
    await s.call("Read", { path: "f.txt" });
    assert.equal((await s.call("Write", { path: "f.txt", content: "mine\n" })).ok, true);
  } finally { s.cleanup(); }
});

test("a touched-but-identical file is not 'stale'", async () => {
  const s = setup({ "f.txt": "same\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(s.abs("f.txt"), later, later);
    assert.equal((await s.call("Write", { path: "f.txt", content: "next\n" })).ok, true);
  } finally { s.cleanup(); }
});

test("Write refuses folders, partial reads, NUL and non-text content; no-ops are reported", async () => {
  const s = setup({ "d/x.txt": "x", "p.txt": "1\n2\n3\n4\n5\n" });
  try {
    assert.match((await s.call("Write", { path: "d", content: "x" })).content, /folder/);
    await s.call("Read", { path: "p.txt", limit: 2 });
    const partial = await s.call("Write", { path: "p.txt", content: "z" });
    assert.match(partial.content, /only read part/i);
    assert.match((await s.call("Write", { path: "n.txt", content: "a\0b" })).content, /NUL/);
    assert.match((await s.call("Write", { path: "n.txt" })).content, /content is required/);
    await s.call("Read", { path: "p.txt" });
    const same = await s.call("Write", { path: "p.txt", content: "1\n2\n3\n4\n5\n" });
    assert.match(same.content, /No change/);
  } finally { s.cleanup(); }
});

test("Write refuses a path whose parent is a file", async () => {
  const s = setup({ "file.txt": "x" });
  try {
    const r = await s.call("Write", { path: "file.txt/child.txt", content: "x" });
    assert.equal(r.ok, false);
  } finally { s.cleanup(); }
});

test("Write handles Arabic names and content, and a following Edit needs no new Read", async () => {
  const s = setup();
  try {
    await s.call("Write", { path: "ملف.txt", content: "السلام عليكم\nمرحبا\n" });
    const r = await s.call("Edit", { path: "ملف.txt", old_string: "مرحبا", new_string: "أهلًا" });
    assert.equal(r.ok, true);
    assert.equal(s.read("ملف.txt"), "السلام عليكم\nأهلًا\n");
  } finally { s.cleanup(); }
});

test("Write permission: new file previews as creation, existing as an old/new diff, edits are remembered under Edit:*", async () => {
  const s = setup({ "e.txt": "old\n" });
  try {
    const write = s.toolbox.byName.get("Write");
    const fresh = write.permission({ path: "fresh.txt", content: "hi" }, s.ctx);
    assert.equal(fresh.decision, "ask");
    assert.equal(fresh.diff.oldText, null);
    assert.equal(fresh.sessionKey, "Edit:*");
    assert.equal(fresh.inside, true);
    assert.equal(fresh.category, "edit");
    assert.equal(fresh.risk, "low");
    const refused = write.permission({ path: "e.txt", content: "new" }, s.ctx);
    assert.equal(refused.decision, "allow", "a write that will be refused is not worth a question");
    await s.call("Read", { path: "e.txt" });
    const over = write.permission({ path: "e.txt", content: "new\n" }, s.ctx);
    assert.equal(over.decision, "ask");
    assert.equal(over.diff.oldText, "old\n");
    const outside = write.permission({ path: path.join(path.dirname(s.dir), "outside.txt"), content: "x" }, s.ctx);
    assert.equal(outside.risk, "medium");
    assert.equal(outside.inside, false);
    assert.match(outside.sessionKey, /^Edit:dir:/);
    assert.equal(write.permission({ path: ".env", content: "A=1" }, s.ctx).risk, "high");
    assert.equal(write.permission({ path: "secrets/id_rsa", content: "k" }, s.ctx).sessionKey, undefined);
    const system = write.permission({ path: process.platform === "win32" ? "C:\\Windows\\x.txt" : "/etc/x.txt", content: "k" }, s.ctx);
    assert.equal(system.risk, "high");
  } finally { s.cleanup(); }
});

// -------------------------------------------------------------------------------------------- Edit

test("Edit replaces a unique string, shows the result, and produces a diff", async () => {
  const s = setup({ "src/app.js": "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n" });
  try {
    await s.call("Read", { path: "src/app.js" });
    const r = await s.call("Edit", { path: "src/app.js", old_string: "const b = 2;", new_string: "const b = 20;" });
    assert.equal(r.ok, true);
    assert.equal(s.read("src/app.js"), "const a = 1;\nconst b = 20;\nconsole.log(a + b);\n");
    assert.match(r.content, /replaced 1 occurrence at line 2/);
    assert.match(r.content, /     2\tconst b = 20;/);
    assert.equal(r.display.diff.path, "src/app.js");
    assert.equal(r.display.diff.oldText, "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");
    assert.equal(r.display.diff.newText, "const a = 1;\nconst b = 20;\nconsole.log(a + b);\n");
  } finally { s.cleanup(); }
});

test("Edit requires a prior Read and refuses stale files", async () => {
  const s = setup({ "f.txt": "alpha\n" });
  try {
    const unread = await s.call("Edit", { path: "f.txt", old_string: "alpha", new_string: "beta" });
    assert.equal(unread.ok, false);
    assert.match(unread.content, /not read this file/);
    await s.call("Read", { path: "f.txt" });
    fs.writeFileSync(s.abs("f.txt"), "alpha changed\n");
    const stale = await s.call("Edit", { path: "f.txt", old_string: "alpha", new_string: "beta" });
    assert.match(stale.content, /changed on disk/);
    assert.equal(s.read("f.txt"), "alpha changed\n");
    assert.equal(stale.display.summary, "File changed since it was read");
  } finally { s.cleanup(); }
});

test("Edit insists on a unique match unless replace_all, and says where the matches are", async () => {
  const s = setup({ "f.txt": "x = 1\ny = 2\nx = 1\nz\nx = 1\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    const many = await s.call("Edit", { path: "f.txt", old_string: "x = 1", new_string: "x = 9" });
    assert.equal(many.ok, false);
    assert.match(many.content, /matches 3 places in the file \(lines 1, 3, 5\)/);
    assert.match(many.content, /replace_all/);
    const all = await s.call("Edit", { path: "f.txt", old_string: "x = 1", new_string: "x = 9", replace_all: true });
    assert.equal(all.ok, true);
    assert.equal(s.read("f.txt"), "x = 9\ny = 2\nx = 9\nz\nx = 9\n");
    assert.match(all.content, /replaced 3 occurrences/);
  } finally { s.cleanup(); }
});

test("Edit errors explain what is different", async () => {
  const s = setup({ "f.js": "function go() {\n\tif (ready) {\n\t\treturn 'it’s done';\n\t}\n}\n" });
  try {
    await s.call("Read", { path: "f.js" });
    const spaces = await s.call("Edit", { path: "f.js", old_string: "  if (ready) {", new_string: "  if (!ready) {" });
    assert.match(spaces.content, /not found/);
    assert.match(spaces.content, /whitespace, indentation or quote characters/);
    assert.match(spaces.content, /line 2/);
    const quotes = await s.call("Edit", { path: "f.js", old_string: "return 'it's done';", new_string: "return 1;" });
    assert.match(quotes.content, /line 3/);
    const prefixed = await s.call("Edit", { path: "f.js", old_string: "     1\tfunction go() {", new_string: "function run() {" });
    assert.match(prefixed.content, /line-number prefixes/);
    const typo = await s.call("Edit", { path: "f.js", old_string: "function gone() {", new_string: "x" });
    assert.match(typo.content, /closest line in the file is line 1/);
    const nothing = await s.call("Edit", { path: "f.js", old_string: "zzzzzzzzzzzzzzzzzzzz unrelated text", new_string: "x" });
    assert.match(nothing.content, /Nothing similar was found/);
    const same = await s.call("Edit", { path: "f.js", old_string: "go", new_string: "go" });
    assert.equal(same.ok, false);
    assert.match(same.content, /identical/);
    assert.equal((await s.call("Edit", { path: "f.js", old_string: "", new_string: "x" })).ok, false);
  } finally { s.cleanup(); }
});

test("Edit keeps CRLF files CRLF, including multi-line replacements", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("w.txt"), "one\r\ntwo\r\nthree\r\n");
    await s.call("Read", { path: "w.txt" });
    const r = await s.call("Edit", { path: "w.txt", old_string: "one\ntwo", new_string: "uno\ndos\ntres" });
    assert.equal(r.ok, true, r.content);
    assert.equal(s.read("w.txt"), "uno\r\ndos\r\ntres\r\nthree\r\n");
    const again = await s.call("Edit", { path: "w.txt", old_string: "three\n", new_string: "" });
    assert.equal(again.ok, true);
    assert.equal(s.read("w.txt"), "uno\r\ndos\r\ntres\r\n");
  } finally { s.cleanup(); }
});

test("Edit leaves untouched lines of a mixed-ending file exactly as they were", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("m.txt"), "crlf line\r\nlf line\nanother crlf\r\nlast lf\n");
    await s.call("Read", { path: "m.txt" });
    const r1 = await s.call("Edit", { path: "m.txt", old_string: "last lf", new_string: "LAST" });
    assert.equal(r1.ok, true);
    assert.equal(s.read("m.txt"), "crlf line\r\nlf line\nanother crlf\r\nLAST\n");
    const r2 = await s.call("Edit", { path: "m.txt", old_string: "lf line\nanother", new_string: "LF\nanother" });
    assert.equal(r2.ok, true, r2.content);
    assert.equal(s.read("m.txt"), "crlf line\r\nLF\nanother crlf\r\nLAST\n");
  } finally { s.cleanup(); }
});

test("Edit keeps a BOM and UTF-16 encoding", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("b.txt"), Buffer.concat([BOM, Buffer.from("hello world\n")]));
    await s.call("Read", { path: "b.txt" });
    await s.call("Edit", { path: "b.txt", old_string: "world", new_string: "there" });
    assert.deepEqual([...s.readBuf("b.txt").subarray(0, 3)], [...BOM]);
    assert.equal(s.readBuf("b.txt").subarray(3).toString(), "hello there\n");
    fs.writeFileSync(s.abs("u.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo wörld\n", "utf16le")]));
    await s.call("Read", { path: "u.txt" });
    await s.call("Edit", { path: "u.txt", old_string: "wörld", new_string: "wörlds" });
    assert.equal(s.readBuf("u.txt").subarray(2).toString("utf16le"), "héllo wörlds\n");
  } finally { s.cleanup(); }
});

test("Edit treats replacement text literally ($&, $1, backslashes)", async () => {
  const s = setup({ "f.txt": "price: X\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    await s.call("Edit", { path: "f.txt", old_string: "X", new_string: "$& $1 \\n $$" });
    assert.equal(s.read("f.txt"), "price: $& $1 \\n $$\n");
  } finally { s.cleanup(); }
});

test("Edit works with Arabic text and names with spaces", async () => {
  const s = setup({ "مجلد/ملف تجريبي.md": "# عنوان\nنص قديم هنا\n" });
  try {
    await s.call("Read", { path: "مجلد/ملف تجريبي.md" });
    const r = await s.call("Edit", { path: "مجلد/ملف تجريبي.md", old_string: "نص قديم", new_string: "نص جديد" });
    assert.equal(r.ok, true);
    assert.equal(s.read("مجلد/ملف تجريبي.md"), "# عنوان\nنص جديد هنا\n");
  } finally { s.cleanup(); }
});

test("deleting whole lines does not leave blank lines", async () => {
  const s = setup({ "f.txt": "keep1\ndrop me\nkeep2\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    await s.call("Edit", { path: "f.txt", old_string: "drop me", new_string: "" });
    assert.equal(s.read("f.txt"), "keep1\nkeep2\n");
  } finally { s.cleanup(); }
});

test("Edit inside the lines that were read works on a partly read file, and ranges follow the edit", async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`);
  const s = setup({ "big.txt": lines.join("\n") + "\n" });
  try {
    await s.call("Read", { path: "big.txt", offset: 40, limit: 21 });
    const outside = await s.call("Edit", { path: "big.txt", old_string: "row 90", new_string: "ROW 90" });
    assert.equal(outside.ok, false);
    assert.match(outside.content, /line 90, which you have not read/);
    const inside = await s.call("Edit", { path: "big.txt", old_string: "row 50", new_string: "row 50\nextra a\nextra b" });
    assert.equal(inside.ok, true);
    const again = await s.call("Edit", { path: "big.txt", old_string: "extra b", new_string: "extra B" });
    assert.equal(again.ok, true, "the new lines count as seen");
    const stillOutside = await s.call("Edit", { path: "big.txt", old_string: "row 92", new_string: "x" });
    assert.equal(stillOutside.ok, false, "row 90 moved to line 92 and was never read");
    const write = await s.call("Write", { path: "big.txt", content: "x" });
    assert.match(write.content, /only read part/i);
  } finally { s.cleanup(); }
});

test("Edit refuses binary and non-UTF-8 files", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("a.bin"), Buffer.from([0, 1, 2, 3, 0, 0, 5]));
    assert.match((await s.call("Edit", { path: "a.bin", old_string: "a", new_string: "b" })).content, /binary/);
    fs.writeFileSync(s.abs("l.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await s.call("Read", { path: "l.txt" });
    assert.match((await s.call("Edit", { path: "l.txt", old_string: "caf", new_string: "tea" })).content, /not valid UTF-8/);
    assert.deepEqual([...s.readBuf("l.txt")], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
  } finally { s.cleanup(); }
});

test("Edit permission: previews the diff, asks inside the project with Edit:*, and does not bother when it will fail", async () => {
  const s = setup({ "f.txt": "a\nb\n" });
  try {
    const edit = s.toolbox.byName.get("Edit");
    const doomed = edit.permission({ path: "f.txt", old_string: "a", new_string: "x" }, s.ctx);
    assert.equal(doomed.decision, "allow", "not read yet, run() will say so");
    await s.call("Read", { path: "f.txt" });
    const v = edit.permission({ path: "f.txt", old_string: "a", new_string: "x" }, s.ctx);
    assert.equal(v.decision, "ask");
    assert.equal(v.sessionKey, "Edit:*");
    assert.equal(v.diff.oldText, "a\nb\n");
    assert.equal(v.diff.newText, "x\nb\n");
    assert.equal(edit.permission({ path: "f.txt", old_string: "nope", new_string: "x" }, s.ctx).decision, "allow");
    assert.equal(s.read("f.txt"), "a\nb\n", "permission() never writes");
  } finally { s.cleanup(); }
});

test("a big file's diff is windowed around the change", async () => {
  const s = setup({ "big.txt": Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n" });
  try {
    await s.call("Read", { path: "big.txt", limit: 2000 });
    await s.call("Read", { path: "big.txt", offset: 2001, limit: 2000 });
    await s.call("Read", { path: "big.txt", offset: 4001 });
    const r = await s.call("Edit", { path: "big.txt", old_string: "line 3000", new_string: "line 3000 changed" });
    assert.equal(r.ok, true);
    const diff = r.display.diff;
    assert.ok(diff.oldText.split("\n").length < 40);
    assert.ok(diff.startLine > 2900 && diff.startLine < 3000);
    assert.ok(diff.newText.includes("line 3000 changed"));
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------- MultiEdit

test("MultiEdit applies edits in order, each seeing the previous result", async () => {
  const s = setup({ "f.js": "let a = 1;\nlet b = 2;\nlet c = 3;\n" });
  try {
    await s.call("Read", { path: "f.js" });
    const r = await s.call("MultiEdit", { path: "f.js", edits: [
      { old_string: "let a = 1;", new_string: "const a = 1;" },
      { old_string: "const a = 1;\nlet b = 2;", new_string: "const a = 1;\nconst b = 2;" },
      { old_string: "let c", new_string: "const c" },
    ] });
    assert.equal(r.ok, true, r.content);
    assert.equal(s.read("f.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    assert.match(r.content, /Applied 3 edits/);
    assert.equal(r.display.diff.oldText, "let a = 1;\nlet b = 2;\nlet c = 3;\n");
  } finally { s.cleanup(); }
});

test("MultiEdit is all-or-nothing: one failing edit leaves the file byte-for-byte unchanged", async () => {
  const original = "first\r\nsecond\r\nthird\r\n";
  const s = setup();
  try {
    fs.writeFileSync(s.abs("f.txt"), original);
    await s.call("Read", { path: "f.txt" });
    const before = s.readBuf("f.txt");
    const mtime = fs.statSync(s.abs("f.txt")).mtimeMs;
    const r = await s.call("MultiEdit", { path: "f.txt", edits: [
      { old_string: "first", new_string: "1st" },
      { old_string: "does not exist", new_string: "x" },
      { old_string: "third", new_string: "3rd" },
    ] });
    assert.equal(r.ok, false);
    assert.match(r.content, /Edit 2 of 3 failed, so NOTHING was changed/);
    assert.deepEqual(s.readBuf("f.txt"), before);
    assert.equal(fs.statSync(s.abs("f.txt")).mtimeMs, mtime);
    assert.deepEqual(fs.readdirSync(s.dir).filter(n => n.endsWith(".tmp")), [], "no temp files left");
    const ok = await s.call("MultiEdit", { path: "f.txt", edits: [{ old_string: "first", new_string: "1st" }, { old_string: "third", new_string: "3rd" }] });
    assert.equal(ok.ok, true);
    assert.equal(s.read("f.txt"), "1st\r\nsecond\r\n3rd\r\n");
  } finally { s.cleanup(); }
});

test("MultiEdit needs a full read and valid input", async () => {
  const s = setup({ "f.txt": "1\n2\n3\n4\n" });
  try {
    const unread = await s.call("MultiEdit", { path: "f.txt", edits: [{ old_string: "1", new_string: "a" }] });
    assert.match(unread.content, /not read this file/);
    await s.call("Read", { path: "f.txt", limit: 2 });
    assert.match((await s.call("MultiEdit", { path: "f.txt", edits: [{ old_string: "1", new_string: "a" }] })).content, /only read part/i);
    await s.call("Read", { path: "f.txt" });
    assert.match((await s.call("MultiEdit", { path: "f.txt", edits: [] })).content, /non-empty array/);
    assert.match((await s.call("MultiEdit", { path: "f.txt", edits: [{ old_string: "1" }] })).content, /needs string fields/);
    assert.match((await s.call("MultiEdit", { path: "f.txt", edits: [{ old_string: "1", new_string: "1" }] })).content, /identical/);
    assert.match((await s.call("MultiEdit", { path: "f.txt", edits: Array.from({ length: 51 }, () => ({ old_string: "a", new_string: "b" })) })).content, /Too many edits/);
  } finally { s.cleanup(); }
});

test("MultiEdit supports replace_all and uniqueness errors per edit", async () => {
  const s = setup({ "f.txt": "a a a\nb\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    const dup = await s.call("MultiEdit", { path: "f.txt", edits: [{ old_string: "a", new_string: "z" }] });
    assert.match(dup.content, /matches 3 places/);
    const r = await s.call("MultiEdit", { path: "f.txt", edits: [{ old_string: "a", new_string: "z", replace_all: true }, { old_string: "b", new_string: "y" }] });
    assert.equal(r.ok, true);
    assert.equal(s.read("f.txt"), "z z z\ny\n");
    assert.match(r.content, /4 replacements in total/);
  } finally { s.cleanup(); }
});

test("MultiEdit permission previews the combined result", async () => {
  const s = setup({ "f.txt": "a\nb\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    const v = s.toolbox.byName.get("MultiEdit").permission({ path: "f.txt", edits: [{ old_string: "a", new_string: "x" }, { old_string: "b", new_string: "y" }] }, s.ctx);
    assert.equal(v.decision, "ask");
    assert.equal(v.diff.newText, "x\ny\n");
    assert.match(v.title, /Make 2 edits in f\.txt/);
  } finally { s.cleanup(); }
});

test("writes go through a temp file and leave nothing behind", async () => {
  const s = setup({ "f.txt": "x\n" });
  try {
    await s.call("Read", { path: "f.txt" });
    await s.call("Edit", { path: "f.txt", old_string: "x", new_string: "y" });
    assert.deepEqual(fs.readdirSync(s.dir), ["f.txt"]);
  } finally { s.cleanup(); }
});
