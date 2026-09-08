import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { appendRawCapture } from '../db/rawCaptures.js';
import type { Json } from '../db/database.types.js';
import { createCustomer } from '../db/customers.js';
import { createJob, listJobsForCustomer } from '../db/jobs.js';
import { createVisit } from '../db/visits.js';
import { insertTechnician } from '../db/technicians.js';
import { setTenantSeats } from '../db/tenants.js';
import { localDateISO } from '../schedule/availability.js';
import { NOTE_SIGNAL_TRANSITIONS, recordFieldNote } from './recordFieldNote.js';
import { ALLOWED_TRANSITIONS, type JobStatus } from '../db/jobs.js';
import type { Extractor, ExtractedFields } from './extract.js';

// Integration test against the TEST project with a STUBBED extractor (no live
// model), exercising the full L1 → extract → match → L2/L3 write-path.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  // ORDER BY, and it is load-bearing rather than tidiness. These suites mean
  // "the SEED tenant" — the one `npm run seed:local` builds, whose timezone is
  // America/Los_Angeles, which this file hardcodes when it computes a firm-local
  // day. An unordered limit(1) returns an ARBITRARY row, and the local stack
  // accumulates a tenant per integration run (1000+ of them), so it reliably
  // picked a test-created tenant instead — whose timezone is the UTC default.
  // The matcher then looked for the visit on the UTC day while the fixture
  // booked it on the LA day, found nothing, and returned needs_disambiguation.
  // Time-of-day dependent, so it passed all morning and failed after 5pm Pacific.
  const { data, error } = await getClient().from('tenants').select('id').order('created_at', { ascending: true }).limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query(
    'truncate table customers, jobs, visits, raw_captures, technicians, schedule_events, ' +
      'observations, job_captures cascade',
  );
  await pg.end();
});

const stub = (fields: ExtractedFields): { extract: Extractor } => ({ extract: async () => fields });

async function rawCaptureCount(): Promise<number> {
  const { rows } = await pg.query<{ n: string }>('select count(*)::int as n from raw_captures');
  return Number(rows[0].n);
}

async function visitCount(): Promise<number> {
  const { rows } = await pg.query<{ n: string }>('select count(*)::int as n from visits');
  return Number(rows[0].n);
}

// The rung-10 readers: what LANDED on the job, and what was ASKED about a
// capture. Read straight from SQL, never through the code under test.
async function jobCaptureLinks(jobId: string): Promise<number> {
  const { rows } = await pg.query<{ n: string }>(
    'select count(*)::int as n from job_captures where job_id = $1',
    [jobId],
  );
  return Number(rows[0].n);
}

async function observationsFor(captureId: string): Promise<
  { kind: string; status: string; context: Record<string, unknown> }[]
> {
  const { rows } = await pg.query<{ kind: string; status: string; context: Record<string, unknown> }>(
    'select kind, status, context from observations where subject_ref = $1',
    [captureId],
  );
  return rows;
}

async function jobAttributes(jobId: string): Promise<Record<string, unknown>> {
  const { rows } = await pg.query<{ attributes: Record<string, unknown> }>(
    'select attributes from jobs where id = $1',
    [jobId],
  );
  return rows[0].attributes;
}

