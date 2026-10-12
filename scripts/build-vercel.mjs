#!/usr/bin/env node
/**
 * Cloud build (Vercel runs it as `npm run vercel-build` before packaging api/icloud-mail.js):
 * typecheck, then bundle src/http/vercel.ts with every dependency into build/vercel/handler.mjs
 * (same esbuild settings as the .mcpb bundle: ESM, node20, createRequire banner).
 *
 * Usage: node scripts/build-vercel.mjs [--skip-typecheck]
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PROJECT_ROOT, serverBundleOptions } from './build-dev.mjs';
import { typecheck } from './build.mjs';

export const VERCEL_BUNDLE = path.join(PROJECT_ROOT, 'build', 'vercel', 'handler.mjs');

export async function buildVercel({ skipTypecheck = false } = {}) {
  if (!skipTypecheck) await typecheck();
  await mkdir(path.dirname(VERCEL_BUNDLE), { recursive: true });
  const result = await build({
    ...serverBundleOptions({ outfile: VERCEL_BUNDLE, minify: true }),
    entryPoints: [path.join(PROJECT_ROOT, 'src', 'http', 'vercel.ts')],
  });
  if (result.errors.length) throw new Error(`esbuild failed with ${result.errors.length} error(s)`);
  return VERCEL_BUNDLE;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildVercel({ skipTypecheck: process.argv.includes('--skip-typecheck') }).then(
    (file) => process.stderr.write(`built ${path.relative(process.cwd(), file)}\n`),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
