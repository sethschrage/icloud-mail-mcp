/**
 * Domain layer against the iCloud-fidelity profiles (test-infra README): "icloud" has no MOVE and no
 * SPECIAL-USE (UIDPLUS present); "no-uidplus" also lacks UIDPLUS, so every move/delete ends in a
 * plain EXPUNGE and the SPEC §2.4 guard must protect other \Deleted messages.
 * Skipped when the profile instances are not running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { MailService } from '../../src/service.js';
import {
  PROFILES,
  cleanupDirs,
  createTestService,
  makeTestDirs,
  portOpen,
  skipProfile,
  rawFlags,
  rawSetDeleted,
  rawStatus,
  rawUidsByMessageId,
  resetProfile,
  type TestDirs,
} from '../helpers/infra.js';

const icloudUp = await portOpen(PROFILES.icloud);
const noUidplusUp = await portOpen(PROFILES['no-uidplus']);

async function expectMailError(p: Promise<unknown>, code: string, pattern?: RegExp): Promise<MailError> {
  const err = await p.then(
    () => {
      throw new Error('expected a MailError');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailError);
  expect((err as MailError).code).toBe(code);
  if (pattern) expect((err as MailError).message).toMatch(pattern);
  return err as MailError;
}

describe.skipIf(skipProfile(icloudUp))('icloud profile (no MOVE, no SPECIAL-USE)', () => {
  const port = PROFILES.icloud;
  let dirs: TestDirs;
  let svc: MailService;

  beforeAll(async () => {
    await resetProfile('icloud');
    dirs = makeTestDirs();
    svc = createTestService(dirs, { IMAP_PORT: String(port), MAIL_ALLOW_PERMANENT_DELETE: 'true', MAIL_MAX_SENDS_PER_HOUR: '0' });
  });
  afterAll(async () => {
    await svc?.close();
    if (dirs) cleanupDirs(dirs);
  });

  it('detects special folders by name and reports the capabilities', async () => {
    const list = await svc.listMailboxes();
    expect(list.slice(0, 6).map((m) => `${m.special_use}:${m.path}`)).toEqual([
      'inbox:INBOX',
      'drafts:Drafts',
      'sent:Sent Messages',
      'archive:Archive',
      'junk:Junk',
      'trash:Deleted Messages',
    ]);
    // No LIST-STATUS here: counts come from per-mailbox STATUS.
    expect(list.find((m) => m.path === 'INBOX')).toMatchObject({ total: 29, unread: 15 });
    const info = await svc.getAccountInfo();
    expect(info['capabilities']).toMatchObject({ MOVE: false, 'SPECIAL-USE': false, UIDPLUS: true });
    expect((await svc.resolveMailbox('trash')).path).toBe('Deleted Messages');
  });

  it('search works without WITHIN-style dates and without server SORT', async () => {
    expect((await svc.search({ since: '2026-09-01', before: '2026-09-20', limit: 100 })).messages.map((m) => m.uid)).toEqual([27, 26, 25]);
    expect((await svc.search({ allMailboxes: true, subject: 'kickoff' })).total).toBe(4);
  });

  it('move falls back to COPY + UID EXPUNGE and leaves other \\Deleted messages alone', async () => {
    await rawSetDeleted('INBOX', 1, true, port);
    const r = await svc.trashMessages({ mailbox: 'INBOX', uids: [3] });
    expect(r).toMatchObject({ destination: 'Deleted Messages', moved: 1, new_uids: { '3': 2 } });
    expect(await rawFlags('INBOX', 3, port)).toBeNull();
    expect(await rawFlags('INBOX', 1, port)).toContain('\\Deleted');
    await rawSetDeleted('INBOX', 1, false, port);
    const a = await svc.archiveMessages({ mailbox: 'INBOX', uids: [2] });
    expect(a).toMatchObject({ destination: 'Archive', new_uids: { '2': 4 } });
  });

  it('permanent delete uses UID EXPUNGE', async () => {
    await rawSetDeleted('Deleted Messages', 1, true, port);
    const r = await svc.deleteMessagesPermanently({ mailbox: 'trash', uids: [2] });
    expect(r).toMatchObject({ deleted: 1 });
    expect(await rawFlags('Deleted Messages', 1, port)).toContain('\\Deleted');
  });

  it('drafts and Sent copies land in the name-detected folders with their flags', async () => {
    const d = await svc.saveDraft({ to: ['friend@example.com'], body: 'profile draft' });
    expect(d.mailbox).toBe('Drafts');
    expect(await rawFlags('Drafts', d.uid ?? 0, port)).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    const sent = await svc.sendEmail({ to: ['friend@example.com'], subject: 'profile send', body: 'x' });
    expect(sent).toMatchObject({ sent: true, sent_copy_saved: true, sent_copy_mailbox: 'Sent Messages' });
    if (sent.sent) expect(await rawUidsByMessageId('Sent Messages', sent.message_id, port)).toHaveLength(1);
  });
});

describe.skipIf(skipProfile(noUidplusUp))('no-uidplus profile (expunge guard)', () => {
  const port = PROFILES['no-uidplus'];
  let dirs: TestDirs;
  let svc: MailService;

  beforeAll(async () => {
    await resetProfile('no-uidplus');
    dirs = makeTestDirs();
    svc = createTestService(dirs, { IMAP_PORT: String(port), MAIL_ALLOW_PERMANENT_DELETE: 'true' });
  });
  afterAll(async () => {
    await svc?.close();
    if (dirs) cleanupDirs(dirs);
  });

  it('refuses a move that would purge someone else\'s \\Deleted message', async () => {
    await rawSetDeleted('INBOX', 1, true, port);
    const before = await rawStatus('INBOX', port);
    await expectMailError(svc.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'Receipts' }), 'EXPUNGE_GUARD', /neither MOVE nor UIDPLUS.*UIDs 1/);
    expect(await rawFlags('INBOX', 1, port)).toContain('\\Deleted');
    expect(await rawFlags('INBOX', 2, port)).not.toBeNull();
    expect((await rawStatus('INBOX', port)).messages).toBe(before.messages);
    await expectMailError(svc.trashMessages({ mailbox: 'INBOX', uids: [2] }), 'EXPUNGE_GUARD');
  });

  it('moves once no other \\Deleted messages exist (plain EXPUNGE path)', async () => {
    await rawSetDeleted('INBOX', 1, false, port);
    const r = await svc.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'Receipts' });
    expect(r.moved).toBe(1);
    expect(await rawFlags('INBOX', 2, port)).toBeNull();
    expect(await rawFlags('INBOX', 1, port)).not.toBeNull();
    expect((await rawStatus('Receipts', port)).messages).toBe(2);
  });

  it('guards permanent delete and draft replacement too', async () => {
    await rawSetDeleted('Deleted Messages', 1, true, port);
    const trashed = await svc.trashMessages({ mailbox: 'INBOX', uids: [4] });
    expect(trashed.moved).toBe(1);
    const trashUids = (await svc.search({ mailbox: 'trash', limit: 10 })).messages.map((m) => m.uid);
    expect(trashUids.length).toBeGreaterThan(0);
    await expectMailError(svc.deleteMessagesPermanently({ mailbox: 'trash', uids: [trashUids[0] as number] }), 'EXPUNGE_GUARD');
    await rawSetDeleted('Drafts', 2, true, port);
    const before = await rawStatus('Drafts', port);
    await expectMailError(svc.saveDraft({ body: 'v2', replaceDraftUid: 1 }), 'EXPUNGE_GUARD', /replace the draft/);
    expect((await rawStatus('Drafts', port)).messages).toBe(before.messages);
    await rawSetDeleted('Drafts', 2, false, port);
    const ok = await svc.saveDraft({ body: 'v2', replaceDraftUid: 1 });
    expect(ok.replaced_uid).toBe(1);
    // drafts-1: a draft this process did not save goes to Trash, never expunged.
    expect(ok.old_draft).toMatch(/moved to Deleted Messages/);
    expect(await rawFlags('Drafts', 1, port)).toBeNull();
    expect(await rawFlags('Drafts', 2, port)).not.toBeNull();
  });
});
