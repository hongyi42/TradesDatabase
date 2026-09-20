import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from './tenants.js';
import { insertTechnician } from './technicians.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createVisit } from './visits.js';
import { upsertTenantProfile } from './tenantProfiles.js';
import { nl } from './time.js';

// The security properties of the query_spine read surface, asserted against the
// real database rather than reasoned about. Isolation here rests on a view
// filter keyed off a transaction-local GUC — there is no RLS behind it and the
// app runs as service_role — so every claim in the migration header gets a test.
// A green suite is the only evidence these hold after a schema change.
const pg = new Client({ connectionString: process.env.DATABASE_URL });

let tenantA: string;
let tenantB: string;
// One assignment per status, tenant A — the v_schedule/v_cancelled_visits
// membership fixtures. Ids captured so tests assert exact membership, not
// counts that another fixture could drift.
const ids: Record<'confirmed' | 'completed' | 'cancelled' | 'proposed', string> = {
  confirmed: '',
  completed: '',
  cancelled: '',
  proposed: '',
};

// Call the function the way the tool will: tenant passed as a PARAMETER from the
// verified identity, never interpolated into the SQL the model wrote.
const run = (tenant: string, sql: string, maxRows?: number) =>
  pg.query('select query_spine($1::uuid, $2::text, $3::int) as result', [
    tenant,
    sql,
    maxRows ?? null,
  ]);

beforeAll(async () => {
  await pg.connect();
  tenantA = (await createTenant('qs-tenant-a', { managerSeats: 2 })).id;
  tenantB = (await createTenant('qs-tenant-b', { managerSeats: 2 })).id;

  const jobIds: Record<string, string> = {};
  const techIds: Record<string, string> = {};
  for (const [tenantId, tag] of [
    [tenantA, 'a'],
    [tenantB, 'b'],
  ] as const) {
    const tech = await insertTechnician({
      tenantId,
      ref: `qs-tech-${tag}`,
      displayName: `QS Tech ${tag.toUpperCase()}`,
      seatExempt: true,
    });
    const customer = await createCustomer({ tenantId, name: `QS Customer ${tag.toUpperCase()}` });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: `QS Job ${tag.toUpperCase()}`,
    });
    jobIds[tag] = job.id;
    techIds[tag] = tech.id;
    // Firm-profile fixture per tenant, so the v_firm_profile isolation case
    // has real cross-tenant data to leak, not a vacuous empty set.
    await upsertTenantProfile(tenantId, { displayName: `QS Firm ${tag.toUpperCase()}` });
  }

  // One assignment per status for tenant A, non-overlapping slots on a fixed
  // far-future day. The membership fixtures for "v_schedule means the
  // schedule": the 2026-08-12 date eval caught v_schedule counting cancelled
  // rows as booked work (August +90), so which statuses each view returns is
  // pinned here, not left to the view's WHERE staying unread.
  const slot = async (
    status: 'proposed' | 'confirmed' | 'completed' | 'cancelled',
    hour: number,
    tag: 'a' | 'b' = 'a',
  ) => {
    const row = await createVisit({
      tenantId: tag === 'a' ? tenantA : tenantB,
      jobId: jobIds[tag],
      technicianId: techIds[tag],
      startsAt: nl(`2027-03-02T${String(hour).padStart(2, '0')}:00:00Z`),
      endsAt: nl(`2027-03-02T${String(hour).padStart(2, '0')}:45:00Z`),
      status,
    });
    return row.id;
  };
  ids.confirmed = await slot('confirmed', 9);
  ids.completed = await slot('completed', 11);
  ids.cancelled = await slot('cancelled', 13);
  ids.proposed = await slot('proposed', 15);
  // Tenant B gets a cancelled row too, so the isolation test.each has real
  // cross-tenant data to leak on v_cancelled_visits, not a vacuous empty set.
  await slot('cancelled', 9, 'b');
  await pg.query(`update visits set reason = 'QS customer away' where id = $1`, [
    ids.cancelled,
  ]);
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    await pg.query('delete from query_audit where tenant_id = $1', [t]);
    // Before the tenants delete — tenant_profiles' FK is NO ACTION.
    await pg.query('delete from tenant_profiles where tenant_id = $1', [t]);
    await pg.query('delete from visits where tenant_id = $1', [t]);
    await pg.query(
      'delete from jobs where customer_id in (select id from customers where tenant_id = $1)',
      [t],
    );
    await pg.query('delete from customers where tenant_id = $1', [t]);
    await pg.query('delete from technicians where tenant_id = $1', [t]);
    await pg.query('delete from tenants where id = $1', [t]);
  }
  await pg.end();
});

