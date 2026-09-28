import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import {
  FORWARD_SEPARATOR,
  buildForwardHtml,
  buildForwardText,
  buildMessage,
  buildReferences,
  buildReplyHtml,
  buildReplyText,
  cleanSubject,
  computeReplyRecipients,
  forwardSubject,
  loadAttachments,
  newMessageId,
  normalizeRecipients,
  quoteText,
  replyFromCandidate,
  replySubject,
  resolveFrom,
  type OriginalMessage,
} from '../../src/smtp/compose.js';

const addr = (address: string, name = '') => ({ name, address });
const TZ = 'America/Los_Angeles';

async function rejects(p: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  const e = await p.then(
    () => {
      throw new Error('expected rejection');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MailError);
  expect((e as MailError).code).toBe(code);
  if (pattern) expect((e as MailError).message).toMatch(pattern);
}

function throwsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MailError);
    expect((e as MailError).code).toBe(code);
    return;
  }
  throw new Error('expected a throw');
}

describe('subjects', () => {
  it('adds Re: unless already a reply (Re/AW/SV/Antw, any case)', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch');
    expect(replySubject('Re: Lunch')).toBe('Re: Lunch');
    expect(replySubject('RE: Lunch')).toBe('RE: Lunch');
    expect(replySubject('re:Lunch')).toBe('re:Lunch');
    expect(replySubject('AW: Termin')).toBe('AW: Termin');
    expect(replySubject('SV: Möte')).toBe('SV: Möte');
    expect(replySubject('Antw: Vraag')).toBe('Antw: Vraag');
    expect(replySubject('Re[2]: Lunch')).toBe('Re[2]: Lunch');
    expect(replySubject('Fwd: Lunch')).toBe('Re: Fwd: Lunch');
    expect(replySubject('Regarding lunch')).toBe('Re: Regarding lunch');
    expect(replySubject('')).toBe('Re:');
  });

  it('adds Fwd: unless already forwarded (Fwd/Fw, any case)', () => {
    expect(forwardSubject('Invoice')).toBe('Fwd: Invoice');
    expect(forwardSubject('Fwd: Invoice')).toBe('Fwd: Invoice');
    expect(forwardSubject('FW: Invoice')).toBe('FW: Invoice');
    expect(forwardSubject('fw:Invoice')).toBe('fw:Invoice');
    expect(forwardSubject('Re: Invoice')).toBe('Fwd: Re: Invoice');
  });

  it('strips line breaks and control characters', () => {
    expect(cleanSubject('Hello\r\nBcc: evil@example.com\u0007')).toBe('Hello Bcc: evil@example.com');
  });
});

