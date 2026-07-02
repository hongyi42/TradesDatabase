import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import type { ReviewItem, Technician, UpsertOpenReviewItemInput } from '../db/index.js';
import { syncScheduleFromSheet, type ScheduleRow } from './sheetSync.js';

// Integration test against the TEST project with a STUBBED SheetReader (no
// Google). Verifies the sync is idempotent, edits update in place, and unknown
// refs are flagged (loosely — the row still imports).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

// Roster stub: tech-1/tech-2 are known active refs (typed as full rows; only
// ref/state are read by the sync).
const rosterStub = async (): Promise<Technician[]> =>
  [
    { ref: 'tech-1', state: 'active' },
    { ref: 'tech-2', state: 'active' },
    { ref: 'tech-gone', state: 'offboarded' },
  ] as Technician[];

// Recorder for the flag path (used where the live review_items write is not the
// point of the test).
function flagRecorder() {
  const calls: UpsertOpenReviewItemInput[] = [];
  const fn = async (input: UpsertOpenReviewItemInput): Promise<ReviewItem> => {
    calls.push(input);
    return { id: 'stub-review' } as ReviewItem;
  };
  return { calls, fn };
}

beforeAll(async () => {
  await pg.connect();
  // BY NAME, not limit(1): a leftover tenant from a crashed run must not be
  // picked silently (same hardening as server.test.ts / technicians.test.ts).
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query(
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, review_items cascade',
  );
  await pg.end();
});

const baseRows: ScheduleRow[] = [
  { rowKey: '2', technicianRef: 'tech-1', customerName: 'A', addressLine1: '1 First St', scheduledStart: '2026-06-19T09:00:00.000Z' },
  { rowKey: '3', technicianRef: 'tech-2', customerName: 'B', addressLine1: '2 Second St', scheduledStart: '2026-06-19T11:00:00.000Z' },
];

async function rowCount(): Promise<number> {
  const { rows } = await pg.query<{ n: string }>(
    'select count(*)::int as n from schedule_entries where tenant_id = $1',
    [tenantId],
  );
  return Number(rows[0].n);
}

async function addressOf(rowKey: string): Promise<string | null> {
  const { rows } = await pg.query<{ address_line1: string | null }>(
    'select address_line1 from schedule_entries where tenant_id = $1 and external_row_key = $2',
    [tenantId, rowKey],
  );
  return rows[0]?.address_line1 ?? null;
}

describe('syncScheduleFromSheet', () => {
  test('syncing the same sheet twice is idempotent — no duplicate rows, no flags for known refs', async () => {
    const flag = flagRecorder();
    const stub = { read: async () => baseRows, roster: rosterStub, flagReview: flag.fn };

    const first = await syncScheduleFromSheet(tenantId, 'sheet-1', stub);
    expect(first.upserted).toBe(2);
    expect(first.flagged).toBe(0);
    expect(await rowCount()).toBe(2);

    const second = await syncScheduleFromSheet(tenantId, 'sheet-1', stub);
    expect(second.upserted).toBe(2);
    expect(await rowCount()).toBe(2); // still 2 — upsert, not insert
    expect(flag.calls).toHaveLength(0);

    expect(await addressOf('2')).toBe('1 First St'); // cross-channel read-back
  });

  test('an edited sheet row updates the existing entry in place', async () => {
    const edited: ScheduleRow[] = [
      { ...baseRows[0], addressLine1: '1 First St RENAMED' },
      baseRows[1],
    ];
    await syncScheduleFromSheet(tenantId, 'sheet-1', {
      read: async () => edited,
      roster: rosterStub,
      flagReview: flagRecorder().fn,
    });

    expect(await rowCount()).toBe(2); // no new row
    expect(await addressOf('2')).toBe('1 First St RENAMED');
  });

  test('a typo ref is STILL upserted but flagged with a did-you-mean suggestion', async () => {
    const flag = flagRecorder();
    const rows: ScheduleRow[] = [
      { rowKey: '4', technicianRef: 'tehc-1', customerName: 'C', addressLine1: '3 Third St', scheduledStart: '2026-06-19T13:00:00.000Z' },
    ];
    const result = await syncScheduleFromSheet(tenantId, 'sheet-1', {
      read: async () => rows,
      roster: rosterStub,
      flagReview: flag.fn,
    });

    expect(result).toEqual({ upserted: 1, flagged: 1 }); // loose: the row imported
    expect(await addressOf('4')).toBe('3 Third St');
    expect(flag.calls[0]).toMatchObject({
      kind: 'sheet_ref_mismatch',
      subjectRef: 'tehc-1',
      suggestion: 'tech-1',
      detail: { rowKey: '4' },
    });
  });

  test('an offboarded ref flags like an unknown one (not a valid schedule target)', async () => {
    const flag = flagRecorder();
    const rows: ScheduleRow[] = [
      { rowKey: '5', technicianRef: 'tech-gone', scheduledStart: '2026-06-19T14:00:00.000Z' },
    ];
    const result = await syncScheduleFromSheet(tenantId, 'sheet-1', {
      read: async () => rows,
      roster: rosterStub,
      flagReview: flag.fn,
    });
    expect(result.flagged).toBe(1);
    expect(flag.calls[0]).toMatchObject({ subjectRef: 'tech-gone' });
  });

  test('an EMPTY roster (pre-backfill tenant) imports everything and flags nothing', async () => {
    const flag = flagRecorder();
    const result = await syncScheduleFromSheet(tenantId, 'sheet-1', {
      read: async () => baseRows,
      roster: async () => [],
      flagReview: flag.fn,
    });
    expect(result).toEqual({ upserted: 2, flagged: 0 });
    expect(flag.calls).toHaveLength(0); // no queue flood for tenants not yet on the roster
  });

  test('a failing flag write is advisory: every row still imports', async () => {
    const rows: ScheduleRow[] = [
      { rowKey: '7', technicianRef: 'tehc-1', addressLine1: '7 Seventh St', scheduledStart: '2026-06-19T16:00:00.000Z' },
      { rowKey: '8', technicianRef: 'tech-2', addressLine1: '8 Eighth St', scheduledStart: '2026-06-19T17:00:00.000Z' },
    ];
    const result = await syncScheduleFromSheet(tenantId, 'sheet-1', {
      read: async () => rows,
      roster: rosterStub,
      flagReview: async () => {
        throw new Error('review_items unavailable');
      },
    });
    expect(result).toEqual({ upserted: 2, flagged: 0 }); // no throw, full import
    expect(await addressOf('7')).toBe('7 Seventh St'); // the row AT the failed flag
    expect(await addressOf('8')).toBe('8 Eighth St'); // and the rows after it
  });

  test('LIVE flag path: repeat syncs of the same bad ref keep ONE open review item', async () => {
    const rows: ScheduleRow[] = [
      { rowKey: '6', technicianRef: 'tehc-2', scheduledStart: '2026-06-19T15:00:00.000Z' },
    ];
    // No flagReview stub — exercises the real review_items write (open-dedup).
    await syncScheduleFromSheet(tenantId, 'sheet-1', { read: async () => rows, roster: rosterStub });
    await syncScheduleFromSheet(tenantId, 'sheet-1', { read: async () => rows, roster: rosterStub });

    const { rows: items } = await pg.query<{ suggestion: string | null; status: string }>(
      "select suggestion, status from review_items where tenant_id = $1 and kind = 'sheet_ref_mismatch' and subject_ref = 'tehc-2'",
      [tenantId],
    );
    expect(items).toHaveLength(1); // open-dedup held across syncs
    expect(items[0]).toEqual({ suggestion: 'tech-2', status: 'open' });
  });
});
