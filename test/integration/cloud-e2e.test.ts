/**
 * The cloud (Vercel) entry end to end against the local test-infra servers: MCP over HTTP (the
 * client's requests go straight into the handler), env and header logins, inline attachments,
 * drafts, and sending through the shared send-limit store (an in-memory Upstash stand-in).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { createCloudHandler, type CloudHandler } from '../../src/http/handler.js';
import { setRuntime } from '../../src/runtime.js';
import { cloudEnv, connectCloud, FakeUpstash, resultText } from '../helpers/cloud.js';
import { ACCOUNT, PASSWORD, findSidecarByMessageId, listSidecars, rawUidsByMessageId, resetMailServer } from '../helpers/infra.js';
import { json, leadingJson, toToolCall } from '../helpers/mcp.js';

const SENT = 'Sent Messages';

type Session = Awaited<ReturnType<typeof connectCloud>>;

async function call(s: Session, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await s.client.callTool({ name, arguments: args })) as CallToolResult;
}

let fake: FakeUpstash;
let handler: CloudHandler;
let session: Session;

beforeAll(async () => {
  await resetMailServer();
  fake = new FakeUpstash();
  handler = createCloudHandler({ env: cloudEnv(), serviceDeps: { quotaFetch: fake.fetch } });
  session = await connectCloud(handler);
});

afterAll(async () => {
  await session?.close();
  await handler?.close();
  setRuntime('local');
});

describe('reading over HTTP', () => {
  it('lists mailboxes and searches with the Vercel env login', async () => {
    const boxes = json<{ mailboxes: Array<{ path: string; special_use: string | null }> }>(toToolCall(await call(session, 'list_mailboxes')));
    expect(boxes.mailboxes.map((m) => m.path)).toEqual(expect.arrayContaining(['INBOX', SENT, 'Drafts', 'Deleted Messages']));
    const found = json<{ total: number; messages: unknown[] }>(toToolCall(await call(session, 'search_messages', { limit: 5 })));
    expect(found.total).toBeGreaterThan(5);
    expect(found.messages).toHaveLength(5);
  });

  it('works with a login sent in connector headers instead of the env', async () => {
    const h = createCloudHandler({ env: cloudEnv({ ICLOUD_EMAIL: undefined, ICLOUD_PASSWORD: undefined }), serviceDeps: { quotaFetch: fake.fetch } });
    const s = await connectCloud(h, { headers: { 'X-ICloud-Email': ACCOUNT, 'X-ICloud-Password': PASSWORD } });
    const r = await call(s, 'get_message', { mailbox: 'INBOX', uid: 1 });
    expect(r.isError).toBeFalsy();
    expect(resultText(r)).toMatch(/BEGIN UNTRUSTED EMAIL CONTENT/);
    const info = json<Record<string, unknown>>(toToolCall(await call(s, 'get_account_info')));
    expect(info['runtime']).toBe('cloud');
    expect(info['password_source']).toBe('X-ICloud-Password connector header');
    await s.close();
    await h.close();
  });

  it('reports a wrong password with the iCloud guidance, never the password itself', async () => {
    const s = await connectCloud(handler, { headers: { 'X-ICloud-Email': ACCOUNT, 'X-ICloud-Password': 'wrong-pass-7781' } });
    const r = await call(s, 'list_mailboxes');
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/app-specific password/);
    expect(resultText(r)).toMatch(/X-ICloud-Password connector header or set ICLOUD_PASSWORD/);
    expect(resultText(r)).not.toContain('wrong-pass-7781');
    await s.close();
  });
});

describe('attachments in the cloud (no disk)', () => {
  it('returns images and text inline without saving anything', async () => {
    const img = await call(session, 'download_attachment', { mailbox: 'INBOX', uid: 8, part: '2' });
    expect(img.content.some((c) => c.type === 'image')).toBe(true);
    const first = img.content[0];
    const meta = JSON.parse(first?.type === 'text' ? first.text : '{}') as Record<string, unknown>;
    expect(meta['path']).toBeUndefined();
    expect(String(meta['note'])).not.toMatch(/Saved to/);
    const txt = await call(session, 'download_attachment', { mailbox: 'INBOX', uid: 7, part: '2' });
    expect(resultText(txt)).toMatch(/BEGIN UNTRUSTED EMAIL CONTENT/);
    expect(leadingJson<Record<string, unknown>>(resultText(txt))['path']).toBeUndefined();
  });

  it('describes other files (a PDF) instead of saving them', async () => {
    const pdf = await call(session, 'download_attachment', { mailbox: 'INBOX', uid: 6, part: '2' });
    const meta = json<Record<string, unknown>>(toToolCall(pdf));
    expect(meta).toMatchObject({ filename: 'Invoice-10423.pdf', content_type: 'application/pdf' });
    expect(meta['path']).toBeUndefined();
    expect(String(meta['note'])).toMatch(/cloud version cannot save files/);
  });

  it('rejects a local-file attachment parameter (it is not offered in the cloud)', async () => {
    const r = await call(session, 'send_email', { to: ['bob@example.com'], subject: 'x', body: 'y', attachments: ['/etc/passwd'] });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/attachments/);
  });
});

describe('drafts and sending', () => {
  afterEach(() => {
    fake.fail = null;
  });

  it('saves a draft into Drafts', async () => {
    const r = json<{ uid: number; mailbox: string }>(toToolCall(await call(session, 'save_draft', { to: ['bob@example.com'], subject: 'Cloud draft', body: 'Hello from Vercel' })));
    expect(r.mailbox).toBe('Drafts');
    expect(r.uid).toBeGreaterThan(0);
  });

  it('sends, saves the Sent copy once, and counts the send in the shared store', async () => {
    const before = fake.total('sends_h');
    const r = json<{ sent: boolean; message_id: string; sent_copy_saved: boolean }>(
      toToolCall(await call(session, 'send_email', { to: ['bob@example.com'], cc: ['carol@example.com'], subject: 'Cloud send', body: 'Sent from the cloud version' })),
    );
    expect(r.sent).toBe(true);
    expect(r.sent_copy_saved).toBe(true);
    expect(findSidecarByMessageId(r.message_id)?.envelope.rcptTo.slice().sort()).toEqual(['bob@example.com', 'carol@example.com']);
    expect(await rawUidsByMessageId(SENT, r.message_id)).toHaveLength(1);
    expect(fake.total('sends_h')).toBe(before + 1);
    expect(fake.total('rcpt_d')).toBeGreaterThanOrEqual(2);
    const info = json<{ shared_send_limits: Record<string, unknown> }>(toToolCall(await call(session, 'get_account_info')));
    expect(info.shared_send_limits).toMatchObject({ store: 'upstash' });
  });

  it('refuses to send (fail closed) when the store cannot be reached, and gives the reservation back on SMTP failure', async () => {
    const sidecars = listSidecars().length;
    fake.fail = 'network';
    const down = await call(session, 'send_email', { to: ['bob@example.com'], subject: 'Should not go', body: 'x' });
    expect(down.isError).toBe(true);
    expect(resultText(down)).toMatch(/send-limit store \(Upstash Redis\) could not be reached/);
    expect(listSidecars()).toHaveLength(sidecars);
    fake.fail = null;
    const before = fake.total('sends_h');
    const refused = await call(session, 'send_email', { to: ['nobody@reject.test'], subject: 'Rejected', body: 'x' });
    expect(refused.isError).toBe(true);
    expect(fake.total('sends_h')).toBe(before);
  });

  it('enforces the shared hourly limit across handler instances (as two Vercel instances would)', async () => {
    const shared = new FakeUpstash();
    const env = cloudEnv({ MAIL_MAX_SENDS_PER_HOUR: '1' });
    const h1 = createCloudHandler({ env, serviceDeps: { quotaFetch: shared.fetch } });
    const h2 = createCloudHandler({ env, serviceDeps: { quotaFetch: shared.fetch } });
    const s1 = await connectCloud(h1);
    const s2 = await connectCloud(h2);
    const first = await call(s1, 'send_email', { to: ['bob@example.com'], subject: 'Limit 1', body: 'x' });
    expect(first.isError).toBeFalsy();
    const second = await call(s2, 'send_email', { to: ['bob@example.com'], subject: 'Limit 2', body: 'x' });
    expect(second.isError).toBe(true);
    expect(resultText(second)).toMatch(/at most 1 emails per hour \(MAIL_MAX_SENDS_PER_HOUR\)/);
    for (const x of [s1, s2]) await x.close();
    for (const x of [h1, h2]) await x.close();
  });

  it('without a configured store, refuses sends with the fix but still saves drafts', async () => {
    const h = createCloudHandler({ env: cloudEnv({ UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }) });
    const s = await connectCloud(h);
    const r = await call(s, 'send_email', { to: ['bob@example.com'], subject: 'No store', body: 'x' });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toMatch(/Add Upstash for Redis/);
    expect((await call(s, 'save_draft', { to: ['bob@example.com'], subject: 'No store draft', body: 'x' })).isError).toBeFalsy();
    await s.close();
    await h.close();
  });

  it('writes the audit trail to stdout (the Vercel logs)', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      if (String(chunk).startsWith('icloud-mail-audit ')) lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const h = createCloudHandler({ env: cloudEnv({ MAIL_AUDIT_LOG: undefined }), serviceDeps: { quotaFetch: fake.fetch } });
    const s = await connectCloud(h);
    try {
      await call(s, 'save_draft', { to: ['bob@example.com'], subject: 'Audited', body: 'secret body text' });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => l.includes('"tool":"save_draft"'))).toBe(true);
    expect(lines.join('')).not.toContain('secret body text');
    await s.close();
    await h.close();
  });
});
