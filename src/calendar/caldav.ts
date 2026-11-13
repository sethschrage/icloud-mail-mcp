/**
 * Read-only CalDAV client for iCloud Calendar (RFC 4791 over RFC 4918), on node:https.
 *
 * Discovery follows iCloud's layout: PROPFIND caldav.icloud.com for the current-user-principal,
 * then the principal for its calendar-home-set, which lives on a per-account partition host
 * (https://pNN-caldav.icloud.com:443/<dsid>/calendars/). Calendars are the collections in the home
 * whose resourcetype includes C:calendar and that can hold events (iCloud also keeps Reminders lists
 * there, which only hold VTODO). Events come from REPORT calendar-query.
 *
 * Login is the same as for mail: the iCloud address and the app-specific password from the
 * credential provider (redacted everywhere). Credentials are only ever sent over TLS, and only to
 * the configured host or, for iCloud, to other *.icloud.com hosts (the partition host).
 *
 * Every request runs under the current tool call's deadline and cancellation signal (context.ts).
 */
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type tls from 'node:tls';
import { currentContext } from '../context.js';
import { passwordHelp, type CredentialProvider } from '../credentials.js';
import { MailError, errorMessage } from '../errors.js';
import { redact, type Logger } from '../log.js';
import { getRuntime } from '../runtime.js';
import { VERSION } from '../version.js';
import { NS, child, childText, childrenNamed, parseXml, XmlError, type XmlElement } from './xml.js';

export const DEFAULT_CALDAV_URL = 'https://caldav.icloud.com';
/** Largest response accepted (a calendar-query over a busy year of a big calendar stays far below). */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Longest a single request may take, even when the tool deadline is further away. */
export const MAX_REQUEST_MS = 45_000;
const MAX_REDIRECTS = 5;

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface HttpRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | undefined;
}

/** One HTTP exchange (injectable for unit tests). Must reject on network/TLS errors. */
export type HttpFn = (req: HttpRequest, options: { signal?: AbortSignal | undefined; timeoutMs: number; maxBytes: number }) => Promise<HttpResponse>;

export interface CalendarInfo {
  /** Collection path on the calendar host, e.g. /123456/calendars/home/ (stable id for filters). */
  href: string;
  /** Last path segment of href (iCloud: "home", "work" or a UUID). */
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  /** Component types the calendar accepts (VEVENT, VTODO, …); empty when the server did not say. */
  components: string[];
  /** True when the server says the user may not change the calendar (null when it did not say). */
  readOnly: boolean | null;
  /** CalendarServer ctag (changes whenever anything in the calendar changes), when offered. */
  ctag: string | null;
  order: number | null;
}

export interface CalendarObject {
  /** Path of the .ics resource on the calendar host. */
  href: string;
  etag: string | null;
  /** iCalendar text (one VCALENDAR). */
  data: string;
}

export interface CalDavClientOptions {
  baseUrl: string;
  /** Login (the iCloud address). */
  user: () => string;
  credentials: CredentialProvider;
  tlsOptions: () => tls.ConnectionOptions;
  logger: Logger;
  http?: HttpFn;
}

