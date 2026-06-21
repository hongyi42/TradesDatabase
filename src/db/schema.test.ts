import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';

// Structural assertions run against the live test project over a direct pg
// connection — supabase-js/PostgREST cannot reach information_schema.
const client = new Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

type ColumnInfo = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
};

async function columns(table: string): Promise<Map<string, ColumnInfo>> {
  const { rows } = await client.query<ColumnInfo>(
    `select column_name, data_type, udt_name, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, r]));
}

describe('context spine schema', () => {
  test('all five spine tables exist', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('tenants','customers','jobs','visits','raw_captures')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'customers',
      'jobs',
      'raw_captures',
      'tenants',
      'visits',
    ]);
  });

  test('each L2 table has a jsonb attributes column and a nullable source_capture_id', async () => {
    for (const table of ['customers', 'jobs', 'visits']) {
      const cols = await columns(table);
      expect(cols.get('attributes')?.data_type, `${table}.attributes`).toBe('jsonb');
      expect(cols.get('source_capture_id')?.data_type, `${table}.source_capture_id`).toBe('uuid');
      expect(cols.get('source_capture_id')?.is_nullable, `${table}.source_capture_id`).toBe('YES');
    }
  });

  test('jobs.status uses the job_status enum', async () => {
    const status = (await columns('jobs')).get('status');
    expect(status?.data_type).toBe('USER-DEFINED');
    expect(status?.udt_name).toBe('job_status');
  });

  test('raw_captures provenance FKs are nullable', async () => {
    const cols = await columns('raw_captures');
    for (const c of ['customer_id', 'job_id', 'visit_id']) {
      expect(cols.get(c)?.is_nullable, `raw_captures.${c}`).toBe('YES');
    }
  });

  test('schedule_entries exists with a unique (tenant_id, external_row_key) index', async () => {
    const cols = await columns('schedule_entries');
    expect(cols.size, 'schedule_entries table exists').toBeGreaterThan(0);
    expect(cols.get('external_row_key')?.is_nullable, 'external_row_key NOT NULL').toBe('NO');
    expect(cols.get('technician_ref')?.is_nullable, 'technician_ref NOT NULL').toBe('NO');

    const { rows } = await client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'schedule_entries'`,
    );
    const hasUnique = rows.some(
      (r) => /unique/i.test(r.indexdef) && /\(tenant_id, external_row_key\)/i.test(r.indexdef),
    );
    expect(hasUnique, 'unique index on (tenant_id, external_row_key)').toBe(true);
  });

  // The L1 invariant: raw_captures is append-only. The whole probe runs inside a
  // transaction that is rolled back, so nothing persists (and DELETE is blocked
  // by the same trigger, so a committed probe row could not be cleaned up).
  test('raw_captures is append-only — UPDATE is blocked by the trigger', async () => {
    await client.query('begin');
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into raw_captures (tenant_id, channel, raw_text)
           values ((select id from tenants limit 1), 'phone_call', '__append_only_probe__')
         returning id`,
      );
      const id = rows[0].id;
      await expect(
        client.query(`update raw_captures set raw_text = 'changed' where id = $1`, [id]),
      ).rejects.toThrow(/append-only/);
    } finally {
      await client.query('rollback');
    }
  });
});
