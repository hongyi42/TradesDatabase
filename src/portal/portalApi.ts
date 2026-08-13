import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  clearSessionCookie,
  completeMagicLink,
  currentSession,
  hasMailer,
  requestMagicLink,
  setSessionCookie,
  signOut,
} from './auth.js';
import { getSeat, getSummary, listSeats } from './queries.js';

// The customer account portal's HTTP surface (design handoff 2026-08-07).
// Mounted by httpServer.ts BEFORE the IP allowlist, for the same reason as
// /admin and /board: this loads in a customer's ordinary browser, not through
// the gateway, so the allowlist would 403 every real user.
//
// SCOPE OF THIS FILE TODAY: static assets only. The React app runs entirely on
// mock data, so there is no /portal/api/* yet and nothing here reads the
// database. That is deliberate — the auth and tenant-scoping work is the
// riskiest part of the feature and is planned as its own phase
// (thoughts/shared/plans/2026-08-07-customer-billing-portal.md, Phase 2).
//
// When data endpoints land here they inherit the adminApi contract: bearer or
// session auth checked per request, `cache-control: no-store` on every JSON
// body, unset config fails CLOSED with a 503, and every read is scoped to
// exactly one tenant resolved from the session — never from a query parameter.

export function isPortalPath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return pathname === '/portal' || pathname === '/portal/' || pathname.startsWith('/portal/');
}

// Always path.resolve the root: a trailing-slash or relative PORTAL_STATIC_DIR
// would fail the containment prefix-check and 404 the whole app.
const staticDir = (): string =>
  path.resolve(process.env.PORTAL_STATIC_DIR ?? path.join(process.cwd(), 'web/portal/dist'));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// Hashed filenames are immutable; index.html must never be cached or a deploy
// leaves browsers pointing at asset names that no longer exist.
function cacheControl(name: string): string {
  return name === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable';
}