describe('query_spine — tenant isolation', () => {
  // The whole design: the model never writes the tenant filter, so this is the
  // property that has to hold for every view, not just the one under test today.
  test.each([
    'v_team',
    'v_customers',
    'v_jobs',
    'v_schedule',
    'v_time_off',
    'v_cancelled_visits',
    'v_firm_profile',
  ])(
    '%s only ever returns the calling tenant',
    async (view) => {
      const a = await run(tenantA, `select * from ${view}`);
      const b = await run(tenantB, `select * from ${view}`);
      const textA = JSON.stringify(a.rows[0].result);
      const textB = JSON.stringify(b.rows[0].result);
      // Explicit markers both ways. A bare not.toContain('B') would pass today and
      // break the day a customer lives in Bellevue — the assertion has to name
      // the other tenant's data, not a letter.
      for (const marker of ['QS Tech B', 'QS Customer B', 'QS Job B', 'QS Firm B']) {
        expect(textA).not.toContain(marker);
      }
      for (const marker of ['QS Tech A', 'QS Customer A', 'QS Job A', 'QS Firm A']) {
        expect(textB).not.toContain(marker);
      }
    },
  );

  test('the planner finds a customer by NUMBER through v_customers.phone_key, whatever the spelling', async () => {
    // The code lookups moved onto phone_key (20260916130100); spine_read reads
    // v_customers, so without the column a planner query on a caller's +1
    // number missed the same customer the matcher now finds.
    const spelled = await createCustomer({ tenantId: tenantA, name: 'QS Spelled A', phone: '(206) 555-0170' });
    const r = await run(tenantA, "select id, phone from v_customers where phone_key = '2065550170'");
    const rows = r.rows[0].result as Array<{ id: string; phone: string }>;
    expect(rows.map((c) => c.id)).toContain(spelled.id);
    expect(rows.find((c) => c.id === spelled.id)?.phone).toBe('(206) 555-0170');
  });

  test('a query that tries to widen the filter still only gets its own tenant', async () => {
    // `or true` is the shape an adversarial or confused query takes. The view's
    // WHERE is applied before this predicate can matter.
    const r = await run(tenantA, "select * from v_customers where name is not null or true = true");
    expect(JSON.stringify(r.rows[0].result)).not.toContain('QS Customer B');
  });

  test('the GUC is transaction-local — it does not leak to the next call', async () => {
    await run(tenantA, 'select * from v_team');
    // A fresh call with tenant B must see B, not A. If set_config had been
    // session-scoped, this would silently return A's roster.
    const b = await run(tenantB, 'select * from v_team');
    expect(JSON.stringify(b.rows[0].result)).toContain('QS Tech B');
    expect(JSON.stringify(b.rows[0].result)).not.toContain('QS Tech A');
  });
});

describe('query_spine — v_schedule means the schedule (2026-08-12 eval finding)', () => {
  // The regression under pin: count(*) from v_schedule was every visit
  // ever made — cancelled included — so "how many visits this month?" came
  // back +90. These tests assert exact id membership per status, so a future
  // view rewrite that drops the filter fails here, not in a manager chat.
  // query_spine returns a bare jsonb array of rows (the {status, rows} wrapper
  // seen in agent trajectories is added by the MCP layer above it).
  const rowsOf = (r: { rows: { result: unknown }[] }) =>
    r.rows[0].result as { visit_id: string; status?: string; reason?: string }[];

  test('v_schedule returns confirmed and completed visits — and nothing else', async () => {
    const r = await run(tenantA, "select visit_id, status from v_schedule where local_day = '2027-03-02'");
    const got = rowsOf(r);
    expect(new Set(got.map((x) => x.visit_id))).toEqual(
      new Set([ids.confirmed, ids.completed]),
    );
    expect(new Set(got.map((x) => x.status))).toEqual(new Set(['confirmed', 'completed']));
  });

  test('count(*) over v_schedule counts real bookings only — the eval regression shape', async () => {
    const r = await run(
      tenantA,
      "select count(*) as visit_count from v_schedule where local_day = '2027-03-02'",
    );
    expect((rowsOf(r)[0] as unknown as { visit_count: number }).visit_count).toBe(2);
  });

  test('cancelled visits live in v_cancelled_visits, with the reason', async () => {
    const r = await run(
      tenantA,
      "select visit_id, reason from v_cancelled_visits where local_day = '2027-03-02'",
    );
    const got = rowsOf(r);
    expect(got.map((x) => x.visit_id)).toEqual([ids.cancelled]);
    expect(got[0].reason).toBe('QS customer away');
  });

  test('a proposed assignment is staged workflow state — visible in NEITHER view', async () => {
    for (const view of ['v_schedule', 'v_cancelled_visits']) {
      const r = await run(tenantA, `select visit_id from ${view}`);
      expect(rowsOf(r).map((x) => x.visit_id)).not.toContain(ids.proposed);
    }
  });
});