// ---- Rung 9b phase 3: a note ATTACHES to the trip it reports ----------------
//
// The old shape minted a visit per note, which meant two technicians on one crew
// produced two trips and one technician filing twice produced two more. `visits`
// is the schedule now, so these pin which trip a note lands on.
//
// TIMES ARE RELATIVE TO THE FIRM'S CURRENT DAY, not a fixed date: `captured_at`
// is stamped by the database at insert and cannot be injected, so a fixture on a
// future day would always read as "filed before the visit". The visit is placed
// to span today instead, which holds whatever time the suite runs at. The one
// exception is the before-the-start case, which needs a visit still to come and
// so books the last two minutes of the day — it would misjudge only if the suite
// ran inside them (the date-eval midnight rule, applied here).
describe('a field note attaches to its trip (rung 9b)', () => {
  const TZ = 'America/Los_Angeles';
  let DAY: string;
  let TOMORROW: string;
  let YESTERDAY: string;
  const naive = (hhmm: string, day?: string) => `${day ?? DAY}T${hhmm}:00.000Z`;

  let phoneSeq = 7000;
  let techSeq = 0;
  async function jobFor(name: string) {
    // Identity matches on the PHONE, so every fixture carries a distinct one
    // and hands it back for the stub to echo.
    const phone = `555-${phoneSeq++}`;
    const customer = await createCustomer({ tenantId, name, phone });
    const job = await createJob({ tenantId, customerId: customer.id, title: `${name} work` });
    return { customer, job, phone };
  }
  // A technician PER TEST: they all place visits on the same day, and one
  // person cannot hold two overlapping confirmed visits (no_confirmed_overlap).
  // seatExempt: these fixtures must not consume the tenant's technician seats —
  // the file's other suites insert their own roster rows and would hit
  // seat_cap_exceeded behind us.
  const freshTech = async () =>
    (await insertTechnician({
      tenantId,
      ref: `attach-tech-${techSeq++}`,
      displayName: `Attach Tech ${techSeq}`,
      seatExempt: true,
    })).id;
  const placed = (
    jobId: string,
    from: string,
    to: string,
    technicianId: string | null,
    day?: string,
  ) =>
    createVisit({
      tenantId,
      jobId,
      technicianId,
      startsAt: naive(from, day),
      endsAt: naive(to, day),
      status: 'confirmed',
    });
  const noteLinks = async (visitId: string) => {
    const { rows } = await pg.query<{ n: string }>(
      'select count(*)::int as n from visit_notes where visit_id = $1',
      [visitId],
    );
    return Number(rows[0].n);
  };
  const visitRow = async (id: string) => {
    const { rows } = await pg.query('select * from visits where id = $1', [id]);
    return rows[0] as { status: string; completed_at: string | null; labor_hours: string | null };
  };
  const noteBy = (ref: string, channel: 'technician_note' | 'email', text: string) => ({
    tenantId,
    technicianRef: ref,
    channel,
    text,
  });

  beforeAll(async () => {
    await pg.query('update tenants set timezone = $1 where id = $2', [TZ, tenantId]);
    DAY = localDateISO(new Date().toISOString(), TZ);
    const shift = (days: number) =>
      localDateISO(new Date(Date.now() + days * 86_400_000).toISOString(), TZ);
    TOMORROW = shift(1);
    YESTERDAY = shift(-1);
  });

  test('a note on the visit’s own day ATTACHES to it — no second row, and it reads as happened', async () => {
    const { job, phone } = await jobFor('Attach Amy');
    const tech = await freshTech();
    const visit = await placed(job.id, '00:00', '23:59', tech);
    const before = await visitCount();
    const r = await recordFieldNote(
      noteBy(`attach-tech-${techSeq - 1}`, 'technician_note', 'all done'),
      stub({ phone, customerName: 'Attach Amy', jobTitle: 'Attach Amy work', laborHours: 2 }),
    );
    expect(r.visitId).toBe(visit.id); // the SAME trip, not a new one
    expect(await visitCount()).toBe(before);
    expect(await noteLinks(visit.id)).toBe(1);
    const row = await visitRow(visit.id);
    expect(row.status).toBe('completed'); // a report is evidence the trip happened
    expect(row.completed_at).not.toBeNull();
    expect(Number(row.labor_hours)).toBe(2); // the note's hours landed on the trip
    expect(r.stage).toBe('reported');
  });

  test('two notes about one trip make ONE visit and TWO links, and the hours ACCUMULATE', async () => {
    const { job, phone } = await jobFor('Crew Cass');
    const visit = await placed(job.id, '00:00', '23:59', null); // unassigned: anyone may report
    const before = await visitCount();
    for (const [i, hours] of [1.5, 2].entries()) {
      const ref = `crew-tech-${i}`;
      await insertTechnician({ tenantId, ref, displayName: `Crew ${i}`, seatExempt: true });
      await recordFieldNote(
        noteBy(ref, 'technician_note', `did ${hours}h`),
        stub({ phone, customerName: 'Crew Cass', jobTitle: 'Crew Cass work', laborHours: hours }),
      );
    }
    expect(await visitCount()).toBe(before); // still ONE trip
    expect(await noteLinks(visit.id)).toBe(2);
    // Two people on one crew each report their own hours; the trip cost both.
    expect(Number((await visitRow(visit.id)).labor_hours)).toBe(3.5);
  });

  test('a CREW visit: EITHER person closes it, and the partner row never existed to strand', async () => {
    // The bug this rung removes: two people on one trip used to be two visits,
    // so the one who filed closed HERS and his sat 'confirmed' forever — chased
    // by the watcher for a report that had already been written.
    //
    // The closer is the SECOND-added participant on purpose. Filing as the
    // first one would pass even if the rule still matched a single column.
    const { job, phone } = await jobFor('Duo Dana');
    const first = await freshTech();
    const firstRef = `attach-tech-${techSeq - 1}`;
    const second = await freshTech();
    const secondRef = `attach-tech-${techSeq - 1}`;
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [first, second],
      startsAt: naive('00:00'),
      endsAt: naive('23:59'),
      status: 'confirmed',
    });
    // A SECOND live visit on the job, so step 2 ("the job's one live visit")
    // cannot rescue a step-1 miss. Without it this test passes even when the
    // rule is still a single-column match — which is the regression it exists
    // to catch.
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [first],
      startsAt: naive('09:00', TOMORROW),
      endsAt: naive('10:00', TOMORROW),
      status: 'confirmed',
    });
    expect(firstRef).not.toBe(secondRef);
    const before = await visitCount();
    const r = await recordFieldNote(
      noteBy(secondRef, 'technician_note', 'we finished it'),
      stub({ phone, customerName: 'Duo Dana', jobTitle: 'Duo Dana work', laborHours: 3 }),
    );
    expect(r.visitId).toBe(visit.id); // THE trip, not a second one
    expect(await visitCount()).toBe(before);
    const row = await visitRow(visit.id);
    expect(row.status).toBe('completed'); // done for BOTH of them
    // And the crew is intact — closing it did not take anybody off.
    const { rows: crew } = await pg.query<{ n: string }>(
      'select count(*)::int as n from visit_participants where visit_id = $1',
      [visit.id],
    );
    expect(Number(crew[0].n)).toBe(2);
  });

  test('a technician who is NOT on the trip falls through to step 3 and gets their own', async () => {
    const { job, phone } = await jobFor('Outside Otto');
    const onIt = await freshTech();
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [onIt],
      startsAt: naive('00:00'),
      endsAt: naive('23:59'),
      status: 'confirmed',
    });
    // A SECOND live visit on the job, so step 2 ("the job's one live visit")
    // cannot resolve it either — otherwise every note lands on the only trip
    // regardless of who is on it, and step 1 is never the deciding rule.
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [onIt],
      startsAt: naive('09:00', TOMORROW),
      endsAt: naive('10:00', TOMORROW),
      status: 'confirmed',
    });
    const stranger = await freshTech();
    const strangerRef = `attach-tech-${techSeq - 1}`;
    expect(stranger).not.toBe(onIt);
    const before = await visitCount();
    const r = await recordFieldNote(
      noteBy(strangerRef, 'technician_note', 'I went too, separately'),
      stub({ phone, customerName: 'Outside Otto', jobTitle: 'Outside Otto work' }),
    );
    // Step 1 does not match — the filer is not on today's trip, so it is NOT
    // closed on their say-so — and step 2 cannot pick between two live visits,
    // so a trip with no booking behind it is created, as it always was.
    expect(await visitCount()).toBe(before + 1);
    const { rows } = await pg.query<{ n: string }>(
      'select count(*)::int as n from visit_participants where visit_id = $1',
      [r.visitId],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  test('a note filed BEFORE the visit starts attaches as evidence, and leaves it PLACED', async () => {
    const { job, phone } = await jobFor('Early Ed');
    const tech = await freshTech();
    // TOMORROW, not the last two minutes of today: a fixture that depends on the
    // suite not running near local midnight is a fixture that fails at 23:58.
    // It also exercises step 2 of the attach rule — the job's ONE live visit,
    // whatever day it sits on — which no same-day fixture reaches.
    const visit = await placed(job.id, '00:00', '01:00', tech, TOMORROW); // still to come
    const r = await recordFieldNote(
      noteBy(`attach-tech-${techSeq - 1}`, 'technician_note', 'running late, customer knows'),
      stub({ phone, customerName: 'Early Ed', jobTitle: 'Early Ed work' }),
    );
    expect(r.visitId).toBe(visit.id);
    expect(await noteLinks(visit.id)).toBe(1);
    // NOT completed: marking it done would close the very gap this note is
    // often complaining about.
    expect((await visitRow(visit.id)).status).toBe('confirmed');
  });

  test('with two visits that day, the note lands on the one THIS technician holds', async () => {
    const { job, phone } = await jobFor('Split Sam');
    const otherTech = await freshTech();
    const theirs = await placed(job.id, '00:00', '12:00', otherTech);
    const mineTech = await freshTech();
    const mineRef = `attach-tech-${techSeq - 1}`;
    const mine = await placed(job.id, '00:00', '23:59', mineTech);
    const r = await recordFieldNote(
      noteBy(mineRef, 'technician_note', 'mine, the long one'),
      stub({ phone, customerName: 'Split Sam', jobTitle: 'Split Sam work' }),
    );
    expect(r.visitId).toBe(mine.id);
    expect(r.visitId).not.toBe(theirs.id);
  });

  test('yesterday’s trip, reported this morning: the job’s ONE live visit still takes it', async () => {
    // Step 2 of the attach rule. The common shape — a technician writes up the
    // day after — and the one a same-day rule alone would get wrong by minting
    // a second trip for work that already has one.
    const { job, phone } = await jobFor('Late Larry');
    const visit = await placed(job.id, '09:00', '11:00', await freshTech(), YESTERDAY);
    const before = await visitCount();
    const r = await recordFieldNote(
      noteBy(`attach-tech-${techSeq - 1}`, 'technician_note', 'wrote it up this morning'),
      stub({ phone, customerName: 'Late Larry', jobTitle: 'Late Larry work' }),
    );
    expect(r.visitId).toBe(visit.id);
    expect(await visitCount()).toBe(before); // no second trip
    expect((await visitRow(visit.id)).status).toBe('completed'); // filed after it ran
  });

  test('an inbound email NEVER marks a trip happened — the detector must keep asking', async () => {
    // The failure this prevents: a customer emails "nobody ever showed up" at
    // 10am for a 9am visit. Attaching is right — that IS evidence about the
    // trip. Flipping it to completed would delete it from the overdue detector
    // (confirmed-only) forever, silencing the alarm with the complaint.
    const { job, phone } = await jobFor('Nobody Nora');
    const visit = await placed(job.id, '00:00', '23:59', await freshTech());
    const r = await recordFieldNote(
      noteBy('connector:gmail', 'email', 'nobody ever showed up today'),
      stub({ phone, customerName: 'Nobody Nora', jobTitle: 'Nobody Nora work', laborHours: 9 }),
    );
    expect(r.visitId).toBe(visit.id); // attached — the evidence is linked
    const row = await visitRow(visit.id);
    expect(row.status).toBe('confirmed'); // and STILL overdue-detectable
    expect(row.completed_at).toBeNull();
    // A customer's mail cannot edit the trip's billing hours either.
    expect(row.labor_hours).toBeNull();
  });

  test('no visit to attach to → a technician note CREATES one, already happened and untimed', async () => {
    const { phone } = await jobFor('Walkin Wanda');
    await freshTech();
    const before = await visitCount();
    const r = await recordFieldNote(
      noteBy(`attach-tech-${techSeq - 1}`, 'technician_note', 'walk-in, fixed it'),
      stub({ phone, customerName: 'Walkin Wanda', jobTitle: 'Walkin Wanda work', laborHours: 1 }),
    );
    expect(await visitCount()).toBe(before + 1); // the walk-in IS a trip
    expect(r.visitId).toBeDefined();
    const row = await visitRow(r.visitId as string);
    expect(row.status).toBe('completed');
    expect(row.completed_at).not.toBeNull();
  });

  test('an INBOUND email attaches to a booked visit — attach is channel-blind, create is not', async () => {
    // THE ENTRY CRITERION for this phase. Phase 1 gated the whole visit step on
    // a technician channel, which left a customer's own answer linked to
    // nothing: invisible to the planner's evidence read and to the watcher's
    // activity probe, so a gap the customer had already answered still looked
    // unanswered.
    const { job, phone } = await jobFor('Inbound Ida');
    const visit = await placed(job.id, '00:00', '23:59', await freshTech());
    const before = await visitCount();
    const r = await recordFieldNote(
      noteBy('connector:gmail', 'email', 'yes, someone came out this morning — all good'),
      stub({ phone, customerName: 'Inbound Ida', jobTitle: 'Inbound Ida work' }),
    );
    expect(r.visitId).toBe(visit.id); // ATTACHED
    expect(await visitCount()).toBe(before); // and created NOTHING
    expect(await noteLinks(visit.id)).toBe(1);
  });

  test('an INBOUND email with no visit to attach to creates NOTHING — a customer’s email is not a trip', async () => {
    const { phone } = await jobFor('Emailer Eve');
    const before = await visitCount();
    const r = await recordFieldNote(
      noteBy('connector:gmail', 'email', 'any update?'),
      stub({ phone, customerName: 'Emailer Eve', jobTitle: 'Emailer Eve work' }),
    );
    expect(r.visitId).toBeUndefined();
    expect(await visitCount()).toBe(before);
  });

  test('RUNG 10 CLOSED IT: an inbound capture on a live job LINKS, so a redelivery cannot re-apply a stale signal', async () => {
    // Was pinned as an OPEN gap. An inbound capture on a job with no live visit
    // linked NOTHING, so captureHasLinkedL2 could not short-circuit it: a
    // redelivery re-ran the extractor, and a `completed` signal correctly
    // SKIPPED on pass 1 (the job was still 'open') became legal once the job
    // reached 'in_progress' — a five-week-old email closing a job late.
    // `job_captures` is the link that closes it.
    const { job, phone } = await jobFor('Stale Stan'); // deliberately NO visit
    const note = {
      ...noteBy('connector:gmail', 'email' as const, 'all finished on our end'),
      externalId: 'gmail-stale-signal-1',
    };
    const ext = { phone, customerName: 'Stale Stan', statusSignal: 'completed' as const };
    const first = await recordFieldNote(note, stub(ext));
    expect(first.visitId).toBeUndefined(); // no trip attaches — still true
    expect(await jobCaptureLinks(job.id)).toBe(1); // …but the JOB now carries it
    const { rows: after1 } = await pg.query<{ status: string }>(
      'select status from jobs where id = $1',
      [job.id],
    );
    expect(after1[0].status).toBe('open'); // 'completed' is not legal from 'open'

    // The job moves on, then the same message is delivered again.
    await pg.query("update jobs set status = 'in_progress' where id = $1", [job.id]);
    const second = await recordFieldNote(note, stub(ext));
    expect(second.status).toBe('duplicate'); // the link makes it a real duplicate
    expect(second.captureId).toBe(first.captureId);
    const { rows: after2 } = await pg.query<{ status: string }>(
      'select status from jobs where id = $1',
      [job.id],
    );
    // THE FIX: the stale signal never lands.
    expect(after2[0].status).toBe('in_progress');
  });

  test('a redelivered note is a DUPLICATE once its link exists — the hole phase 1 accepted', async () => {
    // Phase 1 accepted a re-run here because nothing carried the capture id.
    // With the note linked to a trip, captureHasLinkedL2 sees it and the second
    // delivery short-circuits — no repeat extractor call, and no chance for a
    // stale forward status signal to land late on a job that has since moved on.
    const { job, phone } = await jobFor('Redeliver Rita');
    await placed(job.id, '00:00', '23:59', await freshTech());
    const note = {
      ...noteBy('connector:gmail', 'email' as const, 'confirming the visit happened'),
      externalId: 'gmail-attach-dedup-1',
    };
    const first = await recordFieldNote(note, stub({ phone, customerName: 'Redeliver Rita' }));
    expect(first.status).toBe('matched');
    expect(first.visitId).toBeDefined();
    const second = await recordFieldNote(note, stub({ phone, customerName: 'Redeliver Rita' }));
    expect(second.status).toBe('duplicate');
    expect(second.captureId).toBe(first.captureId);
  });
});

