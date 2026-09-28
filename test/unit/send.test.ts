import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NodemailerError, SMTPSentMessageInfo } from 'nodemailer';
import { afterAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit.js';
import { loadConfig } from '../../src/config.js';
import { CredentialProvider } from '../../src/credentials.js';
import { MailError } from '../../src/errors.js';
import type { ImapManager } from '../../src/imap/client.js';
import type { MailboxRegistry } from '../../src/imap/mailboxes.js';
import { clearSecrets, createLogger, registerSecret } from '../../src/log.js';
import { buildMessage } from '../../src/smtp/compose.js';
import { RateLimiter, Sender, explainRecipientRejection, mapSmtpError, type TransportFactory } from '../../src/smtp/send.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'send-test-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSecrets();
});

describe('RateLimiter', () => {
  it('allows max sends per rolling hour and frees slots as they age out', () => {
    let now = 1_000_000;
    const rl = new RateLimiter(2, () => now);
    expect(rl.remaining()).toBe(2);
    rl.reserve().commit();
    now += 10 * 60_000;
    rl.reserve().commit();
    expect(rl.remaining()).toBe(0);
    expect(() => rl.reserve()).toThrow(MailError);
    try {
      rl.assertAllowed();
    } catch (e) {
      expect((e as MailError).code).toBe('RATE_LIMIT');
      expect((e as MailError).message).toMatch(/at most 2 emails per hour.*about 50 minutes/);
    }
    now += 50 * 60_000 + 1; // first send is now older than an hour
    expect(rl.remaining()).toBe(1);
    expect(rl.retryAfterSeconds()).toBe(0);
  });

  it('counts pending reservations, and released reservations do not count', () => {
    const rl = new RateLimiter(1);
    const r = rl.reserve();
    expect(rl.remaining()).toBe(0);
    expect(() => rl.reserve()).toThrow(/Send limit reached/);
    r.release();
    r.commit(); // no effect after release
    expect(rl.remaining()).toBe(1);
  });

  it('0 means unlimited', () => {
    const rl = new RateLimiter(0);
    for (let i = 0; i < 1000; i++) rl.reserve().commit();
    expect(rl.remaining()).toBeNull();
  });
});

function smtpErr(message: string, extra: Partial<NodemailerError>): NodemailerError {
  return Object.assign(new Error(message), extra);
}

