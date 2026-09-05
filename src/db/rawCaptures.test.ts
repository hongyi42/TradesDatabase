import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { listJobEvidenceSince } from './rawCaptures.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createVisit, insertVisitNote } from './visits.js';
import { createTenant } from './tenants.js';

// listJobEvidenceSince is what decides WHAT A CITATION MAY BE CHECKED AGAINST,
// it crosses a tenant boundary on a join, and the planner turns its output into
// a row-closing decision. It was shipped with no automated coverage; this is it.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;
let jobA: string;
let jobB: string;
let otherJob: string;

const FLOOR = '2026-08-16T12:00:00.000Z';

// A note that reported a trip: the visit row PLUS the visit_notes link, which
// is what recordFieldNote writes and what the evidence reader now walks (rung
// 9b — the row's own created_at stopped being the moment evidence landed once a
// note could attach to a trip booked weeks earlier).
async function reportedVisit(o: { tenantId: string; jobId: string; captureId: string }) {
  const v = await createVisit({
    tenantId: o.tenantId,
    jobId: o.jobId,
    technicianId: null,
    startsAt: null,
    endsAt: null,
    status: 'completed',
    completedAt: '2026-08-16T13:00:00.000Z',
    sourceCaptureId: o.captureId,
  });
  await insertVisitNote({ tenantId: o.tenantId, visitId: v.id, captureId: o.captureId });
  return v;
}
const before = '2026-08-16T11:00:00.000Z';
const after = '2026-08-16T13:00:00.000Z';

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  otherTenantId = (await createTenant(`evidence-guard-${Date.now()}`)).id;

  const mkJob = async (tid: string, title: string) => {
    const c = await createCustomer({ tenantId: tid, name: `${title} Customer` });
    const j = await createJob({ tenantId: tid, customerId: c.id, title });
    return j.id;
  };
  jobA = await mkJob(tenantId, 'Evidence Job A');
  jobB = await mkJob(tenantId, 'Evidence Job B');
  otherJob = await mkJob(otherTenantId, 'Other Tenant Job');
});

afterAll(async () => {
  // The house pattern for L1-touching suites (context.test.ts): TRUNCATE, because
  // raw_captures is append-only by trigger — DELETE is refused, and so is the
  // `on delete set null` UPDATE that removing a referenced job would need.
  // vitest runs test FILES sequentially (fileParallelism: false) for exactly this.
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.query('delete from tenants where id = $1', [otherTenantId]);
  await pg.end();
});

