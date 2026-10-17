import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setup } from "./helpers.js";
import { stateKey } from "../../src/tools/pathguard.js";

const stateOf = (s, rel) => s.ctx.fileState.get(stateKey(s.abs(rel), process.platform));

test("Read numbers lines like cat -n and records what it saw", async () => {
  const s = setup({ "src/a.js": "alpha\nbeta\ngamma\n" });
  try {
    const r = await s.call("Read", { path: "src/a.js" });
    assert.equal(r.ok, true);
    assert.equal(r.content, "     1\talpha\n     2\tbeta\n     3\tgamma");
    assert.equal(r.display.summary, "3 lines");
    const st = stateOf(s, "src/a.js");
    assert.equal(st.partial, false);
    assert.equal(st.size, 17);
    assert.equal(typeof st.mtimeMs, "number");
    assert.equal(typeof st.hash, "string");
  } finally { s.cleanup(); }
});

test("offset and limit select lines; a partial read is marked partial", async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const s = setup({ "f.txt": lines });
  try {
    const r = await s.call("Read", { path: "f.txt", offset: 10, limit: 5 });
    assert.ok(r.content.startsWith("    10\tline 10\n    11\tline 11"));
    assert.ok(r.content.includes("    14\tline 14"));
    assert.ok(!r.content.includes("line 15\n"));
    assert.match(r.content, /Showing lines 10-14 of 50\. Call Read again with offset=15/);
    assert.equal(stateOf(s, "f.txt").partial, true);
    await s.call("Read", { path: "f.txt", offset: 1, limit: 9 });
    assert.equal(stateOf(s, "f.txt").partial, true, "still gaps");
    await s.call("Read", { path: "f.txt", offset: 15, limit: 100 });
    assert.equal(stateOf(s, "f.txt").partial, false, "the pieces now cover the whole file");
    const past = await s.call("Read", { path: "f.txt", offset: 500 });
    assert.equal(past.ok, false);
    assert.match(past.content, /past the end.*50 lines/);
  } finally { s.cleanup(); }
});

test("long files stop at 2000 lines with a continuation hint", async () => {
  const s = setup({ "big.txt": Array.from({ length: 2500 }, (_, i) => `n${i + 1}`).join("\n") });
  try {
    const first = await s.call("Read", { path: "big.txt" });
    assert.match(first.content, /Showing lines 1-2000 of 2500\. Call Read again with offset=2001/);
    assert.ok(first.content.includes("  2000\tn2000"));
    const second = await s.call("Read", { path: "big.txt", offset: 2001 });
    assert.ok(second.content.includes("  2500\tn2500"));
    assert.ok(!second.content.includes("Showing lines"));
    assert.equal(stateOf(s, "big.txt").partial, false);
  } finally { s.cleanup(); }
});

test("the 256 KB cap stops a read of very long lines", async () => {
  const line = "x".repeat(1500);
  const s = setup({ "wide.txt": Array.from({ length: 400 }, () => line).join("\n") });
  try {
    const r = await s.call("Read", { path: "wide.txt" });
    assert.ok(Buffer.byteLength(r.content) < 270 * 1024);
    assert.match(r.content, /stopped at the 256 KB limit/);
    assert.match(r.content, /offset=\d+ to continue/);
  } finally { s.cleanup(); }
});

test("lines over 2000 characters are cut with a marker, and the read is lossy", async () => {
  const s = setup({ "long.txt": `short\n${"y".repeat(5000)}\nend\n` });
  try {
    const r = await s.call("Read", { path: "long.txt" });
    assert.match(r.content, /line cut: 5000 characters in total/);
    assert.ok(r.content.length < 3000);
    assert.equal(stateOf(s, "long.txt").partial, true, "a cut line was not fully seen");
  } finally { s.cleanup(); }
});

test("empty files are reported", async () => {
  const s = setup({ "empty.txt": "" });
  try {
    const r = await s.call("Read", { path: "empty.txt" });
    assert.equal(r.ok, true);
    assert.match(r.content, /exists but is empty/);
    assert.equal(stateOf(s, "empty.txt").partial, false);
  } finally { s.cleanup(); }
});

test("CRLF lines are clean and a UTF-8 BOM is not shown", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("w.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\n")]));
    const r = await s.call("Read", { path: "w.txt" });
    assert.equal(r.content, "     1\tone\n     2\ttwo");
  } finally { s.cleanup(); }
});

test("UTF-16 files are decoded (with and without a BOM) and say so", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("le.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo\nwörld\n", "utf16le")]));
    const le = await s.call("Read", { path: "le.txt" });
    assert.ok(le.content.includes("     1\théllo"));
    assert.match(le.content, /UTF-16 little-endian/);
    fs.writeFileSync(s.abs("nobom.txt"), Buffer.from("plain text here\nsecond\n", "utf16le"));
    const nb = await s.call("Read", { path: "nobom.txt" });
    assert.ok(nb.content.includes("plain text here"));
    const be = Buffer.from("be text\n", "utf16le").swap16();
    fs.writeFileSync(s.abs("be.txt"), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    assert.ok((await s.call("Read", { path: "be.txt" })).content.includes("be text"));
  } finally { s.cleanup(); }
});

