/**
 * Message reading (SPEC §5): summaries with snippets, structure-based full messages, attachment
 * discovery/download. Functions taking an `ImapFlow` must be called inside `withMailbox()`; they
 * only use numeric UIDs with a fresh `{ uid: true }` options object, and never nest commands
 * inside a fetch iterator (only `fetchAll`/`fetchOne`/`download` are used).
 */
import { unlink, type FileHandle } from 'node:fs/promises';
import { Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FetchMessageObject, ImapFlow, MessageAddressObject, MessageStructureObject } from 'imapflow';
import { MailError } from '../errors.js';
import { decodedSizeEstimate, formatDateISO, formatSize, htmlToPlainText, makeSnippet, stripHtmlCheap, toValidDate } from '../format.js';
import { attachmentSaveError, createUniqueFile, fallbackAttachmentName, sanitizeFilename } from '../safety/paths.js';
import { sanitizeInline } from '../safety/untrusted.js';
import { displayName, formatAddressForDisplay, type EmailAddress } from '../smtp/address.js';
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
import { toSequenceSet } from './uids.js';

/**
 * Search/thread summary (SPEC §5). To keep results small, `cc` appears only when non-empty,
 * `flagged`, `flag_color`, `answered` and `draft` only when set, and at most SUMMARY_MAX_ADDRESSES
 * To/Cc addresses are listed (`to_count`/`cc_count` then give the full number; get_message shows all).
 */
export interface MessageSummary {
  mailbox: string;
  uid: number;
  date: string | null;
  from: string;
  to: string[];
  to_count?: number;
  cc?: string[];
  cc_count?: number;
  subject: string;
  unread: boolean;
  flagged?: true;
  flag_color?: FlagColor;
  answered?: true;
  draft?: true;
  has_attachments: boolean;
  size: string;
  snippet?: string;
}

export const SUMMARY_MAX_ADDRESSES = 5;

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

/**
 * Envelope addresses with display names made safe once, for every consumer (display, reply
 * recipients, attribution lines): no CR/LF from encoded-words, no invisible characters, capped.
 */
export function addressList(list: MessageAddressObject[] | undefined): EmailAddress[] {
  return (list ?? []).map((a) => ({ name: displayName(a.name ?? '', 256), address: (a.address ?? '').trim() })).filter((a) => a.address || a.name);
}

/** Addresses for display: the address is never cut, only the (sanitised) name is capped. */
export function renderAddress(a: EmailAddress): string {
  return sanitizeInline(formatAddressForDisplay(a, 100), 2000);
}

