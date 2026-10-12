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
 * - A tool call that is abandoned (deadline or client cancellation, see context.ts) while one of
 *   its IMAP commands is still pending stops waiting at once. If no other call is using that
 *   connection, it is closed: imapflow then rejects the pending command and drops its mailbox
 *   lock, and the next call reconnects instead of waiting minutes behind a command that will never
 *   finish (a half-open socket after a network change, or a SEARCH iCloud never answers). If other
 *   calls are using it (concurrent requests on one warm cloud instance), it is left to them: the
 *   abandoned command either finishes, or the connection is closed when the last of those calls
 *   is abandoned too, or as soon as none of them uses it any more while the abandoned command is
 *   still pending. A mailbox lock wait that times out is treated the same way.
 * - When a call's connection is closed underneath it before its work started (still waiting for
 *   the connection or the mailbox lock), it retries once on a new connection, writes included;
 *   once a write has started, it reports that the change may or may not have been applied.
 * - Without implicit TLS (IMAP_SECURE=false) STARTTLS is required, so a network attacker cannot
 *   strip it and read the app-specific password; IMAP_ALLOW_PLAINTEXT=true (tests only) relaxes it.
 */
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { ImapFlow, type ImapFlowOptions, type MailboxObject } from 'imapflow';
import type { Config } from '../config.js';
import { currentContext } from '../context.js';
import { passwordHelp, type CredentialProvider } from '../credentials.js';
import { getRuntime } from '../runtime.js';
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

export function authFailureMessage(service: 'IMAP' | 'SMTP', host: string, users: readonly string[], serverSaid?: string): string {
  const who = users.length ? users.map((u) => `"${u}"`).join(' and ') : 'the configured account';
  const cloud = getRuntime() === 'cloud';
  const customDomain = cloud
    ? 'custom-domain users: log in with your primary @icloud.com address (X-ICloud-Email header or ICLOUD_EMAIL) and set your custom address as MAIL_FROM_ADDRESS'
    : 'custom-domain users: enter your primary @icloud.com address as "iCloud email address" in the extension settings and your custom address as "From address (optional)" (manual setups: ICLOUD_EMAIL / MAIL_FROM_ADDRESS)';
  const loginHint =
    service === 'IMAP'
      ? `(3) the login must be your iCloud Mail address (or the part before "@"), not an Apple Account sign-in email from another provider such as Gmail; ${customDomain}; a different IMAP login can also be set as ${cloud ? 'ICLOUD_IMAP_USER' : '"IMAP login (optional)" (ICLOUD_IMAP_USER)'};`
      : `(3) SMTP needs your full iCloud Mail address as the login; ${customDomain}; ${cloud ? 'ICLOUD_SMTP_USER can also be set' : 'a manual setup can also set ICLOUD_SMTP_USER'};`;
  const nonIcloud = users.find((u) => u.includes('@') && !(ICLOUD_DOMAINS as readonly string[]).includes(domainOf(u)));
  const appleIdHint = nonIcloud
    ? ` Note: "${nonIcloud}" is not an @icloud.com, @me.com or @mac.com address. Your Apple Account email is not necessarily your iCloud Mail address: use your @icloud.com address.`
    : '';
  return (
    `iCloud ${service} (${host}) rejected the login for ${who}${serverSaid ? ` (server said: ${serverSaid})` : ''}. Likely causes: ` +
    '(1) your regular Apple Account password was used instead of an app-specific password; ' +
    '(2) the app-specific password was revoked, which happens automatically when the Apple Account password is changed, so create a new one; ' +
    `${loginHint} ` +
    '(4) app-specific passwords require two-factor authentication on the Apple Account.' +
    `${appleIdHint} ` +
    passwordHelp()
  );
}

/** IMAP response codes (RFC 5530) that refuse a login for a reason other than the credentials. */
const TRANSIENT_LOGIN_CODES = new Set(['UNAVAILABLE', 'LIMIT', 'INUSE', 'SERVERBUG', 'CONTACTADMIN', 'ALERT', 'OVERQUOTA']);
const CREDENTIAL_CODES = new Set(['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED']);