describe('query_spine — what it must refuse', () => {
  test('cannot reach a base table, only the views', async () => {
    await expect(run(tenantA, 'select * from customers')).rejects.toThrow(/permission denied/i);
  });

  test('cannot reach the raw_captures BASE table — v_captures is the sanctioned path', async () => {
    // Decision B (query-spine design, 2026-08-04) excluded L1 outright; its
    // revisit clause was exercised on 2026-08-23 (④ — the planner closes gaps
    // on evidence and must be able to read it). What survives of decision B is
    // the mechanism: the BASE table stays ungranted, and only the columns
    // v_captures names are readable (live notes only since plan 3 of the
    // retrieval layer, 2026-09-15 — the labeled trail is gone).
    await expect(run(tenantA, 'select * from raw_captures')).rejects.toThrow(/permission denied/i);
  });

  // Writes are blocked TWICE over, and the distinction matters for what a test
  // is allowed to claim. A bare `insert …` is refused by SYNTAX (it sits inside
  // the subquery wrapper, where a write statement cannot appear) — that proves
  // nothing about privileges. A data-modifying CTE is the real attempt, and the
  // privilege check is the durable guarantee, so both are asserted separately.
  test('data-modifying CTEs — the actual write bypass — are refused', async () => {
    for (const sql of [
      "with i as (insert into customers (tenant_id,name) values (gen_random_uuid(),'pwn') returning 1) select * from i",
      "with u as (update customers set name='pwn' returning 1) select * from u",
      'with d as (delete from customers returning 1) select * from d',
      "with i as (insert into v_customers (name) values ('pwn') returning 1) select * from i",
    ]) {
      await expect(run(tenantA, sql)).rejects.toThrow(/data-modifying statement must be at the top level/i);
    }
    const { rows } = await pg.query("select count(*)::int as n from customers where name = 'pwn'");
    expect(rows[0].n).toBe(0);
  });

  test('spine_reader holds no write privilege on any base table', async () => {
    // The guarantee that survives a change to the wrapper: even if a write
    // statement could reach the planner, the role cannot perform one.
    const { rows } = await pg.query(`
      select tablename,
             has_table_privilege('spine_reader', schemaname||'.'||tablename, 'INSERT') as ins,
             has_table_privilege('spine_reader', schemaname||'.'||tablename, 'UPDATE') as upd,
             has_table_privilege('spine_reader', schemaname||'.'||tablename, 'DELETE') as del
        from pg_tables where schemaname = 'public'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.ins || r.upd || r.del)).toEqual([]);
  });

  test('cannot call the cross-tenant cost functions', async () => {
    await expect(
      run(tenantA, `select * from tenant_cost_detail('${tenantB}'::uuid, '2026-07-01'::date)`),
    ).rejects.toThrow(/permission denied/i);
  });

  test('cannot escalate role from inside the query', async () => {
    await expect(run(tenantA, "select set_config('role', 'postgres', false)")).rejects.toThrow();
  });

  test('rejects multiple statements', async () => {
    await expect(run(tenantA, 'select 1; select 2')).rejects.toThrow(/one statement only/i);
  });

  test('rejects an empty query', async () => {
    await expect(run(tenantA, '   ')).rejects.toThrow(/empty query/i);
  });
});

describe('query_spine — bounds', () => {
  test('caps rows, and the cap cannot be raised past the ceiling', async () => {
    const two = await run(tenantA, 'select * from generate_series(1, 100) as n', 2);
    expect(two.rows[0].result).toHaveLength(2);
    // Asking for more than the hard ceiling clamps rather than obeying.
    const huge = await run(tenantA, 'select * from generate_series(1, 5000) as n', 99_999);
    expect(huge.rows[0].result.length).toBeLessThanOrEqual(1000);
  });

  test('v_schedule exposes local_weekday, and it matches local_day', async () => {
    // Added after a live turn on 2026-08-06 where the agent got the count right
    // (22 visits, verified) and then said "Monday the 4th" — 2026-08-04 is a
    // TUESDAY. local_day comes back as a bare date and the view carried no
    // weekday, so §0f's "always state the weekday" left it computing one. Same
    // remedy as local_day: the database answers, nothing is derived.
    const r = await run(
      tenantA,
      "select to_char(date '2026-08-04','FMDay') as computed",
    );
    // Postgres is the authority both ways; FMDay must not pad.
    expect(r.rows[0].result[0].computed).toBe('Tuesday');

    const cols = await pg.query(`
      select column_name from information_schema.columns
       where table_name = 'v_schedule' and column_name in ('local_day','local_weekday')
       order by column_name`);
    expect(cols.rows.map((c) => c.column_name)).toEqual(['local_day', 'local_weekday']);
  });

  test('an empty result is [] rather than null', async () => {
    // The tool relays this to the agent; null would read as an error.
    const r = await run(tenantA, "select * from v_customers where name = 'nobody'");
    expect(r.rows[0].result).toEqual([]);
  });

  test('v_schedule exposes local_day, so day bucketing cannot be got wrong', async () => {
    // The bug this prevents: assignments.starts_at is timestamptz, and bucketing
    // by the raw UTC date puts every evening stop on the wrong day.
    const r = await run(tenantA, 'select local_day from v_schedule limit 1');
    expect(r.rows[0].result).toBeDefined();
  });
});

describe('query_spine — the view surface is closed', () => {
  test('spine_reader holds SELECT on exactly the seventeen views and nothing else', async () => {
    // A new table must not become readable by default. This is the test that
    // fails when someone adds a grant without thinking.
    // v_money_events added 2026-08-15 (money-ledger plan, manager-only money
    // reads — query_spine is an admin tool, so the tier gate holds upstream).
    // v_firm_profile added 2026-08-15 (firm-profile plan, same tier logic).
    // v_captures/v_visits/v_nudges/v_review_items added 2026-08-23 (④ — the
    // planner's read surface; nudge_decisions is the deliberate exception).
    // v_observations added 2026-08-31 ("a gap is not an ask" — dismissed rows
    // must be findable or `recover` has nothing to act on; manager visibility
    // through the shared catalog is the plan's recorded acceptance).
    // v_roster_events added 2026-09-02 (build 6.5 Phase 1 — the roster trail;
    // the ONLY honest source for when somebody left, since technicians
    // .updated_at is bumped by any edit. Same recorded acceptance: a firm's own
    // roster history is data its managers already own).
    // v_office_messages added 2026-09-02 (build 7, user ruling): the planner
    // could look back at its decisions, its notes, its observations and its
    // questions — its own INBOX was the one thing it could not. And because
    // spine_read is a CITABLE tool, this is also what lets a seat agent's words
    // close a gap, superseding the 5.5 rule that office answers never fill the
    // record. Manager visibility through the shared catalog is the same
    // recorded acceptance as v_observations and v_roster_events.
    // v_job_captures (2026-09-07), v_visit_notes (2026-09-06) and
    // v_customer_captures (2026-09-12) were three answers to "which job or
    // customer is this note on". Plan 3 of the retrieval layer (2026-09-15)
    // DROPPED all three for v_capture_links: capture_membership — the one
    // definition every seat tool reads — exposed to SQL, live notes only.
    // v_visit_participants added 2026-09-06 (rung 9c): v_schedule stays ONE ROW
    // PER TRIP with the crew as arrays, so `count(*)` keeps counting trips —
    // this view is where a question about PEOPLE ("how many visits did Ben go
    // on") gets one row per person to count instead.
    // v_access_grants added 2026-09-19 (access plan A): the planner does not
    // grant access but reads the history (operator ruling); its `reason` column
    // is only ever a manager's words or a technician's quoted by code, never
    // the planner's own, because spine_read is citable.
    const { rows } = await pg.query(
      `select table_name from information_schema.table_privileges
        where grantee = 'spine_reader' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'v_access_grants',
      'v_cancelled_visits',
      'v_capture_links',
      'v_captures',
      'v_customers',
      'v_firm_profile',
      'v_jobs',
      'v_money_events',
      'v_nudges',
      'v_observations',
      'v_office_messages',
      'v_review_items',
      'v_roster_events',
      'v_schedule',
      'v_team',
      'v_time_off',
      'v_visit_participants',
    ]);
  });

  // BUILD 7 FINAL REVIEW, and the highest-severity finding of the build.
  //
  // The PLANNER'S OWN WORDS are its `to_agent` send text AND the desk answers
  // written in its name — which are `to_planner`, kind 'desk' (desk.ts), so the
  // direction filter alone never caught them (fixed 2026-09-15 by
  // 20260916130000_desk_answers_not_citable). `spine_read` is in CITABLE_TOOLS, so a view
  // without these filters lets the planner read its own prose back and quote it
  // into an evidence-basis close: exactly the laundering build 6 Phase 4 found
  // by live probe and shut. The same build excludes desk pairs from `readText`
  // and keeps `read_memory` out of CITABLE_TOOLS for that one reason, so a view
  // that reopened the door would have made both guards decorative.
  test('v_office_messages is the INBOX only — the planner never reads its own words back', async () => {
    const def = await pg.query(
      `select pg_get_viewdef('v_office_messages'::regclass, true) as def`,
    );
    expect(def.rows[0].def).toContain("direction = 'to_planner'");
    expect(def.rows[0].def).toContain("'desk'");

    // Asserted against real rows too, not just the definition: a filter can be
    // present and wrong.
    const t = await pg.query(`select id from tenants where name = 'Default Tenant'`);
    const tenantId = t.rows[0].id;
    const tech = await pg.query(
      `insert into technicians (tenant_id, ref, display_name, state, seat_exempt)
       values ($1, 'qs-office-rail', 'Rail Probe', 'active', true) returning id`,
      [tenantId],
    );
    await pg.query(
      `insert into office_messages (tenant_id, direction, kind, from_ref, to_ref, technician_id, body)
       values ($1,'to_planner','inform','qs-office-rail','spine:team-lead',$2,'INBOUND probe body'),
              ($1,'to_agent','inform','spine:team-lead','qs-office-rail',$2,'OUTBOUND planner prose'),
              -- The desk's answer: to_planner like the inbox, but the planner's own words.
              ($1,'to_planner','desk','spine:team-lead','qs-office-rail',$2,'DESK answer prose')`,
      [tenantId, tech.rows[0].id],
    );
    try {
      // `false`, not `true`: a local set_config dies with the (implicit)
      // transaction, so the next statement reads '' and the view's uuid cast
      // throws. Session scope keeps it for the read below.
      await pg.query(`select set_config('spine.tenant_id', $1, false)`, [tenantId]);
      const seen = await pg.query(
        `select body, direction from v_office_messages where from_ref = 'qs-office-rail'
            or to_ref = 'qs-office-rail'`,
      );
      expect(seen.rows.map((r) => r.body)).toEqual(['INBOUND probe body']);
      expect(seen.rows.every((r) => r.direction === 'to_planner')).toBe(true);
    } finally {
      await pg.query(`select set_config('spine.tenant_id', '', false)`);
      await pg.query(`delete from office_messages where technician_id = $1`, [tech.rows[0].id]);
      await pg.query(`delete from technicians where id = $1`, [tech.rows[0].id]);
    }
  });

  // THE 5-SECOND LIMIT THAT NEVER WAS (plan 3 of the retrieval layer). The
  // original body ran `set_config('statement_timeout', '5000', true)` INSIDE the
  // function; measured 2026-09-15 through /rpc/query_spine, pg_sleep(6) returned
  // at 6.03 s — a statement's timer is armed when the statement starts, so a GUC
  // changed mid-statement cannot reach it. The bound that holds is the
  // authenticator role's statement_timeout=8s (local and hosted). Pinned so the
  // dead line is not re-added as though it did something.
  test('query_spine does not pretend to set its own statement timeout', async () => {
    const { rows } = await pg.query<{ def: string }>(
      "select pg_get_functiondef('query_spine'::regproc) as def",
    );
    expect(rows[0].def).not.toContain("set_config('statement_timeout'");
  });

  test('only service_role may execute query_spine — NOT anon or authenticated', async () => {
    // Regression guard for a hole that reached the pilot on 2026-08-06.
    // Supabase DEFAULT PRIVILEGES grant EXECUTE on a new public function
    // directly to anon and authenticated, so `revoke ... from public` does not
    // remove them — it only drops the implicit PUBLIC grant, which was never the
    // mechanism. It matters more here than for most functions because
    // query_spine takes the TENANT AS A PARAMETER: anyone with the project's
    // publishable anon key could have called it for ANY tenant and read that
    // firm's customers, phones, addresses and schedule through the REST API.
    const { rows } = await pg.query(`
      select has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'query_spine'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].anon).toBe(false);
    expect(rows[0].authenticated).toBe(false);
    expect(rows[0].service_role).toBe(true);
  });

  test('v_team does not expose credentials or Composio ids', async () => {
    // technicians carries badge_hash, composio_* ids, connected_email and
    // telegram_user_id. list_team keeps them server-side; so must this.
    const r = await run(tenantA, 'select * from v_team');
    const text = JSON.stringify(r.rows[0].result);
    for (const forbidden of [
      'badge_hash',
      'composio_connected_account_id',
      'composio_trigger_id',
      'composio_session_id',
      'connected_email',
      'telegram_user_id',
      'sandbox_ref',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('query_spine — local_day is the stored wall clock (plan 2026-09-15 retrieval layer 4)', () => {
  // starts_at is NAIVE-LOCAL: the digits are the firm's wall clock and the +00
  // lies. The views used to convert it as if it were a real UTC instant, which
  // put a 06:00 visit for a Pacific firm on the PREVIOUS day (seven hours back)
  // and a late-evening visit for a UTC+ firm on the NEXT one. Both directions
  // are pinned: the Pacific case fails on the old view, the Tokyo case on the
  // mirror-image mistake.
  let pacific: string;
  let tokyo: string;
  const made: string[] = [];

  beforeAll(async () => {
    for (const [tag, tz] of [
      ['la', 'America/Los_Angeles'],
      ['tokyo', 'Asia/Tokyo'],
    ] as const) {
      // createTenant takes no timezone; the column defaults to Los Angeles.
      const tenantId = (await createTenant(`qs-day-${tag}`, { managerSeats: 1 })).id;
      await pg.query('update tenants set timezone = $1 where id = $2', [tz, tenantId]);
      made.push(tenantId);
      const customer = await createCustomer({ tenantId, name: `QS Day ${tag}` });
      const job = await createJob({ tenantId, customerId: customer.id, title: `QS Day ${tag}` });
      const at = tag === 'la' ? '06:00' : '22:00';
      const until = tag === 'la' ? '07:00' : '23:00';
      await createVisit({
        tenantId,
        jobId: job.id,
        startsAt: nl(`2027-03-09T${at}:00Z`),
        endsAt: nl(`2027-03-09T${until}:00Z`),
        status: 'confirmed',
      });
      // A cancelled one at the same edge of the day, for v_cancelled_visits.
      await createVisit({
        tenantId,
        jobId: job.id,
        startsAt: nl(tag === 'la' ? '2027-03-09T05:00:00Z' : '2027-03-09T23:00:00Z'),
        endsAt: nl(tag === 'la' ? '2027-03-09T05:30:00Z' : '2027-03-09T23:30:00Z'),
        status: 'cancelled',
      });
      if (tag === 'la') pacific = tenantId;
      else tokyo = tenantId;
    }
  });

  afterAll(async () => {
    for (const t of made) {
      await pg.query('delete from query_audit where tenant_id = $1', [t]);
      await pg.query('delete from visits where tenant_id = $1', [t]);
      await pg.query('delete from jobs where tenant_id = $1', [t]);
      await pg.query('delete from customers where tenant_id = $1', [t]);
      await pg.query('delete from tenants where id = $1', [t]);
    }
  });

  test.each([
    ['a 06:00 visit for a Pacific firm', () => pacific],
    ['a 22:00 visit for a Tokyo firm', () => tokyo],
  ])('%s sits on its own day in v_schedule and v_cancelled_visits', async (_label, tenantOf) => {
    for (const view of ['v_schedule', 'v_cancelled_visits']) {
      const r = await run(tenantOf(), `select local_day, local_weekday from ${view}`);
      const rows = r.rows[0].result as { local_day: string; local_weekday: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].local_day).toBe('2027-03-09');
      expect(rows[0].local_weekday).toBe('Tuesday');
    }
  });
});
