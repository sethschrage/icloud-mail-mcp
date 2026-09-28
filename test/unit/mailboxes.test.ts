import type { ListResponse } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import {
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

/** iCloud-like listing: no SPECIAL-USE attributes, imapflow name matching fills specialUse. */
function icloudLike(): MailboxInfo[] {
  return [
    entry('INBOX', { flags: ['\\NoInferiors'], specialUse: '\\Inbox', messages: 10, unseen: 2 }),
    entry('Sent Messages', { specialUse: '\\Sent', source: 'name' }),
    entry('Deleted Messages', { specialUse: '\\Trash', source: 'name' }),
    entry('Drafts', { specialUse: '\\Drafts', source: 'name' }),
    entry('Junk', { specialUse: '\\Junk', source: 'name' }),
    entry('Archive', { specialUse: '\\Archive', source: 'name' }),
    entry('Notes'),
    entry('México'), // NFD, as created on a Mac
    entry('Work', { flags: ['\\Noselect', '\\HasChildren'] }),
    entry('Work/Reports'),
    entry('Personal/Reports'),
    entry('Sent'), // a client-created duplicate
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
