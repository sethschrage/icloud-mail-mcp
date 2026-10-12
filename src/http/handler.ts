/**
 * Cloud entry: a web-standard (Request -> Response) MCP endpoint for Vercel, serving the same
 * tools as the local stdio server over stateless Streamable HTTP.
 *
 * Access and login follow the pattern of Seth's buxfer-mcp (lib/mcp.js, lib/buxfer.js):
 * - Every request needs the access key (MCP_ACCESS_KEY, 32+ characters) as `?key=` or
 *   `Authorization: Bearer`, compared in constant time. Without a usable MCP_ACCESS_KEY the
 *   server refuses every request.
 * - The iCloud login comes from connector headers (X-ICloud-Email, X-ICloud-Password, optional
 *   X-ICloud-From), so each user can bring their own, else from the Vercel env (ICLOUD_EMAIL,
 *   ICLOUD_PASSWORD). Headers never replace the access key.
 * - One MailService (IMAP connection, limits, Sent-copy logic) per login, cached while the
 *   instance stays warm, keyed by sha256(email \0 password \0 from) — never the raw values.
 * - Credentials are never logged or returned; the request URL (which carries the key) is never logged.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { loadConfig } from '../config.js';
import { errorMessage } from '../errors.js';
import { log as defaultLogger, forgetSecret, redact, registerSecret, type Logger } from '../log.js';
import { setRuntime } from '../runtime.js';
import { buildServer } from '../server.js';
import { MailService, type MailServiceDeps } from '../service.js';
import { isValidEmailAddress } from '../smtp/address.js';

export const MIN_ACCESS_KEY_LENGTH = 32;
/** Logins kept warm per instance; the least recently used one is closed beyond this. */
export const MAX_CACHED_LOGINS = 16;

export const HEADER_EMAIL = 'x-icloud-email';
export const HEADER_PASSWORD = 'x-icloud-password';
export const HEADER_FROM = 'x-icloud-from';

export type AccessResult = 'ok' | 'unauthorized' | 'misconfigured';

/** The access-key check (buxfer-mcp's checkAccess, plus telling a missing key apart from a wrong one). */
export function checkAccess(request: Request, expected: string | undefined): AccessResult {
  const want = (expected ?? '').trim();
  if (want.length < MIN_ACCESS_KEY_LENGTH) return 'misconfigured';
  let given = '';
  try {
    given = new URL(request.url).searchParams.get('key') ?? '';
  } catch {
    given = '';
  }
  const auth = request.headers.get('authorization') ?? '';
  if (!given && auth.toLowerCase().startsWith('bearer ')) given = auth.slice(7).trim();
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'unauthorized';
}

export interface RequestLogin {
  email: string;
  password: string;
  from?: string;
}

/** Apple app-specific passwords: four groups of four letters (xxxx-xxxx-xxxx-xxxx). */
const APP_PASSWORD = /^[a-z]{4}(?:[- ]?[a-z]{4}){3}$/i;

export const INCOMPLETE_HEADERS =
  "Incomplete login headers: send both X-ICloud-Email and X-ICloud-Password (and optionally X-ICloud-From), or none of them to use the server's own login.";

/**
 * Login from connector headers: both email and password, or nothing. A partial or malformed set is
 * reported as a `problem` (never silently mixed with the env login, which would pair one user's
 * address with another's password). Problems never quote the header values: a password pasted
 * into the wrong header must not end up in the logs or the reply.
 */
