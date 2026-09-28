/**
 * Sending (SPEC §6.6): per-send SMTP transport, raw send with the same Message-ID, rejected-recipient
 * handling, Sent copy with a dedupe check, rolling rate limit, optional native confirmation, audit.
 */
import type tls from 'node:tls';
import nodemailer from 'nodemailer';
import type { NodemailerError, SMTPSentMessageInfo } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import { markAudited, type AuditLog } from '../audit.js';
import type { Config } from '../config.js';
import type { CredentialProvider } from '../credentials.js';
import { MailError, errorMessage } from '../errors.js';
import { authFailureMessage } from '../imap/client.js';
import type { MailboxRegistry } from '../imap/mailboxes.js';
import { appendMessage, findByMessageId } from '../imap/ops.js';
import type { ImapManager } from '../imap/client.js';
import { log as defaultLogger, redact, type Logger } from '../log.js';
import { CONFIRM_DISABLE_HINT, buildSendConfirmationMessage, type ConfirmFn } from '../safety/confirm.js';
import { formatAddress } from './address.js';
import type { BuiltMessage } from './compose.js';

// ---------------------------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------------------------

export interface RateReservation {
  commit(): void;
  release(): void;
}

/** Rolling one-hour window across all send tools. `max = 0` means unlimited. */
export class RateLimiter {
  private readonly sent: number[] = [];
  private pending = 0;

