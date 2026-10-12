/**
 * save_draft (SPEC §6.5). Registered unless MAIL_READ_ONLY; available when sending is disabled.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { renderJson } from '../render.js';
import {
  WRITE_NON_IDEMPOTENT_HINTS,
  CLOUD_ATTACHMENTS_NOTE,
  addressListField,
  forRuntime,
  isCloud,
  annotations,
  attachmentsField,
  auditRecipients,
  bodyField,
  fromField,
  htmlField,
  mailboxField,
  runTool,
  textResult,
  uidField,
  type ToolRuntime,
} from './common.js';

export const DRAFT_TOOL_NAMES = ['save_draft'] as const;

export function registerDraftTools(server: McpServer, rt: ToolRuntime): void {
  const { service } = rt;
  const title = 'Save Draft';
  server.registerTool(
    'save_draft',
    {
      title,
      description: [
        "Save an email as a draft in the iCloud Drafts folder WITHOUT sending it. It appears in Apple Mail's Drafts, where the user can review, edit and send it. Prefer this over the send tools whenever the user has not explicitly asked to send.",
        'For a reply draft pass reply_to {mailbox, uid, reply_all}: recipients, "Re:" subject, quoted original and threading headers are filled in (to/cc add extra recipients).',
        'For a forward draft pass forward_of {mailbox, uid, include_attachments}: "Fwd:" subject, the forwarded message and by default its attachments are included; give the recipients in to.',
        'To revise a draft saved earlier, pass its uid in Drafts as replace_draft_uid: from, to, cc, bcc, subject, threading headers and attachments you leave out are kept from the old draft (pass a field, even an empty list, to change it; keep_attachments=false drops the old attachments); body replaces the old body entirely. The new version is saved first; the old one is then deleted if Claude saved it in this session, otherwise moved to Trash (recoverable).',
        isCloud(rt)
          ? `body is plain text; html is optional. ${CLOUD_ATTACHMENTS_NOTE.replace('forward an existing email with its attachments (forward_message)', 'save a forward draft with forward_of')}`
          : 'body is plain text; html is optional. Attachments are local files inside the allowed attachment folders (see the attachments parameter); note that Claude can read files it attaches, even when sending is switched off.',
        'Returns the draft\'s mailbox, uid, Message-ID and what was saved (from, to, cc, bcc, subject, attachment names), so it can be shown to the user. To send a saved draft later, use send_draft (when sending is enabled).',
      ].join(' '),
      inputSchema: forRuntime(rt, z.strictObject({
        to: addressListField('To recipients (optional for a draft)').optional(),
        cc: addressListField('Cc recipients').optional(),
        bcc: addressListField('Bcc recipients (kept in the draft; not visible to other recipients once sent)').optional(),
        subject: z.string().max(2000).describe('Subject line. For reply/forward drafts it defaults to "Re: …" / "Fwd: …" of the original.').optional(),
        body: bodyField('Plain-text body of the draft (for reply/forward drafts: your text; the original is quoted below it). With replace_draft_uid it replaces the old body entirely.'),
        html: htmlField().optional(),
        attachments: attachmentsField().optional(),
        from: fromField().optional(),
        reply_to: z
          .strictObject({
            mailbox: mailboxField('Mailbox of the message being replied to'),
            uid: uidField(),
            reply_all: z.boolean().default(false).describe('Also address the original To and Cc recipients (default false).'),
          })
          .describe('Make this a reply draft to the given message. Not combinable with forward_of.')
          .optional(),
        forward_of: z
          .strictObject({
            mailbox: mailboxField('Mailbox of the message being forwarded'),
            uid: uidField(),
            include_attachments: z.boolean().default(true).describe("Include the original's attachments (default true)."),
          })
          .describe('Make this a forward draft of the given message. Not combinable with reply_to.')
          .optional(),
        replace_draft_uid: z
          .number()
          .int()
          .min(1)
          .max(4_294_967_295)
          .describe('UID (in Drafts) of an earlier draft to replace with this version; fields you leave out are kept from it. Only a message marked as a draft is replaced.')
          .optional(),
        keep_attachments: z
          .boolean()
          .describe("With replace_draft_uid and no attachments given: keep the old draft's attachments (default true).")
          .optional(),
      })),
      annotations: annotations(title, WRITE_NON_IDEMPOTENT_HINTS),
    },
    (args, ctx) =>
      runTool(
        rt,
        'save_draft',
        ctx,
        async (signal) => {
          const result = await service.saveDraft(
            {
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
              html: args.html,
              attachments: args.attachments,
              from: args.from,
              replyTo: args.reply_to ? { mailbox: args.reply_to.mailbox, uid: args.reply_to.uid, replyAll: args.reply_to.reply_all } : undefined,
              forwardOf: args.forward_of ? { mailbox: args.forward_of.mailbox, uid: args.forward_of.uid, includeAttachments: args.forward_of.include_attachments } : undefined,
              replaceDraftUid: args.replace_draft_uid,
              keepAttachments: args.keep_attachments,
            },
            { signal },
          );
          return textResult(renderJson(result));
        },
        {
          audit: () => ({
            recipients: auditRecipients(args.to, args.cc, args.bcc),
            subject: args.subject,
            from: args.from,
            attachments: args.attachments?.length ?? 0,
            reply_to: args.reply_to ? { mailbox: args.reply_to.mailbox, uid: args.reply_to.uid } : undefined,
            forward_of: args.forward_of ? { mailbox: args.forward_of.mailbox, uid: args.forward_of.uid } : undefined,
            replace_draft_uid: args.replace_draft_uid,
          }),
        },
      ),
  );
}
