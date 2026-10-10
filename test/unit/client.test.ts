import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { ImapFlow, ImapFlowOptions } from 'imapflow';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { CredentialProvider } from '../../src/credentials.js';
import { MailError } from '../../src/errors.js';
import { ImapManager, authFailureMessage, imapLoginCandidates, isConnectionError, isCredentialFailure, mapImapError, serverTextOf } from '../../src/imap/client.js';
import { clearSecrets, createLogger, registerSecret } from '../../src/log.js';

type Listener = (...args: unknown[]) => void;

/** Minimal stand-in for ImapFlow covering what ImapManager uses. */
class FakeImap {
  static instances: FakeImap[] = [];
  usable = false;
  capabilities = new Map<string, boolean | number>([
    ['IMAP4rev1', true],
    ['UIDPLUS', true],
    ['WITHIN', true],
  ]);
  mailbox: { path: string; readOnly: boolean; exists: number } | false = false;
  listeners = new Map<string, Listener[]>();
  loggedOut = false;
  closed = false;
  locks: Array<{ path: string; readOnly: boolean; released: boolean }> = [];
  constructor(
    readonly options: ImapFlowOptions,
    private readonly behaviour: { failAuthFor?: string[]; failConnect?: Error },
  ) {
    FakeImap.instances.push(this);
  }
  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
  connect(): Promise<void> {
    if (this.behaviour.failConnect) return Promise.reject(this.behaviour.failConnect);
    if (this.behaviour.failAuthFor?.includes(this.options.auth?.user ?? '')) {
      return Promise.reject(Object.assign(new Error('Authentication failed'), { authenticationFailed: true, serverResponseCode: 'AUTHENTICATIONFAILED' }));
    }
    this.usable = true;
    return Promise.resolve();
  }
  static lockErrors: Error[] = [];
  getMailboxLock(p: string, opts: { readOnly?: boolean }): Promise<{ path: string; release: () => void }> {
    const lockErr = FakeImap.lockErrors.shift();
    if (lockErr) return Promise.reject(lockErr);
    const lock = { path: p, readOnly: !!opts.readOnly, released: false };
    this.locks.push(lock);
    this.mailbox = { path: p, readOnly: !!opts.readOnly, exists: 3 };
    return Promise.resolve({ path: p, release: () => (lock.released = true) });
  }
  noopFails = false;
  noops = 0;
  noop(): Promise<void> {
    this.noops++;
    return this.noopFails ? Promise.reject(Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })) : Promise.resolve();
  }
  logout(): Promise<void> {
    this.loggedOut = true;
    this.kill();
    return Promise.resolve();
  }
  close(): void {
    this.kill();
  }
  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.usable = false;
    this.emit('close');
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'client-test-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSecrets();
});

function manager(env: Record<string, string>, behaviour: { failAuthFor?: string[]; failConnect?: Error } = {}, extra: { idleCloseMs?: number; healthCheckAfterMs?: number } = {}) {
  FakeImap.instances = [];
  const { config } = loadConfig({ ICLOUD_APP_PASSWORD: 'app-pass-1234', MAIL_AUDIT_LOG: 'off', ...env }, { platform: 'linux', home: dir });
  const credentials = new CredentialProvider(config, { platform: 'linux' });
  let invalidated = 0;
  const origInvalidate = credentials.invalidate.bind(credentials);
  credentials.invalidate = () => {
    invalidated++;
    origInvalidate();
  };
  const created: ImapFlowOptions[] = [];
  const m = new ImapManager({
    config,
    credentials,
    logger: createLogger({ level: 'error', sink: () => undefined }),
    idleCloseMs: extra.idleCloseMs ?? 60_000,
    healthCheckAfterMs: extra.healthCheckAfterMs ?? 60_000,
    // The fake implements the subset of ImapFlow that ImapManager touches.
    createClient: (options) => {
      created.push(options);
      return new FakeImap(options, behaviour) as unknown as ImapFlow;
    },
  });
  return { m, created, invalidations: () => invalidated };
}

describe('login candidates', () => {
  it('tries the full address, then the local part for icloud.com/me.com/mac.com only', () => {
    expect(imapLoginCandidates('john@icloud.com', undefined)).toEqual(['john@icloud.com', 'john']);
    expect(imapLoginCandidates('john@ME.com', undefined)).toEqual(['john@ME.com', 'john']);
    expect(imapLoginCandidates('john@mac.com', undefined)).toEqual(['john@mac.com', 'john']);
    expect(imapLoginCandidates('john@custom.dev', undefined)).toEqual(['john@custom.dev']);
    expect(imapLoginCandidates('john@icloud.com', 'override@icloud.com')).toEqual(['override@icloud.com']);
    expect(imapLoginCandidates('', undefined)).toEqual([]);
  });
});

