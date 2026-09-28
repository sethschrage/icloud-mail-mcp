/**
 * MailService: the domain-layer facade the MCP tool handlers call. It wires config, credentials,
 * the IMAP connection manager, mailbox registry, sender, rate limiter, audit log and the optional
 * confirmation dialog, and implements every tool's behaviour (validation, guardrails, audit).
 * Handlers only parse input (zod), call one method, and render the result (see render.ts).
 */
import type { ImapFlow, ImapFlowOptions } from 'imapflow';
import { AuditLog, markAudited } from './audit.js';
import { MAX_BODY_CHARS_CEILING, effectiveFeatures, loadConfig, type Config, type ConfigResult, type LoadConfigOptions } from './config.js';
import { APP_PASSWORD_HELP, CredentialProvider, type CredentialOptions } from './credentials.js';
import { MailError, errorMessage } from './errors.js';
import { formatDateISO, formatSize, toJson } from './format.js';
import { ImapManager } from './imap/client.js';
import { downloadPartToDir, fetchAttachmentBuffers, fetchFullMessage, type FullMessage } from './imap/fetch.js';
import { ANSWERED, FORWARDED, SEEN, isFlagColor, type FlagColor } from './imap/flags.js';
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
import { buildMessageView, type MessageView } from './render.js';
import { CONFIRM_DISABLE_HINT, buildDeleteConfirmationMessage, createConfirmer, type ConfirmFn } from './safety/confirm.js';
import type { PathContext } from './safety/paths.js';
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
  forwardSubject,
  loadAttachments,
  normalizeRecipients,
  parseAddressInputs,
  replyFromCandidate,
  replySubject,
  resolveFrom,
  type OriginalMessage,
  type OutgoingAttachment,
  type OutgoingMessage,
} from './smtp/compose.js';
import { parseAddressString } from './smtp/address.js';
import { RateLimiter, Sender, type NotSentResult, type SendResult, type TransportFactory } from './smtp/send.js';

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
}

export interface DraftResult {
  saved: true;
  mailbox: string;
  uid: number | null;
  message_id: string;
  replaced_uid?: number;
  replace_error?: string;
  /** Set when the server did not keep \\Draft (Apple Mail would then not treat it as a draft). */
  warning?: string;
  note: string;
}

export type ReplyResult = (SendResult & { original: { mailbox: string; uid: number }; original_marked: boolean; original_mark_note?: string }) | NotSentResult;

export interface AttachmentResult {
  mailbox: string;
  uid: number;
  part: string;
  path: string;
  filename: string;
  size: number;
  size_human: string;
  content_type: string;
  /** Returned inline content (image as base64, or text) when requested and small enough. */
  content?: { kind: 'image'; mimeType: string; data: string } | { kind: 'text'; text: string };
  note?: string;
}

