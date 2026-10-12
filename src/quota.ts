/**
 * Send and recipient limits shared by every instance of the cloud version.
 *
 * On Vercel each warm instance has its own memory, and instances come and go, so the in-process
 * RateLimiter/RecipientLimiter (smtp/send.ts) cannot enforce "at most N per hour / per day" on
 * their own. The cloud version therefore also counts in Upstash Redis (REST API, plain fetch, no
 * extra dependency):
 *
 * - one sorted set per limit per account (sends per hour, recipients per hour, recipients per
 *   day). Each reservation adds one member `<random id>:<n>` (n = 1 send, or the recipient count)
 *   scored with the time it was made;
 * - exact rolling windows: reserve() first drops members older than the window, adds its own,
 *   then reads the set back and sums n. If that sum is over a limit it removes its own members
 *   again and refuses. A reservation is only kept when the set, including it, fits the limit, so
 *   no rolling hour (or day) ever holds more than the limit, at a window boundary or anywhere
 *   else. Two concurrent reservations near the limit can both be refused (each sees the other);
 *   that errs towards refusing, never towards letting extra mail through;
 * - removal is by member (ZREM), which is idempotent and never creates a key: a send that fails
 *   releases its reservation that way (retried on the next call if the release itself fails),
 *   and when the answer to a reservation is unclear (timeout, HTTP error, error in any command)
 *   its members are removed best-effort before the error is reported, so nothing leaks;
 * - fail closed: if Upstash cannot be reached, nothing is sent (drafts still work).
 *
 * Account keys are a hash of the email address, never the address itself.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { MailError } from './errors.js';
import { log as defaultLogger, redact, type Logger } from './log.js';

export interface QuotaReservation {
  /** Give the reservation back (the send did not happen). Safe to call more than once. */
  release(): Promise<void>;
}

export interface SharedQuota {
  readonly kind: Config['quotaStore']['kind'];
  /** Reserve one send with `recipients` recipients; throws RATE_LIMIT, CONFIG or CONNECTION. */
  reserve(recipients: number): Promise<QuotaReservation>;
  /** What is left, for get_account_info. Never throws. */
  status(): Promise<Record<string, unknown>>;
}

export type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOOP_RESERVATION: QuotaReservation = { release: async () => undefined };

interface Metric {
  name: 'sends_h' | 'rcpt_h' | 'rcpt_d';
  windowMs: number;
  max: number;
  env: string;
  what: string;
}

export function accountKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

/** No shared limits: local server, or MAIL_RATE_LIMIT_STORE=memory (the in-process limiters apply). */
export class NoSharedQuota implements SharedQuota {
  constructor(readonly kind: 'none' | 'memory') {}
  async reserve(): Promise<QuotaReservation> {
    return NOOP_RESERVATION;
  }
  async status(): Promise<Record<string, unknown>> {
    return this.kind === 'memory'
      ? { store: 'memory', note: 'Limits are counted per Vercel instance and reset when Vercel starts a fresh one (MAIL_RATE_LIMIT_STORE=memory).' }
      : { store: 'none' };
  }
}

/** Cloud with sending on but no Upstash configured: refuse sends (fail closed), explain the fix. */
export class MissingSharedQuota implements SharedQuota {
  readonly kind = 'missing' as const;
  static readonly MESSAGE =
    'Not sent: the cloud version keeps its send limits in Upstash Redis, and none is configured. Add Upstash for Redis to the Vercel project (Storage tab; it sets KV_REST_API_URL and KV_REST_API_TOKEN) and redeploy, or set MAIL_RATE_LIMIT_STORE=memory to accept per-instance limits. Drafts still work in the meantime (save_draft).';
  async reserve(): Promise<QuotaReservation> {
    throw new MailError('CONFIG', MissingSharedQuota.MESSAGE);
  }
  async status(): Promise<Record<string, unknown>> {
    return { store: 'missing', note: MissingSharedQuota.MESSAGE };
  }
}

