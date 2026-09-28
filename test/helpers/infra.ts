/**
 * Helpers for integration tests against the local test-infra mail server (see test-infra/README.md).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { promisify } from 'node:util';
import { ImapFlow } from 'imapflow';
import { loadConfig, type ConfigResult } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { MailService, type MailServiceDeps } from '../../src/service.js';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEST_INFRA = path.join(PROJECT_ROOT, 'test-infra');
export const CA_FILE = path.join(TEST_INFRA, 'certs', 'ca.crt');
export const SMTP_OUT = path.join(TEST_INFRA, 'smtp-out');
export const ACCOUNT = 'testuser@icloud.test';
export const PASSWORD = 'app-specific-pass';

/** Reset the main instance (stop, wipe, start, seed): canonical UIDs afterwards. */
export async function resetMailServer(): Promise<void> {
  await execFileAsync(path.join(TEST_INFRA, 'reset.sh'), [], { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
}

/** iCloud-fidelity profiles (test-infra README "iCloud-fidelity profiles"): IMAPS ports. */
export const PROFILES = { icloud: 2993, 'no-uidplus': 3993 } as const;
export type ProfileName = keyof typeof PROFILES;

/** Reset one profile (its own Dovecot instance; never touches the main instance). */
export async function resetProfile(name: ProfileName): Promise<void> {
  await execFileAsync(path.join(TEST_INFRA, 'reset.sh'), ['--profile', name], { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
}

/** True if something accepts TCP connections on 127.0.0.1:port. */
export function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Whether profile-dependent tests may be skipped: only when the profile is down AND the run opted
 * in with ALLOW_PROFILE_SKIP=1 (the integration globalSetup otherwise starts the profiles or fails).
 */
export function skipProfile(up: boolean): boolean {
  return !up && process.env['ALLOW_PROFILE_SKIP'] === '1';
}

export interface ManifestMessage {
  uid: number;
  key: string;
  messageId: string;
  subject: string | null;
  from: string;
  date: string;
  flags: string[];
  size: number;
  note: string;
}

export interface Manifest {
  account: { name: string; address: string };
  mailboxes: Record<string, { specialUse: string | null; count: number; unseen: number; messages: ManifestMessage[] }>;
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(TEST_INFRA, 'fixtures', 'manifest.json'), 'utf8')) as Manifest;
}

export function fixture(key: string): ManifestMessage & { mailbox: string } {
  const m = loadManifest();
  for (const [mailbox, box] of Object.entries(m.mailboxes)) {
    const msg = box.messages.find((x) => x.key === key);
    if (msg) return { ...msg, mailbox };
  }
  throw new Error(`fixture ${key} not found`);
}

export interface TestDirs {
  root: string;
  attachmentDir: string;
  attachFrom: string;
  auditLog: string;
}

export function makeTestDirs(): TestDirs {
  const root = mkdtempSync(path.join(os.tmpdir(), 'icloud-mail-mcp-test-'));
  const attachFrom = path.join(root, 'Documents');
  mkdirSync(attachFrom, { recursive: true });
  return { root, attachmentDir: path.join(root, 'Attachments'), attachFrom, auditLog: path.join(root, 'audit.jsonl') };
}

export function cleanupDirs(dirs: TestDirs): void {
  rmSync(dirs.root, { recursive: true, force: true });
}

/** Environment for the main test-infra instance: IMAPS 1993 + SMTP 1587 STARTTLS with the test CA. */
export function testEnv(dirs: TestDirs, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ICLOUD_EMAIL: ACCOUNT,
    ICLOUD_APP_PASSWORD: PASSWORD,
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: '1993',
    IMAP_SECURE: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1587',
    SMTP_SECURE: 'false',
    MAIL_TLS_CA_FILE: CA_FILE,
    MAIL_ATTACHMENT_DIR: dirs.attachmentDir,
    MAIL_ATTACH_FROM_DIRS: dirs.attachFrom,
    MAIL_AUDIT_LOG: dirs.auditLog,
    MAIL_TIMEZONE: 'America/Los_Angeles',
    MAIL_ALLOWED_FROM: 'testuser.alias@icloud.test',
    MAIL_FROM_NAME: 'Test User',
    MAIL_LOG_LEVEL: 'error',
    ...overrides,
  };
}

export function testConfig(dirs: TestDirs, overrides: Record<string, string | undefined> = {}): ConfigResult {
  return loadConfig(testEnv(dirs, overrides), { platform: 'linux', home: dirs.root });
}

export const quietLogger = createLogger({ level: 'error', sink: () => undefined });

export function createTestService(dirs: TestDirs, overrides: Record<string, string | undefined> = {}, deps: MailServiceDeps = {}): MailService {
  return new MailService(testConfig(dirs, overrides), { logger: quietLogger, platform: 'linux', pathContext: { home: dirs.root }, ...deps });
}

/** Independent raw client for verifying server state (not using our code paths). */
export async function withRawImap<T>(fn: (client: ImapFlow) => Promise<T>, port = 1993): Promise<T> {
  const client = new ImapFlow({
    host: '127.0.0.1',
    port,
    secure: true,
    tls: { ca: readFileSync(CA_FILE, 'utf8') },
    auth: { user: ACCOUNT, pass: PASSWORD },
    logger: false,
  });
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function rawFlags(mailbox: string, uid: number, port = 1993): Promise<string[] | null> {
  return withRawImap(async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
      return msg ? [...(msg.flags ?? [])].sort() : null;
    } finally {
      lock.release();
    }
  }, port);
}

