/**
 * CalendarService: the read-only calendar tools' domain layer (list_calendars, search_events,
 * get_event). It owns the CalDAV client for one login and lives inside MailService, so the cloud
 * handler's per-login service cache keeps discovery and caches warm too.
 *
 * Range searches send two REPORTs per calendar: a time-range query (widened by a day on each side,
 * because floating and all-day times are compared in UTC by the server) and a query for every
 * event with an RRULE. The second one makes recurring events independent of whether the server
 * expands recurrences when it applies a time-range filter (iCloud's support for that is unreliable);
 * its result is cached per calendar until the calendar's ctag changes. Everything is then expanded
 * and filtered exactly on the client (ical.ts).
 */
import type tls from 'node:tls';
import type { Config } from '../config.js';
import type { CredentialProvider } from '../credentials.js';
import { MailError } from '../errors.js';
import { addDays, formatCalendarDate, formatDateISO, todayIn, zonedMidnight, type CalendarDate } from '../format.js';
import { redact, type Logger } from '../log.js';
import { sanitizeInline } from '../safety/untrusted.js';
import { CalDavClient, type CalendarInfo, type CalendarObject, type HttpFn } from './caldav.js';
import { expandObject, findOccurrence, parseObject, seriesOccurrence, textProp, wallTimeToMs, type Occurrence, type ParsedObject } from './ical.js';

/** Longest range one search may cover. */
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 7;
const DAY_MS = 86_400_000;
const CALENDAR_LIST_TTL_MS = 60_000;
const CALENDAR_CONCURRENCY = 4;

export interface CalendarServiceOptions {
  config: Config;
  credentials: CredentialProvider;
  tlsOptions: () => tls.ConnectionOptions;
  logger: Logger;
  /** Throws the configuration error, if any (MailService.assertConfigured). */
  assertConfigured: () => void;
  http?: HttpFn;
  now?: () => number;
}

export interface CalendarListItem {
  id: string;
  name: string;
  href: string;
  color: string | null;
  description?: string;
  read_only?: boolean;
}

export interface EventSummary {
  calendar: string;
  calendar_id: string;
  href: string;
  uid: string;
  recurrence_id?: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
  recurring: boolean;
  status?: string;
}

