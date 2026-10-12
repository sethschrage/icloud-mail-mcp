/**
 * Helpers for the cloud (Vercel) entry: an in-memory stand-in for Upstash Redis's REST pipeline
 * API, and an MCP client wired straight into a CloudHandler (no network, no port).
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import type { CloudHandler } from '../../src/http/handler.js';
import type { FetchFn } from '../../src/quota.js';
import { ACCOUNT, CA_FILE, PASSWORD } from './infra.js';

export const ACCESS_KEY = 'test-access-key-0123456789abcdefghijklmnopqrstuvwxyz';
export const ENDPOINT = 'https://icloud-mail.test/api/icloud-mail';

/** Parse a ZRANGEBYSCORE-style bound: -inf, +inf/inf, a number, or `(number` (exclusive). */
function parseBound(raw: string | undefined): { value: number; exclusive: boolean } {
  const s = raw ?? '';
  const exclusive = s.startsWith('(');
  const body = exclusive ? s.slice(1) : s;
  const value = body === '-inf' ? -Infinity : body === '+inf' || body === 'inf' ? Infinity : Number(body);
  if (Number.isNaN(value)) throw new Error('ERR min or max is not a float');
  return { value, exclusive };
}

function inRange(score: number, min: { value: number; exclusive: boolean }, max: { value: number; exclusive: boolean }): boolean {
  return (min.exclusive ? score > min.value : score >= min.value) && (max.exclusive ? score < max.value : score <= max.value);
}

/**
 * In-memory stand-in for Upstash Redis's REST `POST {url}/pipeline`: sorted sets (ZADD, ZREM,
 * ZREMRANGEBYSCORE, ZRANGE, ZRANGEBYSCORE) and PEXPIRE, with Redis's answers and semantics (an
 * emptied sorted set is deleted). Commands run one by one, not atomically, as Upstash does.
 */
export class FakeUpstash {
  /** key -> (member -> score). */
  readonly data = new Map<string, Map<string, number>>();
  /** key -> last PEXPIRE in ms (recorded only; nothing expires). */
  readonly ttl = new Map<string, number>();
  readonly requests: Array<{ url: string; authorization: string | undefined; commands: string[][] }> = [];
  /**
   * 'network' = fetch rejects, nothing applied; 'timeout-after-apply' = the commands are applied but
   * the answer is lost (fetch rejects with a TimeoutError); a number = that HTTP status, nothing applied.
   */
  fail: 'network' | 'timeout-after-apply' | number | null = null;
  /** When set, `fail` only applies to this many more requests, then resets to null. */
  failTimes: number | null = null;
  /** One-shot: the next request answers `{error}` for the command at this index and applies the others. */
  errorAt: number | null = null;

  readonly fetch: FetchFn = async (url, init) => {
    const commands = JSON.parse(init.body) as string[][];
    this.requests.push({ url, authorization: init.headers['authorization'], commands });
    const fail = this.fail;
    if (fail !== null && this.failTimes !== null && --this.failTimes <= 0) {
      this.fail = null;
      this.failTimes = null;
    }
    if (fail === 'network') throw new Error('getaddrinfo ENOTFOUND upstash.test');
    if (typeof fail === 'number') return { ok: false, status: fail, json: async () => ({ error: 'nope' }) };
    const errorAt = this.errorAt;
    this.errorAt = null;
    const results = commands.map((command, i) => {
      if (i === errorAt) return { error: 'ERR simulated failure' };
      try {
        return { result: this.run(command) };
      } catch (err) {
        return { error: (err as Error).message };
      }
    });
    if (fail === 'timeout-after-apply') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    return { ok: true, status: 200, json: async () => results };
  };

