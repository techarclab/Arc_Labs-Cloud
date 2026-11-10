#!/usr/bin/env node
// Packs firmware/arduino-library/ArcCloud into ArcCloud-<version>.zip for Arduino IDE "Add .ZIP Library…".
//   node tools/pack-arduino-library.mjs [outDir]      (default: apps/console/public/downloads)
// The console build runs it, so the zip is served by the console at /downloads/ArcCloud-<version>.zip.
// No dependencies: a minimal ZIP writer (deflate via node:zlib). Output is deterministic (fixed timestamps).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libDir = join(root, 'firmware/arduino-library/ArcCloud');
const outDir = resolve(process.argv[2] ?? join(root, 'apps/console/public/downloads'));
const version = /^version=(.+)$/m.exec(readFileSync(join(libDir, 'library.properties'), 'utf8'))?.[1]?.trim();
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('library.properties has no valid version=');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function files(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01, fixed so the zip is reproducible
const local = [];
const central = [];
let offset = 0;
for (const path of files(libDir)) {
  const name = Buffer.from(`ArcCloud/${relative(libDir, path).split('\\').join('/')}`, 'utf8');
  const data = readFileSync(path);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  local.push(head, name, packed);
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);
  dir.writeUInt16LE(20, 6);
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(8, 10);
  dir.writeUInt16LE(DOS_TIME, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(packed.length, 20);
  dir.writeUInt32LE(data.length, 24);
  dir.writeUInt16LE(name.length, 28);
  dir.writeUInt32LE(offset, 42);
  central.push(dir, name);
  offset += head.length + name.length + packed.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(outDir, { recursive: true });
for (const old of readdirSync(outDir)) if (/^ArcCloud-.*\.zip$/.test(old)) rmSync(join(outDir, old));
const out = join(outDir, `ArcCloud-${version}.zip`);
writeFileSync(out, Buffer.concat([...local, ...central, end]));
writeFileSync(join(outDir, 'arduino-library.json'), JSON.stringify({ name: 'ArcCloud', version, file: `ArcCloud-${version}.zip` }) + '\n');
console.log(`[pack-arduino-library] ${relative(root, out)} (${central.length / 2} files)`);
