/**
 * Tool registration by feature switch (SPEC §3, §6):
 * - read tools and download_attachment: always;
 * - mailbox changes and save_draft: unless MAIL_READ_ONLY;
 * - send tools: MAIL_ALLOW_SEND and not read-only;
 * - delete_messages_permanently: MAIL_ALLOW_PERMANENT_DELETE and not read-only.
 *
 * With an invalid configuration the same rules apply to the (defaulted) switches, so the tools are
 * still listed and every call explains what to fix.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { effectiveFeatures } from '../config.js';
import { ATTACHMENT_TOOL_NAMES, registerAttachmentTools } from './attachments.js';
import type { ToolRuntime } from './common.js';
import { DELETE_TOOL_NAMES, registerDeleteTools } from './delete.js';
import { DRAFT_TOOL_NAMES, registerDraftTools } from './drafts.js';
import { MAILBOX_TOOL_NAMES, registerMailboxTools } from './mailbox.js';
import { READ_TOOL_NAMES, registerReadTools } from './read.js';
import { SEND_TOOL_NAMES, registerSendTools } from './send.js';

export type { ToolRuntime } from './common.js';

export type Features = ReturnType<typeof effectiveFeatures>;

/** Every tool this server can register, by group (the .mcpb manifest must list all of them). */
export const TOOL_GROUPS = {
  read: READ_TOOL_NAMES,
  attachments: ATTACHMENT_TOOL_NAMES,
  mailbox: MAILBOX_TOOL_NAMES,
  drafts: DRAFT_TOOL_NAMES,
  send: SEND_TOOL_NAMES,
  delete: DELETE_TOOL_NAMES,
} as const;

export const ALL_TOOL_NAMES: readonly string[] = Object.values(TOOL_GROUPS).flat();

/** Names of the tools registered for the given feature switches, in registration order. */
export function toolNamesFor(features: Features): string[] {
  return [
    ...READ_TOOL_NAMES,
    ...ATTACHMENT_TOOL_NAMES,
    ...(features.mailboxChanges ? MAILBOX_TOOL_NAMES : []),
    ...(features.drafts ? DRAFT_TOOL_NAMES : []),
    ...(features.send ? SEND_TOOL_NAMES : []),
    ...(features.permanentDelete ? DELETE_TOOL_NAMES : []),
  ];
}

export function registerTools(server: McpServer, rt: ToolRuntime): void {
  const f = rt.service.features;
  registerReadTools(server, rt);
  registerAttachmentTools(server, rt);
  if (f.mailboxChanges) registerMailboxTools(server, rt);
  if (f.drafts) registerDraftTools(server, rt);
  if (f.send) registerSendTools(server, rt);
  if (f.permanentDelete) registerDeleteTools(server, rt);
}
