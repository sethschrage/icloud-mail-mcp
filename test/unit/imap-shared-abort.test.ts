/**
 * One ImapManager connection shared by concurrent tool calls (a warm cloud instance serves
 * several requests through one cached MailService). A call that is abandoned (deadline or client
 * cancellation) must not close the connection under the other calls still using it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImapFlow, ImapFlowOptions } from 'imapflow';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { runWithContext } from '../../src/context.js';
import { CredentialProvider } from '../../src/credentials.js';
import { withDeadline } from '../../src/deadline.js';
import { MailError } from '../../src/errors.js';
import { ImapManager, mapImapError } from '../../src/imap/client.js';
import { clearSecrets, createLogger } from '../../src/log.js';
import { setRuntime } from '../../src/runtime.js';

type Listener = (...args: unknown[]) => void;

const noConnection = (): Error => Object.assign(new Error('Connection not available'), { code: 'NoConnection' });

/**
 * Stand-in for ImapFlow: one mailbox lock at a time (queued like imapflow's), commands that take
 * a while, and close() rejecting every pending command and lock wait with NoConnection.
 */
class FakeImap {
  static instances: FakeImap[] = [];
  readonly id: number;
  usable = false;
  closed = false;
  capabilities = new Map<string, boolean>([['IMAP4rev1', true]]);
  mailbox: { path: string; exists: number } | false = false;
  listeners = new Map<string, Listener[]>();
  pending = new Set<(err: Error) => void>();
  lockQueue: Promise<void> = Promise.resolve();
  lockReleases = 0;
  constructor(readonly options: ImapFlowOptions) {
    FakeImap.instances.push(this);
    this.id = FakeImap.instances.length;
  }
  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  connect(): Promise<void> {
    this.usable = true;
    return Promise.resolve();
  }
  noop(): Promise<void> {
    return Promise.resolve();
  }
  logout(): Promise<void> {
    this.close();
    return Promise.resolve();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.usable = false;
    for (const reject of this.pending) reject(noConnection());
    this.pending.clear();
    for (const fn of this.listeners.get('close') ?? []) fn();
  }
  /** A command answered after `ms` (never when `ms` is Infinity). */
  cmd<T>(ms: number, value: T): Promise<T> {
    if (!this.usable) return Promise.reject(noConnection());
    return new Promise<T>((resolve, reject) => {
      this.pending.add(reject);
      if (Number.isFinite(ms)) {
        setTimeout(() => {
          if (!this.pending.delete(reject)) return;
          resolve(value);
        }, ms);
      }
    });
  }
  async getMailboxLock(p: string): Promise<{ path: string; release: () => void }> {
    let release!: () => void;
    const previous = this.lockQueue;
    this.lockQueue = new Promise<void>((r) => (release = r));
    const done = (): void => {
      this.lockReleases++;
      release();
    };
    // imapflow rejects a lock wait when the connection closes.
    let onClose!: (err: Error) => void;
    const closed = new Promise<never>((_, reject) => {
      onClose = reject;
      this.pending.add(reject);
    });
    try {
      await Promise.race([previous, closed]);
    } catch (err) {
      release();
      throw err;
    } finally {
      this.pending.delete(onClose);
    }
    if (!this.usable) {
      release();
      throw noConnection();
    }
    this.mailbox = { path: p, exists: 3 };
    return { path: p, release: done };
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'imap-shared-abort-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSecrets();
});
afterEach(() => setRuntime('local'));

function manager(): ImapManager {
  FakeImap.instances = [];
  const { config } = loadConfig({ ICLOUD_EMAIL: 'john@custom.dev', ICLOUD_APP_PASSWORD: 'app-pass-1234', MAIL_AUDIT_LOG: 'off' }, { platform: 'linux', home: dir });
  return new ImapManager({
    config,
    credentials: new CredentialProvider(config, { platform: 'linux' }),
    logger: createLogger({ level: 'error', sink: () => undefined }),
    idleCloseMs: 60_000,
    createClient: (options) => new FakeImap(options) as unknown as ImapFlow,
  });
}

const fake = (c: ImapFlow): FakeImap => c as unknown as FakeImap;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const failure = (p: Promise<unknown>): Promise<MailError> =>
  p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e as MailError,
  );

/** Settle time of `p`, measured from now. */
async function timed<T>(p: Promise<T>): Promise<{ ms: number; result: T | undefined; error: MailError | undefined }> {
  const t0 = Date.now();
  try {
    const result = await p;
    return { ms: Date.now() - t0, result, error: undefined };
  } catch (e) {
    return { ms: Date.now() - t0, result: undefined, error: e as MailError };
  }
}

