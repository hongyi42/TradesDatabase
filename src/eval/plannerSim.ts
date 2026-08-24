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
import { runPlanner, type PlannerSummary } from '../teamLead/planner.js';
import { runToolLoop, type ToolLoopCall } from '../model/toolLoop.js';
import { TEAM_LEAD_TOOL_SCHEMAS, dispatchForIdentity } from '../mcp/server.js';
import { TEAM_LEAD_REF } from '../teamLead/identity.js';
import { insideAskWindow } from '../teamLead/compose.js';
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
  money?: Array<{
    at: Offset;
    kind: Database['public']['Enums']['money_event_kind'];
    amountCents?: number | null;
  }>;
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
      channel: 'technician_note',
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

  return {
    tenantId,
    t0Ms,
    customerId: customer.id,
    jobId: job.id,
    assignmentId,
    technicianId: tech.id,
    technicianRef: tech.ref,
    nudgeIds,
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
  /** Ticks outside the 7:00–19:00 firm-local ask window record NOTHING (the
   *  planner skips the tenant before building views). That is almost always a
   *  scenario-authoring bug, so runTick throws unless the scenario declares
   *  it expects the skip. */
  expectWindowSkip?: boolean;
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
  const tz = opts.tz ?? SIM_TZ;
  if (!opts.expectWindowSkip && !insideAskWindow(nowIso, tz)) {
    throw new Error(
      `runTick at ${nowIso} falls outside the 7:00-19:00 ${tz} ask window — the planner ` +
        'records nothing there. Move the tick, or declare expectWindowSkip.',
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
