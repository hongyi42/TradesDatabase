import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { createJob, listCostGapCandidates, updateJobStatus, type JobStatus } from './jobs.js';
import { createTenant } from './tenants.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
// This covers the riskiest new SQL in the cost detector: a PostgREST embed with
// a filter on the EMBEDDED table (`jobs!inner` + .in('jobs.status', …)), which
// silently returns everything if it is written wrong.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const FROM = '2026-08-16T00:00:00.000Z';
const TO = '2026-08-19T00:00:00.000Z';
let hour = 0;
// A technician cannot hold two overlapping CONFIRMED visits (exclusion
// constraint no_confirmed_overlap), so every fixture gets its own hour.
const nextSlot = (): string => `2026-08-17T${String(hour++).padStart(2, '0')}:30:00.000Z`;

let tenantId: string;
let otherTenantId: string;
let customerId: string;
let techA: string;
let techB: string;

async function mkTech(tenant: string, ref: string): Promise<string> {
  const { data, error } = await getClient()
    .from('technicians')
    .insert({ tenant_id: tenant, ref, display_name: ref, state: 'active', seat_exempt: true })
    .select('id')
    .single();
  if (error) throw new Error(`tech insert failed: ${error.message}`);
  return data.id as string;
}

async function mkJob(status: JobStatus, tenant = tenantId, customer = customerId): Promise<string> {
  const job = await createJob({ tenantId: tenant, customerId: customer, title: `job-${status}` });
  // Walk the status machine — statuses are derived, never set directly.
  const path: Record<string, JobStatus[]> = {
    open: [],
    in_progress: ['in_progress'],
    completed: ['in_progress', 'completed'],
    invoiced: ['in_progress', 'completed', 'invoiced'],
    paid: ['in_progress', 'completed', 'invoiced', 'paid'],
    cancelled: ['cancelled'],
    declined: ['declined'],
  };
  if (status !== 'open' && !(status in path)) throw new Error(`mkJob: no path for '${status}'`);
  for (const hop of path[status] ?? []) await updateJobStatus(job.id, hop);
  return job.id;
}

async function mkAssignment(
  jobId: string,
  technicianId: string | null,
  endsAt: string,
  status: 'proposed' | 'confirmed' | 'cancelled' | 'completed' = 'confirmed',
  tenant = tenantId,
): Promise<void> {
  const startsAt = new Date(Date.parse(endsAt) - 3_600_000).toISOString();
  const { error } = await getClient().from('assignments').insert({
    tenant_id: tenant,
    job_id: jobId,
    technician_id: technicianId,
    status,
    starts_at: startsAt,
    ends_at: endsAt,
  });
  if (error) throw new Error(`assignment insert failed: ${error.message}`);
}

beforeAll(async () => {
  await pg.connect();
  tenantId = (await createTenant(`costgap-${Date.now()}`)).id;
  otherTenantId = (await createTenant(`costgap-other-${Date.now()}`)).id;
  customerId = (await createCustomer({ tenantId, name: 'Cost Gap Customer' })).id;
  techA = await mkTech(tenantId, 'cg-tech-a');
  techB = await mkTech(tenantId, 'cg-tech-b');
});

afterAll(async () => {
  await pg.query('truncate table assignments, jobs, customers, technicians cascade');
  await pg.query('delete from tenants where id = any($1)', [[tenantId, otherTenantId]]);
  await pg.end();
});

describe('listCostGapCandidates — detector #2 candidates', () => {
  test('only FINISHED jobs qualify — the embedded status filter really filters', async () => {
    // If `.in('jobs.status', …)` were written wrong it would silently match
    // everything, and the detector would chase jobs still being worked on.
    // 'cancelled'/'declined' are excluded for the opposite reason: no work
    // happened, so there is nothing to have been spent.
    for (const status of ['open', 'in_progress', 'cancelled', 'declined'] as JobStatus[]) {
      const jobId = await mkJob(status);
      await mkAssignment(jobId, techA, nextSlot());
    }
    const completed = await mkJob('completed');
    await mkAssignment(completed, techA, nextSlot());
    const invoiced = await mkJob('invoiced');
    await mkAssignment(invoiced, techA, nextSlot());

    const rows = await listCostGapCandidates(tenantId, FROM, TO);
    expect(rows.map((r) => r.jobId).sort()).toEqual([completed, invoiced].sort());
  });

  test("a PAID job is still a candidate — the paid-on-the-spot job is the common case", async () => {
    // REGRESSION (final-review finding): the filter used to be
    // ('completed','invoiced') only. deriveStatusTarget walks a job to 'paid'
    // AUTOMATICALLY once a payment clears the balance, and this detector only
    // looks 3h after the visit ends — so a customer who taps a card at the door
    // put the job beyond the detector's reach before it ever ran, and the 72h
    // window then closed on it unasked, permanently. Paid jobs are also where
    // the gap hurts most: revenue is known exactly, so the missing cost is the
    // only thing between the firm and knowing what the job made.
    const paid = await mkJob('paid');
    await mkAssignment(paid, techA, nextSlot());

    const ids = (await listCostGapCandidates(tenantId, FROM, TO)).map((r) => r.jobId);
    expect(ids).toContain(paid);
  });

  test('the MOST RECENT visit wins — the right technician is asked', async () => {
    // A multi-visit job must be attributed to whoever was there LAST: they know
    // what it ended up costing. Ordering this wrong asks the wrong person.
    const jobId = await mkJob('completed');
    await mkAssignment(jobId, techB, '2026-08-17T07:00:00.000Z'); // earlier
    await mkAssignment(jobId, techA, '2026-08-17T18:00:00.000Z'); // later
    const rows = await listCostGapCandidates(tenantId, FROM, TO);
    const mine = rows.filter((r) => r.jobId === jobId);
    expect(mine).toHaveLength(1); // ONE candidate per job, not one per visit
    expect(mine[0].technicianId).toBe(techA);
    expect(mine[0].endsAtLocal.startsWith('2026-08-17T18:00')).toBe(true);
  });

  test('drops unconfirmed visits, out-of-window visits, and null technicians', async () => {
    const unconfirmed = await mkJob('completed');
    await mkAssignment(unconfirmed, techA, nextSlot(), 'proposed');
    const outside = await mkJob('completed');
    await mkAssignment(outside, techA, '2026-08-01T11:00:00.000Z');
    const noTech = await mkJob('completed');
    await mkAssignment(noTech, null, nextSlot());

    const ids = (await listCostGapCandidates(tenantId, FROM, TO)).map((r) => r.jobId);
    expect(ids).not.toContain(unconfirmed);
    expect(ids).not.toContain(outside);
    expect(ids).not.toContain(noTech); // nobody to ask
  });

  test('is tenant-scoped', async () => {
    const otherCustomer = await createCustomer({ tenantId: otherTenantId, name: 'Other' });
    const otherTech = await mkTech(otherTenantId, 'cg-tech-other');
    const otherJob = await mkJob('completed', otherTenantId, otherCustomer.id);
    await mkAssignment(otherJob, otherTech, nextSlot(), 'confirmed', otherTenantId);

    const mine = await listCostGapCandidates(tenantId, FROM, TO);
    expect(mine.map((r) => r.jobId)).not.toContain(otherJob);
    const theirs = await listCostGapCandidates(otherTenantId, FROM, TO);
    expect(theirs.map((r) => r.jobId)).toEqual([otherJob]);
  });

  test('carries the job title and customer name the question needs', async () => {
    const rows = await listCostGapCandidates(tenantId, FROM, TO);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].customerName).toBe('Cost Gap Customer');
    expect(rows[0].jobTitle).toBeTruthy();
  });
});
