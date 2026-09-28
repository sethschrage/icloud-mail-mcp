/**
 * search_messages (SPEC §6.1 #2): criteria building, date-ordered paging, cross-mailbox merge.
 *
 * Rules: always UNDELETED; UIDs sorted numerically on the client (iCloud may return them out of
 * order, and its SORT is a no-op).
 *
 * Ordering. UID order is the order messages were filed into a folder, not their date: in Archive
 * or any folder filled by moving mail, recently filed old mail would come first. So each
 * mailbox's matches are ranked by INTERNALDATE (arrival date, preserved by COPY), newest first,
 * with one cheap FETCH of UID + INTERNALDATE (+ FLAGS) for up to DATE_SORT_MAX matches. Only a
 * mailbox with more matches than that falls back to arrival (UID) order, and the result says so.
 *
 * Dates. IMAP SINCE/BEFORE compare the date part of INTERNALDATE in the server's own time zone,
 * which need not be the user's. The server search therefore uses a window widened by one day on
 * each side, and matches are then filtered on the client against local midnight in MAIL_TIMEZONE.
 *
 * all_mailboxes: every mailbox contributes its top (offset + limit) matches by that same date key,
 * the lists are merged by date, and full summaries are fetched only for the final page. offset +
 * limit is capped at ALL_MAILBOXES_MAX_WINDOW.
 */
import type { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import type { Config } from '../config.js';
import { MailError } from '../errors.js';
import { addDays, calendarDateToUTC, compareCalendarDates, parseDateInput, todayIn, toValidDate, zonedMidnight, type CalendarDate } from '../format.js';
import type { ImapManager } from './client.js';
import { fetchSummaryRecords, type MessageSummary, type SummaryRecord } from './fetch.js';
import { DELETED, colorKeywords, flagColorFromFlags, hasFlag, type FlagColor } from './flags.js';
import type { MailboxInfo, MailboxRegistry } from './mailboxes.js';
import { chunks, searchStrict, toSequenceSet } from './uids.js';

export { searchStrict, sortUidsDesc, toSequenceSet } from './uids.js';

/** Matches per mailbox that are ranked by arrival date; above this, arrival (UID) order is used. */
export const DATE_SORT_MAX = 5000;
/** all_mailboxes: offset + limit must not exceed this. */
export const ALL_MAILBOXES_MAX_WINDOW = 1000;
/** UIDs per FETCH command when ranking (keeps command lines reasonable). */
const FETCH_CHUNK = 2000;

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
  /** Present when some matches could not be ranked by date (very large result sets). */
  ordering_note?: string;
  /** Mailboxes searched (for all_mailboxes). */
  mailboxes_searched?: string[];
  /** Mailboxes that could not be searched (all_mailboxes), with the reason. */
  mailboxes_skipped?: Array<{ mailbox: string; reason: string }>;
  /** all_mailboxes: the folders it leaves out (Trash, Junk, Notes). */
  mailboxes_not_searched?: string[];
  /** all_mailboxes with few results: matches in the folders it leaves out. */
  excluded_matches?: Record<string, number>;
  note?: string;
}

export interface DateRange {
  /** Epoch ms of local midnight at the start of `since` (inclusive), or null. */
  start: number | null;
  /** Epoch ms of local midnight at the start of `before` (exclusive), or null. */
  end: number | null;
  since: CalendarDate | null;
  before: CalendarDate | null;
}

export interface BuiltSearch {
  /** Server query, with SINCE/BEFORE widened by one day on each side. */
  query: SearchObject;
  /** Exact colour to keep after the server search (keyword criteria can be silently dropped). */
  colorFilter: FlagColor | null;
  /** Local-calendar date bounds applied to INTERNALDATE on the client, or null. */
  range: DateRange | null;
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
 * that calendar date for SINCE/BEFORE (WITHIN is disabled on the connection, see client.ts); the
 * window is one day wider on each side than asked, and `range` holds the exact local bounds.
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
  let range: DateRange | null = null;
  if (since || before) {
    if (since) q.since = calendarDateToUTC(addDays(since, -1));
    if (before) q.before = calendarDateToUTC(addDays(before, 1));
    range = {
      start: since ? zonedMidnight(since, options.timeZone) : null,
      end: before ? zonedMidnight(before, options.timeZone) : null,
      since,
      before,
    };
  }

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
  return { query: q, colorFilter, range, empty: !hasCriteria(c) };
}

