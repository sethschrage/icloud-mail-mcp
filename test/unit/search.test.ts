import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { ImapManager } from '../../src/imap/client.js';
import type { MailboxRegistry } from '../../src/imap/mailboxes.js';
import { ALL_MAILBOXES_MAX_WINDOW, buildSearchObject, hasCriteria, searchMessages, sortUidsDesc, toSequenceSet } from '../../src/imap/search.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-09-28T16:00:00Z');

describe('buildSearchObject', () => {
  it('always adds UNDELETED', () => {
    const b = buildSearchObject({}, { timeZone: TZ, now: NOW });
    expect(b.query).toEqual({ deleted: false });
    expect(b.empty).toBe(true);
    expect(b.colorFilter).toBeNull();
  });

  it('maps text criteria; `to` matches To or Cc', () => {
    const b = buildSearchObject({ query: 'invoice', from: 'alice', to: 'bob@example.org', subject: 'Q3', body: 'total' }, { timeZone: TZ, now: NOW });
    expect(b.query).toEqual({ deleted: false, text: 'invoice', from: 'alice', or: [{ to: 'bob@example.org' }, { cc: 'bob@example.org' }], subject: 'Q3', body: 'total' });
    expect(b.empty).toBe(false);
  });

  it('widens the server date window by a day and keeps exact local-midnight bounds for the client filter', () => {
    const b = buildSearchObject({ since: '2026-09-01', before: '2026-09-20T08:00:00+09:00' }, { timeZone: TZ, now: NOW });
    expect((b.query.since as Date).toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect((b.query.before as Date).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    // Local midnight in Los Angeles (PDT, UTC-7).
    expect(new Date(b.range?.start ?? 0).toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(new Date(b.range?.end ?? 0).toISOString()).toBe('2026-09-20T07:00:00.000Z');
  });

  it('newer_than_days counts from today in MAIL_TIMEZONE and keeps the later of since/newer_than_days', () => {
    const since = (c: Parameters<typeof buildSearchObject>[0]): string | undefined => buildSearchObject(c, { timeZone: TZ, now: NOW }).range?.since?.day.toString();
    expect(since({ newerThanDays: 7 })).toBe('21');
    expect(since({ newerThanDays: 0 })).toBe('28');
    expect(since({ newerThanDays: 7, since: '2026-09-25' })).toBe('25');
    expect(since({ newerThanDays: 7, since: '2026-01-01' })).toBe('21');
    expect((buildSearchObject({ newerThanDays: 7 }, { timeZone: TZ, now: NOW }).query.since as Date).toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('rejects inverted ranges and bad values', () => {
    expect(() => buildSearchObject({ since: '2026-09-20', before: '2026-09-20' }, { timeZone: TZ, now: NOW })).toThrow(MailError);
    expect(() => buildSearchObject({ newerThanDays: -1 }, { timeZone: TZ, now: NOW })).toThrow(MailError);
    expect(() => buildSearchObject({ from: 'a\r\nb' }, { timeZone: TZ, now: NOW })).toThrow(/line breaks/);
    expect(() => buildSearchObject({ flagColor: 'red', flagged: false }, { timeZone: TZ, now: NOW })).toThrow(MailError);
  });

  it('maps flags', () => {
    expect(buildSearchObject({ unread: true, flagged: false, answered: true }, { timeZone: TZ }).query).toEqual({ deleted: false, seen: false, flagged: false, answered: true });
    expect(buildSearchObject({ unread: false }, { timeZone: TZ }).query).toEqual({ deleted: false, seen: true });
  });

  it('narrows colour searches on the server and keeps an exact post-filter', () => {
    expect(buildSearchObject({ flagColor: 'green' }, { timeZone: TZ })).toMatchObject({ query: { deleted: false, flagged: true, keyword: '$MailFlagBit0', unKeyword: '$MailFlagBit2' }, colorFilter: 'green' });
    expect(buildSearchObject({ flagColor: 'red' }, { timeZone: TZ }).query).toEqual({ deleted: false, flagged: true, unKeyword: '$MailFlagBit0' });
    expect(buildSearchObject({ flagColor: 'gray' }, { timeZone: TZ }).query).toEqual({ deleted: false, flagged: true, keyword: '$MailFlagBit1', unKeyword: '$MailFlagBit0' });
  });

  it('converts min_size_kb to LARGER', () => {
    expect(buildSearchObject({ minSizeKb: 100 }, { timeZone: TZ }).query.larger).toBe(102_399);
  });

  it('hasCriteria ignores blanks', () => {
    expect(hasCriteria({ query: '  ', from: '' })).toBe(false);
    expect(hasCriteria({ unread: false })).toBe(true);
    expect(hasCriteria({ minSizeKb: 0 })).toBe(false);
  });
});

describe('UID helpers', () => {
  it('sorts numerically descending, unique (iCloud may return UIDs out of order)', () => {
    expect(sortUidsDesc([10, 9, 100, 2, 10, 33])).toEqual([100, 33, 10, 9, 2]);
  });

  it('compresses UID sets', () => {
    expect(toSequenceSet([5, 1, 2, 3, 9, 10, 7])).toBe('1:3,5,7,9:10');
    expect(toSequenceSet([42])).toBe('42');
    expect(toSequenceSet([])).toBe('');
  });
});

// imap-10 / dos-2: deep all_mailboxes paging is refused instead of fetching offset+limit per folder.
describe('all_mailboxes window', () => {
  it('rejects offset + limit above the cap before touching the server', async () => {
    const untouched = new Proxy({}, { get: () => { throw new Error('server touched'); } });
    await expect(
      searchMessages(untouched as ImapManager, untouched as MailboxRegistry, { timezone: 'UTC' }, { allMailboxes: true, offset: ALL_MAILBOXES_MAX_WINDOW, limit: 20, includeSnippets: false }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
