import { getClient } from './client.js';
import { participantIdsOf } from './visits.js';
import { factEntriesCiting } from './standingFacts.js';
import { correspondenceEntriesCiting } from './jobs.js';

// What disappears from default views if a given capture is retracted: standing
// facts (customer/job attributes bundle-citing it as evidence) and visits whose
// source capture it is. Computed server-side so the retraction preview never
// depends on the agent noticing — a live retraction (2026-07-14) folded a job's
// fact the agent's own warning missed.
//
// RUNG 9b SPLIT THE VISIT ARM IN TWO, and the distinction is the whole point of
// the preview. A note used to OWN its visit row, so "linked to the capture" and
// "disappears with the capture" were the same set. Now a note LINKS a trip that
// may have been booked long before it, and the fold in src/db/context.ts drops
// only visits whose `source_capture_id` is retracted — a real appointment must
// NOT vanish from the board because a note about it was recorded in error, a
// customer is expecting it. So: `visits` = the trips that actually disappear,
// `visitsLosingEvidence` = the trips that survive and lose this note. Telling
// the manager a booked trip "will disappear" when it will not is the failure
// this split exists to prevent.
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
  // EVERY person on the trip (rung 9c). A crew loses its evidence together, so
  // the singular field would have named one of two.
  technicianIds: string[];
}

// RUNG 10 ADDED A THIRD THING THAT DISAPPEARS. `attributes.correspondence` on a
// job is what a caller said, one entry per inbound capture, and src/db/context.ts
// drops the entries whose capture is retracted — exactly as it drops a standing
// fact. A preview that did not name them would tell the manager "nothing else
// goes" and then silently remove the customer's own words from the job, which is
// the failure this whole module exists to prevent.
export interface FoldedCorrespondence {
  jobId: string;
  jobLabel: string;
  channel: string;
  at: string;
  /** What the caller asked us to do next, when the extractor found one. */
  followUp: string | null;
}

export interface FoldImpact {
  facts: FoldedFact[];
  /** Trips that DISAPPEAR with the capture — it is their `source_capture_id`. */
  visits: FoldedVisit[];
  /** Trips that SURVIVE the retraction and merely lose this note as evidence. */
  visitsLosingEvidence: FoldedVisit[];
  /** What this caller said, kept on a job, that stops being shown (rung 10). */
  correspondence: FoldedCorrespondence[];
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
  const [customers, jobs, visits, citingVisits] = await Promise.all([
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
        .select(
          'visit_id, visits!inner(id,tenant_id,job_id,starts_at,status,source_capture_id,visit_participants(technician_id,created_at,tenant_id))',
        )
        .eq('tenant_id', tenantId)
        .eq('capture_id', captureId)
        .range(from, to),
    ),
    // THE SECOND SOURCE, added in rung 10 because the first stopped being a
    // superset. Until `book_visit` could cite a call, the ONLY writer of
    // `visits.source_capture_id` was attachNote's step 3, which links the same
    // visit through visit_notes in the same call — so walking the links found
    // everything the fold removes. `book_visit` now stamps a visit it MINTS
    // from a manager's yes, and that visit has no visit_notes row at all: the
    // preview would have said "nothing else goes" and the fold would then have
    // dropped a real appointment out of every briefing. Reading the column
    // directly restores the superset whatever writes it next.
    fetchAll('visits', (from, to) =>
      client
        .from('visits')
        .select(
          'id,tenant_id,job_id,starts_at,status,source_capture_id,visit_participants(technician_id,created_at,tenant_id)',
        )
        .eq('tenant_id', tenantId)
        .eq('source_capture_id', captureId)
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
  // The two sources, deduped by visit id: a trip reached through its note, and a
  // trip that cites the capture directly. A visit in BOTH is one visit.
  const byId = new Map<string, (typeof visits)[number]['visits']>();
  // !inner guarantees the embed, but the FK is ID-ONLY: re-check the tenant
  // before surfacing anything about the trip (the DETAIL_SELECT doctrine).
  for (const n of visits) if (n.visits && n.visits.tenant_id === tenantId) byId.set(n.visits.id, n.visits);
  for (const v of citingVisits) if (v.tenant_id === tenantId) byId.set(v.id, v);
  const linked = [...byId.values()].map((v) => ({
    folded: {
      visitId: v.id,
      jobId: v.job_id,
      // The trip's own time, which is what "scheduled" meant all along — the
      // old column of that name was never written by anything.
      scheduledAt: v.starts_at,
      // EVERY person on the trip (rung 9c) — the preview names who loses
      // evidence, and a crew loses it together.
      technicianIds: participantIdsOf(v, tenantId),
    },
    // WHAT "DISAPPEARS" HAS TO MEAN: the reader actually stops showing it.
    // The contents page (customer_contents, migration 20260916120000) reads
    // `last_visit_at` over live-sourced completed trips only — past work
    // evidence — and `src/db/context.ts` does NOT fold `upcomingVisits`, so a
    // CONFIRMED trip keeps its place on the
    // schedule whatever is retracted. That is the rung-9b rule stated out loud:
    // never tell anyone a booked visit is going away.
    //
    // The status test costs nothing on the old path and is what makes the new
    // one truthful: attachNote's step 3 mints its visit `completed` (and the
    // happened-flip completes any trip a note owns), so a note's own trip is
    // never `confirmed` — while a visit `book_visit` minted from a manager's
    // yes always is. Naming that one under `visits` would promise a
    // disappearance that does not happen; it loses this note as evidence.
    disappears: v.source_capture_id === captureId && v.status !== 'confirmed',
  }));
  // Off the SAME jobs scan the facts arm uses — no extra round trip, and the
  // two can never disagree about which jobs were looked at.
  const correspondence: FoldedCorrespondence[] = jobs.flatMap((j) =>
    correspondenceEntriesCiting(j.attributes, captureId).map((e) => ({
      jobId: j.id,
      // Same `||` fallback as the facts arm: a blank title must not attribute
      // the entry to a nameless row.
      jobLabel: j.title?.trim() || j.job_type?.trim() || 'job',
      channel: e.channel,
      at: e.at,
      followUp: e.followUp ?? null,
    })),
  );
  return {
    facts,
    visits: linked.filter((v) => v.disappears).map((v) => v.folded),
    visitsLosingEvidence: linked.filter((v) => !v.disappears).map((v) => v.folded),
    correspondence,
  };
}
