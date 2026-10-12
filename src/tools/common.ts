/**
 * Shared plumbing for the MCP tool modules: annotation presets, reusable input fields, and the
 * handler wrapper every tool runs through (SPEC §2.11, §5 "Output format"):
 *
 * - overall deadline (MAIL_OPERATION_TIMEOUT_SECONDS) combined with the client's cancellation
 *   signal; the combined AbortSignal is handed to the domain call, which checks it before
 *   destructive steps;
 * - any thrown error becomes `{isError: true}` with an actionable, redacted message;
 * - write tools whose failure was not already written to the audit log by the domain layer (a
 *   refusal before the action, a rate limit, a timeout, …) get an audit entry here, never with a
 *   body;
 * - every text block is capped at ~100k characters.
 */
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { wasAudited } from '../audit.js';
import { withDeadline } from '../deadline.js';
import { MailError, describeError } from '../errors.js';
import { truncateResult } from '../format.js';
import type { Logger } from '../log.js';
import { DIALOG_GIVE_UP_SECONDS } from '../safety/confirm.js';
import type { MailService } from '../service.js';

export interface ToolRuntime {
  service: MailService;
  logger: Logger;
}

/** True for the Vercel-hosted version (no local disk, no Mac confirmation dialog). */
export function isCloud(rt: ToolRuntime): boolean {
  return rt.service.config.runtime === 'cloud';
}

/** How files get into outgoing mail in the cloud version, for tool descriptions. */
export const CLOUD_ATTACHMENTS_NOTE =
  'Files from disk cannot be attached in the cloud version: to share a file, put a link from another connector (for example a shared Google Drive or Dropbox link) in the body, or forward an existing email with its attachments (forward_message).';

/**
 * Cloud version: drop the local-file `attachments` parameter (there is no disk to attach from),
 * so Claude is never offered it. The field is optional, so handlers see it as undefined.
 */
export function forRuntime<T extends z.ZodObject>(rt: ToolRuntime, schema: T): T {
  if (!isCloud(rt) || !('attachments' in schema.shape)) return schema;
  return schema.omit({ attachments: true } as never) as unknown as T;
}

/** Tool annotations with every hint set explicitly (SPEC §6). */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export const READ_HINTS: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Local file write (download_attachment) and mailbox changes (SPEC §6.2, §6.3). */
export const WRITE_IDEMPOTENT_HINTS: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** trash_messages, save_draft. */
export const WRITE_NON_IDEMPOTENT_HINTS: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** delete_mailbox. */
export const DESTRUCTIVE_NON_IDEMPOTENT_HINTS: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
/** send_email, reply_to_message, forward_message (SPEC §6.6). */
export const SEND_HINTS: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** delete_messages_permanently (SPEC §6.7). */
export const PERMANENT_DELETE_HINTS: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** `_meta` for tools that must prompt on every call (Claude Code honours it; harmless elsewhere). */
export const REQUIRES_USER_INTERACTION_META = { 'anthropic/requiresUserInteraction': true } as const;

export function annotations(title: string, hints: ToolHints): ToolHints & { title: string } {
  return { title, ...hints };
}

// ---------------------------------------------------------------------------------------------
// Reusable input fields
// ---------------------------------------------------------------------------------------------

export const MAX_UIDS = 500;

export const mailboxField = (what = 'Mailbox'): z.ZodString =>
  z
    .string()
    .min(1)
    .max(1000)
    .describe(
      `${what}: the exact path from list_mailboxes or search results (e.g. "INBOX", "Projects/Acme"); aliases like "sent", "drafts", "archive", "junk" and "trash" also work.`,
    );

export const uidField = (): z.ZodNumber =>
  z
    .number()
    .int()
    .min(1)
    .max(4_294_967_295)
    .describe('UID of the message in that mailbox, from search_messages or get_thread results (UIDs change when a message is moved).');

export const uidsField = (): z.ZodArray<z.ZodNumber> =>
  z
    .array(z.number().int().min(1).max(4_294_967_295))
    .min(1)
    .max(MAX_UIDS)
    .describe(`UIDs of the messages in that mailbox (1 to ${MAX_UIDS}), from search_messages results.`);

const ADDRESS_ITEM = z.string().min(1).max(998);

export const addressListField = (what: string): z.ZodArray<z.ZodString> =>
  z
    .array(ADDRESS_ITEM)
    .max(500)
    .describe(`${what}: a list of email addresses, each "user@example.com" or "Name <user@example.com>".`);

export const fromField = (): z.ZodString =>
  z
    .string()
    .min(1)
    .max(998)
    .describe(
      'From address. Must be one of the account\'s allowed addresses (the iCloud address, the "From address (optional)" and "Other From addresses (optional)" settings; see get_account_info from.allowed). Omit to use the default (for replies and forwards: the allowed address the original came from or was sent to).',
    );

