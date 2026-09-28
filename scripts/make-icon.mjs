#!/usr/bin/env node
/**
 * Generates icon.png (SPEC §9): a 512×512 white envelope glyph on a blue rounded square, drawn
 * with signed-distance shapes and 4×4 supersampling, encoded as an RGBA PNG with node:zlib only
 * (no image libraries).
 *
 * Usage: node scripts/make-icon.mjs [output.png]   (default: icon.png in the project root)
 *
 * The rasteriser uses only IEEE-exact arithmetic (+, -, *, /, Math.sqrt), so the pixels are the
 * same on every platform; test/unit/icon.test.ts checks that the committed icon.png matches them.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const ICON_SIZE = 512;
const SUPERSAMPLE = 4;

// Geometry, in units of a 512-pixel canvas (scaled for other sizes).
const BG = { cx: 256, cy: 256, hw: 256, hh: 256, r: 115 };
const ENVELOPE = { cx: 256, cy: 262, hw: 158, hh: 110, r: 26 };
const FLAP = [
  [120, 174],
  [256, 282],
  [392, 174],
];
const FLAP_HALF_WIDTH = 9.5;

const TOP_BLUE = [72, 170, 255];
const BOTTOM_BLUE = [10, 98, 222];
const FLAP_BLUE = [26, 120, 236];
const WHITE = [255, 255, 255];

/** Signed distance from (x, y) to a rounded rectangle (negative inside). */
function roundedRectDistance(x, y, { cx, cy, hw, hh, r }) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from (x, y) to the segment a-b. */
function segmentDistance(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  let t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
  t = Math.min(1, Math.max(0, t));
  const px = ax + t * dx - x;
  const py = ay + t * dy - y;
  return Math.sqrt(px * px + py * py);
}

/** Colour of one sample point (canvas units), or null outside the rounded square. */
function sampleColor(x, y) {
  if (roundedRectDistance(x, y, BG) > 0) return null;
  if (roundedRectDistance(x, y, ENVELOPE) <= 0) {
    const d = Math.min(segmentDistance(x, y, FLAP[0], FLAP[1]), segmentDistance(x, y, FLAP[1], FLAP[2]));
    return d <= FLAP_HALF_WIDTH ? FLAP_BLUE : WHITE;
  }
  const t = y / 512;
  return [0, 1, 2].map((i) => TOP_BLUE[i] + (BOTTOM_BLUE[i] - TOP_BLUE[i]) * t);
}

/** Render the icon as non-premultiplied RGBA bytes, row by row. */
export function renderIcon(size = ICON_SIZE) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  const n = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const c = sampleColor((px + (sx + 0.5) / SUPERSAMPLE) * scale, (py + (sy + 0.5) / SUPERSAMPLE) * scale);
          if (!c) continue;
          covered++;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const o = (py * size + px) * 4;
      if (covered === 0) continue; // fully transparent (already zero)
      rgba[o] = Math.round(r / covered);
      rgba[o + 1] = Math.round(g / covered);
      rgba[o + 2] = Math.round(b / covered);
      rgba[o + 3] = Math.round((covered / n) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as used by PNG chunks (node:zlib.crc32 needs Node >= 20.15, so it is computed here). */
export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode RGBA pixels as a PNG (8-bit RGBA, no interlace, filter type 0 on every row). */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('pixel buffer does not match the dimensions');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeIcon(size = ICON_SIZE) {
  return encodePng(size, size, renderIcon(size));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = path.resolve(process.argv[2] ?? path.join(root, 'icon.png'));
  const png = makeIcon();
  writeFileSync(out, png);
  process.stderr.write(`wrote ${path.relative(process.cwd(), out) || out} (${ICON_SIZE}x${ICON_SIZE}, ${png.length} bytes)\n`);
}
