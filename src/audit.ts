/**
 * Append-only JSONL audit log of write actions (SPEC §3 MAIL_AUDIT_LOG, §6.6 step 7).
 * Never records message bodies or secrets. Failures to write are logged to stderr and never
 * fail the action itself (the action has already happened when we record it).
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { log as defaultLogger, redact, type Logger } from './log.js';

export interface AuditEntry {
  tool: string;
  result: 'ok' | 'partial' | 'error' | 'cancelled';
  mailbox?: string;
  uids?: number[];
  destination?: string;
  from?: string;
  recipients?: string[];
  subject?: string;
  message_id?: string;
  error?: string;
  [key: string]: unknown;
}

/** `filePath` may also be 'stdout' or 'stderr' (cloud version: the Vercel logs). */
export class AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string | null,
    private readonly logger: Logger = defaultLogger,
    private readonly writeTimeoutMs = 5000,
  ) {}

  get enabled(): boolean {
    return this.filePath !== null;
  }

  /** Append one entry. Resolves once written (or once the failure has been logged). */
  record(entry: AuditEntry): Promise<void> {
    const file = this.filePath;
    if (!file) return Promise.resolve();
    const line = `${redact(JSON.stringify({ ts: new Date().toISOString(), ...entry }, jsonReplacer))}\n`;
    if (file === 'stdout' || file === 'stderr') {
      // Cloud version: the Vercel logs are the audit log. One JSON line per entry, tagged so it can
      // be filtered (search the logs for "icloud-mail-audit").
      try {
        (file === 'stdout' ? process.stdout : process.stderr).write(`icloud-mail-audit ${line}`);
      } catch (err) {
        this.logger.warn('could not write the audit log', { file, err });
      }
      return Promise.resolve();
    }
    const append = async (): Promise<void> => {
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fsp.appendFile(file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    };
    const write = async (): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        // A wedged filesystem must never hold up tool results (or later audit entries).
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${this.writeTimeoutMs} ms`)), this.writeTimeoutMs);
          timer.unref();
        });
        await Promise.race([append(), timeout]);
      } catch (err) {
        this.logger.warn('could not write the audit log', { file, err });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    this.queue = this.queue.then(write, write);
    return this.queue;
  }
}

// Errors whose failure has already been written to the audit log by the domain layer, so the tool
// layer (which audits refused/failed write calls that never reached an audited step) does not
// record them twice.
const auditedErrors = new WeakSet<object>();

/** Mark an error as already audited; returns it unchanged (for `throw markAudited(err)`). */
export function markAudited<T>(err: T): T {
  if (err !== null && typeof err === 'object') auditedErrors.add(err);
  return err;
}

export function wasAudited(err: unknown): boolean {
  return err !== null && typeof err === 'object' && auditedErrors.has(err);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
