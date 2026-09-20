import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createHmac, generateKeyPairSync, sign as signEd } from 'node:crypto';
import { Client } from 'pg';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createHttpServer } from '../mcp/httpServer.js';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, updateTechnician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { bookVisit } from '../schedule/booking.js';
import { updateVisitStatus } from '../db/visits.js';
import * as rosterCache from '../telegram/rosterCache.js';
import * as botIds from '../telegram/botIds.js';
import { setPublicKeyForTests } from '../telegram/initData.js';
import { nl } from '../db/time.js';

// Integration: the /console routes over a real HTTP server on an ephemeral
// port against the local stack (the boardApi.test.ts harness, reused because
// the console shares that surface's auth and its write verbs).
//
// WHAT THIS FILE IS ACTUALLY GUARDING is the coexistence contract, not the UI:
//   · the kill switch really hides the whole surface;
//   · the console's wider date range did not widen the BOARD's;
//   · a delegated write is the board's write, tier gate and all;
//   · the new mint path respects the duplicate-job guard instead of routing
//     around it.
const TOKEN = '7000000011:CONSOLE-api-suite-token';
const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let server: http.Server;
let base: string;
let tenantId: string;
let prevToken: string | undefined;
let prevEnabled: string | undefined;

// Distinct relative offsets, per the board suite's rule: a fixed date rots the
// day it crosses the technician visibility horizon, and two fixtures sharing an
// offset can collide weeks later.
const relDate = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const DAY_A = relDate(3); // the team day every read asserts on
const DAY_B = relDate(9); // the delegated-move target
const DAY_MINT = relDate(11); // the new-job path's own day
const DAY_UNTIME = relDate(13); // the untime verb's own day
const DAY_DOOMED = relDate(15); // the cancel-job verb's own day

function signSlip(userId: number, token = TOKEN): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAconsole',
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

// The console shares /board's auth, and that auth has accepted ONLY Telegram's
// Ed25519 signature since the HMAC fallback was removed (2026-09-17). So every
// slip here must be signed. `signSlip` above is kept as the negative case.
const { publicKey: TG_PUB, privateKey: TG_PRIV } = generateKeyPairSync('ed25519');
const TG_PUB_HEX = TG_PUB.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const CONSOLE_BOT_ID = '7000000011'; // botIdFromToken(TOKEN)

function signedSlip(userId: number, botId = CONSOLE_BOT_ID): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAconsole',
    user: JSON.stringify({ id: userId, first_name: 'Probe' }),
  });
  const data = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  params.set(
    'signature',
    signEd(null, Buffer.from(`${botId}:WebAppData\n${data}`, 'utf8'), TG_PRIV).toString(
      'base64url',
    ),
  );
  return params.toString();
}

const tma = (userId: number): Record<string, string> => ({
  Authorization: `tma ${signedSlip(userId)}`,
});

const MGR = 910000001;
const TECH = 910000002;

