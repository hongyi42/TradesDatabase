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

  test('the daily marker gate, pinned independently of the freshness gate', async () => {
    // Marker stamped to NOW's own firm-local day + plenty of fresh summaries:
    // the ONLY thing gating is ranToday (review F5 — the original fixture let
    // either gate produce the same skip).
    await pg.query(`update reflector_runs set ran_at = $1 where tenant_id = $2`, [NOW, tenantA]);
    await mintSummaries(tenantA, 6, 'fresh');
    const s = await runReflector(NOW, 'shadow', {
      listTenants: async () => [tenantA],
      run: async () => {
        throw new Error('must not run twice in one firm-local day');
      },
    });
    expect(s.skippedGate).toBe(1);
  });

  test('the freshness gate, pinned independently of the daily marker', async () => {
    // Marker moved to the PREVIOUS firm-local day and stamped as the last
    // SUCCESSFUL run AFTER the fresh summaries existed → <5 new since it.
    await pg.query(
      `update reflector_runs set ran_at = $1, ok = true where tenant_id = $2`,
      ['2026-08-23T19:00:00Z', tenantA],
    );
    await pg.query(
      `update gap_summaries set created_at = '2026-08-23T18:00:00Z' where tenant_id = $1`,
      [tenantA],
    );
    const s = await runReflector(NOW, 'shadow', {
      listTenants: async () => [tenantA],
      run: async () => {
        throw new Error('nothing new — must not re-run');
      },
    });
    expect(s.skippedGate).toBe(1);
  });

  test('a FAILED call writes an ok=false marker that bounds the day but not the watermark', async () => {
    // Yesterday's marker + fresh summaries → eligible; the model call throws.
    await pg.query(`delete from reflector_runs where tenant_id = $1`, [tenantA]);
    await pg.query(
      `update gap_summaries set created_at = now() where tenant_id = $1`,
      [tenantA],
    );
    const s = await runReflector(NOW, 'shadow', {
      listTenants: async () => [tenantA],
      run: async () => {
        throw new Error('provider 429');
      },
    });
    expect(s.tenantErrors).toBe(1);
    const rows = await pg.query(
      `select ok, proposed from reflector_runs where tenant_id = $1 order by ran_at desc limit 1`,
      [tenantA],
    );
    expect(rows.rows[0].ok).toBe(false);
    expect(rows.rows[0].proposed).toBe(0);
    // The failure marker gates the rest of ITS day. The marker was stamped at
    // the DB's real clock; pin it to NOW's firm-local day so the fixture's
    // fixed NOW and the marker share a day (they always do in production —
    // one run, one clock).
    await pg.query(
      `update reflector_runs set ran_at = $1 where tenant_id = $2 and ok = false`,
      [NOW, tenantA],
    );
    const again = await runReflector(NOW, 'shadow', {
      listTenants: async () => [tenantA],
      run: async () => {
        throw new Error('must be day-gated after a failed attempt');
      },
    });
    expect(again.skippedGate).toBe(1);
    // ...but tomorrow the unseen summaries still count as new: the watermark
    // reads only ok=true markers, and none exists.
  });

  test('thin evidence is refused WHOLE, never trimmed', async () => {
    // Own tenant: a marker written here must not day-gate or watermark-starve
    // the zero-proposal test's tenant.
    const tenantC = (await createTenant(`refl-c-${RUN}`, { managerSeats: 1 })).id;
    await pg.query(`update tenants set timezone = $1 where id = $2`, [TZ, tenantC]);
    const fresh = await mintSummaries(tenantC, MIN_SUMMARIES + 1, 'thin');
    const s = await runReflector(NOW, 'shadow', {
      listTenants: async () => [tenantC],
      run: async () => ({
        lessons: [
          { text: 'Two-evidence rule.', evidence: fresh.slice(0, 2) },
          { text: 'Mixed-type evidence.', evidence: [fresh[0], 42, fresh[1]] },
        ],
      }),
    });
    expect(s.ran).toBe(1);
    expect(s.proposed).toBe(0);
    expect(s.refused).toBe(2);
    await pg.query(`delete from nudges where tenant_id = $1`, [tenantC]);
    await pg.query(`delete from reflector_runs where tenant_id = $1`, [tenantC]);
    await pg.query(`delete from tenants where id = $1`, [tenantC]);
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
