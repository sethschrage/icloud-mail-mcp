/**
 * Path expansion, confinement and filename sanitising (SPEC §3, §6.2, §6.4).
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExecFileFn } from '../credentials.js';
import { MailError } from '../errors.js';

export interface PathContext {
  /** Home directory used for `~` and the `${HOME}`-style variables. */
  home: string;
}

export function defaultPathContext(): PathContext {
  return { home: os.homedir() };
}

/** Variables Claude Desktop may pass through unexpanded, and their meaning. */
export const PATH_VARIABLES = ['HOME', 'DOWNLOADS', 'DOCUMENTS', 'DESKTOP'] as const;

function variableValue(name: string, ctx: PathContext): string | undefined {
  switch (name) {
    case 'HOME':
      return ctx.home;
    case 'DOWNLOADS':
      return path.join(ctx.home, 'Downloads');
    case 'DOCUMENTS':
      return path.join(ctx.home, 'Documents');
    case 'DESKTOP':
      return path.join(ctx.home, 'Desktop');
    default:
      return undefined;
  }
}

/**
 * Expand `~`, `~/…`, `${HOME}`, `${DOWNLOADS}`, `${DOCUMENTS}` and `${DESKTOP}` and normalise.
 * The result may still be relative when the input was; callers decide whether that is allowed.
 */
export function expandPath(input: string, ctx: PathContext = defaultPathContext()): string {
  let p = input.trim();
  p = p.replace(/\$\{([A-Z_]+)\}/g, (match, name: string) => variableValue(name, ctx) ?? match);
  if (p === '~') p = ctx.home;
  else if (p.startsWith('~/')) p = path.join(ctx.home, p.slice(2));
  return path.normalize(p);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi overrides/isolates and zero-width characters can disguise a file extension ("…‮fdp.exe").
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁩﻿]/g;

export const MAX_FILENAME_BYTES = 200;

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Length(s) <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = utf8Length(ch);
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Split "name.ext" into ["name", ".ext"]; the extension is only kept when it is short and sane. */
export function splitExtension(filename: string): [string, string] {
  const ext = path.extname(filename);
  if (!ext || ext === filename || utf8Length(ext) > 20 || !/^\.[\p{L}\p{N}_-]+$/u.test(ext)) return [filename, ''];
  return [filename.slice(0, -ext.length), ext];
}

/**
 * Make an email-supplied filename safe to create on disk: no path separators, no leading dots,
 * no control or invisible characters, at most 200 UTF-8 bytes (keeping the extension).
 * Returns `null` when nothing usable is left, so the caller can fall back to a generated name.
 */
export function sanitizeFilename(name: string | undefined | null, maxBytes = MAX_FILENAME_BYTES): string | null {
  if (!name) return null;
  let s = name.normalize('NFC');
  s = s.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '');
  s = s.replace(/[/\\:]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '');
  s = s.replace(/[\s]+$/, '');
  if (!s || s === '.' || s === '..' || /^_+$/.test(s)) return null;
  if (utf8Length(s) > maxBytes) {
    const [base, ext] = splitExtension(s);
    s = truncateUtf8(base, maxBytes - utf8Length(ext)).trimEnd() + ext;
  }
  s = s.replace(/^[.\s]+/, '');
  return s || null;
}

const MIME_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/rtf': 'rtf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.apple.pages': 'pages',
  'application/vnd.apple.numbers': 'numbers',
  'application/vnd.apple.keynote': 'key',
  'application/ics': 'ics',
  'application/gzip': 'gz',
  'application/octet-stream': 'bin',
  'message/rfc822': 'eml',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/csv': 'csv',
  'text/calendar': 'ics',
  'text/xml': 'xml',
  'text/markdown': 'md',
  'text/vcard': 'vcf',
  'text/x-vcard': 'vcf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

export function extensionForMime(contentType: string | undefined): string {
  if (!contentType) return 'bin';
  const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  return MIME_EXTENSIONS[base] ?? 'bin';
}

/** `attachment-<uid>-<part>.<ext>` used when an attachment has no usable filename. */
export function fallbackAttachmentName(uid: number, part: string, contentType: string | undefined): string {
  return `attachment-${uid}-${part.replace(/[^0-9.]/g, '_')}.${extensionForMime(contentType)}`;
}

/** Candidate names "a.pdf", "a (1).pdf", "a (2).pdf", … each at most `maxBytes` long. */
export function collisionName(filename: string, n: number, maxBytes = MAX_FILENAME_BYTES): string {
  if (n === 0) return filename;
  const [base, ext] = splitExtension(filename);
  const suffix = ` (${n})`;
  return truncateUtf8(base, maxBytes - utf8Length(suffix) - utf8Length(ext)).trimEnd() + suffix + ext;
}

