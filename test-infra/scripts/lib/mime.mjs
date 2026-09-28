// Minimal deterministic RFC 5322 / MIME builder for test fixtures.
// Hand-rolled on purpose: no random boundaries or Message-IDs, byte-for-byte reproducible output.
import zlib from 'node:zlib';

export const CRLF = '\r\n';

// ------------------------------------------------------------------ PRNG (mulberry32)
export function prng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function randomBytes(len, seed) {
    const rnd = prng(seed);
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = Math.floor(rnd() * 256);
    return buf;
}

// ------------------------------------------------------------------ transfer encodings
export function base64Lines(buf) {
    const b64 = Buffer.from(buf).toString('base64');
    const lines = [];
    for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
    return lines.join(CRLF);
}

export function quotedPrintable(input, charset = 'utf-8') {
    const text = typeof input === 'string' ? input : input.toString('latin1');
    const srcLines = text.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    for (const srcLine of srcLines) {
        const bytes = Buffer.from(srcLine, charset === 'iso-8859-1' ? 'latin1' : 'utf8');
        let line = '';
        const tokens = [];
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            const isLast = i === bytes.length - 1;
            if ((b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !isLast)) {
                tokens.push(String.fromCharCode(b));
            } else {
                tokens.push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
            }
        }
        for (const tok of tokens) {
            if (line.length + tok.length > 75) {
                out.push(line + '=');
                line = '';
            }
            line += tok;
        }
        out.push(line);
    }
    return out.join(CRLF);
}

export function crlf(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n/g, CRLF);
}

// ------------------------------------------------------------------ RFC 2047 encoded words
function chunkByBytes(str, maxBytes, charset) {
    const enc = charset.toLowerCase() === 'iso-8859-1' ? 'latin1' : 'utf8';
    const chunks = [];
    let cur = '';
    for (const ch of Array.from(str)) {
        if (Buffer.byteLength(cur + ch, enc) > maxBytes && cur) {
            chunks.push(cur);
            cur = '';
        }
        cur += ch;
    }
    if (cur) chunks.push(cur);
    return chunks;
}

/** Encodes a header value as one or more RFC 2047 encoded-words, folded with CRLF+SP. */
export function encodeWords(str, { encoding = 'B', charset = 'UTF-8' } = {}) {
    const enc = charset.toLowerCase() === 'iso-8859-1' ? 'latin1' : 'utf8';
    const prefix = `=?${charset}?${encoding}?`;
    const overhead = prefix.length + 2;
    if (encoding === 'B') {
        const maxBytes = Math.floor((75 - overhead) / 4) * 3;
        return chunkByBytes(str, maxBytes, charset)
            .map(c => `${prefix}${Buffer.from(c, enc).toString('base64')}?=`)
            .join(CRLF + ' ');
    }
    // Q encoding: worst case 3 output chars per byte
    const maxBytes = Math.floor((75 - overhead) / 3);
    return chunkByBytes(str, maxBytes, charset)
        .map(c => {
            let q = '';
            for (const b of Buffer.from(c, enc)) {
                if (b === 32) q += '_';
                else if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || '!*+-/'.includes(String.fromCharCode(b))) q += String.fromCharCode(b);
                else q += '=' + b.toString(16).toUpperCase().padStart(2, '0');
            }
            return `${prefix}${q}?=`;
        })
        .join(CRLF + ' ');
}

const isAscii = s => /^[\x20-\x7e]*$/.test(s);