describe('ImapManager', () => {
  it('connects lazily with a non-stdout logger, TLS >= 1.2 and disables WITHIN', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@icloud.com' });
    expect(created).toHaveLength(0);
    const client = await m.connection();
    expect(created).toHaveLength(1);
    const opts = created[0] as ImapFlowOptions;
    expect(opts.logger).toBeTypeOf('object');
    expect(opts.logger).not.toBeUndefined();
    expect(opts.host).toBe('imap.mail.me.com');
    expect(opts.port).toBe(993);
    expect(opts.secure).toBe(true);
    expect(opts.tls?.minVersion).toBe('TLSv1.2');
    expect(client.capabilities.has('WITHIN')).toBe(false);
    expect(m.effectiveUser).toBe('john@icloud.com');
  });

  it('falls back to the local part after an auth failure and remembers it', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@icloud.com' }, { failAuthFor: ['john@icloud.com'] });
    await m.connection();
    expect(created.map((o) => o.auth?.user)).toEqual(['john@icloud.com', 'john']);
    expect(m.effectiveUser).toBe('john');
    (FakeImap.instances[1] as FakeImap).kill();
    await m.connection();
    expect(created.map((o) => o.auth?.user)).toEqual(['john@icloud.com', 'john', 'john']);
  });

  it('does not retry with the local part for custom domains, and invalidates cached credentials', async () => {
    const { m, created, invalidations } = manager({ ICLOUD_EMAIL: 'me@custom.dev' }, { failAuthFor: ['me@custom.dev'] });
    const err = await m.connection().then(
      () => null,
      (e: unknown) => e as MailError,
    );
    expect(err).toBeInstanceOf(MailError);
    expect(err?.code).toBe('AUTH');
    expect(err?.message).toContain('"me@custom.dev"');
    expect(err?.message).toMatch(/custom-domain users: enter your primary @icloud\.com address as "iCloud email address"/);
    expect(created).toHaveLength(1);
    expect(invalidations()).toBe(1);
  });

  it('reports both logins when the fallback also fails', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@icloud.com' }, { failAuthFor: ['john@icloud.com', 'john'] });
    const err = await m.connection().catch((e: unknown) => e as MailError);
    expect((err as MailError).message).toContain('"john@icloud.com" and "john"');
  });

  it('shares one in-flight connect between concurrent callers', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@custom.dev' });
    const [a, b] = await Promise.all([m.connection(), m.connection()]);
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('creates a new instance after the connection closes (ImapFlow cannot reconnect)', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@custom.dev' });
    const first = await m.connection();
    (FakeImap.instances[0] as FakeImap).kill();
    const second = await m.connection();
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
    (FakeImap.instances[1] as FakeImap).usable = false; // e.g. socket died without a close event yet
    await m.connection();
    expect(created).toHaveLength(3);
  });

  it('runs mailbox work under a lock (EXAMINE for reads) and always releases it', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@custom.dev' });
    const exists = await m.withMailbox('INBOX', (_c, mb) => Promise.resolve(mb.exists), { readOnly: true });
    expect(exists).toBe(3);
    const fake = FakeImap.instances[0] as FakeImap;
    expect(fake.locks[0]).toEqual({ path: 'INBOX', readOnly: true, released: true });
    await expect(m.withMailbox('Archive', () => Promise.reject(new MailError('NOT_FOUND', 'nope')), { readOnly: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.locks[1]).toEqual({ path: 'Archive', readOnly: false, released: true });
  });

  it('retries a read once on a fresh connection when the connection died, but never a write', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@custom.dev' });
    let calls = 0;
    const result = await m.withMailbox(
      'INBOX',
      () => {
        calls++;
        if (calls === 1) {
          (FakeImap.instances[0] as FakeImap).kill();
          return Promise.reject(Object.assign(new Error('Connection not available'), { code: 'NoConnection' }));
        }
        return Promise.resolve('ok');
      },
      { readOnly: true },
    );
    expect(result).toBe('ok');
    expect(created).toHaveLength(2);

    let writes = 0;
    const err = await m
      .withMailbox(
        'INBOX',
        () => {
          writes++;
          (FakeImap.instances[1] as FakeImap).kill();
          return Promise.reject(Object.assign(new Error('socket closed'), { code: 'EConnectionClosed' }));
        },
        { readOnly: false },
      )
      .catch((e: unknown) => e as MailError);
    expect(writes).toBe(1);
    expect((err as MailError).code).toBe('CONNECTION');
  });

  it('probes a long-idle connection with NOOP and replaces it when it does not answer', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@custom.dev' }, {}, { healthCheckAfterMs: 0 });
    await m.run(() => Promise.resolve(1));
    const first = FakeImap.instances[0] as FakeImap;
    await m.run(() => Promise.resolve(2));
    expect(first.noops).toBe(1);
    expect(created).toHaveLength(1);
    first.noopFails = true;
    await m.run(() => Promise.resolve(3));
    expect(created).toHaveLength(2);
    expect(first.closed).toBe(true);
  });

  it('skips the probe when the connection was used recently', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@custom.dev' });
    await m.run(() => Promise.resolve(1));
    await m.run(() => Promise.resolve(2));
    expect((FakeImap.instances[0] as FakeImap).noops).toBe(0);
  });

  it('logs out after the idle timeout', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@custom.dev' }, {}, { idleCloseMs: 20 });
    await m.run(() => Promise.resolve(1));
    const fake = FakeImap.instances[0] as FakeImap;
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.loggedOut).toBe(true);
    expect(m.isConnected).toBe(false);
  });

  it('close() logs out and refuses further work', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@custom.dev' });
    await m.connection();
    await m.close();
    expect((FakeImap.instances[0] as FakeImap).loggedOut).toBe(true);
    await expect(m.connection()).rejects.toMatchObject({ code: 'CONNECTION' });
  });

  it('release() logs out but a later operation reconnects', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@custom.dev' });
    await m.connection();
    await m.release();
    expect((FakeImap.instances[0] as FakeImap).loggedOut).toBe(true);
    expect(m.isConnected).toBe(false);
    await m.connection();
    expect(FakeImap.instances).toHaveLength(2);
    expect(m.isConnected).toBe(true);
  });

  it('maps connection failures to friendly errors', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@custom.dev' }, { failConnect: Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:993'), { code: 'ECONNREFUSED' }) });
    await expect(m.connection()).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/Could not talk to the IMAP server imap\.mail\.me\.com:993 \(ECONNREFUSED\)/) as string });
  });

  it('trusts the extra CA from MAIL_TLS_CA_FILE in addition to the system roots', () => {
    const ca = path.join(dir, 'ca.pem');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    const { m } = manager({ ICLOUD_EMAIL: 'john@custom.dev', MAIL_TLS_CA_FILE: ca });
    const opts = m.tlsOptions();
    expect(Array.isArray(opts.ca)).toBe(true);
    expect((opts.ca as string[]).length).toBe(tls.rootCertificates.length + 1);
    expect(opts.rejectUnauthorized).toBeUndefined();
    const missing = manager({ ICLOUD_EMAIL: 'john@custom.dev', MAIL_TLS_CA_FILE: path.join(dir, 'nope.pem') }).m;
    expect(() => missing.tlsOptions()).toThrow(/MAIL_TLS_CA_FILE could not be read/);
  });
});

