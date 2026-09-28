import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { dedupeAddresses, formatAddress, isValidEmailAddress, normalizeEmailAddress, parseAddressInputs, parseAddressString } from '../../src/smtp/address.js';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof MailError ? e.code : 'other';
  }
  return 'none';
}

describe('strict address validation', () => {
  it('accepts normal addresses', () => {
    for (const a of ['a@example.com', 'first.last+tag@sub.example.co.uk', "o'brien@example.ie", 'x_y-z@icloud.test', 'UPPER@Example.COM']) {
      expect(isValidEmailAddress(a), a).toBe(true);
    }
  });

  it('rejects malformed addresses', () => {
    for (const a of ['', 'plain', '@example.com', 'a@', 'a@b', 'a..b@example.com', '.a@example.com', 'a@-example.com', 'a@example..com', 'a b@example.com', 'a@exa mple.com', `${'x'.repeat(65)}@example.com`, 'a@example.com\n']) {
      expect(isValidEmailAddress(a), JSON.stringify(a)).toBe(false);
    }
  });

  it('converts IDN domains to punycode', () => {
    expect(normalizeEmailAddress('user@bücher.example')).toBe('user@xn--bcher-kva.example');
  });
});

describe('parsing recipient strings', () => {
  it('parses bare and named addresses', () => {
    expect(parseAddressString('a@example.com')).toEqual([{ name: '', address: 'a@example.com' }]);
    expect(parseAddressString('Alice Nguyen <alice@example.com>')).toEqual([{ name: 'Alice Nguyen', address: 'alice@example.com' }]);
    expect(parseAddressString('"Nguyen, Alice" <alice@example.com>')).toEqual([{ name: 'Nguyen, Alice', address: 'alice@example.com' }]);
    // addressparser keeps an unquoted comma before <addr> in the display name
    expect(parseAddressString('Nguyen, Alice <alice@example.com>')).toEqual([{ name: 'Nguyen, Alice', address: 'alice@example.com' }]);
    expect(parseAddressString('a@example.com, B <b@example.com>')).toHaveLength(2);
  });

  it('rejects the CR/LF injection case from research-libs §6', () => {
    // nodemailer itself would turn this into a group and silently send only to evil1@example.com:
    const nodemailerView = addressparser('victim@example.com\r\nBcc: evil1@example.com');
    expect(JSON.stringify(nodemailerView)).toContain('evil1@example.com');
    const envelope = new MailComposer({ from: 'me@icloud.com', to: 'victim@example.com\r\nBcc: evil1@example.com' }).compile().getEnvelope();
    expect(envelope.to).toEqual(['evil1@example.com']);
    // ours refuses it outright
    expect(code(() => parseAddressString('victim@example.com\r\nBcc: evil1@example.com', 'to'))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('victim@example.com\nBcc: evil1@example.com'))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('victim@example.com\u0000'))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('victim@example.com\t'))).toBe('INVALID_INPUT');
  });

  it('rejects groups, empty strings, names without addresses and unquoted commas', () => {
    expect(code(() => parseAddressString('Friends: a@example.com, b@example.com;'))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('undisclosed-recipients:;'))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString(''))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('   '))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('Just A Name'))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('Nguyen, Alice, <alice@example.com>'))).toBe('INVALID_INPUT');
    expect(code(() => parseAddressString('a@example.com Bcc: evil@example.com'))).toBe('INVALID_INPUT');
  });

  it('names the field and index in errors', () => {
    try {
      parseAddressInputs(['ok@example.com', 'bad'], 'cc');
      throw new Error('no throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/^cc\[1\]/);
    }
  });
});

describe('helpers', () => {
  it('dedupes case-insensitively keeping the first entry', () => {
    const list = dedupeAddresses([
      { name: 'A', address: 'a@example.com' },
      { name: 'A2', address: 'A@EXAMPLE.com' },
      { name: '', address: 'b@example.com' },
    ]);
    expect(list).toEqual([
      { name: 'A', address: 'a@example.com' },
      { name: '', address: 'b@example.com' },
    ]);
  });

  it('formats addresses as "Name <addr>" or bare', () => {
    expect(formatAddress({ name: 'Alice', address: 'a@example.com' })).toBe('Alice <a@example.com>');
    expect(formatAddress({ name: '', address: 'a@example.com' })).toBe('a@example.com');
    expect(formatAddress({ name: 'a@example.com', address: 'a@example.com' })).toBe('a@example.com');
    expect(formatAddress({ name: 'Only Name' })).toBe('Only Name');
  });
});

// addr-1: space-separated addresses are never silently re-read as a display name.
describe('several addresses in one string', () => {
  it.each(['a@x.com b@y.com', '<a@x.com> <b@y.com>', 'Alice <a@x.com> <b@y.com>', 'alice@example.com bob@example.com carol@example.com'])('rejects %s', (input) => {
    expect(() => parseAddressString(input, 'to')).toThrow(/more than one address/);
  });
  it('still accepts proper lists and names', () => {
    expect(parseAddressString('Alice <a@x.com>, Bob <b@y.com>', 'to')).toEqual([
      { name: 'Alice', address: 'a@x.com' },
      { name: 'Bob', address: 'b@y.com' },
    ]);
    expect(parseAddressString('"Smith, Jane" <jane@x.com>', 'to')).toEqual([{ name: 'Smith, Jane', address: 'jane@x.com' }]);
    expect(parseAddressString('"jane@x.com" <jane@x.com>', 'to')).toEqual([{ name: '', address: 'jane@x.com' }]);
  });
});
