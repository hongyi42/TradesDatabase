import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from './tenants.js';
import { insertTechnician } from './technicians.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';

// The security properties of the query_spine read surface, asserted against the
// real database rather than reasoned about. Isolation here rests on a view
// filter keyed off a transaction-local GUC — there is no RLS behind it and the
// app runs as service_role — so every claim in the migration header gets a test.
// A green suite is the only evidence these hold after a schema change.
const pg = new Client({ connectionString: process.env.DATABASE_URL });

let tenantA: string;
let tenantB: string;

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

  for (const [tenantId, tag] of [
    [tenantA, 'a'],
    [tenantB, 'b'],
  ] as const) {
    await insertTechnician({
      tenantId,
      ref: `qs-tech-${tag}`,
      displayName: `QS Tech ${tag.toUpperCase()}`,
      seatExempt: true,
    });
    const customer = await createCustomer({ tenantId, name: `QS Customer ${tag.toUpperCase()}` });
    await createJob({ tenantId, customerId: customer.id, title: `QS Job ${tag.toUpperCase()}` });
  }
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    await pg.query('delete from query_audit where tenant_id = $1', [t]);
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
  test.each(['v_team', 'v_customers', 'v_jobs', 'v_schedule', 'v_time_off'])(
    '%s only ever returns the calling tenant',
    async (view) => {
      const a = await run(tenantA, `select * from ${view}`);
      const b = await run(tenantB, `select * from ${view}`);
      const textA = JSON.stringify(a.rows[0].result);
      const textB = JSON.stringify(b.rows[0].result);
      // Explicit markers both ways. A bare not.toContain('B') would pass today and
      // break the day a customer lives in Bellevue — the assertion has to name
      // the other tenant's data, not a letter.
      for (const marker of ['QS Tech B', 'QS Customer B', 'QS Job B']) {
        expect(textA).not.toContain(marker);
      }
      for (const marker of ['QS Tech A', 'QS Customer A', 'QS Job A']) {
        expect(textB).not.toContain(marker);
      }
    },
  );

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

describe('query_spine — what it must refuse', () => {
  test('cannot reach a base table, only the views', async () => {
    await expect(run(tenantA, 'select * from customers')).rejects.toThrow(/permission denied/i);
  });

  test('cannot read L1 (raw_captures) — decision B', async () => {
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
  test('spine_reader holds SELECT on exactly the five views and nothing else', async () => {
    // A new table must not become readable by default. This is the test that
    // fails when someone adds a grant without thinking.
    const { rows } = await pg.query(
      `select table_name from information_schema.table_privileges
        where grantee = 'spine_reader' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'v_customers',
      'v_jobs',
      'v_schedule',
      'v_team',
      'v_time_off',
    ]);
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
