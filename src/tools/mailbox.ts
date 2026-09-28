/**
 * Mailbox changes (SPEC §6.3): mark_messages, move_messages, archive_messages, trash_messages,
 * create_mailbox, rename_mailbox, delete_mailbox. Not registered in read-only mode.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { FLAG_COLORS } from '../imap/flags.js';
import type { MoveResult } from '../imap/ops.js';
import { renderJson } from '../render.js';
import {
  DESTRUCTIVE_NON_IDEMPOTENT_HINTS,
  WRITE_IDEMPOTENT_HINTS,
  WRITE_NON_IDEMPOTENT_HINTS,
  annotations,
  mailboxField,
  notFoundNote,
  runTool,
  textResult,
  uidsField,
  type ToolRuntime,
} from './common.js';

export const MAILBOX_TOOL_NAMES = ['mark_messages', 'move_messages', 'archive_messages', 'trash_messages', 'create_mailbox', 'rename_mailbox', 'delete_mailbox'] as const;

const newPathField = (what: string): z.ZodString =>
  z
    .string()
    .min(1)
    .max(500)
    .describe(`${what} Use "/" between levels for a nested folder (e.g. "Projects/2026"); it is mapped to the server's hierarchy delimiter.`);

function moveText(r: MoveResult): string {
  const note = notFoundNote(r.source, r.not_found);
  return renderJson(note ? { ...r, note } : r);
}

export function registerMailboxTools(server: McpServer, rt: ToolRuntime): void {
  const { service } = rt;

  const markTitle = 'Mark Messages';
  server.registerTool(
    'mark_messages',
    {
      title: markTitle,
      description:
        'Change the read state and/or the flag of messages in one mailbox: read=true/false marks them read or unread; flagged=true/false flags or unflags them (unflagging also clears any colour); flag_color sets an Apple Mail flag colour and implies flagged. Give at least one of read, flagged or flag_color. Changes sync to Apple Mail through iCloud. Returns how many messages were changed, counts of the state in effect afterwards (and the per-message state for up to 20 messages), anything that did not take effect, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField(),
        uids: uidsField(),
        read: z.boolean().describe('true = mark as read; false = mark as unread.').optional(),
        flagged: z.boolean().describe('true = flag; false = remove the flag and any flag colour.').optional(),
        flag_color: z.enum(FLAG_COLORS).describe('Apple Mail flag colour to set (implies flagged=true).').optional(),
      }),
      annotations: annotations(markTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(
        rt,
        'mark_messages',
        ctx,
        async (signal) => {
          const r = await service.markMessages({ mailbox: args.mailbox, uids: args.uids, read: args.read, flagged: args.flagged, flagColor: args.flag_color }, { signal });
          const note = notFoundNote(r.mailbox, r.not_found);
          return textResult(renderJson(note ? { ...r, note } : r));
        },
        { audit: () => ({ mailbox: args.mailbox, uids: args.uids, read: args.read, flagged: args.flagged, flag_color: args.flag_color }) },
      ),
  );

  const moveTitle = 'Move Messages';
  server.registerTool(
    'move_messages',
    {
      title: moveTitle,
      description:
        'Move messages from one mailbox to another existing mailbox, e.g. into a project folder. The destination is matched by exact path, by alias (inbox, sent, drafts, archive, junk, trash) or by unique folder name; it must already exist (create it first with create_mailbox) and differ from the source. For the common cases prefer archive_messages or trash_messages. iCloud has no native MOVE, so a move is a copy followed by deleting the original; it is refused when that could also purge other messages already marked as deleted. Returns the number moved, the new UIDs in the destination when the server reports them, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField('Source mailbox'),
        uids: uidsField(),
        destination: mailboxField('Destination mailbox (must already exist)'),
      }),
      annotations: annotations(moveTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'move_messages', ctx, async (signal) => textResult(moveText(await service.moveMessages({ mailbox: args.mailbox, uids: args.uids, destination: args.destination }, { signal }))), {
        audit: () => ({ mailbox: args.mailbox, uids: args.uids, destination: args.destination }),
      }),
  );

  const archiveTitle = 'Archive Messages';
  server.registerTool(
    'archive_messages',
    {
      title: archiveTitle,
      description:
        'Move messages to the Archive folder, the way Apple Mail\'s Archive button does (the folder is created if it does not exist yet). Use this when the user wants to archive or file away mail without deleting it. Refused for messages that are already in Archive. Returns the number moved, the new UIDs in Archive when the server reports them, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox the messages are in'),
        uids: uidsField(),
      }),
      annotations: annotations(archiveTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'archive_messages', ctx, async (signal) => textResult(moveText(await service.archiveMessages({ mailbox: args.mailbox, uids: args.uids }, { signal }))), {
        audit: () => ({ mailbox: args.mailbox, uids: args.uids }),
      }),
  );

  const trashTitle = 'Move Messages to Trash';
  server.registerTool(
    'trash_messages',
    {
      title: trashTitle,
      description:
        'Move messages to Trash (iCloud\'s "Deleted Messages" folder). This is the normal, recoverable way to delete mail: the user can restore it from Trash until Trash is emptied (iCloud normally after about 30 days; Apple Mail\'s "Erase deleted messages" setting can do it sooner). Messages that are already in Trash are refused (permanent deletion is a separate tool that may be disabled). Returns the number moved, the new UIDs in Trash when the server reports them, and UIDs that were not found. Up to 500 UIDs per call.',
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox the messages are in'),
        uids: uidsField(),
      }),
      annotations: annotations(trashTitle, WRITE_NON_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'trash_messages', ctx, async (signal) => textResult(moveText(await service.trashMessages({ mailbox: args.mailbox, uids: args.uids }, { signal }))), {
        audit: () => ({ mailbox: args.mailbox, uids: args.uids }),
      }),
  );

  const createTitle = 'Create Mailbox';
  server.registerTool(
    'create_mailbox',
    {
      title: createTitle,
      description:
        'Create a new mailbox (folder) in iCloud Mail, e.g. "Receipts 2026" or the nested "Projects/2026". The parent of a nested folder must allow subfolders (iCloud does not allow folders inside INBOX). Refused when a mailbox with that name already exists. The folder appears in Apple Mail once iCloud syncs. Returns the created path.',
      inputSchema: z.strictObject({
        path: newPathField('Path of the new mailbox.'),
      }),
      annotations: annotations(createTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'create_mailbox', ctx, async (signal) => textResult(renderJson(await service.createMailbox({ path: args.path }, { signal }))), {
        audit: () => ({ mailbox: args.path }),
      }),
  );

  const renameTitle = 'Rename Mailbox';
  server.registerTool(
    'rename_mailbox',
    {
      title: renameTitle,
      description:
        'Rename a user-created mailbox, or move it under another folder: e.g. path "Receipts" with new_path "Finance/Receipts". Its messages and subfolders go with it. INBOX and the special folders (Sent, Drafts, Archive, Junk, Trash) cannot be renamed, and new_path must not exist yet. Returns the old and new paths.',
      inputSchema: z.strictObject({
        path: mailboxField('Mailbox to rename'),
        new_path: newPathField('New full path for the mailbox.'),
      }),
      annotations: annotations(renameTitle, WRITE_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'rename_mailbox', ctx, async (signal) => textResult(renderJson(await service.renameMailbox({ path: args.path, newPath: args.new_path }, { signal }))), {
        audit: () => ({ mailbox: args.path, destination: args.new_path }),
      }),
  );

  const deleteTitle = 'Delete Empty Mailbox';
  server.registerTool(
    'delete_mailbox',
    {
      title: deleteTitle,
      description:
        'Delete an empty, user-created mailbox (folder). Only allowed when the mailbox contains no messages and no subfolders, and never for INBOX or the special folders (Sent, Drafts, Archive, Junk, Trash); otherwise nothing is changed and the error explains why (move or trash the messages first). The folder itself cannot be restored afterwards.',
      inputSchema: z.strictObject({
        path: mailboxField('Mailbox to delete'),
      }),
      annotations: annotations(deleteTitle, DESTRUCTIVE_NON_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(rt, 'delete_mailbox', ctx, async (signal) => textResult(renderJson(await service.deleteMailbox({ path: args.path }, { signal }))), {
        audit: () => ({ mailbox: args.path }),
      }),
  );
}
