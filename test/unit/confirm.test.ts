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

  it('caps the message at ~1000 characters', async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    await createConfirmer({ platform: 'darwin', exec: exec({ stdout: 'Send' }, calls) })({ ...req, message: 'x'.repeat(5000) });
    expect((calls[0]?.args[3] ?? '').length).toBeLessThanOrEqual(DIALOG_MESSAGE_MAX_CHARS);
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
  it('shows From, final recipients incl. Bcc, subject, the body start and attachment names', () => {
    const text = buildSendConfirmationMessage({
      from: 'Me <me@icloud.com>',
      to: ['a@example.com'],
      cc: ['b@example.com'],
      bcc: ['c@example.com'],
      subject: 'Hello',
      body: `${'word '.repeat(200)}END`,
      attachments: ['report.pdf'],
    });
    expect(text).toContain('From: Me <me@icloud.com>');
    expect(text).toContain('To: a@example.com');
    expect(text).toContain('Cc: b@example.com');
    expect(text).toContain('Bcc: c@example.com');
    expect(text).toContain('Subject: Hello');
    expect(text).toContain('Attachments: report.pdf');
    expect(text).not.toContain('END');
    expect(text.length).toBeLessThanOrEqual(DIALOG_MESSAGE_MAX_CHARS);
  });

  it('describes permanent deletion', () => {
    const text = buildDeleteConfirmationMessage({ mailbox: 'Deleted Messages', count: 12, subjects: Array.from({ length: 12 }, (_, i) => `S${i}`) });
    expect(text).toMatch(/PERMANENTLY delete 12 messages from "Deleted Messages"/);
    expect(text).toContain('… and 2 more');
  });
});
