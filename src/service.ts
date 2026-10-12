/**
 * MailService: the domain-layer facade the MCP tool handlers call. It wires config, credentials,
 * the IMAP connection manager, mailbox registry, sender, rate limiter, audit log and the optional
 * confirmation dialog, and implements every tool's behaviour (validation, guardrails, audit).
 * Handlers only parse input (zod), call one method, and render the result (see render.ts).
 */
import type { ImapFlow, ImapFlowOptions } from 'imapflow';
import { AuditLog, markAudited } from './audit.js';
import { effectiveFeatures, loadConfig, settingName, type Config, type ConfigResult, type LoadConfigOptions } from './config.js';
import { passwordHelp, CredentialProvider, defaultExecFile, type CredentialOptions, type ExecFileFn } from './credentials.js';
import { MailError, errorMessage } from './errors.js';
import { formatDateISO, formatSize, toJson } from './format.js';
import { ImapManager } from './imap/client.js';
import { downloadPartToDir, downloadPartToMemory, extractMessageIds, fetchAttachmentBuffers, fetchFullMessage, readEmbeddedMessage, resolveAttachmentPart, type FullMessage } from './imap/fetch.js';
import { ANSWERED, DELETED, DRAFT, FORWARDED, SEEN, hasFlag, isFlagColor, type FlagColor } from './imap/flags.js';
import { MailboxRegistry, type MailboxInfo, type SpecialUse } from './imap/mailboxes.js';
import { decodeCharset } from './imap/mime.js';
import {
  addFlagsToMessage,
  appendMessage,
  checkReplaceableDraft,
  createMailbox,
  deleteDraft,
  deleteMailbox,
  deleteMessagesPermanently,
  fetchSubjects,
  findByMessageId,
  markMessages,
  moveMessages,
  renameMailbox,
  validateUids,
  verifyUids,
  type DeleteResult,
  type MarkResult,
  type MoveResult,
} from './imap/ops.js';
import { searchMessages, type SearchCriteria, type SearchResult } from './imap/search.js';
import { getThread, type ThreadResult } from './imap/thread.js';
import { log as defaultLogger, redact, type Logger } from './log.js';
import { createSharedQuota, type FetchFn, type SharedQuota } from './quota.js';
import { settingsPlace } from './runtime.js';
import { buildMessageView, type MessageView } from './render.js';
import { CONFIRM_DISABLE_HINT, buildDeleteConfirmationMessage, createConfirmer, type ConfirmFn } from './safety/confirm.js';
import { isRiskyFileName, markQuarantined, type PathContext } from './safety/paths.js';
import { rebuildDraftForSending } from './smtp/draft.js';
import {
  MAX_OUTGOING_ATTACHMENT_BYTES,
  buildForwardHtml,
  buildForwardText,
  buildMessage,
  buildReferences,
  buildReplyHtml,
  buildReplyText,
  cleanSubject,
  computeReplyRecipients,
  finalizeRecipients,
  formatAddress,
  forwardSubject,
  loadAttachments,
  normalizeRecipients,
  parseAddressInputs,
  replyFromCandidate,
  replySubject,
  resolveFrom,
  textToHtml,
  type BuiltMessage,
  type EmailAddress,
  type OriginalMessage,
  type OutgoingAttachment,
  type OutgoingMessage,
} from './smtp/compose.js';
import { parseAddressString } from './smtp/address.js';
import { RateLimiter, RecipientLimiter, Sender, type NotSentResult, type SendResult, type TransportFactory } from './smtp/send.js';

export interface MailServiceDeps {
  logger?: Logger;
  credentialOptions?: CredentialOptions;
  confirm?: ConfirmFn;
  platform?: NodeJS.Platform;
  transportFactory?: TransportFactory;
  imapClientFactory?: (options: ImapFlowOptions) => ImapFlow;
  pathContext?: PathContext;
  now?: () => number;
  idleCloseMs?: number;
  /** Runs /usr/bin/xattr (quarantine flag for downloads on macOS); injectable for tests. */
  exec?: ExecFileFn;
  /** fetch used for the shared send-limit store (cloud; injectable for tests). */
  quotaFetch?: FetchFn;
}

export interface OperationOptions {
  /** Abort signal (tool deadline / client cancellation); checked before destructive steps. */
  signal?: AbortSignal | undefined;
}

export interface MailboxListItem {
  path: string;
  name: string;
  special_use: SpecialUse | null;
  selectable: boolean;
  total: number | null;
  unread: number | null;
}

export interface NewMessageInput {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  body: string;
  html?: string | undefined;
  attachments?: string[] | undefined;
  from?: string | undefined;
  replyToAddress?: string | undefined;
}

export interface ReplyInput {
  mailbox: string;
  uid: number;
  body: string;
  replyAll?: boolean | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  html?: string | undefined;
  attachments?: string[] | undefined;
  from?: string | undefined;
}

export interface ForwardInput {
  mailbox: string;
  uid: number;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  body?: string | undefined;
  html?: string | undefined;
  includeAttachments?: boolean | undefined;
  attachments?: string[] | undefined;
  from?: string | undefined;
}

export interface DraftInput {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  body: string;
  html?: string | undefined;
  attachments?: string[] | undefined;
  from?: string | undefined;
  replyTo?: { mailbox: string; uid: number; replyAll?: boolean | undefined } | undefined;
  forwardOf?: { mailbox: string; uid: number; includeAttachments?: boolean | undefined } | undefined;
  replaceDraftUid?: number | undefined;
  /** With replace_draft_uid: keep the old draft's attachments (default true unless `attachments` is given). */
  keepAttachments?: boolean | undefined;
}

export interface DraftResult {
  saved: true;
  mailbox: string;
  uid: number | null;
  message_id: string;
  /** What was saved, so it can be shown to the user without another call. */
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  attachments: string[];
  body_chars: number;
  replaced_uid?: number;
  /** Where the replaced draft went ("deleted" for a draft Claude saved earlier in this session). */
  old_draft?: string;
  replace_error?: string;
  /** Fields carried over from the replaced draft. */
  inherited?: string[];
  /** Set when the server did not keep \\Draft (Apple Mail would then not treat it as a draft). */
  warning?: string;
  note: string;
}

/** Fields of an earlier draft carried into its replacement (save_draft replace_draft_uid). */
interface InheritedDraft {
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  inReplyTo: string | null;
  references: string[];
  attachments: OutgoingAttachment[] | null;
}

export type ReplyResult = (SendResult & { original: { mailbox: string; uid: number }; original_marked?: boolean; original_mark_note?: string }) | NotSentResult;

export interface AttachmentResult {
  mailbox: string;
  uid: number;
  part: string;
  /** Where the file was saved (absent in the cloud version, which has no disk). */
  path?: string;
  filename: string;
  size: number;
  size_human: string;
  content_type: string;
  /** Returned inline content (image as base64, or text) when requested and small enough. */
  content?: { kind: 'image'; mimeType: string; data: string } | { kind: 'text'; text: string };
  note?: string;
  /** Set when the file could not be quarantine-flagged, or it is an app/installer/script. */
  warning?: string;
}

export const IMAGE_INLINE_MAX_BYTES = 3 * 1024 * 1024;
export const TEXT_INLINE_MAX_BYTES = 200 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EMBEDDED_MESSAGE_TYPES = new Set(['message/rfc822', 'message/global']);

function isInlineTextType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t === 'application/csv' ||
    t === 'message/delivery-status' ||
    t === 'message/global-delivery-status' ||
    t === 'message/disposition-notification' ||
    t.endsWith('+json') ||
    t.endsWith('+xml')
  );
}