export const bodyField = (what: string): z.ZodString => z.string().max(2_000_000).describe(what);

export const htmlField = (): z.ZodString =>
  z
    .string()
    .max(5_000_000)
    .describe('Optional HTML version of the body. It is sent together with the plain-text body (multipart/alternative); the plain-text body is still required.');

export const attachmentsField = (): z.ZodArray<z.ZodString> =>
  z
    .array(z.string().min(1).max(4096))
    .max(50)
    .describe(
      'Local files to attach, as absolute paths or paths starting with "~/". They must be inside the allowed attachment folders ("Attach files from" in the extension settings; get_account_info lists them as attach_from_dirs; default Desktop, Documents, Downloads); hidden files and folders are refused. At most 14 MB in total.',
    );

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text: truncateResult(text) }], isError: true };
}

/** Keep every text block under the result size limit (SPEC §5). */
export function capResult(result: CallToolResult): CallToolResult {
  let changed = false;
  const content = result.content.map((block) => {
    if (block.type === 'text') {
      const text = truncateResult(block.text);
      if (text !== block.text) {
        changed = true;
        return { ...block, text };
      }
    }
    return block;
  });
  return changed ? { ...result, content } : result;
}

/** Human note for UIDs that were not found (they were probably moved or deleted meanwhile). */
export function notFoundNote(mailbox: string, notFound: readonly number[]): string | undefined {
  if (notFound.length === 0) return undefined;
  return `UID${notFound.length === 1 ? '' : 's'} ${notFound.slice(0, 50).join(', ')}${notFound.length > 50 ? ', …' : ''} ${notFound.length === 1 ? 'was' : 'were'} not found in "${mailbox}" (already moved or deleted?); search again to get current UIDs.`;
}

// ---------------------------------------------------------------------------------------------
// Handler wrapper
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  /** Deadline override in ms (default: MAIL_OPERATION_TIMEOUT_SECONDS). */
  timeoutMs?: number;
  /**
   * For write tools: safe fields describing the attempted action (mailbox, uids, recipients,
   * subject, … never a body) recorded when the call fails before the domain layer audited it.
   */
  audit?: () => Record<string, unknown>;
}

const QUIET_CODES = new Set(['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'CONFIG', 'EXPUNGE_GUARD', 'RATE_LIMIT', 'TOO_LARGE', 'CANCELLED']);

/**
 * Run one tool call under the deadline and turn every failure into an actionable isError result.
 * `fn` receives the combined deadline/cancellation signal.
 */
export async function runTool(
  rt: ToolRuntime,
  name: string,
  ctx: ServerContext,
  fn: (signal: AbortSignal) => Promise<CallToolResult>,
  options: RunOptions = {},
): Promise<CallToolResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? rt.service.config.operationTimeoutSeconds * 1000;
  try {
    const result = await withDeadline(fn, { timeoutMs, signal: ctx.mcpReq.signal, what: name });
    rt.logger.info('tool call finished', { tool: name, ms: Date.now() - started });
    return capResult(result);
  } catch (err) {
    const text = describeError(err);
    const code = err instanceof MailError ? err.code : 'INTERNAL';
    const fields = { tool: name, code, ms: Date.now() - started };
    if (QUIET_CODES.has(code)) rt.logger.info('tool call refused', fields);
    else if (code === 'INTERNAL') rt.logger.error('tool call failed unexpectedly', { ...fields, err: text });
    else rt.logger.warn('tool call failed', { ...fields, err: text });
    if (options.audit && code !== 'CONFIG' && !wasAudited(err)) {
      let details: Record<string, unknown> = {};
      try {
        details = options.audit();
      } catch {
        // Never let audit detail extraction mask the real error.
      }
      await rt.service.audit.record({ ...details, tool: name, result: code === 'CANCELLED' ? 'cancelled' : 'error', error_code: code, error: text });
    }
    return errorResult(text);
  }
}

/**
 * Deadline for tools that may wait for the native confirmation dialog (send, permanent delete):
 * the dialog alone may stay open for DIALOG_GIVE_UP_SECONDS (120 s), so with MAIL_CONFIRM_DIALOG
 * on these tools get at least that plus 60 s for the actual work, still under Claude Desktop's
 * ~240 s tool timeout. Without the dialog the normal deadline applies.
 */
export function confirmAwareTimeoutMs(rt: ToolRuntime): number | undefined {
  const config = rt.service.config;
  if (!config.confirmDialog) return undefined;
  return Math.max(config.operationTimeoutSeconds, DIALOG_GIVE_UP_SECONDS + 60) * 1000;
}

/** Recipients for audit entries: the raw strings Claude supplied (addresses only; never bodies). */
export function auditRecipients(...lists: Array<readonly string[] | undefined>): string[] {
  return lists.flatMap((l) => (l ? [...l] : [])).slice(0, 100);
}
