/**
 * stderr logger with levels and secret redaction.
 *
 * stdout belongs to the MCP JSON-RPC stream (SPEC §2.1), so nothing in this module (or anywhere
 * else) writes to it. Registered secrets (the app-specific password and the SASL PLAIN blobs that
 * contain it) are replaced with "[REDACTED]" in every log line and in every error message that
 * passes through `redact()`.
 */
import type { Logger as ImapFlowLogger } from 'imapflow';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

const REDACTED = '[REDACTED]';

/** Registry of secret strings that must never appear in logs or tool output. */
class SecretRegistry {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined, usernames: readonly string[] = []): void {
    if (!secret) return;
    this.secrets.add(secret);
    // Variants that libraries might echo: base64 of the password, and SASL PLAIN / LOGIN blobs.
    this.secrets.add(Buffer.from(secret, 'utf8').toString('base64'));
    for (const user of usernames) {
      if (!user) continue;
      this.secrets.add(Buffer.from(`\u0000${user}\u0000${secret}`, 'utf8').toString('base64'));
      this.secrets.add(Buffer.from(`${user}\u0000${user}\u0000${secret}`, 'utf8').toString('base64'));
    }
    const stripped = secret.replace(/-/g, '');
    if (stripped.length >= 8 && stripped !== secret) this.secrets.add(stripped);
  }

  clear(): void {
    this.secrets.clear();
  }

  redact(text: string): string {
    let out = text;
    // Longest first so a secret that contains another is fully replaced.
    const sorted = [...this.secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
    for (const secret of sorted) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }
}

const secrets = new SecretRegistry();

/** Register a secret (e.g. the app-specific password) so it is redacted everywhere. */
export function registerSecret(secret: string | undefined, usernames: readonly string[] = []): void {
  secrets.add(secret, usernames);
}

/** Test helper: forget all registered secrets. */
export function clearSecrets(): void {
  secrets.clear();
}

/** Replace every registered secret in `text`. Use on any library error message before showing it. */
export function redact(text: string): string {
  return secrets.redact(text);
}

export type LogSink = (line: string) => void;

const stderrSink: LogSink = (line) => {
  try {
    process.stderr.write(line);
  } catch {
    // stderr closed: nothing sensible left to do, and we must never fall back to stdout.
  }
};

export interface Logger {
  readonly level: LogLevel;
  setLevel(level: LogLevel): void;
  enabled(level: LogLevel): boolean;
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

function safeStringify(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return { name: value.name, message: value.message, code: (value as { code?: unknown }).code };
      if (value instanceof Set) return [...(value as Set<unknown>)];
      if (value instanceof Map) return Object.fromEntries(value as Map<unknown, unknown>);
      return value;
    });
  } catch {
    return '"[unserializable]"';
  }
}

export function createLogger(options: { level?: LogLevel; sink?: LogSink; name?: string } = {}): Logger {
  let level: LogLevel = options.level ?? 'warn';
  const sink = options.sink ?? stderrSink;
  const name = options.name ?? 'icloud-mail-mcp';

  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[lvl] > LEVEL_RANK[level]) return;
    const extra = fields && Object.keys(fields).length > 0 ? ` ${safeStringify(fields)}` : '';
    const line = `${new Date().toISOString()} [${name}] ${lvl.toUpperCase()} ${msg}${extra}`;
    sink(`${redact(line).replace(/[\r\n]+/g, ' ')}\n`);
  };

  return {
    get level() {
      return level;
    },
    setLevel(next: LogLevel) {
      level = next;
    },
    enabled(lvl: LogLevel) {
      return LEVEL_RANK[lvl] <= LEVEL_RANK[level];
    },
    error: (msg, fields) => write('error', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    debug: (msg, fields) => write('debug', msg, fields),
  };
}

/** Process-wide default logger (stderr). */
export const log: Logger = createLogger({ level: 'warn' });

interface ImapLogEntry {
  msg?: unknown;
  src?: unknown;
  err?: unknown;
  code?: unknown;
  cid?: unknown;
}

function asEntry(obj: unknown): ImapLogEntry {
  return obj !== null && typeof obj === 'object' ? (obj as ImapLogEntry) : { msg: String(obj) };
}

function errSummary(err: unknown): Record<string, unknown> | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { message?: unknown; code?: unknown };
  return { message: typeof e.message === 'string' ? e.message : undefined, code: e.code };
}

/**
 * Adapter that lets imapflow log through our stderr logger without leaking content:
 * - server lines (`src: 's'`) are never logged: they can contain subjects, addresses or bodies;
 * - client command lines (`src: 'c'`) are logged at debug only (imapflow masks LOGIN/AUTHENTICATE);
 * - library warnings/errors are logged as a message + error code, never raw payloads.
 */
export function imapflowLogger(logger: Logger): ImapFlowLogger {
  const libMsg = (e: ImapLogEntry): string => (typeof e.msg === 'string' && e.src === undefined ? e.msg : 'event');
  return {
    trace: () => undefined,
    debug: (obj: unknown) => {
      if (!logger.enabled('debug')) return;
      const e = asEntry(obj);
      if (e.src === 'c' && typeof e.msg === 'string') logger.debug(`imap C: ${e.msg}`);
    },
    info: () => undefined,
    warn: (obj: unknown) => {
      const e = asEntry(obj);
      if (e.src === 's') return;
      logger.warn(`imapflow: ${libMsg(e)}`, { err: errSummary(e.err), code: e.code });
    },
    error: (obj: unknown) => {
      const e = asEntry(obj);
      if (e.src === 's') {
        logger.error('imapflow: could not parse a server response', { err: errSummary(e.err) });
        return;
      }
      logger.error(`imapflow: ${libMsg(e)}`, { err: errSummary(e.err), code: e.code });
    },
    fatal: (obj: unknown) => {
      const e = asEntry(obj);
      logger.error(`imapflow fatal: ${libMsg(e)}`, { err: errSummary(e.err) });
    },
  };
}
