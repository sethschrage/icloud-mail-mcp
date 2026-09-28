/**
 * Mailbox changes (SPEC §6.3, §6.5, §6.7): flags/colours, move (with the expunge guard), trash,
 * archive, permanent delete, append, mailbox create/rename/delete.
 *
 * Expunge guard (SPEC §2.4): iCloud has no MOVE, so a move is COPY + \Deleted + EXPUNGE, and the
 * EXPUNGE is a UID EXPUNGE only with UIDPLUS. Without UIDPLUS a plain EXPUNGE would purge every
 * \Deleted message in the folder, so we refuse when other (visible) \Deleted messages exist.
 *
 * Every SEARCH here goes through searchStrict: imapflow returns `false` for a failed SEARCH, and
 * reading that as "no results" would make the guard fail open.
 */
import type { ImapFlow } from 'imapflow';
import { MailError } from '../errors.js';
import type { ImapManager } from './client.js';
import { extractMessageIds } from './fetch.js';
import { COLOR_BIT_KEYWORDS, DELETED, DRAFT, FLAGGED, SEEN, colorKeywords, flagState, hasFlag, type FlagColor } from './flags.js';
import { fold, isInboxPath, type MailboxInfo, type MailboxRegistry } from './mailboxes.js';
import { searchStrict, sortUidsDesc, toSequenceSet } from './uids.js';

export const MAX_UIDS_PER_CALL = 500;

/** Validate a uids argument: 1..500 positive integers; returns unique UIDs ascending. */
export function validateUids(uids: readonly number[]): number[] {
  if (!Array.isArray(uids) || uids.length === 0) throw new MailError('INVALID_INPUT', 'uids must contain at least one UID.');
  if (uids.length > MAX_UIDS_PER_CALL) throw new MailError('INVALID_INPUT', `At most ${MAX_UIDS_PER_CALL} UIDs per call.`);
  for (const u of uids) {
    if (!Number.isInteger(u) || u < 1 || u > 4_294_967_295) throw new MailError('INVALID_INPUT', `Invalid UID ${String(u)}: UIDs are positive whole numbers.`);
  }
  return [...new Set(uids)].sort((a, b) => a - b);
}

export interface UidCheck {
  found: number[];
  notFound: number[];
}

/** Which of `uids` exist (and are not \Deleted) in the selected mailbox. */
export async function verifyUids(client: ImapFlow, uids: readonly number[]): Promise<UidCheck> {
  const existing = new Set(await searchStrict(client, { uid: toSequenceSet(uids), deleted: false }));
  const found = uids.filter((u) => existing.has(u));
  const notFound = uids.filter((u) => !existing.has(u));
  return { found, notFound };
}

function capability(client: ImapFlow, name: string): boolean {
  return client.capabilities.has(name);
}

/**
 * Refuse if an EXPUNGE could remove \Deleted messages other than `targets` (SPEC §2.4).
 * `needed` tells whether the pending operation would issue a plain EXPUNGE at all.
 */
/** How many other \Deleted candidates the guard confirms with FETCH before assuming the rest are real. */
export const GUARD_CONFIRM_MAX = 1000;

export async function expungeGuard(client: ImapFlow, mailboxPath: string, targets: readonly number[], action: string): Promise<void> {
  // Fails closed: a failed SEARCH throws here, before any COPY or STORE.
  const deleted = await searchStrict(client, { deleted: true });
  const targetSet = new Set(targets);
  const candidates = sortUidsDesc(deleted.filter((u) => !targetSet.has(u)));
  // iCloud's SEARCH also returns "ghost" UIDs of \Deleted messages that EXISTS, STATUS and FETCH
  // no longer show; the user cannot see or undelete those and purging them loses nothing. Count
  // only candidates FETCH still returns with \Deleted (any beyond the confirmation cap count too).
  const toConfirm = candidates.slice(0, GUARD_CONFIRM_MAX);
  const confirmed = new Set<number>();
  if (toConfirm.length) {
    const msgs = await client.fetchAll(toSequenceSet(toConfirm), { uid: true, flags: true }, { uid: true });
    for (const m of msgs) if (hasFlag(m.flags ?? [], DELETED)) confirmed.add(m.uid);
  }
  const others = [...toConfirm.filter((u) => confirmed.has(u)), ...candidates.slice(GUARD_CONFIRM_MAX)];
  if (others.length > 0) {
    throw new MailError(
      'EXPUNGE_GUARD',
      `Refusing to ${action}: this server has neither MOVE nor UIDPLUS, so finishing the operation needs a plain EXPUNGE, which would also permanently remove ${others.length} other message(s) in "${mailboxPath}" that are already marked \\Deleted (UIDs ${others.slice(0, 20).join(', ')}${others.length > 20 ? ', …' : ''}). Nothing was changed. Undelete or purge those in Apple Mail first.`,
      { details: { other_deleted_uids: others.slice(0, 100) } },
    );
  }
}

