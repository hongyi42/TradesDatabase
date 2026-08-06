import { getClient } from './client.js';

// The read-only ad-hoc query path (design:
// thoughts/shared/plans/2026-08-04-query-spine-design.md).
//
// The SQL the agent wrote is passed as a PARAMETER to a SECURITY DEFINER
// function owned by `spine_reader`, so it executes with strictly fewer
// privileges than this caller holds. The tenant is a separate parameter, taken
// from the VERIFIED identity — it is never interpolated into the model's SQL and
// never read from a tool argument. See the migration header for why the filter
// lives in views rather than in an appended WHERE clause.

export interface QuerySpineResult {
  rows: unknown[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

// Mirrors the ceiling inside query_spine(); a caller asking for more is clamped
// there, not here. Kept in sync deliberately so the reported `truncated` flag
// matches what the database actually did.
export const QUERY_SPINE_MAX_ROWS = 1000;
export const QUERY_SPINE_DEFAULT_ROWS = 200;

export async function runSpineQuery(
  tenantId: string,
  sql: string,
  opts: { technicianRef?: string; maxRows?: number } = {},
): Promise<QuerySpineResult> {
  const maxRows = Math.min(opts.maxRows ?? QUERY_SPINE_DEFAULT_ROWS, QUERY_SPINE_MAX_ROWS);
  const started = Date.now();
  const { data, error } = await getClient().rpc('query_spine', {
    p_tenant: tenantId,
    p_sql: sql,
    p_max_rows: maxRows,
  });
  const durationMs = Date.now() - started;

  // Audit BOTH outcomes, and never let an audit failure change the caller's
  // result: a swallowed query is worse than a missing log line, and this runs
  // after the read has already happened. Decision C — a table, not L1, because a
  // read is not a state-changing agent action and L1 cannot be pruned.
  const audit = async (rowCount: number | null, err: string | null) => {
    try {
      await getClient().from('query_audit').insert({
        tenant_id: tenantId,
        technician_ref: opts.technicianRef ?? null,
        sql,
        row_count: rowCount,
        duration_ms: durationMs,
        error: err,
      });
    } catch {
      /* best effort */
    }
  };

  if (error) {
    await audit(null, error.message);
    throw new Error(error.message, { cause: error });
  }

  const rows = Array.isArray(data) ? (data as unknown[]) : [];
  await audit(rows.length, null);
  return {
    rows,
    rowCount: rows.length,
    durationMs,
    // Reported rather than silent: a capped result that reads as complete is the
    // failure mode that turns "3 open jobs" into a wrong answer nobody queries.
    truncated: rows.length >= maxRows,
  };
}
