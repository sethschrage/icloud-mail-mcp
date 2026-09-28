/**
 * End-to-end sending over stdio against the test-infra SMTP sink (127.0.0.1:1587, STARTTLS with the
 * test CA): envelope vs headers, the Sent copy, replies, forwards, recipient failures, the foreign
 * From refusal, attachments, the rate limit, the fail-closed confirmation dialog, send-disabled
 * mode and the audit log.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eEnv } from '../helpers/e2e.js';
import {
  PASSWORD,
  cleanupDirs,
  findSidecarByMessageId,
  listSidecars,
  makeTestDirs,
  rawFlags,
  rawSource,
  rawUidsByMessageId,
  readEml,
  resetMailServer,
  type TestDirs,
} from '../helpers/infra.js';
import { auditEntries, json, startMcp, type McpSession, type ToolCall } from '../helpers/mcp.js';

interface Sent {
  sent: true;
  message_id: string;
  from: string;
  accepted: string[];
  rejected: Array<{ address: string; reason: string }>;
  partial: boolean;
  sent_copy_saved: boolean;
  sent_copy_uid?: number;
  sent_copy_mailbox?: string;
  original?: { mailbox: string; uid: number };
  original_marked?: boolean;
}

function sent(call: ToolCall): Sent {
  expect(call.isError, call.text).toBe(false);
  const r = json<Sent>(call);
  expect(r.sent).toBe(true);
  return r;
}

let dirs: TestDirs;
let s: McpSession;

beforeAll(async () => {
  await resetMailServer();
  dirs = makeTestDirs();
  s = await startMcp(e2eEnv(dirs, { MAIL_MAX_SENDS_PER_HOUR: '0' }));
});

afterAll(async () => {
  await s?.close();
  if (dirs) cleanupDirs(dirs);
});

describe('send_email', () => {
  it('delivers with Bcc only in the envelope and saves exactly one Sent copy that keeps Bcc', async () => {
    const r = sent(
      await s.call('send_email', {
        to: ['Friend <friend@example.com>'],
        cc: ['other@example.org'],
        bcc: ['hidden@example.net'],
        subject: 'E2E hello ✓',
        body: 'E2E body line one\nline two',
        html: '<p>E2E body line one</p><p>line two</p>',
      }),
    );
    expect(r.accepted.sort()).toEqual(['friend@example.com', 'hidden@example.net', 'other@example.org']);
    expect(r).toMatchObject({ from: 'Test User <testuser@icloud.test>', rejected: [], partial: false, sent_copy_saved: true, sent_copy_mailbox: 'Sent Messages' });

    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar).toBeDefined();
    expect(sidecar?.envelope.mailFrom).toBe('testuser@icloud.test');
    expect(sidecar?.envelope.rcptTo.sort()).toEqual(['friend@example.com', 'hidden@example.net', 'other@example.org']);
    expect(sidecar?.headers?.bcc).toEqual([]);
    expect(sidecar?.headers?.to).toEqual(['friend@example.com']);
    expect(sidecar?.tls.starttls).toBe(true);
    const eml = readEml(sidecar!);
    expect(eml).not.toMatch(/^Bcc:/im);
    const parsed = await simpleParser(eml);
    expect(parsed.text?.trim()).toBe('E2E body line one\nline two');
    expect(parsed.html).toContain('<p>E2E body line one</p>');

    const copies = await rawUidsByMessageId('Sent Messages', r.message_id);
    expect(copies).toEqual([r.sent_copy_uid]);
    const copy = (await rawSource('Sent Messages', copies[0] ?? 0))?.toString('utf8') ?? '';
    expect(copy).toMatch(/^Bcc: hidden@example\.net\r$/m);
    expect(await rawFlags('Sent Messages', copies[0] ?? 0)).toContain('\\Seen');
  });

  it('sends from an allowed alias with a Reply-To and an allowed attachment', async () => {
    const file = path.join(dirs.attachFrom, 'report.csv');
    writeFileSync(file, 'a,b\n1,2\n');
    const r = sent(
      await s.call('send_email', {
        to: ['friend@example.com'],
        subject: 'Alias with attachment',
        body: 'see attached',
        from: 'testuser.alias@icloud.test',
        reply_to_address: 'Replies <replies@icloud.test>',
        attachments: [file],
      }),
    );
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.envelope.mailFrom).toBe('testuser.alias@icloud.test');
    expect(sidecar?.headers?.attachments).toEqual([expect.objectContaining({ filename: 'report.csv' })]);
    expect(readEml(sidecar!)).toMatch(/^Reply-To: Replies <replies@icloud\.test>\r$/m);
  });

  it('refuses a foreign From, header injection and files outside the allowed folders before SMTP', async () => {
    const before = listSidecars().length;
    const foreign = await s.call('send_email', { to: ['friend@example.com'], subject: 'x', body: 'x', from: 'ceo@evil.test' });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toMatch(/Allowed From addresses: testuser@icloud\.test/);
    const injection = await s.call('send_email', { to: ['victim@example.com\r\nBcc: evil@example.com'], subject: 'x', body: 'x' });
    expect(injection.isError).toBe(true);
    expect(injection.text).toMatch(/line break/);
    const file = await s.call('send_email', { to: ['friend@example.com'], subject: 'x', body: 'x', attachments: ['/etc/passwd'] });
    expect(file.isError).toBe(true);
    expect(file.text).toMatch(/MAIL_ATTACH_FROM_DIRS/);
    const noTo = await s.call('send_email', { to: [], subject: 'x', body: 'x' });
    expect(noTo.isError).toBe(true);
    expect(listSidecars().length).toBe(before);
  });
});

describe('recipient failures', () => {
  it('fails when every recipient is rejected (550) and reports a temporary failure (451)', async () => {
    const before = listSidecars().length;
    const rejected = await s.call('send_email', { to: ['nobody@reject.test'], subject: 'x', body: 'x' });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/All recipients were rejected.*nobody@reject\.test.*550/);
    const temp = await s.call('send_email', { to: ['later@tempfail.test'], subject: 'x', body: 'x' });
    expect(temp.isError).toBe(true);
    expect(temp.text).toMatch(/451.*temporary/i);
    expect(listSidecars().length).toBe(before);
  });

  it('reports a partial send', async () => {
    const r = sent(await s.call('send_email', { to: ['friend@example.com', 'nobody@reject.test'], cc: ['later@tempfail.test'], subject: 'Partial', body: 'x' }));
    expect(r.partial).toBe(true);
    expect(r.accepted).toEqual(['friend@example.com']);
    expect(r.rejected.map((x) => x.address).sort()).toEqual(['later@tempfail.test', 'nobody@reject.test']);
    expect(findSidecarByMessageId(r.message_id)?.envelope.rcptTo).toEqual(['friend@example.com']);
  });
});

describe('reply_to_message', () => {
  it('replies with In-Reply-To/References, quotes the original and sets \\Answered', async () => {
    expect(await rawFlags('INBOX', 23)).not.toContain('\\Answered');
    const r = sent(await s.call('reply_to_message', { mailbox: 'INBOX', uid: 23, body: 'Thanks Dave, E2E reply' }));
    expect(r).toMatchObject({ original: { mailbox: 'INBOX', uid: 23 }, original_marked: true });
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.headers?.to).toEqual(['dave@example.com']);
    expect(sidecar?.headers?.subject).toBe('Re: Project kickoff');
    expect(sidecar?.headers?.inReplyTo).toBe('<kickoff-3@example.com>');
    expect(sidecar?.headers?.references).toEqual(['<kickoff-1@example.com>', '<kickoff-2@icloud.test>', '<kickoff-3@example.com>']);
    const parsed = await simpleParser(readEml(sidecar!));
    expect(parsed.text).toMatch(/^Thanks Dave, E2E reply\n\nOn .+, Dave Wilson <dave@example\.com> wrote:\n> /);
    expect(await rawFlags('INBOX', 23)).toContain('\\Answered');
    expect(await rawUidsByMessageId('Sent Messages', r.message_id)).toHaveLength(1);
  });

  it('reply_all includes the original To and Cc minus our own address', async () => {
    const r = sent(await s.call('reply_to_message', { mailbox: 'INBOX', uid: 15, body: 'Count me in.', reply_all: true }));
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.headers?.to).toEqual(['offsite@example.com', 'alice@example.com', 'bob@example.org', 'carol@example.net']);
    expect(sidecar?.headers?.cc).toEqual(['erin@example.com', 'hr@example.com']);
    expect(sidecar?.envelope.rcptTo).not.toContain('testuser@icloud.test');
  });

  it('reports a missing original', async () => {
    const r = await s.call('reply_to_message', { mailbox: 'INBOX', uid: 4242, body: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No message with UID 4242/);
  });
});

describe('forward_message', () => {
  it('forwards with the original attachments, a note, "Fwd:" and $Forwarded', async () => {
    expect(await rawFlags('INBOX', 6)).not.toContain('$Forwarded');
    const r = sent(await s.call('forward_message', { mailbox: 'INBOX', uid: 6, to: ['accounting@example.com'], body: 'Please pay this one.' }));
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.headers?.subject).toBe('Fwd: Invoice #10423 for March');
    expect(sidecar?.headers?.attachments).toEqual([expect.objectContaining({ filename: 'Invoice-10423.pdf', contentType: 'application/pdf' })]);
    const parsed = await simpleParser(readEml(sidecar!));
    expect(parsed.text).toMatch(/^Please pay this one\.\n/);
    expect(parsed.text).toContain('---------- Forwarded message ----------');
    expect(await rawFlags('INBOX', 6)).toContain('$Forwarded');
  });

  it('refuses invalid recipients and a missing original', async () => {
    const before = listSidecars().length;
    const bad = await s.call('forward_message', { mailbox: 'INBOX', uid: 6, to: ['not-an-address'] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not-an-address/);
    const missing = await s.call('forward_message', { mailbox: 'INBOX', uid: 4242, to: ['friend@example.com'] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No message with UID 4242/);
    expect(listSidecars().length).toBe(before);
  });

  it('can leave the attachments out', async () => {
    const r = sent(await s.call('forward_message', { mailbox: 'INBOX', uid: 6, to: ['accounting@example.com'], include_attachments: false }));
    expect(findSidecarByMessageId(r.message_id)?.headers?.attachments).toEqual([]);
  });
});

describe('audit log', () => {
  it('records sends and refused sends without bodies', () => {
    const entries = auditEntries(dirs.auditLog);
    const ok = entries.filter((e) => e['result'] === 'ok' || e['result'] === 'partial');
    for (const t of ['send_email', 'reply_to_message', 'forward_message']) expect(ok.some((e) => e['tool'] === t), t).toBe(true);
    const first = ok.find((e) => e['subject'] === 'E2E hello ✓');
    expect(first).toMatchObject({ tool: 'send_email', from: 'testuser@icloud.test', result: 'ok' });
    expect(first?.['recipients']).toEqual(expect.arrayContaining(['friend@example.com', 'other@example.org', 'hidden@example.net']));
    expect(typeof first?.['message_id']).toBe('string');
    // Refused before SMTP (tool-layer audit) and rejected by SMTP (domain audit), each once.
    expect(entries.filter((e) => e['tool'] === 'send_email' && e['error_code'] === 'FORBIDDEN' && e['from'] === 'ceo@evil.test')).toHaveLength(1);
    expect(entries.filter((e) => e['tool'] === 'send_email' && e['error_code'] === 'SMTP' && /nobody@reject\.test/.test(String(e['error'])))).toHaveLength(1);
    const raw = readFileSync(dirs.auditLog, 'utf8');
    for (const body of ['E2E body line one', 'Thanks Dave, E2E reply', 'Please pay this one', 'Count me in', 'see attached']) expect(raw).not.toContain(body);
    expect(raw).not.toContain(PASSWORD);
  });
});

describe('rate limit (MAIL_MAX_SENDS_PER_HOUR=1)', () => {
  it('allows one send per hour across the send tools, then refuses with guidance', async () => {
    const limited = await startMcp(e2eEnv(dirs, { MAIL_MAX_SENDS_PER_HOUR: '1' }));
    try {
      const before = listSidecars().length;
      sent(await limited.call('send_email', { to: ['friend@example.com'], subject: 'rate 1', body: 'x' }));
      const second = await limited.call('send_email', { to: ['friend@example.com'], subject: 'rate 2', body: 'x' });
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(/Send limit reached: at most 1 emails per hour \("Maximum emails sent per hour" \(MAIL_MAX_SENDS_PER_HOUR\)/);
      expect(second.text).toMatch(/save a draft instead/);
      const reply = await limited.call('reply_to_message', { mailbox: 'INBOX', uid: 29, body: 'x' });
      expect(reply.isError).toBe(true);
      expect(reply.text).toMatch(/Send limit reached/);
      expect(listSidecars().length).toBe(before + 1);
      const info = json(await limited.call('get_account_info'));
      expect((info['features'] as { rate_limit: unknown }).rate_limit).toEqual({ max_sends_per_hour: 1, remaining_this_hour: 0 });
      // Drafts are not rate limited.
      expect((await limited.call('save_draft', { body: 'still possible' })).isError).toBe(false);
    } finally {
      await limited.close();
    }
    expect(auditEntries(dirs.auditLog).filter((e) => e['error_code'] === 'RATE_LIMIT').map((e) => e['tool'])).toEqual(['send_email', 'reply_to_message']);
  });
});

describe('confirmation dialog (MAIL_CONFIRM_DIALOG=true) fails closed off macOS', () => {
  it('refuses to send or permanently delete when the dialog cannot be shown', async () => {
    const confirm = await startMcp(e2eEnv(dirs, { MAIL_CONFIRM_DIALOG: 'true', MAIL_ALLOW_PERMANENT_DELETE: 'true', MAIL_MAX_SENDS_PER_HOUR: '0' }));
    try {
      const before = listSidecars().length;
      const send = await confirm.call('send_email', { to: ['friend@example.com'], subject: 'needs a click', body: 'x' });
      expect(send.isError).toBe(true);
      expect(send.text).toMatch(/Not sent: the confirmation dialog could not be shown/);
      expect(send.text).toMatch(/MAIL_CONFIRM_DIALOG=false/);
      const reply = await confirm.call('reply_to_message', { mailbox: 'INBOX', uid: 29, body: 'x' });
      expect(reply.isError).toBe(true);
      expect(reply.text).toMatch(/confirmation dialog could not be shown/);
      expect(listSidecars().length).toBe(before);
      expect(await rawFlags('INBOX', 29)).not.toContain('\\Answered');

      const del = await confirm.call('delete_messages_permanently', { mailbox: 'Deleted Messages', uids: [1] });
      expect(del.isError).toBe(true);
      expect(del.text).toMatch(/Nothing was deleted: the confirmation dialog could not be shown/);
      expect(await rawFlags('Deleted Messages', 1)).not.toBeNull();
    } finally {
      await confirm.close();
    }
    const unavailable = auditEntries(dirs.auditLog).filter((e) => e['error_code'] === 'CONFIRM_UNAVAILABLE');
    expect(unavailable.map((e) => e['tool']).sort()).toEqual(['delete_messages_permanently', 'reply_to_message', 'send_email']);
  });
});

describe('send disabled (MAIL_ALLOW_SEND=false)', () => {
  it('has no send tools but still saves drafts', async () => {
    const off = await startMcp(e2eEnv(dirs, { MAIL_ALLOW_SEND: 'false' }));
    try {
      await expect(off.client.callTool({ name: 'send_email', arguments: { to: ['friend@example.com'], subject: 's', body: 'b' } })).rejects.toThrow(/not found/i);
      const draft = await off.call('save_draft', { to: ['friend@example.com'], subject: 'draft only', body: 'b' });
      expect(draft.isError).toBe(false);
      expect(json(draft)).toMatchObject({ saved: true, mailbox: 'Drafts' });
      const info = json(await off.call('get_account_info'));
      expect(info['features']).toMatchObject({ send: false, drafts: true });
    } finally {
      await off.close();
    }
  });
});
