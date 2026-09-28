/**
 * End-to-end helpers: spawn the bundled server (build/dev/index.js, built by test/global-build.ts)
 * over stdio with the MCP v2 client, and small accessors for tool results.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Client, type CallToolResult, type ContentBlock } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { UNTRUSTED_LIST_NOTE } from '../../src/safety/untrusted.js';
import { PROJECT_ROOT } from './infra.js';

export const SERVER_ENTRY = path.join(PROJECT_ROOT, 'build', 'dev', 'index.js');

export type Env = Record<string, string | undefined>;

/** Only the given variables (plus PATH), so the developer's own mail env never leaks in. */
export function childEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env['PATH']) out['PATH'] = process.env['PATH'];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export interface McpSession {
  client: Client;
  transport: StdioClientTransport;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  close(): Promise<void>;
}

export interface ToolCall {
  result: CallToolResult;
  isError: boolean;
  /** All text blocks joined with "\n". */
  text: string;
  content: ContentBlock[];
}

export function toToolCall(result: CallToolResult): ToolCall {
  const content = result.content;
  const text = content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { result, isError: result.isError === true, text, content };
}

/**
 * Spawn the server and connect an MCP client. `entry` defaults to the dev bundle; the packaging
 * smoke test can point it at an unpacked .mcpb's server/index.js, or pass the complete `args`
 * (entry first) that the manifest produces.
 */
export async function startMcp(env: Env, options: { cwd?: string; entry?: string; args?: string[] } = {}): Promise<McpSession> {
  const args = options.args ?? [options.entry ?? SERVER_ENTRY];
  const entry = args[0] ?? '';
  if (!existsSync(entry)) throw new Error(`${entry} is missing; run npm run build:dev`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnv(env),
    stderr: 'pipe',
    cwd: options.cwd ?? PROJECT_ROOT,
  });
  const chunks: string[] = [];
  transport.stderr?.on('data', (c: Buffer | string) => chunks.push(String(c)));
  const client = new Client({ name: 'icloud-mail-e2e', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => chunks.join(''),
    call: async (name, args = {}) => toToolCall((await client.callTool({ name, arguments: args }, { timeout: 90_000 })) as CallToolResult),
    close: async () => {
      await client.close();
    },
  };
}

/** Parse a compact-JSON tool result (optionally preceded by the untrusted-content reminder line). */
export function json<T = Record<string, unknown>>(call: ToolCall): T {
  let text = call.text;
  if (text.startsWith(UNTRUSTED_LIST_NOTE)) text = text.slice(UNTRUSTED_LIST_NOTE.length + 1);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`tool result is not JSON (isError=${call.isError}): ${call.text.slice(0, 500)}`);
  }
}

/** Parse the JSON block at the start of a text that continues with other content. */
export function leadingJson<T = Record<string, unknown>>(text: string): T {
  const end = text.indexOf('\n\n');
  return JSON.parse(end >= 0 ? text.slice(0, end) : text) as T;
}

export function auditEntries(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export interface RawSession {
  /** Every complete stdout line. */
  stdoutLines: string[];
  stderr: string;
  code: number | null;
}

/**
 * Drive the server with raw JSON-RPC lines (no SDK), wait for the responses to the given request
 * ids, then close stdin and collect every stdout line (for the stdout-cleanliness test).
 */
export async function rawSession(env: Env, requests: Array<Record<string, unknown>>, waitForIds: number[], timeoutMs = 60_000): Promise<RawSession> {
  const child = spawn(process.execPath, [SERVER_ENTRY], { env: childEnv(env), cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const pending = new Set(waitForIds);
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  child.stdout.on('data', (c: string) => {
    stdout += c;
    for (const line of stdout.split('\n')) {
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') pending.delete(msg.id);
      } catch {
        // partial line or garbage: judged by the test
      }
    }
    if (pending.size === 0) resolveDone();
  });
  child.stderr.on('data', (c: string) => {
    stderr += c;
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
  const timer = setTimeout(() => resolveDone(), timeoutMs);
  await done;
  clearTimeout(timer);
  child.stdin.end();
  const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const code = await exited;
  clearTimeout(killer);
  const stdoutLines = stdout.split('\n').filter((l) => l !== '');
  return { stdoutLines, stderr, code };
}

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-e2e', version: '1.0.0' } },
};
export const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