describe('a call abandoned while another call uses the same connection', () => {
  it('deadline: the other call\'s write still succeeds, and the abandoned call rejects promptly', async () => {
    const m = manager();
    let inner: Promise<string> | undefined;
    // A: a slow read whose deadline fires while its command is pending.
    const a = withDeadline(
      () => {
        inner = m.run((c) => fake(c).cmd(1_000, 'A'), { retry: true });
        return inner;
      },
      { timeoutMs: 80, what: 'search_messages' },
    );
    await sleep(20);
    // B: a write on the same connection, in flight when A's deadline fires.
    const b = withDeadline(() => m.withMailbox('Archive', (c) => fake(c).cmd(200, 'B-moved'), { readOnly: false }), { timeoutMs: 5_000, what: 'move_messages' });
    const innerA = timed(inner as Promise<string>);
    const [ra, rb, ri] = await Promise.all([timed(a), timed(b), innerA]);
    expect(ra.error?.code).toBe('TIMEOUT');
    // The manager itself stops waiting at the deadline, not when the stuck command ends.
    expect(ri.error?.code).toBe('TIMEOUT');
    expect(ri.ms).toBeLessThan(500);
    expect(rb.error).toBeUndefined();
    expect(rb.result).toBe('B-moved');
    expect(FakeImap.instances).toHaveLength(1);
    const first = FakeImap.instances[0] as FakeImap;
    expect(first.lockReleases).toBe(1);
    // B was the last call using it while A's command was still pending: it is closed now, and
    // the next call gets a fresh connection.
    expect(first.closed).toBe(true);
    expect(await m.run(async (c) => fake(c).id)).toBe(2);
    await m.close();
  });

  it('client cancellation (external AbortSignal): the other call\'s write still succeeds', async () => {
    const m = manager();
    const cancel = new AbortController();
    let inner: Promise<string> | undefined;
    const a = withDeadline(
      () => {
        inner = m.withMailbox('INBOX', (c) => fake(c).cmd(Infinity, 'A'), { readOnly: true });
        return inner;
      },
      { timeoutMs: 10_000, signal: cancel.signal, what: 'search_messages' },
    );
    await sleep(20);
    const created: string[] = [];
    const b = withDeadline(
      () =>
        m.run(async (c) => {
          await fake(c).cmd(150, null);
          created.push(`Projects@${fake(c).id}`);
          return 'created';
        }),
      { timeoutMs: 5_000, what: 'create_mailbox' },
    );
    await sleep(30);
    cancel.abort();
    const ri = await timed(inner as Promise<string>);
    expect(ri.error?.code).toBe('CANCELLED');
    expect(ri.ms).toBeLessThan(100);
    expect((await failure(a)).code).toBe('CANCELLED');
    expect(await b).toBe('created');
    expect(created).toEqual(['Projects@1']);
    // A's command never finished; with B done nothing uses the connection any more, so it is
    // closed (which also rejects A's command and releases its mailbox lock).
    const first = FakeImap.instances[0] as FakeImap;
    expect(first.closed).toBe(true);
    await sleep(0);
    expect(first.lockReleases).toBe(1);
    await m.close();
  });

  it('runs ImapManager directly under an aborted context: rejects with the abort reason at once', async () => {
    const m = manager();
    const ac = new AbortController();
    const a = runWithContext({ signal: ac.signal }, () => m.run((c) => fake(c).cmd(Infinity, 'A')));
    await sleep(10);
    const b = m.run((c) => fake(c).cmd(100, 'B'));
    await sleep(10);
    const reason = new MailError('TIMEOUT', 'search_messages did not finish');
    ac.abort(reason);
    const ra = await timed(a);
    expect(ra.error).toBe(reason);
    expect(ra.ms).toBeLessThan(50);
    expect((FakeImap.instances[0] as FakeImap).closed).toBe(false);
    expect(await b).toBe('B');
    await m.close();
  });

  it('when the abandoned call was the only one using the connection, it is still closed at once', async () => {
    const m = manager();
    let inner: Promise<string> | undefined;
    const a = withDeadline(
      () => {
        inner = m.withMailbox('INBOX', (c) => fake(c).cmd(Infinity, 'A'), { readOnly: true });
        return inner;
      },
      { timeoutMs: 50, what: 'search_messages' },
    );
    expect((await failure(a)).code).toBe('TIMEOUT');
    expect((await failure(inner as Promise<string>)).code).toBe('TIMEOUT');
    const first = FakeImap.instances[0] as FakeImap;
    expect(first.closed).toBe(true);
    await sleep(0);
    expect(first.lockReleases).toBe(1);
    expect(await m.run(async (c) => fake(c).id)).toBe(2);
    await m.close();
  });

  it('calls abandoned together (one cancelled request) close the connection', async () => {
    const m = manager();
    const ac = new AbortController();
    const a = withDeadline(() => m.withMailbox('INBOX', (c) => fake(c).cmd(Infinity, 'A'), { readOnly: true }), { timeoutMs: 10_000, signal: ac.signal });
    await sleep(10);
    const b = withDeadline(() => m.withMailbox('Archive', (c) => fake(c).cmd(10, 'B'), { readOnly: false }), { timeoutMs: 10_000, signal: ac.signal });
    await sleep(10);
    ac.abort();
    expect((await failure(a)).code).toBe('CANCELLED');
    expect((await failure(b)).code).toBe('CANCELLED');
    expect((FakeImap.instances[0] as FakeImap).closed).toBe(true);
    await m.close();
  });

  it('a command that never finishes is closed by the deadline of the last call still waiting behind it', async () => {
    const m = manager();
    const a = withDeadline(() => m.withMailbox('INBOX', (c) => fake(c).cmd(Infinity, 'A'), { readOnly: true }), { timeoutMs: 40, what: 'search_messages' });
    await sleep(10);
    let bRan = false;
    const b = withDeadline(
      () =>
        m.withMailbox(
          'INBOX',
          async () => {
            bRan = true;
            return 'B';
          },
          { readOnly: false },
        ),
      { timeoutMs: 150, what: 'mark_messages' },
    );
    expect((await failure(a)).code).toBe('TIMEOUT');
    // A's deadline left the connection to B, which is waiting for the mailbox lock.
    const first = FakeImap.instances[0] as FakeImap;
    expect(first.closed).toBe(false);
    expect((await failure(b)).code).toBe('TIMEOUT');
    expect(first.closed).toBe(true);
    expect(bRan).toBe(false);
    expect(await m.run(async (c) => fake(c).id)).toBe(2);
    await m.close();
  });
});

