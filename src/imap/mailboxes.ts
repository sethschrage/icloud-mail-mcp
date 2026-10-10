/**
 * Mailbox listing, special-folder resolution and name resolution (SPEC §4).
 */
import type { ListResponse } from 'imapflow';
import type { Config, SpecialFolder } from '../config.js';
import { MailError } from '../errors.js';
import type { ImapManager } from './client.js';

export type SpecialUse = 'inbox' | SpecialFolder;

export const SPECIAL_ORDER: readonly SpecialFolder[] = ['drafts', 'sent', 'archive', 'junk', 'trash'];

/**
 * iCloud's own folder names. Without SPECIAL-USE (iCloud advertises none), a top-level folder with
 * exactly this name wins over imapflow's name guess, which would otherwise pick e.g. an Outlook
 * "Sent Items" or "Deleted Items" folder that sorts before Apple's folder (see computeSpecialMap).
 */
export const ICLOUD_DEFAULT_NAMES: Record<SpecialFolder, string> = {
  sent: 'Sent Messages',
  trash: 'Deleted Messages',
  drafts: 'Drafts',
  junk: 'Junk',
  archive: 'Archive',
};

export const OVERRIDE_ENV: Record<SpecialFolder, string> = {
  sent: 'MAIL_SENT_MAILBOX',
  trash: 'MAIL_TRASH_MAILBOX',
  archive: 'MAIL_ARCHIVE_MAILBOX',
  drafts: 'MAIL_DRAFTS_MAILBOX',
  junk: 'MAIL_JUNK_MAILBOX',
};

/** Case-insensitive aliases accepted wherever a mailbox name is expected. */
export const SPECIAL_ALIASES: Readonly<Record<string, SpecialUse>> = {
  inbox: 'inbox',
  sent: 'sent',
  'sent messages': 'sent',
  'sent items': 'sent',
  trash: 'trash',
  deleted: 'trash',
  'deleted messages': 'trash',
  bin: 'trash',
  junk: 'junk',
  spam: 'junk',
  drafts: 'drafts',
  archive: 'archive',
};

const IMAP_SPECIAL_USE: Record<string, SpecialFolder> = {
  '\\sent': 'sent',
  '\\trash': 'trash',
  '\\drafts': 'drafts',
  '\\junk': 'junk',
  '\\archive': 'archive',
};

export interface MailboxInfo {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  /** Special use as decided by this server's resolution (not just the server's attribute). */
  specialUse: SpecialUse | null;
  /** What imapflow/the server reported (\Sent etc.), before our resolution. */
  serverSpecialUse: SpecialFolder | null;
  /**
   * Where imapflow's specialUse came from: 'extension' (a real SPECIAL-USE/XLIST attribute),
   * 'user' (an explicit hint) or 'name' (imapflow guessed it from the folder name).
   */
  serverSpecialUseSource: 'user' | 'extension' | 'name' | null;
  selectable: boolean;
  noInferiors: boolean;
  hasChildren: boolean;
  total: number | null;
  unread: number | null;
  flags: string[];
}

export type SpecialMap = Record<SpecialUse, MailboxInfo | null>;

export interface SpecialResolution {
  map: SpecialMap;
  /** Overrides that point at a mailbox that does not exist. */
  missingOverrides: Partial<Record<SpecialFolder, string>>;
}

export function fold(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

export function isInboxPath(path: string): boolean {
  return path.toUpperCase() === 'INBOX';
}

function flagSet(flags: Iterable<string>): Set<string> {
  return new Set([...flags].map((f) => f.toLowerCase()));
}

export function toMailboxInfo(entry: ListResponse): MailboxInfo {
  const flags = flagSet(entry.flags);
  const serverSpecial = entry.specialUse ? (IMAP_SPECIAL_USE[entry.specialUse.toLowerCase()] ?? null) : null;
  const selectable = !flags.has('\\noselect') && !flags.has('\\nonexistent');
  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter || '/',
    parentPath: entry.parentPath ?? '',
    specialUse: isInboxPath(entry.path) ? 'inbox' : null,
    serverSpecialUse: serverSpecial,
    serverSpecialUseSource: serverSpecial ? (entry.specialUseSource ?? 'name') : null,
    selectable,
    noInferiors: flags.has('\\noinferiors'),
    hasChildren: flags.has('\\haschildren'),
    total: selectable && typeof entry.status?.messages === 'number' ? entry.status.messages : null,
    unread: selectable && typeof entry.status?.unseen === 'number' ? entry.status.unseen : null,
    flags: [...entry.flags],
  };
}

