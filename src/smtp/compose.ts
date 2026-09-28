/**
 * Message composition (SPEC §6.4, §6.6): recipients and From validation, attachment loading,
 * MailComposer builds (file/URL access disabled), and reply/forward construction.
 */
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { MailComposerAttachment, MailComposerOptions } from 'nodemailer/lib/mail-composer';
import type { Config } from '../config.js';
import { MailError } from '../errors.js';
import { formatDateHuman, formatSize, normalizeNewlines } from '../format.js';
import { readAllowedFile, resolveAllowedFile, type PathContext } from '../safety/paths.js';
import { dedupeAddresses, domainOf, formatAddress, parseAddressInputs, parseAddressString, type EmailAddress } from './address.js';

export * from './address.js';

/** Outgoing attachments must total <= 14 MB (iCloud's 20 MB message limit after base64). */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 14 * 1024 * 1024;
/** iCloud's per-message limit. */
export const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
export const MAX_QUOTED_CHARS = 20_000;
export const MAX_REFERENCES = 20;

export interface OutgoingAttachment {
  filename: string;
  content: Buffer;
  contentType?: string | undefined;
  cid?: string | undefined;
}

export interface OutgoingMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo?: EmailAddress[] | undefined;
  subject: string;
  text: string;
  html?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachments: OutgoingAttachment[];
}

export interface BuiltMessage {
  messageId: string;
  date: Date;
  /** SMTP envelope: MAIL FROM and every To/Cc/Bcc recipient. */
  envelope: { from: string; to: string[] };
  /** Bytes for SMTP: no Bcc header. */
  raw: Buffer;
  /** Same message (same Message-ID, Date, boundaries) with the Bcc header, for Sent/Drafts. */
  rawWithBcc: Buffer;
  message: OutgoingMessage;
}

// eslint-disable-next-line no-control-regex
const HEADER_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

export function cleanSubject(subject: string | undefined): string {
  return (subject ?? '').replace(/\r\n?|\n/g, ' ').replace(HEADER_UNSAFE, '').trim().slice(0, 998);
}

/**
 * Resolve the From address: explicit input must be in the allowed set (case-insensitive); default
 * is `preferred` (e.g. the alias a replied-to message was sent to) or MAIL_FROM_ADDRESS.
 */
export function resolveFrom(input: string | undefined, config: Pick<Config, 'allowedFrom' | 'fromAddress' | 'fromName'>, preferred?: string): EmailAddress {
  const allowedList = config.allowedFrom.join(', ') || '(none configured)';
  const lookup = (address: string): string | undefined => config.allowedFrom.find((a) => a.toLowerCase() === address.toLowerCase());
  if (input !== undefined && input.trim() !== '') {
    const parsed = parseAddressString(input, 'from');
    if (parsed.length !== 1) throw new MailError('INVALID_INPUT', 'from must be a single address.');
    const one = parsed[0] as EmailAddress;
    const allowed = lookup(one.address);
    if (!allowed) {
      throw new MailError(
        'FORBIDDEN',
        `From address ${one.address} is not allowed. Allowed From addresses: ${allowedList}. (iCloud only sends from your own addresses and aliases; add more with MAIL_ALLOWED_FROM.)`,
      );
    }
    return { name: one.name || config.fromName || '', address: allowed };
  }
  const chosen = (preferred && lookup(preferred)) || config.fromAddress;
  if (!chosen) throw new MailError('CONFIG', 'No From address is configured (set ICLOUD_EMAIL or MAIL_FROM_ADDRESS).');
  return { name: config.fromName ?? '', address: chosen };
}

export interface RecipientInput {
  to?: readonly string[] | undefined;
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
}

export interface Recipients {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
}

/** Validate, dedupe case-insensitively across To/Cc/Bcc (first occurrence wins), enforce the maximum. */
export function normalizeRecipients(input: RecipientInput, maxRecipients: number, options: { requireTo?: boolean } = {}): Recipients {
  return finalizeRecipients(
    { to: parseAddressInputs(input.to, 'to'), cc: parseAddressInputs(input.cc, 'cc'), bcc: parseAddressInputs(input.bcc, 'bcc') },
    maxRecipients,
    options,
  );
}

export function finalizeRecipients(r: Recipients, maxRecipients: number, options: { requireTo?: boolean } = {}): Recipients {
  const seen = new Set<string>();
  const to = dedupeAddresses(r.to, seen);
  const cc = dedupeAddresses(r.cc, seen);
  const bcc = dedupeAddresses(r.bcc, seen);
  const total = to.length + cc.length + bcc.length;
  if (options.requireTo && total === 0) throw new MailError('INVALID_INPUT', 'At least one recipient is required.');
  if (total > maxRecipients) {
    throw new MailError('INVALID_INPUT', `Too many recipients: ${total} (To+Cc+Bcc). The limit is ${maxRecipients} (MAIL_MAX_RECIPIENTS; iCloud's hard limit is 500).`);
  }
  return { to, cc, bcc };
}

