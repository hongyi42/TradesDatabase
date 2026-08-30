import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { latestSuccessfulPlannerRunAt, upsertPlannerRun } from './plannerRuns.js';

// Writes through the app path, read-back through direct pg — the db-test
// convention. Here it also matters for a second reason: the whole point of this
// table is that the CALLER supplies the instant, so the read-back has to see the
// literal timestamps passed in, not whatever the database's clock said.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

const RAN = '2026-08-29T09:00:00.000Z';
const LATER = '2026-08-29T14:30:00.000Z';

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

beforeEach(async () => {
  await pg.query('truncate table planner_runs');
});

afterAll(async () => {
  await pg.query('truncate table planner_runs');
  await pg.end();
});

async function row(): Promise<{ ran: string | null; success: string | null; rows: number }> {
  const { rows } = await pg.query(
    `select last_ran_at, last_success_at from planner_runs where tenant_id = $1`,
    [tenantId],
  );
  return {
    rows: rows.length,
    ran: rows[0]?.last_ran_at ? new Date(rows[0].last_ran_at).toISOString() : null,
    success: rows[0]?.last_success_at ? new Date(rows[0].last_success_at).toISOString() : null,
  };
}

describe('the planner run marker', () => {
  test('a successful run stamps both columns with the instant it was given', async () => {
    await upsertPlannerRun(tenantId, RAN, true);
    expect(await row()).toEqual({ rows: 1, ran: RAN, success: RAN });
    expect(await latestSuccessfulPlannerRunAt(tenantId)).toBe(RAN);
  });

  test('repeated runs keep ONE row per firm', async () => {
    await upsertPlannerRun(tenantId, RAN, true);
    await upsertPlannerRun(tenantId, LATER, true);
    const state = await row();
    expect(state.rows).toBe(1);
    expect(state.ran).toBe(LATER);
  });

  test('a FAILED run moves last_ran_at and leaves last_success_at where it was', async () => {
    await upsertPlannerRun(tenantId, RAN, true);
    await upsertPlannerRun(tenantId, LATER, false);
    // This asymmetry is the whole reason the two columns exist: a failing tick
    // that advanced the success watermark would tell the next tick it had just
    // been served, and the firm would starve (the reflector_runs lesson).
    expect(await row()).toEqual({ rows: 1, ran: LATER, success: RAN });
    expect(await latestSuccessfulPlannerRunAt(tenantId)).toBe(RAN);
  });

  test('a firm whose every run failed has no successful run to report', async () => {
    await upsertPlannerRun(tenantId, RAN, false);
    expect((await row()).success).toBeNull();
    expect(await latestSuccessfulPlannerRunAt(tenantId)).toBeNull();
  });

  test('a firm that has never run reports null rather than throwing', async () => {
    expect(await latestSuccessfulPlannerRunAt(tenantId)).toBeNull();
  });

  test('an unknown tenant is refused by the foreign key', async () => {
    await expect(
      upsertPlannerRun('00000000-0000-0000-0000-000000000000', RAN, true),
    ).rejects.toThrow(/upsertPlannerRun failed/);
  });

  test('deleting the firm takes its marker with it', async () => {
    const { rows } = await pg.query(
      `insert into tenants (name) values ('planner-run-cascade-probe') returning id`,
    );
    const doomed = rows[0].id as string;
    await upsertPlannerRun(doomed, RAN, true);
    await pg.query('delete from tenants where id = $1', [doomed]);
    const left = await pg.query('select count(*) as n from planner_runs where tenant_id = $1', [
      doomed,
    ]);
    expect(left.rows[0].n).toBe('0');
  });
});
