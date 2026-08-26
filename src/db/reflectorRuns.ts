import { getClient } from './client.js';
import type { Database } from './database.types.js';

// ⑤ Phase 4: the Reflector's run markers, typed. One row per ATTEMPTED run per
// tenant.
//
// These markers are BILLING CONTROL, not telemetry — the table's migration
// header is explicit: without a marker an unchanged corpus re-fires a billed
// model call every day. That is why a FAILED run still writes one.
//
// Append-only by convention, like gap_summaries next door: a run either
// happened or it did not, and there is no accessor here to rewrite one.

export type ReflectorRun = Database['public']['Tables']['reflector_runs']['Row'];

// Newest marker of ANY outcome. The once-a-day gate reads this one, so a failed
// attempt still closes the day for billing purposes.
export async function latestReflectorRunAt(tenantId: string): Promise<string | null> {
  const { data, error } = await getClient()
    .from('reflector_runs')
    .select('ran_at')
    .eq('tenant_id', tenantId)
    .order('ran_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`latestReflectorRunAt failed: ${error.message}`, { cause: error });
  return data?.[0]?.ran_at ?? null;
}

// Newest SUCCESSFUL marker — the floor for "what has arrived since we last
// actually looked". Deliberately a different read from the one above (reflector
// review F2): a failure marker must bound the day's billing without making the
// summaries the model never saw stop counting as new.
export async function latestSuccessfulReflectorRunAt(tenantId: string): Promise<string | null> {
  const { data, error } = await getClient()
    .from('reflector_runs')
    .select('ran_at')
    .eq('tenant_id', tenantId)
    .eq('ok', true)
    .order('ran_at', { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`latestSuccessfulReflectorRunAt failed: ${error.message}`, { cause: error });
  }
  return data?.[0]?.ran_at ?? null;
}

// `ran_at` is left to the column default so the marker carries the DATABASE's
// clock, not the caller's — the same instant the gate above will compare against.
export async function insertReflectorRun(
  tenantId: string,
  proposed: number,
  ok: boolean,
): Promise<void> {
  const { error } = await getClient()
    .from('reflector_runs')
    .insert({ tenant_id: tenantId, proposed, ok });
  if (error) throw new Error(`insertReflectorRun failed: ${error.message}`, { cause: error });
}
