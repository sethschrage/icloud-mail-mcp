/**
 * Optional native macOS confirmation dialog (SPEC §6.8).
 *
 * The AppleScript source is a constant; all user-visible text travels as argv (`on run argv`), so
 * nothing from an email or from the model is ever interpolated into script source. Confirmed only
 * when osascript exits 0 and prints exactly the action button's name. Anything else is "not
 * confirmed", and failure to show the dialog at all fails closed.
 *
 * The dialog is the one check Claude cannot answer for the user, so its text is built to be
 * truthful under hostile input: every value is single-line (a CR/LF in a display name cannot forge
 * a "Bcc:" line), every envelope address is listed in full with a per-field count, display names are
 * capped and shown after the address, Reply-To is always shown, and only the body preview is
 * shortened to fit. When the dialog is abandoned (the tool call was cancelled or timed out, or the
 * server shuts down) the osascript process is killed, so a stale dialog never lingers on screen.
 */
import { defaultExecFile, type ExecFileFn } from '../credentials.js';
import { displayName, domainOf, nameHidesOtherAddress } from '../smtp/address.js';

export type ConfirmAction = 'Send' | 'Delete';

export interface ConfirmRequest {
  title: string;
  message: string;
  action: ConfirmAction;
}

export type ConfirmResult =
  | { status: 'confirmed' }
  | { status: 'declined'; reason: 'cancelled' | 'timeout' }
  | { status: 'unavailable'; reason: string };

export type ConfirmFn = (request: ConfirmRequest, options?: { signal?: AbortSignal | undefined }) => Promise<ConfirmResult>;

export const DIALOG_GIVE_UP_SECONDS = 120;
/** Text budget of the dialog; the recipient and attachment lists are never cut to fit it. */
export const DIALOG_MESSAGE_MAX_CHARS = 1600;
/** Hard safety cap passed to osascript (only reached by an enormous recipient list). */
const DIALOG_HARD_MAX_CHARS = 6000;
const NAME_MAX = 40;

/** Title of the manifest setting (manifest.json user_config.confirm_dialog.title). */
export const CONFIRM_SETTING_TITLE = 'Confirm on my Mac before sending or permanently deleting';

export const CONFIRM_DISABLE_HINT = `To turn the dialog off, switch off "${CONFIRM_SETTING_TITLE}" in Settings → Extensions → iCloud Mail (MAIL_CONFIRM_DIALOG=false in a manual setup).`;

/** Fixed script: argv = [title, message, actionButton, giveUpSeconds]. */
export const CONFIRM_APPLESCRIPT = [
  'on run argv',
  'set theTitle to item 1 of argv',
  'set theMessage to item 2 of argv',
  'set actionButton to item 3 of argv',
  'set giveUp to (item 4 of argv) as integer',
  'set r to display dialog theMessage with title theTitle buttons {"Cancel", actionButton} default button "Cancel" cancel button "Cancel" with icon caution giving up after giveUp',
  'if gave up of r then return "__timeout__"',
  'return button returned of r',
  'end run',
].join('\n');

export interface ConfirmOptions {
  platform?: NodeJS.Platform;
  osascriptPath?: string;
  exec?: ExecFileFn;
  giveUpSeconds?: number;
}

/** Cut at `max` characters, keeping the start (used for the body preview and subjects only). */
function truncateEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// eslint-disable-next-line no-control-regex
const LINE_BREAKS = /[\r\n\u000b\u000c\u0085\u2028\u2029]+/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
const FORMAT_CHARS = /[\p{Cf}\u{E0000}-\u{E007F}]/gu;

/** One line of dialog text: no line breaks, controls or invisible format characters. */
export function singleLine(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(CONTROLS, '').replace(FORMAT_CHARS, '').replace(/\s+/g, ' ').trim();
}

