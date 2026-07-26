import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { connect, type AddressInfo } from 'node:net';
import type http from 'node:http';
import { Client as PgClient } from 'pg';
import { createHttpServer } from '../mcp/httpServer.js';
import { appendCostEvents, rollupCosts } from '../db/costs.js';
import { isAdminPath } from './adminApi.js';

// Driven through the REAL HTTP server, not the handler in isolation: the whole
// point of this surface is WHERE it is mounted (before the IP allowlist), and a
// handler-only test cannot see that.
const TOKEN = 'test-admin-token-0123456789abcdef';
const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
let server: http.Server;
let base: string;
let tenantId: string;
let prevToken: string | undefined;

const auth = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  await pg.connect();
  prevToken = process.env.ADMIN_DASHBOARD_TOKEN;
  process.env.ADMIN_DASHBOARD_TOKEN = TOKEN;
  const { rows } = await pg.query<{ id: string }>(
    `select id from tenants where name = 'Default Tenant'`,
  );
  tenantId = rows[0].id;
  await pg.query("delete from cost_events where source_ref like 'adm-%'");
  await pg.query('delete from cost_rollup_monthly');
  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pg.query("delete from cost_events where source_ref like 'adm-%'");
  await pg.query('delete from cost_rollup_monthly');
  await pg.end();
  if (prevToken === undefined) delete process.env.ADMIN_DASHBOARD_TOKEN;
  else process.env.ADMIN_DASHBOARD_TOKEN = prevToken;
});

afterEach(() => {
  process.env.ADMIN_DASHBOARD_TOKEN = TOKEN;
});

describe('isAdminPath', () => {
  test('matches the admin tree only', () => {
    for (const u of ['/admin', '/admin/', '/admin/api/costs', '/admin/static/admin.js', '/admin?x=1']) {
      expect(isAdminPath(u)).toBe(true);
    }
    // Must not shadow any existing route.
    for (const u of ['/adminX', '/board', '/composio', '/inbound/x', '/control/badges', '/', undefined]) {
      expect(isAdminPath(u)).toBe(false);
    }
  });
});

