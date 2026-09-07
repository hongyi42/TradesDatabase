import { getCustomer, type Customer } from './customers.js';
import { getTenant } from './tenants.js';
import { listJobsForCustomer, type Job } from './jobs.js';
import { listVisitsForCustomer, type VisitWithTechnician } from './visits.js';
import {
  listUpcomingVisitsForCustomer,
  participantIdsOf,
  participantsOf,
} from './visits.js';
import { localDateISO } from '../schedule/availability.js';
import { spineNowIso } from '../evalClock.js';
// Full weekday name, matching resolve_date's phrase convention ("Monday
// 2026-08-03") — the label the agent is told to say verbatim. fit.ts's
// weekdayLabel is the short form used by schedule grids; a phrase spoken to a
// person gets the full word.
const weekdayFull = (dateISO: string): string =>
  new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
import {
  findRetractionsFor,
  foldRetractions,
  getRawCapture,
  listRawCapturesForCustomer,
  type RawCapture,
} from './rawCaptures.js';
import { factSourceIds, foldRetractedFacts } from './standingFacts.js';
import { correspondenceEntries, foldRetractedCorrespondence } from './jobs.js';

// One upcoming stop, in the schedule's display conventions: date + HH:MM
// slices of the naive-local timestamps (never timezone-converted — the wire's
// '+00' is a lie, see get_team_schedule's startTime note). An UNTIMED visit
// (rung 9a) carries no date at all — every date field is null and the phrase
// says so.
export interface UpcomingVisit {
  visitId: string;
  jobId: string;
  jobTitle: string | null;
  technicianRef: string | null;
  technicianName: string | null;
  unassigned: boolean;
  date: string | null; // YYYY-MM-DD — null = no time set yet
  startTime: string | null; // HH:MM wall clock
  endTime: string | null;
  untimed?: true;
  /**
   * Server-composed day label — "Tuesday 2026-08-18", or for a window
   * "between Monday 2026-08-24 and Friday 2026-08-28". The resolve_date
   * pattern: the agent SAYS this verbatim instead of composing its own
   * (2026-08-13 eval, S01: served the bare date 2026-08-18, the model wrote
   * "Tuesday, Aug 19" — right weekday, wrong date, exactly the class a
   * pre-composed phrase removes).
   */
  phrase: string;
}

export interface CustomerContext {
  customer: Customer | null;
  jobs: Job[];
  /**
   * Confirmed FUTURE work from the visits table — placed visits from
   * today forward plus unplaced (time-TBD) visits with a live scheduling
   * window. Added 2026-08-13: this aggregate previously read only `visits`
   * (L2 evidence of PAST work), so "when is X's next visit?" answered "none"
   * for customers with four confirmed bookings, on every surface that briefs
   * from this context.
   */
  upcomingVisits: UpcomingVisit[];
  recentVisits: VisitWithTechnician[];
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

  // Upcoming schedule, tenant-scoped by the CUSTOMER's own tenant (the caller
  // still rejects cross-tenant customers wholesale). "Today" is the firm's
  // local date. Booked work stands regardless of note retractions — an
  // assignment dies via its own status, never via retract_capture — so these
  // rows deliberately do not join the retraction fold below.
  let upcomingVisits: UpcomingVisit[] = [];
  if (customer) {
    const tz = (await getTenant(customer.tenant_id))?.timezone ?? 'UTC';
    // Real clock unless EVAL_FAKE_NOW anchors THIS tenant (date-eval only):
    // the upcoming/recent split must agree with the anchored resolve_date, or
    // an anchored run charges the model for the harness's own inconsistency.
    const todayLocal = localDateISO(spineNowIso(customer.tenant_id), tz);
    const rows = await listUpcomingVisitsForCustomer(customer.tenant_id, customerId, todayLocal);
    upcomingVisits = rows
      // Re-check the embed's tenant: "a job shares its customer's tenant" is
      // an unenforced invariant (id-only FK) — drop rows that violate it.
      .filter((r) => r.jobs?.tenant_id === customer.tenant_id)
      .map((r) => {
        const date = r.starts_at?.slice(0, 10) ?? null;
        const phrase = date ? `${weekdayFull(date)} ${date}` : 'no time set yet';
        const crew = participantsOf(r, customer.tenant_id);
        return {
          visitId: r.id,
          jobId: r.job_id,
          jobTitle: r.jobs?.title ?? null,
          technicianRef: crew[0]?.ref ?? null,
          technicianName: crew[0]?.displayName ?? null,
          // EVERY name on the trip: the brief tells a customer who is coming,
          // and "Ben" for a two-person job is a wrong answer, not a short one.
          technicianRefs: crew.map((p) => p.ref),
          technicianNames: crew.map((p) => p.displayName),
          unassigned: participantIdsOf(r, customer.tenant_id).length === 0, // counted, not named
          date,
          startTime: r.starts_at?.slice(11, 16) ?? null,
          endTime: r.ends_at?.slice(11, 16) ?? null,
          ...(r.starts_at === null ? { untimed: true as const } : {}),
          phrase,
        };
      });
  }

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
  let customerOut = customer;
  let jobsOut = jobs;
  if (!opts.includeRetracted) {
    // Standing-fact evidence captures are normally IN recentCaptures already
    // (record_standing_fact stamps customer_id), but the union above doesn't
    // guarantee it — add their ids explicitly so a fact can never dodge the
    // fold by its evidence missing from the fetched lists.
    const factIds = [
      ...factSourceIds(customer?.attributes ?? null),
      ...jobs.flatMap((j) => factSourceIds(j.attributes)),
    ];
    // Correspondence entries carry their own evidence (rung 10) and are in the
    // SAME position as standing facts: an inbound capture on an existing job is
    // never stamped with a customer_id (identity resolves after L1, which is
    // immutable), so its retraction would not be found by the capture lists
    // above and a retracted email would keep speaking from the job's L3.
    const correspondenceIds = jobs.flatMap((j) =>
      correspondenceEntries(j.attributes).map((e) => e.captureId),
    );
    const retractions = await findRetractionsFor([
      ...new Set([...recentCaptures.map((c) => c.id), ...factIds, ...correspondenceIds]),
    ]);
    recentCaptures = foldRetractions(recentCaptures, retractions);
    const retractedIds = new Set(
      retractions.map((r) => r.retracts_capture_id).filter((id): id is string => !!id),
    );
    // A visit is this note's trip: its source capture retracted ⇒ the visit's
    // facts (labor hours, L3 attributes) must not surface either.
    visits = recentVisits.filter(
      (v) => !v.source_capture_id || !retractedIds.has(v.source_capture_id),
    );
    // Standing facts follow the same rule: evidence retracted ⇒ the fact
    // disappears from the default view (it is the only removal path).
    if (customerOut) {
      customerOut = {
        ...customerOut,
        attributes: foldRetractedFacts(customerOut.attributes, retractedIds),
      };
    }
    jobsOut = jobs.map((j) => ({
      ...j,
      attributes: foldRetractedCorrespondence(
        foldRetractedFacts(j.attributes, retractedIds),
        retractedIds,
      ),
    }));
  }

  return { customer: customerOut, jobs: jobsOut, upcomingVisits, recentVisits: visits, recentCaptures };
}