describe('stuck connections', () => {
  // imap-4: a lock wait that times out means the holder is stuck: reset and retry once, even for writes.
  it('replaces the connection after a mailbox lock timeout and retries once', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@icloud.com' });
    FakeImap.lockErrors = [Object.assign(new Error('lock wait timed out'), { code: 'LockTimeout' })];
    const r = await m.withMailbox('INBOX', async () => 'ok', { readOnly: false, retry: false });
    expect(r).toBe('ok');
    expect(created).toHaveLength(2);
    expect(FakeImap.instances[0]?.closed).toBe(true);
  });

  it('gives up with a CONNECTION error when the lock also times out on the new connection', async () => {
    const { m } = manager({ ICLOUD_EMAIL: 'john@icloud.com' });
    const lockErr = (): Error => Object.assign(new Error('lock wait timed out'), { code: 'LockTimeout' });
    FakeImap.lockErrors = [lockErr(), lockErr()];
    const e = await m.withMailbox('INBOX', async () => 'ok', { readOnly: true }).catch((err: unknown) => err as MailError);
    expect(e).toBeInstanceOf(MailError);
    expect((e as MailError).code).toBe('CONNECTION');
    FakeImap.lockErrors = [];
  });
});

describe('connection options', () => {
  // imap-9: no ENABLE CONDSTORE / UTF8=ACCEPT after login.
  it('disables imapflow\'s auto-ENABLE and QRESYNC', async () => {
    const { m, created } = manager({ ICLOUD_EMAIL: 'john@icloud.com' });
    await m.connection();
    expect(created[0]?.disableAutoEnable).toBe(true);
    expect(created[0]?.qresync).toBe(false);
  });

  // tls-1: without implicit TLS, STARTTLS is mandatory unless the test-only switch is set.
  it('requires STARTTLS when IMAP_SECURE=false', async () => {
    const a = manager({ ICLOUD_EMAIL: 'john@icloud.com', IMAP_SECURE: 'false' });
    await a.m.connection();
    expect(a.created[0]?.doSTARTTLS).toBe(true);
    const b = manager({ ICLOUD_EMAIL: 'john@icloud.com', IMAP_SECURE: 'false', IMAP_ALLOW_PLAINTEXT: 'true' });
    await b.m.connection();
    expect(b.created[0]?.doSTARTTLS).toBeUndefined();
    const c = manager({ ICLOUD_EMAIL: 'john@icloud.com' });
    await c.m.connection();
    expect(c.created[0]?.doSTARTTLS).toBeUndefined();
  });
});

