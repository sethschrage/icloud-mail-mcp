import type { ListResponse } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { Config } from '../../src/config.js';
import type { ImapManager } from '../../src/imap/client.js';
import {
  MailboxRegistry,
  computeSpecialMap,
  isNotesMailbox,
  labelSpecials,
  resolveMailboxName,
  sortMailboxesForDisplay,
  toMailboxInfo,
  type MailboxInfo,
} from '../../src/imap/mailboxes.js';

function entry(path: string, opts: { flags?: string[]; specialUse?: string; source?: 'extension' | 'name'; messages?: number; unseen?: number; delimiter?: string } = {}): ListResponse {
  const delimiter = opts.delimiter ?? '/';
  const parts = path.split(delimiter);
  const e: ListResponse = {
    path,
    pathAsListed: path,
    name: parts[parts.length - 1] ?? path,
    delimiter,
    parent: parts.slice(0, -1),
    parentPath: parts.slice(0, -1).join(delimiter),
    flags: new Set(opts.flags ?? []),
    listed: true,
    subscribed: true,
    status: { path, messages: opts.messages ?? 0, unseen: opts.unseen ?? 0 },
  };
  if (opts.specialUse) {
    e.specialUse = opts.specialUse;
    e.specialUseSource = opts.source ?? 'extension';
  }
  return e;
}

/**
 * iCloud-like listing: no SPECIAL-USE attributes, so imapflow guesses specialUse from names. When
 * several folders match one type it gives it to the alphabetically first path only: the
 * client-created "Sent" gets \\Sent and Apple's "Sent Messages" gets nothing (what imapflow 2.1 does).
 */
function icloudLike(): MailboxInfo[] {
  return [
    entry('INBOX', { flags: ['\\NoInferiors'], specialUse: '\\Inbox', messages: 10, unseen: 2 }),
    entry('Sent Messages'),
    entry('Deleted Messages', { specialUse: '\\Trash', source: 'name' }),
    entry('Drafts', { specialUse: '\\Drafts', source: 'name' }),
    entry('Junk', { specialUse: '\\Junk', source: 'name' }),
    entry('Archive', { specialUse: '\\Archive', source: 'name' }),
    entry('Notes'),
    entry('México'), // NFD, as created on a Mac
    entry('Work', { flags: ['\\Noselect', '\\HasChildren'] }),
    entry('Work/Reports'),
    entry('Personal/Reports'),
    entry('Sent', { specialUse: '\\Sent', source: 'name' }), // a client-created duplicate
  ].map(toMailboxInfo);
}

function resolve(input: string, list = icloudLike()): MailboxInfo {
  const { map } = computeSpecialMap(list, {});
  return resolveMailboxName(input, labelSpecials(list, map), map);
}

function errorOf(fn: () => unknown): MailError {
  try {
    fn();
  } catch (e) {
    return e as MailError;
  }
  throw new Error('expected a throw');
}