describe('recordFieldNote', () => {
  test('matched note writes L1 + reuses customer + creates job/visit with provenance & labor hours; a completed-signal on a new (open) job is skipped, not thrown', async () => {
    const customer = await createCustomer({ tenantId, name: 'Reuse Me', phone: '555-0177' });

    const r = await recordFieldNote(
      { tenantId, technicianRef: 'tech-jane', channel: 'technician_voice', text: 'note text' },
      stub({
        phone: '555-0177',
        workPerformed: 'Replaced capacitor',
        laborHours: 2.5,
        statusSignal: 'completed', // illegal from 'open' → must be skipped, not throw
      }),
    );

    expect(r.status).toBe('matched');
    expect(r.customerId).toBe(customer.id);
    expect(r.jobId).toBeDefined();
    expect(r.visitId).toBeDefined();

    // Cross-channel read-back via direct pg.
    const cap = await pg.query<{ channel: string; customer_id: string | null; technician_ref: string | null }>(
      'select channel, customer_id, technician_ref from raw_captures where id = $1',
      [r.captureId],
    );
    expect(cap.rows[0].channel).toBe('technician_voice');
    expect(cap.rows[0].customer_id).toBeNull(); // append-only: provenance not back-written
    expect(cap.rows[0].technician_ref).toBe('tech-jane'); // person attribution on L1

    const job = await pg.query<{ status: string }>('select status from jobs where id = $1', [r.jobId]);
    expect(job.rows[0].status).toBe('open'); // completed-signal skipped, no throw

    const visit = await pg.query<{
      labor_hours: string | null;
      source_capture_id: string | null;
      status: string;
      completed_at: string | null;
    }>(
      'select labor_hours, source_capture_id, status, completed_at from visits where id = $1',
      [r.visitId],
    );
    expect(Number(visit.rows[0].labor_hours)).toBe(2.5);
    expect(visit.rows[0].source_capture_id).toBe(r.captureId);
    // Rung 9b: a reported trip is a COMPLETED visit on the one visits table,
    // and the note reaches it through visit_notes rather than owning it.
    expect(visit.rows[0].status).toBe('completed');
    expect(visit.rows[0].completed_at).not.toBeNull();
    const link = await pg.query<{ n: string }>(
      'select count(*)::int as n from visit_notes where visit_id = $1 and capture_id = $2',
      [r.visitId, r.captureId],
    );
    expect(Number(link.rows[0].n)).toBe(1);
  });

  test('note signals drive the WORK dimension only: invoiced ignores a late "done", completed reopens on "underway"', async () => {
    const { updateJobStatus } = await import('../db/jobs.js');
    // A job already in the money tail: a stale "job done" note must not demote it.
    const invCust = await createCustomer({ tenantId, name: 'Invoiced Cust', phone: '555-0311' });
    const invJob = await createJob({ tenantId, customerId: invCust.id, title: 'done and billed' });
    await updateJobStatus(invJob.id, 'in_progress');
    await updateJobStatus(invJob.id, 'completed');
    await updateJobStatus(invJob.id, 'invoiced');
    const r1 = await recordFieldNote(
      { tenantId, technicianRef: 'tech-jane', channel: 'technician_note', text: 'all wrapped up' },
      stub({ phone: '555-0311', statusSignal: 'completed' }),
    );
    expect(r1.jobId).toBe(invJob.id); // invoiced is non-terminal → reused for the note
    const inv = await pg.query<{ status: string }>('select status from jobs where id = $1', [invJob.id]);
    expect(inv.rows[0].status).toBe('invoiced'); // NOT demoted (money-ledger review finding)

    // The blessed reopen: field activity on a completed job revives it.
    const reCust = await createCustomer({ tenantId, name: 'Reopen Cust', phone: '555-0312' });
    const reJob = await createJob({ tenantId, customerId: reCust.id, title: 'not quite done' });
    await updateJobStatus(reJob.id, 'in_progress');
    await updateJobStatus(reJob.id, 'completed');
    const r2 = await recordFieldNote(
      { tenantId, technicianRef: 'tech-jane', channel: 'technician_note', text: 'back out here, leak returned' },
      stub({ phone: '555-0312', statusSignal: 'in_progress' }),
    );
    expect(r2.jobId).toBe(reJob.id);
    const re = await pg.query<{ status: string }>('select status from jobs where id = $1', [reJob.id]);
    expect(re.rows[0].status).toBe('in_progress'); // reopened via the new completed→in_progress edge
  });

  test('NOTE_SIGNAL_TRANSITIONS is a strict subset of the machine (pinned invariant)', () => {
    for (const [from, signals] of Object.entries(NOTE_SIGNAL_TRANSITIONS)) {
      for (const sig of signals ?? []) {
        expect(ALLOWED_TRANSITIONS[from as JobStatus]).toContain(sig);
      }
    }
  });

  test('stale reopen guard: a note captured BEFORE completion cannot resurrect the job', async () => {
    const { updateJobStatus } = await import('../db/jobs.js');
    const { appendRawCapture: append } = await import('../db/rawCaptures.js');
    const cust = await createCustomer({ tenantId, name: 'Stale Reopen Cust', phone: '555-0313' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'late transcript' });
    // The mid-job note lands in L1 first (delivery pending)…
    const early = await append({
      tenantId, channel: 'phone_call', technicianRef: 'tech-jane',
      rawText: 'on site, starting the swap', externalId: 'stale-reopen-probe-1',
    });
    // …then the job completes…
    await updateJobStatus(job.id, 'in_progress');
    await updateJobStatus(job.id, 'completed');
    // …then the delayed delivery re-arrives and heals the orphan capture.
    const r = await recordFieldNote(
      {
        tenantId, technicianRef: 'tech-jane', channel: 'phone_call',
        text: 'on site, starting the swap', externalId: 'stale-reopen-probe-1',
      },
      stub({ phone: '555-0313', statusSignal: 'in_progress' }),
    );
    expect(r.captureId).toBe(early.id); // healed the SAME capture (captured_at is the early time)
    const row = await pg.query<{ status: string }>('select status from jobs where id = $1', [job.id]);
    expect(row.rows[0].status).toBe('completed'); // stale signal skipped — no resurrection
  });

  test('inbound contract: an unmatched note proposes the scheduled address (L1 kept, no L2)', async () => {
    const tech = 'tech-sched-rfn';
    // FIRM-local today (seed tenant tz): the matcher consults the capture's
    // firm-local day, so the fixture books there, not on the UTC date.
    const day = localDateISO(new Date().toISOString(), 'America/Los_Angeles');
    // The schedule matchIdentity consults = confirmed assignments; a roster
    // row + a customer whose address the suggestion must surface. The customer
    // gets a UNIQUE phone but the extraction below carries none, so step-1
    // dedup cannot short-circuit the schedule branch.
    await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
    const roster = await insertTechnician({ tenantId, ref: tech, displayName: 'RFN Sched' });
    const sheetCust = await createCustomer({
      tenantId,
      name: 'Sheet Cust',
      phone: '555-7700',
      addressLine1: '88 Sheet St',
    });
    const schedJob = await createJob({ tenantId, customerId: sheetCust.id, title: 'rfn visit' });
    await createVisit({
      tenantId,
      jobId: schedJob.id,
      technicianId: roster.id,
      startsAt: `${day}T12:00:00.000Z`,
      endsAt: `${day}T14:00:00.000Z`,
      status: 'confirmed',
    });

    const first = await recordFieldNote(
      { tenantId, technicianRef: tech, channel: 'technician_voice', text: 'all done here' },
      stub({ workPerformed: 'all done here' }), // extraction has NO customer details
    );
    expect(first.status).toBe('needs_confirmation');
    expect(first.suggestion?.address).toBe('88 Sheet St');
    expect(first.captureId).toBeDefined(); // inbound path: raw kept, unresolved
  });

  test('staged-confirm contract: resolved.createFrom commits exactly the previewed draft', async () => {
    // The staged flow resolves identity BEFORE commit and passes the full
    // draft through — commit must use it verbatim, not re-derive from the
    // (empty) extraction or a schedule lookup that may have gone stale.
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'tech-sched-rfn',
        channel: 'technician_voice',
        text: 'all done here',
        resolved: {
          createFrom: {
            customerName: 'Sheet Cust',
            phone: '555-7700',
            addressLine1: '88 Sheet St',
            city: null,
            state: null,
            postalCode: null,
          },
        },
      },
      stub({ workPerformed: 'all done here' }),
    );
    expect(r.status).toBe('matched');

    const cust = await pg.query<{
      name: string;
      phone: string | null;
      address_line1: string | null;
      source_capture_id: string | null;
    }>('select name, phone, address_line1, source_capture_id from customers where id = $1', [
      r.customerId,
    ]);
    expect(cust.rows[0]).toMatchObject({
      name: 'Sheet Cust', // the draft, not 'Unknown customer'
      phone: '555-7700',
      address_line1: '88 Sheet St',
      source_capture_id: r.captureId, // provenance: created rows link to the L1 evidence
    });
  });

  test('a retracted unmatched capture is terminal: redelivery reports duplicate and never heals into L2', async () => {
    const externalId = 'gmail-msg-retracted-1';
    const note = {
      tenantId,
      technicianRef: 'connector:gmail',
      channel: 'email' as const,
      text: 'personal mail — retracted by manager',
      externalId,
    };
    // First delivery: unmatched → L1 only (raw kept, no L2).
    const first = await recordFieldNote(note, stub({ workPerformed: 'n/a' }));
    expect(first.status).toBe('needs_disambiguation');

    // A manager retracts the capture (Option-B retraction row).
    await appendRawCapture({
      tenantId,
      channel: 'retraction',
      technicianRef: 'mgr-x',
      rawText: 'personal mail, recorded in error',
      retractsCaptureId: first.captureId,
    });

    // A customer now exists that the redelivered extraction WOULD match —
    // without the retraction guard the orphan heal would build L2 from a
    // recorded-in-error capture.
    const customer = await createCustomer({ tenantId, name: 'Now Exists', phone: '555-8181' });
    const redelivered = await recordFieldNote(
      note,
      stub({ phone: '555-8181', workPerformed: 'would match now' }),
    );
    expect(redelivered.status).toBe('duplicate');
    expect(redelivered.captureId).toBe(first.captureId);
    expect((await listJobsForCustomer(customer.id)).length).toBe(0); // no L2 was built
  });

  test('a matched customer with an existing non-terminal job reuses it rather than creating a new one', async () => {
    const customer = await createCustomer({ tenantId, name: 'Has A Job', phone: '555-0188' });
    const existingJob = await createJob({ tenantId, customerId: customer.id, title: 'Open work' });

    const r = await recordFieldNote(
      { tenantId, technicianRef: 'tech-amy', channel: 'technician_voice', text: 'more work' },
      stub({ phone: '555-0188', workPerformed: 'follow-up' }),
    );

    expect(r.status).toBe('matched');
    expect(r.jobId).toBe(existingJob.id); // reused, not a new job
    expect((await listJobsForCustomer(customer.id)).length).toBe(1);
  });

  test('inbound contract: an unresolvable call writes L1 once and returns needs_disambiguation (raw kept, no L2)', async () => {
    const before = await rawCaptureCount();
    const visitsBefore = await visitCount();

    const first = await recordFieldNote(
      { tenantId, technicianRef: 'tech-bob', channel: 'technician_note', text: 'fixed a leak' },
      stub({ workPerformed: 'fixed a leak', address: '77 Unmatched Way' }),
    );
    expect(first.status).toBe('needs_disambiguation');
    expect(await rawCaptureCount()).toBe(before + 1); // exactly one L1 appended
    expect(await visitCount()).toBe(visitsBefore); // and no L2 was built
  });

  test('staged-confirm contract: resolved.customerId bypasses matchIdentity — a conflicting extraction cannot re-route the note', async () => {
    // Two customers; the extraction's phone points at Y, but the technician
    // confirmed X during staging. Commit must attach to X — the preview is
    // the contract, never a commit-time re-match.
    const confirmedCust = await createCustomer({ tenantId, name: 'Confirmed X', phone: '555-6061' });
    await createCustomer({ tenantId, name: 'Distractor Y', phone: '555-6062' });

    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'tech-bob',
        channel: 'technician_note',
        text: 'note for X',
        resolved: { customerId: confirmedCust.id },
      },
      stub({ phone: '555-6062', workPerformed: 'note for X' }), // would match Y
    );
    expect(r.status).toBe('matched');
    expect(r.customerId).toBe(confirmedCust.id);

    const visit = await pg.query<{ source_capture_id: string | null }>(
      'select source_capture_id from visits where id = $1',
      [r.visitId],
    );
    expect(visit.rows[0].source_capture_id).toBe(r.captureId);

    // The capture itself carries the customer STAMP (2026-08-14): on the
    // staged path identity is known BEFORE the immutable L1 insert, and an
    // unstamped note is invisible to every stamped-capture reader — a
    // perfectly-executed staged note read as attributed to nobody until the
    // eval's customer-scoped end-state caught it.
    const cap = await pg.query<{ customer_id: string | null }>(
      'select customer_id from raw_captures where id = $1',
      [r.captureId],
    );
    expect(cap.rows[0].customer_id).toBe(confirmedCust.id);
  });

  test('an externalId capture persists external_id + occurredAt/sourceMeta in metadata JSONB', async () => {
    const customer = await createCustomer({ tenantId, name: 'Ext Meta', phone: '555-3030' });
    const externalId = 'gmail-msg-meta-1';
    const occurredAt = '2026-06-02T08:30:00.000Z';

    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'connector:gmail',
        channel: 'email',
        text: 'noisy unit',
        externalId,
        occurredAt,
        sourceMeta: { from: 'cust@x.com', subject: 'AC repair' },
      },
      stub({ phone: '555-3030', workPerformed: 'noisy AC' }),
    );
    expect(r.status).toBe('matched');
    expect(r.customerId).toBe(customer.id);

    // Cross-channel read-back: external_id column + metadata fields persisted.
    const cap = await pg.query<{
      external_id: string | null;
      metadata: { occurredAt?: string; from?: string; subject?: string };
    }>('select external_id, metadata from raw_captures where id = $1', [r.captureId]);
    expect(cap.rows[0].external_id).toBe(externalId);
    expect(cap.rows[0].metadata.occurredAt).toBe(occurredAt);
    expect(cap.rows[0].metadata.from).toBe('cust@x.com');
    expect(cap.rows[0].metadata.subject).toBe('AC repair');
  });

  test('a repeat call with the same (tenant, externalId) is a duplicate no-op: no second L1 row, no second job/visit', async () => {
    const customer = await createCustomer({ tenantId, name: 'Dedup Cust', phone: '555-4040' });
    const externalId = 'gmail-msg-dedup-1';
    const note = {
      tenantId,
      technicianRef: 'connector:gmail',
      channel: 'email' as const,
      text: 'leak under sink',
      externalId,
      sourceMeta: { from: 'cust@y.com', subject: 'Leak' },
    };

    const first = await recordFieldNote(note, stub({ phone: '555-4040', workPerformed: 'fixed leak' }));
    expect(first.status).toBe('matched');
    const jobsAfterFirst = (await listJobsForCustomer(customer.id)).length;
    const visitsAfterFirst = await visitCount();

    // Second delivery of the same message id → no-op duplicate (pre-check short-circuit).
    const second = await recordFieldNote(note, stub({ phone: '555-4040', workPerformed: 'fixed leak' }));
    expect(second.status).toBe('duplicate');
    expect(second.captureId).toBe(first.captureId);

    // Exactly one L1 row for that external id; no new job, no new visit.
    const l1 = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [externalId],
    );
    expect(Number(l1.rows[0].n)).toBe(1);
    expect((await listJobsForCustomer(customer.id)).length).toBe(jobsAfterFirst);
    expect(await visitCount()).toBe(visitsAfterFirst);
  });

  // REVIEW FINDING, rung 9b — RESOLVED BY RUNG 10. The dedup short-circuit keys
  // on captureHasLinkedL2, and before 9b an email ALWAYS left a link because it
  // always minted a visit. It stopped doing that (a customer's email is not a
  // trip), so a note resolving to an EXISTING customer AND an existing open job
  // carried no link and every redelivery re-ran the extractor. Rung 10 gives it
  // a `job_captures` link, so the redelivery is a real duplicate: no repeat
  // model call, no second row of anything.
  test('an email redelivered onto an EXISTING customer+job is a DUPLICATE — the job link marks it processed', async () => {
    const customer = await createCustomer({ tenantId, name: 'Redeliver Cust', phone: '555-7171' });
    const { createJob } = await import('../db/jobs.js');
    await createJob({ tenantId, customerId: customer.id, title: 'already open work' });
    const externalId = 'gmail-msg-existing-job-1';
    const note = {
      tenantId,
      technicianRef: 'connector:gmail',
      channel: 'email' as const,
      text: 'any update on the leak?',
      externalId,
    };
    let extractCalls = 0;
    const countingStub = {
      extract: async () => {
        extractCalls++;
        return { phone: '555-7171' };
      },
    };
    const first = await recordFieldNote(note, countingStub);
    expect(first.status).toBe('matched');
    expect(first.visitId).toBeUndefined(); // an email is not a trip
    expect(extractCalls).toBe(1);
    const jobsAfterFirst = (await listJobsForCustomer(customer.id)).length;
    const visitsAfterFirst = await visitCount();

    const second = await recordFieldNote(note, countingStub);
    // SHORT-CIRCUITS now — asserted explicitly, and the extractor spy is what
    // proves the model was not called a second time.
    expect(second.status).toBe('duplicate');
    expect(extractCalls).toBe(1);
    expect(second.captureId).toBe(first.captureId); // the SAME L1 row is reused
    const l1 = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [externalId],
    );
    expect(Number(l1.rows[0].n)).toBe(1);
    expect((await listJobsForCustomer(customer.id)).length).toBe(jobsAfterFirst);
    expect(await visitCount()).toBe(visitsAfterFirst);
    const custs = await pg.query<{ n: string }>(
      'select count(*)::int as n from customers where tenant_id = $1 and phone = $2',
      [tenantId, '555-7171'],
    );
    expect(Number(custs.rows[0].n)).toBe(1);
  });

  test('#3: an orphan capture (L1 written, extract failed) is healed on redelivery — reuse L1, build L2, no second row', async () => {
    const customer = await createCustomer({ tenantId, name: 'Heal Me', phone: '555-5050' });
    const externalId = 'gmail-msg-heal-1';
    const note = {
      tenantId,
      technicianRef: 'connector:gmail',
      channel: 'email' as const,
      text: 'broken furnace',
      externalId,
      sourceMeta: { from: 'c@d.com', subject: 'furnace' },
    };

    // A flaky extractor: throws on the FIRST call (after L1 is written → orphan), then
    // succeeds — simulating a transient model failure mid-write.
    let calls = 0;
    const flaky: Extractor = async () => {
      calls++;
      if (calls === 1) throw new Error('extractor timeout');
      return { phone: '555-5050', workPerformed: 'fixed furnace' };
    };

    // First delivery: L1 lands, extract throws → orphan, no L2.
    await expect(recordFieldNote(note, { extract: flaky })).rejects.toThrow();
    const l1a = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [externalId],
    );
    expect(Number(l1a.rows[0].n)).toBe(1);
    expect((await listJobsForCustomer(customer.id)).length).toBe(0); // orphan: no job yet

    // Redelivery: reuse the orphan L1 (no second row), extract succeeds →
    // and, since rung 10, an inbound capture on a customer with NO open job
    // ASKS instead of minting one. The heal is the OBSERVATION.
    const healed = await recordFieldNote(note, { extract: flaky });
    expect(healed.status).toBe('matched');
    expect(healed.customerId).toBe(customer.id);
    expect(healed.observationId).toBeDefined();
    expect(healed.jobId).toBeUndefined();
    const l1b = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [externalId],
    );
    expect(Number(l1b.rows[0].n)).toBe(1); // SAME row reused, not re-appended
    expect((await listJobsForCustomer(customer.id)).length).toBe(0); // nothing created
    expect((await observationsFor(healed.captureId)).length).toBe(1);

    // Third delivery: the observation IS the processed marker → duplicate no-op.
    const third = await recordFieldNote(note, { extract: flaky });
    expect(third.status).toBe('duplicate');
    expect((await listJobsForCustomer(customer.id)).length).toBe(0);
    expect((await observationsFor(healed.captureId)).length).toBe(1); // never asked twice
  });

  test('structure:false stores L1 only — no extract, no job/visit, status captured', async () => {
    const before = await rawCaptureCount();
    const visitsBefore = await visitCount();
    let extractCalls = 0;
    const spyExtract: Extractor = async () => {
      extractCalls++;
      return { workPerformed: 'should never run' };
    };

    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: 'just calling to say thanks',
        structure: false,
      },
      { extract: spyExtract },
    );
    expect(r.status).toBe('captured');
    expect(r.captureId).toBeDefined();
    expect(extractCalls).toBe(0); // extract must NOT run in L1-only mode

    // Exactly one L1 row appended, and no L2.
    expect(await rawCaptureCount()).toBe(before + 1);
    expect(await visitCount()).toBe(visitsBefore);
    const l2 = await pg.query<{ n: string }>(
      'select count(*)::int as n from visits where source_capture_id = $1',
      [r.captureId],
    );
    expect(Number(l2.rows[0].n)).toBe(0);
  });

  test('structure omitted → still structures, and a call with no open job ASKS (rung 10)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Default Structures', phone: '555-9090' });
    const r = await recordFieldNote(
      { tenantId, technicianRef: 'phone-line', channel: 'phone_call', text: 'furnace down' },
      stub({ phone: '555-9090', workPerformed: 'furnace repair' }),
    );
    expect(r.status).toBe('matched');
    expect(r.customerId).toBe(customer.id); // identity still resolves
    // INVERTED AGAIN by rung 10. 9b stopped a call minting a VISIT (`visits` is
    // the schedule — a call is not a trip). Rung 10 stops it minting a JOB too:
    // the manager was blind to work appearing on the record, so the capture
    // raises an observation and a manager is asked instead.
    expect(r.jobId).toBeUndefined();
    expect(r.visitId).toBeUndefined();
    expect(r.observationId).toBeDefined();
    expect((await listJobsForCustomer(customer.id)).length).toBe(0);
  });
});

