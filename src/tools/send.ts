/**
 * Sending (SPEC §6.6): send_email, reply_to_message, forward_message. Registered only when
 * MAIL_ALLOW_SEND is on and MAIL_READ_ONLY is off. Every tool is destructive + open-world and
 * carries `anthropic/requiresUserInteraction`, so the host prompts on every call.
 *
 * A send the user cancelled in the native confirmation dialog is reported as a normal result
 * (`sent: false`), not as an error.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { renderJson } from '../render.js';
import {
  REQUIRES_USER_INTERACTION_META,
  SEND_HINTS,
  addressListField,
  annotations,
  attachmentsField,
  auditRecipients,
  bodyField,
  confirmAwareTimeoutMs,
  fromField,
  htmlField,
  mailboxField,
  runTool,
  textResult,
  uidField,
  type ToolRuntime,
} from './common.js';

export const SEND_TOOL_NAMES = ['send_email', 'reply_to_message', 'forward_message'] as const;

/** The mandatory warning at the start of every send tool description (SPEC §6.6). */
function sendWarning(what: string, askedTo: string, draftAlternative: string): string {
  return (
    `SENDS A REAL ${what} IMMEDIATELY from the user's iCloud account; it cannot be recalled. ` +
    `Only call this when the user has explicitly asked to ${askedTo} (not merely to write or draft it), and confirm the recipients and content with the user first unless they gave them exactly. ` +
    `If unsure, use ${draftAlternative} instead.`
  );
}

const SEND_FOOTER =
  'A copy is saved to the Sent mailbox. Sending is limited per hour (MAIL_MAX_SENDS_PER_HOUR) and may require a click in a confirmation dialog on the Mac (MAIL_CONFIRM_DIALOG); if the user cancels there, the result says it was not sent.';

