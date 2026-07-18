import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyInitData } from './initData.js';
import { findRosterByTelegramUserIdGlobal, type Technician } from '../db/index.js';
import { InvalidRangeError, readBoardDays } from '../schedule/boardRead.js';
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

// Auth posture per the plan: any failure (missing/garbled header, bad
// signature, stale slip, unknown id, unconfigured token) → bare 401, no
// detail. The ONE distinguished failure is a Telegram account live on more
// than one firm — 409, so the UI can say why instead of looking broken.
async function authBoard(req: http.IncomingMessage): Promise<BoardAuth> {
  try {
    const m = /^tma\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) return { ok: false, code: 401 };
    const verified = verifyInitData(m[1], process.env.BOARD_BOT_TOKEN ?? '');
    const match = await findRosterByTelegramUserIdGlobal(verified.userId);
    if (!match) return { ok: false, code: 401 };
    if ('ambiguous' in match) {
      return { ok: false, code: 409, error: 'account on multiple firms' };
    }
    return { ok: true, tenantId: match.technician.tenant_id, technician: match.technician };
  } catch {
    return { ok: false, code: 401 };
  }
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
      try {
        const days = await readBoardDays({
          tenantId: auth.tenantId,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          viewerTechnicianId: isManager ? null : auth.technician.id,
        });
        json(res, 200, { tier: auth.technician.tier, self: auth.technician.ref, ...days });
      } catch (err) {
        if (err instanceof InvalidRangeError) {
          json(res, 400, { error: err.message });
          return;
        }
        throw err;
      }
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
        // Verb refusals travel verbatim (incl. the UNSCHEDULED stranding).
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }

    res.writeHead(404);
    res.end();
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}
