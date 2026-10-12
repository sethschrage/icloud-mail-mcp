import { promises as fsp, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/audit.js';
import { clearSecrets, createLogger, imapflowLogger, redact, registerSecret } from '../../src/log.js';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT } from '../helpers/infra.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'log-audit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => clearSecrets());

describe('logger', () => {
  it('filters by level and writes single lines to the sink', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.debug('d');
    log.info('i');
    log.warn('w', { a: 1, big: 2n });
    log.error('e\nmultiline');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[icloud-mail-mcp\] WARN w \{"a":1,"big":"2"\}\n$/);
    expect(lines[1]).toMatch(/ERROR e multiline\n$/);
    log.setLevel('debug');
    log.debug('now visible');
    expect(lines).toHaveLength(3);
  });

  it('redacts registered secrets and their SASL/base64 forms', () => {
    registerSecret('abcd-efgh-ijkl-mnop', ['me@icloud.com']);
    const plain = Buffer.from('\u0000me@icloud.com\u0000abcd-efgh-ijkl-mnop').toString('base64');
    expect(redact(`pass=abcd-efgh-ijkl-mnop sasl=${plain} nohyphen=abcdefghijklmnop`)).toBe('pass=[REDACTED] sasl=[REDACTED] nohyphen=[REDACTED]');
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l) }).error('failed with abcd-efgh-ijkl-mnop', { err: new Error('abcd-efgh-ijkl-mnop') });
    expect(lines.join('')).not.toContain('abcd-efgh-ijkl-mnop');
  });

  it('writes to stderr, never stdout', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      createLogger({ level: 'debug' }).error('to stderr');
      expect(err).toHaveBeenCalled();
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('imapflow adapter drops server lines and logs client commands only at debug', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    const adapter = imapflowLogger(log);
    adapter.debug({ src: 'c', msg: '1 UID FETCH 1 (BODY.PEEK[])' });
    adapter.debug({ src: 's', msg: '* 1 FETCH (BODY[] {10} secret body)' });
    adapter.warn({ src: 's', msg: 'server said secret' });
    adapter.error({ src: 's', msg: 'raw payload with body text', err: new Error('parse') });
    adapter.warn({ msg: 'Mailbox lock held for a long time' });
    expect(lines.join('')).not.toContain('secret');
    expect(lines.join('')).not.toContain('payload');
    expect(lines.join('')).toContain('Mailbox lock held');
    log.setLevel('debug');
    adapter.debug({ src: 'c', msg: '2 UID SEARCH UNDELETED' });
    expect(lines.join('')).toContain('imap C: 2 UID SEARCH UNDELETED');
  });

  it('no console.log / stdout writes anywhere in src', () => {
    let out = '';
    try {
      out = execFileSync('grep', ['-rnE', 'console\\.(log|info|debug)|process\\.stdout', path.join(PROJECT_ROOT, 'src')], { encoding: 'utf8' });
    } catch (e) {
      // grep exits 1 when nothing matches
      if ((e as { status?: number }).status !== 1) throw e;
    }
    const offending = out
      .split('\n')
      .filter((l) => l && !/^\S+:\d+:\s*(\/\/|\*|\/\*)/.test(l))
      // index.ts redirects these console methods to stderr (assignment, not a call) and listens
      // for EPIPE on stdout; neither writes to stdout.
      .filter((l) => !/^\S+\/src\/index\.ts:\d+:\s*(console\.(log|info|debug) = toStderr;|process\.stdout\.on\('error',)/.test(l))
      // The cloud version's audit sink (MAIL_AUDIT_LOG=stdout, i.e. the Vercel logs). loadConfig
      // refuses "stdout" for the local stdio server, where stdout carries the MCP protocol.
      .filter((l) => !/^\S+\/src\/audit\.ts:\d+:\s*\(file === 'stdout' \? process\.stdout : process\.stderr\)\.write\(/.test(l));
    expect(offending).toEqual([]);
  });
});

describe('audit log', () => {
  it('appends JSONL entries with a timestamp, creating the directory privately', async () => {
    const file = path.join(dir, 'nested', 'audit.jsonl');
    const audit = new AuditLog(file, createLogger({ sink: () => undefined }));
    await Promise.all([audit.record({ tool: 'send_email', result: 'ok', message_id: '<a@b>', recipients: ['x@example.com'] }), audit.record({ tool: 'move_messages', result: 'error', error: 'nope' })]);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l['tool'])).toEqual(['send_email', 'move_messages']);
    expect(lines[0]).toMatchObject({ result: 'ok', message_id: '<a@b>', recipients: ['x@example.com'] });
    expect(typeof lines[0]?.['ts']).toBe('string');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('redacts secrets and is a no-op when disabled', async () => {
    registerSecret('secret-pw-99');
    const file = path.join(dir, 'a2.jsonl');
    await new AuditLog(file).record({ tool: 't', result: 'error', error: 'bad secret-pw-99' });
    expect(readFileSync(file, 'utf8')).not.toContain('secret-pw-99');
    const off = new AuditLog(null);
    expect(off.enabled).toBe(false);
    await off.record({ tool: 't', result: 'ok' });
  });

  it('never throws when the file cannot be written', async () => {
    const warnings: string[] = [];
    const blocker = path.join(dir, 'a-regular-file');
    writeFileSync(blocker, 'x');
    const audit = new AuditLog(path.join(blocker, 'sub', 'audit.jsonl'), createLogger({ sink: (l) => warnings.push(l) }));
    await audit.record({ tool: 't', result: 'ok' });
    expect(warnings.join('')).toMatch(/could not write the audit log/);
  });

  it('gives up on a wedged write after the timeout and keeps later entries flowing', async () => {
    const warnings: string[] = [];
    const file = path.join(dir, 'hung', 'audit.jsonl');
    const hung = new AuditLog(file, createLogger({ sink: (l) => warnings.push(l) }), 200);
    // A hung filesystem: appends that never settle.
    const append = vi.spyOn(fsp, 'appendFile').mockImplementation(() => new Promise<void>(() => {}));
    const started = Date.now();
    try {
      await hung.record({ tool: 't', result: 'ok' });
      await hung.record({ tool: 't2', result: 'ok' });
    } finally {
      append.mockRestore();
    }
    expect(Date.now() - started).toBeLessThan(5000);
    expect(warnings.join('')).toMatch(/timed out/);
    await hung.record({ tool: 't3', result: 'ok' });
    expect(readFileSync(file, 'utf8')).toContain('"tool":"t3"');
  });
});