export interface UpstashQuotaOptions {
  url: string;
  token: string;
  email: string;
  maxSendsPerHour: number;
  maxRecipientsPerHour: number;
  maxRecipientsPerDay: number;
  fetch?: FetchFn;
  now?: () => number;
  timeoutMs?: number;
  logger?: Logger;
}

export class UpstashQuota implements SharedQuota {
  readonly kind = 'upstash' as const;
  private readonly metrics: Metric[];
  private readonly prefix: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(private readonly opts: UpstashQuotaOptions) {
    this.metrics = [
      { name: 'sends_h', windowMs: HOUR, max: opts.maxSendsPerHour, env: 'MAIL_MAX_SENDS_PER_HOUR', what: 'emails per hour' },
      { name: 'rcpt_h', windowMs: HOUR, max: opts.maxRecipientsPerHour, env: 'MAIL_MAX_RECIPIENTS_PER_HOUR', what: 'recipients per hour' },
      { name: 'rcpt_d', windowMs: DAY, max: opts.maxRecipientsPerDay, env: 'MAIL_MAX_RECIPIENTS_PER_DAY', what: 'recipients per day' },
    ];
    this.prefix = `icloud-mail:v2:${accountKey(opts.email)}`;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.logger = opts.logger ?? defaultLogger;
  }

  private key(m: Metric): string {
    return `${this.prefix}:${m.name}`;
  }

  private amount(m: Metric, recipients: number): number {
    return m.name === 'sends_h' ? 1 : recipients;
  }

  /** Sum of the `n` suffixes of sorted-set members `<id>:<n>` (a ZRANGE / ZRANGEBYSCORE answer). */
  private static sum(members: unknown): number {
    if (!Array.isArray(members)) {
      throw new MailError('CONNECTION', 'Not sent: the send-limit store (Upstash Redis) gave an unexpected answer. Try again shortly, or save a draft instead.');
    }
    let total = 0;
    for (const member of members) {
      const s = String(member);
      const n = Number(s.slice(s.lastIndexOf(':') + 1));
      if (Number.isFinite(n)) total += n;
    }
    return total;
  }

  /** POST {url}/pipeline; returns each command's `result`. Any failure is a CONNECTION error. */
  private async pipeline(commands: string[][]): Promise<unknown[]> {
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(`${this.opts.url}/pipeline`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MailError('CONNECTION', `Not sent: the send-limit store (Upstash Redis) could not be reached (${redact(err instanceof Error ? err.message : String(err))}). Try again shortly, or save a draft instead.`);
    }
    if (!res.ok) {
      throw new MailError('CONNECTION', `Not sent: the send-limit store (Upstash Redis) answered HTTP ${res.status}${res.status === 401 ? ' (check the Upstash token)' : ''}. Try again shortly, or save a draft instead.`);
    }
    const body = (await res.json().catch(() => null)) as Array<{ result?: unknown; error?: unknown }> | null;
    if (!Array.isArray(body) || body.length !== commands.length) {
      throw new MailError('CONNECTION', 'Not sent: the send-limit store (Upstash Redis) gave an unexpected answer. Try again shortly, or save a draft instead.');
    }
    return body.map((r) => {
      if (r && r.error !== undefined) throw new MailError('CONNECTION', `Not sent: the send-limit store (Upstash Redis) reported an error (${String(r.error).slice(0, 200)}).`);
      return r?.result ?? null;
    });
  }

  /** Remove these members (idempotent; creates no key, so safe even if they were never added). */
  private removeCommands(members: Array<{ key: string; member: string }>): string[][] {
    return members.map(({ key, member }) => ['ZREM', key, member]);
  }

