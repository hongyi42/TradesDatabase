import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from '../db/tenants.js';
import { ALL_SCENARIOS, FAMILY_COUNTS, type ScenarioExpect } from './plannerCorpus.js';
import { parseOffsetMs, seedScenario, simStartIso, SIM_TZ } from './plannerSim.js';

// The corpus's structural rails (plan Phase 3). These are AUTHORING tests:
// they catch the scenario shapes that would grade the harness instead of the
// planner — a tick outside the ask window records nothing, a gap already past
// its deadline is escalated by the sweep before the planner sees it, and a
// mixed-case mustNotClaim can never match the lowercase haystack.

const HOUR = 3_600_000;
const T0_HOUR = 10; // simStartIso(10) — the driver's anchor

describe('corpus structure', () => {
  test('ids are unique and family counts are pinned', () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const byFamily = new Map<string, number>();
    for (const s of ALL_SCENARIOS) byFamily.set(s.family, (byFamily.get(s.family) ?? 0) + 1);
    expect(Object.fromEntries(byFamily)).toEqual(FAMILY_COUNTS);
    expect(ALL_SCENARIOS.length).toBe(Object.values(FAMILY_COUNTS).reduce((a, b) => a + b, 0));
  });

  test('every timeline is monotonic', () => {
    for (const s of ALL_SCENARIOS) {
      let prev = Number.NEGATIVE_INFINITY;
      for (const step of s.timeline) {
        const ms = parseOffsetMs(step.at);
        expect(ms, `${s.id} step at ${step.at}`).toBeGreaterThanOrEqual(prev);
        prev = ms;
      }
    }
  });

  test('every tick lands inside the 7:00-19:00 window unless it expects the skip', () => {
    for (const s of ALL_SCENARIOS) {
      for (const step of s.timeline) {
        if (step.kind !== 'tick') continue;
        const hour = (((T0_HOUR + parseOffsetMs(step.at) / HOUR) % 24) + 24) % 24;
        const inWindow = hour >= 7 && hour < 19;
        if (step.expectWindowSkip) {
          expect(inWindow, `${s.id} tick at ${step.at} declares a skip but is IN window`).toBe(
            false,
          );
        } else {
          expect(inWindow, `${s.id} tick at ${step.at} is outside the ask window`).toBe(true);
        }
      }
    }
  });

  test("every seeded ASKED gap's deadline is later than the first tick", () => {
    for (const s of ALL_SCENARIOS) {
      const firstTick = s.timeline.find((t) => t.kind === 'tick' && !t.expectWindowSkip);
      if (!firstTick) continue;
      const tickMs = parseOffsetMs(firstTick.at);
      for (const n of s.world.nudges) {
        if (n.status !== 'asked') continue;
        const due = n.escalateAfter
          ? parseOffsetMs(n.escalateAfter)
          : parseOffsetMs(n.askedAt!) + 24 * HOUR;
        expect(
          due,
          `${s.id}/${n.key}: due ${n.escalateAfter ?? '(asked+24h)'} is not after the first ` +
            `tick ${firstTick.at} — the sweep would escalate before the planner ever decides`,
        ).toBeGreaterThan(tickMs);
      }
    }
  });

  test('deadlines are producible and ask times are deliverable', () => {
    for (const s of ALL_SCENARIOS) {
      for (const n of s.world.nudges) {
        if (n.askedAt && n.escalateAfter) {
          // No production writer can stamp a deadline past asked+48h
          // (NUDGE_ESCALATE_MAX_HOURS bounds every extend) — a seeded one
          // makes the gap undecidable at the ceiling (review finding, WD-02).
          expect(
            parseOffsetMs(n.escalateAfter) - parseOffsetMs(n.askedAt),
            `${s.id}/${n.key}: escalate_after is past asked+48h`,
          ).toBeLessThanOrEqual(48 * HOUR);
        }
        if (n.askedAt) {
          // Compose only delivers 7:00-19:00 — an ask stamped 02:00 is a
          // world production cannot produce.
          const hour = (((T0_HOUR + parseOffsetMs(n.askedAt) / HOUR) % 24) + 24) % 24;
          expect(
            hour >= 7 && hour < 19,
            `${s.id}/${n.key}: asked_at at ${n.askedAt} (${hour}:00 firm-local) is outside ` +
              'the delivery window',
          ).toBe(true);
        }
      }
    }
  });

  test('claim strings are lowercase; multi-gap expectations name their gap', () => {
    for (const s of ALL_SCENARIOS) {
      const expects: ScenarioExpect[] = Array.isArray(s.expect) ? s.expect : s.expect ? [s.expect] : [];
      for (const e of expects) {
        for (const c of [...(e.mustNotClaim ?? []), ...(e.mustName ?? [])]) {
          expect(c, `${s.id}: claim '${c}' must be lowercase`).toBe(c.toLowerCase());
        }
        if (s.world.nudges.length > 1 && (e.action || e.actionNot)) {
          expect(e.nudgeKey, `${s.id}: multi-gap expectation needs nudgeKey`).toBeDefined();
        }
        if (e.nudgeKey) {
          expect(
            s.world.nudges.some((n) => n.key === e.nudgeKey),
            `${s.id}: nudgeKey '${e.nudgeKey}' names no seeded gap`,
          ).toBe(true);
        }
      }
      // deliver/manager_resolve steps must reference real keys too.
      for (const step of s.timeline) {
        if (step.kind === 'deliver' || step.kind === 'manager_resolve') {
          expect(
            s.world.nudges.some((n) => n.key === step.nudgeKey),
            `${s.id}: ${step.kind} names unknown key '${step.nudgeKey}'`,
          ).toBe(true);
        }
      }
    }
  });

  test('lesson scenarios seed lessons; mustRead tools are real team-lead tools', () => {
    const TOOLS = new Set(['spine_read', 'recall_decisions', 'get_customer_context', 'resolve_date']);
    for (const s of ALL_SCENARIOS) {
      const expects: ScenarioExpect[] = Array.isArray(s.expect) ? s.expect : s.expect ? [s.expect] : [];
      for (const e of expects) {
        if (e.lessonCited) {
          expect(s.world.lessons?.length ?? 0, `${s.id}: lessonCited without a seeded lesson`).toBeGreaterThan(0);
        }
        if (e.mustRead) {
          expect(TOOLS.has(e.mustRead.tool), `${s.id}: mustRead names unknown tool`).toBe(true);
        }
      }
    }
  });
});

