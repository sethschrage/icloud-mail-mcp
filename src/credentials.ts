/**
 * App-specific password resolution: ICLOUD_APP_PASSWORD, else the macOS Keychain (SPEC §3).
 *
 * The Keychain is read with `execFile('/usr/bin/security', [...])` (no shell), a 15 s timeout, and
 * only on darwin. The resolved password is cached for the process lifetime and registered with the
 * logger's redaction list.
 */
import { getRuntime } from './runtime.js';
import { execFile, type ChildProcess } from 'node:child_process';
import type { Config } from './config.js';
import { MailError } from './errors.js';
import { localPartOf } from './smtp/address.js';
import { registerSecret } from './log.js';

export const APP_PASSWORD_HELP =
  'Create an app-specific password at account.apple.com → Sign-In and Security → App-Specific Passwords, then either set it as ' +
  'ICLOUD_APP_PASSWORD (the "App-specific password" field in the extension settings) or store it in the macOS Keychain with: ' +
  'security add-generic-password -s icloud-mail-mcp -a <your iCloud email> -U -w';

/** Cloud version: the password comes from connector headers or the Vercel env, never the Keychain. */
export const CLOUD_PASSWORD_HELP =
  'Create an app-specific password at account.apple.com → Sign-In and Security → App-Specific Passwords, then either send it in the X-ICloud-Password connector header or set ICLOUD_PASSWORD (Sensitive, Production) in the Vercel project\'s environment variables and redeploy.';

/** The password help for this runtime. */
export function passwordHelp(): string {
  return getRuntime() === 'cloud' ? CLOUD_PASSWORD_HELP : APP_PASSWORD_HELP;
}

export type ExecFileResult = { stdout: string; stderr: string; code: number | null; error?: NodeJS.ErrnoException & { killed?: boolean } };
export type ExecFileFn = (file: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal | undefined }) => Promise<ExecFileResult>;

/** Child processes still running (the confirmation dialog, the Keychain reader, xattr). */
const liveChildren = new Set<ChildProcess>();

/** Kill every child process still running (on shutdown, so no orphaned dialog stays on screen). */
export function killChildProcesses(): void {
  for (const child of liveChildren) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  liveChildren.clear();
}

/**
 * Default executor: node's execFile without a shell; never rejects (errors are in the result). An
 * aborted `signal` kills the child (the result's error is then an AbortError).
 */
export const defaultExecFile: ExecFileFn = (file, args, { timeoutMs, signal }) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        liveChildren.delete(child);
        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
          const code = typeof e.code === 'number' ? e.code : null;
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code, error: e });
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 });
      },
    );
    liveChildren.add(child);
  });

export interface CredentialOptions {
  platform?: NodeJS.Platform;
  /** Path of the `security` binary (injectable for tests). */
  securityPath?: string;
  timeoutMs?: number;
  exec?: ExecFileFn;
  /** How get_account_info describes the password's origin (cloud: connector header or Vercel env). */
  sourceLabel?: string;
}

export interface ResolvedPassword {
  password: string;
  source: 'env' | 'keychain';
}

export class CredentialProvider {
  private cached: ResolvedPassword | undefined;
  private inFlight: Promise<ResolvedPassword> | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly securityPath: string;
  private readonly timeoutMs: number;
  private readonly exec: ExecFileFn;
  private readonly sourceLabel: string | undefined;

  constructor(
    private readonly config: Pick<Config, 'email' | 'password' | 'keychainService' | 'imapUser' | 'smtpUser'>,
    options: CredentialOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.securityPath = options.securityPath ?? '/usr/bin/security';
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.exec = options.exec ?? defaultExecFile;
    this.sourceLabel = options.sourceLabel;
  }

