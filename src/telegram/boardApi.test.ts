import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createHttpServer } from '../mcp/httpServer.js';
import { getClient } from '../db/client.js';
import { setTenantSeats, createTenant } from '../db/tenants.js';
import { insertTechnician, updateTechnician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { bookVisit } from '../schedule/booking.js';
import * as rosterCache from './rosterCache.js';

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

// Relative dates for technician-tier fixtures/reads: the visibility horizon
// (today + 28 default) clamps technician reads, so fixed dates rot the day
// they cross it. today+5 stays comfortably inside; today+40 is safely beyond.
const relDate = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const REL_T1_DATE = relDate(5);
// EVERY date fixture is a DISTINCT relative offset (review gap: a relative
// fixture drifting across a fixed date breaks bookings/counts deterministically
// weeks later — distinct offsets can never collide with each other).
const DAY_A = relDate(3); // the main team day (t1 / t2 / unassigned)
const DAY_B = relDate(4); // the manager's own visit (Mine tab subject)
const DAY_MOVE = relDate(6); // the move test's target day
const DAY_PROM = relDate(7); // promised-visit fixture
const DAY_PROM2 = relDate(8); // its preview move target
const DAY_X1 = relDate(20); // cross-tenant hostile rows: manager reads —
const DAY_X2 = relDate(21); // the horizon never clamps managers, so far
const DAY_X3 = relDate(22); // offsets are safe

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
    phone: '555-014-2000',
    email: 'casa@example.com',
    addressLine1: '12 Board St',
    city: 'Springfield',
    state: 'OR',
    postalCode: '97477',
  });
  const bookArgs = { tenantId, customerId: casa.id, actorRef: 'board-mgr', date: DAY_A };
  await bookVisit({ ...bookArgs, technicianRef: 'board-t1', title: 'AC tune-up', startTime: '09:00', endTime: '11:00' });
  await bookVisit({ ...bookArgs, technicianRef: 'board-t2', title: 'Filter swap', startTime: '10:00', endTime: '12:00' });
  await bookVisit({ ...bookArgs, title: 'Duct inspection', startTime: '13:00', endTime: '15:00' });
  // A visit the MANAGER holds personally (managers are bookable roster rows) —
  // on a different day so the exact-count team-view assertions above stay put.
  // This is the "My schedule" tab's subject.
  await bookVisit({
    ...bookArgs,
    date: DAY_B,
    technicianRef: 'board-mgr',
    title: 'Site walkthrough',
    startTime: '08:00',
    endTime: '09:00',
  });
  // A t1 visit at a RELATIVE near date: the technician-tier day-read tests
  // target this one — technician reads clamp at the visibility horizon
  // (Plan 4a), so their fixtures must never sit on fixed far-future dates.
  await bookVisit({
    ...bookArgs,
    date: REL_T1_DATE,
    technicianRef: 'board-t1',
    title: 'Near relative visit',
    startTime: '09:00',
    endTime: '11:00',
  });
  // Companions on the SAME relative day so the technician self-filter tests
  // stay discriminating (review gap: alone, "own stops only" would pass even
  // with the filter broken): someone else's visit + an unassigned one.
  await bookVisit({
    ...bookArgs,
    date: REL_T1_DATE,
    technicianRef: 'board-t2',
    title: 'Near rival visit',
    startTime: '12:00',
    endTime: '13:00',
  });
  await bookVisit({
    ...bookArgs,
    date: REL_T1_DATE,
    title: 'Near unassigned visit',
    startTime: '14:00',
    endTime: '15:00',
  });

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

// The roster cache is module-level, so it outlives an individual test: a
// success cached by one test would leak into the next. Concretely, without this
// the "account live on two firms → 409" test below would see the ALLOW cached
// for 900000001 by an earlier test and wrongly return 200. Clear per test.
beforeEach(() => {
  rosterCache.clear();
});

