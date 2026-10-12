/**
 * Vercel entry (bundled to build/vercel/handler.mjs by scripts/build-vercel.mjs and re-exported by
 * api/icloud-mail.js): GET/POST/DELETE web handlers for https://<project>.vercel.app/api/icloud-mail.
 */
import { errorMessage } from '../errors.js';
import { log, redact } from '../log.js';
import { setKeepAlive, setRuntime } from '../runtime.js';
import { createCloudHandler } from './handler.js';

setRuntime('cloud');
// Post-send work (the Sent copy) can outlive the tool call; waitUntil keeps the instance running
// for it. This is what `waitUntil` from @vercel/functions does (wait-until.js / get-context.js),
// without that package's dependencies: Vercel exposes the current request's context on a
// well-known global symbol. Outside a Vercel request there is no context and nothing happens.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
type VercelRequestContext = { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined };
setKeepAlive((work) => {
  const ctx = (globalThis as Record<symbol, VercelRequestContext | undefined>)[REQUEST_CONTEXT]?.get?.();
  if (!ctx?.waitUntil) throw new Error('no Vercel request context');
  ctx.waitUntil(work);
});

// A late rejection from a background IMAP socket must not take the instance down.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection (ignored)', { err: redact(errorMessage(reason)) });
});

const handler = createCloudHandler({ env: process.env });

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
