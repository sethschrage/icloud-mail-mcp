/**
 * iCloud behaviour the Dovecot profiles cannot reproduce, against a scripted fake IMAP server with the
 * real imapflow: name-guess conflicts between special folders, ghost \Deleted UIDs, failures between
 * COPY and EXPUNGE, failed SEARCHes, commands that never get an answer, login refusals, the STARTTLS
 * requirement and the command budget of ordinary calls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { withDeadline } from '../../src/deadline.js';
import { MailError } from '../../src/errors.js';
import { createLogger } from '../../src/log.js';
import { MailService } from '../../src/service.js';
import { startFakeIcloud, type FakeFolder, type FakeOptions, type FakeServer } from '../helpers/fake-icloud-imap.js';

const ICLOUD_STANDARD: FakeFolder[] = ['Drafts', 'Sent Messages', 'Deleted Messages', 'Junk', 'Archive'].map((p) => ({ path: p }));
const NO_UIDPLUS = 'IMAP4rev1 LITERAL+ IDLE QUOTA';

const home = mkdtempSync(path.join(os.tmpdir(), 'fake-icloud-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

let server: FakeServer | undefined;
let svc: MailService | undefined;
afterEach(async () => {
  await svc?.close().catch(() => undefined);
  await server?.close();
  svc = undefined;
  server = undefined;
});

async function setup(extraFolders: Array<string | FakeFolder>, opts: FakeOptions = {}, env: Record<string, string> = {}): Promise<{ s: MailService; srv: FakeServer }> {
  server = await startFakeIcloud([...ICLOUD_STANDARD, ...extraFolders.map((f) => (typeof f === 'string' ? { path: f } : f))], opts);
  const cfg = loadConfig(
    {
      ICLOUD_EMAIL: 'me@icloud.com',
      ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
      IMAP_HOST: '127.0.0.1',
      IMAP_PORT: String(server.port),
      IMAP_SECURE: 'false',
      IMAP_ALLOW_PLAINTEXT: 'true',
      MAIL_AUDIT_LOG: 'off',
      MAIL_TIMEZONE: 'UTC',
      ...env,
    },
    { platform: 'linux', home },
  );
  svc = new MailService(cfg, { logger: createLogger({ level: 'error', sink: () => undefined }), platform: 'linux' });
  return { s: svc, srv: server };
}

async function failure(p: Promise<unknown>): Promise<MailError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MailError);
  return e as MailError;
}

// imap-1 / tests-1
describe('special folders without SPECIAL-USE', () => {
  it('baseline: only Apple folders -> canonical mapping', async () => {
    const { s } = await setup([]);
    expect((await s.getAccountInfo())['special_folders']).toMatchObject({ sent: 'Sent Messages', trash: 'Deleted Messages', drafts: 'Drafts', junk: 'Junk', archive: 'Archive' });
  });

  it('stray Outlook/Thunderbird/Gmail folders never replace Apple\'s folders', async () => {
    const { s } = await setup(['Deleted Items', 'Sent Items', 'Bulk Mail', 'Bin', 'Draft', 'Sent']);
    expect((await s.getAccountInfo())['special_folders']).toMatchObject({ sent: 'Sent Messages', trash: 'Deleted Messages', drafts: 'Drafts', junk: 'Junk' });
    expect((await s.resolveMailbox('trash')).path).toBe('Deleted Messages');
    expect((await s.resolveMailbox('deleted messages')).path).toBe('Deleted Messages');
    const list = await s.listMailboxes({ includeCounts: false });
    expect(list.find((m) => m.path === 'Deleted Messages')?.special_use).toBe('trash');
    expect(list.find((m) => m.path === 'Bin')?.special_use).toBeNull();
  });

  it('nested folders named like special folders are ordinary folders', async () => {
    const { s } = await setup(['Old Mail', 'Old Mail/Sent', 'Clients', 'Clients/Trash', 'Clients/Drafts']);
    expect((await s.getAccountInfo())['special_folders']).toMatchObject({ sent: 'Sent Messages', trash: 'Deleted Messages', drafts: 'Drafts' });
  });

  it('trash_messages moves into Deleted Messages even when a "Bin" exists', async () => {
    const { s, srv } = await setup(['Bin', 'Deleted Items'], { uids: { INBOX: [7] } });
    const r = await s.trashMessages({ mailbox: 'INBOX', uids: [7] });
    expect(r).toMatchObject({ destination: 'Deleted Messages', moved: 1 });
    expect(srv.commands.find((c) => c.includes('UID COPY'))).toMatch(/"?Deleted Messages"?$/);
  });

  it('falls back to a top-level name guess when Apple\'s folder is missing', async () => {
    server = await startFakeIcloud([{ path: 'Drafts' }, { path: 'Sent Items' }, { path: 'Deleted Messages' }, { path: 'Junk' }]);
    const cfg = loadConfig(
      { ICLOUD_EMAIL: 'me@icloud.com', ICLOUD_APP_PASSWORD: 'x', IMAP_HOST: '127.0.0.1', IMAP_PORT: String(server.port), IMAP_SECURE: 'false', IMAP_ALLOW_PLAINTEXT: 'true', MAIL_AUDIT_LOG: 'off' },
      { platform: 'linux', home },
    );
    svc = new MailService(cfg, { logger: createLogger({ level: 'error', sink: () => undefined }), platform: 'linux' });
    expect((await svc.getAccountInfo())['special_folders']).toMatchObject({ sent: 'Sent Items' });
  });
});

// imap-6 / tests-6
describe('a move that fails after COPY (no MOVE)', () => {
  it('EXPUNGE failed but the originals are flagged deleted: reported as moved, with a warning', async () => {
    const { s, srv } = await setup(['Receipts'], { uids: { INBOX: [5] }, failExpunge: true });
    const r = await s.moveMessages({ mailbox: 'INBOX', uids: [5], destination: 'Receipts' });
    expect(r.moved).toBe(1);
    expect(r.new_uids).toEqual({ '5': 101 });
    expect(r.warning).toMatch(/copied to "Receipts".*do not move them again/);
    expect(srv.flagsOf('INBOX', 5)).toContain('\\Deleted');
  });

  it('STORE failed after COPY: the error says copies exist and not to retry', async () => {
    const { s } = await setup(['Receipts'], { uids: { INBOX: [5, 6] }, failStore: true });
    const e = await failure(s.moveMessages({ mailbox: 'INBOX', uids: [5, 6], destination: 'Receipts' }));
    expect(e.code).toBe('SERVER');
    expect(e.message).toMatch(/Copied 2 message\(s\) to "Receipts" \(new UIDs there: 101, 102\).*Do not retry the move/);
    expect(e.details).toMatchObject({ copied: 2, new_uids: { '5': 101, '6': 102 } });
  });
});

// imap-2
describe('a failed SEARCH is an error, never "no results"', () => {
  it('the expunge guard fails closed: nothing is copied when SEARCH DELETED fails (no UIDPLUS)', async () => {
    const { s, srv } = await setup(['Receipts'], { caps: NO_UIDPLUS, uids: { INBOX: [1, 2, 3] }, failSearch: /^DELETED$/i });
    const e = await failure(s.moveMessages({ mailbox: 'INBOX', uids: [2], destination: 'Receipts' }));
    expect(e.code).toBe('SERVER');
    expect(srv.commands.some((c) => /UID (COPY|STORE|EXPUNGE)|\bEXPUNGE\b/.test(c))).toBe(false);
  });

  it('a failed verify SEARCH is reported as an error, not as not_found', async () => {
    const { s } = await setup([], { uids: { INBOX: [1, 2] }, failSearch: /UNDELETED/i });
    const e = await failure(s.markMessages({ mailbox: 'INBOX', uids: [1, 2], read: true }));
    expect(e.code).toBe('SERVER');
  });
});

// tests-9
describe('ghost \\Deleted UIDs (no UIDPLUS)', () => {
  it('UIDs that SEARCH DELETED returns but FETCH does not show do not block a move', async () => {
    const { s } = await setup(['Receipts'], { caps: NO_UIDPLUS, uids: { INBOX: [10] }, ghostDeleted: [1, 2, 3] });
    const r = await s.moveMessages({ mailbox: 'INBOX', uids: [10], destination: 'Receipts' });
    expect(r.moved).toBe(1);
  });

  it('a visible \\Deleted message still blocks it', async () => {
    const { s, srv } = await setup(['Receipts'], { caps: NO_UIDPLUS, uids: { INBOX: [9, 10] }, flags: { 'INBOX/9': ['\\Deleted'] } });
    const e = await failure(s.moveMessages({ mailbox: 'INBOX', uids: [10], destination: 'Receipts' }));
    expect(e.code).toBe('EXPUNGE_GUARD');
    expect(e.message).toContain('9');
    expect(srv.commands.some((c) => c.includes('COPY'))).toBe(false);
  });
});

// imap-4 / integ-1 / tests-7
describe('a command that never gets an answer', () => {
  it('after a timed-out call the connection is replaced, so the next call works right away', async () => {
    const { s, srv } = await setup([], { uids: { INBOX: [1, 2, 3] }, hangOn: ['UID SEARCH'] });
    const first = await failure(withDeadline(() => s.search({ mailbox: 'INBOX', subject: 'x' }), { timeoutMs: 1500, what: 'search_messages' }));
    expect(first.code).toBe('TIMEOUT');
    const started = Date.now();
    const second = await withDeadline(() => s.search({ mailbox: 'INBOX', limit: 1 }), { timeoutMs: 20_000, what: 'search_messages' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(second.returned).toBe(1);
    expect(srv.logins()).toBe(2);
  });

  it('a write queued behind the stuck command is never sent once its call was abandoned', async () => {
    const { s, srv } = await setup(['Receipts'], { uids: { INBOX: [1, 2, 3] }, hangOn: ['UID SEARCH'] });
    const controller = new AbortController();
    const stuck = withDeadline(() => s.search({ mailbox: 'INBOX', subject: 'x' }), { timeoutMs: 60_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 300));
    const queued = withDeadline((signal) => s.createMailbox({ path: 'NewFolder' }, { signal }), { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect((await failure(stuck)).code).toBe('CANCELLED');
    expect((await failure(queued)).code).toBe('CANCELLED');
    await new Promise((r) => setTimeout(r, 200));
    expect(srv.commands.some((c) => c.includes('CREATE'))).toBe(false);
  });
});

// integ-2
describe('login refusals', () => {
  it('NO [UNAVAILABLE] is a temporary connection problem: one LOGIN, server text quoted, no password advice', async () => {
    const { s, srv } = await setup([], { loginResponse: 'NO [UNAVAILABLE] Maximum number of connections from user+IP exceeded' });
    const e = await failure(s.search({ mailbox: 'INBOX', limit: 1 }));
    expect(e.code).toBe('CONNECTION');
    expect(e.message).toContain('(server said: [UNAVAILABLE] Maximum number of connections from user+IP exceeded)');
    expect(e.message).not.toMatch(/revoked/);
    expect(srv.logins()).toBe(1);
  });

  it('NO [AUTHENTICATIONFAILED] is a credential problem and tries the local part too', async () => {
    const { s, srv } = await setup([], { loginResponse: 'NO [AUTHENTICATIONFAILED] Invalid credentials' });
    const e = await failure(s.search({ mailbox: 'INBOX', limit: 1 }));
    expect(e.code).toBe('AUTH');
    expect(e.message).toContain('server said: [AUTHENTICATIONFAILED] Invalid credentials');
    expect(srv.logins()).toBe(2);
  });
});

// tls-1
describe('STARTTLS is required without implicit TLS', () => {
  it('refuses to log in in plaintext when the server offers no STARTTLS', async () => {
    const { s, srv } = await setup([], {}, { IMAP_ALLOW_PLAINTEXT: 'false' });
    await failure(s.search({ mailbox: 'INBOX', limit: 1 }));
    expect(srv.logins()).toBe(0);
    expect(srv.commands.some((c) => /LOGIN|AUTHENTICATE/i.test(c))).toBe(false);
  });

  it('the test-only plaintext switch is reported as a configuration warning', () => {
    const r = loadConfig({ ICLOUD_EMAIL: 'me@icloud.com', IMAP_SECURE: 'false', IMAP_ALLOW_PLAINTEXT: 'true' }, { platform: 'linux', home });
    expect(r.warnings.join(' ')).toMatch(/IMAP_ALLOW_PLAINTEXT/);
  });
});

// imap-9
describe('no ENABLE after login', () => {
  it('does not enable CONDSTORE / UTF8=ACCEPT even when advertised', async () => {
    const { s, srv } = await setup([], { caps: 'IMAP4rev1 LITERAL+ UIDPLUS ENABLE CONDSTORE UTF8=ACCEPT', uids: { INBOX: [1] } });
    await s.search({ mailbox: 'INBOX', limit: 1 });
    expect(srv.commands.some((c) => /\bENABLE\b/i.test(c))).toBe(false);
    expect(srv.commands.some((c) => /MODSEQ/i.test(c))).toBe(false);
  });
});

// imap-5
describe('folder list caching', () => {
  it('a flag change does not make the next call relist every folder, and counts are only loaded on request', async () => {
    const { s, srv } = await setup(['A', 'B', 'C'], { uids: { INBOX: [1, 2] } });
    await s.search({ mailbox: 'INBOX', limit: 5 });
    await s.markMessages({ mailbox: 'INBOX', uids: [1], read: true });
    const before = srv.commands.length;
    await s.search({ mailbox: 'INBOX', limit: 5 });
    await s.listMailboxes({ includeCounts: false });
    const after = srv.commands.slice(before);
    expect(after.some((c) => /\b(LIST|LSUB|STATUS)\b/i.test(c))).toBe(false);
    await s.listMailboxes({ includeCounts: true });
    expect(srv.commands.slice(before).some((c) => /\bSTATUS\b|LIST .*RETURN \(STATUS/i.test(c))).toBe(true);
  });
});