export function loginFromRequest(request: Request): { login: RequestLogin | null; partial: boolean; problem: string | null } {
  const email = request.headers.get(HEADER_EMAIL)?.trim() ?? '';
  const password = request.headers.get(HEADER_PASSWORD)?.trim() ?? '';
  const from = request.headers.get(HEADER_FROM)?.trim() ?? '';
  if (!email || !password) {
    const partial = Boolean(email || password || from);
    return { login: null, partial, problem: partial ? INCOMPLETE_HEADERS : null };
  }
  const problems: string[] = [];
  if (!isValidEmailAddress(email)) problems.push('X-ICloud-Email is not a valid email address.');
  if (!APP_PASSWORD.test(password)) {
    problems.push(
      'X-ICloud-Password is not an app-specific password (four groups of four letters, like abcd-efgh-ijkl-mnop). Create one at account.apple.com > Sign-In and Security > App-Specific Passwords; the Apple Account password does not work.',
    );
  }
  if (from && !isValidEmailAddress(from)) problems.push('X-ICloud-From is not a valid email address.');
  if (problems.length) return { login: null, partial: true, problem: `Login headers not usable: ${problems.join(' ')}` };
  return { login: { email, password, ...(from ? { from } : {}) }, partial: false, problem: null };
}

export function loginCacheKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// Identity settings in the Vercel env belong to the env login; a header login must not inherit them.
const IDENTITY_VARS = ['ICLOUD_EMAIL', 'ICLOUD_PASSWORD', 'ICLOUD_APP_PASSWORD', 'ICLOUD_IMAP_USER', 'ICLOUD_SMTP_USER', 'MAIL_FROM_ADDRESS', 'MAIL_FROM_NAME', 'MAIL_ALLOWED_FROM'];

export interface CloudHandlerOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Extra MailService dependencies (tests: fake fetch for the limit store, clocks, ...). */
  serviceDeps?: MailServiceDeps;
}

interface CacheEntry {
  service: MailService;
  mcp: McpHttpHandler;
  /** Header login's password, forgotten by the redactor once the entry is closed. */
  headerPassword?: string;
  /** Requests still using this entry (their response bodies are still streaming). */
  inflight: number;
  /** Evicted from the cache; closed as soon as `inflight` drops to 0. */
  evicted: boolean;
}

