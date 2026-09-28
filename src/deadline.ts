/**
 * Per-tool deadline (SPEC §2.11). Claude Desktop gives up on a tool call after ~240 s, so every
 * handler runs under an overall deadline (MAIL_OPERATION_TIMEOUT_SECONDS, default 120 s) and
 * returns an isError result instead of hanging. The AbortSignal handed to the operation fires on
 * the deadline or when the client cancels; domain methods check it before destructive steps.
 */
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
  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new MailError('TIMEOUT', 'deadline'));
      reject(
        new MailError(
          'TIMEOUT',
          `${what} did not finish within ${Math.round(options.timeoutMs / 1000)} s (MAIL_OPERATION_TIMEOUT_SECONDS). iCloud may be slow right now. ` +
            'If this was a change (send, move, delete), it may still have completed: check before retrying.',
        ),
      );
    }, options.timeoutMs);
    timer.unref();
    if (parent) {
      onParentAbort = () => {
        controller.abort(parent.reason);
        reject(new MailError('CANCELLED', `${what} was cancelled by the client.`));
      };
      if (parent.aborted) onParentAbort();
      else parent.addEventListener('abort', onParentAbort, { once: true });
    }
  });
  try {
    return await Promise.race([fn(controller.signal), limit]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parent && onParentAbort) parent.removeEventListener('abort', onParentAbort);
  }
}
