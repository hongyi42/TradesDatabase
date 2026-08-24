import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from '../db/tenants.js';
import { runReflector, MIN_SUMMARIES } from './reflector.js';

// ⑤ Phase 4 against the real local stack: the gate (hour, daily marker,
// thresholds), the forced-tool seam (injected — no model), the Curator
// hand-off (evidence verified, bad proposals refused without aborting the
// run), and the marker discipline (EVERY run writes one, proposals or not).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const TZ = 'America/Los_Angeles';
const RUN = Date.now().toString(36);
// 10:00 firm-local on a fixed day — inside the from-2am window.
const NOW = '2026-08-24T17:00:00Z';

let tenantA: string; // eligible, rich corpus
let tenantB: string; // eligible, zero-proposal run
const aEvidence: string[] = [];

async function mintSummaries(tenantId: string, n: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const nu = await pg.query(
      `insert into nudges (tenant_id, kind, subject_ref, status, context, resolved_at)
       values ($1, 'overdue_visit_gap', $2, 'answered', '{}'::jsonb, now()) returning id`,
      [tenantId, `refl-${tag}-${i}-${RUN}`],
    );
    const s = await pg.query(
      `insert into gap_summaries (tenant_id, nudge_id, kind, subject, closed_at, status)
       values ($1, $2, 'overdue_visit_gap', 'fixture', now(), 'answered') returning id`,
      [tenantId, nu.rows[0].id],
    );
    ids.push(s.rows[0].id);
  }
  return ids;
}

const markers = async (tenantId: string) =>
  (await pg.query(`select proposed from reflector_runs where tenant_id = $1 order by ran_at`, [tenantId]))
    .rows;

beforeAll(async () => {
  await pg.connect();
  tenantA = (await createTenant(`refl-a-${RUN}`, { managerSeats: 1 })).id;
  tenantB = (await createTenant(`refl-b-${RUN}`, { managerSeats: 1 })).id;
  for (const id of [tenantA, tenantB]) {
    await pg.query(`update tenants set timezone = $1 where id = $2`, [TZ, id]);
  }
  aEvidence.push(...(await mintSummaries(tenantA, MIN_SUMMARIES + 1, 'a')));
  await mintSummaries(tenantB, MIN_SUMMARIES + 1, 'b');
});

afterAll(async () => {
  for (const id of [tenantA, tenantB]) {
    await pg.query(`delete from nudges where tenant_id = $1`, [id]);
    await pg.query(`delete from planner_lessons where tenant_id = $1`, [id]);
    await pg.query(`delete from reflector_runs where tenant_id = $1`, [id]);
    await pg.query(`delete from tenants where id = $1`, [id]);
  }
  await pg.end();
});

describe('runReflector', () => {
  test("mode 'off' does nothing at all", async () => {
    const s = await runReflector(NOW, 'off', {
      listTenants: async () => {
        throw new Error('off must not even list tenants');
      },
    });
    expect(s).toMatchObject({ tenants: 0, ran: 0, proposed: 0 });
  });

  test('the hour gate: before 2am firm-local nothing runs, and no marker is written', async () => {
    const s = await runReflector('2026-08-24T08:30:00Z', 'shadow', {
      // 01:30 firm-local
      listTenants: async () => [tenantA],
      run: async () => {
        throw new Error('gated run must not call the model');
      },
    });
    expect(s.skippedGate).toBe(1);
    expect(await markers(tenantA)).toEqual([]);
  });

  test('an eligible run: good proposal stored, bad ones refused, marker written with the count', async () => {
    const s = await runReflector(NOW, 'shadow', {
      listTenants: async () => [tenantA],
      run: async () => ({
        lessons: [
          { text: 'Prefer extend to Monday over Friday-evening escalation.', evidence: aEvidence.slice(0, 3) },
          { text: 'On 2026-08-23 things went badly.', evidence: aEvidence.slice(0, 3) }, // date rail
          { text: 'A rule with laundered evidence.', evidence: ['00000000-0000-4000-8000-00000000dead'] },
        ],
      }),
    });
    expect(s.ran).toBe(1);
    expect(s.proposed).toBe(1);
    expect(s.refused).toBe(2);
    const rows = await pg.query(
      `select text, status, evidence from planner_lessons where tenant_id = $1`,
      [tenantA],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('proposed');
    expect(rows.rows[0].text).toContain('Prefer extend');
    expect(await markers(tenantA)).toEqual([{ proposed: 1 }]);
  });

  test('the daily marker: a second run the same firm-local day is gated', async () => {
    const s = await runReflector(NOW, 'shadow', {
      listTenants: async () => [tenantA],
      run: async () => {
        throw new Error('must not run twice in one day');
      },
    });
    expect(s.skippedGate).toBe(1);
    expect(await markers(tenantA)).toHaveLength(1);
  });

  test("a zero-proposal run STILL writes its marker (mode 'live' = shadow-equivalent)", async () => {
    const s = await runReflector(NOW, 'live', {
      listTenants: async () => [tenantB],
      run: async () => ({ lessons: [] }),
    });
    expect(s.ran).toBe(1);
    expect(s.proposed).toBe(0);
    expect(await markers(tenantB)).toEqual([{ proposed: 0 }]);
    expect(
      (await pg.query(`select count(*)::int as n from planner_lessons where tenant_id = $1`, [tenantB]))
        .rows[0].n,
    ).toBe(0);
  });

  test('the corpus-size gate: a thin tenant never reaches the model', async () => {
    const thin = (await createTenant(`refl-thin-${RUN}`, { managerSeats: 1 })).id;
    await pg.query(`update tenants set timezone = $1 where id = $2`, [TZ, thin]);
    const s = await runReflector(NOW, 'shadow', {
      listTenants: async () => [thin],
      run: async () => {
        throw new Error('thin corpus must not call the model');
      },
    });
    expect(s.skippedGate).toBe(1);
    await pg.query(`delete from tenants where id = $1`, [thin]);
  });
});