/** Formats an address: {name, address} or string. Non-ASCII names become encoded-words. */
export function formatAddress(a, opts = {}) {
    if (!a) return '';
    if (typeof a === 'string') return a;
    if (!a.name) return a.address;
    const name = isAscii(a.name)
        ? /[()<>@,;:\\".[\]]/.test(a.name)
            ? `"${a.name.replace(/(["\\])/g, '\\$1')}"`
            : a.name
        : encodeWords(a.name, { encoding: opts.encoding || 'Q', charset: opts.charset || 'UTF-8' });
    return `${name} <${a.address}>`;
}

export function formatAddressList(list, opts) {
    if (!list) return '';
    const arr = Array.isArray(list) ? list : [list];
    return arr.map(a => formatAddress(a, opts)).join(',' + CRLF + ' ');
}

// ------------------------------------------------------------------ dates
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-02-10T13:05:00-08:00' -> 'Tue, 10 Feb 2026 13:05:00 -0800' (keeps the given offset). */
export function rfc2822Date(iso) {
    const m = /([+-])(\d{2}):?(\d{2})$|Z$/.exec(iso);
    if (!m) throw new Error(`date needs explicit offset: ${iso}`);
    const sign = m[1] === '-' ? -1 : 1;
    const offMin = m[0] === 'Z' ? 0 : sign * (Number(m[2]) * 60 + Number(m[3]));
    const t = new Date(iso);
    const local = new Date(t.getTime() + offMin * 60000);
    const pad = n => String(n).padStart(2, '0');
    const offStr = (offMin < 0 ? '-' : '+') + pad(Math.floor(Math.abs(offMin) / 60)) + pad(Math.abs(offMin) % 60);
    return `${DAYS[local.getUTCDay()]}, ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${offStr}`;
}

// ------------------------------------------------------------------ MIME entities
// An entity is { headers: [[name, value], ...], body: string } with body already transfer-encoded.

export function textPart(text, { subtype = 'plain', charset = 'utf-8', encoding = 'quoted-printable', params = '', headers = [] } = {}) {
    let body;
    if (encoding === 'quoted-printable') body = quotedPrintable(text, charset);
    else if (encoding === 'base64') body = base64Lines(Buffer.from(text, charset === 'iso-8859-1' ? 'latin1' : 'utf8'));
    else body = crlf(text); // 7bit / 8bit
    return {
        headers: [['Content-Type', `text/${subtype}; charset=${charset}${params}`], ['Content-Transfer-Encoding', encoding], ...headers],
        body
    };
}

export function attachmentPart(buf, { contentType, filename, filenameStar, inline = false, cid, encoding = 'base64', headers = [] }) {
    const h = [];
    let ct = contentType;
    if (filename) ct += `;${CRLF} name="${filename}"`;
    h.push(['Content-Type', ct]);
    let disp = inline ? 'inline' : 'attachment';
    if (filenameStar) disp += `;${CRLF} filename*=${filenameStar}`;
    else if (filename) disp += `;${CRLF} filename="${filename}"`;
    h.push(['Content-Disposition', disp]);
    if (cid) h.push(['Content-ID', `<${cid}>`]);
    h.push(['Content-Transfer-Encoding', encoding]);
    h.push(...headers);
    return { headers: h, body: encoding === 'base64' ? base64Lines(buf) : crlf(buf.toString('utf8')) };
}

export function messagePart(rawMessage, { headers = [] } = {}) {
    return {
        headers: [['Content-Type', 'message/rfc822'], ['Content-Disposition', 'attachment'], ['Content-Transfer-Encoding', '7bit'], ...headers],
        body: rawMessage.replace(/\r\n$/, '')
    };
}

export function multipart(subtype, parts, boundary, { params = '' } = {}) {
    const lines = ['This is a multi-part message in MIME format.', ''];
    for (const p of parts) {
        lines.push(`--${boundary}`);
        lines.push(serializeEntity(p));
    }
    lines.push(`--${boundary}--`, '');
    return {
        headers: [['Content-Type', `multipart/${subtype};${CRLF} boundary="${boundary}"${params}`]],
        body: lines.join(CRLF)
    };
}

export function serializeEntity(entity) {
    const head = entity.headers.map(([k, v]) => `${k}: ${v}`).join(CRLF);
    return head + CRLF + CRLF + entity.body;
}

/**
 * Builds a complete message.
 * msg: { from, to, cc, bcc, replyTo, subject (string|null; null = omit header), subjectEncoding,
 *        date (ISO with offset), messageId, inReplyTo, references[], headers: [[k,v]], root: entity }
 */
export function buildMessage(msg) {
    const h = [];
    const addrOpts = { encoding: msg.addressEncoding || 'Q', charset: msg.addressCharset || 'UTF-8' };
    if (msg.returnPath) h.push(['Return-Path', `<${msg.returnPath}>`]);
    for (const [k, v] of msg.traceHeaders || []) h.push([k, v]);
    h.push(['From', formatAddress(msg.from, addrOpts)]);
    if (msg.to) h.push(['To', formatAddressList(msg.to, addrOpts)]);
    if (msg.cc) h.push(['Cc', formatAddressList(msg.cc, addrOpts)]);
    if (msg.bcc) h.push(['Bcc', formatAddressList(msg.bcc, addrOpts)]);
    if (msg.replyTo) h.push(['Reply-To', formatAddressList(msg.replyTo, addrOpts)]);
    if (msg.subject !== null && msg.subject !== undefined) {
        const subj = msg.subjectEncoding
            ? encodeWords(msg.subject, { encoding: msg.subjectEncoding, charset: msg.subjectCharset || 'UTF-8' })
            : msg.subject;
        h.push(['Subject', subj]);
    }
    h.push(['Date', rfc2822Date(msg.date)]);
    h.push(['Message-ID', `<${msg.messageId}>`]);
    if (msg.inReplyTo) h.push(['In-Reply-To', `<${msg.inReplyTo}>`]);
    if (msg.references && msg.references.length) h.push(['References', msg.references.map(r => `<${r}>`).join(CRLF + ' ')]);
    h.push(['MIME-Version', msg.mimeVersion || '1.0']);
    for (const [k, v] of msg.headers || []) h.push([k, v]);
    h.push(...msg.root.headers);
    return h.map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF + msg.root.body + (msg.root.body.endsWith(CRLF) ? '' : CRLF);
}

// ------------------------------------------------------------------ binary fixtures
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Deterministic RGB PNG (size x size) with a simple gradient + diagonal. */
export function makePng(size = 16, seed = 1) {
    const rnd = prng(seed);
    const base = [Math.floor(rnd() * 200), Math.floor(rnd() * 200), Math.floor(rnd() * 200)];
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 3 + 1)] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const o = y * (size * 3 + 1) + 1 + x * 3;
            const diag = x === y || x === size - 1 - y;
            raw[o] = diag ? 255 : (base[0] + x * 3) & 0xff;
            raw[o + 1] = diag ? 255 : (base[1] + y * 3) & 0xff;
            raw[o + 2] = diag ? 255 : base[2];
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/** Small but structurally valid single-page PDF containing the given text lines. */
export function makePdf(lines) {
    const esc = s => s.replace(/([\\()])/g, '\\$1');
    const content = ['BT', '/F1 14 Tf', '72 720 Td', '18 TL', ...lines.map(l => `(${esc(l)}) '`), 'ET'].join('\n');
    const objs = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    ];
    // header + binary comment line, as real PDF writers emit (marks the file as binary)
    const parts = [Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])];
    let offset = parts.reduce((n, b) => n + b.length, 0);
    const offsets = [];
    objs.forEach((o, i) => {
        const s = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
        offsets.push(offset);
        offset += s.length;
        parts.push(s);
    });
    const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f ', ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n `)].join('\n') + '\n';
    parts.push(Buffer.from(xref, 'latin1'));
    parts.push(Buffer.from(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
}