// ---- Rung 10: inbound ASKS before it creates, and what it says is kept ------
//
// For a customer we know, an inbound call or email now creates NOTHING. If they
// have an open job the words are pinned to it and what they said is kept on it;
// if they have no open job, or the firm agreed to come out with no trip to
// attach to, an OBSERVATION is written instead and the planner is called about
// that one item. These pin every arm of that fork, and read the result straight
// from SQL rather than through the code under test.
describe('rung 10 — inbound asks before it creates', () => {
  const TZ = 'America/Los_Angeles';
  let DAY: string;
  let phoneSeq = 9100;
  const naive = (hhmm: string, day?: string) => `${day ?? DAY}T${hhmm}:00.000Z`;

  const inbound = (
    channel: 'email' | 'phone_call',
    text: string,
    extra: Partial<Parameters<typeof recordFieldNote>[0]> = {},
  ) => ({
    tenantId,
    technicianRef: channel === 'email' ? 'connector:gmail' : 'phone-line',
    channel,
    text,
    ...extra,
  });

  const newCustomer = async (name: string) => {
    const phone = `555-${phoneSeq++}`;
    return { customer: await createCustomer({ tenantId, name, phone }), phone };
  };
  const withOpenJob = async (name: string) => {
    const { customer, phone } = await newCustomer(name);
    const job = await createJob({ tenantId, customerId: customer.id, title: `${name} work` });
    return { customer, job, phone };
  };

  beforeAll(async () => {
    await pg.query('update tenants set timezone = $1 where id = $2', [TZ, tenantId]);
    DAY = localDateISO(new Date().toISOString(), TZ);
  });

  test('(1) a COMMITTED email from a known customer with no open job asks — no job, no visit', async () => {
    const { customer, phone } = await newCustomer('Commit Cora');
    const jobsBefore = await visitCount();
    const r = await recordFieldNote(
      inbound('email', 'my heater is dead — ok, see you Thursday then'),
      stub({
        phone,
        visitCommitted: true,
        jobTitle: 'heater not firing',
        attributes: { gateCode: '4412' },
      }),
    );
    expect(r.status).toBe('matched');
    expect(r.customerId).toBe(customer.id);
    expect(r.jobId).toBeUndefined();
    expect(r.visitId).toBeUndefined();
    expect(r.observationId).toBeDefined();
    expect((await listJobsForCustomer(customer.id)).length).toBe(0);
    expect(await visitCount()).toBe(jobsBefore);

    const obs = await observationsFor(r.captureId);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('inbound_commitment');
    expect(obs[0].status).toBe('open');
    const ctx = obs[0].context as Record<string, unknown>;
    expect(ctx.customerId).toBe(customer.id);
    expect(ctx.customerName).toBe('Commit Cora');
    expect(ctx.channel).toBe('email');
    // No jobId ⇒ the planner reads "a job would be opened too". ONE observation,
    // never two texts for one message.
    expect(ctx.jobId).toBeUndefined();
    expect(ctx.words).toContain('see you Thursday');
    expect((ctx.asked as Record<string, unknown>).attributes).toEqual({ gateCode: '4412' });
  });

  test('(2) a COMMITTED call on an open job with no trip: pinned to the job, kept on the job, and asked', async () => {
    const { customer, job, phone } = await withOpenJob('Commit Cal');
    const r = await recordFieldNote(
      inbound('phone_call', 'yes please send someone out tomorrow', {
        sourceMeta: { from: '+15551234567' },
      }),
      stub({ phone, visitCommitted: true, followUp: 'send a tech for the leak' }),
    );
    expect(r.jobId).toBe(job.id); // the existing job, not a new one
    expect(r.visitId).toBeUndefined();
    expect(r.observationId).toBeDefined();
    expect((await listJobsForCustomer(customer.id)).length).toBe(1);

    // A: the LINK.
    expect(await jobCaptureLinks(job.id)).toBe(1);
    // C: the VALUES.
    const attrs = await jobAttributes(job.id);
    const entries = attrs.correspondence as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].captureId).toBe(r.captureId);
    expect(entries[0].channel).toBe('phone_call');
    expect(entries[0].followUp).toBe('send a tech for the leak');

    const obs = await observationsFor(r.captureId);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('inbound_commitment');
    expect((obs[0].context as Record<string, unknown>).jobId).toBe(job.id);
    expect((obs[0].context as Record<string, unknown>).from).toBe('+15551234567');
  });

  test('(3) a COMMITTED email that ATTACHES to a live trip is correspondence, not an ask', async () => {
    const { job, phone } = await withOpenJob('Booked Bea');
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: naive('00:00'),
      endsAt: naive('23:59'),
      status: 'confirmed',
    });
    const r = await recordFieldNote(
      inbound('email', 'confirming you are coming today — gate code is 9931'),
      stub({ phone, visitCommitted: true, attributes: { gateCode: '9931' } }),
    );
    expect(r.visitId).toBe(visit.id); // attached to the booked trip
    expect(r.observationId).toBeUndefined(); // nothing to ask — it is already booked
    expect(await observationsFor(r.captureId)).toHaveLength(0);
    const { rows } = await pg.query<{ n: string }>(
      'select count(*)::int as n from visit_notes where visit_id = $1',
      [visit.id],
    );
    expect(Number(rows[0].n)).toBe(1);
    expect(await jobCaptureLinks(job.id)).toBe(0); // the trip took it, not the job
    // C still applies: what they said is kept on the job either way.
    const entries = (await jobAttributes(job.id)).correspondence as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].facts).toEqual({ gateCode: '9931' });
  });

  test('(4) an UNCOMMITTED email from a known customer with no open job asks as inbound_new_job', async () => {
    const { customer, phone } = await newCustomer('Asking Ada');
    const r = await recordFieldNote(
      inbound('email', 'what would it cost to replace the water heater?'),
      stub({ phone, jobTitle: 'water heater quote' }),
    );
    expect(r.jobId).toBeUndefined();
    expect((await listJobsForCustomer(customer.id)).length).toBe(0);
    const obs = await observationsFor(r.captureId);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('inbound_new_job'); // asked for, not agreed to
  });

  test('(5) an UNCOMMITTED email on an open job is kept, and asks NOTHING', async () => {
    const { job, phone } = await withOpenJob('Chasing Chad');
    const r = await recordFieldNote(
      inbound('email', 'any update on the part?', { externalId: 'gmail-rung10-chad-1' }),
      stub({ phone, followUp: 'chase the part ETA' }),
    );
    expect(r.jobId).toBe(job.id);
    expect(r.observationId).toBeUndefined();
    expect(await observationsFor(r.captureId)).toHaveLength(0);
    expect(await jobCaptureLinks(job.id)).toBe(1);
    const entries = (await jobAttributes(job.id)).correspondence as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
  });

  test('(6) redelivery is a DUPLICATE on BOTH shapes — the link and the ask both mark it processed', async () => {
    // The job-linked shape (5's message id), and the asked shape.
    const kept = await withOpenJob('Twice Tina');
    let calls = 0;
    const spy = {
      extract: async () => {
        calls++;
        return { phone: kept.phone };
      },
    };
    const linked = inbound('email', 'any update?', { externalId: 'gmail-rung10-twice-1' });
    const first = await recordFieldNote(linked, spy);
    expect(first.status).toBe('matched');
    expect(calls).toBe(1);
    const again = await recordFieldNote(linked, spy);
    expect(again.status).toBe('duplicate');
    expect(calls).toBe(1); // no repeat model call

    const asked = await newCustomer('Twice Tom');
    let askedCalls = 0;
    const askedSpy = {
      extract: async () => {
        askedCalls++;
        return { phone: asked.phone, visitCommitted: true };
      },
    };
    const note = inbound('email', 'ok Friday works', { externalId: 'gmail-rung10-twice-2' });
    const one = await recordFieldNote(note, askedSpy);
    expect(one.observationId).toBeDefined();
    const two = await recordFieldNote(note, askedSpy);
    expect(two.status).toBe('duplicate');
    expect(askedCalls).toBe(1);
    expect(await observationsFor(one.captureId)).toHaveLength(1); // asked once, ever
  });

  // ---- RUNG 10B: nobody matched, and that is now its own kind ---------------
  test('(7) an UNMATCHED committed call raises ONE inbound_unmatched, with the caller-ID on it', async () => {
    const r = await recordFieldNote(
      inbound('phone_call', 'hi, I need someone out to look at my furnace', {
        sourceMeta: { fromNumber: '+15550001111' },
      }),
      stub({
        phone: '555-0000-nobody',
        visitCommitted: true,
        customerName: 'Nobody Knownyet',
        jobTitle: 'furnace not lighting',
      }),
    );
    expect(r.status).toBe('needs_disambiguation');
    expect(r.customerId).toBeUndefined(); // nothing was created
    expect(r.observationId).toBeDefined();

    const obs = await observationsFor(r.captureId);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('inbound_unmatched');
    expect(obs[0].status).toBe('open');
    const ctx = obs[0].context as Record<string, unknown>;
    // NO customer on it — that is the open question this kind exists to ask.
    expect(ctx.customerId).toBeUndefined();
    expect(ctx.from).toBe('+15550001111'); // the phone door spells it `fromNumber`
    expect(ctx.channel).toBe('phone_call');
    // The commitment is a FIELD here, not something read off the kind's name.
    expect(ctx.visitCommitted).toBe(true);
    expect(ctx.matchReason).toEqual(expect.any(String));
    expect(ctx.words).toContain('furnace');
    expect(ctx.asked).toMatchObject({
      customerName: 'Nobody Knownyet',
      jobTitle: 'furnace not lighting',
    });
  });

  test('(7b) an UNMATCHED email raises one too, carrying the sender and the door’s address', async () => {
    const r = await recordFieldNote(
      inbound('email', 'hello — my kitchen tap has been dripping for a week', {
        externalId: 'unmatched-email-1',
        sourceMeta: { from: 'Stranger Sam <sam@nowhere.test>' },
        fallbackEmail: 'sam@nowhere.test',
      }),
      stub({ customerName: 'Stranger Sam', jobTitle: 'dripping tap' }),
    );
    expect(r.status).toBe('needs_disambiguation');
    const obs = await observationsFor(r.captureId);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('inbound_unmatched');
    const ctx = obs[0].context as Record<string, unknown>;
    expect(ctx.from).toBe('Stranger Sam <sam@nowhere.test>');
    expect(ctx.visitCommitted).toBeNull(); // not said, and said so
    // The address is the ENVELOPE's, not something the model read out of the body.
    expect((ctx.asked as Record<string, unknown>).email).toBe('sam@nowhere.test');
  });

  test('(7c) a stranger whose message closes itself asks NOTHING — the same `=== false` filter', async () => {
    const before = await pg.query<{ n: string }>('select count(*)::int as n from observations');
    const r = await recordFieldNote(
      inbound('email', 'thanks, got the invoice — have a good weekend', {
        externalId: 'unmatched-email-quiet',
        sourceMeta: { from: 'quiet@nowhere.test' },
      }),
      stub({ touchesOperations: false }),
    );
    expect(r.status).toBe('needs_disambiguation');
    expect(r.observationId).toBeUndefined();
    expect(await observationsFor(r.captureId)).toHaveLength(0);
    const after = await pg.query<{ n: string }>('select count(*)::int as n from observations');
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n));
  });

  test('(7d) an unmatched TECHNICIAN note asks nothing — the staged-confirm contract is untouched', async () => {
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'tech-unmatched-10b',
        channel: 'technician_note',
        text: 'fixed a leak at the place on the corner',
      },
      stub({ workPerformed: 'fixed a leak', address: '77 Nobody Knows Way', visitCommitted: true }),
    );
    expect(r.status).toBe('needs_disambiguation');
    expect(r.observationId).toBeUndefined();
    expect(await observationsFor(r.captureId)).toHaveLength(0);
  });

  test('(7e) the ask is the marker: a redelivery of the unmatched email is a DUPLICATE', async () => {
    // Before rung 10b an unmatched capture left NO L2 trace, so every redelivery
    // re-ran the extractor — a paid model call that wrote nothing.
    const first = await recordFieldNote(
      inbound('email', 'my boiler is making a banging noise', {
        externalId: 'unmatched-email-redeliver',
        sourceMeta: { from: 'banging@nowhere.test' },
      }),
      stub({ jobTitle: 'banging boiler' }),
    );
    expect(first.observationId).toBeDefined();
    let extractorCalls = 0;
    const again = await recordFieldNote(
      inbound('email', 'my boiler is making a banging noise', {
        externalId: 'unmatched-email-redeliver',
        sourceMeta: { from: 'banging@nowhere.test' },
      }),
      {
        extract: async () => {
          extractorCalls += 1;
          return { jobTitle: 'banging boiler' };
        },
      },
    );
    expect(again.status).toBe('duplicate');
    expect(again.captureId).toBe(first.captureId);
    expect(extractorCalls).toBe(0); // never paid for twice
    expect(await observationsFor(first.captureId)).toHaveLength(1);
  });

  test('(7f) two deliveries racing converge on ONE row — the once-ever index decides', async () => {
    const delivery = () =>
      recordFieldNote(
        inbound('email', 'can somebody come and look at the shower', {
          externalId: 'unmatched-email-race',
          sourceMeta: { from: 'race@nowhere.test' },
        }),
        stub({ jobTitle: 'shower' }),
      );
    const [a, b] = await Promise.all([delivery(), delivery()]);
    const captureIds = new Set([a.captureId, b.captureId]);
    expect(captureIds.size).toBe(1); // one L1 row — the unique index on externalId
    const obs = await observationsFor([...captureIds][0]);
    expect(obs).toHaveLength(1); // and exactly one ask, however the race landed
    // And only ONE delivery may report having raised it: createObservation
    // returns null on the once-ever conflict, so the loser reports no
    // observationId rather than claiming a fresh ask that is really the winner's.
    const reported = [a.observationId, b.observationId].filter(Boolean);
    expect(reported.length).toBe(1);
    const { rows } = await pg.query<{ id: string }>(
      'select id from observations where subject_ref = $1',
      [[...captureIds][0]],
    );
    expect(reported[0]).toBe(rows[0].id); // and it is the row that actually landed
  });

  test('(8) a TECHNICIAN note is untouched by all of it — walk-in still mints a trip, nothing is kept as correspondence', async () => {
    const { customer, job, phone } = await withOpenJob('Walkin Wanda');
    const tech = await insertTechnician({
      tenantId,
      ref: 'rung10-tech-1',
      displayName: 'Rung Ten Tech',
      seatExempt: true,
    });
    const r = await recordFieldNote(
      { tenantId, technicianRef: tech.ref, channel: 'technician_note', text: 'replaced the igniter' },
      stub({ phone, visitCommitted: true, workPerformed: 'replaced igniter', laborHours: 1.5 }),
    );
    expect(r.jobId).toBe(job.id);
    expect(r.visitId).toBeDefined(); // step 3 still creates for a technician
    expect(r.observationId).toBeUndefined(); // visitCommitted is inbound's word only
    expect(await observationsFor(r.captureId)).toHaveLength(0);
    expect(await jobCaptureLinks(job.id)).toBe(0);
    expect((await jobAttributes(job.id)).correspondence).toBeUndefined();
    expect((await listJobsForCustomer(customer.id)).length).toBe(1);
  });

  test('THE ASK IS WRITTEN FIRST: a failure after it cannot bury the promise', async () => {
    // `job_captures` is a "processed" marker, so if the link were written
    // before the observation, any failure in between would make the redelivery
    // a duplicate and NOBODY would ever hear that the firm agreed to come out.
    // Forced here by making the correspondence append throw: a job whose
    // attributes are not a JSON object is refused by trySetJobAttribute.
    const { job, phone } = await withOpenJob('Broken Bella');
    await pg.query(`update jobs set attributes = '"not an object"'::jsonb where id = $1`, [job.id]);
    const note = inbound('email', 'yes, tomorrow works — see you then', {
      externalId: 'gmail-rung10-ordering-1',
    });
    const ext = stub({ phone, visitCommitted: true, followUp: 'send someone tomorrow' });

    await expect(recordFieldNote(note, ext)).rejects.toThrow(/refusing to replace it/);

    // The ask survived the failure — which is the whole point of the ordering.
    const { rows } = await pg.query<{ subject_ref: string; kind: string }>(
      `select subject_ref, kind from observations o
        where exists (select 1 from raw_captures c
                       where c.id::text = o.subject_ref and c.external_id = $1)`,
      ['gmail-rung10-ordering-1'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('inbound_commitment');

    // AND THE ORDERING'S PRICE, stated rather than hidden: the observation is
    // itself a "processed" marker, so the redelivery converges and this job
    // never gets its own copy of the words. Nothing is LOST — the capture is in
    // L1 and the observation carries the same fields for the planner to read —
    // but the job reads silent to the evidence readers until somebody links it.
    // Reversing the order would trade a dropped promise for a tidy record.
    const again = await recordFieldNote(note, ext);
    expect(again.status).toBe('duplicate');
    expect(await observationsFor(rows[0].subject_ref)).toHaveLength(1);
    expect(await jobCaptureLinks(job.id)).toBe(0);
    const asked = (await observationsFor(rows[0].subject_ref))[0].context as {
      asked: { followUp: string | null };
    };
    expect(asked.asked.followUp).toBe('send someone tomorrow');
  });

  test('THE WORDS SURVIVE A FAILED APPEND: nothing is marked processed until they land', async () => {
    // The same ordering rule one step down. `job_captures` stops a redelivery,
    // so if the link were written before the correspondence, a CAS exhaustion
    // (or a job whose attributes are not an object, forced here) would lose the
    // caller's words permanently and silently. Ahead of the marker, the retry
    // simply re-runs and lands them.
    const { job, phone } = await withOpenJob('Retry Rhea');
    await pg.query(`update jobs set attributes = '"not an object"'::jsonb where id = $1`, [job.id]);
    const note = inbound('email', 'the part never arrived', {
      externalId: 'gmail-rung10-retry-1',
    });
    const ext = stub({ phone, followUp: 'chase the supplier' }); // NOT committed — no ask

    await expect(recordFieldNote(note, ext)).rejects.toThrow(/refusing to replace it/);
    expect(await jobCaptureLinks(job.id)).toBe(0); // nothing was marked processed

    // The job is repaired; the same message is delivered again.
    await pg.query(`update jobs set attributes = '{}'::jsonb where id = $1`, [job.id]);
    const healed = await recordFieldNote(note, ext);
    expect(healed.status).toBe('matched'); // re-runs, rather than short-circuiting
    expect(healed.jobId).toBe(job.id);
    const entries = (await jobAttributes(job.id)).correspondence as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].followUp).toBe('chase the supplier');
    expect(await jobCaptureLinks(job.id)).toBe(1);
  });

  test('a CALL’s caller-ID reaches the planner — the phone door spells it `fromNumber`', async () => {
    // The two doors spell the sender differently and neither is going to
    // change: the email webhook writes `from`, the call worker writes
    // `fromNumber` (src/calls/worker.ts). Reading only `from` left every call —
    // this rung's headline channel — with no sender to show.
    const { phone } = await newCustomer('Caller Carl');
    const r = await recordFieldNote(
      inbound('phone_call', 'my furnace is out', {
        sourceMeta: {
          fromNumber: '+15559998888',
          recordingProvider: 'signalwire',
          callSid: 'CA-test-1',
        },
      }),
      stub({ phone }),
    );
    const obs = await observationsFor(r.captureId);
    expect(obs).toHaveLength(1);
    expect((obs[0].context as Record<string, unknown>).from).toBe('+15559998888');
  });

  test('(9) correspondence carries the caller’s words only — never the report or the bill — and APPENDS', async () => {
    const { job, phone } = await withOpenJob('Appending Abe');
    // A pre-existing top-level L3 key must survive every append.
    await pg.query(`update jobs set attributes = '{"gateCode":"1111"}'::jsonb where id = $1`, [job.id]);

    const one = await recordFieldNote(
      inbound('email', 'the leak is under the sink'),
      stub({
        phone,
        followUp: 'bring a basin wrench',
        workPerformed: 'customer says it drips',
        laborHours: 9,
        attributes: { pets: 'dog' },
      }),
    );
    const two = await recordFieldNote(
      inbound('email', 'also the tap is loose'),
      stub({ phone, followUp: 'check the tap' }),
    );

    const attrs = await jobAttributes(job.id);
    expect(attrs.gateCode).toBe('1111'); // the existing key survives
    const entries = attrs.correspondence as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2); // APPENDED, never merged over the key
    expect(entries.map((e) => e.captureId)).toEqual([one.captureId, two.captureId]);
    for (const e of entries) {
      expect(e).not.toHaveProperty('workPerformed');
      expect(e).not.toHaveProperty('laborHours');
      expect(JSON.stringify(e)).not.toContain('drips');
    }
    expect(entries[0].facts).toEqual({ pets: 'dog' });

    // Nothing to say ⇒ nothing written: the link still records that it landed.
    const three = await recordFieldNote(inbound('email', 'thanks!'), stub({ phone }));
    expect(three.jobId).toBe(job.id);
    expect(((await jobAttributes(job.id)).correspondence as unknown[]).length).toBe(2);
    expect(await jobCaptureLinks(job.id)).toBe(3);
  });

  // ---- THE EXTRACTOR DECIDES (amended 2026-09-07, user) -------------------
  //
  // The first version of this rung asked whenever the customer had no
  // non-terminal job, which woke the planner for a thank-you arriving after the
  // invoice was paid. The extractor already reads every one of these captures on
  // inference, so the judgment moved there — and the question it answers is
  // whether the message carries anything for the OPERATIONS layer (a job, a
  // visit, a schedule change, parts, money), not whether someone "should care".
  // These pin BOTH directions of that switch — the skip, and the far more
  // important refusal to skip.

  test('(10) touchesOperations FALSE with no open job: filed on the last job, nobody asked', async () => {
    const { customer, phone } = await newCustomer('Grateful Greta');
    // Terminal on purpose: the old gate is exactly what this status triggered.
    const paid = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'furnace service',
      status: 'paid',
    });

    const r = await recordFieldNote(
      inbound('email', 'thanks so much, the heat has been perfect all week!'),
      stub({ phone, touchesOperations: false, followUp: 'none — customer is happy' }),
    );

    expect(r.status).toBe('matched');
    expect(r.jobId).toBe(paid.id); // filed on the paid job, not a new one
    expect(r.observationId).toBeUndefined();
    expect(await observationsFor(r.captureId)).toHaveLength(0);

    // The words still land on the record: this is the whole reason a filtered
    // capture is not simply abandoned in L1.
    const entries = (await jobAttributes(paid.id)).correspondence as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].captureId).toBe(r.captureId);
    expect(await jobCaptureLinks(paid.id)).toBe(1);

    // And NOTHING moved: no second job, no trip, and the paid job is still paid
    // (NOTE_SIGNAL_TRANSITIONS has no entry for it).
    expect((await listJobsForCustomer(customer.id)).length).toBe(1);
    expect((await listJobsForCustomer(customer.id))[0].status).toBe('paid');
    expect(r.visitId).toBeUndefined();
  });

  test('(11) touchesOperations FALSE with no job at all: L1 keeps it, nothing else is built', async () => {
    const { customer, phone } = await newCustomer('Wrongnumber Wally');
    const before = await rawCaptureCount();

    const r = await recordFieldNote(
      inbound('email', 'sorry, wrong address — ignore my last message'),
      stub({ phone, touchesOperations: false }),
    );

    expect(r.status).toBe('captured');
    expect(r.captureId).toBeDefined();
    expect(r.jobId).toBeUndefined();
    expect(r.observationId).toBeUndefined();
    expect(await rawCaptureCount()).toBe(before + 1); // the verbatim capture is kept
    expect(await observationsFor(r.captureId)).toHaveLength(0);
    expect((await listJobsForCustomer(customer.id)).length).toBe(0);
  });

  test('(12) ONLY an explicit false skips — absent, null and true all still ask', async () => {
    // THE SIGN OF THIS COMPARISON IS THE WHOLE SAFETY PROPERTY. A truncated
    // response, an older stub, or a model that ignores the field must behave as
    // the code did before the field existed. Written as three cases because
    // `!touchesOperations` instead of `=== false` passes the first one and silences
    // the other two — the exact mistake this test exists to catch.
    for (const [label, fields] of [
      ['absent', {}],
      ['null', { touchesOperations: null }],
      ['true', { touchesOperations: true }],
    ] as const) {
      const { customer, phone } = await newCustomer(`Asks ${label}`);
      const r = await recordFieldNote(
        inbound('email', 'my water heater is leaking, can someone come out?'),
        stub({ phone, jobTitle: 'water heater leak', ...fields }),
      );
      expect(r.observationId, `${label} must still ask`).toBeDefined();
      const obs = await observationsFor(r.captureId);
      expect(obs, `${label} must still ask`).toHaveLength(1);
      expect(obs[0].kind).toBe('inbound_new_job');
      expect((await listJobsForCustomer(customer.id)).length).toBe(0);
    }
  });

  test('(13) a COMMITMENT outranks the filter — the firm agreeing to come out IS attention', async () => {
    const { customer, phone } = await newCustomer('Committed Callum');
    const r = await recordFieldNote(
      inbound('phone_call', 'great, we will have someone out Thursday morning'),
      // A model that judged this unimportant must not be able to lose the
      // promise: `visitCommitted` is checked alongside, not after.
      stub({ phone, touchesOperations: false, visitCommitted: true, jobTitle: 'no heat' }),
    );
    expect(r.observationId).toBeDefined();
    const obs = await observationsFor(r.captureId);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('inbound_commitment');
    expect((await listJobsForCustomer(customer.id)).length).toBe(0);
  });

  test('(14) the filter is INBOUND-ONLY — a technician note still mints work', async () => {
    const { customer, phone } = await newCustomer('Fieldnote Fran');
    const tech = await insertTechnician({
      tenantId,
      ref: 'rung10-tech-2',
      displayName: 'Filter Free Tech',
      seatExempt: true,
    });
    const r = await recordFieldNote(
      { tenantId, technicianRef: tech.ref, channel: 'technician_note', text: 'swapped the capacitor' },
      stub({ phone, touchesOperations: false, workPerformed: 'swapped capacitor' }),
    );
    // A technician's own note is the firm acting, not a message to judge.
    expect(r.jobId).toBeDefined();
    expect(r.visitId).toBeDefined();
    expect(r.observationId).toBeUndefined();
    expect((await listJobsForCustomer(customer.id)).length).toBe(1);
  });
});

