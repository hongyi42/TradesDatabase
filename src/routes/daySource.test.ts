import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, type Technician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { createVisit, updateVisitStatus } from '../db/visits.js';
import { listDayStops } from './daySource.js';
import { nl, type NaiveLocal } from '../db/time.js';

// Integration against the LOCAL stack, self-cleaning (pattern:
// scheduling.test.ts — truncate both ways, restore seed seats; `cascade`
// sweeps assignments FK'd rows). Single source since the mirror retired:
// listDayStops reads confirmed assignments only.
const TRUNCATE = 'truncate table customers, jobs, technicians, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tech: Technician;

const REF = 'route-tech';
// Fixed absolute dates — deterministic regardless of when the suite runs.
const D1 = '2026-08-10'; // Monday
const D2 = '2026-08-11';
const D3 = '2026-08-12';

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
  tech = await insertTechnician({ tenantId, ref: REF, displayName: 'Route Tech' });

  // Fixtures: two confirmed stops on D1 (inserted out of order), a cancelled
  // one on D2 (excluded), one on D3 whose customer has no address_line1
  // (unroutable stop), and an overnight booking straddling into D1.
  const cust = await createCustomer({
    tenantId,
    name: 'Asg Customer',
    addressLine1: '77 Visit Ave',
    city: 'Clovis',
    state: 'CA',
    postalCode: '93611',
  });
  const early = await createCustomer({
    tenantId,
    name: 'Early Bird',
    addressLine1: '11 Early Way',
    city: 'Fresno',
    state: 'CA',
    postalCode: '93701',
  });
  const noAddr = await createCustomer({ tenantId, name: 'No Address Co' });
  const jobA = await createJob({ tenantId, customerId: cust.id, title: 'A' });
  const jobEarly = await createJob({ tenantId, customerId: early.id, title: 'E' });
  const jobB = await createJob({ tenantId, customerId: cust.id, title: 'B' });
  const jobC = await createJob({ tenantId, customerId: noAddr.id, title: 'C' });
  const confirmed = (jobId: string, startISO: NaiveLocal, endISO: NaiveLocal) =>
    createVisit({
      tenantId,
      jobId,
      technicianId: tech.id,
      startsAt: startISO,
      endsAt: endISO,
      status: 'confirmed',
    });
  await confirmed(jobA.id, nl(`${D1}T18:00:00.000Z`), nl(`${D1}T20:00:00.000Z`)); // late, inserted first
  await confirmed(jobEarly.id, nl(`${D1}T15:00:00.000Z`), nl(`${D1}T17:00:00.000Z`));
  await confirmed(jobC.id, nl(`${D3}T15:00:00.000Z`), nl(`${D3}T17:00:00.000Z`));
  const toCancel = await createVisit({
    tenantId,
    jobId: jobB.id,
    technicianId: tech.id,
    startsAt: nl(`${D2}T16:00:00.000Z`),
    endsAt: nl(`${D2}T18:00:00.000Z`),
  });
  await updateVisitStatus(toCancel.id, 'cancelled', 'test');
  // Overnight booking STARTING the day before D1 but ending inside it — the
  // overlap query returns it; the day clamp must keep it out of [D1..] results.
  await createVisit({
    tenantId,
    jobId: jobB.id,
    technicianId: tech.id,
    startsAt: nl('2026-08-09T23:00:00.000Z'),
    endsAt: nl(`${D1}T01:00:00.000Z`),
    status: 'confirmed',
  });
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('listDayStops (assignments — the only source)', () => {
  test('confirmed assignments grouped by UTC day, time-sorted; cancelled excluded', async () => {
    const days = await listDayStops(tenantId, REF, D1, D3);
    expect(days.map((d) => d.date)).toEqual([D1, D3]); // D2's booking was cancelled
    const d1 = days[0];
    expect(d1.stops.map((s) => s.label)).toEqual(['Early Bird', 'Asg Customer']);
    expect(d1.stops[1]).toMatchObject({
      label: 'Asg Customer',
      address: '77 Visit Ave, Clovis, CA, 93611',
      // timestamptz reads back as +00:00, not the Z form it was written with
      scheduledStart: expect.stringMatching(new RegExp(`^${D1}T18:00:00`)) as unknown as string,
    });
  });

  test('customer without address_line1 → stop present but unroutable (null address)', async () => {
    const days = await listDayStops(tenantId, REF, D3, D3);
    expect(days[0].stops).toEqual([
      expect.objectContaining({ label: 'No Address Co', address: null }),
    ]);
  });

  test('roster-less ref → empty schedule, no crash', async () => {
    expect(await listDayStops(tenantId, 'badge-without-roster', D1, D3)).toEqual([]);
  });

  test('overnight booking starting before the range is clamped out', async () => {
    const days = await listDayStops(tenantId, REF, D1, D3);
    // the 2026-08-09T23:00Z booking overlaps D1 but belongs to 08-09
    expect(days.map((d) => d.date)).toEqual([D1, D3]);
    // asking for 08-09 itself still finds it
    const before = await listDayStops(tenantId, REF, '2026-08-09', '2026-08-09');
    expect(before.map((d) => d.date)).toEqual(['2026-08-09']);
  });
});
