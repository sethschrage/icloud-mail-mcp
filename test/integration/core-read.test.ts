/**
 * Domain-layer read paths against the main test-infra instance (IMAPS 1993 with the test CA).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MailError } from '../../src/errors.js';
import { renderListResult, renderMessageView } from '../../src/render.js';
import type { MailService } from '../../src/service.js';
import { UNTRUSTED_BEGIN, UNTRUSTED_END, UNTRUSTED_LIST_NOTE } from '../../src/safety/untrusted.js';
import { cleanupDirs, createTestService, fixture, loadManifest, makeTestDirs, resetMailServer, type TestDirs } from '../helpers/infra.js';

let dirs: TestDirs;
let svc: MailService;

beforeAll(async () => {
  await resetMailServer();
  dirs = makeTestDirs();
  svc = createTestService(dirs);
});

afterAll(async () => {
  await svc?.close();
  if (dirs) cleanupDirs(dirs);
});

async function expectMailError(p: Promise<unknown>, code: string, pattern?: RegExp): Promise<MailError> {
  const err = await p.then(
    () => {
      throw new Error('expected a MailError');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailError);
  const me = err as MailError;
  expect(me.code).toBe(code);
  if (pattern) expect(me.message).toMatch(pattern);
  return me;
}

describe('mailboxes', () => {
  it('lists every mailbox with counts in display order', async () => {
    const list = await svc.listMailboxes();
    const manifest = loadManifest();
    expect(list.map((m) => m.path)).toEqual(['INBOX', 'Drafts', 'Sent Messages', 'Archive', 'Junk', 'Deleted Messages', 'Projects', 'Projects/Acme', 'Receipts']);
    for (const m of list) {
      const expected = manifest.mailboxes[m.path];
      expect(expected, m.path).toBeDefined();
      expect(m.total).toBe(expected?.count);
      expect(m.unread).toBe(expected?.unseen);
      expect(m.selectable).toBe(true);
    }
    const specials = Object.fromEntries(list.filter((m) => m.special_use).map((m) => [m.special_use, m.path]));
    expect(specials).toEqual({ inbox: 'INBOX', drafts: 'Drafts', sent: 'Sent Messages', archive: 'Archive', junk: 'Junk', trash: 'Deleted Messages' });
  });

  it('can omit counts', async () => {
    const list = await svc.listMailboxes({ includeCounts: false });
    expect(list.every((m) => m.total === null && m.unread === null)).toBe(true);
  });

  it('resolves aliases, case-insensitive and NFD names to exact paths', async () => {
    expect((await svc.resolveMailbox('inbox')).path).toBe('INBOX');
    expect((await svc.resolveMailbox('sent')).path).toBe('Sent Messages');
    expect((await svc.resolveMailbox('Sent Items')).path).toBe('Sent Messages');
    expect((await svc.resolveMailbox('trash')).path).toBe('Deleted Messages');
    expect((await svc.resolveMailbox('bin')).path).toBe('Deleted Messages');
    expect((await svc.resolveMailbox('spam')).path).toBe('Junk');
    expect((await svc.resolveMailbox('projects/acme')).path).toBe('Projects/Acme');
    expect((await svc.resolveMailbox('ACME')).path).toBe('Projects/Acme');
    expect((await svc.resolveMailbox('receipts'.normalize('NFD'))).path).toBe('Receipts');
  });

  it('lists available mailboxes when a name does not resolve', async () => {
    await expectMailError(svc.resolveMailbox('No Such Folder'), 'NOT_FOUND', /Available mailboxes: INBOX, Drafts, Sent Messages/);
  });
});

describe('search', () => {
  it('no-criteria fast path returns the newest messages first with snippets', async () => {
    const r = await svc.search({ mailbox: 'INBOX', limit: 5 });
    expect(r.total).toBe(29);
    expect(r.offset).toBe(0);
    expect(r.returned).toBe(5);
    expect(r.has_more).toBe(true);
    expect(r.messages.map((m) => m.uid)).toEqual([29, 28, 27, 26, 25]);
    const latest = r.messages[0];
    expect(latest?.mailbox).toBe('INBOX');
    expect(latest?.subject).toBe('Weekend plans?');
    expect(latest?.from).toBe('Alice Nguyen <alice@example.com>');
    expect(latest?.date).toBe('2026-09-27T17:30:00-07:00');
    expect(latest?.snippet && latest.snippet.length).toBeGreaterThan(5);
    expect(r.messages.find((m) => m.uid === 28)?.subject).toBe('(no subject)');
    // HTML-only newsletter: snippet comes from stripped HTML, not markup.
    const digest = r.messages.find((m) => m.uid === 27);
    expect(digest?.snippet).not.toMatch(/<|>|\{|font-family/);
  });

  it('pages through the fast path', async () => {
    const r = await svc.search({ mailbox: 'INBOX', limit: 20, offset: 20, includeSnippets: false });
    expect(r.total).toBe(29);
    expect(r.returned).toBe(9);
    expect(r.has_more).toBe(false);
    expect(r.messages.map((m) => m.uid)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(r.messages.every((m) => m.snippet === undefined)).toBe(true);
  });

  it('filters by sender, subject, text and size', async () => {
    expect((await svc.search({ from: 'alice@example.com' })).messages.map((m) => m.uid)).toEqual([29, 3]);
    expect((await svc.search({ subject: 'kickoff' })).messages.map((m) => m.uid)).toEqual([23, 22]);
    expect((await svc.search({ query: 'sensor-dataset' })).messages.map((m) => m.uid)).toContain(24);
    expect((await svc.search({ minSizeKb: 1000 })).messages.map((m) => m.uid)).toEqual([24]);
    const body = await svc.search({ body: 'IGNORE PREVIOUS INSTRUCTIONS' });
    // 25 is plain text; 26 hides the same kind of text in its HTML part.
    expect(body.messages.map((m) => m.uid)).toEqual([26, 25]);
  });

  it('matches To or Cc for `to`', async () => {
    const offsite = fixture('team-offsite');
    const r = await svc.search({ to: 'icloud.test', limit: 100 });
    expect(r.messages.map((m) => m.uid)).toContain(offsite.uid);
  });

  it('filters by flags and Apple Mail colours', async () => {
    const unread = await svc.search({ unread: true, limit: 100 });
    expect(unread.total).toBe(15);
    const flagged = await svc.search({ flagged: true, limit: 100 });
    expect(flagged.messages.map((m) => m.uid)).toEqual([19, 18, 17, 16, 5]);
    expect((await svc.search({ flagColor: 'red' })).messages.map((m) => m.uid)).toEqual([5]);
    expect((await svc.search({ flagColor: 'orange' })).messages.map((m) => m.uid)).toEqual([16]);
    expect((await svc.search({ flagColor: 'yellow' })).messages.map((m) => m.uid)).toEqual([17]);
    expect((await svc.search({ flagColor: 'green' })).messages.map((m) => m.uid)).toEqual([18]);
    expect((await svc.search({ flagColor: 'blue' })).messages.map((m) => m.uid)).toEqual([19]);
    expect((await svc.search({ flagColor: 'purple' })).total).toBe(0);
    expect((await svc.search({ mailbox: 'Archive', flagColor: 'purple' })).messages.map((m) => m.uid)).toEqual([3]);
    const answered = await svc.search({ answered: true });
    expect(answered.messages.map((m) => m.uid)).toEqual([22, 3]);
    const summary = flagged.messages.find((m) => m.uid === 18);
    expect(summary).toMatchObject({ flagged: true, flag_color: 'green', unread: true });
  });

  it('filters by date (since inclusive, before exclusive)', async () => {
    const r = await svc.search({ since: '2026-09-01', before: '2026-09-20', limit: 100 });
    expect(r.messages.map((m) => m.uid)).toEqual([27, 26, 25]);
    const iso = await svc.search({ since: '2026-09-20T23:59:00-07:00', limit: 100 });
    expect(iso.messages.map((m) => m.uid)).toEqual([29, 28]);
    const recent = await svc.search({ newerThanDays: 100000, limit: 1 });
    expect(recent.total).toBe(29);
    await expectMailError(svc.search({ since: 'yesterday' }), 'INVALID_INPUT');
  });

  it('pages criteria results', async () => {
    const a = await svc.search({ unread: true, limit: 10, offset: 0, includeSnippets: false });
    const b = await svc.search({ unread: true, limit: 10, offset: 10, includeSnippets: false });
    expect(a.returned).toBe(10);
    expect(a.has_more).toBe(true);
    expect(b.returned).toBe(5);
    expect(b.has_more).toBe(false);
    const all = [...a.messages, ...b.messages].map((m) => m.uid);
    expect(all).toEqual([...all].sort((x, y) => y - x));
    expect(new Set(all).size).toBe(15);
  });

  it('all_mailboxes merges by date and skips Trash and Junk', async () => {
    const r = await svc.search({ allMailboxes: true, subject: 'kickoff' });
    expect(r.total).toBe(4);
    expect(r.messages.map((m) => `${m.mailbox}:${m.uid}`)).toEqual(['Drafts:1', 'INBOX:23', 'Sent Messages:2', 'INBOX:22']);
    expect(r.messages.every((m) => typeof m.snippet === 'string')).toBe(true);
    expect(r.mailboxes_searched).not.toContain('Junk');
    expect(r.mailboxes_searched).not.toContain('Deleted Messages');
    const junkOnly = await svc.search({ allMailboxes: true, subject: 'gift card' });
    expect(junkOnly.total).toBe(0);
    const junk = await svc.search({ mailbox: 'junk', subject: 'gift card' });
    expect(junk.total).toBe(1);
  });

  it('all_mailboxes pages across folders', async () => {
    const first = await svc.search({ allMailboxes: true, limit: 3, includeSnippets: false });
    const second = await svc.search({ allMailboxes: true, limit: 3, offset: 3, includeSnippets: false });
    // 43 total minus Junk (2) and Deleted Messages (1)
    expect(first.total).toBe(40);
    expect(first.returned).toBe(3);
    expect(second.returned).toBe(3);
    const keys = [...first.messages, ...second.messages].map((m) => `${m.mailbox}:${m.uid}`);
    expect(new Set(keys).size).toBe(6);
    const dates = [...first.messages, ...second.messages].map((m) => m.date ?? '');
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('renders search results with the untrusted reminder', async () => {
    const r = await svc.search({ limit: 1 });
    const text = renderListResult(r);
    expect(text.startsWith(UNTRUSTED_LIST_NOTE)).toBe(true);
    expect(JSON.parse(text.slice(UNTRUSTED_LIST_NOTE.length + 1))).toMatchObject({ total: 29 });
  });
});

describe('get_message', () => {
  it('renders a plain text message', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 2 });
    expect(view.message.bodyFormat).toBe('text/plain');
    expect(view.message.subject).toBe('Welcome to your test mailbox');
    expect(view.message.attachments).toEqual([]);
    expect(view.bodyTruncated).toBe(false);
    const text = renderMessageView(view);
    expect(text).toContain('Subject: Welcome to your test mailbox');
    expect(text).toContain(UNTRUSTED_BEGIN);
    expect(text).toContain(UNTRUSTED_END);
  });

  it('converts an HTML-only body to text without images or markup', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 4, includeHtml: true });
    expect(view.message.bodyFormat).toBe('text/html');
    expect(view.body).not.toMatch(/<\/?(p|div|table|td|a|span|img|br|html|body)\b/i);
    expect(view.body).toContain('Shop now <https://shop.example/feb?utm_source=email>');
    expect(view.body.length).toBeGreaterThan(20);
    expect(view.html).toMatch(/<html|<p|<table|<div/i);
    expect(view.message.listUnsubscribe).toBeTruthy();
    const text = renderMessageView(view);
    expect(text.split(UNTRUSTED_BEGIN).length - 1).toBe(2); // body + raw HTML both wrapped
  });

  it('prefers text/plain in multipart/alternative', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 5 });
    expect(view.message.bodyFormat).toBe('text/plain');
    expect(view.message.flags).toMatchObject({ flagged: true, flag_color: 'red' });
  });

  it('lists attachments with part numbers and never downloads their bytes', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 6 });
    expect(view.message.attachments).toEqual([
      { part: '2', filename: 'Invoice-10423.pdf', content_type: 'application/pdf', size: expect.any(Number) as number, encoding: 'base64', inline: false, content_id: null },
    ]);
    expect(renderMessageView(view)).toContain('- part 2: "Invoice-10423.pdf" (application/pdf');
  });

  it('marks inline images with their Content-ID', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 8 });
    expect(view.message.attachments).toEqual([
      { part: '2', filename: 'summit.png', content_type: 'image/png', size: expect.any(Number) as number, encoding: 'base64', inline: true, content_id: '<summit-photo@example.com>' },
    ]);
    expect(view.message.bodyFormat).toBe('text/plain');
  });

  it('decodes encoded subjects, names and charsets', async () => {
    const q = await svc.getMessage({ mailbox: 'INBOX', uid: 9 });
    expect(q.message.subject).toBe('Café meeting — résumé review');
    expect(q.message.addresses.from[0]?.name).toBe('José Álvarez');
    const emoji = await svc.getMessage({ mailbox: 'INBOX', uid: 10 });
    expect(emoji.message.subject).toBe('🎉 Party this Saturday! 🥳');
    const latin1 = await svc.getMessage({ mailbox: 'INBOX', uid: 11 });
    expect(latin1.message.subject).toBe('Grüße aus München');
    expect(latin1.body).toMatch(/[äöüß]/);
    expect(latin1.body).not.toContain('�');
    const jp = await svc.getMessage({ mailbox: 'INBOX', uid: 12 });
    expect(jp.message.subject).toBe('来週の会議について');
    expect(jp.body).toMatch(/[぀-ヿ一-鿿]/);
  });

  it('handles RFC 2231 filenames and attached messages', async () => {
    const resume = await svc.getMessage({ mailbox: 'INBOX', uid: 20 });
    expect(resume.message.attachments[0]?.filename).toBe('Résumé Ivan.pdf');
    const fwd = await svc.getMessage({ mailbox: 'INBOX', uid: 21 });
    expect(fwd.message.attachments).toEqual([expect.objectContaining({ part: '2', content_type: 'message/rfc822' })]);
    expect(fwd.message.bodyFormat).toBe('text/plain');
  });

  it('reads the 2 MB message without downloading the attachment', async () => {
    const started = Date.now();
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 24 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(view.message.size).toBeGreaterThan(2_000_000);
    expect(view.body.length).toBeLessThan(1000);
    expect(view.message.attachments[0]).toMatchObject({ filename: 'sensor-dataset.bin', content_type: 'application/octet-stream' });
  });

  it('wraps prompt-injection content as untrusted data', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 25 });
    const text = renderMessageView(view);
    const begin = text.indexOf(UNTRUSTED_BEGIN);
    const end = text.lastIndexOf(UNTRUSTED_END);
    const injection = text.indexOf('IGNORE PREVIOUS INSTRUCTIONS');
    expect(begin).toBeGreaterThan(0);
    expect(injection).toBeGreaterThan(begin);
    expect(injection).toBeLessThan(end);
    expect(text.split(UNTRUSTED_END).length - 1).toBe(1);
    const hidden = await svc.getMessage({ mailbox: 'INBOX', uid: 26 });
    expect(hidden.message.bodyFormat).toBe('text/plain');
  });

  it('truncates long bodies and reports the total', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 27, maxChars: 500 });
    expect(view.message.bodyFormat).toBe('text/html');
    expect(view.bodyTruncated).toBe(true);
    expect(view.body.length).toBe(500);
    expect(view.bodyTotalChars).toBeGreaterThan(500);
    expect(view.message.bodyText).not.toMatch(/<script|function\s*\(|tracking-pixel\.gif/i);
    expect(renderMessageView(view)).toContain(`showing 500 of ${view.bodyTotalChars}`);
  });

  it('handles a message without Subject', async () => {
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 28 });
    expect(view.message.subject).toBe('');
    expect(renderMessageView(view)).toContain('Subject: (no subject)');
  });

  it('reports a missing UID clearly', async () => {
    await expectMailError(svc.getMessage({ mailbox: 'INBOX', uid: 999 }), 'NOT_FOUND', /No message with UID 999/);
  });

  it('does not change \\Seen when reading (BODY.PEEK)', async () => {
    const before = await svc.search({ unread: true, limit: 100 });
    await svc.getMessage({ mailbox: 'INBOX', uid: 29 });
    const after = await svc.search({ unread: true, limit: 100 });
    expect(after.total).toBe(before.total);
  });
});

describe('get_thread', () => {
  it('finds the 3-message thread across INBOX and Sent from the last message', async () => {
    const t = await svc.getThread({ mailbox: 'INBOX', uid: 23 });
    expect(t.messages.map((m) => `${m.mailbox}:${m.uid}`)).toEqual(['INBOX:22', 'Sent Messages:2', 'INBOX:23']);
    expect(t.messages.every((m) => typeof m.snippet === 'string')).toBe(true);
  });

  it('finds the whole thread from the first message (expansion pass)', async () => {
    const t = await svc.getThread({ mailbox: 'INBOX', uid: 22 });
    expect(t.messages.map((m) => `${m.mailbox}:${m.uid}`)).toEqual(['INBOX:22', 'Sent Messages:2', 'INBOX:23']);
  });

  it('returns just the seed for an unrelated message', async () => {
    const t = await svc.getThread({ mailbox: 'INBOX', uid: 2 });
    expect(t.messages.map((m) => m.uid)).toEqual([2]);
  });
});

/** The local version always saves the file, so `path` is set. */
type LocalDownload = Awaited<ReturnType<MailService['downloadAttachment']>> & { path: string };

