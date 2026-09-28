/**
 * Message reading (SPEC §5): summaries with snippets, structure-based full messages, attachment
 * discovery/download. Functions taking an `ImapFlow` must be called inside `withMailbox()`; they
 * only use numeric UIDs with a fresh `{ uid: true }` options object, and never nest commands
 * inside a fetch iterator (only `fetchAll`/`fetchOne`/`download` are used).
 */
import { unlink, type FileHandle } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FetchMessageObject, ImapFlow, MessageAddressObject, MessageStructureObject } from 'imapflow';
import { MailError } from '../errors.js';
import { formatDateISO, formatSize, htmlToPlainText, makeSnippet, stripHtmlCheap, toValidDate } from '../format.js';
import { createUniqueFile, fallbackAttachmentName, sanitizeFilename } from '../safety/paths.js';
import { sanitizeInline } from '../safety/untrusted.js';
import { formatAddress, type EmailAddress } from '../smtp/address.js';
import { flagState, type FlagColor, type FlagState } from './flags.js';
import {
  collectAttachments,
  decodePartialBody,
  findPart,
  findSnippetPart,
  hasRealAttachments,
  isMultipart,
  selectBodyParts,
  selectHtmlParts,
  type AttachmentInfo,
  type TextPartRef,
} from './mime.js';

export interface MessageSummary {
  mailbox: string;
  uid: number;
  date: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  unread: boolean;
  flagged: boolean;
  flag_color: FlagColor | null;
  answered: boolean;
  draft: boolean;
  has_attachments: boolean;
  size: string;
  snippet?: string;
}

/** Summary plus the data needed for merging and threading (not part of tool output). */
export interface SummaryRecord {
  summary: MessageSummary;
  /** Envelope Date, falling back to INTERNALDATE, as epoch ms (0 if unknown). */
  time: number;
  messageId: string | null;
  inReplyTo: string | null;
  flags: Set<string>;
}

export const SUMMARY_QUERY = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true } as const;

export const SNIPPET_MAX_BYTES_PLAIN = 2048;
/** HTML parts often start with a long <head>/<style>; fetch a little more so the snippet has text. */
export const SNIPPET_MAX_BYTES_HTML = 6144;

