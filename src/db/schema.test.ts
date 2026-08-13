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

  test('assignments: times NULLABLE + day-range columns exist (Plan 4b-2)', async () => {
    const cols = await columns('assignments');
    // NULL times = an UNPLACED visit (day known, time not yet).
    expect(cols.get('starts_at')?.is_nullable).toBe('YES');
    expect(cols.get('ends_at')?.is_nullable).toBe('YES');
    expect(cols.get('earliest_date')?.data_type).toBe('date');
    expect(cols.get('latest_date')?.data_type).toBe('date');
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

  // portal_accounts decides which tenant a BROWSER SESSION may read, and the
  // portal is the first surface in this system that outsiders use. If the
  // publishable anon key could reach this table straight through PostgREST, an
  // attacker could grant their own address a row against someone else's tenant
  // and the session layer above would faithfully honour it. These three
  // assertions are what stop that being toggled off without a test going red.
  describe('portal_accounts is closed to the Data API', () => {
    test('RLS is enabled', async () => {
      const { rows } = await client.query<{ relrowsecurity: boolean }>(
        `select relrowsecurity from pg_class where relname = 'portal_accounts'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].relrowsecurity, 'RLS must be ON').toBe(true);
    });

    test('there is no policy — RLS with no policy means anon gets zero rows', async () => {
      const { rows } = await client.query(
        `select policyname from pg_policies where tablename = 'portal_accounts'`,
      );
      // A policy is a door. This table has no legitimate client-side reader, so
      // adding one would be strictly worse (the cost-tables reasoning).
      expect(rows).toHaveLength(0);
    });

    test('anon and authenticated hold no grants', async () => {
      const { rows } = await client.query(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_name = 'portal_accounts' and grantee in ('anon','authenticated')`,
      );
      expect(rows).toHaveLength(0);
    });

    test('email is citext and globally unique — one email, at most one tenant', async () => {
      const { rows: cols } = await client.query<{ udt_name: string }>(
        `select udt_name from information_schema.columns
          where table_name = 'portal_accounts' and column_name = 'email'`,
      );
      expect(cols[0]?.udt_name).toBe('citext');

      // Unique on (email) ALONE. If this ever became (tenant_id, email), one
      // address could resolve to two tenants and session resolution would have to
      // guess — the exact bug class this feature exists to avoid.
      const { rows: idx } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where tablename = 'portal_accounts' and indexdef ilike '%unique%' and indexdef ilike '%email%'`,
      );
      expect(idx).toHaveLength(1);
      expect(idx[0].indexdef).toMatch(/\(email\)/);
    });
  });
});
