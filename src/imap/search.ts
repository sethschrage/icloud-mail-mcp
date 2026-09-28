/**
 * search_messages (SPEC §6.1 #2): criteria building, paging, cross-mailbox merge.
 *
 * Rules: always UNDELETED; UIDs sorted numerically on the client (iCloud may return them out of
 * order, and its SORT is a no-op); newest first by UID descending within a mailbox; with
 * all_mailboxes, merge per-mailbox top (offset+limit) by date descending.
 */
import type { ImapFlow, SearchObject } from 'imapflow';
import type { Config } from '../config.js';
import { MailError } from '../errors.js';
import { addDays, calendarDateToUTC, compareCalendarDates, parseDateInput, todayIn, type CalendarDate } from '../format.js';
import type { ImapManager } from './client.js';
import { compareRecordsDesc, fetchSummaryRecords, fetchSummaryRecordsBySeq, type MessageSummary, type SummaryRecord } from './fetch.js';
import { colorKeywords, flagColorFromFlags, type FlagColor } from './flags.js';
import type { MailboxInfo, MailboxRegistry } from './mailboxes.js';

export interface SearchCriteria {
  /** IMAP TEXT: headers and body. */
  query?: string | undefined;
  from?: string | undefined;
  /** Matches To or Cc. */
  to?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  /** YYYY-MM-DD or ISO datetime (truncated to a date). */
  since?: string | undefined;
  /** Exclusive. */
  before?: string | undefined;
  newerThanDays?: number | undefined;
  unread?: boolean | undefined;
  flagged?: boolean | undefined;
  answered?: boolean | undefined;
  flagColor?: FlagColor | undefined;
  minSizeKb?: number | undefined;
}

export interface SearchPaging {
  limit: number;
  offset: number;
  includeSnippets: boolean;
}

export interface SearchResult {
  total: number;
  offset: number;
  returned: number;
  has_more: boolean;
  messages: MessageSummary[];
  /** Mailboxes searched (for all_mailboxes). */
  mailboxes_searched?: string[];
  /** Mailboxes that could not be searched (all_mailboxes), with the reason. */
  mailboxes_skipped?: Array<{ mailbox: string; reason: string }>;
}

export interface BuiltSearch {
  query: SearchObject;
  /** Exact colour to keep after the server search (keyword criteria can be silently dropped). */
  colorFilter: FlagColor | null;
  /** True when no user criterion was given (only UNDELETED). */
  empty: boolean;
}

function nonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim() !== '';
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function textCriterion(value: string, field: string): string {
  if (CONTROL.test(value)) throw new MailError('INVALID_INPUT', `${field} must not contain line breaks or control characters.`);
  return value.trim();
}

export function hasCriteria(c: SearchCriteria): boolean {
  return (
    nonEmpty(c.query) ||
    nonEmpty(c.from) ||
    nonEmpty(c.to) ||
    nonEmpty(c.subject) ||
    nonEmpty(c.body) ||
    nonEmpty(c.since) ||
    nonEmpty(c.before) ||
    c.newerThanDays !== undefined ||
    c.unread !== undefined ||
    c.flagged !== undefined ||
    c.answered !== undefined ||
    c.flagColor !== undefined ||
    (c.minSizeKb !== undefined && c.minSizeKb > 0)
  );
}

/**
 * Build the imapflow SearchObject. Dates become UTC-midnight Date objects so imapflow emits exactly
 * that calendar date for SINCE/BEFORE (WITHIN is disabled on the connection, see client.ts).
 */
