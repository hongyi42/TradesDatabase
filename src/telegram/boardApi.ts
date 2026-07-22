import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyInitData } from './initData.js';
import * as rosterCache from './rosterCache.js';
import { findRosterByTelegramUserIdGlobal, type Technician } from '../db/index.js';
import { InvalidRangeError, readBoardDays, readVisitDetail } from '../schedule/boardRead.js';
import {
  cancelVisit,
  moveVisit,
  previewCancelVisit,
  previewMoveVisit,
} from '../schedule/booking.js';

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

    // Manager-only write path (Phase 3). Both verbs are the SAME shared
    // booking.ts verbs the chat agent drives — every guard (tenant, overlap,
    // promise ladder) fires identically. The confirm model is Feature A's
    // doctrine, inherited via the previews' requiresConfirmation: the page
    // previews first, one-shots when false, confirms in-UI when true.
    if (
      (pathname === '/board/api/move' || pathname === '/board/api/cancel') &&
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
      const assignmentId = str(body, 'assignmentId');
      const reason = str(body, 'reason');
      if (!assignmentId) {
        json(res, 400, { error: 'assignmentId is required' });
        return;
      }
      try {
        if (pathname === '/board/api/cancel') {
          if (preview) {
            json(res, 200, await previewCancelVisit(auth.tenantId, assignmentId));
            return;
          }
          if (!reason) {
            json(res, 400, { error: 'reason is required' });
            return;
          }
          const cancelled = await cancelVisit({
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
            day: cancelled.starts_at.slice(0, 10),
            promiseLevel: cancelled.promise_level,
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
        const input = {
          tenantId: auth.tenantId,
          assignmentId,
          date,
          startTime,
          endTime: str(body, 'endTime'),
          technicianRef: str(body, 'technicianRef'), // set = assign/reassign (Feature A attach)
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
          start: moved.created.starts_at,
          end: moved.created.ends_at,
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
