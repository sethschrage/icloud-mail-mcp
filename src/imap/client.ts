/**
 * IMAP connection manager (SPEC §2.1, §2.6, §2.7, §3 ICLOUD_IMAP_USER).
 *
 * - One ImapFlow instance at a time, created lazily; a single in-flight connect promise is shared.
 * - ImapFlow instances cannot reconnect: on 'close' (or when `!usable`) the instance is dropped and
 *   a new one is created for the next operation.
 * - Every selected-mailbox operation runs inside `getMailboxLock` via `withMailbox()`.
 * - The connection is logged out after 5 minutes without activity.
 * - Login: ICLOUD_IMAP_USER if set; otherwise the full email, and on an authentication failure for
 *   icloud.com/me.com/mac.com addresses one retry with the local part. The working login is kept
 *   for the process lifetime.
 * - imapflow never gets its default (stdout) logger.
 */
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { ImapFlow, type ImapFlowOptions, type MailboxObject } from 'imapflow';
import type { Config } from '../config.js';
import { APP_PASSWORD_HELP, type CredentialProvider } from '../credentials.js';
import { MailError, errorMessage } from '../errors.js';
import { imapflowLogger, log as defaultLogger, redact, type Logger } from '../log.js';
import { domainOf, localPartOf } from '../smtp/address.js';
import { VERSION } from '../version.js';

export const ICLOUD_DOMAINS = ['icloud.com', 'me.com', 'mac.com'] as const;
export const IDLE_CLOSE_MS = 5 * 60_000;

/** Logins to try, in order (SPEC §3 ICLOUD_IMAP_USER). */
export function imapLoginCandidates(email: string, override: string | undefined): string[] {
  if (override) return [override];
  if (!email) return [];
  const candidates = [email];
  if ((ICLOUD_DOMAINS as readonly string[]).includes(domainOf(email))) {
    const local = localPartOf(email);
    if (local && local !== email) candidates.push(local);
  }
  return candidates;
}

export function authFailureMessage(service: 'IMAP' | 'SMTP', host: string, users: readonly string[]): string {
  const who = users.length ? users.map((u) => `"${u}"`).join(' and ') : 'the configured account';
  const loginHint =
    service === 'IMAP'
      ? '(3) the IMAP login may need to be the part of your address before "@" or your primary @icloud.com address: custom-domain users must log in with their @icloud.com address (set ICLOUD_IMAP_USER);'
      : '(3) SMTP needs your full iCloud email address as the login (custom-domain users: your primary @icloud.com address; set ICLOUD_SMTP_USER);';
  return (
    `iCloud ${service} (${host}) rejected the login for ${who}. Likely causes: ` +
    '(1) your regular Apple Account password was used instead of an app-specific password; ' +
    '(2) the app-specific password was revoked, which happens automatically when the Apple Account password is changed, so create a new one; ' +
    `${loginHint} ` +
    '(4) app-specific passwords require two-factor authentication on the Apple Account. ' +
    APP_PASSWORD_HELP
  );
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'StateLogout',
]);

interface ImapErrorLike {
  code?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  responseStatus?: unknown;
  responseText?: unknown;
  serverResponseCode?: unknown;
  throttleReset?: unknown;
  _err?: unknown;
  cause?: unknown;
}

function errorCode(err: unknown): string | undefined {
  const e = err as ImapErrorLike | null;
  if (!e || typeof e !== 'object') return undefined;
  if (typeof e.code === 'string') return e.code;
  return errorCode(e._err) ?? errorCode(e.cause);
}

/** True for errors that mean the connection itself is gone (safe to retry a read on a new one). */
export function isConnectionError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && CONNECTION_ERROR_CODES.has(code);
}

