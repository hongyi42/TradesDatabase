import {
  findCustomersByPhone,
  findCustomersByAddress,
  getTechnician,
  getTenant,
  listAssignmentsForTechnician,
  listJobsWithCustomerByIds,
} from '../db/index.js';
import { localDateISO } from '../schedule/availability.js';
import type { ExtractedFields } from './extract.js';

// Identity matching is the hardcoded, deterministic core (overview §5): the model
// only suggests fields; this decides which existing customer/job a capture
// belongs to. Resolution order: confirmed customer → unique existing customer by
// phone/address → schedule confirmation → ask.
export interface MatchInput {
  tenantId: string;
  technicianRef: string;
  capturedAt: string; // ISO; the schedule branch looks up this calendar day
  extracted: ExtractedFields;
  // A prior turn's confirmation (disambiguation/confirmation resume).
  confirmed?: { customerId?: string; address?: string };
}

// Denormalized customer fields used to prefill a new customer when create-new
// is the right move (dedup already ran and found none). No longer populated by
// the schedule consultation — assignments always link a real customer — but
// still the shape the staged-confirm resume path (server.ts resolutionFrom /
// recordFieldNote's create-new) carries.
export interface ScheduledCustomerDraft {
  customerName?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

export interface MatchResult {
  status: 'matched' | 'needs_confirmation' | 'needs_disambiguation';
  customerId?: string;
  jobId?: string;
  suggestion?: { address: string; assignmentId: string };
  createFrom?: ScheduledCustomerDraft;
  reason?: string;
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export async function matchIdentity(input: MatchInput): Promise<MatchResult> {
  const { tenantId, technicianRef, capturedAt, extracted, confirmed } = input;

  // An explicitly confirmed customer wins outright.
  if (confirmed?.customerId) {
    return { status: 'matched', customerId: confirmed.customerId };
  }

  // 1. Unique existing-customer match by phone, then address (a confirmed address
  //    wins over the extracted one). This branch is also the dedup that stops a
  //    confirmed/scheduled address from minting a duplicate of a known customer.
  const phone = extracted.phone?.trim();
  if (phone) {
    const byPhone = await findCustomersByPhone(tenantId, phone);
    if (byPhone.length === 1) return { status: 'matched', customerId: byPhone[0].id };
  }
  const address = (confirmed?.address ?? extracted.address)?.trim();
  if (address) {
    const byAddress = await findCustomersByAddress(tenantId, address);
    if (byAddress.length === 1) return { status: 'matched', customerId: byAddress[0].id };
  }

  // 2. Consult the DB-owned schedule (confirmed assignments) for this
  // technician on the capture's FIRM-LOCAL day. Assignments are naive-local
  // (wall-clock stored as if UTC), but capturedAt is REAL UTC — slicing it
  // directly would consult tomorrow's schedule for any evening capture (a
  // 6pm PDT note is already the next UTC day). localDateISO with the firm's
  // timezone recovers the wall-clock day the technician is living in, which
  // is exactly the day key the naive-local rows are stored under.
  // A badge with no roster row has no schedule to consult (assignments key on
  // the technician UUID); every assignment links job → customer, so a hit
  // resolves BOTH ids directly.
  const tech = await getTechnician(tenantId, technicianRef);
  const timezone = tech ? ((await getTenant(tenantId))?.timezone ?? 'UTC') : 'UTC';
  const day = localDateISO(capturedAt, timezone);
  let scheduled: { assignmentId: string; customerId: string; jobId: string; address: string | null }[] =
    [];
  if (tech) {
    const assignments = (
      await listAssignmentsForTechnician(
        tech.id,
        `${day}T00:00:00.000Z`,
        new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString(),
        ['confirmed'],
      )
    ).filter((a) => a.starts_at.slice(0, 10) === day); // overlap-edge clamp (daySource precedent)
    const jobs = await listJobsWithCustomerByIds(tenantId, [
      ...new Set(assignments.map((a) => a.job_id)),
    ]);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    scheduled = assignments.flatMap((a) => {
      const job = jobById.get(a.job_id);
      if (!job) return [];
      return [
        {
          assignmentId: a.id,
          customerId: job.customer_id,
          jobId: a.job_id,
          address: job.customers?.address_line1 ?? null,
        },
      ];
    });
  }

  // 2a. Resume: a confirmed address pointing at a scheduled visit → resolve to
  // its customer AND job.
  if (confirmed?.address) {
    const entry = scheduled.find((e) => sameAddress(e.address, confirmed.address));
    if (entry) {
      return { status: 'matched', customerId: entry.customerId, jobId: entry.jobId };
    }
    // Confirmed address with no scheduled match → caller creates from confirmed.
    return { status: 'needs_disambiguation', reason: 'confirmed address not found on the schedule' };
  }

  // 2b. First pass: exactly one scheduled visit with an address → propose it.
  if (scheduled.length === 1 && scheduled[0].address) {
    return {
      status: 'needs_confirmation',
      suggestion: { address: scheduled[0].address, assignmentId: scheduled[0].assignmentId },
    };
  }

  // 3. Nothing unique to go on — the agent must ask.
  return {
    status: 'needs_disambiguation',
    reason: 'no unique customer match and no single scheduled entry',
  };
}
