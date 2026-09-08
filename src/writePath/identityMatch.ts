import {
  findCustomersByPhone,
  findCustomersByEmail,
  findCustomersByAddress,
  findCustomersByThread,
  getTechnician,
  getTenant,
  listVisitsForTechnician,
  listJobsWithCustomerByIds,
} from '../db/index.js';
import { localDateISO } from '../schedule/availability.js';
import type { ExtractedFields } from './extract.js';

// Identity matching is the hardcoded, deterministic core (overview §5): the model
// only suggests fields; this decides which existing customer/job a capture
// belongs to. Resolution order: confirmed customer → unique existing customer by
// phone, then EMAIL, then the email THREAD, then address → schedule confirmation
// → ask.
//
// WHY THAT ORDER (rung 10b). Every key is unique-or-refuse — two hits mean the
// key did not identify anybody and the next key gets its turn — so the order is
// about which key, when it IS unique, is the most trustworthy claim.
//   phone   — a person. Strongest: a number is dialled by whoever holds it.
//   email   — a person. Same strength in principle, but shared family/office
//             addresses are commoner than shared phones, so it sits second.
//   thread  — a CONVERSATION we already filed. Weaker than a person key: it says
//             "this reply belongs to that exchange", and the exchange's customer
//             is inferred. It is also the only key that can name the JOB, which
//             it does when the thread's captures point at exactly one.
//   address — a PLACE. Weakest: tenants, landlords and new owners share it.
export interface MatchInput {
  tenantId: string;
  technicianRef: string;
  capturedAt: string; // ISO; the schedule branch looks up this calendar day
  extracted: ExtractedFields;
  // A prior turn's confirmation (disambiguation/confirmation resume).
  confirmed?: { customerId?: string; address?: string };
  // Rung 10b, inbound email only: the sender's bare address and the Gmail thread
  // the message belongs to. The DOOR supplies these — they are envelope facts,
  // not something the extractor read out of the words — which is why they arrive
  // beside `extracted` rather than inside it. Inert when unset (calls, tech
  // notes, and any email whose From had no address in it).
  email?: string | null;
  threadId?: string | null;
}

// Denormalized customer fields used to prefill a new customer when create-new
// is the right move (dedup already ran and found none). No longer populated by
// the schedule consultation — visits always link a real customer — but
// still the shape the staged-confirm resume path (server.ts resolutionFrom /
// recordFieldNote's create-new) carries.
export interface ScheduledCustomerDraft {
  customerName?: string | null;
  phone?: string | null;
  // Rung 10b: a customer created from an inbound email keeps the address it
  // wrote from, so Phase 1's email key recognises them on their NEXT message.
  email?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

export interface MatchResult {
  status: 'matched' | 'needs_confirmation' | 'needs_disambiguation';
  customerId?: string;
  jobId?: string;
  suggestion?: { address: string; visitId: string };
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
  const email = input.email?.trim();
  if (email) {
    const byEmail = await findCustomersByEmail(tenantId, email);
    if (byEmail.length === 1) return { status: 'matched', customerId: byEmail[0].id };
  }
  // THE CONVERSATION KEY. A reply we have already filed one end of identifies its
  // customer even when the reply itself carries no phone and no address — the
  // shape that parked a known customer's reschedule request as a stranger on
  // 2026-09-08. Unique-or-refuse on the CUSTOMER; the job rides along only when
  // the thread points at exactly one, because filing a reply on the wrong job of
  // the right customer is a quieter error than it looks.
  const threadId = input.threadId?.trim();
  if (threadId) {
    const byThread = await findCustomersByThread(tenantId, threadId);
    const customers = new Set(byThread.map((row) => row.customerId));
    if (customers.size === 1) {
      const jobs = new Set(byThread.map((row) => row.jobId).filter((id): id is string => !!id));
      return {
        status: 'matched',
        customerId: [...customers][0],
        ...(jobs.size === 1 ? { jobId: [...jobs][0] } : {}),
      };
    }
  }
  const address = (confirmed?.address ?? extracted.address)?.trim();
  if (address) {
    const byAddress = await findCustomersByAddress(tenantId, address);
    if (byAddress.length === 1) return { status: 'matched', customerId: byAddress[0].id };
  }

  // 2. Consult the DB-owned schedule (confirmed visits) for this
  // technician on the capture's FIRM-LOCAL day. Assignments are naive-local
  // (wall-clock stored as if UTC), but capturedAt is REAL UTC — slicing it
  // directly would consult tomorrow's schedule for any evening capture (a
  // 6pm PDT note is already the next UTC day). localDateISO with the firm's
  // timezone recovers the wall-clock day the technician is living in, which
  // is exactly the day key the naive-local rows are stored under.
  // A badge with no roster row has no schedule to consult (visits key on
  // the technician UUID); every assignment links job → customer, so a hit
  // resolves BOTH ids directly.
  const tech = await getTechnician(tenantId, technicianRef);
  const timezone = tech ? ((await getTenant(tenantId))?.timezone ?? 'UTC') : 'UTC';
  const day = localDateISO(capturedAt, timezone);
  let scheduled: { visitId: string; customerId: string; jobId: string; address: string | null }[] =
    [];
  if (tech) {
    const visits = (
      await listVisitsForTechnician(
        tech.id,
        `${day}T00:00:00.000Z`,
        new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString(),
        // 'completed' too, since rung 9b: the technician's FIRST note of the day
        // marks that visit completed, so a confirmed-only read would leave their
        // second note of the same day with no schedule to match against.
        ['confirmed', 'completed'],
      )
    ).filter((a) => a.starts_at.slice(0, 10) === day); // overlap-edge clamp (daySource precedent)
    const jobs = await listJobsWithCustomerByIds(tenantId, [
      ...new Set(visits.map((a) => a.job_id)),
    ]);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    scheduled = visits.flatMap((a) => {
      const job = jobById.get(a.job_id);
      if (!job) return [];
      return [
        {
          visitId: a.id,
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
      suggestion: { address: scheduled[0].address, visitId: scheduled[0].visitId },
    };
  }

  // 3. Nothing unique to go on — the agent must ask.
  return {
    status: 'needs_disambiguation',
    reason: 'no unique customer match and no single scheduled entry',
  };
}