function responseCodeOf(err: unknown): string | undefined {
  const c = (err as ImapErrorLike | null)?.serverResponseCode;
  return typeof c === 'string' && c ? c.toUpperCase() : undefined;
}

/** The server's human-readable text for a failed command (redacted, single line, capped). */
export function serverTextOf(err: unknown): string | undefined {
  const e = (err ?? {}) as ImapErrorLike;
  let raw = typeof e.responseText === 'string' && e.responseText ? e.responseText : typeof e.response === 'string' && e.response ? e.response : undefined;
  if (!raw) return undefined;
  // err.response is the whole tagged line ("2 NO [UNAVAILABLE] …"): drop the tag and status.
  raw = raw.replace(/^\s*\S+\s+(?:NO|BAD|BYE)\s+/i, '');
  const code = responseCodeOf(err);
  if (code && !raw.toUpperCase().includes(`[${code}`)) raw = `[${code}] ${raw}`;
  return redact(raw).replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;
}

/**
 * True when a refused LOGIN/AUTHENTICATE means the credentials are wrong. imapflow sets
 * `authenticationFailed` on every tagged NO to LOGIN, whatever the reason, so the RFC 5530 response
 * code decides: UNAVAILABLE, LIMIT (too many connections), INUSE, … are not credential problems.
 */
export function isCredentialFailure(err: unknown): boolean {
  const e = (err ?? {}) as ImapErrorLike;
  const code = responseCodeOf(err);
  if (code && CREDENTIAL_CODES.has(code)) return true;
  if (e.authenticationFailed !== true) return false;
  return !code || !TRANSIENT_LOGIN_CODES.has(code);
}

/** A refused login that is not about the credentials (e.g. too many connections). */
export function isTransientLoginRefusal(err: unknown): boolean {
  const code = responseCodeOf(err);
  return (err as ImapErrorLike | null)?.authenticationFailed === true && !!code && TRANSIENT_LOGIN_CODES.has(code);
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
  response?: unknown;
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
  if (isTransientLoginRefusal(err)) {
    const said = serverTextOf(err);
    return new MailError(
      'CONNECTION',
      `iCloud IMAP (${where}) refused the login for now${said ? ` (server said: ${said})` : ''}. This is usually temporary, for example too many open connections from Apple Mail on your Mac, iPhone and iPad; your password was not necessarily wrong. Try again in a few minutes.`,
      { cause: err },
    );
  }
  if (isCredentialFailure(err)) {
    return new MailError('AUTH', authFailureMessage('IMAP', where, ctx.users ?? [], serverTextOf(err)), { cause: err });
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
    return new MailError('CONNECTION', 'Timed out waiting for another mail operation on this connection to finish; the connection was reset. Try again.', { cause: err });
  }
  if (code && CONNECTION_ERROR_CODES.has(code)) {
    const advice =
      getRuntime() === 'cloud'
        ? 'Check that iCloud Mail is reachable; iCloud may be temporarily unavailable.'
        : "Check the Mac's internet connection; iCloud may also be temporarily unavailable.";
    return new MailError('CONNECTION', `Could not talk to the IMAP server ${where} (${code}). ${advice} The next request will reconnect.`, { cause: err });
  }
  if (e.responseStatus === 'NO' || e.responseStatus === 'BAD') {
    const text = typeof e.responseText === 'string' && e.responseText ? e.responseText : errorMessage(err);
    return new MailError('SERVER', `The IMAP server refused the request: ${redact(text)}`, { cause: err });
  }
  return new MailError('INTERNAL', `IMAP error: ${redact(errorMessage(err))}`, { cause: err });
}