/** Read local files the model asked to attach, confined to MAIL_ATTACH_FROM_DIRS, within the size budget. */
export async function loadAttachments(
  paths: readonly string[] | undefined,
  allowedDirs: readonly string[],
  budgetBytes: number = MAX_OUTGOING_ATTACHMENT_BYTES,
  ctx?: PathContext,
): Promise<OutgoingAttachment[]> {
  if (!paths || paths.length === 0) return [];
  const resolved = [];
  let total = 0;
  for (const p of paths) {
    const file = await resolveAllowedFile(p, allowedDirs, ctx);
    total += file.size;
    if (total > budgetBytes) {
      throw new MailError('TOO_LARGE', `Attachments total more than ${formatSize(budgetBytes)} (iCloud's 20 MB message limit after encoding). Remove or shrink some attachments.`);
    }
    resolved.push(file);
  }
  const out: OutgoingAttachment[] = [];
  let used = 0;
  for (const file of resolved) {
    const content = await readAllowedFile(file, budgetBytes - used);
    used += content.length;
    out.push({ filename: file.name, content });
  }
  return out;
}

function toComposerAttachment(a: OutgoingAttachment): MailComposerAttachment {
  const att: MailComposerAttachment = { filename: a.filename, content: a.content };
  if (a.contentType) att.contentType = a.contentType;
  if (a.cid) att.cid = a.cid;
  return att;
}

/** Message-ID in the From address's domain. */
export function newMessageId(fromAddress: string): string {
  return `<${randomUUID()}@${domainOf(fromAddress) || 'localhost'}>`;
}

/**
 * Build the message once and render it twice: without Bcc (SMTP) and with Bcc (Sent copy / Drafts).
 * Both renders share Message-ID, Date and MIME boundaries. File and URL access are disabled.
 */
