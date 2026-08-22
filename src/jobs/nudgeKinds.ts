import type { Nudge } from '../db/nudges.js';
import type { ReviewKind } from '../db/reviewItems.js';
import type { ForcedToolSpec } from '../model/forcedTool.js';
import {
  COMPOSE_SYSTEM,
  COMPOSE_TOOL,
  COST_COMPOSE_SYSTEM,
  COST_COMPOSE_TOOL,
  assembleCostNudgeMessage,
  assembleNudgeMessage,
  readComposeContext,
  readCostComposeContext,
  relativeDayPhrase,
} from '../teamLead/composeCopy.js';
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
  // Real-UTC instant → the firm's wall clock, the per-tenant closure. The cost
  // spec compares activity against the ASK time (asked_at, real UTC) while the
  // activity map is naive-local, so it cannot convert without this.
  naiveLocal: (utcIso: string) => string;
  // Jobs that HAVE a live (non-negated) cost on the money ledger. Added for the
  // ITEM sweep (plan 2026-08-19, Phase 2), which needs to know when a manager
  // has done the thing their queue item asked for.
  //
  // Deliberately NOT consumed by any `filled` predicate. A cost recorded by the
  // manager still does not close an open cost NUDGE — that is one of three
  // "the ladder cannot see the money ledger" defects the user ruled should be
  // designed once, together, in a later plan. Wiring it here because it happened
  // to be in hand would be exactly the piecemeal fix that decision rejected.
  jobsWithCostEvents: Set<string>;
}

// The manager-queue twin of SweepFacts' subject: what the item sweep knows about
// ONE open review item, parsed fail-closed at the boundary the way nudge context
// is. `jobId` is required (every gap is about a job); the visit bounds are null
// for a job-scoped kind, and a spec that needs them returns null.
export interface OpenItemView {
  subjectRef: string;
  jobId: string;
  startsAtLocal: string | null;
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

// How ONE kind turns a nudge row into a model call and a deliverable.
//
// The row's context never escapes this block: `prepare` reads it and returns a
// closure that assembles the final message. That is what lets a second kind
// carry a completely different context shape with no union type and no generic
// leaking into the registry — compose.ts only ever sees {user, assemble}.
export interface ComposeBlock {
  system: string;
  tool: ForcedToolSpec;
  // null = the row's evidence is thin or tampered. NEVER ask a model to guess
  // around it; the caller hands the gap to the manager instead.
  prepare(
    n: Nudge,
    nowIso: string,
    tz: string,
  ): { user: string; assemble: (question: string) => string } | null;
}

// What the CALLER has already checked, handed to a template so its copy can say
// it. The rule every manager-facing string here obeys (user, 2026-08-21): a
// template may render data it was given and may carry instructions, but must
// NEVER assert a fact it did not receive as an argument. Each field below is
// therefore named after the PREDICATE that produces it, never after the
// conclusion a reader might draw — a later caller must not be able to reach for
// one of these to justify a wider claim than the predicate supports.
export interface HandoffContext {
  // The newest APPLIED escalate reason for this gap, or null. Model-authored
  // text on a surface where every other word is code-owned, so it is quoted and
  // attributed rather than blended in.
  plannerReason?: string | null;
  // TRUE only when the caller has just evaluated hasActivitySince and it was
  // false. Backs ONE clause with ONE wording: "no field note and no status
  // change". It does NOT back "nothing is on the record" — that predicate reads
  // two tables and is blind to money_events, which is exactly how the
  // 2026-08-20 specimen told a manager nothing had happened on a job the
  // customer had already paid for.
  // NOT passed on the EXPIRED path: JOB_COST_GAP_SPEC.filled short-circuits on
  // `!n.asked_at` (:298) and an expired row was never asked, so the predicate is
  // never evaluated there for that kind.
  noNoteOrStatusChange?: boolean;
  // TRUE only when the caller has checked the money ledger for this job and
  // found no live material_cost. Backs "nothing is recorded for it yet". It does
  // NOT back "the job's costs are incomplete" — a job with no parts has complete
  // costs, and that conclusion is nobody's to draw from this predicate.
  noCostOnLedger?: boolean;
}

// The planner's own words, appended to a handoff. Kept local: `flat` is private
// to planner.ts and `flatten` is unexported in composeCopy.ts, and widening
// either one to reach here would export a helper purely for a caller that wants
// a different shape anyway.
const plannerNote = (ctx?: HandoffContext): string => {
  const r = ctx?.plannerReason?.replace(/\s+/g, ' ').trim();
  if (!r) return '';
  return `\n\nThe assistant's note: "${r.length > 200 ? r.slice(0, 199) + '…' : r}"`;
};

export interface NudgeKindSpec {
  kind: ReviewKind;
  // Does subject_ref name a VISIT (an assignment id), or something else? The
  // sweep uses this to decide which batched status read a kind's subjects belong
  // in — a job-scoped kind's subject is a job id, and looking it up in the
  // assignments table is both wasted work and a lie about what the id means.
  subjectIsVisit: boolean;
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
  // How an open MANAGER REVIEW ITEM of this kind closes itself → resolution
  // text, or null to leave it open.
  //
  // Separate from `filled`/`moot` because the QUESTION is different. A nudge asks
  // the technician and closes when they answer; an item asks the MANAGER and
  // closes when the manager has done the thing it asked for. For a visit gap
  // those coincide (a field report). For a cost gap they do not: the item asks a
  // manager to RECORD the cost, and only the ledger can say whether they did.
  //
  // Before this existed the sweep read one hardcoded kind, so a cost item never
  // left the queue — it could not be resolved by anything except a human
  // dismissing it. That is the gap escalate-then-close depends on.
  itemResolved(item: OpenItemView, f: SweepFacts): string | null;
  // `naiveLocal` is a PER-TENANT closure built from that tenant's timezone
  // (watchers.ts). OPTIONAL because compose and the delivery queue hand rows to
  // the manager too and have no timezone to build one from — they only ever use
  // 'expired', which prints no timestamp. A spec whose 'escalated' copy needs
  // one must return null when it is absent (fail-closed, never a wrong time).
  // `ctx` is OPTIONAL for the same reason `naiveLocal` is: compose.ts and the
  // delivery queue hand rows to the manager too, and they have checked nothing.
  // A spec must therefore omit every factual clause when it is absent — that
  // path asserts nothing because it knows nothing.
  handoff(
    n: Nudge,
    mode: 'escalated' | 'expired',
    naiveLocal?: (utcIso: string) => string,
    ctx?: HandoffContext,
  ): HandoffPlan | null;
  compose: ComposeBlock;
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
  // See HandoffContext.noNoteOrStatusChange. Absent = the caller checked
  // nothing, so the clause is omitted rather than softened.
  noNoteOrStatusChange?: boolean,
): string =>
  `The visit for '${title}' (${customer}) was scheduled to wrap up by ` +
  `${wallClockLabel(endsAtLocal)}.` +
  (noNoteOrStatusChange ? ` No field note and no status change has been recorded for it.` : '') +
  ` Worth checking how it went so the job's record stays complete. If nothing needed ` +
  `recording, just dismiss this.`;

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
  subjectIsVisit: true,
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