describe('a write whose connection is closed underneath it by another call', () => {
  it('retries once on a new connection when it had not started yet (waiting for the mailbox lock)', async () => {
    const m = manager();
    const holder = m.withMailbox('INBOX', (c) => fake(c).cmd(Infinity, 'held'), { readOnly: true, retry: false }).catch((e: unknown) => e);
    await sleep(10);
    const runs: number[] = [];
    const write = m.withMailbox(
      'INBOX',
      async (c) => {
        runs.push(fake(c).id);
        return 'flagged';
      },
      { readOnly: false },
    );
    await sleep(10);
    // Another path resets the connection (here: the MCP session closing, release()).
    await m.release();
    expect(await write).toBe('flagged');
    expect(runs).toEqual([2]);
    await holder;
    await m.close();
  });

  it('reports that the change may or may not have been applied once it had started', async () => {
    const m = manager();
    const write = m.withMailbox('Archive', (c) => fake(c).cmd(Infinity, 'moved'), { readOnly: false });
    await sleep(10);
    await m.release();
    const e = await failure(write);
    expect(e.code).toBe('CONNECTION');
    expect(e.message).toMatch(/may or may not have been applied: check before retrying/);
    expect(FakeImap.instances).toHaveLength(1);
    await m.close();
  });
});

describe('connection failure wording', () => {
  const err = (): Error => Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
  const ctx = { host: 'imap.mail.me.com', port: 993 };

  it('local: points at the Mac\'s internet connection (unchanged)', () => {
    setRuntime('local');
    expect(mapImapError(err(), ctx).message).toBe(
      "Could not talk to the IMAP server imap.mail.me.com:993 (NoConnection). Check the Mac's internet connection; iCloud may also be temporarily unavailable. The next request will reconnect.",
    );
  });

  it('cloud: does not mention a Mac', () => {
    setRuntime('cloud');
    const e = mapImapError(err(), ctx);
    expect(e.code).toBe('CONNECTION');
    expect(e.message).toBe(
      'Could not talk to the IMAP server imap.mail.me.com:993 (NoConnection). Check that iCloud Mail is reachable; iCloud may be temporarily unavailable. The next request will reconnect.',
    );
    expect(e.message).not.toMatch(/Mac/);
  });
});
