/**
 * get_thread (SPEC §6.1 #4): header-based thread discovery without server THREAD (rejected on iCloud).
 *
 * Seed IDs = References + In-Reply-To + Message-ID of the seed (at most the 25 most recent). Search
 * INBOX, Sent, Archive and the seed's mailbox for messages whose Message-ID, References or
 * In-Reply-To contains one of them; then one expansion pass with newly discovered IDs.
 *
 * Two phases, so a huge thread (a mailing list or notification stream where thousands of messages
 * reference one root) stays cheap: matches are first fetched with only UID, envelope and the
 * threading headers; after dedupe and sorting, full summaries and snippets are fetched only for the
 * `limit` messages returned.
 */
import type { ImapFlow, SearchObject } from 'imapflow';
import type { Config } from '../config.js';
import { MailError } from '../errors.js';
import type { ImapManager } from './client.js';
import { extractMessageIds, fetchSummaryRecords, messageNotFound, messageTime, parseHeaderBlock, type MessageSummary } from './fetch.js';
import type { MailboxInfo, MailboxRegistry } from './mailboxes.js';
import { chunks, searchStrict, sortUidsDesc, toSequenceSet } from './uids.js';

export const THREAD_MAX_IDS = 25;
export const THREAD_IDS_PER_SEARCH = 8;
/** No expansion pass once this many messages were found (the bound is on messages, not only IDs). */
export const THREAD_MAX_MESSAGES = 500;

export interface ThreadResult {
  mailboxes_searched: string[];
  total: number;
  returned: number;
  messages: MessageSummary[];
}

interface FoundMessage {
  mailbox: string;
  uid: number;
  /** Envelope Date, falling back to INTERNALDATE (epoch ms). */
  time: number;
  messageId: string | null;
  ids: string[]; // its Message-ID, In-Reply-To and References
}

function unique<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

/** Collect the thread IDs of a message: References (oldest first), In-Reply-To, Message-ID. */
export function threadIdsOf(headers: Map<string, string[]>, envelope: { messageId?: string | undefined; inReplyTo?: string | undefined } | undefined): string[] {
  const refs = (headers.get('references') ?? []).flatMap((v) => extractMessageIds(v));
  const irt = extractMessageIds(envelope?.inReplyTo ?? headers.get('in-reply-to')?.[0]);
  const mid = extractMessageIds(envelope?.messageId ?? headers.get('message-id')?.[0]);
  return unique([...refs, ...irt, ...mid]);
}

async function searchIdsInMailbox(client: ImapFlow, ids: readonly string[]): Promise<number[]> {
  const found: number[] = [];
  for (let i = 0; i < ids.length; i += THREAD_IDS_PER_SEARCH) {
    const chunk = ids.slice(i, i + THREAD_IDS_PER_SEARCH);
    const or: SearchObject[] = chunk.flatMap((id): SearchObject[] => [{ header: { 'message-id': id } }, { header: { references: id } }, { header: { 'in-reply-to': id } }]);
    found.push(...(await searchStrict(client, { deleted: false, or })));
  }
  return sortUidsDesc(found);
}

/** Phase 1: the lightweight data needed to thread, dedupe and sort (no BODYSTRUCTURE, no snippets). */
async function collect(client: ImapFlow, path: string, uids: readonly number[]): Promise<FoundMessage[]> {
  if (uids.length === 0) return [];
  const out: FoundMessage[] = [];
  for (const part of chunks([...uids], 2000)) {
    const msgs = await client.fetchAll(toSequenceSet(part), { uid: true, envelope: true, internalDate: true, headers: ['references', 'in-reply-to', 'message-id'] }, { uid: true });
    for (const m of msgs) {
      const mid = m.envelope?.messageId ? (extractMessageIds(m.envelope.messageId)[0] ?? m.envelope.messageId) : null;
      out.push({ mailbox: path, uid: m.uid, time: messageTime(m), messageId: mid, ids: threadIdsOf(parseHeaderBlock(m.headers), m.envelope) });
    }
  }
  return out;
}

