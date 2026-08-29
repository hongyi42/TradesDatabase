// The agentic planner eval's simulator core (plan 2026-08-24, Phase 1).
//
// This module makes ONE production-faithful planner tick runnable against a
// scenario world seeded into the LOCAL stack, at any simulated instant. Three
// jobs, deliberately in one file so the clock cannot fork:
//
//   seedScenario  — writes a scenario's world with EXPLICIT timestamps. The
//                   typed db helpers stamp the real wall clock (markNudgeAsked,
//                   recordNudgeDecisions, appendMoneyEvent all do), so seeding
//                   goes through the supabase client directly with every
//                   time-bearing column named. Captures are inserted right the
//                   first time — L1 forbids UPDATE even locally.
//   setSimClock   — the ONLY writer of EVAL_FAKE_NOW. The tick instant reaches
//                   the planner/watchers as an ARGUMENT, but the TOOL side
//                   (grounding riders, resolve_date) reads spineNowIso(), which
//                   follows EVAL_FAKE_NOW per tenant — the two must move
//                   together or the model is shown two different "now"s.
//   runTick       — sweep, then planner, mirroring lifecycle.ts:383-395; then
//                   the sim-time fix-up (below), then a read-back of what the
//                   tick did, INCLUDING the tool-call transcript production
//                   discards (planner.ts keeps only counts).
//
// THE SIM-TIME FIX-UP, and why it is not optional: rows the tick itself writes
// (nudge_decisions.decided_at, nudges.resolved_at/queued_at) are stamped by the
// database's real clock. In an arc whose simulated clock has advanced more than
// 24h past the first tick, watchers' `plannerAlive` check compares those REAL
// stamps against sim-now − PLANNER_SILENCE_HOURS and reads a planner that
// decided "ten sim-hours ago" as a full day silent — firing the auto-close
// fail-safe mid-arc and corrupting exactly the late/stuck arcs the corpus
// exists to grade. So after every tick, that tick's new time stamps are
// rewritten to sim-now.

import { randomUUID } from 'node:crypto';
import { getClient } from '../db/client.js';
import type { Database } from '../db/database.types.js';
import {
  createAssignment,
  createCustomer,
  createJob,
  insertTechnician,
  type Nudge,
  type NudgeDecision,
} from '../db/index.js';
import { runWatchers, type WatchersSummary } from '../jobs/watchers.js';
import { runGapSummaries, type SummarizeSummary } from '../jobs/summarize.js';
import { CLOSED_NUDGE_STATUSES, type GapSummary } from '../db/gapSummaries.js';
import { runPlanner, type PlannerSummary } from '../teamLead/planner.js';
import { runToolLoop, type ToolLoopCall } from '../model/toolLoop.js';
import { TEAM_LEAD_TOOL_SCHEMAS, dispatchForIdentity } from '../mcp/server.js';
import { TEAM_LEAD_REF } from '../teamLead/identity.js';
import { plannerCadenceDue, PLANNER_TICK_MINUTES } from '../teamLead/planner.js';
import { localDateISO, localTimeHHMM } from '../schedule/availability.js';
import { naiveLocalISO } from '../schedule/booking.js';

export const SIM_TZ = 'America/Los_Angeles';

// ── offsets ──────────────────────────────────────────────────────────────────
// Every instant in a scenario is an OFFSET from the scenario's t0 ("-30h",
// "+2.5h", "-3d") — the worldSpec doctrine: nothing absolute, so a scenario
// authored in August is as valid in November, and a failing one reproduces
// from t0 alone.

export type Offset = string;

export function parseOffsetMs(offset: Offset): number {
  const m = /^([+-])(\d+(?:\.\d+)?)([hd])$/.exec(offset.trim());
  if (!m) throw new Error(`bad offset '${offset}' — expected like '-30h', '+2h', '-3d'`);
  const sign = m[1] === '-' ? -1 : 1;
  const unitMs = m[3] === 'd' ? 24 * 3_600_000 : 3_600_000;
  return sign * Number(m[2]) * unitMs;
}

export function atOffset(t0Ms: number, offset: Offset): string {
  return new Date(t0Ms + parseOffsetMs(offset)).toISOString();
}

/** Real-UTC instant → the firm's wall clock in the canonical naive-local
 *  storage form (assignments' convention — watchers.ts's own helper, mirrored). */