test("Arabic content, Arabic names and spaces in paths", async () => {
  const s = setup({ "مجلد عربي/ملف 1.txt": "مرحبا بالعالم\nهذا سطر ثان\n" });
  try {
    const r = await s.call("Read", { path: "مجلد عربي/ملف 1.txt" });
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("     1\tمرحبا بالعالم"));
    const quoted = await s.call("Read", { path: '"مجلد عربي/ملف 1.txt"' });
    assert.equal(quoted.ok, true);
    assert.equal(s.toolbox.byName.get("Read").summarize({ path: "مجلد عربي/ملف 1.txt" }, s.ctx), "مجلد عربي/ملف 1.txt");
  } finally { s.cleanup(); }
});

test("Windows-style separators work", { skip: process.platform !== "win32" }, async () => {
  const s = setup({ "a/b/c.txt": "deep\n" });
  try {
    const r = await s.call("Read", { path: "a\\b\\c.txt" });
    assert.equal(r.ok, true);
    assert.ok(r.content.includes("deep"));
  } finally { s.cleanup(); }
});

test("binary files, images and PDFs are described instead of dumped", async () => {
  const s = setup();
  try {
    const png = Buffer.alloc(64);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "latin1"); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
    fs.writeFileSync(s.abs("pic.png"), png);
    const img = await s.call("Read", { path: "pic.png" });
    assert.equal(img.ok, true);
    assert.match(img.content, /an image \(PNG image, 800x600 pixels/);
    fs.writeFileSync(s.abs("doc.pdf"), Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n"));
    assert.match((await s.call("Read", { path: "doc.pdf" })).content, /PDF document/);
    fs.writeFileSync(s.abs("data.bin"), Buffer.from([1, 2, 0, 0, 3, 4, 0, 255, 254, 0]));
    const bin = await s.call("Read", { path: "data.bin" });
    assert.match(bin.content, /binary file/);
    assert.ok(!bin.content.includes("\u0000"));
    assert.equal(stateOf(s, "data.bin"), undefined);
  } finally { s.cleanup(); }
});

test("invalid UTF-8 is flagged", async () => {
  const s = setup();
  try {
    fs.writeFileSync(s.abs("latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const r = await s.call("Read", { path: "latin.txt" });
    assert.match(r.content, /not valid UTF-8/);
  } finally { s.cleanup(); }
});

test("folders, missing files and bad paths fail with a useful message", async () => {
  const s = setup({ "src/index.js": "x", "docs/Readme.MD": "y" });
  try {
    const dir = await s.call("Read", { path: "src" });
    assert.equal(dir.ok, false);
    assert.match(dir.content, /folder.*Use LS/);
    const missing = await s.call("Read", { path: "src/index.jss" });
    assert.equal(missing.ok, false);
    assert.match(missing.content, /not found.*src\/index\.js/i);
    const typo = await s.call("Read", { path: "docs/readme.txt" });
    assert.match(typo.content, /Did you mean: docs\/Readme\.MD/);
    assert.match((await s.call("Read", { path: "a\0b" })).content, /NUL/);
    assert.equal((await s.call("Read", {})).ok, false);
    assert.equal(missing.display.summary.startsWith("Not found"), true);
  } finally { s.cleanup(); }
});

test("a huge text file is read in ranges without loading it all", async () => {
  const s = setup();
  try {
    const row = "0123456789".repeat(10) + "\n";
    const fd = fs.openSync(s.abs("huge.log"), "w");
    for (let i = 0; i < 140_000; i++) fs.writeSync(fd, `${i + 1} ${row}`);
    fs.closeSync(fd);
    assert.ok(fs.statSync(s.abs("huge.log")).size > 12 * 1024 * 1024);
    const r = await s.call("Read", { path: "huge.log", offset: 100_000, limit: 3 });
    assert.ok(r.content.includes("100000\t100000 0123456789"));
    assert.ok(r.content.includes("100002\t100002 "));
    assert.match(r.content, /Large file/);
    assert.equal(stateOf(s, "huge.log"), undefined, "too big to edit, so no state is kept");
  } finally { s.cleanup(); }
});

test("permissions: inside is silent, outside asks, secrets ask with high risk", async () => {
  const s = setup({ "ok.txt": "x", ".env": "A=1", "pk/id_rsa": "k" });
  try {
    const read = s.toolbox.byName.get("Read");
    assert.equal(read.permission({ path: "ok.txt" }, s.ctx).decision, "allow");
    const outside = read.permission({ path: path.join(path.dirname(s.dir), "elsewhere.txt") }, s.ctx);
    assert.equal(outside.decision, "ask");
    assert.equal(outside.risk, "low");
    assert.match(outside.sessionKey, /^Read:dir:/);
    const env = read.permission({ path: ".env" }, s.ctx);
    assert.equal(env.decision, "ask");
    assert.equal(env.risk, "high");
    assert.equal(env.sessionKey, undefined, "secrets are never remembered");
    assert.equal(read.permission({ path: "pk/id_rsa" }, s.ctx).risk, "high");
    assert.equal(read.permission({ path: "bad\0path" }, s.ctx).decision, "deny");
    assert.equal(read.readOnly, true);
    assert.equal(read.concurrencySafe, true);
  } finally { s.cleanup(); }
});
