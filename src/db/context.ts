import { getCustomer, type Customer } from './customers.js';
import { listJobsForCustomer, type Job } from './jobs.js';
import { listVisitsForCustomer, type Visit } from './visits.js';
import {
  findRetractionsFor,
  foldRetractions,
  getRawCapture,
  listRawCapturesForCustomer,
  type RawCapture,
} from './rawCaptures.js';

export interface CustomerContext {
  customer: Customer | null;
  jobs: Job[];
  recentVisits: Visit[];
  recentCaptures: RawCapture[];
}

// Aggregated read for "brief me on this customer" / "what did the last tech say".
// recentCaptures unions two sources: captures directly stamped with customer_id,
// AND the captures linked from this customer's jobs/visits via source_capture_id —
// because a tech note lands in L1 before identity is resolved, so its
// raw_captures.customer_id is null and provenance lives only on the L2 row.
//
// Retraction fold (default): retracted captures, the retraction rows themselves,
// AND visits whose source capture is retracted are all dropped — every consumer
// (context tool, briefings, Q&A) inherits the folded view by construction.
// includeRetracted is the audit escape hatch; the caller gates who may use it.
export async function getCustomerContext(
  customerId: string,
  opts: { includeRetracted?: boolean } = {},
): Promise<CustomerContext> {
  const [customer, jobs, recentVisits, capturesByCustomer] = await Promise.all([
    getCustomer(customerId),
    listJobsForCustomer(customerId),
    listVisitsForCustomer(customerId),
    listRawCapturesForCustomer(customerId),
  ]);

  const byId = new Map<string, RawCapture>();
  for (const capture of capturesByCustomer) byId.set(capture.id, capture);

  const sourceIds = [
    ...jobs.map((j) => j.source_capture_id),
    ...recentVisits.map((v) => v.source_capture_id),
  ].filter((id): id is string => !!id && !byId.has(id));

  const fetched = await Promise.all([...new Set(sourceIds)].map((id) => getRawCapture(id)));
  for (const capture of fetched) if (capture) byId.set(capture.id, capture);

  let recentCaptures = [...byId.values()].sort((a, b) =>
    a.captured_at < b.captured_at ? 1 : -1,
  );

  let visits = recentVisits;
  if (!opts.includeRetracted) {
    const retractions = await findRetractionsFor(recentCaptures.map((c) => c.id));
    recentCaptures = foldRetractions(recentCaptures, retractions);
    const retractedIds = new Set(
      retractions.map((r) => r.retracts_capture_id).filter((id): id is string => !!id),
    );
    // A visit is this note's trip: its source capture retracted ⇒ the visit's
    // facts (labor hours, L3 attributes) must not surface either.
    visits = recentVisits.filter(
      (v) => !v.source_capture_id || !retractedIds.has(v.source_capture_id),
    );
  }

  return { customer, jobs, recentVisits: visits, recentCaptures };
}