export function toNaiveLocal(iso: string, tz: string = SIM_TZ): string {
  return naiveLocalISO(localDateISO(iso, tz), localTimeHHMM(iso, tz));
}

/**
 * The scenario's t0: TODAY at `hour`:00 firm-local, as a real UTC instant.
 * Derived, not guessed: the candidate offsets are tried and the one whose
 * firm-local reading is exactly `hour`:00 wins (DST makes the offset ±1h).
 */
export function simStartIso(hour = 10, tz: string = SIM_TZ): string {
  const day = localDateISO(new Date().toISOString(), tz);
  const hh = String(hour).padStart(2, '0');
  for (const off of ['-07:00', '-08:00', '+00:00']) {
    const iso = new Date(Date.parse(`${day}T${hh}:00:00${off}`)).toISOString();
    if (localDateISO(iso, tz) === day && localTimeHHMM(iso, tz) === `${hh}:00`) return iso;
  }
  throw new Error(`could not derive ${hh}:00 firm-local for ${day} in ${tz}`);
}

// ── the scenario world ───────────────────────────────────────────────────────

export type SimNudgeKind = 'overdue_visit_gap' | 'job_cost_gap';
export type SimNudgeStatus = 'pending' | 'queued' | 'asked';
export type SimMoneyKind = Database['public']['Enums']['money_event_kind'];

export interface ScenarioNudgeSpec {
  /** Scenario-local key, referenced by history rows and expectations. */
  key: string;
  kind: SimNudgeKind;
  status: SimNudgeStatus;
  createdAt: Offset;
  askedAt?: Offset;
  /** A planner-moved deadline. Absent = the 24h default applies. */
  escalateAfter?: Offset;
  question?: string;
}

export interface ScenarioWorld {
  customer: { name: string };
  job: { title: string; status?: 'open' | 'in_progress' | 'completed' | 'cancelled' };
  technician: { ref: string; name: string };
  /** The visit (placed assignment). Times are offsets; stored naive-local. */
  visit?: { startsAt: Offset; endsAt: Offset; status?: 'proposed' | 'confirmed' | 'completed' };
  nudges: ScenarioNudgeSpec[];
  /** Job-stamped captures. `at` may be before or after any ask. */
  evidence?: Array<{ at: Offset; text: string; fromTechnician?: boolean }>;
  /** Ledger rows. `at` sets BOTH occurred_at and created_at (the reader bounds
   *  on created_at, which the typed writer refuses to spoof). */
  money?: Array<{ at: Offset; kind: SimMoneyKind; amountCents?: number | null }>;
  /** Prior planner decisions, back-dated — the gap's watched history. */
  history?: Array<{
    at: Offset;
    nudgeKey: string;
    action: string;
    outcome: 'applied' | 'shadow' | 'refused';
    reason?: string;
    escalateAfter?: Offset;
    handoffNote?: string;
  }>;
  /** ACTIVE lessons (⑤): rendered into the prompt's LESSONS block. */
  lessons?: Array<{ text: string }>;
  /** SETTLED review items from PAST escalations about this technician — the
   *  dismissal-pattern substrate the planner's self-check reads
   *  (v_review_items where escalated_from_nudge is not null). The cited nudge
   *  is synthetic: the column is JSONB detail, not an FK. */
  priorItems?: Array<{ at: Offset; status: 'dismissed' | 'resolved'; note?: string }>;
}

export interface SeededScenario {
  tenantId: string;
  t0Ms: number;
  customerId: string;
  jobId: string;
  assignmentId: string | null;
  technicianId: string;
  technicianRef: string;
  /** scenario nudge key → nudges.id */
  nudgeIds: Record<string, string>;
  /** Seeded ACTIVE lesson ids — the strict referent for lessonCited grading. */
  lessonIds: string[];
}

/**
 * Write one scenario's world. Direct column writes wherever a timestamp
 * matters; typed helpers where none does. `subject_ref` is PINNED by kind —
 * the assignment id for a visit gap, the job id for a cost gap — so the live
 * detectors' once-ever dedup recognises the seeded gap as already surfaced
 * instead of minting a duplicate every tick.
 */