/**
 * The server's "every message" mailbox: RFC 6154 \All, which Gmail uses for "[Gmail]/All Mail".
 * On Gmail each label is a folder holding copies of the same messages, so this one mailbox stands
 * in for all of them (see searchableMailboxes) and is where archived mail lives (computeSpecialMap).
 */
export function isAllMailbox(m: MailboxInfo): boolean {
  return m.selectable && m.flags.some((f) => f.toLowerCase() === '\\all');
}

/** Find a mailbox by exact path, then by NFC/case-folded path, then by unique folded name. */
function findByName(input: string, mailboxes: readonly MailboxInfo[]): MailboxInfo | null | 'ambiguous' {
  const exact = mailboxes.find((m) => m.path === input);
  if (exact) return exact;
  if (isInboxPath(input)) return mailboxes.find((m) => isInboxPath(m.path)) ?? null;
  const candidates = new Set([fold(input)]);
  for (const m of mailboxes) if (m.delimiter !== '/') candidates.add(fold(input.split('/').join(m.delimiter)));
  const byPath = mailboxes.filter((m) => candidates.has(fold(m.path)));
  if (byPath.length === 1) return byPath[0] ?? null;
  if (byPath.length > 1) {
    // Several paths differ only by case/normalisation: prefer the NFC-identical one.
    const nfc = byPath.find((m) => m.path.normalize('NFC') === input.normalize('NFC'));
    return nfc ?? 'ambiguous';
  }
  const byName = mailboxes.filter((m) => candidates.has(fold(m.name)));
  if (byName.length === 1) return byName[0] ?? null;
  if (byName.length > 1) return 'ambiguous';
  return null;
}

/**
 * Decide the special-folder mapping. Per kind, first match wins:
 * 1. env override (MAIL_SENT_MAILBOX, …);
 * 2. a real server attribute: imapflow specialUse with source 'extension' (SPECIAL-USE/XLIST) or 'user';
 * 3. a selectable top-level folder named exactly as iCloud names it ("Sent Messages", "Deleted
 *    Messages", "Drafts", "Junk", "Archive"), whatever imapflow guessed for it. iCloud has no
 *    SPECIAL-USE, so imapflow guesses from names and, when several folders match one type, gives
 *    it to the alphabetically first path: a stray "Sent Items", "Bin" or "Draft" from another
 *    client would otherwise replace Apple's real folder (and imapflow then strips the guess from
 *    the real one);
 * 4. imapflow's name guess, for a selectable top-level folder only (a nested "Old Mail/Sent" or
 *    "Clients/Trash" is a user folder, never the special one);
 * 5. archive only: the \All mailbox (Gmail's "[Gmail]/All Mail"), since archiving there is what
 *    Gmail's Archive does and creating an "Archive" folder would only add a label;
 * 6. none.
 * A mailbox is used for at most one kind.
 */
