/**
 * README.md stays in step with the code: every tool, every environment variable the server reads,
 * every settings field and the setup essentials are documented.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACH_FROM_DIRS_FLAG } from '../../src/config.js';
import { ALL_TOOL_NAMES } from '../../src/tools/index.js';
import { PROJECT_ROOT as ROOT, envVarsReadByConfig } from '../helpers/source.js';

const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')) as {
  version: string;
  user_config: Record<string, { title: string }>;
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
