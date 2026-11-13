/**
 * Scripted CalDAV server for unit tests, as an injectable HttpFn (no sockets). It imitates iCloud's
 * layout and wire format: discovery on caldav.icloud.com, the calendar home on a partition host,
 * a default `xmlns="DAV:"` namespace, CR line ends sent as `&#13;`, a Reminders list (VTODO only)
 * and a scheduling inbox next to the calendars.
 *
 * By default its time-range REPORT behaves the way the client must not rely on: it never returns
 * recurring events (they only come back from the RRULE prop-filter query).
 */
import type { HttpFn, HttpRequest, HttpResponse } from '../../src/calendar/caldav.js';
import type { CalendarFixture } from './calendar-fixtures.js';

export const FAKE_BASE = 'https://caldav.icloud.com';
export const FAKE_HOME = 'https://p42-caldav.icloud.com:443/123456/calendars/';
const HOME_PATH = '/123456/calendars/';

export interface FakeCalDavOptions {
  user: string;
  password: string;
  objects: CalendarFixture[];
  /** Answer the RRULE prop-filter query with 400 (a server without prop-filter support). */
  rejectPropFilter?: boolean;
  /** Return recurring events from time-range queries too (a server that expands correctly). */
  timeRangeIncludesRecurring?: boolean;
  /** Status to answer every request with (e.g. 503). */
  forceStatus?: number;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

function multistatus(responses: string[]): HttpResponse {
  return {
    status: 207,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">${responses.join('')}</multistatus>`,
  };
}

function propstat(props: string, missing = ''): string {
  return `<propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat>${missing ? `<propstat><prop>${missing}</prop><status>HTTP/1.1 404 Not Found</status></propstat>` : ''}`;
}

const CALENDARS = [
  { id: 'home', name: 'Home', color: '#FF2968FF', comps: ['VEVENT'], order: 1 },
  { id: 'work', name: 'Work', color: '#1BADF8FF', comps: ['VEVENT'], order: 2 },
  { id: 'tasks', name: 'Reminders', color: '#CC73E1FF', comps: ['VTODO'], order: 3 },
];

export function fakeCalDav(opts: FakeCalDavOptions): { http: HttpFn; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const expectedAuth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
  const http: HttpFn = async (req) => {
    requests.push(req);
    if (opts.forceStatus) return { status: opts.forceStatus, headers: {}, body: '' };
    if (req.headers['Authorization'] !== expectedAuth) return { status: 401, headers: { 'www-authenticate': 'Basic realm="iCloud"' }, body: 'Unauthorized' };
    const url = req.url;
    const body = req.body ?? '';
    if (req.method === 'PROPFIND' && url.host === 'caldav.icloud.com' && url.pathname === '/') {
      return multistatus([`<response><href>/</href>${propstat('<current-user-principal><href>/123456/principal/</href></current-user-principal>')}</response>`]);
    }
    if (req.method === 'PROPFIND' && url.host === 'caldav.icloud.com' && url.pathname === '/123456/principal/') {
      return {
        ...multistatus([
          `<response><href>/123456/principal/</href>${propstat(`<calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">${FAKE_HOME}</href></calendar-home-set>`)}</response>`,
        ]),
      };
    }
    if (url.host !== 'p42-caldav.icloud.com') return { status: 404, headers: {}, body: '' };
    if (req.method === 'PROPFIND' && url.pathname === HOME_PATH) {
      if (req.headers['Depth'] !== '1') return { status: 400, headers: {}, body: 'Depth required' };
      const rows = [
        `<response><href>${HOME_PATH}</href>${propstat('<resourcetype><collection/></resourcetype>')}</response>`,
        `<response><href>${HOME_PATH}inbox/</href>${propstat('<resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>')}</response>`,
        ...CALENDARS.map(
          (c) =>
            `<response><href>${HOME_PATH}${c.id}/</href>${propstat(
              `<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>${c.name}</displayname>` +
                `<calendar-color xmlns="http://apple.com/ns/ical/" symbolic-color="custom">${c.color}</calendar-color><calendar-order xmlns="http://apple.com/ns/ical/">${c.order}</calendar-order>` +
                `<C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav">${c.comps.map((x) => `<C:comp name="${x}"/>`).join('')}</C:supported-calendar-component-set>` +
                `<getctag xmlns="http://calendarserver.org/ns/">ctag-${c.id}-1</getctag>` +
                '<current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>',
              '<calendar-description xmlns="urn:ietf:params:xml:ns:caldav"/>',
            )}</response>`,
        ),
      ];
      return multistatus(rows);
    }
    const cal = CALENDARS.find((c) => url.pathname === `${HOME_PATH}${c.id}/`);
    if (req.method === 'REPORT' && cal) {
      if (req.headers['Depth'] !== '1') return { status: 400, headers: {}, body: 'Depth required' };
      const inCal = opts.objects.filter((o) => o.calendar === cal.id);
      let selected: CalendarFixture[];
      if (body.includes('prop-filter name="RRULE"')) {
        if (opts.rejectPropFilter) return { status: 400, headers: {}, body: '<error>unsupported filter</error>' };
        selected = inCal.filter((o) => o.data.includes('RRULE:'));
      } else {
        selected = opts.timeRangeIncludesRecurring ? inCal : inCal.filter((o) => !o.data.includes('RRULE:'));
      }
      return multistatus(
        selected.map(
          (o) =>
            `<response><href>${HOME_PATH}${cal.id}/${o.file}</href>${propstat(`<getetag>"${o.file}-1"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${xmlEscape(o.data)}</calendar-data>`)}</response>`,
        ),
      );
    }
    if (req.method === 'GET') {
      const o = opts.objects.find((x) => url.pathname === `${HOME_PATH}${x.calendar}/${x.file}`);
      if (!o) return { status: 404, headers: {}, body: 'Not Found' };
      return { status: 200, headers: { etag: `"${o.file}-1"`, 'content-type': 'text/calendar' }, body: o.data };
    }
    return { status: 405, headers: {}, body: '' };
  };
  return { http, requests };
}