  async reserve(recipients: number): Promise<QuotaReservation> {
    const active = this.metrics.filter((m) => m.max > 0);
    if (active.length === 0) return NOOP_RESERVATION;
    const at = this.now();
    const id = randomUUID();
    const plan = active.map((m) => {
      const n = this.amount(m, recipients);
      return { m, n, key: this.key(m), member: `${id}:${n}` };
    });
    const commands = plan.flatMap(({ m, key, member }) => [
      ['ZREMRANGEBYSCORE', key, '-inf', String(at - m.windowMs)],
      ['ZADD', key, String(at), member],
      ['PEXPIRE', key, String(m.windowMs + 60_000)],
      ['ZRANGE', key, '0', '-1'],
    ]);
    const remove = this.removeCommands(plan);
    const cleanUp = (what: string) =>
      this.pipeline(remove).then(
        () => undefined,
        (err: unknown) => this.logger.warn(what, { err: redact(String(err)) }),
      );

    let used: number[];
    try {
      const results = await this.pipeline(commands);
      used = plan.map((_, i) => UpstashQuota.sum(results[i * 4 + 3]));
    } catch (err) {
      // The request may have reached Upstash and been applied: take our members back out.
      await cleanUp('could not remove a send-limit reservation after an unclear answer from the store');
      throw err;
    }
    for (let i = 0; i < plan.length; i++) {
      const { m, n } = plan[i] as (typeof plan)[number];
      const sum = used[i] as number;
      if (sum > m.max) {
        await cleanUp('could not roll back a refused send-limit reservation');
        const remaining = Math.max(0, Math.floor(m.max - (sum - n)));
        throw new MailError(
          'RATE_LIMIT',
          m.name === 'sends_h'
            ? `Send limit reached: at most ${m.max} emails per hour (${m.env}). Try again later, or save a draft instead.`
            : `Recipient limit reached: this email has ${recipients} recipient(s), but only ${remaining} more are allowed right now (at most ${m.max} ${m.what}; ${m.env}; iCloud itself allows about 1,000 recipients a day). Nothing was sent; try later, or save a draft instead.`,
        );
      }
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        try {
          await this.pipeline(remove);
          released = true;
        } catch (err) {
          this.logger.warn('could not release a send-limit reservation', { err: redact(String(err)) });
        }
      },
    };
  }

  async status(): Promise<Record<string, unknown>> {
    const at = this.now();
    const active = this.metrics.filter((m) => m.max > 0);
    try {
      const results = active.length
        ? await this.pipeline(active.map((m) => ['ZRANGEBYSCORE', this.key(m), `(${at - m.windowMs}`, '+inf']))
        : [];
      const out: Record<string, unknown> = { store: 'upstash' };
      for (const m of this.metrics) {
        const i = active.indexOf(m);
        out[m.name === 'sends_h' ? 'sends_remaining_this_hour' : m.name === 'rcpt_h' ? 'recipients_remaining_this_hour' : 'recipients_remaining_today'] =
          i < 0 ? 'unlimited' : Math.max(0, Math.floor(m.max - UpstashQuota.sum(results[i])));
      }
      return out;
    } catch (err) {
      return { store: 'upstash', error: err instanceof MailError ? err.message : 'unreachable' };
    }
  }
}

/** The shared quota for a configuration (one per MailService, i.e. per iCloud account). */
export function createSharedQuota(config: Config, deps: { fetch?: FetchFn; now?: () => number; logger?: Logger } = {}): SharedQuota {
  const store = config.quotaStore;
  switch (store.kind) {
    case 'upstash':
      return new UpstashQuota({
        url: store.url,
        token: store.token,
        email: config.email,
        maxSendsPerHour: config.maxSendsPerHour,
        maxRecipientsPerHour: config.maxRecipientsPerHour,
        maxRecipientsPerDay: config.maxRecipientsPerDay,
        ...deps,
      });
    case 'missing':
      return new MissingSharedQuota();
    case 'memory':
      return new NoSharedQuota('memory');
    default:
      return new NoSharedQuota('none');
  }
}
