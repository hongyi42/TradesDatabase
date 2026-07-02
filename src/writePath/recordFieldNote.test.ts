import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { createCustomer } from '../db/customers.js';
import { createJob, listJobsForCustomer } from '../db/jobs.js';
import { upsertScheduleEntry } from '../db/scheduleEntries.js';
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
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
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

  test('create-from-schedule: an unlinked scheduled entry prefills the new customer from the sheet row, not the (empty) extraction', async () => {
    const tech = 'tech-sched-rfn';
    const day = new Date().toISOString().slice(0, 10); // align with the capture's UTC day
    await upsertScheduleEntry({
      tenantId,
      technicianRef: tech,
      externalRowKey: 'rfn-1',
      customerName: 'Sheet Cust',
      phone: '555-7700',
      addressLine1: '88 Sheet St',
      scheduledStart: `${day}T12:00:00.000Z`,
    });

    // First call: the note matches no existing customer → propose the scheduled address.
    const first = await recordFieldNote(
      { tenantId, technicianRef: tech, channel: 'technician_voice', text: 'all done here' },
      stub({ workPerformed: 'all done here' }), // extraction has NO customer details
    );
    expect(first.status).toBe('needs_confirmation');
    expect(first.suggestion?.address).toBe('88 Sheet St');

    // Resume confirming that address → create-new prefilled from the sheet row.
    const resumed = await recordFieldNote(
      {
        tenantId,
        technicianRef: tech,
        channel: 'technician_voice',
        captureId: first.captureId,
        confirmed: { address: '88 Sheet St' },
      },
      stub({ workPerformed: 'all done here' }),
    );
    expect(resumed.status).toBe('matched');

    const cust = await pg.query<{ name: string; phone: string | null; address_line1: string | null }>(
      'select name, phone, address_line1 from customers where id = $1',
      [resumed.customerId],
    );
    expect(cust.rows[0]).toMatchObject({
      name: 'Sheet Cust', // from the sheet (createFrom), not 'Unknown customer'
      phone: '555-7700',
      address_line1: '88 Sheet St',
    });
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

  test('an unresolvable first call writes L1 once and returns needs_disambiguation; resume creates a new customer without a second L1', async () => {
    const before = await rawCaptureCount();

    // First call: nothing matches → ask.
    const first = await recordFieldNote(
      { tenantId, technicianRef: 'tech-bob', channel: 'technician_note', text: 'fixed a leak' },
      stub({ workPerformed: 'fixed a leak', address: '77 Unmatched Way' }),
    );
    expect(first.status).toBe('needs_disambiguation');
    expect(await rawCaptureCount()).toBe(before + 1); // exactly one L1 appended

    // Resume with a confirmed address that still matches nothing → create-new.
    const resumed = await recordFieldNote(
      {
        tenantId,
        technicianRef: 'tech-bob',
        channel: 'technician_note',
        captureId: first.captureId,
        confirmed: { address: '77 Unmatched Way' },
      },
      stub({ customerName: 'Brand New', address: '77 Unmatched Way', workPerformed: 'fixed a leak' }),
    );
    expect(resumed.status).toBe('matched');
    expect(resumed.captureId).toBe(first.captureId); // same capture
    expect(await rawCaptureCount()).toBe(before + 1); // NO second L1

    const created = await pg.query<{ address_line1: string | null; source_capture_id: string | null }>(
      'select address_line1, source_capture_id from customers where id = $1',
      [resumed.customerId],
    );
    expect(created.rows[0].address_line1).toBe('77 Unmatched Way');
    expect(created.rows[0].source_capture_id).toBe(first.captureId);

    const visit = await pg.query<{ source_capture_id: string | null }>(
      'select source_capture_id from visits where id = $1',
      [resumed.visitId],
    );
    expect(visit.rows[0].source_capture_id).toBe(first.captureId);
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
});