export class MailService {
  readonly config: Config;
  readonly configErrors: readonly string[];
  readonly configWarnings: readonly string[];
  readonly logger: Logger;
  readonly credentials: CredentialProvider;
  readonly imap: ImapManager;
  readonly mailboxes: MailboxRegistry;
  readonly audit: AuditLog;
  readonly rateLimiter: RateLimiter;
  readonly recipientLimiter: RecipientLimiter;
  /** Limits shared by every instance of the cloud version (no-op locally). */
  readonly sharedQuota: SharedQuota;
  readonly sender: Sender;
  private readonly confirm: ConfirmFn;
  private readonly pathContext: PathContext | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly exec: ExecFileFn;
  /** Message-IDs of drafts this process saved (only those may be expunged when replaced or sent). */
  private readonly selfDrafts = new Set<string>();
  /**
   * Message-IDs of messages this process built with local files attached. Their attachments are
   * not handed back to Claude by download_attachment: saving a draft (or sending to oneself) and
   * downloading it again would otherwise let Claude read any file in the attachment folders.
   */
  private readonly localFileMessages = new Set<string>();

  static fromEnv(env: NodeJS.ProcessEnv = process.env, deps: MailServiceDeps = {}, configOptions: LoadConfigOptions = {}): MailService {
    return new MailService(loadConfig(env, deps.platform ? { ...configOptions, platform: deps.platform } : configOptions), deps);
  }

