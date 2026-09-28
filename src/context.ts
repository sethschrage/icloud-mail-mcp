/**
 * Per-tool-call operation context (AsyncLocalStorage).
 *
 * withDeadline() runs every tool handler inside a context that carries the combined
 * deadline/cancellation AbortSignal and the absolute deadline. Code deep in the IMAP layer reads it
 * without threading a parameter through every function:
 *
 * - ImapManager tears down the shared connection when the signal fires while an IMAP command of
 *   that call is still pending (otherwise the stuck command would keep the mailbox lock and the one
 *   socket, and every later call would fail for minutes), and refuses to start new commands for an
 *   abandoned call;
 * - the Sender finishes post-send work (Sent copy, flagging the original) before the deadline, so
 *   a delivered email is never reported as a timeout.
 *
 * Work that must survive the call's deadline (e.g. finishing a Sent copy in the background) runs in
 * `detachedContext()`, which has no signal.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationContext {
  /** Fires on the tool deadline or client cancellation. */
  signal?: AbortSignal | undefined;
  /** Absolute deadline (epoch ms) of the tool call, if any. */
  deadlineAt?: number | undefined;
}

const storage = new AsyncLocalStorage<OperationContext>();

/** Run `fn` with `ctx` as the current operation context. */
export function runWithContext<T>(ctx: OperationContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The context of the current tool call (undefined outside one, e.g. in unit tests). */
export function currentContext(): OperationContext | undefined {
  return storage.getStore();
}

/** Run `fn` outside any call's signal/deadline (background work that must not be torn down). */
export function detachedContext<T>(fn: () => T): T {
  return storage.run({}, fn);
}