  constructor(
    readonly maxPerHour: number,
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60 * 60_000,
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.sent.length && (this.sent[0] as number) <= cutoff) this.sent.shift();
  }

  /** Sends still allowed in the current window (null = unlimited). */
  remaining(): number | null {
    if (this.maxPerHour <= 0) return null;
    this.prune();
    return Math.max(0, this.maxPerHour - this.sent.length - this.pending);
  }

  /** Seconds until the next send is allowed (0 if allowed now). */
  retryAfterSeconds(): number {
    const remaining = this.remaining();
    if (remaining === null || remaining > 0) return 0;
    const oldest = this.sent[0];
    if (oldest === undefined) return 60;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  assertAllowed(): void {
    const remaining = this.remaining();
    if (remaining !== null && remaining <= 0) {
      const mins = Math.ceil(this.retryAfterSeconds() / 60);
      throw new MailError(
        'RATE_LIMIT',
        `Send limit reached: at most ${this.maxPerHour} emails per hour (MAIL_MAX_SENDS_PER_HOUR). Try again in about ${mins} minute${mins === 1 ? '' : 's'}, or save a draft instead.`,
      );
    }
  }

  /** Reserve a slot (throws RATE_LIMIT when none is free). Commit after a send, release otherwise. */
  reserve(): RateReservation {
    this.assertAllowed();
    if (this.maxPerHour <= 0) return { commit: () => undefined, release: () => undefined };
    this.pending++;
    let done = false;
    return {
      commit: () => {
        if (done) return;
        done = true;
        this.pending--;
        this.sent.push(this.now());
      },
      release: () => {
        if (done) return;
        done = true;
        this.pending--;
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// SMTP error mapping
// ---------------------------------------------------------------------------------------------

export interface RejectedRecipient {
  address: string;
  reason: string;
}

function responseText(err: NodemailerError): string {
  return redact((err.response ?? err.message ?? '').toString()).trim();
}

/** Short explanation for one rejected recipient. */
export function explainRecipientRejection(err: NodemailerError): string {
  const code = err.responseCode;
  const text = responseText(err);
  if (code !== undefined && code >= 400 && code < 500) {
    if (code === 452) return `${text} (too many recipients; iCloud allows 500 per message and 1000 per day)`;
    return `${text} (temporary failure; retrying later may work)`;
  }
  if (code === 550 || code === 551 || code === 553) return `${text} (the address was refused; check it is spelled correctly)`;
  return text || 'rejected';
}

const SMTP_TLS_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);

/** Friendly text for SMTP failures (SPEC §6.6). */
export function mapSmtpError(err: unknown, ctx: { host: string; port: number; user: string }): MailError {
  if (err instanceof MailError) return err;
  const e = (err ?? {}) as NodemailerError;
  const code = e.responseCode;
  const text = responseText(e);
  const where = `${ctx.host}:${ctx.port}`;
  if (code === 535 || e.code === 'EAUTH') {
    return new MailError('AUTH', `${authFailureMessage('SMTP', where, [ctx.user])} (Server said: ${text || 'authentication failed'})`, { cause: err });
  }
  if (code === 550 && /5\.7\.0|not one of your addresses/i.test(text)) {
    return new MailError(
      'SMTP',
      `iCloud refused the From address: "${text}". The From must be your iCloud address or one of its aliases / custom-domain addresses set up in iCloud Mail settings. Not sent.`,
      { cause: err },
    );
  }
  if (code === 552) return new MailError('TOO_LARGE', `The message is too large for iCloud (20 MB per message, including encoding): ${text}. Not sent.`, { cause: err });
  if (code === 452) return new MailError('SMTP', `Too many recipients for iCloud (500 per message, 1000 per day): ${text}. Not sent.`, { cause: err });
  if (e.code === 'EENVELOPE' && Array.isArray(e.rejectedErrors) && e.rejectedErrors.length) {
    const details = e.rejectedErrors.map((r) => `${r.recipient ?? '?'}: ${explainRecipientRejection(r)}`).join('; ');
    const allTemp = e.rejectedErrors.every((r) => (r.responseCode ?? 0) >= 400 && (r.responseCode ?? 0) < 500);
    return new MailError('SMTP', `All recipients were rejected, so nothing was sent. ${details}${allTemp ? ' This looks temporary; retrying later may work.' : ''}`, {
      cause: err,
      details: { rejected: e.rejectedErrors.map((r) => ({ address: r.recipient ?? '', reason: explainRecipientRejection(r) })) },
    });
  }
  if (code !== undefined && code >= 400 && code < 500) {
    return new MailError('SMTP', `iCloud reported a temporary problem: ${text}. The message was not sent; retrying later may work.`, { cause: err });
  }
  if (code !== undefined && code >= 500) {
    return new MailError('SMTP', `iCloud rejected the message: ${text}. Not sent.`, { cause: err });
  }
  const causeCode = (e as { code?: string }).code;
  if (causeCode && (SMTP_TLS_CODES.has(causeCode) || causeCode === 'ETLS')) {
    return new MailError(
      'CONNECTION',
      `TLS failed with the SMTP server ${where} (${redact(errorMessage(err))}). If the server uses a private certificate authority, set MAIL_TLS_CA_FILE. Not sent.`,
      { cause: err },
    );
  }
  if (causeCode === 'ECONNECTION' || causeCode === 'ETIMEDOUT' || causeCode === 'ESOCKET' || causeCode === 'EDNS' || causeCode === 'ECONNREFUSED') {
    return new MailError('CONNECTION', `Could not reach the SMTP server ${where} (${redact(errorMessage(err))}). Check the internet connection. Not sent.`, { cause: err });
  }
  return new MailError('SMTP', `Sending failed: ${redact(errorMessage(err))}. Not sent.`, { cause: err });
}

// ---------------------------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------------------------

export interface SendResult {
  sent: true;
  message_id: string;
  from: string;
  accepted: string[];
  rejected: RejectedRecipient[];
  /** True when some (but not all) recipients were rejected. */
  partial: boolean;
  sent_copy_saved: boolean;
  sent_copy_uid?: number;
  sent_copy_mailbox?: string;
  /** Why the Sent copy was not saved (or that an existing copy was found). */
  sent_copy_note?: string;
}

export interface NotSentResult {
  sent: false;
  cancelled: true;
  reason: 'cancelled' | 'timeout';
  message: string;
}

export interface SendOptions {
  /** Tool name for the audit log. */
  tool: string;
  signal?: AbortSignal | undefined;
  /** Reservation obtained earlier (so the limit is checked before building). */
  reservation?: RateReservation;
  /** Extra audit fields (e.g. the original message for replies). */
  audit?: Record<string, unknown>;
}

export type TransportFactory = (options: SMTPTransportOptions) => {
  sendMail(mail: { envelope: { from: string; to: string[] }; raw: Buffer; messageId: string; disableFileAccess: boolean; disableUrlAccess: boolean }): Promise<SMTPSentMessageInfo>;
  close(): void;
};

const defaultTransportFactory: TransportFactory = (options) => nodemailer.createTransport(options);

export interface SenderDeps {
  config: Config;
  credentials: CredentialProvider;
  imap: ImapManager;
  registry: MailboxRegistry;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  confirm: ConfirmFn;
  tlsOptions: () => tls.ConnectionOptions;
  logger?: Logger;
  transportFactory?: TransportFactory;
}

export class Sender {
  private readonly logger: Logger;
  private readonly transportFactory: TransportFactory;

  constructor(private readonly deps: SenderDeps) {
    this.logger = deps.logger ?? defaultLogger;
    this.transportFactory = deps.transportFactory ?? defaultTransportFactory;
  }

  private async transport(): Promise<ReturnType<TransportFactory>> {
    const { password } = await this.deps.credentials.getPassword();
    const { host, port, secure, requireTLS } = this.deps.config.smtp;
    // No `logger` option: nodemailer's logger:true would write to stdout (SPEC §2.1).
    return this.transportFactory({
      host,
      port,
      secure,
      requireTLS,
      auth: { user: this.deps.config.smtpUser, pass: password },
      tls: this.deps.tlsOptions(),
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  /** Save the Bcc-bearing copy to Sent unless a message with this Message-ID is already there. */
  private async saveSentCopy(built: BuiltMessage): Promise<Pick<SendResult, 'sent_copy_saved' | 'sent_copy_uid' | 'sent_copy_mailbox' | 'sent_copy_note'>> {
    try {
      const sent = await this.deps.registry.resolveSpecial('sent');
      if (!sent) return { sent_copy_saved: false, sent_copy_note: 'No Sent mailbox was found (set MAIL_SENT_MAILBOX).' };
      const existing = await findByMessageId(this.deps.imap, sent.path, built.messageId);
      if (existing.length > 0) {
        const out: Pick<SendResult, 'sent_copy_saved' | 'sent_copy_uid' | 'sent_copy_mailbox' | 'sent_copy_note'> = {
          sent_copy_saved: true,
          sent_copy_mailbox: sent.path,
          sent_copy_note: 'A copy with this Message-ID was already in the Sent mailbox, so no duplicate was added.',
        };
        if (existing[0] !== undefined) out.sent_copy_uid = existing[0];
        return out;
      }
      const res = await appendMessage(this.deps.imap, this.deps.registry, sent.path, built.rawWithBcc, ['\\Seen'], built.date);
      const out: Pick<SendResult, 'sent_copy_saved' | 'sent_copy_uid' | 'sent_copy_mailbox'> = { sent_copy_saved: true, sent_copy_mailbox: res.mailbox };
      if (res.uid !== null) out.sent_copy_uid = res.uid;
      return out;
    } catch (err) {
      this.logger.warn('saving the Sent copy failed', { err: redact(errorMessage(err)) });
      return { sent_copy_saved: false, sent_copy_note: `The email was sent, but saving a copy to Sent failed: ${redact(errorMessage(err))}` };
    }
  }

  /**
   * Send a built message: confirm (optional) -> SMTP (raw bytes, same Message-ID) -> check rejected
   * -> Sent copy -> audit. Returns a NotSentResult when the user declined the native dialog.
   */
  async send(built: BuiltMessage, options: SendOptions): Promise<SendResult | NotSentResult> {
    const { config, audit } = this.deps;
    const msg = built.message;
    const from = formatAddress(msg.from);
    const auditBase = {
      tool: options.tool,
      from: msg.from.address,
      recipients: built.envelope.to,
      subject: msg.subject,
      message_id: built.messageId,
      ...options.audit,
    };
    const reservation = options.reservation ?? this.deps.rateLimiter.reserve();
    let committed = false;
    try {
      if (config.confirmDialog) {
        const decision = await this.deps.confirm({
          title: 'iCloud Mail: send this email?',
          action: 'Send',
          message: buildSendConfirmationMessage({
            from,
            to: msg.to.map(formatAddress),
            cc: msg.cc.map(formatAddress),
            bcc: msg.bcc.map(formatAddress),
            subject: msg.subject,
            body: msg.text,
            attachments: msg.attachments.map((a) => a.filename),
          }),
        });
        if (decision.status === 'unavailable') {
          await audit.record({ ...auditBase, result: 'error', error_code: 'CONFIRM_UNAVAILABLE', error: `confirmation dialog unavailable: ${decision.reason}` });
          throw markAudited(new MailError('CONFIRM_UNAVAILABLE', `Not sent: the confirmation dialog could not be shown (${decision.reason}). ${CONFIRM_DISABLE_HINT}`));
        }
        if (decision.status === 'declined') {
          await audit.record({ ...auditBase, result: 'cancelled', error: decision.reason });
          return {
            sent: false,
            cancelled: true,
            reason: decision.reason,
            message:
              decision.reason === 'timeout'
                ? 'Not sent: the confirmation dialog timed out without a click on "Send".'
                : 'Not sent: the user clicked Cancel in the confirmation dialog.',
          };
        }
      }
      if (options.signal?.aborted) {
        throw new MailError('CANCELLED', 'Not sent: the request was cancelled or timed out before sending.');
      }

      const transport = await this.transport();
      let info: SMTPSentMessageInfo;
      try {
        info = await transport.sendMail({ envelope: built.envelope, raw: built.raw, messageId: built.messageId, disableFileAccess: true, disableUrlAccess: true });
      } catch (err) {
        const mapped = mapSmtpError(err, { host: config.smtp.host, port: config.smtp.port, user: config.smtpUser });
        if (mapped.code === 'AUTH') this.deps.credentials.invalidate();
        await audit.record({ ...auditBase, result: 'error', error_code: mapped.code, error: mapped.message });
        throw markAudited(mapped);
      } finally {
        try {
          transport.close();
        } catch {
          // ignore
        }
      }

      reservation.commit();
      committed = true;
      const rejectedErrors = info.rejectedErrors ?? [];
      const rejected: RejectedRecipient[] = (info.rejected ?? []).map((address) => {
        const e = rejectedErrors.find((r) => r.recipient === address);
        return { address, reason: e ? explainRecipientRejection(e) : 'rejected' };
      });
      const accepted = [...(info.accepted ?? [])];
      if (accepted.length === 0) {
        // Defensive: nodemailer normally throws EENVELOPE in this case.
        const error = new MailError('SMTP', `All recipients were rejected, so nothing was sent: ${rejected.map((r) => `${r.address}: ${r.reason}`).join('; ')}`);
        await audit.record({ ...auditBase, result: 'error', error_code: error.code, error: error.message });
        throw markAudited(error);
      }

      const copy = config.saveSentCopy ? await this.saveSentCopy(built) : { sent_copy_saved: false, sent_copy_note: 'MAIL_SAVE_SENT_COPY is off.' };
      const result: SendResult = {
        sent: true,
        message_id: built.messageId,
        from,
        accepted,
        rejected,
        partial: rejected.length > 0,
        ...copy,
      };
      await audit.record({
        ...auditBase,
        result: rejected.length ? 'partial' : 'ok',
        accepted,
        rejected: rejected.map((r) => r.address),
        sent_copy_saved: result.sent_copy_saved,
      });
      return result;
    } finally {
      if (!committed) reservation.release();
    }
  }
}