export interface SearchEventsParams {
  start?: string | undefined;
  end?: string | undefined;
  query?: string | undefined;
  calendars?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SearchEventsResult {
  range: { start: string; end: string; timezone: string };
  calendars_searched: string[];
  total: number;
  returned: number;
  offset: number;
  has_more: boolean;
  events: EventSummary[];
  note?: string;
}

export interface EventView {
  calendar: CalendarInfo | null;
  occurrence: Occurrence;
  /** The occurrence was asked for and is an edited instance of the series. */
  modified: boolean;
  overrideCount: number;
  timezone: string;
  maxNotesChars: number;
}

/** Untrusted calendar text as one safe line (no line breaks, invisible characters or markers). */
function oneLine(text: string | null | undefined, max: number): string {
  return sanitizeInline(text, max);
}

interface ParsedBound {
  ms: number;
  label: string;
}

/**
 * A range bound: YYYY-MM-DD (a whole day in the user's zone; as an end, the day is included) or an
 * ISO datetime (with an offset, or else in the user's zone).
 */
export function parseBound(input: string, field: string, timeZone: string, isEnd: boolean): ParsedBound {
  const s = input.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const bad = (): MailError => new MailError('INVALID_INPUT', `${field} must be a date like 2026-11-13 or an ISO datetime like 2026-11-13T09:00:00-05:00; got "${input}".`);
  if (date) {
    const d: CalendarDate = { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) };
    const check = new Date(Date.UTC(d.year, d.month - 1, d.day));
    if (check.getUTCFullYear() !== d.year || check.getUTCMonth() !== d.month - 1 || check.getUTCDate() !== d.day) throw bad();
    return isEnd ? { ms: zonedMidnight(addDays(d, 1), timeZone), label: formatCalendarDate(d) } : { ms: zonedMidnight(d, timeZone), label: formatCalendarDate(d) };
  }
  const dt = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!dt) throw bad();
  let ms: number;
  if (dt[7]) ms = Date.parse(s.replace(' ', 'T'));
  else ms = wallTimeToMs({ year: Number(dt[1]), month: Number(dt[2]), day: Number(dt[3]), hour: Number(dt[4]), minute: Number(dt[5]), second: Number(dt[6] ?? '0') }, timeZone);
  if (Number.isNaN(ms)) throw bad();
  return { ms, label: formatDateISO(ms, timeZone) ?? s };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class CalendarService {
  readonly client: CalDavClient;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly assertConfigured: () => void;
  private readonly now: () => number;
  private calendarCache: { at: number; list: CalendarInfo[] } | null = null;
  private readonly recurringCache = new Map<string, { ctag: string; objects: CalendarObject[] }>();

  constructor(opts: CalendarServiceOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.assertConfigured = opts.assertConfigured;
    this.now = opts.now ?? Date.now;
    this.client = new CalDavClient({
      baseUrl: opts.config.caldavUrl,
      user: () => opts.config.email,
      credentials: opts.credentials,
      tlsOptions: opts.tlsOptions,
      logger: opts.logger,
      ...(opts.http ? { http: opts.http } : {}),
    });
  }

  close(): void {
    this.client.close();
  }

  private async calendars(fresh = false): Promise<CalendarInfo[]> {
    this.assertConfigured();
    const cached = this.calendarCache;
    if (!fresh && cached && this.now() - cached.at < CALENDAR_LIST_TTL_MS) return cached.list;
    const list = await this.client.listCalendars();
    this.calendarCache = { at: this.now(), list };
    return list;
  }

  async listCalendars(): Promise<{ count: number; calendars: CalendarListItem[] }> {
    const list = await this.calendars(true);
    return {
      count: list.length,
      calendars: list.map((c) => ({
        id: oneLine(c.id, 200),
        name: oneLine(c.name, 200),
        href: c.href,
        color: c.color,
        ...(c.description ? { description: oneLine(c.description, 300) } : {}),
        ...(c.readOnly ? { read_only: true } : {}),
      })),
    };
  }

  /** Calendars matching the caller's names/ids/hrefs (all when none given). */
  private select(all: CalendarInfo[], wanted: string[] | undefined): CalendarInfo[] {
    if (!wanted || wanted.length === 0) return all;
    const out: CalendarInfo[] = [];
    const unknown: string[] = [];
    for (const w of wanted) {
      const key = w.trim().toLowerCase();
      const match = all.filter((c) => c.id.toLowerCase() === key || c.href.toLowerCase() === key || c.href.toLowerCase() === `${key}/` || c.name.toLowerCase() === key);
      if (match.length === 0) unknown.push(w);
      for (const m of match) if (!out.includes(m)) out.push(m);
    }
    if (unknown.length) {
      const names = all.map((c) => `"${oneLine(c.name, 60)}" (id ${c.id})`).join(', ');
      throw new MailError('INVALID_INPUT', `Unknown calendar${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => `"${oneLine(u, 100)}"`).join(', ')}. Available: ${names || 'none'}. Use list_calendars to see them.`);
    }
    return out;
  }

  private async recurringObjects(calendar: CalendarInfo): Promise<CalendarObject[]> {
    const cached = this.recurringCache.get(calendar.href);
    if (cached && calendar.ctag && cached.ctag === calendar.ctag) return cached.objects;
    try {
      const objects = await this.client.queryRecurring(calendar);
      if (calendar.ctag) this.recurringCache.set(calendar.href, { ctag: calendar.ctag, objects });
      return objects;
    } catch (err) {
      // Only a server that rejects the filter is tolerated: the range query still finds what it can.
      if (err instanceof MailError && err.code === 'SERVER') {
        this.logger.info('recurring-event query not supported; relying on the time-range query', { calendar: calendar.id, err: redact(err.message) });
        return [];
      }
      throw err;
    }
  }

  async searchEvents(params: SearchEventsParams): Promise<SearchEventsResult> {
    this.assertConfigured();
    const tz = this.config.timezone;
    const today = todayIn(tz, new Date(this.now()));
    const start = params.start ? parseBound(params.start, 'start', tz, false) : { ms: zonedMidnight(today, tz), label: formatCalendarDate(today) };
    let end: ParsedBound;
    if (params.end) end = parseBound(params.end, 'end', tz, true);
    else {
      const ms = start.ms + DEFAULT_RANGE_DAYS * DAY_MS;
      end = { ms, label: formatDateISO(ms, tz) ?? '' };
    }
    if (end.ms <= start.ms) throw new MailError('INVALID_INPUT', `end (${end.label}) must be after start (${start.label}).`);
    if (end.ms - start.ms > (MAX_RANGE_DAYS + 1) * DAY_MS) throw new MailError('INVALID_INPUT', `The date range is longer than ${MAX_RANGE_DAYS} days; search a shorter range.`);
    const limit = Math.min(500, Math.max(1, Math.floor(params.limit ?? 50)));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const query = params.query?.trim().toLowerCase() || undefined;

    const all = await this.calendars();
    const selected = this.select(all, params.calendars);
    const range = { startMs: start.ms, endMs: end.ms };
    let skipped = 0;
    let truncatedSeries = 0;
    const perCalendar = await mapLimit(selected, CALENDAR_CONCURRENCY, async (cal) => {
      const [inRange, recurring] = await Promise.all([this.client.queryRange(cal, start.ms - DAY_MS, end.ms + DAY_MS), this.recurringObjects(cal)]);
      const byHref = new Map<string, CalendarObject>();
      for (const o of recurring) byHref.set(o.href, o);
      for (const o of inRange) byHref.set(o.href, o);
      const found: Array<{ cal: CalendarInfo; occ: Occurrence }> = [];
      for (const obj of byHref.values()) {
        let parsed: ParsedObject;
        try {
          parsed = parseObject(obj.href, obj.data);
        } catch {
          skipped++;
          continue;
        }
        try {
          const { occurrences, truncated } = expandObject(parsed, range, tz);
          if (truncated) truncatedSeries++;
          for (const occ of occurrences) found.push({ cal, occ });
        } catch (err) {
          skipped++;
          this.logger.warn('could not expand a calendar event', { calendar: cal.id, err: redact(err instanceof Error ? err.message : String(err)) });
        }
      }
      return found;
    });
    let hits = perCalendar.flat();
    if (query) {
      hits = hits.filter(({ occ }) =>
        ['summary', 'location', 'description'].some((p) => (textProp(occ.component, p) ?? (occ.master && occ.master !== occ.component ? textProp(occ.master, p) : null) ?? '').toLowerCase().includes(query)),
      );
    }
    hits.sort((a, b) => a.occ.startMs - b.occ.startMs || a.occ.endMs - b.occ.endMs || a.cal.name.localeCompare(b.cal.name));
    const page = hits.slice(offset, offset + limit);
    const notes: string[] = [];
    if (skipped) notes.push(`${skipped} event${skipped === 1 ? '' : 's'} could not be read and ${skipped === 1 ? 'was' : 'were'} skipped.`);
    if (truncatedSeries) notes.push(`${truncatedSeries} repeating event${truncatedSeries === 1 ? ' repeats' : 's repeat'} so often that not every occurrence could be listed.`);
    return {
      range: { start: formatDateISO(start.ms, tz) ?? start.label, end: formatDateISO(end.ms, tz) ?? end.label, timezone: tz },
      calendars_searched: selected.map((c) => oneLine(c.name, 200)),
      total: hits.length,
      returned: page.length,
      offset,
      has_more: offset + page.length < hits.length,
      events: page.map(({ cal, occ }) => this.summary(cal, occ)),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  private summary(cal: CalendarInfo, occ: Occurrence): EventSummary {
    const tz = this.config.timezone;
    const c = occ.component;
    const fallback = (name: string): string | null => textProp(c, name) ?? (occ.master && occ.master !== c ? textProp(occ.master, name) : null);
    const status = (textProp(c, 'status') ?? '').toLowerCase();
    const location = oneLine(fallback('location'), 300);
    return {
      calendar: oneLine(cal.name, 200),
      calendar_id: oneLine(cal.id, 200),
      href: occ.href,
      uid: occ.uid,
      ...(occ.recurrenceId ? { recurrence_id: occ.recurrenceId } : {}),
      title: oneLine(fallback('summary'), 300) || '(no title)',
      start: occ.allDay && occ.startDate ? formatCalendarDate(occ.startDate) : (formatDateISO(occ.startMs, tz) ?? ''),
      end: occ.allDay && occ.lastDate ? formatCalendarDate(occ.lastDate) : (formatDateISO(occ.endMs, tz) ?? ''),
      all_day: occ.allDay,
      ...(location ? { location } : {}),
      recurring: occ.recurring,
      ...(status && status !== 'confirmed' ? { status } : {}),
    };
  }

  async getEvent(params: { href: string; occurrence?: string | undefined }): Promise<EventView> {
    this.assertConfigured();
    const tz = this.config.timezone;
    const object = await this.client.getObject(params.href);
    const parsed = parseObject(object.href, object.data);
    let occurrence: Occurrence;
    let modified = false;
    if (params.occurrence) {
      const found = findOccurrence(parsed, params.occurrence, tz);
      if (!found) throw new MailError('NOT_FOUND', `This event has no occurrence starting at ${params.occurrence} (it may have been deleted or the series changed); search again to get current recurrence_id values.`);
      occurrence = found;
      modified = found.component !== parsed.master;
    } else {
      occurrence = seriesOccurrence(parsed, tz);
    }
    let calendar: CalendarInfo | null = null;
    try {
      const all = await this.calendars();
      calendar = all.filter((c) => object.href.startsWith(c.href)).sort((a, b) => b.href.length - a.href.length)[0] ?? null;
    } catch {
      // The event itself was read; the calendar name is only a label.
    }
    return { calendar, occurrence, modified, overrideCount: parsed.overrides.length, timezone: tz, maxNotesChars: this.config.maxBodyChars };
  }
}
