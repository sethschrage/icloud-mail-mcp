/** Types for scripts/build-dev.mjs (imported by the vitest global setup). */
export declare const PROJECT_ROOT: string;
export declare const DEV_OUTDIR: string;
export declare const CREATE_REQUIRE_BANNER: string;
export declare function serverBundleOptions(options: { outfile: string; minify: boolean }): Record<string, unknown>;
/** Bundle src/index.ts into `<outdir>/index.js`; resolves to the output file path. */
export declare function buildDev(outdir?: string): Promise<string>;
