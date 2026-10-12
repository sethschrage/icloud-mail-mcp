import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import {
  attachmentSaveError,
  isRiskyFileName,
  markQuarantined,
  collisionName,
  createUniqueFile,
  expandPath,
  extensionForMime,
  fallbackAttachmentName,
  isInside,
  resolveAllowedFile,
  sanitizeFilename,
  truncateUtf8,
} from '../../src/safety/paths.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'paths-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function rejectCode(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'none',
    (e: unknown) => (e instanceof MailError ? e.code : `other:${String(e)}`),
  );
}

describe('expandPath', () => {
  const ctx = { home: '/Users/alex' };
  it('expands home and folder variables', () => {
    expect(expandPath('~', ctx)).toBe('/Users/alex');
    expect(expandPath('~/Documents/x.pdf', ctx)).toBe('/Users/alex/Documents/x.pdf');
    expect(expandPath('${HOME}/a', ctx)).toBe('/Users/alex/a');
    expect(expandPath('${DOWNLOADS}', ctx)).toBe('/Users/alex/Downloads');
    expect(expandPath('${DOCUMENTS}/b', ctx)).toBe('/Users/alex/Documents/b');
    expect(expandPath('${DESKTOP}/c/../d', ctx)).toBe('/Users/alex/Desktop/d');
    expect(expandPath('${UNKNOWN}/x', ctx)).toBe('${UNKNOWN}/x');
    expect(expandPath('~other/x', ctx)).toBe('~other/x');
  });
});

describe('sanitizeFilename', () => {
  it('removes path separators, leading dots and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFilename('..\\..\\win.ini')).toBe('_.._win.ini');
    expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    expect(sanitizeFilename('...hidden.txt')).toBe('hidden.txt');
    expect(sanitizeFilename('in\u0000voice\r\n.pdf')).toBe('invoice.pdf');
    expect(sanitizeFilename('a:b.txt')).toBe('a_b.txt');
    expect(sanitizeFilename('  spaced   name .pdf ')).toBe('spaced name .pdf');
  });

  it('strips bidi overrides that disguise extensions', () => {
    expect(sanitizeFilename('invoice‮fdp.exe')).toBe('invoicefdp.exe');
  });

  it('returns null when nothing usable remains', () => {
    for (const n of ['', '.', '..', '...', '/', '\u0001', null, undefined]) expect(sanitizeFilename(n)).toBeNull();
  });

  it('limits to 200 UTF-8 bytes keeping the extension and whole code points', () => {
    const long = `${'é'.repeat(300)}.pdf`;
    const s = sanitizeFilename(long) ?? '';
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(200);
    expect(s.endsWith('.pdf')).toBe(true);
    expect(s).not.toContain('�');
    expect(truncateUtf8('😀😀😀', 9)).toBe('😀😀');
  });

  it('normalises to NFC', () => {
    expect(sanitizeFilename('Résumé.pdf')).toBe('Résumé.pdf');
  });
});

