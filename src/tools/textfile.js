// Shared file helpers for the file tools: what kind of file this is, decoding / encoding that survives a
// round trip (BOM, UTF-16, CRLF), the read-state bookkeeping that protects against stale writes, and an
// atomic writer that copes with Windows locking.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateKey } from "./pathguard.js";

export const MAX_TEXT_BYTES = 12 * 1024 * 1024; // beyond this we neither edit nor read whole

export function sha1(buf) { return crypto.createHash("sha1").update(buf).digest("hex"); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startsWith(buf, bytes, at = 0) {
  if (buf.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
}
const ascii = (buf, from, to) => buf.toString("latin1", from, to);

function pngSize(buf) { return buf.length >= 24 ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null; }
function gifSize(buf) { return buf.length >= 10 ? { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) } : null; }
function bmpSize(buf) { return buf.length >= 26 ? { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) } : null; }
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const size = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + size;
  }
  return null;
}
function webpSize(buf) {
  if (buf.length < 30) return null;
  const kind = ascii(buf, 12, 16);
  if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") { const bits = buf.readUInt32LE(21); return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 }; }
  return null;
}

const SIGNATURES = [
  { label: "PNG image", image: true, test: b => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), size: pngSize },
  { label: "JPEG image", image: true, test: b => startsWith(b, [0xff, 0xd8, 0xff]), size: jpegSize },
  { label: "GIF image", image: true, test: b => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a", size: gifSize },
  { label: "WebP image", image: true, test: b => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP", size: webpSize },
  { label: "BMP image", image: true, test: b => startsWith(b, [0x42, 0x4d]) && b.length > 14 && b.readUInt32LE(6) === 0, size: bmpSize },
  { label: "ICO icon", image: true, test: b => startsWith(b, [0, 0, 1, 0]) && b.length > 6 && b[4] > 0 && b[4] < 64 },
  { label: "TIFF image", image: true, test: b => startsWith(b, [0x49, 0x49, 0x2a, 0]) || startsWith(b, [0x4d, 0x4d, 0, 0x2a]) },
  { label: "PDF document", pdf: true, test: b => ascii(b, 0, 5) === "%PDF-" },
  { label: "ZIP archive (also .docx, .xlsx, .jar, .apk)", test: b => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) },
  { label: "gzip archive", test: b => startsWith(b, [0x1f, 0x8b]) },
  { label: "7-Zip archive", test: b => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { label: "RAR archive", test: b => ascii(b, 0, 4) === "Rar!" },
  { label: "Windows executable", test: b => startsWith(b, [0x4d, 0x5a]) && b.length > 64 },
  { label: "ELF executable", test: b => startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) },
  { label: "WebAssembly module", test: b => startsWith(b, [0, 0x61, 0x73, 0x6d]) },
  { label: "SQLite database", test: b => ascii(b, 0, 15) === "SQLite format 3" },
  { label: "audio file", test: b => ascii(b, 0, 3) === "ID3" || ascii(b, 0, 4) === "OggS" || ascii(b, 0, 4) === "fLaC" || (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") },
  { label: "video file", test: b => ascii(b, 4, 8) === "ftyp" || startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]) },
  { label: "font file", test: b => ascii(b, 0, 4) === "wOFF" || ascii(b, 0, 4) === "wOF2" || startsWith(b, [0, 1, 0, 0]) || ascii(b, 0, 4) === "OTTO" },
];

/** Cheap classification from the first bytes: text, image, pdf or other binary. */
export function sniffFile(buf) {
  if (buf.length === 0) return { kind: "text" };
  for (const sig of SIGNATURES) {
    if (!sig.test(buf)) continue;
    let size = null;
    try { size = sig.size ? sig.size(buf) : null; } catch { size = null; }
    return { kind: sig.image ? "image" : sig.pdf ? "pdf" : "binary", label: sig.label, size };
  }
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (startsWith(head, [0xff, 0xfe, 0, 0]) || startsWith(head, [0, 0, 0xfe, 0xff])) return { kind: "binary", label: "UTF-32 text (not supported)" };
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return { kind: "text" };
  let nul = 0, evenNul = 0, oddNul = 0, control = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b === 0) { nul++; if (i % 2 === 0) evenNul++; else oddNul++; }
    else if (b < 9 || (b > 13 && b < 32 && b !== 27)) control++;
  }
  if (nul > 0) {
    const pairs = Math.floor(head.length / 2);
    const utf16 = pairs >= 8 && ((oddNul > pairs * 0.3 && evenNul < pairs * 0.05) || (evenNul > pairs * 0.3 && oddNul < pairs * 0.05));
    return utf16 ? { kind: "text" } : { kind: "binary", label: "binary data" };
  }
  if (control > head.length * 0.3) return { kind: "binary", label: "binary data" };
  return { kind: "text" };
}