/** Call `done` once the response body has been fully read, cancelled or has failed. */
function onBodyDone(response: Response, done: () => void): Response {
  if (!response.body) {
    done();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (err) {
        finish();
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export type CloudHandler = ((request: Request) => Promise<Response>) & {
  /** Close every cached login (tests, shutdown). */
  close(): Promise<void>;
  /** Number of logins currently cached (tests). */
  readonly cachedLogins: number;
};

export function createCloudHandler(options: CloudHandlerOptions = {}): CloudHandler {
  setRuntime('cloud');
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const cache = new Map<string, CacheEntry>();
  const accessKey = env['MCP_ACCESS_KEY'];
  if (accessKey) registerSecret(accessKey.trim());
  let warnedMisconfigured = false;

  const envPassword = env['ICLOUD_PASSWORD'] ?? env['ICLOUD_APP_PASSWORD'];

  const closeEntry = (entry: CacheEntry): void => {
    void entry.service.close().catch(() => undefined);
    void entry.mcp.close().catch(() => undefined);
    const pw = entry.headerPassword;
    // Forget the password unless the env login or another cached login still uses it.
    if (pw && pw !== envPassword && ![...cache.values()].some((e) => e.headerPassword === pw)) forgetSecret(pw);
  };

  const entryFor = (request: Request): CacheEntry => {
    const { login, problem } = loginFromRequest(request);
    let serviceEnv: NodeJS.ProcessEnv;
    let key: string;
    let sourceLabel: string;
    if (login) {
      serviceEnv = { ...env };
      for (const v of IDENTITY_VARS) delete serviceEnv[v];
      serviceEnv['ICLOUD_EMAIL'] = login.email;
      serviceEnv['ICLOUD_PASSWORD'] = login.password;
      if (login.from) serviceEnv['MAIL_FROM_ADDRESS'] = login.from;
      key = loginCacheKey(['header', login.email, login.password, login.from ?? '']);
      sourceLabel = 'X-ICloud-Password connector header';
    } else if (problem) {
      // Build a service that only explains the problem (every tool returns it).
      serviceEnv = { ...env };
      for (const v of IDENTITY_VARS) delete serviceEnv[v];
      key = `problem:${problem}`;
      sourceLabel = 'incomplete connector headers';
    } else {
      serviceEnv = env;
      key = loginCacheKey(['env', env['ICLOUD_EMAIL'] ?? '', env['ICLOUD_PASSWORD'] ?? env['ICLOUD_APP_PASSWORD'] ?? '', env['MAIL_FROM_ADDRESS'] ?? '']);
      sourceLabel = 'ICLOUD_PASSWORD environment variable (Vercel)';
    }
    const hit = cache.get(key);
    if (hit) {
      // Refresh recency (Map keeps insertion order).
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    // Registered only once the headers passed validation, so a caller cannot make the redactor
    // hide arbitrary strings (addresses, tool names) from the logs and the audit trail.
    if (login) registerSecret(login.password);
    const configResult = loadConfig(serviceEnv, { runtime: 'cloud' });
    if (problem) configResult.errors.unshift(problem);
    const service = new MailService(configResult, {
      // Without an injected logger the service sets the shared stderr logger to MAIL_LOG_LEVEL.
      ...(options.logger ? { logger } : {}),
      ...options.serviceDeps,
      credentialOptions: { ...options.serviceDeps?.credentialOptions, sourceLabel },
    });
    for (const w of service.configWarnings) logger.warn(`configuration warning: ${w}`);
    for (const e of service.configErrors) logger.warn(`configuration problem: ${e}`);
    const mcp = createMcpHandler(() => buildServer(service, { logger }), {
      legacy: 'stateless',
      onerror: (err) => logger.warn('MCP request error', { err: redact(errorMessage(err)) }),
    });
    const entry: CacheEntry = { service, mcp, inflight: 0, evicted: false, ...(login ? { headerPassword: login.password } : {}) };
    cache.set(key, entry);
    while (cache.size > MAX_CACHED_LOGINS) {
      const oldestKey = cache.keys().next().value as string;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (!oldest) continue;
      // A request still using it keeps it open; the last one to finish closes it.
      oldest.evicted = true;
      if (oldest.inflight === 0) closeEntry(oldest);
    }
    return entry;
  };

  const handler = async (request: Request): Promise<Response> => {
    const started = Date.now();
    const access = checkAccess(request, env['MCP_ACCESS_KEY']);
    if (access === 'misconfigured') {
      if (!warnedMisconfigured) {
        warnedMisconfigured = true;
        logger.error(`MCP_ACCESS_KEY is missing or shorter than ${MIN_ACCESS_KEY_LENGTH} characters: refusing every request. Set it (Sensitive) in the Vercel project's environment variables and redeploy.`);
      }
      return json({ error: 'server not configured', detail: `MCP_ACCESS_KEY must be set to at least ${MIN_ACCESS_KEY_LENGTH} characters in the Vercel project's environment variables; then redeploy.` }, 503);
    }
    if (access !== 'ok') return json({ error: 'unauthorized' }, 401);
    let entry: CacheEntry | undefined;
    let released = false;
    const release = (): void => {
      if (released || !entry) return;
      released = true;
      entry.inflight--;
      if (entry.evicted && entry.inflight === 0) closeEntry(entry);
    };
    try {
      entry = entryFor(request);
      entry.inflight++;
      const response = await entry.mcp.fetch(request);
      logger.info('MCP request', { method: request.method, status: response.status, ms: Date.now() - started });
      // Tool calls run while the (SSE) body streams, so the entry stays in use until it ends.
      return onBodyDone(response, release);
    } catch (err) {
      release();
      logger.error('MCP request failed', { err: redact(errorMessage(err)) });
      return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }, 500);
    }
  };

  const close = async (): Promise<void> => {
    const entries = [...cache.values()];
    cache.clear();
    await Promise.all(entries.flatMap((e) => [e.service.close().catch(() => undefined), e.mcp.close().catch(() => undefined)]));
    for (const e of entries) if (e.headerPassword && e.headerPassword !== envPassword) forgetSecret(e.headerPassword);
  };
  // defineProperty, not Object.assign: assign would copy the getter's current value, not the getter.
  Object.defineProperty(handler, 'close', { value: close });
  Object.defineProperty(handler, 'cachedLogins', { get: () => cache.size });
  return handler as CloudHandler;
}
