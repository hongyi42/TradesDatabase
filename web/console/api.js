// The console's only door to the server. Holds NO auth logic — it forwards the
// Telegram slip exactly as board.js does, and every decision about who may do
// what is made server-side (consoleApi.ts, and the board verbs it delegates to).

const tg = window.Telegram && window.Telegram.WebApp;

function authHeader() {
  // initData is the raw signed slip. Absent outside a real webview, in which
  // case every call 401s — which is the correct, loud failure.
  return 'tma ' + ((tg && tg.initData) || '');
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: method,
      headers: Object.assign(
        { authorization: authHeader() },
        body ? { 'content-type': 'application/json' } : {},
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // A dropped connection is not a refusal — say so, or the manager reads a
    // network blip as the server rejecting the move they just made.
    throw new ApiError(0, 'no connection — check the network and try again');
  }
  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body from a proxy or a 502 page: the status still decides.
      payload = null;
    }
  }
  if (!res.ok) {
    // 401/409-with-no-body are the board's deliberate bare denials; give them
    // words here rather than showing an empty toast.
    const fallback =
      res.status === 401
        ? 'not signed in — reopen the console from the Telegram menu'
        : res.status === 403
          ? 'managers only'
          : 'request failed (' + res.status + ')';
    throw new ApiError(res.status, (payload && payload.error) || fallback);
  }
  return payload;
}

export const api = {
  calendar: (from, to) =>
    request('GET', '/console/api/calendar?from=' + from + '&to=' + to),
  visit: (visitId) => request('GET', '/console/api/visit?visitId=' + encodeURIComponent(visitId)),
  customers: (q) => request('GET', '/console/api/customers?q=' + encodeURIComponent(q)),

  // Every write comes in a preview/commit pair. The preview is not a formality:
  // it runs the SAME guards the commit will, so a stale tab is refused before
  // the manager is walked through a confirm into a guaranteed 409.
  previewMove: (body) => request('POST', '/console/api/move?preview=1', body),
  move: (body) => request('POST', '/console/api/move', body),
  previewBook: (body) => request('POST', '/console/api/book?preview=1', body),
  book: (body) => request('POST', '/console/api/book', body),
  previewCancel: (body) => request('POST', '/console/api/cancel?preview=1', body),
  cancel: (body) => request('POST', '/console/api/cancel', body),
  editJob: (body) => request('POST', '/console/api/job', body),
  // Console-only: a placed visit back to "no time set" (the undo of placing a
  // parked visit). Crew is kept; the caller re-attaches the old crew if the
  // placing changed it.
  previewUntime: (body) => request('POST', '/console/api/untime?preview=1', body),
  untime: (body) => request('POST', '/console/api/untime', body),
  // Console-only: cancel a whole job (its visits go with it). No undo.
  previewCancelJob: (body) => request('POST', '/console/api/canceljob?preview=1', body),
  cancelJob: (body) => request('POST', '/console/api/canceljob', body),
  newJob: (body) => request('POST', '/console/api/newjob', body),
};

// ── Dates ────────────────────────────────────────────────────────────────────
// EVERY function here is UTC-only string arithmetic on YYYY-MM-DD. The naive-
// local rule (board.js' opening comment) is that stored days and times print
// verbatim and the browser never applies a timezone; Date is used ONLY as a
// calendar calculator through Date.UTC/getUTC*, which cannot shift which
// weekday a stored day claims to be.

export function ymdToUTC(ymd) {
  return Date.parse(ymd + 'T00:00:00Z');
}

export function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(ymd, n) {
  return fromUTC(ymdToUTC(ymd) + n * 86400000);
}

export function weekdayIndex(ymd) {
  // 0 = Monday … 6 = Sunday, matching the board's Mon-Sun weeks.
  return (new Date(ymdToUTC(ymd)).getUTCDay() + 6) % 7;
}

export function mondayOf(ymd) {
  return addDays(ymd, -weekdayIndex(ymd));
}

export function firstOfMonth(ymd) {
  return ymd.slice(0, 8) + '01';
}

export function addMonths(ymd, n) {
  const d = new Date(ymdToUTC(firstOfMonth(ymd)));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// The six-row month grid: the Monday on or before the 1st, then 42 days. Fixed
// at six rows so the grid never changes height as the manager pages through
// months — a jumping layout loses the drop target under the cursor.
export function monthGrid(ymd) {
  const start = mondayOf(firstOfMonth(ymd));
  return { from: start, to: addDays(start, 41) };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function monthName(ymd) {
  return MONTHS[Number(ymd.slice(5, 7)) - 1];
}

export function dayLabel(ymd, style) {
  const dow = DAYS[weekdayIndex(ymd)];
  const dom = Number(ymd.slice(8, 10));
  if (style === 'short') return dow.slice(0, 3) + ' ' + dom;
  return dow + ', ' + monthName(ymd) + ' ' + dom + ', ' + ymd.slice(0, 4);
}

// ── Times ────────────────────────────────────────────────────────────────────
// Minutes since midnight from a stored ISO instant, read by SLICING — never by
// parsing it into a Date, which would apply the viewer's timezone to a value
// the firm stated in its own.

export function minutesOf(iso) {
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
}

export function hhmm(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

export function clockLabel(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m % 60 === 0 ? h12 + suffix : h12 + ':' + String(m % 60).padStart(2, '0') + suffix;
}
