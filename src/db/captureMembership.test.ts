import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  listGapEvidence,
  listJobActivitySince,
  listL2CitingCapture,
  readCaptureRecords,
  type EvidenceAsk,
} from './captureMembership.js';
import { createCustomer } from './customers.js';
import { createJob, insertJobCapture, listJobsWithCustomerByIds } from './jobs.js';
import { listJobIdsWithCostEvents } from './moneyEvents.js';
import { createVisit, insertVisitNote, updateVisitStatus } from './visits.js';
import { createTenant } from './tenants.js';

// The planner's and the watcher's capture readers over the ONE membership
// definition (retrieval layer plan 3). Ported from rawCaptures.test.ts, where the
// hand-written readers these replace were tested: every behaviour that suite
// pinned is pinned here against the database functions, with two deliberate
// flips — manager_only rows are now EVIDENCE (the planner tier reads everything)
// and `via` names every arm a capture was reached by instead of picking one.
//
// These decide WHAT A CITATION MAY BE CHECKED AGAINST, they cross a tenant
// boundary on every join, and the planner turns their output into row-closing
// decisions.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;
let jobA: string;
let jobB: string;
let otherJob: string;

const FLOOR = '2026-08-16T12:00:00.000Z';
const before = '2026-08-16T11:00:00.000Z';
const after = '2026-08-16T13:00:00.000Z';

const ask = (jobId: string, sinceIso = FLOOR, gapId = `gap-${jobId}`): EvidenceAsk => ({
  gapId,
  jobId,
  sinceIso,
});

// A note that reported a trip: the visit row PLUS the visit_notes link, which is
// what recordFieldNote writes.
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

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  otherTenantId = (await createTenant(`membership-guard-${Date.now()}`)).id;

  const mkJob = async (tid: string, title: string) => {
    const c = await createCustomer({ tenantId: tid, name: `${title} Customer` });
    const j = await createJob({ tenantId: tid, customerId: c.id, title });
    return j.id;
  };
  jobA = await mkJob(tenantId, 'Membership Job A');
  jobB = await mkJob(tenantId, 'Membership Job B');
  otherJob = await mkJob(otherTenantId, 'Other Tenant Job');
});

afterAll(async () => {
  // TRUNCATE, the house pattern for L1-touching suites: raw_captures is
  // append-only by trigger, so DELETE is refused.
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.query('delete from tenants where id = $1', [otherTenantId]);
  await pg.end();
});

// INSERTED DIRECTLY: captured_at defaults to now() and is not a writable input,
// and the append-only trigger refuses the UPDATE that would fix it afterwards.
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