function addressList(list: MessageAddressObject[] | undefined): EmailAddress[] {
  return (list ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' })).filter((a) => a.address || a.name);
}

function renderAddresses(list: MessageAddressObject[] | undefined): string[] {
  return addressList(list).map((a) => sanitizeInline(formatAddress(a), 500));
}

export function messageTime(msg: Pick<FetchMessageObject, 'envelope' | 'internalDate'>): number {
  const d = toValidDate(msg.envelope?.date ?? null) ?? toValidDate(msg.internalDate ?? null);
  return d ? d.getTime() : 0;
}

export function toSummaryRecord(mailbox: string, msg: FetchMessageObject, timeZone: string): SummaryRecord {
  const time = messageTime(msg);
  const flags = msg.flags ?? new Set<string>();
  const state = flagState(flags);
  const subject = msg.envelope?.subject;
  return {
    summary: {
      mailbox,
      uid: msg.uid,
      date: time ? formatDateISO(new Date(time), timeZone) : null,
      from: renderAddresses(msg.envelope?.from)[0] ?? '',
      to: renderAddresses(msg.envelope?.to),
      cc: renderAddresses(msg.envelope?.cc),
      subject: subject ? sanitizeInline(subject, 1000) : '(no subject)',
      unread: state.unread,
      flagged: state.flagged,
      flag_color: state.flag_color,
      answered: state.answered,
      draft: state.draft,
      has_attachments: hasRealAttachments(msg.bodyStructure),
      size: formatSize(msg.size),
    },
    time,
    messageId: msg.envelope?.messageId ?? null,
    inReplyTo: msg.envelope?.inReplyTo ?? null,
    flags,
  };
}

/** Newest first: by date, then by UID. */
export function compareRecordsDesc(a: SummaryRecord, b: SummaryRecord): number {
  return b.time - a.time || b.summary.uid - a.summary.uid;
}

/**
 * Fetch summaries for `uids` (UIDs) in the selected mailbox, preserving the order of `uids`.
 * Messages that no longer exist are skipped.
 */
export async function fetchSummaryRecords(
  client: ImapFlow,
  mailbox: string,
  uids: readonly number[],
  options: { snippets: boolean; timeZone: string },
): Promise<SummaryRecord[]> {
  if (uids.length === 0) return [];
  const messages = await client.fetchAll([...uids], { ...SUMMARY_QUERY }, { uid: true });
  const byUid = new Map(messages.map((m) => [m.uid, m]));
  const ordered = uids.map((u) => byUid.get(u)).filter((m): m is FetchMessageObject => m !== undefined);
  const records = ordered.map((m) => toSummaryRecord(mailbox, m, options.timeZone));
  if (options.snippets) await attachSnippets(client, ordered, records);
  return records;
}

/** Fetch summaries by a sequence range computed from EXISTS (no-criteria fast path). */
export async function fetchSummaryRecordsBySeq(
  client: ImapFlow,
  mailbox: string,
  seqFrom: number,
  seqTo: number,
  options: { snippets: boolean; timeZone: string },
): Promise<SummaryRecord[]> {
  if (seqTo < seqFrom || seqFrom < 1) return [];
  // Sequence numbers here come from the server's own EXISTS count, never from user input.
  const messages = await client.fetchAll(`${seqFrom}:${seqTo}`, { ...SUMMARY_QUERY });
  const live = messages.filter((m) => !(m.flags && [...m.flags].some((f) => f.toLowerCase() === '\\deleted')));
  live.sort((a, b) => b.uid - a.uid);
  const records = live.map((m) => toSummaryRecord(mailbox, m, options.timeZone));
  if (options.snippets) await attachSnippets(client, live, records);
  return records;
}

/**
 * Snippets (SPEC §5): pick the snippet part from BODYSTRUCTURE, then one batched `fetchAll` per
 * distinct part key with a partial BODY.PEEK[part]<0.N>, decoded here.
 */
export async function attachSnippets(client: ImapFlow, messages: readonly FetchMessageObject[], records: readonly SummaryRecord[]): Promise<void> {
  const refs = new Map<number, TextPartRef>();
  const groups = new Map<string, number[]>();
  messages.forEach((m) => {
    if (!m.bodyStructure) return;
    const ref = findSnippetPart(m.bodyStructure);
    if (!ref) return;
    refs.set(m.uid, ref);
    const key = `${ref.part}|${ref.type === 'text/html' ? SNIPPET_MAX_BYTES_HTML : SNIPPET_MAX_BYTES_PLAIN}`;
    const list = groups.get(key) ?? [];
    list.push(m.uid);
    groups.set(key, list);
  });
  const raw = new Map<number, Buffer>();
  for (const [key, uids] of groups) {
    const [part = 'TEXT', maxStr = '2048'] = key.split('|');
    const fetched = await client.fetchAll(uids, { uid: true, bodyParts: [{ key: part, maxLength: Number(maxStr) }] }, { uid: true });
    for (const m of fetched) {
      const buf = m.bodyParts?.get(part.toLowerCase());
      if (buf) raw.set(m.uid, buf);
    }
  }
  for (const record of records) {
    const ref = refs.get(record.summary.uid);
    const buf = raw.get(record.summary.uid);
    if (!ref || !buf) {
      record.summary.snippet = '';
      continue;
    }
    let text = decodePartialBody(buf, ref.encoding, ref.charset);
    if (ref.type === 'text/html') text = stripHtmlCheap(text);
    record.summary.snippet = sanitizeInline(makeSnippet(text, 160), 200);
  }
}

// ---------------------------------------------------------------------------------------------
// Full message
// ---------------------------------------------------------------------------------------------

export const MESSAGE_HEADER_FIELDS = ['references', 'in-reply-to', 'reply-to', 'list-id', 'list-unsubscribe', 'message-id'] as const;

/** Parse a raw header block (as returned for `headers: [...]`) into lowercase name -> unfolded values. */
export function parseHeaderBlock(raw: Buffer | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!raw) return out;
  const text = raw.toString('utf8').replace(/\r\n/g, '\n');
  const unfolded = text.replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const list = out.get(name) ?? [];
    list.push(value);
    out.set(name, list);
  }
  return out;
}

