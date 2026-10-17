import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic, encodeText, decodeText, detectEol, withEol, countLines, sniffFile, similarNames, dice, mergeRanges, fsErrorMessage } from "../../src/tools/textfile.js";
import { tmpProject, setup } from "./helpers.js";

function patchRename(impl) {
  const original = fs.renameSync;
  fs.renameSync = impl(original);
  return () => { fs.renameSync = original; };
}

test("atomic write: writes through a temp file and replaces the target", async () => {
  const p = tmpProject({ "f.txt": "old" });
  try {
    const res = await writeFileAtomic(p.abs("f.txt"), Buffer.from("new"));
    assert.deepEqual(res, { atomic: true });
    assert.equal(p.read("f.txt"), "new");
    assert.deepEqual(fs.readdirSync(p.dir), ["f.txt"]);
  } finally { p.cleanup(); }
});

test("atomic write: a Windows-style 'busy' error on rename is retried", async () => {
  const p = tmpProject({ "f.txt": "old" });
  let failures = 0;
  const restore = patchRename(real => (from, to) => {
    if (failures < 2) { failures++; throw Object.assign(new Error("locked"), { code: "EBUSY" }); }
    return real(from, to);
  });
  try {
    const res = await writeFileAtomic(p.abs("f.txt"), Buffer.from("retried"));
    assert.equal(res.atomic, true);
    assert.equal(failures, 2);
    assert.equal(p.read("f.txt"), "retried");
  } finally { restore(); p.cleanup(); }
});

test("atomic write: if rename never works the content is written directly and no temp file stays", async () => {
  const p = tmpProject({ "f.txt": "old" });
  const restore = patchRename(() => () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  try {
    const res = await writeFileAtomic(p.abs("f.txt"), Buffer.from("direct"));
    assert.equal(res.atomic, false);
    assert.equal(p.read("f.txt"), "direct");
    assert.deepEqual(fs.readdirSync(p.dir), ["f.txt"]);
  } finally { restore(); p.cleanup(); }
});

test("atomic write: other rename errors surface and clean up", async () => {
  const p = tmpProject({ "f.txt": "old" });
  const restore = patchRename(() => () => { throw Object.assign(new Error("disk"), { code: "ENOSPC" }); });
  try {
    await assert.rejects(writeFileAtomic(p.abs("f.txt"), Buffer.from("x")), /disk/);
    assert.equal(p.read("f.txt"), "old");
    assert.deepEqual(fs.readdirSync(p.dir), ["f.txt"]);
  } finally { restore(); p.cleanup(); }
});

test("a read-only file gives a clear message instead of a crash", { skip: process.platform !== "win32" }, async () => {
  const s = setup({ "ro.txt": "locked\n" });
  try {
    await s.call("Read", { path: "ro.txt" });
    fs.chmodSync(s.abs("ro.txt"), 0o444);
    const r = await s.call("Edit", { path: "ro.txt", old_string: "locked", new_string: "free" });
    assert.equal(r.ok, false);
    assert.match(r.content, /Could not write ro\.txt: Permission denied/);
    assert.equal(s.read("ro.txt"), "locked\n");
    assert.deepEqual(fs.readdirSync(s.dir).filter(n => n.endsWith(".tmp")), []);
    fs.chmodSync(s.abs("ro.txt"), 0o666);
  } finally { s.cleanup(); }
});

test("encoding helpers round-trip", () => {
  for (const [text, opts] of [["héllo\nمرحبا\n", { encoding: "utf8", bom: false }], ["x", { encoding: "utf8", bom: true }], ["مرحبا", { encoding: "utf16le", bom: true }], ["مرحبا", { encoding: "utf16be", bom: true }], ["plain ascii", { encoding: "utf16le", bom: false }]]) {
    const decoded = decodeText(encodeText(text, opts));
    assert.equal(decoded.text, text, JSON.stringify(opts));
    assert.equal(decoded.encoding, opts.encoding);
    assert.equal(decoded.bom, opts.bom);
  }
});

test("line ending helpers", () => {
  assert.equal(detectEol("a\r\nb\r\n"), "\r\n");
  assert.equal(detectEol("a\nb\n"), "\n");
  assert.equal(detectEol("a\r\nb\nc\n"), "\n");
  assert.equal(detectEol("a\r\nb\r\nc\n"), "\r\n");
  assert.equal(detectEol("no newline"), "\n");
  assert.equal(withEol("a\nb\r\nc", "\r\n"), "a\r\nb\r\nc");
  assert.equal(withEol("a\r\nb", "\n"), "a\nb");
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("\n\n"), 2);
});

test("file sniffing", () => {
  assert.equal(sniffFile(Buffer.from("plain text")).kind, "text");
  assert.equal(sniffFile(Buffer.alloc(0)).kind, "text");
  assert.equal(sniffFile(Buffer.from("مرحبا")).kind, "text");
  assert.equal(sniffFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])).kind, "image");
  assert.equal(sniffFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])).kind, "image");
  assert.equal(sniffFile(Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1")).kind, "image");
  assert.equal(sniffFile(Buffer.from("%PDF-1.4")).kind, "pdf");
  assert.equal(sniffFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])).kind, "binary");
  assert.equal(sniffFile(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])).kind, "binary");
  assert.equal(sniffFile(Buffer.from([1, 2, 3, 0, 4, 5])).kind, "binary");
  assert.equal(sniffFile(Buffer.from("hi there", "utf16le")).kind, "text", "UTF-16 without a BOM is text");
  assert.equal(sniffFile(Buffer.from([0xff, 0xfe, 0, 0, 1, 0, 0, 0])).kind, "binary", "UTF-32 is not supported");
});

test("helpers: similar names, dice, ranges, error messages", () => {
  const p = tmpProject({ "Readme.md": "x", "readme-old.txt": "x", "other.js": "x" });
  try {
    const found = similarNames(p.abs("README.MD")).map(f => path.basename(f));
    assert.ok(found.includes("Readme.md"));
    assert.ok(!found.includes("other.js"));
    assert.deepEqual(similarNames(path.join(p.dir, "no-dir", "x.txt")), []);
  } finally { p.cleanup(); }
  assert.equal(dice("night", "nacht") > 0.2, true);
  assert.equal(dice("same", "same"), 1);
  assert.equal(dice("a", "b"), 0);
  assert.deepEqual(mergeRanges([[5, 6], [1, 2], [3, 4], [10, 12], [11, 11]]), [[1, 6], [10, 12]]);
  assert.match(fsErrorMessage({ code: "EBUSY" }, "x.txt"), /locked by another program/);
  assert.match(fsErrorMessage({ code: "ENOSPC" }, "x"), /disk is full/);
  assert.match(fsErrorMessage({ code: "EWEIRD", message: "odd" }, "x"), /EWEIRD: odd/);
});
