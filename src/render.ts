/**
 * Text rendering of tool results (SPEC §5 "Output format"): compact JSON for lists/actions, and a
 * readable layout for get_message (header block, attachments, wrapped body).
 */
import { getRuntime } from './runtime.js';
import { decodedSizeEstimate, formatDateISO, formatSize, toJson, truncateResult, MAX_RESULT_CHARS } from './format.js';
import { renderAddress, type FullMessage } from './imap/fetch.js';
import { UNTRUSTED_LIST_NOTE, UNTRUSTED_MESSAGE_NOTE, sanitizeInline, wrapUntrusted } from './safety/untrusted.js';
import type { EmailAddress } from './smtp/address.js';

/**
 * Search/thread results: one-line untrusted reminder, then compact JSON. A result over the size
 * limit is shortened structurally, never by cutting the JSON text: whole messages are dropped
 * (from the end, or from the start with `keep: 'last'` for threads, which keep the most recent),
 * `returned`/`has_more` are corrected and a note says how to page.
 */
export function renderListResult(result: unknown, options: { keep?: 'first' | 'last' } = {}): string {
  const render = (r: unknown): string => `${UNTRUSTED_LIST_NOTE}\n${toJson(r)}`;
  let text = render(result);
  if (text.length <= MAX_RESULT_CHARS) return text;
  const r = result as { messages?: unknown[]; returned?: number; has_more?: boolean; note?: string };
  if (!r || typeof r !== 'object' || !Array.isArray(r.messages)) return truncateResult(text);
  const all = r.messages;
  let lo = 0;
  let hi = all.length;
  const build = (n: number): Record<string, unknown> => {
    const messages = options.keep === 'last' ? all.slice(all.length - n) : all.slice(0, n);
    const shortened: Record<string, unknown> = { ...r, messages, returned: messages.length };
    if ('has_more' in r) shortened['has_more'] = true;
    shortened['note'] = `${r.note ? `${r.note} ` : ''}Result shortened to ${messages.length} of ${all.length} messages to stay under the size limit; use a smaller limit${options.keep === 'last' ? '' : ' or page with offset'}.`;
    return shortened;
  };
  // Largest n whose rendering fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(build(mid)).length <= MAX_RESULT_CHARS) lo = mid;
    else hi = mid - 1;
  }
  text = render(build(lo));
  return text.length <= MAX_RESULT_CHARS ? text : truncateResult(text);
}

/** Action results: compact JSON. */
export function renderJson(result: unknown): string {
  return truncateResult(toJson(result));
}

export interface MessageView {
  message: FullMessage;
  body: string;
  bodyTruncated: boolean;
  bodyTotalChars: number;
  html: string | null;
  htmlTruncated: boolean;
  htmlTotalChars: number;
  maxChars: number;
  /** The configured maximum (MAIL_MAX_BODY_CHARS); a call cannot read more than this. */
  configuredMax: number;
  notes: string[];
}

/** Truncate at `max` UTF-16 units without splitting a surrogate pair. */
export function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

export function buildMessageView(message: FullMessage, maxChars: number, notes: string[] = [], configuredMax: number = maxChars): MessageView {
  const body = truncateChars(message.bodyText, maxChars);
  const html = message.html === null ? null : truncateChars(message.html, maxChars);
  return {
    message,
    body: body.text,
    bodyTruncated: body.truncated,
    bodyTotalChars: message.bodyText.length,
    html: html ? html.text : null,
    htmlTruncated: html ? html.truncated : false,
    htmlTotalChars: message.html?.length ?? 0,
    maxChars,
    configuredMax,
    notes,
  };
}

/** Addresses for the header block: every address in full, names sanitised and capped. */
function addrs(list: EmailAddress[]): string {
  return list.map(renderAddress).join(', ');
}