describe('listGapEvidence', () => {
  test('no asks short-circuits', async () => {
    expect(await listGapEvidence(tenantId, [])).toEqual([]);
  });

  test('the floor is STRICT — at or before it is excluded, after it is kept', async () => {
    await capture({ tenantId, jobId: jobA, text: 'too early', at: before });
    await capture({ tenantId, jobId: jobA, text: 'exactly at the floor', at: FLOOR });
    await capture({ tenantId, jobId: jobA, text: 'in bounds', at: after });
    const texts = (await listGapEvidence(tenantId, [ask(jobA)], 20)).map((r) => r.capture.raw_text);
    expect(texts).toContain('in bounds');
    // The same `captured_at > since` buildGapView applies — the database and the
    // prompt agree on the bound, so nothing shown is filtered out again.
    expect(texts).not.toContain('exactly at the floor');
    expect(texts).not.toContain('too early');
  });

  test('THE REASON THIS EXISTS: a capture with no job_id, reached through its visit', async () => {
    const orphan = await capture({ tenantId, jobId: null, text: 'the answer nobody stamped', at: after });
    await reportedVisit({ tenantId, jobId: jobB, captureId: orphan.id });
    const found = (await listGapEvidence(tenantId, [ask(jobB)], 20)).find(
      (r) => r.capture.id === orphan.id,
    );
    expect(found).toBeDefined();
    expect(found?.via.split(',')).toContain('visit_note');
    expect(found?.jobId).toBe(jobB); // attributed to the visit's job, not the capture's
    expect(found?.gapId).toBe(`gap-${jobB}`);
  });

  test('a capture reached two ways comes back ONCE, naming both arms', async () => {
    const stamped = await capture({ tenantId, jobId: jobA, text: 'stamped and visited', at: after });
    await reportedVisit({ tenantId, jobId: jobA, captureId: stamped.id });
    const found = (await listGapEvidence(tenantId, [ask(jobA)], 20)).filter(
      (r) => r.capture.id === stamped.id,
    );
    expect(found).toHaveLength(1); // deduped, not returned twice
    expect(found[0].via.split(',')).toEqual(expect.arrayContaining(['job_stamp', 'visit_note']));
  });

  test('manager_only rows ARE evidence now — the planner tier reads everything (FLIPPED)', async () => {
    // The old reader dropped these "because the team lead holds no manager
    // badge". The operator ruled the planner reads everything (2026-08-23,
    // 2026-09-15), and its SQL already could — the pushed evidence now agrees.
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
    const ids = (await listGapEvidence(tenantId, [ask(jobA)], 20)).map((r) => r.capture.id);
    expect(ids).toContain(stampedSecret.id);
    expect(ids).toContain(orphanSecret.id);
  });

  test('a retracted capture and its retraction are both absent — citing a retracted note is worse than none', async () => {
    const bad = await capture({ tenantId, jobId: jobB, text: 'this was wrong', at: after });
    const retraction = await capture({
      tenantId,
      jobId: jobB,
      text: 'retracting that',
      at: after,
      retracts: bad.id,
    });
    const ids = (await listGapEvidence(tenantId, [ask(jobB)], 20)).map((r) => r.capture.id);
    expect(ids).not.toContain(bad.id);
    expect(ids).not.toContain(retraction.id);
  });

  test("another tenant's captures are unreachable, by job stamp or by visit", async () => {
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
    // A forged jobId in a gap's context is exactly how this would be reached.
    expect(await listGapEvidence(tenantId, [ask(otherJob)], 20)).toEqual([]);
    const ids = (await listGapEvidence(tenantId, [ask(jobA), ask(jobB), ask(otherJob)], 20)).map(
      (r) => r.capture.id,
    );
    expect(ids).not.toContain(stamped.id);
    expect(ids).not.toContain(orphan.id);
  });

  test("a note LINK pointing at ANOTHER tenant's capture cannot pull it in", async () => {
    // visit_notes.capture_id is a bare FK with no tenant constraint, so a link in
    // OUR tenant can name a capture in another one.
    const foreign = await capture({
      tenantId: otherTenantId,
      jobId: null,
      text: "another firm's words entirely",
      at: after,
    });
    const ourVisit = await pg.query<{ id: string }>(
      `insert into visits (tenant_id, job_id, status, completed_at)
       values ($1, $2, 'completed', $3) returning id`,
      [tenantId, jobB, after],
    );
    await pg.query('insert into visit_notes (tenant_id, visit_id, capture_id) values ($1, $2, $3)', [
      tenantId,
      ourVisit.rows[0].id,
      foreign.id,
    ]);
    const rows = await listGapEvidence(tenantId, [ask(jobB)], 20);
    expect(rows.map((r) => r.capture.id)).not.toContain(foreign.id);
    expect(rows.map((r) => r.capture.raw_text)).not.toContain("another firm's words entirely");
  });

  test('a capture LINKED to the job (rung 10) is evidence, via job_link', async () => {
    const linked = await capture({ tenantId, jobId: null, text: 'any update on the part?', at: after });
    await insertJobCapture({ tenantId, jobId: jobB, captureId: linked.id });
    const found = (await listGapEvidence(tenantId, [ask(jobB)], 20)).find(
      (r) => r.capture.id === linked.id,
    );
    expect(found?.via.split(',')).toContain('job_link');
    expect(found?.jobId).toBe(jobB);
  });

  test('the job link respects the floor, and the floor is the CAPTURE’s time', async () => {
    const early = await capture({ tenantId, jobId: null, text: 'said before the floor', at: before });
    // The LINK is written now — long after the words.
    await insertJobCapture({ tenantId, jobId: jobB, captureId: early.id });
    const ids = (await listGapEvidence(tenantId, [ask(jobB)], 20)).map((r) => r.capture.id);
    expect(ids).not.toContain(early.id);
  });

  test('a job link cannot smuggle in ANOTHER firm’s words — evidence and activity alike', async () => {
    // LATER than anything already on jobB: if the link leaked, the job's latest
    // activity would move — a leak at the same instant could not be told apart.
    const foreign = await capture({
      tenantId: otherTenantId,
      jobId: null,
      text: "another firm's words, linked to our job",
      at: '2026-08-16T23:00:00.000Z',
    });
    const evidenceBefore = (await listGapEvidence(tenantId, [ask(jobB)], 20))[0]?.gapTotal ?? 0;
    const activityBefore = (await listJobActivitySince(tenantId, [jobB], FLOOR)).get(jobB);
    await pg.query('insert into job_captures (tenant_id, job_id, capture_id) values ($1, $2, $3)', [
      tenantId,
      jobB,
      foreign.id,
    ]);
    const rows = await listGapEvidence(tenantId, [ask(jobB)], 20);
    expect(rows.map((r) => r.capture.id)).not.toContain(foreign.id);
    expect(rows[0]?.gapTotal ?? 0).toBe(evidenceBefore);
    expect((await listJobActivitySince(tenantId, [jobB], FLOOR)).get(jobB)).toBe(activityBefore);
  });

  test('a stamped capture that is ALSO linked to its job comes back once, naming both arms', async () => {
    const stamped = await capture({ tenantId, jobId: jobA, text: 'stamped and linked', at: after });
    await insertJobCapture({ tenantId, jobId: jobA, captureId: stamped.id });
    const found = (await listGapEvidence(tenantId, [ask(jobA)], 20)).filter(
      (r) => r.capture.id === stamped.id,
    );
    expect(found).toHaveLength(1);
    expect(found[0].via.split(',')).toEqual(expect.arrayContaining(['job_stamp', 'job_link']));
  });

  test('an unstamped capture on BOTH a trip and a job link comes back once, naming both arms', async () => {
    // Reachable through the retraction twin-insert, which follows its target
    // onto every link it has.
    const both = await capture({ tenantId, jobId: null, text: 'linked twice', at: after });
    await reportedVisit({ tenantId, jobId: jobB, captureId: both.id });
    await insertJobCapture({ tenantId, jobId: jobB, captureId: both.id });
    const found = (await listGapEvidence(tenantId, [ask(jobB)], 20)).filter(
      (r) => r.capture.id === both.id,
    );
    expect(found).toHaveLength(1);
    expect(found[0].via.split(',')).toEqual(expect.arrayContaining(['visit_note', 'job_link']));
  });

  test('results carry their job and gap, and come back oldest-first within a gap', async () => {
    const rows = await listGapEvidence(tenantId, [ask(jobA), ask(jobB)], 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const jobId of [jobA, jobB]) {
      const mine = rows.filter((r) => r.gapId === `gap-${jobId}`);
      expect(mine.length).toBeGreaterThan(0);
      for (const r of mine) expect(r.jobId).toBe(jobId);
      const times = mine.map((r) => Date.parse(r.capture.captured_at));
      expect([...times].sort((x, y) => x - y)).toEqual(times);
    }
  });

  test('the NEWEST perGap come back, and gapTotal counts every one since the floor', async () => {
    const jobC = (
      await createJob({
        tenantId,
        customerId: (await createCustomer({ tenantId, name: 'Many Notes' })).id,
        title: 'many notes',
      })
    ).id;
    for (let i = 0; i < 8; i++) {
      await capture({ tenantId, jobId: jobC, text: `note ${i}`, at: `2026-08-16T13:0${i}:00.000Z` });
    }
    const rows = await listGapEvidence(tenantId, [ask(jobC)], 6);
    expect(rows.map((r) => r.capture.raw_text)).toEqual([
      'note 2',
      'note 3',
      'note 4',
      'note 5',
      'note 6',
      'note 7',
    ]);
    expect(rows.every((r) => r.gapTotal === 8)).toBe(true);
  });

  test('two gaps on ONE job each get their own floor and their own rows', async () => {
    const jobD = (
      await createJob({
        tenantId,
        customerId: (await createCustomer({ tenantId, name: 'Two Gaps' })).id,
        title: 'two gaps',
      })
    ).id;
    await capture({ tenantId, jobId: jobD, text: 'early answer', at: '2026-08-16T13:00:00.000Z' });
    await capture({ tenantId, jobId: jobD, text: 'late answer', at: '2026-08-16T15:00:00.000Z' });
    const rows = await listGapEvidence(tenantId, [
      ask(jobD, FLOOR, 'asked-early'),
      ask(jobD, '2026-08-16T14:00:00.000Z', 'asked-late'),
    ]);
    const forGap = (g: string) => rows.filter((r) => r.gapId === g).map((r) => r.capture.raw_text);
    expect(forGap('asked-early')).toEqual(['early answer', 'late answer']);
    expect(forGap('asked-late')).toEqual(['late answer']);
    expect(rows.find((r) => r.gapId === 'asked-late')?.gapTotal).toBe(1);
  });
});

