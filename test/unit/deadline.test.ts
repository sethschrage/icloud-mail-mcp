import { describe, expect, it } from 'vitest';
import { withDeadline } from '../../src/deadline.js';
import { MailError, describeError } from '../../src/errors.js';
import { clearSecrets, registerSecret } from '../../src/log.js';

describe('withDeadline', () => {
  it('returns the result when the operation finishes in time', async () => {
    expect(await withDeadline(() => Promise.resolve(42), { timeoutMs: 1000 })).toBe(42);
  });

  it('rejects with TIMEOUT and aborts the signal when the deadline passes', async () => {
    let seen: AbortSignal | undefined;
    const err = await withDeadline(
      (signal) => {
        seen = signal;
        return new Promise<never>(() => undefined);
      },
      { timeoutMs: 30, what: 'send_email' },
    ).catch((e: unknown) => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).code).toBe('TIMEOUT');
    expect((err as MailError).message).toMatch(/^send_email did not finish within 0 s.*check before retrying/);
    expect(seen?.aborted).toBe(true);
  });

  it('propagates client cancellation', async () => {
    const ac = new AbortController();
    const p = withDeadline(() => new Promise<never>(() => undefined), { timeoutMs: 10_000, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    const already = new AbortController();
    already.abort();
    await expect(withDeadline(() => new Promise<never>(() => undefined), { timeoutMs: 10_000, signal: already.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('passes operation errors through', async () => {
    await expect(withDeadline(() => Promise.reject(new MailError('NOT_FOUND', 'x')), { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('describeError', () => {
  it('keeps MailError text and redacts unexpected errors', () => {
    registerSecret('hunter2-secret');
    expect(describeError(new MailError('AUTH', 'bad login'))).toBe('bad login');
    expect(describeError(new Error('socket hunter2-secret'))).toBe('Unexpected error: socket [REDACTED]');
    expect(describeError('plain')).toBe('Unexpected error: plain');
    clearSecrets();
  });
});
