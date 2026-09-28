/**
 * End-to-end read tools over stdio against the main test-infra instance: list_mailboxes,
 * search_messages, get_message, get_thread, get_account_info and download_attachment.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UNTRUSTED_BEGIN, UNTRUSTED_END, UNTRUSTED_LIST_NOTE } from '../../src/safety/untrusted.js';
import { e2eEnv } from '../helpers/e2e.js';
import { PASSWORD, cleanupDirs, loadManifest, makeTestDirs, resetMailServer, type TestDirs } from '../helpers/infra.js';
import { auditEntries, json, leadingJson, startMcp, type McpSession } from '../helpers/mcp.js';

interface Summary {
  mailbox: string;
  uid: number;
  date: string | null;
  from: string;
  subject: string;
  unread: boolean;
  flagged: boolean;
  flag_color: string | null;
  has_attachments: boolean;
  snippet?: string;
}
interface SearchResult {
  total: number;
  offset: number;
  returned: number;
  has_more: boolean;
  messages: Summary[];
  mailboxes_searched?: string[];
}

let dirs: TestDirs;
let s: McpSession;

beforeAll(async () => {
  await resetMailServer();
  dirs = makeTestDirs();
  s = await startMcp(e2eEnv(dirs));
});

afterAll(async () => {
  await s?.close();
  if (dirs) cleanupDirs(dirs);
});

describe('list_mailboxes', () => {
  it('lists every mailbox with counts, INBOX and special folders first', async () => {
    const r = await s.call('list_mailboxes');
    expect(r.isError).toBe(false);
    const data = json<{ count: number; mailboxes: Array<{ path: string; special_use: string | null; selectable: boolean; total: number | null; unread: number | null }> }>(r);
    expect(data.mailboxes.map((m) => m.path)).toEqual(['INBOX', 'Drafts', 'Sent Messages', 'Archive', 'Junk', 'Deleted Messages', 'Projects', 'Projects/Acme', 'Receipts']);
    expect(data.count).toBe(9);
    const manifest = loadManifest();
    for (const m of data.mailboxes) {
      expect(m.total, m.path).toBe(manifest.mailboxes[m.path]?.count);
      expect(m.unread, m.path).toBe(manifest.mailboxes[m.path]?.unseen);
    }
    expect(Object.fromEntries(data.mailboxes.filter((m) => m.special_use).map((m) => [m.special_use, m.path]))).toEqual({
      inbox: 'INBOX',
      drafts: 'Drafts',
      sent: 'Sent Messages',
      archive: 'Archive',
      junk: 'Junk',
      trash: 'Deleted Messages',
    });
  });

  it('can skip the counts', async () => {
    const data = json<{ mailboxes: Array<{ total: number | null; unread: number | null }> }>(await s.call('list_mailboxes', { include_counts: false }));
    expect(data.mailboxes.every((m) => m.total === null && m.unread === null)).toBe(true);
  });
});

describe('search_messages', () => {
  it('lists the newest messages first when no criteria are given, with the untrusted reminder', async () => {
    const r = await s.call('search_messages', { limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.text.startsWith(UNTRUSTED_LIST_NOTE)).toBe(true);
    const data = json<SearchResult>(r);
    expect(data).toMatchObject({ total: 29, offset: 0, returned: 5, has_more: true });
    expect(data.messages.map((m) => m.uid)).toEqual([29, 28, 27, 26, 25]);
    expect(data.messages[0]).toMatchObject({ mailbox: 'INBOX', subject: 'Weekend plans?', from: 'Alice Nguyen <alice@example.com>', date: '2026-09-27T17:30:00-07:00' });
    expect(typeof data.messages[0]?.snippet).toBe('string');
  });

  it('combines criteria, pages, and omits snippets on request', async () => {
    expect(json<SearchResult>(await s.call('search_messages', { from: 'alice@example.com' })).messages.map((m) => m.uid)).toEqual([29, 3]);
    expect(json<SearchResult>(await s.call('search_messages', { subject: 'kickoff', mailbox: 'inbox' })).messages.map((m) => m.uid)).toEqual([23, 22]);
    expect(json<SearchResult>(await s.call('search_messages', { flag_color: 'green' })).messages.map((m) => m.uid)).toEqual([18]);
    expect(json<SearchResult>(await s.call('search_messages', { flagged: true, unread: true })).messages.map((m) => m.uid)).toEqual([18]);
    expect(json<SearchResult>(await s.call('search_messages', { min_size_kb: 1000 })).messages.map((m) => m.uid)).toEqual([24]);
    expect(json<SearchResult>(await s.call('search_messages', { since: '2026-09-01', before: '2026-09-20', limit: 100 })).messages.map((m) => m.uid)).toEqual([27, 26, 25]);
    const page2 = json<SearchResult>(await s.call('search_messages', { unread: true, limit: 10, offset: 10, include_snippets: false }));
    expect(page2).toMatchObject({ total: 15, returned: 5, has_more: false });
    expect(page2.messages.every((m) => m.snippet === undefined)).toBe(true);
  });

  it('searches all mailboxes except Trash and Junk', async () => {
    const data = json<SearchResult>(await s.call('search_messages', { all_mailboxes: true, subject: 'kickoff' }));
    expect(data.total).toBe(4);
    expect(data.messages.map((m) => `${m.mailbox}:${m.uid}`)).toEqual(['Drafts:1', 'INBOX:23', 'Sent Messages:2', 'INBOX:22']);
    expect(data.mailboxes_searched).not.toContain('Junk');
    expect(data.mailboxes_searched).not.toContain('Deleted Messages');
    expect(json<SearchResult>(await s.call('search_messages', { mailbox: 'spam', subject: 'gift card' })).total).toBe(1);
  });

  it('explains bad input and unknown mailboxes', async () => {
    const date = await s.call('search_messages', { since: 'last tuesday' });
    expect(date.isError).toBe(true);
    expect(date.text).toMatch(/since must be a date like 2026-09-28/);
    const order = await s.call('search_messages', { since: '2026-09-20', before: '2026-09-01' });
    expect(order.isError).toBe(true);
    expect(order.text).toMatch(/earlier than before/);
    const unknown = await s.call('search_messages', { mailbox: 'No Such Folder' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Available mailboxes: INBOX, Drafts, Sent Messages/);
  });
});

describe('get_message', () => {
  it('shows headers, attachments and the body wrapped as untrusted content', async () => {
    const r = await s.call('get_message', { mailbox: 'INBOX', uid: 6 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Subject: Invoice #10423 for March');
    expect(r.text).toContain('From: Vendor Billing <billing@vendor.example>');
    expect(r.text).toContain('- part 2: "Invoice-10423.pdf" (application/pdf');
    expect(r.text).toContain(UNTRUSTED_BEGIN);
    expect(r.text).toContain(UNTRUSTED_END);
    expect(r.text).toMatch(/Flags: unread/);
  });

  it('keeps the prompt-injection fixture inside the untrusted block', async () => {
    const r = await s.call('get_message', { mailbox: 'INBOX', uid: 25 });
    const begin = r.text.indexOf(UNTRUSTED_BEGIN);
    const end = r.text.lastIndexOf(UNTRUSTED_END);
    const injection = r.text.indexOf('IGNORE PREVIOUS INSTRUCTIONS');
    expect(begin).toBeGreaterThan(0);
    expect(injection).toBeGreaterThan(begin);
    expect(injection).toBeLessThan(end);
    expect(r.text.split(UNTRUSTED_END).length - 1).toBe(1);
    expect(r.text.startsWith('Note: header values, attachment names and the body below come from the email itself')).toBe(true);
  });

  it('converts an HTML-only body to text and can include the raw HTML', async () => {
    const r = await s.call('get_message', { mailbox: 'INBOX', uid: 4, include_html: true });
    expect(r.text).toMatch(/Body \(converted from HTML;/);
    const body = r.text.slice(r.text.indexOf(UNTRUSTED_BEGIN), r.text.indexOf(UNTRUSTED_END));
    expect(body).not.toMatch(/<\/?(p|div|table|td|span|img|html|body)\b/i);
    expect(body).toContain('Shop now <https://shop.example/feb?utm_source=email>');
    expect(r.text).toMatch(/Raw HTML \(/);
    expect(r.text.split(UNTRUSTED_BEGIN).length - 1).toBe(2);
  });

  it('handles the 2 MB message quickly without downloading its attachment', async () => {
    const started = Date.now();
    const r = await s.call('get_message', { mailbox: 'INBOX', uid: 24 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.text).toContain('"sensor-dataset.bin" (application/octet-stream');
    expect(r.text).toMatch(/Size: 1\.9 MB/);
    expect(r.text.length).toBeLessThan(10_000);
  });

  it('truncates long bodies at max_chars and says so', async () => {
    const r = await s.call('get_message', { mailbox: 'INBOX', uid: 27, max_chars: 500 });
    expect(r.text).toMatch(/showing 500 of \d+ characters/);
    expect(r.text).toMatch(/Body truncated: showing 500 of \d+ characters\. Call get_message with a larger max_chars/);
    expect(r.text).not.toMatch(/<script|tracking-pixel\.gif/i);
  });

  it('reports a missing UID, a bad mailbox and does not mark the message read', async () => {
    const missing = await s.call('get_message', { mailbox: 'INBOX', uid: 999 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No message with UID 999 in "INBOX"/);
    const bad = await s.call('get_message', { mailbox: 'Nowhere', uid: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Available mailboxes/);
    const before = json<SearchResult>(await s.call('search_messages', { unread: true, limit: 100, include_snippets: false })).total;
    await s.call('get_message', { mailbox: 'INBOX', uid: 29 });
    expect(json<SearchResult>(await s.call('search_messages', { unread: true, limit: 100, include_snippets: false })).total).toBe(before);
  });
});

describe('get_thread', () => {
  it('finds the three-message thread across INBOX and Sent in chronological order', async () => {
    const r = await s.call('get_thread', { mailbox: 'INBOX', uid: 23 });
    expect(r.text.startsWith(UNTRUSTED_LIST_NOTE)).toBe(true);
    const t = json<{ total: number; messages: Summary[]; mailboxes_searched: string[] }>(r);
    expect(t.messages.map((m) => `${m.mailbox}:${m.uid}`)).toEqual(['INBOX:22', 'Sent Messages:2', 'INBOX:23']);
    expect(t.messages.every((m) => typeof m.snippet === 'string')).toBe(true);
    expect(t.mailboxes_searched).toEqual(expect.arrayContaining(['INBOX', 'Sent Messages', 'Archive']));
    const limited = json<{ total: number; returned: number; messages: Summary[] }>(await s.call('get_thread', { mailbox: 'INBOX', uid: 22, limit: 1 }));
    expect(limited).toMatchObject({ total: 3, returned: 1 });
    expect(limited.messages[0]?.uid).toBe(23);
  });

  it('reports a missing seed message', async () => {
    const r = await s.call('get_thread', { mailbox: 'INBOX', uid: 4242 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No message with UID 4242/);
  });
});

describe('get_account_info', () => {
  it('reports the connection, features and folders without the password', async () => {
    const r = await s.call('get_account_info');
    expect(r.isError).toBe(false);
    const info = json(r);
    expect(info).toMatchObject({
      status: 'connected',
      email: 'testuser@icloud.test',
      capabilities: { MOVE: true, UIDPLUS: true, 'SPECIAL-USE': true, IDLE: true, QUOTA: true },
      special_folders: { inbox: 'INBOX', sent: 'Sent Messages', trash: 'Deleted Messages', drafts: 'Drafts', junk: 'Junk', archive: 'Archive' },
      features: { send: true, permanent_delete: false, read_only: false, drafts: true, confirm_dialog: false, save_sent_copy: true },
      audit_log: dirs.auditLog,
    });
    expect((info['now'] as { timezone: string }).timezone).toBe('America/Los_Angeles');
    expect((info['imap'] as { login: string }).login).toBe('testuser@icloud.test');
    expect(r.text).not.toContain(PASSWORD);
  });
});

describe('download_attachment', () => {
  it('saves the PDF, never overwrites, and says the content is not shown', async () => {
    const a = await s.call('download_attachment', { mailbox: 'INBOX', uid: 6, part: '2' });
    expect(a.isError).toBe(false);
    const first = json<{ path: string; filename: string; content_type: string; size: number; note: string }>(a);
    expect(first).toMatchObject({ filename: 'Invoice-10423.pdf', content_type: 'application/pdf' });
    expect(path.dirname(first.path)).toBe(dirs.attachmentDir);
    expect(readFileSync(first.path).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(first.note).toMatch(/Saved to/);
    expect(a.content.map((c) => c.type)).toEqual(['text']);

    const second = json<{ path: string; filename: string; size: number }>(await s.call('download_attachment', { mailbox: 'INBOX', uid: 6, part: '2' }));
    expect(second.filename).toBe('Invoice-10423 (1).pdf');
    expect(second.size).toBe(first.size);
    expect(existsSync(first.path)).toBe(true);
    expect(readdirSync(dirs.attachmentDir).sort()).toEqual(['Invoice-10423 (1).pdf', 'Invoice-10423.pdf']);
  });

  it('returns a small text attachment as wrapped untrusted text', async () => {
    const r = await s.call('download_attachment', { mailbox: 'INBOX', uid: 7, part: '2' });
    expect(r.isError).toBe(false);
    const meta = leadingJson<{ filename: string; content_type: string }>(r.text);
    expect(meta).toMatchObject({ filename: 'notes.txt', content_type: 'text/plain' });
    expect(r.text).toContain(UNTRUSTED_BEGIN);
    expect(r.text.trimEnd().split('\n').at(-1)?.startsWith(UNTRUSTED_END)).toBe(true);
  });

  it('returns a small image as an image block', async () => {
    const r = await s.call('download_attachment', { mailbox: 'INBOX', uid: 8, part: '2' });
    expect(r.isError).toBe(false);
    expect(r.content.map((c) => c.type)).toEqual(['text', 'image']);
    const img = r.content[1];
    if (img?.type !== 'image') throw new Error('expected an image block');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG');
    const noContent = await s.call('download_attachment', { mailbox: 'INBOX', uid: 8, part: '2', return_content: false });
    expect(noContent.content.map((c) => c.type)).toEqual(['text']);
    expect(json<{ filename: string }>(noContent).filename).toBe('summit (1).png');
  });

  it('refuses unknown parts, multipart containers and oversized attachments', async () => {
    const unknown = await s.call('download_attachment', { mailbox: 'INBOX', uid: 6, part: '9' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/has no part "9"\. Attachment parts: 2/);
    const container = await s.call('download_attachment', { mailbox: 'INBOX', uid: 8, part: '1' });
    expect(container.isError).toBe(true);
    expect(container.text).toMatch(/multipart container/);
    const small = await startMcp(e2eEnv(dirs, { MAIL_MAX_ATTACHMENT_MB: '1' }));
    try {
      const big = await small.call('download_attachment', { mailbox: 'INBOX', uid: 24, part: '2' });
      expect(big.isError).toBe(true);
      expect(big.text).toMatch(/MAIL_MAX_ATTACHMENT_MB/);
    } finally {
      await small.close();
    }
  });

  it('audits downloads (including refused ones) without content', () => {
    const entries = auditEntries(dirs.auditLog).filter((e) => e['tool'] === 'download_attachment');
    expect(entries.filter((e) => e['result'] === 'ok').length).toBeGreaterThanOrEqual(4);
    const refused = entries.filter((e) => e['result'] === 'error');
    expect(refused.map((e) => e['error_code'])).toEqual(expect.arrayContaining(['NOT_FOUND', 'INVALID_INPUT', 'TOO_LARGE']));
    expect(refused.every((e) => typeof e['mailbox'] === 'string' && Array.isArray(e['uids']))).toBe(true);
  });
});