export function buildSearchObject(c: SearchCriteria, options: { timeZone: string; now?: Date }): BuiltSearch {
  const q: SearchObject = { deleted: false };
  if (nonEmpty(c.query)) q.text = textCriterion(c.query, 'query');
  if (nonEmpty(c.from)) q.from = textCriterion(c.from, 'from');
  if (nonEmpty(c.to)) {
    const v = textCriterion(c.to, 'to');
    q.or = [{ to: v }, { cc: v }];
  }
  if (nonEmpty(c.subject)) q.subject = textCriterion(c.subject, 'subject');
  if (nonEmpty(c.body)) q.body = textCriterion(c.body, 'body');

  let since: CalendarDate | null = nonEmpty(c.since) ? parseDateInput(c.since, 'since') : null;
  if (c.newerThanDays !== undefined) {
    if (!Number.isInteger(c.newerThanDays) || c.newerThanDays < 0) throw new MailError('INVALID_INPUT', 'newer_than_days must be a whole number >= 0.');
    const cutoff = addDays(todayIn(options.timeZone, options.now), -c.newerThanDays);
    if (!since || compareCalendarDates(cutoff, since) > 0) since = cutoff;
  }
  const before: CalendarDate | null = nonEmpty(c.before) ? parseDateInput(c.before, 'before') : null;
  if (since && before && compareCalendarDates(since, before) >= 0) {
    throw new MailError('INVALID_INPUT', 'since must be earlier than before (before is exclusive).');
  }
  if (since) q.since = calendarDateToUTC(since);
  if (before) q.before = calendarDateToUTC(before);

  if (c.unread !== undefined) q.seen = !c.unread;
  if (c.answered !== undefined) q.answered = c.answered;

  let colorFilter: FlagColor | null = null;
  if (c.flagColor !== undefined) {
    if (c.flagged === false) throw new MailError('INVALID_INPUT', 'flag_color cannot be combined with flagged: false.');
    colorFilter = c.flagColor;
    q.flagged = true;
    // Narrow on the server where possible; the exact bit combination is checked after fetching flags.
    const { add, remove } = colorKeywords(c.flagColor);
    if (add[0]) q.keyword = add[0];
    if (remove[0]) q.unKeyword = remove[0];
  } else if (c.flagged !== undefined) {
    q.flagged = c.flagged;
  }
  if (c.minSizeKb !== undefined && c.minSizeKb > 0) {
    if (!Number.isInteger(c.minSizeKb)) throw new MailError('INVALID_INPUT', 'min_size_kb must be a whole number.');
    q.larger = c.minSizeKb * 1024 - 1;
  }
  return { query: q, colorFilter, empty: !hasCriteria(c) };
}

/** Unique UIDs sorted descending (newest first). */
export function sortUidsDesc(uids: Iterable<number>): number[] {
  return [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0).sort((a, b) => b - a);
}

/** Run a UID SEARCH in the selected mailbox; result is unique and sorted newest-first. */
export async function searchUids(client: ImapFlow, query: SearchObject): Promise<number[]> {
  // Keep SINCE/BEFORE date-only even if a later CAPABILITY refresh re-announced WITHIN (see client.ts).
  client.capabilities.delete('WITHIN');
  const result = await client.search(query, { uid: true });
  if (result === false || result === undefined) {
    throw new MailError('SERVER', 'The IMAP server did not return search results.');
  }
  return sortUidsDesc(result);
}

/** Keep only UIDs whose flags match the exact Apple Mail colour. */
export async function filterByColor(client: ImapFlow, uids: readonly number[], color: FlagColor): Promise<number[]> {
  if (uids.length === 0) return [];
  const msgs = await client.fetchAll([...uids], { uid: true, flags: true }, { uid: true });
  const keep = new Set(msgs.filter((m) => flagColorFromFlags(m.flags ?? []) === color).map((m) => m.uid));
  return uids.filter((u) => keep.has(u));
}

/** Compress UIDs into an IMAP sequence set string ("1:3,7,9:10"). */
export function toSequenceSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const u of sorted) {
    if (start === undefined) {
      start = prev = u;
      continue;
    }
    if (prev !== undefined && u === prev + 1) {
      prev = u;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = prev = u;
  }
  if (start !== undefined) ranges.push(start === prev ? `${start}` : `${start}:${prev}`);
  return ranges.join(',');
}

interface MailboxPage {
  total: number;
  records: SummaryRecord[];
}

/**
 * One mailbox: returns the matching total and the summary records for UIDs [offset, offset+limit)
 * newest first. With `window` (all_mailboxes) the top `window` records are returned instead.
 */