/** Extract `<id>` tokens from a References / In-Reply-To style header. */
export function extractMessageIds(value: string | undefined | null): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  const bare = value.trim();
  return bare && !/\s/.test(bare) ? [`<${bare.replace(/^<|>$/g, '')}>`] : [];
}

export interface MessageAddresses {
  from: EmailAddress[];
  sender: EmailAddress[];
  replyTo: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
}

export interface FullMessage {
  mailbox: string;
  uid: number;
  messageId: string | null;
  /** ISO date in MAIL_TIMEZONE (envelope Date, else INTERNALDATE). */
  date: string | null;
  /** Epoch ms of the same date (0 if unknown). */
  time: number;
  /** Decoded subject as sent ('' if none). */
  subject: string;
  addresses: MessageAddresses;
  flags: FlagState;
  rawFlags: string[];
  size: number | null;
  listId: string | null;
  listUnsubscribe: string | null;
  inReplyTo: string | null;
  references: string[];
  attachments: AttachmentInfo[];
  /** Body text (untruncated up to the download cap; callers truncate for display). */
  bodyText: string;
  bodyFormat: 'text/plain' | 'text/html' | 'mixed' | 'none';
  /** Raw HTML of the body, only when requested. */
  html: string | null;
  bodyStructure: MessageStructureObject | undefined;
}

/** Cap for downloading one body text part (decoded bytes). */
export const MAX_TEXT_PART_BYTES = 4 * 1024 * 1024;

