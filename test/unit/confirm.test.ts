import { describe, expect, it } from 'vitest';
import type { ExecFileFn, ExecFileResult } from '../../src/credentials.js';
import {
  CONFIRM_APPLESCRIPT,
  DIALOG_MESSAGE_MAX_CHARS,
  buildDeleteConfirmationMessage,
  buildSendConfirmationMessage,
  createConfirmer,
} from '../../src/safety/confirm.js';

function exec(result: Partial<ExecFileResult>, calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = []): ExecFileFn {
  return (file, args, opts) => {
    calls.push({ file, args, timeoutMs: opts.timeoutMs });
    return Promise.resolve({ stdout: '', stderr: '', code: 0, ...result });
  };
}

const req = { title: 'iCloud Mail: send this email?', message: 'To: a@example.com', action: 'Send' as const };

describe('native confirmation dialog', () => {
  it('passes all text as argv to a fixed script (never interpolated)', async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const evil = { ...req, message: '" & (do shell script "rm -rf ~") & "' };
    const confirm = createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send\n' }, calls) });
    expect(await confirm(evil)).toEqual({ status: 'confirmed' });
    expect(calls[0]?.file).toBe('/usr/bin/osascript');
    expect(calls[0]?.args).toEqual(['-e', CONFIRM_APPLESCRIPT, evil.title, evil.message, 'Send', '120']);
    expect(CONFIRM_APPLESCRIPT).not.toContain('rm -rf');
    expect(CONFIRM_APPLESCRIPT).toContain('on run argv');
    expect(CONFIRM_APPLESCRIPT).toContain('buttons {"Cancel", actionButton} default button "Cancel" cancel button "Cancel" with icon caution giving up after giveUp');
    expect(calls[0]?.timeoutMs).toBeGreaterThan(120_000);
  });

  it('is confirmed only by exit 0 and exactly the action button', async () => {
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send' }) })(req)).toEqual({ status: 'confirmed' });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send ' }) })(req)).toEqual({ status: 'declined', reason: 'cancelled' });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'send' }) })(req)).toEqual({ status: 'declined', reason: 'cancelled' });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Delete' }) })(req)).toEqual({ status: 'declined', reason: 'cancelled' });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ stdout: '__timeout__\n' }) })(req)).toEqual({ status: 'declined', reason: 'timeout' });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send', code: 1, error: Object.assign(new Error('x'), { code: '1' }) }) })(req)).toMatchObject({ status: 'unavailable' });
  });

  it('treats Cancel (error -128) as declined', async () => {
    const r = await createConfirmer({ platform: 'darwin', exec: exec({ code: 1, stderr: 'execution error: User canceled. (-128)', error: new Error('Command failed') }) })(req);
    expect(r).toEqual({ status: 'declined', reason: 'cancelled' });
  });

  it('fails closed when osascript cannot be run or errors otherwise', async () => {
    expect(await createConfirmer({ platform: 'linux' })(req)).toMatchObject({ status: 'unavailable', reason: expect.stringMatching(/only available on macOS/) as string });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ code: null, error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) }) })(req)).toMatchObject({ status: 'unavailable' });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ code: 1, stderr: 'No user interaction allowed. (-1713)', error: new Error('x') }) })(req)).toMatchObject({
      status: 'unavailable',
      reason: expect.stringMatching(/-1713/) as string,
    });
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ code: null, error: Object.assign(new Error('killed'), { killed: true }) }) })(req)).toMatchObject({ status: 'unavailable' });
    expect(await createConfirmer({ platform: 'darwin', exec: () => Promise.reject(new Error('boom')) })(req)).toMatchObject({ status: 'unavailable' });
  });

  it('caps an oversized message (the builder keeps recipient lines; only the hard cap applies here)', async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send' }, calls) })({ ...req, message: 'x'.repeat(20_000) });
    expect((calls[0]?.args[3] ?? '').length).toBeLessThanOrEqual(6000);
  });

  it('keeps only the builder\'s own line breaks', async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send' }, calls) })({ ...req, message: 'a\nb\rc\u2028d\u0085e' });
    expect(calls[0]?.args[3]).toBe('a\nb c d e');
  });

  // integ-5: an abandoned call kills the dialog and never counts as confirmed.
  it('passes the abort signal to osascript and reports an aborted dialog as cancelled', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const slow: ExecFileFn = (_f, _a, opts) => {
      seen.push(opts.signal);
      return new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve({ stdout: '', stderr: '', code: null, error: Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }) }));
      });
    };
    const pending = createConfirmer({ platform: 'darwin', exec: slow })(req, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: 'declined', reason: 'cancelled' });
    expect(seen[0]).toBe(controller.signal);
    // Already aborted: osascript is never started.
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    expect(await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send' }, calls) })(req, { signal: controller.signal })).toEqual({ status: 'declined', reason: 'cancelled' });
    expect(calls).toHaveLength(0);
  });

  it('the default executor kills the child on abort', async () => {
    const { defaultExecFile } = await import('../../src/credentials.js');
    const controller = new AbortController();
    const started = Date.now();
    const p = defaultExecFile('/bin/sleep', ['30'], { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await p;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.error?.name).toBe('AbortError');
  });

  it('works through the real execFile path with a stand-in osascript', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'osa-'));
    try {
      const fake = path.join(dir, 'osascript');
      // argv: -e <script> <title> <message> <button> <giveUp>; echo the button back like a click on it
      writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$5"\n');
      chmodSync(fake, 0o755);
      expect(await createConfirmer({ platform: 'darwin', osascriptPath: fake })(req)).toEqual({ status: 'confirmed' });
      writeFileSync(fake, '#!/bin/sh\necho "execution error: User canceled. (-128)" >&2\nexit 1\n');
      expect(await createConfirmer({ platform: 'darwin', osascriptPath: fake })(req)).toEqual({ status: 'declined', reason: 'cancelled' });
      expect(await createConfirmer({ platform: 'darwin', osascriptPath: path.join(dir, 'missing') })(req)).toMatchObject({ status: 'unavailable' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dialog text', () => {
  it('shows From, final recipients incl. Bcc with counts, subject, the body start and attachment names', () => {
    const text = buildSendConfirmationMessage({
      from: { name: 'Me', address: 'me@icloud.com' },
      to: [{ address: 'a@example.com' }],
      cc: [{ address: 'b@example.com' }],
      bcc: [{ address: 'c@example.com' }],
      subject: 'Hello',
      body: `${'word '.repeat(400)}END`,
      attachments: [{ name: 'report.pdf' }],
    });
    expect(text).toContain('Recipients: 3 (To 1, Cc 1, Bcc 1)');
    expect(text).toContain('From: me@icloud.com (Me)');
    expect(text).toContain('To (1): a@example.com');
    expect(text).toContain('Cc (1): b@example.com');
    expect(text).toContain('Bcc (1): c@example.com');
    expect(text).toContain('Subject: Hello');
    expect(text).toContain('Attachments (1): report.pdf');
    expect(text).not.toContain('END');
    expect(text.length).toBeLessThanOrEqual(DIALOG_MESSAGE_MAX_CHARS);
  });

  // confirm-1 (security): hostile reply recipients cannot hide the real address or forge lines.
  it('always shows the real address, never lets a display name forge lines, and warns on look-alike names', () => {
    const base = { from: { address: 'me@icloud.com' }, cc: [], bcc: [], subject: 'Re: Q3', body: 'numbers', attachments: [] };
    const dots = buildSendConfirmationMessage({ ...base, to: [{ name: `Your Boss (boss@company.example)${'.'.repeat(600)}`, address: 'attacker@evil.test' }] });
    expect(dots).toContain('attacker@evil.test');
    expect(dots).toMatch(/WARNING: a display name contains a different email address/);
    const crlf = buildSendConfirmationMessage({ ...base, to: [{ name: 'Your Boss\r\nBcc: injected@evil.test\u2028X-Evil: 1', address: 'attacker@evil.test' }] });
    const lines = crlf.split('\n');
    expect(lines.filter((l) => l.startsWith('Bcc'))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith('X-Evil'))).toHaveLength(0);
    expect(crlf).toContain('attacker@evil.test');
  });

  // confirm-1 (smtp): a 250-character name does not push a later recipient out; long lists say how many are hidden.
  it('lists every recipient address and says when a list was shortened', () => {
    const base = { from: { address: 'me@icloud.com' }, cc: [], bcc: [], subject: 's', body: 'b', attachments: [] };
    const two = buildSendConfirmationMessage({ ...base, to: [{ name: 'Alice Nguyen', address: 'alice@example.com' }, { name: `Accounts Payable ${'x'.repeat(250)}`, address: 'attacker@evil.test' }] });
    expect(two).toContain('alice@example.com');
    expect(two).toContain('attacker@evil.test');
    const many = Array.from({ length: 400 }, (_, i) => ({ address: `person${i}@example${i % 7}.com` }));
    const big = buildSendConfirmationMessage({ ...base, to: many });
    expect(big).toContain('To (400):');
    expect(big).toMatch(/… and \d+ more \(LIST SHORTENED; their domains: /);
  });

  // confirm-2: model-supplied input cannot push Bcc, Reply-To, attachments or the subject out of view.
  it('keeps every field visible with hostile long input (poc5)', () => {
    const text = buildSendConfirmationMessage({
      from: { name: 'F'.repeat(250), address: 'me@icloud.com' },
      to: [{ name: 'N'.repeat(250), address: 'ap.team@example-corp.example' }, { address: 'exfil@attacker.example' }],
      cc: Array.from({ length: 10 }, (_, i) => ({ address: `colleague${i}.with.a.long.address@example-corp.example` })),
      bcc: [{ address: 'archive.mailbox.for.finance.department@example-corp.example' }, { address: 'second-exfil@attacker.example' }],
      replyTo: [{ address: 'attacker@attacker.example' }],
      subject: 'Quarterly numbers',
      body: 'please see attached',
      attachments: [...Array.from({ length: 20 }, () => ({ name: 'report.xlsx' })), { name: 'passwords.csv' }, { name: 'invoice.pdf', realName: 'secrets.txt' }],
    });
    for (const needle of ['exfil@attacker.example', 'second-exfil@attacker.example', 'passwords.csv', 'Reply-To (1): attacker@attacker.example', 'Subject: Quarterly numbers', 'report.xlsx ×20', '[real file: secrets.txt]', 'Attachments (22)']) {
      expect(text).toContain(needle);
    }
  });

  it('describes permanent deletion', () => {
    const text = buildDeleteConfirmationMessage({ mailbox: 'Deleted Messages', count: 12, subjects: Array.from({ length: 12 }, (_, i) => `S${i}`) });
    expect(text).toMatch(/PERMANENTLY delete 12 messages from "Deleted Messages"/);
    expect(text).toContain('… and 2 more');
  });
});
