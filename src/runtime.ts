/**
 * Which way this process is deployed, for wording that differs between the two:
 * - 'local': stdio server started by Claude Desktop (.mcpb extension) or Claude Code on a Mac;
 *   settings live in the extension settings form (or the env of a manual install).
 * - 'cloud': HTTP server on Vercel (src/http); settings are the Vercel project's env vars and the
 *   iCloud login can also arrive in connector headers.
 *
 * A process is one or the other for its whole life, so this is a module-level switch set once by
 * the entry point (src/http/vercel.ts calls setRuntime('cloud')).
 */
export type Runtime = 'local' | 'cloud';

let current: Runtime = 'local';

export function setRuntime(runtime: Runtime): void {
  current = runtime;
}

export function getRuntime(): Runtime {
  return current;
}

type KeepAlive = (work: Promise<unknown>) => void;
let keepAliveHook: KeepAlive | null = null;

/** The cloud entry registers Vercel's waitUntil here, so work that outlives a response still finishes. */
export function setKeepAlive(hook: KeepAlive | null): void {
  keepAliveHook = hook;
}

/**
 * Keep the instance running until `work` settles, where the platform supports it (Vercel's
 * waitUntil); a no-op locally, where the process stays up anyway. Returns whether a hook took it.
 */
export function keepAlive(work: Promise<unknown>): boolean {
  if (!keepAliveHook) return false;
  try {
    keepAliveHook(work.catch(() => undefined));
    return true;
  } catch {
    return false;
  }
}

/** Where the user changes a setting, for messages like `… in ${settingsPlace()}`. */
export function settingsPlace(): string {
  return current === 'cloud' ? "the Vercel project's environment variables" : 'the extension settings';
}