/** Run a UID SEARCH in the selected mailbox; result is unique and sorted newest-first. */
export async function searchUids(client: ImapFlow, query: SearchObject): Promise<number[]> {
  return searchStrict(client, query);
}

/** True if an INTERNALDATE (epoch ms) lies within the local date range. */
export function inDateRange(time: number, range: Pick<DateRange, 'start' | 'end'> | null): boolean {
  if (!range) return true;
  if (range.start !== null && time < range.start) return false;
  if (range.end !== null && time >= range.end) return false;
  return true;
}

/** Keep only UIDs whose flags match the exact Apple Mail colour. */
export async function filterByColor(client: ImapFlow, uids: readonly number[], color: FlagColor): Promise<number[]> {
  if (uids.length === 0) return [];
  const keep = new Set<number>();
  for (const part of chunks([...uids], FETCH_CHUNK)) {
    const msgs = await client.fetchAll(toSequenceSet(part), { uid: true, flags: true }, { uid: true });
    for (const m of msgs) if (flagColorFromFlags(m.flags ?? []) === color) keep.add(m.uid);
  }
  return uids.filter((u) => keep.has(u));
}

/** One ranked match: UID plus arrival time (INTERNALDATE, epoch ms; 0 when unknown). */
export interface Candidate {
  uid: number;
  time: number;
}

/** Newest first by arrival time, then by UID. */
export function compareCandidatesDesc(a: Candidate, b: Candidate): number {
  return b.time - a.time || b.uid - a.uid;
}

function internalTime(m: Pick<FetchMessageObject, 'internalDate'>): number {
  return toValidDate(m.internalDate ?? null)?.getTime() ?? 0;
}

/** UID + INTERNALDATE (+ FLAGS) for `uids`, in chunks. */
async function fetchArrival(client: ImapFlow, uids: readonly number[], withFlags: boolean): Promise<FetchMessageObject[]> {
  const out: FetchMessageObject[] = [];
  for (const part of chunks([...uids], FETCH_CHUNK)) {
    out.push(...(await client.fetchAll(toSequenceSet(part), withFlags ? { uid: true, internalDate: true, flags: true } : { uid: true, internalDate: true }, { uid: true })));
  }
  return out;
}

/** Matches of one mailbox. `byDate` false means `ranked` is in arrival (UID) order, not date order. */
export interface RankedMailbox {
  total: number;
  /** Matches, newest first (all of them, or at least the first `need`). */
  ranked: Candidate[];
  byDate: boolean;
  /** `total` is an estimate (a very large mailbox listed without criteria). */
  approximateTotal: boolean;
}

/**
 * Rank one mailbox's matches (SPEC §6.1, see the module comment). `need` is how many of the top
 * matches the caller will use (offset + limit); only those are guaranteed to be present.
 */
export async function rankMailbox(client: ImapFlow, built: BuiltSearch, need: number, box: { exists: number }): Promise<RankedMailbox> {
  if (built.empty) return rankWithoutCriteria(client, need, box);
  const uids = await searchStrict(client, built.query);
  if (uids.length <= DATE_SORT_MAX) {
    const msgs = await fetchArrival(client, uids, built.colorFilter !== null);
    const ranked = msgs
      .filter((m) => (built.colorFilter ? flagColorFromFlags(m.flags ?? []) === built.colorFilter : true))
      .map((m) => ({ uid: m.uid, time: internalTime(m) }))
      .filter((c) => inDateRange(c.time, built.range))
      .sort(compareCandidatesDesc);
    return { total: ranked.length, ranked, byDate: true, approximateTotal: false };
  }
  // Too many matches to rank by date: arrival (UID) order, with the exact filters still applied.
  let kept = uids;
  if (built.colorFilter) kept = await filterByColor(client, kept, built.colorFilter);
  if (built.range) {
    const edge = await dateEdgeUids(client, built);
    if (edge.length) {
      const keptSet = new Set(kept);
      const outside = new Set((await fetchArrival(client, edge.filter((u) => keptSet.has(u)), false)).filter((m) => !inDateRange(internalTime(m), built.range)).map((m) => m.uid));
      if (outside.size) kept = kept.filter((u) => !outside.has(u));
    }
  }
  // Arrival times of the part the caller will show, so a cross-mailbox merge can use them.
  const top = kept.slice(0, need);
  const times = new Map((await fetchArrival(client, top, false)).map((m) => [m.uid, internalTime(m)]));
  const ranked = kept.map((uid) => ({ uid, time: times.get(uid) ?? 0 }));
  return { total: ranked.length, ranked, byDate: false, approximateTotal: false };
}

