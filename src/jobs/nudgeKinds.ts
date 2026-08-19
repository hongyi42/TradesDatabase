import type { Nudge } from '../db/nudges.js';
import type { ReviewKind } from '../db/reviewItems.js';
import { wallClockLabel } from './watchers.js';

// The ladder's kind registry (plan 2026-08-19, Phase 1). Before this, the one
// gap archetype was a literal 'overdue_visit_gap' in four places — and the
// dangerous one is the resolve/escalate sweep, which fails SILENTLY: a nudge of
// an unregistered kind is simply never swept, so it can never be answered,
// escalated or expired. It sits open forever with nothing logged. A registry
// makes "every kind is swept" structural rather than remembered.
//
// The predicates are PURE functions over facts the sweep has already fetched
// (SweepFacts) — never a DB client. That is deliberate: the sweep does ONE
// batched activity/status read per tenant per tick, and a spec that could query
// would quietly turn it into a per-row read.
//
// IMPORT DIRECTION: this module imports `wallClockLabel` from watchers.ts,
// which imports this module back. That cycle is safe ONLY because
// wallClockLabel is a hoisted `function` declaration and nothing here CALLS it
// at module-evaluation time. Do not import a `const` from watchers.ts here (it
// would be in the temporal dead zone), and do not move wallClockLabel to an
// arrow function.

// Everything a spec may know about the world this tick, pre-fetched by the
// sweep. Keyed the way the batched reads already key: activity by job,
// assignment status by the nudge's subject_ref, job status by job id.
export interface SweepFacts {
  hasActivitySince: (jobId: string, sinceLocal: string) => boolean;
  visitStatusById: Map<string, string>;
  // Unused by the overdue spec; the cost spec's `moot` needs it (a cancelled
  // job has nothing left to ask). Populated from the same batched pre-fetch.
  jobStatusById: Map<string, string>;
}

// What a dying nudge hands the manager. The spec BUILDS this; the watcher
// performs the write — so the injected flagGap seam every test relies on stays
// intact, and specs stay pure.
export interface HandoffPlan {
  subjectRef: string;
  jobId: string;
  technicianRef: string | null;
  // Null for kinds whose subject is not a visit (a job-scoped cost gap has no
  // visit window) — flagNudgeGap treats them as optional.
  startsAtLocal: string | null;
  endsAtLocal: string | null;
  suggestion: string;
}

export interface NudgeKindSpec {
  kind: ReviewKind;
  // The per-detector runaway brake. The deleted per-person cap was incidentally
  // capping a MISFIRING detector; the user accepted that the backstop must move
  // per-detector (nudge-pacing-replacement-design §5). Max NEW nudges of this
  // kind per tenant per tick — the tenant-wide MAX_NEW_ITEMS_PER_TENANT_TICK
  // ceiling still applies across all kinds on top of this.
  maxNewPerTenantTick: number;
  // The gap answered itself → resolution text, or null. Checked FIRST.
  filled(n: Nudge, f: SweepFacts): string | null;
  // Nothing left to ask → resolution text, or null.
  moot(n: Nudge, f: SweepFacts): string | null;
  // `naiveLocal` is passed in because it is a PER-TENANT closure built from
  // that tenant's timezone (watchers.ts) — the escalation copy prints the ask
  // time through it, so a spec cannot build one itself.
  handoff(
    n: Nudge,
    mode: 'escalated' | 'expired',
    naiveLocal: (utcIso: string) => string,
  ): HandoffPlan | null;
}

// The ONE manager-item copy for a plain unreported visit (user-approved
// 2026-08-16). Used by the routing fallback, the expired-nudge handoff, and
// compose's thin-context handoff — deliberately NOT the escalation copy, which
// claims "their assistant asked": an expired nudge's ask never landed, and the
// manager must never be told it did (Phase-4 review F1/F3).
export const stage0Suggestion = (
  title: string,
  customer: string,
  endsAtLocal: string,
): string =>
  `The visit for '${title}' (${customer}) was scheduled to wrap up by ` +
  `${wallClockLabel(endsAtLocal)}, but nothing has been recorded about it yet — no ` +
  `field note and no status change. Worth checking how it went so the job's record ` +
  `stays complete. If nothing needed recording, just dismiss this.`;

