import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, type Technician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { createAssignment, updateAssignmentStatus } from '../db/assignments.js';
import { upsertScheduleEntry } from '../db/scheduleEntries.js';
import { listDayStops } from './daySource.js';

// Integration against the LOCAL stack, self-cleaning (pattern:
// scheduling.test.ts — truncate both ways, restore seed seats; `cascade`
// sweeps assignments and schedule_entries FK'd rows).
const TRUNCATE = 'truncate table customers, jobs, technicians, schedule_entries cascade';

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

  // ── schedule_entries fixtures: 2 stops on D1 (inserted out of order), 1 on D2,
  //    1 with NULL scheduled_start (must be skipped), 1 outside the range.
  const mk = (key: string, over: Record<string, unknown>) =>
    upsertScheduleEntry({
      tenantId,
      technicianRef: REF,
      externalRowKey: key,
      customerName: `SE ${key}`,
      addressLine1: `${key} St`,
      city: 'Fresno',
      state: 'CA',
      postalCode: '93701',
      source: 'test',
      ...over,
    });
  await mk('d1-late', { scheduledStart: `${D1}T18:00:00.000Z` });
  await mk('d1-early', { scheduledStart: `${D1}T15:00:00.000Z` });
  await mk('d2-only', { scheduledStart: `${D2}T16:00:00.000Z` });
  await mk('null-start', { scheduledStart: null });
  await mk('outside', { scheduledStart: '2026-09-01T16:00:00.000Z' });

  // ── assignments fixtures: confirmed on D1 and D3, cancelled on D2 (excluded),
  //    plus a job whose customer has no address_line1 (unroutable stop).
  const cust = await createCustomer({
    tenantId,
    name: 'Asg Customer',
    addressLine1: '77 Assignment Ave',
    city: 'Clovis',
    state: 'CA',
    postalCode: '93611',
  });
  const noAddr = await createCustomer({ tenantId, name: 'No Address Co' });
  const jobA = await createJob({ tenantId, customerId: cust.id, title: 'A' });
  const jobB = await createJob({ tenantId, customerId: cust.id, title: 'B' });
  const jobC = await createJob({ tenantId, customerId: noAddr.id, title: 'C' });
  const confirmed = (jobId: string, day: string, hour: string) =>
    createAssignment({
      tenantId,
      jobId,
      technicianId: tech.id,
      startsAt: `${day}T${hour}:00:00.000Z`,
      endsAt: `${day}T${hour === '22' ? '23' : String(Number(hour) + 2).padStart(2, '0')}:00:00.000Z`,
      status: 'confirmed',
    });
  await confirmed(jobA.id, D1, '16');
  await confirmed(jobC.id, D3, '15');
  const toCancel = await createAssignment({
    tenantId,
    jobId: jobB.id,
    technicianId: tech.id,
    startsAt: `${D2}T16:00:00.000Z`,
    endsAt: `${D2}T18:00:00.000Z`,
  });
  await updateAssignmentStatus(toCancel.id, 'cancelled', 'test');
  // Overnight booking STARTING the day before D1 but ending inside it — the
  // overlap query returns it; the day clamp must keep it out of [D1..] results.
  await createAssignment({
    tenantId,
    jobId: jobB.id,
    technicianId: tech.id,
    startsAt: '2026-08-09T23:00:00.000Z',
    endsAt: `${D1}T01:00:00.000Z`,
    status: 'confirmed',
  });
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('listDayStops — schedule_entries mode (flag default)', () => {
  test('flag unset defaults to schedule_entries', async () => {
    vi.stubEnv('ROUTE_DAY_SOURCE', '');
    const days = await listDayStops(tenantId, REF, D1, D3);
    expect(days.map((d) => d.date)).toEqual([D1, D2]); // D3 has no mirror rows
  });

  test('groups by UTC day, stops time-sorted within a day', async () => {
    const days = await listDayStops(tenantId, REF, D1, D3);
    const d1 = days.find((d) => d.date === D1)!;
    expect(d1.stops.map((s) => s.label)).toEqual(['SE d1-early', 'SE d1-late']);
    expect(d1.stops[0].address).toBe('d1-early St, Fresno, CA, 93701');
  });

  test('range edges inclusive; outside-range and null-start rows excluded', async () => {
    const days = await listDayStops(tenantId, REF, D2, D2);
    expect(days).toHaveLength(1);
    expect(days[0].stops.map((s) => s.label)).toEqual(['SE d2-only']);
    const all = await listDayStops(tenantId, REF, '2026-08-01', '2026-09-30');
    const labels = all.flatMap((d) => d.stops.map((s) => s.label));
    expect(labels).not.toContain('SE null-start');
    expect(labels).toContain('SE outside');
  });

  test('unknown technician ref → empty', async () => {
    expect(await listDayStops(tenantId, 'nobody', D1, D3)).toEqual([]);
  });
});

describe('listDayStops — assignments mode', () => {
  test('confirmed assignments grouped by day; cancelled excluded', async () => {
    vi.stubEnv('ROUTE_DAY_SOURCE', 'assignments');
    const days = await listDayStops(tenantId, REF, D1, D3);
    expect(days.map((d) => d.date)).toEqual([D1, D3]); // D2's booking was cancelled
    expect(days[0].stops[0]).toMatchObject({
      label: 'Asg Customer',
      address: '77 Assignment Ave, Clovis, CA, 93611',
      // timestamptz reads back as +00:00, not the Z form it was written with
      scheduledStart: expect.stringMatching(new RegExp(`^${D1}T16:00:00`)) as unknown as string,
    });
  });

  test('customer without address_line1 → stop present but unroutable (null address)', async () => {
    vi.stubEnv('ROUTE_DAY_SOURCE', 'assignments');
    const days = await listDayStops(tenantId, REF, D3, D3);
    expect(days[0].stops).toEqual([
      expect.objectContaining({ label: 'No Address Co', address: null }),
    ]);
  });

  test('roster-less ref → empty schedule, no crash', async () => {
    vi.stubEnv('ROUTE_DAY_SOURCE', 'assignments');
    expect(await listDayStops(tenantId, 'badge-without-roster', D1, D3)).toEqual([]);
  });

  test('overnight booking starting before the range is clamped out', async () => {
    vi.stubEnv('ROUTE_DAY_SOURCE', 'assignments');
    const days = await listDayStops(tenantId, REF, D1, D3);
    // the 2026-08-09T23:00Z booking overlaps D1 but belongs to 08-09
    expect(days.map((d) => d.date)).toEqual([D1, D3]);
    // asking for 08-09 itself still finds it
    const before = await listDayStops(tenantId, REF, '2026-08-09', '2026-08-09');
    expect(before.map((d) => d.date)).toEqual(['2026-08-09']);
  });
});