/** The error to throw for an aborted call: the deadline/cancellation MailError, or CANCELLED. */
export function abortError(signal: AbortSignal): MailError {
  const reason: unknown = signal.reason;
  if (reason instanceof MailError) return reason;
  return new MailError('CANCELLED', 'The request was cancelled or timed out; nothing more was done.');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
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
  /** Called when a mailbox turned out not to exist any more (the registry drops its folder list). */
  onMailboxMissing: (() => void) | undefined;
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private loginUser: string | null = null;
  private active = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private lastActivity = Date.now();
  private readonly healthCheckAfterMs: number;
  private caCache: string | null | undefined;
  /** Calls currently using each connection (each with its call's abort signal, if any). */
  private readonly users = new WeakMap<ImapFlow, Set<{ signal: AbortSignal | undefined }>>();
  /** Per connection: abandoned calls whose work is still pending on it. */
  private readonly orphans = new WeakMap<ImapFlow, number>();
  /** Connections this manager closed itself (as opposed to the server or the network). */
  private readonly closedHere = new WeakSet<ImapFlow>();
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
    const { host, port, secure, allowPlaintext } = this.config.imap;
    const options: ImapFlowOptions = {
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
      // No ENABLE CONDSTORE / UTF8=ACCEPT after login: nothing here needs them, and iCloud's
      // CONDSTORE/ENABLE handling is known to be buggy (SPEC hard rule 3: rely only on the basics).
      // Mailbox names then use modified UTF-7, which imapflow encodes and decodes transparently.
      disableAutoEnable: true,
      qresync: false,
    };
    // Without implicit TLS, require STARTTLS: opportunistic STARTTLS would silently fall back to a
    // plaintext LOGIN when a network attacker strips it from CAPABILITY.
    if (!secure && !allowPlaintext) options.doSTARTTLS = true;
    const client = this.createClient(options);
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
        const authFailed = isCredentialFailure(err);
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
      this.closedHere.add(existing);
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

  /**
   * Close `client` and forget it, so pending commands reject (NoConnection), its mailbox lock is
   * dropped and the next operation reconnects.
   */
  private abandon(client: ImapFlow, reason: string): void {
    if (this.client === client) this.client = null;
    if (this.closedHere.has(client)) return;
    this.closedHere.add(client);
    this.logger.info('closing the IMAP connection', { reason });
    try {
      client.close();
    } catch {
      // already closed
    }
  }

  private usersOf(client: ImapFlow): Set<{ signal: AbortSignal | undefined }> {
    let set = this.users.get(client);
    if (!set) {
      set = new Set();
      this.users.set(client, set);
    }
    return set;
  }

  /**
   * Run `fn` on a connection. `fn` calls `started()` right before it sends anything of its own
   * (after waiting for the mailbox lock), which tells a write whether a retry is still safe.
   */
  private async attempt<T>(fn: (client: ImapFlow, started: () => void) => Promise<T>, retry: boolean): Promise<T> {
    const ctx = { host: this.config.imap.host, port: this.config.imap.port, users: this.plannedLogins };
    const signal = currentContext()?.signal;
    for (let attemptNo = 0; ; attemptNo++) {
      throwIfAborted(signal);
      const client = await this.connection();
      throwIfAborted(signal);
      const users = this.usersOf(client);
      const me = { signal };
      users.add(me);
      let didStart = false;
      let abandoned = false;
      let onAbort: (() => void) | undefined;
      // The call was abandoned while its work is still pending: stop waiting at once. Nothing will
      // ever read the result, and a stuck command would block the one connection for everyone
      // else, so close the connection, unless other calls are still using it: closing it would
      // fail their commands too (on a warm cloud instance concurrent requests share it). Their own
      // deadlines still close it if the abandoned command never finishes (see the finally below).
      const abort = signal
        ? new Promise<never>((_, reject) => {
            onAbort = (): void => {
              abandoned = true;
              users.delete(me);
              const othersLive = [...users].some((u) => !u.signal?.aborted);
              if (othersLive) {
                this.logger.info('a tool call was abandoned while its IMAP work was pending; leaving the connection to the other calls using it');
              } else {
                this.abandon(client, 'the tool call was abandoned (deadline or cancellation) while an IMAP command was pending');
              }
              reject(abortError(signal));
            };
            signal.addEventListener('abort', onAbort, { once: true });
          })
        : undefined;
      const work = fn(client, () => {
        didStart = true;
      });
      try {
        return await (abort ? Promise.race([work, abort]) : work);
      } catch (err) {
        // Never retry work for an abandoned call (a read would silently re-run the stuck command).
        if (signal?.aborted) throw abortError(signal);
        if (err instanceof MailError) throw err;
        if (errorCode(err) === 'LockTimeout') {
          // Operations are serialised and each holds at most one lock, so a lock wait this long
          // means the holder is stuck: reset the connection. Nothing of this operation ran yet
          // (it never got the lock), so one retry on a fresh connection is safe even for writes.
          this.abandon(client, 'a mailbox lock wait timed out');
          if (attemptNo === 0) continue;
          throw mapImapError(err, ctx);
        }
        const dead = !client.usable || isConnectionError(err);
        if (dead && this.client === client) this.client = null;
        // Nothing of a write was sent yet (it was still waiting for the mailbox lock), so it can
        // be retried like a read.
        if (dead && (retry || !didStart) && attemptNo === 0) {
          this.logger.info('IMAP connection was lost; retrying once on a new connection', { code: errorCode(err) });
          continue;
        }
        if (dead && !retry && didStart && this.closedHere.has(client)) {
          throw new MailError(
            'CONNECTION',
            `The connection to the IMAP server ${ctx.host}:${ctx.port} was reset by another request while this one was in progress (${errorCode(err) ?? 'connection closed'}). ` +
              'If this was a change (move, flag, delete, create, rename, save), it may or may not have been applied: check before retrying.',
            { cause: err },
          );
        }
        throw mapImapError(err, ctx);
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        users.delete(me);
        if (abandoned) {
          // `work` goes on in the background (it releases its mailbox lock when it settles).
          this.orphans.set(client, (this.orphans.get(client) ?? 0) + 1);
          const settled = (): void => {
            this.orphans.set(client, Math.max(0, (this.orphans.get(client) ?? 0) - 1));
          };
          work.then(settled, settled);
        }
        // The last call using this connection is done while an abandoned call's command is still
        // pending on it (possibly stuck): close it rather than leave the next call behind it.
        if (users.size === 0 && (this.orphans.get(client) ?? 0) > 0) {
          this.abandon(client, 'an abandoned tool call still had an IMAP command pending');
        }
      }
    }
  }

  /** Run commands that don't need a selected mailbox (LIST, STATUS, APPEND, CREATE, …). */
  async run<T>(fn: (client: ImapFlow) => Promise<T>, opts: { retry?: boolean } = {}): Promise<T> {
    this.begin();
    try {
      return await this.attempt(async (client, started) => {
        // On a connection that is already closed, imapflow rejects every command unsent.
        if (client.usable) started();
        return fn(client);
      }, opts.retry ?? false);
    } finally {
      this.end();
    }
  }

  /** The current call's abort signal, for callers that check it between commands. */
  get signal(): AbortSignal | undefined {
    return currentContext()?.signal;
  }

  /**
   * Run `fn` with `path` selected under a mailbox lock (SPEC §2.6). Read-only operations use
   * EXAMINE. `path` must be the server's exact mailbox path.
   */
  async withMailbox<T>(path: string, fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>, opts: WithMailboxOptions): Promise<T> {
    this.begin();
    try {
      return await this.attempt(async (client, started) => {
        let lock;
        try {
          lock = await client.getMailboxLock(path, { readOnly: opts.readOnly, acquireTimeout: this.lockTimeoutMs, description: `mcp:${path}` });
        } catch (err) {
          if ((err as { mailboxMissing?: unknown }).mailboxMissing === true) {
            this.onMailboxMissing?.();
            throw new MailError('NOT_FOUND', `Mailbox "${path}" does not exist on the server (it may have been renamed or deleted). Call list_mailboxes to see the current folders.`);
          }
          throw err;
        }
        try {
          // The call may have been abandoned while waiting for the lock: start nothing new.
          throwIfAborted(currentContext()?.signal);
          const mailbox = client.mailbox;
          if (!mailbox) throw new MailError('INTERNAL', `Mailbox "${path}" could not be opened.`);
          started();
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
    this.closedHere.add(client);
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
