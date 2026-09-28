/**
 * Domain-layer mailbox changes against the main test-infra instance: flags and colours, move /
 * archive / trash with new UIDs, permanent delete, mailbox rules, drafts, audit log.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { MailService } from '../../src/service.js';
import {
  cleanupDirs,
  createTestService,
  makeTestDirs,
  rawFlags,
  rawSource,
  rawStatus,
  rawUidsByMessageId,
  resetMailServer,
  withRawImap,
  type TestDirs,
} from '../helpers/infra.js';

let dirs: TestDirs;
let svc: MailService;

beforeAll(async () => {
  await resetMailServer();
  dirs = makeTestDirs();
  svc = createTestService(dirs, { MAIL_ALLOW_PERMANENT_DELETE: 'true' });
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

function auditEntries(): Array<Record<string, unknown>> {
  return readFileSync(dirs.auditLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('mark_messages', () => {
  it('marks read/unread and reports not_found UIDs', async () => {
    const r = await svc.markMessages({ mailbox: 'INBOX', uids: [29, 999], read: true });
    expect(r.affected).toBe(1);
    expect(r.not_found).toEqual([999]);
    expect(r.messages).toEqual([{ uid: 29, unread: false, flagged: false, flag_color: null }]);
    expect(await rawFlags('INBOX', 29)).toContain('\\Seen');
    const back = await svc.markMessages({ mailbox: 'INBOX', uids: [29], read: false });
    expect(back.messages?.[0]?.unread).toBe(true);
    expect(await rawFlags('INBOX', 29)).not.toContain('\\Seen');
  });

  it('sets each colour with exactly the right bits and reads it back', async () => {
    const expectedBits: Record<string, string[]> = {
      red: [],
      orange: ['$MailFlagBit0'],
      yellow: ['$MailFlagBit1'],
      green: ['$MailFlagBit0', '$MailFlagBit1'],
      blue: ['$MailFlagBit2'],
      purple: ['$MailFlagBit0', '$MailFlagBit2'],
      gray: ['$MailFlagBit1', '$MailFlagBit2'],
    };
    for (const [color, bits] of Object.entries(expectedBits)) {
      const r = await svc.markMessages({ mailbox: 'INBOX', uids: [2], flagColor: color as 'red' });
      expect(r.not_applied).toEqual([]);
      expect(r.messages?.[0]).toMatchObject({ uid: 2, flagged: true, flag_color: color });
      const flags = (await rawFlags('INBOX', 2)) ?? [];
      expect(flags).toContain('\\Flagged');
      expect(flags.filter((f) => f.startsWith('$MailFlagBit')).sort()).toEqual(bits);
    }
  });

  it('flagged:false removes \\Flagged and every colour bit', async () => {
    await svc.markMessages({ mailbox: 'INBOX', uids: [2], flagColor: 'gray' });
    const r = await svc.markMessages({ mailbox: 'INBOX', uids: [2], flagged: false });
    expect(r.messages?.[0]).toMatchObject({ flagged: false, flag_color: null });
    const flags = (await rawFlags('INBOX', 2)) ?? [];
    expect(flags.some((f) => f === '\\Flagged' || f.startsWith('$MailFlagBit'))).toBe(false);
  });

  it('rejects empty or conflicting requests', async () => {
    await expectMailError(svc.markMessages({ mailbox: 'INBOX', uids: [2] }), 'INVALID_INPUT');
    await expectMailError(svc.markMessages({ mailbox: 'INBOX', uids: [2], flagged: false, flagColor: 'red' }), 'INVALID_INPUT');
    await expectMailError(svc.markMessages({ mailbox: 'INBOX', uids: [], read: true }), 'INVALID_INPUT');
    await expectMailError(svc.markMessages({ mailbox: 'INBOX', uids: [0], read: true }), 'INVALID_INPUT');
    await expectMailError(svc.markMessages({ mailbox: 'INBOX', uids: Array.from({ length: 501 }, (_, i) => i + 1), read: true }), 'INVALID_INPUT', /500/);
  });

  it('get_message mark_as_read sets \\Seen', async () => {
    expect(await rawFlags('INBOX', 29)).not.toContain('\\Seen');
    const view = await svc.getMessage({ mailbox: 'INBOX', uid: 29, markAsRead: true });
    expect(view.message.flags.unread).toBe(false);
    expect(await rawFlags('INBOX', 29)).toContain('\\Seen');
  });
});

describe('move / archive / trash', () => {
  it('moves messages and returns their new UIDs', async () => {
    const before = await rawStatus('Receipts');
    const r = await svc.moveMessages({ mailbox: 'INBOX', uids: [1, 12345], destination: 'receipts' });
    expect(r).toMatchObject({ source: 'INBOX', destination: 'Receipts', moved: 1, not_found: [12345] });
    expect(r.new_uids).toEqual({ '1': 2 });
    expect((await rawStatus('Receipts')).messages).toBe(before.messages + 1);
    expect(await rawFlags('INBOX', 1)).toBeNull();
    expect(await rawFlags('Receipts', 2)).toContain('\\Seen');
    // The mailbox cache was invalidated: counts are fresh.
    const list = await svc.listMailboxes();
    expect(list.find((m) => m.path === 'Receipts')?.total).toBe(before.messages + 1);
  });

  it('refuses a destination that does not exist or equals the source', async () => {
    await expectMailError(svc.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'Nope' }), 'NOT_FOUND', /create_mailbox/);
    await expectMailError(svc.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'inbox' }), 'INVALID_INPUT', /same mailbox/);
  });

  it('archives into the Archive folder', async () => {
    const r = await svc.archiveMessages({ mailbox: 'INBOX', uids: [14] });
    expect(r.destination).toBe('Archive');
    expect(r.moved).toBe(1);
    expect(r.new_uids).toEqual({ '14': 4 });
    await expectMailError(svc.archiveMessages({ mailbox: 'Archive', uids: [4] }), 'INVALID_INPUT', /already in the archive/);
  });

  it('trashes into Deleted Messages and explains when already in Trash', async () => {
    const r = await svc.trashMessages({ mailbox: 'INBOX', uids: [17] });
    expect(r.destination).toBe('Deleted Messages');
    expect(r.new_uids).toEqual({ '17': 2 });
    await expectMailError(svc.trashMessages({ mailbox: 'trash', uids: [2] }), 'INVALID_INPUT', /already in Trash.*delete_messages_permanently/);
    const noDelete = createTestService(dirs);
    try {
      await expectMailError(noDelete.trashMessages({ mailbox: 'trash', uids: [2] }), 'INVALID_INPUT', /Permanent deletion is disabled/);
    } finally {
      await noDelete.close();
    }
  });

  it('reports not_found without failing when no UID exists', async () => {
    const r = await svc.trashMessages({ mailbox: 'INBOX', uids: [4242] });
    expect(r).toMatchObject({ moved: 0, not_found: [4242] });
  });

  it('honours an aborted signal before moving', async () => {
    const ac = new AbortController();
    ac.abort();
    await expectMailError(svc.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'Receipts' }, { signal: ac.signal }), 'CANCELLED');
    expect(await rawFlags('INBOX', 2)).not.toBeNull();
  });
});

describe('permanent delete', () => {
  it('deletes only the given UIDs', async () => {
    const before = await rawStatus('Deleted Messages');
    const r = await svc.deleteMessagesPermanently({ mailbox: 'Deleted Messages', uids: [1, 777] });
    expect(r).toMatchObject({ deleted: 1, not_found: [777] });
    expect((await rawStatus('Deleted Messages')).messages).toBe(before.messages - 1);
    expect(await rawFlags('Deleted Messages', 2)).not.toBeNull();
  });

  it('is refused when disabled', async () => {
    const off = createTestService(dirs);
    try {
      await expectMailError(off.deleteMessagesPermanently({ mailbox: 'trash', uids: [2] }), 'FORBIDDEN', /MAIL_ALLOW_PERMANENT_DELETE/);
    } finally {
      await off.close();
    }
  });

  it('asks the confirmation dialog when enabled and respects Cancel', async () => {
    const prompts: string[] = [];
    const confirmSvc = createTestService(
      dirs,
      { MAIL_ALLOW_PERMANENT_DELETE: 'true', MAIL_CONFIRM_DIALOG: 'true' },
      {
        confirm: (req) => {
          prompts.push(req.message);
          return Promise.resolve({ status: 'declined', reason: 'cancelled' });
        },
      },
    );
    try {
      const r = await confirmSvc.deleteMessagesPermanently({ mailbox: 'trash', uids: [2] });
      expect(r).toMatchObject({ deleted: 0, cancelled: true });
      expect(prompts[0]).toMatch(/PERMANENTLY delete 1 message/);
      expect(prompts[0]).toContain('Tax documents ready for review');
      expect(await rawFlags('Deleted Messages', 2)).not.toBeNull();
    } finally {
      await confirmSvc.close();
    }
  });
});

describe('mailbox management', () => {
  it('creates, refuses duplicates, renames and deletes', async () => {
    const created = await svc.createMailbox({ path: 'Test Folder/Sub' });
    expect(created).toEqual({ path: 'Test Folder/Sub', created: true });
    await expectMailError(svc.createMailbox({ path: 'test folder/sub' }), 'CONFLICT', /already exists/);
    await expectMailError(svc.createMailbox({ path: 'Bad//Name' }), 'INVALID_INPUT');
    const renamed = await svc.renameMailbox({ path: 'Test Folder/Sub', newPath: 'Test Folder/Renamed' });
    expect(renamed.new_path).toBe('Test Folder/Renamed');
    expect((await svc.resolveMailbox('Test Folder/Renamed')).path).toBe('Test Folder/Renamed');
    await expectMailError(svc.deleteMailbox({ path: 'Test Folder' }), 'CONFLICT', /still contains folders/);
    expect(await svc.deleteMailbox({ path: 'Test Folder/Renamed' })).toEqual({ path: 'Test Folder/Renamed', deleted: true });
    expect(await svc.deleteMailbox({ path: 'Test Folder' })).toEqual({ path: 'Test Folder', deleted: true });
    await expectMailError(svc.resolveMailbox('Test Folder'), 'NOT_FOUND');
  });

  it('protects INBOX, special folders and non-empty mailboxes', async () => {
    await expectMailError(svc.renameMailbox({ path: 'INBOX', newPath: 'Old Inbox' }), 'FORBIDDEN', /INBOX/);
    await expectMailError(svc.renameMailbox({ path: 'sent', newPath: 'Sent Old' }), 'FORBIDDEN', /sent folder/);
    await expectMailError(svc.deleteMailbox({ path: 'Drafts' }), 'FORBIDDEN');
    await expectMailError(svc.deleteMailbox({ path: 'INBOX' }), 'FORBIDDEN');
    await expectMailError(svc.deleteMailbox({ path: 'Receipts' }), 'CONFLICT', /still contains \d+ message/);
    await expectMailError(svc.deleteMailbox({ path: 'Projects' }), 'CONFLICT', /Projects\/Acme/);
    await expectMailError(svc.renameMailbox({ path: 'Receipts', newPath: 'Archive' }), 'CONFLICT', /already exists/);
  });
});

describe('drafts', () => {
  let firstUid: number | null = null;

  it('appends a draft with \\Draft and \\Seen, keeping Bcc', async () => {
    const r = await svc.saveDraft({ to: ['Friend <friend@example.com>'], bcc: ['hidden@example.net'], subject: 'Draft subject', body: 'Draft body\nline 2' });
    expect(r.mailbox).toBe('Drafts');
    expect(r.uid).toBe(3);
    expect(r.message_id).toMatch(/^<[0-9a-f-]+@icloud\.test>$/);
    firstUid = r.uid;
    const flags = await rawFlags('Drafts', 3);
    expect(flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    const src = (await rawSource('Drafts', 3))?.toString('utf8') ?? '';
    expect(src).toMatch(/^Bcc: hidden@example\.net\r$/m);
    expect(src).toMatch(/^From: Test User <testuser@icloud\.test>\r$/m);
    expect(src).toContain('\r\n');
  });

  it('replaces an earlier draft only after saving the new one', async () => {
    const r = await svc.saveDraft({ to: ['friend@example.com'], subject: 'Draft v2', body: 'Second version', replaceDraftUid: firstUid ?? 0 });
    expect(r.replaced_uid).toBe(firstUid);
    expect(r.replace_error).toBeUndefined();
    expect(r.uid).toBe(4);
    expect(await rawFlags('Drafts', firstUid ?? 0)).toBeNull();
    expect(await rawFlags('Drafts', 4)).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
  });

  it('refuses to replace a UID that is not in Drafts', async () => {
    const before = await rawStatus('Drafts');
    await expectMailError(svc.saveDraft({ body: 'x', replaceDraftUid: 999 }), 'NOT_FOUND', /replace_draft_uid 999/);
    expect((await rawStatus('Drafts')).messages).toBe(before.messages);
  });

  it('builds a reply draft with threading headers and quoting', async () => {
    const r = await svc.saveDraft({ body: 'Sounds good.', replyTo: { mailbox: 'INBOX', uid: 23 } });
    expect(r.warning).toBeUndefined();
    // Regression: imapflow filters APPEND flags by the selected mailbox's PERMANENTFLAGS.
    expect(await rawFlags('Drafts', r.uid ?? 0)).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    const src = (await rawSource('Drafts', r.uid ?? 0))?.toString('utf8') ?? '';
    expect(src).toMatch(/^Subject: Re: Project kickoff\r$/m);
    expect(src).toMatch(/^In-Reply-To: <kickoff-3@example\.com>\r$/m);
    expect(src).toMatch(/^References: <kickoff-1@example\.com> <kickoff-2@icloud\.test>\s+<kickoff-3@example\.com>\r$/m);
    expect(src).toMatch(/^To: Dave Wilson <dave@example\.com>\r$/m);
    // Drafts never set \Answered on the original.
    expect(await rawFlags('INBOX', 23)).not.toContain('\\Answered');
  });

  it('builds a forward draft with the original attachments', async () => {
    const r = await svc.saveDraft({ body: 'FYI', forwardOf: { mailbox: 'INBOX', uid: 6 } });
    expect(await rawFlags('Drafts', r.uid ?? 0)).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    const src = (await rawSource('Drafts', r.uid ?? 0))?.toString('utf8') ?? '';
    expect(src).toMatch(/^Subject: Fwd: Invoice #10423 for March\r$/m);
    expect(src).toContain('---------- Forwarded message ----------');
    expect(src).toMatch(/filename=Invoice-10423\.pdf/);
    expect(await rawFlags('INBOX', 6)).not.toContain('$Forwarded');
    expect(await rawUidsByMessageId('Drafts', r.message_id)).toEqual([r.uid]);
  });

  it('records write actions in the audit log without bodies', () => {
    const entries = auditEntries();
    const tools = new Set(entries.map((e) => e['tool']));
    for (const t of ['mark_messages', 'move_messages', 'archive_messages', 'trash_messages', 'delete_messages_permanently', 'create_mailbox', 'rename_mailbox', 'delete_mailbox', 'save_draft']) {
      expect(tools.has(t), t).toBe(true);
    }
    const raw = readFileSync(dirs.auditLog, 'utf8');
    expect(raw).not.toContain('Draft body');
    expect(raw).not.toContain('Second version');
    expect(raw).not.toContain('app-specific-pass');
    expect(entries.every((e) => typeof e['ts'] === 'string')).toBe(true);
  });
});

describe('freshness', () => {
  it('the no-criteria listing sees mail that arrived after INBOX was selected', async () => {
    const before = await svc.search({ mailbox: 'INBOX', limit: 1, includeSnippets: false });
    await withRawImap((client) =>
      client.append('INBOX', Buffer.from('From: late@example.com\r\nTo: testuser@icloud.test\r\nSubject: Just arrived\r\nMessage-ID: <late-1@example.com>\r\n\r\nhello\r\n'), []),
    );
    const after = await svc.search({ mailbox: 'INBOX', limit: 1, includeSnippets: false });
    expect(after.total).toBe(before.total + 1);
    expect(after.messages[0]?.subject).toBe('Just arrived');
    expect(after.messages[0]?.uid).toBeGreaterThan(before.messages[0]?.uid ?? 0);
  });
});

describe('read-only mode', () => {
  it('refuses every write', async () => {
    const ro = createTestService(dirs, { MAIL_READ_ONLY: 'true' });
    try {
      await expectMailError(ro.markMessages({ mailbox: 'INBOX', uids: [2], read: true }), 'FORBIDDEN', /read-only/);
      await expectMailError(ro.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'Receipts' }), 'FORBIDDEN');
      await expectMailError(ro.saveDraft({ body: 'x' }), 'FORBIDDEN');
      await expectMailError(ro.sendEmail({ to: ['a@example.com'], subject: 's', body: 'b' }), 'FORBIDDEN');
      await expectMailError(ro.createMailbox({ path: 'X' }), 'FORBIDDEN');
      const view = await ro.getMessage({ mailbox: 'INBOX', uid: 26, markAsRead: true });
      expect(view.notes.join(' ')).toMatch(/ignored/);
      expect(await rawFlags('INBOX', 26)).not.toContain('\\Seen');
      expect(ro.features).toMatchObject({ readOnly: true, send: false, permanentDelete: false, drafts: false });
    } finally {
      await ro.close();
    }
  });
});