describe('fallback names and collisions', () => {
  it('builds attachment-<uid>-<part>.<ext>', () => {
    expect(fallbackAttachmentName(21, '2', 'message/rfc822')).toBe('attachment-21-2.eml');
    expect(fallbackAttachmentName(5, '1.2', 'image/jpeg')).toBe('attachment-5-1.2.jpg');
    expect(fallbackAttachmentName(5, '3', 'application/x-weird')).toBe('attachment-5-3.bin');
    expect(extensionForMime('text/plain; charset=utf-8')).toBe('txt');
  });

  it('adds (1), (2)… before the extension within the byte limit', () => {
    expect(collisionName('a.pdf', 0)).toBe('a.pdf');
    expect(collisionName('a.pdf', 1)).toBe('a (1).pdf');
    expect(collisionName('archive.tar.gz', 2)).toBe('archive.tar (2).gz');
    expect(collisionName('noext', 3)).toBe('noext (3)');
    expect(Buffer.byteLength(collisionName(`${'x'.repeat(196)}.pdf`, 12))).toBeLessThanOrEqual(200);
  });

  it('never overwrites an existing file', async () => {
    const dir = path.join(root, 'downloads');
    const a = await createUniqueFile(dir, 'report.pdf');
    await a.handle.writeFile('first');
    await a.handle.close();
    const b = await createUniqueFile(dir, 'report.pdf');
    await b.handle.writeFile('second');
    await b.handle.close();
    expect(path.basename(a.path)).toBe('report.pdf');
    expect(path.basename(b.path)).toBe('report (1).pdf');
    expect(readFileSync(a.path, 'utf8')).toBe('first');
  });

  it('does not follow a symlink planted at the target name', async () => {
    const dir = path.join(root, 'planted');
    mkdirSync(dir, { recursive: true });
    const victim = path.join(root, 'victim.txt');
    writeFileSync(victim, 'keep me');
    symlinkSync(victim, path.join(dir, 'x.txt'));
    const f = await createUniqueFile(dir, 'x.txt');
    await f.handle.writeFile('new');
    await f.handle.close();
    expect(path.basename(f.path)).toBe('x (1).txt');
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
  });
});

describe('confinement of attachment paths', () => {
  let allowed: string;
  beforeAll(() => {
    allowed = path.join(root, 'Documents');
    mkdirSync(path.join(allowed, 'sub'), { recursive: true });
    mkdirSync(path.join(allowed, '.hidden'), { recursive: true });
    mkdirSync(path.join(root, 'private'), { recursive: true });
    writeFileSync(path.join(allowed, 'ok.txt'), 'ok');
    writeFileSync(path.join(allowed, 'sub', 'nested.txt'), 'nested');
    writeFileSync(path.join(allowed, '.env'), 'secret');
    writeFileSync(path.join(allowed, '.hidden', 'x.txt'), 'x');
    writeFileSync(path.join(root, 'private', 'secret.txt'), 'secret');
    symlinkSync(path.join(root, 'private', 'secret.txt'), path.join(allowed, 'link-out.txt'));
    symlinkSync(path.join(allowed, 'ok.txt'), path.join(allowed, 'link-in.txt'));
    symlinkSync(path.join(allowed, 'sub'), path.join(allowed, '.dotlink'));
  });

  it('accepts regular files inside an allowed dir (including via ~ and in-tree symlinks)', async () => {
    const ok = await resolveAllowedFile(path.join(allowed, 'ok.txt'), [allowed]);
    expect(ok).toMatchObject({ name: 'ok.txt', size: 2 });
    expect((await resolveAllowedFile('~/Documents/sub/nested.txt', ['~/Documents'], { home: root })).name).toBe('nested.txt');
    expect((await resolveAllowedFile(path.join(allowed, 'link-in.txt'), [allowed])).name).toBe('link-in.txt');
  });

  it('rejects traversal out of the allowed dir', async () => {
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, '..', 'private', 'secret.txt'), [allowed]))).toBe('FORBIDDEN');
    // An existing file elsewhere, by absolute path. (A missing one is NOT_FOUND: the path is realpath'd first.)
    expect(await rejectCode(resolveAllowedFile(path.join(root, 'private', 'secret.txt'), [allowed]))).toBe('FORBIDDEN');
  });

  it('rejects symlinks that escape the allowed dir', async () => {
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, 'link-out.txt'), [allowed]))).toBe('FORBIDDEN');
  });

  it('rejects hidden files and directories, even via a hidden-named symlink', async () => {
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, '.env'), [allowed]))).toBe('FORBIDDEN');
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, '.hidden', 'x.txt'), [allowed]))).toBe('FORBIDDEN');
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, '.dotlink', 'nested.txt'), [allowed]))).toBe('FORBIDDEN');
  });

  it('rejects directories, missing files, relative paths and control characters', async () => {
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, 'sub'), [allowed]))).toBe('INVALID_INPUT');
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, 'nope.txt'), [allowed]))).toBe('NOT_FOUND');
    expect(await rejectCode(resolveAllowedFile('Documents/ok.txt', [allowed]))).toBe('INVALID_INPUT');
    expect(await rejectCode(resolveAllowedFile(`${allowed}/ok.txt\n`, [allowed]))).toBe('INVALID_INPUT');
  });

  it('allows a configured dir that itself lives under a hidden folder', async () => {
    const hiddenRoot = path.join(root, '.config', 'mail-out');
    mkdirSync(hiddenRoot, { recursive: true });
    writeFileSync(path.join(hiddenRoot, 'f.txt'), 'f');
    expect((await resolveAllowedFile(path.join(hiddenRoot, 'f.txt'), [hiddenRoot])).name).toBe('f.txt');
  });

  it('ignores allowed dirs that do not exist and reports when none exist', async () => {
    expect(await rejectCode(resolveAllowedFile(path.join(allowed, 'ok.txt'), [path.join(root, 'missing-dir')]))).toBe('FORBIDDEN');
    expect(existsSync(path.join(root, 'missing-dir'))).toBe(false);
  });

  it('isInside is strict', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
  });
});

