import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { listTenantSeats, readRollup, type CostRollupRow } from '../db/index.js';

// The operator cost dashboard's HTTP surface, mounted by httpServer.ts BEFORE
// the IP allowlist: this page loads in an operator's ordinary browser, not
// through the gateway, so the allowlist must not gate it (the board precedent).
//
// THIS IS THE ONLY CROSS-TENANT READ SURFACE IN THE SYSTEM. Every other surface
// resolves to exactly one roster row and answers for that tenant alone; this one
// deliberately shows every tenant's spend side by side. Two consequences:
//   1. it authenticates with a shared bearer token rather than a per-person
//      identity, because there is no operator identity system to hang it on;
//   2. the four cost tables have RLS enabled with no policy (migration
//      20260725140000), so the publishable anon key cannot reach the same data
//      by going straight to PostgREST and around this handler.
// Without (2), (1) would be decorative.

export function isAdminPath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/');
}

// Always path.resolve the root: a trailing-slash or relative ADMIN_STATIC_DIR
// would fail the containment prefix-check and 404 the whole dashboard.
const staticDir = (): string =>
  path.resolve(process.env.ADMIN_STATIC_DIR ?? path.join(process.cwd(), 'web/admin'));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Constant-time compare, with the length check FIRST: timingSafeEqual throws on