/** Translate an imapflow / socket error into a MailError with an actionable, redacted message. */
export function mapImapError(err: unknown, ctx: { host: string; port: number; users?: readonly string[] }): MailError {
  if (err instanceof MailError) return err;
  const e = (err ?? {}) as ImapErrorLike;
  const code = errorCode(err);
  const where = `${ctx.host}:${ctx.port}`;
  if (e.authenticationFailed === true || e.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new MailError('AUTH', authFailureMessage('IMAP', where, ctx.users ?? []), { cause: err });
  }
  if (e.tlsFailed === true || (code && TLS_ERROR_CODES.has(code))) {
    return new MailError(
      'CONNECTION',
      `TLS certificate verification failed for the IMAP server ${where} (${code ?? 'TLS error'}). If you use a server with a private certificate authority, point MAIL_TLS_CA_FILE at its CA certificate (TLS verification cannot be disabled).`,
      { cause: err },
    );
  }
  if (code === 'ETHROTTLE') {
    const secs = typeof e.throttleReset === 'number' ? Math.ceil(e.throttleReset / 1000) : undefined;
    return new MailError('CONNECTION', `iCloud is throttling IMAP requests${secs ? `; try again in about ${secs} s` : '; try again in a minute'}.`, { cause: err });
  }
  if (code === 'LockTimeout') {
    return new MailError('CONNECTION', 'Timed out waiting for another mail operation on this connection to finish. Try again.', { cause: err });
  }
  if (code && CONNECTION_ERROR_CODES.has(code)) {
    return new MailError(
      'CONNECTION',
      `Could not talk to the IMAP server ${where} (${code}). Check the Mac's internet connection; iCloud may also be temporarily unavailable. The next request will reconnect.`,
      { cause: err },
    );
  }
  if (e.responseStatus === 'NO' || e.responseStatus === 'BAD') {
    const text = typeof e.responseText === 'string' && e.responseText ? e.responseText : errorMessage(err);
    return new MailError('SERVER', `The IMAP server refused the request: ${redact(text)}`, { cause: err });
  }
  return new MailError('INTERNAL', `IMAP error: ${redact(errorMessage(err))}`, { cause: err });
}

export interface ImapManagerOptions {
  config: Config;
  credentials: CredentialProvider;
  logger?: Logger;
  idleCloseMs?: number;
  lockTimeoutMs?: number;
  /** Probe an existing connection with NOOP when it was idle for longer than this (default 60 s). */
  healthCheckAfterMs?: number;
  /** Test seam: build the ImapFlow instance. */
  createClient?: (options: ImapFlowOptions) => ImapFlow;
}

export interface WithMailboxOptions {
  readOnly: boolean;
  /** Retry once on a fresh connection if the connection turns out to be dead (reads only). */
  retry?: boolean;
}

export class ImapManager {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private loginUser: string | null = null;
  private active = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private lastActivity = Date.now();
  private readonly healthCheckAfterMs: number;
  private caCache: string | null | undefined;
  private readonly logger: Logger;
  private readonly idleCloseMs: number;
  private readonly lockTimeoutMs: number;
  private readonly createClient: (options: ImapFlowOptions) => ImapFlow;

  constructor(private readonly opts: ImapManagerOptions) {
    this.logger = opts.logger ?? defaultLogger;
    this.idleCloseMs = opts.idleCloseMs ?? IDLE_CLOSE_MS;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 60_000;
    this.healthCheckAfterMs = opts.healthCheckAfterMs ?? 60_000;
    this.createClient = opts.createClient ?? ((o) => new ImapFlow(o));
  }

  get config(): Config {
    return this.opts.config;
  }

  /** The login that last succeeded (null before the first successful connect). */
  get effectiveUser(): string | null {
    return this.loginUser;
  }

  /** Logins that will be tried on the next connect. */
  get plannedLogins(): string[] {
    return this.loginUser ? [this.loginUser] : imapLoginCandidates(this.config.email, this.config.imapUser);
  }

  get isConnected(): boolean {
    return !!this.client?.usable;
  }

  private tlsCa(): string | null {
    if (this.caCache !== undefined) return this.caCache;
    const file = this.config.tlsCaFile;
    if (!file) {
      this.caCache = null;
      return null;
    }
    try {
      this.caCache = readFileSync(file, 'utf8');
    } catch (err) {
      throw new MailError('CONFIG', `MAIL_TLS_CA_FILE could not be read (${file}): ${(err as NodeJS.ErrnoException).code ?? errorMessage(err)}.`);
    }
    return this.caCache;
  }

