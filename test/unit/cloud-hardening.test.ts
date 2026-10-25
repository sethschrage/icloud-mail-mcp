/**
 * Pre-deploy review fixes for the cloud entry: header logins are validated before their password
 * is registered with the redactor (and never echoed), evicted logins wait for in-flight requests
 * and are forgotten by the redactor, the cloud deadline stays inside Vercel's limit, post-send
 * work is kept alive on Vercel, and cloud tool texts don't mention the Mac.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createCloudHandler, MAX_CACHED_LOGINS, type CloudHandler } from '../../src/http/handler.js';
import { clearSecrets, redact } from '../../src/log.js';
import { keepAlive, setKeepAlive, setRuntime } from '../../src/runtime.js';
import { MailService } from '../../src/service.js';
import { ACCESS_KEY, cloudEnv, connectCloud, ENDPOINT, resultText } from '../helpers/cloud.js';

afterAll(() => {
  setRuntime('local');
  setKeepAlive(null);
});

const appPassword = (i: number) => `abcd-efgh-ijkl-${String.fromCharCode(97 + i)}aaa`;

/** A raw tools/list POST, as claude.ai sends it, with optional login headers. */
const toolsList = (headers: Record<string, string> = {}) =>
  new Request(`${ENDPOINT}?key=${ACCESS_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

describe('header logins', () => {
  let handler: CloudHandler | undefined;
  afterEach(async () => {
    await handler?.close();
    handler = undefined;
    vi.restoreAllMocks();
    clearSecrets();
  });

  it('refuses swapped or malformed login headers without echoing them, and registers nothing', async () => {
    const logged: string[] = [];
    const logger = { error: (...a: unknown[]) => logged.push(JSON.stringify(a)), warn: (...a: unknown[]) => logged.push(JSON.stringify(a)), info: () => undefined, debug: () => undefined } as never;
    handler = createCloudHandler({ env: cloudEnv({ IMAP_PORT: '9' }), logger });
    // A user pasting the app password into the email header, and the address into the password one.
    const swapped = await connectCloud(handler, { headers: { 'X-ICloud-Email': 'qwer-tyui-opas-dfgh', 'X-ICloud-Password': 'victim@example.com' } });
    const r = await swapped.client.callTool({ name: 'list_mailboxes', arguments: {} });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/X-ICloud-Email is not a valid email address/);
    expect(resultText(r)).toMatch(/X-ICloud-Password is not an app-specific password/);
    for (const text of [resultText(r), ...logged]) {
      expect(text).not.toContain('qwer-tyui-opas-dfgh');
      expect(text).not.toContain('victim@example.com');
    }
    await swapped.close();
    // Neither value became a "secret": the redactor cannot be used to hide addresses or tool names.
    expect(redact('victim@example.com send_email')).toBe('victim@example.com send_email');
  });

  it('accepts app-specific passwords with or without dashes and only then redacts them', async () => {
    handler = createCloudHandler({ env: cloudEnv({ IMAP_PORT: '9' }) });
    for (const password of ['abcd-efgh-ijkl-mnop', 'ABCDEFGHIJKLMNOQ']) {
      const res = await handler(toolsList({ 'x-icloud-email': 'a@icloud.com', 'x-icloud-password': password }));
      expect(res.status).toBe(200);
      await res.text();
      expect(redact(`pw ${password}`)).toBe('pw [REDACTED]');
    }
  });

  it('forgets an evicted login\'s password, but not one the env login still uses', async () => {
    const envPassword = 'mnop-qrst-uvwx-yzab';
    handler = createCloudHandler({ env: cloudEnv({ IMAP_PORT: '9', ICLOUD_PASSWORD: envPassword }) });
    const first = await handler(toolsList({ 'x-icloud-email': 'a@icloud.com', 'x-icloud-password': appPassword(0) }));
    await first.text();
    const same = await handler(toolsList({ 'x-icloud-email': 'b@icloud.com', 'x-icloud-password': envPassword }));
    await same.text();
    expect(redact(appPassword(0))).toBe('[REDACTED]');
    for (let i = 1; i <= MAX_CACHED_LOGINS; i++) {
      const res = await handler(toolsList({ 'x-icloud-email': `u${i}@icloud.com`, 'x-icloud-password': appPassword(i) }));
      await res.text();
    }
    expect(handler.cachedLogins).toBe(MAX_CACHED_LOGINS);
    expect(redact(appPassword(0))).toBe(appPassword(0)); // evicted: forgotten
    expect(redact(envPassword)).toBe('[REDACTED]'); // evicted header login, but the env login's password
  });

  it('closes an evicted login only once its in-flight request has finished', async () => {
    const closed: MailService[] = [];
    const original = MailService.prototype.close;
    vi.spyOn(MailService.prototype, 'close').mockImplementation(function (this: MailService) {
      closed.push(this);
      return original.call(this);
    });
    handler = createCloudHandler({ env: cloudEnv({ IMAP_PORT: '9' }) });
    // Request A's response is not read yet: its tool call is still "running" as far as we know.
    const a = await handler(toolsList({ 'x-icloud-email': 'a@icloud.com', 'x-icloud-password': appPassword(0) }));
    for (let i = 1; i <= MAX_CACHED_LOGINS; i++) {
      const res = await handler(toolsList({ 'x-icloud-email': `u${i}@icloud.com`, 'x-icloud-password': appPassword(i) }));
      await res.text();
    }
    expect(handler.cachedLogins).toBe(MAX_CACHED_LOGINS);
    expect(closed).toHaveLength(0); // A was evicted, but is still in use
    expect(await a.text()).toMatch(/"tools"/);
    expect(closed).toHaveLength(1);
  });
});

describe('cloud limits and texts', () => {
  afterEach(() => setRuntime('local'));

  it('caps the per-call deadline below Vercel\'s 60 s function limit', () => {
    const cloud = loadConfig(cloudEnv({ MAIL_OPERATION_TIMEOUT_SECONDS: '120' }), { runtime: 'cloud' });
    expect(cloud.config.operationTimeoutSeconds).toBe(50);
    expect(cloud.warnings.join(' ')).toMatch(/MAIL_OPERATION_TIMEOUT_SECONDS/);
    const local = loadConfig({ ...cloudEnv({ MAIL_OPERATION_TIMEOUT_SECONDS: '120' }), MCP_ACCESS_KEY: undefined }, { runtime: 'local' });
    expect(local.config.operationTimeoutSeconds).toBe(120);
  });

  it('keeps post-send work alive through the registered hook (Vercel waitUntil)', async () => {
    expect(keepAlive(Promise.resolve())).toBe(false);
    const kept: Promise<unknown>[] = [];
    setKeepAlive((p) => kept.push(p));
    try {
      // A rejection is swallowed before it reaches the platform.
      expect(keepAlive(Promise.reject(new Error('late')))).toBe(true);
      expect(kept).toHaveLength(1);
      await expect(kept[0]).resolves.toBeUndefined();
    } finally {
      setKeepAlive(null);
    }
  });

  it('lets forwarding be always allowed only with MAIL_FORWARD_ALWAYS_ALLOW, keeping every other send gated', async () => {
    const meta = async (env: Record<string, string>) => {
      const handler = createCloudHandler({ env: cloudEnv({ IMAP_PORT: '9', ...env }) });
      const { client, close } = await connectCloud(handler);
      const tools = (await client.listTools()).tools;
      await close();
      await handler.close();
      return Object.fromEntries(tools.map((t) => [t.name, { gated: t._meta?.['anthropic/requiresUserInteraction'] === true, destructive: t.annotations?.destructiveHint }]));
    };
    const off = await meta({});
    for (const name of ['send_email', 'reply_to_message', 'forward_message', 'send_draft']) expect(off[name], name).toEqual({ gated: true, destructive: true });
    const on = await meta({ MAIL_FORWARD_ALWAYS_ALLOW: 'true' });
    expect(on['forward_message']).toEqual({ gated: false, destructive: true });
    for (const name of ['send_email', 'reply_to_message', 'send_draft']) expect(on[name], name).toEqual({ gated: true, destructive: true });
  });

  it('does not mention a Mac dialog for permanent deletion in the cloud', async () => {
    const handler = createCloudHandler({ env: cloudEnv({ IMAP_PORT: '9', MAIL_ALLOW_PERMANENT_DELETE: 'true' }) });
    const { client, close } = await connectCloud(handler);
    const tools = (await client.listTools()).tools;
    const del = tools.find((t) => t.name === 'delete_messages_permanently');
    expect(del?.description).toMatch(/CANNOT BE UNDONE/);
    expect(del?.description).not.toMatch(/on the Mac/);
    await close();
    await handler.close();
  });
});
