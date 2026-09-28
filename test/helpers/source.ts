/** Facts read from the project's own files, for tests that keep docs and packaging in step with the code. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Env var names src/config.ts reads: str('X'), bool('X'), int('X'), pathValue('X'), env['X'] and
 * the special-folder override table.
 */
export function envVarsReadByConfig(): Set<string> {
  const source = readFileSync(path.join(PROJECT_ROOT, 'src', 'config.ts'), 'utf8');
  const names = new Set<string>();
  for (const m of source.matchAll(/(?:str|bool|int|pathValue)\('([A-Z0-9_]+)'|env\['([A-Z0-9_]+)'\]|: '(MAIL_[A-Z]+_MAILBOX)'/g)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name) names.add(name);
  }
  return names;
}
