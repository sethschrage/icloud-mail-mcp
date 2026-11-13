/**
 * Minimal namespace-aware XML reader for WebDAV/CalDAV responses (RFC 4918 multistatus).
 *
 * The responses this server reads are small, machine-generated documents: elements, attributes,
 * text, CDATA, comments and the occasional processing instruction. A full XML library would be a
 * dependency for very little, so this parser handles exactly that subset and resolves namespace
 * prefixes (iCloud uses a default `xmlns="DAV:"` next to prefixed CalDAV and Apple elements;
 * other servers prefix everything). DOCTYPE declarations are refused: nothing legitimate here has
 * one, and refusing them rules out entity-expansion tricks.
 */

export interface XmlElement {
  /** Namespace URI ('' when none). */
  ns: string;
  /** Local name without prefix. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text directly inside this element (entities decoded). */
  text: string;
}

export const NS = {
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  APPLE: 'http://apple.com/ns/ical/',
  CS: 'http://calendarserver.org/ns/',
} as const;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ent] ?? whole;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

interface OpenElement {
  el: XmlElement;
  qname: string;
  scope: Map<string, string>;
}

const NAME_RE = /[^\s/>=]+/y;
const ATTR_RE = /\s*([^\s/>=]+)\s*=\s*("([^"]*)"|'([^']*)')/y;

/** Parse an XML document and return its root element. Throws XmlError on malformed input. */
export function parseXml(input: string): XmlElement {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack: OpenElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const rootScope = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);

  const appendText = (text: string): void => {
    const top = stack[stack.length - 1];
    if (top) top.el.text += text;
    else if (text.trim() !== '') throw new XmlError('text outside the root element');
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      appendText(decodeXmlEntities(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeXmlEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('unterminated comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('unterminated CDATA section');
      appendText(src.slice(lt + 9, end));
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('unterminated processing instruction');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      throw new XmlError('DOCTYPE and other declarations are not accepted');
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      if (end === -1) throw new XmlError('unterminated end tag');
      const qname = src.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new XmlError(`unexpected end tag </${qname}>`);
      i = end + 1;
    } else {
      NAME_RE.lastIndex = lt + 1;
      const nameMatch = NAME_RE.exec(src);
      if (!nameMatch) throw new XmlError('malformed start tag');
      const qname = nameMatch[0];
      let j = NAME_RE.lastIndex;
      const rawAttrs: Array<[string, string]> = [];
      for (;;) {
        ATTR_RE.lastIndex = j;
        const a = ATTR_RE.exec(src);
        if (!a) break;
        rawAttrs.push([a[1] as string, decodeXmlEntities(a[3] ?? a[4] ?? '')]);
        j = ATTR_RE.lastIndex;
      }
      while (j < src.length && /\s/.test(src[j] as string)) j++;
      let selfClosing = false;
      if (src[j] === '/' && src[j + 1] === '>') {
        selfClosing = true;
        j += 2;
      } else if (src[j] === '>') {
        j += 1;
      } else {
        throw new XmlError(`malformed start tag <${qname}>`);
      }
      const parentScope = stack[stack.length - 1]?.scope ?? rootScope;
      let scope = parentScope;
      const attrs: Record<string, string> = {};
      for (const [name, value] of rawAttrs) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) {
          if (scope === parentScope) scope = new Map(parentScope);
          scope.set(name === 'xmlns' ? '' : name.slice(6), value);
        } else {
          const colon = name.indexOf(':');
          attrs[colon === -1 ? name : name.slice(colon + 1)] = value;
        }
      }
      const colon = qname.indexOf(':');
      const prefix = colon === -1 ? '' : qname.slice(0, colon);
      const ns = scope.get(prefix);
      if (ns === undefined && prefix !== '') throw new XmlError(`undeclared namespace prefix "${prefix}"`);
      const el: XmlElement = { ns: ns ?? '', name: colon === -1 ? qname : qname.slice(colon + 1), attrs, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent) parent.el.children.push(el);
      else if (root) throw new XmlError('more than one root element');
      else root = el;
      if (!selfClosing) stack.push({ el, qname, scope });
      i = j;
    }
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1]?.qname ?? '?'}>`);
  if (!root) throw new XmlError('empty document');
  return root;
}

/** Direct children with the given namespace and local name. */
export function childrenNamed(el: XmlElement | undefined, ns: string, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.ns === ns && c.name === name) : [];
}

/** First direct child with the given namespace and local name. */
export function child(el: XmlElement | undefined, ns: string, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.ns === ns && c.name === name);
}

/** Text of the first matching child, trimmed ('' when absent). */
export function childText(el: XmlElement | undefined, ns: string, name: string): string {
  return child(el, ns, name)?.text.trim() ?? '';
}
