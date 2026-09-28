import { describe, expect, it } from 'vitest';
import {
  HTML_TO_TEXT_OPTIONS,
  addDays,
  calendarDateToUTC,
  formatDateHuman,
  formatDateISO,
  formatSize,
  htmlToPlainText,
  makeSnippet,
  parseDateInput,
  stripHtmlCheap,
  toJson,
  todayIn,
  truncateResult,
  truncateText,
} from '../../src/format.js';
import { MailError } from '../../src/errors.js';

describe('dates', () => {
  it('renders ISO 8601 with the local offset of the configured zone', () => {
    const d = new Date('2026-09-28T16:14:00Z');
    expect(formatDateISO(d, 'America/Los_Angeles')).toBe('2026-09-28T09:14:00-07:00');
    expect(formatDateISO(d, 'Europe/Berlin')).toBe('2026-09-28T18:14:00+02:00');
    expect(formatDateISO(d, 'Asia/Kolkata')).toBe('2026-09-28T21:44:00+05:30');
    expect(formatDateISO(d, 'UTC')).toBe('2026-09-28T16:14:00+00:00');
    expect(formatDateISO(new Date('2026-01-15T12:00:00Z'), 'America/Los_Angeles')).toBe('2026-01-15T04:00:00-08:00');
    expect(formatDateISO('garbage', 'UTC')).toBeNull();
    expect(formatDateISO(undefined, 'UTC')).toBeNull();
  });

  it('handles midnight and DST transitions', () => {
    expect(formatDateISO(new Date('2026-03-08T10:30:00Z'), 'America/Los_Angeles')).toBe('2026-03-08T03:30:00-07:00');
    expect(formatDateISO(new Date('2026-03-08T08:00:00Z'), 'America/Los_Angeles')).toBe('2026-03-08T00:00:00-08:00');
  });

  it('renders a human date for reply attribution', () => {
    expect(formatDateHuman(new Date('2026-06-12T22:40:00Z'), 'America/Los_Angeles')).toBe('Fri, 12 Jun 2026 at 15:40 (-07:00)');
    expect(formatDateHuman(null, 'UTC')).toBe('an unknown date');
  });

  it('parses date inputs, truncating datetimes to the written date', () => {
    expect(parseDateInput('2026-09-28')).toEqual({ year: 2026, month: 9, day: 28 });
    expect(parseDateInput('2026-09-28T23:59:00-07:00')).toEqual({ year: 2026, month: 9, day: 28 });
    expect(parseDateInput('2026-09-28T01:00:00Z')).toEqual({ year: 2026, month: 9, day: 28 });
    expect(parseDateInput(' 2026-02-28 ')).toEqual({ year: 2026, month: 2, day: 28 });
    for (const bad of ['2026-02-30', '28/09/2026', 'yesterday', '2026-9-1', '']) expect(() => parseDateInput(bad), bad).toThrow(MailError);
  });

  it('computes today in a zone and date arithmetic', () => {
    const now = new Date('2026-09-28T03:00:00Z'); // still the 27th in Los Angeles
    expect(todayIn('America/Los_Angeles', now)).toEqual({ year: 2026, month: 9, day: 27 });
    expect(todayIn('Europe/Berlin', now)).toEqual({ year: 2026, month: 9, day: 28 });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(calendarDateToUTC({ year: 2026, month: 9, day: 1 }).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('sizes and text', () => {
  it('formats sizes', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(592)).toBe('592 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(12 * 1024 + 100)).toBe('12 KB');
    expect(formatSize(2026187)).toBe('1.9 MB');
    expect(formatSize(5 * 1024 ** 3)).toBe('5.00 GB');
    expect(formatSize(undefined)).toBe('unknown');
  });

  it('makes snippets of ~160 characters with collapsed whitespace', () => {
    expect(makeSnippet('  a\n\n b\t c  ')).toBe('a b c');
    const s = makeSnippet('word '.repeat(100));
    expect(s.length).toBe(160);
    expect(s.endsWith('…')).toBe(true);
    expect(truncateText('😀😀😀', 2)).toBe('😀…');
  });

  it('strips HTML cheaply for snippets', () => {
    const html = '<html><head><title>T</title><style>.x{color:red}</style></head><body><!-- c --><p>Hello&nbsp;<b>world</b> &amp; you&#33;</p><script>evil()</script><img src="x"><div>Bye';
    expect(makeSnippet(stripHtmlCheap(html))).toBe('Hello world & you! Bye');
    expect(stripHtmlCheap('<p>cut <a href="x')).toBe(' cut ');
  });

  it('converts bigint and collections in JSON', () => {
    expect(toJson({ v: 10n, s: new Set([1]), m: new Map([['a', 1]]) })).toBe('{"v":"10","s":[1],"m":{"a":1}}');
  });

  it('truncates results with a note', () => {
    const out = truncateResult('x'.repeat(200), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toMatch(/Result truncated to 100 of 200 characters/);
    expect(truncateResult('short', 100)).toBe('short');
  });
});

describe('html-to-text settings', () => {
  it('uses the SPEC settings', () => {
    expect(HTML_TO_TEXT_OPTIONS.wordwrap).toBe(false);
    expect(HTML_TO_TEXT_OPTIONS.selectors).toEqual(expect.arrayContaining([{ selector: 'img', format: 'skip' }]));
  });

  it('skips images and tracking pixels, hides hrefs equal to the text, keeps others', () => {
    const html = `<p>Hi <img src="https://track.example/p.gif" alt="pixel"></p>
      <p><a href="https://example.com">https://example.com</a> and <a href="https://example.com/x?utm=1">click here</a></p>`;
    const text = htmlToPlainText(html);
    expect(text).not.toContain('track.example');
    expect(text).not.toContain('pixel');
    expect(text).toContain('https://example.com and click here <https://example.com/x?utm=1>');
    expect(text.split('https://example.com ').length).toBe(2);
  });

  it('does not uppercase headings, does not wrap, drops style/script', () => {
    const long = 'word '.repeat(60).trim();
    const text = htmlToPlainText(`<style>p{}</style><script>alert(1)</script><h1>Monthly Report</h1><h2>Section two</h2><p>${long}</p><table><tr><th>Name</th></tr><tr><td>A</td></tr></table>`);
    expect(text).toContain('Monthly Report');
    expect(text).not.toContain('MONTHLY REPORT');
    expect(text).toContain('Section two');
    expect(text).toContain(long);
    expect(text).not.toContain('alert');
    expect(text).not.toContain('p{}');
    expect(text).toContain('Name');
    expect(text).not.toContain('NAME');
  });
});

// dos-1: pathological nesting never crashes the HTML conversion.
describe('htmlToPlainText limits', () => {
  it('handles very deep nesting and huge numbers of unclosed tags', () => {
    const deep = `${'<div>'.repeat(12_000)}deep text${'</div>'.repeat(12_000)}`;
    expect(htmlToPlainText(deep)).toContain('deep text');
    const unclosed = `${'<a href=x>'.repeat(50_000)}tail`;
    expect(typeof htmlToPlainText(unclosed)).toBe('string');
    const tables = `${'<table><tr><td>'.repeat(3000)}cell`;
    expect(htmlToPlainText(tables)).toContain('cell');
    expect(htmlToPlainText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });
});