/**
 * Decodes a text buffer. { text, encoding: "utf8"|"utf16le"|"utf16be", bom, invalid } where `invalid` means
 * the bytes were not valid UTF-8 (the text then holds replacement characters and must not be written back).
 */
export function decodeText(buf) {
  if (startsWith(buf, [0xff, 0xfe])) return { text: buf.toString("utf16le", 2), encoding: "utf16le", bom: true, invalid: false };
  if (startsWith(buf, [0xfe, 0xff])) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return { text: body.swap16().toString("utf16le"), encoding: "utf16be", bom: true, invalid: false };
  }
  const bom = startsWith(buf, [0xef, 0xbb, 0xbf]);
  const body = bom ? buf.subarray(3) : buf;
  const head = body.subarray(0, Math.min(body.length, 4096));
  let evenNul = 0, oddNul = 0;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) { if (i % 2 === 0) evenNul++; else oddNul++; }
  const pairs = Math.floor(head.length / 2);
  if (pairs >= 8 && oddNul > pairs * 0.3 && evenNul < pairs * 0.05) return { text: body.toString("utf16le"), encoding: "utf16le", bom: false, invalid: false };
  if (pairs >= 8 && evenNul > pairs * 0.3 && oddNul < pairs * 0.05) {
    const swapped = Buffer.from(body.subarray(0, body.length & ~1)).swap16();
    return { text: swapped.toString("utf16le"), encoding: "utf16be", bom: false, invalid: false };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    return { text, encoding: "utf8", bom, invalid: false };
  } catch {
    return { text: body.toString("utf8"), encoding: "utf8", bom, invalid: true };
  }
}

export function encodeText(text, { encoding = "utf8", bom = false } = {}) {
  if (encoding === "utf16le") return Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, "utf16le")]);
  if (encoding === "utf16be") return Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), Buffer.from(text, "utf16le").swap16()]);
  return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);
}

/** The dominant line ending of a text: CRLF when it has at least as many CRLF as bare LF. */
export function detectEol(text) {
  let crlf = 0, lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) { if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++; else lf++; }
  return crlf > 0 && crlf >= lf ? "\r\n" : "\n";
}

export const toLf = text => text.replace(/\r\n/g, "\n");
export const withEol = (text, eol) => (eol === "\r\n" ? toLf(text).replace(/\n/g, "\r\n") : toLf(text));

export function countLines(text) {
  if (text === "") return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** Shortens a thrown filesystem error into one sentence a model (and a person) can act on. */
export function fsErrorMessage(error, shown) {
  switch (error?.code) {
    case "ENOENT": return `Not found: ${shown}`;
    case "ENOTDIR": return `A part of the path is not a folder: ${shown}`;
    case "EISDIR": return `${shown} is a folder, not a file.`;
    case "EACCES": case "EPERM": return `Permission denied: ${shown} (read-only, or protected by the system).`;
    case "EBUSY": return `${shown} is locked by another program. Close it and try again.`;
    case "ENAMETOOLONG": return `The path is too long: ${shown}`;
    case "ELOOP": return `Too many symbolic links: ${shown}`;
    case "ENOSPC": return "The disk is full.";
    case "EMFILE": return "Too many files are open right now; try again.";
    default: return `${error?.code ? error.code + ": " : ""}${error?.message || "file system error"} (${shown})`;
  }
}

/** Writes through a temp file in the same folder and renames; falls back to a direct write when the OS refuses to rename. */
export async function writeFileAtomic(target, data, { mode } = {}) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const cleanup = () => { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ } };
  try {
    fs.writeFileSync(tmp, data, { mode: mode ?? 0o666 });
    if (mode !== undefined && process.platform !== "win32") { try { fs.chmodSync(tmp, mode); } catch { /* keep default mode */ } }
  } catch (error) { cleanup(); throw error; }
  let last = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { fs.renameSync(tmp, target); return { atomic: true }; }
    catch (error) {
      last = error;
      if (!["EPERM", "EBUSY", "EACCES", "EEXIST"].includes(error.code)) { cleanup(); throw error; }
      await sleep(25 * (attempt + 1));
    }
  }
  try {
    fs.writeFileSync(target, data);
    return { atomic: false };
  } catch (error) {
    throw error?.code ? error : last;
  } finally { cleanup(); }
}