export function moveNeedsGuard(client: ImapFlow): boolean {
  return !capability(client, 'MOVE') && !capability(client, 'UIDPLUS');
}

export function deleteNeedsGuard(client: ImapFlow): boolean {
  return !capability(client, 'UIDPLUS');
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

export interface MarkRequest {
  read?: boolean | undefined;
  flagged?: boolean | undefined;
  flagColor?: FlagColor | undefined;
}

export interface MarkedMessage {
  uid: number;
  unread: boolean;
  flagged: boolean;
  flag_color: FlagColor | null;
}

/** Per-message states are listed only for small calls; larger ones get the counts. */
export const MARK_DETAIL_MAX = 20;

export interface MarkResult {
  mailbox: string;
  affected: number;
  not_found: number[];
  /** State after the change, counted over the affected messages. */
  now: { unread: number; read: number; flagged: number };
  /** Per-message state (only when at most MARK_DETAIL_MAX messages were affected). */
  messages?: MarkedMessage[];
  /** UIDs where the read-back shows the change did not (fully) take effect, with the reason. */
  not_applied: Array<{ uid: number; reason: string }>;
}

export async function markMessages(imap: ImapManager, mailbox: MailboxInfo, uidsIn: readonly number[], req: MarkRequest): Promise<MarkResult> {
  const uids = validateUids(uidsIn);
  if (req.read === undefined && req.flagged === undefined && req.flagColor === undefined) {
    throw new MailError('INVALID_INPUT', 'Give at least one of read, flagged or flag_color.');
  }
  if (req.flagColor !== undefined && req.flagged === false) {
    throw new MailError('INVALID_INPUT', 'flag_color implies flagged; it cannot be combined with flagged: false.');
  }
  return imap.withMailbox(
    mailbox.path,
    async (client) => {
      const { found, notFound } = await verifyUids(client, uids);
      if (found.length === 0) return { mailbox: mailbox.path, affected: 0, not_found: notFound, now: { unread: 0, read: 0, flagged: 0 }, not_applied: [] };
      if (req.read === true) await client.messageFlagsAdd([...found], [SEEN], { uid: true });
      if (req.read === false) await client.messageFlagsRemove([...found], [SEEN], { uid: true });
      if (req.flagColor !== undefined) {
        const { add, remove } = colorKeywords(req.flagColor);
        await client.messageFlagsAdd([...found], [FLAGGED, ...add], { uid: true });
        if (remove.length) await client.messageFlagsRemove([...found], remove, { uid: true });
      } else if (req.flagged === true) {
        await client.messageFlagsAdd([...found], [FLAGGED], { uid: true });
      } else if (req.flagged === false) {
        await client.messageFlagsRemove([...found], [FLAGGED, ...COLOR_BIT_KEYWORDS], { uid: true });
      }
      // Read back: keywords outside PERMANENTFLAGS are dropped silently by imapflow/the server.
      const after = await client.fetchAll(toSequenceSet(found), { uid: true, flags: true }, { uid: true });
      const messages: MarkedMessage[] = after
        .map((m) => {
          const s = flagState(m.flags);
          return { uid: m.uid, unread: s.unread, flagged: s.flagged, flag_color: s.flag_color };
        })
        .sort((a, b) => a.uid - b.uid);
      const notApplied: Array<{ uid: number; reason: string }> = [];
      for (const m of messages) {
        const reasons: string[] = [];
        if (req.read !== undefined && m.unread === req.read) reasons.push(`still ${m.unread ? 'unread' : 'read'}`);
        if (req.flagColor !== undefined && m.flag_color !== req.flagColor) {
          reasons.push(`colour is ${m.flag_color ?? 'none'} instead of ${req.flagColor} (the server may not allow the $MailFlagBit keywords)`);
        } else if (req.flagged !== undefined && m.flagged !== req.flagged) {
          reasons.push(`still ${m.flagged ? 'flagged' : 'unflagged'}`);
        }
        if (reasons.length) notApplied.push({ uid: m.uid, reason: reasons.join('; ') });
      }
      const now = {
        unread: messages.filter((m) => m.unread).length,
        read: messages.filter((m) => !m.unread).length,
        flagged: messages.filter((m) => m.flagged).length,
      };
      const result: MarkResult = { mailbox: mailbox.path, affected: found.length, not_found: notFound, now, not_applied: notApplied };
      if (messages.length <= MARK_DETAIL_MAX) result.messages = messages;
      return result;
    },
    { readOnly: false, retry: false },
  );
}

/** Add flags to one message (e.g. \Answered after a reply, $Forwarded after a forward). */
export async function addFlagsToMessage(imap: ImapManager, mailboxPath: string, uid: number, flags: string[]): Promise<boolean> {
  return imap.withMailbox(
    mailboxPath,
    async (client) => {
      const { found } = await verifyUids(client, [uid]);
      if (found.length === 0) return false;
      await client.messageFlagsAdd([uid], flags, { uid: true });
      const msg = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
      return !!msg && flags.every((f) => hasFlag(msg.flags ?? [], f));
    },
    { readOnly: false, retry: false },
  );
}

// ---------------------------------------------------------------------------------------------
// Move / delete
// ---------------------------------------------------------------------------------------------

export interface MoveResult {
  source: string;
  destination: string;
  moved: number;
  not_found: number[];
  /** old UID -> new UID in the destination, when the server reports COPYUID. */
  new_uids?: Record<string, number>;
  /** Set when the move completed only partly in a harmless way (see moveMessages). */
  warning?: string;
}

function uidMapRecord(map: Map<number, number> | undefined): Record<string, number> | undefined {
  if (!map || map.size === 0) return undefined;
  return Object.fromEntries([...map.entries()].sort((a, b) => a[0] - b[0]).map(([o, n]) => [String(o), n]));
}

export async function moveMessages(
  imap: ImapManager,
  registry: MailboxRegistry,
  source: MailboxInfo,
  uidsIn: readonly number[],
  destination: MailboxInfo,
): Promise<MoveResult> {
  const uids = validateUids(uidsIn);
  if (source.path === destination.path) throw new MailError('INVALID_INPUT', `Source and destination are the same mailbox ("${source.path}").`);
  if (!destination.selectable) throw new MailError('INVALID_INPUT', `"${destination.path}" is a folder container and cannot hold messages.`);
  try {
    return await imap.withMailbox(
      source.path,
      async (client) => {
        const { found, notFound } = await verifyUids(client, uids);
        const result: MoveResult = { source: source.path, destination: destination.path, moved: 0, not_found: notFound };
        if (found.length === 0) return result;
        if (moveNeedsGuard(client)) await expungeGuard(client, source.path, found, `move messages out of "${source.path}"`);
        if (!capability(client, 'MOVE')) return copyThenDelete(client, source, destination, found, result);
        const res = await client.messageMove(toSequenceSet(found), destination.path, { uid: true });
        if (!res) throw new MailError('SERVER', `The server did not move the messages to "${destination.path}"; nothing was moved.`);
        result.moved = found.length;
        const newUids = uidMapRecord(res.uidMap);
        if (newUids) result.new_uids = newUids;
        return result;
      },
      { readOnly: false, retry: false },
    );
  } finally {
    registry.invalidateCounts();
  }
}

/**
 * The move for servers without MOVE (iCloud), done step by step so a failure after the COPY is
 * reported truthfully: the copies then already exist in the destination, and "did not move" would
 * invite a retry that duplicates them.
 */
async function copyThenDelete(client: ImapFlow, source: MailboxInfo, destination: MailboxInfo, found: readonly number[], result: MoveResult): Promise<MoveResult> {
  const set = toSequenceSet(found);
  const copy = await client.messageCopy(set, destination.path, { uid: true });
  if (!copy) throw new MailError('SERVER', `The server did not copy the messages to "${destination.path}"; nothing was moved.`);
  const newUids = uidMapRecord(copy.uidMap);
  let removed = false;
  try {
    removed = (await client.messageDelete(set, { uid: true })) === true;
  } catch {
    removed = false;
  }
  if (removed) {
    result.moved = found.length;
    if (newUids) result.new_uids = newUids;
    return result;
  }
  // The copy exists; find out what state the originals are in.
  let allFlaggedDeleted = false;
  if (client.usable) {
    try {
      const msgs = await client.fetchAll(set, { uid: true, flags: true }, { uid: true });
      const byUid = new Map(msgs.map((m) => [m.uid, m]));
      allFlaggedDeleted = found.every((u) => {
        const m = byUid.get(u);
        return !m || hasFlag(m.flags ?? [], DELETED);
      });
    } catch {
      allFlaggedDeleted = false;
    }
  }
  const newList = newUids ? ` (new UIDs there: ${Object.values(newUids).slice(0, 50).join(', ')})` : '';
  if (allFlaggedDeleted) {
    // STORE \Deleted worked, only the final EXPUNGE failed: the move is effectively done.
    result.moved = found.length;
    if (newUids) result.new_uids = newUids;
    result.warning = `The messages were copied to "${destination.path}" and marked as deleted in "${source.path}", but the server did not finish removing them there (EXPUNGE failed). They are hidden from searches and will be purged later; do not move them again.`;
    return result;
  }
  throw new MailError(
    'SERVER',
    `Copied ${found.length} message(s) to "${destination.path}"${newList}, but could not remove them from "${source.path}": they may now exist in both folders. Do not retry the move; check both folders, then trash the originals in "${source.path}" if they are still there.`,
    { details: { copied: found.length, destination: destination.path, ...(newUids ? { new_uids: newUids } : {}) } },
  );
}

export interface DeleteResult {
  mailbox: string;
  deleted: number;
  not_found: number[];
}

export async function deleteMessagesPermanently(imap: ImapManager, registry: MailboxRegistry, mailbox: MailboxInfo, uidsIn: readonly number[]): Promise<DeleteResult> {
  const uids = validateUids(uidsIn);
  try {
    return await imap.withMailbox(
      mailbox.path,
      async (client) => {
        const { found, notFound } = await verifyUids(client, uids);
        if (found.length === 0) return { mailbox: mailbox.path, deleted: 0, not_found: notFound };
        if (deleteNeedsGuard(client)) await expungeGuard(client, mailbox.path, found, `permanently delete messages in "${mailbox.path}"`);
        const ok = await client.messageDelete(toSequenceSet(found), { uid: true });
        if (!ok) throw new MailError('SERVER', 'The server did not delete the messages.');
        return { mailbox: mailbox.path, deleted: found.length, not_found: notFound };
      },
      { readOnly: false, retry: false },
    );
  } finally {
    registry.invalidateCounts();
  }
}

/** Subjects of the given UIDs (for confirmation dialogs / audit), in UID order. */
export async function fetchSubjects(imap: ImapManager, mailboxPath: string, uids: readonly number[]): Promise<Array<{ uid: number; subject: string }>> {
  if (uids.length === 0) return [];
  return imap.withMailbox(
    mailboxPath,
    async (client) => {
      const msgs = await client.fetchAll(toSequenceSet(uids), { uid: true, envelope: true, flags: true }, { uid: true });
      return msgs
        .filter((m) => !hasFlag(m.flags ?? [], DELETED))
        .map((m) => ({ uid: m.uid, subject: m.envelope?.subject ?? '' }))
        .sort((a, b) => a.uid - b.uid);
    },
    { readOnly: true },
  );
}

// ---------------------------------------------------------------------------------------------
// Append / drafts
// ---------------------------------------------------------------------------------------------

export interface AppendResult {
  mailbox: string;
  uid: number | null;
  /** Flags read back from the appended message (null when its UID is not known). */
  flags: string[] | null;
}

/**
 * APPEND with flags. Runs with the destination SELECTed read-write under the mailbox lock:
 * imapflow filters APPEND flags against the PERMANENTFLAGS of whatever mailbox is currently
 * selected, and an EXAMINEd (read-only) mailbox reports none, which would silently drop
 * \Seen / \Draft. Flags are read back so callers can report what actually took effect.
 *
 * The new UID is trusted only from APPENDUID (UIDPLUS). Without it imapflow guesses the UID from
 * the EXISTS count, which is another client's message when mail arrives (or Apple Mail autosaves a
 * draft) at the same moment; then the UID is looked up by `messageId` and kept only if exactly one
 * message matches.
 */
export async function appendMessage(
  imap: ImapManager,
  registry: MailboxRegistry,
  mailboxPath: string,
  raw: Buffer,
  flags: string[],
  date?: Date,
  messageId?: string,
): Promise<AppendResult> {
  try {
    return await imap.withMailbox(
      mailboxPath,
      async (client) => {
        const res = await client.append(mailboxPath, raw, flags, date);
        if (!res) throw new MailError('SERVER', `The server did not accept the message into "${mailboxPath}".`);
        let uid: number | null = null;
        if (typeof res.uid === 'number' && res.uidValidity !== undefined) {
          uid = res.uid;
        } else if (messageId) {
          const hits = await searchStrict(client, { header: { 'message-id': messageId }, deleted: false }).catch(() => []);
          uid = hits.length === 1 ? (hits[0] ?? null) : null;
        }
        let applied: string[] | null = null;
        if (uid !== null) {
          const msg = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
          applied = msg ? [...(msg.flags ?? [])].filter((f) => f !== '\\Recent') : null;
        }
        return { mailbox: res.destination || mailboxPath, uid, flags: applied };
      },
      { readOnly: false, retry: false },
    );
  } finally {
    registry.invalidateCounts();
  }
}

/** UIDs of messages with this Message-ID (not \Deleted) in a mailbox. A failed SEARCH throws. */
export async function findByMessageId(imap: ImapManager, mailboxPath: string, messageId: string): Promise<number[]> {
  return imap.withMailbox(mailboxPath, (client) => searchStrict(client, { header: { 'message-id': messageId }, deleted: false }), { readOnly: true });
}

export interface DraftCheck {
  uid: number;
  messageId: string | null;
}

/** Check that `uid` in Drafts is a real draft (has \Draft, not \Deleted) before replacing it. */
export async function checkReplaceableDraft(imap: ImapManager, drafts: MailboxInfo, uid: number): Promise<DraftCheck> {
  validateUids([uid]);
  return imap.withMailbox(
    drafts.path,
    async (client) => {
      const msg = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true }, { uid: true });
      if (!msg || msg.uid !== uid || hasFlag(msg.flags ?? [], DELETED)) {
        throw new MailError('NOT_FOUND', `replace_draft_uid ${uid} was not found in "${drafts.path}".`);
      }
      if (!hasFlag(msg.flags ?? [], DRAFT)) {
        throw new MailError('FORBIDDEN', `Message ${uid} in "${drafts.path}" is not marked as a draft (\\Draft), so it will not be replaced.`);
      }
      if (deleteNeedsGuard(client)) await expungeGuard(client, drafts.path, [uid], 'replace the draft');
      const mid = msg.envelope?.messageId ? (extractMessageIds(msg.envelope.messageId)[0] ?? msg.envelope.messageId) : null;
      return { uid, messageId: mid };
    },
    { readOnly: true },
  );
}

