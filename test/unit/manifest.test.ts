/**
 * manifest.json (SPEC §9) against the code: the tools list is exactly what the server can
 * register, every user_config field reaches an env var (or argument) the server actually reads,
 * the manifest defaults produce the server's own defaults, and the versions agree.
 *
 * Variable substitution is done with @anthropic-ai/mcpb's getMcpConfigForManifest, the reference
 * implementation of what Claude Desktop does with `${user_config.*}`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MANIFEST_SCHEMAS, getMcpConfigForManifest, type McpbManifestAny, type McpbUserConfigValues } from '@anthropic-ai/mcpb';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTACH_FROM_DIRS_FLAG, SETTING_LABELS, effectiveFeatures, loadConfig, type ConfigResult } from '../../src/config.js';
import { CONFIRM_SETTING_TITLE } from '../../src/safety/confirm.js';
import { createLogger } from '../../src/log.js';
import { PROMPT_NAMES } from '../../src/prompts.js';
import { buildServer } from '../../src/server.js';
import { MailService } from '../../src/service.js';
import { ALL_TOOL_NAMES, toolNamesFor } from '../../src/tools/index.js';
import { SERVER_NAME, VERSION } from '../../src/version.js';
import { PROJECT_ROOT as ROOT, envVarsReadByConfig } from '../helpers/source.js';

const HOME = '/Users/alex';
const SYSTEM_DIRS = { HOME, DESKTOP: `${HOME}/Desktop`, DOCUMENTS: `${HOME}/Documents`, DOWNLOADS: `${HOME}/Downloads` };
const EXTENSION_PATH = `${HOME}/Library/Application Support/Claude/Claude Extensions/local.mcpb.seth.icloud-mail`;

const rawManifest: unknown = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const manifest = MANIFEST_SCHEMAS['0.3'].parse(rawManifest);
const REQUIRED_ONLY: McpbUserConfigValues = { icloud_email: 'me@icloud.com', app_specific_password: 'abcd-efgh-ijkl-mnop' };

/** The env and argv Claude Desktop would start the server with, as a loaded server config. */
async function hostConfig(userConfig: McpbUserConfigValues, m: McpbManifestAny = manifest): Promise<{ result: ConfigResult; env: Record<string, string>; args: string[] }> {
  const cfg = await getMcpConfigForManifest({ manifest: m, extensionPath: EXTENSION_PATH, systemDirs: SYSTEM_DIRS, userConfig, pathSeparator: '/' });
  if (!cfg) throw new Error('required configuration missing');
  const env = cfg.env ?? {};
  const args = cfg.args ?? [];
  const result = loadConfig(env, { platform: 'darwin', home: HOME, systemTimezone: 'Europe/Berlin', argv: args.slice(1) });
  return { result, env, args };
}

describe('manifest.json identity', () => {
  it('matches SPEC §9 and the package version', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(manifest.manifest_version).toBe('0.3');
    expect(manifest.name).toBe(SERVER_NAME);
    expect(manifest.display_name).toBe('iCloud Mail');
    expect(manifest.author).toEqual({ name: 'Seth' });
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.version).toBe(VERSION);
    expect(manifest.icon).toBe('icon.png');
    expect(manifest.compatibility).toEqual({ platforms: ['darwin'], runtimes: { node: '>=20.0.0' } });
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.entry_point).toBe('server/index.js');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args?.[0]).toBe('${__dirname}/server/index.js');
  });
});

describe('manifest.json tools and prompts', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'icloud-mail-mcp-manifest-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const manifestTools = (manifest.tools ?? []).map((t) => t.name);

  it('lists every tool the server can register, exactly once, and nothing else', () => {
    expect(new Set(manifestTools).size).toBe(manifestTools.length);
    expect([...manifestTools].sort()).toEqual([...ALL_TOOL_NAMES].sort());
    expect(manifest.tools_generated).toBe(false);
    for (const t of manifest.tools ?? []) expect(t.description?.length ?? 0).toBeGreaterThan(10);
  });

  it('equals the tools a server with every feature enabled actually registers, and covers every mode', async () => {
    const quiet = createLogger({ level: 'error', sink: () => undefined });
    const env = { ICLOUD_EMAIL: 'me@icloud.com', ICLOUD_APP_PASSWORD: 'x', MAIL_AUDIT_LOG: 'off', MAIL_ALLOW_PERMANENT_DELETE: 'true' };
    const svc = new MailService(loadConfig(env, { platform: 'linux', home: root }), { logger: quiet, platform: 'linux' });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await buildServer(svc).connect(serverSide);
    const client = new Client({ name: 'manifest-test', version: '1' });
    await client.connect(clientSide);
    try {
      const registered = (await client.listTools()).tools.map((t) => t.name);
      expect([...registered].sort()).toEqual([...manifestTools].sort());

      const prompts = (await client.listPrompts()).prompts;
      expect(prompts.map((p) => p.name).sort()).toEqual([...PROMPT_NAMES].sort());
      for (const declared of manifest.prompts ?? []) {
        const live = prompts.find((p) => p.name === declared.name);
        expect(live?.arguments?.map((a) => a.name)).toEqual(declared.arguments ?? []);
        for (const arg of declared.arguments ?? []) expect(declared.text).toContain(`\${arguments.${arg}}`);
      }
    } finally {
      await client.close();
    }

    for (const flags of [
      { readOnly: false, allowSend: true, allowPermanentDelete: false },
      { readOnly: false, allowSend: false, allowPermanentDelete: true },
      { readOnly: true, allowSend: true, allowPermanentDelete: true },
    ]) {
      const { config } = loadConfig({}, { platform: 'linux', home: root });
      const names = toolNamesFor(effectiveFeatures({ ...config, ...flags }));
      for (const n of names) expect(manifestTools).toContain(n);
    }
  });
});

