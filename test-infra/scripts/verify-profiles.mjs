#!/usr/bin/env node
// Self-test of the iCloud-fidelity IMAP profiles (README.md "iCloud-fidelity profiles").
// Run after `./reset.sh --profile all`:
//
//   node scripts/verify-profiles.mjs [icloud|no-uidplus|all] [--trace]
//
// Per profile it checks:
//   - the exact pre-login and post-login CAPABILITY on both ports, over the raw protocol
//   - what imapflow sees: capabilities, list() specialUse/specialUseSource, and the LIST/LSUB/STATUS
//     commands it sends when LIST-EXTENDED/LIST-STATUS are missing
//   - counts, UIDs, Message-IDs and flags of every fixture mailbox against fixtures/manifest.json
//   - how imapflow's messageMove()/messageDelete() behave without MOVE (and without UIDPLUS): the exact
//     commands sent, and whether another message's pending \Deleted flag survives
//   - IDLE, transports/logins, and that the profile's Maildir is not shared with any other instance
// Fixture mailboxes are only read. Mutations run in scratch folders that are deleted afterwards, so the
// profile stays at canonical UIDs. The main instance (1143) is only sent one read-only CAPABILITY check.
// --trace mirrors every imapflow protocol line (C: / S:) to stderr.
import { ImapFlow } from 'imapflow';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DEF_DIR = path.join(ROOT, 'dovecot', 'profiles');
const CA = fs.readFileSync(path.join(ROOT, 'certs', 'ca.crt'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'manifest.json'), 'utf8'));
const USER = 'testuser';
const PASS = 'app-specific-pass';
const MAIN_IMAP_PORT = 1143;
const TRACE = process.argv.includes('--trace');
const SRC = 'zz-verify-profile-src';
const DST = 'zz-verify-profile-dst';

// SPEC section 8 contract for the named profiles. A definition file that drifts from it fails here.
const CONTRACT = {
    icloud: { absent: ['MOVE', 'SPECIAL-USE', 'IMAP4rev2'], present: ['UIDPLUS', 'IDLE'] },
    'no-uidplus': { absent: ['MOVE', 'SPECIAL-USE', 'UIDPLUS', 'IMAP4rev2'], present: ['IDLE'] }
};
const SPECIAL_USE_ATTRS = ['\\All', '\\Archive', '\\Drafts', '\\Flagged', '\\Junk', '\\Sent', '\\Trash'];

let failures = 0;
const check = (cond, label, detail = '') => {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
    if (!cond) failures++;
    return !!cond;
};
const info = (label, detail = '') => console.log(`  INFO  ${label}${detail ? `  -- ${detail}` : ''}`);
const section = t => console.log(`\n== ${t}`);
const sub = t => console.log(`\n  -- ${t}`);
const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const numeric = list => [...list].sort((x, y) => x - y);

// ---------------------------------------------------------------- profile definitions
function knownProfiles() {
    return fs
        .readdirSync(PROFILE_DEF_DIR)
        .filter(f => f.endsWith('.env'))
        .map(f => f.slice(0, -4))
        .sort();
}

function loadProfile(name) {
    const vars = {};
    for (const line of fs.readFileSync(path.join(PROFILE_DEF_DIR, `${name}.env`), 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|(\S*))\s*$/.exec(line);
        if (m) vars[m[1]] = m[2] ?? m[3];
    }
    const capability = (vars.PROFILE_CAPABILITY || '').split(/\s+/).filter(Boolean);
    return {
        name,
        description: vars.PROFILE_DESCRIPTION || '',
        imapPort: Number(vars.PROFILE_IMAP_PORT),
        imapsPort: Number(vars.PROFILE_IMAPS_PORT),
        specialUse: vars.PROFILE_SPECIAL_USE === 'yes',
        capability,
        hasMove: capability.includes('MOVE'),
        hasUidplus: capability.includes('UIDPLUS')
    };
}

// ---------------------------------------------------------------- raw IMAP client (no imapflow)
class RawImap {
    constructor(socket) {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.current = '';
        this.literal = 0;
        this.queue = [];
        this.waiter = null;
        this.closed = null;
        this.tag = 0;
        socket.on('data', chunk => this.onData(chunk));
        socket.on('error', err => this.fail(err));
        socket.on('close', () => this.fail(new Error('connection closed')));
    }

