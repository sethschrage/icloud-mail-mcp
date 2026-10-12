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
import { log as defaultLogger, redact, registerSecret, type Logger } from '../log.js';
import { setRuntime } from '../runtime.js';
import { buildServer } from '../server.js';
import { MailService, type MailServiceDeps } from '../service.js';

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

/**
 * Login from connector headers: both email and password, or nothing. A partial set is reported
 * (never silently mixed with the env login, which would pair one user's address with another's password).
 */
export function loginFromRequest(request: Request): { login: RequestLogin | null; partial: boolean } {
  const email = request.headers.get(HEADER_EMAIL)?.trim() ?? '';
  const password = request.headers.get(HEADER_PASSWORD)?.trim() ?? '';
  const from = request.headers.get(HEADER_FROM)?.trim() ?? '';
  if (email && password) return { login: { email, password, ...(from ? { from } : {}) }, partial: false };
  return { login: null, partial: Boolean(email || password || from) };
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

  const entryFor = (request: Request): CacheEntry => {
    const { login, partial } = loginFromRequest(request);
    let serviceEnv: NodeJS.ProcessEnv;
    let key: string;
    let sourceLabel: string;
    if (login) {
      registerSecret(login.password);
      serviceEnv = { ...env };
      for (const v of IDENTITY_VARS) delete serviceEnv[v];
      serviceEnv['ICLOUD_EMAIL'] = login.email;
      serviceEnv['ICLOUD_PASSWORD'] = login.password;
      if (login.from) serviceEnv['MAIL_FROM_ADDRESS'] = login.from;
      key = loginCacheKey(['header', login.email, login.password, login.from ?? '']);
      sourceLabel = 'X-ICloud-Password connector header';
    } else if (partial) {
      // Build a service that only explains the problem (every tool returns it).
      serviceEnv = { ...env };
      for (const v of IDENTITY_VARS) delete serviceEnv[v];
      key = 'partial-headers';
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
    const configResult = loadConfig(serviceEnv, { runtime: 'cloud' });
    if (partial) {
      configResult.errors.unshift(
        'Incomplete login headers: send both X-ICloud-Email and X-ICloud-Password (and optionally X-ICloud-From), or none of them to use the server\'s own login.',
      );
    }
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
    const entry: CacheEntry = { service, mcp };
    cache.set(key, entry);
    while (cache.size > MAX_CACHED_LOGINS) {
      const oldestKey = cache.keys().next().value as string;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      void oldest?.service.close().catch(() => undefined);
      void oldest?.mcp.close().catch(() => undefined);
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
      return json({ error: 'server not configured', detail: `MCP_ACCESS_KEY must be set to at least ${MIN_ACCESS_KEY_LENGTH} characters in the Vercel project's environment variables.` }, 503);
    }
    if (access !== 'ok') return json({ error: 'unauthorized' }, 401);
    try {
      const { mcp } = entryFor(request);
      const response = await mcp.fetch(request);
      logger.info('MCP request', { method: request.method, status: response.status, ms: Date.now() - started });
      return response;
    } catch (err) {
      logger.error('MCP request failed', { err: redact(errorMessage(err)) });
      return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }, 500);
    }
  };

  const close = async (): Promise<void> => {
    const entries = [...cache.values()];
    cache.clear();
    await Promise.all(entries.flatMap((e) => [e.service.close().catch(() => undefined), e.mcp.close().catch(() => undefined)]));
  };
  // defineProperty, not Object.assign: assign would copy the getter's current value, not the getter.
  Object.defineProperty(handler, 'close', { value: close });
  Object.defineProperty(handler, 'cachedLogins', { get: () => cache.size });
  return handler as CloudHandler;
}
