/**
 * Text rendering of tool results (SPEC §5 "Output format"): compact JSON for lists/actions, and a
 * readable layout for get_message (header block, attachments, wrapped body).
 */
import { formatSize, toJson, truncateResult, MAX_RESULT_CHARS } from './format.js';
import type { FullMessage } from './imap/fetch.js';
import { UNTRUSTED_LIST_NOTE, UNTRUSTED_MESSAGE_NOTE, sanitizeInline, wrapUntrusted } from './safety/untrusted.js';
import { formatAddress, type EmailAddress } from './smtp/address.js';

/** Search/thread results: one-line untrusted reminder, then compact JSON. */
export function renderListResult(result: unknown): string {
  return truncateResult(`${UNTRUSTED_LIST_NOTE}\n${toJson(result)}`);
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

export function buildMessageView(message: FullMessage, maxChars: number, notes: string[] = []): MessageView {
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
    notes,
  };
}

function addrs(list: EmailAddress[]): string {
  return list.map((a) => sanitizeInline(formatAddress(a), 500)).join(', ');
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
  push('Reply-To', addrs(m.addresses.replyTo));
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
      const extras = [a.content_type, a.size !== null ? formatSize(a.size) : null, a.inline ? 'inline' : null, a.content_id ? `cid ${sanitizeInline(a.content_id, 200)}` : null].filter(
        (x): x is string => !!x,
      );
      lines.push(`- part ${a.part}: ${a.filename ? `"${sanitizeInline(a.filename, 300)}"` : '(no filename)'} (${extras.join(', ')})`);
    }
  }

  lines.push('');
  const shown = view.body.length;
  const fmt = m.bodyFormat === 'text/html' ? 'converted from HTML' : m.bodyFormat === 'mixed' ? 'several parts' : m.bodyFormat === 'none' ? 'no text body' : 'plain text';
  lines.push(`Body (${fmt}; ${view.bodyTruncated ? `showing ${shown} of ${view.bodyTotalChars}` : `${view.bodyTotalChars}`} characters):`);
  lines.push(wrapUntrusted(view.body || (m.bodyFormat === 'none' ? '(this message has no text body)' : '')));
  if (view.bodyTruncated) {
    lines.push(`[Body truncated: showing ${shown} of ${view.bodyTotalChars} characters. Call get_message with a larger max_chars (up to 100000) to read more.]`);
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
    const smaller = buildMessageView(m, Math.max(1000, view.body.length - excess), view.notes);
    if (smaller.body.length < view.body.length) {
      smaller.html = null;
      smaller.notes = [...view.notes, 'The output was shortened to stay within the tool result size limit.'];
      text = renderMessageView(smaller);
    }
  }
  return text;
}
