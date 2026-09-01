import type { Database } from './database.types.js';
import { getClient } from './client.js';

export type NudgeDecision = Database['public']['Tables']['nudge_decisions']['Row'];

// What the CODE did with a decision, which is not what the model asked for.
// 'refused' is the load-bearing value: a rail that rejects a decision has to
// leave a mark, or a silent no-op reads as success forever.
export type DecisionOutcome = 'shadow' | 'applied' | 'refused';

export interface NudgeDecisionInput {
  tenantId: string;
  // THE GAP'S id — which under the same-id design (plan 2026-08-31) names one
  // gap across both stages. `subject` says which table's row this decision was
  // about, and the writer keys nudge_id OR observation_id from it; the readers
  // coalesce, so callers never care which stage a row landed in.
  nudgeId: string;
  subject?: 'nudge' | 'observation';
  jobId?: string | null;
  mode: 'shadow' | 'live';
  action: string;
  notBefore?: string | null;
  // HISTORIC (build 5): what an `extend` moved the deadline to, back when the
  // verb and the clock existed. No writer passes it any more; the field stays
  // so old rows keep their meaning and the column its docs.
  escalateAfter?: string | null;
  // The manager-facing sentence the planner wrote for an APPLIED escalate, or
  // null when the sweep escalated on its own (it has no model). Deliberately
  // separate from `reason`: that one is diagnostic, is written for refusals
  // too, and is the corpus — this one is product copy and is read by a person.
  handoffNote?: string | null;
  // The TECHNICIAN-facing question the planner wrote for an applied `send` —
  // the delivered message itself since the collapse. Third audience, third
  // rail — see the migration header.
  questionDraft?: string | null;
  // The briefing for the manager's ASSISTANT on an applied `escalate` — the
  // fourth audience, fourth rail. Machine context; never shown to a human.
  agentContext?: string | null;
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
      // Exactly one of the pair, keyed by stage (default: the ask). Both point
      // at the same uuid for a sent gap; the FK decides which table must hold it.
      nudge_id: d.subject === 'observation' ? null : d.nudgeId,
      observation_id: d.subject === 'observation' ? d.nudgeId : null,
      job_id: safeJobId(d.jobId, d.nudgeId),
      mode: d.mode,
      action: d.action,
      not_before: d.notBefore ?? null,
      escalate_after: d.escalateAfter ?? null,
      handoff_note: d.handoffNote ?? null,
      agent_context: d.agentContext ?? null,
      question_draft: d.questionDraft ?? null,
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
 * Includes the `unmentioned` tick marks (plan 2026-08-22, Phase 3) — the COUNT
 * is exactly what the pushed history line is for, so filtering them here would
 * make that number a lie. The two `recall_decisions` lookups below drop them.
 *
 * Growth: since build 5 a gap has no lifetime clocks, so a long-lived gap is
 * a designed state, not a defect. The filler is capped per gap
 * (UNMENTIONED_CAP in planner.ts); real decisions accrue only as fast as the
 * planner makes them. The paging keeps this read correct rather than silently
 * short either way.
 */
export async function listDecisionsForNudges(
  tenantId: string,
  nudgeIds: string[],
): Promise<Map<string, NudgeDecision[]>> {
  const out = new Map<string, NudgeDecision[]>();
  if (nudgeIds.length === 0) return out;
  for (let i = 0; i < nudgeIds.length; i += CHUNK) {
    const slice = nudgeIds.slice(i, i + CHUNK);
    // TWO bound .in() reads, one per column, merged below — NOT one .or()
    // (code-review): the .or() form interpolates the id list twice into a GET
    // querystring (~39KB at CHUNK=500, past common proxy URL ceilings), has an
    // injection grammar surface a bound .in() does not, and buys nothing —
    // under the same-id design the two columns hold the same uuid space.
    const readColumn = async (column: 'nudge_id' | 'observation_id'): Promise<NudgeDecision[]> => {
      const rows: NudgeDecision[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await getClient()
          .from('nudge_decisions')
          .select('*')
          .eq('tenant_id', tenantId)
          .in(column, slice)
          .order('decided_at', { ascending: true })
          // TIEBREAK. `decided_at` defaults to now(), so every row from ONE
          // insert shares a timestamp to the microsecond. `id` is a random
          // uuid: a DETERMINISTIC order, not insertion order — enough for
          // every reader here (historyLine skips `unmentioned` outright and
          // the rest are predicate scans).
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`listDecisionsForNudges failed: ${error.message}`);
        rows.push(...((data ?? []) as NudgeDecision[]));
        if (!data || data.length < PAGE) break;
      }
      return rows;
    };
    const [askRows, obsRows] = await Promise.all([
      readColumn('nudge_id'),
      readColumn('observation_id'),
    ]);
    // Merge in decided_at-then-id order — the same order each read came in.
    // A row matches exactly ONE column (the writer sets one and nulls the
    // other), so no dedup is needed.
    const merged = [...askRows, ...obsRows].sort((a, b) => {
      const at = Date.parse(a.decided_at) - Date.parse(b.decided_at);
      return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (const row of merged) {
      // `?? observation_id` (plan 2026-08-31): pre-ask rows carry
      // observation_id and a NULL nudge_id, and under the same-id design the
      // two name ONE gap — grouping on nudge_id alone would file every
      // pre-ask decision under null, where historyLine and the sweep's
      // plannerAlive would never find it (review F9).
      const key = row.nudge_id ?? row.observation_id;
      if (!key) continue; // unreachable: nudge_decisions_subject_check
      const list = out.get(key);
      if (list) list.push(row);
      else out.set(key, [row]);
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
  // Guards the single-id .or() interpolation below — bounded (one uuid, never
  // a list), so the URL-size hazard the LIST read was rebuilt around does not
  // apply here; the guard is the injection fence.
  if (!UUID_RE.test(nudgeId)) return [];
  const { data, error } = await getClient()
    .from('nudge_decisions')
    .select('*')
    .eq('tenant_id', tenantId)
    // Both stages of one gap (plan 2026-08-31) — recall by the gap's id must
    // surface its pre-ask dismissals and holds too.
    .or(`nudge_id.eq.${nudgeId},observation_id.eq.${nudgeId}`)
    // The tick marks are excluded here and KEPT in listDecisionsForNudges above.
    // That split is the design: the count of considerations belongs in the
    // pushed line, while a planner asking to READ its history wants the
    // decisions — 200 rows of "said nothing" would bury the four that matter and
    // spend the limit on filler.
    .neq('action', 'unmentioned')
    .order('decided_at', { ascending: false })
    .order('id', { ascending: false })
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
    .neq('action', 'unmentioned') // same reason as the per-gap lookup above
    .order('decided_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 200)));
  if (error) throw new Error(`listDecisionsForJob failed: ${error.message}`);
  return (data ?? []) as NudgeDecision[];
}
