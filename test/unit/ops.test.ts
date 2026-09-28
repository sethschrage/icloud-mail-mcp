import type { ImapFlow, SearchObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { ImapManager } from '../../src/imap/client.js';
import type { MailboxInfo, MailboxRegistry } from '../../src/imap/mailboxes.js';
import { appendMessage, deleteMessagesPermanently, markMessages, moveMessages, normalizeNewMailboxPath, validateUids, verifyUids } from '../../src/imap/ops.js';

interface Call {
  method: string;
  args: unknown[];
}

/** Expand a sequence-set string ("1:3,7") into UIDs. */
function expand(set: string): number[] {
  const out: number[] = [];
  for (const part of String(set).split(',')) {
    const [a, b] = part.split(':').map(Number);
    if (a === undefined || Number.isNaN(a)) continue;
    for (let u = a; u <= (b ?? a); u++) out.push(u);
  }
  return out;
}

/** Fake selected-mailbox client: `existing` UIDs, some of which may carry \Deleted. */
class FakeMailboxClient {
  calls: Call[] = [];
  capabilities: Map<string, boolean>;
  flags = new Map<number, Set<string>>();
  constructor(
    private readonly existing: number[],
    private readonly deleted: number[],
    caps: string[],
  ) {
    this.capabilities = new Map(caps.map((c) => [c, true]));
    for (const u of existing) this.flags.set(u, new Set(deleted.includes(u) ? ['\\Deleted'] : []));
  }
  /** What search() returns for the next query (false = imapflow's value for a failed SEARCH). */
  searchResult: false | undefined = undefined;
  copyFails = false;
  deleteResult: boolean | 'throw' = true;
  private live(): number[] {
    return this.existing.filter((u) => !this.deleted.includes(u));
  }
  search(query: SearchObject, options: { uid?: boolean }): Promise<number[]> {
    this.calls.push({ method: 'search', args: [query, options] });
    if (this.searchResult === false) return Promise.resolve(false as unknown as number[]);
    if (query.deleted === true) return Promise.resolve([...this.deleted].reverse());
    const set = String(query.uid ?? '');
    const wanted = new Set<number>();
    for (const part of set.split(',')) {
      const [a, b] = part.split(':').map(Number);
      if (a === undefined || Number.isNaN(a)) continue;
      for (let u = a; u <= (b ?? a); u++) wanted.add(u);
    }
    return Promise.resolve(this.live().filter((u) => wanted.has(u)));
  }
  usable = true;
  messageMove(range: string, dest: string, options: { uid?: boolean }) {
    this.calls.push({ method: 'messageMove', args: [range, dest, options] });
    return Promise.resolve({ path: 'INBOX', destination: dest, uidMap: new Map(expand(range).map((u, i) => [u, 100 + i])) });
  }
  messageCopy(range: string, dest: string, options: { uid?: boolean }) {
    this.calls.push({ method: 'messageCopy', args: [range, dest, options] });
    if (this.copyFails) return Promise.resolve(false);
    return Promise.resolve({ path: 'INBOX', destination: dest, uidMap: new Map(expand(range).map((u, i) => [u, 100 + i])) });
  }
  messageDelete(range: string, options: { uid?: boolean }) {
    this.calls.push({ method: 'messageDelete', args: [range, options] });
    if (this.deleteResult === 'throw') return Promise.reject(Object.assign(new Error('Connection closed'), { code: 'NoConnection' }));
    return Promise.resolve(this.deleteResult);
  }
  messageFlagsAdd(range: number[], flags: string[], options: { uid?: boolean }) {
    this.calls.push({ method: 'messageFlagsAdd', args: [range, flags, options] });
    for (const u of range) for (const f of flags) this.flags.get(u)?.add(f);
    return Promise.resolve(true);
  }
  messageFlagsRemove(range: number[], flags: string[], options: { uid?: boolean }) {
    this.calls.push({ method: 'messageFlagsRemove', args: [range, flags, options] });
    for (const u of range) for (const f of flags) this.flags.get(u)?.delete(f);
    return Promise.resolve(true);
  }
  fetchAll(range: string, _query: unknown, options: { uid?: boolean }) {
    this.calls.push({ method: 'fetchAll', args: [range, _query, options] });
    return Promise.resolve(expand(range).filter((u) => this.flags.has(u)).map((uid) => ({ uid, seq: uid, flags: new Set(this.flags.get(uid)) })));
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

function fakeImap(client: FakeMailboxClient): ImapManager {
  // Only withMailbox is used by these operations.
  return {
    withMailbox: <T>(_path: string, fn: (c: ImapFlow, mb: unknown) => Promise<T>) => fn(client as unknown as ImapFlow, { path: _path, exists: 10 }),
  } as unknown as ImapManager;
}

const registry = { invalidate: () => undefined, invalidateCounts: () => undefined } as unknown as MailboxRegistry;
const box = (path: string): MailboxInfo => ({
  path,
  name: path,
  delimiter: '/',
  parentPath: '',
  specialUse: null,
  serverSpecialUse: null,
  serverSpecialUseSource: null,
  selectable: true,
  noInferiors: false,
  hasChildren: false,
  total: 0,
  unread: 0,
  flags: [],
});

describe('validateUids', () => {
  it('accepts 1..500 positive integers and dedupes', () => {
    expect(validateUids([3, 1, 3, 2])).toEqual([1, 2, 3]);
    for (const bad of [[], [0], [-1], [1.5], [Number.NaN], Array.from({ length: 501 }, (_, i) => i + 1)]) {
      expect(() => validateUids(bad), JSON.stringify(bad).slice(0, 30)).toThrow(MailError);
    }
  });
});

describe('verifyUids', () => {
  it('uses one UID SEARCH with UNDELETED and reports not_found', async () => {
    const c = new FakeMailboxClient([1, 2, 3, 5], [3], ['UIDPLUS']);
    const r = await verifyUids(c as unknown as ImapFlow, [1, 2, 3, 4, 5]);
    expect(r).toEqual({ found: [1, 2, 5], notFound: [3, 4] });
    expect(c.calls[0]).toEqual({ method: 'search', args: [{ uid: '1:5', deleted: false }, { uid: true }] });
  });
});

describe('move and the expunge guard', () => {
  it('with MOVE: moves by UID with { uid: true } and returns the new UIDs', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [2], ['MOVE', 'UIDPLUS']);
    const r = await moveMessages(fakeImap(c), registry, box('INBOX'), [1, 3, 9], box('Archive'));
    expect(r).toEqual({ source: 'INBOX', destination: 'Archive', moved: 2, not_found: [9], new_uids: { '1': 100, '3': 101 } });
    expect(c.methods()).toEqual(['search', 'messageMove']);
    expect(c.calls[1]?.args).toEqual(['1,3', 'Archive', { uid: true }]);
  });

  it('without MOVE but with UIDPLUS (iCloud): no guard needed, UID EXPUNGE only touches our UIDs', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [2], ['UIDPLUS']);
    const r = await moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('Archive'));
    expect(r).toMatchObject({ moved: 1, new_uids: { '1': 100 } });
    // Step by step (COPY, then STORE \Deleted + UID EXPUNGE), so a failure after COPY is reported truthfully.
    expect(c.methods()).toEqual(['search', 'messageCopy', 'messageDelete']);
  });

  it('without MOVE and UIDPLUS: refuses when other \\Deleted messages exist', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [2], []);
    const err = await moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('Archive')).catch((e: unknown) => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).code).toBe('EXPUNGE_GUARD');
    expect((err as MailError).message).toMatch(/neither MOVE nor UIDPLUS.*1 other message.*UIDs 2/);
    expect(c.methods()).toEqual(['search', 'search', 'fetchAll']);
    expect(c.calls[1]?.args).toEqual([{ deleted: true }, { uid: true }]);
  });

  it('without MOVE and UIDPLUS: proceeds when no other \\Deleted messages exist', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [], []);
    const r = await moveMessages(fakeImap(c), registry, box('INBOX'), [1, 2], box('Archive'));
    expect(r.moved).toBe(2);
    expect(c.methods()).toEqual(['search', 'search', 'messageCopy', 'messageDelete']);
  });

  it('refuses moving to the same mailbox', async () => {
    const c = new FakeMailboxClient([1], [], ['MOVE']);
    await expect(moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('INBOX'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('passes a fresh options object to every call (imapflow mutates it)', async () => {
    const c = new FakeMailboxClient([1, 2], [], []);
    await moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('Archive'));
    const opts = c.calls.map((call) => call.args[call.args.length - 1]);
    expect(new Set(opts).size).toBe(opts.length);
    expect(opts.every((o) => (o as { uid?: boolean }).uid === true)).toBe(true);
  });
});

// imap-2: imapflow returns false for a failed SEARCH; that must never read as "no results".
describe('a failed SEARCH', () => {
  it('verifyUids rejects instead of reporting every UID as not found', async () => {
    const c = new FakeMailboxClient([1, 2], [], ['UIDPLUS']);
    c.searchResult = false;
    await expect(verifyUids(c as unknown as ImapFlow, [1, 2])).rejects.toMatchObject({ code: 'SERVER' });
  });

  it('the expunge guard fails closed: no COPY, STORE or EXPUNGE', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [1], []);
    const search = c.search.bind(c);
    c.search = (q, o) => (q.deleted === true ? Promise.resolve(false as unknown as number[]) : search(q, o));
    await expect(moveMessages(fakeImap(c), registry, box('INBOX'), [2], box('Archive'))).rejects.toMatchObject({ code: 'SERVER' });
    expect(c.methods()).not.toContain('messageCopy');
    expect(c.methods()).not.toContain('messageMove');
    expect(c.methods()).not.toContain('messageDelete');
  });

  it('the guard ignores ghost UIDs FETCH does not return', async () => {
    const c = new FakeMailboxClient([1, 2], [], []);
    const search = c.search.bind(c);
    c.search = (q, o) => (q.deleted === true ? Promise.resolve([900, 901]) : search(q, o));
    expect((await moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('Archive'))).moved).toBe(1);
  });
});

