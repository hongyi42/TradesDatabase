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
          and table_name in ('technician_time_off','job_type_durations','visits')`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'job_type_durations',
      'technician_time_off',
      'visits',
    ]);
  });

  // Rung 9b: the schedule table WAS `assignments` and the word is now gone —
  // there is one `visits` object, and a view of the old name would only exist
  // during the deploy window (20260906140100 drops it). A stray table of that
  // name would mean the rename half-happened.
  test('there is no `assignments` relation left — one visit object, one name', async () => {
    const { rows } = await client.query<{ relkind: string }>(
      `select relkind from pg_class
        where relname = 'assignments' and relnamespace = 'public'::regnamespace`,
    );
    expect(rows).toEqual([]);
  });

  test('visits absorbed the happened-stage columns the per-note table carried', async () => {
    const cols = await columns('visits');
    // From the SCHEDULE half…
    for (const scheduled of ['starts_at', 'ends_at', 'status', 'reason']) {
      expect(cols.get(scheduled), `visits.${scheduled}`).toBeDefined();
    }
    // INVERTED by rung 9c: WHO goes is not a column on the trip. A crew has no
    // lead, and one nullable FK could only ever hold one of them, so the person
    // lives in `visit_participants` — where the double-booking guard can see
    // both the person and the times on one row.
    expect(cols.get('technician_id'), 'the person moved to visit_participants').toBeUndefined();
    // …and from the REPORT half, which used to live in a second table.
    expect(cols.get('started_at')?.data_type).toBe('timestamp with time zone');
    expect(cols.get('completed_at')?.data_type).toBe('timestamp with time zone');
    expect(cols.get('labor_hours')?.data_type).toBe('numeric');
    expect(cols.get('attributes')?.data_type).toBe('jsonb');
    // The old table's never-written column did NOT come along: a trip's time is
    // starts_at, and nothing ever set scheduled_at.
    expect(cols.get('scheduled_at'), 'scheduled_at must not be resurrected').toBeUndefined();
    // technician_name was free TEXT with no FK; the survivor has the real key.
    expect(cols.get('technician_name'), 'technician_name must be gone').toBeUndefined();
  });

  test('visit_notes links a capture to a trip, and is append-only on UPDATE only', async () => {
    const cols = await columns('visit_notes');
    for (const c of ['tenant_id', 'visit_id', 'capture_id', 'created_at']) {
      expect(cols.get(c), `visit_notes.${c}`).toBeDefined();
    }
    const { rows: trig } = await client.query<{ def: string }>(
      `select pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.visit_notes'::regclass and not tgisinternal`,
    );
    expect(trig).toHaveLength(1);
    expect(trig[0].def).toContain('BEFORE UPDATE');
    // DELETE is deliberately NOT blocked: the link must die with its visit, or
    // a note would pin an L2 row forever (the trap rung 9b exists to escape).
    expect(trig[0].def).not.toContain('DELETE');
    const { rows: fk } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.visit_notes'::regclass and conname = 'visit_notes_visit_id_fkey'`,
    );
    expect(fk[0].def).toContain('ON DELETE CASCADE');
  });

  test('v_schedule exposes visit_id and the derived stage', async () => {
    const cols = await columns('v_schedule');
    expect(cols.get('visit_id'), 'v_schedule.visit_id').toBeDefined();
    expect(cols.get('stage'), 'v_schedule.stage').toBeDefined();
    expect(cols.get('completed_at'), 'v_schedule.completed_at').toBeDefined();
    expect(cols.get('assignment_id'), 'the old name must be gone').toBeUndefined();
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

  test('visits: times NULLABLE, and the rails are GONE (Plan 4b-2, rung 9a)', async () => {
    const cols = await columns('visits');
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

  test('the overlap guard MOVED, and no copy was left behind on visits (rung 9c)', async () => {
    // The guard needs a row that knows both WHO and WHEN, and a Postgres
    // exclusion constraint cannot reach a second table — so when the person
    // moved to visit_participants, the constraint went with them. A surviving
    // copy on `visits` would be a guard over a column that no longer exists.
    const { rows: onVisits } = await client.query(
      `select 1 from pg_constraint
        where conname = 'no_confirmed_overlap' and conrelid = 'public.visits'::regclass`,
    );
    expect(onVisits).toEqual([]);
    const { rows } = await client.query<{ def: string; contype: string }>(
      `select contype, pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'no_confirmed_overlap_participant'
          and conrelid = 'public.visit_participants'::regclass`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contype, 'x = exclusion constraint').toBe('x');
    // Unplaced rows are demand, not schedule — they must sit OUTSIDE the guard
    // or tstzrange(null,null) blocks the technician's entire calendar.
    expect(rows[0].def).toContain('starts_at IS NOT NULL');
  });

  // ── Rung 9c: the crew, and where the double-booking guard now lives ────────

  test('visit_participants carries the relocated overlap guard', async () => {
    const cols = await columns('visit_participants');
    for (const c of ['id', 'tenant_id', 'visit_id', 'technician_id', 'starts_at', 'ends_at', 'status', 'created_at']) {
      expect(cols.get(c), `visit_participants.${c}`).toBeDefined();
    }
    const { rows } = await client.query<{ contype: string; def: string }>(
      `select contype, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.visit_participants'::regclass
          and conname = 'no_confirmed_overlap_participant'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contype, 'x = exclusion constraint').toBe('x');
    // Same predicate as the visits-level guard it replaces: an untimed row is
    // demand, not schedule, and tstzrange(null,null) would block a whole
    // calendar.
    expect(rows[0].def).toContain('starts_at IS NOT NULL');
    // And nothing of it was left on `visits`: the bridge column is dropped by
    // 20260907100100 (asserted above, where it used to be required).
    const { rows: fk } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.visit_participants'::regclass
          and conname = 'visit_participants_visit_id_fkey'`,
    );
    // A crew list must die with its trip, or a visit becomes undeletable.
    expect(fk[0].def).toContain('ON DELETE CASCADE');
  });

  test('the crew table must NOT look like a PostgREST junction', async () => {
    // MEASURED (local stack, 2026-09-06): with a (visit_id, technician_id)
    // PRIMARY KEY, PostgREST synthesises a many-to-many `visits ↔ technicians`
    // that collides with visits_technician_id_fkey, and EVERY select embedding
    // `technicians` from `visits` answers HTTP 300 PGRST201 — the board, the
    // customer brief, the unplaced strip. A surrogate key gives the same
    // guarantee and keeps the relationship unambiguous. Do not "tidy" this back
    // into a composite primary key.
    const { rows } = await client.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.visit_participants'::regclass and contype in ('p','u')`,
    );
    expect(rows.some((r) => r.def === 'PRIMARY KEY (id)')).toBe(true);
    expect(rows.some((r) => r.def === 'UNIQUE (visit_id, technician_id)')).toBe(true);
  });

  test('ONE after-trigger reconciles participants — the order is inside it, not between triggers', async () => {
    const { rows } = await client.query<{ tgname: string; def: string }>(
      `select tgname, pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.visits'::regclass and not tgisinternal
        order by tgname`,
    );
    // AFTER triggers fire ALPHABETICALLY. Split across two — a `_sync` and a
    // `_mirror` — the name decides which runs first, and "sync the times"
    // before "reconcile the person" refuses a legitimate reassign-and-move.
    expect(rows.filter((r) => /AFTER/.test(r.def)).map((r) => r.tgname)).toEqual([
      'visits_participants_after',
    ]);
    // Its bridge arm went with the column: it fires on the TIMES and the
    // status now, and there is no person on `visits` to reconcile.
    const after = rows.find((r) => r.tgname === 'visits_participants_after');
    expect(after?.def).not.toContain('technician_id');
    expect(rows.some((r) => /sync|mirror/i.test(r.tgname))).toBe(false);
    const fill = await client.query<{ def: string }>(
      `select pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.visit_participants'::regclass and not tgisinternal`,
    );
    // INSERT **AND UPDATE**: the times on a participant are copies, and the
    // guarantee is only structural if a hand-written UPDATE cannot set them
    // either — otherwise the exclusion constraint ends up checking a time
    // nobody is going (Phase 1 review).
    expect(fill.rows).toHaveLength(1);
    expect(fill.rows[0].def).toContain('BEFORE INSERT OR UPDATE');
  });

  test('visit_participants is closed to the Data API', async () => {
    const { rows } = await client.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.visit_participants'::regclass`,
    );
    expect(rows[0].relrowsecurity, 'RLS on, no policy → anon/authenticated get zero rows').toBe(true);
    const { rows: grants } = await client.query<{ grantee: string }>(
      `select distinct grantee from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'visit_participants'
          and grantee in ('anon','authenticated')`,
    );
    expect(grants).toEqual([]);
  });

  // RUNG 10. `visit_notes` never enabled RLS — the one-time deny-all sweep
  // (20260824120000) had already covered every table that existed then, and a
  // new table gets nothing from it. Both halves are asserted, because either
  // alone leaves the Data API a door: the grant revoke without RLS, or RLS
  // without the revoke (auto_expose_new_tables re-grants SELECT).
  test('job_captures is closed to the Data API', async () => {
    const { rows } = await client.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.job_captures'::regclass`,
    );
    expect(rows[0].relrowsecurity, 'RLS on, no policy → anon/authenticated get zero rows').toBe(true);
    const { rows: grants } = await client.query<{ grantee: string }>(
      `select distinct grantee from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'job_captures'
          and grantee in ('anon','authenticated')`,
    );
    expect(grants).toEqual([]);
  });

  // A LINK, ONCE MADE, IS NEVER RE-POINTED — the visit_notes rule, one rung
  // down. UPDATE only: blocking DELETE would make a job undeletable the moment
  // a customer emailed about it (`on delete cascade` would raise instead of
  // cascading), which is the "L1 pins L2" trap.
  test('job_captures is append-only on UPDATE, and its job cascade still works', async () => {
    const { rows } = await client.query<{ def: string }>(
      `select pg_get_triggerdef(oid) as def from pg_trigger
        where tgrelid = 'public.job_captures'::regclass and not tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain('BEFORE UPDATE');
    expect(rows[0].def).not.toContain('DELETE');
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
