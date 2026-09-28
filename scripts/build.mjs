#!/usr/bin/env node
/**
 * Packaging build (SPEC §9): typecheck, then stage the .mcpb contents in build/mcpb/:
 *
 *   server/index.js          src/index.ts bundled by esbuild (ESM, node20, minified, createRequire
 *                            banner; same settings as the dev build, scripts/build-dev.mjs)
 *   manifest.json icon.png LICENSE
 *   package.json             minimal: {"name", "version", "private", "type": "module"}
 *   THIRD_PARTY_NOTICES.txt  licence texts of every npm package inlined into the bundle
 *
 * Nothing else goes in: no sources, tests or node_modules (the bundle is self-contained). The
 * staged file list is checked against BUNDLE_FILES, and the package.json, manifest.json and
 * src/version.ts versions must agree.
 *
 * Usage: node scripts/build.mjs [--skip-typecheck] [--outdir <dir>]
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { PROJECT_ROOT, serverBundleOptions } from './build-dev.mjs';

const execFileAsync = promisify(execFile);

export { PROJECT_ROOT };
export const MCPB_STAGE_DIR = path.join(PROJECT_ROOT, 'build', 'mcpb');

/** Exactly the files of the .mcpb, sorted (checked after staging and again after packing). */
export const BUNDLE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'icon.png', 'manifest.json', 'package.json', 'server/index.js'];

/** Files copied verbatim from the project root. */
const COPIED_FILES = ['manifest.json', 'icon.png', 'LICENSE'];

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** Read the three version declarations and fail unless they agree. */
export async function projectVersion() {
  const pkg = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8'));
  const source = await readFile(path.join(PROJECT_ROOT, 'src', 'version.ts'), 'utf8');
  const sourceVersion = /export const VERSION = '([^']+)'/.exec(source)?.[1];
  if (pkg.version !== manifest.version || pkg.version !== sourceVersion) {
    throw new Error(`version mismatch: package.json ${pkg.version}, manifest.json ${manifest.version}, src/version.ts ${sourceVersion}`);
  }
  return { version: pkg.version, name: manifest.name };
}

/** `tsc --noEmit -p tsconfig.json`; throws with the compiler output on errors. */
export async function typecheck() {
  const tsc = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    await execFileAsync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], { cwd: PROJECT_ROOT, maxBuffer: 20 * 1024 * 1024 });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(`typecheck failed:\n${out || err.message}`);
  }
}

/** Relative paths (with "/") of every file below dir, sorted. */
export async function listFiles(dir) {
  const out = [];
  const walk = async (rel) => {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

/** Directory of the npm package that owns a bundled input path, or null for our own sources. */
function packageDirOf(input) {
  const parts = input.split('/');
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || i + 1 >= parts.length) return null;
  const nameLength = parts[i + 1]?.startsWith('@') ? 2 : 1;
  return parts.slice(0, i + 1 + nameLength).join('/');
}

/** Licence notices of every npm package esbuild inlined, from the build's metafile. */
async function thirdPartyNotices(metafile) {
  const dirs = [...new Set(Object.keys(metafile.inputs).map(packageDirOf).filter((d) => d !== null))];
  const packages = new Map();
  for (const dir of dirs) {
    const abs = path.resolve(PROJECT_ROOT, dir);
    const pkg = JSON.parse(await readFile(path.join(abs, 'package.json'), 'utf8'));
    const id = `${pkg.name}@${pkg.version}`;
    if (packages.has(id)) continue; // the same version installed in two places
    const licenseFiles = (await readdir(abs)).filter((f) => LICENSE_FILE.test(f)).sort();
    const texts = await Promise.all(licenseFiles.map((f) => readFile(path.join(abs, f), 'utf8')));
    const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see package');
    packages.set(id, { id, license, texts });
  }
  const sorted = [...packages.values()].sort((a, b) => a.id.localeCompare(b.id));
  const rule = '='.repeat(78);
  const sections = sorted.map(({ id, license, texts }) =>
    [rule, `${id} (${license})`, rule, '', texts.length ? texts.map((t) => t.trim()).join('\n\n') : `No licence file is included in this package; its package.json declares: ${license}.`, ''].join('\n'),
  );
  return [
    'The iCloud Mail extension (server/index.js) bundles the following open-source packages.',
    'Their licence notices follow.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Stage the .mcpb contents in `outDir` (wiped first). Resolves to the staged file list.
 * `log` receives progress lines (pass null for silence).
 */
export async function buildMcpb({ outDir = MCPB_STAGE_DIR, typecheck: runTypecheck = true, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const say = log ?? (() => undefined);
  const { version, name } = await projectVersion();
  if (runTypecheck) {
    say('typecheck: tsc --noEmit');
    await typecheck();
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, 'server'), { recursive: true });

  const outfile = path.join(outDir, 'server', 'index.js');
  say(`bundle: src/index.ts -> ${path.relative(PROJECT_ROOT, outfile)}`);
  const result = await build({ ...serverBundleOptions({ outfile, minify: true }), metafile: true });
  if (result.errors.length) throw new Error(`esbuild failed with ${result.errors.length} error(s)`);

  for (const file of COPIED_FILES) await copyFile(path.join(PROJECT_ROOT, file), path.join(outDir, file));
  await writeFile(path.join(outDir, 'package.json'), `${JSON.stringify({ name, version, private: true, type: 'module' }, null, 2)}\n`);
  await writeFile(path.join(outDir, 'THIRD_PARTY_NOTICES.txt'), await thirdPartyNotices(result.metafile));

  const files = await listFiles(outDir);
  if (JSON.stringify(files) !== JSON.stringify(BUNDLE_FILES)) {
    throw new Error(`unexpected staged files in ${outDir}: ${files.join(', ')} (expected ${BUNDLE_FILES.join(', ')})`);
  }
  say(`staged ${files.length} files in ${path.relative(PROJECT_ROOT, outDir) || outDir} (version ${version})`);
  return { outDir, version, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--outdir');
  const outDir = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : MCPB_STAGE_DIR;
  buildMcpb({ outDir, typecheck: !process.argv.includes('--skip-typecheck') }).catch((err) => {
    process.stderr.write(`build failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