describe('special folders', () => {
  it('maps specials from imapflow special-use (server attribute or name match)', () => {
    const { map } = computeSpecialMap(icloudLike(), {});
    expect(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v?.path ?? null]))).toEqual({
      inbox: 'INBOX',
      sent: 'Sent Messages',
      trash: 'Deleted Messages',
      drafts: 'Drafts',
      junk: 'Junk',
      archive: 'Archive',
    });
  });

  // imap-1 / tests-1: a name guess never beats Apple's own top-level folder names.
  it('prefers Apple\'s folder names over imapflow name guesses for stray folders', () => {
    const list = [
      entry('INBOX'),
      entry('Sent Items', { specialUse: '\\Sent', source: 'name' }),
      entry('Sent Messages'),
      entry('Bin', { specialUse: '\\Trash', source: 'name' }),
      entry('Deleted Messages'),
      entry('Draft', { specialUse: '\\Drafts', source: 'name' }),
      entry('Drafts'),
      entry('Bulk Mail', { specialUse: '\\Junk', source: 'name' }),
      entry('Junk'),
    ].map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    expect(map.sent?.path).toBe('Sent Messages');
    expect(map.trash?.path).toBe('Deleted Messages');
    expect(map.drafts?.path).toBe('Drafts');
    expect(map.junk?.path).toBe('Junk');
    expect(list.find((m) => m.path === 'Sent Items')?.serverSpecialUseSource).toBe('name');
  });

  it('trusts a real SPECIAL-USE attribute, ignores nested name guesses, and uses one folder for one kind only', () => {
    const list = [
      entry('INBOX'),
      entry('Gesendet', { specialUse: '\\Sent', source: 'extension' }),
      entry('Sent Messages'),
      entry('Old Mail', { flags: ['\\HasChildren'] }),
      entry('Old Mail/Trash', { specialUse: '\\Trash', source: 'name' }),
      entry('Sent Items', { specialUse: '\\Sent', source: 'name' }),
    ].map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    expect(map.sent?.path).toBe('Gesendet');
    expect(map.trash).toBeNull();
    const guessOnly = computeSpecialMap([entry('INBOX'), entry('Sent Items', { specialUse: '\\Sent', source: 'name' })].map(toMailboxInfo), {});
    expect(guessOnly.map.sent?.path).toBe('Sent Items');
    const both = computeSpecialMap([entry('INBOX'), entry('Archive')].map(toMailboxInfo), { sent: 'Archive' });
    expect(both.map.sent?.path).toBe('Archive');
    expect(both.map.archive).toBeNull();
  });

  it('falls back to iCloud default names when special-use is missing', () => {
    const list = [entry('INBOX'), entry('Sent Messages'), entry('Deleted Messages'), entry('Drafts')].map(toMailboxInfo);
    const { map } = computeSpecialMap(list, {});
    expect(map.sent?.path).toBe('Sent Messages');
    expect(map.trash?.path).toBe('Deleted Messages');
    expect(map.drafts?.path).toBe('Drafts');
    expect(map.archive).toBeNull();
    expect(map.junk).toBeNull();
  });

  it('env overrides win, and missing overrides are reported', () => {
    const { map, missingOverrides } = computeSpecialMap(icloudLike(), { sent: 'sent', archive: 'Old Archive' });
    expect(map.sent?.path).toBe('Sent');
    expect(map.archive).toBeNull();
    expect(missingOverrides).toEqual({ archive: 'Old Archive' });
  });
});

describe('name resolution', () => {
  it('prefers an exact path match', () => {
    expect(resolve('Sent').path).toBe('Sent');
    expect(resolve('Sent Messages').path).toBe('Sent Messages');
  });

  it('understands aliases case-insensitively', () => {
    const cases: Record<string, string> = {
      inbox: 'INBOX',
      Inbox: 'INBOX',
      sent: 'Sent Messages',
      'SENT ITEMS': 'Sent Messages',
      trash: 'Deleted Messages',
      Deleted: 'Deleted Messages',
      'deleted messages': 'Deleted Messages',
      bin: 'Deleted Messages',
      spam: 'Junk',
      junk: 'Junk',
      drafts: 'Drafts',
      archive: 'Archive',
    };
    for (const [input, expected] of Object.entries(cases)) expect(resolve(input).path, input).toBe(expected);
  });

  it('matches NFC input against NFD server names and returns the exact server path', () => {
    const found = resolve('México'.normalize('NFC'));
    expect(found.path).toBe('México');
    expect(resolve('MÉXICO').path).toBe('México');
  });

  it('matches case-folded paths and unique names', () => {
    expect(resolve('work/reports').path).toBe('Work/Reports');
    expect(resolve('notes').path).toBe('Notes');
  });

  it('reports ambiguous names', () => {
    const e = errorOf(() => resolve('Reports'));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toMatch(/ambiguous.*Work\/Reports.*Personal\/Reports/);
  });

  it('lists available mailboxes when nothing matches', () => {
    const e = errorOf(() => resolve('Receipts'));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toContain('Available mailboxes: INBOX, Sent Messages');
    expect(e.message).toContain('Work (not selectable)');
  });

  it('explains when an alias has no folder on this account', () => {
    const list = [entry('INBOX')].map(toMailboxInfo);
    const e = errorOf(() => resolve('archive', list));
    expect(e.message).toMatch(/no archive folder/);
  });

  it('maps "/" to another server delimiter', () => {
    const list = [entry('INBOX', { delimiter: '.' }), entry('Projects.Acme', { delimiter: '.' })].map(toMailboxInfo);
    expect(resolve('projects/acme', list).path).toBe('Projects.Acme');
  });
});