  private run([cmd, key = '', ...args]: string[]): unknown {
    const zset = this.data.get(key);
    const prune = () => {
      if (zset && zset.size === 0) {
        this.data.delete(key);
        this.ttl.delete(key);
      }
    };
    switch (cmd?.toUpperCase()) {
      case 'ZADD': {
        const set = zset ?? new Map<string, number>();
        let added = 0;
        for (let i = 0; i + 1 < args.length; i += 2) {
          const score = Number(args[i]);
          if (Number.isNaN(score)) throw new Error('ERR value is not a valid float');
          const member = args[i + 1] as string;
          if (!set.has(member)) added++;
          set.set(member, score);
        }
        this.data.set(key, set);
        return added;
      }
      case 'ZREM': {
        if (!zset) return 0;
        let removed = 0;
        for (const member of args) if (zset.delete(member)) removed++;
        prune();
        return removed;
      }
      case 'ZREMRANGEBYSCORE': {
        if (!zset) return 0;
        const min = parseBound(args[0]);
        const max = parseBound(args[1]);
        let removed = 0;
        for (const [member, score] of zset) {
          if (inRange(score, min, max)) {
            zset.delete(member);
            removed++;
          }
        }
        prune();
        return removed;
      }
      case 'ZRANGE': {
        const sorted = this.sorted(key);
        const len = sorted.length;
        let start = Number(args[0]);
        let stop = Number(args[1]);
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        return start > stop ? [] : sorted.slice(start, stop + 1).map(([m]) => m);
      }
      case 'ZRANGEBYSCORE': {
        const min = parseBound(args[0]);
        const max = parseBound(args[1]);
        return this.sorted(key)
          .filter(([, score]) => inRange(score, min, max))
          .map(([m]) => m);
      }
      case 'PEXPIRE': {
        if (!zset) return 0;
        this.ttl.set(key, Number(args[0]));
        return 1;
      }
      default:
        throw new Error(`ERR unknown command '${cmd}'`);
    }
  }

  /** Members of a sorted set ordered by score, then member, as Redis orders them. */
  private sorted(key: string): Array<[string, number]> {
    return [...(this.data.get(key) ?? new Map<string, number>())].sort(([ma, a], [mb, b]) => a - b || (ma < mb ? -1 : ma > mb ? 1 : 0));
  }

  /** Sum of n over the current members `<id>:<n>` of the sorted sets whose key ends with `:${metric}` (e.g. "sends_h"). */
  total(metric: string): number {
    let n = 0;
    for (const [k, set] of this.data) {
      if (!k.endsWith(`:${metric}`)) continue;
      for (const member of set.keys()) n += Number(member.slice(member.lastIndexOf(':') + 1));
    }
    return n;
  }
}

/** Vercel-style env for the cloud handler against the local test-infra servers. */
export function cloudEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    MCP_ACCESS_KEY: ACCESS_KEY,
    ICLOUD_EMAIL: ACCOUNT,
    ICLOUD_PASSWORD: PASSWORD,
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: '1993',
    IMAP_SECURE: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1587',
    SMTP_SECURE: 'false',
    MAIL_TLS_CA_FILE: CA_FILE,
    MAIL_TIMEZONE: 'America/Los_Angeles',
    MAIL_ALLOWED_FROM: 'testuser.alias@icloud.test',
    MAIL_FROM_NAME: 'Test User',
    MAIL_LOG_LEVEL: 'error',
    MAIL_AUDIT_LOG: 'off',
    UPSTASH_REDIS_REST_URL: 'https://upstash.test',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-token-123',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** An MCP client whose HTTP requests go straight into `handler`. */
export async function connectCloud(
  handler: CloudHandler,
  options: { key?: string | null; headers?: Record<string, string>; bearer?: boolean } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const key = options.key === undefined ? ACCESS_KEY : options.key;
  const url = new URL(ENDPOINT);
  const headers: Record<string, string> = { ...options.headers };
  if (key !== null && options.bearer) headers['authorization'] = `Bearer ${key}`;
  else if (key !== null) url.searchParams.set('key', key);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: async (input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)),
  });
  const client = new Client({ name: 'icloud-mail-cloud-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

export function resultText(r: unknown): string {
  const content = (r as CallToolResult).content ?? [];
  return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}
