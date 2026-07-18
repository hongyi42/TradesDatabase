import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyInitData } from './initData.js';
import { findRosterByTelegramUserIdGlobal, type Technician } from '../db/index.js';
import { InvalidRangeError, readBoardDays } from '../schedule/boardRead.js';

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

export async function handleBoardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
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

    res.writeHead(404);
    res.end();
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}