  /** TLS options shared with SMTP: TLS >= 1.2, system roots plus the optional extra CA. */
  tlsOptions(): tls.ConnectionOptions {
    const ca = this.tlsCa();
    return ca ? { minVersion: 'TLSv1.2', ca: [...tls.rootCertificates, ca] } : { minVersion: 'TLSv1.2' };
  }

  private buildClient(user: string, pass: string): ImapFlow {
    const { host, port, secure } = this.config.imap;
    const client = this.createClient({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: imapflowLogger(this.logger),
      emitLogs: false,
      clientInfo: { name: 'icloud-mail-mcp', version: VERSION, vendor: false, 'support-url': false },
      disableAutoIdle: true,
      connectionTimeout: 30_000,
      greetingTimeout: 16_000,
      socketTimeout: 5 * 60_000,
      tls: this.tlsOptions(),
      maxLockHoldTime: 90_000,
    });
    client.on('error', (err: Error) => {
      this.logger.warn('IMAP connection error', { code: errorCode(err), err: redact(errorMessage(err)) });
      if (this.client === client) this.client = null;
    });
    client.on('close', () => {
      this.logger.debug('IMAP connection closed');
      if (this.client === client) this.client = null;
    });
    return client;
  }

  private async connect(): Promise<ImapFlow> {
    if (!this.config.email && !this.config.imapUser) {
      throw new MailError('CONFIG', 'ICLOUD_EMAIL is not set, so there is no IMAP login to use.');
    }
    const { password } = await this.opts.credentials.getPassword();
    const candidates = this.plannedLogins;
    const tried: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const user = candidates[i] as string;
      tried.push(user);
      const client = this.buildClient(user, password);
      try {
        await client.connect();
      } catch (err) {
        try {
          client.close();
        } catch {
          // already closed
        }
        const authFailed = (err as ImapErrorLike | null)?.authenticationFailed === true;
        if (authFailed && i < candidates.length - 1) {
          this.logger.info('IMAP login failed; retrying with the next login form', { next: candidates[i + 1] });
          continue;
        }
        // Re-read the Keychain next time, in case the user fixes the stored password meanwhile.
        if (authFailed) this.opts.credentials.invalidate();
        throw mapImapError(err, { host: this.config.imap.host, port: this.config.imap.port, users: tried });
      }
      // imapflow turns SINCE/BEFORE into WITHIN (YOUNGER/OLDER, relative seconds) when WITHIN is
      // advertised. IMAP dates are date-only by design here (SPEC §5), and iCloud's WITHIN support
      // is unverified, so always use plain SINCE/BEFORE.
      client.capabilities.delete('WITHIN');
      if (this.loginUser !== user) this.logger.info('IMAP login succeeded', { user });
      this.loginUser = user;
      return client;
    }
    throw new MailError('CONFIG', 'No IMAP login is configured.');
  }

  /**
   * After a quiet period (e.g. the Mac slept) a socket can look usable but be dead, and the first
   * command would then hang until a TCP timeout. Probe it with NOOP (short cap) and replace it if needed.
   */
  private async healthy(client: ImapFlow): Promise<boolean> {
    if (Date.now() - this.lastActivity < this.healthCheckAfterMs) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      const probe = client.noop().then(() => true);
      const cap = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 10_000);
        timer.unref();
      });
      return (await Promise.race([probe, cap])) && client.usable;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Get a connected, usable client (lazy connect, one shared in-flight connect). */
  async connection(): Promise<ImapFlow> {
    if (this.shuttingDown) throw new MailError('CONNECTION', 'The mail server connection is shutting down.');
    const existing = this.client;
    if (existing && existing.usable && this.active <= 1 && !(await this.healthy(existing))) {
      this.logger.info('IMAP connection did not answer NOOP; reconnecting');
      if (this.client === existing) this.client = null;
      try {
        existing.close();
      } catch {
        // already closed
      }
    }
    if (this.client && this.client.usable) return this.client;
    if (this.client && !this.client.usable) this.client = null;
    if (!this.connecting) {
      this.connecting = this.connect()
        .then((c) => {
          this.client = c;
          return c;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  private begin(): void {
    this.active++;
    // lastActivity is only advanced when an operation ends, so a long idle gap is visible to healthy().
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private end(): void {
    this.active = Math.max(0, this.active - 1);
    this.lastActivity = Date.now();
    if (this.active === 0 && !this.shuttingDown && this.client) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.active === 0) void this.disconnect('idle');
      }, this.idleCloseMs);
      this.idleTimer.unref();
    }
  }

  private async attempt<T>(fn: (client: ImapFlow) => Promise<T>, retry: boolean): Promise<T> {
    const ctx = { host: this.config.imap.host, port: this.config.imap.port, users: this.plannedLogins };
    for (let attemptNo = 0; ; attemptNo++) {
      const client = await this.connection();
      try {
        return await fn(client);
      } catch (err) {
        if (err instanceof MailError) throw err;
        const dead = !client.usable || isConnectionError(err);
        if (dead && this.client === client) this.client = null;
        if (dead && retry && attemptNo === 0) {
          this.logger.info('IMAP connection was lost; retrying once on a new connection', { code: errorCode(err) });
          continue;
        }
        throw mapImapError(err, ctx);
      }
    }
  }

  /** Run commands that don't need a selected mailbox (LIST, STATUS, APPEND, CREATE, …). */
  async run<T>(fn: (client: ImapFlow) => Promise<T>, opts: { retry?: boolean } = {}): Promise<T> {
    this.begin();
    try {
      return await this.attempt(fn, opts.retry ?? false);
    } finally {
      this.end();
    }
  }

  /**
   * Run `fn` with `path` selected under a mailbox lock (SPEC §2.6). Read-only operations use
   * EXAMINE. `path` must be the server's exact mailbox path.
   */
  async withMailbox<T>(path: string, fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>, opts: WithMailboxOptions): Promise<T> {
    this.begin();
    try {
      return await this.attempt(async (client) => {
        let lock;
        try {
          lock = await client.getMailboxLock(path, { readOnly: opts.readOnly, acquireTimeout: this.lockTimeoutMs, description: `mcp:${path}` });
        } catch (err) {
          if ((err as { mailboxMissing?: unknown }).mailboxMissing === true) {
            throw new MailError('NOT_FOUND', `Mailbox "${path}" does not exist on the server (it may have been renamed or deleted). Call list_mailboxes to see the current folders.`);
          }
          throw err;
        }
        try {
          const mailbox = client.mailbox;
          if (!mailbox) throw new MailError('INTERNAL', `Mailbox "${path}" could not be opened.`);
          return await fn(client, mailbox);
        } finally {
          lock.release();
        }
      }, opts.retry ?? opts.readOnly);
    } finally {
      this.end();
    }
  }

  /** Server capabilities (connects if needed). */
  async capabilities(): Promise<Set<string>> {
    return this.run((client) => Promise.resolve(new Set([...client.capabilities.keys()].map((c) => c.toUpperCase()))), { retry: true });
  }

  async hasCapability(name: string): Promise<boolean> {
    return (await this.capabilities()).has(name.toUpperCase());
  }

  private async disconnect(reason: string): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    this.logger.debug('closing IMAP connection', { reason });
    const logout = client.logout().catch(() => undefined);
    const cap = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      t.unref();
    });
    await Promise.race([logout, cap]);
    try {
      client.close();
    } catch {
      // already closed
    }
  }

  /**
   * Log out now (best effort, capped at 2 s) without refusing further work: a later operation
   * opens a new connection. Used when an MCP connection closes while the process lives on.
   */
  async release(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.disconnect('released');
  }

  /** Log out (best effort, capped at 2 s) and refuse further work. */
  async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const pending = this.connecting;
    if (pending) {
      try {
        await Promise.race([pending, new Promise((r) => setTimeout(r, 2000).unref())]);
      } catch {
        // connect failed; nothing to close
      }
    }
    await this.disconnect('shutdown');
  }
}
