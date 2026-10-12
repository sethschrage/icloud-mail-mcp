/**
 * Send and recipient limits shared by every instance of the cloud version.
 *
 * On Vercel each warm instance has its own memory, and instances come and go, so the in-process
 * RateLimiter/RecipientLimiter (smtp/send.ts) cannot enforce "at most N per hour / per day" on
 * their own. The cloud version therefore also counts in Upstash Redis (REST API, plain fetch, no
 * extra dependency):
 *
 * - three counters per account: sends per hour, recipients per hour, recipients per day;
 * - a sliding-window estimate (current fixed window + the previous one, weighted by how much of it
 *   still overlaps), so a burst at a window boundary cannot double the limit;
 * - reserve() increments first and rolls back when over a limit, so concurrent instances cannot
 *   both slip under it; a send that then fails releases its reservation;
 * - fail closed: if Upstash cannot be reached, nothing is sent (drafts still work).
 *
 * Account keys are a hash of the email address, never the address itself.
 */
import { createHash } from 'node:crypto';
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
    this.prefix = `icloud-mail:v1:${accountKey(opts.email)}`;
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.logger = opts.logger ?? defaultLogger;
  }

  private keys(m: Metric, at: number): { cur: string; prev: string; elapsed: number } {
    const index = Math.floor(at / m.windowMs);
    return { cur: `${this.prefix}:${m.name}:${index}`, prev: `${this.prefix}:${m.name}:${index - 1}`, elapsed: (at % m.windowMs) / m.windowMs };
  }

  private amount(m: Metric, recipients: number): number {
    return m.name === 'sends_h' ? 1 : recipients;
  }

  /** Sliding-window estimate: all of the current window plus the still-overlapping share of the previous one. */
  private static estimate(cur: number, prev: number, elapsed: number): number {
    return cur + prev * (1 - elapsed);
  }

  private async pipeline(commands: string[][]): Promise<Array<number | null>> {
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
      const v = r?.result;
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
  }

  async reserve(recipients: number): Promise<QuotaReservation> {
    const active = this.metrics.filter((m) => m.max > 0);
    if (active.length === 0) return NOOP_RESERVATION;
    const at = this.now();
    const commands: string[][] = [];
    const plan = active.map((m) => {
      const k = this.keys(m, at);
      const n = this.amount(m, recipients);
      commands.push(['INCRBY', k.cur, String(n)], ['PEXPIRE', k.cur, String(m.windowMs * 2 + 60_000)], ['GET', k.prev]);
      return { m, k, n };
    });
    const results = await this.pipeline(commands);
    const decrements = plan.map(({ k, n }) => ['DECRBY', k.cur, String(n)]);
    for (let i = 0; i < plan.length; i++) {
      const { m, k, n } = plan[i] as (typeof plan)[number];
      const cur = results[i * 3] ?? n;
      const prev = results[i * 3 + 2] ?? 0;
      if (UpstashQuota.estimate(cur, prev, k.elapsed) > m.max) {
        await this.pipeline(decrements).catch((err) => this.logger.warn('could not roll back a refused send-limit reservation', { err: redact(String(err)) }));
        const remaining = Math.max(0, Math.floor(m.max - UpstashQuota.estimate(cur - n, prev, k.elapsed)));
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
        released = true;
        await this.pipeline(decrements).catch((err) => this.logger.warn('could not release a send-limit reservation', { err: redact(String(err)) }));
      },
    };
  }

  async status(): Promise<Record<string, unknown>> {
    const at = this.now();
    const plan = this.metrics.map((m) => ({ m, k: this.keys(m, at) }));
    try {
      const results = await this.pipeline(plan.flatMap(({ k }) => [['GET', k.cur], ['GET', k.prev]]));
      const out: Record<string, unknown> = { store: 'upstash' };
      plan.forEach(({ m, k }, i) => {
        const used = UpstashQuota.estimate(results[i * 2] ?? 0, results[i * 2 + 1] ?? 0, k.elapsed);
        out[m.name === 'sends_h' ? 'sends_remaining_this_hour' : m.name === 'rcpt_h' ? 'recipients_remaining_this_hour' : 'recipients_remaining_today'] =
          m.max > 0 ? Math.max(0, Math.floor(m.max - used)) : 'unlimited';
      });
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