describe('download_attachment', () => {
  it('saves under the sanitised filename and never overwrites', async () => {
    const a = (await svc.downloadAttachment({ mailbox: 'INBOX', uid: 6, part: '2' })) as LocalDownload;
    expect(path.basename(a.path)).toBe('Invoice-10423.pdf');
    expect(a.content_type).toBe('application/pdf');
    expect(readFileSync(a.path).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(a.content).toBeUndefined();
    expect(a.note).toMatch(/Saved to/);
    const b = (await svc.downloadAttachment({ mailbox: 'INBOX', uid: 6, part: '2' })) as LocalDownload;
    expect(path.basename(b.path)).toBe('Invoice-10423 (1).pdf');
    expect(existsSync(a.path)).toBe(true);
    expect(b.size).toBe(a.size);
  });

  it('returns small text attachments as text and images as image content', async () => {
    const t = await svc.downloadAttachment({ mailbox: 'INBOX', uid: 7, part: '2' });
    expect(t.filename).toBe('notes.txt');
    expect(t.content?.kind).toBe('text');
    const img = await svc.downloadAttachment({ mailbox: 'INBOX', uid: 8, part: '2' });
    expect(img.content).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    if (img.content?.kind === 'image') expect(Buffer.from(img.content.data, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('uses a fallback name for attachments without a filename and keeps non-ASCII names', async () => {
    const rfc822 = (await svc.downloadAttachment({ mailbox: 'INBOX', uid: 21, part: '2', returnContent: false })) as LocalDownload;
    expect(rfc822.filename).toBe('attachment-21-2.eml');
    expect(readFileSync(rfc822.path, 'utf8')).toMatch(/Subject:/i);
    const resume = await svc.downloadAttachment({ mailbox: 'INBOX', uid: 20, part: '2', returnContent: false });
    expect(resume.filename).toBe('Résumé Ivan.pdf');
  });

  it('validates the part and enforces the size limit', async () => {
    await expectMailError(svc.downloadAttachment({ mailbox: 'INBOX', uid: 6, part: '9' }), 'NOT_FOUND', /Attachment parts: 2/);
    await expectMailError(svc.downloadAttachment({ mailbox: 'INBOX', uid: 8, part: '1' }), 'INVALID_INPUT', /multipart container/);
    await expectMailError(svc.downloadAttachment({ mailbox: 'INBOX', uid: 6, part: '../2' }), 'INVALID_INPUT');
    const small = createTestService(dirs, { MAIL_MAX_ATTACHMENT_MB: '1' });
    try {
      await expectMailError(small.downloadAttachment({ mailbox: 'INBOX', uid: 24, part: '2' }), 'TOO_LARGE', /MAIL_MAX_ATTACHMENT_MB/);
    } finally {
      await small.close();
    }
  });

  it('downloads the 1.48 MB attachment completely', async () => {
    const big = await svc.downloadAttachment({ mailbox: 'INBOX', uid: 24, part: '2' });
    expect(big.size).toBeGreaterThan(1_400_000);
    expect(big.content).toBeUndefined();
  });
});

describe('account info', () => {
  it('reports capabilities, special folders, quota and effective login without the password', async () => {
    const info = await svc.getAccountInfo();
    expect(info['status']).toBe('connected');
    expect(info['email']).toBe('testuser@icloud.test');
    expect(info['capabilities']).toMatchObject({ MOVE: true, UIDPLUS: true, 'SPECIAL-USE': true, IDLE: true, QUOTA: true });
    expect(info['special_folders']).toMatchObject({ inbox: 'INBOX', sent: 'Sent Messages', trash: 'Deleted Messages', drafts: 'Drafts', junk: 'Junk', archive: 'Archive' });
    expect(info['quota']).toMatchObject({ limit: expect.stringMatching(/GB/) as string });
    expect((info['imap'] as { login: string }).login).toBe('testuser@icloud.test');
    expect(JSON.stringify(info)).not.toContain('app-specific-pass');
  });
});

describe('stdout cleanliness', () => {
  it('never writes to stdout, even when the IMAP connection fails (debug logging on)', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const refused = createTestService(dirs, { IMAP_PORT: '1', MAIL_LOG_LEVEL: 'debug' });
    const debug = createTestService(dirs, { MAIL_LOG_LEVEL: 'debug' });
    try {
      await expectMailError(refused.listMailboxes(), 'CONNECTION', /Could not talk to the IMAP server 127\.0\.0\.1:1/);
      await debug.search({ limit: 3 });
      await debug.getMessage({ mailbox: 'INBOX', uid: 25 });
    } finally {
      spy.mockRestore();
      await refused.close();
      await debug.close();
    }
    expect(writes).toEqual([]);
  });
});