export async function streamToBuffer(stream: Readable, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new MailError('TOO_LARGE', `Content exceeds the limit of ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

async function downloadText(client: ImapFlow, uid: number, ref: TextPartRef): Promise<string> {
  const part = ref.part === 'TEXT' ? '1' : ref.part;
  const dl = await client.download(String(uid), part, { uid: true, maxBytes: MAX_TEXT_PART_BYTES });
  if (!dl.content) return '';
  const buf = await streamToBuffer(dl.content);
  // download() decodes transfer encoding and converts text charsets to UTF-8.
  return buf.toString('utf8');
}

export function messageNotFound(mailbox: string, uid: number): MailError {
  return new MailError(
    'NOT_FOUND',
    `No message with UID ${uid} in "${mailbox}". It may have been moved or deleted (UIDs change when a message moves to another mailbox); search again to get current UIDs.`,
  );
}

/**
 * Read a full message structure-first (SPEC §5): envelope, flags, BODYSTRUCTURE, selected headers,
 * then download only the chosen text parts (never attachment bytes).
 */
export async function fetchFullMessage(
  client: ImapFlow,
  mailbox: string,
  uid: number,
  options: { timeZone: string; includeHtml?: boolean },
): Promise<FullMessage> {
  const msg = await client.fetchOne(
    String(uid),
    { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: [...MESSAGE_HEADER_FIELDS] },
    { uid: true },
  );
  if (!msg || msg.uid !== uid) throw messageNotFound(mailbox, uid);
  const headers = parseHeaderBlock(msg.headers);
  const root = msg.bodyStructure;
  const attachments = root ? collectAttachments(root) : [];
  const parts = root ? selectBodyParts(root) : [];

  const texts: string[] = [];
  for (const ref of parts) {
    const content = await downloadText(client, uid, ref);
    texts.push(ref.type === 'text/html' ? htmlToPlainText(content) : content.replace(/\r\n?/g, '\n'));
  }
  const kinds = new Set(parts.map((p) => p.type));
  const bodyFormat: FullMessage['bodyFormat'] = parts.length === 0 ? 'none' : kinds.size > 1 ? 'mixed' : (parts[0]?.type ?? 'none');

  let html: string | null = null;
  if (options.includeHtml && root) {
    const htmlParts = selectHtmlParts(root);
    if (htmlParts.length) {
      const pieces: string[] = [];
      for (const ref of htmlParts) pieces.push(await downloadText(client, uid, ref));
      html = pieces.join('\n');
    }
  }

  const time = messageTime(msg);
  const env = msg.envelope;
  const refs = headers.get('references')?.flatMap((v) => extractMessageIds(v)) ?? [];
  const inReplyTo = env?.inReplyTo ? (extractMessageIds(env.inReplyTo)[0] ?? env.inReplyTo) : (extractMessageIds(headers.get('in-reply-to')?.[0])[0] ?? null);
  const messageId = env?.messageId ? (extractMessageIds(env.messageId)[0] ?? env.messageId) : (extractMessageIds(headers.get('message-id')?.[0])[0] ?? null);
  return {
    mailbox,
    uid,
    messageId,
    date: time ? formatDateISO(new Date(time), options.timeZone) : null,
    time,
    subject: env?.subject ?? '',
    addresses: {
      from: addressList(env?.from),
      sender: addressList(env?.sender),
      replyTo: addressList(env?.replyTo),
      to: addressList(env?.to),
      cc: addressList(env?.cc),
      bcc: addressList(env?.bcc),
    },
    flags: flagState(msg.flags),
    rawFlags: [...(msg.flags ?? [])],
    size: typeof msg.size === 'number' ? msg.size : null,
    listId: headers.get('list-id')?.[0] ?? null,
    listUnsubscribe: headers.get('list-unsubscribe')?.[0] ?? null,
    inReplyTo,
    references: refs,
    attachments,
    bodyText: texts.join('\n\n').replace(/\n{4,}/g, '\n\n\n'),
    bodyFormat,
    html,
    bodyStructure: root,
  };
}

// ---------------------------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------------------------

/** Rough decoded size from the encoded BODYSTRUCTURE size. */
export function estimateDecodedSize(att: Pick<AttachmentInfo, 'size'>, encoding: string | undefined): number {
  const size = att.size ?? 0;
  return (encoding ?? '').toLowerCase() === 'base64' ? Math.floor((size * 3) / 4) : size;
}

export interface ResolvedPart {
  node: MessageStructureObject;
  info: AttachmentInfo;
}

/** Validate `part` against the message's BODYSTRUCTURE (exists, not a multipart container). */
export async function resolveAttachmentPart(client: ImapFlow, mailbox: string, uid: number, part: string): Promise<ResolvedPart> {
  if (!/^\d+(\.\d+)*$/.test(part)) {
    throw new MailError('INVALID_INPUT', `Invalid part "${part}". Use a part number such as "2" or "1.2" from get_message's attachment list.`);
  }
  const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  if (!msg || msg.uid !== uid || !msg.bodyStructure) throw messageNotFound(mailbox, uid);
  const node = findPart(msg.bodyStructure, part);
  if (!node) {
    const available = collectAttachments(msg.bodyStructure).map((a) => a.part);
    throw new MailError(
      'NOT_FOUND',
      `Message ${uid} has no part "${part}".${available.length ? ` Attachment parts: ${available.join(', ')}.` : ' It has no attachments.'}`,
    );
  }
  if (isMultipart(node)) throw new MailError('INVALID_INPUT', `Part "${part}" is a multipart container, not an attachment.`);
  const info = collectAttachments(msg.bodyStructure).find((a) => a.part === part) ?? {
    part,
    filename: null,
    content_type: (node.type || 'application/octet-stream').toLowerCase(),
    size: typeof node.size === 'number' ? node.size : null,
    inline: false,
    content_id: node.id ?? null,
  };
  return { node, info };
}

export interface DownloadedFile {
  path: string;
  filename: string;
  size: number;
  content_type: string;
  /** charset parameter of the part, if any (attachments are saved undecoded). */
  charset: string | null;
  /** File content when it is at most `captureUpTo` bytes. */
  content?: Buffer;
}

class ByteLimiter extends Transform {
  total = 0;
  captured: Buffer[] | null;
  constructor(
    private readonly limit: number,
    private readonly captureUpTo: number,
  ) {
    super();
    this.captured = captureUpTo > 0 ? [] : null;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.total += chunk.length;
    if (this.total > this.limit) {
      cb(new MailError('TOO_LARGE', `Attachment exceeds MAIL_MAX_ATTACHMENT_MB (${Math.round(this.limit / 1048576)} MB).`));
      return;
    }
    if (this.captured) {
      if (this.total <= this.captureUpTo) this.captured.push(chunk);
      else this.captured = null;
    }
    cb(null, chunk);
  }
}

/**
 * Stream one attachment part into `dir` under a sanitised, collision-free name (never overwrites;
 * realpath-confined), enforcing `maxBytes` on the decoded content.
 */