export async function seedScenario(
  tenantId: string,
  world: ScenarioWorld,
  t0Ms: number,
  tz: string = SIM_TZ,
): Promise<SeededScenario> {
  const sb = getClient();
  const customer = await createCustomer({ tenantId, name: world.customer.name });
  const job = await createJob({
    tenantId,
    customerId: customer.id,
    title: world.job.title,
    status: world.job.status ?? 'in_progress',
  });
  const tech = await insertTechnician({
    tenantId,
    ref: world.technician.ref,
    displayName: world.technician.name,
    seatExempt: true, // active immediately, deliberately UNREACHABLE (no telegram/sandbox/host)
  });

  let assignmentId: string | null = null;
  let startsAtLocal: string | null = null;
  let endsAtLocal: string | null = null;
  if (world.visit) {
    startsAtLocal = toNaiveLocal(atOffset(t0Ms, world.visit.startsAt), tz);
    endsAtLocal = toNaiveLocal(atOffset(t0Ms, world.visit.endsAt), tz);
    const a = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: tech.id,
      startsAt: startsAtLocal,
      endsAt: endsAtLocal,
      status: (world.visit.status ?? 'confirmed') as never,
    });
    assignmentId = a.id;
  }

  const nudgeIds: Record<string, string> = {};
  for (const spec of world.nudges) {
    if (spec.kind === 'overdue_visit_gap' && !assignmentId) {
      throw new Error(`nudge '${spec.key}': a visit gap needs a visit in the world`);
    }
    const subjectRef = spec.kind === 'overdue_visit_gap' ? assignmentId! : job.id;
    const context: Record<string, unknown> = {
      customerName: world.customer.name,
      jobTitle: world.job.title,
      technicianRef: tech.ref,
      technicianName: world.technician.name,
      jobId: job.id,
      ...(spec.kind === 'overdue_visit_gap'
        ? { assignmentId: assignmentId!, startsAtLocal, endsAtLocal }
        : { endsAtLocal }),
    };
    const askedAt = spec.askedAt ? atOffset(t0Ms, spec.askedAt) : null;
    if (spec.status === 'asked' && !askedAt) {
      throw new Error(`nudge '${spec.key}': status 'asked' needs askedAt`);
    }
    const { data, error } = await sb
      .from('nudges')
      .insert({
        tenant_id: tenantId,
        kind: spec.kind,
        subject_ref: subjectRef,
        technician_id: tech.id,
        status: spec.status,
        context: context as never,
        created_at: atOffset(t0Ms, spec.createdAt),
        asked_at: askedAt,
        escalate_after: spec.escalateAfter ? atOffset(t0Ms, spec.escalateAfter) : null,
        question: spec.question ?? null,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`seed nudge '${spec.key}' failed: ${error?.message}`);
    nudgeIds[spec.key] = data.id;
  }

  for (const ev of world.evidence ?? []) {
    const { error } = await sb.from('raw_captures').insert({
      tenant_id: tenantId,
      // Customer-authored notes are NOT technician notes (review finding):
      // a model reading 'via technician_note' about a customer call could
      // honestly say "no contact from the customer" and be graded a liar.
      channel: ev.fromTechnician === false ? 'phone_call' : 'technician_note',
      raw_text: ev.text,
      technician_ref: ev.fromTechnician === false ? null : tech.ref,
      metadata: { source: 'agentic-eval-seed' } as never,
      job_id: job.id,
      captured_at: atOffset(t0Ms, ev.at),
    });
    if (error) throw new Error(`seed capture failed: ${error.message}`);
  }

  for (const m of world.money ?? []) {
    const at = atOffset(t0Ms, m.at);
    const { error } = await sb.from('money_events').insert({
      tenant_id: tenantId,
      job_id: job.id,
      kind: m.kind,
      amount_cents: m.amountCents ?? null,
      occurred_at: at,
      created_at: at,
      detail: { source: 'agentic-eval-seed' } as never,
    });
    if (error) throw new Error(`seed money event failed: ${error.message}`);
  }

  for (const h of world.history ?? []) {
    const nudgeId = nudgeIds[h.nudgeKey];
    if (!nudgeId) throw new Error(`history row names unknown nudge key '${h.nudgeKey}'`);
    const { error } = await sb.from('nudge_decisions').insert({
      tenant_id: tenantId,
      nudge_id: nudgeId,
      mode: h.outcome === 'shadow' ? 'shadow' : 'live',
      action: h.action,
      outcome: h.outcome,
      confidence: 'medium',
      reason: h.reason ?? '',
      escalate_after: h.escalateAfter ? atOffset(t0Ms, h.escalateAfter) : null,
      handoff_note: h.handoffNote ?? null,
      decided_at: atOffset(t0Ms, h.at),
    });
    if (error) throw new Error(`seed decision history failed: ${error.message}`);
  }

  const lessonIds: string[] = [];
  for (const lesson of world.lessons ?? []) {
    const evidence = Object.values(nudgeIds);
    const { data: lrow, error } = await sb
      .from('planner_lessons')
      .insert({
        tenant_id: tenantId,
        text: lesson.text,
        status: 'active',
        evidence: (evidence.length > 0 ? evidence : ['seed']) as never,
        activated_at: new Date(t0Ms).toISOString(),
      })
      .select('id')
      .single();
    if (error || !lrow) throw new Error(`seed lesson failed: ${error?.message}`);
    lessonIds.push(lrow.id);
  }

  for (const [i, item] of (world.priorItems ?? []).entries()) {
    const at = atOffset(t0Ms, item.at);
    const { error } = await sb.from('review_items').insert({
      tenant_id: tenantId,
      kind: 'overdue_visit_gap',
      subject_ref: `eval-prior-${i}-${tech.ref}`,
      status: item.status,
      suggestion: item.note ?? `an earlier follow-up about ${world.technician.name}'s visit`,
      resolution: item.note ?? null,
      detail: {
        technicianRef: tech.ref,
        escalatedFromNudge: randomUUID(),
      } as never,
      created_at: at,
      resolved_at: at,
    });
    if (error) throw new Error(`seed prior item failed: ${error.message}`);
  }

  return {
    tenantId,
    t0Ms,
    customerId: customer.id,
    jobId: job.id,
    assignmentId,
    technicianId: tech.id,
    technicianRef: tech.ref,
    nudgeIds,
    lessonIds,
  };
}