// integ-2: only credential response codes mean a wrong password.
describe('login refusal classification', () => {
  it('uses the RFC 5530 response code', () => {
    expect(isCredentialFailure({ authenticationFailed: true, serverResponseCode: 'UNAVAILABLE' })).toBe(false);
    expect(isCredentialFailure({ authenticationFailed: true, serverResponseCode: 'LIMIT' })).toBe(false);
    expect(isCredentialFailure({ authenticationFailed: true })).toBe(true);
    expect(isCredentialFailure({ serverResponseCode: 'AUTHENTICATIONFAILED' })).toBe(true);
    expect(isCredentialFailure({ code: 'ECONNRESET' })).toBe(false);
    const e = mapImapError({ authenticationFailed: true, serverResponseCode: 'UNAVAILABLE', response: '2 NO [UNAVAILABLE] Maximum number of connections' }, { host: 'h', port: 1 });
    expect(e.code).toBe('CONNECTION');
    expect(e.message).toContain('(server said: [UNAVAILABLE] Maximum number of connections)');
    expect(mapImapError({ authenticationFailed: true }, { host: 'h', port: 1, users: ['a@icloud.com'] }).code).toBe('AUTH');
  });

  it('quotes the server text without the tag', () => {
    expect(serverTextOf({ response: 'A7 NO [ALERT] Slow down' })).toBe('[ALERT] Slow down');
    expect(serverTextOf({ responseText: 'Try later', serverResponseCode: 'INUSE' })).toBe('[INUSE] Try later');
    expect(serverTextOf({})).toBeUndefined();
  });
});

describe('mapImapError', () => {
  const ctx = { host: 'imap.mail.me.com', port: 993, users: ['me@icloud.com'] };
  it('recognises auth, TLS, throttling, lock timeouts and connection errors', () => {
    expect(mapImapError(Object.assign(new Error('x'), { authenticationFailed: true }), ctx).code).toBe('AUTH');
    expect(mapImapError(Object.assign(new Error('self-signed certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }), ctx).message).toMatch(/MAIL_TLS_CA_FILE/);
    expect(mapImapError(Object.assign(new Error('x'), { code: 'ETHROTTLE', throttleReset: 30_000 }), ctx).message).toMatch(/about 30 s/);
    expect(mapImapError(Object.assign(new Error('x'), { code: 'LockTimeout' }), ctx).code).toBe('CONNECTION');
    expect(mapImapError(Object.assign(new Error('x'), { _err: Object.assign(new Error('y'), { code: 'ETIMEDOUT' }) }), ctx).code).toBe('CONNECTION');
    expect(isConnectionError(Object.assign(new Error('x'), { code: 'NoConnection' }))).toBe(true);
    expect(isConnectionError(new Error('x'))).toBe(false);
  });

  it('passes server NO/BAD text through, redacted', () => {
    registerSecret('super-secret-pw');
    const e = mapImapError(Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'Quota exceeded for super-secret-pw' }), ctx);
    expect(e.code).toBe('SERVER');
    expect(e.message).toBe('The IMAP server refused the request: Quota exceeded for [REDACTED]');
    expect(mapImapError(new Error('boom super-secret-pw'), ctx).message).toBe('IMAP error: boom [REDACTED]');
  });

  it('keeps MailErrors as they are', () => {
    const me = new MailError('NOT_FOUND', 'x');
    expect(mapImapError(me, ctx)).toBe(me);
  });
});

describe('Gmail login failures', () => {
  it('explain Google app passwords, not Apple ones', () => {
    const msg = authFailureMessage('IMAP', 'imap.gmail.com', ['me@gmail.com']);
    expect(msg).toContain('Gmail IMAP (imap.gmail.com) rejected the login for "me@gmail.com"');
    expect(msg).toContain('myaccount.google.com/apppasswords');
    expect(msg).not.toContain('iCloud');
    expect(authFailureMessage('IMAP', 'imap.mail.me.com', ['me@icloud.com'])).toContain('iCloud IMAP');
  });
});