describe('listing helpers', () => {
  it('marks \\Noselect mailboxes and legacy Notes', () => {
    const list = icloudLike();
    expect(list.find((m) => m.path === 'Work')?.selectable).toBe(false);
    expect(list.find((m) => m.path === 'Work')?.total).toBeNull();
    expect(list.find((m) => m.path === 'INBOX')).toMatchObject({ total: 10, unread: 2, noInferiors: true });
    expect(isNotesMailbox(list.find((m) => m.path === 'Notes') as MailboxInfo)).toBe(true);
    expect(isNotesMailbox(list.find((m) => m.path === 'Drafts') as MailboxInfo)).toBe(false);
  });

  it('orders INBOX, then specials, then the rest alphabetically', () => {
    const list = icloudLike();
    const { map } = computeSpecialMap(list, {});
    const sorted = sortMailboxesForDisplay(labelSpecials(list, map)).map((m) => m.path);
    expect(sorted.slice(0, 6)).toEqual(['INBOX', 'Drafts', 'Sent Messages', 'Archive', 'Junk', 'Deleted Messages']);
    expect(sorted.slice(6)).toEqual(['México', 'Notes', 'Personal/Reports', 'Sent', 'Work', 'Work/Reports']);
  });
});

// imap-8 / imap-5: the registry's two caches and refresh generations.
describe('MailboxRegistry', () => {
  function registryWith(listImpl: (opts?: { statusQuery?: unknown }) => Promise<ListResponse[]>) {
    const calls: Array<{ status: boolean }> = [];
    const imap = {
      onMailboxMissing: undefined as undefined | (() => void),
      run: <T>(fn: (c: unknown) => Promise<T>) =>
        fn({
          list: (opts?: { statusQuery?: unknown }) => {
            calls.push({ status: !!opts?.statusQuery });
            return listImpl(opts);
          },
        }),
    };
    const config = { mailboxOverrides: {} } as unknown as Config;
    return { reg: new MailboxRegistry(imap as unknown as ImapManager, config), calls, imap };
  }

  it('a refresh never returns a load that started before the change', async () => {
    let folders = ['INBOX', 'Drafts'];
    let releaseFirst: (() => void) | undefined;
    let n = 0;
    const { reg } = registryWith(async () => {
      const snapshot = folders.map((f) => entry(f));
      if (n++ === 0) await new Promise<void>((r) => (releaseFirst = r));
      return snapshot;
    });
    const first = reg.list();
    await new Promise((r) => setTimeout(r, 10));
    folders = ['INBOX', 'Drafts', 'Created Just Now'];
    const refreshed = reg.list({ refresh: true });
    releaseFirst?.();
    expect((await refreshed).map((m) => m.path)).toContain('Created Just Now');
    expect((await first).map((m) => m.path)).not.toContain('Created Just Now');
    // The stale load was not cached either.
    expect((await reg.list()).map((m) => m.path)).toContain('Created Just Now');
  });

  it('loads names without STATUS; counts only on request, and invalidateCounts keeps the names', async () => {
    const { reg, calls } = registryWith(async (opts) => ['INBOX', 'Drafts'].map((f) => entry(f, opts?.statusQuery ? { messages: 5, unseen: 1 } : {})));
    const names = await reg.list();
    expect(names.every((m) => m.total === null || m.total === 0 || m.total === undefined || typeof m.total === 'number')).toBe(true);
    expect(calls).toEqual([{ status: false }]);
    await reg.resolve('drafts');
    expect(calls).toHaveLength(1);
    const withCounts = await reg.list({ counts: true });
    expect(withCounts.find((m) => m.path === 'INBOX')).toMatchObject({ total: 5, unread: 1 });
    expect(calls).toEqual([{ status: false }, { status: true }]);
    reg.invalidateCounts();
    await reg.resolve('inbox');
    expect(calls).toHaveLength(2);
    await reg.list({ counts: true });
    expect(calls).toHaveLength(3);
  });

  it('drops the folder list when a mailbox turned out to be missing', async () => {
    const { reg, calls, imap } = registryWith(async () => [entry('INBOX')]);
    await reg.list();
    imap.onMailboxMissing?.();
    await reg.list();
    expect(calls).toHaveLength(2);
  });
});

