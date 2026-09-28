import type { MessageStructureObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import {
  collectAttachments,
  decodePartialBody,
  decodeTransferEncoding,
  findPart,
  findSnippetPart,
  hasRealAttachments,
  selectBodyParts,
  selectHtmlParts,
} from '../../src/imap/mime.js';

describe('snippet decoding of partial fetches', () => {
  it('decodes quoted-printable cut in the middle of an escape', () => {
    const qp = Buffer.from('Gr=C3=BC=C3=9Fe aus K=C3=B6ln, dies ist ein l=\r\nanger Text =C3', 'latin1');
    expect(decodePartialBody(qp, 'quoted-printable', 'utf-8')).toBe('Grüße aus Köln, dies ist ein langer Text ');
    expect(decodePartialBody(Buffer.from('abc=', 'latin1'), 'quoted-printable', 'utf-8')).toBe('abc');
    expect(decodePartialBody(Buffer.from('abc=4', 'latin1'), 'quoted-printable', 'utf-8')).toBe('abc');
  });

  it('decodes base64 truncated at any length', () => {
    const full = Buffer.from('Héllo wörld – ünïcode test').toString('base64');
    for (let n = 0; n <= full.length; n++) {
      const out = decodePartialBody(Buffer.from(full.slice(0, n)), 'base64', 'utf-8');
      expect('Héllo wörld – ünïcode test'.startsWith(out), `${n}: ${out}`).toBe(true);
    }
    expect(decodePartialBody(Buffer.from(`${full.slice(0, 8)}\r\n${full.slice(8)}`), 'BASE64', 'UTF-8')).toBe('Héllo wörld – ünïcode test');
  });

  it('decodes latin-1 and windows-1252 bodies', () => {
    expect(decodePartialBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), '8bit', 'iso-8859-1')).toBe('café');
    expect(decodePartialBody(Buffer.from('Gr=FC=DFe', 'latin1'), 'quoted-printable', 'ISO-8859-1')).toBe('Grüße');
    expect(decodePartialBody(Buffer.from([0x93, 0x68, 0x69, 0x94]), '7bit', 'windows-1252')).toBe('“hi”');
    expect(decodePartialBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), '8bit', '"latin1"')).toBe('café');
  });

  it('falls back to UTF-8 for unknown charsets and drops a cut multi-byte tail', () => {
    expect(decodePartialBody(Buffer.from('plain text'), '7bit', 'x-unknown-charset')).toBe('plain text');
    const cut = Buffer.from('ab€').subarray(0, 4); // € is 3 bytes, cut after 2
    expect(decodePartialBody(cut, '8bit', 'utf-8')).toBe('ab');
  });

  it('decodes ISO-2022-JP and Shift_JIS', () => {
    const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]); // 日本
    expect(decodePartialBody(sjis, '8bit', 'shift_jis')).toBe('日本');
  });

  it('passes other encodings through', () => {
    expect(decodeTransferEncoding(Buffer.from('x'), 'binary').toString()).toBe('x');
  });
});

const invoice: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' }, size: 118 },
    { part: '2', type: 'application/pdf', encoding: 'base64', size: 948, disposition: 'attachment', dispositionParameters: { filename: 'Invoice.pdf' } },
  ],
};

const related: MessageStructureObject = {
  type: 'multipart/related',
  childNodes: [
    {
      part: '1',
      type: 'multipart/alternative',
      childNodes: [
        { part: '1.1', type: 'text/plain', encoding: 'quoted-printable', parameters: { charset: 'utf-8' }, size: 65 },
        { part: '1.2', type: 'text/html', encoding: 'quoted-printable', parameters: { charset: 'utf-8' }, size: 177 },
      ],
    },
    { part: '2', type: 'image/png', encoding: 'base64', size: 706, disposition: 'inline', dispositionParameters: { filename: 'summit.png' }, id: '<summit@x>' },
  ],
};

const forwarded: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', encoding: '7bit', size: 49 },
    { part: '2', type: 'message/rfc822', encoding: '7bit', size: 381, disposition: 'attachment', childNodes: [{ part: '2', type: 'text/plain', size: 94 }] },
  ],
};

describe('body part selection', () => {
  it('uses the single part of a single-part message', () => {
    const single: MessageStructureObject = { type: 'text/html', encoding: 'base64', parameters: { charset: 'windows-1252' }, size: 10 };
    expect(selectBodyParts(single)).toEqual([{ part: '1', type: 'text/html', encoding: 'base64', charset: 'windows-1252', size: 10 }]);
    expect(findSnippetPart(single)).toMatchObject({ part: 'TEXT', type: 'text/html' });
  });

  it('prefers text/plain in multipart/alternative, even nested under related', () => {
    expect(selectBodyParts(related).map((p) => p.part)).toEqual(['1.1']);
    expect(selectHtmlParts(related).map((p) => p.part)).toEqual(['1.2']);
    expect(findSnippetPart(related)?.part).toBe('1.1');
  });

  it('uses HTML when an alternative has no plain part', () => {
    const alt: MessageStructureObject = {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/calendar', size: 5 },
        { part: '2', type: 'text/html', size: 5 },
      ],
    };
    expect(selectBodyParts(alt).map((p) => `${p.part}:${p.type}`)).toEqual(['2:text/html']);
  });

  it('concatenates inline text parts of multipart/mixed in order, skipping attachments', () => {
    const mixed: MessageStructureObject = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 5 },
        { part: '2', type: 'image/jpeg', disposition: 'inline', dispositionParameters: { filename: 'a.jpg' }, size: 5 },
        { part: '3', type: 'text/plain', size: 5 },
        { part: '4', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' }, size: 5 },
        { part: '5', type: 'text/html', size: 5 },
      ],
    };
    expect(selectBodyParts(mixed).map((p) => p.part)).toEqual(['1', '3', '5']);
  });

  it('never descends into an attached message for the body', () => {
    expect(selectBodyParts(forwarded).map((p) => p.part)).toEqual(['1']);
    expect(findSnippetPart(forwarded)?.part).toBe('1');
  });
});