export const IMAGE_INLINE_MAX_BYTES = 3 * 1024 * 1024;
export const TEXT_INLINE_MAX_BYTES = 200 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function isInlineTextType(contentType: string): boolean {
  const t = contentType.toLowerCase();
  return (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t === 'application/csv' ||
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
  readonly sender: Sender;
  private readonly confirm: ConfirmFn;
  private readonly pathContext: PathContext | undefined;

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
    const confirm = deps.confirm ?? createConfirmer(deps.platform ? { platform: deps.platform } : {});
    this.sender = new Sender({
      config: this.config,
      credentials: this.credentials,
      imap: this.imap,
      registry: this.mailboxes,
      audit: this.audit,
      rateLimiter: this.rateLimiter,
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
      `The iCloud Mail server is not configured correctly:\n- ${this.configErrors.join('\n- ')}${needsPasswordHelp ? `\n${APP_PASSWORD_HELP}` : ''}`,
    );
  }

  private assertWritable(what: string): void {
    this.assertConfigured();
    if (this.config.readOnly) throw new MailError('FORBIDDEN', `${what} is not available: the server runs in read-only mode (MAIL_READ_ONLY=true).`);
  }

  private assertCanSend(): void {
    this.assertWritable('Sending');
    if (!this.config.allowSend) throw new MailError('FORBIDDEN', 'Sending is disabled (MAIL_ALLOW_SEND=false). Save a draft instead.');
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
    const list = await this.mailboxes.list({ refresh: false });
    const includeCounts = options.includeCounts ?? true;
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
    const maxChars = Math.min(MAX_BODY_CHARS_CEILING, Math.max(1, Math.floor(params.maxChars ?? this.config.maxBodyChars)));
    const notes: string[] = [];
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
      this.mailboxes.invalidate();
      notes.push('The message was marked as read.');
      await this.audit.record({ tool: 'get_message', result: 'ok', action: 'mark_as_read', mailbox: mb.path, uids: [uid] });
    }
    return buildMessageView(full, maxChars, notes);
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
        max_recipients: c.maxRecipients,
      },
      limits: { max_body_chars: c.maxBodyChars, max_attachment_mb: c.maxAttachmentMb, operation_timeout_seconds: c.operationTimeoutSeconds },
      attachment_dir: c.attachmentDir,
      attach_from_dirs: c.attachFromDirs,
      audit_log: c.auditLog ?? 'off',
      now: { local: formatDateISO(new Date(), c.timezone), timezone: c.timezone },
    };
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
    const file = await this.imap.withMailbox(
      mb.path,
      (client) => downloadPartToDir(client, mb.path, uid, params.part, { dir: this.config.attachmentDir, maxBytes, captureUpTo: returnContent ? IMAGE_INLINE_MAX_BYTES : 0 }),
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
    if (returnContent) {
      if (file.content && INLINE_IMAGE_TYPES.has(file.content_type) && file.size <= IMAGE_INLINE_MAX_BYTES) {
        result.content = { kind: 'image', mimeType: file.content_type, data: file.content.toString('base64') };
      } else if (file.content && isInlineTextType(file.content_type) && file.size <= TEXT_INLINE_MAX_BYTES) {
        result.content = { kind: 'text', text: decodeCharset(file.content, file.charset ?? 'utf-8') };
      } else {
        result.note = `Saved to ${file.path}. The content is not shown here (${file.content_type}, ${formatSize(file.size)}); the user can open the file from that folder.`;
      }
    }
    await this.audit.record({ tool: 'download_attachment', result: 'ok', mailbox: mb.path, uids: [uid], part: params.part, path: file.path });
    return result;
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
          if (params.read !== undefined) this.mailboxes.invalidate(); // unread counts changed
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
    if (!trash) throw new MailError('NOT_FOUND', 'No Trash (Deleted Messages) mailbox was found. Set MAIL_TRASH_MAILBOX to its name.');
    if (trash.path === source.path) {
      const how = this.features.permanentDelete
        ? 'To remove them for good, use delete_messages_permanently (this cannot be undone).'
        : 'Permanent deletion is disabled on this server (MAIL_ALLOW_PERMANENT_DELETE=false); iCloud purges Deleted Messages automatically after about 30 days.';
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
    if (!this.config.allowPermanentDelete) throw new MailError('FORBIDDEN', 'Permanent deletion is disabled (MAIL_ALLOW_PERMANENT_DELETE=false). Use trash_messages instead.');
    const mb = await this.mailboxes.resolve(params.mailbox);
    const uids = validateUids(params.uids);
    const entry = { tool: 'delete_messages_permanently', mailbox: mb.path, uids };
    if (this.config.confirmDialog) {
      const subjects = await fetchSubjects(this.imap, mb.path, uids);
      if (subjects.length === 0) return { mailbox: mb.path, deleted: 0, not_found: uids };
      const decision = await this.confirm({
        title: 'iCloud Mail: permanently delete?',
        action: 'Delete',
        message: buildDeleteConfirmationMessage({ mailbox: mb.path, count: subjects.length, subjects: subjects.map((s) => s.subject) }),
      });
      if (decision.status === 'unavailable') {
        await this.audit.record({ ...entry, result: 'error', error_code: 'CONFIRM_UNAVAILABLE', error: `confirmation dialog unavailable: ${decision.reason}` });
        throw markAudited(new MailError('CONFIRM_UNAVAILABLE', `Nothing was deleted: the confirmation dialog could not be shown (${decision.reason}). ${CONFIRM_DISABLE_HINT}`));
      }
      if (decision.status === 'declined') {
        await this.audit.record({ ...entry, result: 'cancelled', error: decision.reason });
        return {
          deleted: 0,
          cancelled: true,
          message: decision.reason === 'timeout' ? 'Nothing was deleted: the confirmation dialog timed out.' : 'Nothing was deleted: the user clicked Cancel.',
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

  private async loadOriginal(mailbox: string, uid: number): Promise<{ box: MailboxInfo; full: FullMessage; original: OriginalMessage }> {
    const box = await this.mailboxes.resolve(mailbox);
    const u = this.uid(uid);
    const full = await this.imap.withMailbox(box.path, (client) => fetchFullMessage(client, box.path, u, { timeZone: this.config.timezone }), { readOnly: true });
    const original: OriginalMessage = {
      messageId: full.messageId,
      references: full.references,
      subject: full.subject,
      time: full.time,
      from: full.addresses.from,
      replyTo: full.addresses.replyTo,
      to: full.addresses.to,
      cc: full.addresses.cc,
      text: full.bodyText,
    };
    return { box, full, original };
  }

  private replyToHeader(value: string | undefined): OutgoingMessage['replyTo'] {
    if (value === undefined || value.trim() === '') return undefined;
    return parseAddressString(value, 'reply_to_address');
  }

  private async composeNew(input: NewMessageInput, options: { requireRecipient: boolean }): Promise<OutgoingMessage> {
    const from = resolveFrom(input.from, this.config);
    const recipients = normalizeRecipients(input, this.config.maxRecipients, { requireTo: options.requireRecipient });
    const attachments = await loadAttachments(input.attachments, this.config.attachFromDirs, MAX_OUTGOING_ATTACHMENT_BYTES, this.pathContext);
    return {
      from,
      ...recipients,
      replyTo: this.replyToHeader(input.replyToAddress),
      subject: cleanSubject(input.subject),
      text: input.body,
      html: input.html,
      attachments,
    };
  }

  private async composeReply(
    input: { mailbox: string; uid: number; replyAll?: boolean | undefined; body: string; html?: string | undefined; to?: string[] | undefined; cc?: string[] | undefined; bcc?: string[] | undefined; attachments?: string[] | undefined; from?: string | undefined; subject?: string | undefined },
    options: { requireRecipient: boolean },
  ): Promise<{ msg: OutgoingMessage; original: { mailbox: string; uid: number } }> {
    const { box, full, original } = await this.loadOriginal(input.mailbox, input.uid);
    const from = resolveFrom(input.from, this.config, replyFromCandidate(original, this.config.allowedFrom));
    const own = [...this.config.allowedFrom, from.address];
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
      references: buildReferences(original.references, original.messageId),
      attachments,
    };
    return { msg, original: { mailbox: box.path, uid: full.uid } };
  }

  private async composeForward(
    input: { mailbox: string; uid: number; to?: string[] | undefined; cc?: string[] | undefined; bcc?: string[] | undefined; body?: string | undefined; html?: string | undefined; includeAttachments?: boolean | undefined; attachments?: string[] | undefined; from?: string | undefined; subject?: string | undefined },
    options: { requireRecipient: boolean },
  ): Promise<{ msg: OutgoingMessage; original: { mailbox: string; uid: number } }> {
    const { box, full, original } = await this.loadOriginal(input.mailbox, input.uid);
    const from = resolveFrom(input.from, this.config, replyFromCandidate(original, this.config.allowedFrom));
    const recipients = normalizeRecipients(input, this.config.maxRecipients, { requireTo: options.requireRecipient });
    const local = await loadAttachments(input.attachments, this.config.attachFromDirs, MAX_OUTGOING_ATTACHMENT_BYTES, this.pathContext);
    const localBytes = local.reduce((n, a) => n + a.content.length, 0);
    let forwarded: OutgoingAttachment[] = [];
    if ((input.includeAttachments ?? true) && full.attachments.length > 0) {
      const buffers = await this.imap.withMailbox(box.path, (client) => fetchAttachmentBuffers(client, box.path, full.uid, MAX_OUTGOING_ATTACHMENT_BYTES - localBytes), { readOnly: true });
      // Inline (cid) images are attached as regular files: the forwarded body is text, not the original HTML.
      forwarded = buffers.map((b) => ({ filename: b.filename, content: b.content, contentType: b.contentType }));
    }
    const tz = this.config.timezone;
    const note = input.body ?? '';
    const msg: OutgoingMessage = {
      from,
      ...recipients,
      subject: input.subject !== undefined && input.subject.trim() !== '' ? cleanSubject(input.subject) : forwardSubject(original.subject),
      text: buildForwardText(note, original, tz),
      html: input.html !== undefined ? buildForwardHtml(input.html, original, tz) : undefined,
      attachments: [...forwarded, ...local],
    };
    return { msg, original: { mailbox: box.path, uid: full.uid } };
  }

  // -------------------------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------------------------

  async saveDraft(input: DraftInput, opts: OperationOptions = {}): Promise<DraftResult> {
    this.assertWritable('Saving drafts');
    if (input.replyTo && input.forwardOf) throw new MailError('INVALID_INPUT', 'Use either reply_to or forward_of, not both.');
    const drafts = await this.mailboxes.resolveSpecial('drafts', { create: true });
    if (!drafts) throw new MailError('NOT_FOUND', 'No Drafts mailbox was found. Set MAIL_DRAFTS_MAILBOX to its name.');
    if (input.replaceDraftUid !== undefined) await checkReplaceableDraft(this.imap, drafts, input.replaceDraftUid);

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
      msg = await this.composeNew(input, { requireRecipient: false });
    }
    const built = await buildMessage(msg);
    this.checkSignal(opts.signal, 'saving the draft');
    const entry = { tool: 'save_draft', mailbox: drafts.path, from: msg.from.address, recipients: built.envelope.to, subject: msg.subject, message_id: built.messageId, ...related };
    let appended;
    try {
      appended = await appendMessage(this.imap, this.mailboxes, drafts.path, built.rawWithBcc, ['\\Draft', '\\Seen'], built.date);
    } catch (err) {
      await this.audit.record({ ...entry, result: 'error', error_code: err instanceof MailError ? err.code : 'INTERNAL', error: err instanceof MailError ? err.message : redact(errorMessage(err)) });
      throw markAudited(err);
    }
    const result: DraftResult = {
      saved: true,
      mailbox: appended.mailbox,
      uid: appended.uid,
      message_id: built.messageId,
      note: "The draft was saved and will appear in Apple Mail's Drafts folder (iCloud syncs it).",
    };
    if (appended.flags && !appended.flags.some((f) => f.toLowerCase() === '\\draft')) {
      result.warning = `The server did not keep the \\Draft flag on the saved message (flags: ${appended.flags.join(' ') || 'none'}).`;
    }
    if (input.replaceDraftUid !== undefined) {
      try {
        await deleteDraft(this.imap, this.mailboxes, drafts, input.replaceDraftUid);
        result.replaced_uid = input.replaceDraftUid;
      } catch (err) {
        result.replace_error = `The new draft was saved, but the old draft ${input.replaceDraftUid} was not removed: ${err instanceof MailError ? err.message : redact(errorMessage(err))}`;
      }
    }
    await this.audit.record({ ...entry, result: 'ok', uid: result.uid, replaced_uid: result.replaced_uid, replace_error: result.replace_error });
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
      return await this.sender.send(built, { tool: 'send_email', signal: opts.signal, reservation });
    } finally {
      reservation.release();
    }
  }

  private async markOriginal(original: { mailbox: string; uid: number }, flag: string): Promise<{ original_marked: boolean; original_mark_note?: string }> {
    try {
      const ok = await addFlagsToMessage(this.imap, original.mailbox, original.uid, [flag]);
      return ok ? { original_marked: true } : { original_marked: false, original_mark_note: `The original message could not be marked ${flag} (it may have been moved, or the server does not allow the flag).` };
    } catch (err) {
      return { original_marked: false, original_mark_note: `Marking the original ${flag} failed: ${err instanceof MailError ? err.message : redact(errorMessage(err))}` };
    }
  }

  async replyToMessage(input: ReplyInput, opts: OperationOptions = {}): Promise<ReplyResult> {
    this.assertCanSend();
    const reservation = this.rateLimiter.reserve();
    try {
      const { msg, original } = await this.composeReply(input, { requireRecipient: true });
      const built = await buildMessage(msg);
      const res = await this.sender.send(built, { tool: 'reply_to_message', signal: opts.signal, reservation, audit: { reply_to: original } });
      if (!res.sent) return res;
      return { ...res, original, ...(await this.markOriginal(original, ANSWERED)) };
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
      const res = await this.sender.send(built, { tool: 'forward_message', signal: opts.signal, reservation, audit: { forward_of: original } });
      if (!res.sent) return res;
      return { ...res, original, ...(await this.markOriginal(original, FORWARDED)) };
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
