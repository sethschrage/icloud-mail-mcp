/**
 * Entry point: config -> MailService -> serveStdio(buildServer), plus shutdown and last-resort
 * error handling (SPEC §2.1, §7).
 *
 * - Never crashes on a bad configuration: the tools are still listed and explain what to fix.
 * - Nothing connects at startup; the first tool call opens the IMAP connection.
 * - stdout carries only JSON-RPC. As a safety net, console methods that would print to stdout are
 *   redirected to stderr (nothing in this codebase uses them).
 * - Shutdown on stdin end, SIGTERM or SIGINT: close the MCP handle, log out of IMAP (capped at 2 s)
 *   and exit 0, with an unref'd 3 s force-exit timer.
 * - Unhandled rejections and stray socket exceptions are logged, not fatal.
 */
import { format } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { killChildProcesses } from './credentials.js';
import { errorMessage } from './errors.js';
import { log, redact } from './log.js';
import { buildServer } from './server.js';
import { MailService } from './service.js';
import { toolNamesFor } from './tools/index.js';
import { VERSION } from './version.js';

const FORCE_EXIT_MS = 3000;

function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    try {
      process.stderr.write(`${redact(format(...args))}\n`);
    } catch {
      // stderr is gone; never fall back to stdout.
    }
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = (obj: unknown) => toStderr(obj);
  console.table = (data: unknown) => toStderr(data);
  console.timeLog = (label?: string, ...data: unknown[]) => toStderr(label ?? 'default', ...data);
  console.count = (label?: string) => toStderr(`count: ${label ?? 'default'}`);
}

function main(): void {
  redirectConsoleToStderr();

  // Arguments come from the .mcpb manifest (`--attach-from-dirs <folder>...`, see config.ts).
  const service = MailService.fromEnv(process.env, {}, { argv: process.argv.slice(2) });
  for (const e of service.configErrors) log.warn(`configuration problem: ${e}`);
  for (const w of service.configWarnings) log.warn(`configuration warning: ${w}`);
  log.info('icloud-mail MCP server starting', { version: VERSION, tools: toolNamesFor(service.features).length, node: process.version });

  const handle = serveStdio(
    () => {
      log.debug('MCP server instance created');
      const server = buildServer(service);
      server.server.onclose = () => {
        // Release (not close) so the shared service stays usable should another instance follow.
        log.debug('MCP connection closed; releasing the IMAP connection');
        void service.release().catch(() => undefined);
      };
      return server;
    },
    { onerror: (err) => log.error('MCP transport error', { err: redact(errorMessage(err)) }) },
  );

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { reason });
    const force = setTimeout(() => process.exit(0), FORCE_EXIT_MS);
    force.unref();
    // A confirmation dialog still on screen would outlive the process and its answer would be lost.
    killChildProcesses();
    try {
      await handle.close();
    } catch (err) {
      log.warn('closing the MCP connection failed', { err: redact(errorMessage(err)) });
    }
    try {
      await service.close(); // IMAP LOGOUT, best effort, capped at 2 s
    } catch (err) {
      log.warn('closing the IMAP connection failed', { err: redact(errorMessage(err)) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.stdin.on('end', () => void shutdown('stdin ended'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  // The client went away mid-write: nothing can be delivered any more.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    log.warn('stdout error', { code: err.code });
    void shutdown('stdout closed');
  });

  process.on('unhandledRejection', (reason) => {
    // Typically a late rejection from a background IMAP socket or a call that already timed out.
    log.error('unhandled promise rejection (ignored)', { err: redact(errorMessage(reason)) });
  });
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    // Stray socket errors must not take the server down: the connection manager reconnects on
    // the next call. Log with the stack for diagnosis and keep serving.
    log.error('uncaught exception (server keeps running)', { code: err.code, err: redact(err.stack ?? errorMessage(err)) });
  });
}

main();