describe('listJobActivitySince', () => {
  test('a job-linked capture is activity; a RETRACTED note is not', async () => {
    const jobE = (
      await createJob({
        tenantId,
        customerId: (await createCustomer({ tenantId, name: 'Activity Emma' })).id,
        title: 'activity',
      })
    ).id;
    const linked = await capture({ tenantId, jobId: null, text: 'they wrote in', at: after });
    await insertJobCapture({ tenantId, jobId: jobE, captureId: linked.id });
    // Date.parse, not a string compare: the DB renders `…+00:00`.
    expect(Date.parse((await listJobActivitySince(tenantId, [jobE], FLOOR)).get(jobE) ?? '')).toBe(
      Date.parse(after),
    );

    // A later report, then withdrawn as recorded in error: the latest activity
    // falls back to the earlier capture, because a withdrawn report is no report.
    const later = '2026-08-16T16:00:00.000Z';
    const report = await capture({ tenantId, jobId: jobE, text: 'job done', at: later });
    expect(Date.parse((await listJobActivitySince(tenantId, [jobE], FLOOR)).get(jobE) ?? '')).toBe(
      Date.parse(later),
    );
    await capture({ tenantId, jobId: jobE, text: 'wrong job', at: later, retracts: report.id });
    expect(Date.parse((await listJobActivitySince(tenantId, [jobE], FLOOR)).get(jobE) ?? '')).toBe(
      Date.parse(after),
    );
  });
});

