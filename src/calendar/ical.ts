/**
 * iCalendar parsing and recurrence expansion (ical.js).
 *
 * One CalDAV calendar object holds one event: a master VEVENT (with RRULE/RDATE/EXDATE when it
 * repeats) plus override VEVENTs carrying a RECURRENCE-ID for single occurrences that were moved or
 * edited. Expansion happens here, on the client, because iCloud does not reliably expand
 * recurrences server-side (CalDAV `<C:expand>`); see docs/SPEC.md §11.
 *
 * Instants: an ICAL.Time is a wall-clock time in some zone. Times with an IANA TZID (what Apple
 * writes) are converted with the platform's time-zone database (Intl), not the VTIMEZONE block;
 * custom TZIDs (e.g. Outlook's "Eastern Standard Time") use their VTIMEZONE through ical.js;
 * floating times and all-day dates are taken in the display time zone (MAIL_TIMEZONE).
 */
import ICAL from 'ical.js';
import { isValidTimezone } from '../config.js';
import { MailError } from '../errors.js';
import { formatCalendarDate, formatDateISO, zonedMidnight, zonedParts, type CalendarDate } from '../format.js';

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;
type Event = InstanceType<typeof ICAL.Event>;
type Duration = InstanceType<typeof ICAL.Duration>;

/** Most occurrences of one series walked through per call (a minutely rule over years stops here). */
export const MAX_ITERATIONS = 50_000;
const DAY_MS = 86_400_000;

export interface Range {
  startMs: number;
  endMs: number;
}

export interface ParsedObject {
  href: string;
  uid: string;
  /** The VEVENT without RECURRENCE-ID (absent for an invitation to single occurrences only). */
  master: Component | null;
  overrides: Component[];
}

export interface Occurrence {
  href: string;
  uid: string;
  /** Component that describes this occurrence (an override, or the master). */
  component: Component;
  master: Component | null;
  /** Original start of a recurring occurrence, as shown to Claude (null for a single event). */
  recurrenceId: string | null;
  recurring: boolean;
  allDay: boolean;
  startMs: number;
  endMs: number;
  /** All-day events: first day and last day (inclusive). */
  startDate: CalendarDate | null;
  lastDate: CalendarDate | null;
  /** TZID of the event's start, when it has one. */
  tzid: string | null;
}

/** Wall-clock time in an IANA zone → epoch ms (DST-aware, like zonedMidnight). */
export function wallTimeToMs(parts: { year: number; month: number; day: number; hour: number; minute: number; second: number }, timeZone: string): number {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const first = guess - zonedParts(new Date(guess), timeZone).offsetMinutes * 60_000;
  return guess - zonedParts(new Date(first), timeZone).offsetMinutes * 60_000;
}

/** The TZID a time was written with (null for UTC, floating and dates). */
export function tzidOf(t: Time): string | null {
  if (t.isDate) return null;
  const zoneId = t.zone?.tzid;
  if (zoneId === 'UTC' || zoneId === 'Z' || zoneId === 'GMT') return null;
  if (zoneId && zoneId !== 'floating') return zoneId;
  const written = (t as unknown as { timezone?: unknown }).timezone;
  return typeof written === 'string' && written ? written : null;
}

/** Epoch ms of an ICAL.Time (see the module comment for how zones are resolved). */
export function timeToMs(t: Time, displayTz: string): number {
  if (t.isDate) return zonedMidnight({ year: t.year, month: t.month, day: t.day }, displayTz);
  const parts = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
  const zoneId = t.zone?.tzid;
  if (zoneId === 'UTC' || zoneId === 'Z' || zoneId === 'GMT') return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const tzid = tzidOf(t);
  if (tzid && isValidTimezone(tzid)) return wallTimeToMs(parts, tzid);
  if (tzid && zoneId && zoneId !== 'floating') return t.toUnixTime() * 1000;
  return wallTimeToMs(parts, displayTz);
}

/**
 * Make the VTIMEZONE definitions of an object known to ical.js (it resolves TZIDs through a global
 * registry). A definition already registered is kept: they describe the same zone.
 */
function registerTimezones(vcalendar: Component): void {
  for (const vtz of vcalendar.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string' || !tzid || ICAL.TimezoneService.has(tzid)) continue;
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      // A broken VTIMEZONE: times in it fall back to the TZID name or floating.
    }
  }
}