/**
 * Permanently remove a draft this server saved itself (same Message-ID as recorded when it was
 * saved), after its replacement was saved or it was sent. Re-checks \Draft, the Message-ID and the
 * expunge guard. Other drafts are moved to Trash instead (see MailService).
 */
export async function deleteDraft(imap: ImapManager, registry: MailboxRegistry, drafts: MailboxInfo, uid: number, expectedMessageId: string): Promise<void> {
  try {
    await imap.withMailbox(
      drafts.path,
      async (client) => {
        const msg = await client.fetchOne(String(uid), { uid: true, flags: true, envelope: true }, { uid: true });
        if (!msg || msg.uid !== uid || hasFlag(msg.flags ?? [], DELETED)) throw new MailError('NOT_FOUND', `Draft ${uid} no longer exists in "${drafts.path}".`);
        if (!hasFlag(msg.flags ?? [], DRAFT)) throw new MailError('FORBIDDEN', `Message ${uid} is not marked as a draft; not deleting it.`);
        const mid = msg.envelope?.messageId ? (extractMessageIds(msg.envelope.messageId)[0] ?? msg.envelope.messageId) : null;
        if (!mid || mid.toLowerCase() !== expectedMessageId.toLowerCase()) {
          throw new MailError('FORBIDDEN', `Draft ${uid} is not the draft this server saved (its Message-ID changed); not deleting it.`);
        }
        if (deleteNeedsGuard(client)) await expungeGuard(client, drafts.path, [uid], 'replace the draft');
        const ok = await client.messageDelete(String(uid), { uid: true });
        if (!ok) throw new MailError('SERVER', `The server did not delete draft ${uid}.`);
      },
      { readOnly: false, retry: false },
    );
  } finally {
    registry.invalidateCounts();
  }
}