  // The two paths that were inlined in the sweep before the registry reached
  // review items, with their resolution copy carried over VERBATIM — this move
  // must not change a single manager-visible string.
  itemResolved(item, f) {
    if (item.startsAtLocal && f.hasActivitySince(item.jobId, item.startsAtLocal)) {
      return 'field report arrived after this was flagged';
    }
    const status = f.visitStatusById.get(item.subjectRef);
    if (status === 'cancelled' || status === 'completed') {
      return `visit was ${status} after this was flagged`;
    }
    return null;
  },

  compose: {
    system: COMPOSE_SYSTEM,
    tool: COMPOSE_TOOL,
    prepare(n, nowIso, tz) {
      const ctx = readComposeContext(n);
      if (!ctx) return null;
      return {
        user:
          `Customer: ${ctx.customerName}\n` +
          `Job: ${ctx.jobTitle}\n` +
          `Technician: ${ctx.technicianName}\n` +
          `The visit wrapped up ${relativeDayPhrase(nowIso, tz, ctx.endsAtLocal)}; ` +
          `nothing has been recorded since — no field note and no status change.`,
        assemble: (question) => assembleNudgeMessage(question, ctx),
      };
    },
  },

  handoff(n, mode, naiveLocal, ctx) {
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
      return {
        ...base,
        suggestion: stage0Suggestion(title, customer, endsAtLocal, ctx?.noNoteOrStatusChange),
      };
    }
    // Escalation copy quotes the ask time, so it needs both a real asked_at
    // and a way to render it in the firm's clock.
    if (!n.asked_at || !naiveLocal) return null;
    const techName = disp(c, 'technicianName', 'The technician');
    return {
      ...base,
      // Same copy doctrine as the fallback suggestion — and about the JOB, even
      // here: the ask is "close the record out", never "your technician is
      // unresponsive".
      // "hasn't heard back" is DELETED, not gated: no reply-side datum exists
      // anywhere in the system, so nothing could ever back it. The record claim
      // is gated on the predicate that was actually run.
      suggestion:
        `${techName}'s assistant asked about the '${title}' visit (${customer}) on ` +
        `${wallClockLabel(naiveLocal(n.asked_at))}.` +
        (ctx?.noNoteOrStatusChange
          ? ` No field note and no status change has been recorded since.`
          : '') +
        ` Worth a direct word so it gets closed out. If it's already handled, just dismiss this.` +
        plannerNote(ctx),
    };
  },
};

