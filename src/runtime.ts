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

/** Where the user changes a setting, for messages like `… in ${settingsPlace()}`. */
export function settingsPlace(): string {
  return current === 'cloud' ? "the Vercel project's environment variables" : 'the extension settings';
}