// ---------------------------------------------------------------------------------------------
// Mailbox management
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const MAILBOX_NAME_FORBIDDEN = /[\u0000-\u001f\u007f*%]/;

/** Normalise a user-supplied mailbox path: "/" maps to the server delimiter; validates segments. */
export function normalizeNewMailboxPath(input: string, delimiter: string): string {
  const raw = input.trim().normalize('NFC');
  if (!raw) throw new MailError('INVALID_INPUT', 'Mailbox path is empty.');
  if (MAILBOX_NAME_FORBIDDEN.test(raw)) throw new MailError('INVALID_INPUT', 'Mailbox names cannot contain control characters, "*" or "%".');
  if (raw.length > 500) throw new MailError('INVALID_INPUT', 'Mailbox path is too long.');
  const segments = raw.split('/').flatMap((s) => (delimiter === '/' ? [s] : s.split(delimiter)));
  if (segments.some((s) => s.trim() === '')) throw new MailError('INVALID_INPUT', `Mailbox path "${input}" has an empty folder name (check for doubled or trailing "/").`);
  return segments.map((s) => s.trim()).join(delimiter);
}

function delimiterOf(mailboxes: readonly MailboxInfo[]): string {
  return mailboxes.find((m) => isInboxPath(m.path))?.delimiter ?? mailboxes[0]?.delimiter ?? '/';
}