// ── the clock ────────────────────────────────────────────────────────────────

/** The ONLY writer of EVAL_FAKE_NOW. See src/evalClock.ts for the read side. */
export function setSimClock(tenantId: string, iso: string): void {
  process.env.EVAL_FAKE_NOW = `${tenantId}:${iso}`;
}

export function clearSimClock(): void {
  delete process.env.EVAL_FAKE_NOW;
}

// ── the tick ─────────────────────────────────────────────────────────────────

export interface TickOpts {
  /** Injected for tests. A stub MUST drive the executor it is handed (call
   *  execute('submit_plan', …)) — decisions exist only via validateDecisions
   *  inside that branch; a stub that merely returns records nothing. */
  runLoop?: typeof runToolLoop;
  /** A tick that does not land on the planner's cadence grid records NOTHING
   *  (the planner skips the tenant before building views). That is almost always
   *  a scenario-authoring bug, so runTick throws unless the scenario declares it
   *  expects the skip.
   *
   *  This replaced expectWindowSkip. The ask window is gone, so no tick is
   *  skipped for being at the wrong HOUR any more — but the cadence can still
   *  skip one for being at the wrong MINUTE, and that failure is silent in
   *  exactly the same way the window's was. Same guard, new subject. */
  expectCadenceSkip?: boolean;
  tz?: string;
}

export interface TickRecord {
  nowIso: string;
  watchers: WatchersSummary;
  planner: PlannerSummary;
  /** Rows this tick wrote to nudge_decisions, decided_at rewritten to sim-now. */
  decisions: NudgeDecision[];
  /** The full loop transcript — what production discards. */
  toolCalls: ToolLoopCall[];
  turns: number;
  /** The rendered prompt (gap blocks + lessons block) — the judge's evidence.
   *  Null when the planner skipped before the model call. */
  userPrompt: string | null;
  /** Every nudge on the tenant after the tick, any status. */
  nudgesAfter: Nudge[];
}