const calendar = (query: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/console/api/calendar${query}`, { headers });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

let customerId: string;

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
  setPublicKeyForTests(TG_PUB_HEX);
  botIds.clear();
  prevEnabled = process.env.CONSOLE_ENABLED;
  process.env.CONSOLE_ENABLED = '1';

  const mgr = await insertTechnician({
    tenantId,
    ref: 'con-mgr',
    displayName: 'Connie Manager',
    tier: 'manager',
  });
  await updateTechnician(mgr.id, { telegram_user_id: String(MGR), state: 'active' });
  const t1 = await insertTechnician({ tenantId, ref: 'con-t1', displayName: 'Tam One' });
  await updateTechnician(t1.id, { telegram_user_id: String(TECH), state: 'active' });
  const t2 = await insertTechnician({ tenantId, ref: 'con-t2', displayName: 'Toby Two' });
  await updateTechnician(t2.id, { state: 'active' });

  const casa = await createCustomer({
    tenantId,
    name: 'Console Casa',
    phone: '555-014-3000',
    addressLine1: '8 Console Way',
    city: 'Springfield',
    state: 'OR',
    postalCode: '97477',
  });
  customerId = casa.id;
  const bookArgs = { tenantId, customerId: casa.id, actorRef: 'con-mgr', date: DAY_A };
  await bookVisit({
    ...bookArgs,
    technicianRef: 'con-t1',
    title: 'AC tune-up',
    startTime: '09:00',
    endTime: '11:00',
  });
  await bookVisit({
    ...bookArgs,
    technicianRef: 'con-t2',
    title: 'Filter swap',
    startTime: '10:00',
    endTime: '12:00',
  });
  await bookVisit({ ...bookArgs, title: 'Duct inspection', startTime: '13:00', endTime: '15:00' });

  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  if (prevToken === undefined) delete process.env.BOARD_BOT_TOKEN;
  else process.env.BOARD_BOT_TOKEN = prevToken;
  setPublicKeyForTests(null);
  botIds.clear();
  if (prevEnabled === undefined) delete process.env.CONSOLE_ENABLED;
  else process.env.CONSOLE_ENABLED = prevEnabled;
  await pg.query(TRUNCATE);
  await pg.end();
});

beforeEach(() => {
  // The roster lookup is memoised for 60s on success; a fixture edit between
  // tests must not be read through a stale entry.
  rosterCache.clear();
});

describe('the kill switch', () => {
  test('with CONSOLE_ENABLED unset the whole surface 404s — page shell included', async () => {
    delete process.env.CONSOLE_ENABLED;
    try {
      expect((await fetch(`${base}/console`)).status).toBe(404);
      // Not 401: an unauthenticated probe must not learn the route exists
      // behind auth. This is the difference between "off" and "protected".
      expect((await calendar(`?from=${DAY_A}&to=${DAY_A}`, tma(MGR))).status).toBe(404);
    } finally {
      process.env.CONSOLE_ENABLED = '1';
    }
  });

  test('the BOARD is unaffected by the console flag', async () => {
    delete process.env.CONSOLE_ENABLED;
    try {
      const res = await fetch(`${base}/board/api/day?from=${DAY_A}&to=${DAY_A}`, {
        headers: tma(MGR),
      });
      expect(res.status).toBe(200);
    } finally {
      process.env.CONSOLE_ENABLED = '1';
    }
  });
});

describe('reads', () => {
  test('an unsigned request is refused', async () => {
    expect((await calendar(`?from=${DAY_A}&to=${DAY_A}`)).status).toBe(401);
  });

  // The HMAC fallback was dropped 2026-09-17 (#255), leaving Ed25519 the only
  // stamp. `signSlip` builds a slip the OLD scheme would have accepted, so this
  // is what proves the fallback is really gone: without it nothing fails when
  // HMAC quietly comes back, and the auth guard stops failing closed.
  test('an HMAC-signed slip — the removed fallback — is refused', async () => {
    const res = await calendar(`?from=${DAY_A}&to=${DAY_A}`, {
      Authorization: `tma ${signSlip(MGR)}`,
    });
    expect(res.status).toBe(401);
  });

  test('a manager gets the day, the roster and the tray in one payload', async () => {
    const res = await calendar(`?from=${DAY_A}&to=${DAY_A}`, tma(MGR));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe('manager');
    expect(body.self).toBe('con-mgr');
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.roster.map((t: { ref: string }) => t.ref).sort()).toEqual([
      'con-mgr',
      'con-t1',
      'con-t2',
    ]);
    expect(body.bucket).not.toBeNull();
    const stops = body.days[0].stops;
    expect(stops).toHaveLength(3);
    // The console's cards say what the work is — the widened BoardStop.
    expect(stops.map((s: { jobTitle: string }) => s.jobTitle).sort()).toEqual([
      'AC tune-up',
      'Duct inspection',
      'Filter swap',
    ]);
    expect(stops.every((s: { priority: string }) => s.priority === 'routine')).toBe(true);
  });

  test('a technician gets their own stops, no roster and no tray', async () => {
    const res = await calendar(`?from=${DAY_A}&to=${DAY_A}`, tma(TECH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe('technician');
    expect(body.roster).toEqual([]);
    expect(body.bucket).toBeNull();
    expect(body.days[0].stops).toHaveLength(1);
    expect(body.days[0].stops[0].technicianRef).toBe('con-t1');
  });

  test('a completed visit stays on the console grid; the board still drops it', async () => {
    // Booked confirmed, then walked to completed the way a field note or the
    // status tool would. A done trip claims no time, so 15:00 beside the
    // 13:00–15:00 unassigned booking is not an overlap question.
    const done = await bookVisit({
      tenantId,
      customerId,
      actorRef: 'con-mgr',
      date: DAY_A,
      technicianRef: 'con-t1',
      title: 'Blower belt',
      startTime: '15:00',
      endTime: '16:00',
    });
    await updateVisitStatus(done.assignment.id, 'completed', null, nl(`${DAY_A}T16:05:00`));

    const con = await (await calendar(`?from=${DAY_A}&to=${DAY_A}`, tma(MGR))).json();
    const stop = con.days[0].stops.find(
      (s: { visitId: string }) => s.visitId === done.assignment.id,
    );
    expect(stop).toBeDefined();
    expect(stop.status).toBe('completed');
    expect(stop.technicianRef).toBe('con-t1');

    // The visit sheet says when it was finished.
    const sheet = await fetch(`${base}/console/api/visit?visitId=${done.assignment.id}`, {
      headers: tma(MGR),
    });
    expect(sheet.status).toBe(200);
    // timestamptz on the wire carries '+00:00' — the naive-local convention's
    // known lie (PR #72); readers slice, they never parse.
    expect((await sheet.json()).completedAt).toMatch(new RegExp(`^${DAY_A}T16:05:00`));

    // The phone board's read is the default — confirmed only — and must not
    // have widened just because the console asked for more.
    const board = await (
      await fetch(`${base}/board/api/day?from=${DAY_A}&to=${DAY_A}`, { headers: tma(MGR) })
    ).json();
    expect(
      board.days[0].stops.some((s: { visitId: string }) => s.visitId === done.assignment.id),
    ).toBe(false);
  });

  test('the month grid fits: 42 days is served, 46 is refused', async () => {
    const ok = await calendar(`?from=${DAY_A}&to=${relDate(3 + 41)}`, tma(MGR));
    expect(ok.status).toBe(200);
    const tooWide = await calendar(`?from=${DAY_A}&to=${relDate(3 + 45)}`, tma(MGR));
    expect(tooWide.status).toBe(400);
    expect((await tooWide.json()).error).toContain('45 days');
  });

  test('the BOARD keeps its own two-week ceiling', async () => {
    // The widening is an argument, not a new constant: raising it for the
    // console must not raise it for the phone-sized surface (or for the
    // technician-tier reads that share this code path).
    const res = await fetch(`${base}/board/api/day?from=${DAY_A}&to=${relDate(3 + 20)}`, {
      headers: tma(MGR),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('14 days');
  });

  test('a garbled date is a 400, not a silent default', async () => {
    expect((await calendar('?from=last-tuesday', tma(MGR))).status).toBe(400);
  });
});

describe('customer lookup', () => {
  test('a manager can search; a technician cannot', async () => {
    const ok = await fetch(`${base}/console/api/customers?q=Console`, { headers: tma(MGR) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).customers[0].name).toBe('Console Casa');

    const denied = await fetch(`${base}/console/api/customers?q=Console`, { headers: tma(TECH) });
    expect(denied.status).toBe(403);
  });

  test('a one-character query returns nothing rather than the whole book', async () => {
    const res = await fetch(`${base}/console/api/customers?q=C`, { headers: tma(MGR) });
    expect((await res.json()).customers).toEqual([]);
  });
});

describe('the new-job path', () => {
  test('a technician cannot mint work', async () => {
    const res = await post('/console/api/newjob', { customerId, title: 'nope' }, tma(TECH));
    expect(res.status).toBe(403);
  });

  test('the past floor holds on the server, not just in the UI', async () => {
    const res = await post(
      '/console/api/newjob',
      {
        customerId,
        title: 'yesterday',
        // -2, not -1: relDate is UTC, the floor is firm-local, and in the
        // evening (US) UTC's yesterday is still today here — a clock-window
        // flake seen 2026-09-07 20:54 PDT.
        date: relDate(-2),
        startTime: '09:00',
        endTime: '10:00',
      },
      tma(MGR),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('never target the past');
  });

  test('a half-stated time is refused; all three or none', async () => {
    const res = await post(
      '/console/api/newjob',
      { customerId, date: DAY_MINT, startTime: '09:00' },
      tma(MGR),
    );
    expect(res.status).toBe(400);
  });

  test('a new customer is created and booked in one gesture', async () => {
    const res = await post(
      '/console/api/newjob',
      {
        newCustomer: { name: 'Fresh Face', phone: '555-014-3100', addressLine1: '2 New Rd' },
        title: 'first visit',
        priority: 'urgent',
        date: DAY_MINT,
        startTime: '08:00',
        endTime: '09:30',
        technicianRefs: ['con-t1'],
      },
      tma(MGR),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('booked');
    expect(body.jobId).toBeTruthy();
    // The booked span is recorded as the job's length — measured, not invented.
    const { data } = await getClient()
      .from('jobs')
      .select('title,priority,duration_minutes')
      .eq('id', body.jobId)
      .single();
    expect(data).toMatchObject({ title: 'first visit', priority: 'urgent', duration_minutes: 90 });
  });

  test('the duplicate-job guard is not routed around — and force is the only way past', async () => {
    // `customerId` already has open work from the fixtures. The guard fires on
    // the two shapes every recorded live failure had: a TITLELESS booking (the
    // terse "book them in" — which of the open jobs did they mean?) and a title
    // that names work already on file. A genuinely new title mints without
    // ceremony, which is why this test uses the titleless shape rather than a
    // made-up name.
    const body = { customerId, date: DAY_MINT, startTime: '13:00', endTime: '14:00' };
    const refused = await post('/console/api/newjob', body, tma(MGR));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/already has open work/i);

    const forced = await post(
      '/console/api/newjob',
      { ...body, forceNewJob: true },
      tma(MGR),
    );
    expect(forced.status).toBe(200);
  });

  test('a title that names work already on file is refused too', async () => {
    const res = await post(
      '/console/api/newjob',
      {
        customerId,
        title: 'AC tune-up', // a fixture job carries exactly this title
        date: DAY_MINT,
        startTime: '15:00',
        endTime: '16:00',
      },
      tma(MGR),
    );
    expect(res.status).toBe(409);
  });
});

describe('delegated writes', () => {
  test('a move through /console is the board move, tier gate included', async () => {
    const before = await (await calendar(`?from=${DAY_A}&to=${DAY_A}`, tma(MGR))).json();
    const visitId = before.days[0].stops.find(
      (s: { technicianRef: string }) => s.technicianRef === 'con-t1',
    ).visitId;

    const denied = await post(
      '/console/api/move',
      { visitId, date: DAY_B, startTime: '09:00', reason: 'test' },
      tma(TECH),
    );
    expect(denied.status).toBe(403);

    const moved = await post(
      '/console/api/move',
      { visitId, date: DAY_B, startTime: '09:00', reason: 'moved on the dispatch console' },
      tma(MGR),
    );
    expect(moved.status).toBe(200);
    expect((await moved.json()).start.slice(0, 10)).toBe(DAY_B);
  });

  test('an unmapped console verb is a 404, never a fall-through to some other board route', async () => {
    const res = await post('/console/api/promise', { visitId: 'x' }, tma(MGR));
    expect(res.status).toBe(404);
  });
});

describe('untime — the console-only verb behind undo', () => {
  test('a placed visit goes back to no time set, crew kept; the board never sees the verb', async () => {
    const booked = await bookVisit({
      tenantId,
      customerId,
      actorRef: 'con-mgr',
      date: DAY_UNTIME,
      technicianRef: 'con-t2',
      title: 'Loose panel',
      startTime: '09:00',
      endTime: '10:00',
    });
    const visitId = booked.assignment.id;

    // Tier gate.
    expect((await post('/console/api/untime', { visitId, reason: 'x' }, tma(TECH))).status).toBe(403);

    // Preview: the cancel rule — a placed visit is somebody's appointment.
    const pv = await post('/console/api/untime?preview=1', { visitId }, tma(MGR));
    expect(pv.status).toBe(200);
    expect(await pv.json()).toMatchObject({
      requiresConfirmation: true,
      day: DAY_UNTIME,
      technicianRefs: ['con-t2'],
    });

    // Commit needs a reason.
    expect((await post('/console/api/untime', { visitId }, tma(MGR))).status).toBe(400);
    const done = await post('/console/api/untime', { visitId, reason: 'undo' }, tma(MGR));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'untimed', visitId, technicianRefs: ['con-t2'] });

    // Off the day, into the tray, still confirmed, still crewed.
    const day = await (await calendar(`?from=${DAY_UNTIME}&to=${DAY_UNTIME}`, tma(MGR))).json();
    // `days` lists only days that have stops — an emptied day is simply absent.
    const stops = day.days.flatMap((d: { stops: { visitId: string }[] }) => d.stops);
    expect(stops.some((s: { visitId: string }) => s.visitId === visitId)).toBe(false);
    const row = day.bucket.parkedVisits.find((p: { visitId: string }) => p.visitId === visitId);
    expect(row).toMatchObject({ date: null, startTime: null, technicianRefs: ['con-t2'] });
    const sheet = await (
      await fetch(`${base}/console/api/visit?visitId=${visitId}`, { headers: tma(MGR) })
    ).json();
    expect(sheet.status).toBe('confirmed');
    expect(sheet.start).toBeNull();

    // A second undo cannot pretend to work.
    const again = await post('/console/api/untime', { visitId, reason: 'undo' }, tma(MGR));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already has no time set/);

    // The board's URL space did not grow.
    expect((await post('/board/api/untime', { visitId, reason: 'x' }, tma(MGR))).status).toBe(404);
  });
});

describe('cancel job — the tray\'s "Delete this job"', () => {
  test('cancels the job and its visits, always confirms, never on the board', async () => {
    const booked = await bookVisit({
      tenantId,
      customerId,
      actorRef: 'con-mgr',
      date: DAY_DOOMED,
      technicianRef: 'con-t2',
      title: 'Doomed by console',
      startTime: '11:00',
      endTime: '12:00',
    });
    const jobId = booked.job.id;

    expect((await post('/console/api/canceljob', { jobId, reason: 'x' }, tma(TECH))).status).toBe(403);

    const pv = await post('/console/api/canceljob?preview=1', { jobId }, tma(MGR));
    expect(pv.status).toBe(200);
    const preview = await pv.json();
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.jobTitle).toBe('Doomed by console');
    expect(preview.visits).toHaveLength(1);

    expect((await post('/console/api/canceljob', { jobId }, tma(MGR))).status).toBe(400);
    const done = await post('/console/api/canceljob', { jobId, reason: 'entered twice' }, tma(MGR));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'cancelled', jobId, cancelledVisits: 1 });

    // Gone from the day and from both halves of the tray.
    const day = await (await calendar(`?from=${DAY_DOOMED}&to=${DAY_DOOMED}`, tma(MGR))).json();
    const stops = day.days.flatMap((d: { stops: { visitId: string }[] }) => d.stops);
    expect(stops.some((s: { visitId: string }) => s.visitId === booked.assignment.id)).toBe(false);
    expect(day.bucket.unscheduledJobs.some((j: { jobId: string }) => j.jobId === jobId)).toBe(false);
    expect(day.bucket.parkedVisits.some((p: { visitId: string }) => p.visitId === booked.assignment.id)).toBe(false);

    // Terminal: a second cancel is refused, and says so.
    const again = await post('/console/api/canceljob', { jobId, reason: 'again' }, tma(MGR));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already is/);

    expect((await post('/board/api/canceljob', { jobId, reason: 'x' }, tma(MGR))).status).toBe(404);
  });
});

describe('static assets', () => {
  test('the shell is served unauthenticated', async () => {
    const res = await fetch(`${base}/console`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Dispatch console');
  });

  test('traversal and non-whitelisted types are refused', async () => {
    // ENCODED, because a literal ../ is collapsed by the client before the
    // request is sent — the server never sees it, so testing that form proves
    // nothing about the server. This is the shape an actual probe uses.
    expect((await fetch(`${base}/console/static/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/console/static/app.map`)).status).toBe(404);
  });
});
