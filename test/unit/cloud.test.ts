/**
 * Cloud (Vercel) entry without a mail server: access key, header/env login, cloud configuration,
 * the shared send-limit store, the tool surface offered in the cloud, and credential hygiene.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { MailError } from '../../src/errors.js';
import { checkAccess, createCloudHandler, loginCacheKey, loginFromRequest, MAX_CACHED_LOGINS, MIN_ACCESS_KEY_LENGTH, type CloudHandler } from '../../src/http/handler.js';
import { accountKey, createSharedQuota, MissingSharedQuota, UpstashQuota } from '../../src/quota.js';
import { setRuntime } from '../../src/runtime.js';
import { AuditLog } from '../../src/audit.js';
import { ACCESS_KEY, cloudEnv, connectCloud, ENDPOINT, FakeUpstash, resultText } from '../helpers/cloud.js';

afterAll(() => setRuntime('local'));

const req = (url: string, init: RequestInit = {}) => new Request(url, { method: 'POST', ...init });

describe('checkAccess', () => {
  it('accepts the key as ?key= or Authorization: Bearer, compared exactly', () => {
    expect(checkAccess(req(`${ENDPOINT}?key=${ACCESS_KEY}`), ACCESS_KEY)).toBe('ok');
    expect(checkAccess(req(ENDPOINT, { headers: { authorization: `Bearer ${ACCESS_KEY}` } }), ACCESS_KEY)).toBe('ok');
    expect(checkAccess(req(ENDPOINT, { headers: { authorization: `bearer ${ACCESS_KEY}` } }), ACCESS_KEY)).toBe('ok');
    expect(checkAccess(req(`${ENDPOINT}?key=${ACCESS_KEY}x`), ACCESS_KEY)).toBe('unauthorized');
    expect(checkAccess(req(`${ENDPOINT}?key=${ACCESS_KEY.slice(0, -1)}`), ACCESS_KEY)).toBe('unauthorized');
    expect(checkAccess(req(ENDPOINT), ACCESS_KEY)).toBe('unauthorized');
    expect(checkAccess(req(ENDPOINT, { headers: { authorization: `Basic ${ACCESS_KEY}` } }), ACCESS_KEY)).toBe('unauthorized');
  });

  it('refuses everything when MCP_ACCESS_KEY is missing or shorter than 32 characters', () => {
    const short = 'k'.repeat(MIN_ACCESS_KEY_LENGTH - 1);
    expect(checkAccess(req(`${ENDPOINT}?key=${short}`), short)).toBe('misconfigured');
    expect(checkAccess(req(`${ENDPOINT}?key=`), undefined)).toBe('misconfigured');
    expect(checkAccess(req(`${ENDPOINT}?key=`), '')).toBe('misconfigured');
  });
});

describe('loginFromRequest', () => {
  it('takes both headers or nothing, and reports a partial set', () => {
    const full = loginFromRequest(req(ENDPOINT, { headers: { 'X-ICloud-Email': ' a@icloud.com ', 'X-ICloud-Password': 'abcd-efgh-ijkl-mnop', 'X-ICloud-From': 'me@example.com' } }));
    expect(full).toEqual({ login: { email: 'a@icloud.com', password: 'abcd-efgh-ijkl-mnop', from: 'me@example.com' }, partial: false });
    expect(loginFromRequest(req(ENDPOINT))).toEqual({ login: null, partial: false });
    expect(loginFromRequest(req(ENDPOINT, { headers: { 'X-ICloud-Email': 'a@icloud.com' } }))).toEqual({ login: null, partial: true });
    expect(loginFromRequest(req(ENDPOINT, { headers: { 'X-ICloud-Password': 'pw' } }))).toEqual({ login: null, partial: true });
  });

  it('keys the login cache by a hash, never the raw values', () => {
    const k = loginCacheKey(['header', 'a@icloud.com', 'secret-password']);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).not.toContain('secret');
    expect(loginCacheKey(['header', 'a@icloud.com', 'other'])).not.toBe(k);
  });
});

describe('cloud configuration', () => {
  const load = (env: NodeJS.ProcessEnv) => loadConfig(env, { runtime: 'cloud', platform: 'linux', home: '/nonexistent', systemTimezone: 'UTC' });

  it('accepts ICLOUD_PASSWORD, keeps no disk paths, audits to stdout and shares limits through Upstash', () => {
    const { config, errors } = load(cloudEnv());
    expect(errors).toEqual([]);
    expect(config.runtime).toBe('cloud');
    expect(config.password).toBe('app-specific-pass');
    expect(config.attachmentDir).toBe('');
    expect(config.attachFromDirs).toEqual([]);
    expect(config.auditLog).toBeNull(); // MAIL_AUDIT_LOG=off in cloudEnv
    expect(load(cloudEnv({ MAIL_AUDIT_LOG: undefined })).config.auditLog).toBe('stdout');
    expect(config.quotaStore).toEqual({ kind: 'upstash', url: 'https://upstash.test', token: 'upstash-token-123' });
    expect(config.operationTimeoutSeconds).toBe(50);
  });

  it('reads the Vercel Marketplace names KV_REST_API_URL / KV_REST_API_TOKEN', () => {
    const { config } = load(cloudEnv({ UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, KV_REST_API_URL: 'https://kv.upstash.io/', KV_REST_API_TOKEN: 't' }));
    expect(config.quotaStore).toEqual({ kind: 'upstash', url: 'https://kv.upstash.io', token: 't' });
  });

  it('marks the store missing (or per-instance on request) and rejects non-https URLs', () => {
    expect(load(cloudEnv({ UPSTASH_REDIS_REST_URL: undefined })).config.quotaStore).toEqual({ kind: 'missing' });
    expect(load(cloudEnv({ UPSTASH_REDIS_REST_URL: undefined, MAIL_RATE_LIMIT_STORE: 'memory' })).config.quotaStore).toEqual({ kind: 'memory' });
    expect(load(cloudEnv({ UPSTASH_REDIS_REST_URL: 'http://upstash.test' })).errors.join(' ')).toMatch(/https/);
    expect(load(cloudEnv({ MAIL_RATE_LIMIT_STORE: 'redis' })).errors.join(' ')).toMatch(/MAIL_RATE_LIMIT_STORE/);
  });

  it('explains how to log in when neither headers nor env provide one', () => {
    const noEmail = load(cloudEnv({ ICLOUD_EMAIL: undefined, ICLOUD_PASSWORD: undefined }));
    expect(noEmail.errors).toHaveLength(1);
    expect(noEmail.errors[0]).toMatch(/X-ICloud-Email.*X-ICloud-Password.*ICLOUD_EMAIL and ICLOUD_PASSWORD/);
    const noPassword = load(cloudEnv({ ICLOUD_PASSWORD: undefined }));
    expect(noPassword.errors[0]).toMatch(/No iCloud login/);
  });

  it('refuses the Mac confirmation dialog and ignores disk settings with a warning', () => {
    expect(load(cloudEnv({ MAIL_CONFIRM_DIALOG: 'true' })).errors.join(' ')).toMatch(/MAIL_CONFIRM_DIALOG cannot be used in the cloud/);
    const r = load(cloudEnv({ MAIL_ATTACH_FROM_DIRS: '/tmp', MAIL_ATTACHMENT_DIR: '/tmp' }));
    expect(r.config.attachFromDirs).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/MAIL_ATTACH_FROM_DIRS is ignored/);
  });

  it('warns when MAIL_TIMEZONE is unset (Vercel runs in UTC)', () => {
    expect(load(cloudEnv({ MAIL_TIMEZONE: undefined })).warnings.join(' ')).toMatch(/MAIL_TIMEZONE is not set/);
  });

  it('locally, refuses MAIL_AUDIT_LOG=stdout (stdout carries the MCP protocol) but accepts stderr', () => {
    const local = (v: string) => loadConfig({ ICLOUD_EMAIL: 'a@icloud.com', MAIL_AUDIT_LOG: v }, { runtime: 'local', platform: 'linux', home: '/h' });
    expect(local('stdout').errors.join(' ')).toMatch(/only available in the cloud/);
    expect(local('stderr').config.auditLog).toBe('stderr');
    expect(local('stderr').config.quotaStore).toEqual({ kind: 'none' });
  });
});

describe('UpstashQuota', () => {
  const HOUR = 3_600_000;
  const make = (fake: FakeUpstash, opts: Partial<ConstructorParameters<typeof UpstashQuota>[0]> = {}, now = () => 10 * HOUR) =>
    new UpstashQuota({ url: 'https://upstash.test', token: 'tok', email: 'Seth@iCloud.com', maxSendsPerHour: 3, maxRecipientsPerHour: 10, maxRecipientsPerDay: 20, fetch: fake.fetch, now, ...opts });

  it('counts sends and recipients, refuses beyond a limit and rolls the refused attempt back', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    for (let i = 0; i < 3; i++) await q.reserve(2);
    expect(fake.total('sends_h')).toBe(3);
    await expect(q.reserve(1)).rejects.toMatchObject({ code: 'RATE_LIMIT', message: expect.stringMatching(/at most 3 emails per hour/) });
    expect(fake.total('sends_h')).toBe(3);
    expect(fake.total('rcpt_h')).toBe(6);
  });

  it('refuses a send whose recipients exceed the hourly budget, without counting it', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    await q.reserve(8);
    await expect(q.reserve(3)).rejects.toMatchObject({ code: 'RATE_LIMIT', message: expect.stringMatching(/only 2 more are allowed/) });
    expect(fake.total('rcpt_h')).toBe(8);
    expect(fake.total('rcpt_d')).toBe(8);
  });

  it('releases a reservation once when the send does not happen', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    const r = await q.reserve(4);
    await r.release();
    await r.release();
    expect(fake.total('sends_h')).toBe(0);
    expect(fake.total('rcpt_h')).toBe(0);
  });

  it('uses a sliding window: the previous hour still counts in proportion', async () => {
    const fake = new FakeUpstash();
    let now = 10 * HOUR + 0.9 * HOUR;
    const q = make(fake, {}, () => now);
    for (let i = 0; i < 3; i++) await q.reserve(1);
    now = 11 * HOUR + 0.1 * HOUR; // 90% of the previous hour still overlaps: 2.7 sends
    await expect(q.reserve(1)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    now = 11 * HOUR + 0.8 * HOUR; // 20% overlaps: 0.6 sends
    await expect(q.reserve(1)).resolves.toBeDefined();
  });

  it('sends the token only as a Bearer header and keys counters by a hash of the address', async () => {
    const fake = new FakeUpstash();
    await make(fake).reserve(1);
    expect(fake.requests[0]?.url).toBe('https://upstash.test/pipeline');
    expect(fake.requests[0]?.authorization).toBe('Bearer tok');
    const keys = [...fake.data.keys()];
    expect(keys.every((k) => k.includes(accountKey('seth@icloud.com')))).toBe(true);
    expect(keys.map((k) => k.replace(/^icloud-mail:v1:/, '')).join(' ')).not.toMatch(/seth|icloud/i);
  });

  it('fails closed when Upstash is unreachable or refuses the token', async () => {
    const fake = new FakeUpstash();
    fake.fail = 'network';
    await expect(make(fake).reserve(1)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/Not sent: the send-limit store/) });
    fake.fail = 401;
    await expect(make(fake).reserve(1)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/HTTP 401 \(check the Upstash token\)/) });
  });

  it('reports what is left', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    await q.reserve(4);
    expect(await q.status()).toEqual({ store: 'upstash', sends_remaining_this_hour: 2, recipients_remaining_this_hour: 6, recipients_remaining_today: 16 });
  });

  it('refuses sends with a clear fix when no store is configured', async () => {
    const config = loadConfig(cloudEnv({ UPSTASH_REDIS_REST_URL: undefined }), { runtime: 'cloud' }).config;
    const q = createSharedQuota(config);
    expect(q).toBeInstanceOf(MissingSharedQuota);
    await expect(q.reserve(1)).rejects.toBeInstanceOf(MailError);
    await expect(q.reserve(1)).rejects.toMatchObject({ code: 'CONFIG', message: expect.stringMatching(/Upstash for Redis.*MAIL_RATE_LIMIT_STORE=memory/) });
  });
});

describe('audit log to the Vercel logs', () => {
  afterEach(() => vi.restoreAllMocks());
  it('writes one tagged JSON line per entry to stdout, without bodies', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await new AuditLog('stdout').record({ tool: 'send_email', result: 'ok', recipients: ['b@example.com'], subject: 'Hi' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^icloud-mail-audit \{.*"tool":"send_email".*\}\n$/);
  });
});

describe('cloud HTTP handler (no mail server)', () => {
  let handler: CloudHandler | undefined;
  afterEach(async () => {
    await handler?.close();
    handler = undefined;
  });

  it('answers 503 without a usable MCP_ACCESS_KEY, 401 for a wrong one, 405 for GET', async () => {
    handler = createCloudHandler({ env: cloudEnv({ MCP_ACCESS_KEY: 'too-short' }) });
    const r = await handler(req(`${ENDPOINT}?key=too-short`, { body: '{}' }));
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/MCP_ACCESS_KEY must be set/);
    await handler.close();
    handler = createCloudHandler({ env: cloudEnv() });
    const wrong = await handler(req(`${ENDPOINT}?key=nope`, { body: '{}' }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });
    expect((await handler(new Request(`${ENDPOINT}?key=${ACCESS_KEY}`))).status).toBe(405);
  });

  it('never lets login headers stand in for the access key', async () => {
    handler = createCloudHandler({ env: cloudEnv() });
    const r = await handler(req(ENDPOINT, { headers: { 'x-icloud-email': 'a@icloud.com', 'x-icloud-password': 'pw' }, body: '{}' }));
    expect(r.status).toBe(401);
  });

  it('serves MCP over HTTP (key in the URL or as Bearer) with the cloud tool surface', async () => {
    handler = createCloudHandler({ env: cloudEnv() });
    for (const bearer of [false, true]) {
      const { client, close } = await connectCloud(handler, { bearer });
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(Object.keys(byName)).toContain('send_email');
      expect(Object.keys(byName)).toContain('save_draft');
      for (const name of ['send_email', 'reply_to_message', 'save_draft']) {
        expect(Object.keys((byName[name]?.inputSchema as { properties: object }).properties)).not.toContain('attachments');
        expect(byName[name]?.description).toMatch(/link from another connector/);
      }
      expect(byName['send_email']?.description).not.toMatch(/confirmation dialog on the Mac/);
      expect(byName['download_attachment']?.title).toBe('Get Attachment');
      expect(byName['download_attachment']?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(client.getInstructions()).toMatch(/cloud-hosted version/);
      await close();
    }
  });

  it('tells a caller without any login which headers or env vars to add', async () => {
    handler = createCloudHandler({ env: cloudEnv({ ICLOUD_EMAIL: undefined, ICLOUD_PASSWORD: undefined }) });
    const { client, close } = await connectCloud(handler);
    const r = await client.callTool({ name: 'search_messages', arguments: {} });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/X-ICloud-Email.*X-ICloud-Password/);
    await close();
    const partial = await connectCloud(handler, { headers: { 'X-ICloud-Email': 'a@icloud.com' } });
    expect(resultText(await partial.client.callTool({ name: 'list_mailboxes', arguments: {} }))).toMatch(/Incomplete login headers/);
    await partial.close();
  });

  it('never returns or logs the password, and keeps one cached login per distinct credential set', async () => {
    const logged: string[] = [];
    const logger = { error: (...a: unknown[]) => logged.push(JSON.stringify(a)), warn: (...a: unknown[]) => logged.push(JSON.stringify(a)), info: () => undefined, debug: () => undefined } as never;
    // Nothing listens on port 9: the login attempt fails fast with a connection error.
    handler = createCloudHandler({ env: cloudEnv({ IMAP_PORT: '9', MAIL_LOG_LEVEL: 'debug' }), logger });
    const password = 'zzqx-secret-pw-9431';
    const a = await connectCloud(handler, { headers: { 'X-ICloud-Email': 'someone@icloud.com', 'X-ICloud-Password': password } });
    const search = await a.client.callTool({ name: 'search_messages', arguments: {} });
    expect(search.isError).toBe(true);
    const info = await a.client.callTool({ name: 'get_account_info', arguments: {} });
    expect(resultText(info)).toMatch(/X-ICloud-Password connector header/);
    expect(resultText(info)).not.toContain('testuser@icloud.test'); // the env login's identity is not inherited
    for (const text of [resultText(search), resultText(info), ...logged]) expect(text).not.toContain(password);
    await a.close();
    expect(handler.cachedLogins).toBe(1);
    const b = await connectCloud(handler); // env login
    await b.client.listTools();
    await b.close();
    expect(handler.cachedLogins).toBe(2);
  });

  it('closes the least recently used login beyond the cache limit', async () => {
    handler = createCloudHandler({ env: cloudEnv() });
    for (let i = 0; i <= MAX_CACHED_LOGINS; i++) {
      const c = await connectCloud(handler, { headers: { 'X-ICloud-Email': `u${i}@icloud.com`, 'X-ICloud-Password': `pw-${i}` } });
      await c.close();
    }
    expect(handler.cachedLogins).toBe(MAX_CACHED_LOGINS);
  });
});
