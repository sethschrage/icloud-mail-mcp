/**
 * Vercel entry (bundled to build/vercel/handler.mjs by scripts/build-vercel.mjs and re-exported by
 * api/icloud-mail.js): GET/POST/DELETE web handlers for https://<project>.vercel.app/api/icloud-mail.
 */
import { errorMessage } from '../errors.js';
import { log, redact } from '../log.js';
import { setRuntime } from '../runtime.js';
import { createCloudHandler } from './handler.js';

setRuntime('cloud');

// A late rejection from a background IMAP socket must not take the instance down.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection (ignored)', { err: redact(errorMessage(reason)) });
});

const handler = createCloudHandler({ env: process.env });

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
