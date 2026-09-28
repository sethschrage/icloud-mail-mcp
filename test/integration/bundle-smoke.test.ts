/**
 * Bundle smoke test (SPEC §8): pack the real .mcpb (scripts/pack.mjs), unpack it with the mcpb
 * CLI into a temp dir outside the project (so no node_modules can be resolved), and run
 * `node server/index.js` from there over stdio against test-infra.
 *
 * The command line and env are what Claude Desktop derives from the unpacked manifest.json, computed
 * with @anthropic-ai/mcpb's getMcpConfigForManifest (the reference implementation of the
 * `${user_config.*}` substitution). Only the server endpoints and the test CA are added on top,
 * and HOME points at a temp dir so the `${HOME}` defaults can be checked.
 *
 * Two host behaviours are simulated:
 * - defaults applied: blank optional strings arrive as "", `${HOME}` in defaults stays literal
 *   (research-mcpb Gotcha B), the attach-from folders arrive as separate arguments;
 * - defaults not applied: every optional value arrives as a literal `${user_config.<key>}`
 *   (Gotcha A), which the server must treat as unset.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MANIFEST_SCHEMAS, getMcpConfigForManifest, type McpbManifestAny, type McpbUserConfigValues } from '@anthropic-ai/mcpb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNDLE_FILES, listFiles } from '../../scripts/build.mjs';
import { packMcpb, runMcpb, type PackResult } from '../../scripts/pack.mjs';
import { ATTACH_FROM_DIRS_FLAG, defaultAuditLogPath } from '../../src/config.js';
import { DEFAULT_TOOLS } from '../helpers/e2e.js';
import { ACCOUNT, CA_FILE, PASSWORD, PROJECT_ROOT, resetMailServer } from '../helpers/infra.js';
import { json, leadingJson, startMcp, type McpSession } from '../helpers/mcp.js';

let tmp: string;
let unpacked: string;
let home: string;
let packed: PackResult;
let manifest: McpbManifestAny;

const REQUIRED_ONLY: McpbUserConfigValues = { icloud_email: ACCOUNT, app_specific_password: PASSWORD };

/** Server endpoints and trust for test-infra: the only values not coming from the manifest. */
function infraEnv(): Record<string, string> {
  return {
    IMAP_HOST: '127.0.0.1',
    IMAP_PORT: '1993',
    IMAP_SECURE: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1587',
    SMTP_SECURE: 'false',
    MAIL_TLS_CA_FILE: CA_FILE,
    MAIL_TIMEZONE: 'America/Los_Angeles',
    HOME: home,
  };
}

/** Start the unpacked server the way Claude Desktop would for this manifest and user config. */
async function startLikeClaudeDesktop(m: McpbManifestAny, userConfig: McpbUserConfigValues): Promise<{ session: McpSession; env: Record<string, string>; args: string[] }> {
  const systemDirs = { HOME: home, DESKTOP: path.join(home, 'Desktop'), DOCUMENTS: path.join(home, 'Documents'), DOWNLOADS: path.join(home, 'Downloads') };
  const cfg = await getMcpConfigForManifest({ manifest: m, extensionPath: unpacked, systemDirs, userConfig, pathSeparator: '/' });
  if (!cfg) throw new Error('the host would not start the server (required configuration missing)');
  expect(cfg.command).toBe('node');
  const env = cfg.env ?? {};
  const args = cfg.args ?? [];
  expect(args[0]).toBe(path.join(unpacked, 'server', 'index.js'));
  // Claude Desktop may start the server with "/" as the working directory.
  const session = await startMcp({ ...env, ...infraEnv() }, { args, cwd: '/' });
  return { session, env, args };
}

