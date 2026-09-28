/**
 * send_draft: turn a draft's stored MIME into the bytes to submit. The body (all MIME parts,
 * attachments included) is kept byte for byte, so edits the user made in Apple Mail go out exactly
 * as saved. Only the top-level header block changes:
 * - Bcc is dropped from the submitted copy (it stays in the Sent copy, like any other send);
 * - Date and Message-ID are renewed (the draft's Message-ID belongs to the draft);
 * - Apple Mail's draft bookkeeping headers (X-Uniform-Type-Identifier, X-Apple-*,
 *   X-Universally-Unique-Identifier) are dropped.
 */
import { newMessageId } from './compose.js';

const DROP_ALWAYS = /^(date|message-id|x-uniform-type-identifier|x-universally-unique-identifier|x-apple-[a-z0-9-]*)$/i;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date-time in UTC, e.g. "Mon, 28 Sep 2026 09:14:00 +0000". */
export function rfc5322Date(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export interface RebuiltDraft {
  messageId: string;
  /** Bytes for SMTP (no Bcc). */
  raw: Buffer;
  /** Bytes for the Sent copy (with Bcc). */
  rawWithBcc: Buffer;
  eightBit: boolean;
}

/** Split raw message bytes into header fields (each with its folded continuation lines) and body. */
export function splitHeaderFields(source: Buffer): { fields: string[]; body: Buffer; eol: string } {
  // Headers are handled as latin1 so every byte survives unchanged.
  const text = source.toString('latin1');
  let sep = text.indexOf('\r\n\r\n');
  let eol = '\r\n';
  if (sep < 0 || (text.indexOf('\n\n') >= 0 && text.indexOf('\n\n') < sep)) {
    const lf = text.indexOf('\n\n');
    if (lf >= 0) {
      sep = lf;
      eol = '\n';
    }
  }
  const headerText = sep >= 0 ? text.slice(0, sep) : text;
  const body = sep >= 0 ? source.subarray(sep + eol.length * 2) : Buffer.alloc(0);
  const fields: string[] = [];
  for (const line of headerText.split(eol)) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1] += `${eol}${line}`;
    else if (line !== '') fields.push(line);
  }
  return { fields, body, eol };
}

function fieldName(field: string): string {
  const i = field.indexOf(':');
  return i > 0 ? field.slice(0, i).trim() : '';
}

export function rebuildDraftForSending(source: Buffer, options: { from: string; date: Date; messageId?: string }): RebuiltDraft {
  const { fields, body } = splitHeaderFields(source);
  const messageId = options.messageId ?? newMessageId(options.from);
  const kept = fields.filter((f) => !DROP_ALWAYS.test(fieldName(f)));
  const fresh = [`Date: ${rfc5322Date(options.date)}`, `Message-ID: ${messageId}`];
  const withBcc = [...fresh, ...kept];
  const withoutBcc = [...fresh, ...kept.filter((f) => fieldName(f).toLowerCase() !== 'bcc')];
  // Always CRLF on the wire.
  const render = (list: string[]): Buffer => Buffer.concat([Buffer.from(`${list.map((f) => f.replace(/\r?\n/g, '\r\n')).join('\r\n')}\r\n\r\n`, 'latin1'), body]);
  const raw = render(withoutBcc);
  let eightBit = false;
  for (let i = 0; i < raw.length; i++) {
    if ((raw[i] as number) > 0x7f) {
      eightBit = true;
      break;
    }
  }
  return { messageId, raw, rawWithBcc: render(withBcc), eightBit };
}
