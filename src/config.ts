/**
 * Environment parsing -> typed Config (SPEC §3).
 *
 * `loadConfig` never throws: the server must start and list its tools even when the configuration
 * is broken, so problems are collected in `errors` (fatal: every mail tool refuses to run) and
 * `warnings` (a value was adjusted). The password itself is resolved lazily by credentials.ts.
 */
import os from 'node:os';
import path from 'node:path';
import { PATH_VARIABLES, expandPath, type PathContext } from './safety/paths.js';
import { isLogLevel, type LogLevel } from './log.js';
import { isValidEmailAddress } from './smtp/address.js';

export type SpecialFolder = 'sent' | 'trash' | 'archive' | 'drafts' | 'junk';

export interface Config {
  email: string;
  /** App-specific password from ICLOUD_APP_PASSWORD (undefined => Keychain lookup). */
  password: string | undefined;
  keychainService: string;
  /** ICLOUD_IMAP_USER override (undefined => full email, then local-part fallback). */
  imapUser: string | undefined;
  smtpUser: string;
  fromAddress: string;
  fromName: string | undefined;
  /** ICLOUD_EMAIL ∪ MAIL_FROM_ADDRESS ∪ MAIL_ALLOWED_FROM, deduplicated case-insensitively. */
  allowedFrom: string[];
  /**
   * Addresses that belong to the user, for reply recipients and the default reply From: the
   * allowed From set plus, for a legacy @icloud.com/@me.com/@mac.com account, the same name at the
   * other two domains (never used as allowed From: iCloud may refuse to send from them).
   */
  ownAddresses: string[];
  allowSend: boolean;
  allowPermanentDelete: boolean;
  readOnly: boolean;
  confirmDialog: boolean;
  maxSendsPerHour: number;
  maxRecipients: number;
  /** Rolling recipient budgets across all sends (0 = unlimited); iCloud allows 1,000 recipients a day. */
  maxRecipientsPerHour: number;
  maxRecipientsPerDay: number;
  attachmentDir: string;
  attachFromDirs: string[];
  maxBodyChars: number;
  maxAttachmentMb: number;
  /** null when MAIL_AUDIT_LOG=off. */
  auditLog: string | null;
  saveSentCopy: boolean;
  operationTimeoutSeconds: number;
  logLevel: LogLevel;
  timezone: string;
  mailboxOverrides: Partial<Record<SpecialFolder, string>>;
  /** allowPlaintext: IMAP_ALLOW_PLAINTEXT (tests only): without implicit TLS, do not require STARTTLS. */
  imap: { host: string; port: number; secure: boolean; allowPlaintext: boolean };
  smtp: { host: string; port: number; secure: boolean; requireTLS: boolean };
  tlsCaFile: string | undefined;
}

export interface ConfigResult {
  config: Config;
  /** Fatal problems: mail tools must return an isError result explaining these. */
  errors: string[];
  /** Non-fatal adjustments (clamped values etc.). */
  warnings: string[];
}

export interface LoadConfigOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Used when MAIL_TIMEZONE is unset. */
  systemTimezone?: string;
  /** Command-line arguments after the script path (`process.argv.slice(2)`); see parseCommandLine. */
  argv?: readonly string[];
}

export const MAX_BODY_CHARS_CEILING = 100_000;
export const ICLOUD_MAX_RECIPIENTS = 500;
export const ICLOUD_DOMAINS_FOR_OWN = ['icloud.com', 'me.com', 'mac.com'] as const;

/**
 * Titles of the extension settings (manifest.json user_config) for the env vars they set, so error
 * messages name the field a Claude Desktop user actually sees, next to the env var for manual setups.
 */