  constructor(configResult: ConfigResult, deps: MailServiceDeps = {}) {
    this.config = configResult.config;
    this.configErrors = configResult.errors;
    this.configWarnings = configResult.warnings;
    this.logger = deps.logger ?? defaultLogger;
    // The process-wide stderr logger follows MAIL_LOG_LEVEL (an injected logger keeps its own level).
    if (!deps.logger) defaultLogger.setLevel(this.config.logLevel);
    this.pathContext = deps.pathContext;
    this.credentials = new CredentialProvider(this.config, { platform: deps.platform, ...deps.credentialOptions });
    const imapOpts: ConstructorParameters<typeof ImapManager>[0] = { config: this.config, credentials: this.credentials, logger: this.logger };
    if (deps.imapClientFactory) imapOpts.createClient = deps.imapClientFactory;
    if (deps.idleCloseMs !== undefined) imapOpts.idleCloseMs = deps.idleCloseMs;
    this.imap = new ImapManager(imapOpts);
    this.mailboxes = new MailboxRegistry(this.imap, this.config, deps.now ? { now: deps.now } : {});
    this.audit = new AuditLog(this.config.auditLog, this.logger);
    this.rateLimiter = new RateLimiter(this.config.maxSendsPerHour, deps.now);
    this.recipientLimiter = new RecipientLimiter(this.config.maxRecipientsPerHour, this.config.maxRecipientsPerDay, deps.now);
    this.sharedQuota = createSharedQuota(this.config, {
      logger: this.logger,
      ...(deps.quotaFetch ? { fetch: deps.quotaFetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.platform = deps.platform ?? process.platform;
    this.exec = deps.exec ?? defaultExecFile;
    const confirm = deps.confirm ?? createConfirmer(deps.platform ? { platform: deps.platform } : {});
    this.sender = new Sender({
      config: this.config,
      credentials: this.credentials,
      imap: this.imap,
      registry: this.mailboxes,
      audit: this.audit,
      rateLimiter: this.rateLimiter,
      recipientLimiter: this.recipientLimiter,
      sharedQuota: this.sharedQuota,
      confirm,
      tlsOptions: () => this.imap.tlsOptions(),
      logger: this.logger,
      ...(deps.transportFactory ? { transportFactory: deps.transportFactory } : {}),
    });
    this.confirm = confirm;
  }

  get features(): ReturnType<typeof effectiveFeatures> {
    return effectiveFeatures(this.config);
  }

  /** Throw a CONFIG error describing every configuration problem (used by all tools but get_account_info). */
  assertConfigured(): void {
    if (this.configErrors.length === 0) return;
    const needsPasswordHelp = this.configErrors.some((e) => /ICLOUD_EMAIL|PASSWORD/i.test(e));
    throw new MailError(
      'CONFIG',
      `The iCloud Mail server is not configured correctly:\n- ${this.configErrors.join('\n- ')}${needsPasswordHelp && this.config.runtime !== 'cloud' ? `\n${passwordHelp()}` : ''}`,
    );
  }

  private assertWritable(what: string): void {
    this.assertConfigured();
    if (this.config.readOnly) throw new MailError('FORBIDDEN', `${what} is not available: the server runs in read-only mode (${settingName('MAIL_READ_ONLY')} is on).`);
  }

  private assertCanSend(): void {
    this.assertWritable('Sending');
    if (!this.config.allowSend) throw new MailError('FORBIDDEN', `Sending is disabled (${settingName('MAIL_ALLOW_SEND')} is off). Save a draft instead; the user can send it from Apple Mail.`);
  }

  private checkSignal(signal: AbortSignal | undefined, what: string): void {
    if (signal?.aborted) throw new MailError('CANCELLED', `Cancelled before ${what}; nothing was changed.`);
  }

  private uid(uid: number): number {
    return validateUids([uid])[0] as number;
  }

  // -------------------------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------------------------

  async listMailboxes(options: { includeCounts?: boolean } = {}): Promise<MailboxListItem[]> {
    this.assertConfigured();
    const includeCounts = options.includeCounts ?? true;
    // Counts cost one STATUS per folder on iCloud (no LIST-STATUS): only load them when asked.
    const list = await this.mailboxes.list({ counts: includeCounts });
    return list.map((m) => ({
      path: m.path,
      name: m.name,
      special_use: m.specialUse,
      selectable: m.selectable,
      total: includeCounts ? m.total : null,
      unread: includeCounts ? m.unread : null,
    }));
  }

  async resolveMailbox(name: string, options: { requireSelectable?: boolean } = {}): Promise<MailboxInfo> {
    this.assertConfigured();
    return this.mailboxes.resolve(name, options);
  }

  async search(
    params: SearchCriteria & { mailbox?: string | undefined; allMailboxes?: boolean | undefined; limit?: number | undefined; offset?: number | undefined; includeSnippets?: boolean | undefined },
  ): Promise<SearchResult> {
    this.assertConfigured();
    if (params.flagColor !== undefined && !isFlagColor(params.flagColor)) throw new MailError('INVALID_INPUT', `Unknown flag_color "${String(params.flagColor)}".`);
    const { mailbox: mailboxName, ...criteria } = params;
    const mailbox = params.allMailboxes ? undefined : await this.mailboxes.resolve(mailboxName ?? 'INBOX');
    return searchMessages(this.imap, this.mailboxes, this.config, {
      ...criteria,
      ...(mailbox ? { mailbox } : {}),
      allMailboxes: params.allMailboxes ?? false,
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
      includeSnippets: params.includeSnippets ?? true,
    });
  }

  async getMessage(params: { mailbox: string; uid: number; maxChars?: number | undefined; includeHtml?: boolean | undefined; markAsRead?: boolean | undefined }): Promise<MessageView> {
    this.assertConfigured();
    const mb = await this.mailboxes.resolve(params.mailbox);
    const uid = this.uid(params.uid);
    // MAIL_MAX_BODY_CHARS is a real maximum (SPEC §3): a call may ask for fewer characters, never more.
    const cap = this.config.maxBodyChars;
    const requested = params.maxChars === undefined ? cap : Math.max(1, Math.floor(params.maxChars));
    const maxChars = Math.min(cap, requested);
    const notes: string[] = [];
    if (requested > cap) notes.push(`max_chars was limited to the configured maximum of ${cap} characters (${settingName('MAIL_MAX_BODY_CHARS')} in ${settingsPlace()}).`);
    let markAsRead = params.markAsRead ?? false;
    if (markAsRead && this.config.readOnly) {
      markAsRead = false;
      notes.push('mark_as_read was ignored because the server runs in read-only mode.');
    }
    let marked = false;
    const full = await this.imap.withMailbox(
      mb.path,
      async (client) => {
        const m = await fetchFullMessage(client, mb.path, uid, { timeZone: this.config.timezone, includeHtml: params.includeHtml ?? false });
        if (markAsRead && m.flags.unread) {
          await client.messageFlagsAdd([uid], [SEEN], { uid: true });
          m.flags = { ...m.flags, unread: false };
          marked = true;
        }
        return m;
      },
      { readOnly: !markAsRead },
    );
    if (marked) {
      this.mailboxes.invalidateCounts();
      notes.push('The message was marked as read.');
      await this.audit.record({ tool: 'get_message', result: 'ok', action: 'mark_as_read', mailbox: mb.path, uids: [uid] });
    }
    return buildMessageView(full, maxChars, notes, cap);
  }

  async getThread(params: { mailbox: string; uid: number; limit?: number | undefined }): Promise<ThreadResult> {
    this.assertConfigured();
    const mb = await this.mailboxes.resolve(params.mailbox);
    const limit = Math.min(200, Math.max(1, Math.floor(params.limit ?? 50)));
    return getThread(this.imap, this.mailboxes, this.config, { mailbox: mb, uid: this.uid(params.uid), limit });
  }

  /** get_account_info: works (and reports problems) even when config or credentials are wrong. */
  async getAccountInfo(): Promise<Record<string, unknown>> {
    const c = this.config;
    const f = this.features;
    const info: Record<string, unknown> = {
      email: c.email || null,
      imap: { host: c.imap.host, port: c.imap.port, secure: c.imap.secure, login: this.imap.effectiveUser ?? null, logins_to_try: this.imap.plannedLogins },
      smtp: { host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure, require_tls: c.smtp.requireTLS, login: c.smtpUser || null },
      password_source: this.credentials.describeSource(),
      from: { default: c.fromAddress || null, name: c.fromName ?? null, allowed: c.allowedFrom },
      features: {
        send: f.send,
        permanent_delete: f.permanentDelete,
        read_only: f.readOnly,
        drafts: f.drafts,
        confirm_dialog: c.confirmDialog,
        save_sent_copy: c.saveSentCopy,
        rate_limit: { max_sends_per_hour: c.maxSendsPerHour === 0 ? 'unlimited' : c.maxSendsPerHour, remaining_this_hour: this.rateLimiter.remaining() ?? 'unlimited' },
        recipient_limit: (() => {
          const r = this.recipientLimiter.remaining();
          return {
            max_per_hour: c.maxRecipientsPerHour === 0 ? 'unlimited' : c.maxRecipientsPerHour,
            max_per_day: c.maxRecipientsPerDay === 0 ? 'unlimited' : c.maxRecipientsPerDay,
            remaining_this_hour: r.hour ?? 'unlimited',
            remaining_today: r.day ?? 'unlimited',
          };
        })(),
        max_recipients: c.maxRecipients,
      },
      limits: { max_body_chars: c.maxBodyChars, max_attachment_mb: c.maxAttachmentMb, operation_timeout_seconds: c.operationTimeoutSeconds },
      runtime: c.runtime,
      ...(c.runtime === 'cloud'
        ? { attachments: 'Downloaded attachments are returned inline (images and text); the cloud version has no disk, so files cannot be saved or attached from disk.' }
        : { attachment_dir: c.attachmentDir, attach_from_dirs: c.attachFromDirs }),
      audit_log: c.auditLog ?? 'off',
      now: { local: formatDateISO(new Date(), c.timezone), timezone: c.timezone },
    };
    if (c.runtime === 'cloud' && f.send) info['shared_send_limits'] = await this.sharedQuota.status();
    if (this.configErrors.length) info['config_errors'] = [...this.configErrors];
    if (this.configWarnings.length) info['config_warnings'] = [...this.configWarnings];
    if (this.configErrors.length) {
      info['status'] = 'not configured';
      return info;
    }
    try {
      const caps = await this.imap.capabilities();
      info['imap'] = { ...(info['imap'] as object), login: this.imap.effectiveUser };
      info['capabilities'] = Object.fromEntries(['MOVE', 'UIDPLUS', 'SPECIAL-USE', 'IDLE', 'QUOTA'].map((k) => [k, caps.has(k)]));
      if (!caps.has('UIDPLUS')) {
        info['capability_note'] =
          'The server lacks UIDPLUS: moves, deletions and draft replacements are refused while other messages in the same folder are marked as deleted (finishing them would purge those too).';
      }
      const special = await this.mailboxes.specialResolution();
      info['special_folders'] = Object.fromEntries(Object.entries(special.map).map(([k, v]) => [k, v ? v.path : null]));
      if (Object.keys(special.missingOverrides).length) info['special_folder_errors'] = special.missingOverrides;
      if (caps.has('QUOTA')) {
        try {
          const quota = await this.imap.run((client) => client.getQuota('INBOX'));
          if (quota && quota.storage) {
            const { usage, limit } = quota.storage;
            info['quota'] = {
              used: usage !== undefined ? formatSize(usage) : null,
              limit: limit !== undefined ? formatSize(limit) : null,
              percent_used: usage !== undefined && limit ? Math.round((usage / limit) * 1000) / 10 : null,
            };
          }
        } catch (err) {
          info['quota'] = { error: redact(errorMessage(err)) };
        }
      }
      info['status'] = 'connected';
    } catch (err) {
      info['status'] = err instanceof MailError && err.code === 'CONFIG' ? 'not configured' : 'connection failed';
      info['connection_error'] = err instanceof MailError ? err.message : redact(errorMessage(err));
    }
    return info;
  }

  async downloadAttachment(params: { mailbox: string; uid: number; part: string; returnContent?: boolean | undefined }): Promise<AttachmentResult> {
    this.assertConfigured();
    const mb = await this.mailboxes.resolve(params.mailbox);
    const uid = this.uid(params.uid);
    const returnContent = params.returnContent ?? true;
    const maxBytes = this.config.maxAttachmentMb * 1024 * 1024;
    if (this.config.runtime === 'cloud') return this.downloadAttachmentInline(mb.path, uid, params.part, returnContent, maxBytes);
    const file = await this.imap.withMailbox(
      mb.path,
      async (client) => {
        const saved = await downloadPartToDir(client, mb.path, uid, params.part, { dir: this.config.attachmentDir, maxBytes, captureUpTo: returnContent ? IMAGE_INLINE_MAX_BYTES : 0 });
        let embedded: string | undefined;
        if (returnContent && EMBEDDED_MESSAGE_TYPES.has(saved.content_type) && !this.isOwnLocalFileMessage(saved.messageId)) {
          const { node } = await resolveAttachmentPart(client, mb.path, uid, params.part);
          embedded = await readEmbeddedMessage(client, uid, params.part, node, this.config.timezone);
        }
        return { ...saved, embedded };
      },
      { readOnly: true, retry: false },
    );
    const result: AttachmentResult = {
      mailbox: mb.path,
      uid,
      part: params.part,
      path: file.path,
      filename: file.filename,
      size: file.size,
      size_human: formatSize(file.size),
      content_type: file.content_type,
    };
    const warnings: string[] = [];
    const quarantine = await markQuarantined(file.path, { platform: this.platform, exec: this.exec }).catch(() => 'The file could not be marked as downloaded from the internet.');
    if (quarantine) warnings.push(quarantine);
    if (isRiskyFileName(file.filename)) {
      warnings.push('This file type can run code or install software when opened (or contain something that does). Tell the user to open it only if they trust the sender.');
    }
    if (warnings.length) result.warning = warnings.join(' ');
    if (returnContent) {
      if (this.isOwnLocalFileMessage(file.messageId)) {
        result.note = `Saved to ${file.path}. This message was created in this session with a local file attached, so the attachment's content is not shown again here.`;
      } else if (file.embedded !== undefined) {
        result.content = { kind: 'text', text: file.embedded };
      } else if (file.content && INLINE_IMAGE_TYPES.has(file.content_type) && file.size <= IMAGE_INLINE_MAX_BYTES) {
        result.content = { kind: 'image', mimeType: file.content_type, data: file.content.toString('base64') };
      } else if (file.content && isInlineTextType(file.content_type) && file.size <= TEXT_INLINE_MAX_BYTES) {
        // `charset` describes the saved bytes (imapflow converts inline text parts to UTF-8).
        result.content = { kind: 'text', text: decodeCharset(file.content, file.charset ?? 'utf-8') };
      } else {
        result.note = `Saved to ${file.path}. The content is not shown here (${file.content_type}, ${formatSize(file.size)}); the user can open the file from that folder.`;
      }
    }
    await this.audit.record({ tool: 'download_attachment', result: 'ok', mailbox: mb.path, uids: [uid], part: params.part, path: file.path });
    return result;
  }

  /** Cloud version: nothing is saved; small images and text come back inline, other files are described. */
  private async downloadAttachmentInline(mailbox: string, uid: number, part: string, returnContent: boolean, maxBytes: number): Promise<AttachmentResult> {
    const file = await this.imap.withMailbox(
      mailbox,
      async (client) => {
        const got = await downloadPartToMemory(client, mailbox, uid, part, {
          maxBytes,
          captureFor: (type) => (!returnContent ? 0 : INLINE_IMAGE_TYPES.has(type) ? IMAGE_INLINE_MAX_BYTES : isInlineTextType(type) ? TEXT_INLINE_MAX_BYTES : 0),
        });
        let embedded: string | undefined;
        if (returnContent && EMBEDDED_MESSAGE_TYPES.has(got.content_type)) {
          const { node } = await resolveAttachmentPart(client, mailbox, uid, part);
          embedded = await readEmbeddedMessage(client, uid, part, node, this.config.timezone);
        }
        return { ...got, embedded };
      },
      { readOnly: true, retry: false },
    );
    const result: AttachmentResult = {
      mailbox,
      uid,
      part,
      filename: file.filename,
      size: file.size,
      size_human: formatSize(file.size),
      content_type: file.content_type,
    };
    if (isRiskyFileName(file.filename)) {
      result.warning = 'This file type can run code or install software when opened (or contain something that does). Tell the user to open it only if they trust the sender.';
    }
    const elsewhere = 'The cloud version cannot save files; the user can open it in Apple Mail or at icloud.com/mail, or another connector can be used to store or share it.';
    if (!returnContent) {
      result.note = `Not shown (return_content is false). ${elsewhere}`;
    } else if (file.embedded !== undefined) {
      result.content = { kind: 'text', text: file.embedded };
    } else if (file.content && INLINE_IMAGE_TYPES.has(file.content_type) && file.size <= IMAGE_INLINE_MAX_BYTES) {
      result.content = { kind: 'image', mimeType: file.content_type, data: file.content.toString('base64') };
    } else if (file.content && isInlineTextType(file.content_type) && file.size <= TEXT_INLINE_MAX_BYTES) {
      result.content = { kind: 'text', text: decodeCharset(file.content, file.charset ?? 'utf-8') };
    } else {
      result.note = `The content is not shown here (${file.content_type}, ${formatSize(file.size)}): only images up to ${formatSize(IMAGE_INLINE_MAX_BYTES)} and text files up to ${formatSize(TEXT_INLINE_MAX_BYTES)} can be returned. ${elsewhere}`;
    }
    await this.audit.record({ tool: 'download_attachment', result: 'ok', mailbox, uids: [uid], part });
    return result;
  }

  private isOwnLocalFileMessage(messageId: string | null): boolean {
    return !!messageId && this.localFileMessages.has(messageId.toLowerCase());
  }

  private rememberBuilt(built: BuiltMessage, hasLocalFiles: boolean): void {
    if (hasLocalFiles) this.localFileMessages.add(built.messageId.toLowerCase());
  }

  // -------------------------------------------------------------------------------------------
  // Mailbox changes
  // -------------------------------------------------------------------------------------------

  private async audited<T>(entry: { tool: string; mailbox?: string; uids?: number[]; destination?: string; [k: string]: unknown }, fn: () => Promise<T>, summarize: (r: T) => Record<string, unknown> = () => ({})): Promise<T> {
    try {
      const result = await fn();
      await this.audit.record({ ...entry, result: 'ok', ...summarize(result) });
      return result;
    } catch (err) {
      await this.audit.record({ ...entry, result: 'error', error_code: err instanceof MailError ? err.code : 'INTERNAL', error: err instanceof MailError ? err.message : redact(errorMessage(err)) });
      throw markAudited(err);
    }
  }

  async markMessages(params: { mailbox: string; uids: number[]; read?: boolean | undefined; flagged?: boolean | undefined; flagColor?: FlagColor | undefined }, opts: OperationOptions = {}): Promise<MarkResult> {
    this.assertWritable('Changing flags');
    if (params.flagColor !== undefined && !isFlagColor(params.flagColor)) throw new MailError('INVALID_INPUT', `Unknown flag_color "${String(params.flagColor)}".`);
    const mb = await this.mailboxes.resolve(params.mailbox);
    const uids = validateUids(params.uids);
    this.checkSignal(opts.signal, 'changing flags');
    return this.audited(
      { tool: 'mark_messages', mailbox: mb.path, uids, read: params.read, flagged: params.flagged, flag_color: params.flagColor },
      async () => {
        try {
          return await markMessages(this.imap, mb, uids, { read: params.read, flagged: params.flagged, flagColor: params.flagColor });
        } finally {
          if (params.read !== undefined) this.mailboxes.invalidateCounts(); // unread counts changed
        }
      },
      (r) => ({ affected: r.affected, not_found: r.not_found }),
    );
  }

  private async resolveDestination(name: string): Promise<MailboxInfo> {
    try {
      return await this.mailboxes.resolve(name);
    } catch (err) {
      if (err instanceof MailError && err.code === 'NOT_FOUND') {
        throw new MailError('NOT_FOUND', `${err.message} To use a new folder, create it first with create_mailbox.`);
      }
      throw err;
    }
  }

  async moveMessages(params: { mailbox: string; uids: number[]; destination: string }, opts: OperationOptions = {}): Promise<MoveResult> {
    this.assertWritable('Moving messages');
    const source = await this.mailboxes.resolve(params.mailbox);
    const destination = await this.resolveDestination(params.destination);
    const uids = validateUids(params.uids);
    this.checkSignal(opts.signal, 'moving messages');
    return this.audited({ tool: 'move_messages', mailbox: source.path, uids, destination: destination.path }, () => moveMessages(this.imap, this.mailboxes, source, uids, destination), (r) => ({
      moved: r.moved,
      not_found: r.not_found,
      new_uids: r.new_uids,
    }));
  }

  async archiveMessages(params: { mailbox: string; uids: number[] }, opts: OperationOptions = {}): Promise<MoveResult> {
    this.assertWritable('Archiving');
    const source = await this.mailboxes.resolve(params.mailbox);
    const uids = validateUids(params.uids);
    const existingArchive = await this.mailboxes.resolveSpecial('archive');
    if (existingArchive && existingArchive.path === source.path) {
      throw new MailError('INVALID_INPUT', `The messages are already in the archive folder ("${source.path}").`);
    }
    this.checkSignal(opts.signal, 'archiving');
    const archive = existingArchive ?? (await this.mailboxes.resolveSpecial('archive', { create: true }));
    if (!archive) throw new MailError('SERVER', 'No archive folder is available.');
    return this.audited({ tool: 'archive_messages', mailbox: source.path, uids, destination: archive.path }, () => moveMessages(this.imap, this.mailboxes, source, uids, archive), (r) => ({
      moved: r.moved,
      not_found: r.not_found,
      new_uids: r.new_uids,
    }));
  }

  async trashMessages(params: { mailbox: string; uids: number[] }, opts: OperationOptions = {}): Promise<MoveResult> {
    this.assertWritable('Moving to Trash');
    const source = await this.mailboxes.resolve(params.mailbox);
    const uids = validateUids(params.uids);
    const trash = await this.mailboxes.resolveSpecial('trash');
    if (!trash) throw new MailError('NOT_FOUND', `No Trash (Deleted Messages) mailbox was found. Set its name as ${settingName('MAIL_TRASH_MAILBOX')}.`);
    if (trash.path === source.path) {
      const how = this.features.permanentDelete
        ? 'To remove them for good, use delete_messages_permanently (this cannot be undone).'
        : `Permanent deletion is disabled on this server (${settingName('MAIL_ALLOW_PERMANENT_DELETE')} is off); iCloud normally empties Deleted Messages after about 30 days.`;
      throw new MailError('INVALID_INPUT', `These messages are already in Trash ("${trash.path}"). ${how}`);
    }
    this.checkSignal(opts.signal, 'moving to Trash');
    return this.audited({ tool: 'trash_messages', mailbox: source.path, uids, destination: trash.path }, () => moveMessages(this.imap, this.mailboxes, source, uids, trash), (r) => ({
      moved: r.moved,
      not_found: r.not_found,
      new_uids: r.new_uids,
    }));
  }

  async deleteMessagesPermanently(params: { mailbox: string; uids: number[] }, opts: OperationOptions = {}): Promise<DeleteResult | { deleted: 0; cancelled: true; message: string }> {
    this.assertWritable('Permanent deletion');
    if (!this.config.allowPermanentDelete) throw new MailError('FORBIDDEN', `Permanent deletion is disabled (${settingName('MAIL_ALLOW_PERMANENT_DELETE')} is off). Use trash_messages instead.`);
    const mb = await this.mailboxes.resolve(params.mailbox);
    const uids = validateUids(params.uids);
    const entry = { tool: 'delete_messages_permanently', mailbox: mb.path, uids };
    if (this.config.confirmDialog) {
      const subjects = await fetchSubjects(this.imap, mb.path, uids);
      if (subjects.length === 0) return { mailbox: mb.path, deleted: 0, not_found: uids };
      const decision = await this.confirm(
        {
          title: 'iCloud Mail: permanently delete?',
          action: 'Delete',
          message: buildDeleteConfirmationMessage({ mailbox: mb.path, count: subjects.length, subjects: subjects.map((s) => s.subject) }),
        },
        { signal: opts.signal },
      );
      if (decision.status === 'unavailable') {
        await this.audit.record({ ...entry, result: 'error', error_code: 'CONFIRM_UNAVAILABLE', error: `confirmation dialog unavailable: ${decision.reason}` });
        throw markAudited(new MailError('CONFIRM_UNAVAILABLE', `Nothing was deleted: the confirmation dialog could not be shown (${decision.reason}). ${CONFIRM_DISABLE_HINT}`));
      }
      if (decision.status === 'declined') {
        await this.audit.record({ ...entry, result: 'cancelled', error: decision.reason });
        return {
          deleted: 0,
          cancelled: true,
          message: decision.reason === 'timeout' ? 'Nothing was deleted: the confirmation dialog timed out.' : 'Nothing was deleted: the confirmation dialog was cancelled.',
        };
      }
    }
    this.checkSignal(opts.signal, 'deleting');
    return this.audited(entry, () => deleteMessagesPermanently(this.imap, this.mailboxes, mb, uids), (r) => ({ deleted: r.deleted, not_found: r.not_found }));
  }

  async createMailbox(params: { path: string }, opts: OperationOptions = {}): Promise<{ path: string; created: boolean }> {
    this.assertWritable('Creating mailboxes');
    this.checkSignal(opts.signal, 'creating the mailbox');
    return this.audited({ tool: 'create_mailbox', mailbox: params.path }, () => createMailbox(this.imap, this.mailboxes, params.path), (r) => ({ path: r.path }));
  }

  async renameMailbox(params: { path: string; newPath: string }, opts: OperationOptions = {}): Promise<{ path: string; new_path: string }> {
    this.assertWritable('Renaming mailboxes');
    const mb = await this.mailboxes.resolve(params.path, { requireSelectable: false });
    this.checkSignal(opts.signal, 'renaming the mailbox');
    return this.audited({ tool: 'rename_mailbox', mailbox: mb.path, destination: params.newPath }, () => renameMailbox(this.imap, this.mailboxes, mb, params.newPath), (r) => ({
      new_path: r.new_path,
    }));
  }

  async deleteMailbox(params: { path: string }, opts: OperationOptions = {}): Promise<{ path: string; deleted: true }> {
    this.assertWritable('Deleting mailboxes');
    const mb = await this.mailboxes.resolve(params.path, { requireSelectable: false });
    this.checkSignal(opts.signal, 'deleting the mailbox');
    return this.audited({ tool: 'delete_mailbox', mailbox: mb.path }, () => deleteMailbox(this.imap, this.mailboxes, mb));
  }

  // -------------------------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------------------------

  private async loadOriginal(mailbox: string, uid: number, options: { html?: boolean } = {}): Promise<{ box: MailboxInfo; full: FullMessage; original: OriginalMessage }> {
    const box = await this.mailboxes.resolve(mailbox);
    const u = this.uid(uid);
    const full = await this.imap.withMailbox(box.path, (client) => fetchFullMessage(client, box.path, u, { timeZone: this.config.timezone, includeHtml: options.html ?? false }), {
      readOnly: true,
    });
    const original: OriginalMessage = {
      messageId: full.messageId,
      inReplyTo: full.inReplyTo,
      references: full.references,
      subject: full.subject,
      time: full.time,
      from: full.addresses.from,
      replyTo: full.addresses.replyTo,
      to: full.addresses.to,
      cc: full.addresses.cc,
      text: full.bodyText,
      html: full.html,
    };
    return { box, full, original };
  }

  private replyToHeader(value: string | undefined): OutgoingMessage['replyTo'] {
    if (value === undefined || value.trim() === '') return undefined;
    return parseAddressString(value, 'reply_to_address');
  }

  private async composeNew(input: NewMessageInput, options: { requireRecipient: boolean; inherited?: InheritedDraft | undefined }): Promise<OutgoingMessage> {
    const inherited = options.inherited;
    const inheritedFrom = inherited?.from && this.config.allowedFrom.some((a) => a.toLowerCase() === inherited.from?.address.toLowerCase()) ? inherited.from : undefined;
    const from = input.from !== undefined || !inheritedFrom ? resolveFrom(input.from, this.config) : resolveFrom(undefined, this.config, inheritedFrom.address);
    if (input.from === undefined && inheritedFrom?.name) from.name = inheritedFrom.name;
    const recipients = finalizeRecipients(
      {
        to: input.to !== undefined ? parseAddressInputs(input.to, 'to') : (inherited?.to ?? []),
        cc: input.cc !== undefined ? parseAddressInputs(input.cc, 'cc') : (inherited?.cc ?? []),
        bcc: input.bcc !== undefined ? parseAddressInputs(input.bcc, 'bcc') : (inherited?.bcc ?? []),
      },
      this.config.maxRecipients,
      { requireTo: options.requireRecipient },
    );
    const attachments =
      input.attachments === undefined && inherited?.attachments
        ? inherited.attachments
        : await loadAttachments(input.attachments, this.config.attachFromDirs, MAX_OUTGOING_ATTACHMENT_BYTES, this.pathContext);
    const msg: OutgoingMessage = {
      from,
      ...recipients,
      replyTo: this.replyToHeader(input.replyToAddress),
      subject: input.subject !== undefined ? cleanSubject(input.subject) : cleanSubject(inherited?.subject ?? ''),
      text: input.body,
      html: input.html,
      attachments,
    };
    if (inherited?.inReplyTo) msg.inReplyTo = inherited.inReplyTo;
    if (inherited?.references.length) msg.references = inherited.references;
    return msg;
  }

  private async composeReply(
    input: { mailbox: string; uid: number; replyAll?: boolean | undefined; body: string; html?: string | undefined; to?: string[] | undefined; cc?: string[] | undefined; bcc?: string[] | undefined; attachments?: string[] | undefined; from?: string | undefined; subject?: string | undefined },
    options: { requireRecipient: boolean },
  ): Promise<{ msg: OutgoingMessage; original: { mailbox: string; uid: number } }> {
    const { box, full, original } = await this.loadOriginal(input.mailbox, input.uid);
    const from = resolveFrom(input.from, this.config, replyFromCandidate(original, this.config.allowedFrom));
    // Own addresses include the legacy @me.com/@mac.com equivalents, so reply-all never copies the user.
    const own = [...this.config.ownAddresses, from.address];
    const computed = computeReplyRecipients(original, own, input.replyAll ?? false);
    const recipients = finalizeRecipients(
      {
        to: [...computed.to, ...parseAddressInputs(input.to, 'to')],
        cc: [...computed.cc, ...parseAddressInputs(input.cc, 'cc')],
        bcc: parseAddressInputs(input.bcc, 'bcc'),
      },
      this.config.maxRecipients,
      { requireTo: options.requireRecipient },
    );
    const attachments = await loadAttachments(input.attachments, this.config.attachFromDirs, MAX_OUTGOING_ATTACHMENT_BYTES, this.pathContext);
    const tz = this.config.timezone;
    const msg: OutgoingMessage = {
      from,
      ...recipients,
      subject: input.subject !== undefined && input.subject.trim() !== '' ? cleanSubject(input.subject) : replySubject(original.subject),
      text: buildReplyText(input.body, original, tz),
      html: input.html !== undefined ? buildReplyHtml(input.html, original, tz) : undefined,
      inReplyTo: original.messageId ?? undefined,
      references: buildReferences(original.references, original.inReplyTo, original.messageId),
      attachments,
    };
    return { msg, original: { mailbox: box.path, uid: full.uid } };
  }

  private async composeForward(
    input: { mailbox: string; uid: number; to?: string[] | undefined; cc?: string[] | undefined; bcc?: string[] | undefined; body?: string | undefined; html?: string | undefined; includeAttachments?: boolean | undefined; attachments?: string[] | undefined; from?: string | undefined; subject?: string | undefined },
    options: { requireRecipient: boolean },
  ): Promise<{ msg: OutgoingMessage; original: { mailbox: string; uid: number } }> {
    const { box, full, original } = await this.loadOriginal(input.mailbox, input.uid, { html: true });
    const from = resolveFrom(input.from, this.config, replyFromCandidate(original, this.config.allowedFrom));
    const recipients = normalizeRecipients(input, this.config.maxRecipients, { requireTo: options.requireRecipient });
    const local = await loadAttachments(input.attachments, this.config.attachFromDirs, MAX_OUTGOING_ATTACHMENT_BYTES, this.pathContext);
    const localBytes = local.reduce((n, a) => n + a.content.length, 0);
    const tz = this.config.timezone;
    const note = input.body ?? '';
    // HTML mail is forwarded as HTML (as Apple Mail does), with a plain-text alternative.
    const html = input.html !== undefined ? buildForwardHtml(input.html, original, tz) : original.html ? buildForwardHtml(textToHtml(note), original, tz) : undefined;
    let forwarded: OutgoingAttachment[] = [];
    if ((input.includeAttachments ?? true) && full.attachments.length > 0) {
      const buffers = await this.imap.withMailbox(box.path, (client) => fetchAttachmentBuffers(client, box.path, full.uid, MAX_OUTGOING_ATTACHMENT_BYTES - localBytes), { readOnly: true });
      forwarded = buffers.map((b) => {
        const cid = b.cid ? b.cid.replace(/^<|>$/g, '') : '';
        // Inline images referenced from the forwarded HTML keep their Content-ID (multipart/related);
        // everything else is a plain attachment, including message/rfc822 (nodemailer would inline it).
        if (html && b.inline && cid && original.html?.includes(`cid:${cid}`)) {
          return { filename: b.filename, content: b.content, contentType: b.contentType, cid, contentDisposition: 'inline' as const };
        }
        return { filename: b.filename, content: b.content, contentType: b.contentType, contentDisposition: 'attachment' as const };
      });
    }
    const msg: OutgoingMessage = {
      from,
      ...recipients,
      subject: input.subject !== undefined && input.subject.trim() !== '' ? cleanSubject(input.subject) : forwardSubject(original.subject),
      text: buildForwardText(note, original, tz),
      html,
      attachments: [...forwarded, ...local],
    };
    return { msg, original: { mailbox: box.path, uid: full.uid } };
  }

  // -------------------------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------------------------

  /** Load the fields of the draft being replaced, to carry over what the new call leaves out. */
  private async loadInheritedDraft(drafts: MailboxInfo, uid: number, withAttachments: boolean): Promise<InheritedDraft> {
    return this.imap.withMailbox(
      drafts.path,
      async (client) => {
        const full = await fetchFullMessage(client, drafts.path, uid, { timeZone: this.config.timezone });
        let attachments: OutgoingAttachment[] | null = null;
        if (withAttachments && full.attachments.length) {
          const buffers = await fetchAttachmentBuffers(client, drafts.path, uid, MAX_OUTGOING_ATTACHMENT_BYTES);
          attachments = buffers.map((b) => ({ filename: b.filename, content: b.content, contentType: b.contentType, contentDisposition: 'attachment' as const }));
        }
        const inherited: InheritedDraft = {
          to: full.addresses.to,
          cc: full.addresses.cc,
          bcc: full.addresses.bcc,
          subject: full.subject,
          inReplyTo: full.inReplyTo,
          references: full.references,
          attachments,
        };
        const from = full.addresses.from[0];
        if (from) inherited.from = from;
        return inherited;
      },
      { readOnly: true },
    );
  }

  /**
   * Remove the draft a new version replaced: expunged if this process saved it (same Message-ID),
   * otherwise moved to Trash so a draft the user wrote in Apple Mail stays recoverable.
   */
  private async retireDraft(drafts: MailboxInfo, uid: number, messageId: string | null): Promise<string> {
    if (messageId && this.selfDrafts.has(messageId.toLowerCase())) {
      await deleteDraft(this.imap, this.mailboxes, drafts, uid, messageId);
      this.selfDrafts.delete(messageId.toLowerCase());
      return 'deleted (it was a draft Claude saved earlier in this session)';
    }
    const trash = await this.mailboxes.resolveSpecial('trash');
    if (!trash || trash.path === drafts.path) throw new MailError('NOT_FOUND', 'there is no Trash folder to move it to, so it was left in Drafts');
    const moved = await moveMessages(this.imap, this.mailboxes, drafts, [uid], trash);
    if (moved.moved !== 1) throw new MailError('NOT_FOUND', `draft ${uid} no longer exists in "${drafts.path}"`);
    return `moved to ${trash.path} (recoverable)`;
  }

  async saveDraft(input: DraftInput, opts: OperationOptions = {}): Promise<DraftResult> {
    this.assertWritable('Saving drafts');
    if (input.replyTo && input.forwardOf) throw new MailError('INVALID_INPUT', 'Use either reply_to or forward_of, not both.');
    const drafts = await this.mailboxes.resolveSpecial('drafts', { create: true });
    if (!drafts) throw new MailError('NOT_FOUND', `No Drafts mailbox was found. Set its name as ${settingName('MAIL_DRAFTS_MAILBOX')}.`);
    let replaced: { uid: number; messageId: string | null } | undefined;
    let inherited: InheritedDraft | undefined;
    if (input.replaceDraftUid !== undefined) {
      replaced = await checkReplaceableDraft(this.imap, drafts, input.replaceDraftUid);
      // A plain revision keeps everything the call leaves out (recipients, subject, threading,
      // attachments); a reply_to / forward_of rebuilds the draft from that message instead.
      if (!input.replyTo && !input.forwardOf) {
        const withAttachments = input.attachments === undefined && input.keepAttachments !== false;
        inherited = await this.loadInheritedDraft(drafts, input.replaceDraftUid, withAttachments);
      }
    }

    let msg: OutgoingMessage;
    let related: Record<string, unknown> = {};
    if (input.replyTo) {
      const r = await this.composeReply({ ...input, mailbox: input.replyTo.mailbox, uid: input.replyTo.uid, replyAll: input.replyTo.replyAll }, { requireRecipient: false });
      msg = r.msg;
      related = { reply_to: r.original };
    } else if (input.forwardOf) {
      const r = await this.composeForward({ ...input, mailbox: input.forwardOf.mailbox, uid: input.forwardOf.uid, includeAttachments: input.forwardOf.includeAttachments }, { requireRecipient: false });
      msg = r.msg;
      related = { forward_of: r.original };
    } else {
      msg = await this.composeNew(input, { requireRecipient: false, inherited });
    }
    const built = await buildMessage(msg);
    this.checkSignal(opts.signal, 'saving the draft');
    const entry = { tool: 'save_draft', mailbox: drafts.path, from: msg.from.address, recipients: built.envelope.to, subject: msg.subject, message_id: built.messageId, ...related };
    let appended;
    try {
      appended = await appendMessage(this.imap, this.mailboxes, drafts.path, built.rawWithBcc, ['\\Draft', '\\Seen'], built.date, built.messageId);
    } catch (err) {
      await this.audit.record({ ...entry, result: 'error', error_code: err instanceof MailError ? err.code : 'INTERNAL', error: err instanceof MailError ? err.message : redact(errorMessage(err)) });
      throw markAudited(err);
    }
    this.selfDrafts.add(built.messageId.toLowerCase());
    this.rememberBuilt(built, (input.attachments?.length ?? 0) > 0);
    const result: DraftResult = {
      saved: true,
      mailbox: appended.mailbox,
      uid: appended.uid,
      message_id: built.messageId,
      from: formatAddress(msg.from),
      to: msg.to.map(formatAddress),
      cc: msg.cc.map(formatAddress),
      bcc: msg.bcc.map(formatAddress),
      subject: msg.subject || '(no subject)',
      attachments: msg.attachments.map((a) => a.filename),
      body_chars: msg.text.length,
      note: "The draft was saved and will appear in Apple Mail's Drafts folder (iCloud syncs it).",
    };
    if (inherited) {
      const kept: string[] = [];
      if (input.from === undefined && inherited.from) kept.push('from');
      if (input.to === undefined && inherited.to.length) kept.push('to');
      if (input.cc === undefined && inherited.cc.length) kept.push('cc');
      if (input.bcc === undefined && inherited.bcc.length) kept.push('bcc');
      if (input.subject === undefined && inherited.subject) kept.push('subject');
      if (inherited.inReplyTo || inherited.references.length) kept.push('threading headers');
      if (input.attachments === undefined && inherited.attachments?.length) kept.push('attachments');
      if (kept.length) result.inherited = kept;
    }
    if (appended.flags && !appended.flags.some((f) => f.toLowerCase() === '\\draft')) {
      result.warning = `The server did not keep the \\Draft flag on the saved message (flags: ${appended.flags.join(' ') || 'none'}).`;
    }
    if (replaced) {
      try {
        result.old_draft = await this.retireDraft(drafts, replaced.uid, replaced.messageId);
        result.replaced_uid = replaced.uid;
      } catch (err) {
        result.replace_error = `The new draft was saved, but the old draft ${replaced.uid} was not removed: ${err instanceof MailError ? err.message : redact(errorMessage(err))}`;
      }
    }
    await this.audit.record({ ...entry, result: 'ok', uid: result.uid, replaced_uid: result.replaced_uid, old_draft: result.old_draft, replace_error: result.replace_error });
    return result;
  }

  // -------------------------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------------------------

  async sendEmail(input: NewMessageInput, opts: OperationOptions = {}): Promise<SendResult | NotSentResult> {
    this.assertCanSend();
    const reservation = this.rateLimiter.reserve();
    try {
      const msg = await this.composeNew(input, { requireRecipient: true });
      const built = await buildMessage(msg);
      this.rememberBuilt(built, (input.attachments?.length ?? 0) > 0);
      return await this.sender.send(built, { tool: 'send_email', signal: opts.signal, reservation });
    } finally {
      reservation.release();
    }
  }

  /** Flag the replied-to / forwarded original, and mark it read (as Apple Mail does). */
  private async markOriginal(original: { mailbox: string; uid: number }, flags: string[]): Promise<{ original_marked: boolean; original_mark_note?: string }> {
    const label = flags.join(' ');
    try {
      const ok = await addFlagsToMessage(this.imap, original.mailbox, original.uid, flags);
      this.mailboxes.invalidateCounts();
      return ok ? { original_marked: true } : { original_marked: false, original_mark_note: `The original message could not be marked ${label} (it may have been moved, or the server does not allow the flag).` };
    } catch (err) {
      return { original_marked: false, original_mark_note: `Marking the original ${label} failed: ${err instanceof MailError ? err.message : redact(errorMessage(err))}` };
    }
  }

  async replyToMessage(input: ReplyInput, opts: OperationOptions = {}): Promise<ReplyResult> {
    this.assertCanSend();
    const reservation = this.rateLimiter.reserve();
    try {
      const { msg, original } = await this.composeReply(input, { requireRecipient: true });
      const built = await buildMessage(msg);
      this.rememberBuilt(built, (input.attachments?.length ?? 0) > 0);
      const res = await this.sender.send(built, {
        tool: 'reply_to_message',
        signal: opts.signal,
        reservation,
        audit: { reply_to: original },
        afterSend: () => this.markOriginal(original, [ANSWERED, SEEN]),
      });
      if (!res.sent) return res;
      return { ...res, original };
    } finally {
      reservation.release();
    }
  }

  async forwardMessage(input: ForwardInput, opts: OperationOptions = {}): Promise<ReplyResult> {
    this.assertCanSend();
    const reservation = this.rateLimiter.reserve();
    try {
      const { msg, original } = await this.composeForward(input, { requireRecipient: true });
      const built = await buildMessage(msg);
      this.rememberBuilt(built, (input.attachments?.length ?? 0) > 0);
      const res = await this.sender.send(built, {
        tool: 'forward_message',
        signal: opts.signal,
        reservation,
        audit: { forward_of: original },
        afterSend: () => this.markOriginal(original, [FORWARDED, SEEN]),
      });
      if (!res.sent) return res;
      return { ...res, original };
    } finally {
      reservation.release();
    }
  }

  /**
   * send_draft: send a draft from the Drafts folder exactly as saved (including edits the user made
   * in Apple Mail), through the same pipeline as the other send tools (rate limits, confirmation
   * dialog, Sent copy, audit). Bcc goes into the envelope only; Date and Message-ID are renewed.
   * Afterwards the draft is removed: deleted when the Sent copy (which has the same content) was
   * saved, otherwise moved to Trash.
   */
  async sendDraft(params: { uid: number }, opts: OperationOptions = {}): Promise<ReplyResult> {
    this.assertCanSend();
    const reservation = this.rateLimiter.reserve();
    try {
      const drafts = await this.mailboxes.resolveSpecial('drafts');
      if (!drafts) throw new MailError('NOT_FOUND', `No Drafts mailbox was found. Set its name as ${settingName('MAIL_DRAFTS_MAILBOX')}.`);
      const uid = this.uid(params.uid);
      const { source, full } = await this.imap.withMailbox(
        drafts.path,
        async (client) => {
          const msg = await client.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
          if (!msg || msg.uid !== uid || hasFlag(msg.flags ?? [], DELETED) || !msg.source) {
            throw new MailError('NOT_FOUND', `No draft with UID ${uid} in "${drafts.path}". Search the Drafts mailbox to get current UIDs.`);
          }
          if (!hasFlag(msg.flags ?? [], DRAFT)) throw new MailError('FORBIDDEN', `Message ${uid} in "${drafts.path}" is not marked as a draft (\\Draft), so it is not sent.`);
          return { source: msg.source, full: await fetchFullMessage(client, drafts.path, uid, { timeZone: this.config.timezone }) };
        },
        { readOnly: true },
      );
      const draftFrom = full.addresses.from[0];
      if (!draftFrom?.address) throw new MailError('INVALID_INPUT', 'The draft has no From address; open it in Apple Mail or save it again with save_draft.');
      const allowed = this.config.allowedFrom.find((a) => a.toLowerCase() === draftFrom.address.toLowerCase());
      if (!allowed) {
        throw new MailError('FORBIDDEN', `The draft's From address ${draftFrom.address} is not one of the allowed From addresses (${this.config.allowedFrom.join(', ')}); iCloud would refuse it. Change it in Apple Mail or re-save the draft.`);
      }
      const recipients = finalizeRecipients({ to: full.addresses.to, cc: full.addresses.cc, bcc: full.addresses.bcc }, this.config.maxRecipients, { requireTo: true });
      const date = new Date();
      const rebuilt = rebuildDraftForSending(source, { from: allowed, date });
      const message: OutgoingMessage = {
        from: { name: draftFrom.name, address: allowed },
        ...recipients,
        replyTo: full.addresses.replyTo,
        subject: full.subject,
        text: full.bodyText,
        attachments: full.attachments.map((a) => ({ filename: a.filename ?? `part ${a.part} (${a.content_type})`, content: Buffer.alloc(0) })),
      };
      const built: BuiltMessage = {
        messageId: rebuilt.messageId,
        date,
        envelope: { from: allowed, to: [...recipients.to, ...recipients.cc, ...recipients.bcc].map((a) => a.address) },
        raw: rebuilt.raw,
        rawWithBcc: rebuilt.rawWithBcc,
        eightBit: rebuilt.eightBit,
        message,
      };
      const draftRef = { mailbox: drafts.path, uid };
      const res = await this.sender.send(built, {
        tool: 'send_draft',
        signal: opts.signal,
        reservation,
        audit: { draft: draftRef },
        afterSend: async () => {
          const out: Record<string, unknown> = {};
          // Remove the draft so it is not sent twice from Apple Mail later.
          try {
            const sentCopy = await findByMessageId(this.imap, (await this.mailboxes.resolveSpecial('sent'))?.path ?? drafts.path, built.messageId).catch(() => []);
            if (sentCopy.length > 0 && full.messageId) {
              this.selfDrafts.add(full.messageId.toLowerCase());
              out['draft_removed'] = await this.retireDraft(drafts, uid, full.messageId);
            } else {
              this.selfDrafts.delete((full.messageId ?? '').toLowerCase());
              out['draft_removed'] = await this.retireDraft(drafts, uid, null);
            }
          } catch (err) {
            out['draft_removed'] = false;
            out['draft_note'] = `The email was sent, but the draft could not be removed from Drafts: ${err instanceof MailError ? err.message : redact(errorMessage(err))}. Delete it in Apple Mail so it is not sent again.`;
          }
          // Mark the message the draft replies to as answered (and read), when it is in INBOX.
          const parent = full.inReplyTo ? (extractMessageIds(full.inReplyTo)[0] ?? full.inReplyTo) : null;
          if (parent) {
            try {
              const inbox = await this.mailboxes.inbox();
              const hits = await findByMessageId(this.imap, inbox.path, parent);
              if (hits[0] !== undefined) Object.assign(out, await this.markOriginal({ mailbox: inbox.path, uid: hits[0] }, [ANSWERED, SEEN]));
            } catch {
              // optional
            }
          }
          return out;
        },
      });
      if (!res.sent) return res;
      return { ...res, original: draftRef };
    } finally {
      reservation.release();
    }
  }

  /** Check which UIDs exist in a mailbox (helper for tools/tests). */
  async existingUids(mailbox: string, uids: number[]): Promise<{ found: number[]; not_found: number[] }> {
    this.assertConfigured();
    const mb = await this.mailboxes.resolve(mailbox);
    const valid = validateUids(uids);
    const r = await this.imap.withMailbox(mb.path, (client) => verifyUids(client, valid), { readOnly: true });
    return { found: r.found, not_found: r.notFound };
  }

  /** Log out of IMAP now but keep the service usable (the next call reconnects). */
  async release(): Promise<void> {
    await this.imap.release();
  }

  /** Log out of IMAP (capped at 2 s) and refuse further work; for process shutdown. */
  async close(): Promise<void> {
    await this.imap.close();
  }

  /** Debug helper: JSON of the effective config without secrets. */
  describeConfig(): string {
    return toJson({ ...this.config, password: this.config.password ? '[set]' : '[not set]' });
  }
}