interface DayResponse {
  tier: string;
  self: string;
  view: string;
  from: string;
  to: string;
  days: Array<{
    date: string;
    // Mirrors BoardStop in full — the shape test below pins this key set, so a
    // dropped field in the embed projection fails loudly instead of silently.
    stops: Array<{
      assignmentId: string;
      technicianRef: string | null;
      technicianName: string | null;
      unassigned: boolean;
      customer: string | null;
      address: string | null;
      start: string;
      end: string;
      promiseLevel: string;
      promisedDay: string | null;
      locked: boolean;
      status: string;
      jobId: string | null;
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
    const bare = await day(`?from=${DAY_A}`);
    expect(bare.status).toBe(401);
    expect(await bare.text()).toBe('');
    expect((await day(`?from=${DAY_A}`, { Authorization: 'tma not-a-slip' })).status).toBe(401);
    // Valid slip for an id nobody on any roster holds → 401 too.
    expect((await day(`?from=${DAY_A}`, tma(900000777))).status).toBe(401);
  });

  test('manager slip → whole team incl. the unassigned stop (null name/ref, unassigned:true)', async () => {
    const resp = await day(`?from=${DAY_A}`, tma(900000001));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as DayResponse;
    expect(body.tier).toBe('manager');
    expect(body.self).toBe('board-mgr');
    expect(body.view).toBe('team');
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

  test('BoardStop shape is complete and stable (guards embed field drift)', async () => {
    // The day read is one PostgREST embed; a projection typo would silently
    // drop a field. Pin the whole key set AND every value for one known stop.
    const resp = await day(`?from=${DAY_A}`, tma(900000001));
    const body = (await resp.json()) as DayResponse;
    const stop = body.days[0].stops.find((s) => s.start.slice(11, 16) === '09:00');
    if (!stop) throw new Error('expected a 09:00 stop');
    expect(Object.keys(stop).sort()).toEqual(
      [
        'address',
        'assignmentId',
        'customer',
        'end',
        'jobId',
        'locked',
        'promiseLevel',
        'promisedDay',
        'start',
        'status',
        'technicianName',
        'technicianRef',
        'unassigned',
      ].sort(),
    );
    expect(stop).toMatchObject({
      technicianRef: 'board-t1',
      technicianName: 'Tess One',
      unassigned: false,
      customer: 'Board Casa',
      address: '12 Board St, Springfield, OR, 97477',
      promiseLevel: 'none',
      promisedDay: null,
      locked: true,
      status: 'confirmed',
    });
    expect(typeof stop.jobId).toBe('string');
    expect(stop.end.slice(0, 16)).toBe(`${DAY_A}T11:00`);
  });

  test('technician slip → own stops only; the unassigned stop is absent by construction', async () => {
    // Relative near date (Plan 4a): technician reads clamp at the horizon, so
    // this test targets the REL fixture day (which also holds a rival's visit
    // and an unassigned one — the count of 1 is a real discrimination).
    const resp = await day(`?from=${REL_T1_DATE}`, tma(900000002));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as DayResponse;
    expect(body.tier).toBe('technician');
    expect(body.self).toBe('board-t1');
    expect(body.view).toBe('mine');
    const stops = body.days.flatMap((d) => d.stops);
    expect(stops).toHaveLength(1);
    expect(stops[0].technicianRef).toBe('board-t1');
  });

  test("manager view=mine → only the manager's own visits; team default unchanged", async () => {
    const mine = await day(`?from=${DAY_A}&to=${DAY_B}&view=mine`, tma(900000001));
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as DayResponse;
    expect(mineBody.view).toBe('mine');
    const mineStops = mineBody.days.flatMap((d) => d.stops);
    expect(mineStops).toHaveLength(1);
    expect(mineStops[0]).toMatchObject({
      technicianRef: 'board-mgr',
      unassigned: false,
      customer: 'Board Casa',
    });
    expect(mineStops[0].start.slice(0, 16)).toBe(`${DAY_B}T08:00`);

    // Same window WITHOUT the param: the full team view — t1, t2, the
    // unassigned stop AND the manager's own visit, all present.
    const team = await day(`?from=${DAY_A}&to=${DAY_B}`, tma(900000001));
    expect(team.status).toBe(200);
    const teamBody = (await team.json()) as DayResponse;
    expect(teamBody.view).toBe('team');
    expect(teamBody.days.flatMap((d) => d.stops)).toHaveLength(4);
  });

  test('technician view param is inert: mine is a no-op, team/garbage never widen the read', async () => {
    for (const probe of ['view=mine', 'view=team', 'view=%00junk']) {
      // Single relative day holding t1's visit + a rival's + an unassigned
      // one: a widened read would see 3 stops, so 1 is a real discrimination.
      const resp = await day(`?from=${REL_T1_DATE}&to=${REL_T1_DATE}&${probe}`, tma(900000002));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as DayResponse;
      expect(body.view).toBe('mine');
      const stops = body.days.flatMap((d) => d.stops);
      expect(stops).toHaveLength(1);
      expect(stops[0].technicianRef).toBe('board-t1');
    }
  });

  test('technician visibility horizon: beyond → empty + note; straddling → trimmed; managers never clamp', async () => {
    // Fully beyond today+28 (default horizon): 200, no days, self-explaining.
    const beyond = await day(`?from=${relDate(40)}&to=${relDate(41)}`, tma(900000002));
    expect(beyond.status).toBe(200);
    const beyondBody = (await beyond.json()) as DayResponse & { horizonNote?: string };
    expect(beyondBody.days).toEqual([]);
    expect(beyondBody.horizonNote).toContain("isn't published yet");

    // Straddling: trimmed `to` + note. Firm-local today can lag the
    // UTC-derived relDate by a day — pin bounds, not the exact trim date.
    const straddle = await day(`?from=${relDate(25)}&to=${relDate(31)}`, tma(900000002));
    expect(straddle.status).toBe(200);
    const straddleBody = (await straddle.json()) as DayResponse & { horizonNote?: string };
    expect(straddleBody.horizonNote).toContain("isn't published yet");
    expect(straddleBody.to < relDate(31)).toBe(true);
    expect(straddleBody.to >= relDate(27)).toBe(true);

    // Managers never clamp — team view AND the Mine tab (the clamp keys on
    // TIER, never the self-filter; a mine-view regression would silently
    // blind the manager's own far weeks).
    for (const probe of ['', '&view=mine']) {
      const mgr = await day(`?from=${relDate(40)}&to=${relDate(41)}${probe}`, tma(900000001));
      expect(mgr.status).toBe(200);
      const mgrBody = (await mgr.json()) as DayResponse & { horizonNote?: string };
      expect(mgrBody.horizonNote).toBeUndefined();
      expect(mgrBody.to).toBe(relDate(41));
    }
  });

  test('same validation contract as get_team_schedule: bad date / inverted / >14 days → 400', async () => {
    expect((await day('?from=september', tma(900000001))).status).toBe(400);
    expect((await day(`?from=${DAY_B}&to=${DAY_A}`, tma(900000001))).status).toBe(400);
    const capped = await day(`?from=${DAY_A}&to=${relDate(33)}`, tma(900000001));
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
    const resp = await day(`?from=${DAY_A}`, tma(900000001));
    expect(resp.status).toBe(409);
    expect(((await resp.json()) as { error: string }).error).toBe('account on multiple firms');
    // Restore: offboard the twin so later tests see one firm again.
    await updateTechnician(dupe.id, { state: 'offboarded' });
  });
});

describe('GET /board/api/visit (tap-into-a-visit detail)', () => {
  const visit = (query: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/board/api/visit${query}`, { headers });
  const idByTitle = async (title: string): Promise<string> =>
    (
      await pg.query<{ id: string }>(
        `select a.id from assignments a join jobs j on j.id = a.job_id
         where j.title = $1 and a.status = 'confirmed'`,
        [title],
      )
    ).rows[0].id;

  test('auth + arg contract: no slip → 401; missing assignmentId → 400; non-UUID → 404', async () => {
    expect((await visit('?assignmentId=x')).status).toBe(401);
    const missing = await visit('', tma(900000001));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain('assignmentId');
    // Non-UUID garbage reads exactly like an unknown id — 404, never a 500
    // (PostgREST's invalid-uuid error must not become a loggable server fault
    // any roster member can trigger at will).
    const junk = await visit('?assignmentId=not-a-uuid', tma(900000001));
    expect(junk.status).toBe(404);
    expect(((await junk.json()) as { error: string }).error).toBe('visit not found');
  });

  test('manager: full contact + logistics for any visit, unassigned included', async () => {
    const resp = await visit(`?assignmentId=${await idByTitle('AC tune-up')}`, tma(900000001));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      status: 'confirmed',
      unassigned: false,
      technicianRef: 'board-t1',
      technicianName: 'Tess One',
      jobTitle: 'AC tune-up',
      promiseLevel: 'none',
      promisedDay: null,
      locked: true,
      customer: {
        name: 'Board Casa',
        phone: '555-014-2000',
        email: 'casa@example.com',
        address: '12 Board St, Springfield, OR, 97477',
      },
    });

    const bare = await visit(`?assignmentId=${await idByTitle('Duct inspection')}`, tma(900000001));
    expect(bare.status).toBe(200);
    expect(await bare.json()).toMatchObject({
      unassigned: true,
      technicianRef: null,
      technicianName: null,
      jobTitle: 'Duct inspection',
    });
  });

  test("technician: own visit resolves; anyone else's (and unassigned, and garbage) reads as 404", async () => {
    const own = await visit(`?assignmentId=${await idByTitle('AC tune-up')}`, tma(900000002));
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ technicianRef: 'board-t1', jobTitle: 'AC tune-up' });

    // Not-found semantics for everything out of scope — indistinguishable from
    // a nonexistent id, so the endpoint leaks nothing the self-filtered day
    // view wouldn't show.
    for (const q of [
      `?assignmentId=${await idByTitle('Filter swap')}`, // someone else's
      `?assignmentId=${await idByTitle('Duct inspection')}`, // unassigned
      '?assignmentId=00000000-0000-0000-0000-000000000000', // nonexistent
    ]) {
      const resp = await visit(q, tma(900000002));
      expect(resp.status).toBe(404);
      expect(((await resp.json()) as { error: string }).error).toBe('visit not found');
    }
  });
});

describe('GET /board/api/bucket (the loose-bucket tray, Plan 4a)', () => {
  // Relative dates only (top-level relDate): the bucket anchors at firm-local
  // today, so fixed fixtures rot (and the suite's DAY_A unassigned visit is
  // consumed by the drag-to-assign test below — order-coupled; never build on
  // it).
  const bucket = (headers: Record<string, string> = {}) =>
    fetch(`${base}/board/api/bucket`, { headers });

  let parkedDate: string;
  let probeTenantId: string;
  let hostileVisitId: string;
  let mismatchedJobId2: string;

  beforeAll(async () => {
    parkedDate = relDate(9);
    const casaId = (await pg.query("select id from customers where name = 'Board Casa'"))
      .rows[0].id as string;
    // A real parked visit (unassigned, future) via the real verb.
    await bookVisit({
      tenantId,
      customerId: casaId,
      title: 'Bucket parked visit',
      date: parkedDate,
      startTime: '09:00',
      endTime: '11:00',
      actorRef: 'board-mgr',
    });
    // An unscheduled open job — no visit at all.
    await createJob({ tenantId, customerId: casaId, title: 'Bucket bare job', priority: 'urgent' });

    // Hostile shapes for the withholding assertions (the cross-tenant suite's
    // fixtures are its own — this suite cleans up after itself).
    const probe = await createTenant('Bucket Probe Tenant', {
      managerSeats: 1,
      technicianSeats: 1,
    });
    probeTenantId = probe.id;
    const theirCustomer = await createCustomer({
      tenantId: probeTenantId,
      name: 'SECRET Bucket Customer',
    });
    const theirJob = await createJob({
      tenantId: probeTenantId,
      customerId: theirCustomer.id,
      title: 'SECRET Bucket Job',
    });
    // Our tenant's parked visit pointing at THEIR job (raw SQL — the verbs
    // would never mint it).
    hostileVisitId = (
      await pg.query<{ id: string }>(
        `insert into assignments (tenant_id, job_id, technician_id, starts_at, ends_at, status)
         values ($1, $2, null, $3, $4, 'confirmed') returning id`,
        [tenantId, theirJob.id, `${relDate(11)}T09:00:00Z`, `${relDate(11)}T10:00:00Z`],
      )
    ).rows[0].id;
    // Our open job whose customer is THEIRS (createJob validates no
    // relationship — no raw SQL needed).
    mismatchedJobId2 = (
      await createJob({ tenantId, customerId: theirCustomer.id, title: 'Bucket foreign customer' })
    ).id;
  });

  afterAll(async () => {
    await pg.query('delete from assignments where id = $1', [hostileVisitId]);
    await pg.query('delete from jobs where id = $1', [mismatchedJobId2]);
    await pg.query('delete from jobs where tenant_id = $1', [probeTenantId]);
    await pg.query('delete from customers where tenant_id = $1', [probeTenantId]);
    await pg.query('delete from tenants where id = $1', [probeTenantId]);
  });

  test('no slip → 401; technician slip → 403 managers only', async () => {
    expect((await bucket()).status).toBe(401);
    const tech = await bucket(tma(900000002));
    expect(tech.status).toBe(403);
    expect(((await tech.json()) as { error: string }).error).toBe('managers only');
  });

  test('manager: both sections, HH:MM/weekday shapes, names embedded', async () => {
    const resp = await bucket(tma(900000001));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      parkedVisits: Array<Record<string, unknown>>;
      unscheduledJobs: Array<Record<string, unknown>>;
    };
    const parked = body.parkedVisits.find((v) => v.jobTitle === 'Bucket parked visit');
    expect(parked).toMatchObject({
      date: parkedDate,
      startTime: '09:00',
      endTime: '11:00',
      customer: 'Board Casa',
    });
    expect(parked?.weekday).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    expect(typeof parked?.assignmentId).toBe('string');
    const bare = body.unscheduledJobs.find((j) => j.title === 'Bucket bare job');
    expect(bare).toMatchObject({ customer: 'Board Casa', priority: 'urgent' });
    // Jobs WITH a live visit never appear in the jobs half.
    expect(body.unscheduledJobs.some((j) => j.title === 'Bucket parked visit')).toBe(false);
  });

  test('cross-tenant names are withheld, rows kept', async () => {
    const resp = await bucket(tma(900000001));
    const raw = await resp.text();
    expect(raw).not.toContain('SECRET');
    const body = JSON.parse(raw) as {
      parkedVisits: Array<Record<string, unknown>>;
      unscheduledJobs: Array<Record<string, unknown>>;
    };
    const hostile = body.parkedVisits.find((v) => v.assignmentId === hostileVisitId);
    expect(hostile).toMatchObject({ customer: null, jobTitle: null });
    const mismatched = body.unscheduledJobs.find((j) => j.jobId === mismatchedJobId2);
    expect(mismatched).toMatchObject({ title: 'Bucket foreign customer', customer: null });
  });
});

describe('cross-tenant nested rows never leak through the embedded read', () => {
  // Both board reads now fetch assignment + job + customer + technician in ONE
  // PostgREST embed. The foreign keys are ID-ONLY — not one of them carries
  // tenant_id — so an assignment CAN reference another firm's job, and the
  // embed will happily hand that row back. boardRead re-checks every nested
  // row's tenant before surfacing it; these tests are what prove that guard is
  // still there. Delete them and a future embed refactor leaks silently.
  let strandedId: string;
  let strandedTechId: string;
  let strandedCustomerId: string;
  let otherTenantId: string;
  let ourJobId: string;
  let ourCustomerId: string;
  let mismatchedJobId: string;

  beforeAll(async () => {
    const other = await createTenant('Board Cross-Tenant Probe', {
      managerSeats: 1,
      technicianSeats: 1,
    });
    otherTenantId = other.id;
    const theirCustomer = await createCustomer({
      tenantId: otherTenantId,
      name: 'SECRET Rival Customer',
      phone: '555-999-0000',
      email: 'secret@rival.example',
      addressLine1: '99 Secret Ave',
      city: 'Nowhere',
      state: 'OR',
      postalCode: '97000',
    });
    const theirJob = await createJob({
      tenantId: otherTenantId,
      customerId: theirCustomer.id,
      title: 'SECRET Rival Job',
    });
    // The hostile row: lives in OUR tenant, points at THEIR job. Raw SQL because
    // the real booking verbs are tenant-scoped and would never create it.
    // Unassigned + its own day so no_confirmed_overlap cannot fire.
    const inserted = await pg.query<{ id: string }>(
      `insert into assignments
         (tenant_id, job_id, technician_id, starts_at, ends_at, status)
       values ($1, $2, null, '${DAY_X1}T09:00:00Z', '${DAY_X1}T10:00:00Z', 'confirmed')
       returning id`,
      [tenantId, theirJob.id],
    );
    strandedId = inserted.rows[0].id;

    // Second hostile shape, isolating the TECHNICIAN guard: our own job and
    // customer (so those resolve normally) but technician_id pointing at the
    // other firm's roster row. Without the technician tenant check this
    // discloses their ref + display name.
    const ourCustomer = await createCustomer({
      tenantId,
      name: 'Tenant-Safe Casa',
      addressLine1: '1 Safe St',
      city: 'Springfield',
      state: 'OR',
      postalCode: '97477',
    });
    ourCustomerId = ourCustomer.id;
    const ourJob = await createJob({
      tenantId,
      customerId: ourCustomer.id,
      title: 'Tenant-Safe Job',
    });
    ourJobId = ourJob.id;
    const theirTech = await insertTechnician({
      tenantId: otherTenantId,
      ref: 'rival-tech',
      displayName: 'SECRET Rival Tech',
    });
    const insertedTech = await pg.query<{ id: string }>(
      `insert into assignments
         (tenant_id, job_id, technician_id, starts_at, ends_at, status)
       values ($1, $2, $3, '${DAY_X2}T09:00:00Z', '${DAY_X2}T10:00:00Z', 'confirmed')
       returning id`,
      [tenantId, ourJob.id, theirTech.id],
    );
    strandedTechId = insertedTech.rows[0].id;

    // Third hostile shape, isolating the CUSTOMER guard: a job in OUR tenant
    // whose customer_id points at THEIR customer. createJob takes tenantId and
    // customerId as independent arguments and validates no relationship between
    // them, so this needs no raw SQL — which is exactly why the day view cannot
    // simply inherit the customer's tenant from its job.
    const mismatchedJob = await createJob({
      tenantId,
      customerId: theirCustomer.id,
      title: 'Our Job Foreign Customer',
    });
    mismatchedJobId = mismatchedJob.id;
    const insertedCust = await pg.query<{ id: string }>(
      `insert into assignments
         (tenant_id, job_id, technician_id, starts_at, ends_at, status)
       values ($1, $2, null, '${DAY_X3}T09:00:00Z', '${DAY_X3}T10:00:00Z', 'confirmed')
       returning id`,
      [tenantId, mismatchedJob.id],
    );
    strandedCustomerId = insertedCust.rows[0].id;
  });

  afterAll(async () => {
    await pg.query('delete from assignments where id = any($1)', [
      [strandedId, strandedTechId, strandedCustomerId],
    ]);
    await pg.query('delete from jobs where id = any($1)', [[ourJobId, mismatchedJobId]]);
    await pg.query('delete from customers where id = $1', [ourCustomerId]);
    await pg.query('delete from technicians where tenant_id = $1', [otherTenantId]);
    await pg.query('delete from jobs where tenant_id = $1', [otherTenantId]);
    await pg.query('delete from customers where tenant_id = $1', [otherTenantId]);
    await pg.query('delete from tenants where id = $1', [otherTenantId]);
  });

  test("a foreign-tenant technician's ref and name are withheld in both reads", async () => {
    const detail = await fetch(`${base}/board/api/visit?assignmentId=${strandedTechId}`, {
      headers: tma(900000001),
    });
    expect(detail.status).toBe(200);
    const detailRaw = await detail.text();
    expect(detailRaw).not.toContain('SECRET');
    expect(detailRaw).not.toContain('rival-tech');
    expect(JSON.parse(detailRaw)).toMatchObject({
      // Our own job/customer still resolve — only the technician is foreign.
      jobTitle: 'Tenant-Safe Job',
      technicianRef: null,
      technicianName: null,
      // technician_id is SET (just to another firm), so this is not "unassigned".
      unassigned: false,
    });

    const grid = await day(`?from=${DAY_X2}`, tma(900000001));
    expect(grid.status).toBe(200);
    const gridRaw = await grid.text();
    expect(gridRaw).not.toContain('SECRET');
    expect(gridRaw).not.toContain('rival-tech');
    const stops = (JSON.parse(gridRaw) as DayResponse).days.flatMap((d) => d.stops);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      customer: 'Tenant-Safe Casa',
      technicianRef: null,
      technicianName: null,
      unassigned: false,
    });
  });

  test("our own job pointing at another firm's customer withholds that customer", async () => {
    // The job passes the tenant check (it IS ours) — only a check on the
    // CUSTOMER's own tenant can catch this one.
    const grid = await day(`?from=${DAY_X3}`, tma(900000001));
    expect(grid.status).toBe(200);
    const raw = await grid.text();
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('99 Secret Ave');
    const stops = (JSON.parse(raw) as DayResponse).days.flatMap((d) => d.stops);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ customer: null, address: null });
    // The job is ours, so its id is NOT withheld — only the foreign customer is.
    expect(stops[0].jobId).toBe(mismatchedJobId);
  });

  test('visit detail withholds the other firm\'s job title and customer', async () => {
    const resp = await fetch(`${base}/board/api/visit?assignmentId=${strandedId}`, {
      headers: tma(900000001),
    });
    expect(resp.status).toBe(200);
    const raw = await resp.text();
    // Nothing from the other tenant may appear ANYWHERE in the payload.
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('secret@rival.example');
    expect(raw).not.toContain('99 Secret Ave');
    expect(JSON.parse(raw)).toMatchObject({
      status: 'confirmed',
      unassigned: true,
      jobTitle: null,
      customer: null,
    });
  });

  test('day view shows the stop but withholds the other firm\'s customer', async () => {
    const resp = await day(`?from=${DAY_X1}`, tma(900000001));
    expect(resp.status).toBe(200);
    const raw = await resp.text();
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('99 Secret Ave');
    const body = JSON.parse(raw) as DayResponse;
    const stops = body.days.flatMap((d) => d.stops);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      unassigned: true,
      technicianRef: null,
      customer: null,
      address: null,
      // The foreign job's UUID is withheld too — nulling the customer while
      // still emitting the other firm's job id would leak an identifier.
      jobId: null,
    });
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
      { assignmentId: 'x', date: DAY_MOVE, startTime: '09:00', technicianRef: '', reason: 'r' },
      900000001,
    );
    expect(emptyRef.status).toBe(400);
    expect(((await emptyRef.json()) as { error: string }).error).toContain('technicianRef was empty');
  });

  test('oversized body → 413 BEFORE auth (pre-auth cap on the public board path)', async () => {
    const big = '{"pad":"' + 'x'.repeat(70 * 1024) + '"}';
    const resp = await fetch(`${base}/board/api/move`, { method: 'POST', body: big });
    expect(resp.status).toBe(413);
  });

  test('preview → requiresConfirmation false (unpromised), NO write; commit → moved row + moved event', async () => {
    const [t1Row] = await assignmentRows(
      `t.ref = 'board-t1' and a.status = 'confirmed' and a.starts_at::date = '${DAY_A}'`,
    );
    const body = {
      assignmentId: t1Row.id,
      date: DAY_MOVE,
      startTime: '09:00',
      endTime: '11:00',
      reason: 'shuffle for parts pickup',
    };
    const preview = await post('/board/api/move', body, 900000001, true);
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { requiresConfirmation: boolean; promiseBroken: boolean; toDay: string };
    expect(p).toMatchObject({ requiresConfirmation: false, promiseBroken: false, toDay: DAY_MOVE });
    // Preview wrote NOTHING: the row is untouched, still on DAY_A.
    const [after] = await assignmentRows('a.id = $1', [t1Row.id]);
    expect(after.status).toBe('confirmed');
    expect(after.starts_at.slice(0, 10)).toBe(DAY_A);

    const commit = await post('/board/api/move', body, 900000001);
    expect(commit.status).toBe(200);
    expect(((await commit.json()) as { status: string }).status).toBe('moved');
    // Cross-channel read-back: old row cancelled, new confirmed row on the new
    // day, and a 'moved' schedule_events row hangs off the NEW assignment.
    const [old] = await assignmentRows('a.id = $1', [t1Row.id]);
    expect(old.status).toBe('cancelled');
    // Pinned to the TARGET day: t1 also holds the suite's relative-date
    // fixture, so a ref-wide count would drift with the calendar.
    const moved = await assignmentRows(
      `t.ref = 'board-t1' and a.status = 'confirmed' and a.starts_at::date = '${DAY_MOVE}'`,
    );
    expect(moved).toHaveLength(1);
    expect(moved[0].starts_at.slice(0, 10)).toBe(DAY_MOVE);
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
      date: DAY_PROM,
      startTime: '09:00',
      endTime: '10:00',
      promiseLevel: 'day',
      actorRef: 'board-mgr',
    });
    const preview = await post(
      '/board/api/move',
      { assignmentId: assignment.id, date: DAY_PROM2, startTime: '09:00', endTime: '10:00', reason: 'r' },
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
      `a.technician_id is null and a.status = 'confirmed' and a.starts_at = '${DAY_A}T13:00:00Z'`,
    );
    const resp = await post(
      '/board/api/move',
      {
        assignmentId: unassigned.id,
        date: DAY_A,
        startTime: '13:00',
        endTime: '15:00',
        technicianRef: 'board-t1',
        reason: 'assigning from the board',
      },
      900000001,
    );
    expect(resp.status).toBe(200);
    const rows = await assignmentRows(
      `a.status = 'confirmed' and a.starts_at = '${DAY_A}T13:00:00Z'`,
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
      date: DAY_A,
      startTime: '10:30',
      endTime: '11:30',
      actorRef: 'board-mgr',
    });
    const resp = await post(
      '/board/api/move',
      {
        assignmentId: assignment.id,
        date: DAY_A,
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
    // Pinned to DAY_A: t2 also holds the REL companion fixture.
    const t2 = await assignmentRows(
      `t.ref = 'board-t2' and a.status = 'confirmed' and a.starts_at::date = '${DAY_A}'`,
    );
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
