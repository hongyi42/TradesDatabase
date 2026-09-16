import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer, getCustomer } from './customers.js';
import {
  createJob,
  getJob,
  listJobsForCustomer,
  listOpenJobsForCustomer,
  updateJobStatus,
} from './jobs.js';
import { createTenant } from './tenants.js';
import {
  createVisit,
  insertVisitNote,
  listUnscheduledOpenJobsWithCustomer,
  listVisitsForCustomer,
  listVisitsForJob,
} from './visits.js';
import { appendRawCapture } from './rawCaptures.js';
import { listJobActivitySince } from './captureMembership.js';

// Writes go through the app's own path (supabase-js / PostgREST). A direct pg
// connection is used as an INDEPENDENT channel for cross-channel read-back
// (verifying-behavior §2) and for cleanup.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tenantB: string | undefined;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').order('created_at', { ascending: true }).limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  // Self-clean. raw_captures DELETE is blocked by the append-only trigger, but
  // TRUNCATE does not fire row-level UPDATE/DELETE triggers — so this clears all
  // rows the tests created (this is a dedicated fake-data test project) while
  // leaving the seeded tenant intact.
  await pg.query('truncate table customers, jobs, visits, raw_captures cascade');
  // The truncate swept tenant B's children; the row itself is outside it.
  if (tenantB) await pg.query('delete from tenants where id = $1', [tenantB]);
  await pg.end();
});

describe('context spine data-access layer', () => {
  test('round-trip with provenance, verified cross-channel via direct pg', async () => {
    const customer = await createCustomer({ tenantId, name: 'Jane Smith', phone: '555-0100' });

    // The inbound call that started everything (L1), linked to the customer.
    const call = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'Hi, my AC is broken',
      customerId: customer.id,
    });

    // The dispatcher turns the call into a job; the job records its source capture.
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'AC repair',
      sourceCaptureId: call.id,
    });

    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: '2026-08-16T13:00:00.000Z',
    });

    // The tech's on-site note (L1), linked to all three entities.
    const note = await appendRawCapture({
      tenantId,
      channel: 'technician_voice',
      rawText: 'Replaced the capacitor, unit running',
      customerId: customer.id,
      jobId: job.id,
      visitId: visit.id,
    });

    // Read back via the app's path.
    expect((await getJob(job.id))?.source_capture_id).toBe(call.id);
    expect((await listJobsForCustomer(customer.id)).map((j) => j.id)).toContain(job.id);
    expect((await listVisitsForJob(job.id)).map((v) => v.id)).toContain(visit.id);

    // Cross-channel read-back via direct pg (different protocol than PostgREST).
    const jobRow = await pg.query<{ source_capture_id: string | null }>(
      'select source_capture_id from jobs where id = $1',
      [job.id],
    );
    expect(jobRow.rows[0].source_capture_id).toBe(call.id);
    const noteRow = await pg.query<{
      customer_id: string | null;
      job_id: string | null;
      visit_id: string | null;
    }>('select customer_id, job_id, visit_id from raw_captures where id = $1', [note.id]);
    expect(noteRow.rows[0]).toEqual({
      customer_id: customer.id,
      job_id: job.id,
      visit_id: visit.id,
    });
  });

  test('jobs tied on created_at come back in ONE stable order — id ascending', async () => {
    // Two jobs minted in one transaction or one millisecond share created_at, and
    // Postgres gives equal sort keys no order. recordFieldNote reads the list's
    // TAIL as the newest job, so without a tiebreak the same note could land on a
    // different job on its next delivery.
    const customer = await createCustomer({ tenantId, name: 'Tie Cust' });
    const jobs = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => createJob({ tenantId, customerId: customer.id, title: `tie ${i}` })),
    );
    const ids = jobs.map((j) => j.id);
    // The independent channel forces the tie PostgREST cannot create on demand.
    await pg.query('update jobs set created_at = $1 where id = any($2::uuid[])', [
      '2026-09-01T12:00:00Z',
      ids,
    ]);
    const expected = [...ids].sort(); // lowercase-hex order == Postgres uuid byte order
    for (let i = 0; i < 3; i++) {
      expect((await listJobsForCustomer(customer.id)).map((j) => j.id)).toEqual(expected);
      expect((await listOpenJobsForCustomer(customer.id)).map((j) => j.id)).toEqual(expected);
    }
  });

  test('the unscheduled work queue and a customer\'s past visits are stable on a created_at tie', async () => {
    const customer = await createCustomer({ tenantId, name: 'Tie Queue Cust' });
    const jobs = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => createJob({ tenantId, customerId: customer.id, title: `queue ${i}` })),
    );
    const jobIds = jobs.map((j) => j.id);
    await pg.query('update jobs set created_at = $1 where id = any($2::uuid[])', [
      '2026-09-01T12:00:00Z',
      jobIds,
    ]);
    // A job WITH a completed visit stays unscheduled (only proposed/confirmed
    // visits take it off the queue), so these trips do not disturb the queue.
    const visits = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        createVisit({
          tenantId,
          jobId: jobs[0].id,
          technicianId: null,
          startsAt: null,
          endsAt: null,
          status: 'completed',
          completedAt: '2026-08-16T13:00:00.000Z',
        }),
      ),
    );
    const visitIds = visits.map((v) => v.id);
    await pg.query('update visits set created_at = $1 where id = any($2::uuid[])', [
      '2026-09-01T12:00:00Z',
      visitIds,
    ]);

    const queueOrder = [...jobIds].sort(); // oldest first, id ascending on a tie
    const visitOrder = [...visitIds].sort().reverse(); // newest first, id descending on a tie
    for (let i = 0; i < 3; i++) {
      const queue = (await listUnscheduledOpenJobsWithCustomer(tenantId))
        .map((r) => r.id)
        .filter((id) => jobIds.includes(id));
      expect(queue).toEqual(queueOrder);
      expect((await listVisitsForCustomer(customer.id)).map((v) => v.id)).toEqual(visitOrder);
    }
  });

  test('job priority: stored when passed, defaults to routine (Plan 3a)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Priority Test' });
    const urgent = await createJob({ tenantId, customerId: customer.id, priority: 'urgent' });
    expect(urgent.priority).toBe('urgent');
    const plain = await createJob({ tenantId, customerId: customer.id });
    expect(plain.priority).toBe('routine');
  });

  test('updateJobStatus enforces the transition state machine', async () => {
    const customer = await createCustomer({ tenantId, name: 'Status Test' });
    const job = await createJob({ tenantId, customerId: customer.id });
    expect(job.status).toBe('open');

    // open → paid is illegal and must throw.
    await expect(updateJobStatus(job.id, 'paid')).rejects.toThrow(/Illegal job status transition/);

    // open → in_progress is allowed.
    const moved = await updateJobStatus(job.id, 'in_progress');
    expect(moved.status).toBe('in_progress');
  });

  test('updated_at is auto-stamped by the DB trigger on update', async () => {
    const customer = await createCustomer({ tenantId, name: 'Stamp Test' });
    const job = await createJob({ tenantId, customerId: customer.id });
    // No code path sets updated_at anymore, so a later value proves the trigger ran.
    const moved = await updateJobStatus(job.id, 'in_progress');
    expect(new Date(moved.updated_at).getTime()).toBeGreaterThan(new Date(job.updated_at).getTime());
  });

  test('L3 attributes JSON round-trips intact', async () => {
    const customer = await createCustomer({
      tenantId,
      name: 'Gate Code Customer',
      attributes: { gateCode: '1234', prefersAfternoons: true },
    });
    const reloaded = await getCustomer(customer.id);
    expect(reloaded?.attributes).toEqual({ gateCode: '1234', prefersAfternoons: true });
  });
});

