import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialProvider, readKeychainPassword, defaultExecFile } from '../../src/credentials.js';
import { MailError } from '../../src/errors.js';
import { clearSecrets, redact } from '../../src/log.js';

let dir: string;
let fakeSecurity: string;
let argsLog: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'fake-security-'));
  argsLog = path.join(dir, 'args.log');
  fakeSecurity = path.join(dir, 'security');
  // Mimics /usr/bin/security find-generic-password -s <svc> -a <acct> -w
  writeFileSync(
    fakeSecurity,
    `#!/bin/sh
printf '%s\\n' "$@" > "${argsLog}"
if [ "$1" != "find-generic-password" ] || [ "$2" != "-s" ] || [ "$4" != "-a" ] || [ "$6" != "-w" ]; then exit 2; fi
case "$3" in
  icloud-mail-mcp) printf 'abcd-efgh-ijkl-mnop\\n'; exit 0 ;;
  empty) printf '\\n'; exit 0 ;;
  slow) sleep 5; exit 0 ;;
  broken) echo "security: SecKeychainSearchCopyNext: failure" >&2; exit 1 ;;
  *) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44 ;;
esac
`,
  );
  chmodSync(fakeSecurity, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSecrets();
});

const base = { email: 'me@icloud.com', password: undefined, keychainService: 'icloud-mail-mcp', imapUser: undefined, smtpUser: 'me@icloud.com' };

async function mailError(p: Promise<unknown>): Promise<MailError> {
  const e = await p.then(
    () => {
      throw new Error('expected rejection');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MailError);
  return e as MailError;
}

describe('password resolution', () => {
  it('prefers ICLOUD_APP_PASSWORD and registers it for redaction', async () => {
    const p = new CredentialProvider({ ...base, password: 'env-pass-1234' }, { platform: 'linux', securityPath: '/nonexistent' });
    expect(await p.getPassword()).toEqual({ password: 'env-pass-1234', source: 'env' });
    expect(redact('login failed for env-pass-1234')).toBe('login failed for [REDACTED]');
    expect(p.describeSource()).toMatch(/ICLOUD_APP_PASSWORD/);
  });

  it('reads the macOS Keychain with execFile argv (no shell) and trims the trailing newline', async () => {
    const p = new CredentialProvider(base, { platform: 'darwin', securityPath: fakeSecurity });
    expect(await p.getPassword()).toEqual({ password: 'abcd-efgh-ijkl-mnop', source: 'keychain' });
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toEqual(['find-generic-password', '-s', 'icloud-mail-mcp', '-a', 'me@icloud.com', '-w']);
    expect(redact('pw abcd-efgh-ijkl-mnop')).toBe('pw [REDACTED]');
    expect(p.describeSource()).toMatch(/Keychain \(service "icloud-mail-mcp", account "me@icloud.com"\)/);
  });

  it('caches the result and can be invalidated', async () => {
    let calls = 0;
    const p = new CredentialProvider(base, {
      platform: 'darwin',
      securityPath: fakeSecurity,
      exec: (file, args, opts) => {
        calls++;
        return defaultExecFile(file, args, opts);
      },
    });
    await Promise.all([p.getPassword(), p.getPassword()]);
    await p.getPassword();
    expect(calls).toBe(1);
    p.invalidate();
    await p.getPassword();
    expect(calls).toBe(2);
  });

  it('explains a missing Keychain item with the add-generic-password command', async () => {
    const p = new CredentialProvider({ ...base, keychainService: 'other-service' }, { platform: 'darwin', securityPath: fakeSecurity });
    const err = await mailError(p.getPassword());
    expect(err.code).toBe('CONFIG');
    expect(err.message).toMatch(/No Keychain item found for service "other-service"/);
    expect(err.message).toContain('security add-generic-password -s other-service -a me@icloud.com -U -w');
    expect(err.message).toMatch(/App-Specific Passwords/);
  });

  it('handles an empty item, other failures and a missing binary', async () => {
    expect((await mailError(new CredentialProvider({ ...base, keychainService: 'empty' }, { platform: 'darwin', securityPath: fakeSecurity }).getPassword())).message).toMatch(/is empty/);
    expect((await mailError(new CredentialProvider({ ...base, keychainService: 'broken' }, { platform: 'darwin', securityPath: fakeSecurity }).getPassword())).message).toMatch(/exit code 1/);
    expect((await mailError(new CredentialProvider(base, { platform: 'darwin', securityPath: path.join(dir, 'missing') }).getPassword())).message).toMatch(/Could not run/);
  });

  it('times out a hanging security call', async () => {
    const err = await mailError(
      readKeychainPassword({ service: 'slow', account: 'me@icloud.com', securityPath: fakeSecurity, timeoutMs: 300, exec: defaultExecFile }),
    );
    expect(err.message).toMatch(/timed out/);
  });

  it('only uses the Keychain on macOS', async () => {
    const err = await mailError(new CredentialProvider(base, { platform: 'linux', securityPath: fakeSecurity }).getPassword());
    expect(err.message).toMatch(/only works on macOS/);
    expect(new CredentialProvider(base, { platform: 'linux' }).describeSource()).toMatch(/none configured/);
  });

  it('needs an email for the Keychain account', async () => {
    const err = await mailError(new CredentialProvider({ ...base, email: '' }, { platform: 'darwin', securityPath: fakeSecurity }).getPassword());
    expect(err.message).toMatch(/ICLOUD_EMAIL is not set/);
  });
});