// imap-6 / tests-6: a failure after the COPY of a MOVE-less move.
describe('move without MOVE: failure after COPY', () => {
  it('the delete step fails and the originals are not flagged: error names the copies and says not to retry', async () => {
    const c = new FakeMailboxClient([1, 2], [], ['UIDPLUS']);
    c.deleteResult = false;
    const e = (await moveMessages(fakeImap(c), registry, box("INBOX"), [1, 2], box("Receipts")).catch((err: unknown) => err)) as MailError;
    expect(e).toBeInstanceOf(MailError);
    expect(e.message).toMatch(/Copied 2 message\(s\) to "Receipts" \(new UIDs there: 100, 101\).*Do not retry the move/);
    expect(e.details).toMatchObject({ new_uids: { '1': 100, '2': 101 } });
  });

  it('a connection drop during the delete step is reported the same way', async () => {
    const c = new FakeMailboxClient([1], [], ['UIDPLUS']);
    c.deleteResult = 'throw';
    c.usable = false;
    const e = (await moveMessages(fakeImap(c), registry, box("INBOX"), [1], box("Receipts")).catch((err: unknown) => err)) as MailError;
    expect(e).toBeInstanceOf(MailError);
    expect(e.message).toMatch(/Copied 1 message\(s\)/);
  });

  it('COPY refused: nothing was moved', async () => {
    const c = new FakeMailboxClient([1], [], ['UIDPLUS']);
    c.copyFails = true;
    await expect(moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('Receipts'))).rejects.toMatchObject({ code: 'SERVER', message: expect.stringMatching(/nothing was moved/) as string });
    expect(c.methods()).not.toContain('messageDelete');
  });
});