function renderAddresses(list: MessageAddressObject[] | undefined): string[] {
  return addressList(list).map(renderAddress);
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
  const to = renderAddresses(msg.envelope?.to);
  const cc = renderAddresses(msg.envelope?.cc);
  const summary: MessageSummary = {
    mailbox,
    uid: msg.uid,
    date: time ? formatDateISO(new Date(time), timeZone) : null,
    from: renderAddresses(msg.envelope?.from)[0] ?? '',
    to: to.slice(0, SUMMARY_MAX_ADDRESSES),
    subject: subject ? sanitizeInline(subject, 1000) : '(no subject)',
    unread: state.unread,
    has_attachments: hasRealAttachments(msg.bodyStructure),
    size: formatSize(msg.size),
  };
  if (to.length > SUMMARY_MAX_ADDRESSES) summary.to_count = to.length;
  if (cc.length) summary.cc = cc.slice(0, SUMMARY_MAX_ADDRESSES);
  if (cc.length > SUMMARY_MAX_ADDRESSES) summary.cc_count = cc.length;
  if (state.flagged) summary.flagged = true;
  if (state.flag_color) summary.flag_color = state.flag_color;
  if (state.answered) summary.answered = true;
  if (state.draft) summary.draft = true;
  // Keep a stable key order (snippet last), as before.
  const ordered: MessageSummary = {
    mailbox: summary.mailbox,
    uid: summary.uid,
    date: summary.date,
    from: summary.from,
    to: summary.to,
    ...(summary.to_count !== undefined ? { to_count: summary.to_count } : {}),
    ...(summary.cc ? { cc: summary.cc } : {}),
    ...(summary.cc_count !== undefined ? { cc_count: summary.cc_count } : {}),
    subject: summary.subject,
    unread: summary.unread,
    ...(summary.flagged ? { flagged: true as const } : {}),
    ...(summary.flag_color ? { flag_color: summary.flag_color } : {}),
    ...(summary.answered ? { answered: true as const } : {}),
    ...(summary.draft ? { draft: true as const } : {}),
    has_attachments: summary.has_attachments,
    size: summary.size,
  };
  return {
    summary: ordered,
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
  const messages = await client.fetchAll(toSequenceSet(uids), { ...SUMMARY_QUERY }, { uid: true });
  const byUid = new Map(messages.map((m) => [m.uid, m]));
  const ordered = uids.map((u) => byUid.get(u)).filter((m): m is FetchMessageObject => m !== undefined);
  const records = ordered.map((m) => toSummaryRecord(mailbox, m, options.timeZone));
  if (options.snippets) await attachSnippets(client, ordered, records);
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
    const fetched = await client.fetchAll(toSequenceSet(uids), { uid: true, bodyParts: [{ key: part, maxLength: Number(maxStr) }] }, { uid: true });
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
  // The IMAP ENVELOPE copies From into reply-to when the header is absent; only report a Reply-To
  // the message really has, so a differing one (a phishing sign) stands out.
  const hasReplyToHeader = (headers.get('reply-to') ?? []).some((v) => v.trim() !== '');
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
      replyTo: hasReplyToHeader ? addressList(env?.replyTo) : [],
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

/** Decoded size estimated from the encoded BODYSTRUCTURE size (see decodedSizeEstimate). */
export function estimateDecodedSize(att: Pick<AttachmentInfo, 'size'>, encoding: string | undefined): number {
  return decodedSizeEstimate(att.size ?? 0, encoding);
}

export interface ResolvedPart {
  node: MessageStructureObject;
  info: AttachmentInfo;
  /** Message-ID of the message the part belongs to. */
  messageId: string | null;
}

/** Validate `part` against the message's BODYSTRUCTURE (exists, not a multipart container). */
export async function resolveAttachmentPart(client: ImapFlow, mailbox: string, uid: number, part: string): Promise<ResolvedPart> {
  if (!/^\d+(\.\d+)*$/.test(part)) {
    throw new MailError('INVALID_INPUT', `Invalid part "${part}". Use a part number such as "2" or "1.2" from get_message's attachment list.`);
  }
  const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true, envelope: true }, { uid: true });
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
    encoding: (node.encoding ?? '7bit').toLowerCase(),
    inline: false,
    content_id: node.id ?? null,
  };
  const messageId = msg.envelope?.messageId ? (extractMessageIds(msg.envelope.messageId)[0] ?? msg.envelope.messageId) : null;
  return { node, info, messageId };
}

export interface DownloadedFile {
  path: string;
  filename: string;
  size: number;
  content_type: string;
  /**
   * Charset of the saved bytes. imapflow converts inline (or disposition-less) text/plain and
   * text/html parts to UTF-8 while downloading (and then reports 'utf-8'); disposition=attachment
   * parts are saved as the original bytes in their declared charset.
   */
  charset: string | null;
  /** Message-ID of the message the attachment belongs to. */
  messageId: string | null;
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
  const { node, info, messageId } = await resolveAttachmentPart(client, mailbox, uid, part);
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
      // What imapflow actually delivered (it converts inline text parts to UTF-8).
      charset: dl.meta?.charset ?? node.parameters?.['charset'] ?? null,
      messageId,
    };
    if (limiter.captured) result.content = Buffer.concat(limiter.captured);
    return result;
  } catch (err) {
    dl.content.destroy();
    if (file) {
      await file.handle.close().catch(() => undefined);
      await unlink(file.path).catch(() => undefined);
    }
    // A local file-system problem (macOS privacy denial, full disk, bad folder) is not an IMAP error.
    throw attachmentSaveError(err, options.dir) ?? err;
  }
}

/**
 * Cloud version (no disk): read one attachment part into memory instead of saving it.
 * `captureFor(contentType)` says how many bytes of content are worth returning for that type
 * (0 = none: the part is not downloaded at all, and `size` is estimated from the structure).
 * `path` is always ''.
 */
