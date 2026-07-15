import { getClient } from './client.js';
import { isFactBundle } from './standingFacts.js';
import type { Json } from './database.types.js';

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
  technicianName: string | null;
}

export interface FoldImpact {
  facts: FoldedFact[];
  visits: FoldedVisit[];
}

function factsCiting(
  attrs: Json,
  captureId: string,
  rowType: FoldedFact['rowType'],
  rowId: string,
  rowLabel: string,
): FoldedFact[] {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return [];
  const out: FoldedFact[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    const v = value ?? null;
    if (isFactBundle(v) && v.sourceCaptureId === captureId) {
      out.push({ rowType, rowId, rowLabel, key, value: v.value });
    }
  }
  return out;
}

// Tenant-scoped fetch + in-memory match: PostgREST filters can't express "any
// JSONB key whose value cites capture X", and hand-written SQL stays out of the
// codebase by convention. Retraction is a rare, manager-gated action and a
// tenant's customers/jobs are small at pilot scale — revisit with a JSONB path
// index if that stops being true.
export async function findFoldImpact(tenantId: string, captureId: string): Promise<FoldImpact> {
  const client = getClient();
  const [customers, jobs, visits] = await Promise.all([
    client.from('customers').select('id, name, attributes').eq('tenant_id', tenantId),
    client.from('jobs').select('id, title, job_type, attributes').eq('tenant_id', tenantId),
    client
      .from('visits')
      .select('id, job_id, scheduled_at, technician_name')
      .eq('tenant_id', tenantId)
      .eq('source_capture_id', captureId),
  ]);
  if (customers.error) throw new Error(`findFoldImpact customers failed: ${customers.error.message}`);
  if (jobs.error) throw new Error(`findFoldImpact jobs failed: ${jobs.error.message}`);
  if (visits.error) throw new Error(`findFoldImpact visits failed: ${visits.error.message}`);

  const facts = [
    ...(customers.data ?? []).flatMap((c) =>
      factsCiting(c.attributes, captureId, 'customer', c.id, c.name),
    ),
    ...(jobs.data ?? []).flatMap((j) =>
      factsCiting(j.attributes, captureId, 'job', j.id, j.title ?? j.job_type ?? 'job'),
    ),
  ];
  const foldedVisits = (visits.data ?? []).map((v) => ({
    visitId: v.id,
    jobId: v.job_id,
    scheduledAt: v.scheduled_at,
    technicianName: v.technician_name,
  }));
  return { facts, visits: foldedVisits };
}
