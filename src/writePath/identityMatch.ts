import {
  findCustomersByPhone,
  findCustomersByAddress,
  listScheduleForTechnicianOnDate,
} from '../db/index.js';
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

// Denormalized customer fields from a scheduled entry, used to prefill a new
// customer when create-new is the right move (dedup already ran and found none).
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
  suggestion?: { address: string; scheduleEntryId: string };
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

  // 2. Consult the firm schedule for this technician on the capture's day.
  const scheduled = await listScheduleForTechnicianOnDate(tenantId, technicianRef, capturedAt);

  // 2a. Resume: a confirmed address pointing at a scheduled entry.
  if (confirmed?.address) {
    const entry = scheduled.find((e) => sameAddress(e.address_line1, confirmed.address));
    if (entry?.customer_id) {
      // Entry already linked to the spine → resolve to its customer/job.
      return { status: 'matched', customerId: entry.customer_id, jobId: entry.job_id ?? undefined };
    }
    if (entry) {
      // Unlinked entry → create new from its denormalized fields (dedup in step 1
      // already failed to find an existing customer at this address).
      return {
        status: 'needs_disambiguation',
        reason: 'scheduled entry not yet linked to a customer',
        createFrom: {
          customerName: entry.customer_name,
          phone: entry.phone,
          addressLine1: entry.address_line1,
          city: entry.city,
          state: entry.state,
          postalCode: entry.postal_code,
        },
      };
    }
    // Confirmed address with no scheduled match → caller creates from confirmed.
    return { status: 'needs_disambiguation', reason: 'confirmed address not found on the schedule' };
  }

  // 2b. First pass: exactly one scheduled entry with an address → propose it.
  if (scheduled.length === 1 && scheduled[0].address_line1) {
    return {
      status: 'needs_confirmation',
      suggestion: { address: scheduled[0].address_line1, scheduleEntryId: scheduled[0].id },
    };
  }

  // 3. Nothing unique to go on — the agent must ask.
  return {
    status: 'needs_disambiguation',
    reason: 'no unique customer match and no single scheduled entry',
  };
}
