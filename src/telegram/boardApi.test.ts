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
import { appendRawCapture } from '../db/rawCaptures.js';
import { bookVisit, cancelJob } from '../schedule/booking.js';
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
const DAY_PARK = relDate(13); // detach (unassign) fixture — its own day
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
    const beyondBody = (await beyond.json()) as DayResponse & {
      horizonNote?: string;
      horizonEnd?: string;
    };
    expect(beyondBody.days).toEqual([]);
    expect(beyondBody.horizonNote).toContain("isn't published yet");
    // Structured companion: the client branches on from > horizonEnd, never
    // by parsing the sentence.
    expect(beyondBody.horizonEnd && beyondBody.from > beyondBody.horizonEnd).toBe(true);

    // Straddling: trimmed `to` + note. Firm-local today can lag the
    // UTC-derived relDate by a day — pin bounds, not the exact trim date.
    const straddle = await day(`?from=${relDate(25)}&to=${relDate(31)}`, tma(900000002));
    expect(straddle.status).toBe(200);
    const straddleBody = (await straddle.json()) as DayResponse & {
      horizonNote?: string;
      horizonEnd?: string;
    };
    expect(straddleBody.horizonNote).toContain("isn't published yet");
    expect(straddleBody.to < relDate(31)).toBe(true);
    expect(straddleBody.to >= relDate(27)).toBe(true);
    // A trimmed window's `to` IS the horizon end — deterministic even with
    // the firm-local-vs-UTC one-day skew.
    expect(straddleBody.to).toBe(straddleBody.horizonEnd);

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
        `select a.id from visits a join jobs j on j.id = a.job_id
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

describe('the "no time yet" strip (plan 4b-2 Phase 3)', () => {
  let stripAssignmentId: string;
  let stripJobId: string;
  let d1: string;
  let d2: string;
  let d3: string;

  beforeAll(async () => {
    d1 = relDate(21);
    d2 = relDate(22);
    d3 = relDate(23);
    const casaId = (await pg.query("select id from customers where name = 'Board Casa'"))
      .rows[0].id as string;
    // An ASSIGNED UNTIMED visit, booked via the board endpoint itself with no
    // date and no times at all (rung 9a).
    const resp = await fetch(`${base}/board/api/book`, {
      method: 'POST',
      headers: { ...tma(900000001), 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: (
          await pg.query(
            `insert into jobs (tenant_id, customer_id, title, status)
             values ($1, $2, 'Strip ranged job', 'open') returning id`,
            [tenantId, casaId],
          )
        ).rows[0].id,
        technicianRef: 'board-t1',
      }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { assignmentId: string; jobId: string; untimed?: boolean };
    stripAssignmentId = body.assignmentId;
    stripJobId = body.jobId;
  });

  afterAll(async () => {
    await pg.query("update visits set status = 'cancelled' where id = $1", [stripAssignmentId]);
    await pg.query("update jobs set status = 'cancelled' where id = $1", [stripJobId]);
  });

  test('INVERTED (rung 9a): an untimed visit appears on NO day of the board', async () => {
    // It used to be smeared across every day of its stored range, labelled
    // with the full range. With no range there is no day it belongs to, and
    // drawing it on one would be the invention this rung removes. It lives in
    // the flat Unscheduled tray instead (asserted in the tray tests below).
    const resp = await fetch(`${base}/board/api/day?from=${d1}&to=${d3}`, {
      headers: tma(900000001),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      days: Array<{ date: string; stops: Array<{ assignmentId: string }>; unplaced?: unknown[] }>;
    };
    // The `unplaced` key is gone from the payload entirely.
    for (const day of body.days) {
      expect(day.unplaced).toBeUndefined();
      // And it is not on the time grid either — that half never changed.
      expect(day.stops.some((st) => st.assignmentId === stripAssignmentId)).toBe(false);
    }
    // A day whose ONLY work was this visit no longer appears at all.
    expect(body.days.map((d) => d.date)).not.toContain(d2);
  });

  test('…and it IS in the Unscheduled tray, even though a person is attached', async () => {
    // The other half of the sentence above, and the review finding that made
    // it necessary: the tray used to key on "nobody attached", so an ASSIGNED
    // untimed visit was on no day AND not in the tray — invisible on the whole
    // board, reachable only through chat. Worse, the board's own Assign button
    // put it there: tap it on a tray row and the row vanished.
    const resp = await fetch(`${base}/board/api/bucket`, { headers: tma(900000001) });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      parkedVisits: Array<{ assignmentId: string; date: string | null }>;
    };
    const mine = body.parkedVisits.find((v) => v.assignmentId === stripAssignmentId);
    expect(mine, 'an assigned untimed visit must still be reachable').toBeDefined();
    expect(mine?.date).toBeNull();
  });

  test('partial times are a 400; attachUnplaced re-attaches keeping it untimed', async () => {
    // Rung 9a: all three of date/startTime/endTime, or none. A lone startTime
    // is the accident the rule catches.
    const bad = await fetch(`${base}/board/api/book`, {
      method: 'POST',
      headers: { ...tma(900000001), 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: stripJobId, date: d1, startTime: '09:00' }),
    });
    expect(bad.status).toBe(400);

    const attach = await fetch(`${base}/board/api/move`, {
      method: 'POST',
      headers: { ...tma(900000001), 'content-type': 'application/json' },
      body: JSON.stringify({
        assignmentId: stripAssignmentId,
        attachUnplaced: true,
        technicianRef: 'board-t2',
        reason: 'strip attach test',
      }),
    });
    expect(attach.status).toBe(200);
    const body = (await attach.json()) as Record<string, unknown>;
    expect(body.status).toBe('moved');
    expect(body.untimed).toBe(true);
    // The row: new id, still untimed, new person; the old row cancelled.
    const { rows } = await pg.query(
      `select id, starts_at, technician_id from visits where id = $1`,
      [body.assignmentId],
    );
    expect(rows[0].starts_at).toBeNull();
    expect(rows[0].technician_id).not.toBeNull();
    stripAssignmentId = rows[0].id as string; // afterAll cancels the live row
  });

  test('attach refusals + detach parks it back (review findings)', async () => {
    // Times alongside an attach → 400, never silently ignored.
    const mixed = await fetch(`${base}/board/api/move`, {
      method: 'POST',
      headers: { ...tma(900000001), 'content-type': 'application/json' },
      body: JSON.stringify({
        assignmentId: stripAssignmentId,
        attachUnplaced: true,
        technicianRef: 'board-t1',
        date: relDate(21),
        startTime: '09:00',
        reason: 'mixed shapes',
      }),
    });
    expect(mixed.status).toBe(400);

    // Detach (unassign:true) parks it back — still untimed, nobody attached.
    const detach = await fetch(`${base}/board/api/move`, {
      method: 'POST',
      headers: { ...tma(900000001), 'content-type': 'application/json' },
      body: JSON.stringify({
        assignmentId: stripAssignmentId,
        attachUnplaced: true,
        unassign: true,
        reason: 'park it back',
      }),
    });
    expect(detach.status).toBe(200);
    const parked = (await detach.json()) as Record<string, unknown>;
    expect(parked.unassigned).toBe(true);
    const { rows } = await pg.query(
      'select id, starts_at, technician_id from visits where id = $1',
      [parked.assignmentId],
    );
    expect(rows[0].starts_at).toBeNull();
    expect(rows[0].technician_id).toBeNull();
    stripAssignmentId = rows[0].id as string;
  });

  test('the attach PREVIEW runs the commit guards: valid → green light, placed subject → 409 (final-review fix)', async () => {
    // Valid target: the detached strip row (untimed, unassigned) previews
    // clean and is NOT modified by the preview.
    const ok = await fetch(`${base}/board/api/move?preview=1`, {
      method: 'POST',
      headers: { ...tma(900000001), 'content-type': 'application/json' },
      body: JSON.stringify({
        assignmentId: stripAssignmentId,
        attachUnplaced: true,
        technicianRef: 'board-t1',
        reason: 'preview probe',
      }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as Record<string, unknown>;
    expect(okBody.status).toBe('preview');
    expect(okBody.attach).toBe(true);
    expect(okBody.requiresConfirmation).toBe(false);
    const after = await pg.query('select technician_id, status from visits where id = $1', [
      stripAssignmentId,
    ]);
    expect(after.rows[0].technician_id).toBeNull(); // preview wrote nothing
    expect(after.rows[0].status).toBe('confirmed');

    // A PLACED subject refuses at PREVIEW time, not after the picker walk
    // (the finding: the old preview green-lit unconditionally and the user
    // discovered the refusal only at commit).
    const casaId = (await pg.query("select id from customers where name = 'Board Casa'"))
      .rows[0].id as string;
    const placedJob = (
      await pg.query(
        `insert into jobs (tenant_id, customer_id, title, status)
         values ($1, $2, 'Placed preview job', 'open') returning id`,
        [tenantId, casaId],
      )
    ).rows[0].id as string;
    const placedRow = (
      await pg.query(
        `insert into visits (tenant_id, job_id, starts_at, ends_at, status)
         values ($1, $2, $3, $4, 'confirmed') returning id`,
        [tenantId, placedJob, `${relDate(25)}T09:00:00Z`, `${relDate(25)}T10:00:00Z`],
      )
    ).rows[0].id as string;
    try {
      const refused = await fetch(`${base}/board/api/move?preview=1`, {
        method: 'POST',
        headers: { ...tma(900000001), 'content-type': 'application/json' },
        body: JSON.stringify({
          assignmentId: placedRow,
          attachUnplaced: true,
          technicianRef: 'board-t1',
          reason: 'preview probe placed',
        }),
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain('has times');
    } finally {
      await pg.query("update visits set status = 'cancelled' where id = $1", [placedRow]);
      await pg.query("update jobs set status = 'cancelled' where id = $1", [placedJob]);
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
    // A parked visit whose day already PASSED — missed work must surface
    // flagged overdue, never vanish (final-review finding: it used to drop
    // out of the tray while its job stayed hidden by the live-row anti-join).
    await bookVisit({
      tenantId,
      customerId: casaId,
      title: 'Bucket overdue visit',
      date: relDate(-8),
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'board-mgr',
    });

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
        `insert into visits (tenant_id, job_id, technician_id, starts_at, ends_at, status)
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
    await pg.query('delete from visits where id = $1', [hostileVisitId]);
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

  test('an unassigned UNTIMED visit appears in the tray with every date field null', async () => {
    const casaId = (await pg.query("select id from customers where name = 'Board Casa'"))
      .rows[0].id as string;
    const booked = await bookVisit({
      tenantId,
      customerId: casaId,
      title: 'Bucket untimed visit',
      actorRef: 'board-mgr',
    });
    try {
      const resp = await bucket(tma(900000001));
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        parkedVisits: Array<Record<string, unknown>>;
      };
      // Without the widened .or() reader (.gte alone) this row is invisible —
      // the assertion below fails, which is exactly the regression pin.
      const mine = body.parkedVisits.find(
        (v) => v.assignmentId === booked.assignment.id,
      );
      expect(mine).toBeDefined();
      // Rung 9a: nothing records when it should happen, so every date field
      // reads null and NOTHING untimed can be overdue.
      expect(mine?.date).toBeNull();
      expect(mine?.weekday).toBeNull();
      expect(mine?.startTime).toBeNull();
      expect(mine?.endTime).toBeNull();
      expect(mine?.overdue).toBe(false);
    } finally {
      // Terminal flips, not deletes: a delete cascades toward append-only L1
      // territory; cancelled rows vanish from every bucket read regardless.
      await pg.query("update visits set status = 'cancelled' where id = $1", [
        booked.assignment.id,
      ]);
      await pg.query("update jobs set status = 'cancelled' where id = $1", [booked.job.id]);
    }
  });

  test('INVERTED (rung 9a): dated rows first, then UNTIMED rows OLDEST FIRST — and a reschedule does not reshuffle them', async () => {
    // The old rule sorted every tray row by its day, and an unplaced visit had
    // one (its range start). It has none now, so the user's choice governs:
    // dated rows keep their day order, untimed rows queue by AGE. Age is what
    // stops a hard-to-place visit sinking, and nothing stored can go stale
    // because nothing is stored.
    const casaId = (await pg.query("select id from customers where name = 'Board Casa'"))
      .rows[0].id as string;
    const older = await bookVisit({
      tenantId, customerId: casaId, title: 'Bucket untimed OLDER', actorRef: 'board-mgr',
    });
    const newer = await bookVisit({
      tenantId, customerId: casaId, title: 'Bucket untimed NEWER', actorRef: 'board-mgr',
    });
    const idxOf = (rows: Array<{ jobTitle: string | null }>, title: string) =>
      rows.findIndex((v) => v.jobTitle === title);
    try {
      const read = async () => {
        const resp = await bucket(tma(900000001));
        expect(resp.status).toBe(200);
        return ((await resp.json()) as {
          parkedVisits: Array<{ jobTitle: string | null; date: string | null }>;
        }).parkedVisits;
      };
      const rows = await read();
      // Dated rows all precede untimed ones, and the dated block is ascending.
      const dated = rows.filter((v) => v.date !== null).map((v) => v.date as string);
      expect(rows.slice(0, dated.length).every((v) => v.date !== null)).toBe(true);
      expect([...dated].sort()).toEqual(dated);
      // Among the untimed, oldest first.
      expect(idxOf(rows, 'Bucket untimed OLDER')).toBeGreaterThanOrEqual(0);
      expect(idxOf(rows, 'Bucket untimed OLDER')).toBeLessThan(idxOf(rows, 'Bucket untimed NEWER'));

      // THE AGE-CARRY PIN (reviewer finding): every attach/park is a
      // cancel-plus-insert, so without created_at carried onto the successor
      // row the OLDER visit would be reborn "now" and sink below the newer one
      // — "oldest first" would silently mean "least recently touched", and the
      // visit nobody can place would drift down every time someone tried.
      // The tray lists UNASSIGNED rows, so attach (it leaves) then detach (it
      // returns) — two cancel-plus-inserts, and it must come back in place.
      const attach = await fetch(`${base}/board/api/move`, {
        method: 'POST',
        headers: { ...tma(900000001), 'content-type': 'application/json' },
        body: JSON.stringify({
          assignmentId: older.assignment.id,
          attachUnplaced: true,
          technicianRef: 'board-t1',
          reason: 'touch the older row',
        }),
      });
      expect(attach.status).toBe(200);
      const attachedId = ((await attach.json()) as { assignmentId: string }).assignmentId;
      const detach = await fetch(`${base}/board/api/move`, {
        method: 'POST',
        headers: { ...tma(900000001), 'content-type': 'application/json' },
        body: JSON.stringify({
          assignmentId: attachedId,
          attachUnplaced: true,
          unassign: true,
          reason: 'park it back',
        }),
      });
      expect(detach.status).toBe(200);
      const after = await read();
      expect(idxOf(after, 'Bucket untimed OLDER')).toBeLessThan(
        idxOf(after, 'Bucket untimed NEWER'),
      );
    } finally {
      await pg.query(
        "update visits set status = 'cancelled' where job_id = any($1::uuid[])",
        [[older.job.id, newer.job.id]],
      );
      await pg.query("update jobs set status = 'cancelled' where id = any($1::uuid[])", [
        [older.job.id, newer.job.id],
      ]);
    }
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
    expect(parked?.overdue).toBe(false);
    // The past parked visit surfaces, flagged — it never silently vanishes.
    const overdue = body.parkedVisits.find((v) => v.jobTitle === 'Bucket overdue visit');
    expect(overdue).toMatchObject({ date: relDate(-8), overdue: true });
    const bare = body.unscheduledJobs.find((j) => j.title === 'Bucket bare job');
    expect(bare).toMatchObject({ customer: 'Board Casa', priority: 'urgent' });
    // Jobs WITH a live visit never appear in the jobs half.
    expect(body.unscheduledJobs.some((j) => j.title === 'Bucket parked visit')).toBe(false);
  });

  test('a cancelled job leaves BOTH tray halves (cancel-vocabulary plan)', async () => {
    const casaId = (await pg.query("select id from customers where name = 'Board Casa'"))
      .rows[0].id as string;
    // A job with a parked visit AND bucket presence, then cancel_job's core:
    // the tray must drop the job (status filter) and its visit (cascade) in
    // the same stroke — the freeze's input must never contain dead work.
    const doomed = await bookVisit({
      tenantId,
      customerId: casaId,
      title: 'Bucket doomed visit',
      date: relDate(12),
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'board-mgr',
    });
    const before = (await (await bucket(tma(900000001))).json()) as {
      parkedVisits: Array<{ jobTitle: string | null }>;
    };
    expect(before.parkedVisits.some((v) => v.jobTitle === 'Bucket doomed visit')).toBe(true);

    await cancelJob({
      tenantId,
      jobId: doomed.job.id,
      reason: 'customer called it off',
      actorRef: 'board-mgr',
    });
    const after = (await (await bucket(tma(900000001))).json()) as {
      parkedVisits: Array<{ jobTitle: string | null }>;
      unscheduledJobs: Array<{ jobId: string }>;
    };
    expect(after.parkedVisits.some((v) => v.jobTitle === 'Bucket doomed visit')).toBe(false);
    expect(after.unscheduledJobs.some((j) => j.jobId === doomed.job.id)).toBe(false);
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
      `insert into visits
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
      `insert into visits
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
      `insert into visits
         (tenant_id, job_id, technician_id, starts_at, ends_at, status)
       values ($1, $2, null, '${DAY_X3}T09:00:00Z', '${DAY_X3}T10:00:00Z', 'confirmed')
       returning id`,
      [tenantId, mismatchedJob.id],
    );
    strandedCustomerId = insertedCust.rows[0].id;
  });

  afterAll(async () => {
    await pg.query('delete from visits where id = any($1)', [
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
           from visits a left join technicians t on t.id = a.technician_id
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

  test('preview → requiresConfirmation false, NO write; commit → moved row + moved event', async () => {
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
    const p = (await preview.json()) as { requiresConfirmation: boolean; toDay: string };
    expect(p).toMatchObject({ requiresConfirmation: false, toDay: DAY_MOVE });
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

  test('unassign parks via the endpoint; unassign + technicianRef → 400 (plan 4a.5)', async () => {
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'board-t2',
      customerId: (await pg.query("select id from customers where name = 'Board Casa'")).rows[0].id,
      title: 'Park probe visit',
      date: DAY_PARK,
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'board-mgr',
    });
    // Both steering args → 400 before any verb runs.
    const both = await post(
      '/board/api/move',
      { assignmentId: assignment.id, date: DAY_PARK, startTime: '09:00', technicianRef: 'board-t1', unassign: true, reason: 'r' },
      900000001,
    );
    expect(both.status).toBe(400);
    expect(((await both.json()) as { error: string }).error).toContain('not both');
    // Non-boolean unassign → 400.
    const badFlag = await post(
      '/board/api/move',
      { assignmentId: assignment.id, date: DAY_PARK, startTime: '09:00', unassign: 'yes', reason: 'r' },
      900000001,
    );
    expect(badFlag.status).toBe(400);
    // Preview echoes the park; commit detaches — SQL read-back is the second
    // channel: new confirmed row with technician_id NULL, old row cancelled.
    const body = { assignmentId: assignment.id, date: DAY_PARK, startTime: '09:00', unassign: true, reason: 'tech pulled off' };
    const preview = await post('/board/api/move', body, 900000001, true);
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { unassign: boolean; requiresConfirmation: boolean };
    expect(p.unassign).toBe(true);
    expect(p.requiresConfirmation).toBe(false); // unpromised — one dialog never appears
    const commit = await post('/board/api/move', body, 900000001);
    expect(commit.status).toBe(200);
    const [old] = await assignmentRows('a.id = $1', [assignment.id]);
    expect(old.status).toBe('cancelled');
    const parkedRows = await assignmentRows(
      `a.status = 'confirmed' and a.technician_id is null and a.starts_at::date = '${DAY_PARK}'`,
    );
    expect(parkedRows).toHaveLength(1);
  });

  test('rung 9a: a date-changing move previews FALSE; cancelling that placed visit still confirms', async () => {
    const { assignment } = await bookVisit({
      tenantId,
      technicianRef: 'board-t2',
      customerId: (await pg.query("select id from customers where name = 'Board Casa'")).rows[0].id,
      title: 'Promised furnace check',
      date: DAY_PROM,
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'board-mgr',
    });
    const preview = await post(
      '/board/api/move',
      { assignmentId: assignment.id, date: DAY_PROM2, startTime: '09:00', endTime: '10:00', reason: 'r' },
      900000001,
      true,
    );
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { requiresConfirmation: boolean };
    expect(p.requiresConfirmation).toBe(false); // was true under the ladder
    // Cancel two-mode on the same PLACED row: preview says confirm needed…
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

describe('board quick-edit API (plan 4a.5): roster, book, job, detail additions', () => {
  const post = (path: string, body: unknown, userId: number, preview = false) =>
    fetch(`${base}${path}${preview ? '?preview=1' : ''}`, {
      method: 'POST',
      headers: { ...tma(userId), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const BOOK_DAY = relDate(15);
  const HOSTILE_DAY = relDate(16);
  const NOTES_DAY = relDate(17);
  let probeJobId: string;
  let notesVisitId: string;
  let hostileVisitId: string;
  let hostileTenantId: string;

  beforeAll(async () => {
    // Roster-filter fixtures: a seat-exempt name (bookable → must appear) and
    // an offboarded row (must never).
    await insertTechnician({
      tenantId,
      ref: 'board-exempt',
      displayName: 'Extra Elle',
      seatExempt: true,
    });
    const off = await insertTechnician({ tenantId, ref: 'board-off', displayName: 'Off Olly' });
    await updateTechnician(off.id, { state: 'offboarded' });

    // The tray-booking subject: an open job with NO visit.
    const casa = await createCustomer({ tenantId, name: 'Quick Edit Casa' });
    probeJobId = (
      await createJob({ tenantId, customerId: casa.id, title: 'Quick edit probe job' })
    ).id;

    // Customer-notes fixture: a retracted fact FIRST (fold must precede the
    // cap), then 9 plain facts (→ 8 after cap), one of them >80 chars.
    const orig = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      rawText: 'promised 10% off',
      technicianRef: 'board-mgr',
      customerId: casa.id,
    });
    await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      rawText: 'retract that',
      technicianRef: 'board-mgr',
      customerId: casa.id,
      retractsCaptureId: orig.id,
    });
    // jsonb key order is deterministic (length, then bytes) — 'aa' sorts
    // first, 'retracted_fact' last; the fold removes the latter, the cap then
    // trims fact_8. Assertions below pin exactly that.
    const attributes: Record<string, unknown> = {
      retracted_fact: {
        value: 'SHOULD VANISH',
        sourceCaptureId: orig.id,
        recordedAt: '2026-07-01T00:00:00.000Z',
      },
      aa: 'L'.repeat(100),
    };
    for (let i = 1; i <= 8; i++) attributes[`fact_${i}`] = `value ${i}`;
    const notesCustomer = await createCustomer({
      tenantId,
      name: 'Notes Casa',
      attributes: attributes as never,
    });
    notesVisitId = (
      await bookVisit({
        tenantId,
        customerId: notesCustomer.id,
        technicianRef: 'board-t1',
        title: 'Notes probe visit',
        date: NOTES_DAY,
        startTime: '09:00',
        endTime: '10:00',
        actorRef: 'board-mgr',
      })
    ).assignment.id;

    // Own hostile row (the cross-tenant describe's fixtures are torn down in
    // its afterAll): our assignment → their job, so jobId/jobPriority/notes
    // must all be withheld.
    const hostile = await createTenant('Board 4a5 Hostile Tenant', {
      managerSeats: 1,
      technicianSeats: 1,
    });
    hostileTenantId = hostile.id;
    const theirCustomer = await createCustomer({
      tenantId: hostileTenantId,
      name: 'SECRET 4a5 Customer',
      attributes: { secret_fact: 'MUST NOT LEAK' } as never,
    });
    const theirJob = await createJob({
      tenantId: hostileTenantId,
      customerId: theirCustomer.id,
      title: 'SECRET 4a5 Job',
    });
    hostileVisitId = (
      await pg.query<{ id: string }>(
        `insert into visits
           (tenant_id, job_id, technician_id, starts_at, ends_at, status)
         values ($1, $2, null, '${HOSTILE_DAY}T09:00:00Z', '${HOSTILE_DAY}T10:00:00Z', 'confirmed')
         returning id`,
        [tenantId, theirJob.id],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await pg.query('delete from visits where id = $1', [hostileVisitId]);
    await pg.query('delete from jobs where tenant_id = $1', [hostileTenantId]);
    await pg.query('delete from customers where tenant_id = $1', [hostileTenantId]);
    await pg.query('delete from tenants where id = $1', [hostileTenantId]);
  });

  test('tier gates: every quick-edit surface is managers-only', async () => {
    const roster = await fetch(`${base}/board/api/roster`, { headers: tma(900000002) });
    expect(roster.status).toBe(403);
    for (const path of ['/board/api/book', '/board/api/job']) {
      const resp = await post(path, {}, 900000002);
      expect(resp.status).toBe(403);
      expect(((await resp.json()) as { error: string }).error).toBe('managers only');
    }
  });

  test('roster: active + seat-exempt appear, offboarded never; {ref,name} shape', async () => {
    const resp = await fetch(`${base}/board/api/roster`, { headers: tma(900000001) });
    expect(resp.status).toBe(200);
    const { technicians } = (await resp.json()) as {
      technicians: Array<{ ref: string; name: string }>;
    };
    const refs = technicians.map((t) => t.ref);
    expect(refs).toContain('board-mgr');
    expect(refs).toContain('board-t1');
    expect(refs).toContain('board-exempt'); // seat-exempt = bookable name
    expect(refs).not.toContain('board-off'); // offboarded never
    expect(technicians.find((t) => t.ref === 'board-t1')).toEqual({
      ref: 'board-t1',
      name: 'Tess One',
    });
  });

  test('book: validation 400s; preview writes NOTHING; commit books; overlap → 409', async () => {
    expect(
      (await post('/board/api/book', { customerId: 'x', date: BOOK_DAY, startTime: '09:00', endTime: '10:00' }, 900000001)).status,
    ).toBe(400);
    expect((await post('/board/api/book', { date: BOOK_DAY, startTime: '09:00', endTime: '10:00' }, 900000001)).status).toBe(400);
    expect((await post('/board/api/book', { jobId: probeJobId, date: BOOK_DAY, startTime: '09:00' }, 900000001)).status).toBe(400);
    expect(
      (await post('/board/api/book', { jobId: probeJobId, date: BOOK_DAY, startTime: '09:00', endTime: '10:00', technicianRef: '' }, 900000001)).status,
    ).toBe(400);

    const body = { jobId: probeJobId, date: BOOK_DAY, startTime: '09:00', endTime: '10:00', technicianRef: 'board-t2' };
    const preview = await post('/board/api/book', body, 900000001, true);
    expect(preview.status).toBe(200);
    const p = (await preview.json()) as { requiresConfirmation: boolean; newJob: boolean; jobTitle: string };
    expect(p).toMatchObject({ requiresConfirmation: false, newJob: false, jobTitle: 'Quick edit probe job' });
    // Preview wrote NOTHING.
    const before = await pg.query(
      "select id from visits where job_id = $1 and status = 'confirmed'",
      [probeJobId],
    );
    expect(before.rows).toHaveLength(0);

    const commit = await post('/board/api/book', body, 900000001);
    expect(commit.status).toBe(200);
    const c = (await commit.json()) as { status: string; assignmentId: string };
    expect(c.status).toBe('booked');
    // SQL read-back: confirmed row for the job, held by board-t2.
    const row = await pg.query(
      `select a.status, t.ref from visits a join technicians t on t.id = a.technician_id
        where a.id = $1`,
      [c.assignmentId],
    );
    expect(row.rows[0]).toEqual({ status: 'confirmed', ref: 'board-t2' });
    // The shared verb's overlap refusal travels as a 409 with the message.
    const clash = await post('/board/api/book', body, 900000001);
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toContain('already has a confirmed visit');
  });

  test('final-review guards: one-shot verbs refuse ?preview=1; board writes refuse past dates; book refuses stray priority', async () => {
    // One-shot verbs 400 a preview request instead of silently committing.
    const jv = await fetch(`${base}/board/api/job?preview=1`, {
      method: 'POST',
      headers: { ...tma(900000001), 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: probeJobId, title: 'x' }),
    });
    expect(jv.status).toBe(400);
    expect(((await jv.json()) as { error: string }).error).toContain('has no preview');
    // The server floor under the client's past-date gates (board-only; chat
    // keeps its deliberate-correction path).
    const pastBook = await post(
      '/board/api/book',
      { jobId: probeJobId, date: relDate(-3), startTime: '09:00', endTime: '10:00' },
      900000001,
    );
    expect(pastBook.status).toBe(400);
    expect(((await pastBook.json()) as { error: string }).error).toContain('never target the past');
    const pastMove = await post(
      '/board/api/move',
      { assignmentId: notesVisitId, date: relDate(-3), startTime: '09:00', reason: 'r' },
      900000001,
    );
    expect(pastMove.status).toBe(400);
    expect(((await pastMove.json()) as { error: string }).error).toContain('never target the past');
    // Stray priority on book → 400 (MCP-layer parity: never report an
    // unstored urgency as stored).
    const stray = await post(
      '/board/api/book',
      { jobId: probeJobId, date: BOOK_DAY, startTime: '17:00', endTime: '18:00', priority: 'emergency' },
      900000001,
    );
    expect(stray.status).toBe(400);
    expect(((await stray.json()) as { error: string }).error).toContain('priority is not set at booking');
  });

  test('job: title+priority old→new + SQL read-back; jobType and empty patches → 400', async () => {
    const resp = await post(
      '/board/api/job',
      { jobId: probeJobId, title: 'Renamed probe job', priority: 'urgent' },
      900000001,
    );
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { changes: unknown }).changes).toEqual({
      title: { from: 'Quick edit probe job', to: 'Renamed probe job' },
      priority: { from: 'routine', to: 'urgent' },
    });
    const row = await pg.query('select title, priority from jobs where id = $1', [probeJobId]);
    expect(row.rows[0]).toEqual({ title: 'Renamed probe job', priority: 'urgent' });
    const ev = await pg.query(
      "select detail from schedule_events where kind = 'job_updated' and detail->>'jobId' = $1",
      [probeJobId],
    );
    expect(ev.rows).toHaveLength(1);
    expect((await post('/board/api/job', { jobId: probeJobId, jobType: 'repair' }, 900000001)).status).toBe(400);
    expect((await post('/board/api/job', { jobId: probeJobId, priority: 'asap' }, 900000001)).status).toBe(400);
    expect((await post('/board/api/job', { jobId: probeJobId }, 900000001)).status).toBe(400);
  });

  // 4a.6 (user device finding): a job with NO visit was already editable —
  // /board/api/job is keyed by jobId, never by an assignment — but the only
  // UI path ran through a VISIT's detail sheet, so managers had to schedule a
  // job before they could fix its description. The tray's Edit button closes
  // that gap; this pins the contract it stands on, including that an identity
  // edit never mints a visit.
  test('job edit needs no visit: an unscheduled tray job edits in place (4a.6)', async () => {
    const casa = await createCustomer({ tenantId, name: 'Tray Edit Casa' });
    const job = await createJob({ tenantId, customerId: casa.id, title: 'Wrong title' });
    const trayTitle = async () => {
      const resp = await fetch(`${base}/board/api/bucket`, { headers: tma(900000001) });
      const body = (await resp.json()) as {
        unscheduledJobs: Array<{ jobId: string; title: string | null }>;
      };
      return body.unscheduledJobs.find((j) => j.jobId === job.id)?.title;
    };
    expect(await trayTitle()).toBe('Wrong title');

    const resp = await post(
      '/board/api/job',
      { jobId: job.id, title: 'Right title', priority: 'urgent' },
      900000001,
    );
    expect(resp.status).toBe(200);
    const row = await pg.query('select title, priority from jobs where id = $1', [job.id]);
    expect(row.rows[0]).toEqual({ title: 'Right title', priority: 'urgent' });
    expect(await trayTitle()).toBe('Right title');
    const visits = await pg.query(
      'select count(*)::int as n from visits where job_id = $1',
      [job.id],
    );
    expect(visits.rows[0].n).toBe(0);
  });

  test('job length end-to-end (4b-1): ladder + free minutes + null-clear + tray/detail rides', async () => {
    const casa = await createCustomer({ tenantId, name: 'Length Casa' });
    const job = await createJob({ tenantId, customerId: casa.id, title: 'Fence repair' });

    // The tray reports "not set" as null, not by omission.
    const trayDuration = async () => {
      const resp = await fetch(`${base}/board/api/bucket`, { headers: tma(900000001) });
      const body = (await resp.json()) as {
        unscheduledJobs: Array<{ jobId: string; durationMinutes: number | null }>;
      };
      const row = body.unscheduledJobs.find((j) => j.jobId === job.id);
      expect(row).toBeDefined(); // the field must RIDE, not be absent
      return row!.durationMinutes;
    };
    expect(await trayDuration()).toBeNull();

    // A rung, echoed old → new.
    const rung = await post('/board/api/job', { jobId: job.id, durationMinutes: 120 }, 900000001);
    expect(rung.status).toBe(200);
    expect(((await rung.json()) as { changes: unknown }).changes).toEqual({
      durationMinutes: { from: null, to: 120 },
    });
    expect(await trayDuration()).toBe(120);

    // OFF-ladder 20 is legal (the ladder is offered, never enforced) — and a
    // duration-only POST is a real update, not "nothing to update".
    const off = await post('/board/api/job', { jobId: job.id, durationMinutes: 20 }, 900000001);
    expect(off.status).toBe(200);
    expect(await trayDuration()).toBe(20);

    // Bound violations 400 with the shared message; nothing written.
    for (const bad of [0, 6000, 45.5]) {
      const r = await post('/board/api/job', { jobId: job.id, durationMinutes: bad }, 900000001);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain('1 to 1440');
    }
    expect(await trayDuration()).toBe(20);

    // null CLEARS (presence guard, not truthiness — the review-pinned trap:
    // a falsy test would misread the clear as an empty patch and 400).
    const clear = await post('/board/api/job', { jobId: job.id, durationMinutes: null }, 900000001);
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { changes: unknown }).changes).toEqual({
      durationMinutes: { from: 20, to: null },
    });
    expect(await trayDuration()).toBeNull();

    // The visit detail rides jobDurationMinutes — null when unset, the value
    // once set (the sheet's Purpose row renders from exactly this field).
    const { assignment } = await bookVisit({
      tenantId,
      jobId: job.id,
      date: '2027-06-07',
      startTime: '09:00',
      endTime: '10:00',
      actorRef: 'board-mgr',
    });
    const detail = async () => {
      const resp = await fetch(`${base}/board/api/visit?assignmentId=${assignment.id}`, {
        headers: tma(900000001),
      });
      expect(resp.status).toBe(200);
      return ((await resp.json()) as { jobDurationMinutes: number | null }).jobDurationMinutes;
    };
    // The jobId-path booking left the cleared length alone (Phase 2 contract).
    expect(await detail()).toBeNull();
    await post('/board/api/job', { jobId: job.id, durationMinutes: 45 }, 900000001);
    expect(await detail()).toBe(45);
  });

  test('detail: jobId/jobPriority/customerNotes ride — folded, capped at 8, values truncated', async () => {
    const resp = await fetch(`${base}/board/api/visit?assignmentId=${notesVisitId}`, {
      headers: tma(900000001),
    });
    expect(resp.status).toBe(200);
    const d = (await resp.json()) as {
      jobId: string | null;
      jobPriority: string | null;
      customerNotes: Array<{ key: string; value: string }>;
    };
    expect(d.jobId).not.toBeNull();
    expect(d.jobPriority).toBe('routine');
    // Fold BEFORE cap: the retracted fact vanished, leaving exactly 9 live
    // facts → capped to 8 in jsonb's deterministic key order (fact_8 trimmed).
    expect(d.customerNotes.map((n) => n.key)).toEqual([
      'aa',
      'fact_1',
      'fact_2',
      'fact_3',
      'fact_4',
      'fact_5',
      'fact_6',
      'fact_7',
    ]);
    const long = d.customerNotes.find((n) => n.key === 'aa');
    expect(long).toBeDefined();
    expect(long!.value).toHaveLength(80);
    expect(long!.value.endsWith('…')).toBe(true);
    // BOTH tiers see notes (recorded decision): the visit's own technician
    // gets the same section.
    const techView = await fetch(`${base}/board/api/visit?assignmentId=${notesVisitId}`, {
      headers: tma(900000002),
    });
    expect(techView.status).toBe(200);
    expect(
      ((await techView.json()) as { customerNotes: unknown[] }).customerNotes,
    ).toHaveLength(8);
  });

  test('detail: a hostile cross-tenant job withholds jobId, priority, and notes', async () => {
    const resp = await fetch(`${base}/board/api/visit?assignmentId=${hostileVisitId}`, {
      headers: tma(900000001),
    });
    expect(resp.status).toBe(200);
    const raw = await resp.text();
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('MUST NOT LEAK');
    const d = JSON.parse(raw) as {
      jobId: string | null;
      jobPriority: string | null;
      customerNotes: unknown[];
    };
    expect(d.jobId).toBeNull();
    expect(d.jobPriority).toBeNull();
    expect(d.customerNotes).toEqual([]);
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
