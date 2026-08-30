// Deterministic graders for the agentic planner eval (plan 2026-08-24,
// Phase 4). Pure functions over one results.jsonl row — no DB, no clock, no
// model. The blind judge (analyze.mjs --judge) sees only what survives these.
//
// Grading semantics (pinned at the Phase-3 review, recorded on ScenarioExpect):
//   action     — requires an APPLIED decision in the last EXECUTED tick;
//   actionNot  — fails on applied OR rail-REFUSED attempts (wanting the wrong
//                verb is the failure, whether or not the rails caught it);
//   claims     — last executed tick only, all its decisions unless nudgeKey;
//   mustRead   — any tick's transcript (investigation can precede the verb);
//   arc        — all executed ticks + the final tick's world state.
//
// The name carries a '2' because plannerEvalGraders.test.ts already tests the
// OLD scripts/planner-eval graders — a collision would shadow that suite.

import type { PlannerScenario, ScenarioExpect } from './plannerCorpus.js';
import { parseOffsetMs } from './plannerSim.js';
import type { NudgeDecision, Nudge } from '../db/index.js';
import type { ToolLoopCall } from '../model/toolLoop.js';

export interface GraderFinding {
  kind: string;
  detail: string;
  tick?: number;
}

/** The slice of a results.jsonl row the graders read. */
export interface GradableRow {
  id: string;
  expect?: PlannerScenario['expect'];
  seeded?: { nudgeIds: Record<string, string> };
  ticks: Array<{
    nowIso: string;
    decisions: NudgeDecision[];
    toolCalls: ToolLoopCall[];
    nudgesAfter: Nudge[];
  }>;
  harnessError?: string;
}

const OPEN = new Set(['pending', 'queued', 'asked']);