describe('Gmail (\\All mailbox)', () => {
  /** Gmail's listing: SPECIAL-USE attributes, labels as folders, everything also in "[Gmail]/All Mail". */
  function gmailLike(): ListResponse[] {
    return [
      entry('INBOX'),
      entry('Receipts'),
      entry('[Gmail]', { flags: ['\\Noselect', '\\HasChildren'] }),
      entry('[Gmail]/All Mail', { flags: ['\\All', '\\HasNoChildren'] }),
      entry('[Gmail]/Drafts', { flags: ['\\Drafts'], specialUse: '\\Drafts' }),
      entry('[Gmail]/Important', { flags: ['\\Important'] }),
      entry('[Gmail]/Sent Mail', { flags: ['\\Sent'], specialUse: '\\Sent' }),
      entry('[Gmail]/Spam', { flags: ['\\Junk'], specialUse: '\\Junk' }),
      entry('[Gmail]/Starred', { flags: ['\\Flagged'] }),
      entry('[Gmail]/Trash', { flags: ['\\Trash'], specialUse: '\\Trash' }),
    ];
  }

  it('archives to All Mail instead of creating an Archive label', () => {
    const { map } = computeSpecialMap(gmailLike().map(toMailboxInfo), {});
    expect(map.archive?.path).toBe('[Gmail]/All Mail');
    expect(map.sent?.path).toBe('[Gmail]/Sent Mail');
    expect(map.trash?.path).toBe('[Gmail]/Trash');
  });

  it('a real Archive folder or an override still wins', () => {
    const withArchive = computeSpecialMap([...gmailLike(), entry('Archive')].map(toMailboxInfo), {});
    expect(withArchive.map.archive?.path).toBe('Archive');
    const overridden = computeSpecialMap(gmailLike().map(toMailboxInfo), { archive: 'Receipts' });
    expect(overridden.map.archive?.path).toBe('Receipts');
  });

  it('all_mailboxes searches only All Mail, so a message is not listed once per label', async () => {
    const imap = { run: <T>(fn: (c: unknown) => Promise<T>) => fn({ list: async () => gmailLike() }) };
    const reg = new MailboxRegistry(imap as unknown as ImapManager, { mailboxOverrides: {} } as unknown as Config);
    expect((await reg.searchableMailboxes()).map((m) => m.path)).toEqual(['[Gmail]/All Mail']);
    expect((await reg.excludedFromAllMailboxes()).map((m) => m.path).sort()).toEqual(['[Gmail]/Spam', '[Gmail]/Trash']);
  });

  it('without an \\All mailbox (iCloud) every folder but Trash, Junk and Notes is searched', async () => {
    const imap = { run: <T>(fn: (c: unknown) => Promise<T>) => fn({ list: async () => [entry('INBOX'), entry('Archive'), entry('Notes'), entry('Deleted Messages', { specialUse: '\\Trash', source: 'name' })] }) };
    const reg = new MailboxRegistry(imap as unknown as ImapManager, { mailboxOverrides: {} } as unknown as Config);
    expect((await reg.searchableMailboxes()).map((m) => m.path)).toEqual(['INBOX', 'Archive']);
  });
});