    static open(port, secure) {
        return new Promise((resolve, reject) => {
            const socket = secure
                ? tls.connect({ host: '127.0.0.1', port, ca: CA, servername: 'localhost' })
                : net.connect({ host: '127.0.0.1', port });
            const onError = err => reject(err);
            socket.once('error', onError);
            socket.once(secure ? 'secureConnect' : 'connect', async () => {
                socket.off('error', onError);
                const raw = new RawImap(socket);
                try {
                    resolve({ raw, greeting: await raw.nextLine() });
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            if (this.literal > 0) {
                if (this.buf.length < this.literal) return;
                this.current += this.buf.subarray(0, this.literal).toString('utf8');
                this.buf = this.buf.subarray(this.literal);
                this.literal = 0;
                continue;
            }
            const idx = this.buf.indexOf('\r\n');
            if (idx < 0) return;
            const line = this.buf.subarray(0, idx).toString('utf8');
            this.buf = this.buf.subarray(idx + 2);
            this.current += line;
            const lit = /\{(\d+)\+?\}$/.exec(line);
            if (lit) {
                this.literal = Number(lit[1]);
                this.current += '\r\n';
                continue;
            }
            this.queue.push(this.current);
            this.current = '';
            this.wake();
        }
    }

    fail(err) {
        if (!this.closed) this.closed = err;
        this.wake();
    }

    wake() {
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w();
        }
    }

    async nextLine(timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (!this.queue.length) {
            if (this.closed) throw this.closed;
            const left = deadline - Date.now();
            if (left <= 0) throw new Error('timeout waiting for server response');
            await new Promise(resolve => {
                const t = setTimeout(resolve, left);
                this.waiter = () => {
                    clearTimeout(t);
                    resolve();
                };
            });
        }
        return this.queue.shift();
    }

    // Sends one command, returns { untagged: string[], tagged, status, text }.
    async command(cmd) {
        const tag = `r${++this.tag}`;
        this.socket.write(`${tag} ${cmd}\r\n`);
        const untagged = [];
        for (;;) {
            const line = await this.nextLine();
            if (line.startsWith(`${tag} `)) {
                const m = /^\S+ (OK|NO|BAD) ?(.*)$/.exec(line);
                return { untagged, tagged: line, status: m ? m[1] : '?', text: m ? m[2] : line };
            }
            untagged.push(line);
        }
    }

    close() {
        this.socket.destroy();
    }
}

const capsFromText = text => {
    const m = /\[CAPABILITY ([^\]]*)\]/i.exec(text) || /^\* CAPABILITY (.*)$/i.exec(text);
    return m ? m[1].trim().split(/\s+/) : null;
};
const capsFromResponse = res => {
    for (const line of res.untagged) {
        const caps = capsFromText(line);
        if (caps) return caps;
    }
    return null;
};

async function portOpen(port) {
    return new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port });
        s.once('connect', () => {
            s.destroy();
            resolve(true);
        });
        s.once('error', () => resolve(false));
    });
}

// Logs in over the raw protocol and runs fn(raw).
async function withRawSession(port, fn) {
    const { raw } = await RawImap.open(port, false);
    try {
        const login = await raw.command(`LOGIN ${USER} ${PASS}`);
        if (login.status !== 'OK') throw new Error(`LOGIN failed on ${port}: ${login.tagged}`);
        return await fn(raw);
    } finally {
        await raw.command('LOGOUT').catch(() => {});
        raw.close();
    }
}

// ---------------------------------------------------------------- imapflow with protocol capture
function captureLogger(label) {
    const entries = [];
    let recording = false;
    const onLine = obj => {
        if (!obj || (obj.src !== 'c' && obj.src !== 's') || typeof obj.msg !== 'string') return;
        if (TRACE) process.stderr.write(`[${label}] ${obj.src === 'c' ? 'C:' : 'S:'} ${obj.msg}\n`);
        if (recording) entries.push({ src: obj.src, msg: obj.msg });
    };
    const noop = () => {};
    return {
        logger: { trace: onLine, debug: onLine, info: noop, warn: noop, error: noop, fatal: noop },
        start() {
            entries.length = 0;
            recording = true;
        },
        stop() {
            recording = false;
            return entries.splice(0);
        }
    };
}
// Client commands without their tags, e.g. "UID COPY 1 zz-verify-profile-dst".
const commandsOf = entries => entries.filter(e => e.src === 'c').map(e => e.msg.replace(/^\S+ /, ''));

