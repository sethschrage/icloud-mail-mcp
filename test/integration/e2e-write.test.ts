/**
 * End-to-end write tools over stdio against the main test-infra instance: mark_messages,
 * get_message mark_as_read, mailbox management, save_draft, and the audit log they produce.
 * (Moves, archive, trash, permanent delete and draft replacement on every server profile are in
 * e2e-folders.test.ts.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eEnv } from '../helpers/e2e.js';
import { PASSWORD, cleanupDirs, makeTestDirs, rawFlags, rawSource, rawStatus, resetMailServer, type TestDirs } from '../helpers/infra.js';
import { auditEntries, json, startMcp, type McpSession } from '../helpers/mcp.js';

interface Marked {
  mailbox: string;
  affected: number;
  not_found: number[];
  messages: Array<{ uid: number; unread: boolean; flagged: boolean; flag_color: string | null }>;
  not_applied: unknown[];
  note?: string;
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

describe('mark_messages', () => {
  it('marks read and unread, reporting UIDs that were not found', async () => {
    const r = json<Marked>(await s.call('mark_messages', { mailbox: 'INBOX', uids: [29, 999], read: true }));
    expect(r).toMatchObject({ mailbox: 'INBOX', affected: 1, not_found: [999], messages: [{ uid: 29, unread: false, flagged: false, flag_color: null }], not_applied: [] });
    expect(r.note).toMatch(/UID 999 was not found in "INBOX"/);
    expect(await rawFlags('INBOX', 29)).toContain('\\Seen');
    const back = json<Marked>(await s.call('mark_messages', { mailbox: 'INBOX', uids: [29], read: false }));
    expect(back.messages[0]?.unread).toBe(true);
    expect(back.note).toBeUndefined();
    expect(await rawFlags('INBOX', 29)).not.toContain('\\Seen');
  });

  it('sets Apple Mail flag colours with the right bits, and unflagging clears them', async () => {
    const purple = json<Marked>(await s.call('mark_messages', { mailbox: 'INBOX', uids: [2], flag_color: 'purple' }));
    expect(purple.messages[0]).toMatchObject({ flagged: true, flag_color: 'purple' });
    expect(((await rawFlags('INBOX', 2)) ?? []).filter((f) => f.startsWith('$MailFlagBit') || f === '\\Flagged').sort()).toEqual(['$MailFlagBit0', '$MailFlagBit2', '\\Flagged']);
    const gray = json<Marked>(await s.call('mark_messages', { mailbox: 'INBOX', uids: [2], flag_color: 'gray' }));
    expect(gray.messages[0]?.flag_color).toBe('gray');
    expect(((await rawFlags('INBOX', 2)) ?? []).filter((f) => f.startsWith('$MailFlagBit')).sort()).toEqual(['$MailFlagBit1', '$MailFlagBit2']);
    const off = json<Marked>(await s.call('mark_messages', { mailbox: 'INBOX', uids: [2], flagged: false }));
    expect(off.messages[0]).toMatchObject({ flagged: false, flag_color: null });
    expect(((await rawFlags('INBOX', 2)) ?? []).some((f) => f === '\\Flagged' || f.startsWith('$MailFlagBit'))).toBe(false);
  });

  it('rejects an empty or contradictory request', async () => {
    const none = await s.call('mark_messages', { mailbox: 'INBOX', uids: [2] });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/at least one of read, flagged or flag_color/);
    const clash = await s.call('mark_messages', { mailbox: 'INBOX', uids: [2], flagged: false, flag_color: 'red' });
    expect(clash.isError).toBe(true);
    expect(clash.text).toMatch(/implies flagged/);
    const color = await s.call('mark_messages', { mailbox: 'INBOX', uids: [2], flag_color: 'pink' });
    expect(color.isError).toBe(true);
    expect(color.text).toMatch(/Input validation error/i);
  });

  it('get_message mark_as_read sets \\Seen and says so', async () => {
    expect(await rawFlags('INBOX', 23)).not.toContain('\\Seen');
    const r = await s.call('get_message', { mailbox: 'INBOX', uid: 23, mark_as_read: true });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Note: The message was marked as read\./);
    expect(r.text).toMatch(/Flags: read/);
    expect(await rawFlags('INBOX', 23)).toContain('\\Seen');
  });
});

describe('mailbox management', () => {
  it('creates nested folders, refuses duplicates, renames and deletes empty folders', async () => {
    const created = await s.call('create_mailbox', { path: 'E2E Folder/Sub' });
    expect(created.isError).toBe(false);
    expect(json(created)).toEqual({ path: 'E2E Folder/Sub', created: true });
    const dup = await s.call('create_mailbox', { path: 'e2e folder/sub' });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/already exists/);
    const bad = await s.call('create_mailbox', { path: 'Bad//Name' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/empty folder name/);

    const renamed = await s.call('rename_mailbox', { path: 'E2E Folder/Sub', new_path: 'E2E Folder/Renamed' });
    expect(json(renamed)).toMatchObject({ new_path: 'E2E Folder/Renamed' });
    const listed = json<{ mailboxes: Array<{ path: string }> }>(await s.call('list_mailboxes', { include_counts: false })).mailboxes.map((m) => m.path);
    expect(listed).toEqual(expect.arrayContaining(['E2E Folder', 'E2E Folder/Renamed']));

    const parent = await s.call('delete_mailbox', { path: 'E2E Folder' });
    expect(parent.isError).toBe(true);
    expect(parent.text).toMatch(/still contains folders/);
    expect(json(await s.call('delete_mailbox', { path: 'E2E Folder/Renamed' }))).toEqual({ path: 'E2E Folder/Renamed', deleted: true });
    expect(json(await s.call('delete_mailbox', { path: 'E2E Folder' }))).toEqual({ path: 'E2E Folder', deleted: true });
    const gone = await s.call('delete_mailbox', { path: 'E2E Folder' });
    expect(gone.isError).toBe(true);
    expect(gone.text).toMatch(/Available mailboxes/);
  });

  it('protects INBOX, the special folders and non-empty folders', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['rename_mailbox', { path: 'INBOX', new_path: 'Old Inbox' }, /INBOX cannot be renamed/],
      ['rename_mailbox', { path: 'sent', new_path: 'Sent Old' }, /sent folder and cannot be renamed/],
      ['rename_mailbox', { path: 'Receipts', new_path: 'Archive' }, /already exists/],
      ['delete_mailbox', { path: 'INBOX' }, /INBOX cannot be deleted/],
      ['delete_mailbox', { path: 'Drafts' }, /drafts folder and cannot be deleted/],
      ['delete_mailbox', { path: 'Receipts' }, /still contains 1 message/],
      ['delete_mailbox', { path: 'Projects' }, /Projects\/Acme/],
    ];
    for (const [tool, args, pattern] of cases) {
      const r = await s.call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text).toMatch(pattern);
    }
    expect((await rawStatus('Receipts')).messages).toBe(1);
  });
});

describe('save_draft', () => {
  it('saves a new draft with \\Draft and \\Seen, keeping Bcc and attachments', async () => {
    const file = path.join(dirs.attachFrom, 'agenda.txt');
    writeFileSync(file, 'agenda for the meeting');
    const r = await s.call('save_draft', {
      to: ['Friend <friend@example.com>'],
      bcc: ['hidden@example.net'],
      subject: 'E2E draft',
      body: 'Draft body from e2e\nsecond line',
      attachments: [file],
    });
    expect(r.isError).toBe(false);
    const d = json<{ saved: boolean; mailbox: string; uid: number; message_id: string; note: string }>(r);
    expect(d).toMatchObject({ saved: true, mailbox: 'Drafts', uid: 3 });
    expect(d.note).toMatch(/Apple Mail's Drafts/);
    expect(await rawFlags('Drafts', d.uid)).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    const src = (await rawSource('Drafts', d.uid))?.toString('utf8') ?? '';
    expect(src).toMatch(/^Bcc: hidden@example\.net\r$/m);
    expect(src).toMatch(/^Subject: E2E draft\r$/m);
    expect(src).toMatch(/filename=agenda\.txt/);
  });

  it('saves reply and forward drafts without marking the originals', async () => {
    const reply = json<{ uid: number }>(await s.call('save_draft', { body: 'Sounds good.', reply_to: { mailbox: 'INBOX', uid: 22 } }));
    const replySrc = (await rawSource('Drafts', reply.uid))?.toString('utf8') ?? '';
    expect(replySrc).toMatch(/^Subject: Re: Project kickoff\r$/m);
    expect(replySrc).toMatch(/^In-Reply-To: <kickoff-1@example\.com>\r$/m);
    expect(replySrc).toMatch(/^To: Dave Wilson <dave@example\.com>\r$/m);
    const forward = json<{ uid: number }>(await s.call('save_draft', { to: ['colleague@example.com'], body: 'FYI', forward_of: { mailbox: 'INBOX', uid: 6 } }));
    const fwdSrc = (await rawSource('Drafts', forward.uid))?.toString('utf8') ?? '';
    expect(fwdSrc).toMatch(/^Subject: Fwd: Invoice #10423 for March\r$/m);
    expect(fwdSrc).toContain('---------- Forwarded message ----------');
    expect(fwdSrc).toMatch(/filename=Invoice-10423\.pdf/);
    expect(await rawFlags('INBOX', 22)).toEqual(['\\Answered', '\\Seen']); // unchanged fixture flags
    expect(await rawFlags('INBOX', 6)).not.toContain('$Forwarded');
  });

  it('refuses invalid drafts clearly', async () => {
    const both = await s.call('save_draft', { body: 'x', reply_to: { mailbox: 'INBOX', uid: 22 }, forward_of: { mailbox: 'INBOX', uid: 6 } });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/either reply_to or forward_of/);
    const from = await s.call('save_draft', { body: 'x', from: 'someone@evil.test' });
    expect(from.isError).toBe(true);
    expect(from.text).toMatch(/Allowed From addresses: testuser@icloud\.test/);
    const outside = await s.call('save_draft', { body: 'x', attachments: ['/etc/hostname'] });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/MAIL_ATTACH_FROM_DIRS/);
    const missing = await s.call('save_draft', { body: 'x', replace_draft_uid: 999 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/replace_draft_uid 999 was not found/);
    const notDraft = await s.call('save_draft', { body: 'x', reply_to: { mailbox: 'INBOX', uid: 4242 } });
    expect(notDraft.isError).toBe(true);
    expect(notDraft.text).toMatch(/No message with UID 4242/);
  });
});

describe('audit log', () => {
  it('records every write, including refused ones, without bodies or secrets', () => {
    const entries = auditEntries(dirs.auditLog);
    const ok = new Set(entries.filter((e) => e['result'] === 'ok').map((e) => e['tool']));
    for (const t of ['mark_messages', 'get_message', 'create_mailbox', 'rename_mailbox', 'delete_mailbox', 'save_draft']) expect(ok.has(t), t).toBe(true);
    // Refusals that happened before any mailbox change are recorded by the tool layer.
    const refused = entries.filter((e) => e['result'] === 'error');
    expect(refused.some((e) => e['tool'] === 'save_draft' && e['error_code'] === 'FORBIDDEN' && e['from'] === 'someone@evil.test')).toBe(true);
    expect(refused.some((e) => e['tool'] === 'mark_messages' && e['error_code'] === 'INVALID_INPUT' && /at least one of/.test(String(e['error'])))).toBe(true);
    expect(refused.some((e) => e['tool'] === 'delete_mailbox' && /INBOX cannot be deleted/.test(String(e['error'])))).toBe(true);
    // Each failure is recorded once (domain-audited failures are not duplicated by the tool layer).
    const inboxDelete = refused.filter((e) => e['tool'] === 'delete_mailbox' && /INBOX cannot be deleted/.test(String(e['error'])));
    expect(inboxDelete).toHaveLength(1);
    const raw = readFileSync(dirs.auditLog, 'utf8');
    expect(raw).not.toContain('Draft body from e2e');
    expect(raw).not.toContain('agenda for the meeting');
    expect(raw).not.toContain('Sounds good.');
    expect(raw).not.toContain(PASSWORD);
    expect(entries.every((e) => typeof e['ts'] === 'string')).toBe(true);
  });
});
