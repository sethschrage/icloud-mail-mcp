/**
 * Cloud (Vercel) entry without a mail server: access key, header/env login, cloud configuration,
 * the shared send-limit store, the tool surface offered in the cloud, and credential hygiene.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { MailError } from '../../src/errors.js';
import { checkAccess, createCloudHandler, INCOMPLETE_HEADERS, loginCacheKey, loginFromRequest, MAX_CACHED_LOGINS, MIN_ACCESS_KEY_LENGTH, type CloudHandler } from '../../src/http/handler.js';
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
    expect(full).toEqual({ login: { email: 'a@icloud.com', password: 'abcd-efgh-ijkl-mnop', from: 'me@example.com' }, partial: false, problem: null });
    expect(loginFromRequest(req(ENDPOINT))).toEqual({ login: null, partial: false, problem: null });
    expect(loginFromRequest(req(ENDPOINT, { headers: { 'X-ICloud-Email': 'a@icloud.com' } }))).toEqual({ login: null, partial: true, problem: INCOMPLETE_HEADERS });
    expect(loginFromRequest(req(ENDPOINT, { headers: { 'X-ICloud-Password': 'pw' } }))).toEqual({ login: null, partial: true, problem: INCOMPLETE_HEADERS });
    expect(loginFromRequest(req(ENDPOINT, { headers: { 'X-ICloud-From': 'me@example.com' } }))).toEqual({ login: null, partial: true, problem: INCOMPLETE_HEADERS });
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
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const quietLogger = () => ({ level: 'warn' as const, setLevel: vi.fn(), enabled: () => true, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() });
  const make = (fake: FakeUpstash, opts: Partial<ConstructorParameters<typeof UpstashQuota>[0]> = {}, now = () => 10 * HOUR) =>
    new UpstashQuota({
      url: 'https://upstash.test',
      token: 'tok',
      email: 'Seth@iCloud.com',
      maxSendsPerHour: 3,
      maxRecipientsPerHour: 10,
      maxRecipientsPerDay: 20,
      fetch: fake.fetch,
      now,
      logger: quietLogger(),
      ...opts,
    });
  const members = (fake: FakeUpstash) => [...fake.data.values()].reduce((n, set) => n + set.size, 0);
  /** Largest total of `amounts` accepted within any span [t, t + windowMs). */
  const maxInWindow = (times: number[], amounts: number[], windowMs: number) =>
    Math.max(0, ...times.map((t) => times.reduce((sum, u, j) => (u >= t && u < t + windowMs ? sum + (amounts[j] ?? 0) : sum), 0)));

  it('counts sends and recipients, refuses beyond a limit and leaves nothing of the refused attempt behind', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    for (let i = 0; i < 3; i++) await q.reserve(2);
    expect(fake.total('sends_h')).toBe(3);
    await expect(q.reserve(1)).rejects.toMatchObject({ code: 'RATE_LIMIT', message: expect.stringMatching(/at most 3 emails per hour/) });
    expect(fake.total('sends_h')).toBe(3);
    expect(fake.total('rcpt_h')).toBe(6);
    expect(fake.total('rcpt_d')).toBe(6);
    expect([...fake.data.values()].map((set) => set.size)).toEqual([3, 3, 3]);
  });

  it('refuses a send whose recipients exceed the hourly budget, without counting it', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    await q.reserve(8);
    await expect(q.reserve(3)).rejects.toMatchObject({ code: 'RATE_LIMIT', message: expect.stringMatching(/only 2 more are allowed/) });
    expect(fake.total('sends_h')).toBe(1);
    expect(fake.total('rcpt_h')).toBe(8);
    expect(fake.total('rcpt_d')).toBe(8);
    expect(members(fake)).toBe(3);
  });

  it('releases a reservation once when the send does not happen', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    const r = await q.reserve(4);
    await r.release();
    await r.release();
    expect(fake.total('sends_h')).toBe(0);
    expect(fake.total('rcpt_h')).toBe(0);
    expect(fake.data.size).toBe(0);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.commands.map((c) => c[0])).toEqual(['ZREM', 'ZREM', 'ZREM']);
  });

  it('retries a release that failed, on the next call', async () => {
    const fake = new FakeUpstash();
    const logger = quietLogger();
    const q = make(fake, { logger });
    const r = await q.reserve(4);
    fake.fail = 'network';
    await expect(r.release()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('could not release a send-limit reservation', expect.anything());
    expect(fake.total('rcpt_d')).toBe(4);
    fake.fail = null;
    await r.release();
    expect(fake.total('sends_h')).toBe(0);
    expect(fake.total('rcpt_d')).toBe(0);
    const sent = fake.requests.length;
    await r.release();
    expect(fake.requests).toHaveLength(sent);
  });

  it('keeps an exact rolling hour: a burst just before the top of the hour cannot double the limit', async () => {
    const fake = new FakeUpstash();
    let now = 10 * HOUR + 59 * MIN;
    const q = make(fake, { maxSendsPerHour: 30, maxRecipientsPerHour: 0, maxRecipientsPerDay: 0 }, () => now);
    const accepted: number[] = [];
    const attempt = async () => {
      try {
        await q.reserve(1);
        accepted.push(now);
      } catch (err) {
        expect(err).toMatchObject({ code: 'RATE_LIMIT' });
      }
      expect(fake.total('sends_h')).toBeLessThanOrEqual(30);
    };
    for (let i = 0; i < 30; i++) await attempt();
    expect(accepted).toHaveLength(30);
    for (now += 10_000; now <= 12 * HOUR; now += 10_000) await attempt();
    expect(maxInWindow(accepted, accepted.map(() => 1), HOUR)).toBe(30);
    // Nothing more until the 10:59 sends are an hour old, then sending resumes.
    expect(accepted.slice(30)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => 11 * HOUR + 59 * MIN + i * 10_000));
  });

  it('keeps an exact rolling day for recipients (10 recipients a minute for 30 hours, default limits)', async () => {
    const fake = new FakeUpstash();
    const start = 7 * HOUR + 13 * MIN;
    let now = start;
    const q = make(fake, { maxSendsPerHour: 30, maxRecipientsPerHour: 150, maxRecipientsPerDay: 500 }, () => now);
    const accepted: number[] = [];
    for (; now < start + 30 * HOUR; now += MIN) {
      try {
        await q.reserve(10);
        accepted.push(now);
      } catch (err) {
        expect(err).toMatchObject({ code: 'RATE_LIMIT' });
      }
    }
    const rcpt = accepted.map(() => 10);
    expect(maxInWindow(accepted, rcpt, DAY)).toBe(500);
    expect(maxInWindow(accepted, rcpt, HOUR)).toBe(150);
    expect(maxInWindow(accepted, accepted.map(() => 1), HOUR)).toBeLessThanOrEqual(30);
    expect(accepted.filter((t) => t < start + DAY)).toHaveLength(50);
    expect(accepted.filter((t) => t >= start + DAY).length).toBeGreaterThan(0);
  });

  it('sends the token only as a Bearer header and keys one sorted set per limit by a hash of the address', async () => {
    const fake = new FakeUpstash();
    await make(fake).reserve(1);
    expect(fake.requests[0]?.url).toBe('https://upstash.test/pipeline');
    expect(fake.requests[0]?.authorization).toBe('Bearer tok');
    const keys = [...fake.data.keys()];
    const prefix = `icloud-mail:v2:${accountKey('seth@icloud.com')}`;
    expect(keys).toEqual([`${prefix}:sends_h`, `${prefix}:rcpt_h`, `${prefix}:rcpt_d`]);
    expect(keys.map((k) => k.replace(/^icloud-mail:v2:/, '')).join(' ')).not.toMatch(/seth|icloud/i);
    const [first] = fake.requests[0]?.commands ?? [];
    expect(first).toEqual(['ZREMRANGEBYSCORE', `${prefix}:sends_h`, '-inf', String(9 * HOUR)]);
    expect(fake.requests[0]?.commands.slice(1, 4)).toEqual([
      ['ZADD', `${prefix}:sends_h`, String(10 * HOUR), expect.stringMatching(/^[0-9a-f-]{36}:1$/)],
      ['PEXPIRE', `${prefix}:sends_h`, String(HOUR + MIN)],
      ['ZRANGE', `${prefix}:sends_h`, '0', '-1'],
    ]);
    expect(fake.ttl.get(`${prefix}:rcpt_d`)).toBe(DAY + MIN);
  });

  it('fails closed when Upstash is unreachable or refuses the token', async () => {
    const fake = new FakeUpstash();
    fake.fail = 'network';
    await expect(make(fake).reserve(1)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/Not sent: the send-limit store/) });
    fake.fail = 401;
    await expect(make(fake).reserve(1)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/HTTP 401 \(check the Upstash token\)/) });
    expect(fake.data.size).toBe(0);
  });

  it('removes its members when the answer is lost after Upstash applied the commands', async () => {
    const fake = new FakeUpstash();
    const q = make(fake);
    fake.fail = 'timeout-after-apply';
    fake.failTimes = 1;
    await expect(q.reserve(2)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/could not be reached \(The operation was aborted due to timeout\)/) });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.commands.map((c) => c[0])).toEqual(['ZREM', 'ZREM', 'ZREM']);
    expect(fake.total('sends_h')).toBe(0);
    expect(fake.total('rcpt_h')).toBe(0);
    expect(fake.total('rcpt_d')).toBe(0);
    expect(fake.data.size).toBe(0);
    await expect(q.reserve(2)).resolves.toBeDefined();
    expect(fake.total('sends_h')).toBe(1);
  });

  it('removes its members after an HTTP error, a wrong-length answer, or an error in one command', async () => {
    const fake = new FakeUpstash();
    fake.fail = 503;
    fake.failTimes = 1;
    await expect(make(fake).reserve(2)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/HTTP 503/) });
    expect(fake.requests.at(-1)?.commands.map((c) => c[0])).toEqual(['ZREM', 'ZREM', 'ZREM']);
    expect(fake.data.size).toBe(0);

    fake.errorAt = 5; // the recipients-per-hour ZADD fails; the other commands are applied
    await expect(make(fake).reserve(2)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/reported an error \(ERR simulated failure\)/) });
    expect(fake.total('sends_h') + fake.total('rcpt_h') + fake.total('rcpt_d')).toBe(0);
    expect(fake.data.size).toBe(0);

    let calls = 0;
    const truncating: typeof fake.fetch = async (url, init) => {
      const res = await fake.fetch(url, init);
      const body = (await res.json()) as unknown[];
      return { ...res, json: async () => (calls++ === 0 ? body.slice(1) : body) };
    };
    await expect(make(fake, { fetch: truncating }).reserve(2)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/unexpected answer/) });
    expect(fake.data.size).toBe(0);
  });

  it('logs, and still reports the original error, when the clean-up fails too', async () => {
    const fake = new FakeUpstash();
    const logger = quietLogger();
    fake.fail = 'network';
    await expect(make(fake, { logger }).reserve(1)).rejects.toMatchObject({ code: 'CONNECTION', message: expect.stringMatching(/could not be reached \(getaddrinfo ENOTFOUND/) });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/could not remove a send-limit reservation/), expect.anything());
  });

  it('reports what is left in the rolling windows', async () => {
    const fake = new FakeUpstash();
    let now = 10 * HOUR;
    const q = make(fake, {}, () => now);
    await q.reserve(4);
    expect(await q.status()).toEqual({ store: 'upstash', sends_remaining_this_hour: 2, recipients_remaining_this_hour: 6, recipients_remaining_today: 16 });
    now = 11 * HOUR; // the send is now exactly an hour old: out of the hourly window, still in the daily one
    expect(await q.status()).toEqual({ store: 'upstash', sends_remaining_this_hour: 3, recipients_remaining_this_hour: 10, recipients_remaining_today: 16 });
    expect(fake.requests.at(-1)?.commands[0]).toEqual(['ZRANGEBYSCORE', expect.stringMatching(/:sends_h$/), `(${10 * HOUR}`, '+inf']);
    expect(await make(fake, { maxSendsPerHour: 0 }).status()).toMatchObject({ sends_remaining_this_hour: 'unlimited', recipients_remaining_today: 16 });
    fake.fail = 'network';
    expect(await q.status()).toEqual({ store: 'upstash', error: expect.stringMatching(/could not be reached/) });
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
    const password = 'zzqx-secr-etpw-qxyz';
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
      const c = await connectCloud(handler, { headers: { 'X-ICloud-Email': `u${i}@icloud.com`, 'X-ICloud-Password': `abcd-efgh-ijkl-${String.fromCharCode(97 + i)}aaa` } });
      await c.close();
    }
    expect(handler.cachedLogins).toBe(MAX_CACHED_LOGINS);
  });
});
