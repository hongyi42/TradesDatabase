import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  captureHasLinkedL2,
  listJobEvidenceSince,
  listJobStampedCaptureTimes,
  listL2CitingCapture,
  listCapturesByThread,
  appendRawCapture,
} from './rawCaptures.js';
import { createCustomer } from './customers.js';
import { createJob, insertJobCapture } from './jobs.js';
import { createVisit, insertVisitNote, updateVisitStatus } from './visits.js';
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

  // ---- RUNG 10: the third home ---------------------------------------------
  //
  // An inbound call or email on an open job with no live trip links to the JOB
  // (`job_captures`). Before it existed such a capture was unstamped and
  // attached to nothing, so every evidence reader missed it and the job read
  // silent — a customer chasing an open job looked like silence.
  test('a capture LINKED to the job is evidence, via "job"', async () => {
    const linked = await capture({ tenantId, jobId: null, text: 'any update on the part?', at: after });
    await insertJobCapture({ tenantId, jobId: jobB, captureId: linked.id });
    const rows = await listJobEvidenceSince(tenantId, [jobB], FLOOR);
    const found = rows.find((r) => r.capture.id === linked.id);
    expect(found).toBeDefined();
    expect(found?.via).toBe('job');
    expect(found?.jobId).toBe(jobB);
  });

  test('the job link respects the floor, and the floor is the CAPTURE’s time', async () => {
    const early = await capture({ tenantId, jobId: null, text: 'said before the floor', at: before });
    // The LINK is written now — long after the words. The floor must read the
    // capture's own time, or a months-old email would re-enter the window the
    // moment somebody linked it.
    await insertJobCapture({ tenantId, jobId: jobB, captureId: early.id });
    const ids = (await listJobEvidenceSince(tenantId, [jobB], FLOOR)).map((r) => r.capture.id);
    expect(ids).not.toContain(early.id);
  });

  test('a job-stamped capture keeps job_stamp even when a job link also points at it', async () => {
    const stamped = await capture({ tenantId, jobId: jobA, text: 'stamped and linked', at: after });
    await insertJobCapture({ tenantId, jobId: jobA, captureId: stamped.id });
    const found = (await listJobEvidenceSince(tenantId, [jobA], FLOOR)).filter(
      (r) => r.capture.id === stamped.id,
    );
    expect(found).toHaveLength(1);
    expect(found[0].via).toBe('job_stamp'); // the direct link is the stronger claim
  });

  test('a job link cannot smuggle in ANOTHER firm’s words', async () => {
    // `job_captures.capture_id` is an ID-ONLY foreign key, so the link's own
    // tenant is no proof the words are ours. Without the re-check on the
    // embedded capture, this row reaches the planner as citeable evidence.
    const foreign = await capture({
      tenantId: otherTenantId,
      jobId: null,
      text: "another firm's words, linked to our job",
      at: after,
    });
    const evidenceBefore = (await listJobEvidenceSince(tenantId, [jobB], FLOOR)).length;
    const timesBefore = (await listJobStampedCaptureTimes(tenantId, [jobB], FLOOR)).length;
    await pg.query(
      'insert into job_captures (tenant_id, job_id, capture_id) values ($1, $2, $3)',
      [tenantId, jobB, foreign.id],
    );
    const rows = await listJobEvidenceSince(tenantId, [jobB], FLOOR);
    expect(rows.map((r) => r.capture.id)).not.toContain(foreign.id);
    // Both readers: the link adds NOTHING, because the words are not ours.
    expect(rows).toHaveLength(evidenceBefore);
    expect(await listJobStampedCaptureTimes(tenantId, [jobB], FLOOR)).toHaveLength(timesBefore);
  });

  test('a capture with BOTH links keeps the visit provenance — the stronger claim', async () => {
    // Reachable through the retraction twin-insert, which follows its target
    // onto every link it has. "It reported this trip" is a more specific claim
    // than "it landed on this job", so the visit arm must win.
    const both = await capture({ tenantId, jobId: null, text: 'linked twice', at: after });
    await reportedVisit({ tenantId, jobId: jobB, captureId: both.id });
    await insertJobCapture({ tenantId, jobId: jobB, captureId: both.id });
    const found = (await listJobEvidenceSince(tenantId, [jobB], FLOOR)).filter(
      (r) => r.capture.id === both.id,
    );
    expect(found).toHaveLength(1); // deduped, not returned twice
    expect(found[0].via).toBe('visit');
  });

  test('a job link alone marks the capture PROCESSED — the redelivery short-circuit', async () => {
    const linked = await capture({ tenantId, jobId: null, text: 'processed by its link', at: after });
    expect(await captureHasLinkedL2(linked.id)).toBe(false);
    await insertJobCapture({ tenantId, jobId: jobA, captureId: linked.id });
    expect(await captureHasLinkedL2(linked.id)).toBe(true);
  });

  test('the watcher’s activity probe sees a job-linked capture too', async () => {
    const linked = await capture({ tenantId, jobId: null, text: 'they wrote in', at: after });
    await insertJobCapture({ tenantId, jobId: jobB, captureId: linked.id });
    const times = await listJobStampedCaptureTimes(tenantId, [jobB], FLOOR);
    // Date.parse, not a string compare: the DB renders `…T13:00:00+00:00` while
    // the fixture wrote `…T13:00:00.000Z` — the same instant, different text.
    expect(
      times.some((t) => t.job_id === jobB && Date.parse(t.captured_at) === Date.parse(after)),
    ).toBe(true);
  });

  test('results carry their job and come back oldest-first', async () => {
    const rows = await listJobEvidenceSince(tenantId, [jobA, jobB], FLOOR);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect([jobA, jobB]).toContain(r.jobId);
    const times = rows.map((r) => r.capture.captured_at);
    expect([...times].sort()).toEqual(times);
  });
});

