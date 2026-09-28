/**
 * Sending against the test-infra SMTP sink (127.0.0.1:1587, STARTTLS with the test CA): envelope vs
 * headers, Sent copy (exactly once, with Bcc), replies, forwards, recipient failures, rate limit,
 * confirmation dialog, auth failures.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { MailService } from '../../src/service.js';
import { buildMessage } from '../../src/smtp/compose.js';
import type { SendResult } from '../../src/smtp/send.js';
import {
  cleanupDirs,
  createTestService,
  findSidecarByMessageId,
  listSidecars,
  makeTestDirs,
  rawFlags,
  rawSource,
  rawUidsByMessageId,
  readEml,
  resetMailServer,
  withRawImap,
  type TestDirs,
} from '../helpers/infra.js';

let dirs: TestDirs;
let svc: MailService;

beforeAll(async () => {
  await resetMailServer();
  dirs = makeTestDirs();
  svc = createTestService(dirs, { MAIL_MAX_SENDS_PER_HOUR: '0' });
});

afterAll(async () => {
  await svc?.close();
  if (dirs) cleanupDirs(dirs);
});

async function expectMailError(p: Promise<unknown>, code: string, pattern?: RegExp): Promise<MailError> {
  const err = await p.then(
    () => {
      throw new Error('expected a MailError');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailError);
  const me = err as MailError;
  expect(me.code).toBe(code);
  if (pattern) expect(me.message).toMatch(pattern);
  return me;
}

function asSent(r: unknown): SendResult {
  expect(r).toMatchObject({ sent: true });
  return r as SendResult;
}

describe('send_email', () => {
  it('sends with Bcc only in the envelope and saves one Sent copy that keeps Bcc', async () => {
    const r = asSent(
      await svc.sendEmail({
        to: ['Friend <friend@example.com>'],
        cc: ['other@example.org'],
        bcc: ['hidden@example.net', 'FRIEND@example.com'],
        subject: 'Hello from the test ✓',
        body: 'Line one\nLine two',
        html: '<p>Line one</p><p>Line two</p>',
      }),
    );
    expect(r.accepted.sort()).toEqual(['friend@example.com', 'hidden@example.net', 'other@example.org']);
    expect(r.rejected).toEqual([]);
    expect(r.partial).toBe(false);
    expect(r.from).toBe('Test User <testuser@icloud.test>');
    expect(r.message_id).toMatch(/@icloud\.test>$/);

    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar).toBeDefined();
    expect(sidecar?.envelope.mailFrom).toBe('testuser@icloud.test');
    expect(sidecar?.envelope.rcptTo.sort()).toEqual(['friend@example.com', 'hidden@example.net', 'other@example.org']);
    expect(sidecar?.headers?.bcc).toEqual([]);
    expect(sidecar?.headers?.subject).toBe('Hello from the test ✓');
    expect(sidecar?.tls.starttls).toBe(true);
    expect(sidecar?.auth.user).toBe('testuser@icloud.test');
    const eml = readEml(sidecar!);
    expect(eml).not.toMatch(/^Bcc:/im);
    const parsed = await simpleParser(eml);
    expect(parsed.text?.trim()).toBe('Line one\nLine two');
    expect(parsed.html).toContain('<p>Line one</p>');

    expect(r.sent_copy_saved).toBe(true);
    expect(r.sent_copy_mailbox).toBe('Sent Messages');
    const copies = await rawUidsByMessageId('Sent Messages', r.message_id);
    expect(copies).toEqual([r.sent_copy_uid]);
    const copy = (await rawSource('Sent Messages', copies[0] ?? 0))?.toString('utf8') ?? '';
    expect(copy).toMatch(/^Bcc: hidden@example\.net\r$/m);
    expect(await rawFlags('Sent Messages', copies[0] ?? 0)).toContain('\\Seen');
    // The SMTP bytes and the Sent copy are the same message (same Message-ID and Date).
    expect(copy).toContain(`Message-ID: ${r.message_id}`);
  });

  it('does not add a second Sent copy when one with the Message-ID already exists', async () => {
    const built = await buildMessage({
      from: { name: '', address: 'testuser@icloud.test' },
      to: [{ name: '', address: 'friend@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Dedupe check',
      text: 'x',
      attachments: [],
    });
    await withRawImap((client) => client.append('Sent Messages', built.rawWithBcc, ['\\Seen']));
    const r = asSent(await svc.sender.send(built, { tool: 'test' }));
    expect(r.sent_copy_saved).toBe(true);
    expect(r.sent_copy_note).toMatch(/already in the Sent mailbox/);
    expect(await rawUidsByMessageId('Sent Messages', built.messageId)).toHaveLength(1);
  });

  it('sends from an allowed alias and rejects a foreign From before SMTP', async () => {
    const alias = asSent(await svc.sendEmail({ to: ['friend@example.com'], subject: 'From alias', body: 'x', from: 'testuser.alias@icloud.test' }));
    expect(findSidecarByMessageId(alias.message_id)?.envelope.mailFrom).toBe('testuser.alias@icloud.test');
    const before = listSidecars().length;
    await expectMailError(svc.sendEmail({ to: ['friend@example.com'], subject: 'x', body: 'x', from: 'someone@evil.test' }), 'FORBIDDEN', /Allowed From addresses: testuser@icloud\.test/);
    expect(listSidecars().length).toBe(before);
  });

  it('rejects address injection and invalid recipients locally', async () => {
    const before = listSidecars().length;
    await expectMailError(svc.sendEmail({ to: ['victim@example.com\r\nBcc: evil@example.com'], subject: 'x', body: 'x' }), 'INVALID_INPUT', /line break/);
    await expectMailError(svc.sendEmail({ to: ['not-an-address'], subject: 'x', body: 'x' }), 'INVALID_INPUT');
    await expectMailError(svc.sendEmail({ to: ['Friends: a@example.com, b@example.com;'], subject: 'x', body: 'x' }), 'INVALID_INPUT', /group/);
    await expectMailError(svc.sendEmail({ to: [], subject: 'x', body: 'x' }), 'INVALID_INPUT', /recipient/);
    expect(listSidecars().length).toBe(before);
  });

  it('attaches allowed local files and refuses others', async () => {
    const file = path.join(dirs.attachFrom, 'report.txt');
    writeFileSync(file, 'report contents');
    const r = asSent(await svc.sendEmail({ to: ['friend@example.com'], subject: 'With attachment', body: 'see attached', attachments: [file] }));
    expect(findSidecarByMessageId(r.message_id)?.headers?.attachments).toEqual([expect.objectContaining({ filename: 'report.txt', contentType: 'text/plain' })]);
    await expectMailError(svc.sendEmail({ to: ['friend@example.com'], subject: 'x', body: 'x', attachments: ['/etc/passwd'] }), 'FORBIDDEN', /MAIL_ATTACH_FROM_DIRS/);
  });
});

describe('recipient failures', () => {
  it('fails when every recipient is rejected (550) and saves nothing', async () => {
    const before = listSidecars().length;
    await expectMailError(svc.sendEmail({ to: ['nobody@reject.test'], subject: 'x', body: 'x' }), 'SMTP', /All recipients were rejected.*nobody@reject\.test.*550/);
    expect(listSidecars().length).toBe(before);
  });

  it('explains temporary failures (451)', async () => {
    await expectMailError(svc.sendEmail({ to: ['later@tempfail.test'], subject: 'x', body: 'x' }), 'SMTP', /451.*temporary/i);
  });

  it('reports a partial send when some recipients are rejected', async () => {
    const r = asSent(await svc.sendEmail({ to: ['friend@example.com', 'nobody@reject.test'], cc: ['later@tempfail.test'], subject: 'Partial', body: 'x' }));
    expect(r.partial).toBe(true);
    expect(r.accepted).toEqual(['friend@example.com']);
    expect(r.rejected.map((x) => x.address).sort()).toEqual(['later@tempfail.test', 'nobody@reject.test']);
    expect(r.rejected.find((x) => x.address === 'later@tempfail.test')?.reason).toMatch(/temporary/);
    expect(findSidecarByMessageId(r.message_id)?.envelope.rcptTo).toEqual(['friend@example.com']);
  });

  it('maps a policy rejection after DATA', async () => {
    await expectMailError(svc.sendEmail({ to: ['x@reject-data.test'], subject: 'x', body: 'x' }), 'SMTP', /554/);
  });
});

describe('reply_to_message', () => {
  it('replies to all with Reply-To, the original To/Cc, threading headers and \\Answered', async () => {
    expect(await rawFlags('INBOX', 15)).not.toContain('\\Answered');
    const res = await svc.replyToMessage({ mailbox: 'INBOX', uid: 15, body: 'Vegetarian, please.', replyAll: true });
    const r = asSent(res);
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.headers?.to).toEqual(['offsite@example.com', 'alice@example.com', 'bob@example.org', 'carol@example.net']);
    expect(sidecar?.headers?.cc).toEqual(['erin@example.com', 'hr@example.com']);
    expect(sidecar?.envelope.rcptTo).not.toContain('testuser@icloud.test');
    expect(sidecar?.headers?.subject).toBe('Re: Team offsite planning');
    expect(sidecar?.headers?.inReplyTo).toBe('<offsite-2026@example.com>');
    expect(sidecar?.headers?.references).toBe('<offsite-2026@example.com>');
    const parsed = await simpleParser(readEml(sidecar!));
    expect(parsed.text).toMatch(/^Vegetarian, please\.\n\nOn Fri, 12 Jun 2026 at 15:40 \(-07:00\), Frank Li <frank@example\.com> wrote:\n> Hi all,/);
    expect(res).toMatchObject({ original: { mailbox: 'INBOX', uid: 15 }, original_marked: true });
    expect(await rawFlags('INBOX', 15)).toContain('\\Answered');
  });

  it('replies to the sender only by default and extends References', async () => {
    const r = asSent(await svc.replyToMessage({ mailbox: 'INBOX', uid: 23, body: 'Thanks Dave' }));
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.headers?.to).toEqual(['dave@example.com']);
    expect(sidecar?.headers?.cc).toEqual([]);
    expect(sidecar?.headers?.subject).toBe('Re: Project kickoff');
    expect(sidecar?.headers?.inReplyTo).toBe('<kickoff-3@example.com>');
    expect(sidecar?.headers?.references).toEqual(['<kickoff-1@example.com>', '<kickoff-2@icloud.test>', '<kickoff-3@example.com>']);
  });

  it('replying to our own sent message goes to its original recipients', async () => {
    const r = asSent(await svc.replyToMessage({ mailbox: 'Sent Messages', uid: 1, body: 'Following up' }));
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.headers?.to).toEqual(['alice@example.com']);
    expect(sidecar?.headers?.subject).toBe('Re: Lunch on Thursday?');
  });
});

describe('forward_message', () => {
  it('forwards with the original attachments and sets $Forwarded', async () => {
    expect(await rawFlags('INBOX', 6)).not.toContain('$Forwarded');
    const res = await svc.forwardMessage({ mailbox: 'INBOX', uid: 6, to: ['accounting@example.com'], body: 'Please pay this.' });
    const r = asSent(res);
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.headers?.subject).toBe('Fwd: Invoice #10423 for March');
    expect(sidecar?.headers?.attachments).toEqual([expect.objectContaining({ filename: 'Invoice-10423.pdf', contentType: 'application/pdf' })]);
    const parsed = await simpleParser(readEml(sidecar!));
    expect(parsed.text).toMatch(/^Please pay this\.\n\n---------- Forwarded message ----------\nFrom: Vendor Billing <billing@vendor\.example>\nDate: /);
    expect(parsed.attachments[0]?.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res).toMatchObject({ original_marked: true });
    expect(await rawFlags('INBOX', 6)).toContain('$Forwarded');
  });

  it('can forward without attachments', async () => {
    const r = asSent(await svc.forwardMessage({ mailbox: 'INBOX', uid: 8, to: ['friend@example.com'], includeAttachments: false }));
    expect(findSidecarByMessageId(r.message_id)?.headers?.attachments).toEqual([]);
  });
});

describe('guardrails', () => {
  it('enforces the hourly rate limit across send tools', async () => {
    const limited = createTestService(dirs, { MAIL_MAX_SENDS_PER_HOUR: '1' });
    try {
      asSent(await limited.sendEmail({ to: ['friend@example.com'], subject: 'rate 1', body: 'x' }));
      expect(limited.rateLimiter.remaining()).toBe(0);
      await expectMailError(limited.replyToMessage({ mailbox: 'INBOX', uid: 2, body: 'x' }), 'RATE_LIMIT', /MAIL_MAX_SENDS_PER_HOUR/);
    } finally {
      await limited.close();
    }
  });

  it('a failed send does not use up the rate limit', async () => {
    const limited = createTestService(dirs, { MAIL_MAX_SENDS_PER_HOUR: '1' });
    try {
      await expectMailError(limited.sendEmail({ to: ['nobody@reject.test'], subject: 'x', body: 'x' }), 'SMTP');
      expect(limited.rateLimiter.remaining()).toBe(1);
    } finally {
      await limited.close();
    }
  });

  it('refuses to send when sending is disabled, but drafts still work', async () => {
    const noSend = createTestService(dirs, { MAIL_ALLOW_SEND: 'false' });
    try {
      await expectMailError(noSend.sendEmail({ to: ['friend@example.com'], subject: 'x', body: 'x' }), 'FORBIDDEN', /MAIL_ALLOW_SEND/);
      const d = await noSend.saveDraft({ to: ['friend@example.com'], body: 'draft while send is off' });
      expect(d.saved).toBe(true);
    } finally {
      await noSend.close();
    }
  });

  it('confirmation dialog: Cancel means not sent; unavailable fails closed; Send proceeds', async () => {
    const seen: string[] = [];
    const make = (status: 'confirmed' | 'declined' | 'unavailable') =>
      createTestService(
        dirs,
        { MAIL_CONFIRM_DIALOG: 'true' },
        {
          confirm: (req) => {
            seen.push(req.message);
            if (status === 'confirmed') return Promise.resolve({ status: 'confirmed' });
            if (status === 'declined') return Promise.resolve({ status: 'declined', reason: 'cancelled' });
            return Promise.resolve({ status: 'unavailable', reason: 'not macOS' });
          },
        },
      );
    const before = listSidecars().length;
    const cancel = make('declined');
    const unavailable = make('unavailable');
    const ok = make('confirmed');
    try {
      const res = await cancel.sendEmail({ to: ['friend@example.com'], bcc: ['hidden@example.net'], subject: 'Needs a click', body: 'x' });
      expect(res).toMatchObject({ sent: false, cancelled: true, reason: 'cancelled' });
      expect(seen[0]).toContain('Bcc (1): hidden@example.net');
      expect(seen[0]).toContain('Subject: Needs a click');
      await expectMailError(unavailable.sendEmail({ to: ['friend@example.com'], subject: 'x', body: 'x' }), 'CONFIRM_UNAVAILABLE', /MAIL_CONFIRM_DIALOG=false/);
      expect(listSidecars().length).toBe(before);
      asSent(await ok.sendEmail({ to: ['friend@example.com'], subject: 'Clicked', body: 'x' }));
      expect(listSidecars().length).toBe(before + 1);
    } finally {
      await Promise.all([cancel.close(), unavailable.close(), ok.close()]);
    }
  });

  it('an aborted signal stops the send before SMTP', async () => {
    const ac = new AbortController();
    ac.abort();
    const before = listSidecars().length;
    await expectMailError(svc.sendEmail({ to: ['friend@example.com'], subject: 'x', body: 'x' }, { signal: ac.signal }), 'CANCELLED');
    expect(listSidecars().length).toBe(before);
  });
});

describe('authentication failures', () => {
  it('IMAP: wrong password gives the friendly app-specific-password guidance', async () => {
    const bad = createTestService(dirs, { ICLOUD_APP_PASSWORD: 'wrong-password' });
    try {
      const err = await expectMailError(bad.listMailboxes(), 'AUTH', /app-specific password/);
      expect(err.message).toMatch(/revoked/);
      expect(err.message).toMatch(/@icloud\.com address/);
      expect(err.message).toMatch(/two-factor/);
      expect(err.message).not.toContain('wrong-password');
      // Not an icloud.com/me.com/mac.com address: no local-part retry.
      expect(err.message).toContain('"testuser@icloud.test"');
      expect(err.message).not.toContain('"testuser" and');
      const info = await bad.getAccountInfo();
      expect(info['status']).toBe('connection failed');
      expect(String(info['connection_error'])).toMatch(/rejected the login/);
    } finally {
      await bad.close();
    }
  });

  it('SMTP: wrong password gives the friendly guidance and sends nothing', async () => {
    const bad = createTestService(dirs, { ICLOUD_APP_PASSWORD: 'wrong-password' });
    try {
      const err = await expectMailError(bad.sendEmail({ to: ['friend@example.com'], subject: 'x', body: 'x' }), 'AUTH', /SMTP .*rejected the login/);
      expect(err.message).toMatch(/full iCloud Mail address/);
      expect(err.message).not.toContain('wrong-password');
    } finally {
      await bad.close();
    }
  });

  it('ICLOUD_IMAP_USER overrides the login (local part works on this server)', async () => {
    const local = createTestService(dirs, { ICLOUD_IMAP_USER: 'testuser' });
    try {
      await local.listMailboxes();
      expect(local.imap.effectiveUser).toBe('testuser');
    } finally {
      await local.close();
    }
  });

  it('missing configuration is reported by every tool, and account info still works', async () => {
    const empty = createTestService(dirs, { ICLOUD_EMAIL: '', ICLOUD_APP_PASSWORD: '${user_config.app_specific_password}' });
    try {
      await expectMailError(empty.listMailboxes(), 'CONFIG', /ICLOUD_EMAIL is not set/);
      await expectMailError(empty.sendEmail({ to: ['a@example.com'], subject: 'x', body: 'x' }), 'CONFIG', /App-Specific Passwords/);
      const info = await empty.getAccountInfo();
      expect(info['status']).toBe('not configured');
      expect(info['config_errors']).toEqual([expect.stringMatching(/ICLOUD_EMAIL/)]);
    } finally {
      await empty.close();
    }
  });
});
