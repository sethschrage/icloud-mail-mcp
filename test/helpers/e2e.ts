/**
 * Shared expectations for the end-to-end suites: the tool sets per mode, the annotation table
 * (SPEC §6) and minimal valid arguments for every tool.
 */
import { testEnv, type TestDirs } from './infra.js';
import type { Env } from './mcp.js';

export const READ_TOOLS = ['list_mailboxes', 'search_messages', 'get_message', 'get_thread', 'get_account_info'];
export const FILE_TOOLS = ['download_attachment'];
export const MAILBOX_TOOLS = ['mark_messages', 'move_messages', 'archive_messages', 'trash_messages', 'create_mailbox', 'rename_mailbox', 'delete_mailbox'];
export const DRAFT_TOOLS = ['save_draft'];
export const SEND_TOOLS = ['send_email', 'reply_to_message', 'forward_message', 'send_draft'];
export const DELETE_TOOLS = ['delete_messages_permanently'];

export const DEFAULT_TOOLS = [...READ_TOOLS, ...FILE_TOOLS, ...MAILBOX_TOOLS, ...DRAFT_TOOLS, ...SEND_TOOLS];
export const ALL_TOOLS = [...DEFAULT_TOOLS, ...DELETE_TOOLS];

type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_IDEMPOTENT: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_NON_IDEMPOTENT: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** SPEC §6 annotation table. */
export const EXPECTED_HINTS: Record<string, Hints> = {
  list_mailboxes: READ,
  search_messages: READ,
  get_message: READ,
  get_thread: READ,
  get_account_info: READ,
  download_attachment: WRITE_IDEMPOTENT,
  mark_messages: WRITE_IDEMPOTENT,
  move_messages: WRITE_IDEMPOTENT,
  archive_messages: WRITE_IDEMPOTENT,
  trash_messages: WRITE_NON_IDEMPOTENT,
  create_mailbox: WRITE_IDEMPOTENT,
  rename_mailbox: WRITE_IDEMPOTENT,
  delete_mailbox: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  save_draft: WRITE_NON_IDEMPOTENT,
  send_email: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  reply_to_message: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  forward_message: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  send_draft: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  delete_messages_permanently: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

export const REQUIRES_USER_INTERACTION = new Set([...SEND_TOOLS, ...DELETE_TOOLS]);

/** Minimal schema-valid arguments for every tool. */
export const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  list_mailboxes: {},
  search_messages: {},
  get_message: { mailbox: 'INBOX', uid: 1 },
  get_thread: { mailbox: 'INBOX', uid: 1 },
  get_account_info: {},
  download_attachment: { mailbox: 'INBOX', uid: 6, part: '2' },
  mark_messages: { mailbox: 'INBOX', uids: [1], read: true },
  move_messages: { mailbox: 'INBOX', uids: [1], destination: 'Receipts' },
  archive_messages: { mailbox: 'INBOX', uids: [1] },
  trash_messages: { mailbox: 'INBOX', uids: [1] },
  create_mailbox: { path: 'New Folder' },
  rename_mailbox: { path: 'Receipts', new_path: 'Receipts 2' },
  delete_mailbox: { path: 'Receipts' },
  save_draft: { body: 'x' },
  send_email: { to: ['friend@example.com'], subject: 's', body: 'b' },
  reply_to_message: { mailbox: 'INBOX', uid: 1, body: 'b' },
  forward_message: { mailbox: 'INBOX', uid: 1, to: ['friend@example.com'] },
  send_draft: { uid: 1 },
  delete_messages_permanently: { mailbox: 'Deleted Messages', uids: [1] },
};

/** Env for a spawned server against test-infra (main instance unless IMAP_PORT is overridden). */
export function e2eEnv(dirs: TestDirs, overrides: Env = {}): Env {
  return { ...testEnv(dirs), HOME: dirs.root, ...overrides };
}