/** RFC 4791 UTC date-time for time-range filters. */
export function caldavUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** Default HttpFn on node:https with a keep-alive agent. */
export function createHttpsFn(agent: () => https.Agent): HttpFn {
  return (req, { signal, timeoutMs, maxBytes }) =>
    new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const r = https.request(
        req.url,
        { method: req.method, headers: req.headers, agent: agent(), timeout: timeoutMs, ...(signal ? { signal } : {}) },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              fail(new MailError('TOO_LARGE', `The calendar server sent more than ${Math.round(maxBytes / 1024 / 1024)} MB for one request; search a shorter date range or fewer calendars.`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', fail);
          res.on('aborted', () => fail(Object.assign(new Error('response aborted'), { code: 'ECONNRESET' })));
        },
      );
      r.on('timeout', () => r.destroy(Object.assign(new Error(`no response within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })));
      r.on('error', fail);
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
}

function isIcloudHost(host: string): boolean {
  return host === 'icloud.com' || host.endsWith('.icloud.com');
}

/** Status line text for messages, e.g. "403 Forbidden". */
function statusText(status: number): string {
  const names: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 412: 'Precondition Failed', 415: 'Unsupported Media Type', 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 507: 'Insufficient Storage' };
  return `${status}${names[status] ? ` ${names[status]}` : ''}`;
}

export function calendarAuthMessage(host: string, user: string): string {
  const cloud = getRuntime() === 'cloud';
  return (
    `iCloud Calendar (${host}) rejected the login for "${user}". Calendars use the same login as mail: your iCloud address and an app-specific password. Likely causes: ` +
    '(1) your regular Apple Account password was used instead of an app-specific password; ' +
    '(2) the app-specific password was revoked, which happens automatically when the Apple Account password is changed, so create a new one; ' +
    `(3) the login must be an address of your Apple Account (normally your @icloud.com address, set as ${cloud ? 'ICLOUD_EMAIL' : '"iCloud email address" (ICLOUD_EMAIL)'}); ` +
    '(4) app-specific passwords require two-factor authentication on the Apple Account. ' +
    `If mail works but calendars do not, check that Calendars is turned on for iCloud in your Apple Account. ${passwordHelp()}`
  );
}

/** Translate a network/TLS failure into a MailError. */
export function mapNetworkError(err: unknown, host: string): MailError {
  if (err instanceof MailError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const c = typeof code === 'string' ? code : undefined;
  if (c === 'ABORT_ERR' || (err as { name?: unknown } | null)?.name === 'AbortError') {
    return new MailError('CANCELLED', 'The calendar request was cancelled (deadline reached or the call was cancelled).', { cause: err });
  }
  if (c && TLS_CODES.has(c)) {
    return new MailError('CONNECTION', `TLS certificate verification failed for the calendar server ${host} (${c}). If you use a server with a private certificate authority, point MAIL_TLS_CA_FILE at its CA certificate (TLS verification cannot be disabled).`, { cause: err });
  }
  return new MailError('CONNECTION', `Could not reach the calendar server ${host}${c ? ` (${c})` : ''}: ${redact(errorMessage(err))}. Check the internet connection; iCloud may also be briefly unavailable.`, { cause: err });
}

export class CalDavClient {
  private readonly base: URL;
  private readonly http: HttpFn;
  private agentInstance: https.Agent | null = null;
  private home: URL | null = null;
  private discovering: Promise<URL> | null = null;

  constructor(private readonly opts: CalDavClientOptions) {
    this.base = new URL(opts.baseUrl);
    this.http = opts.http ?? createHttpsFn(() => this.agent());
  }

  private agent(): https.Agent {
    this.agentInstance ??= new https.Agent({ keepAlive: true, maxSockets: 8, ...this.opts.tlsOptions() });
    return this.agentInstance;
  }

  get host(): string {
    return this.base.host;
  }

  /** The calendar-home-set found by discovery (null before the first call). */
  get homeUrl(): string | null {
    return this.home ? this.home.href : null;
  }

  close(): void {
    this.agentInstance?.destroy();
    this.agentInstance = null;
  }

  /** Forget discovery results (after an authentication failure, so the next call starts over). */
  reset(): void {
    this.home = null;
  }

  private hostAllowed(url: URL): boolean {
    if (url.protocol !== 'https:') return false;
    if (url.host === this.base.host) return true;
    return isIcloudHost(this.base.hostname) && isIcloudHost(url.hostname);
  }

  /** One request with redirects followed (same method; only to allowed hosts). */
  async request(method: string, url: URL, options: { depth?: '0' | '1'; body?: string; contentType?: string; accept?: string } = {}): Promise<HttpResponse & { url: URL }> {
    const { password } = await this.opts.credentials.getPassword();
    const user = this.opts.user();
    const auth = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!this.hostAllowed(current)) {
        throw new MailError('CONNECTION', `The calendar server pointed to ${current.protocol}//${current.host}, which is not an allowed calendar host (credentials are only sent over https to ${this.base.host}${isIcloudHost(this.base.hostname) ? ' and other icloud.com hosts' : ''}).`);
      }
      const ctx = currentContext();
      if (ctx?.signal?.aborted) throw new MailError('CANCELLED', 'The calendar request was cancelled before it started.');
      const remaining = ctx?.deadlineAt !== undefined ? ctx.deadlineAt - Date.now() : MAX_REQUEST_MS;
      const timeoutMs = Math.max(1000, Math.min(MAX_REQUEST_MS, remaining));
      const headers: Record<string, string> = {
        Authorization: auth,
        'User-Agent': `icloud-mail-mcp/${VERSION}`,
        Accept: options.accept ?? 'application/xml, text/xml;q=0.9, */*;q=0.1',
      };
      if (options.depth !== undefined) headers['Depth'] = options.depth;
      if (options.body !== undefined) {
        headers['Content-Type'] = options.contentType ?? 'application/xml; charset=utf-8';
        headers['Content-Length'] = String(Buffer.byteLength(options.body, 'utf8'));
      }
      const started = Date.now();
      let res: HttpResponse;
      try {
        res = await this.http({ method, url: current, headers, body: options.body }, { signal: ctx?.signal, timeoutMs, maxBytes: MAX_RESPONSE_BYTES });
      } catch (err) {
        throw mapNetworkError(err, current.host);
      }
      this.opts.logger.debug('caldav request', { method, host: current.host, status: res.status, ms: Date.now() - started });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.location;
        if (!location) throw new MailError('SERVER', `The calendar server answered ${method} with a redirect (${res.status}) but no location.`);
        current = new URL(location, current);
        continue;
      }
      return { ...res, url: current };
    }
    throw new MailError('SERVER', `The calendar server redirected more than ${MAX_REDIRECTS} times.`);
  }

  /** Throw the right MailError for a non-success status. */
  private fail(status: number, what: string, host: string, body = ''): never {
    if (status === 401) {
      this.reset();
      this.opts.credentials.invalidate();
      throw new MailError('AUTH', calendarAuthMessage(host, this.opts.user()));
    }
    if (status === 403) {
      throw new MailError('FORBIDDEN', `iCloud Calendar refused ${what} (403 Forbidden). If this happens for every calendar, check that Calendars is turned on for iCloud in your Apple Account settings.`);
    }
    if (status === 404) throw new MailError('NOT_FOUND', `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} was not found on the calendar server (404).`);
    if (status === 429 || status === 503) {
      throw new MailError('CONNECTION', `iCloud Calendar is busy (${statusText(status)}) and could not answer ${what}. Try again in a minute.`);
    }
    const detail = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new MailError('SERVER', `The calendar server answered ${what} with ${statusText(status)}${detail ? ` (${redact(detail)})` : ''}.`);
  }

  private async propfind(url: URL, depth: '0' | '1', props: string, what: string): Promise<{ responses: DavResponseEntry[]; url: URL }> {
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/" xmlns:CS="http://calendarserver.org/ns/"><D:prop>${props}</D:prop></D:propfind>`;
    const res = await this.request('PROPFIND', url, { depth, body });
    if (res.status !== 207) this.fail(res.status, what, res.url.host, res.body);
    return { responses: parseMultistatus(res.body, what), url: res.url };
  }

  /** Discovery: base → current-user-principal → calendar-home-set (cached for the client's life). */
  async discover(): Promise<URL> {
    if (this.home) return this.home;
    this.discovering ??= this.doDiscover().finally(() => {
      this.discovering = null;
    });
    const home = await this.discovering;
    this.home = home;
    return home;
  }

  private async doDiscover(): Promise<URL> {
    let principal: URL | null = null;
    for (const path of ['/', '/.well-known/caldav']) {
      const start = new URL(path, this.base);
      let found: { responses: DavResponseEntry[]; url: URL };
      try {
        found = await this.propfind(start, '0', '<D:current-user-principal/>', 'the calendar account lookup');
      } catch (err) {
        if (err instanceof MailError && (err.code === 'NOT_FOUND' || err.code === 'SERVER') && path === '/') continue;
        throw err;
      }
      const href = found.responses.map((r) => childText(child(r.props, NS.DAV, 'current-user-principal'), NS.DAV, 'href')).find((h) => h);
      if (href) {
        principal = new URL(href, found.url);
        break;
      }
    }
    if (!principal) throw new MailError('SERVER', 'The calendar server did not say which account the login belongs to (no current-user-principal). Check that Calendars is turned on for iCloud in your Apple Account.');
    const p = await this.propfind(principal, '0', '<C:calendar-home-set/>', 'the calendar home lookup');
    const homeHref = p.responses.map((r) => childText(child(r.props, NS.CALDAV, 'calendar-home-set'), NS.DAV, 'href')).find((h) => h);
    if (!homeHref) throw new MailError('SERVER', 'The calendar server did not report a calendar home for this account. Check that Calendars is turned on for iCloud in your Apple Account.');
    const home = new URL(homeHref, p.url);
    if (!home.pathname.endsWith('/')) home.pathname += '/';
    if (!this.hostAllowed(home)) throw new MailError('SERVER', `The calendar home is on an unexpected host (${home.host}).`);
    return home;
  }

  /** Every calendar collection in the home that can hold events. */
  async listCalendars(): Promise<CalendarInfo[]> {
    const home = await this.discover();
    const props =
      '<D:resourcetype/><D:displayname/><A:calendar-color/><A:calendar-order/><C:calendar-description/><C:supported-calendar-component-set/><CS:getctag/><D:current-user-privilege-set/>';
    const { responses, url } = await this.propfind(home, '1', props, 'the calendar list request');
    const calendars: CalendarInfo[] = [];
    for (const r of responses) {
      const resourcetype = child(r.props, NS.DAV, 'resourcetype');
      if (!child(resourcetype, NS.CALDAV, 'calendar')) continue;
      const target = new URL(r.href, url);
      if (target.host !== home.host && !this.hostAllowed(target)) continue;
      const components = childrenNamed(child(r.props, NS.CALDAV, 'supported-calendar-component-set'), NS.CALDAV, 'comp')
        .map((c) => (c.attrs['name'] ?? '').toUpperCase())
        .filter((c) => c);
      if (components.length && !components.includes('VEVENT')) continue;
      let path = canonicalPath(target.pathname);
      if (!path.endsWith('/')) path += '/';
      const segments = path.split('/').filter((s) => s);
      const id = safeDecode(segments[segments.length - 1] ?? path);
      const privileges = child(r.props, NS.DAV, 'current-user-privilege-set');
      let readOnly: boolean | null = null;
      if (privileges) {
        const names = new Set(childrenNamed(privileges, NS.DAV, 'privilege').flatMap((p) => p.children.map((c) => (c.ns === NS.DAV ? c.name : ''))));
        readOnly = !(names.has('all') || names.has('write') || names.has('write-content') || names.has('bind'));
      }
      const color = childText(r.props, NS.APPLE, 'calendar-color');
      const orderText = childText(r.props, NS.APPLE, 'calendar-order');
      calendars.push({
        href: path,
        id,
        name: childText(r.props, NS.DAV, 'displayname') || id,
        color: color ? normalizeColor(color) : null,
        description: childText(r.props, NS.CALDAV, 'calendar-description') || null,
        components,
        readOnly,
        ctag: childText(r.props, NS.CS, 'getctag') || null,
        order: orderText && /^-?\d+$/.test(orderText) ? Number(orderText) : null,
      });
    }
    calendars.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    return calendars;
  }

  private async report(calendar: CalendarInfo, filter: string, what: string): Promise<CalendarObject[]> {
    const home = await this.discover();
    const url = new URL(calendar.href, home);
    const body =
      '<?xml version="1.0" encoding="utf-8"?>\n<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop>' +
      `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">${filter}</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
    const res = await this.request('REPORT', url, { depth: '1', body });
    if (res.status !== 207) this.fail(res.status, what, res.url.host, res.body);
    const objects: CalendarObject[] = [];
    for (const r of parseMultistatus(res.body, what)) {
      const data = child(r.props, NS.CALDAV, 'calendar-data')?.text ?? '';
      if (!data.trim()) continue;
      objects.push({ href: canonicalPath(new URL(r.href, res.url).pathname), etag: childText(r.props, NS.DAV, 'getetag') || null, data });
    }
    return objects;
  }

  /** Events with any instance in [startMs, endMs) as the server sees it (callers filter exactly). */
  queryRange(calendar: CalendarInfo, startMs: number, endMs: number): Promise<CalendarObject[]> {
    return this.report(calendar, `<C:time-range start="${caldavUtc(startMs)}" end="${caldavUtc(endMs)}"/>`, `the event search in "${calendar.name}"`);
  }

  /** Every recurring event (with an RRULE) in the calendar, whatever its dates. */
  queryRecurring(calendar: CalendarInfo): Promise<CalendarObject[]> {
    return this.report(calendar, '<C:prop-filter name="RRULE"/>', `the recurring-event search in "${calendar.name}"`);
  }

  /**
   * Resolve an event href given by the caller: it must be a path inside the calendar home (no
   * other host, no "..", no query), so a tool argument can never make the server fetch anything else.
   */
  async resolveEventHref(href: string): Promise<URL> {
    const home = await this.discover();
    const raw = href.trim();
    let url: URL;
    try {
      url = new URL(raw, home);
    } catch {
      throw new MailError('INVALID_INPUT', `"${raw}" is not a valid event href; use the href from search_events results.`);
    }
    // Dot segments in the raw text are refused before URL parsing would quietly resolve them.
    const rawSegments = safeDecode(raw.split(/[?#]/)[0] ?? '').split('/');
    const path = canonicalPath(url.pathname);
    if (url.host !== home.host || url.search || url.hash || rawSegments.includes('..') || rawSegments.includes('.') || !path.startsWith(canonicalPath(home.pathname)) || path.endsWith('/')) {
      throw new MailError('INVALID_INPUT', `"${raw}" is not an event in your calendars; use the href from search_events results.`);
    }
    url.pathname = path;
    return url;
  }

  /** GET one calendar object. */
  async getObject(href: string): Promise<CalendarObject> {
    const url = await this.resolveEventHref(href);
    const res = await this.request('GET', url, { accept: 'text/calendar' });
    if (res.status === 404) throw new MailError('NOT_FOUND', 'The event was not found (it may have been deleted or moved to another calendar); search again to get its current href.');
    if (res.status !== 200) this.fail(res.status, 'the event request', res.url.host, res.body);
    if (!/BEGIN:VCALENDAR/i.test(res.body)) throw new MailError('SERVER', 'The calendar server did not return calendar data for this event.');
    const etag = res.headers.etag;
    return { href: canonicalPath(url.pathname), etag: typeof etag === 'string' ? etag : null, data: res.body };
  }
}

export interface DavResponseEntry {
  href: string;
  /** Merged <prop> of every propstat with a 2xx status. */
  props: XmlElement;
}

/** Parse a 207 multistatus body into (href, successful props) entries. */
export function parseMultistatus(body: string, what = 'the request'): DavResponseEntry[] {
  let root: XmlElement;
  try {
    root = parseXml(body);
  } catch (err) {
    throw new MailError('SERVER', `The calendar server sent an unreadable answer to ${what}${err instanceof XmlError ? ` (${err.message})` : ''}.`);
  }
  if (root.ns !== NS.DAV || root.name !== 'multistatus') throw new MailError('SERVER', `The calendar server sent an unexpected answer to ${what}.`);
  const entries: DavResponseEntry[] = [];
  for (const r of childrenNamed(root, NS.DAV, 'response')) {
    const href = childText(r, NS.DAV, 'href');
    if (!href) continue;
    const props: XmlElement = { ns: NS.DAV, name: 'prop', attrs: {}, children: [], text: '' };
    for (const ps of childrenNamed(r, NS.DAV, 'propstat')) {
      const status = childText(ps, NS.DAV, 'status');
      if (status && !/\s2\d\d\b/.test(status)) continue;
      for (const p of childrenNamed(ps, NS.DAV, 'prop')) props.children.push(...p.children);
    }
    entries.push({ href, props });
  }
  return entries;
}

/**
 * One spelling per path: every segment decoded and re-encoded, so "/u@x/" and "/u%40x/" (Radicale
 * encodes "@", iCloud paths are plain) compare equal and an href round-trips through Claude.
 */
export function canonicalPath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(safeDecode(seg)))
    .join('/');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Apple colours come as #RRGGBBAA; show #RRGGBB. */
export function normalizeColor(color: string): string {
  const c = color.trim();
  return /^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7).toUpperCase() : /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : c.slice(0, 20);
}

