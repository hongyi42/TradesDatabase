import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from './tenants.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createVisit, insertVisitNote } from './visits.js';
import { createPendingNudge } from './nudges.js';
import { upsertOpenReviewItem } from './reviewItems.js';
import { nl } from './time.js';

// ④'s views (plan 2026-08-23), as folded by plan 3 of the retrieval layer
// (2026-09-15): v_captures, v_capture_links, v_nudges, v_review_items — asserted
// against the real database, the querySpine.test.ts discipline. Isolation rests
// on the transaction-local GUC, sensitivity is NOT filtered (user ruling: the
// planner reads everything), and a RETRACTED note is removed, not labelled
// (operator ruling 3, 2026-09-15 — superseding the 2026-08-23 labelled trail).
//
// Cleanup is TRUNCATE, the rawCaptures.test.ts house pattern — this suite
// inserts L1 rows, whose trigger refuses DELETE, so per-row cleanup dead-ends
// on the tenants FK. vitest runs test FILES sequentially (fileParallelism:
// false) for exactly this.
const pg = new Client({ connectionString: process.env.DATABASE_URL });

let tenantA: string;
let tenantB: string;
let jobA: string;
let capPlain: string; // job-stamped, NULL sensitivity
let capSensitive: string; // manager_only
let capRetracted: string; // has a retraction pointing at it
let capUnstamped: string; // NO job_id — linked to jobA only via its visit note
let visitA: string; // tenant A's reported trip — the isolation marker
let visitB: string; // tenant B's reported trip — the isolation marker
let nudgeMalformed: string; // context.jobId is not a uuid

const run = (tenant: string, sql: string) =>
  pg.query('select query_spine($1::uuid, $2::text, $3::int) as result', [tenant, sql, null]);
const rows = async (tenant: string, sql: string): Promise<Record<string, unknown>[]> =>
  (await run(tenant, sql)).rows[0].result as Record<string, unknown>[];

// Direct inserts for L1 fixtures (the rawCaptures.test.ts precedent): the
// append-only trigger blocks UPDATE/DELETE, never INSERT, so a fixture may
// shape its own rows — and must, for sensitivity and retraction shapes the
// typed writers only produce through whole pipelines.
const capture = async (
  tenantId: string,
  text: string,
  over: { jobId?: string; sensitivity?: string; retracts?: string } = {},
): Promise<string> => {
  const r = await pg.query<{ id: string }>(
    `insert into raw_captures (tenant_id, channel, technician_ref, raw_text, job_id, sensitivity, retracts_capture_id)
     values ($1, $2, 'sv-tech', $3, $4, $5, $6) returning id`,
    [
      tenantId,
      over.retracts ? 'retraction' : 'technician_note',
      text,
      over.jobId ?? null,
      over.sensitivity ?? null,
      over.retracts ?? null,
    ],
  );
  return r.rows[0].id;
};

beforeAll(async () => {
  await pg.connect();
  tenantA = (await createTenant('sv-tenant-a', { managerSeats: 2 })).id;
  tenantB = (await createTenant('sv-tenant-b', { managerSeats: 2 })).id;

  const customerA = await createCustomer({ tenantId: tenantA, name: 'SV Customer A' });
  jobA = (await createJob({ tenantId: tenantA, customerId: customerA.id, title: 'SV Job A' })).id;

  capPlain = await capture(tenantA, 'gate code is 4417, dog is friendly', { jobId: jobA });
  capSensitive = await capture(tenantA, 'Agent action: GMAIL_SEND — argument keys: to, subject', {
    jobId: jobA,
    sensitivity: 'manager_only',
  });
  capRetracted = await capture(tenantA, 'quoted $450 for the pump', { jobId: jobA });
  await capture(tenantA, 'recorded in error — wrong customer', { retracts: capRetracted });

  // THE FLAGSHIP SHAPE: identity resolves after the L1 append, so the note has
  // NO job stamp — its only durable link to jobA is the visit's
  // source_capture_id (the two-home doctrine, rawCaptures.ts).
  capUnstamped = await capture(tenantA, 'came to eighty dollars in parts');
  visitA = (
    await createVisit({
      tenantId: tenantA,
      jobId: jobA,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: nl('2026-08-16T13:00:00.000Z'),
      sourceCaptureId: capUnstamped,
    })
  ).id;
  await insertVisitNote({ tenantId: tenantA, visitId: visitA, captureId: capUnstamped });

  // Tenant B: one of everything, so isolation tests have real data to leak.
  const customerB = await createCustomer({ tenantId: tenantB, name: 'SV Customer B' });
  const jobB = (await createJob({ tenantId: tenantB, customerId: customerB.id, title: 'SV Job B' })).id;
  const capB = await capture(tenantB, 'tenant B private note', { jobId: jobB });
  // A reported trip on BOTH sides. The distinctive marker used to be a string
  // in technician_name; v_capture_links carries only ids, so the VISIT'S OWN UUID
  // is the marker — still a value that can actually appear in a leaked row,
  // which is the property that keeps this leak scan from passing vacuously.
  visitB = (
    await createVisit({
      tenantId: tenantB,
      jobId: jobB,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: nl('2026-08-16T13:00:00.000Z'),
      sourceCaptureId: capB,
    })
  ).id;
  await insertVisitNote({ tenantId: tenantB, visitId: visitB, captureId: capB });

  const techRow = await pg.query<{ id: string }>(
    `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
     values ($1, 'sv-nudge-tech', 'SV Nudge Tech', 'technician', 'active', true) returning id`,
    [tenantA],
  );
  const good = await createPendingNudge({
    tenantId: tenantA,
    kind: 'overdue_visit_gap',
    subjectRef: 'sv-asg-good',
    technicianId: techRow.rows[0].id,
    context: { jobId: jobA },
  });
  const bad = await createPendingNudge({
    tenantId: tenantA,
    kind: 'overdue_visit_gap',
    subjectRef: 'sv-asg-bad',
    technicianId: techRow.rows[0].id,
    context: { jobId: 'not-a-uuid' },
  });
  if (!good || !bad) throw new Error('nudge fixtures were not created');
  nudgeMalformed = bad.id;

  await upsertOpenReviewItem({
    tenantId: tenantA,
    kind: 'overdue_visit_gap',
    subjectRef: 'sv-item-a',
    detail: { jobId: jobA, technicianRef: 'sv-tech', escalatedFromNudge: good.id },
  });
  await upsertOpenReviewItem({
    tenantId: tenantB,
    kind: 'overdue_visit_gap',
    subjectRef: 'sv-item-b',
    detail: { jobId: jobB },
  });
});

