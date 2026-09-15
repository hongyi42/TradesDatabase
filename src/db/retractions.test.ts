import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  appendRawCapture,
  findRetractionsFor,
  foldRetractions,
  isUniqueViolation,
  type RawCapture,
} from './rawCaptures.js';
import { getCustomerContents } from './context.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createVisit, insertVisitNote } from './visits.js';

// Phase 1 of the note lifecycle: retraction schema + folding primitives.
// Integration tests against the LOCAL stack (testEnvGuard-pinned).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').order('created_at', { ascending: true }).limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

const note = (over: Partial<Parameters<typeof appendRawCapture>[0]> = {}) =>
  appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'tech-fold',
    rawText: 'a note',
    ...over,
  });

const retractionOf = (target: RawCapture, over: Partial<Parameters<typeof appendRawCapture>[0]> = {}) =>
  appendRawCapture({
    tenantId,
    channel: 'retraction',
    technicianRef: 'tech-fold',
    rawText: 'recorded in error',
    retractsCaptureId: target.id,
    customerId: target.customer_id,
    jobId: target.job_id,
    ...over,
  });

describe('retraction schema', () => {
  test('a retraction row lands with retracts_capture_id and the channel enum value', async () => {
    const target = await note();
    const retraction = await retractionOf(target);
    const { rows } = await pg.query<{ retracts_capture_id: string; channel: string }>(
      'select retracts_capture_id, channel from raw_captures where id = $1',
      [retraction.id],
    );
    expect(rows[0].retracts_capture_id).toBe(target.id);
    expect(rows[0].channel).toBe('retraction');
  });

  test('retracts_capture_id FK rejects a nonexistent target', async () => {
    await expect(
      note({ channel: 'retraction', retractsCaptureId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow();
  });

  test('at most one retraction per target: the second insert is a unique violation', async () => {
    const target = await note();
    await retractionOf(target);
    try {
      await retractionOf(target);
      expect.unreachable('second retraction must not land');
    } catch (err) {
      expect(isUniqueViolation(err)).toBe(true);
    }
  });

  test('the append-only trigger covers retraction rows too', async () => {
    const target = await note();
    const retraction = await retractionOf(target);
    await expect(
      pg.query("update raw_captures set raw_text = 'edited' where id = $1", [retraction.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pg.query('delete from raw_captures where id = $1', [retraction.id]),
    ).rejects.toThrow(/append-only/);
  });
});

describe('folding primitives', () => {
  test('findRetractionsFor finds by target id and fast-paths empty input', async () => {
    const target = await note();
    const other = await note();
    const retraction = await retractionOf(target);

    expect(await findRetractionsFor([])).toEqual([]);
    const found = await findRetractionsFor([target.id, other.id]);
    expect(found.map((r) => r.id)).toEqual([retraction.id]);
  });

  test('findRetractionsFor reads past the 8192-byte URL wall, once per retraction', async () => {
    // Callers pass every capture id a customer's context holds, and L1 only
    // grows. One `in.()` past ~205 ids builds a URL PostgREST refuses with 414,
    // which failed the whole read.
    const first = await note();
    const last = await note();
    const rFirst = await retractionOf(first);
    const rLast = await retractionOf(last);
    const filler = Array.from({ length: 498 }, () => randomUUID());
    // 501 ids, and first.id repeated at the end so it lands in a SECOND chunk:
    // the retraction must still come back once, as a single `in.()` returned it.
    const found = await findRetractionsFor([first.id, ...filler, last.id, first.id]);
    expect(found.map((r) => r.id).sort()).toEqual([rFirst.id, rLast.id].sort());
  });

  test('foldRetractions drops the target and all retraction rows, keeps the rest', async () => {
    const target = await note();
    const kept = await note();
    const retraction = await retractionOf(target);

    const folded = foldRetractions([target, kept, retraction], [retraction]);
    expect(folded.map((r) => r.id)).toEqual([kept.id]);
  });

  test('a retraction row is dropped from folded views even when its own retractions list is empty', async () => {
    const target = await note();
    const retraction = await retractionOf(target);
    // Simulates a stamped list that contains the retraction but where the
    // caller's findRetractionsFor lookup covered different ids.
    expect(foldRetractions([retraction], [])).toEqual([]);
  });
});

describe('getCustomerContents retraction fold', () => {
  test('folds a retracted note and the trip it minted; the audit path is captures_page (retrievalLayer.test.ts)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fold Cust', phone: '555-9101' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Fold job' });

    // A good note and a bad note, each backing a visit via source_capture_id
    // (the tech-note shape: capture rows themselves carry NO customer stamp).
    // The bad trip is the LATER one, so lastVisitAt tells the fold apart.
    const goodNote = await note({ rawText: 'good note' });
    const badNote = await note({ rawText: 'bad note — wrong customer' });
    const reported = async (captureId: string, completedAt: string) => {
      const v = await createVisit({
        tenantId,
        jobId: job.id,
        technicianId: null,
        startsAt: null,
        endsAt: null,
        status: 'completed',
        completedAt,
        sourceCaptureId: captureId,
      });
      await insertVisitNote({ tenantId, visitId: v.id, captureId });
      return v;
    };
    await reported(goodNote.id, '2026-08-16T13:00:00.000Z');
    await reported(badNote.id, '2026-08-17T13:00:00.000Z');

    const before = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    expect(before.jobs[0].noteCount).toBe(2);
    expect(before.jobs[0].lastVisitAt).toContain('2026-08-17');

    await retractionOf(badNote, { customerId: customer.id });

    const folded = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    expect(folded.jobs[0].noteCount).toBe(1);
    expect(folded.jobs[0].newest?.captureId).toBe(goodNote.id);
    // The trip the bad note MINTED goes with it (the old recentVisits fold).
    expect(folded.jobs[0].lastVisitAt).toContain('2026-08-16');
    // The retraction row itself never counts as a note, even stamped with the customer.
    expect(folded.customerLevel.noteCount).toBe(0);
  });
});
