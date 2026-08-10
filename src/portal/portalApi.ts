import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

export async function handlePortalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const pathname = (req.url ?? '/portal').split('?')[0];

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