// RUNG 10B PHASE 1 — the door hands the matcher two envelope keys it never had.
// Both arrive beside `extracted`, not inside it: they are facts about the
// delivery, not something a model read out of the words.
describe('rung 10b — the email door\'s own identity keys', () => {
  let seq = 9600;

  test('an email from a customer\'s own address matches them with no phone in the words', async () => {
    const customer = await createCustomer({
      tenantId,
      name: 'Emailing Edna',
      email: 'edna@example.com',
    });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Edna work' });
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'connector:gmail',
        channel: 'email',
        text: 'any update on the quote?',
        externalId: `msg-10b-${seq++}`,
        fallbackEmail: 'edna@example.com',
      },
      stub({ followUp: 'wants the quote' }), // no phone, no address anywhere
    );
    expect(r).toMatchObject({ status: 'matched', customerId: customer.id, jobId: job.id });
    expect(await jobCaptureLinks(job.id)).toBe(1);
    expect(await observationsFor(r.captureId)).toHaveLength(0);
  });

  test('a reply lands on the job ITS THREAD names, not the customer\'s newest job', async () => {
    // The shape that parked a live reschedule request on 2026-09-08: a known
    // customer replies, and the reply carries no phone and no address of its own.
    const customer = await createCustomer({ tenantId, name: 'Threading Tom' });
    const older = await createJob({ tenantId, customerId: customer.id, title: 'water heater' });
    const newer = await createJob({ tenantId, customerId: customer.id, title: 'a later job' });
    const threadId = `thread-10b-${seq++}`;
    const starter = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'Friday morning for the water heater',
      externalId: threadId, // a starter's thread id IS its message id
    });
    await pg.query('insert into job_captures (tenant_id, job_id, capture_id) values ($1,$2,$3)', [
      tenantId,
      older.id,
      starter.id,
    ]);

    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'connector:gmail',
        channel: 'email',
        text: 'Is it possible to do Friday afternoon instead?',
        externalId: `msg-10b-${seq++}`,
        threadId,
      },
      stub({ followUp: 'wants Friday afternoon' }),
    );
    expect(r).toMatchObject({ status: 'matched', customerId: customer.id, jobId: older.id });
    expect(await jobCaptureLinks(older.id)).toBe(2); // the starter and this reply
    expect(await jobCaptureLinks(newer.id)).toBe(0);
  });

  test('a stranger\'s email still resolves to nobody — the keys widen the matcher, they do not soften it', async () => {
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'connector:gmail',
        channel: 'email',
        text: 'hello, is this the plumber?',
        externalId: `msg-10b-${seq++}`,
        fallbackEmail: 'nobody-on-file@example.com',
        threadId: `thread-unfiled-${seq++}`,
      },
      stub({}),
    );
    expect(r.status).toBe('needs_disambiguation');
    expect(r.customerId).toBeUndefined();
  });

  test('a customer created from an email keeps the address it wrote from', async () => {
    // So the SAME sender is recognised by the email key on their next message,
    // instead of being parked as a stranger a second time.
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'connector:gmail',
        channel: 'email',
        text: 'new here — my sink is blocked',
        externalId: `msg-10b-${seq++}`,
        fallbackEmail: 'brand.new@example.com',
        resolved: { createFrom: { customerName: 'Brand New' } },
      },
      stub({ jobTitle: 'blocked sink' }),
    );
    expect(r.status).toBe('matched');
    const { rows } = await pg.query<{ email: string | null }>(
      'select email from customers where id = $1',
      [r.customerId],
    );
    expect(rows[0].email).toBe('brand.new@example.com');
  });
});

