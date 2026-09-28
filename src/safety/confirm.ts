/**
 * Optional native macOS confirmation dialog (SPEC §6.8).
 *
 * The AppleScript source is a constant; all user-visible text travels as argv (`on run argv`), so
 * nothing from an email or from the model is ever interpolated into script source. Confirmed only
 * when osascript exits 0 and prints exactly the action button's name. Anything else is "not
 * confirmed", and failure to show the dialog at all fails closed.
 */
import { defaultExecFile, type ExecFileFn } from '../credentials.js';

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

export type ConfirmFn = (request: ConfirmRequest) => Promise<ConfirmResult>;

export const DIALOG_GIVE_UP_SECONDS = 120;
export const DIALOG_MESSAGE_MAX_CHARS = 1000;

export const CONFIRM_DISABLE_HINT =
  'To turn the dialog off, set MAIL_CONFIRM_DIALOG=false (the "Confirm dialog" option in the extension settings).';

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

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function createConfirmer(options: ConfirmOptions = {}): ConfirmFn {
  const platform = options.platform ?? process.platform;
  const osascript = options.osascriptPath ?? '/usr/bin/osascript';
  const exec = options.exec ?? defaultExecFile;
  const giveUp = options.giveUpSeconds ?? DIALOG_GIVE_UP_SECONDS;

  return async (request: ConfirmRequest): Promise<ConfirmResult> => {
    if (platform !== 'darwin') {
      return { status: 'unavailable', reason: `the native confirmation dialog is only available on macOS (this is ${platform})` };
    }
    // eslint-disable-next-line no-control-regex
    const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    const message = truncateMiddle(clean(request.message), DIALOG_MESSAGE_MAX_CHARS);
    const title = truncateMiddle(clean(request.title), 120);
    let result;
    try {
      result = await exec(osascript, ['-e', CONFIRM_APPLESCRIPT, title, message, request.action, String(giveUp)], {
        timeoutMs: (giveUp + 15) * 1000,
      });
    } catch (err) {
      return { status: 'unavailable', reason: `osascript could not be run (${err instanceof Error ? err.message : String(err)})` };
    }
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

export interface SendConfirmationDetails {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: string[];
}

/** Text shown in the send dialog: the final envelope recipients, subject, body start, attachments. */
export function buildSendConfirmationMessage(d: SendConfirmationDetails): string {
  const list = (xs: string[]): string => (xs.length ? truncateMiddle(xs.join(', '), 300) : '—');
  const bodyPreview = truncateMiddle(d.body.replace(/\s+/g, ' ').trim(), 300);
  const lines = [
    'Claude wants to send this email from your iCloud account:',
    '',
    `From: ${d.from}`,
    `To: ${list(d.to)}`,
  ];
  if (d.cc.length) lines.push(`Cc: ${list(d.cc)}`);
  if (d.bcc.length) lines.push(`Bcc: ${list(d.bcc)}`);
  lines.push(`Subject: ${truncateMiddle(d.subject || '(no subject)', 150)}`);
  if (d.attachments.length) lines.push(`Attachments: ${truncateMiddle(d.attachments.join(', '), 200)}`);
  lines.push('', bodyPreview || '(empty body)');
  return truncateMiddle(lines.join('\n'), DIALOG_MESSAGE_MAX_CHARS);
}

export function buildDeleteConfirmationMessage(d: { mailbox: string; count: number; subjects: string[] }): string {
  const lines = [
    `Claude wants to PERMANENTLY delete ${d.count} message${d.count === 1 ? '' : 's'} from "${d.mailbox}". This cannot be undone.`,
    '',
    ...d.subjects.slice(0, 10).map((s) => `• ${truncateMiddle(s || '(no subject)', 90)}`),
  ];
  if (d.subjects.length > 10) lines.push(`… and ${d.subjects.length - 10} more`);
  return truncateMiddle(lines.join('\n'), DIALOG_MESSAGE_MAX_CHARS);
}
