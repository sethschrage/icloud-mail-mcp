/**
 * Address validation (SPEC §2.9). Address strings from the model are untrusted: nodemailer's own
 * parser silently turns "a@x\r\nBcc: evil@y" into a different recipient list, so every address is
 * checked here and passed on as a structured `{name, address}` object.
 */
import { domainToASCII } from 'node:url';
import addressparser from 'nodemailer/lib/addressparser';
import { MailError } from '../errors.js';

export interface EmailAddress {
  name: string;
  address: string;
}

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\r\n\u0000-\u001f\u007f]/;

/** Normalise an address (IDN domain -> punycode) and validate it strictly; returns null if invalid. */
export function normalizeEmailAddress(input: string): string | null {
  if (FORBIDDEN_CHARS.test(input)) return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 254) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  const local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return null;
  if (/[^\x00-\x7f]/.test(domain)) {
    const ascii = domainToASCII(domain);
    if (!ascii) return null;
    domain = ascii;
  }
  if (domain.length > 253 || !DOMAIN.test(domain)) return null;
  return `${local}@${domain}`;
}

export function isValidEmailAddress(input: string): boolean {
  return normalizeEmailAddress(input) !== null;
}

/**
 * Parse one recipient string ("addr", "Name <addr>", or a comma-separated list of those) into
 * validated addresses. Rejects control characters, group syntax and entries without an address.
 */
export function parseAddressString(input: string, field = 'address'): EmailAddress[] {
  if (typeof input !== 'string') throw new MailError('INVALID_INPUT', `${field} must be a string.`);
  if (FORBIDDEN_CHARS.test(input)) {
    throw new MailError('INVALID_INPUT', `${field} contains a line break or control character, which is not allowed in an email address.`);
  }
  if (input.trim() === '') throw new MailError('INVALID_INPUT', `${field} is empty.`);
  const parsed = addressparser(input);
  if (parsed.length === 0) throw new MailError('INVALID_INPUT', `${field} "${input}" does not contain an email address.`);
  const out: EmailAddress[] = [];
  for (const entry of parsed) {
    if (entry.group !== undefined) {
      throw new MailError('INVALID_INPUT', `${field} "${input}" uses group syntax ("name: a, b;"), which is not supported. List each address separately.`);
    }
    const address = normalizeEmailAddress(entry.address ?? '');
    if (!address) {
      const shown = entry.address || entry.name || input;
      throw new MailError(
        'INVALID_INPUT',
        `${field} "${input}": "${shown}" is not a valid email address. Use "user@example.com" or "Name <user@example.com>" (quote display names that contain commas).`,
      );
    }
    const name = (entry.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 256);
    out.push({ name, address });
  }
  return out;
}

/** Parse a list of recipient strings. */
export function parseAddressInputs(inputs: readonly string[] | undefined, field: string): EmailAddress[] {
  if (!inputs) return [];
  return inputs.flatMap((s, i) => parseAddressString(s, `${field}[${i}]`));
}

/** Dedupe case-insensitively by address, keeping the first occurrence (and its display name). */
export function dedupeAddresses(list: readonly EmailAddress[], seen: Set<string> = new Set()): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const a of list) {
    const key = a.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** "Name <addr>" or the bare address. */
export function formatAddress(a: { name?: string | undefined; address?: string | undefined }): string {
  const address = a.address ?? '';
  const name = (a.name ?? '').trim();
  if (!name || name.toLowerCase() === address.toLowerCase()) return address || name;
  if (!address) return name;
  return `${name} <${address}>`;
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

export function localPartOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(0, at) : address;
}