export const SETTING_LABELS: Readonly<Record<string, string>> = {
  ICLOUD_EMAIL: 'iCloud email address',
  ICLOUD_APP_PASSWORD: 'App-specific password',
  ICLOUD_IMAP_USER: 'IMAP login (optional)',
  MAIL_FROM_ADDRESS: 'From address (optional)',
  MAIL_FROM_NAME: 'Your name (optional)',
  MAIL_ALLOWED_FROM: 'Other From addresses (optional)',
  MAIL_ALLOW_SEND: 'Allow sending',
  MAIL_ALLOW_PERMANENT_DELETE: 'Allow permanent delete',
  MAIL_READ_ONLY: 'Read-only mode',
  MAIL_CONFIRM_DIALOG: 'Confirm on my Mac before sending or permanently deleting',
  MAIL_ATTACHMENT_DIR: 'Attachment download folder',
  MAIL_ATTACH_FROM_DIRS: 'Attach files from',
  MAIL_MAX_BODY_CHARS: 'Maximum email length shown to Claude',
  MAIL_MAX_SENDS_PER_HOUR: 'Maximum emails sent per hour',
  MAIL_MAX_RECIPIENTS_PER_HOUR: 'Maximum recipients per hour',
  MAIL_MAX_RECIPIENTS_PER_DAY: 'Maximum recipients per day',
  MAIL_SENT_MAILBOX: 'Sent folder (optional)',
  MAIL_TRASH_MAILBOX: 'Trash folder (optional)',
  MAIL_DRAFTS_MAILBOX: 'Drafts folder (optional)',
  MAIL_ARCHIVE_MAILBOX: 'Archive folder (optional)',
  MAIL_JUNK_MAILBOX: 'Junk folder (optional)',
};

/** `"<settings title>" (ENV_VAR)` for env vars that have a settings field, else just the env var. */
export function settingName(envVar: string): string {
  const label = SETTING_LABELS[envVar];
  return label ? `"${label}" (${envVar})` : envVar;
}

/** Values of MAIL_ATTACH_FROM_DIRS / --attach-from-dirs that mean "no attachment folders at all". */
const NO_FOLDERS = new Set(['none', 'off']);

const PLACEHOLDER = /^\$\{([^}]+)\}$/;

/**
 * Claude Desktop passes literal `${user_config.x}` for optional blank fields; treat those (and "")
 * as unset. `${HOME}`-style path variables are real values and are expanded later.
 */
export function isUnsetValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  if (v === '') return true;
  const m = PLACEHOLDER.exec(v);
  if (m && !(PATH_VARIABLES as readonly string[]).includes(m[1] ?? '')) return true;
  return false;
}

export function parseBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
      return true;
    case 'false':
    case '0':
    case 'no':
      return false;
    default:
      return undefined;
  }
}

/** Split a comma-separated list, dropping blanks and unexpanded placeholders. */
export function parseList(value: string | undefined): string[] {
  if (isUnsetValue(value)) return [];
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => !isUnsetValue(s));
}

/**
 * Flag after which the .mcpb manifest passes the "Attach files from" folders, one argument per
 * folder. A `multiple: true` directory setting can only reach the server as separate arguments
 * (Claude Desktop expands an array-valued `${user_config.x}` in `args`, not inside an env string).
 */
export const ATTACH_FROM_DIRS_FLAG = '--attach-from-dirs';

export interface CommandLine {
  /** Folders listed after --attach-from-dirs; blanks and unexpanded placeholders are dropped. */
  attachFromDirs: string[];
  /** Arguments that were not understood (reported as a configuration warning, otherwise ignored). */
  unknown: string[];
}

