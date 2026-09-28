#!/usr/bin/env node
/**
 * Package the extension (SPEC §9): run the build (scripts/build.mjs), validate the staged
 * manifest with `mcpb validate`, then `mcpb pack build/mcpb dist/icloud-mail-<version>.mcpb`.
 * Afterwards the archive's entries are read back and must be exactly BUNDLE_FILES (no sources,
 * tests or node_modules), and the file size is printed.
 *
 * Usage: node scripts/pack.mjs [--skip-typecheck]
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BUNDLE_FILES, MCPB_STAGE_DIR, PROJECT_ROOT, buildMcpb } from './build.mjs';

const execFileAsync = promisify(execFile);

export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const MCPB_CLI = path.join(PROJECT_ROOT, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');

/** Run the mcpb CLI; resolves to its combined output, throws with the output on failure. */
export async function runMcpb(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [MCPB_CLI, ...args], { cwd: PROJECT_ROOT, maxBuffer: 20 * 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(`mcpb ${args[0]} failed:\n${out || err.message}`);
  }
}

/** Names of the entries in a zip archive, read from its central directory (directories skipped). */
export function listZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${i}`);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (!name.endsWith('/')) names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names.sort();
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Build, validate and pack. `outFile` defaults to dist/icloud-mail-<version>.mcpb.
 * Resolves to { file, size, version, entries }.
 */
export async function packMcpb({ stageDir = MCPB_STAGE_DIR, outFile, typecheck = true, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const say = log ?? (() => undefined);
  const { version } = await buildMcpb({ outDir: stageDir, typecheck, log });
  const file = outFile ?? path.join(DIST_DIR, `icloud-mail-${version}.mcpb`);

  say(`validate: mcpb validate ${path.relative(PROJECT_ROOT, path.join(stageDir, 'manifest.json'))}`);
  say(await runMcpb(['validate', path.join(stageDir, 'manifest.json')]));

  await mkdir(path.dirname(file), { recursive: true });
  await rm(file, { force: true });
  // A path relative to the CLI's cwd keeps mcpb's archive listing readable.
  const stageArg = path.relative(PROJECT_ROOT, stageDir).startsWith('..') ? stageDir : path.relative(PROJECT_ROOT, stageDir) || '.';
  say(`pack: mcpb pack ${stageArg} ${path.relative(PROJECT_ROOT, file)}`);
  const packOutput = await runMcpb(['pack', stageArg, file]);
  if (log) say(packOutput);

  const entries = listZipEntries(await readFile(file));
  if (JSON.stringify(entries) !== JSON.stringify(BUNDLE_FILES)) {
    throw new Error(`unexpected entries in ${file}: ${entries.join(', ')} (expected ${BUNDLE_FILES.join(', ')})`);
  }
  const { size } = await stat(file);
  say(`packed ${path.relative(process.cwd(), file) || file}: ${formatBytes(size)} (${size} bytes), ${entries.length} files: ${entries.join(', ')}`);
  return { file, size, version, entries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packMcpb({ typecheck: !process.argv.includes('--skip-typecheck') }).catch((err) => {
    process.stderr.write(`pack failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