function findExisting(path: string, mailboxes: readonly MailboxInfo[]): MailboxInfo | undefined {
  return mailboxes.find((m) => m.path === path) ?? mailboxes.find((m) => fold(m.path) === fold(path));
}

function refuseSpecial(m: MailboxInfo, action: string): void {
  if (m.specialUse === 'inbox' || isInboxPath(m.path)) throw new MailError('FORBIDDEN', `INBOX cannot be ${action}.`);
  if (m.specialUse) throw new MailError('FORBIDDEN', `"${m.path}" is the ${m.specialUse} folder and cannot be ${action}.`);
}

export async function createMailbox(imap: ImapManager, registry: MailboxRegistry, input: string): Promise<{ path: string; created: boolean }> {
  const mailboxes = await registry.list({ refresh: true });
  const delimiter = delimiterOf(mailboxes);
  const path = normalizeNewMailboxPath(input, delimiter);
  const existing = findExisting(path, mailboxes);
  if (existing) throw new MailError('CONFLICT', `Mailbox "${existing.path}" already exists.`);
  const segments = path.split(delimiter);
  const parentPath = segments.slice(0, -1).join(delimiter);
  if (parentPath) {
    const parent = findExisting(parentPath, mailboxes);
    if (parent?.noInferiors) {
      throw new MailError('FORBIDDEN', `"${parent.path}" cannot contain subfolders on this server (\\NoInferiors). Create the folder at the top level instead.`);
    }
    if (!parent && isInboxPath(segments[0] ?? '')) {
      const inbox = mailboxes.find((m) => isInboxPath(m.path));
      if (inbox?.noInferiors) throw new MailError('FORBIDDEN', 'iCloud does not allow folders inside INBOX (\\NoInferiors). Create the folder at the top level instead.');
    }
  }
  if (imap.signal?.aborted) throw new MailError('CANCELLED', 'Cancelled before creating the mailbox; nothing was changed.');
  try {
    const res = await imap.run((client) => client.mailboxCreate(path));
    if (!res.created) throw new MailError('CONFLICT', `Mailbox "${res.path}" already exists.`);
    return { path: res.path, created: true };
  } finally {
    registry.invalidate();
  }
}

