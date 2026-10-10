// Creates icon.png 512x512 (isometric cube) with plain Node, no external libraries needed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const SS = 4; // supersampling for anti-aliasing
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icon.png');

const cx = 256, cy = 268, s = 150, k = Math.cos(Math.PI / 6) * s;
const T = [cx, cy - s], UL = [cx - k, cy - s / 2], UR = [cx + k, cy - s / 2];
const C = [cx, cy], LL = [cx - k, cy + s / 2], LR = [cx + k, cy + s / 2], B = [cx, cy + s];
const FACES = [
  { poly: [T, UR, C, UL], rgb: [125, 211, 252] }, // top
  { poly: [UL, C, B, LL], rgb: [56, 152, 236] }, // left
  { poly: [C, UR, LR, B], rgb: [29, 78, 216] }, // right
];

function inside(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }
  return true;
}

function inRoundedSquare(x, y, r = 104) {
  const dx = Math.max(r - x, 0, x - (SIZE - r)), dy = Math.max(r - y, 0, y - (SIZE - r));
  return dx * dx + dy * dy <= r * r;
}

function sample(x, y) {
  if (!inRoundedSquare(x, y)) return [0, 0, 0, 0];
  for (const f of FACES) if (inside(f.poly, x, y)) return [...f.rgb, 255];
  const t = y / SIZE; // dark blue-grey gradient background
  return [Math.round(30 + 12 * t), Math.round(41 + 10 * t), Math.round(59 + 16 * t), 255];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const p = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    const a = acc[3];
    raw[o] = a ? Math.round(acc[0] / a) : 0;
    raw[o + 1] = a ? Math.round(acc[1] / a) : 0;
    raw[o + 2] = a ? Math.round(acc[2] / a) : 0;
    raw[o + 3] = Math.round(a / (SS * SS));
  }
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`icon.png ${SIZE}x${SIZE}, ${png.length} bytes -> ${OUT}`);