describe('permanent delete', () => {
  it('with UIDPLUS: deletes only the verified UIDs', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [3], ['UIDPLUS']);
    const r = await deleteMessagesPermanently(fakeImap(c), registry, box('Deleted Messages'), [1, 4]);
    expect(r).toEqual({ mailbox: 'Deleted Messages', deleted: 1, not_found: [4] });
    expect(c.calls.at(-1)).toEqual({ method: 'messageDelete', args: ['1', { uid: true }] });
  });

  it('without UIDPLUS: guarded like moves', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [3], ['MOVE']);
    await expect(deleteMessagesPermanently(fakeImap(c), registry, box('Deleted Messages'), [1])).rejects.toMatchObject({ code: 'EXPUNGE_GUARD' });
    expect(c.methods()).not.toContain('messageDelete');
    const ok = new FakeMailboxClient([1, 2], [], ['MOVE']);
    expect((await deleteMessagesPermanently(fakeImap(ok), registry, box('X'), [1])).deleted).toBe(1);
  });
});

describe('markMessages', () => {
  it('sets a colour: adds \\Flagged + bits, removes the other bits, reads back', async () => {
    const c = new FakeMailboxClient([7], [], ['UIDPLUS']);
    c.flags.set(7, new Set(['$MailFlagBit2']));
    const r = await markMessages(fakeImap(c), box('INBOX'), [7], { flagColor: 'orange' });
    expect(c.calls.filter((x) => x.method.startsWith('messageFlags')).map((x) => [x.method, x.args[1]])).toEqual([
      ['messageFlagsAdd', ['\\Flagged', '$MailFlagBit0']],
      ['messageFlagsRemove', ['$MailFlagBit1', '$MailFlagBit2']],
    ]);
    expect(r.messages).toEqual([{ uid: 7, unread: true, flagged: true, flag_color: 'orange' }]);
    expect(r.not_applied).toEqual([]);
  });

  it('reports keywords the server silently dropped', async () => {
    const c = new FakeMailboxClient([7], [], []);
    // Simulate a server that ignores custom keywords.
    const add = c.messageFlagsAdd.bind(c);
    c.messageFlagsAdd = (range, flags, options) => add(range, flags.filter((f) => f.startsWith('\\')), options);
    const r = await markMessages(fakeImap(c), box('INBOX'), [7], { flagColor: 'green' });
    expect(r.not_applied).toEqual([{ uid: 7, reason: expect.stringMatching(/colour is red instead of green/) as string }]);
  });

  it('unflagging removes \\Flagged and all colour bits', async () => {
    const c = new FakeMailboxClient([7], [], []);
    await markMessages(fakeImap(c), box('INBOX'), [7], { flagged: false, read: true });
    expect(c.calls.filter((x) => x.method.startsWith('messageFlags')).map((x) => [x.method, x.args[1]])).toEqual([
      ['messageFlagsAdd', ['\\Seen']],
      ['messageFlagsRemove', ['\\Flagged', '$MailFlagBit0', '$MailFlagBit1', '$MailFlagBit2']],
    ]);
  });
});

