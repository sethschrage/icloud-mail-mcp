#!/usr/bin/env node
/**
 * Development build: bundles src/index.ts into build/dev/index.js (ESM, node20, not minified, with
 * a linked source map). The end-to-end tests spawn this file over stdio (vitest's integration
 * project runs it as a globalSetup, so the tests always exercise the current source).
 *
 * The packaging build (scripts/build.mjs, SPEC §9) produces the minified .mcpb bundle with the same
 * esbuild settings; keep the two in sync (notably the createRequire banner, research-mcpb §3).
 *
 * Usage: node scripts/build-dev.mjs [--outdir build/dev]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_OUTDIR = path.join(PROJECT_ROOT, 'build', 'dev');

/** Some dependencies call require(); ESM bundles need a real require (research-mcpb §3). */
export const CREATE_REQUIRE_BANNER = "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);";

/** Shared esbuild options for the server bundle. */
export function serverBundleOptions({ outfile, minify }) {
  return {
    entryPoints: [path.join(PROJECT_ROOT, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    minify,
    sourcemap: minify ? false : 'linked',
    banner: { js: CREATE_REQUIRE_BANNER },
    legalComments: minify ? 'none' : 'eof',
    logLevel: 'warning',
  };
}

export async function buildDev(outdir = DEV_OUTDIR) {
  await mkdir(outdir, { recursive: true });
  const outfile = path.join(outdir, 'index.js');
  const result = await build(serverBundleOptions({ outfile, minify: false }));
  if (result.errors.length) throw new Error(`esbuild failed with ${result.errors.length} error(s)`);
  await writeFile(path.join(outdir, 'package.json'), `${JSON.stringify({ name: 'icloud-mail-dev', private: true, type: 'module' }, null, 2)}\n`);
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--outdir');
  const outdir = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : DEV_OUTDIR;
  buildDev(outdir).then(
    (file) => process.stderr.write(`built ${path.relative(process.cwd(), file)}\n`),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
