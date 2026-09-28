#!/usr/bin/env node
// Prints fixtures/manifest.json (written by seed.mjs) as Markdown tables, e.g. for README.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'manifest.json'), 'utf8'));
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];
for (const [p, mb] of Object.entries(manifest.mailboxes)) {
    out.push(`#### ${p}${mb.specialUse ? ` (\`${mb.specialUse}\`)` : ''} — ${mb.count} messages, ${mb.unseen} unseen`, '');
    if (!mb.messages.length) {
        out.push('_(empty; selectable parent of a nested folder)_', '');
        continue;
    }
    out.push('| UID | key | Subject (decoded) | From | Date | Flags | Size | Notes |', '|---:|---|---|---|---|---|---:|---|');
    for (const m of mb.messages) {
        const flags = m.flags.length ? m.flags.map(x => '`' + x + '`').join(' ') : '—';
        out.push(`| ${m.uid} | \`${m.key}\` | ${esc(m.subject ?? '_(no Subject header)_')} | ${esc(m.from)} | ${m.date.slice(0, 10)} | ${flags} | ${m.size} | ${esc(m.note)} |`);
    }
    out.push('');
}
console.log(out.join('\n'));