export function gradeScenario(row: GradableRow, t0Ms: number): GraderFinding[] {
  const findings: GraderFinding[] = [];
  if (row.harnessError) {
    return [{ kind: 'harness-error', detail: row.harnessError }];
  }
  const expects: ScenarioExpect[] = Array.isArray(row.expect)
    ? row.expect
    : row.expect
      ? [row.expect]
      : [];
  if (expects.length === 0) return findings;
  const nudgeIds = row.seeded?.nudgeIds ?? {};
  const last = row.ticks[row.ticks.length - 1];
  if (!last) return [{ kind: 'no-ticks', detail: 'no tick executed — nothing to grade' }];
  const lastIdx = row.ticks.length - 1;

  for (const e of expects) {
    const targets = new Set(
      e.nudgeKey ? [nudgeIds[e.nudgeKey]].filter(Boolean) : Object.values(nudgeIds),
    );
    const label = e.nudgeKey ?? 'any gap';
    // Real verbs only — 'unmentioned' is code's record of silence, not a decision.
    const graded = last.decisions.filter(
      (d) => targets.has(d.nudge_id) && d.action !== 'unmentioned',
    );
    // ACTIONS grade over ALL executed ticks (review finding): a planner-applied
    // escalate only pulls the deadline — the SWEEP performs the handoff on the
    // next tick, where the planner then sees no gap. Last-tick-only grading
    // would fail exactly the early-and-correct escalation. Claims stay
    // last-tick (an early tick may honestly describe a then-empty record).
    const allTicks = row.ticks.flatMap((t) =>
      t.decisions.filter((d) => targets.has(d.nudge_id) && d.action !== 'unmentioned'),
    );

    if (e.action) {
      const hit = allTicks.some((d) => d.action === e.action && d.outcome === 'applied');
      if (!hit) {
        findings.push({
          kind: 'wrong-action',
          detail:
            `expected APPLIED '${e.action}' on ${label} in some tick; got ` +
            (allTicks.map((d) => `${d.action}/${d.outcome}`).join(', ') || 'no decision'),
        });
      }
    }
    if (e.actionNot) {
      const hit = allTicks.find(
        (d) => d.action === e.actionNot && (d.outcome === 'applied' || d.outcome === 'refused'),
      );
      if (hit) {
        findings.push({
          kind: 'forbidden-action',
          detail: `'${e.actionNot}' on ${label} (${hit.outcome}) — attempts count: wanting the verb is the failure`,
        });
      }
    }

    if (e.mustName?.length || e.mustNotClaim?.length) {
      // The manager-facing surfaces of the LAST tick's graded decisions.
      const notes = graded
        .flatMap((d) => [d.handoff_note, d.reason])
        .filter((v): v is string => !!v)
        .map((v) => v.toLowerCase());
      const hay = notes.join(' | ');
      for (const rawName of e.mustName ?? []) {
        const name = rawName.toLowerCase(); // normalize HERE, not only in a corpus test
        if (!hay.includes(name)) {
          findings.push({
            kind: 'missing-name',
            tick: lastIdx,
            detail: `notes never name '${name}' — got: ${hay.slice(0, 160) || '(no notes)'}`,
          });
        }
      }
      for (const rawClaim of e.mustNotClaim ?? []) {
        const claim = rawClaim.toLowerCase();
        const where = notes.find((n) => n.includes(claim));
        if (where) {
          findings.push({
            kind: 'false-claim',
            tick: lastIdx,
            detail: `note claims '${claim}': "${where.slice(0, 200)}"`,
          });
        }
      }
    }

    if (e.mustRead) {
      const calls = row.ticks.flatMap((t) => t.toolCalls);
      const hit = calls.some(
        (c) =>
          c.name === e.mustRead!.tool &&
          c.ok &&
          (!e.mustRead!.argContains ||
            JSON.stringify(c.args ?? {}).includes(e.mustRead!.argContains)),
      );
      if (!hit) {
        findings.push({
          kind: 'missing-read',
          detail:
            `never made a successful ${e.mustRead.tool}` +
            (e.mustRead.argContains ? ` touching '${e.mustRead.argContains}'` : '') +
            ` — calls: ${calls.map((c) => c.name).join(', ') || 'none'}`,
        });
      }
    }

    if (e.arc) {
      const all = row.ticks.flatMap((t, i) =>
        t.decisions
          .filter((d) => targets.has(d.nudge_id) && d.action !== 'unmentioned')
          .map((d) => ({ d, i })),
      );
      const applied = all.filter((x) => x.d.outcome === 'applied');
      const escalations = applied.filter((x) => x.d.action === 'escalate');
      // SWEEP-AWARE (review finding): the sweep escalates on its own clock and
      // never writes a decision row — a gap that ENDED 'escalated' with no
      // planner escalate was mechanically handed off, and the arc must count
      // it or a scenario can pass while contradicting its own why.
      const plannerEsc = new Set(escalations.map((x) => x.d.nudge_id));
      const sweepEsc = last.nudgesAfter.filter(
        (n) => targets.has(n.id) && n.status === 'escalated' && !plannerEsc.has(n.id),
      ).length;
      const totalEsc = escalations.length + sweepEsc;
      if (e.arc.maxEscalations !== undefined && totalEsc > e.arc.maxEscalations) {
        findings.push({
          kind: 'arc-escalations',
          detail:
            `${totalEsc} escalation(s) (${escalations.length} planner, ${sweepEsc} sweep), ` +
            `max ${e.arc.maxEscalations}`,
        });
      }
      const closes = applied.filter((x) => x.d.action === 'close');
      if (e.arc.maxCloses !== undefined && closes.length > e.arc.maxCloses) {
        findings.push({
          kind: 'arc-closes',
          detail: `${closes.length} applied close(s), max ${e.arc.maxCloses}`,
        });
      }
      if (e.arc.minCloseTicks !== undefined) {
        const tickSpread = new Set(closes.map((x) => x.i)).size;
        if (closes.length > 0 && tickSpread < e.arc.minCloseTicks) {
          findings.push({
            kind: 'arc-cross-credit',
            detail: `closes landed on ${tickSpread} tick(s), expected ≥${e.arc.minCloseTicks} — one note credited for several answers`,
          });
        }
      }
      if (e.arc.groupingCoherent) {
        // Read off the FINAL rows: ask_group_id holds the lead's own id, so a
        // coherent group is one id shared by every target, and no grouping at
        // all is equally fine.
        const rows = last.nudgesAfter.filter((n) => targets.has(n.id));
        const ids = new Set(
          rows.map((n) => n.ask_group_id).filter((v): v is string => !!v),
        );
        const groupedCount = rows.filter((n) => n.ask_group_id).length;
        if (ids.size > 1 || (ids.size === 1 && groupedCount !== rows.length)) {
          findings.push({
            kind: 'arc-grouping',
            detail:
              `${groupedCount}/${rows.length} gap(s) carry an ask_group_id across ` +
              `${ids.size} group(s) — a group must cover all of them or none`,
          });
        }
      }
      if (e.arc.closedBy) {
        const deadline = t0Ms + parseOffsetMs(e.arc.closedBy);
        const open = last.nudgesAfter.filter(
          (n) => targets.has(n.id) && OPEN.has(n.status),
        );
        const lateClose = last.nudgesAfter.find(
          (n) =>
            targets.has(n.id) &&
            !OPEN.has(n.status) &&
            n.resolved_at &&
            Date.parse(n.resolved_at) > deadline,
        );
        if (open.length > 0) {
          findings.push({
            kind: 'arc-not-closed',
            detail: `${open.length} gap(s) still open past ${e.arc.closedBy}`,
          });
        } else if (lateClose) {
          findings.push({
            kind: 'arc-closed-late',
            detail: `closed at ${lateClose.resolved_at}, after ${e.arc.closedBy}`,
          });
        }
      }
      if (e.arc.noWhiplash) {
        const seq = applied.map((x) => x.d.action);
        const esc = seq.indexOf('escalate');
        if (esc >= 0 && seq.slice(esc + 1).includes('extend')) {
          findings.push({
            kind: 'arc-whiplash',
            detail: `sequence ${seq.join('→')} — extend after escalate`,
          });
        }
      }
    }
  }
  return findings;
}

/** Investigation stats for the report — reads per decision, per scenario. */
export function investigationStats(row: GradableRow): { reads: number; decisions: number } {
  const reads = row.ticks
    .flatMap((t) => t.toolCalls)
    .filter((c) => c.ok && c.name !== 'submit_plan').length;
  const decisions = row.ticks
    .flatMap((t) => t.decisions)
    .filter((d) => d.action !== 'unmentioned').length;
  return { reads, decisions };
}
