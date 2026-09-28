#!/usr/bin/env node
// SMTP sink that mimics smtp.mail.me.com closely enough for integration tests.
//
//  * listens on 127.0.0.1:1587 (SMTP_PORT), plaintext with STARTTLS offered (self-signed test CA)
//  * AUTH PLAIN / LOGIN required before MAIL FROM; accepts testuser or testuser@icloud.test with
//    password "app-specific-pass", everything else gets 535 5.7.8
//  * AUTH is also allowed without TLS (tests only; real iCloud requires STARTTLS on 587)
//  * envelope MAIL FROM must be one of the account's addresses, like iCloud's
//    "550 5.7.0 From address is not one of your addresses" (disable with SMTP_ENFORCE_FROM=0)
//  * NEVER relays. Every accepted message is written to smtp-out/<stamp>-<seq>.eml plus a
//    <stamp>-<seq>.json sidecar with the SMTP envelope, and a line is appended to smtp-out/index.jsonl
//  * does NOT copy anything into "Sent Messages" (iCloud does not either; the client must APPEND)
//  * limits like iCloud: 20 MB message size (SIZE advertised, 552 when exceeded) and 500 recipients per
//    message (452 for the 501st RCPT TO)
//  * failure injection by recipient domain:
//        *@reject.test       -> 550 5.1.1 at RCPT TO
//        *@tempfail.test     -> 451 4.3.0 at RCPT TO
//        *@reject-data.test  -> accepted at RCPT, 554 5.7.1 after DATA (like a content-policy reject)
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.SMTP_HOST || '127.0.0.1';
const PORT = Number(process.env.SMTP_PORT || 1587);
const OUT_DIR = path.resolve(process.env.SMTP_OUT_DIR || path.join(ROOT, 'smtp-out'));
const PID_FILE = path.join(ROOT, 'run', 'smtp-sink.pid');
const MAX_SIZE = Number(process.env.SMTP_MAX_SIZE || 20 * 1024 * 1024); // iCloud: 20 MB per message (support.apple.com/102198)
const MAX_RCPT = Number(process.env.SMTP_MAX_RECIPIENTS || 500); // iCloud: 500 recipients per message (same page)
const ENFORCE_FROM = !['0', 'false', 'no'].includes(String(process.env.SMTP_ENFORCE_FROM ?? '1').toLowerCase());

const USERS = new Map([
    ['testuser', 'app-specific-pass'],
    ['testuser@icloud.test', 'app-specific-pass']
]);
// Addresses the test account may send as (primary + aliases, as configured in iCloud settings).
const ALLOWED_FROM = new Set(
    (process.env.SMTP_ALLOWED_FROM || 'testuser@icloud.test,testuser.alias@icloud.test')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });

const log = (...args) => console.log(new Date().toISOString(), '[smtp-sink]', ...args);

let seq = 0;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('.', '');

function smtpError(code, message) {
    const err = new Error(message);
    err.responseCode = code;
    return err;
}