// ---- Rung 10: what was CREATED from a call ---------------------------------
//
// This is the planner's exact close for an inbound ask: a job or visit whose
// source_capture_id is the call. Getting it wrong closes a live ask.
describe('listL2CitingCapture', () => {
  test('empty input short-circuits', async () => {
    expect(await listL2CitingCapture([])).toEqual([]);
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
    const rows = await listL2CitingCapture([cap.id]);
    expect(rows.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(
      [`job:${job.id}`, `visit:${visit.id}`].sort(),
    );
    expect(rows.every((r) => r.captureId === cap.id && r.jobId === job.id)).toBe(true);
  });

  test('a CANCELLED row is not an answer — the rollback must not close the ask', async () => {
    // bookVisit rolls back a shell it minted when the DB overlap guard fires,
    // by flipping it to 'cancelled' — the stamp stays. Counting it would tell
    // the planner "a job was created from this call", close the ask on the
    // record, and leave a customer who was told someone is coming with nothing
    // on the calendar and nobody left asking.
    const cap = await capture({ tenantId, jobId: null, text: 'the race that lost', at: after });
    const customer = await createCustomer({ tenantId, name: 'Rolled Back' });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'rolled back',
      sourceCaptureId: cap.id,
    });
    await pg.query(`update jobs set status = 'cancelled' where id = $1`, [job.id]);
    expect(await listL2CitingCapture([cap.id])).toEqual([]);
  });

  // RUNG 10B: two more kinds, because "nothing was created" is not the hole
  // `inbound_unmatched` names. That one asks WHO CALLED, and it is answered by
  // the caller having been identified.
  test('a CUSTOMER minted from the capture comes back as its own kind', async () => {
    const cap = await capture({ tenantId, jobId: null, text: 'a stranger rang', at: after });
    const customer = await createCustomer({
      tenantId,
      name: 'Recorded Caller',
      sourceCaptureId: cap.id,
    });
    const rows = await listL2CitingCapture([cap.id]);
    expect(rows).toEqual([
      { kind: 'customer', id: customer.id, captureId: cap.id, jobId: null },
    ]);
  });

  test('a capture RECORDED ONTO a job comes back as a link — and not when the job is cancelled', async () => {
    // This is what LINKING a caller we already knew leaves behind: no new row
    // cites the capture, only a `job_captures` row tying it to their job.
    const cap = await capture({ tenantId, jobId: null, text: 'it was Tom all along', at: after });
    const customer = await createCustomer({ tenantId, name: 'Already Known' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'known work' });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: cap.id });
    expect(await listL2CitingCapture([cap.id])).toEqual([
      { kind: 'link', id: job.id, captureId: cap.id, jobId: job.id },
    ]);

    await pg.query(`update jobs set status = 'cancelled' where id = $1`, [job.id]);
    expect(await listL2CitingCapture([cap.id])).toEqual([]);
  });

  test('listCapturesByThread reads the thread oldest-first, and never a RETRACTED message', async () => {
    // The fallback when Composio cannot hand us the conversation. A retracted
    // capture must not come back: the write-path treats it as terminal precisely
    // so it can never be rebuilt from, and handing its words to the extractor as
    // context would launder them into L2 against the NEW capture.
    const thread = `fallback-${Date.now()}`;
    // Appended WITH their metadata: L1 is append-only, so there is no later
    // update that could add it — which is the whole reason the thread id had to
    // be captured at the door in the first place.
    let msg = 0;
    const onThread = async (text: string) =>
      await appendRawCapture({
        tenantId,
        channel: 'email',
        technicianRef: 'connector:gmail',
        rawText: text,
        externalId: `${thread}-m${msg++}`,
        metadata: { threadId: thread, from: 'jane@home.test' },
      });
    await onThread('my number is 555-0199');
    await onThread('and my gate code is 4412');
    const bad = await onThread('personal, recorded in error');
    await appendRawCapture({
      tenantId,
      channel: 'manual_correction',
      technicianRef: 'tech-a',
      rawText: 'that one was recorded in error',
      retractsCaptureId: bad.id,
    });
    const read = await listCapturesByThread(tenantId, thread);
    expect(read.messages.map((r) => r.body)).toEqual([
      'my number is 555-0199',
      'and my gate code is 4412',
    ]);
    expect(read.messages[0].from).toBe('jane@home.test');
    // …and the retracted one comes back as something the OTHER source must not
    // show either — Gmail knows nothing of our retractions.
    expect(read.blockedMessageIds).toEqual([bad.external_id]);
  });

  test('a capture ATTACHED TO A TRIP cites through the trip — the other shape a link takes', async () => {
    // When the job already has a visit, the capture attaches to the VISIT and no
    // job_captures row is written at all. Without this arm a reply landing on a
    // booked job would cite nothing, and its item could never become moot.
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
    expect(await listL2CitingCapture([cap.id])).toEqual([
      { kind: 'note', id: visit.id, captureId: cap.id, jobId: job.id },
    ]);

    // A CANCELLED trip is not an answer, the same as every other arm.
    await updateVisitStatus(visit.id, 'cancelled', 'test');
    expect(await listL2CitingCapture([cap.id])).toEqual([]);
  });
});