// RUNG 10B PHASE 4 — the door, RE-ENTERED. `record_caller` sends the same capture
// back through with the identity the planner settled and what a manager decided,
// so nothing here is a new write path: it is this one, run again.
describe('rung 10b — re-entry by capture id, and what a manager decided', () => {
  let seq = 9800;
  const parkedCall = async (text: string, meta: Json = {}) =>
    await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      technicianRef: 'phone-line',
      rawText: text,
      externalId: `re-entry-${seq++}`,
      metadata: meta,
    });

  test('re-entry REUSES the L1 row — a second one would be permanent', async () => {
    const capture = await parkedCall('somebody rang about a broken gate');
    const customer = await createCustomer({ tenantId, name: 'Re-entered Rita' });
    const before = await rawCaptureCount();
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
        decided: { openJob: { title: 'broken gate' } },
      },
      stub({ jobTitle: 'ignored — the decision wins' }),
    );
    expect(r.captureId).toBe(capture.id);
    expect(await rawCaptureCount()).toBe(before);
  });

  test('decided.openJob MINTS the job, citing the call, and asks nothing', async () => {
    const capture = await parkedCall('new customer, wants a quote for a new boiler');
    const customer = await createCustomer({ tenantId, name: 'Minted Mo' });
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
        decided: { openJob: { title: 'quote for a new boiler', jobType: 'plumbing' } },
      },
      stub({ jobTitle: 'something the model read', jobType: 'hvac' }),
    );
    expect(r.jobId).toBeDefined();
    expect(await observationsFor(capture.id)).toHaveLength(0);
    const { rows } = await pg.query<{ title: string; job_type: string; source_capture_id: string }>(
      'select title, job_type, source_capture_id from jobs where id = $1',
      [r.jobId],
    );
    // What the manager said wins over what the model read.
    expect(rows[0].title).toBe('quote for a new boiler');
    expect(rows[0].job_type).toBe('plumbing');
    expect(rows[0].source_capture_id).toBe(capture.id);
  });

  test('bookVisit:true puts an UNTIMED trip on the board, citing the call', async () => {
    const capture = await parkedCall('they said someone would come out');
    const customer = await createCustomer({ tenantId, name: 'Booked Bea' });
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
        decided: { openJob: { title: 'no hot water' }, bookVisit: true },
      },
      stub({ visitCommitted: true }),
    );
    expect(r.visitId).toBeDefined();
    expect(await observationsFor(capture.id)).toHaveLength(0); // decided, not asked
    const { rows } = await pg.query<{
      starts_at: string | null;
      ends_at: string | null;
      status: string;
      source_capture_id: string | null;
      job_id: string;
    }>('select starts_at, ends_at, status, source_capture_id, job_id from visits where id = $1', [
      r.visitId,
    ]);
    expect(rows[0].starts_at).toBeNull(); // no day
    expect(rows[0].ends_at).toBeNull(); // no time
    expect(rows[0].status).toBe('confirmed');
    expect(rows[0].source_capture_id).toBe(capture.id);
    expect(rows[0].job_id).toBe(r.jobId);
  });

  test('bookVisit:false books nothing AND asks nothing — a manager said no', async () => {
    const capture = await parkedCall('we told them someone would come');
    const customer = await createCustomer({ tenantId, name: 'Declined Dee' });
    const visitsBefore = await visitCount();
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
        decided: { openJob: { title: 'have a look sometime' }, bookVisit: false },
      },
      stub({ visitCommitted: true }),
    );
    expect(r.visitId).toBeUndefined();
    expect(await visitCount()).toBe(visitsBefore);
    expect(await observationsFor(capture.id)).toHaveLength(0);
  });

  test('decided ABSENT on a committed re-run is rung 10 unchanged — it still asks', async () => {
    const capture = await parkedCall('yes, see you Thursday then');
    const { customer, job } = await (async () => {
      const c = await createCustomer({ tenantId, name: 'Still Asking Asha' });
      const j = await createJob({ tenantId, customerId: c.id, title: 'existing work' });
      return { customer: c, job: j };
    })();
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
      },
      stub({ visitCommitted: true }),
    );
    expect(r.jobId).toBe(job.id);
    const obs = await observationsFor(capture.id);
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('inbound_commitment');
  });

  test('a settled re-entry NEVER raises a second "who is this" — it files the call instead', async () => {
    // Rung 10's gate would raise `inbound_new_job` here, on a capture whose
    // `inbound_unmatched` ask is still open — two questions about one call, and
    // the tool reporting success while nobody had been asked anything.
    const capture = await parkedCall('it is Tom, from the water heater job');
    const customer = await createCustomer({ tenantId, name: 'Filed Fiona' });
    const older = await createJob({ tenantId, customerId: customer.id, title: 'last winter' });
    await pg.query(`update jobs set status = 'paid' where id = $1`, [older.id]);
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
      },
      stub({ followUp: 'wants a callback' }),
    );
    expect(r.observationId).toBeUndefined();
    expect(await observationsFor(capture.id)).toHaveLength(0);
    // Filed on their most recent job WHATEVER its status, which is what lets the
    // original item close on the record.
    expect(r.jobId).toBe(older.id);
    expect(await jobCaptureLinks(older.id)).toBe(1);
  });

  test('a settled re-entry still ASKS about a promise — settling WHO is not deciding WHETHER', async () => {
    // The one loss with a cost outside this database: the customer was told
    // somebody is coming. Knowing who they are does not answer that.
    const capture = await parkedCall('it is Tom — and you said someone would come out Friday');
    const customer = await createCustomer({ tenantId, name: 'Promised Pia' });
    const older = await createJob({ tenantId, customerId: customer.id, title: 'last winter' });
    await pg.query(`update jobs set status = 'paid' where id = $1`, [older.id]);
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
      },
      stub({ visitCommitted: true, touchesOperations: false }), // a commitment outranks the filter
    );
    expect(r.observationId).toBeDefined();
    const obs = await observationsFor(capture.id);
    expect(obs.map((o) => o.kind)).toEqual(['inbound_commitment']);
    // …and the call is still filed, so the ORIGINAL item can still close.
    expect(await jobCaptureLinks(older.id)).toBe(1);
  });

  test('a decided bookVisit:false silences that question on a re-entry too', async () => {
    const capture = await parkedCall('we said someone would come, but never mind');
    const customer = await createCustomer({ tenantId, name: 'Never Mind Nell' });
    const older = await createJob({ tenantId, customerId: customer.id, title: 'old work' });
    await pg.query(`update jobs set status = 'paid' where id = $1`, [older.id]);
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
        decided: { bookVisit: false },
      },
      stub({ visitCommitted: true }),
    );
    expect(r.observationId).toBeUndefined();
    expect(await observationsFor(capture.id)).toHaveLength(0);
  });

  test('a RETRACTED capture stays terminal, however it is re-entered', async () => {
    const capture = await parkedCall('recorded in error');
    await appendRawCapture({
      tenantId,
      channel: 'manual_correction',
      technicianRef: 'tech-retractor',
      rawText: 'that call was a wrong number',
      retractsCaptureId: capture.id,
    });
    const customer = await createCustomer({ tenantId, name: 'Retracted Rae' });
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'phone-line',
        channel: 'phone_call',
        text: capture.raw_text,
        captureId: capture.id,
        resolved: { customerId: customer.id },
        decided: { openJob: { title: 'should never exist' } },
      },
      stub({}),
    );
    expect(r.status).toBe('duplicate');
    expect(await listJobsForCustomer(customer.id)).toHaveLength(0);
  });

  test("another firm's capture is refused, not re-entered", async () => {
    const { rows } = await pg.query<{ id: string }>(
      "insert into tenants (name) values ('re-entry-foreign-probe') returning id",
    );
    const foreign = await appendRawCapture({
      tenantId: rows[0].id,
      channel: 'phone_call',
      rawText: 'not ours',
    });
    const customer = await createCustomer({ tenantId, name: 'Not Theirs' });
    await expect(
      recordFieldNote(
        {
          tenantId,
          technicianRef: 'phone-line',
          channel: 'phone_call',
          text: 'not ours',
          captureId: foreign.id,
          resolved: { customerId: customer.id },
        },
        stub({}),
      ),
    ).rejects.toThrow(/not this firm/);
  });
});