describe('auth', () => {
  test('no token configured → 503, never open', async () => {
    delete process.env.ADMIN_DASHBOARD_TOKEN;
    const res = await fetch(`${base}/admin/api/costs`, { headers: auth() });
    expect(res.status).toBe(503);
  });

  test('missing header → bare 401 with no detail', async () => {
    const res = await fetch(`${base}/admin/api/costs`);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  test('wrong token of the SAME length → 401', async () => {
    const wrong = 'x'.repeat(TOKEN.length);
    expect(wrong.length).toBe(TOKEN.length); // exercises timingSafeEqual itself
    expect((await fetch(`${base}/admin/api/costs`, { headers: auth(wrong) })).status).toBe(401);
  });

  // timingSafeEqual THROWS on unequal-length buffers. Without the length check
  // first this would be a 500 — and the difference between 500 and 401 would
  // leak the correct token length.
  test('wrong token of a DIFFERENT length → 401, not 500', async () => {
    for (const t of ['short', `${TOKEN}-plus-extra`, '']) {
      expect((await fetch(`${base}/admin/api/costs`, { headers: auth(t) })).status).toBe(401);
    }
  });

  test('correct token → 200', async () => {
    expect((await fetch(`${base}/admin/api/costs`, { headers: auth() })).status).toBe(200);
  });

  test('non-GET is refused', async () => {
    const res = await fetch(`${base}/admin/api/costs`, { method: 'POST', headers: auth() });
    expect(res.status).toBe(405);
  });
});

describe('static shell', () => {
  test('serves the page and its assets unauthenticated — they carry no data', async () => {
    const page = await fetch(`${base}/admin`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Cost dashboard');
    // The shell must not embed any figure or secret.
    expect(html).not.toContain(TOKEN);
    expect((await fetch(`${base}/admin/static/admin.js`)).status).toBe(200);
    expect((await fetch(`${base}/admin/static/admin.css`)).status).toBe(200);
  });

  test('non-whitelisted types and nested paths are refused', async () => {
    for (const p of ['/admin/static/admin.ts', '/admin/static/nope.html', '/admin/static/subdir/admin.js']) {
      expect((await fetch(`${base}${p}`)).status).toBe(404);
    }
  });

  // Assert the SECURITY PROPERTY, not a status code. fetch() normalizes some of
  // these client-side (`%2e%2e/` decodes and collapses to `/.env`, which then
  // lands on the MCP catch-all's 401) — a perfectly fine outcome, and pinning
  // 404 would make the test fail for a reason that is not a vulnerability. What
  // must hold is: never 200, and never any file content.
  test('encoded traversal never returns file content', async () => {
    for (const p of [
      '/admin/static/..%2f..%2f.env',
      '/admin/static/%2e%2e/%2e%2e/.env',
      '/admin/static/..%5c..%5c.env',
    ]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain('SUPABASE');
    }
  });

  // A real attacker does not use fetch(). Send the literal, un-normalized path
  // over a raw socket so the traversal reaches the handler exactly as written —
  // the only way to prove the server itself rejects it rather than relying on a
  // client library to sanitize first.
  test('a raw un-normalized traversal is refused by the server', async () => {
    const rawGet = (rawPath: string) =>
      new Promise<string>((resolve, reject) => {
        const { port } = server.address() as AddressInfo;
        const sock = connect(port, '127.0.0.1', () => {
          sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let buf = '';
        sock.on('data', (d) => (buf += d.toString()));
        sock.on('end', () => resolve(buf));
        sock.on('error', reject);
      });
    for (const p of ['/admin/static/../../.env', '/admin/static/../../../etc/passwd']) {
      const raw = await rawGet(p);
      expect(raw.split('\r\n')[0]).toMatch(/ 40[034] /); // refused, never 200
      expect(raw).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(raw).not.toContain('root:');
    }
  });

  test('an unrouted admin path 404s in this handler, never falls through to MCP', async () => {
    expect((await fetch(`${base}/admin/api/nope`, { headers: auth() })).status).toBe(404);
  });
});

// THE MOUNT-POSITION TEST. `allowed()` returns true when ALLOWED_CLIENT_IPS is
// unset, so without setting it this check is vacuous — it would pass even with
// the block mounted on the wrong side of the allowlist.
describe('route ordering', () => {
  test('admin bypasses the IP allowlist; neighbouring paths still do not', async () => {
    const prev = process.env.ALLOWED_CLIENT_IPS;
    process.env.ALLOWED_CLIENT_IPS = '203.0.113.9'; // matches no test client
    try {
      // Operator browsers are never on the allowlist, so these must still serve.
      expect((await fetch(`${base}/admin`)).status).toBe(200);
      expect((await fetch(`${base}/admin/api/costs`, { headers: auth() })).status).toBe(200);
      // …and a path that is NOT admin is still stopped, proving the branch sits
      // before the allowlist and nothing else leaked past it.
      expect((await fetch(`${base}/adminX`)).status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_CLIENT_IPS;
      else process.env.ALLOWED_CLIENT_IPS = prev;
    }
  });

  test('existing routes still route correctly', async () => {
    // Board still self-authenticates (401 without a slip, not 404/403).
    expect((await fetch(`${base}/board/api/day`)).status).toBe(401);
    // Board shell still serves.
    expect((await fetch(`${base}/board`)).status).toBe(200);
    // Badge pull still requires its host token.
    expect((await fetch(`${base}/control/badges`)).status).toBe(401);
  });
});

// The bearer token guards the FRONT door. RLS guards the side one: without it
// anyone holding the publishable anon key reads the same cross-tenant data
// straight from PostgREST and never touches this handler — which would make the
// token decorative. Proven with `set local role`, so no anon key is needed.
describe('RLS on the cost tables', () => {
  const COST_TABLES = ['cost_rates', 'cost_events', 'infra_costs', 'cost_rollup_monthly'];

  for (const role of ['anon', 'authenticated']) {
    test(`role ${role} cannot read any cost table`, async () => {
      for (const table of COST_TABLES) {
        await pg.query('begin');
        try {
          await pg.query(`set local role ${role}`);
          await expect(pg.query(`select * from ${table} limit 1`)).rejects.toMatchObject({
            code: '42501', // insufficient_privilege
          });
        } finally {
          await pg.query('rollback');
        }
      }
    });
  }

  // Without this the test above could pass for the wrong reason — e.g. if the
  // role could read nothing at all, or the connection were already restricted.
  test('the same role CAN still read a non-cost table (the probe is real)', async () => {
    await pg.query('begin');
    try {
      await pg.query('set local role anon');
      await expect(pg.query('select id from customers limit 1')).resolves.toBeDefined();
    } finally {
      await pg.query('rollback');
    }
  });

  // The half that matters just as much: an RLS change that quietly broke the
  // cron or this endpoint would be worse than the exposure it closes.
  test('the service-role path still reads its own writes', async () => {
    await appendCostEvents([
      { tenantId, provider: 'brave', sku: 'search', quantity: 100, unit: 'request', method: 'measured', occurredAt: '2026-07-14T10:00:00.000Z', sourceRef: 'adm-rls' },
    ]);
    await rollupCosts('2026-07-01');
    const res = await fetch(`${base}/admin/api/costs?period=2026-07`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { totalUsd: number }).totalUsd).toBeGreaterThan(0);
  });
});

describe('cost report', () => {
  test('reports per-tenant totals, $/seat, and the method on every line', async () => {
    const period = '2026-07';
    // Self-contained: this asserts an ABSOLUTE total, so it must not inherit
    // whatever an earlier test in this file left in the same period.
    await pg.query("delete from cost_events where source_ref like 'adm-%'");
    await pg.query('delete from cost_rollup_monthly');
    await appendCostEvents([
      // 400 searches x $0.005 = $2.00
      { tenantId, provider: 'brave', sku: 'search', quantity: 400, unit: 'request', method: 'measured', occurredAt: '2026-07-08T10:00:00.000Z', sourceRef: 'adm-1' },
    ]);
    await rollupCosts(`${period}-01`);

    const res = await fetch(`${base}/admin/api/costs?period=${period}`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: string;
      totalUsd: number;
      byProvider: Array<{ provider: string; costUsd: number; hasEstimate: boolean }>;
      tenants: Array<{ tenantName: string; seats: number; costUsd: number; costPerSeatUsd: number | null; lines: Array<{ method: string }> }>;
      trend: Array<{ period: string }>;
    };
    expect(body.period).toBe(period);
    expect(body.totalUsd).toBeCloseTo(2.0, 6);
    expect(body.byProvider[0]).toMatchObject({ provider: 'brave', hasEstimate: false });

    const t = body.tenants.find((x) => x.tenantName === 'Default Tenant');
    expect(t?.costUsd).toBeCloseTo(2.0, 6);
    // The disclosure contract: every line says how it was derived.
    expect(t?.lines.every((l) => l.method === 'measured' || l.method === 'allocated')).toBe(true);
    // $/seat is the commercially meaningful number — and must be null, not 0,
    // when seats are unknown ("we can't say" ≠ "costs nothing").
    expect(t && (t.seats > 0 ? t.costPerSeatUsd : t.costPerSeatUsd === null)).toBeTruthy();
    // Six months ending at the requested period.
    expect(body.trend).toHaveLength(6);
    expect(body.trend[5].period).toBe(period);
  });

  // An impossible MONTH (00, 13+) is structurally well-formed but blows up the
  // date math. Before the tightened regex this threw between two elements of a
  // Promise.all array, orphaning an in-flight query into an unhandled rejection
  // — which kills the whole process, and this one also serves MCP, the board,
  // the inbound webhooks and the Composio relay.
  test('a malformed or impossible period is refused, and the server survives', async () => {
    for (const p of [
      '2026', 'july', '2026-7-01', "2026-07'; drop table cost_events;--",
      '2026-00', '2026-13', '2026-99',
    ]) {
      const res = await fetch(`${base}/admin/api/costs?period=${encodeURIComponent(p)}`, { headers: auth() });
      expect(res.status).toBe(400);
    }
    // Still alive and serving after all of that.
    expect((await fetch(`${base}/admin/api/costs?period=2026-07`, { headers: auth() })).status).toBe(200);
  });
});