export async function runTick(
  tenantId: string,
  nowIso: string,
  opts: TickOpts = {},
): Promise<TickRecord> {
  // No `tz` needed here any more: the old guard asked whether this HOUR was
  // inside the firm's ask window, which was firm-local. The cadence grid is
  // UTC-anchored — only the RATE is firm-dependent — so the guard is zone-free.
  // opts.tz survives for runArc, which still needs it for wall-clock seeding.
  //
  // The sim tenant records no approximate hours, so it runs at the FULL RATE
  // always, which makes the grid a plain "on the hour or the half hour".
  if (!opts.expectCadenceSkip && !plannerCadenceDue(nowIso, PLANNER_TICK_MINUTES)) {
    throw new Error(
      `runTick at ${nowIso} is off the planner's ${PLANNER_TICK_MINUTES}-minute cadence — the ` +
        'planner records nothing there. Move the tick to :00 or :30, or declare expectCadenceSkip.',
    );
  }
  setSimClock(tenantId, nowIso);
  const sb = getClient();
  // Snapshot BEFORE the tick, so "what this tick wrote" is an id/value DIFF —
  // never a wall-clock comparison. Sim stamps and the real clock are not
  // comparable in either direction: seeded history can sit in the real future
  // (t0 is today 10:00 firm-local; runs happen earlier), and a prior tick's
  // sim-stamped resolved_at must not be re-captured by a later tick's fix-up.
  const { data: priorDecisionRows, error: priorErr } = await sb
    .from('nudge_decisions')
    .select('id')
    .eq('tenant_id', tenantId);
  if (priorErr) throw new Error(`pre-tick decision snapshot failed: ${priorErr.message}`);
  const priorDecisionIds = new Set((priorDecisionRows ?? []).map((r) => r.id));
  const { data: priorNudgeRows, error: priorNudgeErr } = await sb
    .from('nudges')
    .select('id, resolved_at, queued_at')
    .eq('tenant_id', tenantId);
  if (priorNudgeErr) throw new Error(`pre-tick nudge snapshot failed: ${priorNudgeErr.message}`);
  const priorNudgeStamps = new Map(
    (priorNudgeRows ?? []).map((r) => [r.id, `${r.resolved_at}|${r.queued_at}`]),
  );
  // review_items too: the SWEEP auto-resolves items (itemResolved → the typed
  // resolver, which stamps a real-clock resolved_at) — summarize's
  // manager_latency_wh reads that stamp, and a real-clock value against a sim
  // closedAt inflates it or silently nulls it (review finding).
  const { data: priorItemRows, error: priorItemErr } = await sb
    .from('review_items')
    .select('id, resolved_at')
    .eq('tenant_id', tenantId);
  if (priorItemErr) throw new Error(`pre-tick item snapshot failed: ${priorItemErr.message}`);
  const priorItemStamps = new Map((priorItemRows ?? []).map((r) => [r.id, r.resolved_at]));

  const listTenants = async (): Promise<string[]> => [tenantId];
  const watchers = await runWatchers(
    nowIso,
    'live',
    {
      listTenants,
      // Load-bearing no-ops: .env carries a real BOARD_BOT_TOKEN, and an
      // un-stubbed item-opening tick would message a real Telegram chat.
      notify: async () => {},
      hasPushToken: () => false,
    },
    'live',
  );

  let userPrompt: string | null = null;
  let toolCalls: ToolLoopCall[] = [];
  let turns = 0;
  const inner = opts.runLoop ?? runToolLoop;
  const wrapLoop: typeof runToolLoop = async (req, tools, execute, ctx, loopDeps) => {
    userPrompt = req.user;
    // Incremental capture UNDER the loop's own record: a loop-level throw
    // (turn/budget ceiling, provider abort) must not erase what the tick
    // already read — the planner's catch still writes rows for that tick, and
    // a tick that made reads must never grade as "no reads" (review finding).
    const seen: ToolLoopCall[] = [];
    const spyExecute: typeof execute = async (name, args) => {
      const rec: ToolLoopCall = { turn: -1, name, args, ok: false, result: '' };
      seen.push(rec);
      try {
        const out = await execute(name, args);
        rec.ok = true;
        rec.result = typeof out === 'string' ? out : JSON.stringify(out ?? null);
        return out;
      } catch (err) {
        rec.result = `error: ${err instanceof Error ? err.message : String(err)}`;
        throw err;
      }
    };
    try {
      const result = await inner(req, tools, spyExecute, ctx, loopDeps);
      toolCalls = result.calls; // authoritative when the loop completes
      turns = result.turns;
      return result;
    } catch (err) {
      toolCalls = seen;
      throw err;
    }
  };

  const planner = await runPlanner(nowIso, 'live', {
    listTenants,
    tools: [...TEAM_LEAD_TOOL_SCHEMAS],
    sweepLive: true,
    execute: (t, name, args) =>
      dispatchForIdentity(name, args, { tenantId: t, technicianRef: TEAM_LEAD_REF }),
    runLoop: wrapLoop,
  });

  // Sim-time fix-up (see the module header): everything the tick wrote — the
  // diff against the pre-tick snapshot — gets its wall-clock stamps rewritten
  // to sim-now.
  const { data: allDecisions, error: readErr } = await sb
    .from('nudge_decisions')
    .select('*')
    .eq('tenant_id', tenantId);
  if (readErr) throw new Error(`tick decision read-back failed: ${readErr.message}`);
  const decisions = ((allDecisions ?? []) as NudgeDecision[]).filter(
    (d) => !priorDecisionIds.has(d.id),
  );
  if (decisions.length > 0) {
    const { error } = await sb
      .from('nudge_decisions')
      .update({ decided_at: nowIso })
      .in(
        'id',
        decisions.map((d) => d.id),
      );
    if (error) throw new Error(`decided_at fix-up failed: ${error.message}`);
    for (const d of decisions) d.decided_at = nowIso;
  }

  const { data: after, error: afterErr } = await sb
    .from('nudges')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });
  if (afterErr) throw new Error(`post-tick nudge read failed: ${afterErr.message}`);
  for (const n of (after ?? []) as Nudge[]) {
    const before = priorNudgeStamps.get(n.id);
    const stampsChanged = before !== undefined && before !== `${n.resolved_at}|${n.queued_at}`;
    const isNew = before === undefined; // minted by this tick's detectors
    if (!stampsChanged && !isNew) continue;
    const patch: { resolved_at?: string; queued_at?: string; created_at?: string } = {};
    // A nudge the tick's own detectors minted carries a real-clock created_at,
    // which drives its delivery deadline and every "noticed Xh ago" label.
    if (isNew) {
      patch.created_at = nowIso;
      n.created_at = nowIso;
    }
    if (n.resolved_at && (isNew || !before?.startsWith(`${n.resolved_at}|`))) {
      patch.resolved_at = nowIso;
      n.resolved_at = nowIso;
    }
    if (n.queued_at && (isNew || !before?.endsWith(`|${n.queued_at}`))) {
      patch.queued_at = nowIso;
      n.queued_at = nowIso;
    }
    if (Object.keys(patch).length === 0) continue;
    const { error } = await sb.from('nudges').update(patch).eq('id', n.id);
    if (error) throw new Error(`nudge stamp fix-up failed: ${error.message}`);
  }
  // Items the tick itself resolved (sweep auto-resolve) or minted: rewrite the
  // real-clock resolved_at to sim-now. Items settled by a manager_resolve STEP
  // are untouched — their stamp was written at sim time and is not a change
  // this tick's snapshot sees.
  const { data: itemsNow, error: itemsNowErr } = await sb
    .from('review_items')
    .select('id, resolved_at')
    .eq('tenant_id', tenantId);
  if (itemsNowErr) throw new Error(`post-tick item read failed: ${itemsNowErr.message}`);
  for (const it of itemsNow ?? []) {
    const before = priorItemStamps.get(it.id);
    const isNewItem = before === undefined; // minted by this tick's sweep
    const stampChanged = !isNewItem && before !== it.resolved_at && it.resolved_at != null;
    if (!isNewItem && !stampChanged) continue;
    const patch: { resolved_at?: string; created_at?: string } = {};
    // A minted item's created_at is on v_review_items — a real-clock stamp in
    // a sim-clock world reads as a contradiction the MODEL gets blamed for.
    if (isNewItem) patch.created_at = nowIso;
    if (it.resolved_at && (isNewItem || stampChanged)) patch.resolved_at = nowIso;
    if (Object.keys(patch).length === 0) continue;
    const { error } = await sb.from('review_items').update(patch).eq('id', it.id);
    if (error) throw new Error(`item stamp fix-up failed: ${error.message}`);
  }

  return {
    nowIso,
    watchers,
    planner,
    decisions,
    toolCalls,
    turns,
    userPrompt,
    nudgesAfter: (after ?? []) as Nudge[],
  };
}

