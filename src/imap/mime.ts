/**
 * Pure helpers over imapflow's BODYSTRUCTURE tree: body part selection, attachment discovery,
 * snippet part lookup and decoding of partial (undecoded) BODY[] fetches.
 */
import type { MessageStructureObject } from 'imapflow';

export interface TextPartRef {
  /** IMAP part number; 'TEXT' for a single-part message (for bodyParts fetches). */
  part: string;
  type: 'text/plain' | 'text/html';
  encoding: string;
  charset: string;
  size: number | undefined;
}

export interface AttachmentInfo {
  part: string;
  filename: string | null;
  content_type: string;
  /** Encoded size on the server in bytes (base64 inflates by ~4/3). */
  size: number | null;
  /** Content-Transfer-Encoding (lowercase), used to estimate the decoded size. */
  encoding: string;
  inline: boolean;
  content_id: string | null;
  /** For an attached message (message/rfc822): its From, Subject and Date. */
  embedded?: { from: string; subject: string; date: string | null };
}

const lower = (s: string | undefined): string => (s ?? '').toLowerCase();

export function isMultipart(node: MessageStructureObject): boolean {
  return lower(node.type).startsWith('multipart/');
}

function isMessageRfc822(node: MessageStructureObject): boolean {
  const t = lower(node.type);
  return t === 'message/rfc822' || t === 'message/global';
}

export function filenameOf(node: MessageStructureObject): string | null {
  const name = node.dispositionParameters?.['filename'] ?? node.parameters?.['name'];
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/** Part number for fetch/download: single-part root has no `part`. */
export function partNumber(node: MessageStructureObject): string {
  return node.part ?? '1';
}

/**
 * Is this leaf an attachment rather than body text?
 * SPEC §5: disposition=attachment, OR a filename on a non-text part, OR message/rfc822. Text parts
 * that carry a filename are also files. Any other non-text leaf (e.g. text/calendar, a nameless
 * PDF) is listed too so nothing in the message is hidden.
 */
export function isAttachmentLeaf(node: MessageStructureObject): boolean {
  if (isMultipart(node)) return false;
  if (isMessageRfc822(node)) return true;
  if (lower(node.disposition) === 'attachment') return true;
  const type = lower(node.type);
  if (type === 'text/plain' || type === 'text/html') return filenameOf(node) !== null;
  return true;
}

function isInlineImage(node: MessageStructureObject): boolean {
  return !!node.id && lower(node.disposition) !== 'attachment' && lower(node.type).startsWith('image/');
}

/** Encoded size from which an inline image counts as a photo rather than a logo or tracker. */
export const INLINE_PHOTO_MIN_BYTES = 64 * 1024;
const CAMERA_FILENAME = /^(IMG|DSC|DSCN|PXL|Photo|PHOTO)[_ -]?\d/;

/**
 * An inline (cid) image that the user thinks of as an attachment: Apple Mail sends attached photos
 * as `Content-Disposition: inline; filename=IMG_1234.jpeg` inside multipart/related. Such an image
 * has a filename and either a photo-like size, Apple's x-unix-mode parameter or a camera-style
 * name; small named signature logos (Outlook's image001.png) and nameless trackers do not count.
 */
export function isLikelyInlinePhoto(node: MessageStructureObject): boolean {
  if (!isInlineImage(node)) return false;
  const name = filenameOf(node);
  if (!name) return false;
  const size = typeof node.size === 'number' ? node.size : 0;
  return size >= INLINE_PHOTO_MIN_BYTES || node.parameters?.['x-unix-mode'] !== undefined || CAMERA_FILENAME.test(name);
}

function textRef(node: MessageStructureObject, singlePartKey: string): TextPartRef | null {
  const type = lower(node.type);
  if (type !== 'text/plain' && type !== 'text/html') return null;
  return {
    part: node.part ?? singlePartKey,
    type,
    encoding: lower(node.encoding) || '7bit',
    charset: node.parameters?.['charset'] ?? 'utf-8',
    size: node.size,
  };
}

/** Walk leaves in order without descending into attached messages. */
function forEachLeaf(node: MessageStructureObject, fn: (leaf: MessageStructureObject) => void): void {
  if (isMultipart(node) && node.childNodes) {
    for (const child of node.childNodes) forEachLeaf(child, fn);
    return;
  }
  fn(node);
}

function embeddedInfo(leaf: MessageStructureObject): AttachmentInfo['embedded'] {
  const env = leaf.envelope;
  if (!env || !isMessageRfc822(leaf)) return undefined;
  const from = env.from?.[0];
  const fromText = from ? (from.name ? `${from.name} <${from.address ?? ''}>` : (from.address ?? '')) : '';
  const date = env.date ? new Date(env.date) : null;
  return { from: fromText, subject: env.subject ?? '', date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null };
}

/** All attachments (see isAttachmentLeaf), in MIME order. */
export function collectAttachments(root: MessageStructureObject): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  forEachLeaf(root, (leaf) => {
    if (!isAttachmentLeaf(leaf)) return;
    const info: AttachmentInfo = {
      part: partNumber(leaf),
      filename: filenameOf(leaf),
      content_type: lower(leaf.type) || 'application/octet-stream',
      size: typeof leaf.size === 'number' ? leaf.size : null,
      encoding: lower(leaf.encoding) || '7bit',
      inline: isInlineImage(leaf),
      content_id: leaf.id ?? null,
    };
    const embedded = embeddedInfo(leaf);
    if (embedded) info.embedded = embedded;
    out.push(info);
  });
  return out;
}

