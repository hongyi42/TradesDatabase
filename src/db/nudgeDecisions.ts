import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type NudgeDecision = Database['public']['Tables']['nudge_decisions']['Row'];

// What the CODE did with a decision, which is not what the model asked for.
// 'refused' is the load-bearing value: a rail that rejects a decision has to
// leave a mark, or a silent no-op reads as success forever.
export type DecisionOutcome = 'shadow' | 'applied' | 'refused';

export interface NudgeDecisionInput {
  tenantId: string;
  nudgeId: string;
  jobId?: string | null;
  mode: 'shadow' | 'live';
  action: string;
  notBefore?: string | null;
  // What an `extend` moved the deadline TO. Null for every other action, the
  // way notBefore is null for everything but a hold. Without it the corpus
  // records THAT a deadline was postponed but never how far, so no eval can
  // ask whether the planner postpones sensibly.
  escalateAfter?: string | null;
  // The manager-facing sentence the planner wrote for an APPLIED escalate, or
  // null when the sweep escalated on its own (it has no model). Deliberately
  // separate from `reason`: that one is diagnostic, is written for refusals
  // too, and is the corpus — this one is product copy and is read by a person.
  handoffNote?: string | null;
  basis?: 'evidence' | 'record' | null;
  citation?: string | null;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  outcome: DecisionOutcome;
  outcomeDetail?: string | null;
}

const CHUNK = 500;
const PAGE = 1000;

// `job_id` is a uuid column with no FK, and the insert is one statement per
// chunk — PostgREST has no partial insert, so ONE malformed id would reject the
// whole batch and lose up to 500 decisions. The corpus is the entire point of
// this table, so a bad id costs its own job-keyed recall and nothing else, and
// says so loudly rather than taking the batch down with it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeJobId(jobId: string | null | undefined, nudgeId: string): string | null {
  if (!jobId) return null;
  if (UUID_RE.test(jobId)) return jobId;
  console.error(
    `[nudgeDecisions] nudge ${nudgeId} carries a non-uuid jobId (${jobId}) — recording the ` +
      'decision without it. Its context is malformed upstream.',
  );
  return null;
}

/**
 * Append the tick's decisions. Insert-only — these rows are never updated (see
 * the migration header: the history is read back into the model's context, and
 * a context rewritten in place erodes).
 *
 * Returns the number of rows written. The caller records AFTER applying, so
 * `outcome` is the truth about what happened rather than what was intended.
 */
export async function recordNudgeDecisions(inputs: NudgeDecisionInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < inputs.length; i += CHUNK) {
    const rows = inputs.slice(i, i + CHUNK).map((d) => ({
      tenant_id: d.tenantId,
      nudge_id: d.nudgeId,
      job_id: safeJobId(d.jobId, d.nudgeId),
      mode: d.mode,
      action: d.action,
      not_before: d.notBefore ?? null,
      escalate_after: d.escalateAfter ?? null,
      handoff_note: d.handoffNote ?? null,
      basis: d.basis ?? null,
      citation: d.citation ?? null,
      confidence: d.confidence,
      reason: d.reason,
      outcome: d.outcome,
      outcome_detail: d.outcomeDetail ?? null,
    }));
    const { data, error } = await getClient().from('nudge_decisions').insert(rows).select('id');
    if (error) throw new Error(`recordNudgeDecisions failed: ${error.message}`);
    written += data?.length ?? 0;
  }
  return written;
}

/**
 * Every decision made about these gaps, oldest first, grouped by nudge id.
 *
 * Reads them ALL rather than a per-gap tail, because PostgREST has no per-group
 * limit and a truncated read would make the count in the prompt a lie. Paged and
 * chunked; the 1000-row default cap is silent, so it is never relied on.
 *
 * Growth: while the ladder is live a gap cannot outlive its escalation or
 * delivery deadline, so at one tick per 30 minutes it accumulates a few dozen
 * decisions at most. That bound is the SWEEP's, not this table's — with
 * NUDGES_MODE rolled back the planner still runs (deliberately, see
 * lifecycle.ts) and nothing closes the gap, so rows accrue at ~24/day for as
 * long as that lasts. The paging keeps this correct rather than silently short;
 * a gap with thousands of decisions is the stuck ladder showing through, and
 * that is the bug to fix, not this read.
 */
export async function listDecisionsForNudges(
  tenantId: string,
  nudgeIds: string[],
): Promise<Map<string, NudgeDecision[]>> {
  const out = new Map<string, NudgeDecision[]>();
  if (nudgeIds.length === 0) return out;
  for (let i = 0; i < nudgeIds.length; i += CHUNK) {
    const slice = nudgeIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('nudge_decisions')
        .select('*')
        .eq('tenant_id', tenantId)
        .in('nudge_id', slice)
        .order('decided_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listDecisionsForNudges failed: ${error.message}`);
      for (const row of (data ?? []) as NudgeDecision[]) {
        const list = out.get(row.nudge_id);
        if (list) list.push(row);
        else out.set(row.nudge_id, [row]);
      }
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

/** One gap's decision history, newest first — the recall tool's gap lookup. */
export async function listDecisionsForNudge(
  tenantId: string,
  nudgeId: string,
  limit = 20,
): Promise<NudgeDecision[]> {
  const { data, error } = await getClient()
    .from('nudge_decisions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('nudge_id', nudgeId)
    .order('decided_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`listDecisionsForNudge failed: ${error.message}`);
  return (data ?? []) as NudgeDecision[];
}

/**
 * Every decision about every gap on ONE job, newest first — the recall tool's
 * job lookup. A job's gaps are the unit a person actually reasons in, which is
 * why `job_id` is denormalised onto the row.
 */
export async function listDecisionsForJob(
  tenantId: string,
  jobId: string,
  limit = 40,
): Promise<NudgeDecision[]> {
  const { data, error } = await getClient()
    .from('nudge_decisions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('job_id', jobId)
    .order('decided_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`listDecisionsForJob failed: ${error.message}`);
  return (data ?? []) as NudgeDecision[];
}
