import type { ImapFlow, SearchObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import type { ImapManager } from '../../src/imap/client.js';
import type { MailboxInfo, MailboxRegistry } from '../../src/imap/mailboxes.js';
import { deleteMessagesPermanently, markMessages, moveMessages, normalizeNewMailboxPath, validateUids, verifyUids } from '../../src/imap/ops.js';

interface Call {
  method: string;
  args: unknown[];
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
  private live(): number[] {
    return this.existing.filter((u) => !this.deleted.includes(u));
  }
  search(query: SearchObject, options: { uid?: boolean }): Promise<number[]> {
    this.calls.push({ method: 'search', args: [query, options] });
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
  messageMove(range: number[], dest: string, options: { uid?: boolean }) {
    this.calls.push({ method: 'messageMove', args: [range, dest, options] });
    return Promise.resolve({ path: 'INBOX', destination: dest, uidMap: new Map(range.map((u, i) => [u, 100 + i])) });
  }
  messageDelete(range: number[], options: { uid?: boolean }) {
    this.calls.push({ method: 'messageDelete', args: [range, options] });
    return Promise.resolve(true);
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
  fetchAll(range: number[], _query: unknown, options: { uid?: boolean }) {
    this.calls.push({ method: 'fetchAll', args: [range, _query, options] });
    return Promise.resolve(range.map((uid) => ({ uid, seq: uid, flags: new Set(this.flags.get(uid)) })));
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

const registry = { invalidate: () => undefined } as unknown as MailboxRegistry;
const box = (path: string): MailboxInfo => ({
  path,
  name: path,
  delimiter: '/',
  parentPath: '',
  specialUse: null,
  serverSpecialUse: null,
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
    expect(c.calls[1]?.args).toEqual([[1, 3], 'Archive', { uid: true }]);
  });

  it('without MOVE but with UIDPLUS (iCloud): no guard needed, UID EXPUNGE only touches our UIDs', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [2], ['UIDPLUS']);
    const r = await moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('Archive'));
    expect(r.moved).toBe(1);
    expect(c.methods()).toEqual(['search', 'messageMove']);
  });

  it('without MOVE and UIDPLUS: refuses when other \\Deleted messages exist', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [2], []);
    const err = await moveMessages(fakeImap(c), registry, box('INBOX'), [1], box('Archive')).catch((e: unknown) => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).code).toBe('EXPUNGE_GUARD');
    expect((err as MailError).message).toMatch(/neither MOVE nor UIDPLUS.*1 other message.*UIDs 2/);
    expect(c.methods()).toEqual(['search', 'search']);
    expect(c.calls[1]?.args).toEqual([{ deleted: true }, { uid: true }]);
  });

  it('without MOVE and UIDPLUS: proceeds when no other \\Deleted messages exist', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [], []);
    const r = await moveMessages(fakeImap(c), registry, box('INBOX'), [1, 2], box('Archive'));
    expect(r.moved).toBe(2);
    expect(c.methods()).toEqual(['search', 'search', 'messageMove']);
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

describe('permanent delete', () => {
  it('with UIDPLUS: deletes only the verified UIDs', async () => {
    const c = new FakeMailboxClient([1, 2, 3], [3], ['UIDPLUS']);
    const r = await deleteMessagesPermanently(fakeImap(c), registry, box('Deleted Messages'), [1, 4]);
    expect(r).toEqual({ mailbox: 'Deleted Messages', deleted: 1, not_found: [4] });
    expect(c.calls.at(-1)).toEqual({ method: 'messageDelete', args: [[1], { uid: true }] });
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
