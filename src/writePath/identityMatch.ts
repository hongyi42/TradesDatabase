import {
  findCustomersByPhone,
  findCustomersByEmail,
  findCustomersByAddress,
  findCustomersByThread,
  getTechnician,
  getTenant,
  listVisitsForTechnician,
  listJobsWithCustomerByIds,
  type ThreadIdentity,
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
//             is inferred. It is also the only key that can name the JOB.
//             SO IT IS ASKED EVEN WHEN IT LOST (rung 10b.3): the ORDER decides
//             WHO, and whichever key won, the thread is then consulted purely
//             for WHICH job — see `withThreadJob` below.
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
  // WHAT EACH KEY ACTUALLY FOUND. A refusal is not "no match": it is usually a
  // NEAR miss — two customers share that address, the thread crosses two records
  // — and the planner is asked to be the second opinion on exactly that. Without
  // it the gap block prints the generic tail and never says what the first
  // opinion saw (rung 10b review finding).
  const tried: string[] = [];

  // THE CONVERSATION KNOWS THE JOB; A PERSON KEY ONLY EVER KNEW THE PERSON.
  // Read once, lazily: a message with no thread id never pays for it, and the
  // arms below (three of which can each want it) share the one answer.
  let threadRowsOnce: Promise<ThreadIdentity[]> | null = null;
  const threadRows = (): Promise<ThreadIdentity[]> => {
    const id = input.threadId?.trim();
    if (!id) return Promise.resolve([]);
    threadRowsOnce ??= findCustomersByThread(tenantId, id);
    return threadRowsOnce;
  };

  // A PERSON KEY DECIDED WHO; ASK THE THREAD PURELY FOR WHICH (rung 10b.3).
  // Before this, phone/email/address returned the moment they were unique, so
  // the thread's answer was never computed and the door fell back to guessing —
  // the customer's most recently created non-terminal job. A customer with a
  // quote outstanding AND a repair booked, replying about the older one, was
  // filed against the newer: cited, on the right person, looking correct.
  //
  // ADOPTED ONLY WHEN THE JOB SITS ON THE CUSTOMER WE JUST MATCHED. A thread
  // that drifted to somebody else (forwarded, re-used, a landlord looped in)
  // would otherwise file this message against another customer's work, which is
  // worse than the guess being fixed. Unique-or-nothing on the job too, for the
  // same reason the thread arm refuses: two jobs is not an answer.
  // `findCustomersByThread` has already dropped TERMINAL jobs and proved every
  // row belongs to this tenant, so neither needs re-checking here.
  //
  // A FAILED "WHICH" MUST NOT COST US THE "WHO". `findCustomersByThread` throws
  // on any PostgREST error, and before this rung a unique person key returned
  // without ever reading the thread — so letting that throw out of here would
  // turn a resolved identity into a 503, and Composio's redelivery would pay for
  // the extractor a SECOND time (the capture has no L2 link yet, so the door's
  // already-processed short-circuit does not catch it). We keep the match and
  // fall back to the door's own job choice — which since 2026-09-12 is a
  // narrower thing than it was: on the automatic path the door no longer guesses
  // from position, so a thread read that fails for a customer with several open
  // jobs now ends in "which one could not be told" and an ask, not in a silent
  // filing on the newest. The fallback still exists; what it falls back TO is
  // the honest answer rather than a confident one. The
  // THREAD ARM below still propagates: there, the read is the answer, not an
  // aid, and a retry is the only thing that gets it right.
  const withThreadJob = async (customerId: string): Promise<MatchResult> => {
    let jobId: string | undefined;
    try {
      const jobs = new Set(
        (await threadRows())
          .filter((row) => row.customerId === customerId && row.jobId)
          .map((row) => row.jobId as string),
      );
      if (jobs.size === 1) jobId = [...jobs][0];
    } catch (err) {
      console.error(
        `matchIdentity: thread ${input.threadId} could not name a job for ${customerId} — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { status: 'matched', customerId, ...(jobId ? { jobId } : {}) };
  };

  const phone = extracted.phone?.trim();
  if (phone) {
    const byPhone = await findCustomersByPhone(tenantId, phone);
    if (byPhone.length === 1) return withThreadJob(byPhone[0].id);
    tried.push(
      byPhone.length === 0
        ? `no customer has the phone ${phone}`
        : `${byPhone.length} customers share the phone ${phone}`,
    );
  }
  const email = input.email?.trim();
  if (email) {
    const byEmail = await findCustomersByEmail(tenantId, email);
    if (byEmail.length === 1) return withThreadJob(byEmail[0].id);
    tried.push(
      byEmail.length === 0
        ? `no customer has the address ${email}`
        : `${byEmail.length} customers share the address ${email}`,
    );
  }
  // THE CONVERSATION KEY. A reply we have already filed one end of identifies its
  // customer even when the reply itself carries no phone and no address — the
  // shape that parked a known customer's reschedule request as a stranger on
  // 2026-09-08. Unique-or-refuse on the CUSTOMER; the job rides along only when
  // the thread points at exactly one, because filing a reply on the wrong job of
  // the right customer is a quieter error than it looks.
  const threadId = input.threadId?.trim();
  if (threadId) {
    const byThread = await threadRows();
    const customers = new Set(byThread.map((row) => row.customerId));
    if (customers.size === 1) {
      return withThreadJob([...customers][0]);
    }
    tried.push(
      customers.size === 0
        ? 'nothing on file belongs to this email thread'
        : `this email thread crosses ${customers.size} customers`,
    );
  }
  const address = (confirmed?.address ?? extracted.address)?.trim();
  if (address) {
    const byAddress = await findCustomersByAddress(tenantId, address);
    if (byAddress.length === 1) return withThreadJob(byAddress[0].id);
    tried.push(
      byAddress.length === 0
        ? `no customer is at ${address}`
        : `${byAddress.length} customers are at ${address}`,
    );
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
      reason: [...tried, `one visit is on this person's schedule today, at ${scheduled[0].address}`]
        .join('; '),
    };
  }

  // 3. Nothing unique to go on — the agent must ask.
  return {
    status: 'needs_disambiguation',
    reason:
      tried.length > 0
        ? `${tried.join('; ')} — and no single scheduled entry`
        : 'the message carried no phone, email, thread or address to match on',
  };
}
