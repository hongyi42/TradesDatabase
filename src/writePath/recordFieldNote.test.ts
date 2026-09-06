import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { appendRawCapture } from '../db/rawCaptures.js';
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
    'truncate table customers, jobs, visits, raw_captures, technicians, schedule_events cascade',
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

  test('a LINK-LESS inbound redelivery can still re-apply a stale forward signal — the gap rung 10 closes', async () => {
    // The edge the plan named, pinned as OPEN rather than left implicit. An
    // inbound capture on a job with NO live visit links nothing, so
    // captureHasLinkedL2 cannot short-circuit it: a redelivery re-runs the
    // extractor, and a `completed` signal that was correctly SKIPPED on pass 1
    // (the job was still 'open') becomes legal once the job has reached
    // 'in_progress'. Nothing is duplicated — but a five-week-old email can
    // close a job late. Rung 10 closes it by giving inbound its own visit.
    const { job, phone } = await jobFor('Stale Stan'); // deliberately NO visit
    const note = {
      ...noteBy('connector:gmail', 'email' as const, 'all finished on our end'),
      externalId: 'gmail-stale-signal-1',
    };
    const ext = { phone, customerName: 'Stale Stan', statusSignal: 'completed' as const };
    const first = await recordFieldNote(note, stub(ext));
    expect(first.visitId).toBeUndefined(); // link-less, as designed
    const { rows: after1 } = await pg.query<{ status: string }>(
      'select status from jobs where id = $1',
      [job.id],
    );
    expect(after1[0].status).toBe('open'); // 'completed' is not legal from 'open'

    // The job moves on, then the same message is delivered again.
    await pg.query("update jobs set status = 'in_progress' where id = $1", [job.id]);
    const second = await recordFieldNote(note, stub(ext));
    expect(second.captureId).toBe(first.captureId); // same L1 row, re-run
    const { rows: after2 } = await pg.query<{ status: string }>(
      'select status from jobs where id = $1',
      [job.id],
    );
    // DOCUMENTS the gap: the stale signal lands the second time around.
    expect(after2[0].status).toBe('completed');
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

  // REVIEW FINDING, rung 9b. The dedup short-circuit keys on captureHasLinkedL2,
  // and before the merge an email ALWAYS left a link because it always minted a
  // visit. It no longer does — a customer's email is not a trip — so when the
  // note resolves to an EXISTING customer AND an existing open job, nothing new
  // carries the capture id and the redelivery falls through to the orphan-heal
  // path: extract runs again (one model call), and the note is re-applied.
  // That is bounded and SAFE, which is what this pins: no second L1 row, no
  // second customer, no second job, no visit. The pre-existing case above only
  // proved it for a customer with no job yet, where the job's own
  // source_capture_id still marks the capture processed.
  test('an email redelivered onto an EXISTING customer+job re-runs, but writes nothing twice', async () => {
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
    const first = await recordFieldNote(note, stub({ phone: '555-7171' }));
    expect(first.status).toBe('matched');
    expect(first.visitId).toBeUndefined(); // an email is not a trip
    const jobsAfterFirst = (await listJobsForCustomer(customer.id)).length;
    const visitsAfterFirst = await visitCount();

    const second = await recordFieldNote(note, stub({ phone: '555-7171' }));
    // It RE-RUNS rather than short-circuiting — asserted explicitly, or this
    // test would pass identically if the dedup had caught it, and would stop
    // describing the behaviour it exists to document.
    expect(second.status).toBe('matched'); // not 'duplicate' — the fall-through
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

    // Redelivery: reuse the orphan L1 (no second row), extract succeeds → L2 built.
    const healed = await recordFieldNote(note, { extract: flaky });
    expect(healed.status).toBe('matched');
    expect(healed.customerId).toBe(customer.id);
    const l1b = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [externalId],
    );
    expect(Number(l1b.rows[0].n)).toBe(1); // SAME row reused, not re-appended
    expect((await listJobsForCustomer(customer.id)).length).toBe(1); // healed → job exists

    // Third delivery now finds linked L2 → real duplicate no-op (no new job).
    const third = await recordFieldNote(note, { extract: flaky });
    expect(third.status).toBe('duplicate');
    expect((await listJobsForCustomer(customer.id)).length).toBe(1);
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

  test('structure omitted → still structures (default true unchanged)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Default Structures', phone: '555-9090' });
    const r = await recordFieldNote(
      { tenantId, technicianRef: 'phone-line', channel: 'phone_call', text: 'furnace down' },
      stub({ phone: '555-9090', workPerformed: 'furnace repair' }),
    );
    expect(r.status).toBe('matched');
    expect(r.customerId).toBe(customer.id); // L2 built when structure is left default
    expect(r.jobId).toBeDefined();
    // INVERTED by rung 9b: a phone call is NOT a trip. `visits` is now the
    // schedule, so minting a row here would put a visit nobody made on the
    // board and brief it as past work. Only a TECHNICIAN channel evidences a
    // trip; a call that commits one is rung 10, and creates it UNPLACED.
    expect(r.visitId).toBeUndefined();
  });
});