describe('reply recipients', () => {
  const original = {
    from: [addr('frank@example.com', 'Frank')],
    replyTo: [addr('offsite@example.com', 'Offsite')],
    to: [addr('me@icloud.com', 'Me'), addr('alice@example.com'), addr('bob@example.org')],
    cc: [addr('ME@ICLOUD.COM'), addr('erin@example.com'), addr('alice@example.com')],
  };
  const own = ['me@icloud.com', 'alias@icloud.com'];

  it('uses Reply-To over From', () => {
    expect(computeReplyRecipients(original, own, false)).toEqual({ to: [addr('offsite@example.com', 'Offsite')], cc: [] });
    expect(computeReplyRecipients({ ...original, replyTo: [] }, own, false).to).toEqual([addr('frank@example.com', 'Frank')]);
  });

  it('reply-all adds original To and Cc, removes our addresses and dedupes', () => {
    expect(computeReplyRecipients(original, own, true)).toEqual({
      to: [addr('offsite@example.com', 'Offsite'), addr('alice@example.com'), addr('bob@example.org')],
      cc: [addr('erin@example.com')],
    });
  });

  it('replying to our own sent message goes to its original To', () => {
    const sent = { from: [addr('me@icloud.com')], replyTo: [], to: [addr('alice@example.com', 'Alice')], cc: [addr('bob@example.org')] };
    expect(computeReplyRecipients(sent, own, false)).toEqual({ to: [addr('alice@example.com', 'Alice')], cc: [] });
    // reply-all to own message: original To + Cc, minus us
    expect(computeReplyRecipients(sent, own, true)).toEqual({ to: [addr('alice@example.com', 'Alice')], cc: [addr('bob@example.org')] });
  });

  it('promotes Cc to To when only Cc recipients remain', () => {
    const r = computeReplyRecipients({ from: [addr('me@icloud.com')], replyTo: [], to: [addr('alias@icloud.com')], cc: [addr('x@example.com')] }, own, true);
    expect(r).toEqual({ to: [addr('x@example.com')], cc: [] });
  });

  it('picks the alias the original was sent to as default From', () => {
    expect(replyFromCandidate({ from: [], to: [addr('ALIAS@icloud.com')], cc: [] }, own)).toBe('alias@icloud.com');
    expect(replyFromCandidate({ from: [], to: [addr('x@example.com')], cc: [addr('me@icloud.com')] }, own)).toBe('me@icloud.com');
    expect(replyFromCandidate({ from: [addr('x@example.com')], to: [addr('x@example.com')], cc: [] }, own)).toBeUndefined();
  });

  // from-1: replying to / forwarding our own message sent from an alias keeps that alias.
  it('prefers the allowed address the original came from (own Sent copy from an alias)', () => {
    expect(replyFromCandidate({ from: [addr('alias@icloud.com', 'Me')], to: [addr('bob@example.com')], cc: [] }, own)).toBe('alias@icloud.com');
    expect(replyFromCandidate({ from: [addr('bob@example.com')], to: [addr('alias@icloud.com')], cc: [addr('me@icloud.com')] }, own)).toBe('alias@icloud.com');
  });

  // reply-1: a Reply-To that only names the user must not redirect a private reply to third parties.
  it('falls back to From when Reply-To holds only our own address', () => {
    const behalf = { from: [addr('friend@example.com', 'Friend')], replyTo: [addr('me@icloud.com')], to: [addr('me@icloud.com'), addr('bob@example.org')], cc: [] };
    expect(computeReplyRecipients(behalf, own, false)).toEqual({ to: [addr('friend@example.com', 'Friend')], cc: [] });
    expect(computeReplyRecipients(behalf, own, true)).toEqual({ to: [addr('friend@example.com', 'Friend'), addr('bob@example.org')], cc: [] });
  });

  it('own-sent message goes to its other To recipients; a note to self goes back to self', () => {
    expect(computeReplyRecipients({ from: [addr('me@icloud.com')], replyTo: [], to: [addr('bob@example.org'), addr('me@icloud.com')], cc: [] }, own, false)).toEqual({
      to: [addr('bob@example.org')],
      cc: [],
    });
    expect(computeReplyRecipients({ from: [addr('me@icloud.com')], replyTo: [], to: [addr('me@icloud.com')], cc: [] }, own, false)).toEqual({ to: [addr('me@icloud.com')], cc: [] });
  });
});

