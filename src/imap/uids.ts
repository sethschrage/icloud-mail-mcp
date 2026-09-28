/**
 * UID list helpers and the strict SEARCH wrapper shared by the IMAP modules.
 */
import type { ImapFlow, SearchObject } from 'imapflow';
import { MailError } from '../errors.js';

/** Unique UIDs sorted descending (newest first). */
export function sortUidsDesc(uids: Iterable<number>): number[] {
  return [...new Set(uids)].filter((u) => Number.isInteger(u) && u > 0).sort((a, b) => b - a);
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

/** Split `items` into chunks of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * UID SEARCH that never mistakes a failed search for "no results". imapflow's search() returns
 * `false` (it does not throw) on a NO/BAD response or a command that failed mid-flight; treating
 * that as an empty list would make the expunge guard fail open and report existing messages as
 * not found. A lost connection is re-thrown as a connection error (so reads can retry on a new
 * connection); anything else becomes a SERVER error. Result: unique UIDs, newest first.
 */
export async function searchStrict(client: ImapFlow, query: SearchObject): Promise<number[]> {
  // Keep SINCE/BEFORE date-only even if a later CAPABILITY refresh re-announced WITHIN (see client.ts).
  client.capabilities.delete('WITHIN');
  const result = await client.search(query, { uid: true });
  if (result === false || result === undefined || !Array.isArray(result)) {
    if (!client.usable) throw Object.assign(new Error('The connection was lost during SEARCH.'), { code: 'NoConnection' });
    throw new MailError('SERVER', 'The IMAP server did not return search results (it refused or failed the SEARCH); nothing was changed.');
  }
  return sortUidsDesc(result);
}
