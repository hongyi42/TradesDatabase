import { getClient } from './client.js';
import { factEntriesCiting } from './standingFacts.js';

// What disappears from default views if a given capture is retracted: standing
// facts (customer/job attributes bundle-citing it as evidence) and visits whose
// source capture it is. Computed server-side so the retraction preview never
// depends on the agent noticing — a live retraction (2026-07-14) folded a job's
// fact the agent's own warning missed.
export interface FoldedFact {
  rowType: 'customer' | 'job';
  rowId: string;
  rowLabel: string;
  key: string;
  value: string | number | boolean;
}

export interface FoldedVisit {
  visitId: string;
  jobId: string;
  scheduledAt: string | null;
  technicianId: string | null;
}

export interface FoldImpact {
  facts: FoldedFact[];
  visits: FoldedVisit[];
}

// PostgREST caps every response at db-max-rows (1000 in supabase/config.toml
// and on hosted projects) and the cap is a silent fetch limit, not an error —
// https://docs.postgrest.org/en/v12/references/configuration.html#db-max-rows.
// An unpaginated tenant scan would therefore silently omit rows past 1000 and
// the "exhaustive" fold list would lie (review finding). Page until a short
// page instead.
const PAGE = 1000;

async function fetchAll<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`findFoldImpact ${what} failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

// Tenant-scoped fetch + in-memory match: PostgREST JSON filters require the
// key path to be named explicitly, so "any attributes key whose bundle cites
// capture X" is not expressible as a query filter —
// https://docs.postgrest.org/en/v12/references/api/tables_views.html (JSON
// columns) — and hand-written SQL stays out of the codebase by convention.
// Retraction is a rare, manager-gated action and the scan pages at PAGE rows;
// revisit with a JSONB path index + RPC if tenants outgrow it.
export async function findFoldImpact(tenantId: string, captureId: string): Promise<FoldImpact> {
  const client = getClient();
  const [customers, jobs, visits] = await Promise.all([
    fetchAll('customers', (from, to) =>
      client.from('customers').select('id, name, attributes').eq('tenant_id', tenantId).range(from, to),
    ),
    fetchAll('jobs', (from, to) =>
      client
        .from('jobs')
        .select('id, title, job_type, attributes')
        .eq('tenant_id', tenantId)
        .range(from, to),
    ),
    // Rung 9b: a note no longer OWNS a visit row — it LINKS one through
    // visit_notes, and the same trip may carry several notes. So the fold's
    // visit arm walks the link, not source_capture_id: retracting a note must
    // still tell the manager which trip loses its evidence, including when the
    // trip was booked long before the note existed.
    fetchAll('visit_notes', (from, to) =>
      client
        .from('visit_notes')
        .select('visit_id, visits!inner(id,tenant_id,job_id,starts_at,technician_id)')
        .eq('tenant_id', tenantId)
        .eq('capture_id', captureId)
        .range(from, to),
    ),
  ]);

  const facts: FoldedFact[] = [
    ...customers.flatMap((c) =>
      factEntriesCiting(c.attributes, captureId).map(({ key, value }) => ({
        rowType: 'customer' as const,
        rowId: c.id,
        rowLabel: c.name,
        key,
        value,
      })),
    ),
    ...jobs.flatMap((j) =>
      factEntriesCiting(j.attributes, captureId).map(({ key, value }) => ({
        rowType: 'job' as const,
        rowId: j.id,
        // `||`, not `??`: an empty-string title must fall through to the type
        // fallback or the preview attributes the fact to a blank-named row.
        rowLabel: j.title?.trim() || j.job_type?.trim() || 'job',
        key,
        value,
      })),
    ),
  ];
  const foldedVisits: FoldedVisit[] = visits
    // !inner guarantees the embed, but the FK is ID-ONLY: re-check the tenant
    // before surfacing anything about the trip (the DETAIL_SELECT doctrine).
    .filter((n) => n.visits && n.visits.tenant_id === tenantId)
    .map((n) => ({
      visitId: n.visits.id,
      jobId: n.visits.job_id,
      // The trip's own time, which is what "scheduled" meant all along — the
      // old column of that name was never written by anything.
      scheduledAt: n.visits.starts_at,
      technicianId: n.visits.technician_id,
    }));
  return { facts, visits: foldedVisits };
}