// Detector #2 (plan 2026-08-19): the work is done, nothing says what it cost.
//
// Squarely `ask` class — a $40 condensate pump exists nowhere but the
// technician's memory, so there is no derivation to attempt. Its urgency
// profile is deliberately DIFFERENT from the visit question, which is why it
// was chosen: a receipt amount does not decay, but it blocks the books.
//
// TWO limits, both accepted deliberately and both visible here rather than
// buried:
//  1. subject_ref is the JOB id, and uq_nudges_subject_ever asks once per
//     subject FOREVER — so only the FIRST cost gap on a job is ever asked.
//     Later purchases on a multi-day job are never chased (user decision
//     2026-08-19, taken to keep "ask once, ever" a database guarantee).
//  2. The answer closes the nudge but does NOT become a countable number: the
//     technician's agent cannot write money (record_money_event is
//     manager-only), so the amount lands as PROSE on the job and a manager must
//     record it. Nothing chases the manager yet — that is the next plan.
export const JOB_COST_GAP_SPEC: NudgeKindSpec = {
  kind: 'job_cost_gap',
  // The only kind whose subject is a JOB — see the note above.
  subjectIsVisit: false,
  // Tighter than the visit brake: cost gaps arrive in bursts when a batch of
  // jobs completes, and this is a brand-new detector — the runaway backstop
  // matters most before it has a track record.
  maxNewPerTenantTick: 3,

  filled(n, f) {
    // The bound is the ASK time, NOT the visit end. A completed job almost
    // always already has a field note (that is usually what completed it), so
    // comparing against the visit would mark every cost nudge answered the
    // instant it was created, without anyone answering anything.
    if (!n.asked_at) return null; // not asked yet — nothing can have answered it
    const jobId = str(ctxOf(n), 'jobId');
    if (!jobId) return null;
    return f.hasActivitySince(jobId, f.naiveLocal(n.asked_at))
      ? 'the technician answered — a note landed on the job'
      : null;
  },

  moot(n, f) {
    const status = f.jobStatusById.get(str(ctxOf(n), 'jobId') ?? '');
    return status === 'cancelled' ? 'the job was cancelled — nothing left to ask' : null;
  },

  // A cost item asks the MANAGER to record what the job cost, so the ledger is
  // the only thing that can say it is done — not a note, and not any other
  // activity on the job. This is the item half ONLY; the nudge's `filled` above
  // deliberately still ignores the ledger (see SweepFacts.jobsWithCostEvents).
  itemResolved(item, f) {
    if (f.jobsWithCostEvents.has(item.jobId)) {
      return 'a cost was recorded for this job after it was flagged';
    }
    if (f.jobStatusById.get(item.jobId) === 'cancelled') {
      return 'the job was cancelled after this was flagged';
    }
    return null;
  },

  handoff(n, mode, _naiveLocal, ctx) {
    const c = ctxOf(n);
    const jobId = str(c, 'jobId');
    if (!jobId) return null;
    const title = disp(c, 'jobTitle', 'a job');
    const customer = disp(c, 'customerName', 'unknown customer');
    const techName = disp(c, 'technicianName', 'The technician');
    return {
      subjectRef: n.subject_ref,
      jobId,
      technicianRef: disp(c, 'technicianRef', null),
      // A job-scoped gap has NO visit window — the flagger takes these as
      // optional and omits the keys rather than storing nulls.
      startsAtLocal: null,
      endsAtLocal: null,
      // Neither copy prints a timestamp, so this kind never needs naiveLocal.
      // The expired lead-in is the ONLY place this copy names the job, the
      // customer and the topic, and handToManager reaches it with NO ctx — so
      // the subject is rendered data and stays unconditional, and only the
      // ledger CLAIM is gated. Gating the whole sentence shipped a manager item
      // that said merely "Worth asking Ben what they picked up for it."
      suggestion:
        mode === 'expired'
          ? `The '${title}' job (${customer}) has an open question about what it cost in parts ` +
            `or materials.` +
            (ctx?.noCostOnLedger ? ` Nothing is recorded for it yet.` : '') +
            ` Worth asking ${techName} what they picked up for it. If there were no parts, just ` +
            `dismiss this.`
          : `${techName}'s assistant asked what the '${title}' job (${customer}) cost in parts ` +
            `and materials.` +
            (ctx?.noCostOnLedger ? ` Nothing is recorded for it yet.` : '') +
            ` Worth a direct word so it can be recorded. If it's already handled, just dismiss ` +
            `this.` +
            plannerNote(ctx),
    };
  },

  compose: {
    system: COST_COMPOSE_SYSTEM,
    tool: COST_COMPOSE_TOOL,
    prepare(n) {
      const ctx = readCostComposeContext(n);
      if (!ctx) return null;
      return {
        user:
          `Customer: ${ctx.customerName}\n` +
          `Job: ${ctx.jobTitle}\n` +
          `Technician: ${ctx.technicianName}\n` +
          `The job is finished; nothing has been recorded about what it cost in parts or ` +
          `materials.`,
        assemble: (question) => assembleCostNudgeMessage(question, ctx),
      };
    },
  },
};

// Every kind the ladder knows how to carry. Adding one here is what makes it
// detected, swept, escalated and composed — there is no second place to edit.
export const NUDGE_KIND_SPECS: NudgeKindSpec[] = [OVERDUE_VISIT_GAP_SPEC, JOB_COST_GAP_SPEC];

export function specFor(
  kind: string,
  specs: NudgeKindSpec[] = NUDGE_KIND_SPECS,
): NudgeKindSpec | undefined {
  return specs.find((s) => s.kind === kind);
}
