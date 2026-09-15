import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authBoard, handleBoardRequest, type BoardAuth } from '../telegram/boardApi.js';
import {
  InvalidRangeError,
  readBoardDays,
  readLooseBucket,
  readRosterForBoard,
} from '../schedule/boardRead.js';
import {
  bookVisit,
  cancelJob,
  previewBookVisit,
  previewCancelJob,
  previewUntimeVisit,
  untimeVisit,
} from '../schedule/booking.js';
import {
  createCustomer,
  getTenant,
  JOB_PRIORITIES,
  phoneKey,
  searchCustomers,
  type JobPriority,
} from '../db/index.js';
import { localDateISO } from '../schedule/availability.js';

// The DISPATCH CONSOLE — the wide, desktop-shaped schedule surface (day/week/
// month grid, technician columns, drag-and-drop, a new-job form). It is a
// SECOND UI over the SAME spine, standing beside the Telegram board rather
// than replacing it: /board and web/board/ are untouched by this file, so the
// live Mini App keeps working for the whole build and the swap at the end is
// one Telegram menu-button URL.
//
// THREE RULES HOLD THE TWO SURFACES TOGETHER:
//
//  1. AUTH IS THE SAME OBJECT. `authBoard` is imported, not reimplemented —
//     the console is also a Mini App (opened from the bot in Telegram
//     Desktop), so every request carries the same signed initData slip and
//     resolves to the same roster row. There is no second way in, which is
//     the point: a browser-session path would be a new pre-auth attack
//     surface on a publicly-reachable URL, and it can be added later behind
//     this same API without the client noticing.
//
//  2. WRITES ARE THE SAME CODE. The move/cancel/book/job verbs are DELEGATED
//     to handleBoardRequest with the pathname rewritten. Not copied — every
//     guard (manager tier, past-date floor, preview then confirm doctrine,
//     crew replacement, the UNSCHEDULED stranding message) fires identically
//     because it IS the same branch. The only writes implemented here are the
//     ones the board deliberately does not have (mint a job from the
//     calendar; create a customer).
//
//  3. THE KILL SWITCH IS DEFAULT-OFF. Without CONSOLE_ENABLED the whole path
//     404s, including the page shell. A half-finished console cannot be
//     reached in production by anyone who has not been given the flag, so
//     shipping this file is not shipping the UI.

const enabled = (): boolean => {
  const v = (process.env.CONSOLE_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

export function isConsolePath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split('?')[0]; // req.url carries the query string
  return pathname === '/console' || pathname === '/console/' || pathname.startsWith('/console/');
}

// Same containment posture as the board's static server: resolve the root so a
// relative or trailing-slash env value cannot fail the prefix check and 404 the
// whole app, and whitelist the exact asset types the console ships.
const staticDir = (): string =>
  path.resolve(process.env.CONSOLE_STATIC_DIR ?? path.join(process.cwd(), 'web/console'));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404);
  res.end();
}

function deny(res: http.ServerResponse, auth: { code: 401 | 409; error?: string }): void {
  if (auth.error) json(res, auth.code, { error: auth.error });
  else {
    res.writeHead(auth.code);
    res.end();
  }
}

async function serveStatic(res: http.ServerResponse, name: string): Promise<void> {
  const ext = path.extname(name);
  const type = CONTENT_TYPES[ext];
  if (!type || name.includes('..') || name.includes('/') || name.includes('\\')) {
    notFound(res);
    return;
  }
  const root = staticDir();
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) {
    notFound(res);
    return;
  }
  try {
    const body = await fs.readFile(resolved);
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    notFound(res);
  }
}