async function serveStatic(res: http.ServerResponse, name: string): Promise<void> {
  const ext = path.extname(name);
  const type = CONTENT_TYPES[ext];
  // Reject traversal and anything outside the whitelist BEFORE touching the
  // filesystem; resolve + prefix-check as the backstop (adminApi precedent).
  // The build is configured to emit FLAT filenames precisely so this check can
  // keep refusing every path separator.
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
    res.writeHead(200, { 'content-type': type, 'cache-control': cacheControl(name) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

// ── JSON + body helpers ────────────────────────────────────────────────────

// no-store on EVERY JSON body: these are one tenant's business records, and the
// browser's private disk cache does not skip them the way a shared cache skips
// an Authorization-bearing request (the adminApi reasoning).
function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// 8 KB. These endpoints are reachable pre-auth from the public internet, so an
// uncapped read is a memory-DoS invitation (the board path's reasoning).
const MAX_BODY_BYTES = 8 * 1024;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.length) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Where our own magic-link callback lives. Derived from the request rather than
 * configured, so a preview deploy links to itself — but ONLY from a trusted
 * source: `PORTAL_PUBLIC_ORIGIN` when set, else the Host header.
 *
 * The Host header is attacker-controllable, which is the classic host-header
 * injection that turns a password-reset mail into a token exfiltration. Set
 * PORTAL_PUBLIC_ORIGIN in production. The scheme follows the same insecure-local
 * switch as the cookie so a dev machine on plain http still works.
 */
function publicOrigin(req: http.IncomingMessage): string {
  const configured = (process.env.PORTAL_PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const host = req.headers.host ?? 'localhost';
  const scheme = process.env.PORTAL_INSECURE_COOKIES === '1' ? 'http' : 'https';
  return `${scheme}://${host}`;
}

// ── API ────────────────────────────────────────────────────────────────────

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  // --- Auth: request a link -------------------------------------------------
  if (pathname === '/portal/api/auth/request-link') {
    if (method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    // Unset mail config fails CLOSED (the /admin precedent): a deploy that forgot
    // its mailer must not look like a working sign-in that silently sends nothing.
    if (!hasMailer()) return json(res, 503, { error: 'unavailable' });

    const body = await readJsonBody(req);
    const email = typeof body?.email === 'string' ? body.email : '';

    // ACCOUNT ENUMERATION: 204 regardless of whether this address is a customer.
    // Signup is invite-only, so "is this firm a customer of yours?" must not be
    // answerable by an outsider. Any error is swallowed to the same 204 for the
    // same reason — a 500 on known addresses only would be a perfect oracle.
    try {
      const result = await requestMagicLink({ email, origin: publicOrigin(req) });
      if (!result.ok) return json(res, 503, { error: 'unavailable' });
    } catch (err) {
      console.error(`[portal] request-link: ${err instanceof Error ? err.message : String(err)}`);
    }
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  // --- Auth: redeem a link --------------------------------------------------
  if (pathname === '/portal/api/auth/callback') {
    if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    const token = new URL(req.url ?? '', 'http://x').searchParams.get('token') ?? '';
    const result = await completeMagicLink({
      token,
      userAgent: req.headers['user-agent'] ?? null,
    });
    if (!result.ok) {
      // A bad, expired, replayed, or no-longer-a-customer token are all the same
      // opaque failure. Redirect rather than render so the token leaves the URL
      // bar (and so the Referer of any later request cannot carry it).
      res.writeHead(303, { location: '/portal?signin=invalid', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    setSessionCookie(res, result.token, result.expiresAt);
    res.writeHead(303, { location: '/portal', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  // --- Auth: sign out -------------------------------------------------------
  if (pathname === '/portal/api/auth/signout') {
    if (method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    await signOut(req);
    clearSessionCookie(res);
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }

  // --- Everything below requires a session ----------------------------------
  const session = await currentSession(req);
  if (!session) return json(res, 401, { error: 'unauthenticated' });

  if (pathname === '/portal/api/me') {
    if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    // Deliberately does NOT echo tenantId: the client never needs it, and every
    // read is scoped server-side from the session anyway. Shipping it would
    // invite a future handler to accept it back as a parameter.
    return json(res, 200, { email: session.email, role: session.role });
  }

  if (pathname === '/portal/api/summary') {
    if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    const summary = await getSummary(session.tenantId);
    return summary ? json(res, 200, summary) : json(res, 404, { error: 'not_found' });
  }

  if (pathname === '/portal/api/seats') {
    if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    return json(res, 200, { seats: await listSeats(session.tenantId) });
  }

  if (pathname.startsWith('/portal/api/seats/')) {
    if (method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
    const ref = decodeURIComponent(pathname.slice('/portal/api/seats/'.length));
    // tenantId comes from the SESSION and the ref from the path — never the
    // other way round. A ref belonging to another tenant returns 404, so it is
    // indistinguishable from one that does not exist.
    const seat = await getSeat(session.tenantId, ref);
    return seat ? json(res, 200, seat) : json(res, 404, { error: 'not_found' });
  }

  return json(res, 404, { error: 'not_found' });
}

export async function handlePortalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const pathname = (req.url ?? '/portal').split('?')[0];

    if (pathname.startsWith('/portal/api/')) {
      return await handleApi(req, res, pathname);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    // The shell and its assets are served unauthenticated — they carry NO data,
    // only the markup that then asks for a session (the /admin and /board
    // precedent). `return await`, not `return`: a bare `return promise` inside
    // try does not route its rejection to the catch below, so a server fault
    // would escape to httpServer's generic handler and answer 401 — an auth
    // code for what is not an auth problem.
    if (pathname === '/portal' || pathname === '/portal/') {
      return await serveStatic(res, 'index.html');
    }
    return await serveStatic(res, pathname.slice('/portal/'.length));
  } catch (err) {
    console.error(`[portal] ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}