/** Readable get_message layout. Header values and filenames are sanitised to single lines. */
export function renderMessageView(view: MessageView): string {
  const m = view.message;
  const lines: string[] = [UNTRUSTED_MESSAGE_NOTE, ''];
  const push = (label: string, value: string | null | undefined): void => {
    if (value !== null && value !== undefined && value !== '') lines.push(`${label}: ${value}`);
  };
  push('Mailbox', m.mailbox);
  push('UID', String(m.uid));
  push('Message-ID', m.messageId ? sanitizeInline(m.messageId, 300) : null);
  push('Date', m.date);
  push('From', addrs(m.addresses.from));
  if (m.addresses.sender.length && addrs(m.addresses.sender) !== addrs(m.addresses.from)) push('Sender', addrs(m.addresses.sender));
  // Only a Reply-To the message really has, and only when it differs from From (a phishing sign).
  const sameAsFrom = (a: EmailAddress): boolean => m.addresses.from.some((f) => f.address.toLowerCase() === a.address.toLowerCase());
  if (m.addresses.replyTo.length && !m.addresses.replyTo.every(sameAsFrom)) push('Reply-To', `${addrs(m.addresses.replyTo)} (differs from From)`);
  push('To', addrs(m.addresses.to));
  push('Cc', addrs(m.addresses.cc));
  push('Bcc', addrs(m.addresses.bcc));
  push('Subject', m.subject ? sanitizeInline(m.subject, 1000) : '(no subject)');
  const f = m.flags;
  const flagWords = [
    f.unread ? 'unread' : 'read',
    f.flagged ? `flagged${f.flag_color ? ` (${f.flag_color})` : ''}` : null,
    f.answered ? 'answered' : null,
    f.forwarded ? 'forwarded' : null,
    f.draft ? 'draft' : null,
  ].filter((x): x is string => !!x);
  push('Flags', flagWords.join(', '));
  push('Size', formatSize(m.size));
  push('List-Id', m.listId ? sanitizeInline(m.listId, 300) : null);
  push('List-Unsubscribe', m.listUnsubscribe ? sanitizeInline(m.listUnsubscribe, 500) : null);
  push('In-Reply-To', m.inReplyTo ? sanitizeInline(m.inReplyTo, 300) : null);
  if (m.references.length) push('References', sanitizeInline(m.references.slice(-5).join(' '), 1000) + (m.references.length > 5 ? ` (+${m.references.length - 5} earlier)` : ''));

  lines.push('');
  if (m.attachments.length === 0) {
    lines.push('Attachments: none');
  } else {
    lines.push(`Attachments (${m.attachments.length}; use download_attachment with the part number):`);
    for (const a of m.attachments) {
      // BODYSTRUCTURE sizes are encoded sizes: show the decoded size, as the download reports it.
      const size = a.size !== null ? `${a.encoding === 'base64' ? 'about ' : ''}${formatSize(decodedSizeEstimate(a.size, a.encoding))}` : null;
      const extras = [a.content_type, size, a.inline ? 'inline' : null, a.content_id ? `cid ${sanitizeInline(a.content_id, 200)}` : null].filter((x): x is string => !!x);
      const embedded = a.embedded
        ? ` [attached message: from ${sanitizeInline(a.embedded.from, 300) || 'unknown'}, subject "${sanitizeInline(a.embedded.subject, 300) || '(no subject)'}"${a.embedded.date ? `, ${formatDateISO(a.embedded.date, 'UTC') ?? ''}` : ''}; download_attachment shows its text]`
        : '';
      lines.push(`- part ${a.part}: ${a.filename ? `"${sanitizeInline(a.filename, 300)}"` : '(no filename)'} (${extras.join(', ')})${embedded}`);
    }
  }

  lines.push('');
  const shown = view.body.length;
  const fmt = m.bodyFormat === 'text/html' ? 'converted from HTML' : m.bodyFormat === 'mixed' ? 'several parts' : m.bodyFormat === 'none' ? 'no text body' : 'plain text';
  lines.push(`Body (${fmt}; ${view.bodyTruncated ? `showing ${shown} of ${view.bodyTotalChars}` : `${view.bodyTotalChars}`} characters):`);
  lines.push(wrapUntrusted(view.body || (m.bodyFormat === 'none' ? '(this message has no text body)' : '')));
  if (view.bodyTruncated) {
    const how =
      view.maxChars >= view.configuredMax
        ? `This is the configured maximum; to read more, the user can raise ${getRuntime() === 'cloud' ? 'MAIL_MAX_BODY_CHARS in the Vercel project\'s environment variables' : '"Maximum email length shown to Claude" in the extension settings (MAIL_MAX_BODY_CHARS'}, now ${view.configuredMax}${getRuntime() === 'cloud' ? '' : ')'}.`
        : `Call get_message with a larger max_chars (up to ${view.configuredMax}) to read more.`;
    lines.push(`[Body truncated: showing ${shown} of ${view.bodyTotalChars} characters. ${how}]`);
  }
  if (view.html !== null) {
    lines.push('');
    lines.push(`Raw HTML (${view.htmlTruncated ? `showing ${view.html.length} of ${view.htmlTotalChars}` : `${view.htmlTotalChars}`} characters):`);
    lines.push(wrapUntrusted(view.html));
  }
  for (const note of view.notes) lines.push(`Note: ${note}`);
  let text = lines.join('\n');
  if (text.length > MAX_RESULT_CHARS) {
    // Never cut the wrapped block's END marker: shrink the body instead.
    const excess = text.length - MAX_RESULT_CHARS + 200;
    const smaller = buildMessageView(m, Math.max(1000, view.body.length - excess), view.notes, view.configuredMax);
    if (smaller.body.length < view.body.length) {
      smaller.html = null;
      smaller.notes = [...view.notes, 'The output was shortened to stay within the tool result size limit.'];
      text = renderMessageView(smaller);
    }
  }
  return text;
}
