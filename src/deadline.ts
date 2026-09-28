/**
 * Per-tool deadline (SPEC §2.11). Claude Desktop gives up on a tool call after ~240 s, so every
 * handler runs under an overall deadline (MAIL_OPERATION_TIMEOUT_SECONDS, default 120 s) and
 * returns an isError result instead of hanging. The AbortSignal handed to the operation fires on
 * the deadline or when the client cancels; domain methods check it before destructive steps.
 *
 * The handler also runs inside an operation context (context.ts) carrying the signal and the
 * absolute deadline: the IMAP connection manager uses it to tear down a connection whose command
 * is still pending when the call is abandoned, so the next call reconnects instead of waiting
 * behind the stuck command.
 */
import { runWithContext } from './context.js';
import { MailError } from './errors.js';

export interface DeadlineOptions {
  timeoutMs: number;
  /** The MCP request's cancellation signal (ctx.mcpReq.signal). */
  signal?: AbortSignal | undefined;
  /** Short description for the timeout message, e.g. "send_email". */
  what?: string;
}

export async function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, options: DeadlineOptions): Promise<T> {
  const controller = new AbortController();
  const parent = options.signal;
  const what = options.what ?? 'The operation';
  const deadlineAt = Date.now() + options.timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new MailError(
        'TIMEOUT',
        `${what} did not finish within ${Math.round(options.timeoutMs / 1000)} s (MAIL_OPERATION_TIMEOUT_SECONDS). iCloud may be slow right now. ` +
          'If this was a change (send, move, delete), it may still have completed: check before retrying.',
      );
      reject(err);
      controller.abort(err);
    }, options.timeoutMs);
    timer.unref();
    if (parent) {
      onParentAbort = () => {
        const err = new MailError('CANCELLED', `${what} was cancelled by the client.`);
        reject(err);
        controller.abort(err);
      };
      if (parent.aborted) onParentAbort();
      else parent.addEventListener('abort', onParentAbort, { once: true });
    }
  });
  // A rejection of `limit` after fn settled must not become an unhandled rejection.
  limit.catch(() => undefined);
  try {
    const work = runWithContext({ signal: controller.signal, deadlineAt }, () => fn(controller.signal));
    // The operation's own late rejection (after the deadline) is expected and ignored.
    work.catch(() => undefined);
    return await Promise.race([work, limit]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parent && onParentAbort) parent.removeEventListener('abort', onParentAbort);
  }
}
