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

describe('board write path (Phase 3)', () => {
  const post = (path: string, body: unknown, userId: number, preview = false) =>
    fetch(`${base}${path}${preview ? '?preview=1' : ''}`, {
      method: 'POST',
      headers: { ...tma(userId), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const assignmentRows = (whereSql: string, params: unknown[] = []) =>
    pg
      .query(
        `select a.id, a.status, a.technician_id, a.starts_at::text as starts_at, t.ref
           from assignments a left join technicians t on t.id = a.technician_id
          where ${whereSql} order by a.created_at`,
        params,
      )
      .then((r) => r.rows as Array<{ id: string; status: string; technician_id: string | null; starts_at: string; ref: string | null }>);

  test('technician slip → 403 managers only; malformed body → 400; empty technicianRef → 400', async () => {
    const resp = await post('/board/api/move', {}, 900000002);
    expect(resp.status).toBe(403);
    expect(((await resp.json()) as { error: string }).error).toBe('managers only');
    expect((await post('/board/api/move', 'not json {{{', 900000001)).status).toBe(400);
    // Present-but-empty ref = MCP-layer parity: an error, never "keep current".
    const emptyRef = await post(
      '/board/api/move',
      { assignmentId: 'x', date: '2026-09-03', startTime: '09:00', technicianRef: '', reason: 'r' },
      900000001,
    );
    expect(emptyRef.status).toBe(400);
    expect(((await emptyRef.json()) as { error: string }).error).toContain('technicianRef was empty');
  });

  test('preview → requiresConfirmation false (unpromised), NO write; commit → moved row + moved event', async () => {
    const [t1Row] = await assignmentRows("t.ref = 'board-t1' and a.status = 'confirmed'");
    const body = {
      assignmentId: t1Row.id,
      date: '2026-09-03',
      startTime: '09:00',
      endTime: '11:00',
      reason: 'shuffle for parts pickup',
    };
    const preview = await post('/board/api/move', body, 900000001, true);
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { requiresConfirmation: boolean; promiseBroken: boolean; toDay: string };
    expect(p).toMatchObject({ requiresConfirmation: false, promiseBroken: false, toDay: '2026-09-03' });
    // Preview wrote NOTHING: the row is untouched, still on 2026-09-01.
    const [after] = await assignmentRows('a.id = $1', [t1Row.id]);
    expect(after.status).toBe('confirmed');
    expect(after.starts_at.slice(0, 10)).toBe('2026-09-01');

    const commit = await post('/board/api/move', body, 900000001);
    expect(commit.status).toBe(200);
    expect(((await commit.json()) as { status: string }).status).toBe('moved');
    // Cross-channel read-back: old row cancelled, new confirmed row on the new
    // day, and a 'moved' schedule_events row hangs off the NEW assignment.
    const [old] = await assignmentRows('a.id = $1', [t1Row.id]);
    expect(old.status).toBe('cancelled');
    const moved = await assignmentRows("t.ref = 'board-t1' and a.status = 'confirmed'");
    expect(moved).toHaveLength(1);
    expect(moved[0].starts_at.slice(0, 10)).toBe('2026-09-03');
    const events = await pg.query(
      "select kind from schedule_events where assignment_id = $1 and kind = 'moved'",
      [moved[0].id],
    );
    expect(events.rows).toHaveLength(1);
  });

  test('a promise-breaking move previews requiresConfirmation:true', async () => {
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'board-t2',
      customerId: (await pg.query("select id from customers where name = 'Board Casa'")).rows[0].id,
      title: 'Promised furnace check',
      date: '2026-09-05',
      startTime: '09:00',
      endTime: '10:00',
      promiseLevel: 'day',
      actorRef: 'board-mgr',
    });
    const preview = await post(
      '/board/api/move',
      { assignmentId: assignment.id, date: '2026-09-06', startTime: '09:00', endTime: '10:00', reason: 'r' },
      900000001,
      true,
    );
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { requiresConfirmation: boolean; promiseBroken: boolean };
    expect(p.requiresConfirmation).toBe(true);
    expect(p.promiseBroken).toBe(true);
    // Cancel two-mode on the same promised row: preview says confirm needed…
    const cp = await post('/board/api/cancel', { assignmentId: assignment.id }, 900000001, true);
    expect(((await cp.json()) as { requiresConfirmation: boolean }).requiresConfirmation).toBe(true);
    // …no reason → 400; with reason → cancelled + event.
    expect((await post('/board/api/cancel', { assignmentId: assignment.id }, 900000001)).status).toBe(400);
    const done = await post(
      '/board/api/cancel',
      { assignmentId: assignment.id, reason: 'customer away' },
      900000001,
    );
    expect(done.status).toBe(200);
    const [row] = await assignmentRows('a.id = $1', [assignment.id]);
    expect(row.status).toBe('cancelled');
    const ev = await pg.query(
      "select 1 from schedule_events where assignment_id = $1 and kind = 'cancelled'",
      [assignment.id],
    );
    expect(ev.rows).toHaveLength(1);
  });

  test('drag-to-assign: commit with technicianRef attaches the person to an unassigned visit', async () => {
    const [unassigned] = await assignmentRows(
      "a.technician_id is null and a.status = 'confirmed' and a.starts_at = '2026-09-01T13:00:00Z'",
    );
    const resp = await post(
      '/board/api/move',
      {
        assignmentId: unassigned.id,
        date: '2026-09-01',
        startTime: '13:00',
        endTime: '15:00',
        technicianRef: 'board-t1',
        reason: 'assigning from the board',
      },
      900000001,
    );
    expect(resp.status).toBe(200);
    const rows = await assignmentRows(
      "a.status = 'confirmed' and a.starts_at = '2026-09-01T13:00:00Z'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ref).toBe('board-t1'); // person attached
    const [old] = await assignmentRows('a.id = $1', [unassigned.id]);
    expect(old.status).toBe('cancelled');
  });

  test('assigning into a clashing window surfaces the overlap failure and writes nothing', async () => {
    // Fresh unassigned visit overlapping board-t2's confirmed 10:00–12:00.
    const { assignment } = await bookVisit({
      tenantId,
      customerId: (await pg.query("select id from customers where name = 'Board Casa'")).rows[0].id,
      title: 'Clash probe',
      date: '2026-09-01',
      startTime: '10:30',
      endTime: '11:30',
      actorRef: 'board-mgr',
    });
    const resp = await post(
      '/board/api/move',
      {
        assignmentId: assignment.id,
        date: '2026-09-01',
        startTime: '10:30',
        endTime: '11:30',
        technicianRef: 'board-t2',
        reason: 'assigning into a clash',
      },
      900000001,
    );
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBeTruthy();
    // Nothing changed: the visit is still confirmed AND still unassigned, and
    // board-t2 still has exactly one confirmed stop in the window.
    const [row] = await assignmentRows('a.id = $1', [assignment.id]);
    expect(row.status).toBe('confirmed');
    expect(row.technician_id).toBeNull();
    const t2 = await assignmentRows("t.ref = 'board-t2' and a.status = 'confirmed'");
    expect(t2).toHaveLength(1);
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