export function computeSpecialMap(mailboxes: readonly MailboxInfo[], overrides: Partial<Record<SpecialFolder, string>>): SpecialResolution {
  const map: SpecialMap = { inbox: mailboxes.find((m) => isInboxPath(m.path)) ?? null, sent: null, trash: null, drafts: null, junk: null, archive: null };
  const missingOverrides: Partial<Record<SpecialFolder, string>> = {};
  const used = new Set<string>();
  const take = (kind: SpecialFolder, m: MailboxInfo | null | undefined): boolean => {
    if (!m) return false;
    map[kind] = m;
    used.add(m.path);
    return true;
  };
  const free = (m: MailboxInfo): boolean => m.selectable && !used.has(m.path) && !isInboxPath(m.path);
  // Overrides first for every kind, so a guess never claims a folder an override names.
  for (const kind of SPECIAL_ORDER) {
    const override = overrides[kind];
    if (!override) continue;
    const found = findByName(override, mailboxes);
    if (found && found !== 'ambiguous') take(kind, found);
    else missingOverrides[kind] = override;
  }
  const pending = SPECIAL_ORDER.filter((kind) => !overrides[kind]);
  for (const kind of pending) {
    take(kind, mailboxes.find((m) => free(m) && m.serverSpecialUse === kind && (m.serverSpecialUseSource === 'extension' || m.serverSpecialUseSource === 'user')));
  }
  for (const kind of pending) {
    if (map[kind]) continue;
    const defaultName = fold(ICLOUD_DEFAULT_NAMES[kind]);
    take(kind, mailboxes.find((m) => free(m) && m.parentPath === '' && fold(m.path) === defaultName));
  }
  for (const kind of pending) {
    if (map[kind]) continue;
    take(kind, mailboxes.find((m) => free(m) && m.parentPath === '' && m.serverSpecialUse === kind));
  }
  if (pending.includes('archive') && !map.archive) take('archive', mailboxes.find((m) => free(m) && isAllMailbox(m)));
  return { map, missingOverrides };
}

/** Apply the special map to the per-mailbox `specialUse` labels. */
export function labelSpecials(mailboxes: readonly MailboxInfo[], map: SpecialMap): MailboxInfo[] {
  const byPath = new Map<string, SpecialUse>();
  for (const kind of Object.keys(map) as SpecialUse[]) {
    const m = map[kind];
    if (m) byPath.set(m.path, kind);
  }
  return mailboxes.map((m) => ({ ...m, specialUse: byPath.get(m.path) ?? null }));
}

/** INBOX first, then special folders (Apple Mail order), then everything else alphabetically. */
export function sortMailboxesForDisplay(mailboxes: readonly MailboxInfo[]): MailboxInfo[] {
  const rank = (m: MailboxInfo): number => {
    if (m.specialUse === 'inbox') return 0;
    if (m.specialUse) return 1 + SPECIAL_ORDER.indexOf(m.specialUse);
    return 10;
  };
  return [...mailboxes].sort((a, b) => rank(a) - rank(b) || a.path.normalize('NFC').localeCompare(b.path.normalize('NFC'), 'en', { sensitivity: 'base' }) || (a.path < b.path ? -1 : 1));
}

export function mailboxNotFound(input: string, mailboxes: readonly MailboxInfo[], extra = ''): MailError {
  const names = mailboxes.map((m) => (m.selectable ? m.path : `${m.path} (not selectable)`)).join(', ');
  return new MailError('NOT_FOUND', `Mailbox "${input}" was not found.${extra} Available mailboxes: ${names}.`);
}

/**
 * Resolve a user-supplied mailbox string (SPEC §4): exact path, special aliases, then NFC +
 * case-folded comparison against path and (if unique) name. Always returns the server's exact path.
 */
export function resolveMailboxName(input: string, mailboxes: readonly MailboxInfo[], map: SpecialMap): MailboxInfo {
  const raw = input.trim();
  if (!raw) throw new MailError('INVALID_INPUT', 'Mailbox name is empty.');
  const exact = mailboxes.find((m) => m.path === raw);
  if (exact) return exact;
  const alias = SPECIAL_ALIASES[raw.toLowerCase()];
  if (alias) {
    const special = map[alias];
    if (special) return special;
  }
  const found = findByName(raw, mailboxes);
  if (found === 'ambiguous') {
    const matches = mailboxes.filter((m) => fold(m.name) === fold(raw) || fold(m.path) === fold(raw)).map((m) => m.path);
    throw new MailError('INVALID_INPUT', `Mailbox name "${raw}" is ambiguous; it matches ${matches.join(', ')}. Use the full path.`);
  }
  if (found) return found;
  const hint = alias && !map[alias] ? ` This account has no ${alias} folder.` : '';
  throw mailboxNotFound(raw, mailboxes, hint);
}

/** A legacy IMAP "Notes" folder is listed but never searched with all_mailboxes. */
export function isNotesMailbox(m: MailboxInfo): boolean {
  return m.parentPath === '' && fold(m.name) === 'notes';
}

export interface MailboxRegistryOptions {
  /** How long the folder list (names, special folders) is cached (default 5 minutes). */
  ttlMs?: number;
  /** How long message counts are cached (default 60 s). */
  countsTtlMs?: number;
  now?: () => number;
}

