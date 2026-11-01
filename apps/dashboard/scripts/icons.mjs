// Generate the PWA icons (a rising line on a dark tile) as PNGs, with no
// image dependencies. Run once: node scripts/icons.mjs. Output is committed.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [19, 19, 18];
const LINE = [57, 135, 229];
// Points in a 0..1 box, inside the maskable safe zone (centre 80%).
const PATH = [[0.2, 0.68], [0.38, 0.52], [0.52, 0.6], [0.8, 0.3]];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function png(size) {
  const half = (0.055 * size) / 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      let d = Infinity;
      for (let i = 1; i < PATH.length; i++) d = Math.min(d, distToSegment(x + 0.5, y + 0.5, [PATH[i - 1][0] * size, PATH[i - 1][1] * size], [PATH[i][0] * size, PATH[i][1] * size]));
      const a = Math.max(0, Math.min(1, half + 0.5 - d)); // 1px anti-aliased edge
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(BG[c] * (1 - a) + LINE[c] * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const out = (f) => new URL(`../public/icons/${f}`, import.meta.url);
writeFileSync(out("icon-192.png"), png(192));
writeFileSync(out("icon-512.png"), png(512));
writeFileSync(out("apple-touch-icon.png"), png(180));
console.log("icons written");
