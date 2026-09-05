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

  test('customers carries nullable solver coordinates (plan 4b-3 Phase 2)', async () => {
    const cols = await columns('customers');
    expect(cols.get('lat')?.data_type, 'customers.lat').toBe('double precision');
    expect(cols.get('lng')?.data_type, 'customers.lng').toBe('double precision');
    expect(cols.get('geocoded_at')?.udt_name, 'customers.geocoded_at').toBe('timestamptz');
    for (const c of ['lat', 'lng', 'geocoded_at']) {
      expect(cols.get(c)?.is_nullable, `customers.${c} nullable`).toBe('YES');
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

  test('scheduling foundation tables exist', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('technician_time_off','job_type_durations','assignments')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'assignments',
      'job_type_durations',
      'technician_time_off',
    ]);
  });

  test('scheduling columns exist: tenants.timezone + technicians.availability', async () => {
    const tenantCols = await columns('tenants');
    expect(tenantCols.get('timezone')?.data_type).toBe('text');
    expect(tenantCols.get('timezone')?.is_nullable).toBe('NO');
    expect(tenantCols.get('default_job_minutes')?.data_type).toBe('integer');

    const techCols = await columns('technicians');
    expect(techCols.get('availability')?.data_type).toBe('jsonb');
    expect(techCols.get('availability')?.is_nullable, 'NULL = unschedulable (fail closed)').toBe(
      'YES',
    );
    expect(techCols.get('service_cities')?.data_type).toBe('ARRAY');
  });

  test('jobs.duration_minutes exists and is NULLABLE (Plan 4b-1)', async () => {
    const jobCols = await columns('jobs');
    expect(jobCols.get('duration_minutes')?.data_type).toBe('integer');
    // NULL = "never been told" — it must stay representable, because inbound
    // capture mints jobs with nobody to ask. Readers stay fail-closed on null.
    expect(
      jobCols.get('duration_minutes')?.is_nullable,
      'NULL = length unknown (fail closed, never defaulted)',
    ).toBe('YES');
  });

  test('assignments: times NULLABLE, and the rails are GONE (Plan 4b-2, rung 9a)', async () => {
    const cols = await columns('assignments');
    // NULL times = an UNTIMED visit: committed work with no time set.
    expect(cols.get('starts_at')?.is_nullable).toBe('YES');
    expect(cols.get('ends_at')?.is_nullable).toBe('YES');
    // INVERTED: these four asserted the promise ladder and the stored window
    // EXIST. Rung 9a deleted both — a commitment frozen in a column is stale
    // the moment the customer calls back, so promises live in L1 where the
    // agent reads them, and a visit has a time or it does not.
    for (const gone of ['promise_level', 'promised_day', 'earliest_date', 'latest_date']) {
      expect(cols.get(gone), `${gone} must be dropped`).toBeUndefined();
    }
  });

  test('the narrowed overlap guard carries the starts_at predicate (Plan 4b-2)', async () => {
    const { rows } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'no_confirmed_overlap'
          and conrelid = 'public.assignments'::regclass`,
    );
    expect(rows).toHaveLength(1);
    // Unplaced rows are demand, not schedule — they must sit OUTSIDE the guard
    // or tstzrange(null,null) blocks the technician's entire calendar.
    expect(rows[0].def).toContain('starts_at IS NOT NULL');
  });

  test('assignments carries the no_confirmed_overlap exclusion constraint', async () => {
    const { rows } = await client.query<{ conname: string; contype: string }>(
      `select conname, contype from pg_constraint
        where conname = 'no_confirmed_overlap'
          and conrelid = 'public.assignments'::regclass`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contype, 'x = exclusion constraint').toBe('x');
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
