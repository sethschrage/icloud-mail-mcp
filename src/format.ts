/**
 * Formatting helpers: dates (local ISO 8601 with offset), sizes, text clean-up, HTML -> text,
 * JSON output and result truncation (SPEC §5).
 */
import { compile } from 'html-to-text';
import { MailError } from './errors.js';

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  /** Offset from UTC in minutes (e.g. -420 for -07:00). */
  offsetMinutes: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '0';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  const wholeSeconds = Math.floor(date.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - wholeSeconds) / 60_000);
  return { year, month, day, hour, minute, second, weekday: get('weekday'), offsetMinutes };
}

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function toValidDate(value: Date | string | number | undefined | null): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO 8601 in the given zone with its offset, e.g. `2026-09-28T09:14:00-07:00`. */
export function formatDateISO(value: Date | string | number | undefined | null, timeZone: string): string | null {
  const d = toValidDate(value);
  if (!d) return null;
  const p = zonedParts(d, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${formatOffset(p.offsetMinutes)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Human-readable local date for reply/forward headers, e.g. `Tue, 10 Feb 2026 at 10:02 (-08:00)`. */
export function formatDateHuman(value: Date | string | number | undefined | null, timeZone: string): string {
  const d = toValidDate(value);
  if (!d) return 'an unknown date';
  const p = zonedParts(d, timeZone);
  return `${p.weekday}, ${p.day} ${MONTHS[p.month - 1] ?? ''} ${p.year} at ${pad(p.hour)}:${pad(p.minute)} (${formatOffset(p.offsetMinutes)})`;
}

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/**
 * Parse a tool date input: `YYYY-MM-DD` or a full ISO datetime, truncated to its calendar date
 * (IMAP SEARCH dates are date-only). A datetime with an offset keeps the date as written.
 */
export function parseDateInput(input: string, field = 'date'): CalendarDate {
  const s = input.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$)/.exec(s);
  if (!m) throw new MailError('INVALID_INPUT', `${field} must be a date like 2026-09-28 or an ISO datetime like 2026-09-28T09:00:00-07:00; got "${input}".`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new MailError('INVALID_INPUT', `${field} "${input}" is not a valid calendar date.`);
  }
  return { year, month, day };
}

export function todayIn(timeZone: string, now: Date = new Date()): CalendarDate {
  const p = zonedParts(now, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * Epoch ms of local midnight at the start of `date` in `timeZone` (DST-aware: the offset is
 * re-evaluated at the candidate instant).
 */
export function zonedMidnight(date: CalendarDate, timeZone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const first = guess - zonedParts(new Date(guess), timeZone).offsetMinutes * 60_000;
  return guess - zonedParts(new Date(first), timeZone).offsetMinutes * 60_000;
}

/** UTC midnight of a calendar date: imapflow formats this back to exactly that date for SINCE/BEFORE. */
export function calendarDateToUTC(date: CalendarDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

export function formatCalendarDate(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

// ---------------------------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------------------------

export function formatSize(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1).replace(/\.0$/, '')} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cut at `max` characters (code points), adding an ellipsis when something was removed. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', zwnj: '', zwj: '' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** Cheap tag stripper for snippets: drops head/style/script/comments and tags, decodes entities. */
export function stripHtmlCheap(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|div|tr|li|h[1-6]|table|td|th|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  // A truncated fetch may end inside a tag.
  s = s.replace(/<[^>]*$/, '');
  return decodeEntities(s);
}

/** Snippet: whitespace-collapsed text, about `max` characters. */
export function makeSnippet(text: string, max = 160): string {
  return truncateText(collapseWhitespace(text), max);
}

/** Normalise line endings to "\n". */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------------------------
// HTML -> text (SPEC §5: skip img, hide hrefs equal to the link text, no word wrap, no uppercase headings)
// ---------------------------------------------------------------------------------------------

export const HTML_TO_TEXT_MAX_INPUT = 4_000_000;
/**
 * html-to-text recurses per nesting level: a few thousand nested elements (a hostile or broken
 * email) overflow the stack. Deeper content is flattened by the cheap stripper instead.
 */
export const HTML_TO_TEXT_MAX_DEPTH = 200;
export const HTML_TO_TEXT_MAX_CHILD_NODES = 10_000;

let htmlConverter: ((html: string) => string) | undefined;

/** html-to-text settings (SPEC §5). Compiled lazily so a library problem can never break startup. */
export const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false,
  limits: { maxInputLength: HTML_TO_TEXT_MAX_INPUT, maxDepth: HTML_TO_TEXT_MAX_DEPTH, maxChildNodes: HTML_TO_TEXT_MAX_CHILD_NODES },
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true, linkBrackets: [' <', '>'] } },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
    { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false } },
  ],
} satisfies Parameters<typeof compile>[0];

/** Rough nesting depth of an HTML string (open minus close tags, ignoring void/self-closing tags). */
function htmlNestingExceeds(html: string, limit: number): boolean {
  let depth = 0;
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(\/?)>/g;
  const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr', 'p', 'li', 'td', 'tr', 'th', 'option']);
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const name = (m[2] ?? '').toLowerCase();
    if (VOID.has(name) || m[3] === '/') continue;
    depth += m[1] === '/' ? -1 : 1;
    if (depth > limit) return true;
  }
  return false;
}

function cheapText(html: string): string {
  return stripHtmlCheap(html)
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToPlainText(html: string): string {
  const input = html.length > HTML_TO_TEXT_MAX_INPUT ? html.slice(0, HTML_TO_TEXT_MAX_INPUT) : html;
  // Past the depth limit html-to-text would drop the deeper content: keep it via the stripper.
  if (htmlNestingExceeds(input, HTML_TO_TEXT_MAX_DEPTH)) return cheapText(input);
  try {
    htmlConverter ??= compile(HTML_TO_TEXT_OPTIONS);
    return htmlConverter(input)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    // e.g. RangeError: Maximum call stack size exceeded on pathological markup.
    return cheapText(input);
  }
}

// ---------------------------------------------------------------------------------------------
// JSON and result size
// ---------------------------------------------------------------------------------------------

/** JSON.stringify that converts bigint (uidValidity, highestModseq) to strings (SPEC §2.8). */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Map) return Object.fromEntries(v as Map<unknown, unknown>);
      if (v instanceof Set) return [...(v as Set<unknown>)];
      return v;
    },
    space,
  );
}

export const MAX_RESULT_CHARS = 100_000;

/**
 * Decoded size of a MIME part from its encoded BODYSTRUCTURE size. base64 is written in 76-character
 * lines plus CRLF, so 78 encoded bytes carry 57 decoded ones.
 */
export function decodedSizeEstimate(encodedSize: number, encoding: string | undefined): number {
  return (encoding ?? '').toLowerCase() === 'base64' ? Math.floor((encodedSize * 57) / 78) : encodedSize;
}

/** Keep a tool result under ~100k characters, appending a note when cut. */
export function truncateResult(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const note = `\n[Result truncated to ${max} of ${text.length} characters.]`;
  return text.slice(0, Math.max(0, max - note.length)) + note;
}
