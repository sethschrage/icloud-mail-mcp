/**
 * delete_messages_permanently (SPEC §6.7). Registered only when MAIL_ALLOW_PERMANENT_DELETE is on
 * and MAIL_READ_ONLY is off. Destructive, and carries `anthropic/requiresUserInteraction`.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { renderJson } from '../render.js';
import { getRuntime } from '../runtime.js';
import { PERMANENT_DELETE_HINTS, REQUIRES_USER_INTERACTION_META, annotations, confirmAwareTimeoutMs, mailboxField, notFoundNote, runTool, textResult, uidsField, type ToolRuntime } from './common.js';

export const DELETE_TOOL_NAMES = ['delete_messages_permanently'] as const;

export function registerDeleteTools(server: McpServer, rt: ToolRuntime): void {
  const { service } = rt;
  const title = 'Delete Messages Permanently';
  server.registerTool(
    'delete_messages_permanently',
    {
      title,
      description:
        `PERMANENTLY deletes (expunges) messages from a mailbox. This bypasses Trash and CANNOT BE UNDONE. Prefer trash_messages, which is recoverable; use this only when the user explicitly asks for permanent deletion, for example to purge messages that are already in Trash. Refused when the server would also purge other messages already marked as deleted.${getRuntime() === 'cloud' ? '' : ' May require a click in a confirmation dialog on the Mac ("Confirm on my Mac before sending or permanently deleting"); if the user cancels there, nothing is deleted.'} Returns the number deleted and UIDs that were not found. Up to 500 UIDs per call.`,
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox the messages are in'),
        uids: uidsField(),
      }),
      annotations: annotations(title, PERMANENT_DELETE_HINTS),
      _meta: { ...REQUIRES_USER_INTERACTION_META },
    },
    (args, ctx) =>
      runTool(
        rt,
        'delete_messages_permanently',
        ctx,
        async (signal) => {
          const r = await service.deleteMessagesPermanently({ mailbox: args.mailbox, uids: args.uids }, { signal });
          const note = 'not_found' in r ? notFoundNote(r.mailbox, r.not_found) : undefined;
          return textResult(renderJson(note ? { ...r, note } : r));
        },
        { timeoutMs: confirmAwareTimeoutMs(rt), audit: () => ({ mailbox: args.mailbox, uids: args.uids }) },
      ),
  );
}