export async function downloadPartToDir(
  client: ImapFlow,
  mailbox: string,
  uid: number,
  part: string,
  options: { dir: string; maxBytes: number; captureUpTo?: number },
): Promise<DownloadedFile> {
  const { node, info } = await resolveAttachmentPart(client, mailbox, uid, part);
  const estimate = estimateDecodedSize(info, node.encoding);
  if (estimate > options.maxBytes) {
    throw new MailError(
      'TOO_LARGE',
      `Attachment part ${part} is about ${formatSize(estimate)}, above the MAIL_MAX_ATTACHMENT_MB limit (${formatSize(options.maxBytes)}).`,
    );
  }
  const filename = sanitizeFilename(info.filename) ?? fallbackAttachmentName(uid, part, info.content_type);
  const dl = await client.download(String(uid), part, { uid: true, maxBytes: options.maxBytes + 1, chunkSize: 256 * 1024 });
  if (!dl.content) throw new MailError('NOT_FOUND', `Part ${part} of message ${uid} could not be downloaded.`);
  let file: { path: string; handle: FileHandle } | undefined;
  try {
    file = await createUniqueFile(options.dir, filename);
    const limiter = new ByteLimiter(options.maxBytes, options.captureUpTo ?? 0);
    await pipeline(dl.content, limiter, file.handle.createWriteStream());
    const result: DownloadedFile = {
      path: file.path,
      filename: file.path.split(/[\\/]/).pop() ?? filename,
      size: limiter.total,
      content_type: info.content_type,
      charset: node.parameters?.['charset'] ?? null,
    };
    if (limiter.captured) result.content = Buffer.concat(limiter.captured);
    return result;
  } catch (err) {
    dl.content.destroy();
    if (file) {
      await file.handle.close().catch(() => undefined);
      await unlink(file.path).catch(() => undefined);
    }
    throw err;
  }
}

export interface AttachmentBuffer {
  filename: string;
  contentType: string;
  content: Buffer;
  cid: string | null;
  inline: boolean;
}

/**
 * Download all attachments of a message into memory (for forwarding), within `maxTotalBytes`.
 * Fails clearly instead of silently dropping attachments when the total is too large.
 */
export async function fetchAttachmentBuffers(client: ImapFlow, mailbox: string, uid: number, maxTotalBytes: number): Promise<AttachmentBuffer[]> {
  const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
  if (!msg || msg.uid !== uid || !msg.bodyStructure) throw messageNotFound(mailbox, uid);
  const root = msg.bodyStructure;
  const atts = collectAttachments(root);
  const estimated = atts.reduce((sum, a) => sum + estimateDecodedSize(a, findPart(root, a.part)?.encoding), 0);
  if (estimated > maxTotalBytes) {
    throw new MailError(
      'TOO_LARGE',
      `The original's attachments total about ${formatSize(estimated)}, above the ${formatSize(maxTotalBytes)} that can be sent (iCloud's 20 MB message limit after encoding). Forward without attachments (include_attachments: false) or download and share them another way.`,
    );
  }
  const out: AttachmentBuffer[] = [];
  let used = 0;
  for (const a of atts) {
    const remaining = maxTotalBytes - used;
    const dl = await client.download(String(uid), a.part, { uid: true, maxBytes: remaining + 1, chunkSize: 256 * 1024 });
    if (!dl.content) throw new MailError('NOT_FOUND', `Attachment part ${a.part} of message ${uid} could not be downloaded.`);
    let content: Buffer;
    try {
      content = await streamToBuffer(dl.content, remaining);
    } catch (err) {
      if (err instanceof MailError && err.code === 'TOO_LARGE') {
        throw new MailError('TOO_LARGE', `The original's attachments exceed the ${formatSize(maxTotalBytes)} that can be sent. Forward without attachments instead.`);
      }
      throw err;
    }
    used += content.length;
    const filename =
      sanitizeFilename(a.filename) ?? (a.content_type === 'message/rfc822' ? `forwarded-message-${a.part}.eml` : fallbackAttachmentName(uid, a.part, a.content_type));
    out.push({ filename, contentType: a.content_type, content, cid: a.content_id, inline: a.inline });
  }
  return out;
}
