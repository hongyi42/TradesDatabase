import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from '../db/tenants.js';
import { ALL_SCENARIOS, FAMILY_COUNTS, type ScenarioExpect } from './plannerCorpus.js';
import { parseOffsetMs, seedScenario, simStartIso, SIM_TZ } from './plannerSim.js';
import { plannerCadenceDue, PLANNER_TICK_MINUTES } from '../teamLead/planner.js';

// The corpus's structural rails (plan Phase 3). These are AUTHORING tests:
// they catch the scenario shapes that would grade the harness instead of the
// planner — a tick the planner skips records nothing, a gap already past its
// deadline is escalated by the sweep before the planner sees it, and a
// mixed-case mustNotClaim can never match the lowercase haystack.

const HOUR = 3_600_000;
const T0_HOUR = 10; // simStartIso(10) — the driver's anchor
// The real instant t0 resolves to, so cadence can be judged on the same UTC
// clock the planner uses rather than on a reconstructed local hour.
const T0_MS = Date.parse(simStartIso(T0_HOUR));

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

  test("every tick lands on the planner's cadence grid unless it expects the skip", () => {
    // Was "inside the 7:00-19:00 ask window". The window is deleted (plan
    // 2026-08-29 Phase 3) so no tick is skipped for its HOUR any more — but the
    // cadence still skips one for its MINUTE, and the failure is identical and
    // just as silent: the planner records nothing and the scenario grades as a
    // no-decision rather than as a broken scenario.
    //
    // The sim tenant records no approximate hours, so it runs at the FULL rate
    // always — the grid is :00 and :30.
    for (const s of ALL_SCENARIOS) {
      for (const step of s.timeline) {
        if (step.kind !== 'tick') continue;
        const onGrid = plannerCadenceDue(
          new Date(T0_MS + parseOffsetMs(step.at)).toISOString(),
          PLANNER_TICK_MINUTES,
        );
        if (step.expectCadenceSkip) {
          expect(onGrid, `${s.id} tick at ${step.at} declares a skip but is ON the grid`).toBe(
            false,
          );
        } else {
          expect(onGrid, `${s.id} tick at ${step.at} is off the planner's cadence`).toBe(true);
        }
      }
    }
  });

  test("every seeded ASKED gap's deadline is later than EVERY scripted tick", () => {
    // Not just the first (review finding, MG-06): the sweep runs at every
    // tick, and a mid-arc due time silently hands the gap off before the
    // planner decides — the scenario then grades the sweep, not the model.
    for (const s of ALL_SCENARIOS) {
      const tickOffsets = s.timeline
        .filter((t) => t.kind === 'tick' && !t.expectCadenceSkip)
        .map((t) => parseOffsetMs(t.at));
      if (tickOffsets.length === 0) continue;
      const lastTickMs = Math.max(...tickOffsets);
      for (const n of s.world.nudges) {
        if (n.status !== 'asked') continue;
        const due = n.escalateAfter
          ? parseOffsetMs(n.escalateAfter)
          : parseOffsetMs(n.askedAt!) + 24 * HOUR;
        expect(
          due,
          `${s.id}/${n.key}: due ${n.escalateAfter ?? '(asked+24h)'} is not after the LAST ` +
            `tick — the sweep would escalate before the planner decides`,
        ).toBeGreaterThan(lastTickMs);
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
    // ONLY the schemas production hands the loop (TEAM_LEAD_TOOL_SCHEMAS = 2).
    // The identity allowlist names two more, but a tool with no handed schema
    // is unreachable — a mustRead on it would fail every run forever.
    const TOOLS = new Set(['spine_read', 'recall_decisions']);
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