/**
 * UIDs whose server-side date lies within a day of a requested bound: only these can be on the
 * wrong side of the local-midnight boundary (time-zone offsets are under a day).
 */
async function dateEdgeUids(client: ImapFlow, built: BuiltSearch): Promise<number[]> {
  const r = built.range;
  if (!r) return [];
  const bands: SearchObject[] = [];
  if (r.since) bands.push({ ...built.query, before: calendarDateToUTC(addDays(r.since, 1)) });
  if (r.before) bands.push({ ...built.query, since: calendarDateToUTC(addDays(r.before, -1)) });
  const out = new Set<number>();
  for (const b of bands) for (const u of await searchStrict(client, b)) out.add(u);
  return [...out];
}

/**
 * No criteria: list the mailbox's live messages without SEARCH. Messages flagged \Deleted (by
 * another client, not yet expunged) still count in EXISTS; they are fetched with their flags and
 * dropped, so totals and pages only ever contain live messages.
 */
async function rankWithoutCriteria(client: ImapFlow, need: number, box: { exists: number }): Promise<RankedMailbox> {
  // The mailbox may have been selected earlier on this connection; NOOP collects any EXISTS
  // updates for mail that arrived since, so the listing really ends at the newest message.
  await client.noop();
  const exists = client.mailbox && typeof client.mailbox.exists === 'number' ? client.mailbox.exists : box.exists;
  if (exists <= 0) return { total: 0, ranked: [], byDate: true, approximateTotal: false };
  const live = (msgs: FetchMessageObject[]): FetchMessageObject[] => msgs.filter((m) => !hasFlag(m.flags ?? [], DELETED));
  if (exists <= DATE_SORT_MAX) {
    // Sequence numbers come from the server's own EXISTS count, never from user input.
    const msgs = await client.fetchAll(`1:${exists}`, { uid: true, internalDate: true, flags: true });
    const ranked = live(msgs)
      .map((m) => ({ uid: m.uid, time: internalTime(m) }))
      .sort(compareCandidatesDesc);
    return { total: ranked.length, ranked, byDate: true, approximateTotal: false };
  }
  // Very large mailbox: arrival order. Widen the window downward until `need` live messages are in it.
  let span = Math.max(need * 2, 200);
  for (;;) {
    const from = Math.max(1, exists - span + 1);
    const msgs = await client.fetchAll(`${from}:${exists}`, { uid: true, internalDate: true, flags: true });
    const alive = live(msgs);
    const deletedSeen = msgs.length - alive.length;
    if (alive.length >= need || from === 1) {
      const ranked = alive.map((m) => ({ uid: m.uid, time: internalTime(m) })).sort((a, b) => b.uid - a.uid);
      return { total: Math.max(ranked.length, exists - deletedSeen), ranked, byDate: false, approximateTotal: from > 1 && deletedSeen > 0 };
    }
    span *= 2;
  }
}

interface MailboxPage {
  total: number;
  records: SummaryRecord[];
  byDate: boolean;
  approximateTotal: boolean;
}

/** One mailbox: the matching total and the summary records for matches [offset, offset+limit). */
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
      const r = await rankMailbox(client, built, range.offset + range.limit, box);
      const page = r.ranked.slice(range.offset, range.offset + range.limit).map((c) => c.uid);
      const records = await fetchSummaryRecords(client, mailbox.path, page, options);
      return { total: r.total, records, byDate: r.byDate, approximateTotal: r.approximateTotal };
    },
    { readOnly: true },
  );
}

export interface SearchParams extends SearchCriteria, SearchPaging {
  /** Resolved mailbox (ignored with allMailboxes). */
  mailbox?: MailboxInfo;
  allMailboxes?: boolean;
  /** Test seam for "today" (newer_than_days). */
  now?: Date;
}

const ARRIVAL_ORDER_NOTE =
  'More messages matched than can be sorted by date, so these are ordered by when they arrived in the folder (usually, but not always, date order). Narrow the search (since/before, from, subject) for exact date order.';