export async function renameMailbox(imap: ImapManager, registry: MailboxRegistry, from: MailboxInfo, newPathInput: string): Promise<{ path: string; new_path: string }> {
  refuseSpecial(from, 'renamed');
  const mailboxes = await registry.list({ refresh: true });
  const newPath = normalizeNewMailboxPath(newPathInput, from.delimiter || delimiterOf(mailboxes));
  if (newPath === from.path) throw new MailError('INVALID_INPUT', 'The new name is the same as the current one.');
  const existing = findExisting(newPath, mailboxes);
  if (existing && existing.path !== from.path) throw new MailError('CONFLICT', `Mailbox "${existing.path}" already exists.`);
  if (newPath.startsWith(from.path + from.delimiter)) throw new MailError('INVALID_INPUT', 'A mailbox cannot be moved inside itself.');
  if (imap.signal?.aborted) throw new MailError('CANCELLED', 'Cancelled before renaming the mailbox; nothing was changed.');
  try {
    // imapflow sends CLOSE before RENAME when the folder is the selected one, and CLOSE on a
    // read-write (SELECTed) mailbox silently expunges every \Deleted message in it, including
    // other clients' pending deletions. Renaming under a read-only lock makes imapflow EXAMINE the
    // folder first, so that CLOSE expunges nothing.
    const res = from.selectable
      ? await imap.withMailbox(from.path, (client) => client.mailboxRename(from.path, newPath), { readOnly: true, retry: false })
      : await imap.run((client) => client.mailboxRename(from.path, newPath));
    return { path: res.path || from.path, new_path: res.newPath || newPath };
  } finally {
    registry.invalidate();
  }
}