// The watcher's activity probe (plan 2026-08-15 feature A), ONE read since
// retrieval layer plan 3: every job arm of the capture membership, by the
// capture's own time. It used to be two homes (job-stamped capture times + notes
// LINKED to a trip), each blind to what the other saw. captured_at is DB-stamped
// real UTC, so the floors below are derived from the wall clock around the inserts.
describe('watcher activity probe', () => {
  test('stamp and trip link both count; floor respected; empty jobIds short-circuits; two-tenant isolation', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const customer = await createCustomer({ tenantId, name: 'Activity Casa' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Activity work' });
    const note = await appendRawCapture({
      tenantId,
      channel: 'technician_voice',
      rawText: 'Compressor swapped, running fine',
      jobId: job.id,
    });
    // A second note with NO job stamp, reaching the job only through the trip
    // it reported — the shape the old job-stamped reader could not see.
    const linkedOnly = await appendRawCapture({
      tenantId,
      channel: 'technician_voice',
      rawText: 'left the filter on the bench',
    });
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: '2026-08-16T13:00:00.000Z',
    });
    await insertVisitNote({ tenantId, visitId: visit.id, captureId: linkedOnly.id });

    // Empty jobIds → an empty Map without a round trip.
    expect(await listJobActivitySince(tenantId, [], before)).toEqual(new Map());

    // Floor respected: a past floor includes the rows, a future floor excludes.
    const latest = await listJobActivitySince(tenantId, [job.id], before);
    expect([...latest.keys()]).toEqual([job.id]);
    expect(Date.parse(latest.get(job.id) ?? '')).toBe(
      Math.max(Date.parse(note.captured_at), Date.parse(linkedOnly.captured_at)),
    );
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await listJobActivitySince(tenantId, [job.id], future)).toEqual(new Map());

    // Two-tenant isolation: tenant-B rows stamped onto THE SAME job id (the FKs
    // are id-only, so nothing in the schema prevents this shape) must never
    // appear in tenant A's answer.
    tenantB = (await createTenant(`spine-tenant-b-${Date.now()}`)).id;
    const bNote = await appendRawCapture({
      tenantId: tenantB,
      channel: 'technician_voice',
      rawText: 'cross-tenant stamp',
      jobId: job.id,
    });
    const bVisit = await createVisit({
      tenantId: tenantB,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: '2026-08-16T13:00:00.000Z',
    });
    await insertVisitNote({ tenantId: tenantB, visitId: bVisit.id, captureId: bNote.id });

    const aLatest = await listJobActivitySince(tenantId, [job.id], before);
    expect(Date.parse(aLatest.get(job.id) ?? '')).toBe(
      Math.max(Date.parse(note.captured_at), Date.parse(linkedOnly.captured_at)),
    );
    // …and tenant B sees NOTHING on tenant A's job id: capture_membership
    // requires the job to share the capture's tenant, so a stamp or a link onto
    // another firm's job is walled off on BOTH sides (the old readers let tenant
    // B's own stamp through — this is the stricter wall).
    expect(await listJobActivitySince(tenantB, [job.id], before)).toEqual(new Map());
  });
});