afterAll(async () => {
  await pg.query(
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, technicians, review_items, nudges cascade',
  );
  await pg.query('delete from tenants where id = any($1::uuid[])', [[tenantA, tenantB]]);
  await pg.end();
});

describe('the four views — tenant isolation', () => {
  // Markers BOTH WAYS (the querySpine.test.ts discipline), and one marker that
  // can actually appear in each view's rows — a leak test whose marker cannot
  // occur in the leaked shape passes vacuously (review finding: v_visits rows
  // carry no capture text, so scanning them for 'gate code' proved nothing).
  // Built INSIDE the test: the visit-id markers are assigned in beforeAll, which
  // runs after this describe body is evaluated.
  const markers = () => ({
    a: ['gate code', 'sv-asg-good', 'sv-item-a', visitA],
    b: ['tenant B private note', 'sv-item-b', visitB],
  });
  test.each(['v_captures', 'v_capture_links', 'v_nudges', 'v_review_items'])(
    '%s never returns another tenant’s rows — markers both ways',
    async (view) => {
      const a = JSON.stringify(await rows(tenantA, `select * from ${view}`));
      const b = JSON.stringify(await rows(tenantB, `select * from ${view}`));
      const { a: A_MARKERS, b: B_MARKERS } = markers();
      for (const m of A_MARKERS) expect(b).not.toContain(m);
      for (const m of B_MARKERS) expect(a).not.toContain(m);
    },
  );

  test('every view has real rows on BOTH sides — the leak scans above are not empty-vs-empty', async () => {
    for (const view of ['v_captures', 'v_capture_links', 'v_review_items']) {
      expect((await rows(tenantA, `select * from ${view}`)).length).toBeGreaterThan(0);
      expect((await rows(tenantB, `select * from ${view}`)).length).toBeGreaterThan(0);
    }
    // nudges exist for tenant A only (a B-side nudge needs a roster row it
    // doesn't have); its A-side markers are covered by the both-ways scan.
    expect((await rows(tenantA, 'select * from v_nudges')).length).toBeGreaterThan(0);
  });
});

describe('v_captures — retracted notes are removed, not labelled', () => {
  test('a retracted capture is ABSENT, and so is the retraction row', async () => {
    expect(await rows(tenantA, `select id from v_captures where id = '${capRetracted}'`)).toHaveLength(0);
    // The retraction's own words ('recorded in error — wrong customer') are not
    // a note about the job either.
    const texts = (await rows(tenantA, 'select raw_text from v_captures')).map((r) => r.raw_text);
    expect(texts).not.toContain('recorded in error — wrong customer');
    expect(texts).not.toContain('quoted $450 for the pump');
  });

  test('the retraction columns are gone — a query naming one fails loudly', async () => {
    await expect(rows(tenantA, 'select retracted from v_captures')).rejects.toThrow(/retracted/);
  });

  test('an unretracted capture is still there', async () => {
    const found = await rows(tenantA, `select raw_text from v_captures where id = '${capPlain}'`);
    expect(found.map((r) => r.raw_text)).toEqual(['gate code is 4417, dog is friendly']);
  });

  test('manager_only rows ARE returned — the planner reads everything (user ruling)', async () => {
    const [r] = await rows(
      tenantA,
      `select sensitivity, raw_text from v_captures where id = '${capSensitive}'`,
    );
    expect(r.sensitivity).toBe('manager_only');
    expect(String(r.raw_text)).toContain('Agent action');
  });

  test('THE TRAP, documented: != drops the NULL-sensitivity rows; is distinct from keeps them', async () => {
    // The catalog warns the model about exactly this. If someone ever adds a
    // sensitivity filter to a view or a canned query, this is the regression.
    const neq = await rows(
      tenantA,
      `select id from v_captures where sensitivity != 'manager_only'`,
    );
    expect(neq).toHaveLength(0); // every non-sensitive row is NULL — all silently dropped
    const idf = await rows(
      tenantA,
      `select id from v_captures where sensitivity is distinct from 'manager_only'`,
    );
    expect(idf).toHaveLength(2); // plain + unstamped (the retracted pair is folded away)
  });
});

