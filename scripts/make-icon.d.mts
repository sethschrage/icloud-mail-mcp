/** Types for scripts/make-icon.mjs (imported by test/unit/icon.test.ts). */
export declare const ICON_SIZE: number;
/** Non-premultiplied RGBA pixels, row by row (size × size × 4 bytes). */
export declare function renderIcon(size?: number): Buffer;
export declare function crc32(buf: Uint8Array): number;
export declare function encodePng(width: number, height: number, rgba: Buffer): Buffer;
/** The complete PNG file. */
export declare function makeIcon(size?: number): Buffer;
