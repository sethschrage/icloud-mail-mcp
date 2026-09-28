/**
 * Error type shared by the domain layer. Every error that reaches a tool result is a MailError
 * with an actionable, already-redacted message; the tool layer turns it into `{isError: true}`.
 */
import { redact } from './log.js';

export type MailErrorCode =
  | 'CONFIG' // configuration missing or invalid
  | 'AUTH' // IMAP/SMTP authentication failed
  | 'CONNECTION' // network / TLS / timeout talking to the server
  | 'INVALID_INPUT' // bad arguments from the caller
  | 'NOT_FOUND' // message / part / mailbox does not exist
  | 'CONFLICT' // target already exists, not empty, wrong state, ...
  | 'FORBIDDEN' // operation refused by a guardrail (special folder, foreign From, ...)
  | 'EXPUNGE_GUARD' // refused because an EXPUNGE could purge unrelated \Deleted messages
  | 'RATE_LIMIT' // MAIL_MAX_SENDS_PER_HOUR reached
  | 'TOO_LARGE' // size limits
  | 'SMTP' // SMTP rejected the message
  | 'CONFIRM_UNAVAILABLE' // MAIL_CONFIRM_DIALOG is on but the dialog could not be shown
  | 'CANCELLED' // aborted by the caller (deadline / cancellation) before a destructive step
  | 'TIMEOUT' // the per-tool deadline (MAIL_OPERATION_TIMEOUT_SECONDS) passed
  | 'SERVER' // IMAP server said NO/BAD
  | 'INTERNAL';

export class MailError extends Error {
  readonly code: MailErrorCode;
  /** Extra structured detail that is safe to show (never secrets). */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: MailErrorCode, message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MailError';
    this.code = code;
    this.details = options?.details;
  }
}

export function isMailError(err: unknown): err is MailError {
  return err instanceof MailError;
}

/** Best-effort message extraction for unknown thrown values. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Text for an isError tool result: MailError messages are already actionable and redacted;
 * anything else is reported as unexpected, with secrets redacted.
 */
export function describeError(err: unknown): string {
  if (err instanceof MailError) return redact(err.message);
  return `Unexpected error: ${redact(errorMessage(err))}`;
}
