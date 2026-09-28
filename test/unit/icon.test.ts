/**
 * icon.png (SPEC §9): a valid 512×512 RGBA PNG whose pixels are exactly what
 * scripts/make-icon.mjs renders, so the committed file and the generator cannot drift apart.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ICON_SIZE, crc32, makeIcon, renderIcon } from '../../scripts/make-icon.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  chunks: string[];
  rgba: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Minimal independent PNG decoder for 8-bit RGBA, non-interlaced images (verifies every CRC). */
function decodePng(file: Buffer): DecodedPng {
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('bad PNG signature');
  let offset = 8;
  const chunks: string[] = [];
  const idat: Buffer[] = [];
  let header: Omit<DecodedPng, 'chunks' | 'rgba'> | undefined;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    const crc = file.readUInt32BE(offset + 8 + length);
    if (crc32(file.subarray(offset + 4, offset + 8 + length)) !== crc) throw new Error(`CRC mismatch in ${type}`);
    chunks.push(type);
    if (type === 'IHDR') {
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8] ?? -1, colorType: data[9] ?? -1, interlace: data[12] ?? -1 };
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('no IHDR');
  const { width, height } = header;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error(`unexpected image data length ${raw.length}`);
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= 4 ? (rgba[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (rgba[(y - 1) * stride + x - 4] ?? 0) : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = Math.floor((a + b) / 2);
          break;
        case 4:
          predictor = paeth(a, b, c);
          break;
        default:
          throw new Error(`bad filter type ${filter}`);
      }
      rgba[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { ...header, chunks, rgba };
}

function pixel(img: DecodedPng, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return [...img.rgba.subarray(o, o + 4)];
}

describe('icon.png', () => {
  const file = readFileSync(path.join(ROOT, 'icon.png'));
  const img = decodePng(file);

  it('is a valid 512x512 8-bit RGBA PNG', () => {
    expect(ICON_SIZE).toBe(512);
    expect(img).toMatchObject({ width: 512, height: 512, bitDepth: 8, colorType: 6, interlace: 0 });
    expect(img.chunks[0]).toBe('IHDR');
    expect(img.chunks.at(-1)).toBe('IEND');
    expect(file.length).toBeLessThan(100_000);
  });

  it('matches what scripts/make-icon.mjs renders (regenerate with npm run icon)', () => {
    expect(img.rgba.equals(renderIcon(512))).toBe(true);
    expect(decodePng(makeIcon()).rgba.equals(img.rgba)).toBe(true);
  });

  it('shows a white envelope on an opaque blue rounded square with transparent corners', () => {
    expect(pixel(img, 0, 0)[3]).toBe(0);
    expect(pixel(img, 511, 511)[3]).toBe(0);
    const [r, g, b, a] = pixel(img, 256, 40);
    expect(a).toBe(255);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(120);
    expect(g).toBeLessThan(200);
    expect(pixel(img, 256, 340)).toEqual([255, 255, 255, 255]);
  });
});