/** Parse one calendar object. Throws MailError('SERVER') for unparseable data. */
export function parseObject(href: string, data: string): ParsedObject {
  let vcalendar: Component;
  try {
    vcalendar = new ICAL.Component(ICAL.parse(data) as unknown as unknown[]);
  } catch (err) {
    throw new MailError('SERVER', `The calendar event ${href} could not be read (${err instanceof Error ? err.message.slice(0, 100) : 'invalid iCalendar data'}).`);
  }
  if (vcalendar.name !== 'vcalendar') {
    const inner = vcalendar.getFirstSubcomponent('vcalendar');
    if (inner) vcalendar = inner;
  }
  registerTimezones(vcalendar);
  const vevents = vcalendar.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id')) ?? null;
  const overrides = vevents.filter((v) => v.hasProperty('recurrence-id'));
  const uidValue = (master ?? overrides[0])?.getFirstPropertyValue('uid');
  return { href, uid: typeof uidValue === 'string' ? uidValue : '', master, overrides };
}

function isCancelled(c: Component): boolean {
  const s = c.getFirstPropertyValue('status');
  return typeof s === 'string' && s.toUpperCase() === 'CANCELLED';
}

function overlaps(startMs: number, endMs: number, range: Range): boolean {
  if (endMs <= startMs) return startMs >= range.startMs && startMs < range.endMs;
  return startMs < range.endMs && endMs > range.startMs;
}

function makeOccurrence(
  obj: ParsedObject,
  component: Component,
  start: Time,
  end: Time,
  recurring: boolean,
  recurrence: { ms: number; isDate: boolean } | null,
  displayTz: string,
): Occurrence {
  const allDay = start.isDate;
  const startMs = timeToMs(start, displayTz);
  let endMs = timeToMs(end, displayTz);
  if (endMs < startMs) endMs = startMs;
  let startDate: CalendarDate | null = null;
  let lastDate: CalendarDate | null = null;
  if (allDay) {
    startDate = { year: start.year, month: start.month, day: start.day };
    const endDay = end.isDate ? { year: end.year, month: end.month, day: end.day } : startDate;
    // DTEND of an all-day event is exclusive: the last day is the one before it.
    const lastUtc = Date.UTC(endDay.year, endDay.month - 1, endDay.day) - DAY_MS;
    const firstUtc = Date.UTC(startDate.year, startDate.month - 1, startDate.day);
    const d = new Date(Math.max(lastUtc, firstUtc));
    lastDate = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    if (endMs <= startMs) endMs = startMs + DAY_MS;
  }
  return {
    href: obj.href,
    uid: obj.uid,
    component,
    master: obj.master,
    recurrenceId: recurrence ? formatRecurrenceId(recurrence.ms, recurrence.isDate, displayTz) : null,
    recurring,
    allDay,
    startMs,
    endMs,
    startDate,
    lastDate,
    tzid: tzidOf(start),
  };
}

/** How an occurrence's original start is shown (and accepted back by get_event). */
export function formatRecurrenceId(ms: number, isDate: boolean, displayTz: string): string {
  if (isDate) {
    const p = zonedParts(new Date(ms), displayTz);
    return formatCalendarDate({ year: p.year, month: p.month, day: p.day });
  }
  return formatDateISO(ms, displayTz) ?? new Date(ms).toISOString();
}

function eventFor(obj: ParsedObject): Event | null {
  if (!obj.master) return null;
  return new ICAL.Event(obj.master, { exceptions: obj.overrides.map((o) => new ICAL.Event(o)) });
}

function endOf(c: Component): Time {
  return new ICAL.Event(c).endDate;
}

function startOf(c: Component): Time {
  return new ICAL.Event(c).startDate;
}

export interface ExpandResult {
  occurrences: Occurrence[];
  /** True when a series had more occurrences than MAX_ITERATIONS before the end of the range. */
  truncated: boolean;
}

/**
 * Every occurrence of the object that overlaps the range, with overrides applied, EXDATEs and
 * cancelled occurrences removed.
 */