/** True if `child` (absolute, normalised) is strictly inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

function hasHiddenSegment(rel: string): boolean {
  return rel.split(path.sep).some((seg) => seg.startsWith('.') && seg !== '');
}

/**
 * Create a new file in `dir` without ever overwriting: tries "name", "name (1)", … using an
 * exclusive create, then verifies (realpath) that the file really is inside `dir`.
 */
export async function createUniqueFile(dir: string, filename: string, maxAttempts = 1000): Promise<{ path: string; handle: FileHandle }> {
  await fsp.mkdir(dir, { recursive: true });
  const dirReal = await fsp.realpath(dir);
  for (let n = 0; n < maxAttempts; n++) {
    const candidate = path.join(dirReal, collisionName(filename, n));
    if (path.dirname(candidate) !== dirReal) throw new MailError('INVALID_INPUT', 'Refusing to write outside the attachment directory.');
    let handle: FileHandle;
    try {
      handle = await fsp.open(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    const real = await fsp.realpath(candidate);
    if (path.dirname(real) !== dirReal) {
      await handle.close();
      await fsp.unlink(candidate).catch(() => undefined);
      throw new MailError('INVALID_INPUT', 'Refusing to write outside the attachment directory.');
    }
    return { path: real, handle };
  }
  throw new MailError('CONFLICT', `Could not find a free filename for "${filename}" in ${dirReal}.`);
}

const MACOS_PRIVACY_HINT =
  'macOS may be blocking access: allow Claude in System Settings → Privacy & Security → Files and Folders (turn on the folder), then try again';

function errnoCode(err: unknown): string | undefined {
  const c = (err as NodeJS.ErrnoException | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

/**
 * Turn a local file-system error while saving an attachment into an actionable MailError (instead
 * of it surfacing as an "IMAP error"). Returns null for errors that are not file-system errors.
 */
export function attachmentSaveError(err: unknown, dir: string, platform: NodeJS.Platform = process.platform): MailError | null {
  if (err instanceof MailError) return null;
  const code = errnoCode(err);
  if (!code) return null;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new MailError('CONFIG', `Could not save the attachment in "${dir}": the disk is full (${code}). Free up some space and try again.`, { cause: err });
  }
  if (!['EPERM', 'EACCES', 'EROFS', 'ENOTDIR', 'EISDIR', 'ENOENT', 'ELOOP', 'ENAMETOOLONG', 'EEXIST'].includes(code)) return null;
  const privacy = platform === 'darwin' && (code === 'EPERM' || code === 'EACCES') ? ` ${MACOS_PRIVACY_HINT}, or choose another folder.` : '';
  const kind = code === 'ENOTDIR' || code === 'EEXIST' || code === 'EISDIR' ? ' (part of that path is a file, not a folder)' : code === 'EROFS' ? ' (the disk is read-only)' : '';
  return new MailError(
    'CONFIG',
    `Could not save the attachment in "${dir}" (${code})${kind}. Check the "Attachment download folder" setting (MAIL_ATTACHMENT_DIR).${privacy}`,
    { cause: err },
  );
}

/** Extensions of files that run code or install software when opened. */
const RISKY_EXTENSIONS = new Set(['.app', '.pkg', '.mpkg', '.dmg', '.command', '.sh', '.tool', '.terminal', '.scpt', '.applescript', '.workflow', '.jar', '.zip', '.docm', '.xlsm', '.pptm', '.iso', '.exe', '.msi', '.bat', '.js']);

export function isRiskyFileName(name: string): boolean {
  return RISKY_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export interface QuarantineOptions {
  platform?: NodeJS.Platform;
  exec: ExecFileFn;
  xattrPath?: string;
  now?: () => number;
}

/**
 * Mark a downloaded file as coming from the internet (macOS `com.apple.quarantine`), as Apple Mail
 * and Safari do, so Gatekeeper checks it and macOS asks before opening an app or installer (and
 * anything extracted from a quarantined archive is quarantined too). The "user approved" bit
 * (0x0040) is never set. Returns a note when the attribute could not be set; no-op elsewhere.
 */
export async function markQuarantined(filePath: string, options: QuarantineOptions): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== 'darwin') return undefined;
  const seconds = Math.floor((options.now ?? Date.now)() / 1000).toString(16);
  const value = `0081;${seconds};icloud-mail-mcp;${randomUUID().toUpperCase()}`;
  const r = await options.exec(options.xattrPath ?? '/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, filePath], { timeoutMs: 10_000 });
  if (r.error || r.code !== 0) {
    return 'The file could not be marked as downloaded from the internet (macOS quarantine), so macOS will not warn before it is opened; treat it with care.';
  }
  return undefined;
}

export interface AllowedFile {
  /** Real (symlink-free) path of the file. */
  realPath: string;
  /** Name to use for the attachment (basename of the path the caller gave). */
  name: string;
  /** Basename of the real file (differs from `name` when the path went through a symlink). */
  realName: string;
  size: number;
}

/**
 * Resolve a local path the model wants to attach and check it is confined to one of the allowed
 * directories: expanded + realpath'd, no hidden path components, regular file only.
 */
export async function resolveAllowedFile(input: string, allowedDirs: readonly string[], ctx: PathContext = defaultPathContext()): Promise<AllowedFile> {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input)) throw new MailError('INVALID_INPUT', 'Attachment path contains control characters.');
  const expanded = expandPath(input, ctx);
  if (!path.isAbsolute(expanded)) {
    throw new MailError('INVALID_INPUT', `Attachment path "${input}" must be absolute (or start with ~/).`);
  }
  if (allowedDirs.length === 0) {
    throw new MailError('FORBIDDEN', 'Attaching local files is switched off ("Attach files from" / MAIL_ATTACH_FROM_DIRS is set to none).');
  }
  const allowed: Array<{ expanded: string; real: string }> = [];
  const denied: string[] = [];
  for (const dir of allowedDirs) {
    const exp = expandPath(dir, ctx);
    if (!path.isAbsolute(exp)) continue;
    try {
      allowed.push({ expanded: exp, real: await fsp.realpath(exp) });
    } catch (err) {
      // An allowed directory that does not exist is ignored; one we may not read is reported.
      const code = errnoCode(err);
      if (code === 'EPERM' || code === 'EACCES') denied.push(exp);
    }
  }
  const allowedList = allowedDirs.join(', ') || '(none)';
  if (allowed.length === 0) {
    if (denied.length) {
      throw new MailError('FORBIDDEN', `Access to the attachment folders was denied (${denied.join(', ')}). ${MACOS_PRIVACY_HINT}.`);
    }
    throw new MailError('FORBIDDEN', `No attachment folder is available: none of the allowed folders exists ("Attach files from" in the extension settings, or MAIL_ATTACH_FROM_DIRS): ${allowedList}.`);
  }

  // Hidden components in the path as given (relative to the allowed root that contains it lexically,
  // or anywhere in the path when no allowed root contains it).
  const lexicalRoot = allowed.find((a) => isInside(a.expanded, expanded) || isInside(a.real, expanded));
  const lexicalRel = lexicalRoot
    ? path.relative(isInside(lexicalRoot.expanded, expanded) ? lexicalRoot.expanded : lexicalRoot.real, expanded)
    : expanded;
  if (hasHiddenSegment(lexicalRel)) {
    throw new MailError('FORBIDDEN', `Refusing to attach "${input}": hidden files and folders (names starting with ".") are not allowed.`);
  }

  let real: string;
  try {
    real = await fsp.realpath(expanded);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new MailError('NOT_FOUND', `Attachment file not found: ${input}`);
    if (code === 'EPERM' || code === 'EACCES') throw new MailError('FORBIDDEN', `Cannot access attachment "${input}" (${code}). ${MACOS_PRIVACY_HINT}.`);
    throw new MailError('INVALID_INPUT', `Cannot access attachment "${input}": ${code ?? 'error'}`);
  }
  const root = allowed.find((a) => isInside(a.real, real));
  if (!root) {
    throw new MailError(
      'FORBIDDEN',
      `Refusing to attach "${input}": files can only be attached from these folders ("Attach files from" in the extension settings, or MAIL_ATTACH_FROM_DIRS): ${allowedList}.`,
    );
  }
  if (hasHiddenSegment(path.relative(root.real, real))) {
    throw new MailError('FORBIDDEN', `Refusing to attach "${input}": hidden files and folders (names starting with ".") are not allowed.`);
  }
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new MailError('INVALID_INPUT', `Attachment "${input}" is not a regular file.`);
  return { realPath: real, name: path.basename(expanded), realName: path.basename(real), size: st.size };
}

/**
 * Read a confined file into memory, re-checking that it is still a regular file and within the
 * remaining size budget at read time (O_NOFOLLOW guards against a last-moment symlink swap).
 */
export async function readAllowedFile(file: AllowedFile, maxBytes: number): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(file.realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EPERM' || code === 'EACCES') throw new MailError('FORBIDDEN', `Cannot read attachment "${file.name}" (${code}). ${MACOS_PRIVACY_HINT}.`);
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new MailError('INVALID_INPUT', `Attachment "${file.name}" is not a regular file.`);
    if (st.size > maxBytes) {
      throw new MailError('TOO_LARGE', `Attachment "${file.name}" (${st.size} bytes) exceeds the remaining attachment budget of ${maxBytes} bytes.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
