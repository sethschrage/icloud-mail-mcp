/**
 * Minimal scripted IMAP server that advertises what iCloud advertises (no MOVE, no SPECIAL-USE, no
 * LIST-STATUS) and lists an arbitrary folder set. It speaks just enough IMAP for imapflow: LOGIN,
 * LIST/LSUB, STATUS, SELECT/EXAMINE, UID SEARCH, (UID) FETCH of UID/FLAGS/INTERNALDATE, UID COPY,
 * UID STORE, UID EXPUNGE and NOOP. Used by unit tests for iCloud behaviour the Dovecot profiles cannot
 * reproduce: name-guess conflicts, ghost \Deleted UIDs, failures between COPY and EXPUNGE, commands
 * that never get an answer, and login refusals with response codes. No TLS: clients must set
 * IMAP_ALLOW_PLAINTEXT=true (or expect STARTTLS to be required).
 */
import net from 'node:net';

export interface FakeFolder {
  path: string;
  flags?: string[];
}

export interface FakeServer {
  port: number;
  /** Every command line received, in order. */
  commands: string[];
  /** Number of LOGIN / AUTHENTICATE commands received. */
  logins(): number;
  /** Current flags of a message. */
  flagsOf(mailbox: string, uid: number): string[];
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Messages per mailbox (UIDs, ascending). */
  uids?: Record<string, number[]>;
  /** Initial flags per "mailbox/uid" key. */
  flags?: Record<string, string[]>;
  /** Reply NO to UID EXPUNGE (a transient failure after COPY + STORE succeeded). */
  failExpunge?: boolean;
  /** Reply NO to UID STORE (a failure right after COPY). */
  failStore?: boolean;
  /** Reply NO to SEARCH commands whose arguments match (e.g. /^DELETED$/). */
  failSearch?: RegExp;
  /** Override the advertised capabilities. */
  caps?: string;
  /** "Ghost" UIDs: returned by UID SEARCH DELETED (as iCloud does) but invisible to FETCH/EXISTS. */
  ghostDeleted?: number[];
  /** Commands (e.g. "UID SEARCH") that never get an answer, like a socket that died mid-command. */
  hangOn?: string[];
  /** Answer LOGIN with this (e.g. 'NO [UNAVAILABLE] Maximum number of connections'); default OK. */
  loginResponse?: string;
}

const DEFAULT_CAPS = 'IMAP4rev1 LITERAL+ UIDPLUS IDLE QUOTA';

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Expand an IMAP sequence set ("1:3,7") against the known values (for "*" and open ranges). */
function expandSet(set: string, known: readonly number[]): number[] {
  const max = known.length ? Math.max(...known) : 0;
  const out = new Set<number>();
  for (const part of set.split(',')) {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    for (const k of known) if (k >= Math.min(lo, hi) && k <= Math.max(lo, hi)) out.add(k);
  }
  return [...out].sort((x, y) => x - y);
}