describe('v_capture_links — the one note→record bridge', () => {
  test('an UNSTAMPED note is reachable by its job — through the trip it reported', async () => {
    // A technician note carries no job stamp by design (identity resolves after
    // the immutable L1 append). v_captures no longer has a job column to tempt
    // the model; the links view is the only way in, and it finds the note.
    const bridged = await rows(
      tenantA,
      `select distinct c.raw_text from v_captures c
         join v_capture_links l on l.capture_id = c.id
        where l.job_id = '${jobA}'`,
    );
    expect(bridged.map((r) => r.raw_text)).toContain('came to eighty dollars in parts');
    const vias = (
      await rows(tenantA, `select via from v_capture_links where capture_id = '${capUnstamped}'`)
    ).map((r) => r.via);
    expect(vias).toEqual(expect.arrayContaining(['visit_note', 'created_visit']));
  });

  test('a retracted note has no link rows', async () => {
    expect(
      await rows(tenantA, `select via from v_capture_links where capture_id = '${capRetracted}'`),
    ).toHaveLength(0);
  });

  test("a link row stamped with OUR tenant pointing at ANOTHER firm's capture never appears", async () => {
    // job_captures.capture_id is an id-only foreign key: a row carrying tenant
    // A's tenant_id and job, but tenant B's capture, must not hand B's words to A.
    const foreign = await capture(tenantB, 'tenant B words smuggled by a link');
    await pg.query('insert into job_captures (tenant_id, job_id, capture_id) values ($1, $2, $3)', [
      tenantA,
      jobA,
      foreign,
    ]);
    expect(
      await rows(tenantA, `select capture_id from v_capture_links where capture_id = '${foreign}'`),
    ).toHaveLength(0);
  });

  test('the view and captures_page agree on a job’s live notes — the two copies of the fold cannot drift', async () => {
    const viaView = (
      await rows(
        tenantA,
        `select distinct c.id from v_captures c join v_capture_links l on l.capture_id = c.id
          where l.job_id = '${jobA}'`,
      )
    )
      .map((r) => String(r.id))
      .sort();
    const page = await pg.query<{ result: { captures: { id: string }[] } }>(
      `select captures_page($1::uuid, 'job', $2::uuid, 'planner', p_limit => 50) as result`,
      [tenantA, jobA],
    );
    const viaPage = page.rows[0].result.captures.map((c) => c.id).sort();
    expect(viaView.length).toBeGreaterThan(0);
    expect(viaView).toEqual(viaPage);
  });
});

describe('v_nudges / v_review_items', () => {
  test('a malformed context jobId yields NULL, and the query SUCCEEDS', async () => {
    const [r] = await rows(
      tenantA,
      `select job_id, subject_ref from v_nudges where id = '${nudgeMalformed}'`,
    );
    expect(r.job_id).toBeNull();
    expect(r.subject_ref).toBe('sv-asg-bad');
  });

  test('a well-formed context jobId casts to a real uuid', async () => {
    const found = await rows(
      tenantA,
      `select subject_ref from v_nudges where job_id = '${jobA}'`,
    );
    expect(found.map((r) => r.subject_ref)).toContain('sv-asg-good');
  });

  test('v_review_items lifts jobId / technicianRef / escalatedFromNudge out of detail', async () => {
    const [r] = await rows(
      tenantA,
      `select job_id, technician_ref, escalated_from_nudge, status from v_review_items where subject_ref = 'sv-item-a'`,
    );
    expect(r.job_id).toBe(jobA);
    expect(r.technician_ref).toBe('sv-tech');
    expect(r.escalated_from_nudge).toBeTruthy();
    expect(r.status).toBe('open');
  });
});

describe('the ACL holds', () => {
  test('SELECT on the four views; no writes; base tables still unreachable', async () => {
    for (const view of ['v_captures', 'v_capture_links', 'v_nudges', 'v_review_items']) {
      const { rows: priv } = await pg.query(
        `select has_table_privilege('spine_reader', $1, 'SELECT') as sel,
                has_table_privilege('spine_reader', $1, 'INSERT') as ins,
                has_table_privilege('spine_reader', $1, 'UPDATE') as upd,
                has_table_privilege('spine_reader', $1, 'DELETE') as del`,
        [view],
      );
      expect(priv[0]).toEqual({ sel: true, ins: false, upd: false, del: false });
    }
    for (const base of ['raw_captures', 'visits', 'nudges', 'review_items']) {
      const { rows: priv } = await pg.query(
        `select has_table_privilege('spine_reader', $1, 'SELECT') as sel`,
        [base],
      );
      expect(priv[0].sel).toBe(false);
    }
  });
});