async function searchOneMailbox(
  imap: ImapManager,
  mailbox: MailboxInfo,
  built: BuiltSearch,
  range: { offset: number; limit: number },
  options: { snippets: boolean; timeZone: string },
): Promise<MailboxPage> {
  return imap.withMailbox(
    mailbox.path,
    async (client, box) => {
      if (built.empty) {
        // No criteria: newest `limit` by sequence window from EXISTS, without SEARCH (SPEC §6.1).
        // The mailbox may have been selected earlier on this connection; NOOP collects any EXISTS
        // updates for mail that arrived since, so the window really ends at the newest message.
        await client.noop();
        const exists = client.mailbox && client.mailbox.path === box.path ? client.mailbox.exists : box.exists;
        const seqTo = exists - range.offset;
        const seqFrom = Math.max(1, seqTo - range.limit + 1);
        const records = seqTo >= 1 ? await fetchSummaryRecordsBySeq(client, mailbox.path, seqFrom, seqTo, options) : [];
        return { total: exists, records };
      }
      let uids = await searchUids(client, built.query);
      if (built.colorFilter) uids = await filterByColor(client, uids, built.colorFilter);
      const page = uids.slice(range.offset, range.offset + range.limit);
      const records = await fetchSummaryRecords(client, mailbox.path, page, options);
      return { total: uids.length, records };
    },
    { readOnly: true },
  );
}

export interface SearchParams extends SearchCriteria, SearchPaging {
  /** Resolved mailbox (ignored with allMailboxes). */
  mailbox?: MailboxInfo;
  allMailboxes?: boolean;
}

export async function searchMessages(imap: ImapManager, registry: MailboxRegistry, config: Pick<Config, 'timezone'>, params: SearchParams): Promise<SearchResult> {
  const limit = params.limit;
  const offset = params.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MailError('INVALID_INPUT', 'limit must be between 1 and 100.');
  if (!Number.isInteger(offset) || offset < 0) throw new MailError('INVALID_INPUT', 'offset must be 0 or more.');
  const built = buildSearchObject(params, { timeZone: config.timezone });

  if (!params.allMailboxes) {
    const mailbox = params.mailbox ?? (await registry.inbox());
    const { total, records } = await searchOneMailbox(imap, mailbox, built, { offset, limit }, { snippets: params.includeSnippets, timeZone: config.timezone });
    const messages = records.map((r) => r.summary);
    return { total, offset, returned: messages.length, has_more: offset + messages.length < total, messages };
  }

  const mailboxes = await registry.searchableMailboxes();
  const window = offset + limit;
  let total = 0;
  const all: SummaryRecord[] = [];
  // One mailbox after another on the one connection; snippets are fetched only for the final page.
  const skipped: Array<{ mailbox: string; reason: string }> = [];
  for (const mb of mailboxes) {
    let page: MailboxPage;
    try {
      page = await searchOneMailbox(imap, mb, built, { offset: 0, limit: window }, { snippets: false, timeZone: config.timezone });
    } catch (err) {
      // A folder that vanished or refuses SELECT should not sink the whole search.
      if (err instanceof MailError && (err.code === 'NOT_FOUND' || err.code === 'SERVER')) {
        skipped.push({ mailbox: mb.path, reason: err.message });
        continue;
      }
      throw err;
    }
    total += page.total;
    all.push(...page.records);
  }
  all.sort(compareRecordsDesc);
  const pageRecords = all.slice(offset, offset + limit);
  if (params.includeSnippets && pageRecords.length) {
    const byMailbox = new Map<string, SummaryRecord[]>();
    for (const r of pageRecords) {
      const list = byMailbox.get(r.summary.mailbox) ?? [];
      list.push(r);
      byMailbox.set(r.summary.mailbox, list);
    }
    for (const [path, recs] of byMailbox) {
      const withSnippets = await imap.withMailbox(
        path,
        (client) => fetchSummaryRecords(client, path, recs.map((r) => r.summary.uid), { snippets: true, timeZone: config.timezone }),
        { readOnly: true },
      );
      const snippetByUid = new Map(withSnippets.map((r) => [r.summary.uid, r.summary.snippet]));
      for (const r of recs) r.summary.snippet = snippetByUid.get(r.summary.uid) ?? '';
    }
  }
  const messages = pageRecords.map((r) => r.summary);
  const result: SearchResult = {
    total,
    offset,
    returned: messages.length,
    has_more: offset + messages.length < total,
    messages,
    mailboxes_searched: mailboxes.filter((m) => !skipped.some((s) => s.mailbox === m.path)).map((m) => m.path),
  };
  if (skipped.length) result.mailboxes_skipped = skipped;
  return result;
}