// ── the arc (Phase 2) ────────────────────────────────────────────────────────
// A gap's whole life: ordered timeline steps at offsets from t0. Ticks run the
// production pair; event steps move the world between them. Offsets must be
// non-decreasing (a backwards clock invalidates the arc), and the tick count
// is capped — a scenario that needs more than MAX_ARC_TICKS is measuring the
// harness, not the planner.

import type { PlannerScenario } from './plannerCorpus.js';

export const MAX_ARC_TICKS = 12;

export interface ArcStepRecord {
  atIso: string;
  kind: string;
  /** What actually happened — including a fail-soft miss ('no open item'),
   *  which is a graded observation, never a harness error: whether the model
   *  ever produced the item a step waits on is model-dependent. */
  detail: string;
}

export interface ArcRecord {
  seeded: SeededScenario;
  ticks: TickRecord[];
  steps: ArcStepRecord[];
  finalNowIso: string;
  /** Scripted ticks NOT run because every scenario gap had already closed.
   *  Non-zero matters to grading: an expectation on "the final tick" grades
   *  the last EXECUTED tick, and steps[] records each skip. */
  ticksSkipped: number;
  epilogue: {
    summarize: SummarizeSummary;
    /** This scenario's gap_summaries rows (absent for still-open gaps). */
    summaries: GapSummary[];
  };
}