describe('manifest.json user_config', () => {
  const userConfig = manifest.user_config ?? {};

  it('exposes exactly the SPEC §9 fields, with a default for every optional field', () => {
    expect(Object.keys(userConfig).sort()).toEqual(
      [
        'icloud_email',
        'app_specific_password',
        'imap_username',
        'from_address',
        'from_name',
        'allowed_from',
        'allow_send',
        'allow_permanent_delete',
        'read_only',
        'confirm_dialog',
        'attachment_dir',
        'attach_from_dirs',
        'max_body_chars',
        'max_sends_per_hour',
        'max_recipients_per_hour',
        'max_recipients_per_day',
        'sent_mailbox',
        'trash_mailbox',
        'drafts_mailbox',
        'archive_mailbox',
        'junk_mailbox',
      ].sort(),
    );
    expect(userConfig['icloud_email']).toMatchObject({ type: 'string', required: true });
    expect(userConfig['app_specific_password']).toMatchObject({ type: 'string', required: true, sensitive: true });
    expect(userConfig['attachment_dir']?.type).toBe('directory');
    expect(userConfig['attach_from_dirs']).toMatchObject({ type: 'directory', multiple: true });
    for (const [key, option] of Object.entries(userConfig)) {
      if (option.required) continue;
      expect(option.default, `${key} needs a default`).toBeDefined();
      if (option.type === 'string') expect(option.default, `${key}`).toBe('');
    }
    expect(userConfig['allow_send']?.default).toBe(true);
    expect(userConfig['allow_permanent_delete']?.default).toBe(false);
    expect(userConfig['read_only']?.default).toBe(false);
    expect(userConfig['confirm_dialog']?.default).toBe(false);
  });

  // integ-7 / docs-8: error messages name the settings the user actually sees.
  it('uses the manifest titles in error messages (SETTING_LABELS, CONFIRM_SETTING_TITLE)', () => {
    const env = (manifest.server?.mcp_config?.env ?? {}) as Record<string, string>;
    expect(SETTING_LABELS['MAIL_ATTACH_FROM_DIRS']).toBe(userConfig['attach_from_dirs']?.title);
    for (const [envVar, label] of Object.entries(SETTING_LABELS)) {
      if (envVar === 'MAIL_ATTACH_FROM_DIRS') continue; // passed as --attach-from-dirs arguments
      const value = env[envVar];
      expect(value, `${envVar} is mapped in the manifest`).toBeDefined();
      const key = /\$\{user_config\.([a-z_]+)\}/.exec(value ?? '')?.[1] ?? '';
      expect(userConfig[key]?.title, envVar).toBe(label);
    }
    expect(userConfig['confirm_dialog']?.title).toBe(CONFIRM_SETTING_TITLE);
  });

  // imap-1: special-folder overrides are available to extension users.
  it('exposes the special-folder overrides', () => {
    const env = (manifest.server?.mcp_config?.env ?? {}) as Record<string, string>;
    for (const k of ['SENT', 'TRASH', 'DRAFTS', 'ARCHIVE', 'JUNK']) expect(env[`MAIL_${k}_MAILBOX`]).toMatch(/^\$\{user_config\.[a-z]+_mailbox\}$/);
  });

  it('maps every field to an env var the server reads, or to the --attach-from-dirs arguments', () => {
    const known = envVarsReadByConfig();
    expect(known.has('ICLOUD_EMAIL')).toBe(true);
    const env = manifest.server.mcp_config.env ?? {};
    const referenced: string[] = [];
    for (const [name, value] of Object.entries(env)) {
      expect(known, `${name} is not read by src/config.ts`).toContain(name);
      const m = /^\$\{user_config\.([a-z_]+)\}$/.exec(value);
      expect(m, `${name} must be exactly \${user_config.<key>}`).not.toBeNull();
      referenced.push(m?.[1] ?? '');
    }
    const args = manifest.server.mcp_config.args ?? [];
    expect(args).toEqual(['${__dirname}/server/index.js', ATTACH_FROM_DIRS_FLAG, '${user_config.attach_from_dirs}']);
    referenced.push('attach_from_dirs');
    expect(referenced.sort()).toEqual(Object.keys(userConfig).sort());
  });

  it('with only the required fields filled in, the host starts the server with the server defaults', async () => {
    const { result, env, args } = await hostConfig(REQUIRED_ONLY);
    // What the reference host really passes (research-mcpb Gotcha B: ${HOME} in defaults stays literal).
    expect(env['ICLOUD_IMAP_USER']).toBe('');
    expect(env['MAIL_ATTACHMENT_DIR']).toBe('${HOME}/Downloads/iCloud Mail Attachments');
    expect(args.slice(1)).toEqual([ATTACH_FROM_DIRS_FLAG, '${HOME}/Desktop', '${HOME}/Documents', '${HOME}/Downloads']);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const defaults = loadConfig({ ICLOUD_EMAIL: 'me@icloud.com', ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' }, { platform: 'darwin', home: HOME, systemTimezone: 'Europe/Berlin' });
    expect(result.config).toEqual(defaults.config);
    expect(result.config.attachmentDir).toBe(`${HOME}/Downloads/iCloud Mail Attachments`);
    expect(result.config.attachFromDirs).toEqual([`${HOME}/Desktop`, `${HOME}/Documents`, `${HOME}/Downloads`]);
  });

  it('treats literal ${user_config.*} placeholders (optional fields without defaults) as unset', async () => {
    const bare = structuredClone(manifest);
    for (const option of Object.values(bare.user_config ?? {})) delete option.default;
    const { result, env, args } = await hostConfig(REQUIRED_ONLY, bare);
    expect(env['ICLOUD_IMAP_USER']).toBe('${user_config.imap_username}');
    expect(env['MAIL_ALLOW_SEND']).toBe('${user_config.allow_send}');
    expect(args.slice(1)).toEqual([ATTACH_FROM_DIRS_FLAG, '${user_config.attach_from_dirs}']);
    expect(result.errors).toEqual([]);
    const defaults = loadConfig({ ICLOUD_EMAIL: 'me@icloud.com', ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' }, { platform: 'darwin', home: HOME, systemTimezone: 'Europe/Berlin' });
    expect(result.config).toEqual(defaults.config);
  });

  it('passes every setting through to the matching config value', async () => {
    const { result } = await hostConfig({
      ...REQUIRED_ONLY,
      imap_username: 'me',
      from_address: 'hello@custom.dev',
      from_name: 'Alex Appleseed',
      allowed_from: 'alias@icloud.com, other@custom.dev',
      allow_send: false,
      allow_permanent_delete: true,
      read_only: true,
      confirm_dialog: true,
      attachment_dir: '/Volumes/Data/Mail Attachments',
      attach_from_dirs: ['/Users/alex/Work, Inc', '/Volumes/Data'],
      max_body_chars: 5000,
      max_sends_per_hour: 0,
    });
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({
      email: 'me@icloud.com',
      password: 'abcd-efgh-ijkl-mnop',
      imapUser: 'me',
      fromAddress: 'hello@custom.dev',
      fromName: 'Alex Appleseed',
      allowedFrom: ['me@icloud.com', 'hello@custom.dev', 'alias@icloud.com', 'other@custom.dev'],
      allowSend: false,
      allowPermanentDelete: true,
      readOnly: true,
      confirmDialog: true,
      attachmentDir: '/Volumes/Data/Mail Attachments',
      attachFromDirs: ['/Users/alex/Work, Inc', '/Volumes/Data'],
      maxBodyChars: 5000,
      maxSendsPerHour: 0,
    });
  });

  it('keeps number limits inside what the server accepts', async () => {
    for (const key of ['max_body_chars', 'max_sends_per_hour'] as const) {
      const option = userConfig[key];
      expect(option?.type).toBe('number');
      for (const value of [option?.min, option?.max]) {
        const { result } = await hostConfig({ ...REQUIRED_ONLY, [key]: value ?? Number.NaN });
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
      }
    }
  });
});