export function expandObject(obj: ParsedObject, range: Range, displayTz: string): ExpandResult {
  const occurrences: Occurrence[] = [];
  const event = eventFor(obj);
  if (!event || !obj.master) {
    // Only overrides (e.g. an invitation to one occurrence of someone else's series).
    for (const o of obj.overrides) {
      if (isCancelled(o)) continue;
      const rid = o.getFirstPropertyValue('recurrence-id') as Time | null;
      const occ = makeOccurrence(obj, o, startOf(o), endOf(o), true, rid ? { ms: timeToMs(rid, displayTz), isDate: rid.isDate } : null, displayTz);
      if (overlaps(occ.startMs, occ.endMs, range)) occurrences.push(occ);
    }
    return { occurrences, truncated: false };
  }
  if (!event.isRecurring()) {
    if (isCancelled(obj.master)) return { occurrences, truncated: false };
    const occ = makeOccurrence(obj, obj.master, event.startDate, event.endDate, false, null, displayTz);
    if (overlaps(occ.startMs, occ.endMs, range)) occurrences.push(occ);
    return { occurrences, truncated: false };
  }

  const masterStart = event.startDate;
  const masterDurationMs = Math.max(0, timeToMs(event.endDate, displayTz) - timeToMs(masterStart, displayTz));
  // Instants of overridden occurrences: those are never skipped cheaply (they may have moved).
  const overrideAt = new Map<number, Component>();
  for (const o of obj.overrides) {
    const rid = o.getFirstPropertyValue('recurrence-id') as Time | null;
    if (rid) overrideAt.set(timeToMs(rid, displayTz), o);
  }
  const seen = new Set<number>();
  const hasRangeOverrides = (event as unknown as { rangeExceptions: unknown[] }).rangeExceptions.length > 0;
  const it = event.iterator();
  let truncated = false;
  let stoppedAt = Number.POSITIVE_INFINITY;
  for (let n = 0; ; n++) {
    if (n >= MAX_ITERATIONS) {
      truncated = true;
      break;
    }
    const next = it.next();
    if (!next) break;
    const origMs = timeToMs(next, displayTz);
    if (origMs >= range.endMs) {
      stoppedAt = origMs;
      break;
    }
    seen.add(origMs);
    // Fast path: an unmodified occurrence that ended before the range starts.
    if (!hasRangeOverrides && !overrideAt.has(origMs) && origMs + Math.max(masterDurationMs, DAY_MS) < range.startMs) continue;
    const details = event.getOccurrenceDetails(next);
    const component = details.item.component;
    if (isCancelled(component)) continue;
    const occ = makeOccurrence(obj, component, details.startDate, details.endDate, true, { ms: origMs, isDate: next.isDate }, displayTz);
    if (overlaps(occ.startMs, occ.endMs, range)) occurrences.push(occ);
  }
  // Occurrences whose original date lies after the range but that were moved into it.
  if (!truncated) {
    const exdates = new Set<number>();
    for (const p of obj.master.getAllProperties('exdate')) for (const v of p.getValues() as Time[]) exdates.add(timeToMs(v, displayTz));
    for (const [ms, o] of overrideAt) {
      if (ms < stoppedAt || seen.has(ms) || exdates.has(ms) || isCancelled(o)) continue;
      const rid = o.getFirstPropertyValue('recurrence-id') as Time;
      const occ = makeOccurrence(obj, o, startOf(o), endOf(o), true, { ms, isDate: rid.isDate }, displayTz);
      if (overlaps(occ.startMs, occ.endMs, range)) occurrences.push(occ);
    }
  }
  return { occurrences, truncated };
}

/** Parse a recurrence_id given back by Claude into an instant (date ids: midnight in displayTz). */
function recurrenceInstant(value: string, displayTz: string): { ms: number; isDate: boolean } | null {
  const s = value.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) return { ms: zonedMidnight({ year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) }, displayTz), isDate: true };
  const ical = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(s);
  if (ical) {
    const parts = { year: Number(ical[1]), month: Number(ical[2]), day: Number(ical[3]), hour: Number(ical[4]), minute: Number(ical[5]), second: Number(ical[6]) };
    return { ms: ical[7] ? Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) : wallTimeToMs(parts, displayTz), isDate: false };
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const parts = { year: Number(local[1]), month: Number(local[2]), day: Number(local[3]), hour: Number(local[4]), minute: Number(local[5]), second: Number(local[6] ?? '0') };
    return { ms: wallTimeToMs(parts, displayTz), isDate: false };
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : { ms, isDate: false };
}

/**
 * The occurrence of a recurring event whose original start is `recurrenceId` (as returned by
 * search_events), with its override applied. Null when the series has no such occurrence.
 */
export function findOccurrence(obj: ParsedObject, recurrenceId: string, displayTz: string): Occurrence | null {
  const target = recurrenceInstant(recurrenceId, displayTz);
  if (!target) throw new MailError('INVALID_INPUT', `occurrence must be the recurrence_id from search_events results (for example 2026-11-13T09:00:00-05:00 or 2026-11-13); got "${recurrenceId}".`);
  const sameInstant = (ms: number, isDate: boolean): boolean => (target.isDate || isDate ? Math.abs(ms - target.ms) < DAY_MS / 2 && formatRecurrenceId(ms, true, displayTz) === formatRecurrenceId(target.ms, true, displayTz) : Math.abs(ms - target.ms) < 1000);
  for (const o of obj.overrides) {
    const rid = o.getFirstPropertyValue('recurrence-id') as Time | null;
    if (!rid) continue;
    const ms = timeToMs(rid, displayTz);
    if (sameInstant(ms, rid.isDate)) {
      if (isCancelled(o)) return null;
      return makeOccurrence(obj, o, startOf(o), endOf(o), true, { ms, isDate: rid.isDate }, displayTz);
    }
  }
  const event = eventFor(obj);
  if (!event || !event.isRecurring()) return null;
  const it = event.iterator();
  for (let n = 0; n < MAX_ITERATIONS; n++) {
    const next = it.next();
    if (!next) return null;
    const ms = timeToMs(next, displayTz);
    if (sameInstant(ms, next.isDate)) {
      const details = event.getOccurrenceDetails(next);
      if (isCancelled(details.item.component)) return null;
      return makeOccurrence(obj, details.item.component, details.startDate, details.endDate, true, { ms, isDate: next.isDate }, displayTz);
    }
    if (ms > target.ms + DAY_MS) return null;
  }
  return null;
}