interface AccountInfo {
  status: string;
  imap: { login: string | null; logins_to_try: string[] };
  from: { default: string | null; name: string | null; allowed: string[] };
  features: { send: boolean; permanent_delete: boolean; read_only: boolean; confirm_dialog: boolean; rate_limit: { max_sends_per_hour: number | string } };
  limits: { max_body_chars: number };
  attachment_dir: string;
  attach_from_dirs: string[];
  audit_log: string;
  config_errors?: string[];
  config_warnings?: string[];
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'icloud-mail-bundle-'));
  unpacked = path.join(tmp, 'Claude Extensions', 'local.mcpb.seth.icloud-mail');
  home = path.join(tmp, 'home');
  mkdirSync(path.join(home, 'Documents'), { recursive: true });
  writeFileSync(path.join(home, 'Documents', 'agenda.txt'), 'agenda for the meeting\n');
  mkdirSync(path.join(tmp, 'elsewhere'));
  writeFileSync(path.join(tmp, 'elsewhere', 'secret.txt'), 'not for attaching\n');

  packed = await packMcpb({ stageDir: path.join(tmp, 'stage'), outFile: path.join(tmp, 'icloud-mail-test.mcpb'), typecheck: false, log: null });
  await runMcpb(['unpack', packed.file, unpacked]);
  manifest = MANIFEST_SCHEMAS['0.3'].parse(JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8')));
  await resetMailServer();
}, 180_000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the .mcpb archive', () => {
  it('contains only the server bundle, manifest, icon, package.json and licences', async () => {
    expect(packed.entries).toEqual([...BUNDLE_FILES]);
    expect(await listFiles(unpacked)).toEqual([...BUNDLE_FILES]);
    expect(packed.size).toBeLessThan(5 * 1024 * 1024);
    expect(JSON.parse(readFileSync(path.join(unpacked, 'package.json'), 'utf8'))).toEqual({ name: 'icloud-mail', version: packed.version, private: true, type: 'module' });
    expect(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8')).toBe(readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8'));
    expect(readFileSync(path.join(unpacked, 'icon.png')).equals(readFileSync(path.join(PROJECT_ROOT, 'icon.png')))).toBe(true);
    const server = readFileSync(path.join(unpacked, 'server', 'index.js'), 'utf8');
    expect(server.startsWith("import{createRequire as __cr}from'module';const require=__cr(import.meta.url);")).toBe(true);
    expect(server).not.toContain('sourceMappingURL');
    expect(readFileSync(path.join(unpacked, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toMatch(/imapflow@2\.1\.0 \(MIT\)/);
  });
});