export async function buildMessage(msg: OutgoingMessage, options: { date?: Date; messageId?: string } = {}): Promise<BuiltMessage> {
  const date = options.date ?? new Date();
  const messageId = options.messageId ?? newMessageId(msg.from.address);
  const mail: MailComposerOptions = {
    from: msg.from,
    to: msg.to,
    cc: msg.cc.length ? msg.cc : undefined,
    bcc: msg.bcc.length ? msg.bcc : undefined,
    replyTo: msg.replyTo && msg.replyTo.length ? msg.replyTo : undefined,
    subject: cleanSubject(msg.subject),
    text: normalizeNewlines(msg.text),
    html: msg.html !== undefined ? normalizeNewlines(msg.html) : undefined,
    attachments: msg.attachments.map(toComposerAttachment),
    inReplyTo: msg.inReplyTo,
    references: msg.references && msg.references.length ? msg.references : undefined,
    messageId,
    date,
    newline: 'windows',
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  const node = new MailComposer(mail).compile();
  const envelope = node.getEnvelope();
  node.keepBcc = false;
  const raw = await node.build();
  node.keepBcc = true;
  const rawWithBcc = await node.build();
  if (rawWithBcc.length > MAX_MESSAGE_BYTES) {
    throw new MailError('TOO_LARGE', `The message is ${formatSize(rawWithBcc.length)}, above iCloud's 20 MB limit. Remove or shrink attachments.`);
  }
  const envFrom = typeof envelope.from === 'string' ? envelope.from : msg.from.address;
  return { messageId: node.messageId(), date, envelope: { from: envFrom, to: [...envelope.to] }, raw, rawWithBcc, message: msg };
}

// ---------------------------------------------------------------------------------------------
// Replies and forwards
// ---------------------------------------------------------------------------------------------

/** Data from the original message needed to reply/forward. */
export interface OriginalMessage {
  messageId: string | null;
  references: string[];
  subject: string;
  time: number;
  from: EmailAddress[];
  replyTo: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Plain-text body (already converted from HTML where needed). */
  text: string;
}

const REPLY_PREFIX = /^\s*(re|aw|sv|antw)\s*(\[\d+\])?\s*:/i;
const FORWARD_PREFIX = /^\s*(fwd?|fw)\s*(\[\d+\])?\s*:/i;

export function replySubject(subject: string): string {
  const s = cleanSubject(subject);
  return REPLY_PREFIX.test(s) ? s : `Re: ${s}`.trimEnd();
}

export function forwardSubject(subject: string): string {
  const s = cleanSubject(subject);
  return FORWARD_PREFIX.test(s) ? s : `Fwd: ${s}`.trimEnd();
}

/**
 * Reply recipients (SPEC §6.6 #16): To = Reply-To else From; reply-all adds the original To (to To)
 * and Cc (to Cc); our own allowed addresses are removed; dedupe; if nothing is left (replying to
 * our own sent message) use the original To.
 */
export function computeReplyRecipients(original: Pick<OriginalMessage, 'from' | 'replyTo' | 'to' | 'cc'>, ownAddresses: readonly string[], replyAll: boolean): { to: EmailAddress[]; cc: EmailAddress[] } {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const notOwn = (a: EmailAddress): boolean => !!a.address && !own.has(a.address.toLowerCase());
  const primary = original.replyTo.length ? original.replyTo : original.from;
  const seen = new Set<string>();
  let to = dedupeAddresses([...primary, ...(replyAll ? original.to : [])].filter(notOwn), seen);
  let cc = dedupeAddresses((replyAll ? original.cc : []).filter(notOwn), seen);
  if (to.length === 0 && cc.length > 0) {
    to = cc;
    cc = [];
  }
  if (to.length === 0) to = dedupeAddresses(original.to.filter((a) => !!a.address));
  return { to, cc };
}

/** References = original References + original Message-ID, deduplicated, last 20. */
export function buildReferences(originalReferences: readonly string[], originalMessageId: string | null): string[] {
  const all = [...originalReferences, ...(originalMessageId ? [originalMessageId] : [])];
  const unique: string[] = [];
  for (const id of all) if (!unique.includes(id)) unique.push(id);
  return unique.slice(-MAX_REFERENCES);
}

/** Default From for a reply: the allowed address the original was sent to (alias-aware). */
export function replyFromCandidate(original: Pick<OriginalMessage, 'to' | 'cc'>, allowedFrom: readonly string[]): string | undefined {
  const allowed = new Map(allowedFrom.map((a) => [a.toLowerCase(), a]));
  for (const a of [...original.to, ...original.cc]) {
    const hit = allowed.get(a.address.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

export function quoteText(text: string, cap = MAX_QUOTED_CHARS): string {
  let t = normalizeNewlines(text).replace(/\s+$/, '');
  if (t.length > cap) t = `${t.slice(0, cap)}\n[…]`;
  return t
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
}

export function attributionLine(original: Pick<OriginalMessage, 'time' | 'from'>, timeZone: string): string {
  const sender = original.from[0] ? formatAddress(original.from[0]) : 'unknown sender';
  return `On ${formatDateHuman(original.time || null, timeZone)}, ${sender} wrote:`;
}

export function buildReplyText(userText: string, original: Pick<OriginalMessage, 'time' | 'from' | 'text'>, timeZone: string): string {
  const quoted = quoteText(original.text);
  return `${normalizeNewlines(userText).replace(/\s+$/, '')}\n\n${attributionLine(original, timeZone)}\n${quoted}\n`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function textToHtml(text: string): string {
  return escapeHtml(normalizeNewlines(text)).replace(/\n/g, '<br>\n');
}

export function buildReplyHtml(userHtml: string, original: Pick<OriginalMessage, 'time' | 'from' | 'text'>, timeZone: string): string {
  let t = normalizeNewlines(original.text).replace(/\s+$/, '');
  if (t.length > MAX_QUOTED_CHARS) t = `${t.slice(0, MAX_QUOTED_CHARS)}\n[…]`;
  return (
    `${userHtml}\n<br>\n<div>${escapeHtml(attributionLine(original, timeZone))}</div>\n` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">\n${textToHtml(t)}\n</blockquote>\n`
  );
}

export const FORWARD_SEPARATOR = '---------- Forwarded message ----------';

/** The forwarded-message header block (From, Date, Subject, To, Cc). */
export function forwardHeaderLines(original: Pick<OriginalMessage, 'from' | 'time' | 'subject' | 'to' | 'cc'>, timeZone: string): string[] {
  const lines = [
    FORWARD_SEPARATOR,
    `From: ${original.from.map(formatAddress).join(', ') || 'unknown'}`,
    `Date: ${formatDateHuman(original.time || null, timeZone)}`,
    `Subject: ${cleanSubject(original.subject) || '(no subject)'}`,
    `To: ${original.to.map(formatAddress).join(', ') || '(none)'}`,
  ];
  if (original.cc.length) lines.push(`Cc: ${original.cc.map(formatAddress).join(', ')}`);
  return lines;
}

export function buildForwardText(note: string, original: OriginalMessage, timeZone: string): string {
  const n = normalizeNewlines(note).replace(/\s+$/, '');
  const block = forwardHeaderLines(original, timeZone).join('\n');
  const body = normalizeNewlines(original.text).replace(/\s+$/, '');
  return `${n ? `${n}\n\n` : ''}${block}\n\n${body}\n`;
}

export function buildForwardHtml(noteHtml: string, original: OriginalMessage, timeZone: string): string {
  const block = forwardHeaderLines(original, timeZone).map(escapeHtml).join('<br>\n');
  return `${noteHtml}\n<br>\n<div>${block}</div>\n<br>\n<div>${textToHtml(original.text)}</div>\n`;
}
