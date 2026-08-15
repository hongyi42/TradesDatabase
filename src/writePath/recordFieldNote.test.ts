import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { appendRawCapture } from '../db/rawCaptures.js';
import { createCustomer } from '../db/customers.js';
import { createJob, listJobsForCustomer } from '../db/jobs.js';
import { createAssignment } from '../db/assignments.js';
import { insertTechnician } from '../db/technicians.js';
import { setTenantSeats } from '../db/tenants.js';
import { localDateISO } from '../schedule/availability.js';
import { recordFieldNote } from './recordFieldNote.js';
import type { Extractor, ExtractedFields } from './extract.js';

// Integration test against the TEST project with a STUBBED extractor (no live
// model), exercising the full L1 → extract → match → L2/L3 write-path.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
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
      technician_name: string | null;
    }>('select labor_hours, source_capture_id, technician_name from visits where id = $1', [r.visitId]);
    expect(Number(visit.rows[0].labor_hours)).toBe(2.5);
    expect(visit.rows[0].source_capture_id).toBe(r.captureId);
    expect(visit.rows[0].technician_name).toBe('tech-jane');
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
    await createAssignment({
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
    expect(r.customerId).toBe(customer.id);
    expect(r.visitId).toBeDefined(); // L2 built when structure is left default
  });
});