/** Parse the server's command line: `[--attach-from-dirs <folder>...]`. Never throws. */
export function parseCommandLine(argv: readonly string[]): CommandLine {
  const attachFromDirs: string[] = [];
  const unknown: string[] = [];
  let inDirs = false;
  for (const arg of argv) {
    if (arg === ATTACH_FROM_DIRS_FLAG) {
      inDirs = true;
    } else if (inDirs) {
      if (!isUnsetValue(arg)) attachFromDirs.push(arg.trim());
    } else {
      unknown.push(arg);
    }
  }
  return { attachFromDirs, unknown };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function defaultAuditLogPath(platform: NodeJS.Platform, home: string): string {
  return platform === 'darwin'
    ? path.join(home, 'Library', 'Logs', 'icloud-mail-mcp', 'audit.jsonl')
    : path.join(home, '.local', 'state', 'icloud-mail-mcp', 'audit.jsonl');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): ConfigResult {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const pathCtx: PathContext = { home };
  const errors: string[] = [];
  const warnings: string[] = [];
  const cli = parseCommandLine(options.argv ?? []);
  if (cli.unknown.length > 0) {
    const shown = cli.unknown.slice(0, 5).map((a) => JSON.stringify(a.slice(0, 200)));
    warnings.push(`Ignoring unknown command-line argument(s): ${shown.join(' ')}${cli.unknown.length > 5 ? ' …' : ''}.`);
  }

  const str = (name: string): string | undefined => {
    const v = env[name];
    return isUnsetValue(v) ? undefined : (v ?? '').trim();
  };
  const bool = (name: string, def: boolean): boolean => {
    const v = str(name);
    if (v === undefined) return def;
    const b = parseBoolean(v);
    if (b === undefined) {
      errors.push(`${settingName(name)} must be true/false (also accepted: 1/0, yes/no); got "${v}".`);
      return def;
    }
    return b;
  };
  /**
   * Whole-number setting. Strict (ports): anything but digits is an error. Lenient (limits the
   * settings form sends, e.g. "1500.5"): any finite number is rounded and clamped with a warning,
   * so one odd value never disables every tool; only non-numeric text is an error.
   */
  const int = (name: string, def: number, min: number, max: number, opts: { lenient?: boolean } = {}): number => {
    const v = str(name);
    if (v === undefined) return def;
    const label = settingName(name);
    let n: number;
    if (/^-?\d+$/.test(v)) {
      n = Number(v);
    } else if (opts.lenient && Number.isFinite(Number(v))) {
      n = Math.round(Number(v));
      warnings.push(`${label}=${v} is not a whole number; using ${n}.`);
    } else {
      errors.push(`${label} must be a whole number; got "${v}".`);
      return def;
    }
    if (n < min) {
      if (opts.lenient) {
        warnings.push(`${label}=${n} is below the minimum ${min}; using ${min}.`);
        return min;
      }
      errors.push(`${label} must be at least ${min}; got ${n}.`);
      return def;
    }
    if (n > max) {
      warnings.push(`${label}=${n} is above the maximum ${max}; using ${max}.`);
      return max;
    }
    return n;
  };
  const pathValue = (name: string, def: string): string => {
    const v = str(name);
    const expanded = expandPath(v ?? def, pathCtx);
    if (!path.isAbsolute(expanded)) {
      errors.push(`${settingName(name)} must be an absolute path (or start with ~/); got "${v}".`);
      return expandPath(def, pathCtx);
    }
    return expanded;
  };
  const address = (name: string, value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    if (!isValidEmailAddress(value)) {
      errors.push(`${settingName(name)} is not a valid email address: "${value}".`);
      return undefined;
    }
    return value;
  };

  // --- identity -------------------------------------------------------------------------------
  const emailRaw = str('ICLOUD_EMAIL');
  let email = '';
  if (emailRaw === undefined) {
    errors.push(
      'ICLOUD_EMAIL is not set. Set it to your iCloud Mail address (for example you@icloud.com) as "iCloud email address" in the extension settings, or in the server env.',
    );
  } else {
    email = address('ICLOUD_EMAIL', emailRaw) ?? '';
  }

  // Passed exactly as given (with or without hyphens); only surrounding whitespace from pasting is dropped.
  const password = str('ICLOUD_APP_PASSWORD');
  const fromAddress = address('MAIL_FROM_ADDRESS', str('MAIL_FROM_ADDRESS')) ?? email;
  const imapUser = str('ICLOUD_IMAP_USER');
  // A full address in the IMAP login (the @icloud.com login of a custom-domain user) is the SMTP
  // login too; the settings form has no separate SMTP login field.
  const smtpUser = str('ICLOUD_SMTP_USER') ?? (imapUser && isValidEmailAddress(imapUser) ? imapUser : email);

  const allowedFrom: string[] = [];
  const pushAllowed = (a: string | undefined): void => {
    if (!a) return;
    if (!allowedFrom.some((x) => x.toLowerCase() === a.toLowerCase())) allowedFrom.push(a);
  };
  pushAllowed(email || undefined);
  pushAllowed(fromAddress || undefined);
  for (const a of parseList(env['MAIL_ALLOWED_FROM'])) pushAllowed(address('MAIL_ALLOWED_FROM', a));
  const ownAddresses = [...allowedFrom];
  const pushOwn = (a: string): void => {
    if (!ownAddresses.some((x) => x.toLowerCase() === a.toLowerCase())) ownAddresses.push(a);
  };
  for (const a of [email, imapUser ?? '']) {
    const at = a.lastIndexOf('@');
    if (at <= 0) continue;
    const domain = a.slice(at + 1).toLowerCase();
    if (!(ICLOUD_DOMAINS_FOR_OWN as readonly string[]).includes(domain)) continue;
    for (const d of ICLOUD_DOMAINS_FOR_OWN) pushOwn(`${a.slice(0, at)}@${d}`);
  }

  // --- guardrails -----------------------------------------------------------------------------
  const readOnly = bool('MAIL_READ_ONLY', false);
  const allowSend = bool('MAIL_ALLOW_SEND', true);
  const allowPermanentDelete = bool('MAIL_ALLOW_PERMANENT_DELETE', false);
  const confirmDialog = bool('MAIL_CONFIRM_DIALOG', false);
  const maxSendsPerHour = int('MAIL_MAX_SENDS_PER_HOUR', 30, 0, 100_000, { lenient: true });
  const maxRecipients = int('MAIL_MAX_RECIPIENTS', 50, 1, ICLOUD_MAX_RECIPIENTS, { lenient: true });
  const maxRecipientsPerHour = int('MAIL_MAX_RECIPIENTS_PER_HOUR', 150, 0, 100_000, { lenient: true });
  const maxRecipientsPerDay = int('MAIL_MAX_RECIPIENTS_PER_DAY', 500, 0, 100_000, { lenient: true });

  // --- files ----------------------------------------------------------------------------------
  const attachmentDir = pathValue('MAIL_ATTACHMENT_DIR', '~/Downloads/iCloud Mail Attachments');
  // Folders chosen in the extension settings arrive as arguments and take precedence over the env list.
  const attachFromRaw = str('MAIL_ATTACH_FROM_DIRS');
  let attachFromSource: { name: string; dirs: string[] };
  if (cli.attachFromDirs.length > 0) attachFromSource = { name: `The "Attach files from" folders (${ATTACH_FROM_DIRS_FLAG})`, dirs: cli.attachFromDirs };
  else if (attachFromRaw !== undefined) attachFromSource = { name: 'MAIL_ATTACH_FROM_DIRS entries', dirs: parseList(attachFromRaw) };
  else attachFromSource = { name: 'Default attachment folders', dirs: ['~/Desktop', '~/Documents', '~/Downloads'] };
  const attachFromDirs: string[] = [];
  // "none" (alone) switches local-file attachments off entirely; an empty list cannot, because
  // Claude Desktop sends nothing for a cleared folder setting and the defaults then apply.
  if (attachFromSource.dirs.length === 1 && NO_FOLDERS.has((attachFromSource.dirs[0] ?? '').toLowerCase())) attachFromSource = { ...attachFromSource, dirs: [] };
  for (const d of attachFromSource.dirs) {
    const expanded = expandPath(d, pathCtx);
    if (!path.isAbsolute(expanded)) {
      errors.push(`${attachFromSource.name} must be absolute paths (or start with ~/); got "${d}".`);
      continue;
    }
    if (!attachFromDirs.includes(expanded)) attachFromDirs.push(expanded);
  }

  const maxBodyChars = int('MAIL_MAX_BODY_CHARS', 20_000, 1, MAX_BODY_CHARS_CEILING, { lenient: true });
  const maxAttachmentMb = int('MAIL_MAX_ATTACHMENT_MB', 25, 1, 1024, { lenient: true });

  const auditRaw = str('MAIL_AUDIT_LOG');
  let auditLog: string | null;
  if (auditRaw !== undefined && auditRaw.toLowerCase() === 'off') auditLog = null;
  else auditLog = pathValue('MAIL_AUDIT_LOG', defaultAuditLogPath(platform, home));

  const saveSentCopy = bool('MAIL_SAVE_SENT_COPY', true);
  const operationTimeoutSeconds = int('MAIL_OPERATION_TIMEOUT_SECONDS', 120, 5, 3600, { lenient: true });

  const logLevelRaw = str('MAIL_LOG_LEVEL');
  let logLevel: LogLevel = 'warn';
  if (logLevelRaw !== undefined) {
    const lvl = logLevelRaw.toLowerCase();
    if (isLogLevel(lvl)) logLevel = lvl;
    else warnings.push(`MAIL_LOG_LEVEL must be one of error, warn, info, debug; got "${logLevelRaw}". Using warn.`);
  }

  const systemTz = options.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const tzRaw = str('MAIL_TIMEZONE');
  let timezone = systemTz;
  if (tzRaw !== undefined) {
    if (isValidTimezone(tzRaw)) timezone = tzRaw;
    else errors.push(`MAIL_TIMEZONE "${tzRaw}" is not a valid IANA time zone (for example America/Los_Angeles).`);
  }

  const mailboxOverrides: Partial<Record<SpecialFolder, string>> = {};
  const overrideVars: Record<SpecialFolder, string> = {
    sent: 'MAIL_SENT_MAILBOX',
    trash: 'MAIL_TRASH_MAILBOX',
    archive: 'MAIL_ARCHIVE_MAILBOX',
    drafts: 'MAIL_DRAFTS_MAILBOX',
    junk: 'MAIL_JUNK_MAILBOX',
  };
  for (const [kind, name] of Object.entries(overrideVars) as Array<[SpecialFolder, string]>) {
    const v = str(name);
    if (v !== undefined) mailboxOverrides[kind] = v;
  }

  // --- servers --------------------------------------------------------------------------------
  const imap = {
    host: str('IMAP_HOST') ?? 'imap.mail.me.com',
    port: int('IMAP_PORT', 993, 1, 65_535),
    secure: bool('IMAP_SECURE', true),
    allowPlaintext: bool('IMAP_ALLOW_PLAINTEXT', false),
  };
  if (!imap.secure && imap.allowPlaintext) {
    warnings.push('IMAP_SECURE=false with IMAP_ALLOW_PLAINTEXT=true: the IMAP login (with the app-specific password) may be sent unencrypted. Use this only for local testing.');
  }
  const smtpSecure = bool('SMTP_SECURE', false);
  const smtp = {
    host: str('SMTP_HOST') ?? 'smtp.mail.me.com',
    port: int('SMTP_PORT', 587, 1, 65_535),
    secure: smtpSecure,
    requireTLS: smtpSecure ? false : bool('SMTP_REQUIRE_TLS', true),
  };
  if (!smtp.secure && !smtp.requireTLS) {
    warnings.push('SMTP_REQUIRE_TLS=false: the SMTP login (with the app-specific password) may be sent unencrypted if the server does not offer STARTTLS. Use this only for local testing.');
  }
  const caRaw = str('MAIL_TLS_CA_FILE');
  const tlsCaFile = caRaw === undefined ? undefined : expandPath(caRaw, pathCtx);

  const config: Config = {
    email,
    password,
    keychainService: str('ICLOUD_KEYCHAIN_SERVICE') ?? 'icloud-mail-mcp',
    imapUser,
    smtpUser,
    fromAddress,
    fromName: str('MAIL_FROM_NAME'),
    allowedFrom,
    ownAddresses,
    allowSend,
    allowPermanentDelete,
    readOnly,
    confirmDialog,
    maxSendsPerHour,
    maxRecipients,
    maxRecipientsPerHour,
    maxRecipientsPerDay,
    attachmentDir,
    attachFromDirs,
    maxBodyChars,
    maxAttachmentMb,
    auditLog,
    saveSentCopy,
    operationTimeoutSeconds,
    logLevel,
    timezone,
    mailboxOverrides,
    imap,
    smtp,
    tlsCaFile,
  };
  return { config, errors, warnings };
}

/** Effective feature switches after MAIL_READ_ONLY overrides the others (SPEC §3). */
export function effectiveFeatures(config: Config): {
  readOnly: boolean;
  send: boolean;
  permanentDelete: boolean;
  drafts: boolean;
  mailboxChanges: boolean;
} {
  return {
    readOnly: config.readOnly,
    send: config.allowSend && !config.readOnly,
    permanentDelete: config.allowPermanentDelete && !config.readOnly,
    drafts: !config.readOnly,
    mailboxChanges: !config.readOnly,
  };
}

/** True if `address` is in the allowed From set (case-insensitive). */
export function isAllowedFrom(config: Config, address: string): boolean {
  const a = address.toLowerCase();
  return config.allowedFrom.some((x) => x.toLowerCase() === a);
}