describe('SMTP error mapping', () => {
  const ctx = { host: 'smtp.mail.me.com', port: 587, user: 'me@icloud.com' };
  it('535 → auth guidance mentioning the full address', () => {
    const e = mapSmtpError(smtpErr('Invalid login', { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication credentials invalid' }), ctx);
    expect(e.code).toBe('AUTH');
    expect(e.message).toMatch(/app-specific password/);
    expect(e.message).toMatch(/full iCloud email address/);
  });

  it('550 5.7.0 → From is not one of your addresses', () => {
    const e = mapSmtpError(smtpErr('Mail command failed', { code: 'EENVELOPE', responseCode: 550, response: '550 5.7.0 From address is not one of your addresses' }), ctx);
    expect(e.message).toMatch(/alias/);
    expect(e.message).toMatch(/Not sent/);
  });

  it('552 size, 452 recipients, other 4xx temporary', () => {
    expect(mapSmtpError(smtpErr('x', { responseCode: 552, response: '552 5.3.4 too big' }), ctx).code).toBe('TOO_LARGE');
    expect(mapSmtpError(smtpErr('x', { responseCode: 452, response: '452 4.5.3 Too many recipients' }), ctx).message).toMatch(/500 per message/);
    expect(mapSmtpError(smtpErr('x', { responseCode: 421, response: '421 try later' }), ctx).message).toMatch(/temporary.*retrying later may work/);
  });

  it('all recipients rejected lists each reason', () => {
    const e = mapSmtpError(
      smtpErr("Can't send mail - all recipients were rejected", {
        code: 'EENVELOPE',
        responseCode: 451,
        rejectedErrors: [
          smtpErr('x', { recipient: 'a@reject.test', responseCode: 550, response: '550 5.1.1 User unknown' }),
          smtpErr('y', { recipient: 'b@tempfail.test', responseCode: 451, response: '451 4.3.0 try again later' }),
        ],
      }),
      ctx,
    );
    expect(e.message).toMatch(/All recipients were rejected.*a@reject\.test: 550 5\.1\.1 User unknown \(the address was refused.*b@tempfail\.test: 451 4\.3\.0 try again later \(temporary/);
    expect(e.details?.['rejected']).toHaveLength(2);
  });

  it('connection and TLS failures', () => {
    expect(mapSmtpError(smtpErr('Greeting never received', { code: 'ETIMEDOUT' }), ctx).code).toBe('CONNECTION');
    expect(mapSmtpError(smtpErr('self-signed certificate in certificate chain', { code: 'SELF_SIGNED_CERT_IN_CHAIN' }), ctx).message).toMatch(/MAIL_TLS_CA_FILE/);
  });

  it('redacts secrets from server text', () => {
    registerSecret('pw-abc-123-xyz');
    expect(mapSmtpError(smtpErr('x', { responseCode: 554, response: '554 rejected pw-abc-123-xyz' }), ctx).message).not.toContain('pw-abc-123-xyz');
  });

  it('explains single recipient rejections', () => {
    expect(explainRecipientRejection(smtpErr('x', { responseCode: 451, response: '451 later' }))).toMatch(/temporary/);
    expect(explainRecipientRejection(smtpErr('x', { responseCode: 550, response: '550 no' }))).toMatch(/refused/);
  });
});

describe('Sender pipeline (fake transport)', () => {
  const { config } = loadConfig(
    { ICLOUD_EMAIL: 'me@icloud.com', ICLOUD_APP_PASSWORD: 'app-pass-000', MAIL_AUDIT_LOG: path.join(dir, 'audit.jsonl'), MAIL_SAVE_SENT_COPY: 'false', MAIL_CONFIRM_DIALOG: 'true' },
    { platform: 'linux', home: dir },
  );
  const logger = createLogger({ level: 'error', sink: () => undefined });

  function sender(transport: TransportFactory, confirmStatus: 'confirmed' | 'declined' | 'unavailable' = 'confirmed') {
    const rateLimiter = new RateLimiter(5);
    const s = new Sender({
      config,
      credentials: new CredentialProvider(config, { platform: 'linux' }),
      imap: {} as ImapManager,
      registry: {} as MailboxRegistry,
      audit: new AuditLog(config.auditLog, logger),
      rateLimiter,
      confirm: () =>
        Promise.resolve(
          confirmStatus === 'confirmed' ? { status: 'confirmed' } : confirmStatus === 'declined' ? { status: 'declined', reason: 'timeout' } : { status: 'unavailable', reason: 'nope' },
        ),
      tlsOptions: () => ({ minVersion: 'TLSv1.2' }),
      logger,
      transportFactory: transport,
    });
    return { s, rateLimiter };
  }

  const message = () =>
    buildMessage({ from: { name: '', address: 'me@icloud.com' }, to: [{ name: '', address: 'a@example.com' }], cc: [], bcc: [{ name: '', address: 'b@example.com' }], subject: 'S', text: 'T', attachments: [] });

  it('sends the Bcc-less raw bytes with the envelope and the same Message-ID, on a per-send transport', async () => {
    const seen: Array<{ options: unknown; mail: unknown }> = [];
    let closed = 0;
    const transport: TransportFactory = (options) => ({
      sendMail: (mail) => {
        seen.push({ options, mail });
        return Promise.resolve({ accepted: ['a@example.com', 'b@example.com'], rejected: [], messageId: mail.messageId, envelope: { from: 'me@icloud.com', to: [] }, response: '250 ok' } as unknown as SMTPSentMessageInfo);
      },
      close: () => {
        closed++;
      },
    });
    const built = await message();
    const { s, rateLimiter } = sender(transport);
    const r = await s.send(built, { tool: 'send_email' });
    expect(r).toMatchObject({ sent: true, message_id: built.messageId, accepted: ['a@example.com', 'b@example.com'], rejected: [], sent_copy_saved: false });
    const mail = seen[0]?.mail as { raw: Buffer; envelope: unknown; messageId: string; disableFileAccess: boolean; disableUrlAccess: boolean };
    expect(mail.raw).toBe(built.raw);
    expect(mail.raw.toString()).not.toMatch(/^Bcc:/m);
    expect(mail.envelope).toEqual({ from: 'me@icloud.com', to: ['a@example.com', 'b@example.com'] });
    expect(mail.messageId).toBe(built.messageId);
    expect(mail.disableFileAccess).toBe(true);
    expect(mail.disableUrlAccess).toBe(true);
    const opts = seen[0]?.options as Record<string, unknown>;
    expect(opts).toMatchObject({ host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true, auth: { user: 'me@icloud.com', pass: 'app-pass-000' } });
    expect('logger' in opts).toBe(false);
    expect(closed).toBe(1);
    expect(rateLimiter.remaining()).toBe(4);
  });

  it('declined dialog: not sent, no transport, slot released', async () => {
    let created = 0;
    const { s, rateLimiter } = sender(() => {
      created++;
      throw new Error('should not be created');
    }, 'declined');
    const r = await s.send(await message(), { tool: 'send_email' });
    expect(r).toEqual({ sent: false, cancelled: true, reason: 'timeout', message: expect.stringMatching(/timed out/) as string });
    expect(created).toBe(0);
    expect(rateLimiter.remaining()).toBe(5);
  });

  it('dialog unavailable: fails closed', async () => {
    const { s } = sender(() => {
      throw new Error('should not be created');
    }, 'unavailable');
    await expect(s.send(await message(), { tool: 'send_email' })).rejects.toMatchObject({ code: 'CONFIRM_UNAVAILABLE' });
  });

  it('SMTP failure: mapped error, slot released, transport closed', async () => {
    let closed = 0;
    const { s, rateLimiter } = sender(() => ({
      sendMail: () => Promise.reject(smtpErr('Invalid login', { code: 'EAUTH', responseCode: 535, response: '535 no' })),
      close: () => {
        closed++;
      },
    }));
    await expect(s.send(await message(), { tool: 'send_email' })).rejects.toMatchObject({ code: 'AUTH' });
    expect(rateLimiter.remaining()).toBe(5);
    expect(closed).toBe(1);
  });
});