// files-1: downloads get the macOS quarantine attribute.
describe('markQuarantined', () => {
  it('runs xattr on darwin with a 0081-flagged value and reports a failure', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const ok = await markQuarantined('/Users/j/Downloads/a.zip', {
      platform: 'darwin',
      now: () => 0x65000000 * 1000,
      exec: (file, args) => {
        calls.push({ file, args });
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      },
    });
    expect(ok).toBeUndefined();
    expect(calls[0]?.file).toBe('/usr/bin/xattr');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['-w', 'com.apple.quarantine']);
    expect(calls[0]?.args[2]).toMatch(/^0081;65000000;icloud-mail-mcp;[0-9A-F-]{36}$/);
    expect(calls[0]?.args[3]).toBe('/Users/j/Downloads/a.zip');
    const failed = await markQuarantined('/x', { platform: 'darwin', exec: () => Promise.resolve({ stdout: '', stderr: 'no', code: 1 }) });
    expect(failed).toMatch(/could not be marked/);
  });

  it('does nothing elsewhere and flags risky file types', async () => {
    let called = false;
    expect(
      await markQuarantined('/x', {
        platform: 'linux',
        exec: () => {
          called = true;
          return Promise.resolve({ stdout: '', stderr: '', code: 0 });
        },
      }),
    ).toBeUndefined();
    expect(called).toBe(false);
    for (const n of ['Invoice.zip', 'setup.PKG', 'x.command', 'doc.docm', 'a.dmg']) expect(isRiskyFileName(n), n).toBe(true);
    for (const n of ['report.pdf', 'photo.jpeg', 'notes.txt']) expect(isRiskyFileName(n), n).toBe(false);
  });
});

// integ-4 / docs-6 / tests-10: local file-system errors are not "IMAP errors".
describe('attachmentSaveError', () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: boom`), { code });
  it('maps EPERM on macOS to the privacy hint', () => {
    const e = attachmentSaveError(err('EPERM'), '/Users/j/Downloads/iCloud Mail Attachments', 'darwin');
    expect(e?.code).toBe('CONFIG');
    expect(e?.message).toMatch(/Privacy & Security → Files and Folders/);
    expect(e?.message).toContain('"Attachment download folder"');
  });
  it('maps ENOTDIR, ENOSPC and ignores non-fs errors', () => {
    expect(attachmentSaveError(err('ENOTDIR'), '/etc/hostname/x', 'linux')?.message).toMatch(/part of that path is a file/);
    expect(attachmentSaveError(err('ENOSPC'), '/d', 'linux')?.message).toMatch(/disk is full/);
    expect(attachmentSaveError(new Error('socket closed'), '/d', 'linux')).toBeNull();
    expect(attachmentSaveError(new MailError('SERVER', 'x'), '/d', 'linux')).toBeNull();
  });
});