describe('the unpacked server, started like Claude Desktop with only the required settings', () => {
  let s: McpSession;
  let env: Record<string, string>;
  let args: string[];
  beforeAll(async () => {
    ({ session: s, env, args } = await startLikeClaudeDesktop(manifest, REQUIRED_ONLY));
  });
  afterAll(async () => {
    await s?.close();
  });

  it('receives blank optional values, a literal ${HOME} default and one argument per attach folder', () => {
    expect(env['ICLOUD_IMAP_USER']).toBe('');
    expect(env['MAIL_FROM_ADDRESS']).toBe('');
    expect(env['MAIL_ATTACHMENT_DIR']).toBe('${HOME}/Downloads/iCloud Mail Attachments');
    expect(args.slice(1)).toEqual([ATTACH_FROM_DIRS_FLAG, '${HOME}/Desktop', '${HOME}/Documents', '${HOME}/Downloads']);
  });

  it('lists the default tool set, all of them declared in the manifest', async () => {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(DEFAULT_TOOLS);
    const declared = (manifest.tools ?? []).map((t) => t.name);
    for (const n of names) expect(declared).toContain(n);
  });

  it('expands ${HOME} and uses the manifest defaults (get_account_info)', async () => {
    const r = await s.call('get_account_info');
    expect(r.isError).toBe(false);
    const info = json<AccountInfo>(r);
    expect(info.config_errors).toBeUndefined();
    expect(info.config_warnings).toBeUndefined();
    expect(info.status).toBe('connected');
    expect(info.imap.login).toBe(ACCOUNT);
    expect(info.from).toMatchObject({ default: ACCOUNT, name: null, allowed: [ACCOUNT] });
    expect(info.features).toMatchObject({ send: true, permanent_delete: false, read_only: false, confirm_dialog: false, rate_limit: { max_sends_per_hour: 30 } });
    expect(info.limits.max_body_chars).toBe(20000);
    expect(info.attachment_dir).toBe(path.join(home, 'Downloads', 'iCloud Mail Attachments'));
    expect(info.attach_from_dirs).toEqual([path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')]);
    expect(info.audit_log).toBe(defaultAuditLogPath(process.platform, home));
  });

  it('lists mailboxes', async () => {
    const r = await s.call('list_mailboxes');
    expect(r.isError).toBe(false);
    const { count, mailboxes } = json<{ count: number; mailboxes: Array<{ path: string; total: number; unread: number }> }>(r);
    expect(count).toBe(9);
    expect(mailboxes[0]).toMatchObject({ path: 'INBOX', total: 29, unread: 15 });
  });

  it('searches messages', async () => {
    const newest = json<{ total: number; returned: number; messages: Array<{ uid: number; subject: string }> }>(await s.call('search_messages', { limit: 3 }));
    expect(newest).toMatchObject({ total: 29, returned: 3 });
    expect(newest.messages.map((m) => m.uid)).toEqual([29, 28, 27]);
    expect(newest.messages[0]?.subject).toBe('Weekend plans?');

    const kickoff = json<{ total: number; messages: Array<{ mailbox: string; uid: number }> }>(await s.call('search_messages', { subject: 'kickoff', all_mailboxes: true }));
    expect(kickoff.total).toBe(4);
    expect(kickoff.messages.map((m) => `${m.mailbox}/${m.uid}`).sort()).toEqual(['Drafts/1', 'INBOX/22', 'INBOX/23', 'Sent Messages/2']);
  });

  it('saves attachments under the expanded ${HOME}/Downloads/iCloud Mail Attachments', async () => {
    const r = await s.call('download_attachment', { mailbox: 'INBOX', uid: 7, part: '2' });
    expect(r.isError).toBe(false);
    const meta = leadingJson<{ path: string; filename: string }>(r.text);
    expect(meta.filename).toBe('notes.txt');
    expect(meta.path).toBe(path.join(home, 'Downloads', 'iCloud Mail Attachments', 'notes.txt'));
    expect(existsSync(meta.path)).toBe(true);
  });

  it('attaches files from the default folders (passed as arguments) and refuses others', async () => {
    const ok = await s.call('save_draft', { to: ['friend@example.com'], subject: 'Bundle smoke draft', body: 'Agenda attached.', attachments: [path.join(home, 'Documents', 'agenda.txt')] });
    expect(ok.isError).toBe(false);
    expect(json<{ saved: boolean; mailbox: string }>(ok)).toMatchObject({ saved: true, mailbox: 'Drafts' });

    const refused = await s.call('save_draft', { body: 'x', attachments: [path.join(tmp, 'elsewhere', 'secret.txt')] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/files can only be attached from these folders/);
    expect(refused.text).toContain(path.join(home, 'Documents'));
  });

  it('logs no configuration problems', () => {
    expect(s.stderr()).not.toMatch(/configuration (problem|warning)/);
    expect(s.stderr()).not.toContain(PASSWORD);
  });
});

describe('the unpacked server with every setting changed in the extension settings form', () => {
  let s: McpSession;
  let work: string;
  let downloads: string;
  beforeAll(async () => {
    work = path.join(tmp, 'Work, Inc');
    downloads = path.join(tmp, 'My Attachments');
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, 'plan.txt'), 'the plan\n');
    ({ session: s } = await startLikeClaudeDesktop(manifest, {
      ...REQUIRED_ONLY,
      imap_username: 'testuser',
      from_address: 'testuser.alias@icloud.test',
      from_name: 'Smoke Tester',
      allowed_from: 'other.alias@icloud.test',
      allow_send: false,
      allow_permanent_delete: true,
      read_only: false,
      confirm_dialog: false,
      attachment_dir: downloads,
      attach_from_dirs: [work, path.join(tmp, 'elsewhere')],
      max_body_chars: 5000,
      max_sends_per_hour: 0,
    }));
  });
  afterAll(async () => {
    await s?.close();
  });

  it('applies them all', async () => {
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('delete_messages_permanently');
    expect(names).toContain('save_draft');
    expect(names).not.toContain('send_email');
    const info = json<AccountInfo>(await s.call('get_account_info'));
    expect(info.config_errors).toBeUndefined();
    expect(info.status).toBe('connected');
    expect(info.imap.login).toBe('testuser');
    expect(info.from).toEqual({ default: 'testuser.alias@icloud.test', name: 'Smoke Tester', allowed: [ACCOUNT, 'testuser.alias@icloud.test', 'other.alias@icloud.test'] });
    expect(info.features).toMatchObject({ send: false, permanent_delete: true, read_only: false, confirm_dialog: false, rate_limit: { max_sends_per_hour: 'unlimited' } });
    expect(info.limits.max_body_chars).toBe(5000);
    expect(info.attachment_dir).toBe(downloads);
    expect(info.attach_from_dirs).toEqual([work, path.join(tmp, 'elsewhere')]);
  });

  it('attaches from the chosen folders only, and downloads into the chosen folder', async () => {
    const ok = await s.call('save_draft', { body: 'Plan attached.', attachments: [path.join(work, 'plan.txt')] });
    expect(ok.isError).toBe(false);
    const refused = await s.call('save_draft', { body: 'x', attachments: [path.join(home, 'Documents', 'agenda.txt')] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/files can only be attached from these folders/);

    const r = await s.call('download_attachment', { mailbox: 'INBOX', uid: 6, part: '2', return_content: false });
    expect(r.isError).toBe(false);
    const meta = json<{ path: string }>(r);
    expect(path.dirname(meta.path)).toBe(downloads);
    expect(existsSync(meta.path)).toBe(true);
  });
});

describe('the unpacked server when the host passes literal ${user_config.*} placeholders', () => {
  let s: McpSession;
  let env: Record<string, string>;
  let args: string[];
  beforeAll(async () => {
    const bare = structuredClone(manifest);
    for (const option of Object.values(bare.user_config ?? {})) delete option.default;
    ({ session: s, env, args } = await startLikeClaudeDesktop(bare, REQUIRED_ONLY));
  });
  afterAll(async () => {
    await s?.close();
  });

  it('receives the placeholders unexpanded', () => {
    expect(env['ICLOUD_IMAP_USER']).toBe('${user_config.imap_username}');
    expect(env['MAIL_ALLOW_SEND']).toBe('${user_config.allow_send}');
    expect(env['MAIL_MAX_BODY_CHARS']).toBe('${user_config.max_body_chars}');
    expect(env['MAIL_ATTACHMENT_DIR']).toBe('${user_config.attachment_dir}');
    expect(args.slice(1)).toEqual([ATTACH_FROM_DIRS_FLAG, '${user_config.attach_from_dirs}']);
  });

  it('treats every placeholder as unset and falls back to the defaults', async () => {
    const info = json<AccountInfo>(await s.call('get_account_info'));
    expect(info.config_errors).toBeUndefined();
    expect(info.config_warnings).toBeUndefined();
    expect(info.status).toBe('connected');
    expect(info.imap.logins_to_try).toEqual([ACCOUNT]);
    expect(info.from).toMatchObject({ default: ACCOUNT, name: null, allowed: [ACCOUNT] });
    expect(info.features).toMatchObject({ send: true, permanent_delete: false, read_only: false, confirm_dialog: false, rate_limit: { max_sends_per_hour: 30 } });
    expect(info.limits.max_body_chars).toBe(20000);
    expect(info.attachment_dir).toBe(path.join(home, 'Downloads', 'iCloud Mail Attachments'));
    expect(info.attach_from_dirs).toEqual([path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')]);
  });

  it('works normally', async () => {
    expect((await s.client.listTools()).tools.map((t) => t.name)).toEqual(DEFAULT_TOOLS);
    const r = await s.call('list_mailboxes', { include_counts: false });
    expect(r.isError).toBe(false);
    expect(json<{ count: number }>(r).count).toBe(9);
  });
});
