import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createHttpServer } from '../mcp/httpServer.js';
import { getClient } from '../db/client.js';
import { setTenantSeats, createTenant } from '../db/tenants.js';
import { insertTechnician, updateTechnician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { bookVisit } from '../schedule/booking.js';

// Integration: the /board routes over a real HTTP server on an ephemeral port
// against the local stack (httpServer.test.ts harness). BOARD_BOT_TOKEN is set
// per-process; slips are minted with the same scheme initData.test.ts mirrors.
const TOKEN = '7000000009:BOARD-api-suite-token';
const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let server: http.Server;
let base: string;
let tenantId: string;
let prevToken: string | undefined;

function signSlip(userId: number, token = TOKEN): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAboard',
    user: JSON.stringify({ id: userId, first_name: 'Probe' }),
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

const tma = (userId: number): Record<string, string> => ({
  Authorization: `tma ${signSlip(userId)}`,
});

const day = (query: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/board/api/day${query}`, { headers });

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  prevToken = process.env.BOARD_BOT_TOKEN;
  process.env.BOARD_BOT_TOKEN = TOKEN;

  // Roster: a bound manager, a bound technician, and a second technician whose
  // stops the first must NOT see. Bindings are Telegram ids (digits as text).
  const mgr = await insertTechnician({
    tenantId,
    ref: 'board-mgr',
    displayName: 'Board Manager',
    tier: 'manager',
  });
  await updateTechnician(mgr.id, { telegram_user_id: '900000001', state: 'active' });
  const t1 = await insertTechnician({ tenantId, ref: 'board-t1', displayName: 'Tess One' });
  await updateTechnician(t1.id, { telegram_user_id: '900000002', state: 'active' });
  const t2 = await insertTechnician({ tenantId, ref: 'board-t2', displayName: 'Theo Two' });
  await updateTechnician(t2.id, { state: 'active' });

  // Three confirmed stops on one day via the REAL booking verb: t1, t2, and an
  // unassigned visit (no technicianRef — Feature A's null technician_id).
  const casa = await createCustomer({
    tenantId,
    name: 'Board Casa',
    addressLine1: '12 Board St',
    city: 'Springfield',
    state: 'OR',
    postalCode: '97477',
  });
  const bookArgs = { tenantId, customerId: casa.id, actorRef: 'board-mgr', date: '2026-09-01' };
  await bookVisit({ ...bookArgs, technicianRef: 'board-t1', title: 'AC tune-up', startTime: '09:00', endTime: '11:00' });
  await bookVisit({ ...bookArgs, technicianRef: 'board-t2', title: 'Filter swap', startTime: '10:00', endTime: '12:00' });
  await bookVisit({ ...bookArgs, title: 'Duct inspection', startTime: '13:00', endTime: '15:00' });

  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (prevToken === undefined) delete process.env.BOARD_BOT_TOKEN;
  else process.env.BOARD_BOT_TOKEN = prevToken;
  await pg.query(TRUNCATE);
  await pg.query("delete from tenants where name = 'Board API Probe Tenant'");
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

interface DayResponse {
  tier: string;
  self: string;
  from: string;
  to: string;
  scheduleVersion: number;
  days: Array<{
    date: string;
    stops: Array<{
      technicianRef: string | null;
      technicianName: string | null;
      unassigned: boolean;
      customer: string | null;
      address: string | null;
      start: string;
      end: string;
    }>;
  }>;
}

describe('board static shell', () => {
  test('GET /board and /board/ serve the page; assets come off /board/static', async () => {
    for (const p of ['/board', '/board/']) {
      const resp = await fetch(`${base}${p}`);
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toContain('text/html');
      expect(await resp.text()).toContain('/board/static/board.js');
    }
    const js = await fetch(`${base}/board/static/board.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
  });

  test('traversal and non-whitelisted asset paths are rejected', async () => {
    // Encoded traversal (fetch would normalize a literal ../ away client-side).
    expect((await fetch(`${base}/board/static/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/board/static/secrets.env`)).status).toBe(404);
    expect((await fetch(`${base}/board/static/nope.js`)).status).toBe(404);
  });
});