/** Remembers what the model has seen of a file. `ranges` are 1-based inclusive line spans it was shown. */
export function recordRead(fileState, abs, { stat, buf, totalLines, ranges, lossy = false, platform = process.platform }) {
  const key = stateKey(abs, platform);
  const prev = fileState.get(key);
  const sameFile = prev && prev.hash === sha1(buf);
  const merged = mergeRanges([...(sameFile ? prev.ranges || [] : []), ...ranges]);
  const covers = merged.length === 1 && merged[0][0] <= 1 && merged[0][1] >= totalLines;
  const covered = totalLines === 0 || covers;
  const partial = Boolean(!covered || lossy || (sameFile && prev.lossy === true));
  fileState.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, hash: sha1(buf), partial, ranges: merged, lines: totalLines, lossy: lossy || (sameFile && prev.lossy === true) });
}

/** Stores a read-state entry verbatim (used after an edit inside a partly read file). */
export function recordState(fileState, abs, { stat, buf, partial, ranges, lines, lossy = false, platform = process.platform }) {
  fileState.set(stateKey(abs, platform), { mtimeMs: stat.mtimeMs, size: stat.size, hash: sha1(buf), partial, ranges: mergeRanges(ranges), lines, lossy });
}

/** State for a file we just wrote: the whole content is known. */
export function recordWrite(fileState, abs, { stat, buf, totalLines, platform = process.platform }) {
  fileState.set(stateKey(abs, platform), { mtimeMs: stat.mtimeMs, size: stat.size, hash: sha1(buf), partial: false, ranges: totalLines ? [[1, totalLines]] : [], lines: totalLines, lossy: false });
}

export function mergeRanges(ranges) {
  const sorted = ranges.filter(r => r && r[0] <= r[1]).map(r => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

export function rangesCover(ranges, from, to) {
  return (ranges || []).some(r => r[0] <= from && r[1] >= to);
}

/** Why an existing file may not be modified right now, or null when it may. */
export function staleProblem(fileState, abs, buf, platform = process.platform) {
  const known = fileState.get(stateKey(abs, platform));
  if (!known) return { code: "notRead", message: "You have not read this file in this session. Read it first (Read tool), then try again." };
  if (known.hash !== sha1(buf)) return { code: "stale", message: "The file changed on disk after you read it (you, the user or another program modified it). Read it again before changing it." };
  return null;
}

/** Up to three entries in the same folder whose names resemble `abs`'s name (case or small typo). */
export function similarNames(abs) {
  try {
    const dir = path.dirname(abs);
    const wanted = path.basename(abs).toLowerCase();
    const stem = wanted.replace(/\.[^.]*$/, "");
    const names = fs.readdirSync(dir);
    const scored = [];
    for (const name of names) {
      const low = name.toLowerCase();
      let score = 0;
      if (low === wanted) score = 3;
      else if (low.replace(/\.[^.]*$/, "") === stem) score = 2;
      else if (stem.length >= 3 && (low.startsWith(stem) || stem.startsWith(low.replace(/\.[^.]*$/, "")))) score = 1;
      else if (dice(low, wanted) >= 0.7) score = 1;
      if (score) scored.push([score, name]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, 3).map(s => path.join(dir, s[1]));
  } catch { return []; }
}

/** Sorensen-Dice similarity of two strings over character pairs (0..1). */
export function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) || 0) + 1); }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) { hits++; grams.set(g, n - 1); }
  }
  return (2 * hits) / (a.length + b.length - 2);
}
