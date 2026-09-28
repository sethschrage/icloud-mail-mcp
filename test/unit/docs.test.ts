/**
 * README.md stays in step with the code: every tool, every environment variable the server reads,
 * every settings field and the setup essentials are documented.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACH_FROM_DIRS_FLAG } from '../../src/config.js';
import { ALL_TOOL_NAMES } from '../../src/tools/index.js';
import { PROJECT_ROOT as ROOT, envVarsReadByConfig } from '../helpers/source.js';

const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const manifestText = readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText) as {
  version: string;
  long_description: string;
  user_config: Record<string, { title: string; description: string }>;
};

describe('README.md', () => {
  it('describes every tool in the tool table', () => {
    for (const name of ALL_TOOL_NAMES) expect(readme, name).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'));
  });

  it('documents every environment variable the server reads', () => {
    const vars = envVarsReadByConfig();
    expect(vars.size).toBeGreaterThan(25);
    for (const v of vars) expect(readme, v).toContain(`\`${v}\``);
    expect(readme).toContain(ATTACH_FROM_DIRS_FLAG);
  });

  it('explains every settings field of the extension', () => {
    for (const [key, option] of Object.entries(manifest.user_config)) {
      // Titles like "IMAP login (optional)" are documented without the "(optional)" suffix.
      const title = option.title.replace(/ \(optional\)$/, '').replace(/…$/, '');
      expect(readme, key).toContain(title.length > 40 ? title.slice(0, 30) : title);
    }
  });

  it('names the current .mcpb file and the setup essentials', () => {
    expect(readme).toContain(`icloud-mail-${manifest.version}.mcpb`);
    expect(readme).toContain('account.apple.com');
    expect(readme).toContain('Sign-In and Security');
    expect(readme).toContain('App-Specific Passwords');
    expect(readme).toContain('Settings → Extensions → Advanced settings → Install Extension…');
    expect(readme).toContain('security add-generic-password -s icloud-mail-mcp');
    expect(readme).toContain('command -v node');
    expect(readme).toContain('claude mcp add');
    expect(readme).toContain('~/Library/Logs/Claude/mcp*.log');
    expect(readme).toContain('~/Library/Logs/icloud-mail-mcp/audit.jsonl');
    expect(readme).toContain('From address is not one of your addresses');
  });
});

// docs-1 … docs-13: user-facing promises match what the code does.
describe('truthful user-facing wording', () => {
  it('never promises an approval prompt before every send (docs-1)', () => {
    for (const [name, text] of [['README.md', readme], ['manifest.json', manifestText]] as const) {
      expect(text, name).not.toMatch(/needs your approval/i);
      expect(text, name).not.toMatch(/asks? for your approval (each|every) time/i);
      expect(text, name).not.toMatch(/Claude asks for your approval before each one runs/i);
    }
    expect(manifest.long_description).toMatch(/normally asks/);
  });

  it('says what reaches Anthropic (docs-2) and that injection protection is best-effort (docs-3)', () => {
    expect(readme).not.toMatch(/download[^.]*stay on your Mac\./i);
    expect(manifest.long_description).toMatch(/processed by Anthropic/);
    expect(manifest.long_description).not.toMatch(/are not followed/);
    expect(manifest.long_description).toMatch(/cannot rule it out/);
  });

  it('describes the body limit as a hard maximum (docs-4)', () => {
    expect(manifest.user_config['max_body_chars']?.description).toMatch(/hard maximum/);
    expect(readme).toMatch(/Claude cannot ask for more/);
  });

  it('documents macOS folder access, updating/removing, iCloud Mail prerequisites and Trash timing (docs-6, 9, 10, 12, 13)', () => {
    expect(readme).toContain('Privacy & Security → Files and Folders');
    expect(readme).toContain('## Updating and removing');
    expect(readme).toMatch(/Revoke the app-specific password/);
    expect(readme).toMatch(/iCloud Mail turned on/);
    expect(readme).toMatch(/exactly the address you put in `ICLOUD_EMAIL`/);
    expect(readme).toMatch(/Erase deleted messages/);
    expect(readme).not.toMatch(/get them back from Trash for about 30 days/);
    expect(readme).toMatch(/If you remove every folder, the defaults are used again/);
    expect(manifest.user_config['attach_from_dirs']?.description).toMatch(/defaults? .*used again|are used again/);
  });

  it('uses the real title of the confirmation setting everywhere (docs-7, docs-8)', () => {
    const title = manifest.user_config['confirm_dialog']?.title ?? '';
    expect(title).toBe('Confirm on my Mac before sending or permanently deleting');
    expect(readme).toContain(title);
    expect(readme).not.toContain('Confirm on my Mac before sending or deleting');
    expect(manifest.user_config['confirm_dialog']?.description).toMatch(/Trash and deleting empty folders are not confirmed/);
  });
});

// integ-5: a literal U+2028/U+2029 inside a regex literal is a syntax error in JavaScript.
describe('source hygiene', () => {
  it('has no literal line/paragraph separators in the sources', () => {
    const files = readdirSync(path.join(ROOT, 'src'), { recursive: true }) as string[];
    for (const f of files.filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(path.join(ROOT, 'src', f), 'utf8');
      expect(/[\u2028\u2029]/.test(text), f).toBe(false);
    }
  });
});