  /** Where the password will come from, without reading it (for get_account_info). */
  describeSource(): string {
    if (this.sourceLabel) return this.sourceLabel;
    if (this.config.password) return 'ICLOUD_APP_PASSWORD environment variable';
    if (this.platform === 'darwin') return `macOS Keychain (service "${this.config.keychainService}", account "${this.config.email}")`;
    return 'none configured (ICLOUD_APP_PASSWORD is not set and the Keychain is only available on macOS)';
  }

  async getPassword(): Promise<ResolvedPassword> {
    if (this.cached) return this.cached;
    this.inFlight ??= this.resolve().finally(() => {
      this.inFlight = undefined;
    });
    const result = await this.inFlight;
    this.cached = result;
    return result;
  }

  /** Forget the cached password (e.g. after the user fixed the Keychain entry). */
  invalidate(): void {
    this.cached = undefined;
  }

  private usernames(): string[] {
    const names = [this.config.email, this.config.smtpUser, this.config.imapUser ?? '', localPartOf(this.config.email)];
    return names.filter((n) => n);
  }

  private async resolve(): Promise<ResolvedPassword> {
    if (this.config.password) {
      registerSecret(this.config.password, this.usernames());
      return { password: this.config.password, source: 'env' };
    }
    if (!this.config.email) {
      throw new MailError('CONFIG', `ICLOUD_EMAIL is not set, so the Keychain entry cannot be looked up. ${APP_PASSWORD_HELP}`);
    }
    if (this.platform !== 'darwin') {
      throw new MailError('CONFIG', `No app-specific password is configured (ICLOUD_APP_PASSWORD is not set, and the Keychain fallback only works on macOS). ${APP_PASSWORD_HELP}`);
    }
    const password = await readKeychainPassword({
      service: this.config.keychainService,
      account: this.config.email,
      securityPath: this.securityPath,
      timeoutMs: this.timeoutMs,
      exec: this.exec,
    });
    registerSecret(password, this.usernames());
    return { password, source: 'keychain' };
  }
}

/** Read a generic password from the Keychain with `security find-generic-password -w`. */
export async function readKeychainPassword(opts: {
  service: string;
  account: string;
  securityPath: string;
  timeoutMs: number;
  exec: ExecFileFn;
}): Promise<string> {
  const helpFor = `security add-generic-password -s ${opts.service} -a ${opts.account} -U -w`;
  const result = await opts.exec(opts.securityPath, ['find-generic-password', '-s', opts.service, '-a', opts.account, '-w'], {
    timeoutMs: opts.timeoutMs,
  });
  if (result.error) {
    const e = result.error;
    if (e.code === 'ENOENT') {
      throw new MailError('CONFIG', `Could not run ${opts.securityPath} to read the Keychain. Set ICLOUD_APP_PASSWORD instead. ${APP_PASSWORD_HELP}`);
    }
    if (e.killed || e.code === 'ETIMEDOUT') {
      throw new MailError(
        'CONFIG',
        `Reading the password from the Keychain timed out after ${Math.round(opts.timeoutMs / 1000)} s (a Keychain access prompt may be waiting for you; click "Always Allow"). Or set ICLOUD_APP_PASSWORD instead.`,
      );
    }
    // security exits with 44 when the item does not exist.
    if (result.code === 44 || /could not be found/i.test(result.stderr)) {
      throw new MailError(
        'CONFIG',
        `No Keychain item found for service "${opts.service}" and account "${opts.account}". Add it with: ${helpFor} (you will be prompted for the app-specific password). ${APP_PASSWORD_HELP}`,
      );
    }
    throw new MailError(
      'CONFIG',
      `Reading the password from the Keychain failed (exit code ${result.code ?? 'unknown'}). Check the item with: security find-generic-password -s ${opts.service} -a ${opts.account}. Or set ICLOUD_APP_PASSWORD instead.`,
    );
  }
  const password = result.stdout.replace(/\r?\n$/, '');
  if (!password) {
    throw new MailError('CONFIG', `The Keychain item for service "${opts.service}" and account "${opts.account}" is empty. Update it with: ${helpFor}`);
  }
  return password;
}
