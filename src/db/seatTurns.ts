import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

// A glue seat's conversation, uploaded live (step 3, plan
// 2026-09-23-step-3-office-reaches-glue-seats; the migration header carries the
// design). OPERATIONAL, never L1: deletable, pruned at 90 days. RAW ACCESSORS
// ONLY — `src/db/` is an import leaf.

export type SeatTurn = Database['public']['Tables']['seat_turns']['Row'];
export type SeatTurnRole = 'person' | 'assistant' | 'tool';

export interface SeatTurnInsert {
  id: string;
  tenantId: string;
  technicianId: string;
  seatId: string;
  sessionId: string;
  at: string;
  role: SeatTurnRole;
  text: string | null;
  tool: string | null;
  args: Json | null;
  ok: boolean | null;
}

/** Idempotent on id: a batch re-sent after a lost response stores nothing twice. Returns rows stored. */
export async function insertSeatTurns(rows: SeatTurnInsert[]): Promise<number> {
  if (!rows.length) return 0;
  const { data, error } = await getClient()
    .from('seat_turns')
    .upsert(
      rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenantId,
        technician_id: r.technicianId,
        seat_id: r.seatId,
        session_id: r.sessionId,
        at: r.at,
        role: r.role,
        text: r.text,
        tool: r.tool,
        args: r.args,
        ok: r.ok,
      })),
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .select('id');
  if (error) throw new Error(`insertSeatTurns failed: ${error.message}`, { cause: error });
  return data?.length ?? 0;
}

// LIKE's own wildcards and escape, escaped: a query is words, never a pattern.
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * One person's recent turns, newest first — the office's read. TENANT and
 * PERSON are both required: this is never a cross-firm or whole-firm read.
 * `query` matches the words or a tool's name; without it, the latest turns.
 */
export async function searchSeatTurns(input: {
  tenantId: string;
  technicianId: string;
  query?: string;
  days: number;
  limit: number;
}): Promise<SeatTurn[]> {
  const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000).toISOString();
  const base = () =>
    getClient()
      .from('seat_turns')
      .select()
      .eq('tenant_id', input.tenantId)
      .eq('technician_id', input.technicianId)
      .gte('at', since);
  const words = input.query?.trim();
  // Two plain ilike reads merged here, rather than one or= filter: an or= list
  // is comma-separated text PostgREST parses, and a person's words can hold any
  // punctuation. A single-column filter takes its value verbatim.
  const reads = words
    ? [base().ilike('text', `%${likeEscape(words)}%`), base().ilike('tool', `%${likeEscape(words)}%`)]
    : [base()];
  const rows = new Map<string, SeatTurn>();
  for (const read of reads) {
    const { data, error } = await read.order('at', { ascending: false }).limit(input.limit);
    if (error) throw new Error(`searchSeatTurns failed: ${error.message}`, { cause: error });
    for (const r of data ?? []) rows.set(r.id, r);
  }
  return [...rows.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, input.limit);
}

// The 90-day prune (lifecycle job). `count: 'exact'` for the pruneLifecycleRuns
// reason: the echoed representation is capped at 1000 rows, the delete is not.
// The cause rides along so the job can tell a missing table (skipped) from a failure.
export async function pruneSeatTurns(beforeIso: string): Promise<number> {
  const { count, error } = await getClient()
    .from('seat_turns')
    .delete({ count: 'exact' })
    .lt('at', beforeIso);
  if (error) throw new Error(`pruneSeatTurns failed: ${error.message}`, { cause: error });
  return count ?? 0;
}
