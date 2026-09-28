/**
 * Apple Mail flag colours (research-icloud §7): a 3-bit index stored as the keywords
 * $MailFlagBit0 (1), $MailFlagBit1 (2), $MailFlagBit2 (4), shown only while \Flagged is set.
 */

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

export const COLOR_BIT_KEYWORDS = ['$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2'] as const;

export const SEEN = '\\Seen';
export const FLAGGED = '\\Flagged';
export const ANSWERED = '\\Answered';
export const DRAFT = '\\Draft';
export const DELETED = '\\Deleted';
export const FORWARDED = '$Forwarded';

export function isFlagColor(value: string): value is FlagColor {
  return (FLAG_COLORS as readonly string[]).includes(value);
}

export function colorIndex(color: FlagColor): number {
  return FLAG_COLORS.indexOf(color);
}

/** Keywords to add and to remove so that exactly `color`'s bits are set. */
export function colorKeywords(color: FlagColor): { add: string[]; remove: string[] } {
  const index = colorIndex(color);
  const add: string[] = [];
  const remove: string[] = [];
  COLOR_BIT_KEYWORDS.forEach((kw, bit) => ((index >> bit) & 1 ? add : remove).push(kw));
  return { add, remove };
}

function hasFlag(flags: Iterable<string>, flag: string): boolean {
  const f = flag.toLowerCase();
  for (const x of flags) if (x.toLowerCase() === f) return true;
  return false;
}

/** Colour index from the bit keywords (0-7), regardless of \Flagged. */
export function colorBitsIndex(flags: Iterable<string>): number {
  let index = 0;
  COLOR_BIT_KEYWORDS.forEach((kw, bit) => {
    if (hasFlag(flags, kw)) index |= 1 << bit;
  });
  return index;
}

/** The Apple Mail colour of a message, or null when it is not flagged (or uses the unused index 7). */
export function flagColorFromFlags(flags: Iterable<string>): FlagColor | null {
  const list = [...flags];
  if (!hasFlag(list, FLAGGED)) return null;
  return FLAG_COLORS[colorBitsIndex(list)] ?? null;
}

export interface FlagState {
  unread: boolean;
  flagged: boolean;
  flag_color: FlagColor | null;
  answered: boolean;
  draft: boolean;
  forwarded: boolean;
}

export function flagState(flags: Iterable<string> | undefined): FlagState {
  const list = flags ? [...flags] : [];
  return {
    unread: !hasFlag(list, SEEN),
    flagged: hasFlag(list, FLAGGED),
    flag_color: flagColorFromFlags(list),
    answered: hasFlag(list, ANSWERED),
    draft: hasFlag(list, DRAFT),
    forwarded: hasFlag(list, FORWARDED),
  };
}

export { hasFlag };
