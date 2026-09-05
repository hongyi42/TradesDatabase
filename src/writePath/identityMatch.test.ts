import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { createVisit, updateVisitStatus } from '../db/visits.js';
import { matchIdentity } from './identityMatch.js';
import type { ExtractedFields } from './extract.js';

// matchIdentity reads customers + the DB-owned schedule (assignments), so this
// is a DB-backed test against the local stack: we seed rows, then assert.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let phoneCustomerId: string;
let addressCustomerId: string;
let schedTech1Id: string;
let schedTech2Id: string;

// Fixed day, far from other suites' fixtures; capture time on the same UTC day.
const DAY = '2026-06-19';
const today = `${DAY}T10:00:00.000Z`;

// A confirmed visit for a (technician, customer) on DAY — the schedule shape
// matchIdentity consults since the sheet mirror retired.
async function bookOn(technicianId: string, customerId: string, hour: string) {
  const job = await createJob({ tenantId, customerId, title: `visit ${hour}` });
  const assignment = await createVisit({
    tenantId,
    jobId: job.id,
    technicianId,
    startsAt: `${DAY}T${hour}:00:00.000Z`,
    endsAt: `${DAY}T${Number(hour) + 2}:00:00.000Z`,
    status: 'confirmed',
  });
  return { job, assignment };
}

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query('truncate table customers, jobs, technicians, schedule_events cascade');
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  schedTech1Id = (
    await insertTechnician({ tenantId, ref: 'tech-sched-1', displayName: 'Sched One' })
  ).id;
  schedTech2Id = (
    await insertTechnician({ tenantId, ref: 'tech-sched-2', displayName: 'Sched Two' })
  ).id;

  phoneCustomerId = (await createCustomer({ tenantId, name: 'Phone Match', phone: '555-0142' })).id;
  addressCustomerId = (
    await createCustomer({ tenantId, name: 'Address Match', addressLine1: '14 Smith St' })
  ).id;
});

afterAll(async () => {
  await pg.query(
    'truncate table customers, jobs, visits, raw_captures, technicians, schedule_events cascade',
  );
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

const note = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({ ...over });

describe('matchIdentity', () => {
  test('a confirmed customerId wins outright', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: today,
      extracted: note(),
      confirmed: { customerId: phoneCustomerId },
    });
    expect(r).toMatchObject({ status: 'matched', customerId: phoneCustomerId });
  });

  test('a unique phone match resolves to that customer', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: today,
      extracted: note({ phone: '555-0142' }),
    });
    expect(r).toMatchObject({ status: 'matched', customerId: phoneCustomerId });
  });

  test('a unique address match resolves to that customer (case-insensitive)', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: today,
      extracted: note({ address: '14 smith st' }),
    });
    expect(r).toMatchObject({ status: 'matched', customerId: addressCustomerId });
  });

  test('no phone/address match and no roster row (no schedule) → needs_disambiguation', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note({ phone: '555-9999', address: '999 Nowhere Ave' }),
    });
    expect(r.status).toBe('needs_disambiguation');
  });
});

describe('matchIdentity — schedule branch (confirmed assignments)', () => {
  test('a single scheduled visit on the capture day → needs_confirmation with its address', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Sched Cust',
      addressLine1: '5 Schedule Rd',
    });
    const { assignment } = await bookOn(schedTech1Id, cust.id, '15');
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-1',
      capturedAt: today,
      extracted: note(),
    });
    expect(r.status).toBe('needs_confirmation');
    expect(r.suggestion?.address).toBe('5 Schedule Rd');
    expect(r.suggestion?.assignmentId).toBe(assignment.id);

    // EVENING capture: 2026-06-20T01:00Z is still 6pm June 19 in the firm's
    // timezone (seed default America/Los_Angeles). The consultation must key
    // on the FIRM-local day, not the raw UTC slice — a same-evening writeup
    // still gets the day's suggestion.
    const evening = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-1',
      capturedAt: '2026-06-20T01:00:00.000Z',
      extracted: note(),
    });
    expect(evening.status).toBe('needs_confirmation');
    expect(evening.suggestion?.address).toBe('5 Schedule Rd');
  });

  test('resume with a confirmed address → matched to the visit\'s customer AND job', async () => {
    // TWO customers share the address (apartment-complex case), so step-1
    // unique-address dedup cannot short-circuit — the day's schedule is what
    // disambiguates, and it returns the JOB link only the assignment knows.
    const booked = await createCustomer({
      tenantId,
      name: 'Linked Unit A',
      addressLine1: '6 Linked Ave',
    });
    await createCustomer({ tenantId, name: 'Linked Unit B', addressLine1: '6 Linked Ave' });
    // A second visit the same day for an unrelated customer → no
    // single-suggestion either; the confirmed address must pick the right one.
    const other = await createCustomer({ tenantId, name: 'Same Day Other' });
    const target = await bookOn(schedTech2Id, booked.id, '09');
    await bookOn(schedTech2Id, other.id, '13');
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-2',
      capturedAt: today,
      extracted: note(),
      confirmed: { address: '6 linked ave' }, // case-insensitive
    });
    expect(r).toMatchObject({
      status: 'matched',
      customerId: booked.id,
      jobId: target.job.id,
    });
  });

  test('confirmed address not on the day\'s schedule → needs_disambiguation (caller creates)', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-2',
      capturedAt: today,
      extracted: note(),
      confirmed: { address: '404 Not Scheduled St' },
    });
    expect(r.status).toBe('needs_disambiguation');
    expect(r.reason).toContain('not found on the schedule');
  });

  test('cancelled visits do not suggest; another day\'s visit does not leak in', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Other Day',
      addressLine1: '8 Other Day Dr',
    });
    // Visit on a DIFFERENT day than the capture → no suggestion for tech-sched-1
    // beyond its single 06-19 visit (already asserted); for a fresh tech ref
    // with only an off-day visit, the schedule branch finds nothing.
    const tech3 = await insertTechnician({ tenantId, ref: 'tech-sched-3', displayName: 'S3' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'off-day' });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech3.id,
      startsAt: '2026-06-20T15:00:00.000Z', // day AFTER the capture
      endsAt: '2026-06-20T17:00:00.000Z',
      status: 'confirmed',
    });
    // A CANCELLED visit ON the capture day must not suggest either — only
    // confirmed rows are the schedule.
    const cancelled = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech3.id,
      startsAt: `${DAY}T09:00:00.000Z`,
      endsAt: `${DAY}T11:00:00.000Z`,
      status: 'confirmed',
    });
    await updateVisitStatus(cancelled.id, 'cancelled', 'test');
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-3',
      capturedAt: today,
      extracted: note(),
    });
    expect(r.status).toBe('needs_disambiguation');
  });
});
