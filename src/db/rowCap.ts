// PostgREST's per-read row limit, made SAYABLE (plan 2026-09-15-the-retrieval-layer-4).
//
// Every supabase-js read that does not page stops at `max_rows` and says nothing:
// the list simply ends. For the tenant-wide schedule readers that is fixed by
// paging. For the rest the operator's ruling (2026-09-15) is to TELL the agent
// rather than page them: when a read that reaches an agent comes back at exactly
// the limit, the result carries this note, so a balance or a job list that may be
// short is never presented as complete.
//
// The number is `[api] max_rows` in supabase/config.toml, which is also the
// hosted default. A read that returns exactly the limit may be complete — the
// note says "may", never "is cut".
export const POSTGREST_MAX_ROWS = 1000;

export const hitRowCap = (n: number): boolean => n >= POSTGREST_MAX_ROWS;

export const rowCapNote = (what: string): string =>
  `Only the first ${POSTGREST_MAX_ROWS} ${what} were read (the database's per-read limit) — ` +
  'there may be more, and anything worked out from them may be incomplete.';