export async function downloadPartToMemory(
  client: ImapFlow,
  mailbox: string,
  uid: number,
  part: string,
  options: { maxBytes: number; captureFor: (contentType: string) => number },
): Promise<DownloadedFile> {
  const { node, info, messageId } = await resolveAttachmentPart(client, mailbox, uid, part);
  const estimate = estimateDecodedSize(info, node.encoding);
  if (estimate > options.maxBytes) {
    throw new MailError(
      'TOO_LARGE',
      `Attachment part ${part} is about ${formatSize(estimate)}, above the MAIL_MAX_ATTACHMENT_MB limit (${formatSize(options.maxBytes)}).`,
    );
  }
  const filename = sanitizeFilename(info.filename) ?? fallbackAttachmentName(uid, part, info.content_type);
  const base: DownloadedFile = { path: '', filename, size: estimate, content_type: info.content_type, charset: node.parameters?.['charset'] ?? null, messageId };
  const captureUpTo = options.captureFor(info.content_type);
  // Too big to return (the estimate is close: base64 is decoded, quoted-printable only shrinks).
  if (captureUpTo <= 0 || estimate > captureUpTo * 1.05) return base;
  const dl = await client.download(String(uid), part, { uid: true, maxBytes: options.maxBytes + 1, chunkSize: 256 * 1024 });
  if (!dl.content) throw new MailError('NOT_FOUND', `Part ${part} of message ${uid} could not be downloaded.`);
  const limiter = new ByteLimiter(options.maxBytes, captureUpTo);
  const discard = new Writable({ write: (_chunk, _enc, cb) => cb() });
  try {
    await pipeline(dl.content, limiter, discard);
  } catch (err) {
    dl.content.destroy();
    throw err;
  }
  const result: DownloadedFile = { ...base, size: limiter.total, charset: dl.meta?.charset ?? base.charset };
  if (limiter.captured) result.content = Buffer.concat(limiter.captured);
  return result;
}

export interface AttachmentBuffer {
  filename: string;
  /** Content-Type with the parameters that matter for the recipient (charset, method). */
  contentType: string;
  content: Buffer;
  cid: string | null;
  inline: boolean;
}

const SAFE_CHARSET = /^[A-Za-z0-9._:+-]{1,40}$/;
const SAFE_METHOD = /^[A-Za-z-]{1,20}$/;

/**
 * Content-Type for re-attaching a part: the bare type plus `charset` for text (what imapflow
 * delivered: 'utf-8' after it converted an inline text part, else the original charset) and
 * `method` for calendar invitations. format=flowed is not carried: imapflow already unwrapped it.
 */
export function forwardedContentType(bare: string, node: MessageStructureObject | null, deliveredCharset: string | undefined): string {
  const params: string[] = [];
  if (bare.startsWith('text/')) {
    const cs = deliveredCharset ?? node?.parameters?.['charset'];
    if (cs && SAFE_CHARSET.test(cs)) params.push(`charset=${cs.toLowerCase()}`);
  }
  if (bare === 'text/calendar') {
    const method = node?.parameters?.['method'];
    if (method && SAFE_METHOD.test(method)) params.push(`method=${method.toUpperCase()}`);
  }
  return [bare, ...params].join('; ');
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
  const estimated = atts.reduce((sum, a) => sum + estimateDecodedSize(a, a.encoding), 0);
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
    const contentType = forwardedContentType(a.content_type, findPart(root, a.part), dl.meta?.charset);
    out.push({ filename, contentType, content, cid: a.content_id, inline: a.inline });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Attached messages (message/rfc822)
// ---------------------------------------------------------------------------------------------

/**
 * Text of a message attached as message/rfc822 ("Forward as Attachment", bounce reports): its
 * From/To/Cc/Date/Subject from BODYSTRUCTURE plus its text body, downloaded part by part. The
 * caller wraps it as untrusted content.
 */
export async function readEmbeddedMessage(client: ImapFlow, uid: number, part: string, node: MessageStructureObject, timeZone: string): Promise<string> {
  const env = node.envelope;
  const lines: string[] = ['Attached message:'];
  const push = (label: string, value: string): void => {
    if (value) lines.push(`${label}: ${value}`);
  };
  if (env) {
    push('From', addressList(env.from).map(renderAddress).join(', '));
    push('To', addressList(env.to).map(renderAddress).join(', '));
    push('Cc', addressList(env.cc).map(renderAddress).join(', '));
    push('Date', formatDateISO(env.date ?? null, timeZone) ?? '');
    push('Subject', env.subject ? sanitizeInline(env.subject, 1000) : '(no subject)');
  }
  const child = node.childNodes?.[0];
  const refs: TextPartRef[] = [];
  if (child) {
    if (isMultipart(child)) {
      refs.push(...selectBodyParts(child));
    } else {
      const type = (child.type ?? '').toLowerCase();
      if (type === 'text/plain' || type === 'text/html') {
        // imapflow numbers a single-part embedded body like its parent; IMAP addresses it as <part>.1.
        const sub = !child.part || child.part === part ? `${part}.1` : child.part;
        refs.push({ part: sub, type, encoding: (child.encoding ?? '7bit').toLowerCase(), charset: child.parameters?.['charset'] ?? 'utf-8', size: child.size });
      }
    }
  }
  const texts: string[] = [];
  for (const ref of refs) {
    const content = await downloadText(client, uid, ref);
    texts.push(ref.type === 'text/html' ? htmlToPlainText(content) : content.replace(/\r\n?/g, '\n'));
  }
  lines.push('', texts.join('\n\n').trim() || '(the attached message has no text body)');
  return lines.join('\n');
}