export function createConfirmer(options: ConfirmOptions = {}): ConfirmFn {
  const platform = options.platform ?? process.platform;
  const osascript = options.osascriptPath ?? '/usr/bin/osascript';
  const exec = options.exec ?? defaultExecFile;
  const giveUp = options.giveUpSeconds ?? DIALOG_GIVE_UP_SECONDS;

  return async (request: ConfirmRequest, opts: { signal?: AbortSignal | undefined } = {}): Promise<ConfirmResult> => {
    if (platform !== 'darwin') {
      return { status: 'unavailable', reason: `the native confirmation dialog is only available on macOS (this is ${platform})` };
    }
    if (opts.signal?.aborted) return { status: 'declined', reason: 'cancelled' };
    // Keep only the builder's own "\n" separators; values were made single-line already.
    const clean = (s: string): string => s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    const message = truncateEnd(clean(request.message), DIALOG_HARD_MAX_CHARS);
    const title = truncateEnd(singleLine(request.title), 120);
    let result;
    try {
      result = await exec(osascript, ['-e', CONFIRM_APPLESCRIPT, title, message, request.action, String(giveUp)], {
        timeoutMs: (giveUp + 15) * 1000,
        signal: opts.signal,
      });
    } catch (err) {
      return { status: 'unavailable', reason: `osascript could not be run (${err instanceof Error ? err.message : String(err)})` };
    }
    // The call was abandoned while the dialog was open: it was killed, nothing was confirmed.
    if (opts.signal?.aborted || result.error?.name === 'AbortError' || result.error?.code === 'ABORT_ERR') return { status: 'declined', reason: 'cancelled' };
    const out = result.stdout.replace(/\r?\n$/, '');
    if (!result.error && result.code === 0) {
      if (out === request.action) return { status: 'confirmed' };
      if (out === '__timeout__') return { status: 'declined', reason: 'timeout' };
      return { status: 'declined', reason: 'cancelled' };
    }
    // "User canceled" is error -128 from the Cancel button.
    if (/-128\b|user cancel/i.test(result.stderr)) return { status: 'declined', reason: 'cancelled' };
    const e = result.error;
    if (e?.code === 'ENOENT') return { status: 'unavailable', reason: `${osascript} was not found` };
    if (e?.killed) return { status: 'unavailable', reason: 'osascript did not finish in time' };
    const detail = result.stderr.trim().slice(0, 200) || `exit code ${result.code ?? 'unknown'}`;
    return { status: 'unavailable', reason: `osascript failed: ${detail}` };
  };
}

export interface DialogAddress {
  name?: string | undefined;
  address: string;
}

export interface DialogAttachment {
  /** Name the attachment is sent under. */
  name: string;
  /** Name of the real file, when it differs (the path went through a symlink). */
  realName?: string | undefined;
}

export interface SendConfirmationDetails {
  from: DialogAddress;
  to: DialogAddress[];
  cc: DialogAddress[];
  bcc: DialogAddress[];
  replyTo?: DialogAddress[] | undefined;
  subject: string;
  body: string;
  attachments: DialogAttachment[];
}

/** "addr (Name…)" with the address first and in full; the name is sanitised and capped. */
export function dialogAddress(a: DialogAddress, withName = true): string {
  const address = singleLine(a.address);
  const name = withName ? displayName(singleLine(a.name ?? ''), NAME_MAX) : '';
  return name && name.toLowerCase() !== address.toLowerCase() ? `${address} (${name})` : address;
}

function domainsOf(list: readonly DialogAddress[]): string[] {
  return [...new Set(list.map((a) => domainOf(a.address)).filter(Boolean))].sort();
}

/** A recipient line that never cuts inside an address; shortened only as a last resort, and then says so. */
function recipientLine(label: string, list: readonly DialogAddress[], budget: number, withNames: boolean): string {
  const head = `${label} (${list.length}): `;
  const entries = list.map((a) => dialogAddress(a, withNames));
  const full = head + entries.join(', ');
  if (full.length <= budget) return full;
  const shown: string[] = [];
  let used = head.length;
  for (const e of entries) {
    const tail = ` … and ${list.length - shown.length} more`;
    if (used + e.length + 2 + tail.length + 60 > budget && shown.length > 0) break;
    shown.push(e);
    used += e.length + 2;
  }
  const hidden = list.slice(shown.length);
  if (hidden.length === 0) return full;
  return `${head}${shown.join(', ')} … and ${hidden.length} more (LIST SHORTENED; their domains: ${domainsOf(hidden).join(', ')})`;
}