export async function deleteMailbox(imap: ImapManager, registry: MailboxRegistry, mailbox: MailboxInfo): Promise<{ path: string; deleted: true }> {
  refuseSpecial(mailbox, 'deleted');
  const mailboxes = await registry.list({ refresh: true });
  const current = mailboxes.find((m) => m.path === mailbox.path);
  if (!current) throw new MailError('NOT_FOUND', `Mailbox "${mailbox.path}" no longer exists.`);
  const children = mailboxes.filter((m) => m.path.startsWith(current.path + current.delimiter));
  if (children.length > 0) {
    throw new MailError('CONFLICT', `"${current.path}" still contains folders (${children.map((c) => c.path).join(', ')}). Move or delete them first.`);
  }
  if (current.selectable) {
    const status = await imap.run((client) => client.status(current.path, { messages: true }));
    const count = status && typeof status.messages === 'number' ? status.messages : null;
    if (count === null) throw new MailError('SERVER', `Could not read the message count of "${current.path}", so it was not deleted.`);
    if (count > 0) {
      throw new MailError('CONFLICT', `"${current.path}" still contains ${count} message(s). Only empty mailboxes can be deleted; move or trash the messages first.`);
    }
  }
  if (imap.signal?.aborted) throw new MailError('CANCELLED', 'Cancelled before deleting the mailbox; nothing was changed.');
  try {
    if (current.selectable) {
      // Under a read-only lock (EXAMINE), so imapflow's CLOSE before DELETE never expunges, and
      // with a last emptiness check: DELETE would remove messages that arrived since the STATUS.
      await imap.withMailbox(
        current.path,
        async (client, box) => {
          if (box.exists > 0) throw new MailError('CONFLICT', `"${current.path}" still contains ${box.exists} message(s). Only empty mailboxes can be deleted.`);
          await client.mailboxDelete(current.path);
        },
        { readOnly: true, retry: false },
      );
    } else {
      await imap.run((client) => client.mailboxDelete(current.path));
    }
    return { path: current.path, deleted: true };
  } finally {
    registry.invalidate();
  }
}