describe('GET /board/api/day', () => {
  test('no/garbled/misfit auth → bare 401', async () => {
    const bare = await day('?from=2026-09-01');
    expect(bare.status).toBe(401);
    expect(await bare.text()).toBe('');
    expect((await day('?from=2026-09-01', { Authorization: 'tma not-a-slip' })).status).toBe(401);
    // Valid slip for an id nobody on any roster holds → 401 too.
    expect((await day('?from=2026-09-01', tma(900000777))).status).toBe(401);
  });

  test('manager slip → whole team incl. the unassigned stop (null name/ref, unassigned:true)', async () => {
    const resp = await day('?from=2026-09-01', tma(900000001));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as DayResponse;
    expect(body.tier).toBe('manager');
    expect(body.self).toBe('board-mgr');
    expect(body.days).toHaveLength(1);
    const stops = body.days[0].stops;
    expect(stops).toHaveLength(3);
    const byStart = new Map(stops.map((s) => [s.start.slice(11, 16), s]));
    expect(byStart.get('09:00')).toMatchObject({
      technicianRef: 'board-t1',
      technicianName: 'Tess One',
      unassigned: false,
      customer: 'Board Casa',
      address: '12 Board St, Springfield, OR, 97477',
    });
    expect(byStart.get('10:00')).toMatchObject({ technicianRef: 'board-t2', unassigned: false });
    expect(byStart.get('13:00')).toMatchObject({
      technicianRef: null,
      technicianName: null,
      unassigned: true,
    });
  });

  test('technician slip → own stops only; the unassigned stop is absent by construction', async () => {
    const resp = await day('?from=2026-09-01', tma(900000002));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as DayResponse;
    expect(body.tier).toBe('technician');
    expect(body.self).toBe('board-t1');
    const stops = body.days.flatMap((d) => d.stops);
    expect(stops).toHaveLength(1);
    expect(stops[0].technicianRef).toBe('board-t1');
  });

  test('same validation contract as get_team_schedule: bad date / inverted / >14 days → 400', async () => {
    expect((await day('?from=september', tma(900000001))).status).toBe(400);
    expect((await day('?from=2026-09-02&to=2026-09-01', tma(900000001))).status).toBe(400);
    const capped = await day('?from=2026-09-01&to=2026-10-01', tma(900000001));
    expect(capped.status).toBe(400);
    expect(((await capped.json()) as { error: string }).error).toContain('14 days');
  });

  test('a Telegram account live on two firms → 409, named error', async () => {
    const other = await createTenant('Board API Probe Tenant', {
      managerSeats: 1,
      technicianSeats: 1,
    });
    const dupe = await insertTechnician({
      tenantId: other.id,
      ref: 'board-mgr-2',
      displayName: 'Elsewhere Manager',
    });
    await updateTechnician(dupe.id, { telegram_user_id: '900000001', state: 'active' });
    const resp = await day('?from=2026-09-01', tma(900000001));
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe('account on multiple firms');
    // Restore: offboard the twin so later tests see one firm again.
    await updateTechnician(dupe.id, { state: 'offboarded' });
  });
});

describe('route ordering', () => {
  test('board paths bypass the IP allowlist; non-board paths do not; unknown board API → 404 not MCP', async () => {
    const prev = process.env.ALLOWED_CLIENT_IPS;
    process.env.ALLOWED_CLIENT_IPS = '203.0.113.9'; // matches no test client
    try {
      // Board route still serves (self-authenticated, pre-allowlist)…
      expect((await fetch(`${base}/board`)).status).toBe(200);
      // …while a NON-board path is now stopped by the allowlist (403), proving
      // the board branch sits before it and nothing else leaked forward.
      expect((await fetch(`${base}/boardX`)).status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_CLIENT_IPS;
      else process.env.ALLOWED_CLIENT_IPS = prev;
    }
    // An unrouted /board/api/* path terminates in the board handler (404), it
    // must not fall through to the MCP catch-all.
    expect((await fetch(`${base}/board/api/nope`)).status).toBe(404);
  });
});