describe('corpus seeds cleanly (loop, no model)', () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  let tenantId: string;

  beforeAll(async () => {
    await pg.connect();
    const t = await createTenant(`Eval PlannerCorpusSeed ${Date.now()}`);
    tenantId = t.id;
    await pg.query(`update tenants set timezone = $2 where id = $1`, [tenantId, SIM_TZ]);
  });
  afterAll(async () => {
    await pg.end();
  });

  test('every scenario world seeds without error and pins its subjects', async () => {
    const t0Ms = Date.parse(simStartIso(10));
    for (const s of ALL_SCENARIOS) {
      // Per-scenario isolation inside ONE tenant, mirroring the driver.
      await pg.query(`delete from review_items where tenant_id = $1`, [tenantId]);
      await pg.query(`delete from nudges where tenant_id = $1`, [tenantId]);
      // money_events is APPEND-ONLY (ledger trigger) — rows stay; harmless,
      // every money read is job-scoped and each scenario seeds fresh jobs.
      await pg.query(`delete from planner_lessons where tenant_id = $1`, [tenantId]);
      const seeded = await seedScenario(tenantId, s.world, t0Ms);
      const { rows } = await pg.query(
        `select id, kind, subject_ref, status from nudges where tenant_id = $1`,
        [tenantId],
      );
      expect(rows.length, s.id).toBe(s.world.nudges.length);
      for (const row of rows) {
        const pin = row.kind === 'overdue_visit_gap' ? seeded.assignmentId : seeded.jobId;
        expect(row.subject_ref, `${s.id}: subject_ref pinned by kind`).toBe(pin);
      }
    }
  }, 120_000);
});
