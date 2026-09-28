import { describe, expect, it } from 'vitest';
import { COLOR_BIT_KEYWORDS, FLAG_COLORS, colorBitsIndex, colorKeywords, flagColorFromFlags, flagState, type FlagColor } from '../../src/imap/flags.js';

describe('Apple Mail flag colour bits', () => {
  const table: Array<[FlagColor, string[]]> = [
    ['red', []],
    ['orange', ['$MailFlagBit0']],
    ['yellow', ['$MailFlagBit1']],
    ['green', ['$MailFlagBit0', '$MailFlagBit1']],
    ['blue', ['$MailFlagBit2']],
    ['purple', ['$MailFlagBit0', '$MailFlagBit2']],
    ['gray', ['$MailFlagBit1', '$MailFlagBit2']],
  ];

  it.each(table)('%s sets exactly %j and clears the other bits', (color, bits) => {
    const { add, remove } = colorKeywords(color);
    expect(add).toEqual(bits);
    expect([...add, ...remove].sort()).toEqual([...COLOR_BIT_KEYWORDS].sort());
    expect(remove.some((r) => add.includes(r))).toBe(false);
  });

  it.each(table)('%s round-trips through flagColorFromFlags', (color, bits) => {
    expect(flagColorFromFlags(['\\Flagged', ...bits])).toBe(color);
    expect(colorBitsIndex(bits)).toBe(FLAG_COLORS.indexOf(color));
  });

  it('has no colour when not flagged, and none for the unused index 7', () => {
    expect(flagColorFromFlags(['$MailFlagBit0'])).toBeNull();
    expect(flagColorFromFlags([])).toBeNull();
    expect(flagColorFromFlags(['\\Flagged', ...COLOR_BIT_KEYWORDS])).toBeNull();
  });

  it('compares keywords case-insensitively', () => {
    expect(flagColorFromFlags(['\\flagged', '$mailflagbit2'])).toBe('blue');
  });

  it('derives the summary flag state', () => {
    expect(flagState(new Set(['\\Seen', '\\Answered', '$Forwarded', '\\Flagged', '$MailFlagBit1']))).toEqual({
      unread: false,
      flagged: true,
      flag_color: 'yellow',
      answered: true,
      draft: false,
      forwarded: true,
    });
    expect(flagState(undefined)).toMatchObject({ unread: true, flagged: false, flag_color: null });
  });
});