const server = new SMTPServer({
    name: 'smtp.icloud.test',
    banner: 'iCloud-like SMTP test sink (no relay)',
    secure: false, // plaintext socket; STARTTLS upgrade offered
    key: fs.readFileSync(path.join(ROOT, 'certs', 'server.key')),
    cert: fs.readFileSync(path.join(ROOT, 'certs', 'server.crt')),
    authMethods: ['PLAIN', 'LOGIN'],
    authOptional: false,
    allowInsecureAuth: true, // tests may AUTH without STARTTLS
    size: MAX_SIZE,
    disabledCommands: [],
    // We write RFC 3463 enhanced codes into our own reply texts (e.g. "550 5.7.0 ..."), so stop
    // smtp-server from prefixing its generic per-code mapping (it would print "550 5.1.1 5.7.0 ...").
    hideENHANCEDSTATUSCODES: true,
    disableReverseLookup: true,
    maxClients: 50,
    logger: false,

    onConnect(session, cb) {
        log(`connect ${session.remoteAddress}:${session.remotePort} id=${session.id}`);
        cb();
    },

    onAuth(auth, session, cb) {
        const username = String(auth.username || '').toLowerCase();
        const ok = USERS.has(username) && USERS.get(username) === auth.password;
        if (!ok) {
            log(`auth FAILED method=${auth.method} user=${JSON.stringify(auth.username)} id=${session.id}`);
            // iCloud answers bad credentials with 535 5.7.8
            return cb(smtpError(535, '5.7.8 Authentication credentials invalid'));
        }
        log(`auth ok method=${auth.method} user=${username} tls=${session.secure} id=${session.id}`);
        cb(null, { user: username });
    },

    onMailFrom(address, session, cb) {
        const from = String(address.address || '').toLowerCase();
        if (ENFORCE_FROM && !ALLOWED_FROM.has(from)) {
            log(`MAIL FROM rejected <${from}> id=${session.id}`);
            return cb(smtpError(550, '5.7.0 From address is not one of your addresses'));
        }
        cb();
    },

    onRcptTo(address, session, cb) {
        const rcpt = String(address.address || '').toLowerCase();
        const domain = rcpt.split('@').pop();
        if (session.envelope.rcptTo.length >= MAX_RCPT) {
            // exact iCloud wording unverified; RFC 5321 4.5.3.1.10 suggests 452 for "too many recipients"
            return cb(smtpError(452, `4.5.3 Too many recipients (max ${MAX_RCPT} per message)`));
        }
        if (domain === 'reject.test') {
            return cb(smtpError(550, `5.1.1 <${rcpt}>: Recipient address rejected: User unknown`));
        }
        if (domain === 'tempfail.test') {
            return cb(smtpError(451, `4.3.0 <${rcpt}>: Temporary failure, try again later`));
        }
        cb();
    },

    onData(stream, session, cb) {
        const chunks = [];
        let bytes = 0;
        stream.on('data', chunk => {
            // stop buffering once over the limit, but keep draining the stream
            if (!stream.sizeExceeded) {
                chunks.push(chunk);
                bytes += chunk.length;
            }
        });
        stream.on('error', err => cb(err));
        stream.on('end', async () => {
            if (stream.sizeExceeded) {
                log(`message rejected: size exceeds ${MAX_SIZE} id=${session.id}`);
                return cb(smtpError(552, `5.3.4 Message size exceeds fixed maximum message size (${MAX_SIZE})`));
            }
            const rcpts = session.envelope.rcptTo.map(r => r.address.toLowerCase());
            if (rcpts.some(r => r.endsWith('@reject-data.test'))) {
                return cb(smtpError(554, '5.7.1 Message rejected due to local policy'));
            }
            try {
                const raw = Buffer.concat(chunks, bytes);
                const base = `${stamp()}-${String(++seq).padStart(4, '0')}`;
                const emlPath = path.join(OUT_DIR, `${base}.eml`);
                const jsonPath = path.join(OUT_DIR, `${base}.json`);

                let parsed = null;
                try {
                    parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
                } catch (err) {
                    log(`warning: could not parse message: ${err.message}`);
                }
                const addrList = v => (v ? (Array.isArray(v) ? v : [v]).flatMap(x => x.value.map(a => a.address)) : []);
                const headerFrom = parsed ? addrList(parsed.from) : [];

                const queueId = crypto.randomBytes(6).toString('hex').toUpperCase();
                const sidecar = {
                    queueId,
                    file: path.basename(emlPath),
                    receivedAt: new Date().toISOString(),
                    size: raw.length,
                    envelope: {
                        mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : null,
                        mailFromArgs: session.envelope.mailFrom ? session.envelope.mailFrom.args || {} : {},
                        rcptTo: session.envelope.rcptTo.map(r => r.address),
                        bodyType: session.envelope.bodyType,
                        smtpUtf8: session.envelope.smtpUtf8
                    },
                    auth: { user: session.user || null },
                    tls: session.secure ? { starttls: true, cipher: session.tlsOptions && session.tlsOptions.name } : { starttls: false },
                    client: { hostname: session.clientHostname, openingCommand: session.openingCommand, remoteAddress: session.remoteAddress },
                    headers: parsed
                        ? {
                              messageId: parsed.messageId || null,
                              subject: parsed.subject ?? null,
                              date: parsed.date ? parsed.date.toISOString() : null,
                              from: headerFrom,
                              to: addrList(parsed.to),
                              cc: addrList(parsed.cc),
                              bcc: addrList(parsed.bcc), // should normally be empty: Bcc must not be in the transmitted header
                              inReplyTo: parsed.inReplyTo || null,
                              references: parsed.references || null,
                              attachments: (parsed.attachments || []).map(a => ({ filename: a.filename || null, contentType: a.contentType, size: a.size }))
                          }
                        : null,
                    // iCloud accounts can only send as their own addresses; flag header/envelope mismatches for tests
                    headerFromMatchesEnvelope: parsed ? headerFrom.map(a => a.toLowerCase()).includes(String(session.envelope.mailFrom?.address || '').toLowerCase()) : null
                };

                fs.writeFileSync(emlPath, raw);
                fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2) + '\n');
                fs.appendFileSync(path.join(OUT_DIR, 'index.jsonl'), JSON.stringify(sidecar) + '\n');
                log(`stored ${path.basename(emlPath)} from=<${sidecar.envelope.mailFrom}> to=${sidecar.envelope.rcptTo.join(',')} size=${raw.length}`);
                cb(null, `2.0.0 Ok: queued as ${queueId}`);
            } catch (err) {
                log(`error storing message: ${err.stack || err}`);
                cb(smtpError(451, '4.3.0 Local error while storing message'));
            }
        });
    }
});

server.on('error', err => log('server error:', err.message));

server.listen(PORT, HOST, () => {
    fs.writeFileSync(PID_FILE, String(process.pid) + '\n');
    log(`listening on ${HOST}:${PORT} (STARTTLS available, AUTH PLAIN/LOGIN, enforceFrom=${ENFORCE_FROM}, maxSize=${MAX_SIZE}) -> ${OUT_DIR}`);
});

const shutdown = sig => {
    log(`received ${sig}, shutting down`);
    server.close(() => {
        try {
            if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
        } catch {
            // ignore
        }
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
