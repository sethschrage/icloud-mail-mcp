/**
 * Mailbox listing, special-folder resolution and name resolution (SPEC §4).
 */
import type { ListResponse } from 'imapflow';
import type { Config, SpecialFolder } from '../config.js';
import { MailError } from '../errors.js';
import type { ImapManager } from './client.js';

export type SpecialUse = 'inbox' | SpecialFolder;

export const SPECIAL_ORDER: readonly SpecialFolder[] = ['drafts', 'sent', 'archive', 'junk', 'trash'];

/** iCloud's folder names, used when neither an override nor SPECIAL-USE/name detection finds one. */
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
    selectable,
    noInferiors: flags.has('\\noinferiors'),
    hasChildren: flags.has('\\haschildren'),
    total: selectable && typeof entry.status?.messages === 'number' ? entry.status.messages : null,
    unread: selectable && typeof entry.status?.unseen === 'number' ? entry.status.unseen : null,
    flags: [...entry.flags],
  };
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

/** Decide the special-folder mapping: env override > server/imapflow special-use > iCloud names. */
export function computeSpecialMap(mailboxes: readonly MailboxInfo[], overrides: Partial<Record<SpecialFolder, string>>): SpecialResolution {
  const map: SpecialMap = { inbox: mailboxes.find((m) => isInboxPath(m.path)) ?? null, sent: null, trash: null, drafts: null, junk: null, archive: null };
  const missingOverrides: Partial<Record<SpecialFolder, string>> = {};
  for (const kind of SPECIAL_ORDER) {
    const override = overrides[kind];
    if (override) {
      const found = findByName(override, mailboxes);
      if (found && found !== 'ambiguous') {
        map[kind] = found;
        continue;
      }
      missingOverrides[kind] = override;
      continue;
    }
    const byServer = mailboxes.find((m) => m.serverSpecialUse === kind && m.selectable);
    if (byServer) {
      map[kind] = byServer;
      continue;
    }
    const defaultName = fold(ICLOUD_DEFAULT_NAMES[kind]);
    map[kind] = mailboxes.find((m) => fold(m.path) === defaultName && m.selectable) ?? null;
  }
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
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  mailboxes: MailboxInfo[];
  special: SpecialResolution;
}

/** Cached LIST (+ STATUS messages/unseen) for 60 s, with special-folder resolution. */
export class MailboxRegistry {
  private cache: CacheEntry | null = null;
  private inFlight: Promise<CacheEntry> | null = null;
  private generation = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly imap: ImapManager,
    private readonly config: Config,
    options: MailboxRegistryOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  invalidate(): void {
    this.cache = null;
    this.generation++;
  }

  private async load(): Promise<CacheEntry> {
    const generation = this.generation;
    const entries = await this.imap.run((client) => client.list({ statusQuery: { messages: true, unseen: true } }), { retry: true });
    const infos = entries.map(toMailboxInfo);
    for (const m of infos) {
      if (!m.hasChildren) m.hasChildren = infos.some((o) => o !== m && o.path.startsWith(m.path + m.delimiter));
    }
    const special = computeSpecialMap(infos, this.config.mailboxOverrides);
    const labelled = labelSpecials(infos, special.map);
    const labelledMap = computeSpecialMap(labelled, this.config.mailboxOverrides);
    const entry: CacheEntry = { at: this.now(), mailboxes: sortMailboxesForDisplay(labelled), special: labelledMap };
    if (generation === this.generation) this.cache = entry;
    return entry;
  }

  private async entry(refresh = false): Promise<CacheEntry> {
    if (!refresh && this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache;
    if (refresh) this.invalidate();
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** All mailboxes (INBOX, specials, rest), with counts. */
  async list(options: { refresh?: boolean } = {}): Promise<MailboxInfo[]> {
    return (await this.entry(options.refresh)).mailboxes;
  }

  async specialResolution(): Promise<SpecialResolution> {
    return (await this.entry()).special;
  }

  /**
   * Resolve a user-supplied mailbox name. A miss on a cached list triggers one refresh (the folder
   * may have been created in Apple Mail within the last minute).
   */
  async resolve(input: string, options: { requireSelectable?: boolean } = {}): Promise<MailboxInfo> {
    let entry = await this.entry();
    let mailbox: MailboxInfo;
    try {
      mailbox = resolveMailboxName(input, entry.mailboxes, entry.special.map);
    } catch (err) {
      if (!(err instanceof MailError) || err.code !== 'NOT_FOUND') throw err;
      entry = await this.entry(true);
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

  /** Selectable mailboxes searched by all_mailboxes: everything except Trash, Junk and Notes. */
  async searchableMailboxes(): Promise<MailboxInfo[]> {
    const mailboxes = await this.list();
    return mailboxes.filter((m) => m.selectable && m.specialUse !== 'trash' && m.specialUse !== 'junk' && !isNotesMailbox(m));
  }
}