export async function startFakeIcloud(folders: FakeFolder[], opts: FakeOptions = {}): Promise<FakeServer> {
  const CAPS = opts.caps ?? DEFAULT_CAPS;
  const uids: Record<string, number[]> = Object.fromEntries(Object.entries(opts.uids ?? {}).map(([k, v]) => [k, [...v]]));
  const flags = new Map<string, Set<string>>(Object.entries(opts.flags ?? {}).map(([k, v]) => [k, new Set(v)]));
  const flagSet = (mb: string, uid: number): Set<string> => {
    const key = `${mb}/${uid}`;
    let s = flags.get(key);
    if (!s) {
      s = new Set();
      flags.set(key, s);
    }
    return s;
  };
  const commands: string[] = [];
  let loginCount = 0;
  const sockets = new Set<net.Socket>();
  const unq = (a: string): string => a.trim().replace(/^"(.*)"$/, '$1');

  const server = net.createServer((sock) => {
    sockets.add(sock);
    let selected = '';
    sock.on('close', () => sockets.delete(sock));
    sock.setEncoding('utf8');
    sock.write(`* OK [CAPABILITY ${CAPS}] fake iCloud IMAP ready\r\n`);
    let buf = '';
    const w = (s: string): void => {
      if (!sock.destroyed) sock.write(`${s}\r\n`);
    };
    const fetchLine = (seq: number, uid: number): string =>
      `* ${seq} FETCH (UID ${uid} FLAGS (${[...flagSet(selected, uid)].join(' ')}) INTERNALDATE "01-Jan-2026 00:00:${String(uid % 60).padStart(2, '0')} +0000")`;
    const handle = (line: string): void => {
      commands.push(line);
      const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!m) return;
      const [, tag, cmdRaw, rest = ''] = m;
      let cmd = (cmdRaw ?? '').toUpperCase();
      let args = rest;
      if (cmd === 'UID') {
        const m2 = /^(\S+)\s*(.*)$/.exec(rest);
        cmd = `UID ${(m2?.[1] ?? '').toUpperCase()}`;
        args = m2?.[2] ?? '';
      }
      if (opts.hangOn?.includes(cmd)) return;
      const have = uids[selected] ?? [];
      switch (cmd) {
        case 'CAPABILITY':
          w(`* CAPABILITY ${CAPS}`);
          w(`${tag} OK done`);
          return;
        case 'LOGIN':
        case 'AUTHENTICATE':
          loginCount++;
          if (opts.loginResponse) w(`${tag} ${opts.loginResponse}`);
          else w(`${tag} OK [CAPABILITY ${CAPS}] logged in`);
          return;
        case 'LIST':
        case 'LSUB':
          if (/^""\s+""$/.test(args.trim())) {
            w(`* ${cmd} (\\Noselect) "/" ""`);
            w(`${tag} OK ${cmd} done`);
            return;
          }
          w(`* ${cmd} (\\HasNoChildren) "/" "INBOX"`);
          for (const f of folders) w(`* ${cmd} (${['\\HasNoChildren', ...(f.flags ?? [])].join(' ')}) "/" ${quote(f.path)}`);
          w(`${tag} OK ${cmd} done`);
          return;
        case 'STATUS': {
          const nm = /^("(?:[^"\\]|\\.)*"|\S+)/.exec(args);
          const box = unq(nm?.[1] ?? 'INBOX');
          w(`* STATUS ${nm?.[1] ?? '"INBOX"'} (MESSAGES ${(uids[box] ?? []).length} UNSEEN 0)`);
          w(`${tag} OK status done`);
          return;
        }
        case 'SELECT':
        case 'EXAMINE':
          selected = unq(args.split(/\s+\(/)[0] ?? args);
          w('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
          w('* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] ok');
          w(`* ${(uids[selected] ?? []).length} EXISTS`);
          w('* 0 RECENT');
          w('* OK [UIDVALIDITY 1] ok');
          w(`* OK [UIDNEXT ${Math.max(0, ...(uids[selected] ?? [])) + 1}] ok`);
          w(`${tag} OK [${cmd === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] done`);
          return;
        case 'UID SEARCH':
        case 'SEARCH': {
          if (opts.failSearch?.test(args)) {
            w(`${tag} NO [UNAVAILABLE] search failed`);
            return;
          }
          const m3 = /UID\s+(\S+)/i.exec(args);
          const wanted = m3 ? expandSet(m3[1] ?? '', have) : have;
          const deletedQuery = /(^|\s)DELETED/i.test(args) && !/UNDELETED/i.test(args);
          let hits: number[];
          if (deletedQuery) hits = [...have.filter((u) => flagSet(selected, u).has('\\Deleted')), ...(opts.ghostDeleted ?? [])];
          else hits = wanted.filter((u) => !(/UNDELETED/i.test(args) && flagSet(selected, u).has('\\Deleted')));
          w(`* SEARCH${hits.length ? ` ${hits.join(' ')}` : ''}`);
          w(`${tag} OK search done`);
          return;
        }
        case 'UID FETCH': {
          const set = args.split(/\s+/)[0] ?? '';
          for (const u of expandSet(set, have)) w(fetchLine(have.indexOf(u) + 1, u));
          w(`${tag} OK fetch done`);
          return;
        }
        case 'FETCH': {
          const set = args.split(/\s+/)[0] ?? '';
          const seqs = expandSet(
            set,
            have.map((_, i) => i + 1),
          );
          for (const s of seqs) {
            const u = have[s - 1];
            if (u !== undefined) w(fetchLine(s, u));
          }
          w(`${tag} OK fetch done`);
          return;
        }
        case 'UID COPY': {
          const src = args.split(/\s+/)[0] ?? '';
          const dest = unq(args.slice(src.length));
          const copied = expandSet(src, have);
          const target = (uids[dest] ??= []);
          const newUids = copied.map(() => {
            const n = Math.max(100, ...target) + 1;
            target.push(n);
            return n;
          });
          w(`${tag} OK [COPYUID 1 ${copied.join(',')} ${newUids.join(',')}] copied`);
          return;
        }
        case 'UID STORE': {
          if (opts.failStore) {
            w(`${tag} NO [UNAVAILABLE] Server busy, try again later`);
            return;
          }
          const set = args.split(/\s+/)[0] ?? '';
          const add = /\+FLAGS/i.test(args);
          const names = /\(([^)]*)\)/.exec(args)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
          for (const u of expandSet(set, have)) for (const f of names) (add ? flagSet(selected, u).add(f) : flagSet(selected, u).delete(f));
          w(`${tag} OK store done`);
          return;
        }
        case 'UID EXPUNGE': {
          if (opts.failExpunge) {
            w(`${tag} NO [UNAVAILABLE] Server busy, try again later`);
            return;
          }
          const set = args.split(/\s+/)[0] ?? '';
          const gone = expandSet(set, have).filter((u) => flagSet(selected, u).has('\\Deleted'));
          uids[selected] = have.filter((u) => !gone.includes(u));
          w(`${tag} OK expunged`);
          return;
        }
        case 'GETQUOTAROOT':
          w(`${tag} NO no quota`);
          return;
        case 'LOGOUT':
          w('* BYE bye');
          w(`${tag} OK bye`);
          sock.end();
          return;
        default:
          w(`${tag} OK ${cmd} done`);
      }
    };
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handle(line);
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    logins: () => loginCount,
    flagsOf: (mailbox, uid) => [...flagSet(mailbox, uid)],
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
