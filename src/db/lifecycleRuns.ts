import { getClient } from './client.js';
import type { Database, Json } from './database.types.js';

// The lifecycle cron's execution record, typed. One row per TICK — and now the
// ONLY per-run surface anywhere. (reflector_runs was per-run too, but per
// TENANT and for billing control rather than observability; it was dropped with
// the Reflector in build 3, 2026-08-30.)
//
// Tenant-agnostic on purpose: a tick sweeps every tenant. See the migration
// header (20260826120000_lifecycle_runs.sql) for why that is safe — it is only
// safe because redactForRecord strips every free-text field before the insert.
//
// Append-only by convention: there is no accessor here that rewrites a run, and
// the one mutation is the whole-row prune. The convention used to be stated by
// analogy to reflector_runs and gap_summaries — both dropped 2026-08-30, so it
// stands on its own reason now: this table is read to answer "was the heartbeat
// alive at time T", and a row rewritten in place cannot answer that.

export type LifecycleRun = Database['public']['Tables']['lifecycle_runs']['Row'];

// BOTH timestamps come from the CALLER's clock — deliberately, and not what the
// plan first said. The reason is cost_events: appendCostEvents stamps
// occurred_at with `new Date().toISOString()` on every row (costs.ts:68), never
// the column default, so the ledger runs on the NODE clock. A tick window
// closed with the DATABASE clock would be measured against a different clock
// from the events it is meant to contain, and the interval join — the whole
// reason the window is stored — would be off by whatever the two hosts' skew is.
//
// It also removes a live failure mode: the table's `finished_at >= started_at`
// CHECK spanning two clocks would REJECT a fast off-cadence tick (they do almost
// no work) whenever the database clock lagged the app's by more than the tick
// took. One clock, so the constraint is now a real invariant rather than a
// skew detector that silently costs us records.
export async function insertLifecycleRun(run: {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  summary: Json;
}): Promise<void> {
  const { error } = await getClient().from('lifecycle_runs').insert({
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    ok: run.ok,
    summary: run.summary,
  });
  if (error) throw new Error(`insertLifecycleRun failed: ${error.message}`, { cause: error });
}

// ASCENDING by started_at — findTickGaps below walks consecutive rows, and a
// descending read would make every gap read as negative. The limit is a guard
// against PostgREST's silent 1000-row cap: 500 rows is ~42h of 5-minute ticks,
// and a caller wanting more must page rather than get a quiet truncation.
export async function listLifecycleRuns(
  sinceIso: string,
  limit = 500,
): Promise<LifecycleRun[]> {
  const { data, error } = await getClient()
    .from('lifecycle_runs')
    .select('*')
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listLifecycleRuns failed: ${error.message}`, { cause: error });
  return data ?? [];
}

// Whole rows only, never a field edit — the append-only convention holds and the
// row either exists or it does not. Returns the count deleted so the cron can
// report it.
//
// `count: 'exact'` rather than `.select('id').length`: the returned
// REPRESENTATION is subject to PostgREST's 1000-row cap, so counting the echoed
// rows would report "1000" for any larger sweep — and the first prune after 90
// days of backlog is exactly that sweep. The delete itself is unbounded either
// way; what the cap would silently corrupt is the number we report about it.
export async function pruneLifecycleRuns(beforeIso: string): Promise<number> {
  const { count, error } = await getClient()
    .from('lifecycle_runs')
    .delete({ count: 'exact' })
    .lt('started_at', beforeIso);
  if (error) throw new Error(`pruneLifecycleRuns failed: ${error.message}`, { cause: error });
  return count ?? 0;
}

export interface TickGap {
  /** The last tick before the hole. */
  after: string;
  /** The first tick after it. */
  before: string;
  /** How many ticks the hole swallowed, at the expected cadence. */
  missedTicks: number;
}

// PURE — no database, no clock. The missing-cron detector: consecutive rows
// further apart than one cadence plus tolerance mean ticks that never ran.
//
// Kept pure and here (rather than inline in the operator report) for two
// reasons: it is the report's only real logic, so this is where the test can
// reach it; and `getClient()` is lazy (client.ts:9 throws on CALL, not on
// import), so scripts/ticks/report.mjs can import this module while talking to
// Postgres over `pg` with no SUPABASE_URL set.
//
// The tolerance is not decoration: Render fires a */5 cron on its own schedule
// and a tick that starts at :06 is late, not missing. Without slack, ordinary
// jitter would report a permanent stream of one-tick holes and train the reader
// to ignore the section that exists to be alarming.
export function findTickGaps(
  rows: { started_at: string }[],
  expectedMs = 5 * 60 * 1000,
  toleranceMs = 3 * 60 * 1000,
): TickGap[] {
  const gaps: TickGap[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].started_at;
    const next = rows[i].started_at;
    const deltaMs = Date.parse(next) - Date.parse(prev);
    if (!Number.isFinite(deltaMs) || deltaMs <= expectedMs + toleranceMs) continue;
    // Round rather than floor: a hole of 19m50s at a 5-minute cadence swallowed
    // three ticks, not two, and flooring would under-report every late-but-real
    // boundary by one.
    const missedTicks = Math.max(Math.round(deltaMs / expectedMs) - 1, 1);
    gaps.push({ after: prev, before: next, missedTicks });
  }
  return gaps;
}