function attachmentsLine(list: readonly DialogAttachment[]): string {
  const counts = new Map<string, number>();
  for (const a of list) {
    const name = truncateEnd(singleLine(a.name), 80);
    const real = a.realName && a.realName !== a.name ? ` [real file: ${truncateEnd(singleLine(a.realName), 80)}]` : '';
    const key = `${name}${real}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  return `Attachments (${list.length}): ${parts.join(', ')}`;
}

/**
 * Text shown in the send dialog: counts, every envelope recipient (address first), Reply-To,
 * subject, attachments, warnings, then as much of the body as still fits.
 */
export function buildSendConfirmationMessage(d: SendConfirmationDetails): string {
  const replyTo = d.replyTo ?? [];
  const total = d.to.length + d.cc.length + d.bcc.length;
  const lines = [
    'Claude wants to send this email from your iCloud account:',
    `Recipients: ${total} (To ${d.to.length}, Cc ${d.cc.length}, Bcc ${d.bcc.length})`,
    '',
    `From: ${dialogAddress(d.from)}`,
  ];
  const fields: Array<[string, DialogAddress[]]> = [
    ['To', d.to],
    ['Cc', d.cc],
    ['Bcc', d.bcc],
    ['Reply-To', replyTo],
  ];
  const present = fields.filter(([, list]) => list.length > 0);
  // Names first go if the lists are long; addresses are only shortened when even they cannot fit.
  const withNamesLength = present.reduce((n, [label, list]) => n + recipientLine(label, list, Number.POSITIVE_INFINITY, true).length + 1, 0);
  const withNames = withNamesLength <= DIALOG_MESSAGE_MAX_CHARS * 0.6;
  const perField = Math.max(300, Math.floor((DIALOG_HARD_MAX_CHARS * 0.8) / Math.max(1, present.length)));
  if (d.to.length === 0) lines.push('To (0): —');
  for (const [label, list] of present) lines.push(recipientLine(label, list, perField, withNames));
  lines.push(`Subject: ${truncateEnd(singleLine(d.subject) || '(no subject)', 150)}`);
  if (d.attachments.length) lines.push(attachmentsLine(d.attachments));
  const spoofed = [d.from, ...d.to, ...d.cc, ...d.bcc, ...replyTo].filter((a) => nameHidesOtherAddress(a));
  if (spoofed.length) {
    lines.push(`WARNING: a display name contains a different email address than the real one (${spoofed.map((a) => singleLine(a.address)).join(', ')}).`);
  }
  const used = lines.join('\n').length + 2;
  const preview = singleLine(d.body);
  const room = Math.max(0, DIALOG_MESSAGE_MAX_CHARS - used);
  lines.push('', room >= 20 ? truncateEnd(preview, room) || '(empty body)' : preview ? '(body not shown: long recipient list)' : '(empty body)');
  return lines.join('\n');
}

export function buildDeleteConfirmationMessage(d: { mailbox: string; count: number; subjects: string[] }): string {
  const lines = [
    `Claude wants to PERMANENTLY delete ${d.count} message${d.count === 1 ? '' : 's'} from "${singleLine(d.mailbox)}". This cannot be undone.`,
    '',
    ...d.subjects.slice(0, 10).map((s) => `• ${truncateEnd(singleLine(s) || '(no subject)', 90)}`),
  ];
  if (d.subjects.length > 10) lines.push(`… and ${d.subjects.length - 10} more`);
  return truncateEnd(lines.join('\n'), DIALOG_MESSAGE_MAX_CHARS);
}