// unequal-length buffers, so comparing a wrong-length token would surface as a
// 500 (and leak the correct length through the difference in response).
function tokenMatches(presented: string): boolean {
  // Trimmed, matching the configured-check above. Untrimmed, a stray newline on
  // a pasted Render env value would pass 'is configured' (so no 503 to diagnose
  // from) while 401ing every request forever.
  const expected = (process.env.ADMIN_DASHBOARD_TOKEN ?? '').trim();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type AdminAuth = { ok: true } | { ok: false; code: 401 | 503 };

function authAdmin(req: http.IncomingMessage): AdminAuth {
  // Unset token => 503, never open. A deploy that forgets the env var must fail
  // CLOSED: this endpoint serves every tenant's finances.
  if (!(process.env.ADMIN_DASHBOARD_TOKEN ?? '').trim()) return { ok: false, code: 503 };
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return { ok: false, code: 401 };
  return tokenMatches(m[1].trim()) ? { ok: true } : { ok: false, code: 401 };
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  // no-store: shared caches already skip an Authorization-bearing request, but
  // the browser's PRIVATE disk cache does not — and this body is every tenant's
  // spend, on whatever laptop happened to open the dashboard.
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res: http.ServerResponse, name: string): Promise<void> {
  const ext = path.extname(name);
  const type = CONTENT_TYPES[ext];
  // Reject traversal and anything outside the whitelist BEFORE touching the
  // filesystem; resolve + prefix-check as the backstop (boardApi precedent).
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

export interface TenantCostLine {
  tenantId: string;
  tenantName: string;
  seats: number;
  costUsd: number;
  costPerSeatUsd: number | null;
  // Does ANY part of this tenant's cost come from an allocated bill? The
  // headline Cost and $/seat figures must carry the marker too, not only the
  // breakdown text — inference is allocated by design and is usually the
  // largest line, so the most prominent number on the page is nearly always
  // part-estimate. Showing it bare is precisely the failure the disclosure
  // discipline exists to prevent.
  hasEstimate: boolean;
  // Per-provider split, each carrying HOW the figure was derived. The UI must
  // render 'allocated' visibly differently from 'measured' — an estimate that
  // looks like a metered fact is the failure this whole disclosure discipline
  // exists to prevent (durationAssumption / driveMeasured:false precedent).
  lines: Array<{ provider: string; method: string; costUsd: number; quantity: number }>;
}

export interface CostReport {
  period: string; // YYYY-MM
  totalUsd: number;
  // True when any part of totalUsd was allocated rather than metered.
  totalHasEstimate: boolean;
  previousTotalUsd: number;
  byProvider: Array<{ provider: string; costUsd: number; hasEstimate: boolean }>;
  tenants: TenantCostLine[];
  trend: Array<{ period: string; totalUsd: number }>;
  generatedAt: string;
}

// Month is validated HERE, not just structurally: /\d{2}/ accepts 00 and 13,
// which then throw inside the date math. Belt to buildCostReport's braces.
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthStart = (period: string): string => `${period}-01`;
const shiftMonth = (period: string, delta: number): string => {
  const d = new Date(`${monthStart(period)}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
};
const sum = (rows: CostRollupRow[]): number =>
  rows.reduce((acc, r) => acc + Number(r.cost_usd), 0);

export async function buildCostReport(period: string): Promise<CostReport> {
  // Compute EVERY derived period BEFORE opening any query. shiftMonth throws on
  // an impossible month, and a throw between two elements of a Promise.all array
  // orphans the promises already in flight — an unhandled rejection that takes
  // down the whole process, which also serves MCP, the board, the inbound
  // webhooks and the Composio relay. (The regex now rejects month 00/13+ too;
  // this ordering is the second line of defence.)
  const currentMonth = monthStart(period);
  const previousMonth = monthStart(shiftMonth(period, -1));
  // Six months ending at the requested one. Cheap: cost_rollup_monthly holds
  // tenants x providers x methods rows per month, not raw events.
  const trendPeriods = Array.from({ length: 6 }, (_, i) => shiftMonth(period, -(5 - i)));

  const [current, previous, tenants] = await Promise.all([
    readRollup(currentMonth),
    readRollup(previousMonth),
    listTenantSeats().then((rows) => new Map(rows.map((t) => [t.id, t]))),
  ]);

  const byProvider = new Map<string, { costUsd: number; hasEstimate: boolean }>();
  const byTenant = new Map<string, CostRollupRow[]>();
  for (const r of current) {
    const p = byProvider.get(r.provider) ?? { costUsd: 0, hasEstimate: false };
    p.costUsd += Number(r.cost_usd);
    // One allocated row anywhere in a provider's total makes the whole figure an
    // estimate — the UI marks it as such rather than implying false precision.
    p.hasEstimate = p.hasEstimate || r.method === 'allocated';
    byProvider.set(r.provider, p);
    byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
  }

  // The last two trend points ARE `current` and `previous` — reuse them instead
  // of asking the database the same two questions again.
  const trend = await Promise.all(
    trendPeriods.map(async (p, i) => {
      if (i === 5) return { period: p, totalUsd: sum(current) };
      if (i === 4) return { period: p, totalUsd: sum(previous) };
      return { period: p, totalUsd: sum(await readRollup(monthStart(p))) };
    }),
  );

  return {
    period,
    totalUsd: sum(current),
    totalHasEstimate: current.some((r) => r.method === 'allocated'),
    previousTotalUsd: sum(previous),
    byProvider: [...byProvider.entries()]
      .map(([provider, v]) => ({ provider, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd),
    tenants: [...byTenant.entries()]
      .map(([tenantId, rows]) => {
        const meta = tenants.get(tenantId);
        const costUsd = sum(rows);
        const seats = meta?.seats ?? 0;
        return {
          tenantId,
          tenantName: meta?.name ?? '(unknown tenant)',
          seats,
          costUsd,
          hasEstimate: rows.some((r) => r.method === 'allocated'),
          // null, not 0, when there are no seats: "we don't know" and "it costs
          // nothing per seat" are different claims, and only one is true.
          costPerSeatUsd: seats > 0 ? costUsd / seats : null,
          lines: rows
            .map((r) => ({
              provider: r.provider,
              method: r.method,
              costUsd: Number(r.cost_usd),
              quantity: Number(r.quantity),
            }))
            .sort((a, b) => b.costUsd - a.costUsd),
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd),
    trend,
    generatedAt: new Date().toISOString(),
  };
}

export async function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const pathname = (req.url ?? '/admin').split('?')[0];

    // The shell and its assets are served unauthenticated — they carry NO data,
    // only the markup that then asks for the token (board precedent). Every
    // figure arrives through the authed JSON call below.
    // `return await`, not `return`: a bare `return promise` inside try does not
    // route its rejection to the catch below, so a server fault would escape to
    // httpServer's generic handler and answer 401 — an auth code for what is
    // not an auth problem.
    if (pathname === '/admin' || pathname === '/admin/') {
      return await serveStatic(res, 'index.html');
    }
    if (pathname.startsWith('/admin/static/')) {
      return await serveStatic(res, pathname.slice('/admin/static/'.length));
    }

    if (pathname === '/admin/api/costs') {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      const auth = authAdmin(req);
      if (!auth.ok) {
        // 503 says "misconfigured", 401 says nothing at all — an auth failure
        // must not distinguish "no such token" from "wrong token".
        if (auth.code === 503) return json(res, 503, { error: 'admin dashboard is not configured' });
        res.writeHead(401);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/admin', 'http://admin.local');
      const period = url.searchParams.get('period') ?? new Date().toISOString().slice(0, 7);
      if (!PERIOD.test(period)) return json(res, 400, { error: 'period must be YYYY-MM' });
      return json(res, 200, await buildCostReport(period));
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error(`[admin] ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}
