import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyInitData } from './initData.js';
import * as rosterCache from './rosterCache.js';
import { findRosterByTelegramUserIdGlobal, type Technician } from '../db/index.js';
import {
  InvalidRangeError,
  readBoardDays,
  readLooseBucket,
  readRosterForBoard,
  readVisitDetail,
} from '../schedule/boardRead.js';
import {
  attachUnplacedVisit,
  previewAttachUnplacedVisit,
  bookVisit,
  unscheduleVisit,
  isPromiseLevel,
  moveVisit,
  previewBookVisit,
  previewUnscheduleVisit,
  previewMoveVisit,
  setVisitLocks,
  setVisitPromise,
  updateJobIdentity,
} from '../schedule/booking.js';
import {
  durationError,
  getTenant,
  isValidDuration,
  JOB_PRIORITIES,
  type JobPriority,
} from '../db/index.js';
import { localDateISO } from '../schedule/availability.js';

// The dispatch board's HTTP surface, mounted by httpServer.ts BEFORE the IP
// allowlist: board traffic comes from users' public browsers (the Telegram
// webview), not the gateway, so the allowlist must not gate it. It is
// self-authenticated instead — every /board/api/* request carries the Mini
// App's signed initData in `Authorization: tma <raw>`, verified against
// BOARD_BOT_TOKEN and resolved to a roster row (which supplies the tenant).
// The page shell + assets are served unauthenticated (no secrets in them).

export function isBoardPath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split('?')[0]; // req.url carries the query string
  return pathname === '/board' || pathname === '/board/' || pathname.startsWith('/board/');
}

// Always path.resolve the root: a trailing-slash or relative BOARD_STATIC_DIR
// would otherwise fail the containment prefix-check and 404 the whole board.
const staticDir = (): string =>
  path.resolve(process.env.BOARD_STATIC_DIR ?? path.join(process.cwd(), 'web/board'));

// Whitelisted asset types only — the board ships exactly html/js/css.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

type BoardAuth =
  | { ok: true; tenantId: string; technician: Technician }
  | { ok: false; code: 401 | 409; error?: string };