export async function getThread(
  imap: ImapManager,
  registry: MailboxRegistry,
  config: Pick<Config, 'timezone'>,
  params: { mailbox: MailboxInfo; uid: number; limit: number },
): Promise<ThreadResult> {
  const tz = config.timezone;
  const seed = await imap.withMailbox(
    params.mailbox.path,
    async (client) => {
      const found = await collect(client, params.mailbox.path, [params.uid]);
      const first = found[0];
      if (!first) throw messageNotFound(params.mailbox.path, params.uid);
      return first;
    },
    { readOnly: true },
  );

  const special = (await registry.specialResolution()).map;
  const boxes: MailboxInfo[] = [];
  for (const mb of [special.inbox, special.sent, special.archive, params.mailbox]) {
    if (mb && mb.selectable && !boxes.some((b) => b.path === mb.path)) boxes.push(mb);
  }

  const found = new Map<string, FoundMessage>(); // key: mailbox\u0000uid
  const keyOf = (f: FoundMessage): string => `${f.mailbox}\u0000${f.uid}`;
  found.set(keyOf(seed), seed);

  const searched = new Set<string>();
  const runPass = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    ids.forEach((id) => searched.add(id));
    for (const mb of boxes) {
      let results: FoundMessage[];
      try {
        results = await imap.withMailbox(
          mb.path,
          async (client) => {
            const uids = await searchIdsInMailbox(client, ids);
            const fresh = uids.filter((u) => !found.has(`${mb.path}\u0000${u}`));
            return collect(client, mb.path, fresh);
          },
          { readOnly: true },
        );
      } catch (err) {
        // A folder that vanished or rejects HEADER search is skipped; connection/auth errors propagate.
        if (err instanceof MailError && (err.code === 'NOT_FOUND' || err.code === 'SERVER')) continue;
        throw err;
      }
      for (const r of results) found.set(keyOf(r), r);
    }
  };

  const seedIds = seed.ids.slice(-THREAD_MAX_IDS);
  await runPass(seedIds);
  // One expansion pass with IDs discovered in the first pass (no unbounded recursion), skipped
  // when the thread is already very large.
  if (found.size < THREAD_MAX_MESSAGES) {
    const discovered = unique([...found.values()].flatMap((f) => f.ids)).filter((id) => !searched.has(id));
    await runPass(discovered.slice(-THREAD_MAX_IDS));
  }

  // Dedupe by Message-ID (the same message can sit in several folders), keeping the first seen.
  const byMessageId = new Map<string, FoundMessage>();
  const noId: FoundMessage[] = [];
  for (const f of found.values()) {
    if (!f.messageId) noId.push(f);
    else if (!byMessageId.has(f.messageId.toLowerCase())) byMessageId.set(f.messageId.toLowerCase(), f);
  }
  const all = [...byMessageId.values(), ...noId];
  all.sort((a, b) => a.time - b.time || a.uid - b.uid);
  const limited = all.slice(-params.limit);

  // Phase 2: full summaries with snippets for the returned messages only, grouped by mailbox.
  const byMailbox = new Map<string, number[]>();
  for (const f of limited) byMailbox.set(f.mailbox, [...(byMailbox.get(f.mailbox) ?? []), f.uid]);
  const summaries = new Map<string, MessageSummary>();
  for (const [path, uids] of byMailbox) {
    const records = await imap.withMailbox(path, (client) => fetchSummaryRecords(client, path, uids, { snippets: true, timeZone: tz }), { readOnly: true });
    for (const r of records) summaries.set(`${path}\u0000${r.summary.uid}`, r.summary);
  }
  const messages = limited.map((f) => summaries.get(keyOf(f))).filter((m): m is MessageSummary => m !== undefined);
  return {
    mailboxes_searched: boxes.map((b) => b.path),
    total: all.length,
    returned: messages.length,
    messages,
  };
}
