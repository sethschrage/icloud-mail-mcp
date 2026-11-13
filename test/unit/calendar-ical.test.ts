/**
 * iCalendar parsing and recurrence expansion (src/calendar/ical.ts): RRULE with UNTIL/COUNT,
 * EXDATE, moved/edited/cancelled overrides (including one moved into the range from after it),
 * all-day dates, TZIDs across the end of daylight saving time, UTC, floating and custom VTIMEZONEs.
 */
import { describe, expect, it } from 'vitest';
import { expandObject, findOccurrence, parseObject, seriesOccurrence, wallTimeToMs, alarmsOf, attendeesOf, organizerOf, rruleOf, type Occurrence } from '../../src/calendar/ical.js';
import { formatCalendarDate, formatDateISO } from '../../src/format.js';
import { BERLIN_CALL, BIRTHDAY, CONFERENCE, DISPLAY_TZ, FLOATING, OUTLOOK, STANDUP, TRIP, UTC_EVENT, ics } from '../helpers/calendar-fixtures.js';

const tz = DISPLAY_TZ;
const day = (d: string): number => wallTimeToMs({ year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)), day: Number(d.slice(8, 10)), hour: 0, minute: 0, second: 0 }, tz);
const range = (from: string, to: string) => ({ startMs: day(from), endMs: day(to) });
const iso = (o: Occurrence): string => (o.allDay && o.startDate ? formatCalendarDate(o.startDate) : (formatDateISO(o.startMs, tz) ?? ''));
const title = (o: Occurrence): string => String(o.component.getFirstPropertyValue('summary'));

function expand(data: string, from: string, to: string): Occurrence[] {
  return expandObject(parseObject('/x.ics', data), range(from, to), tz).occurrences;
}