// Auth posture per the plan: AUTH-shaped failures (missing/garbled header,
// bad signature, stale slip, unknown id, unconfigured token) → bare 401, no
// detail. The ONE distinguished auth failure is an ambiguous account — 409,
// so the UI can say why instead of looking broken. A DB fault is NOT an auth
// failure: the roster lookup sits OUTSIDE the catch so an outage propagates
// to the outer handler's logged 500 instead of masquerading as "bad slip"
// (telling a manager to "reopen the board" during a DB outage helps nobody).
async function authBoard(req: http.IncomingMessage): Promise<BoardAuth> {
  let userId: string;
  try {
    const m = /^tma\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return { ok: false, code: 401 };
    userId = verifyInitData(m[1], process.env.BOARD_BOT_TOKEN ?? '').userId;
  } catch {
    return { ok: false, code: 401 };
  }
  // The signature was verified above, on THIS request. Only the roster lookup —
  // the one DB round-trip in this function — is memoized, and only on success;
  // see rosterCache for the reasoning and the 60s staleness window.
  const cached = rosterCache.get(userId, Date.now());
  if (cached) return { ok: true, tenantId: cached.tenantId, technician: cached.technician };
  const match = await findRosterByTelegramUserIdGlobal(userId);
  if (!match) return { ok: false, code: 401 };
  if ('ambiguous' in match) {
    return {
      ok: false,
      code: 409,
      // Multi-firm vs a same-tenant duplicate binding — both refuse, each
      // with copy the operator can act on. NOT cached: an ambiguity is resolved
      // by an operator edit, and that fix must take effect immediately.
      error:
        match.tenantIds.length > 1
          ? 'account on multiple firms'
          : 'account matches multiple roster entries',
    };
  }
  const resolved = { tenantId: match.technician.tenant_id, technician: match.technician };
  rosterCache.set(userId, resolved, Date.now());
  return { ok: true, ...resolved };
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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
  // Reject traversal and anything outside the whitelist BEFORE touching the
  // filesystem; resolve + prefix-check as the backstop.
  if (!type || name.includes('..') || name.includes('/') || name.includes('\\')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const root = staticDir();
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = await fs.readFile(resolved);
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

// A malformed JSON body is the CALLER's fault → 400; verb-level refusals
// (unknown assignment, overlap clash, the UNSCHEDULED stranding) → 409 with
// the verb's message VERBATIM — the UI must show the stranding, never mask it.
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

// Board writes never target the past — the SERVER floor under the client
// gates (final review: stale-tab midnight crossings and hand-crafted calls
// bypass client checks; the chat surface deliberately keeps its
// history-correction ability, so this floor is board-only).
const PAST_DATE_ERROR = 'board writes never target the past — date must be today or later';
async function boardDateAllowed(tenantId: string, date: string): Promise<boolean> {
  const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
  return date >= localDateISO(new Date().toISOString(), tz);
}

export async function handleBoardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawBody: string,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/board', 'http://board.local');
    const pathname = url.pathname;

    // Page shell + assets — unauthenticated (the page itself acquires initData
    // from the Telegram webview and presents it to the API).
    if ((pathname === '/board' || pathname === '/board/') && req.method === 'GET') {
      await serveStatic(res, 'index.html');
      return;
    }
    if (pathname.startsWith('/board/static/') && req.method === 'GET') {
      await serveStatic(res, pathname.slice('/board/static/'.length));
      return;
    }

    if (pathname === '/board/api/day' && req.method === 'GET') {
      const auth = await authBoard(req);
      if (!auth.ok) {
        deny(res, auth);
        return;
      }
      const isManager = auth.technician.tier === 'manager';
      // The manager's "My schedule" tab: view=mine narrows a manager to their
      // own stops by reusing the technician self-filter. For a technician the
      // param is a no-op (they are always self-filtered); any other value =
      // the tier default. The response echoes the resolved view so the page
      // renders what the server actually filtered, not what it asked for.
      const mine = url.searchParams.get('view') === 'mine';
      try {
        const days = await readBoardDays({
          tenantId: auth.tenantId,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          viewerTechnicianId: isManager && !mine ? null : auth.technician.id,
          // TIER, never the self-filter: the manager's Mine tab must keep far
          // weeks; only technician-tier reads clamp at the horizon (Plan 4a).
          clampToHorizon: !isManager,
        });
        json(res, 200, {
          tier: auth.technician.tier,
          self: auth.technician.ref,
          view: isManager && !mine ? 'team' : 'mine',
          ...days,
        });
      } catch (err) {
        if (err instanceof InvalidRangeError) {
          json(res, 400, { error: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    // Tap-into-a-visit detail (both tiers). Technicians resolve ONLY their own
    // visits — a crafted assignmentId for anyone else's (or an unassigned)
    // visit 404s exactly like a nonexistent id, so this endpoint reveals
    // nothing their self-filtered day view wouldn't.
    if (pathname === '/board/api/visit' && req.method === 'GET') {
      const auth = await authBoard(req);
      if (!auth.ok) {
        deny(res, auth);
        return;
      }
      const assignmentId = url.searchParams.get('assignmentId');
      if (!assignmentId) {
        json(res, 400, { error: 'assignmentId is required' });
        return;
      }
      // Non-UUID garbage must read exactly like an unknown id — without this,
      // PostgREST's 22P02 (invalid uuid syntax) throws through to a bare 500,
      // letting any authenticated caller spam the server-fault log on demand
      // and denting the 404 uniformity (review finding).
      if (!/^[0-9a-fA-F-]{36}$/.test(assignmentId)) {
        json(res, 404, { error: 'visit not found' });
        return;
      }
      const detail = await readVisitDetail(
        auth.tenantId,
        assignmentId,
        auth.technician.tier === 'manager' ? null : auth.technician.id,
      );
      if (!detail) {
        json(res, 404, { error: 'visit not found' });
        return;
      }
      json(res, 200, detail);
      return;
    }

    // The loose bucket (Plan 4a): parked visits + unscheduled jobs — the
    // tray's data. Manager-only: the bucket is dispatch work, and the pill
    // never renders for technicians (their fetch would be a wasted 403).
    if (pathname === '/board/api/bucket' && req.method === 'GET') {
      const auth = await authBoard(req);
      if (!auth.ok) {
        deny(res, auth);
        return;
      }
      if (auth.technician.tier !== 'manager') {
        json(res, 403, { error: 'managers only' });
        return;
      }
      json(res, 200, await readLooseBucket(auth.tenantId));
      return;
    }

    // The assign-picker's roster (plan 4a.5). Manager-only like every write
    // surface; fetched on picker open — never on the board-load path.
    if (pathname === '/board/api/roster' && req.method === 'GET') {
      const auth = await authBoard(req);
      if (!auth.ok) {
        deny(res, auth);
        return;
      }
      if (auth.technician.tier !== 'manager') {
        json(res, 403, { error: 'managers only' });
        return;
      }
      json(res, 200, { technicians: await readRosterForBoard(auth.tenantId) });
      return;
    }

    // Manager-only write path (Phase 3). Both verbs are the SAME shared
    // booking.ts verbs the chat agent drives — every guard (tenant, overlap,
    // promise ladder) fires identically. The confirm model is Feature A's
    // doctrine, inherited via the previews' requiresConfirmation: the page
    // previews first, one-shots when false, confirms in-UI when true.
    if (
      (pathname === '/board/api/move' ||
        pathname === '/board/api/cancel' ||
        pathname === '/board/api/book' ||
        pathname === '/board/api/promise' ||
        pathname === '/board/api/lock' ||
        pathname === '/board/api/job') &&
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
      const reason = str(body, 'reason');
      try {
        // Book an EXISTING job from the tray (plan 4a.5) — the customerId
        // mint-a-job path stays chat-only; preview→confirm-in-UI→commit like
        // move (bookingRequiresConfirmation rides on the preview).
        if (pathname === '/board/api/book') {
          if ('customerId' in body) {
            json(res, 400, { error: 'the board books existing jobs only — pass jobId' });
            return;
          }
          // MCP-layer parity (final-review finding): priority only applies to
          // the mint-a-job path the board blocks — silently ignoring it would
          // report an unstored urgency as stored.
          if ('priority' in body) {
            json(res, 400, {
              error: 'priority is not set at booking — edit it on the job (the /job verb)',
            });
            return;
          }
          const jobId = str(body, 'jobId');
          if (!jobId) {
            json(res, 400, { error: 'jobId is required' });
            return;
          }
          const timeTbd = body.timeTbd === true;
          const date = str(body, 'date');
          const startTime = str(body, 'startTime');
          const endTime = str(body, 'endTime');
          const earliestDate = str(body, 'earliestDate');
          const latestDate = str(body, 'latestDate');
          // The unplaced arm (plan 4b-2): the form's "time not settled" toggle
          // posts timeTbd + the day (range optional) and NO times — the shape
          // rules live in resolveBooking; here only the required fields gate.
          if (timeTbd) {
            if (startTime || endTime) {
              json(res, 400, { error: 'timeTbd bookings carry no times — clear them' });
              return;
            }
            if (!earliestDate && !date) {
              json(res, 400, { error: 'a timeTbd booking needs the day (earliestDate or date)' });
              return;
            }
          } else if (!date || !startTime || !endTime) {
            json(res, 400, { error: 'date, startTime and endTime are required' });
            return;
          }
          const gateDate = timeTbd ? (earliestDate ?? date) : date;
          if (!(await boardDateAllowed(auth.tenantId, gateDate as string))) {
            json(res, 400, { error: PAST_DATE_ERROR });
            return;
          }
          if ('technicianRef' in body && str(body, 'technicianRef') === undefined) {
            json(res, 400, {
              error: 'technicianRef was empty — pass a roster ref, or omit it to book unassigned',
            });
            return;
          }
          let promiseLevel;
          if ('promiseLevel' in body) {
            if (!isPromiseLevel(body.promiseLevel)) {
              json(res, 400, {
                error: 'invalid promiseLevel (use none, day, time, or time_only)',
              });
              return;
            }
            promiseLevel = body.promiseLevel;
          }
          const input = {
            tenantId: auth.tenantId,
            jobId,
            ...(date ? { date } : {}),
            ...(startTime ? { startTime } : {}),
            ...(endTime ? { endTime } : {}),
            ...(timeTbd
              ? {
                  timeTbd: true,
                  ...(earliestDate ? { earliestDate } : {}),
                  ...(latestDate ? { latestDate } : {}),
                }
              : {}),
            technicianRef: str(body, 'technicianRef'),
            ...(promiseLevel ? { promiseLevel } : {}),
            actorRef: auth.technician.ref,
          };
          if (preview) {
            json(res, 200, await previewBookVisit(input));
            return;
          }
          const booked = await bookVisit(input);
          json(res, 200, {
            status: 'booked',
            assignmentId: booked.assignment.id,
            jobId: booked.job.id,
            date,
            startTime,
            endTime,
            promiseLevel: booked.assignment.promise_level,
            ...(booked.warning ? { warning: booked.warning } : {}),
          });
          return;
        }
        // One-shot job identity edit (plan 4a.5): board scope is title +
        // priority — jobType is duration-vocabulary work and stays in chat.
        if (pathname === '/board/api/job') {
          if (preview) {
            json(res, 400, { error: 'job edits are one-shot — this verb has no preview' });
            return;
          }
          const jobId = str(body, 'jobId');
          if (!jobId) {
            json(res, 400, { error: 'jobId is required' });
            return;
          }
          if ('jobType' in body) {
            json(res, 400, {
              error: 'jobType is edited in chat — the board edits title, priority, and length',
            });
            return;
          }
          if ('title' in body && str(body, 'title') === undefined) {
            json(res, 400, { error: 'title must not be empty' });
            return;
          }
          const title = str(body, 'title');
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
          // Presence, not truthiness (plan 4b-1 review): null is the explicit
          // CLEAR arm, and a falsy test would misread a clear as absent.
          let durationMinutes: number | null | undefined;
          if ('durationMinutes' in body) {
            if (body.durationMinutes !== null && !isValidDuration(body.durationMinutes)) {
              json(res, 400, { error: durationError() });
              return;
            }
            durationMinutes = body.durationMinutes as number | null;
          }
          if (title === undefined && priority === undefined && durationMinutes === undefined) {
            json(res, 400, {
              error: 'nothing to update — pass title, priority, and/or durationMinutes',
            });
            return;
          }
          const { previous, updated } = await updateJobIdentity(
            auth.tenantId,
            jobId,
            {
              ...(title !== undefined ? { title } : {}),
              ...(priority !== undefined ? { priority } : {}),
              ...(durationMinutes !== undefined ? { durationMinutes } : {}),
            },
            auth.technician.ref,
          );
          json(res, 200, {
            status: 'ok',
            changes: {
              ...(title !== undefined
                ? { title: { from: previous.title, to: updated.title } }
                : {}),
              ...(priority !== undefined
                ? { priority: { from: previous.priority, to: updated.priority } }
                : {}),
              ...(durationMinutes !== undefined
                ? {
                    durationMinutes: {
                      from: previous.duration_minutes,
                      to: updated.duration_minutes,
                    },
                  }
                : {}),
            },
          });
          return;
        }
        // Every remaining verb (promise / cancel / move) keys on the visit —
        // the jobId-keyed verbs returned above, so the guard narrows cleanly
        // for the rest (final-review finding: the earlier negative-list guard
        // killed TS narrowing and needed four casts).
        const assignmentId = str(body, 'assignmentId');
        if (!assignmentId) {
          json(res, 400, { error: 'assignmentId is required' });
          return;
        }
        // One-shot promise correction (plan 4a.5): correcting the RECORD is
        // reversible + internal — the doctrine gates the moves/cancels the
        // record then arms, never the correction itself.
        if (pathname === '/board/api/promise') {
          // One-shot verbs REFUSE a preview request instead of silently
          // committing on it (final-review finding — every sibling verb on
          // this route honors ?preview=1, so ignoring it here was a trap).
          if (preview) {
            json(res, 400, { error: 'promise edits are one-shot — this verb has no preview' });
            return;
          }
          if (!isPromiseLevel(body.promiseLevel)) {
            json(res, 400, { error: 'invalid promiseLevel (use none, day, time, or time_only)' });
            return;
          }
          const { previous, updated } = await setVisitPromise(
            auth.tenantId,
            assignmentId,
            body.promiseLevel,
            auth.technician.ref,
          );
          json(res, 200, {
            status: 'ok',
            changes: {
              promiseLevel: { from: previous.promise_level, to: updated.promise_level },
              promisedDay: { from: previous.promised_day, to: updated.promised_day },
            },
          });
          return;
        }
        // One-shot pin toggle (plan 4b-3): pinning is reversible + internal —
        // the doctrine's one-shot arm; the sheet re-render is the disclosure.
        if (pathname === '/board/api/lock') {
          if (preview) {
            json(res, 400, { error: 'pin edits are one-shot — this verb has no preview' });
            return;
          }
          if (typeof body.locked !== 'boolean') {
            json(res, 400, { error: 'locked must be a boolean' });
            return;
          }
          const result = await setVisitLocks(
            auth.tenantId,
            { assignmentIds: [assignmentId] },
            body.locked,
            auth.technician.ref,
          );
          json(res, 200, { status: 'ok', locked: result.updated[0].locked });
          return;
        }
        if (pathname === '/board/api/cancel') {
          if (preview) {
            json(res, 200, await previewUnscheduleVisit(auth.tenantId, assignmentId));
            return;
          }
          if (!reason) {
            json(res, 400, { error: 'reason is required' });
            return;
          }
          const cancelled = await unscheduleVisit({
            tenantId: auth.tenantId,
            assignmentId,
            reason,
            actorRef: auth.technician.ref,
          });
          // promiseLevel rides along so the page can disclose a promise that
          // appeared between preview and commit (same race class as move's
          // promiseBroken — the cancel one-shots, so the toast must tell).
          json(res, 200, {
            status: 'cancelled',
            // Placed day, else the unplaced range's day (plan 4b-2).
            day: cancelled.starts_at?.slice(0, 10) ?? cancelled.earliest_date ?? null,
            promiseLevel: cancelled.promise_level,
          });
          return;
        }
        // Attach a person to an UNPLACED visit, keeping it unplaced (plan
        // 4b-2 Phase 3): the tray's Assign on a time-TBD row posts this
        // instead of inventing a time. Routed before the date/time gate —
        // an attach carries neither.
        if (body.attachUnplaced === true) {
          // Times alongside an attach are a caller bug — silently ignoring
          // them would let a buggy client believe it PLACED the visit (the
          // route's own priority/timeTbd refusal standard; review finding).
          if (str(body, 'date') || str(body, 'startTime') || str(body, 'endTime')) {
            json(res, 400, {
              error: 'attachUnplaced keeps the visit time-TBD — drop date/times, or place it with a normal move',
            });
            return;
          }
          const attachRef = str(body, 'technicianRef');
          const detach = body.unassign === true;
          const attachId = str(body, 'assignmentId');
          if (!attachId || !reason || (detach ? attachRef !== undefined : !attachRef)) {
            json(res, 400, {
              error: 'assignmentId, reason, and ONE of technicianRef (attach) or unassign:true (park back) are required',
            });
            return;
          }
          const tz = (await getTenant(auth.tenantId))?.timezone ?? 'UTC';
          // The board's past floor, on the RANGE END: a straddling range
          // stays actionable; a fully-past one is a chat job (review
          // finding — every other /move write already has this floor).
          const notBeforeDate = localDateISO(new Date().toISOString(), tz);
          // The client's move flow previews first — an attach is reversible
          // (unassign:true parks it back) and keeps the promise untouched, so
          // requiresConfirmation stays false, but the preview runs the SAME
          // guards the commit will (final-review finding: an unconditional
          // green light walked a stale tab through the picker + confirm into
          // a guaranteed 409; every sibling write validates at preview).
          if (preview) {
            const attachPreview = await previewAttachUnplacedVisit({
              tenantId: auth.tenantId,
              assignmentId: attachId,
              technicianRef: detach ? null : (attachRef as string),
              notBeforeDate,
            });
            json(res, 200, { status: 'preview', attach: true, ...attachPreview });
            return;
          }
          const attached = await attachUnplacedVisit({
            tenantId: auth.tenantId,
            assignmentId: attachId,
            technicianRef: detach ? null : (attachRef as string),
            reason,
            actorRef: auth.technician.ref,
            notBeforeDate,
          });
          json(res, 200, {
            status: 'moved',
            attach: !detach,
            unassigned: detach,
            timeTbd: true,
            assignmentId: attached.created.id,
            earliestDate: attached.created.earliest_date,
            latestDate: attached.created.latest_date,
            promiseLevel: attached.created.promise_level,
          });
          return;
        }
        const date = str(body, 'date');
        const startTime = str(body, 'startTime');
        if (!date || !startTime || !reason) {
          json(res, 400, { error: 'date, startTime and reason are required' });
          return;
        }
        // Present-but-empty technicianRef: same contract as the MCP layer — an
        // error, never silently "keep the current person" when the caller
        // plainly meant to name someone.
        if ('technicianRef' in body && str(body, 'technicianRef') === undefined) {
          json(res, 400, {
            error: 'technicianRef was empty — pass a roster ref, or omit it to keep the assignment',
          });
          return;
        }
        // Detach (plan 4a.5): unassign:true parks the visit. Exactly-true
        // check — anything else present is a caller bug, not a park request.
        if ('unassign' in body && typeof body.unassign !== 'boolean') {
          json(res, 400, { error: 'unassign must be a boolean' });
          return;
        }
        const unassign = body.unassign === true;
        if (unassign && str(body, 'technicianRef')) {
          json(res, 400, {
            error: 'pass technicianRef to attach/reassign OR unassign:true to park — not both',
          });
          return;
        }
        if (!(await boardDateAllowed(auth.tenantId, date))) {
          json(res, 400, { error: PAST_DATE_ERROR });
          return;
        }
        const input = {
          tenantId: auth.tenantId,
          assignmentId,
          date,
          startTime,
          endTime: str(body, 'endTime'),
          technicianRef: str(body, 'technicianRef'), // set = assign/reassign (Feature A attach)
          ...(unassign ? { unassign: true } : {}),
          reason,
          actorRef: auth.technician.ref,
        };
        if (preview) {
          json(res, 200, await previewMoveVisit(input));
          return;
        }
        const moved = await moveVisit(input);
        json(res, 200, {
          status: 'moved',
          promiseBroken: moved.promiseBroken,
          // A move ALWAYS produces a placed row (rescheduleAssignment requires
          // times) — assert instead of widening the payload (plan 4b-2).
          start: moved.created.starts_at as string,
          end: moved.created.ends_at as string,
          ...(moved.warning ? { warning: moved.warning } : {}),
        });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The shared verbs throw untyped Errors for refusals AND infra faults
        // (booking.ts is deliberately outside this feature's footprint, so no
        // typed refusal exists to discriminate on). Triage order matters:
        // the UNSCHEDULED stranding travels verbatim FIRST — it reports a real
        // state change and can embed a db "failed:" fragment — then the db
        // layer's uniform "<fn> failed:" prefix marks a server fault (logged
        // 500, no internal strings to the webview); everything else is a verb
        // refusal the UI must show as-is.
        if (!message.includes('UNSCHEDULED') && / failed: /.test(message)) {
          console.error('board write failed:', err);
          json(res, 500, { error: 'server error — try again shortly' });
          return;
        }
        json(res, 409, { error: message });
        return;
      }
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    // Genuine server faults (incl. DB outages surfacing through authBoard's
    // roster lookup) — log them; a silent bare 500 leaves the operator blind.
    console.error('board request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}
