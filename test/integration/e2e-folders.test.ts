/**
 * End-to-end folder operations over stdio on every server profile (SPEC §8):
 * - move / archive / trash / special folders / permanent delete / draft replacement against the
 *   main instance (MOVE + SPECIAL-USE) AND the "icloud" profile (no MOVE, no SPECIAL-USE: COPY +
 *   UID EXPUNGE, name-based special folders);
 * - the expunge guard (SPEC §2.4) against the "no-uidplus" profile, where every move/delete ends in
 *   a plain EXPUNGE: a foreign \Deleted message makes the operation refuse; without one it works.
 * Profile suites are skipped when their ports are closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eEnv } from '../helpers/e2e.js';
import {
  PROFILES,
  cleanupDirs,
  makeTestDirs,
  portOpen,
  skipProfile,
  rawFlags,
  rawSetDeleted,
  rawStatus,
  resetMailServer,
  resetProfile,
  type TestDirs,
} from '../helpers/infra.js';
import { auditEntries, json, startMcp, type McpSession } from '../helpers/mcp.js';

interface MoveResult {
  source: string;
  destination: string;
  moved: number;
  not_found: number[];
  new_uids?: Record<string, number>;
  note?: string;
}

interface Target {
  name: string;
  port: number;
  move: boolean;
  specialUse: boolean;
  up: boolean;
  reset: () => Promise<void>;
}

const TARGETS: Target[] = [
  { name: 'main instance', port: 1993, move: true, specialUse: true, up: true, reset: resetMailServer },
  { name: 'icloud profile', port: PROFILES.icloud, move: false, specialUse: false, up: await portOpen(PROFILES.icloud), reset: () => resetProfile('icloud') },
];

describe.each(TARGETS)('folder operations on the $name', (target) => {
  let dirs: TestDirs;
  let s: McpSession;
  const port = target.port;

  beforeAll(async () => {
    if (!target.up) return;
    await target.reset();
    dirs = makeTestDirs();
    s = await startMcp(e2eEnv(dirs, { IMAP_PORT: String(port), MAIL_ALLOW_PERMANENT_DELETE: 'true' }));
  });

  afterAll(async () => {
    await s?.close();
    if (dirs) cleanupDirs(dirs);
  });

  it.skipIf(skipProfile(target.up))('resolves the special folders and aliases', async () => {
    const list = json<{ mailboxes: Array<{ path: string; special_use: string | null }> }>(await s.call('list_mailboxes'));
    expect(list.mailboxes.slice(0, 6).map((m) => `${m.special_use}:${m.path}`)).toEqual([
      'inbox:INBOX',
      'drafts:Drafts',
      'sent:Sent Messages',
      'archive:Archive',
      'junk:Junk',
      'trash:Deleted Messages',
    ]);
    const info = json(await s.call('get_account_info'));
    expect(info['capabilities']).toMatchObject({ MOVE: target.move, 'SPECIAL-USE': target.specialUse, UIDPLUS: true });
    expect(info['special_folders']).toMatchObject({ sent: 'Sent Messages', trash: 'Deleted Messages', drafts: 'Drafts', junk: 'Junk', archive: 'Archive' });
    expect(json<{ total: number }>(await s.call('search_messages', { mailbox: 'trash' })).total).toBe(1);
    expect(json<{ total: number }>(await s.call('search_messages', { mailbox: 'Sent Items' })).total).toBe(3);
    expect(json<{ total: number }>(await s.call('search_messages', { mailbox: 'bin' })).total).toBe(1);
  });

  it.skipIf(skipProfile(target.up))('moves messages, returns new UIDs, and leaves other \\Deleted messages alone', async () => {
    await rawSetDeleted('INBOX', 2, true, port); // someone else's pending deletion
    try {
      const before = await rawStatus('Receipts', port);
      const r = json<MoveResult>(await s.call('move_messages', { mailbox: 'INBOX', uids: [1, 4242], destination: 'receipts' }));
      expect(r).toMatchObject({ source: 'INBOX', destination: 'Receipts', moved: 1, not_found: [4242], new_uids: { '1': 2 } });
      expect(r.note).toMatch(/UID 4242 was not found/);
      expect(await rawFlags('INBOX', 1, port)).toBeNull();
      expect(await rawFlags('INBOX', 2, port)).toContain('\\Deleted');
      expect((await rawStatus('Receipts', port)).messages).toBe(before.messages + 1);
      expect(await rawFlags('Receipts', 2, port)).toContain('\\Seen');
    } finally {
      await rawSetDeleted('INBOX', 2, false, port);
    }
  });

  it.skipIf(skipProfile(target.up))('refuses a missing or identical destination', async () => {
    const missing = await s.call('move_messages', { mailbox: 'INBOX', uids: [2], destination: 'Nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/create_mailbox/);
    const same = await s.call('move_messages', { mailbox: 'INBOX', uids: [2], destination: 'inbox' });
    expect(same.isError).toBe(true);
    expect(same.text).toMatch(/same mailbox/);
    expect(await rawFlags('INBOX', 2, port)).not.toBeNull();
  });

  it.skipIf(skipProfile(target.up))('archives into Archive and refuses to archive what is already there', async () => {
    const r = json<MoveResult>(await s.call('archive_messages', { mailbox: 'INBOX', uids: [14] }));
    expect(r).toMatchObject({ destination: 'Archive', moved: 1, new_uids: { '14': 4 } });
    expect(await rawFlags('INBOX', 14, port)).toBeNull();
    expect(await rawFlags('Archive', 4, port)).not.toBeNull();
    const again = await s.call('archive_messages', { mailbox: 'archive', uids: [4] });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already in the archive folder/);
  });

  it.skipIf(skipProfile(target.up))('trashes into Deleted Messages and explains when messages are already in Trash', async () => {
    const r = json<MoveResult>(await s.call('trash_messages', { mailbox: 'INBOX', uids: [17] }));
    expect(r).toMatchObject({ destination: 'Deleted Messages', moved: 1, new_uids: { '17': 2 } });
    expect(await rawFlags('INBOX', 17, port)).toBeNull();
    const again = await s.call('trash_messages', { mailbox: 'trash', uids: [2] });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already in Trash.*delete_messages_permanently/);
    const none = json<MoveResult>(await s.call('trash_messages', { mailbox: 'INBOX', uids: [4242] }));
    expect(none).toMatchObject({ moved: 0, not_found: [4242] });
  });

  it.skipIf(skipProfile(target.up))('permanently deletes only the given UIDs (UID EXPUNGE keeps other \\Deleted messages)', async () => {
    await rawSetDeleted('Deleted Messages', 1, true, port);
    try {
      const r = json<{ deleted: number; not_found: number[] }>(await s.call('delete_messages_permanently', { mailbox: 'Deleted Messages', uids: [2, 777] }));
      expect(r).toMatchObject({ deleted: 1, not_found: [777] });
      expect(await rawFlags('Deleted Messages', 2, port)).toBeNull();
      expect(await rawFlags('Deleted Messages', 1, port)).toContain('\\Deleted');
    } finally {
      await rawSetDeleted('Deleted Messages', 1, false, port);
    }
  });

  it.skipIf(skipProfile(target.up))('replaces a draft only after saving the new version', async () => {
    const first = json<{ mailbox: string; uid: number }>(await s.call('save_draft', { to: ['friend@example.com'], subject: 'v1', body: 'first version' }));
    expect(first).toMatchObject({ mailbox: 'Drafts', uid: 3 });
    expect(await rawFlags('Drafts', 3, port)).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    await rawSetDeleted('Drafts', 1, true, port);
    try {
      const second = json<{ uid: number; replaced_uid?: number; replace_error?: string }>(
        await s.call('save_draft', { to: ['friend@example.com'], subject: 'v2', body: 'second version', replace_draft_uid: 3 }),
      );
      expect(second).toMatchObject({ uid: 4, replaced_uid: 3 });
      expect(second.replace_error).toBeUndefined();
      expect(await rawFlags('Drafts', 3, port)).toBeNull();
      expect(await rawFlags('Drafts', 4, port)).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
      expect(await rawFlags('Drafts', 1, port)).toContain('\\Deleted');
    } finally {
      await rawSetDeleted('Drafts', 1, false, port);
    }
    const notDraft = await s.call('save_draft', { body: 'x', replace_draft_uid: 3 });
    expect(notDraft.isError).toBe(true);
    expect(notDraft.text).toMatch(/replace_draft_uid 3 was not found in "Drafts"/);
  });
});

const noUidplusUp = await portOpen(PROFILES['no-uidplus']);

describe.skipIf(skipProfile(noUidplusUp))('expunge guard on the no-uidplus profile (no MOVE, no UIDPLUS)', () => {
  const port = PROFILES['no-uidplus'];
  let dirs: TestDirs;
  let s: McpSession;

  beforeAll(async () => {
    await resetProfile('no-uidplus');
    dirs = makeTestDirs();
    s = await startMcp(e2eEnv(dirs, { IMAP_PORT: String(port), MAIL_ALLOW_PERMANENT_DELETE: 'true' }));
  });

  afterAll(async () => {
    await s?.close();
    if (dirs) cleanupDirs(dirs);
  });

  it('reports the capabilities that force the guard', async () => {
    expect(json(await s.call('get_account_info'))['capabilities']).toMatchObject({ MOVE: false, UIDPLUS: false });
  });

  it('refuses move, archive and trash while a foreign \\Deleted message is pending, changing nothing', async () => {
    await rawSetDeleted('INBOX', 1, true, port);
    const before = await rawStatus('INBOX', port);
    for (const [tool, args] of [
      ['move_messages', { mailbox: 'INBOX', uids: [2], destination: 'Receipts' }],
      ['archive_messages', { mailbox: 'INBOX', uids: [2] }],
      ['trash_messages', { mailbox: 'INBOX', uids: [2] }],
    ] as const) {
      const r = await s.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/neither MOVE nor UIDPLUS/);
      expect(r.text, tool).toMatch(/UIDs 1\)/);
      expect(r.text, tool).toMatch(/Nothing was changed/);
    }
    expect((await rawStatus('INBOX', port)).messages).toBe(before.messages);
    expect(await rawFlags('INBOX', 1, port)).toContain('\\Deleted');
    expect(await rawFlags('INBOX', 2, port)).not.toBeNull();
    expect((await rawStatus('Receipts', port)).messages).toBe(1);
    expect((await rawStatus('Archive', port)).messages).toBe(3);
  });

  it('moves once no foreign \\Deleted message is pending (plain EXPUNGE path)', async () => {
    await rawSetDeleted('INBOX', 1, false, port);
    const r = json<MoveResult>(await s.call('move_messages', { mailbox: 'INBOX', uids: [2], destination: 'Receipts' }));
    expect(r.moved).toBe(1);
    expect(await rawFlags('INBOX', 2, port)).toBeNull();
    expect(await rawFlags('INBOX', 1, port)).not.toBeNull();
    expect((await rawStatus('Receipts', port)).messages).toBe(2);
    const t = json<MoveResult>(await s.call('trash_messages', { mailbox: 'INBOX', uids: [4] }));
    expect(t).toMatchObject({ moved: 1, destination: 'Deleted Messages' });
  });

  it('guards permanent delete', async () => {
    const trash = json<{ messages: Array<{ uid: number }> }>(await s.call('search_messages', { mailbox: 'trash', include_snippets: false }));
    const ours = trash.messages.map((m) => m.uid).find((u) => u !== 1);
    expect(ours).toBeDefined();
    await rawSetDeleted('Deleted Messages', 1, true, port);
    const refused = await s.call('delete_messages_permanently', { mailbox: 'trash', uids: [ours as number] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Refusing to permanently delete/);
    expect(await rawFlags('Deleted Messages', ours as number, port)).not.toBeNull();
    await rawSetDeleted('Deleted Messages', 1, false, port);
    const ok = json<{ deleted: number }>(await s.call('delete_messages_permanently', { mailbox: 'trash', uids: [ours as number] }));
    expect(ok.deleted).toBe(1);
    expect(await rawFlags('Deleted Messages', ours as number, port)).toBeNull();
    expect(await rawFlags('Deleted Messages', 1, port)).not.toBeNull();
  });

  it('guards draft replacement (nothing is saved while refused)', async () => {
    await rawSetDeleted('Drafts', 2, true, port);
    const before = await rawStatus('Drafts', port);
    const refused = await s.call('save_draft', { body: 'v2', replace_draft_uid: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Refusing to replace the draft/);
    expect((await rawStatus('Drafts', port)).messages).toBe(before.messages);
    await rawSetDeleted('Drafts', 2, false, port);
    const ok = json<{ replaced_uid?: number }>(await s.call('save_draft', { body: 'v2', replace_draft_uid: 1 }));
    expect(ok.replaced_uid).toBe(1);
    expect(await rawFlags('Drafts', 1, port)).toBeNull();
    expect(await rawFlags('Drafts', 2, port)).not.toBeNull();
  });

  it('audits each refusal exactly once', () => {
    const guarded = auditEntries(dirs.auditLog).filter((e) => e['error_code'] === 'EXPUNGE_GUARD');
    const byTool = guarded.map((e) => e['tool']).sort();
    expect(byTool).toEqual(['archive_messages', 'delete_messages_permanently', 'move_messages', 'save_draft', 'trash_messages']);
  });
});