describe('recurring series', () => {
  it('expands a weekly rule in wall time across the end of daylight saving time', () => {
    const occ = expand(STANDUP, '2026-10-26', '2026-11-05');
    expect(occ.map(iso)).toEqual(['2026-10-26T09:00:00-04:00', '2026-10-28T09:00:00-04:00', '2026-11-02T09:00:00-05:00', '2026-11-04T09:00:00-05:00']);
    expect(occ.every((o) => o.recurring)).toBe(true);
    expect(occ[0]?.recurrenceId).toBe('2026-10-26T09:00:00-04:00');
    expect(occ[0] && formatDateISO(occ[0].endMs, tz)).toBe('2026-10-26T09:30:00-04:00');
  });

  it('drops EXDATEs and cancelled overrides, and applies moved overrides', () => {
    const occ = expand(STANDUP, '2026-11-09', '2026-11-21');
    // Mon 9 Nov: EXDATE. Wed 11: moved to 14:00. Mon 16: cancelled. Wed 18: moved to Fri 13.
    expect(occ.map((o) => [iso(o), title(o)])).toEqual([
      ['2026-11-11T14:00:00-05:00', 'Team stand-up (moved)'],
      ['2026-11-13T16:00:00-05:00', 'Team stand-up (pulled forward)'],
    ]);
    const moved = occ[0];
    expect(moved?.recurrenceId).toBe('2026-11-11T09:00:00-05:00');
  });

  it('includes an occurrence moved into the range from a date after it', () => {
    const occ = expand(STANDUP, '2026-11-13', '2026-11-14');
    expect(occ.map((o) => [iso(o), title(o), o.recurrenceId])).toEqual([['2026-11-13T16:00:00-05:00', 'Team stand-up (pulled forward)', '2026-11-18T09:00:00-05:00']]);
  });

  it('leaves out the original slot of an occurrence that was moved away', () => {
    expect(expand(STANDUP, '2026-11-18', '2026-11-19')).toEqual([]);
  });

  it('stops at UNTIL and COUNT', () => {
    expect(expand(STANDUP, '2027-01-01', '2027-02-01')).toEqual([]);
    expect(expand(TRIP, '2026-11-01', '2026-11-30').map(iso)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });

  it('expands a yearly all-day series that started decades ago', () => {
    const occ = expand(BIRTHDAY, '2026-11-01', '2026-12-01');
    expect(occ.map(iso)).toEqual(['2026-11-13']);
    expect(occ[0]?.recurrenceId).toBe('2026-11-13');
    expect(occ[0]?.lastDate).toEqual({ year: 2026, month: 11, day: 13 });
  });

  it('finds one occurrence by its recurrence_id, with the override applied', () => {
    const obj = parseObject('/x.ics', STANDUP);
    const moved = findOccurrence(obj, '2026-11-18T09:00:00-05:00', tz);
    expect(moved && [iso(moved), title(moved)]).toEqual(['2026-11-13T16:00:00-05:00', 'Team stand-up (pulled forward)']);
    const plain = findOccurrence(obj, '2026-11-04T09:00:00-05:00', tz);
    expect(plain && [iso(plain), title(plain)]).toEqual(['2026-11-04T09:00:00-05:00', 'Team stand-up']);
    // Other spellings of the same instant.
    expect(findOccurrence(obj, '2026-11-04T14:00:00Z', tz)?.startMs).toBe(plain?.startMs);
    expect(findOccurrence(obj, '20261104T090000', tz)?.startMs).toBe(plain?.startMs);
    expect(findOccurrence(obj, '2026-11-04T09:00', tz)?.startMs).toBe(plain?.startMs);
    // EXDATE, cancelled, not an occurrence at all.
    expect(findOccurrence(obj, '2026-11-09T09:00:00-05:00', tz)).toBeNull();
    expect(findOccurrence(obj, '2026-11-16T09:00:00-05:00', tz)).toBeNull();
    expect(findOccurrence(obj, '2026-11-05T09:00:00-05:00', tz)).toBeNull();
    expect(() => findOccurrence(obj, 'next tuesday', tz)).toThrow(/recurrence_id/);
    expect(findOccurrence(parseObject('/b.ics', BIRTHDAY), '2026-11-13', tz)?.recurrenceId).toBe('2026-11-13');
  });

  it('describes the series: rule, organizer, attendees and alerts', () => {
    const obj = parseObject('/x.ics', STANDUP);
    const series = seriesOccurrence(obj, tz);
    expect(series.recurring).toBe(true);
    expect(iso(series)).toBe('2026-10-05T09:00:00-04:00');
    expect(rruleOf(obj.master)).toBe('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z');
    expect(organizerOf(series.component)).toEqual({ name: 'Alice Example', email: 'alice@example.com' });
    expect(attendeesOf(series.component)).toEqual([
      { name: 'Alice Example', email: 'alice@example.com', role: 'chair', status: 'accepted' },
      { name: 'Bob Example', email: 'bob@example.com', role: 'req-participant', status: 'needs-action' },
    ]);
    expect(alarmsOf(series.component, tz)).toEqual([{ action: 'display', trigger: '15 minutes before start' }]);
  });
});

describe('single events and time zones', () => {
  it('shows all-day events as dates with an inclusive last day', () => {
    const [o] = expand(CONFERENCE, '2026-11-13', '2026-11-14');
    expect(o?.allDay).toBe(true);
    expect(o?.startDate).toEqual({ year: 2026, month: 11, day: 12 });
    expect(o?.lastDate).toEqual({ year: 2026, month: 11, day: 13 });
    expect(expand(CONFERENCE, '2026-11-14', '2026-11-15')).toEqual([]);
    expect(expand(CONFERENCE, '2026-11-11', '2026-11-12')).toEqual([]);
  });

  it('converts IANA TZIDs, UTC, floating times and custom VTIMEZONEs', () => {
    expect(expand(BERLIN_CALL, '2026-11-12', '2026-11-13').map(iso)).toEqual(['2026-11-12T12:00:00-05:00']);
    expect(expand(BERLIN_CALL, '2026-11-12', '2026-11-13')[0]?.tzid).toBe('Europe/Berlin');
    expect(expand(UTC_EVENT, '2026-11-13', '2026-11-14').map(iso)).toEqual(['2026-11-13T10:00:00-05:00']);
    expect(expand(FLOATING, '2026-11-13', '2026-11-14').map(iso)).toEqual(['2026-11-13T08:00:00-05:00']);
    expect(expandObject(parseObject('/f.ics', FLOATING), range('2026-11-13', '2026-11-14'), 'Europe/Berlin').occurrences.map((o) => formatDateISO(o.startMs, 'Europe/Berlin'))).toEqual(['2026-11-13T08:00:00+01:00']);
    expect(expand(OUTLOOK, '2026-11-12', '2026-11-13').map(iso)).toEqual(['2026-11-12T11:00:00-05:00']);
  });

  it('uses overlap, not start, against the range', () => {
    // 12:00-13:00 Berlin-call: a range ending at 12:30 New York still contains it.
    const startMs = day('2026-11-12');
    const r = { startMs: startMs + 12.5 * 3600_000, endMs: startMs + 13 * 3600_000 };
    expect(expandObject(parseObject('/b.ics', BERLIN_CALL), r, tz).occurrences).toHaveLength(1);
    const after = { startMs: startMs + 13 * 3600_000, endMs: startMs + 14 * 3600_000 };
    expect(expandObject(parseObject('/b.ics', BERLIN_CALL), after, tz).occurrences).toHaveLength(0);
  });

  it('lists the overrides of an object that has no master (invited to one occurrence)', () => {
    const only = ics([
      'BEGIN:VEVENT',
      'UID:x@test',
      'DTSTAMP:20261001T120000Z',
      'RECURRENCE-ID;TZID=America/New_York:20261112T100000',
      'SUMMARY:Guest slot',
      'DTSTART;TZID=America/New_York:20261112T103000',
      'DTEND;TZID=America/New_York:20261112T110000',
      'END:VEVENT',
    ]);
    const occ = expand(only, '2026-11-12', '2026-11-13');
    expect(occ.map((o) => [iso(o), o.recurring, o.recurrenceId])).toEqual([['2026-11-12T10:30:00-05:00', true, '2026-11-12T10:00:00-05:00']]);
  });

  it('refuses data that is not iCalendar', () => {
    expect(() => parseObject('/bad.ics', 'hello')).toThrow(/could not be read/);
  });

  it('stops a runaway series at the iteration cap and says so', () => {
    const minutely = ics(['BEGIN:VEVENT', 'UID:m@test', 'DTSTAMP:20261001T120000Z', 'SUMMARY:Ping', 'DTSTART:19900101T000000Z', 'DTEND:19900101T000001Z', 'RRULE:FREQ=MINUTELY', 'END:VEVENT']);
    const r = expandObject(parseObject('/m.ics', minutely), range('2026-11-12', '2026-11-13'), tz);
    expect(r.truncated).toBe(true);
    expect(r.occurrences).toEqual([]);
  });
});
