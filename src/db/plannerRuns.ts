import type { Database } from './database.types.js';
import { getClient } from './client.js';
import { wrapDbError } from './rawCaptures.js';

// "When did I last think about this firm?" (plan 2026-08-30, Build 3). One row
// per firm, upserted — see the migration header for why this is not a log.

export type PlannerRun = Database['public']['Tables']['planner_runs']['Row'];

/**
 * Stamp a tick that reached the model.
 *
 * THE CALLER SUPPLIES THE INSTANT — never database now(). The eval drives a
 * simulated clock, and a wall-clock marker would tell every simulated tick that
 * it last planned in the future. Same reason plannerSim rewrites
 * nudge_decisions.decided_at.
 *
 * `ok = false` moves last_ran_at and LEAVES last_success_at alone: the payload
 * omits the column, and PostgREST's merge-duplicates only SETs the columns it
 * was given. That asymmetry is the lesson reflector_runs paid for in a
 * follow-up migration — a failing call that advances the watermark starves the
 * firm, because the next tick believes it has just been served.
 */
export async function upsertPlannerRun(
  tenantId: string,
  atIso: string,
  ok: boolean,
): Promise<void> {
  const { error } = await getClient()
    .from('planner_runs')
    .upsert(
      { tenant_id: tenantId, last_ran_at: atIso, ...(ok ? { last_success_at: atIso } : {}) },
      { onConflict: 'tenant_id' },
    );
  if (error) throw wrapDbError('upsertPlannerRun failed', error);
}

/**
 * When the planner last COMPLETED a tick for this firm, or null if never.
 *
 * NORMALISED to an ISO-8601 Z instant, not relayed raw. PostgREST renders
 * timestamptz as `2026-08-29T09:00:00+00:00`, and every other instant in this
 * codebase is a `…Z` string — the caller subtracts this from `nowIso` and
 * prints the result into a prompt, so leaving two spellings of the same instant
 * in circulation is how a string comparison somewhere downstream quietly
 * becomes false.
 */
export async function latestSuccessfulPlannerRunAt(tenantId: string): Promise<string | null> {
  const { data, error } = await getClient()
    .from('planner_runs')
    .select('last_success_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) {
    throw new Error(`latestSuccessfulPlannerRunAt failed: ${error.message}`, { cause: error });
  }
  const at = data?.last_success_at;
  return at ? new Date(at).toISOString() : null;
}
