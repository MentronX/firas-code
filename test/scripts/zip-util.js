// Minimal ZIP writer for the installer tests (the real installers must read what GitHub produces, so tests build similar archives).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * entries: [{ name, data? }]; a name ending in "/" is a folder. `store` keeps data uncompressed (used for big binaries).
 * Writes straight to `file` so large inputs do not need a second copy in memory.
 */
export function writeZip(file, entries, { store = false } = {}) {
  const fd = fs.openSync(file, "w");
  let offset = 0;
  const central = [];
  const write = buf => { fs.writeSync(fd, buf); offset += buf.length; };
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      const isDir = entry.name.endsWith("/");
      const raw = isDir ? Buffer.alloc(0) : entry.data ?? Buffer.alloc(0);
      const method = isDir || store || raw.length < 64 ? 0 : 8;
      const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
      const crc = crc32(raw);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      central.push({ name, crc, method, size: body.length, rawSize: raw.length, offset, isDir });
      write(local);
      write(name);
      write(body);
    }
    const start = offset;
    for (const c of central) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(c.method, 10);
      head.writeUInt16LE(0, 12);
      head.writeUInt16LE(0x21, 14);
      head.writeUInt32LE(c.crc, 16);
      head.writeUInt32LE(c.size, 20);
      head.writeUInt32LE(c.rawSize, 24);
      head.writeUInt16LE(c.name.length, 28);
      head.writeUInt32LE(c.isDir ? 0x10 : 0, 38);
      head.writeUInt32LE(c.offset, 42);
      write(head);
      write(c.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
}

/** Writes a gzip-compressed ustar archive. entries: [{ name, data?, mode? }]; names ending in "/" are folders. */
export function writeTarGz(file, entries) {
  const blocks = [];
  const octal = (value, width) => Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "latin1");
  for (const entry of entries) {
    const isDir = entry.name.endsWith("/");
    const data = isDir ? Buffer.alloc(0) : entry.data ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    octal(entry.mode ?? (isDir ? 0o755 : 0o644), 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(data.length, 12).copy(header, 124);
    octal(1700000000, 12).copy(header, 136);
    header.fill(0x20, 148, 156);
    header.write(isDir ? "5" : "0", 156, 1, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    let sum = 0;
    for (const byte of header) sum += byte;
    Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "latin1").copy(header, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)));
}

/** Zips a folder the way GitHub does: everything sits under one top-level folder. */
export function zipTree(root, file, top, skip = () => false) {
  const entries = [{ name: top + "/" }];
  (function walk(dir, rel) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? rel + "/" + item.name : item.name;
      if (skip(childRel, item)) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries.push({ name: `${top}/${childRel}/` });
        walk(full, childRel);
      } else if (item.isFile()) {
        entries.push({ name: `${top}/${childRel}`, data: fs.readFileSync(full) });
      }
    }
  })(root, "");
  writeZip(file, entries);
}