/**
 * has_attachments in summaries: any attachment except embedded decorations (inline cid images such
 * as logos and trackers). Inline photos with a filename still count (see isLikelyInlinePhoto).
 */
export function hasRealAttachments(root: MessageStructureObject | undefined): boolean {
  if (!root) return false;
  let found = false;
  forEachLeaf(root, (leaf) => {
    if (found || !isAttachmentLeaf(leaf)) return;
    if (!isInlineImage(leaf) || isLikelyInlinePhoto(leaf)) found = true;
  });
  return found;
}

/**
 * Body parts to show for get_message (SPEC §5):
 * multipart/alternative prefers text/plain; multipart/related uses its root part; multipart/mixed
 * (and other multiparts) concatenates inline text parts in order; message/rfc822 is never descended.
 */
export function selectBodyParts(root: MessageStructureObject): TextPartRef[] {
  const select = (node: MessageStructureObject): TextPartRef[] => {
    if (!isMultipart(node)) {
      if (isAttachmentLeaf(node)) return [];
      const ref = textRef(node, '1');
      return ref ? [ref] : [];
    }
    const children = node.childNodes ?? [];
    const type = lower(node.type);
    if (type === 'multipart/alternative') {
      const candidates = children.map(select).filter((c) => c.length > 0);
      return candidates.find((c) => c.some((p) => p.type === 'text/plain')) ?? candidates[candidates.length - 1] ?? [];
    }
    if (type === 'multipart/related') {
      const start = node.parameters?.['start'];
      const rootPart = (start ? children.find((c) => c.id === start) : undefined) ?? children[0];
      return rootPart ? select(rootPart) : [];
    }
    return children.flatMap(select);
  };
  return select(root);
}

/** HTML parts that correspond to the message body (for include_html). */
export function selectHtmlParts(root: MessageStructureObject): TextPartRef[] {
  const select = (node: MessageStructureObject): TextPartRef[] => {
    if (!isMultipart(node)) {
      if (isAttachmentLeaf(node)) return [];
      const ref = textRef(node, '1');
      return ref && ref.type === 'text/html' ? [ref] : [];
    }
    const children = node.childNodes ?? [];
    const type = lower(node.type);
    if (type === 'multipart/alternative') {
      const candidates = children.map(select).filter((c) => c.length > 0);
      return candidates[candidates.length - 1] ?? [];
    }
    if (type === 'multipart/related') {
      const rootPart = children[0];
      return rootPart ? select(rootPart) : [];
    }
    return children.flatMap(select);
  };
  return select(root);
}

/** SPEC §5 snippets: first non-attachment text/plain leaf, else the first text/html leaf. Single-part => 'TEXT'. */
export function findSnippetPart(root: MessageStructureObject): TextPartRef | null {
  let plain: TextPartRef | null = null;
  let html: TextPartRef | null = null;
  forEachLeaf(root, (leaf) => {
    if (plain || isAttachmentLeaf(leaf)) return;
    const ref = textRef(leaf, 'TEXT');
    if (!ref) return;
    if (ref.type === 'text/plain') plain = ref;
    else html ??= ref;
  });
  return plain ?? html;
}

/** Find a node by part number ("1", "1.2"); the single-part root answers to "1". */
export function findPart(root: MessageStructureObject, part: string): MessageStructureObject | null {
  if (!root.part && !isMultipart(root) && part === '1') return root;
  let found: MessageStructureObject | null = null;
  const walk = (node: MessageStructureObject, insideMessage: boolean): void => {
    if (found) return;
    if (!insideMessage && node.part === part) {
      found = node;
      return;
    }
    // Parts of an attached message (message/rfc822) are addressed through the attachment itself.
    if (isMessageRfc822(node)) return;
    for (const child of node.childNodes ?? []) walk(child, insideMessage);
  };
  walk(root, false);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Decoding of partial bodyParts (imapflow does not decode them)
// ---------------------------------------------------------------------------------------------

function normalizeCharset(charset: string): string {
  const c = charset.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (c === '' || c === 'us-ascii' || c === 'ascii' || c === 'ansi_x3.4-1968') return 'utf-8';
  if (c === 'utf8') return 'utf-8';
  if (c === 'latin1' || c === 'latin-1') return 'iso-8859-1';
  return c;
}

export function decodeTransferEncoding(raw: Buffer, encoding: string): Buffer {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') {
    // Node decodes an incomplete final group to the bytes it fully determines, so a truncated
    // fetch needs no special handling beyond dropping line breaks and padding.
    const s = raw.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
    return Buffer.from(s, 'base64');
  }
  if (enc === 'quoted-printable') {
    const s = raw
      .toString('latin1')
      .replace(/=\r?\n/g, '')
      // a fetch cut mid-escape leaves "=" or "=X" at the very end
      .replace(/=[0-9A-Fa-f]?$/, '');
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 0x3d /* = */ && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(ch & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return raw;
}

export function decodeCharset(bytes: Buffer, charset: string): string {
  let text: string;
  try {
    text = new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(bytes);
  } catch {
    text = bytes.toString('utf8');
  }
  return text;
}

/** Decode a possibly truncated partial BODY[] fetch; never throws. */
export function decodePartialBody(raw: Buffer, encoding: string, charset: string): string {
  try {
    const text = decodeCharset(decodeTransferEncoding(raw, encoding), charset);
    // Drop a multi-byte character cut by the partial range.
    return text.replace(/�+$/, '');
  } catch {
    return '';
  }
}
