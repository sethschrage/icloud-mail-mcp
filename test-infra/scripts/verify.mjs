#!/usr/bin/env node
// End-to-end self test of the local iCloud-like mail server. Run after ./reset.sh.
//   node scripts/verify.mjs [--keep-outbox]
// Leaves every fixture mailbox untouched (mutation tests run in throw-away folders that are deleted
// afterwards). SMTP messages it sends are removed from smtp-out/ unless --keep-outbox is given.
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'smtp-out');
const CA = fs.readFileSync(path.join(ROOT, 'certs', 'ca.crt'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'manifest.json'), 'utf8'));
const KEEP_OUTBOX = process.argv.includes('--keep-outbox');

const IMAP_PORT = Number(process.env.IMAP_PORT || 1143);
const IMAPS_PORT = Number(process.env.IMAPS_PORT || 1993);
const SMTP_PORT = Number(process.env.SMTP_PORT || 1587);
const USER = 'testuser';
const PASS = 'app-specific-pass';

let failures = 0;
const check = (cond, label, detail = '') => {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
    if (!cond) failures++;
};
const section = t => console.log(`\n== ${t}`);

const imap = (opts = {}) =>
    new ImapFlow({
        host: '127.0.0.1',
        port: IMAP_PORT,
        secure: false,
        auth: { user: USER, pass: PASS },
        logger: false,
        disableAutoIdle: true,
        ...opts
    });

async function tryLogin(opts) {
    const c = imap(opts);
    try {
        await c.connect();
        const info = { ok: true, secure: !!c.secureConnection, caps: [...c.capabilities.keys()] };
        await c.logout();
        return info;
    } catch (err) {
        try {
            c.close();
        } catch {
            // ignore
        }
        return { ok: false, err };
    }
}

