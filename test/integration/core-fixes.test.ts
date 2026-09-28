/**
 * Regression tests for the adversarial-review findings, against the local test-infra servers (main
 * instance and the iCloud-fidelity profiles). Each block names the finding it covers. Work happens in
 * scratch mailboxes that are removed afterwards (the main instance is reset first).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { MailService, ReplyResult } from '../../src/service.js';
import type { SendResult } from '../../src/smtp/send.js';
import {
  PROFILES,
  SMTP_OUT,
  cleanupDirs,
  createTestService,
  findSidecarByMessageId,
  makeTestDirs,
  portOpen,
  rawFlags,
  rawSetDeleted,
  rawStatus,
  rawUidsByMessageId,
  readEml,
  resetMailServer,
  resetProfile,
  skipProfile,
  withRawImap,
  type TestDirs,
} from '../helpers/infra.js';

const SCRATCH = 'Scratch-fixes';

function eml(o: { subject: string; date?: string; messageId?: string; headers?: string[]; body?: string; contentType?: string }): string {
  return [
    'From: Friend <friend@example.com>',
    'To: Test User <testuser@icloud.test>',
    `Subject: ${o.subject}`,
    `Date: ${o.date ?? 'Mon, 28 Sep 2026 10:00:00 +0000'}`,
    `Message-ID: ${o.messageId ?? `<${Math.random().toString(36).slice(2)}@example.com>`}`,
    ...(o.headers ?? []),
    'MIME-Version: 1.0',
    `Content-Type: ${o.contentType ?? 'text/plain; charset=utf-8'}`,
    '',
    o.body ?? 'hello',
    '',
  ].join('\r\n');
}

async function append(mailbox: string, raw: string | Buffer, flags: string[] = [], date?: Date, port = 1993): Promise<number> {
  return withRawImap(async (c) => {
    const r = await c.append(mailbox, raw, flags, date);
    if (!r || typeof r.uid !== 'number') throw new Error('append failed');
    return r.uid;
  }, port);
}

async function ensureMailbox(p: string, port = 1993): Promise<void> {
  await withRawImap(async (c) => {
    await c.mailboxCreate(p).catch(() => undefined);
  }, port);
}

async function dropMailbox(p: string, port = 1993): Promise<void> {
  await withRawImap(async (c) => {
    await c.mailboxDelete(p).catch(() => undefined);
  }, port);
}

async function failure(p: Promise<unknown>): Promise<MailError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MailError);
  return e as MailError;
}

function asSent(r: ReplyResult | SendResult | { sent: false }): SendResult {
  expect(r.sent).toBe(true);
  return r as SendResult;
}

let dirs: TestDirs;
let svc: MailService;

beforeAll(async () => {
  await resetMailServer();
  dirs = makeTestDirs();
  svc = createTestService(dirs);
});
afterAll(async () => {
  await svc?.close();
  for (const p of [SCRATCH, `${SCRATCH}-renamed`, 'Réçus-fix', 'Scratch-thread']) await dropMailbox(p);
  if (dirs) cleanupDirs(dirs);
});

// docs-5 / imap-3 / imap-10 / dos-2
describe('ordering by arrival date', () => {
  beforeAll(async () => {
    await ensureMailbox(SCRATCH);
    // UID order is the opposite of arrival-date order (as after archiving old mail last).
    for (const h of [12, 11, 10, 9, 8]) {
      await append(SCRATCH, eml({ subject: `allmb-${h}h order-fix`, date: `Mon, 28 Sep 2026 ${String(h).padStart(2, '0')}:00:00 +0000` }), [], new Date(Date.UTC(2026, 8, 28, h)));
    }
    // A newer message that arrived later in UID terms but with an old date, to mix the orders.
    await append(SCRATCH, eml({ subject: 'allmb-old order-fix' }), [], new Date(Date.UTC(2020, 0, 1)));
    svc.mailboxes.invalidate();
  });

  it('a single mailbox pages newest first by arrival date, not by UID', async () => {
    const r = await svc.search({ mailbox: SCRATCH, subject: 'order-fix', limit: 2 });
    expect(r.messages.map((m) => m.subject)).toEqual(['allmb-12h order-fix', 'allmb-11h order-fix']);
    expect(r.total).toBe(6);
    const listing = await svc.search({ mailbox: SCRATCH, limit: 2 });
    expect(listing.messages.map((m) => m.subject)).toEqual(['allmb-12h order-fix', 'allmb-11h order-fix']);
  });

  it('all_mailboxes pages without duplicates and starts with the newest', async () => {
    const seen: string[] = [];
    let first: string[] = [];
    for (const offset of [0, 2, 4]) {
      const r = await svc.search({ allMailboxes: true, subject: 'order-fix', limit: 2, offset });
      if (offset === 0) first = r.messages.map((m) => m.subject);
      seen.push(...r.messages.map((m) => `${m.mailbox}#${m.uid}`));
    }
    expect(first).toEqual(['allmb-12h order-fix', 'allmb-11h order-fix']);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(6);
  });

  it('refuses deep all_mailboxes paging', async () => {
    expect((await failure(svc.search({ allMailboxes: true, offset: 1000, limit: 20 }))).code).toBe('INVALID_INPUT');
  });
});

// tests-4
describe('listing without criteria and \\Deleted messages', () => {
  it('never counts or shows a pending \\Deleted message', async () => {
    const box = `${SCRATCH}-del`;
    await ensureMailbox(box);
    try {
      for (const n of [1, 2, 3]) await append(box, eml({ subject: `del-${n}` }));
      await rawSetDeleted(box, 3, true);
      svc.mailboxes.invalidate();
      const withCriteria = await svc.search({ mailbox: box, subject: 'del-', limit: 20 });
      const fast = await svc.search({ mailbox: box, limit: 20 });
      expect(fast.total).toBe(withCriteria.total);
      expect(fast.total).toBe(2);
      expect(fast.has_more).toBe(false);
      const one = await svc.search({ mailbox: box, limit: 1 });
      expect(one.returned).toBe(1);
      const pages = [0, 1].map((offset) => svc.search({ mailbox: box, limit: 1, offset }));
      const uids = (await Promise.all(pages)).flatMap((p) => p.messages.map((m) => m.uid));
      expect(new Set(uids).size).toBe(2);
    } finally {
      await dropMailbox(box);
    }
  });
});

// tests-2
describe('rename_mailbox never expunges', () => {
  it('keeps another client\'s \\Deleted message after a read-write operation in the folder', async () => {
    const src = `${SCRATCH}-ren`;
    const dst = `${SCRATCH}-renamed`;
    await ensureMailbox(src);
    const keep = await append(src, eml({ subject: 'ren-keep' }));
    const pending = await append(src, eml({ subject: 'ren-pending' }));
    await rawSetDeleted(src, pending, true);
    svc.mailboxes.invalidate();
    expect((await rawStatus(src)).messages).toBe(2);
    await svc.markMessages({ mailbox: src, uids: [keep], read: true });
    await svc.renameMailbox({ path: src, newPath: dst });
    expect((await rawStatus(dst)).messages).toBe(2);
    await dropMailbox(dst);
  });

  it('delete_mailbox never purges messages that arrived since the emptiness check', async () => {
    const box = `${SCRATCH}-empty`;
    await ensureMailbox(box);
    svc.mailboxes.invalidate();
    await svc.search({ mailbox: box, limit: 1 });
    const r = await svc.deleteMailbox({ path: box });
    expect(r.deleted).toBe(true);
  });
});

// attach-2 / tests-3 / fwd-1 / 8bit-1
describe('charsets of attachments', () => {
  const latin1 = Buffer.from('Grüße aus München', 'latin1');
  const boundary = 'b1';
  function mixed(parts: string[]): Buffer {
    const head = [
      'From: Friend <friend@example.com>',
      'To: Test User <testuser@icloud.test>',
      'Subject: charset-fix',
      'Date: Mon, 28 Sep 2026 10:00:00 +0000',
      `Message-ID: <charset-${Math.random().toString(36).slice(2)}@example.com>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See the attachments.',
    ].join('\r\n');
    return Buffer.concat([Buffer.from(`${head}\r\n`), ...parts.map((p) => Buffer.from(`--${boundary}\r\n${p}\r\n`, 'latin1')), Buffer.from(`--${boundary}--\r\n`)]);
  }
  const b64 = latin1.toString('base64');
  let uid: number;

  beforeAll(async () => {
    await ensureMailbox(SCRATCH);
    uid = await append(
      SCRATCH,
      mixed([
        `Content-Type: text/plain; charset=iso-8859-1; name=gruss.txt\r\nContent-Disposition: inline; filename=gruss.txt\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`,
        `Content-Type: text/plain; charset=iso-8859-1; name=plain.txt\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`,
        `Content-Type: text/csv; charset=iso-8859-1; name=adressen.csv\r\nContent-Disposition: attachment; filename=adressen.csv\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('Müller;München', 'latin1').toString('base64')}`,
        `Content-Type: text/calendar; charset=utf-8; method=REQUEST; name=invite.ics\r\nContent-Disposition: attachment; filename=invite.ics\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR`,
        `Content-Type: message/rfc822\r\nContent-Disposition: attachment\r\nContent-Transfer-Encoding: 8bit\r\n\r\nFrom: a@example.com\r\nSubject: inner\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${Buffer.from('Grüße', 'utf8').toString('latin1')}`,
      ]),
    );
    svc.mailboxes.invalidate();
  });

  it('download_attachment decodes inline and attachment text parts once', async () => {
    for (const part of ['2', '3', '4']) {
      const a = await svc.downloadAttachment({ mailbox: SCRATCH, uid, part });
      expect(a.content, part).toMatchObject({ kind: 'text' });
      const text = a.content?.kind === 'text' ? a.content.text : '';
      expect(text, part).toMatch(/Grüße aus München|Müller;München/);
      expect(text, part).not.toContain('Ã');
    }
  });

  it('forwarding keeps charset, method and attachment disposition, and declares 8BITMIME', async () => {
    const r = asSent(await svc.forwardMessage({ mailbox: SCRATCH, uid, to: ['friend@example.com'], body: 'fwd' }));
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar).toBeDefined();
    const text = readEml(sidecar as NonNullable<typeof sidecar>);
    expect(text).toMatch(/Content-Type: text\/csv; charset=iso-8859-1; name=adressen\.csv/);
    expect(text).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REQUEST/);
    expect(text).toMatch(/Content-Type: message\/rfc822[^]*?Content-Disposition: attachment/);
    const json = JSON.parse(readFileSync(path.join(SMTP_OUT, (sidecar as NonNullable<typeof sidecar>).file.replace(/\.eml$/, '.json')), 'utf8')) as { envelope: { bodyType?: string } };
    expect(json.envelope.bodyType).toBe('8bitmime');
  });
});

// drafts-1 / files-2 / imap-12
describe('drafts', () => {
  it('replacing a draft the user wrote moves it to Trash; a draft Claude saved is deleted', async () => {
    const foreignId = `<user-draft-${Date.now()}@icloud.test>`;
    const userDraft = await append('Drafts', eml({ subject: 'my long letter', messageId: foreignId }), ['\\Draft', '\\Seen']);
    svc.mailboxes.invalidate();
    const r = await svc.saveDraft({ body: 'v2', to: ['bob@example.org'], subject: 'v2', replaceDraftUid: userDraft });
    expect(r.replaced_uid).toBe(userDraft);
    expect(r.old_draft).toMatch(/moved to Deleted Messages/);
    expect(await rawUidsByMessageId('Drafts', foreignId)).toEqual([]);
    expect(await rawUidsByMessageId('Deleted Messages', foreignId)).toHaveLength(1);

    const v3 = await svc.saveDraft({ body: 'v3', replaceDraftUid: r.uid as number });
    expect(v3.old_draft).toMatch(/^deleted/);
    expect(await rawUidsByMessageId('Deleted Messages', r.message_id)).toEqual([]);
    expect(await rawUidsByMessageId('Drafts', r.message_id)).toEqual([]);
    // A plain revision keeps the fields it leaves out.
    expect(v3.to).toEqual(['bob@example.org']);
    expect(v3.subject).toBe('v2');
  });

  it('with sending off, a draft\'s local attachment is not handed back to Claude', async () => {
    const noSend = createTestService(dirs, { MAIL_ALLOW_SEND: 'false' });
    try {
      writeFileSync(path.join(dirs.attachFrom, 'secrets.txt'), 'AWS_SECRET_ACCESS_KEY=abc123-local-secret\n');
      const d = await noSend.saveDraft({ body: 'x', attachments: [path.join(dirs.attachFrom, 'secrets.txt')] });
      expect(d.uid).not.toBeNull();
      const view = await noSend.getMessage({ mailbox: 'Drafts', uid: d.uid as number });
      const part = view.message.attachments[0]?.part ?? '2';
      const a = await noSend.downloadAttachment({ mailbox: 'Drafts', uid: d.uid as number, part, returnContent: true });
      expect(a.content).toBeUndefined();
      expect(a.note).toMatch(/not shown again/);
    } finally {
      await noSend.close();
    }
  });
});

// docs-4
describe('get_message body limit', () => {
  it('max_chars cannot exceed MAIL_MAX_BODY_CHARS', async () => {
    const small = createTestService(dirs, { MAIL_MAX_BODY_CHARS: '1000' });
    try {
      const view = await small.getMessage({ mailbox: 'INBOX', uid: 27, maxChars: 100_000 });
      expect(view.body.length).toBeLessThanOrEqual(1000);
      expect(view.bodyTruncated).toBe(true);
      expect(view.notes.join(' ')).toMatch(/limited to the configured maximum of 1000/);
    } finally {
      await small.close();
    }
  });
});

// integ-4 / docs-6 / tests-10
describe('local file errors while saving attachments', () => {
  it('are configuration errors naming the folder, not "IMAP error"', async () => {
    const blocker = path.join(dirs.root, 'a-file');
    writeFileSync(blocker, 'x');
    const bad = createTestService(dirs, { MAIL_ATTACHMENT_DIR: path.join(blocker, 'sub') });
    try {
      const e = await failure(bad.downloadAttachment({ mailbox: 'INBOX', uid: 6, part: '2' }));
      expect(e.code).toBe('CONFIG');
      expect(e.message).not.toMatch(/IMAP error/);
      expect(e.message).toContain(path.join(blocker, 'sub'));
      expect(e.message).toMatch(/part of that path is a file/);
    } finally {
      await bad.close();
    }
  });
});

// imap-9: without UTF8=ACCEPT, non-ASCII folder names still round-trip (modified UTF-7).
describe('non-ASCII folder names', () => {
  it('creates, lists, selects and deletes "Réçus-fix"', async () => {
    const created = await svc.createMailbox({ path: 'Réçus-fix' });
    expect(created.path.normalize('NFC')).toBe('Réçus-fix');
    const list = await svc.listMailboxes({ includeCounts: false });
    expect(list.some((m) => m.path.normalize('NFC') === 'Réçus-fix')).toBe(true);
    await append('Réçus-fix', eml({ subject: 'utf7' }));
    expect((await svc.search({ mailbox: 'Réçus-fix', limit: 5 })).total).toBe(1);
    const trashed = await svc.trashMessages({ mailbox: 'Réçus-fix', uids: [1] });
    expect(trashed.moved).toBe(1);
    expect((await svc.deleteMailbox({ path: 'Réçus-fix' })).deleted).toBe(true);
  });
});

// imap-7: get_thread fetches full summaries only for the messages it returns.
describe('get_thread on a huge thread', () => {
  it('fetches BODYSTRUCTURE and snippets for at most `limit` messages', async () => {
    const box = 'Scratch-thread';
    await ensureMailbox(box);
    const root = '<thread-root-fix@example.com>';
    await withRawImap(async (c) => {
      await c.append(box, eml({ subject: 'root', messageId: root }));
      for (let i = 0; i < 300; i++) {
        await c.append(box, eml({ subject: `re ${i}`, messageId: `<thread-${i}-fix@example.com>`, headers: [`In-Reply-To: ${root}`, `References: ${root}`], date: `Mon, 28 Sep 2026 10:${String(i % 60).padStart(2, '0')}:00 +0000` }));
      }
    });
    svc.mailboxes.invalidate();
    const calls: Array<{ range: string; query: Record<string, unknown> }> = [];
    const orig = ImapFlow.prototype.fetchAll;
    ImapFlow.prototype.fetchAll = function (this: ImapFlow, range: unknown, query: unknown, opts?: unknown) {
      calls.push({ range: String(range), query: query as Record<string, unknown> });
      return orig.call(this, range as string, query as never, opts as never);
    } as typeof orig;
    try {
      const t = await svc.getThread({ mailbox: box, uid: 1, limit: 5 });
      expect(t.total).toBe(301);
      expect(t.returned).toBe(5);
    } finally {
      ImapFlow.prototype.fetchAll = orig;
    }
    const count = (range: string): number =>
      range.split(',').reduce((n, part) => {
        const [a, b] = part.split(':').map(Number);
        return n + (b === undefined ? 1 : Math.abs((b ?? 0) - (a ?? 0)) + 1);
      }, 0);
    const heavy = calls.filter((c) => c.query['bodyStructure'] || c.query['bodyParts']);
    expect(heavy.length).toBeGreaterThan(0);
    for (const c of heavy) expect(count(c.range), c.range).toBeLessThanOrEqual(5);
    for (const c of calls) expect(c.range.length, 'compressed sequence sets').toBeLessThan(200);
  });
});

// imap-1 / tests-1 (profile without SPECIAL-USE) and imap-12 (without UIDPLUS)
const noUidplusUp = await portOpen(PROFILES['no-uidplus']);
describe.skipIf(skipProfile(noUidplusUp))('no-uidplus profile: stray special-looking folders and APPEND without APPENDUID', () => {
  const port = PROFILES['no-uidplus'];
  let pdirs: TestDirs;
  let p: MailService;

  beforeAll(async () => {
    await resetProfile('no-uidplus');
    for (const f of ['Sent Items', 'Deleted Items', 'Bin', 'Draft']) await ensureMailbox(f, port);
    pdirs = makeTestDirs();
    mkdirSync(pdirs.attachFrom, { recursive: true });
    p = createTestService(pdirs, { IMAP_PORT: String(port) });
  });
  afterAll(async () => {
    await p?.close();
    if (pdirs) cleanupDirs(pdirs);
    await resetProfile('no-uidplus');
  });

  it('uses Apple\'s folders for Trash, Sent and Drafts', async () => {
    const info = await p.getAccountInfo();
    expect(info['special_folders']).toMatchObject({ sent: 'Sent Messages', trash: 'Deleted Messages', drafts: 'Drafts' });
    const trashed = await p.trashMessages({ mailbox: 'INBOX', uids: [2] });
    expect(trashed.destination).toBe('Deleted Messages');
    const sent = asSent(await p.sendEmail({ to: ['friend@example.com'], subject: 'stray folders', body: 'x' }));
    expect(sent.sent_copy_mailbox).toBe('Sent Messages');
    expect(await rawUidsByMessageId('Sent Messages', sent.message_id, port)).toHaveLength(1);
  });

  it('save_draft reports the UID of the draft it saved (looked up by Message-ID)', async () => {
    const d = await p.saveDraft({ body: 'uid check', subject: 'uid check' });
    expect(d.uid).not.toBeNull();
    const mid = await withRawImap(async (c) => {
      const lock = await c.getMailboxLock('Drafts', { readOnly: true });
      try {
        const msg = await c.fetchOne(String(d.uid), { envelope: true }, { uid: true });
        return msg ? (msg.envelope?.messageId ?? null) : null;
      } finally {
        lock.release();
      }
    }, port);
    expect(mid).toBe(d.message_id);
    expect(await rawFlags('Drafts', d.uid as number, port)).toContain('\\Draft');
  });
});

// send_draft (added with the draft-replacement changes): sends the saved bytes, hides Bcc, removes the draft.
describe('send_draft', () => {
  it('sends a saved draft as is and removes it from Drafts', async () => {
    const d = await svc.saveDraft({ to: ['friend@example.com'], bcc: ['hidden@example.net'], subject: 'draft to send', body: 'Hello from a draft' });
    const r = asSent(await svc.sendDraft({ uid: d.uid as number }));
    expect(r.accepted.sort()).toEqual(['friend@example.com', 'hidden@example.net']);
    expect(r.sent_copy_saved).toBe(true);
    const sidecar = findSidecarByMessageId(r.message_id);
    expect(sidecar?.envelope.rcptTo.sort()).toEqual(['friend@example.com', 'hidden@example.net']);
    const text = readEml(sidecar as NonNullable<typeof sidecar>);
    expect(text).not.toMatch(/^Bcc:/im);
    expect(text).toContain('Hello from a draft');
    expect(r.message_id).not.toBe(d.message_id);
    expect(await rawUidsByMessageId('Drafts', d.message_id)).toEqual([]);
    expect(await rawUidsByMessageId('Sent Messages', r.message_id)).toHaveLength(1);
  });

  it('refuses a message that is not a draft', async () => {
    const uid = await append('Drafts', eml({ subject: 'not a draft' }));
    svc.mailboxes.invalidate();
    expect((await failure(svc.sendDraft({ uid }))).code).toBe('FORBIDDEN');
  });
});