interface NamesEntry {
  at: number;
  mailboxes: MailboxInfo[];
  special: SpecialResolution;
}

interface CountsEntry {
  at: number;
  counts: Map<string, { total: number | null; unread: number | null }>;
}

interface InFlight<T> {
  gen: number;
  p: Promise<T>;
}

/**
 * Cached folder list with special-folder resolution (SPEC §4), in two parts:
 * - names (LIST only; 5 minutes): what every tool needs to resolve a mailbox name. Invalidated by
 *   create/rename/delete, Archive auto-creation, a resolve miss or a vanished mailbox. Moves and
 *   flag changes do not touch it, so the call after a change does not pay a full relisting;
 * - counts (STATUS messages/unseen; 60 s): only list_mailboxes with include_counts loads them.
 *   iCloud has no LIST-STATUS, so that is one STATUS command per folder. Moves, flag changes,
 *   appends and mark-as-read invalidate only the counts.
 *
 * Each cache has a generation. A refresh never reuses a load that started before the change it
 * must pick up (the old load's result is neither cached nor handed to the refreshing caller).
 */
export class MailboxRegistry {
  private names: NamesEntry | null = null;
  private namesGen = 0;
  private namesInFlight: InFlight<NamesEntry> | null = null;
  private counts: CountsEntry | null = null;
  private countsGen = 0;
  private countsInFlight: InFlight<CountsEntry> | null = null;
  private readonly ttlMs: number;
  private readonly countsTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly imap: ImapManager,
    private readonly config: Config,
    options: MailboxRegistryOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.countsTtlMs = options.countsTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
    // A folder that vanished (renamed or deleted in Apple Mail) makes the cached names stale.
    imap.onMailboxMissing = () => this.invalidate();
  }

  /** Forget everything (after a folder was created, renamed or deleted). */
  invalidate(): void {
    this.names = null;
    this.namesGen++;
    this.invalidateCounts();
  }

  /** Forget the message counts only (after moves, flag changes, appends). */
  invalidateCounts(): void {
    this.counts = null;
    this.countsGen++;
  }

  private async loadNames(gen: number): Promise<NamesEntry> {
    const entries = await this.imap.run((client) => client.list(), { retry: true });
    const infos = entries.map(toMailboxInfo);
    for (const m of infos) {
      if (!m.hasChildren) m.hasChildren = infos.some((o) => o !== m && o.path.startsWith(m.path + m.delimiter));
    }
    const special = computeSpecialMap(infos, this.config.mailboxOverrides);
    const labelled = labelSpecials(infos, special.map);
    const labelledMap = computeSpecialMap(labelled, this.config.mailboxOverrides);
    const entry: NamesEntry = { at: this.now(), mailboxes: sortMailboxesForDisplay(labelled), special: labelledMap };
    if (gen === this.namesGen) this.names = entry;
    return entry;
  }

  private async namesEntry(refresh = false): Promise<NamesEntry> {
    if (!refresh && this.names && this.now() - this.names.at < this.ttlMs) return this.names;
    if (refresh) this.invalidate();
    const gen = this.namesGen;
    if (!this.namesInFlight || this.namesInFlight.gen !== gen) {
      const p = this.loadNames(gen).finally(() => {
        if (this.namesInFlight?.p === p) this.namesInFlight = null;
      });
      this.namesInFlight = { gen, p };
    }
    return this.namesInFlight.p;
  }

  private async loadCounts(gen: number): Promise<CountsEntry> {
    const entries = await this.imap.run((client) => client.list({ statusQuery: { messages: true, unseen: true } }), { retry: true });
    const counts = new Map<string, { total: number | null; unread: number | null }>();
    for (const e of entries) {
      const m = toMailboxInfo(e);
      counts.set(m.path, { total: m.total, unread: m.unread });
    }
    const entry: CountsEntry = { at: this.now(), counts };
    if (gen === this.countsGen) this.counts = entry;
    return entry;
  }

  private async countsEntry(): Promise<CountsEntry> {
    if (this.counts && this.now() - this.counts.at < this.countsTtlMs) return this.counts;
    const gen = this.countsGen;
    if (!this.countsInFlight || this.countsInFlight.gen !== gen) {
      const p = this.loadCounts(gen).finally(() => {
        if (this.countsInFlight?.p === p) this.countsInFlight = null;
      });
      this.countsInFlight = { gen, p };
    }
    return this.countsInFlight.p;
  }

  /**
   * All mailboxes (INBOX, specials, rest). `total`/`unread` are null unless `counts: true`, which
   * costs one STATUS per folder on iCloud.
   */
  async list(options: { refresh?: boolean; counts?: boolean } = {}): Promise<MailboxInfo[]> {
    const names = await this.namesEntry(options.refresh);
    if (!options.counts) return names.mailboxes;
    const counts = await this.countsEntry();
    return names.mailboxes.map((m) => {
      const c = counts.counts.get(m.path);
      return { ...m, total: m.selectable ? (c?.total ?? null) : null, unread: m.selectable ? (c?.unread ?? null) : null };
    });
  }

  async specialResolution(): Promise<SpecialResolution> {
    return (await this.namesEntry()).special;
  }

  /**
   * Resolve a user-supplied mailbox name. A miss on a cached list triggers one refresh (the folder
   * may have been created in Apple Mail since the list was cached).
   */
  async resolve(input: string, options: { requireSelectable?: boolean } = {}): Promise<MailboxInfo> {
    let entry = await this.namesEntry();
    let mailbox: MailboxInfo;
    try {
      mailbox = resolveMailboxName(input, entry.mailboxes, entry.special.map);
    } catch (err) {
      if (!(err instanceof MailError) || err.code !== 'NOT_FOUND') throw err;
      entry = await this.namesEntry(true);
      mailbox = resolveMailboxName(input, entry.mailboxes, entry.special.map);
    }
    if ((options.requireSelectable ?? true) && !mailbox.selectable) {
      throw new MailError('INVALID_INPUT', `Mailbox "${mailbox.path}" is a folder container (\\Noselect) and cannot hold messages.`);
    }
    return mailbox;
  }

  /**
   * The mailbox for a special folder, or null if there is none. With `create: true` a missing
   * folder is created under iCloud's default name (used for Archive, as Apple Mail does).
   */
  async resolveSpecial(kind: SpecialFolder, options: { create?: boolean } = {}): Promise<MailboxInfo | null> {
    const { map, missingOverrides } = await this.specialResolution();
    const missing = missingOverrides[kind];
    if (missing) {
      throw new MailError('CONFIG', `${OVERRIDE_ENV[kind]} is set to "${missing}", but no mailbox with that name exists. Fix or clear the setting.`);
    }
    const found = map[kind];
    if (found) return found;
    if (!options.create) return null;
    const name = ICLOUD_DEFAULT_NAMES[kind];
    await this.imap.run((client) => client.mailboxCreate(name));
    this.invalidate();
    const again = (await this.specialResolution()).map[kind];
    if (!again) throw new MailError('SERVER', `Created the "${name}" folder, but it does not appear in the mailbox list.`);
    return again;
  }

  async inbox(): Promise<MailboxInfo> {
    const inbox = (await this.specialResolution()).map.inbox;
    if (!inbox) throw new MailError('SERVER', 'The server did not list an INBOX.');
    return inbox;
  }

  /**
   * Selectable mailboxes searched by all_mailboxes: everything except Trash, Junk and Notes. With an
   * \All mailbox (Gmail) only that one, because every other folder is a label holding copies of
   * messages it already has, which would list each message once per label.
   */
  async searchableMailboxes(): Promise<MailboxInfo[]> {
    const mailboxes = await this.list();
    const all = mailboxes.find(isAllMailbox);
    if (all) return [all];
    return mailboxes.filter((m) => m.selectable && m.specialUse !== 'trash' && m.specialUse !== 'junk' && !isNotesMailbox(m));
  }

  /** Selectable mailboxes all_mailboxes leaves out (Trash, Junk, Notes). */
  async excludedFromAllMailboxes(): Promise<MailboxInfo[]> {
    const mailboxes = await this.list();
    return mailboxes.filter((m) => m.selectable && (m.specialUse === 'trash' || m.specialUse === 'junk' || isNotesMailbox(m)));
  }
}