export async function runArc(
  tenantId: string,
  scenario: Pick<PlannerScenario, 'world' | 'timeline'>,
  t0Ms: number,
  opts: TickOpts = {},
): Promise<ArcRecord> {
  const sb = getClient();
  const tz = opts.tz ?? SIM_TZ;

  // Monotonic PRE-PASS, before a single row is written: a regressed timeline
  // must fail before seeding — not after paid ticks have already run against
  // a half-built world (review finding).
  let prevMs = Number.NEGATIVE_INFINITY;
  scenario.timeline.forEach((step, i) => {
    const ms = parseOffsetMs(step.at);
    if (ms < prevMs) {
      throw new Error(
        `timeline regressed: step ${i} ('${step.kind}' at ${step.at}) is earlier than the ` +
          'step before it — a backwards clock invalidates the arc',
      );
    }
    prevMs = ms;
  });

  const seeded = await seedScenario(tenantId, scenario.world, t0Ms, tz);
  const scenarioNudgeIds = new Set(Object.values(seeded.nudgeIds));

  const ticks: TickRecord[] = [];
  const steps: ArcStepRecord[] = [];
  let finalNowIso = new Date(t0Ms).toISOString();
  let ticksSkipped = 0;
  let allClosed = false;

  for (let i = 0; i < scenario.timeline.length; i++) {
    const step = scenario.timeline[i];
    const atIso = new Date(t0Ms + parseOffsetMs(step.at)).toISOString();
    finalNowIso = atIso;

    switch (step.kind) {
      case 'tick': {
        // Every gap closed → remaining TICKS are skipped (nothing left to
        // decide, no model spend), but later EVENT steps still run — a
        // manager_resolve after closure is exactly how an escalated arc's
        // epilogue escapes the holdback.
        if (allClosed) {
          ticksSkipped += 1;
          steps.push({ atIso, kind: 'tick', detail: 'skipped — all gaps closed' });
          break;
        }
        if (ticks.length >= MAX_ARC_TICKS) {
          throw new Error(`arc exceeded ${MAX_ARC_TICKS} ticks — split the scenario`);
        }
        const tick = await runTick(tenantId, atIso, {
          ...opts,
          expectCadenceSkip: step.expectCadenceSkip,
        });
        ticks.push(tick);
        steps.push({ atIso, kind: 'tick', detail: `decisions: ${tick.decisions.length}` });
        const openLeft = tick.nudgesAfter.filter(
          (n) =>
            scenarioNudgeIds.has(n.id) &&
            (n.status === 'pending' || n.status === 'queued' || n.status === 'asked'),
        );
        allClosed = openLeft.length === 0;
        break;
      }
      case 'capture': {
        const { error } = await sb.from('raw_captures').insert({
          tenant_id: tenantId,
          channel: step.fromTechnician === false ? 'phone_call' : 'technician_note',
          raw_text: step.text,
          technician_ref: step.fromTechnician === false ? null : seeded.technicianRef,
          metadata: { source: 'agentic-eval-timeline' } as never,
          job_id: seeded.jobId,
          captured_at: atIso,
        });
        if (error) throw new Error(`timeline capture failed: ${error.message}`);
        steps.push({ atIso, kind: 'capture', detail: step.text.slice(0, 80) });
        break;
      }
      case 'money': {
        const { error } = await sb.from('money_events').insert({
          tenant_id: tenantId,
          job_id: seeded.jobId,
          kind: step.moneyKind,
          amount_cents: step.amountCents ?? null,
          occurred_at: atIso,
          created_at: atIso,
          detail: { source: 'agentic-eval-timeline' } as never,
        });
        if (error) throw new Error(`timeline money event failed: ${error.message}`);
        steps.push({ atIso, kind: 'money', detail: step.moneyKind });
        break;
      }
      case 'deliver': {
        const nudgeId = seeded.nudgeIds[step.nudgeKey];
        if (!nudgeId) throw new Error(`deliver names unknown nudge key '${step.nudgeKey}'`);
        const { data, error } = await sb
          .from('nudges')
          .update({ status: 'asked', asked_at: atIso })
          .eq('id', nudgeId)
          .in('status', ['pending', 'queued'])
          .select('id')
          .maybeSingle();
        if (error) throw new Error(`timeline deliver failed: ${error.message}`);
        steps.push({
          atIso,
          kind: 'deliver',
          detail: data ? `${step.nudgeKey} asked` : `${step.nudgeKey} MISSED — row was not pending/queued`,
        });
        break;
      }
      case 'manager_resolve': {
        const nudgeId = seeded.nudgeIds[step.nudgeKey];
        if (!nudgeId) throw new Error(`manager_resolve names unknown nudge key '${step.nudgeKey}'`);
        const { data: item, error: findErr } = await sb
          .from('review_items')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('detail->>escalatedFromNudge', nudgeId)
          .eq('status', 'open')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (findErr) throw new Error(`manager_resolve item lookup failed: ${findErr.message}`);
        if (!item) {
          // Fail-soft, recorded: whether an item exists is the MODEL's doing.
          steps.push({ atIso, kind: 'manager_resolve', detail: `${step.nudgeKey} MISSED — no open item` });
          break;
        }
        const { error } = await sb
          .from('review_items')
          .update({
            status: step.outcome,
            resolution: step.note ?? `${step.outcome} by the manager (simulated)`,
            resolved_at: atIso, // sim-stamped: manager_latency_wh reads this
          })
          .eq('id', item.id);
        if (error) throw new Error(`manager_resolve failed: ${error.message}`);
        steps.push({ atIso, kind: 'manager_resolve', detail: `${step.nudgeKey} ${step.outcome}` });
        break;
      }
    }
  }

  // The ⑤ epilogue: express the arc in the gap-summary vocabulary. The clock
  // is the arc's final instant — the holdback and every working-hours figure
  // are judged from there, not from the real wall clock. The lister is
  // TENANT-SCOPED (injected via SummarizeDeps): the default scan is global
  // with a 200-row page ordered oldest-first, so foreign debris on a shared
  // local stack could starve this tenant's rows — and our sim clock must
  // never be the holdback clock for another tenant's gaps (review finding).
  setSimClock(tenantId, finalNowIso);
  const summarize = await runGapSummaries(finalNowIso, {
    listClosed: async () => {
      const { data, error } = await sb
        .from('nudges')
        .select('*, gap_summaries!left(nudge_id)')
        .eq('tenant_id', tenantId)
        .in('status', [...CLOSED_NUDGE_STATUSES])
        .is('gap_summaries', null)
        .order('resolved_at', { ascending: true })
        .limit(200);
      if (error) throw new Error(`epilogue closed-nudge read failed: ${error.message}`);
      return (data ?? []).map((row) => {
        const n = { ...row } as Record<string, unknown>;
        delete n.gap_summaries; // the left-embed used only as the anti-join probe
        return n as unknown as Nudge;
      });
    },
  });
  const { data: sums, error: sumErr } = await sb
    .from('gap_summaries')
    .select('*')
    .eq('tenant_id', tenantId)
    .in('nudge_id', [...scenarioNudgeIds]);
  if (sumErr) throw new Error(`epilogue summary read failed: ${sumErr.message}`);

  return {
    seeded,
    ticks,
    steps,
    finalNowIso,
    ticksSkipped,
    epilogue: { summarize, summaries: (sums ?? []) as GapSummary[] },
  };
}
