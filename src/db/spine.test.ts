import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer, getCustomer } from './customers.js';
import { createJob, getJob, listJobsForCustomer, updateJobStatus } from './jobs.js';
import { createVisit, listVisitsForJob } from './visits.js';
import { appendRawCapture } from './rawCaptures.js';

// Writes go through the app's own path (supabase-js / PostgREST). A direct pg
// connection is used as an INDEPENDENT channel for cross-channel read-back
// (verifying-behavior §2) and for cleanup.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  // Self-clean. raw_captures DELETE is blocked by the append-only trigger, but
  // TRUNCATE does not fire row-level UPDATE/DELETE triggers — so this clears all
  // rows the tests created (this is a dedicated fake-data test project) while
  // leaving the seeded tenant intact.
  await pg.query('truncate table customers, jobs, visits, raw_captures cascade');
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

    const visit = await createVisit({ tenantId, jobId: job.id, technicianName: 'Bob' });

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