async function main() {
    // ------------------------------------------------------------------ logins
    section('IMAP authentication / transport');
    let r = await tryLogin({ doSTARTTLS: false });
    check(r.ok && !r.secure, `plaintext login on ${IMAP_PORT} (doSTARTTLS:false)`, r.ok ? 'no TLS' : r.err.message);
    r = await tryLogin({ doSTARTTLS: true, tls: { ca: CA, servername: 'localhost' } });
    check(r.ok && r.secure, `STARTTLS login on ${IMAP_PORT} with test CA pinned`, r.ok ? 'TLS' : r.err.message);
    r = await tryLogin({ port: IMAPS_PORT, secure: true, tls: { rejectUnauthorized: false } });
    check(r.ok && r.secure, `implicit TLS login on ${IMAPS_PORT} (rejectUnauthorized:false)`, r.ok ? 'TLS' : r.err.message);
    r = await tryLogin({ port: IMAPS_PORT, secure: true, tls: { ca: CA, servername: 'localhost' } });
    check(r.ok && r.secure, `implicit TLS login on ${IMAPS_PORT} (verified against certs/ca.crt)`, r.ok ? 'TLS' : r.err.message);
    r = await tryLogin({ port: IMAPS_PORT, secure: true });
    check(!r.ok && /self[- ]signed|certificate/i.test(r.err.message), `default TLS verification rejects the self-signed chain`, r.ok ? 'unexpectedly succeeded' : r.err.message);
    r = await tryLogin({ doSTARTTLS: false, auth: { user: 'testuser@icloud.test', pass: PASS } });
    check(r.ok, 'login with full address testuser@icloud.test', r.ok ? '' : r.err.message);
    r = await tryLogin({ doSTARTTLS: false, auth: { user: USER, pass: 'wrong-password' } });
    check(!r.ok && r.err.authenticationFailed === true, 'wrong password rejected (AUTHENTICATIONFAILED)', r.ok ? 'unexpectedly succeeded' : `${r.err.responseStatus || ''} ${r.err.responseText || r.err.message}`);
    r = await tryLogin({ doSTARTTLS: false, auth: { user: 'nobody', pass: PASS } });
    check(!r.ok, 'unknown user rejected', r.ok ? 'unexpectedly succeeded' : r.err.responseText || r.err.message);

    // ------------------------------------------------------------------ capabilities
    const client = imap({ doSTARTTLS: false });
    await client.connect();
    section('CAPABILITY (post-auth)');
    const caps = [...client.capabilities.keys()];
    console.log('  * CAPABILITY ' + caps.join(' '));
    for (const cap of ['IMAP4rev1', 'MOVE', 'UIDPLUS', 'SPECIAL-USE', 'IDLE', 'CONDSTORE', 'QRESYNC', 'ESEARCH', 'NAMESPACE', 'QUOTA', 'LITERAL+', 'ID']) {
        check(client.capabilities.has(cap), `advertises ${cap}`);
    }

    // ------------------------------------------------------------------ LIST
    section('LIST "" "*"');
    const list = await client.list();
    for (const f of list) {
        console.log(`  * LIST (${[...f.flags].join(' ')}) "${f.delimiter}" "${f.path}"   specialUse=${f.specialUse || '-'} (${f.specialUseSource || '-'}) subscribed=${f.subscribed}`);
    }
    const expectSU = { 'Sent Messages': '\\Sent', Drafts: '\\Drafts', 'Deleted Messages': '\\Trash', Junk: '\\Junk', Archive: '\\Archive' };
    for (const [p, su] of Object.entries(expectSU)) {
        const f = list.find(x => x.path === p);
        check(f && f.flags.has(su) && f.specialUseSource === 'extension', `${p} carries ${su} from the server (RFC 6154)`);
    }
    check(list.every(f => f.delimiter === '/'), 'hierarchy delimiter is "/"');
    const acme = list.find(f => f.path === 'Projects/Acme');
    check(!!acme && acme.parentPath === 'Projects', 'nested folder Projects/Acme exists under Projects');

    // ------------------------------------------------------------------ counts
    section('Message counts vs fixtures/manifest.json');
    for (const [p, mb] of Object.entries(manifest.mailboxes)) {
        const st = await client.status(p, { messages: true, unseen: true, uidNext: true });
        const expected = mb.messages.length;
        const expUnseen = mb.messages.filter(m => !m.flags.includes('\\Seen')).length;
        check(st.messages === expected && st.unseen === expUnseen, `${p.padEnd(17)} messages=${st.messages} unseen=${st.unseen}`, `expected ${expected}/${expUnseen}`);
    }

    // ------------------------------------------------------------------ fixture spot checks
    section('Fixture spot checks');
    let lock = await client.getMailboxLock('INBOX');
    try {
        const threadUids = await client.search({ header: { references: 'kickoff-1@example.com' } }, { uid: true });
        const t3 = manifest.mailboxes.INBOX.messages.find(m => m.key === 'thread-3');
        check(threadUids.length === 1 && threadUids[0] === t3.uid, 'SEARCH HEADER References finds thread message 3/3', `uids=${threadUids}`);
        const green = manifest.mailboxes.INBOX.messages.find(m => m.key === 'flag-green');
        const msg = await client.fetchOne(String(green.uid), { flags: true, envelope: true }, { uid: true });
        check(msg.flagColor === 'green', `Apple colour flag decoded by imapflow (uid ${green.uid})`, `flagColor=${msg.flagColor} flags=${[...msg.flags].join(' ')}`);
        const emoji = manifest.mailboxes.INBOX.messages.find(m => m.key === 'emoji-subject');
        const em = await client.fetchOne(String(emoji.uid), { envelope: true }, { uid: true });
        check(em.envelope.subject === '🎉 Party this Saturday! 🥳', 'RFC 2047 emoji subject decodes', em.envelope.subject);
        const big = manifest.mailboxes.INBOX.messages.find(m => m.key === 'large-2mb');
        const bm = await client.fetchOne(String(big.uid), { size: true, bodyStructure: true }, { uid: true });
        check(bm.size > 1_900_000 && bm.size < 2_200_000, 'large message is ~2 MB', `RFC822.SIZE=${bm.size}`);
        const inj = await client.search({ body: 'IGNORE PREVIOUS INSTRUCTIONS' }, { uid: true });
        check(inj.length === 2, 'prompt-injection fixtures searchable (plain + hidden HTML)', `uids=${inj}`);
        const inline = manifest.mailboxes.INBOX.messages.find(m => m.key === 'inline-image');
        const im = await client.fetchOne(String(inline.uid), { bodyStructure: true }, { uid: true });
        const cids = [];
        (function walk(n) {
            if (n.id) cids.push(n.id);
            (n.childNodes || []).forEach(walk);
        })(im.bodyStructure);
        check(cids.includes('<summit-photo@example.com>'), 'inline image part has Content-ID', cids.join(','));
    } finally {
        lock.release();
    }
    const q = await client.getQuota('INBOX');
    check(!!q && q.storage && q.storage.limit === 5 * 1024 * 1024 * 1024, 'GETQUOTAROOT works (5 GB storage limit)', q ? `usage=${q.storage.usage} limit=${q.storage.limit}` : 'no quota');

    // ------------------------------------------------------------------ mutation tests in scratch folders
    section('MOVE / UIDPLUS / IDLE / nested CREATE (scratch folders, cleaned up)');
    const S1 = 'zz-verify/scratch-a';
    const S2 = 'zz-verify/scratch-b';
    await client.mailboxCreate(S1);
    await client.mailboxCreate(S2);
    const listNested = await client.list();
    check(listNested.some(f => f.path === S1), `CREATE nested ${S1}`);
    const raw = `From: Verify <verify@example.com>\r\nTo: testuser@icloud.test\r\nSubject: scratch\r\nMessage-ID: <verify-scratch@example.com>\r\nDate: Mon, 28 Sep 2026 10:00:00 +0000\r\n\r\nscratch\r\n`;
    const app = await client.append(S1, raw, ['\\Seen']);
    check(app && app.uid === 1 && app.uidValidity, 'APPEND returns APPENDUID (UIDPLUS)', JSON.stringify({ uid: app.uid, uidValidity: String(app.uidValidity) }));

    // IDLE: second connection watches S2, then we MOVE into it
    const watcher = imap({ doSTARTTLS: false });
    await watcher.connect();
    await watcher.mailboxOpen(S2);
    const existsSeen = new Promise(resolve => {
        const t = setTimeout(() => resolve(null), 5000);
        watcher.on('exists', ev => {
            clearTimeout(t);
            resolve(ev);
        });
    });
    const idleP = watcher.idle();

    lock = await client.getMailboxLock(S1);
    try {
        const mv = await client.messageMove('1:*', S2);
        check(mv && mv.uidMap && mv.uidMap.size === 1, 'UID MOVE returns COPYUID map', mv ? JSON.stringify([...mv.uidMap]) : 'false');
        check(client.mailbox.exists === 0, 'source mailbox empty after MOVE (no \\Deleted leftovers)');
    } finally {
        lock.release();
    }
    const ev = await existsSeen;
    check(!!ev && ev.count === 1, 'IDLE watcher got EXISTS push for the moved message', ev ? JSON.stringify({ path: ev.path, count: ev.count }) : 'timeout');
    // logout() breaks the IDLE; only then does idle() resolve
    await watcher.logout().catch(() => watcher.close());
    await idleP.catch(() => {});

    for (const p of [S2, S1, 'zz-verify']) await client.mailboxDelete(p).catch(() => {});
    check(!(await client.list()).some(f => f.path.startsWith('zz-verify')), 'scratch folders deleted');

    const sentBefore = (await client.status('Sent Messages', { messages: true })).messages;

    // ------------------------------------------------------------------ SMTP
    section(`SMTP sink on ${SMTP_PORT}`);
    const before = new Set(fs.readdirSync(OUT_DIR));
    const mailOpts = {
        from: 'Test User <testuser@icloud.test>',
        to: 'Friend <friend@example.com>',
        cc: 'other@example.org',
        bcc: 'hidden@example.net',
        subject: 'Verify ✓ plaintext',
        text: 'Hello from verify.mjs',
        messageId: '<verify-plain@icloud.test>'
    };
    const plain = nodemailer.createTransport({ host: '127.0.0.1', port: SMTP_PORT, secure: false, ignoreTLS: true, auth: { user: USER, pass: PASS } });
    let info = await plain.sendMail(mailOpts);
    check(/^250 /.test(info.response), 'send via plaintext AUTH PLAIN', info.response);
    check(info.accepted.length === 3, 'envelope has To+Cc+Bcc recipients', info.accepted.join(','));

    const tls = nodemailer.createTransport({ host: '127.0.0.1', port: SMTP_PORT, secure: false, requireTLS: true, tls: { ca: CA, servername: 'localhost' }, auth: { user: 'testuser@icloud.test', pass: PASS, method: 'LOGIN' }, authMethod: 'LOGIN' });
    info = await tls.sendMail({ ...mailOpts, bcc: undefined, subject: 'Verify STARTTLS', messageId: '<verify-tls@icloud.test>' });
    check(/^250 /.test(info.response), 'send via STARTTLS + AUTH LOGIN (full-address username)', info.response);

    await new Promise(res => setTimeout(res, 200));
    const created = fs.readdirSync(OUT_DIR).filter(f => !before.has(f) && f !== 'index.jsonl').sort();
    const emls = created.filter(f => f.endsWith('.eml'));
    check(emls.length === 2 && created.filter(f => f.endsWith('.json')).length === 2, '.eml + .json sidecar written per message', created.join(', '));
    const sidecars = created.filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')));
    const sc = sidecars.find(s => s.headers.messageId === '<verify-plain@icloud.test>');
    if (sc) console.log('  sidecar:', JSON.stringify({ file: sc.file, envelope: sc.envelope, auth: sc.auth, tls: sc.tls, subject: sc.headers.subject, bcc: sc.headers.bcc }));
    check(sc && sc.envelope.mailFrom === 'testuser@icloud.test' && sc.envelope.rcptTo.includes('hidden@example.net'), 'sidecar records MAIL FROM / RCPT TO incl. Bcc');
    check(sc && sc.headers.bcc.length === 0, 'Bcc is not present in the transmitted headers');
    const scTls = sidecars.find(s => s.headers.messageId === '<verify-tls@icloud.test>');
    check(scTls && scTls.tls.starttls === true, 'sidecar records STARTTLS use', scTls ? JSON.stringify(scTls.tls) : '');
    const emlText = sc ? fs.readFileSync(path.join(OUT_DIR, sc.file), 'utf8') : '';
    check(emlText.includes('Message-ID: <verify-plain@icloud.test>'), '.eml contains the raw message');

    const expectFail = async (label, transportOpts, msg, code) => {
        const t = nodemailer.createTransport({ host: '127.0.0.1', port: SMTP_PORT, secure: false, ignoreTLS: true, ...transportOpts });
        try {
            await t.sendMail(msg);
            check(false, label, 'unexpectedly accepted');
        } catch (err) {
            check(err.responseCode === code, label, `${err.responseCode} ${err.response || err.message}`);
        }
    };
    await expectFail('bad password rejected with 535', { auth: { user: USER, pass: 'nope' } }, mailOpts, 535);
    await expectFail('unknown user rejected with 535', { auth: { user: 'mallory', pass: PASS } }, mailOpts, 535);
    await expectFail('unauthenticated MAIL FROM rejected with 530', {}, mailOpts, 530);
    await expectFail('foreign MAIL FROM rejected with 550 (iCloud: not one of your addresses)', { auth: { user: USER, pass: PASS } }, { ...mailOpts, from: 'spoof@example.com' }, 550);
    await expectFail('failure injection: *@reject.test -> 550 at RCPT', { auth: { user: USER, pass: PASS } }, { ...mailOpts, to: 'x@reject.test', cc: undefined, bcc: undefined }, 550);
    await expectFail('failure injection: *@tempfail.test -> 451 at RCPT', { auth: { user: USER, pass: PASS } }, { ...mailOpts, to: 'x@tempfail.test', cc: undefined, bcc: undefined }, 451);
    await expectFail('failure injection: *@reject-data.test -> 554 after DATA', { auth: { user: USER, pass: PASS } }, { ...mailOpts, to: 'x@reject-data.test', cc: undefined, bcc: undefined }, 554);
    await expectFail('21 MB message rejected with 552 (iCloud 20 MB limit)', { auth: { user: USER, pass: PASS } },
        { ...mailOpts, cc: undefined, bcc: undefined, attachments: [{ filename: 'big.bin', content: Buffer.alloc(21 * 1024 * 1024, 0x61) }] }, 552);
    const afterFails = fs.readdirSync(OUT_DIR).filter(f => !before.has(f) && f !== 'index.jsonl');
    check(afterFails.length === 4, 'rejected messages were not stored', `${afterFails.length} new files`);

    const many = Array.from({ length: 501 }, (_, i) => `r${i}@example.com`);
    info = await plain.sendMail({ ...mailOpts, to: many, cc: undefined, bcc: undefined, subject: 'Verify recipient limit', messageId: '<verify-rcpt-limit@icloud.test>' });
    check(info.accepted.length === 500 && info.rejected.length === 1 && info.rejectedErrors?.[0]?.responseCode === 452,
        '501st recipient refused with 452 (iCloud: 500 recipients/message); nodemailer still delivers to the other 500',
        `accepted=${info.accepted.length} rejected=${info.rejected.join(',')} ${info.rejectedErrors?.[0]?.response || ''}`);

    const sentAfter = (await client.status('Sent Messages', { messages: true })).messages;
    check(sentAfter === sentBefore, 'SMTP sink does NOT auto-copy into "Sent Messages"', `before=${sentBefore} after=${sentAfter}`);
    await client.logout();

    if (!KEEP_OUTBOX) {
        const createdAll = fs.readdirSync(OUT_DIR).filter(f => !before.has(f) && f !== 'index.jsonl');
        created.splice(0, created.length, ...createdAll);
        for (const f of created) fs.unlinkSync(path.join(OUT_DIR, f));
        // drop our lines from index.jsonl
        const idx = path.join(OUT_DIR, 'index.jsonl');
        if (fs.existsSync(idx)) {
            const keep = fs.readFileSync(idx, 'utf8').split('\n').filter(l => l && !created.includes(JSON.parse(l).file));
            if (keep.length) fs.writeFileSync(idx, keep.join('\n') + '\n');
            else fs.unlinkSync(idx);
        }
        console.log(`  (removed ${created.length} verify files from smtp-out/; use --keep-outbox to keep them)`);
    }

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('verify crashed:', err);
    process.exit(2);
});