function parseBody(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = rawBody.length ? JSON.parse(rawBody) : {};
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const str = (body: Record<string, unknown>, key: string): string | undefined =>
  typeof body[key] === 'string' && (body[key] as string).trim() !== ''
    ? (body[key] as string)
    : undefined;

const strList = (body: Record<string, unknown>, key: string): string[] | undefined | 'bad' => {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0) return 'bad';
  if (v.some((x) => typeof x !== 'string' || (x as string).trim() === '')) return 'bad';
  return (v as string[]).map((x) => x.trim());
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The month grid is six Mon-Sun rows = 42 days, and the pager can land on a
// month whose grid starts in the previous one — 45 is that with slack. The
// board's own ceiling stays 14 (readBoardDays' default): this number widens
// THIS surface only, which is why it travels as an argument.
const CONSOLE_MAX_SPAN_DAYS = 45;

const PAST_DATE_ERROR = 'console writes never target the past — date must be today or later';

// The console's writes inherit the board's server-side past floor. Restated
// here (rather than exported from boardApi) because the two messages name
// different surfaces, and the check is two lines; the POLICY it enforces is
// single-sourced in the verbs themselves.
async function consoleDateAllowed(tenantId: string, date: string): Promise<boolean> {
  const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
  return date >= localDateISO(new Date().toISOString(), tz);
}

// ── The one read the console actually makes ──────────────────────────────────
// ONE round-trip for a whole page paint: the grid needs the days, the columns
// need the roster, the left rail needs the tray, and every one of them is
// re-fetched together after any write anyway. Three separate endpoints would
// paint the grid before it knows its own columns exist.
async function handleCalendar(
  res: http.ServerResponse,
  auth: Extract<BoardAuth, { ok: true }>,
  params: URLSearchParams,
): Promise<void> {
  const isManager = auth.technician.tier === 'manager';
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
    json(res, 400, { error: 'from/to must be YYYY-MM-DD' });
    return;
  }
  const tenant = await getTenant(auth.tenantId);
  const tz = tenant?.timezone ?? 'UTC';
  try {
    // A technician opening the console gets exactly what the board gives them:
    // their own stops, clamped at the visibility horizon, no roster, no tray.
    // The console is a MANAGER tool, but a wrong-tier visitor must see a
    // correct small thing rather than a broken big one.
    const days = await readBoardDays({
      tenantId: auth.tenantId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      maxSpanDays: CONSOLE_MAX_SPAN_DAYS,
      viewerTechnicianId: isManager ? null : auth.technician.id,
      clampToHorizon: !isManager,
      // History stays on the grid: a done trip is drawn (greyed, inert) so a
      // manager paging back a month sees what happened, not a blank week.
      statuses: ['confirmed', 'completed'],
    });
    json(res, 200, {
      ...days,
      today: localDateISO(new Date().toISOString(), tz),
      timezone: tz,
      tier: auth.technician.tier,
      self: auth.technician.ref,
      roster: isManager ? await readRosterForBoard(auth.tenantId) : [],
      bucket: isManager ? await readLooseBucket(auth.tenantId) : null,
    });
  } catch (err) {
    if (err instanceof InvalidRangeError) {
      json(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

// ── Customer lookup for the new-job form ─────────────────────────────────────
// Deliberately thin: id plus the few fields the picker shows. The console is
// not a customer browser, and a fat payload here would be a standing invitation
// to render L3 facts on a surface with no capture provenance to show alongside
// them.
async function handleCustomerSearch(
  res: http.ServerResponse,
  auth: Extract<BoardAuth, { ok: true }>,
  params: URLSearchParams,
): Promise<void> {
  const q = (params.get('q') ?? '').trim();
  if (q.length < 2) {
    json(res, 200, { customers: [] });
    return;
  }
  const rows = await searchCustomers(auth.tenantId, q);
  json(res, 200, {
    customers: rows.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      address: c.address_line1,
      city: c.city,
    })),
  });
}

// ── The one write the board does not have: mint a job from the calendar ──────
// The board refuses `customerId` outright ("the board books existing jobs only")
// because a phone-sized surface is the wrong place to mint work. A right-click
// on a time slot IS the manager saying "new job, here, now", so the console
// opens that path — through the SAME bookVisit verb the chat agent drives, so
// the duplicate-job mint guard, the overlap guard and the crew rules all hold.
//
// forceNewJob is that guard's escape hatch and is NEVER set by this handler on
// its own: the refusal travels to the UI with its list of the customer's open
// work, the manager decides, and a second call carries the flag. Auto-forcing
// would delete the guard for the one surface most likely to trip it.
async function handleNewJob(
  res: http.ServerResponse,
  auth: Extract<BoardAuth, { ok: true }>,
  body: Record<string, unknown>,
  preview: boolean,
): Promise<void> {
  const date = str(body, 'date');
  const startTime = str(body, 'startTime');
  const endTime = str(body, 'endTime');
  // Same all-three-or-none shape the board's book verb enforces: the untimed
  // arm is a real choice ("on the books, no time yet"), a partial one is an
  // accident.
  const untimed = !date && !startTime && !endTime;
  if (!untimed && (!date || !startTime || !endTime)) {
    json(res, 400, { error: 'date, startTime and endTime are required together' });
    return;
  }
  if (!untimed && !(await consoleDateAllowed(auth.tenantId, date as string))) {
    json(res, 400, { error: PAST_DATE_ERROR });
    return;
  }

  let priority: JobPriority | undefined;
  if ('priority' in body) {
    if (
      typeof body.priority !== 'string' ||
      !JOB_PRIORITIES.includes(body.priority as JobPriority)
    ) {
      json(res, 400, { error: `invalid priority (use ${JOB_PRIORITIES.join(', ')})` });
      return;
    }
    priority = body.priority as JobPriority;
  }
  const crew = strList(body, 'technicianRefs');
  if (crew === 'bad') {
    json(res, 400, {
      error: 'technicianRefs must be a non-empty array of roster refs — omit it to book unassigned',
    });
    return;
  }

  let customerId = str(body, 'customerId');
  const fresh = body.newCustomer;
  if (customerId && fresh) {
    json(res, 400, { error: 'pass customerId OR newCustomer, not both' });
    return;
  }
  if (!customerId && !fresh) {
    json(res, 400, { error: 'customerId or newCustomer is required' });
    return;
  }

  // A preview on the NEW-customer path cannot run the mint guard (there is no
  // customer yet to have open work on file), and creating one just to preview
  // would leave a record behind on a call the manager may abandon. Say so
  // instead of guessing: a brand-new customer has no duplicate work by
  // definition, so the client goes straight to commit.
  if (preview && fresh) {
    json(res, 200, { requiresConfirmation: false, newCustomer: true });
    return;
  }

  if (fresh) {
    if (typeof fresh !== 'object' || fresh === null || Array.isArray(fresh)) {
      json(res, 400, { error: 'newCustomer must be an object' });
      return;
    }
    const c = fresh as Record<string, unknown>;
    const name = str(c, 'name');
    if (!name) {
      json(res, 400, { error: 'newCustomer.name is required' });
      return;
    }
    // Created BEFORE the booking, and deliberately not rolled back if the
    // booking then fails. A customer with no work on file is an ordinary,
    // useful record — unlike the orphaned JOB shell bookVisit takes care to
    // avoid, which would sit in the scheduler queue pretending to be work.
    //
    // But a REFUSED booking is normally retried with a different time, and
    // each retry would mint another identical customer (review finding
    // 2026-09-09) — the picker fills with duplicates of one person and
    // nothing ever cleans them up. So reuse an EXACT match: same tenant, same
    // name, same phone. Anything less exact stays a new record, because two
    // households really can share a name.
    const phone = str(c, 'phone') ?? null;
    // Same NUMBER, not the same spelling of it (phone_key); a value with no
    // number in it still has to match exactly, so no phone ≠ some phone.
    const twin = (await searchCustomers(auth.tenantId, name)).find(
      (existing) =>
        existing.name.trim().toLowerCase() === name.trim().toLowerCase() &&
        (phoneKey(existing.phone) ?? existing.phone ?? null) === (phoneKey(phone) ?? phone),
    );
    if (twin) {
      customerId = twin.id;
    } else {
      const created = await createCustomer({
        tenantId: auth.tenantId,
        name,
        phone,
        email: str(c, 'email') ?? null,
        addressLine1: str(c, 'addressLine1') ?? null,
        city: str(c, 'city') ?? null,
        state: str(c, 'state') ?? null,
        postalCode: str(c, 'postalCode') ?? null,
      });
      customerId = created.id;
    }
  }

  const input = {
    tenantId: auth.tenantId,
    customerId: customerId as string,
    title: str(body, 'title') ?? null,
    ...(priority ? { priority } : {}),
    ...(date ? { date } : {}),
    ...(startTime ? { startTime } : {}),
    ...(endTime ? { endTime } : {}),
    ...(crew ? { technicianRefs: crew } : {}),
    ...(body.forceNewJob === true ? { forceNewJob: true } : {}),
    ...(str(body, 'reason') ? { reason: str(body, 'reason') as string } : {}),
    actorRef: auth.technician.ref,
  };

  if (preview) {
    json(res, 200, await previewBookVisit(input));
    return;
  }
  const booked = await bookVisit(input);
  json(res, 200, {
    status: 'booked',
    visitId: booked.assignment.id,
    jobId: booked.job.id,
    customerId,
    date: date ?? null,
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    ...(booked.warning ? { warning: booked.warning } : {}),
  });
}

// The console's one write verb of its own: a placed visit back to "no time
// set", crew kept. It exists for undo — placing a parked visit by drag had no
// inverse on the board API — and the board does not get it, because the phone
// surface has no gesture that needs it. Same tier gate, same preview/confirm
// doctrine (the preview's verdict is the cancel rule: placed → confirm), same
// error triage as the new-job path.
// The shape PostgREST will accept as a uuid. Not a strict RFC check — the DB
// does that — only enough that garbage becomes a 404 instead of a 500.
const UUID_SHAPE = /^[0-9a-fA-F-]{36}$/;

async function handleUntime(
  res: http.ServerResponse,
  auth: BoardAuth & { ok: true },
  body: Record<string, unknown>,
  preview: boolean,
): Promise<void> {
  const visitId = str(body, 'visitId');
  if (!visitId) {
    json(res, 400, { error: 'visitId is required' });
    return;
  }
  // Non-UUID garbage must not reach PostgREST: its 22P02 throws through as a
  // logged 500, which any authenticated caller could then spam on demand — the
  // guard /board/api/visit already carries (review finding 2026-09-09).
  if (!UUID_SHAPE.test(visitId)) {
    json(res, 404, { error: 'visit not found' });
    return;
  }
  if (preview) {
    json(res, 200, { status: 'preview', ...(await previewUntimeVisit(auth.tenantId, visitId)) });
    return;
  }
  const reason = str(body, 'reason');
  if (!reason) {
    json(res, 400, { error: 'reason is required' });
    return;
  }
  const done = await untimeVisit({
    tenantId: auth.tenantId,
    visitId,
    reason,
    actorRef: auth.technician.ref,
  });
  json(res, 200, { status: 'untimed', visitId: done.visit.id, technicianRefs: done.technicianRefs });
}

// Cancel a JOB — the tray's "Delete this job" (user ask 2026-09-08: an open
// job with no visit had no way off the list but chat). The board has no
// job-cancel verb; the chat tool's core (`cancelJob`, visits first then the
// job, one ledger event each) is called directly. Always confirms — the
// preview's verdict is a literal `true` — and there is NO undo: a cancelled
// job is terminal in jobs.ts's state machine, and re-minting one is a
// different job.
async function handleCancelJob(
  res: http.ServerResponse,
  auth: BoardAuth & { ok: true },
  body: Record<string, unknown>,
  preview: boolean,
): Promise<void> {
  const jobId = str(body, 'jobId');
  if (!jobId) {
    json(res, 400, { error: 'jobId is required' });
    return;
  }
  if (!UUID_SHAPE.test(jobId)) {
    json(res, 404, { error: 'job not found' });
    return;
  }
  if (preview) {
    json(res, 200, { status: 'preview', ...(await previewCancelJob(auth.tenantId, jobId)) });
    return;
  }
  const reason = str(body, 'reason');
  if (!reason) {
    json(res, 400, { error: 'reason is required' });
    return;
  }
  const done = await cancelJob({
    tenantId: auth.tenantId,
    jobId,
    reason,
    actorRef: auth.technician.ref,
  });
  json(res, 200, {
    status: 'cancelled',
    jobId: done.job.id,
    cancelledVisits: done.cancelledVisits.length,
  });
}

// The write verbs that already exist on the board, addressed under the
// console's own URL space. The mapping is a literal table on purpose: an
// unlisted path is a 404, so a typo in the client cannot fall through to some
// other board route.
const DELEGATED: Record<string, string> = {
  '/console/api/move': '/board/api/move',
  '/console/api/cancel': '/board/api/cancel',
  '/console/api/book': '/board/api/book',
  '/console/api/job': '/board/api/job',
};

export async function handleConsoleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
): Promise<void> {
  // Default-off, checked before ANY work: with the flag unset the console does
  // not exist, not even as a 401 an attacker could use to learn the route is
  // real behind auth.
  if (!enabled()) {
    notFound(res);
    return;
  }
  try {
    const url = new URL(req.url ?? '/console', 'http://console.local');
    const pathname = url.pathname;

    // Page shell + assets — unauthenticated, exactly like the board's: they
    // carry no secrets, and the page acquires its initData from the webview.
    if ((pathname === '/console' || pathname === '/console/') && req.method === 'GET') {
      await serveStatic(res, 'index.html');
      return;
    }
    if (pathname.startsWith('/console/static/') && req.method === 'GET') {
      await serveStatic(res, pathname.slice('/console/static/'.length));
      return;
    }

    // The visit detail sheet is the board's, unchanged — a tap on a card wants
    // the same contact + logistics payload on either surface.
    if (pathname === '/console/api/visit' && req.method === 'GET') {
      await handleBoardRequest(req, res, rawBody, { pathname: '/board/api/visit' });
      return;
    }
    const delegated = req.method === 'POST' ? DELEGATED[pathname] : undefined;
    if (delegated) {
      await handleBoardRequest(req, res, rawBody, { pathname: delegated });
      return;
    }

    if (pathname === '/console/api/calendar' && req.method === 'GET') {
      const auth = await authBoard(req);
      if (!auth.ok) {
        deny(res, auth);
        return;
      }
      await handleCalendar(res, auth, url.searchParams);
      return;
    }

    if (pathname === '/console/api/customers' && req.method === 'GET') {
      const auth = await authBoard(req);
      if (!auth.ok) {
        deny(res, auth);
        return;
      }
      if (auth.technician.tier !== 'manager') {
        json(res, 403, { error: 'managers only' });
        return;
      }
      await handleCustomerSearch(res, auth, url.searchParams);
      return;
    }

    if (
      (pathname === '/console/api/newjob' ||
        pathname === '/console/api/untime' ||
        pathname === '/console/api/canceljob') &&
      req.method === 'POST'
    ) {
      const auth = await authBoard(req);
      if (!auth.ok) {
        deny(res, auth);
        return;
      }
      if (auth.technician.tier !== 'manager') {
        json(res, 403, { error: 'managers only' });
        return;
      }
      const body = parseBody(rawBody);
      if (!body) {
        json(res, 400, { error: 'malformed JSON body' });
        return;
      }
      const preview = url.searchParams.get('preview') === '1' || body.preview === true;
      try {
        if (pathname === '/console/api/untime') await handleUntime(res, auth, body, preview);
        else if (pathname === '/console/api/canceljob') await handleCancelJob(res, auth, body, preview);
        else await handleNewJob(res, auth, body, preview);
      } catch (err) {
        // The board's triage order, verbatim: the UNSCHEDULED stranding travels
        // as-is FIRST (it reports a real state change and can embed a db
        // "failed:" fragment), then the db layer's uniform "<fn> failed:" marks
        // a server fault worth logging and hiding; everything else is a verb
        // refusal the manager must read — the mint guard's list of the
        // customer's open work arrives through here.
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('UNSCHEDULED') && / failed: /.test(message)) {
          console.error('console write failed:', err);
          json(res, 500, { error: 'server error — try again shortly' });
          return;
        }
        // A verb refusal is written by us and is an Error named 'Error'. A
        // TypeError, or a non-Error throw, is a BUG wearing a conflict's
        // clothes: it would reach the manager as an internal JS string and
        // leave nothing in the logs (review finding 2026-09-09).
        if (!(err instanceof Error) || err.name !== 'Error') {
          console.error('console write threw an unexpected error type:', err);
        }
        json(res, 409, { error: message });
      }
      return;
    }

    notFound(res);
  } catch (err) {
    console.error('console request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}