export function registerSendTools(server: McpServer, rt: ToolRuntime): void {
  const { service } = rt;

  const sendTitle = 'Send Email';
  server.registerTool(
    'send_email',
    {
      title: sendTitle,
      description: [
        sendWarning('EMAIL', 'send an email', 'save_draft'),
        'Composes and sends a new email. to/cc/bcc take "user@example.com" or "Name <user@example.com>" (Bcc recipients are hidden from the others). body is plain text; html is optional.',
        'Attachments are local files inside the allowed folders (MAIL_ATTACH_FROM_DIRS, default Desktop, Documents and Downloads), at most 14 MB in total. from must be one of the account\'s allowed addresses (see get_account_info).',
        SEND_FOOTER,
        'Returns the Message-ID, accepted and rejected recipients, and whether the Sent copy was saved.',
      ].join(' '),
      inputSchema: z.strictObject({
        to: addressListField('To recipients (at least one)').min(1),
        cc: addressListField('Cc recipients').optional(),
        bcc: addressListField('Bcc recipients (hidden from the other recipients)').optional(),
        subject: z.string().max(2000).describe('Subject line.'),
        body: bodyField('Plain-text body of the email.'),
        html: htmlField().optional(),
        attachments: attachmentsField().optional(),
        from: fromField().optional(),
        reply_to_address: z
          .string()
          .min(1)
          .max(998)
          .describe('Optional Reply-To address ("user@example.com" or "Name <user@example.com>") where replies should go instead of the From address.')
          .optional(),
      }),
      annotations: annotations(sendTitle, SEND_HINTS),
      _meta: { ...REQUIRES_USER_INTERACTION_META },
    },
    (args, ctx) =>
      runTool(
        rt,
        'send_email',
        ctx,
        async (signal) => {
          const result = await service.sendEmail(
            {
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              subject: args.subject,
              body: args.body,
              html: args.html,
              attachments: args.attachments,
              from: args.from,
              replyToAddress: args.reply_to_address,
            },
            { signal },
          );
          return textResult(renderJson(result));
        },
        {
          timeoutMs: confirmAwareTimeoutMs(rt),
          audit: () => ({ recipients: auditRecipients(args.to, args.cc, args.bcc), subject: args.subject, from: args.from, attachments: args.attachments?.length ?? 0 }),
        },
      ),
  );

  const replyTitle = 'Reply to Message';
  server.registerTool(
    'reply_to_message',
    {
      title: replyTitle,
      description: [
        sendWarning('REPLY', 'send a reply', 'save_draft with reply_to'),
        'Replies to the email identified by mailbox + uid. Recipients are filled in automatically: the original Reply-To or sender, and with reply_all also the original To and Cc, minus the user\'s own addresses; cc/bcc add more.',
        'The subject gets "Re:", threading headers (In-Reply-To, References) are set, and the original text is quoted below body. The original is marked as answered.',
        SEND_FOOTER,
      ].join(' '),
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox of the message to reply to'),
        uid: uidField(),
        body: bodyField('Plain-text reply. The original message is quoted below it automatically.'),
        reply_all: z.boolean().default(false).describe('Also reply to the original To and Cc recipients (default false: only the sender or Reply-To).'),
        cc: addressListField('Additional Cc recipients').optional(),
        bcc: addressListField('Bcc recipients (hidden from the other recipients)').optional(),
        html: htmlField().optional(),
        attachments: attachmentsField().optional(),
        from: fromField().optional(),
      }),
      annotations: annotations(replyTitle, SEND_HINTS),
      _meta: { ...REQUIRES_USER_INTERACTION_META },
    },
    (args, ctx) =>
      runTool(
        rt,
        'reply_to_message',
        ctx,
        async (signal) => {
          const result = await service.replyToMessage(
            {
              mailbox: args.mailbox,
              uid: args.uid,
              body: args.body,
              replyAll: args.reply_all,
              cc: args.cc,
              bcc: args.bcc,
              html: args.html,
              attachments: args.attachments,
              from: args.from,
            },
            { signal },
          );
          return textResult(renderJson(result));
        },
        {
          timeoutMs: confirmAwareTimeoutMs(rt),
          audit: () => ({
            reply_to: { mailbox: args.mailbox, uid: args.uid },
            reply_all: args.reply_all,
            recipients: auditRecipients(args.cc, args.bcc),
            from: args.from,
            attachments: args.attachments?.length ?? 0,
          }),
        },
      ),
  );

  const forwardTitle = 'Forward Message';
  server.registerTool(
    'forward_message',
    {
      title: forwardTitle,
      description: [
        sendWarning('FORWARD', 'forward the message', 'save_draft with forward_of'),
        'Forwards the email identified by mailbox + uid to new recipients. body is an optional note placed above the forwarded message (which includes its From, Date, Subject, To and Cc).',
        'The original\'s attachments are included by default (include_attachments=false leaves them out; at most 14 MB). The subject gets "Fwd:" and the original is marked as forwarded.',
        SEND_FOOTER,
      ].join(' '),
      inputSchema: z.strictObject({
        mailbox: mailboxField('Mailbox of the message to forward'),
        uid: uidField(),
        to: addressListField('Recipients to forward to (at least one)').min(1),
        cc: addressListField('Cc recipients').optional(),
        bcc: addressListField('Bcc recipients (hidden from the other recipients)').optional(),
        body: bodyField('Optional plain-text note placed above the forwarded message (default empty).').default(''),
        include_attachments: z.boolean().default(true).describe("Include the original message's attachments (default true)."),
        from: fromField().optional(),
      }),
      annotations: annotations(forwardTitle, SEND_HINTS),
      _meta: { ...REQUIRES_USER_INTERACTION_META },
    },
    (args, ctx) =>
      runTool(
        rt,
        'forward_message',
        ctx,
        async (signal) => {
          const result = await service.forwardMessage(
            {
              mailbox: args.mailbox,
              uid: args.uid,
              to: args.to,
              cc: args.cc,
              bcc: args.bcc,
              body: args.body,
              includeAttachments: args.include_attachments,
              from: args.from,
            },
            { signal },
          );
          return textResult(renderJson(result));
        },
        {
          timeoutMs: confirmAwareTimeoutMs(rt),
          audit: () => ({
            forward_of: { mailbox: args.mailbox, uid: args.uid },
            recipients: auditRecipients(args.to, args.cc, args.bcc),
            from: args.from,
            include_attachments: args.include_attachments,
          }),
        },
      ),
  );
}