/** The series as a whole (get_event without an occurrence): the master's own first occurrence. */
export function seriesOccurrence(obj: ParsedObject, displayTz: string): Occurrence {
  if (obj.master) {
    const ev = new ICAL.Event(obj.master);
    return makeOccurrence(obj, obj.master, ev.startDate, ev.endDate, ev.isRecurring(), null, displayTz);
  }
  const first = obj.overrides[0];
  if (!first) throw new MailError('SERVER', `The calendar event ${obj.href} contains no event data.`);
  const rid = first.getFirstPropertyValue('recurrence-id') as Time | null;
  return makeOccurrence(obj, first, startOf(first), endOf(first), true, rid ? { ms: timeToMs(rid, displayTz), isDate: rid.isDate } : null, displayTz);
}

// ---------------------------------------------------------------------------------------------
// Property helpers (values are untrusted text; callers sanitise before showing them)
// ---------------------------------------------------------------------------------------------

export function textProp(c: Component, name: string): string | null {
  const v = c.getFirstPropertyValue(name);
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : String(v);
  return s === '' ? null : s;
}

/** "15 minutes", "1 day 2 hours", … */
export function describeDuration(d: Duration): string {
  const parts: string[] = [];
  const add = (n: number, unit: string): void => {
    if (n) parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`);
  };
  add(d.weeks, 'week');
  add(d.days, 'day');
  add(d.hours, 'hour');
  add(d.minutes, 'minute');
  add(d.seconds, 'second');
  return parts.join(' ');
}

export interface AlarmInfo {
  action: string;
  trigger: string;
}

export function alarmsOf(c: Component, displayTz: string): AlarmInfo[] {
  const out: AlarmInfo[] = [];
  for (const a of c.getAllSubcomponents('valarm')) {
    const action = (textProp(a, 'action') ?? 'DISPLAY').toUpperCase();
    const prop = a.getFirstProperty('trigger');
    let trigger = 'unknown';
    if (prop) {
      const v = prop.getFirstValue() as unknown;
      if (v instanceof ICAL.Duration) {
        const related = String(prop.getParameter('related') ?? 'START').toUpperCase() === 'END' ? 'end' : 'start';
        const len = describeDuration(v);
        trigger = len ? `${len} ${v.isNegative ? 'before' : 'after'} ${related}` : `at ${related}`;
      } else if (v instanceof ICAL.Time) {
        trigger = `at ${formatDateISO(timeToMs(v, displayTz), displayTz) ?? 'an unknown time'}`;
      }
    }
    // Apple adds a hidden "none" alarm to suppress defaults.
    if (action === 'NONE') continue;
    out.push({ action: action.toLowerCase(), trigger });
  }
  return out;
}

export interface PersonInfo {
  name: string | null;
  email: string | null;
  role?: string | null;
  status?: string | null;
}

function person(prop: InstanceType<typeof ICAL.Property>): PersonInfo {
  const value = String(prop.getFirstValue() ?? '');
  const email = /^mailto:/i.test(value) ? value.slice(7) : value.includes('@') ? value : null;
  const cn = prop.getParameter('cn');
  const name = typeof cn === 'string' && cn ? cn : null;
  return { name, email: email || null };
}

export function organizerOf(c: Component): PersonInfo | null {
  const p = c.getFirstProperty('organizer');
  return p ? person(p) : null;
}

export function attendeesOf(c: Component): PersonInfo[] {
  return c.getAllProperties('attendee').map((p) => {
    const role = p.getParameter('role');
    const partstat = p.getParameter('partstat');
    return { ...person(p), role: typeof role === 'string' ? role.toLowerCase() : null, status: typeof partstat === 'string' ? partstat.toLowerCase() : null };
  });
}

export function rruleOf(c: Component | null): string | null {
  if (!c) return null;
  const r = c.getFirstPropertyValue('rrule');
  return r ? String(r.toString()) : null;
}

export function exdateCount(c: Component | null): number {
  if (!c) return 0;
  return c.getAllProperties('exdate').reduce((n, p) => n + p.getValues().length, 0);
}