describe('attachment discovery', () => {
  it('lists disposition=attachment parts', () => {
    expect(collectAttachments(invoice)).toEqual([expect.objectContaining({ part: '2', filename: 'Invoice.pdf', content_type: 'application/pdf', size: 948, inline: false, content_id: null })]);
    expect(hasRealAttachments(invoice)).toBe(true);
  });

  it('marks inline images with a Content-ID and excludes them from has_attachments', () => {
    expect(collectAttachments(related)).toEqual([expect.objectContaining({ part: '2', filename: 'summit.png', content_type: 'image/png', size: 706, inline: true, content_id: '<summit@x>' })]);
    expect(hasRealAttachments(related)).toBe(false);
  });

  it('lists message/rfc822 parts and non-text parts with a name', () => {
    expect(collectAttachments(forwarded)).toEqual([expect.objectContaining({ part: '2', filename: null, content_type: 'message/rfc822', size: 381, inline: false, content_id: null })]);
    const named: MessageStructureObject = { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain' }, { part: '2', type: 'application/zip', parameters: { name: 'a.zip' } }] };
    expect(collectAttachments(named).map((a) => a.filename)).toEqual(['a.zip']);
  });

  // imap-13: Apple Mail sends attached photos as inline images with a filename and a Content-ID.
  it('counts an inline photo with a filename as an attachment, but not a small named logo or a nameless cid image', () => {
    const photo: MessageStructureObject = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/html', size: 300 },
        { part: '2', type: 'image/jpeg', id: '<x@y>', disposition: 'inline', dispositionParameters: { filename: 'IMG_1234.jpeg' }, size: 12_000, encoding: 'base64' },
      ],
    };
    expect(hasRealAttachments(photo)).toBe(true);
    const big: MessageStructureObject = {
      type: 'multipart/related',
      childNodes: [{ part: '1', type: 'text/html' }, { part: '2', type: 'image/png', id: '<p@y>', disposition: 'inline', dispositionParameters: { filename: 'beach.png' }, size: 900_000 }],
    };
    expect(hasRealAttachments(big)).toBe(true);
    const logo: MessageStructureObject = {
      type: 'multipart/related',
      childNodes: [{ part: '1', type: 'text/html' }, { part: '2', type: 'image/png', id: '<l@y>', disposition: 'inline', dispositionParameters: { filename: 'image001.png' }, size: 4000 }],
    };
    expect(hasRealAttachments(logo)).toBe(false);
    const nameless: MessageStructureObject = { type: 'multipart/related', childNodes: [{ part: '1', type: 'text/html' }, { part: '2', type: 'image/gif', id: '<t@y>', size: 200_000 }] };
    expect(hasRealAttachments(nameless)).toBe(false);
  });

  it('finds parts by number but not inside attached messages', () => {
    expect(findPart(related, '1.2')?.type).toBe('text/html');
    expect(findPart(related, '1')?.type).toBe('multipart/alternative');
    expect(findPart(forwarded, '2')?.type).toBe('message/rfc822');
    expect(findPart(related, '3')).toBeNull();
    expect(findPart({ type: 'text/plain' }, '1')?.type).toBe('text/plain');
  });
});

// fwd-1: forwarded attachments keep the Content-Type parameters that matter.
describe('forwardedContentType', () => {
  it('keeps charset for text (what imapflow delivered) and method for calendar invitations', async () => {
    const { forwardedContentType } = await import('../../src/imap/fetch.js');
    expect(forwardedContentType('text/csv', { type: 'text/csv', parameters: { charset: 'ISO-8859-1', name: 'a.csv' } }, undefined)).toBe('text/csv; charset=iso-8859-1');
    expect(forwardedContentType('text/plain', { type: 'text/plain', parameters: { charset: 'shift_jis' } }, 'utf-8')).toBe('text/plain; charset=utf-8');
    expect(forwardedContentType('text/calendar', { type: 'text/calendar', parameters: { charset: 'utf-8', method: 'request' } }, undefined)).toBe('text/calendar; charset=utf-8; method=REQUEST');
    expect(forwardedContentType('application/pdf', { type: 'application/pdf', parameters: { charset: 'x' } }, undefined)).toBe('application/pdf');
    expect(forwardedContentType('text/plain', { type: 'text/plain', parameters: { charset: 'bad"; x=y' } }, undefined)).toBe('text/plain');
  });
});