export async function searchMessages(imap: ImapManager, registry: MailboxRegistry, config: Pick<Config, 'timezone'>, params: SearchParams): Promise<SearchResult> {
  const limit = params.limit;
  const offset = params.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new MailError('INVALID_INPUT', 'limit must be between 1 and 100.');
  if (!Number.isInteger(offset) || offset < 0) throw new MailError('INVALID_INPUT', 'offset must be 0 or more.');
  const built = buildSearchObject(params, params.now ? { timeZone: config.timezone, now: params.now } : { timeZone: config.timezone });

  if (!params.allMailboxes) {
    const mailbox = params.mailbox ?? (await registry.inbox());
    const page = await searchOneMailbox(imap, mailbox, built, { offset, limit }, { snippets: params.includeSnippets, timeZone: config.timezone });
    const messages = page.records.map((r) => r.summary);
    const result: SearchResult = { total: page.total, offset, returned: messages.length, has_more: offset + messages.length < page.total, messages };
    if (!page.byDate) result.ordering_note = ARRIVAL_ORDER_NOTE;
    if (page.approximateTotal) result.note = 'total is an estimate for this very large folder.';
    return result;
  }

  const window = offset + limit;
  if (window > ALL_MAILBOXES_MAX_WINDOW) {
    throw new MailError(
      'INVALID_INPUT',
      `With all_mailboxes, offset + limit can be at most ${ALL_MAILBOXES_MAX_WINDOW} (got ${window}). Narrow the search (since/before, from, subject) or search one mailbox, where deeper paging works.`,
    );
  }
  const mailboxes = await registry.searchableMailboxes();
  let total = 0;
  let allByDate = true;
  const merged: Array<Candidate & { mailbox: string }> = [];
  // One mailbox after another on the one connection; only UID + arrival date per candidate.
  const skipped: Array<{ mailbox: string; reason: string }> = [];
  for (const mb of mailboxes) {
    let ranked: RankedMailbox;
    try {
      ranked = await imap.withMailbox(mb.path, (client, box) => rankMailbox(client, built, window, box), { readOnly: true });
    } catch (err) {
      // A folder that vanished or refuses SELECT/SEARCH should not sink the whole search.
      if (err instanceof MailError && (err.code === 'NOT_FOUND' || err.code === 'SERVER')) {
        skipped.push({ mailbox: mb.path, reason: err.message });
        continue;
      }
      throw err;
    }
    total += ranked.total;
    if (!ranked.byDate) allByDate = false;
    for (const c of ranked.ranked.slice(0, window)) merged.push({ ...c, mailbox: mb.path });
  }
  merged.sort((a, b) => compareCandidatesDesc(a, b) || (a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : 0));
  const pageCandidates = merged.slice(offset, offset + limit);
  // Full summaries (and snippets) only for the final page, grouped by mailbox.
  const byMailbox = new Map<string, number[]>();
  for (const c of pageCandidates) byMailbox.set(c.mailbox, [...(byMailbox.get(c.mailbox) ?? []), c.uid]);
  const records = new Map<string, SummaryRecord>();
  for (const [path, uids] of byMailbox) {
    const recs = await imap.withMailbox(path, (client) => fetchSummaryRecords(client, path, uids, { snippets: params.includeSnippets, timeZone: config.timezone }), { readOnly: true });
    for (const r of recs) records.set(`${path}\u0000${r.summary.uid}`, r);
  }
  const messages = pageCandidates.map((c) => records.get(`${c.mailbox}\u0000${c.uid}`)?.summary).filter((m): m is MessageSummary => m !== undefined);
  const result: SearchResult = {
    total,
    offset,
    returned: messages.length,
    has_more: offset + messages.length < total,
    messages,
    mailboxes_searched: mailboxes.filter((m) => !skipped.some((s) => s.mailbox === m.path)).map((m) => m.path),
  };
  if (!allByDate) result.ordering_note = ARRIVAL_ORDER_NOTE;
  if (skipped.length) result.mailboxes_skipped = skipped;
  const excluded = await registry.excludedFromAllMailboxes();
  if (excluded.length) {
    result.mailboxes_not_searched = excluded.map((m) => m.path);
    // Few or no results: say whether Junk / Trash hold matches, so "not found" is not concluded too early.
    if (total < limit) {
      const counts: Record<string, number> = {};
      for (const mb of excluded) {
        try {
          const n = await imap.withMailbox(mb.path, async (client, box) => (await rankMailbox(client, built, 0, box)).total, { readOnly: true });
          if (n > 0) counts[mb.path] = n;
        } catch (err) {
          if (!(err instanceof MailError) || (err.code !== 'NOT_FOUND' && err.code !== 'SERVER')) throw err;
        }
      }
      if (Object.keys(counts).length) {
        result.excluded_matches = counts;
        result.note = `Also matching in folders all_mailboxes leaves out: ${Object.entries(counts)
          .map(([p, n]) => `${n} in ${p}`)
          .join(', ')} (not included above; search them by naming them in mailbox).`;
      }
    }
  }
  return result;
}