export async function rawUidsByMessageId(mailbox: string, messageId: string, port = 1993): Promise<number[]> {
  return withRawImap(async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const r = await client.search({ header: { 'message-id': messageId }, deleted: false }, { uid: true });
      return (r || []).sort((a, b) => a - b);
    } finally {
      lock.release();
    }
  }, port);
}

export async function rawStatus(mailbox: string, port = 1993): Promise<{ messages: number; unseen: number }> {
  return withRawImap(async (client) => {
    const st = await client.status(mailbox, { messages: true, unseen: true });
    return { messages: st ? (st.messages ?? 0) : 0, unseen: st ? (st.unseen ?? 0) : 0 };
  }, port);
}

/** Set or clear \\Deleted on a message without expunging (to exercise the expunge guard). */
export async function rawSetDeleted(mailbox: string, uid: number, deleted: boolean, port = 1993): Promise<void> {
  await withRawImap(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (deleted) await client.messageFlagsAdd([uid], ['\\Deleted'], { uid: true });
      else await client.messageFlagsRemove([uid], ['\\Deleted'], { uid: true });
    } finally {
      lock.release();
    }
  }, port);
}

export async function rawSource(mailbox: string, uid: number): Promise<Buffer | null> {
  return withRawImap(async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      return msg && msg.source ? msg.source : null;
    } finally {
      lock.release();
    }
  });
}

export interface SmtpSidecar {
  file: string;
  size: number;
  envelope: { mailFrom: string; rcptTo: string[] };
  auth: { user: string | null };
  tls: { starttls: boolean };
  headers: {
    messageId: string | null;
    subject: string | null;
    from: string[];
    to: string[];
    cc: string[];
    bcc: string[];
    inReplyTo: string | null;
    references: string | string[] | null;
    attachments: Array<{ filename: string | null; contentType: string; size: number }>;
  } | null;
}

export function listSidecars(): string[] {
  if (!existsSync(SMTP_OUT)) return [];
  return readdirSync(SMTP_OUT)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

export function readSidecar(file: string): SmtpSidecar {
  return JSON.parse(readFileSync(path.join(SMTP_OUT, file), 'utf8')) as SmtpSidecar;
}

export function readEml(sidecar: SmtpSidecar): string {
  return readFileSync(path.join(SMTP_OUT, sidecar.file), 'utf8');
}

/** Sidecars written after `before` (a previous listSidecars() snapshot), matching the Message-ID. */
export function findSidecarByMessageId(messageId: string): SmtpSidecar | undefined {
  for (const f of listSidecars().reverse()) {
    const s = readSidecar(f);
    if (s.headers?.messageId === messageId) return s;
  }
  return undefined;
}
