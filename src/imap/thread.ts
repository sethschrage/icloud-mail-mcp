/**
 * get_thread (SPEC §6.1 #4): header-based thread discovery without server THREAD (rejected on iCloud).
 *
 * Seed IDs = References + In-Reply-To + Message-ID of the seed (at most the 25 most recent). Search
 * INBOX, Sent, Archive and the seed's mailbox for messages whose Message-ID, References or
 * In-Reply-To contains one of them; then one expansion pass with newly discovered IDs.
 */
import type { ImapFlow, SearchObject } from 'imapflow';
import type { Config } from '../config.js';
import { MailError } from '../errors.js';
import type { ImapManager } from './client.js';
import { extractMessageIds, fetchSummaryRecords, messageNotFound, parseHeaderBlock, type MessageSummary, type SummaryRecord } from './fetch.js';
import type { MailboxInfo, MailboxRegistry } from './mailboxes.js';
import { searchUids, sortUidsDesc } from './search.js';

export const THREAD_MAX_IDS = 25;
export const THREAD_IDS_PER_SEARCH = 8;

export interface ThreadResult {
  mailboxes_searched: string[];
  total: number;
  returned: number;
  messages: MessageSummary[];
}

interface FoundMessage {
  record: SummaryRecord;
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
    found.push(...(await searchUids(client, { deleted: false, or })));
  }
  return sortUidsDesc(found);
}

async function collect(client: ImapFlow, path: string, uids: readonly number[], timeZone: string): Promise<FoundMessage[]> {
  if (uids.length === 0) return [];
  const records = await fetchSummaryRecords(client, path, uids, { snippets: true, timeZone });
  const headerMsgs = await client.fetchAll([...uids], { uid: true, envelope: true, headers: ['references', 'in-reply-to', 'message-id'] }, { uid: true });
  const idsByUid = new Map(headerMsgs.map((m) => [m.uid, threadIdsOf(parseHeaderBlock(m.headers), m.envelope)]));
  return records.map((record) => ({ record, ids: idsByUid.get(record.summary.uid) ?? [] }));
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
      const found = await collect(client, params.mailbox.path, [params.uid], tz);
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
  const keyOf = (f: FoundMessage): string => `${f.record.summary.mailbox}\u0000${f.record.summary.uid}`;
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
            return collect(client, mb.path, fresh, tz);
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
  // One expansion pass with IDs discovered in the first pass (no unbounded recursion).
  const discovered = unique([...found.values()].flatMap((f) => f.ids)).filter((id) => !searched.has(id));
  await runPass(discovered.slice(-THREAD_MAX_IDS));

  // Dedupe by Message-ID (the same message can sit in several folders), keeping the first seen.
  const byMessageId = new Map<string, FoundMessage>();
  const noId: FoundMessage[] = [];
  for (const f of found.values()) {
    const mid = f.record.messageId ? (extractMessageIds(f.record.messageId)[0] ?? f.record.messageId) : null;
    if (!mid) noId.push(f);
    else if (!byMessageId.has(mid.toLowerCase())) byMessageId.set(mid.toLowerCase(), f);
  }
  const all = [...byMessageId.values(), ...noId].map((f) => f.record);
  all.sort((a, b) => a.time - b.time || a.summary.uid - b.summary.uid);
  const limited = all.slice(-params.limit);
  return {
    mailboxes_searched: boxes.map((b) => b.path),
    total: all.length,
    returned: limited.length,
    messages: limited.map((r) => r.summary),
  };
}