// ---- Rung 10: what was CREATED from a call ---------------------------------
//
// The planner's exact close for an inbound ask. Getting it wrong closes a live ask.
describe('readCaptureRecords / listL2CitingCapture', () => {
  test('empty input short-circuits', async () => {
    expect(await listL2CitingCapture(tenantId, [])).toEqual([]);
    expect(await readCaptureRecords(tenantId, [])).toEqual({ citing: [], retracted: [] });
  });

  test('a job and a visit minted from a capture both come back, named', async () => {
    const cap = await capture({ tenantId, jobId: null, text: 'they agreed we would come out', at: after });
    const customer = await createCustomer({ tenantId, name: 'Cited Customer' });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'cited work',
      sourceCaptureId: cap.id,
    });
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
      sourceCaptureId: cap.id,
    });
    const rows = await listL2CitingCapture(tenantId, [cap.id]);
    expect(rows.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(
      [`job:${job.id}`, `visit:${visit.id}`].sort(),
    );
    expect(rows.every((r) => r.captureId === cap.id && r.jobId === job.id)).toBe(true);
    // TENANT-SCOPED now: the same capture id asked for by another firm is nothing.
    expect(await listL2CitingCapture(otherTenantId, [cap.id])).toEqual([]);
  });

  test('a CANCELLED row is not an answer — the rollback must not close the ask', async () => {
    const cap = await capture({ tenantId, jobId: null, text: 'the race that lost', at: after });
    const customer = await createCustomer({ tenantId, name: 'Rolled Back' });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'rolled back',
      sourceCaptureId: cap.id,
    });
    await pg.query(`update jobs set status = 'cancelled' where id = $1`, [job.id]);
    expect(await listL2CitingCapture(tenantId, [cap.id])).toEqual([]);
  });

  test('a CUSTOMER minted from the capture comes back as its own kind', async () => {
    const cap = await capture({ tenantId, jobId: null, text: 'a stranger rang', at: after });
    const customer = await createCustomer({
      tenantId,
      name: 'Recorded Caller',
      sourceCaptureId: cap.id,
    });
    expect(await listL2CitingCapture(tenantId, [cap.id])).toEqual([
      { kind: 'customer', id: customer.id, captureId: cap.id, jobId: null },
    ]);
  });

  test('a capture RECORDED ONTO a job comes back as a link — and not when the job is cancelled', async () => {
    const cap = await capture({ tenantId, jobId: null, text: 'it was Tom all along', at: after });
    const customer = await createCustomer({ tenantId, name: 'Already Known' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'known work' });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: cap.id });
    expect(await listL2CitingCapture(tenantId, [cap.id])).toEqual([
      { kind: 'link', id: job.id, captureId: cap.id, jobId: job.id },
    ]);

    await pg.query(`update jobs set status = 'cancelled' where id = $1`, [job.id]);
    expect(await listL2CitingCapture(tenantId, [cap.id])).toEqual([]);
  });

  test('a capture ATTACHED TO A TRIP cites through the trip — the other shape a link takes', async () => {
    const cap = await capture({ tenantId, jobId: null, text: 'about Friday', at: after });
    const customer = await createCustomer({ tenantId, name: 'Attached Ana' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'in flight' });
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [],
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });
    await insertVisitNote({ tenantId, visitId: visit.id, captureId: cap.id });
    expect(await listL2CitingCapture(tenantId, [cap.id])).toEqual([
      { kind: 'note', id: visit.id, captureId: cap.id, jobId: job.id },
    ]);

    await updateVisitStatus(visit.id, 'cancelled', 'test');
    expect(await listL2CitingCapture(tenantId, [cap.id])).toEqual([]);
  });

  test('`retracted` names the input captures a manager has retracted — this firm only', async () => {
    const kept = await capture({ tenantId, jobId: null, text: 'a real call', at: after });
    const withdrawn = await capture({ tenantId, jobId: null, text: 'a mis-filed call', at: after });
    await capture({ tenantId, jobId: null, text: 'recorded in error', at: after, retracts: withdrawn.id });
    expect((await readCaptureRecords(tenantId, [kept.id, withdrawn.id])).retracted).toEqual([
      withdrawn.id,
    ]);
    expect((await readCaptureRecords(otherTenantId, [kept.id, withdrawn.id])).retracted).toEqual([]);
  });
});

describe('ids ride in the request body — no URL wall', () => {
  test('250 ids pass through every membership reader and the lowered-chunk readers', async () => {
    // PostgREST's gateway refuses a URL past ~8,192 bytes (~205 UUIDs, measured
    // on the local stack). The membership readers send their ids in an RPC body;
    // the `in.()` readers on the same tick path now chunk at 150.
    const ids = Array.from({ length: 250 }, () => randomUUID());
    expect(
      await listGapEvidence(
        tenantId,
        ids.map((id) => ask(id)),
      ),
    ).toEqual([]);
    expect(await listJobActivitySince(tenantId, ids, FLOOR)).toEqual(new Map());
    expect(await readCaptureRecords(tenantId, ids)).toEqual({ citing: [], retracted: [] });
    expect(await listJobsWithCustomerByIds(tenantId, ids)).toEqual([]);
    expect(await listJobIdsWithCostEvents(tenantId, ids)).toEqual([]);
  });
});
