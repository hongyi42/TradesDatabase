import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { syncScheduleFromSheet, type ScheduleRow } from './sheetSync.js';

// Integration test against the TEST project with a STUBBED SheetReader (no
// Google). Verifies the sync is idempotent and edits update in place.
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
  test('syncing the same sheet twice is idempotent — no duplicate rows', async () => {
    const stub = { read: async () => baseRows };

    const first = await syncScheduleFromSheet(tenantId, 'sheet-1', stub);
    expect(first.upserted).toBe(2);
    expect(await rowCount()).toBe(2);

    const second = await syncScheduleFromSheet(tenantId, 'sheet-1', stub);
    expect(second.upserted).toBe(2);
    expect(await rowCount()).toBe(2); // still 2 — upsert, not insert

    expect(await addressOf('2')).toBe('1 First St'); // cross-channel read-back
  });

  test('an edited sheet row updates the existing entry in place', async () => {
    const edited: ScheduleRow[] = [
      { ...baseRows[0], addressLine1: '1 First St RENAMED' },
      baseRows[1],
    ];
    await syncScheduleFromSheet(tenantId, 'sheet-1', { read: async () => edited });

    expect(await rowCount()).toBe(2); // no new row
    expect(await addressOf('2')).toBe('1 First St RENAMED');
  });
});