// Nudge context is watcher-written JSON, read fail-closed at every boundary.
const str = (c: Record<string, unknown>, k: string): string | null =>
  typeof c[k] === 'string' && (c[k] as string).length > 0 ? (c[k] as string) : null;

const ctxOf = (n: Nudge): Record<string, unknown> =>
  (n.context ?? {}) as Record<string, unknown>;

// Display fields keep the pre-registry semantics EXACTLY: any string (including
// '') passes through, only a non-string falls back. `str` above is for the
// structural fields, where '' was already treated as absent.
const disp = <T>(c: Record<string, unknown>, k: string, fallback: T): string | T =>
  typeof c[k] === 'string' ? (c[k] as string) : fallback;

export const OVERDUE_VISIT_GAP_SPEC: NudgeKindSpec = {
  kind: 'overdue_visit_gap',
  // Matches the tenant-wide per-tick cap: with one detector this brake never
  // binds before the tenant ceiling does, which is exactly today's behaviour.
  maxNewPerTenantTick: 5,

  filled(n, f) {
    const c = ctxOf(n);
    const jobId = str(c, 'jobId');
    const startsAtLocal = str(c, 'startsAtLocal');
    if (!jobId || !startsAtLocal || Number.isNaN(Date.parse(startsAtLocal))) return null;
    return f.hasActivitySince(jobId, startsAtLocal)
      ? 'a field report arrived — the gap filled itself'
      : null;
  },

  moot(n, f) {
    const status = f.visitStatusById.get(n.subject_ref);
    return status === 'cancelled' || status === 'completed'
      ? `the visit was ${status} — nothing left to ask`
      : null;
  },

  handoff(n, mode, naiveLocal) {
    const c = ctxOf(n);
    const jobId = str(c, 'jobId');
    const startsAtLocal = str(c, 'startsAtLocal');
    const endsAtLocal = str(c, 'endsAtLocal');
    if (!jobId || !startsAtLocal || !endsAtLocal) return null;
    const title = disp(c, 'jobTitle', 'a job');
    const customer = disp(c, 'customerName', 'unknown customer');
    const base = {
      subjectRef: n.subject_ref,
      jobId,
      technicianRef: disp(c, 'technicianRef', null),
      startsAtLocal,
      endsAtLocal,
    };
    if (mode === 'expired') {
      // The ask never landed → the Stage-0 copy, never the escalation copy.
      return { ...base, suggestion: stage0Suggestion(title, customer, endsAtLocal) };
    }
    // Escalation copy quotes the ask time, so it needs a real asked_at.
    if (!n.asked_at) return null;
    const techName = disp(c, 'technicianName', 'The technician');
    return {
      ...base,
      // Same copy doctrine as the fallback suggestion — and about the JOB, even
      // here: the ask is "close the record out", never "your technician is
      // unresponsive".
      suggestion:
        `${techName}'s assistant asked about the '${title}' visit (${customer}) on ` +
        `${wallClockLabel(naiveLocal(n.asked_at))} and hasn't heard back — ` +
        `nothing is on the job's record yet. Worth a direct word so it gets closed out. ` +
        `If it's already handled, just dismiss this.`,
    };
  },
};

// Every kind the ladder knows how to carry. Adding one here is what makes it
// detected, swept, escalated and composed — there is no second place to edit.
export const NUDGE_KIND_SPECS: NudgeKindSpec[] = [OVERDUE_VISIT_GAP_SPEC];

export function specFor(
  kind: string,
  specs: NudgeKindSpec[] = NUDGE_KIND_SPECS,
): NudgeKindSpec | undefined {
  return specs.find((s) => s.kind === kind);
}