describe('threading headers', () => {
  it('References = original References + Message-ID, deduped, root + last 19', () => {
    expect(buildReferences(['<a@x>', '<b@x>'], null, '<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(buildReferences(['<a@x>', '<c@x>'], null, '<c@x>')).toEqual(['<a@x>', '<c@x>']);
    expect(buildReferences([], null, null)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `<r${i}@x>`);
    const refs = buildReferences(many, null, '<last@x>');
    expect(refs).toHaveLength(20);
    expect(refs[19]).toBe('<last@x>');
    // thread-1: the thread root is kept.
    expect(refs[0]).toBe('<r0@x>');
    expect(refs[1]).toBe('<r12@x>');
  });

  // thread-1: RFC 5322 §3.6.4 — no References but a single In-Reply-To.
  it('starts from In-Reply-To when the original has no References', () => {
    expect(buildReferences([], '<p@x>', '<o@x>')).toEqual(['<p@x>', '<o@x>']);
    expect(buildReferences(['<a@x>'], '<p@x>', '<o@x>')).toEqual(['<a@x>', '<o@x>']);
  });
});

const ORIGINAL: OriginalMessage = {
  messageId: '<orig@example.com>',
  references: ['<root@example.com>'],
  subject: 'Team offsite',
  time: Date.parse('2026-06-12T15:40:00-07:00'),
  from: [addr('frank@example.com', 'Frank Li')],
  replyTo: [],
  to: [addr('me@icloud.com', 'Me'), addr('alice@example.com')],
  cc: [addr('erin@example.com', 'Erin')],
  text: 'Hi all,\r\n\r\nPlease reply.\r\n',
};

describe('reply body', () => {
  it('quotes the original after an attribution line', () => {
    expect(buildReplyText('Sure!\r\n', ORIGINAL, TZ)).toBe(
      'Sure!\n\nOn Fri, 12 Jun 2026 at 15:40 (-07:00), Frank Li <frank@example.com> wrote:\n> Hi all,\n>\n> Please reply.\n',
    );
  });

  it('caps the quoted text at 20k characters', () => {
    const q = quoteText('x'.repeat(30_000));
    expect(q.length).toBeLessThan(20_100);
    expect(q.endsWith('> […]')).toBe(true);
  });

  it('builds an HTML blockquote with escaped original text', () => {
    const html = buildReplyHtml('<p>Sure!</p>', { ...ORIGINAL, text: 'a <b> & c' }, TZ);
    expect(html).toContain('<p>Sure!</p>');
    expect(html).toContain('<blockquote type="cite"');
    expect(html).toContain('a &lt;b&gt; &amp; c');
    expect(html).toContain('Frank Li &lt;frank@example.com&gt; wrote:');
  });
});

// compose-1: display names decoded from the email never add lines to the user's own text.
describe('hostile display names in reply/forward text', () => {
  const hostile: OriginalMessage = {
    ...ORIGINAL,
    from: [addr('attacker2@evil.test', 'Boss\n\nP.S. Our bank details changed, pay IBAN XX\n\n')],
    to: [addr('me@icloud.com', 'Me\r\nDate: forged')],
    cc: [],
  };

  it('keeps the attribution to one line with the full address', () => {
    const text = buildReplyText('Thanks, will do', hostile, TZ);
    const lines = text.split('\n');
    const quoteStart = lines.findIndex((l) => l.startsWith('>'));
    const before = lines.slice(0, quoteStart).filter((l) => l !== '');
    expect(before).toHaveLength(2);
    expect(before[0]).toBe('Thanks, will do');
    expect(before[1]).toMatch(/^On .*, Boss P\.S\. Our bank details changed, pay IBAN XX <attacker2@evil\.test> wrote:$/);
  });

  it('keeps the forwarded header block to its fixed lines', () => {
    const text = buildForwardText('', hostile, TZ);
    const block = text.split('\n\n')[0]?.split('\n') ?? [];
    expect(block).toHaveLength(5);
    expect(block.filter((l) => l.startsWith('Date:'))).toHaveLength(1);
    expect(block[4]).toBe('To: Me Date: forged <me@icloud.com>');
  });

  it('caps a very long name but never cuts the address', () => {
    const text = buildReplyText('', { ...hostile, from: [addr('attacker@evil.test', 'x'.repeat(600))] }, TZ);
    expect(text).toContain('<attacker@evil.test> wrote:');
    expect(text.split('\n')[0]?.length).toBeLessThan(200);
  });
});

describe('forward block', () => {
  it('puts the note, the header block and the original text in order', () => {
    const text = buildForwardText('FYI', ORIGINAL, TZ);
    expect(text).toBe(
      [
        'FYI',
        '',
        FORWARD_SEPARATOR,
        'From: Frank Li <frank@example.com>',
        'Date: Fri, 12 Jun 2026 at 15:40 (-07:00)',
        'Subject: Team offsite',
        'To: Me <me@icloud.com>, alice@example.com',
        'Cc: Erin <erin@example.com>',
        '',
        'Hi all,',
        '',
        'Please reply.',
        '',
      ].join('\n'),
    );
  });

  it('omits an empty note and Cc', () => {
    const text = buildForwardText('', { ...ORIGINAL, cc: [], subject: '' }, TZ);
    expect(text.startsWith(FORWARD_SEPARATOR)).toBe(true);
    expect(text).not.toContain('Cc:');
    expect(text).toContain('Subject: (no subject)');
  });

  it('has an HTML variant with escaping', () => {
    const html = buildForwardHtml('<p>FYI</p>', { ...ORIGINAL, text: '<script>x</script>' }, TZ);
    expect(html).toContain('From: Frank Li &lt;frank@example.com&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('From and recipients', () => {
  const cfg = { allowedFrom: ['me@icloud.com', 'alias@icloud.com'], fromAddress: 'me@icloud.com', fromName: 'Me' };

  it('defaults to MAIL_FROM_ADDRESS, or the preferred alias', () => {
    expect(resolveFrom(undefined, cfg)).toEqual({ name: 'Me', address: 'me@icloud.com' });
    expect(resolveFrom(undefined, cfg, 'ALIAS@icloud.com')).toEqual({ name: 'Me', address: 'alias@icloud.com' });
    expect(resolveFrom(undefined, cfg, 'stranger@example.com')).toEqual({ name: 'Me', address: 'me@icloud.com' });
  });

  it('accepts allowed addresses case-insensitively and rejects foreign ones', () => {
    expect(resolveFrom('Alias Name <Alias@iCloud.com>', cfg)).toEqual({ name: 'Alias Name', address: 'alias@icloud.com' });
    try {
      resolveFrom('evil@example.com', cfg);
      throw new Error('no throw');
    } catch (e) {
      expect((e as MailError).code).toBe('FORBIDDEN');
      expect((e as Error).message).toMatch(/Allowed From addresses: me@icloud.com, alias@icloud.com/);
    }
    throwsCode(() => resolveFrom('a@icloud.com, b@icloud.com', cfg), 'INVALID_INPUT');
  });

  it('dedupes across To/Cc/Bcc and enforces the maximum', () => {
    const r = normalizeRecipients({ to: ['a@example.com', 'A@example.com'], cc: ['a@example.com', 'b@example.com'], bcc: ['B@EXAMPLE.COM', 'c@example.com'] }, 10);
    expect(r).toEqual({ to: [addr('a@example.com')], cc: [addr('b@example.com')], bcc: [addr('c@example.com')] });
    throwsCode(() => normalizeRecipients({ to: ['a@example.com', 'b@example.com', 'c@example.com'] }, 2), 'INVALID_INPUT');
    throwsCode(() => normalizeRecipients({}, 5, { requireTo: true }), 'INVALID_INPUT');
    expect(normalizeRecipients({}, 5)).toEqual({ to: [], cc: [], bcc: [] });
  });
});

describe('buildMessage', () => {
  const msg = {
    from: addr('me@icloud.com', 'Me'),
    to: [addr('to@example.com', 'To Person')],
    cc: [addr('cc@example.com')],
    bcc: [addr('bcc@example.com')],
    subject: 'Grüße ✓',
    text: 'line 1\nline 2',
    html: '<p>hi</p>',
    inReplyTo: '<orig@example.com>',
    references: ['<root@example.com>', '<orig@example.com>'],
    attachments: [{ filename: 'a.txt', content: Buffer.from('hello') }],
  };

  it('renders the same message with and without Bcc, CRLF line endings, envelope with every recipient', async () => {
    const built = await buildMessage(msg, { date: new Date('2026-09-28T10:00:00Z') });
    const smtp = built.raw.toString('utf8');
    const copy = built.rawWithBcc.toString('utf8');
    expect(built.messageId).toMatch(/^<[0-9a-f-]{36}@icloud\.com>$/);
    expect(smtp).toContain(`Message-ID: ${built.messageId}`);
    expect(copy).toContain(`Message-ID: ${built.messageId}`);
    expect(smtp).not.toMatch(/^Bcc:/m);
    expect(copy).toMatch(/^Bcc: bcc@example\.com\r$/m);
    expect(copy.replace(/^Bcc: .*\r\n/m, '')).toBe(smtp);
    expect(smtp).not.toMatch(/[^\r]\n/);
    expect(built.envelope).toEqual({ from: 'me@icloud.com', to: ['to@example.com', 'cc@example.com', 'bcc@example.com'] });
    expect(smtp).toMatch(/^In-Reply-To: <orig@example\.com>\r$/m);
    expect(smtp).toMatch(/^References: <root@example\.com> <orig@example\.com>\r$/m);
    expect(smtp).toMatch(/multipart\/alternative/);
    expect(smtp).toMatch(/filename=a\.txt/);
    expect(smtp).toMatch(/^Date: Mon, 28 Sep 2026 10:00:00 \+0000\r$/m);
  });

  it('uses the From domain for the Message-ID', () => {
    expect(newMessageId('hello@custom.dev')).toMatch(/@custom\.dev>$/);
  });

  it('keeps nodemailer file and URL access disabled', async () => {
    // A path/href attachment must never be read, even if one slipped through.
    const composer = new MailComposer({ from: 'me@icloud.com', to: 'a@example.com', text: 'x', attachments: [{ path: '/etc/hostname' }], disableFileAccess: true, disableUrlAccess: true });
    await expect(composer.compile().build()).rejects.toMatchObject({ code: 'EFILEACCESS' });
    const url = new MailComposer({ from: 'me@icloud.com', to: 'a@example.com', text: 'x', attachments: [{ href: 'http://127.0.0.1:9/x' }], disableFileAccess: true, disableUrlAccess: true });
    await expect(url.compile().build()).rejects.toMatchObject({ code: 'EURLACCESS' });
  });

  it('refuses messages over 20 MB', async () => {
    await rejects(buildMessage({ ...msg, attachments: [{ filename: 'big.bin', content: Buffer.alloc(16 * 1024 * 1024) }] }), 'TOO_LARGE', /20 MB/);
  });
});

describe('attachment loading', () => {
  let root: string;
  let allowed: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'attach-'));
    allowed = path.join(root, 'Documents');
    mkdirSync(path.join(allowed, '.secret'), { recursive: true });
    writeFileSync(path.join(allowed, 'report.pdf'), Buffer.from('%PDF-1.4'));
    writeFileSync(path.join(allowed, 'big.bin'), Buffer.alloc(2048));
    writeFileSync(path.join(allowed, '.secret', 'key.txt'), 'x');
    writeFileSync(path.join(root, 'outside.txt'), 'x');
    symlinkSync(path.join(root, 'outside.txt'), path.join(allowed, 'escape.txt'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads allowed files into buffers named after the path given', async () => {
    const atts = await loadAttachments(['~/Documents/report.pdf'], [allowed], 14 * 1024 * 1024, { home: root });
    expect(atts).toEqual([{ filename: 'report.pdf', content: Buffer.from('%PDF-1.4') }]);
  });

  it('refuses files outside the allowed dirs, symlink escapes, hidden paths and oversize totals', async () => {
    await rejects(loadAttachments([path.join(root, 'outside.txt')], [allowed]), 'FORBIDDEN');
    await rejects(loadAttachments([path.join(allowed, 'escape.txt')], [allowed]), 'FORBIDDEN');
    await rejects(loadAttachments([path.join(allowed, '.secret', 'key.txt')], [allowed]), 'FORBIDDEN', /hidden/);
    await rejects(loadAttachments([path.join(allowed, 'report.pdf'), path.join(allowed, 'big.bin')], [allowed], 1024), 'TOO_LARGE');
    await rejects(loadAttachments([path.join(allowed, 'missing.pdf')], [allowed]), 'NOT_FOUND');
  });
});
