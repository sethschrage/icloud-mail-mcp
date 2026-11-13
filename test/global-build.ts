/**
 * vitest globalSetup for the integration project:
 * - bundle the server once (build/dev/index.js) so the end-to-end tests spawn the compiled server
 *   built from the current source;
 * - make sure the iCloud-fidelity profiles (test-infra "icloud" and "no-uidplus") are running. Their
 *   suites cover the real-iCloud code paths (no MOVE, no SPECIAL-USE, no UIDPLUS), so a run without
 *   them must not pass silently: they are started if needed, and the run fails if they still are not
 *   up. Set ALLOW_PROFILE_SKIP=1 to skip those suites deliberately;
 * - the same for the Radicale CalDAV server (test-infra/caldav.sh, port 5232) behind the calendar
 *   suites: started if needed, and the run fails without it unless ALLOW_CALDAV_SKIP=1.
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildDev } from '../scripts/build-dev.mjs';

const TEST_INFRA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-infra');
const PROFILE_PORTS = [2993, 3993];
const CALDAV_PORT = 5232;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function profilesUp(): Promise<boolean> {
  return (await Promise.all(PROFILE_PORTS.map(portOpen))).every(Boolean);
}

async function ensureCaldav(): Promise<void> {
  if (process.env['ALLOW_CALDAV_SKIP'] === '1' || (await portOpen(CALDAV_PORT))) return;
  try {
    await promisify(execFile)(path.join(TEST_INFRA, 'caldav.sh'), ['start'], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  } catch {
    // reported below
  }
  if (!(await portOpen(CALDAV_PORT))) {
    throw new Error(
      'The CalDAV test server is not running (port 5232). Install Radicale (apt-get install -y radicale) and start it with `cd test-infra && ./caldav.sh start`, or set ALLOW_CALDAV_SKIP=1 to skip the calendar tests deliberately.',
    );
  }
}

export default async function setup(): Promise<void> {
  await buildDev();
  await ensureCaldav();
  if (process.env['ALLOW_PROFILE_SKIP'] === '1') return;
  if (await profilesUp()) return;
  try {
    await promisify(execFile)(path.join(TEST_INFRA, 'start.sh'), ['--profile', 'all'], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  } catch {
    // reported below
  }
  if (!(await profilesUp())) {
    throw new Error(
      'The iCloud-fidelity test profiles are not running (ports 2993/3993). Start them with `cd test-infra && ./reset.sh --profile all`, or set ALLOW_PROFILE_SKIP=1 to skip their tests deliberately.',
    );
  }
}