function imapflow(p, opts = {}) {
    return new ImapFlow({
        host: '127.0.0.1',
        port: p.imapsPort,
        secure: true,
        tls: { ca: CA, servername: 'localhost' },
        auth: { user: USER, pass: PASS },
        logger: false,
        disableAutoIdle: true,
        ...opts
    });
}

async function tryLogin(opts) {
    const c = new ImapFlow({ host: '127.0.0.1', auth: { user: USER, pass: PASS }, logger: false, disableAutoIdle: true, ...opts });
    try {
        await c.connect();
        const res = { ok: true, secure: !!c.secureConnection };
        await c.logout();
        return res;
    } catch (err) {
        c.close();
        return { ok: false, err };
    }
}

const scratchMessage = i =>
    `From: Verify <verify@example.com>\r\nTo: testuser@icloud.test\r\nSubject: profile scratch ${i}\r\n` +
    `Message-ID: <verify-profile-${i}@example.com>\r\nDate: Mon, 28 Sep 2026 10:0${i}:00 +0000\r\n\r\nscratch ${i}\r\n`;

// ---------------------------------------------------------------- per-profile verification
async function verifyProfile(p, allProfiles) {
    section(`profile "${p.name}": IMAP ${p.imapPort} (plaintext/STARTTLS), IMAPS ${p.imapsPort} (TLS) - ${p.description}`);
    const obs = { profile: p.name, ports: { imap: p.imapPort, imaps: p.imapsPort } };

    if (!(await portOpen(p.imapPort)) || !(await portOpen(p.imapsPort))) {
        check(false, `profile "${p.name}" is running`, `start it with ./start.sh --profile ${p.name} (or ./reset.sh --profile ${p.name})`);
        return obs;
    }

    const contract = CONTRACT[p.name];
    if (contract) {
        const missing = contract.present.filter(c => !p.capability.includes(c));
        const extra = contract.absent.filter(c => p.capability.includes(c));
        check(!missing.length && !extra.length, `definition dovecot/profiles/${p.name}.env matches the spec`,
            `must lack ${contract.absent.join(', ')}; must have ${contract.present.join(', ')}` + (missing.length || extra.length ? `; wrong: ${[...missing, ...extra].join(', ')}` : ''));
    }
    const absent = contract ? contract.absent : ['MOVE', 'SPECIAL-USE'].filter(c => !p.capability.includes(c));
    const present = contract ? contract.present : p.capability.filter(c => ['UIDPLUS', 'IDLE'].includes(c));

    // ------------------------------------------------------------ raw CAPABILITY
    sub('raw protocol: CAPABILITY before and after LOGIN, on both ports');
    for (const [port, secure] of [[p.imapPort, false], [p.imapsPort, true]]) {
        const where = `${port}${secure ? ' (TLS)' : ''}`;
        const expectedPre = [...p.capability, ...(secure ? [] : ['STARTTLS']), 'AUTH=PLAIN', 'AUTH=LOGIN'];
        const { raw, greeting } = await RawImap.open(port, secure);
        try {
            const greet = capsFromText(greeting);
            check(!!greet && sameSet(greet, expectedPre), `greeting CAPABILITY on ${where} = profile list${secure ? '' : ' + STARTTLS'} + AUTH=PLAIN AUTH=LOGIN`, greet ? '' : greeting);
            const pre = capsFromResponse(await raw.command('CAPABILITY'));
            check(!!pre && sameSet(pre, expectedPre), `pre-login CAPABILITY command on ${where} matches the greeting`);
            if (pre) check(absent.every(c => !pre.includes(c)), `pre-login on ${where} lacks ${absent.join(', ')}`);
            if (!secure && pre) obs.preLoginCapability = pre.join(' ');

            const login = await raw.command(`LOGIN ${USER} ${PASS}`);
            check(login.status === 'OK', `raw LOGIN on ${where}`, login.tagged);
            const inLogin = capsFromText(login.text) || capsFromResponse(login);
            if (inLogin) check(sameSet(inLogin, p.capability), `CAPABILITY sent with the LOGIN response on ${where} = profile list`);
            const post = capsFromResponse(await raw.command('CAPABILITY'));
            check(!!post && sameSet(post, p.capability), `post-login CAPABILITY on ${where} is exactly the profile list`,
                post ? (sameSet(post, p.capability) ? '' : `got: ${post.join(' ')}`) : 'no CAPABILITY response');
            if (post) {
                for (const c of absent) check(!post.includes(c), `post-login on ${where} does NOT advertise ${c}`);
                for (const c of present) check(post.includes(c), `post-login on ${where} advertises ${c}`);
                if (!secure) {
                    obs.postLoginCapability = post.join(' ');
                    console.log(`        * CAPABILITY ${post.join(' ')}`);
                }
            }

            if (!secure) {
                const list = await raw.command('LIST "" "*"');
                const lines = list.untagged.filter(l => l.startsWith('* LIST '));
                for (const l of lines) console.log(`        ${l}`);
                const withAttr = lines.filter(l => SPECIAL_USE_ATTRS.some(a => new RegExp(`[( ]\\${a}[ )]`, 'i').test(l.slice(0, l.indexOf(')') + 1))));
                if (p.specialUse) check(withAttr.length > 0, 'raw LIST carries RFC 6154 attributes (PROFILE_SPECIAL_USE=yes)');
                else check(withAttr.length === 0, 'raw LIST "" "*" carries no \\Sent/\\Trash/\\Drafts/\\Junk/\\Archive attributes', withAttr.join(' | '));
                obs.rawList = lines;
            }
        } finally {
            await raw.command('LOGOUT').catch(() => {});
            raw.close();
        }
    }

    // ------------------------------------------------------------ transports
    sub('transports and logins (imapflow)');
    let r = await tryLogin({ port: p.imapsPort, secure: true, tls: { ca: CA, servername: 'localhost' } });
    check(r.ok && r.secure, `implicit TLS on ${p.imapsPort}, verified against certs/ca.crt`, r.ok ? '' : r.err.message);
    r = await tryLogin({ port: p.imapPort, secure: false, tls: { ca: CA, servername: 'localhost' } });
    check(r.ok && r.secure, `STARTTLS on ${p.imapPort} with the test CA`, r.ok ? '' : r.err.message);
    r = await tryLogin({ port: p.imapPort, secure: false, doSTARTTLS: false, auth: { user: 'testuser@icloud.test', pass: PASS } });
    check(r.ok && !r.secure, `plaintext login on ${p.imapPort} with the full address`, r.ok ? '' : r.err.message);
    r = await tryLogin({ port: p.imapPort, secure: false, doSTARTTLS: false, auth: { user: USER, pass: 'wrong-password' } });
    check(!r.ok && r.err.authenticationFailed === true, 'wrong password rejected (AUTHENTICATIONFAILED)');

    // ------------------------------------------------------------ imapflow view
    const cap = captureLogger(p.name);
    const client = imapflow(p, { logger: cap.logger });
    client.on('error', err => console.error(`  [${p.name}] imapflow error: ${err.message}`));
    await client.connect();
    try {
        sub('imapflow: capabilities');
        const flowCaps = [...client.capabilities.keys()];
        check(sameSet(flowCaps, p.capability), 'client.capabilities has exactly the profile list', sameSet(flowCaps, p.capability) ? '' : flowCaps.join(' '));
        for (const c of absent) check(!client.capabilities.has(c), `client.capabilities.has('${c}') === false`);
        for (const c of present) check(client.capabilities.has(c), `client.capabilities.has('${c}') === true`);

        sub('imapflow: list() special-use detection');
        cap.start();
        const list = await client.list();
        const listCmds = commandsOf(cap.stop());
        obs.list = list.map(f => ({ path: f.path, flags: [...f.flags], specialUse: f.specialUse || null, specialUseSource: f.specialUseSource || null }));
        for (const f of obs.list) {
            console.log(`        ${f.path.padEnd(18)} flags=${f.flags.join(' ') || '-'}  specialUse=${f.specialUse || '-'}  specialUseSource=${f.specialUseSource || '-'}`);
        }
        obs.listCommands = listCmds;
        console.log(`        commands: ${listCmds.join(' ; ')}`);
        check(listCmds.some(c => /^LIST "" "\*"$/.test(c)) && !listCmds.some(c => /\bRETURN\b/.test(c)),
            'list() sends a plain LIST "" "*" (no RETURN options: LIST-EXTENDED is not advertised)');
        check(listCmds.some(c => /^LSUB /.test(c)), 'list() falls back to LSUB for subscription state');
        for (const [mbPath, mb] of Object.entries(manifest.mailboxes)) {
            const f = list.find(x => x.path === mbPath);
            if (!check(!!f, `list() returns ${mbPath}`)) continue;
            const expected = mbPath === 'INBOX' ? '\\Inbox' : mb.specialUse;
            // imapflow trusts LIST attributes only when SPECIAL-USE (or XLIST) is advertised
            const fromExtension = p.specialUse && p.capability.includes('SPECIAL-USE');
            const expectedSource = fromExtension && expected && expected !== '\\Inbox' ? 'extension' : 'name';
            if (expected) {
                check(f.specialUse === expected && f.specialUseSource === expectedSource,
                    `${mbPath}: specialUse ${expected}, specialUseSource "${expectedSource}"`, `got ${f.specialUse || '-'} / ${f.specialUseSource || '-'}`);
            } else {
                check(!f.specialUse, `${mbPath}: no specialUse`, f.specialUse ? `got ${f.specialUse} / ${f.specialUseSource}` : '');
            }
            if (!p.specialUse) check(!SPECIAL_USE_ATTRS.some(a => f.flags.has(a)), `${mbPath}: flags carry no special-use attribute`);
        }

        sub('imapflow: list({statusQuery}) and STATUS vs fixtures/manifest.json');
        cap.start();
        const withStatus = await client.list({ statusQuery: { messages: true, unseen: true } });
        const statusCmds = commandsOf(cap.stop());
        const nStatus = statusCmds.filter(c => /^STATUS /.test(c)).length;
        check(nStatus >= Object.keys(manifest.mailboxes).length && !statusCmds.some(c => /\bRETURN\b/.test(c)),
            'list({statusQuery}) issues one STATUS per mailbox (LIST-STATUS is not advertised)', `${nStatus} STATUS commands`);
        for (const [mbPath, mb] of Object.entries(manifest.mailboxes)) {
            const f = withStatus.find(x => x.path === mbPath);
            const expUnseen = mb.messages.filter(m => !m.flags.includes('\\Seen')).length;
            const st = f && f.status;
            check(!!st && st.messages === mb.messages.length && st.unseen === expUnseen,
                `${mbPath.padEnd(17)} messages=${st ? st.messages : '?'} unseen=${st ? st.unseen : '?'}`, `expected ${mb.messages.length}/${expUnseen}`);
        }

        sub('UIDs, Message-IDs and flags vs fixtures/manifest.json (EXAMINE, read-only)');
        for (const [mbPath, mb] of Object.entries(manifest.mailboxes)) {
            const lock = await client.getMailboxLock(mbPath, { readOnly: true });
            try {
                const got = mb.messages.length ? await client.fetchAll('1:*', { uid: true, flags: true, envelope: true }, { uid: true }) : [];
                const norm = got
                    .map(m => ({ uid: m.uid, messageId: m.envelope ? m.envelope.messageId : null, flags: [...m.flags].filter(f => f !== '\\Recent').sort() }))
                    .sort((a, b) => a.uid - b.uid);
                const want = mb.messages.map(m => ({ uid: m.uid, messageId: m.messageId, flags: [...m.flags].sort() }));
                const bad = want.filter((w, i) => !norm[i] || JSON.stringify(norm[i]) !== JSON.stringify(w));
                check(norm.length === want.length && bad.length === 0, `${mbPath.padEnd(17)} ${want.length} messages at canonical UIDs with manifest Message-IDs/flags`,
                    bad.length ? `first mismatch uid ${bad[0].uid}` : '');
                const st = await client.status(mbPath, { uidNext: true });
                check(st.uidNext === want.length + 1, `${mbPath.padEnd(17)} UIDNEXT ${st.uidNext} (fresh reset: count + 1)`);
            } finally {
                lock.release();
            }
        }
        const profileManifest = path.join(ROOT, 'run', 'profiles', p.name, 'manifest.json');
        if (fs.existsSync(profileManifest)) {
            check(fs.readFileSync(profileManifest, 'utf8') === fs.readFileSync(path.join(ROOT, 'fixtures', 'manifest.json'), 'utf8'),
                `run/profiles/${p.name}/manifest.json (written by the last reset) is identical to fixtures/manifest.json`);
        }

        // -------------------------------------------------------- move / delete fallback
        sub(`imapflow: messageMove / messageDelete ${p.hasMove ? 'with' : 'without'} MOVE, ${p.hasUidplus ? 'with' : 'without'} UIDPLUS (scratch folders)`);
        const existing = (await client.list()).map(f => f.path);
        for (const f of [SRC, DST]) if (existing.includes(f)) await client.mailboxDelete(f);
        await client.mailboxCreate(SRC);
        await client.mailboxCreate(DST);

        cap.start();
        const appended = [];
        for (let i = 1; i <= 4; i++) appended.push(await client.append(SRC, scratchMessage(i), ['\\Seen']));
        const appendLog = cap.stop();
        const appendUidCodes = appendLog.filter(e => e.src === 's' && /\[APPENDUID /i.test(e.msg)).length;
        check(sameList(appended.map(a => a && a.uid), [1, 2, 3, 4]), `APPEND x4 into ${SRC} -> UIDs 1..4`);
        obs.appendUid = `${appendUidCodes}/4 APPEND responses carried APPENDUID`;
        if (p.hasUidplus) check(appendUidCodes === 4, 'APPEND responses carry APPENDUID');
        else info('APPENDUID although UIDPLUS is not advertised', `${appendUidCodes}/4 APPEND responses carried it (Dovecot always sends it; a real non-UIDPLUS server would not)`);

        // separate Maildir stores: the scratch folder must not show up on any other instance
        for (const other of [{ name: 'main', port: MAIN_IMAP_PORT }, ...allProfiles.filter(o => o.name !== p.name).map(o => ({ name: o.name, port: o.imapPort }))]) {
            if (!(await portOpen(other.port))) continue;
            const seen = await withRawSession(other.port, async raw => (await raw.command(`LIST "" "${SRC}"`)).untagged.filter(l => l.startsWith('* LIST ')).length);
            check(seen === 0, `${SRC} is not visible on the ${other.name} instance (port ${other.port}): separate Maildir`);
        }

        let lock = await client.getMailboxLock(SRC);
        try {
            // uid 4 plays "someone else's deletion": flagged \Deleted by another client, not yet expunged
            await client.messageFlagsAdd('4', ['\\Deleted'], { uid: true });
            const pending = numeric(await client.search({ deleted: true }, { uid: true }));
            check(sameList(pending, [4]), 'guard query search({deleted:true}, {uid:true}) finds the pending \\Deleted uid 4', `[${pending}]`);
            const undeleted = numeric(await client.search({ deleted: false }, { uid: true }));
            check(sameList(undeleted, [1, 2, 3]), 'search({deleted:false}) (UNDELETED) hides it', `[${undeleted}]`);

            cap.start();
            const mv = await client.messageMove('1', DST, { uid: true });
            const mvCmds = commandsOf(cap.stop());
            obs.moveCommands = mvCmds;
            console.log(`        messageMove('1', DST, {uid:true}) sent: ${mvCmds.join(' ; ')}`);
            if (p.hasMove) {
                check(mvCmds.length === 1 && /^UID MOVE 1 /.test(mvCmds[0]), 'MOVE is advertised: a single UID MOVE is sent');
            } else {
                check(!mvCmds.some(c => /^(UID )?MOVE /.test(c)), 'no MOVE / UID MOVE is sent');
                check(mvCmds.some(c => c === `UID COPY 1 ${DST}` || c === `UID COPY 1 "${DST}"`), 'UID COPY 1 <dest> is sent');
                check(mvCmds.some(c => /^UID STORE 1 \+FLAGS(\.SILENT)? \(\\Deleted\)$/.test(c)), 'UID STORE 1 +FLAGS.SILENT (\\Deleted) is sent');
                if (p.hasUidplus) {
                    check(mvCmds.includes('UID EXPUNGE 1') && !mvCmds.includes('EXPUNGE'), 'finished with UID EXPUNGE 1 (UIDPLUS), never a plain EXPUNGE');
                } else {
                    check(mvCmds.includes('EXPUNGE') && !mvCmds.some(c => c.startsWith('UID EXPUNGE')), 'finished with a plain EXPUNGE (no UIDPLUS, so no UID EXPUNGE)');
                }
            }
            const uidMap = mv && mv.uidMap instanceof Map ? [...mv.uidMap] : null;
            obs.moveResult = mv ? { destination: mv.destination, uidMap } : mv;
            check(!!uidMap && sameList(uidMap, [[1, 1]]), 'messageMove() resolves with uidMap {1 => 1} (from COPYUID)',
                p.hasUidplus ? '' : 'Dovecot sends COPYUID even when UIDPLUS is not advertised; a real non-UIDPLUS server would not');
            const afterMove = numeric(await client.search({ all: true }, { uid: true }));
            obs.afterMove = afterMove;
            if (p.hasMove || p.hasUidplus) {
                check(sameList(afterMove, [2, 3, 4]), `the pending \\Deleted uid 4 SURVIVES the move (${p.hasMove ? 'MOVE' : 'UID EXPUNGE'} only removed uid 1)`, `[${afterMove}]`);
            } else {
                check(sameList(afterMove, [2, 3]), 'the plain EXPUNGE ALSO PURGED the pending \\Deleted uid 4 (the data loss SPEC 2.4 must prevent)', `[${afterMove}]`);
            }

            // uid 3 becomes the next bystander
            await client.messageFlagsAdd('3', ['\\Deleted'], { uid: true });
            cap.start();
            const del = await client.messageDelete('2', { uid: true });
            const delCmds = commandsOf(cap.stop());
            obs.deleteCommands = delCmds;
            console.log(`        messageDelete('2', {uid:true}) sent: ${delCmds.join(' ; ')}`);
            check(del === true, 'messageDelete() resolves true');
            check(delCmds.some(c => /^UID STORE 2 \+FLAGS(\.SILENT)? \(\\Deleted\)$/.test(c)), 'UID STORE 2 +FLAGS (\\Deleted) is sent');
            if (p.hasUidplus) check(delCmds.includes('UID EXPUNGE 2') && !delCmds.includes('EXPUNGE'), 'finished with UID EXPUNGE 2, never a plain EXPUNGE');
            else check(delCmds.includes('EXPUNGE') && !delCmds.some(c => c.startsWith('UID EXPUNGE')), 'finished with a plain EXPUNGE');
            const afterDelete = numeric(await client.search({ all: true }, { uid: true }));
            obs.afterDelete = afterDelete;
            if (p.hasUidplus) {
                const survivors = afterMove.filter(u => u !== 2);
                check(sameList(afterDelete, survivors), `pending \\Deleted uids ${survivors.join(' and ')} survive the delete`, `[${afterDelete}]`);
            } else {
                check(sameList(afterDelete, []), 'the plain EXPUNGE also purged every other pending \\Deleted message', `[${afterDelete}]`);
            }
        } finally {
            lock.release();
        }
        const dstStatus = await client.status(DST, { messages: true });
        check(dstStatus.messages === 1, `${DST} holds the moved message`, `messages=${dstStatus.messages}`);

        sub('raw protocol: commands sent although not advertised (informational)');
        obs.rawUnadvertised = await withRawSession(p.imapPort, async raw => {
            const out = {};
            await raw.command(`SELECT ${DST}`);
            const move = await raw.command(`UID MOVE 1 ${SRC}`);
            out.uidMove = `${move.status} ${move.text}`;
            info(`UID MOVE (MOVE ${p.hasMove ? 'advertised' : 'NOT advertised'})`, out.uidMove);
            await raw.command(`SELECT ${SRC}`);
            const uidExpunge = await raw.command('UID EXPUNGE 999');
            out.uidExpunge = `${uidExpunge.status} ${uidExpunge.text}`;
            info(`UID EXPUNGE (UIDPLUS ${p.hasUidplus ? 'advertised' : 'NOT advertised'})`, out.uidExpunge);
            const special = await raw.command('LIST (SPECIAL-USE) "" "*"');
            out.listSpecialUse = `${special.status}, ${special.untagged.filter(l => l.startsWith('* LIST ')).length} mailboxes`;
            info('LIST (SPECIAL-USE) "" "*"', out.listSpecialUse);
            return out;
        });

        sub('IDLE');
        const watcher = imapflow(p);
        watcher.on('error', () => {});
        await watcher.connect();
        await watcher.mailboxOpen(DST);
        const existsSeen = new Promise(resolve => {
            const t = setTimeout(() => resolve(null), 5000);
            watcher.on('exists', ev => {
                clearTimeout(t);
                resolve(ev);
            });
        });
        const idleP = watcher.idle();
        await client.append(DST, scratchMessage(5), ['\\Seen']);
        const ev = await existsSeen;
        check(!!ev, 'a second connection in IDLE receives the EXISTS push', ev ? JSON.stringify({ path: ev.path, count: ev.count }) : 'timeout');
        await watcher.logout().catch(() => watcher.close());
        await idleP.catch(() => {});

        for (const f of [SRC, DST]) await client.mailboxDelete(f).catch(() => {});
        check(!(await client.list()).some(f => f.path === SRC || f.path === DST), 'scratch folders deleted');
    } finally {
        await client.logout().catch(() => client.close());
    }
    return obs;
}

async function checkMainUntouched() {
    section(`main instance (127.0.0.1:${MAIN_IMAP_PORT}), read-only`);
    if (!(await portOpen(MAIN_IMAP_PORT))) {
        info('main instance not running, skipped');
        return;
    }
    const caps = await withRawSession(MAIN_IMAP_PORT, async raw => capsFromResponse(await raw.command('CAPABILITY')));
    check(!!caps && caps.includes('MOVE') && caps.includes('SPECIAL-USE') && caps.includes('UIDPLUS'),
        'main instance still advertises MOVE, SPECIAL-USE and UIDPLUS (profiles do not affect it)');
}

async function main() {
    const known = knownProfiles();
    const arg = process.argv.slice(2).find(a => !a.startsWith('--')) || 'all';
    if (arg !== 'all' && !known.includes(arg)) {
        console.error(`unknown profile "${arg}". Known: ${known.join(', ')} (or all)`);
        process.exit(2);
    }
    const all = known.map(loadProfile);
    const selected = arg === 'all' ? all : all.filter(p => p.name === arg);
    const observed = [];
    for (const p of selected) observed.push(await verifyProfile(p, all));
    await checkMainUntouched();

    section('observed imapflow behaviour (summary)');
    for (const o of observed) {
        if (!o.moveCommands) continue;
        const su = (o.list || []).filter(f => f.specialUse).map(f => `${f.path}=${f.specialUse}(${f.specialUseSource})`).join(', ');
        console.log(`  [${o.profile}] IMAP ${o.ports.imap} / IMAPS ${o.ports.imaps}`);
        console.log(`    specialUse: ${su}`);
        console.log(`    list(): ${o.listCommands.join(' ; ')}`);
        console.log(`    messageMove: ${o.moveCommands.join(' ; ')}  -> source afterwards [${o.afterMove}]`);
        console.log(`    messageDelete: ${o.deleteCommands.join(' ; ')}  -> source afterwards [${o.afterDelete}]`);
        console.log(`    ${o.appendUid}; raw UID MOVE: ${o.rawUnadvertised.uidMove}; raw UID EXPUNGE: ${o.rawUnadvertised.uidExpunge}`);
    }

    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('verify-profiles crashed:', err);
    process.exit(2);
});