// INSERTED DIRECTLY, not through appendRawCapture: captured_at defaults to now()
// and is not a writable input, and the append-only trigger refuses the UPDATE
// that would fix it afterwards. The trigger blocks UPDATE and DELETE, never
// INSERT, so a fixture may name its own timestamp — which every bound in this
// file depends on.
async function capture(opts: {
  tenantId: string;
  jobId?: string | null;
  text: string;
  at: string;
  sensitivity?: string | null;
  retracts?: string | null;
}): Promise<{ id: string }> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into raw_captures
       (tenant_id, channel, raw_text, technician_ref, job_id, captured_at, sensitivity, retracts_capture_id)
     values ($1, 'technician_note', $2, 'evidence-tech', $3, $4, $5, $6)
     returning id`,
    [
      opts.tenantId,
      opts.text,
      opts.jobId ?? null,
      opts.at,
      opts.sensitivity ?? null,
      opts.retracts ?? null,
    ],
  );
  return rows[0];
}

describe('listJobEvidenceSince', () => {
  test('empty input short-circuits — PostgREST in.() with zero values errors', async () => {
    expect(await listJobEvidenceSince(tenantId, [], FLOOR)).toEqual([]);
  });

  test('job-stamped captures at or before the floor are excluded, after it are kept', async () => {
    await capture({ tenantId, jobId: jobA, text: 'too early', at: before });
    await capture({ tenantId, jobId: jobA, text: 'exactly at the floor', at: FLOOR });
    await capture({ tenantId, jobId: jobA, text: 'in bounds', at: after });
    const rows = await listJobEvidenceSince(tenantId, [jobA], FLOOR);
    const texts = rows.map((r) => r.capture.raw_text);
    expect(texts).toContain('in bounds');
    expect(texts).toContain('exactly at the floor'); // gte — the caller applies the strict bound
    expect(texts).not.toContain('too early');
  });

  test('THE REASON THIS EXISTS: a capture with no job_id, reached through its visit', async () => {
    // A technician's reply lands in L1 before identity is resolved, so its
    // raw_captures.job_id is null — the only link is the visit recordFieldNote
    // minted from it. Reading job-stamped rows alone would miss exactly the
    // answers this function is for.
    const orphan = await capture({ tenantId, jobId: null, text: 'the answer nobody stamped', at: after });
    await reportedVisit({ tenantId, jobId: jobB, captureId: orphan.id });
    const rows = await listJobEvidenceSince(tenantId, [jobB], FLOOR);
    const found = rows.find((r) => r.capture.id === orphan.id);
    expect(found).toBeDefined();
    expect(found?.via).toBe('visit');
    expect(found?.jobId).toBe(jobB); // attributed to the visit's job, not the capture's
  });

  test('a job-stamped capture keeps that provenance even when a visit also points at it', async () => {
    const stamped = await capture({ tenantId, jobId: jobA, text: 'stamped and visited', at: after });
    await reportedVisit({ tenantId, jobId: jobA, captureId: stamped.id });
    const rows = await listJobEvidenceSince(tenantId, [jobA], FLOOR);
    const found = rows.filter((r) => r.capture.id === stamped.id);
    expect(found).toHaveLength(1); // deduped, not returned twice
    expect(found[0].via).toBe('job_stamp'); // the direct link is the stronger claim
  });

  test('manager_only rows are dropped on BOTH paths — the team lead holds no manager badge', async () => {
    const stampedSecret = await capture({
      tenantId,
      jobId: jobA,
      text: 'manager eyes only, stamped',
      at: after,
      sensitivity: 'manager_only',
    });
    const orphanSecret = await capture({
      tenantId,
      jobId: null,
      text: 'manager eyes only, via visit',
      at: after,
      sensitivity: 'manager_only',
    });
    await reportedVisit({ tenantId, jobId: jobA, captureId: orphanSecret.id });
    const ids = (await listJobEvidenceSince(tenantId, [jobA], FLOOR)).map((r) => r.capture.id);
    expect(ids).not.toContain(stampedSecret.id);
    expect(ids).not.toContain(orphanSecret.id);
  });

  test('a retracted capture and its retraction are both dropped — citing a retracted note is worse than none', async () => {
    const bad = await capture({ tenantId, jobId: jobB, text: 'this was wrong', at: after });
    const retraction = await capture({
      tenantId,
      jobId: jobB,
      text: 'retracting that',
      at: after,
      retracts: bad.id,
    });
    const ids = (await listJobEvidenceSince(tenantId, [jobB], FLOOR)).map((r) => r.capture.id);
    expect(ids).not.toContain(bad.id);
    expect(ids).not.toContain(retraction.id);
  });

  test('another tenant\'s captures are unreachable, by job stamp or by visit', async () => {
    const stamped = await capture({
      tenantId: otherTenantId,
      jobId: otherJob,
      text: 'other tenant, stamped',
      at: after,
    });
    const orphan = await capture({
      tenantId: otherTenantId,
      jobId: null,
      text: 'other tenant, via visit',
      at: after,
    });
    await reportedVisit({ tenantId: otherTenantId, jobId: otherJob, captureId: orphan.id });
    // A forged jobId in a nudge's context is exactly how this would be reached.
    const rows = await listJobEvidenceSince(tenantId, [otherJob], FLOOR);
    expect(rows).toEqual([]);
    const ids = (await listJobEvidenceSince(tenantId, [jobA, jobB, otherJob], FLOOR)).map(
      (r) => r.capture.id,
    );
    expect(ids).not.toContain(stamped.id);
    expect(ids).not.toContain(orphan.id);
  });

  test('a note LINK pointing at ANOTHER tenant\'s capture cannot pull it in', async () => {
    // The one case that reaches the third query's tenant filter.
    // visit_notes.capture_id is a bare FK with no tenant constraint, so a link
    // in OUR tenant can name a capture in another one — and the link query that
    // finds it is filtered by our tenant, so nothing upstream catches it.
    // Without the filter on the capture fetch itself, that capture becomes
    // citable evidence. (Rung 9b: this used to be exercised through a visit's
    // source_capture_id, which step 2 no longer reads at all — the link is what
    // the reader walks now, so the fixture has to be a link or the assertion
    // passes without touching the guard it names.)
    const foreign = await capture({
      tenantId: otherTenantId,
      jobId: null,
      text: 'another firm\'s words entirely',
      at: after,
    });
    const ourVisit = await pg.query<{ id: string }>(
      `insert into visits (tenant_id, job_id, status, completed_at)
       values ($1, $2, 'completed', $3) returning id`,
      [tenantId, jobB, after],
    );
    await pg.query(
      'insert into visit_notes (tenant_id, visit_id, capture_id) values ($1, $2, $3)',
      [tenantId, ourVisit.rows[0].id, foreign.id],
    );
    const rows = await listJobEvidenceSince(tenantId, [jobB], FLOOR);
    expect(rows.map((r) => r.capture.id)).not.toContain(foreign.id);
    expect(rows.map((r) => r.capture.raw_text)).not.toContain("another firm's words entirely");
  });

  test('results carry their job and come back oldest-first', async () => {
    const rows = await listJobEvidenceSince(tenantId, [jobA, jobB], FLOOR);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect([jobA, jobB]).toContain(r.jobId);
    const times = rows.map((r) => r.capture.captured_at);
    expect([...times].sort()).toEqual(times);
  });
});