describe('normalizeNewMailboxPath', () => {
  it('maps "/" to the server delimiter and validates segments', () => {
    expect(normalizeNewMailboxPath('Projects/New', '/')).toBe('Projects/New');
    expect(normalizeNewMailboxPath('Projects/New', '.')).toBe('Projects.New');
    expect(normalizeNewMailboxPath(' Réceipts ', '/')).toBe('Réceipts');
    for (const bad of ['', '  ', 'a//b', 'a/', '/a', 'a*b', 'a%b', 'x\ny']) expect(() => normalizeNewMailboxPath(bad, '/'), bad).toThrow(MailError);
  });
});

// imap-12: without APPENDUID the UID imapflow guesses from EXISTS may be another client's message.
describe('appendMessage without UIDPLUS', () => {
  function appendClient(appendRes: { uid?: number; uidValidity?: bigint }, hits: number[]) {
    const searches: SearchObject[] = [];
    const client = {
      capabilities: new Map<string, boolean>(),
      usable: true,
      append: () => Promise.resolve({ destination: 'Drafts', ...appendRes }),
      search: (q: SearchObject) => {
        searches.push(q);
        return Promise.resolve(hits);
      },
      fetchOne: (uid: string) => Promise.resolve({ uid: Number(uid), flags: new Set(['\\Draft', '\\Seen']) }),
    };
    return { client, searches };
  }

  it('looks the UID up by Message-ID and keeps it only for exactly one match', async () => {
    const one = appendClient({ uid: 7 }, [8]);
    const r = await appendMessage(fakeImap(one.client as unknown as FakeMailboxClient), registry, 'Drafts', Buffer.from('x'), ['\\Draft'], undefined, '<id@icloud.com>');
    expect(r.uid).toBe(8);
    expect(one.searches[0]).toEqual({ header: { 'message-id': '<id@icloud.com>' }, deleted: false });
    const two = appendClient({ uid: 7 }, [8, 9]);
    expect((await appendMessage(fakeImap(two.client as unknown as FakeMailboxClient), registry, 'Drafts', Buffer.from('x'), [], undefined, '<id@icloud.com>')).uid).toBeNull();
  });

  it('trusts APPENDUID', async () => {
    const c = appendClient({ uid: 7, uidValidity: 1n }, [8]);
    expect((await appendMessage(fakeImap(c.client as unknown as FakeMailboxClient), registry, 'Drafts', Buffer.from('x'), [], undefined, '<id@icloud.com>')).uid).toBe(7);
    expect(c.searches).toHaveLength(0);
  });
});
