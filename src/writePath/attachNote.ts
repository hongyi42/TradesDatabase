// WHICH TRIP DOES THIS NOTE BELONG TO? (rung 9b, phase 3)
//
// Before the remodel the question never came up: every field note MINTED its own
// `visits` row, so a technician filing twice about one trip produced two, and two
// technicians on one crew produced two more. That was invisible because the table
// nothing scheduled from. Now `visits` IS the schedule, so a note has to find the
// trip it is reporting — or the board grows visits nobody made.
//
// The rule, in order:
//   1. A visit PLACED on the note's own firm-local day, with this technician ON
//      IT or with nobody on it. Nearest start wins a tie, because a technician
//      who files at 11:40 after a 9–11 and a 13–14 is talking about the morning
//      one. "ON IT" is membership of the crew (rung 9c), not a column match:
//      when two people go on one trip, EITHER of them reports it and the trip
//      is done. Before that, the crew was two separate visits and the partner's
//      row never closed — it sat 'confirmed' forever, chased by the watcher for
//      a report that had already been filed.
//   2. Otherwise the job's ONE live visit, if it has exactly one. A note filed
//      the next morning about yesterday's trip is the common case, and a job
//      with a single visit has no ambiguity to resolve.
//   3. Otherwise CREATE one, as already happened — but only for a technician
//      channel. A walk-in or an emergency is a real trip with no booking behind
//      it; a customer's email is not a trip at all.
//
// ATTACH IS CHANNEL-BLIND, CREATE IS NOT. Steps 1 and 2 run for every channel:
// an inbound email that answers a question about a booked visit is evidence
// about that trip, and before this it linked nothing at all — invisible to the
// planner's evidence read and to the watcher's activity probe, which is how a
// customer's own answer could leave a gap looking unanswered. Step 3 is the
// only technician-gated part, and RUNG 10 LEFT IT THAT WAY: inbound got no
// creation path here. When nothing attaches, the capture is pinned to the JOB
// (`job_captures`) and — if the firm agreed to come out — a manager is asked
// whether it should reach the calendar. What goes on the schedule is theirs
// to say; the write-path's job is to make sure they are asked.
import {
  createVisit,
  listParticipants,
  listVisitsForJob,
  participantIdsOf,
  type VisitWithParticipants,
} from '../db/visits.js';
import { localDateISO, localTimeHHMM } from '../schedule/availability.js';
import { naiveLocalISO } from '../schedule/booking.js';
import type { Json } from '../db/database.types.js';

export interface ResolveVisitForNoteInput {
  tenantId: string;
  jobId: string;
  technicianId: string | null;
  /** REAL UTC, as captured. Converted to the firm's wall clock here — once. */
  capturedAt: string;
  timezone: string;
  captureId: string;
  /** Step 3 only. False for inbound correspondence (email / call / web form). */
  mayCreate: boolean;
  laborHours?: number | null;
  attributes?: Json;
}

export interface ResolvedVisitForNote {
  /** null = nothing to attach to, and this channel may not create one. */
  visit: VisitWithParticipants | null;
  created: boolean;
  /**
   * The note landed on a trip whose crew does not include the filer (step 2
   * below: the job's one live visit, whatever day it sits on, taken because
   * there was nothing better). NOTHING IS REFUSED OR RE-ROUTED BY THIS — the
   * attach behaves exactly as it always has (operator doctrine, 2026-09-19:
   * "code doesn't restrict"; a technician covering somebody else's trip is
   * ordinary). It exists so the SEAT can say what it assumed and ask, which is
   * where a contradiction gets noticed. Step 1 already requires her or an
   * empty crew, and step 3 creates a trip she is the crew of, so both are
   * false by construction.
   */
  offCrew: boolean;
  /** The note's time in the SAME convention the visit's times use. */
  noteLocal: string;
}

// THE CONVENTION TRAP, and the reason this is computed in one place: visit times
// are NAIVE-LOCAL — firm wall clock stamped as if UTC — while `capturedAt` is a
// real UTC instant. Comparing them raw makes an 08:00 note look like it came
// after a 09:00 visit in America/Los_Angeles, so a note filed before a trip
// would mark it as happened. identityMatch.ts:73-85 documents the same trap.
export function noteLocalOf(capturedAt: string, timezone: string): string {
  return naiveLocalISO(localDateISO(capturedAt, timezone), localTimeHHMM(capturedAt, timezone));
}

const LIVE = new Set(['confirmed', 'completed']);

export async function resolveVisitForNote(
  input: ResolveVisitForNoteInput,
): Promise<ResolvedVisitForNote> {
  const noteLocal = noteLocalOf(input.capturedAt, input.timezone);
  const noteDay = noteLocal.slice(0, 10);

  // job_id is an id-only foreign key, so re-check the tenant before treating any
  // of these rows as ours (the DETAIL_SELECT doctrine in src/db/visits.ts).
  const live = (await listVisitsForJob(input.jobId)).filter(
    (v) => v.tenant_id === input.tenantId && LIVE.has(v.status),
  );

  // (1) Placed on the note's own day, held by this technician or by nobody.
  const sameDay = live.filter((v) => {
    if (v.starts_at === null || v.starts_at.slice(0, 10) !== noteDay) return false;
    const crew = participantIdsOf(v, input.tenantId);
    return (
      crew.length === 0 ||
      (input.technicianId !== null && crew.includes(input.technicianId))
    );
  });
  if (sameDay.length > 0) {
    const noteMs = Date.parse(noteLocal);
    const nearest = sameDay.reduce((best, v) =>
      Math.abs(Date.parse(v.starts_at as string) - noteMs) <
      Math.abs(Date.parse(best.starts_at as string) - noteMs)
        ? v
        : best,
    );
    return { visit: nearest, created: false, offCrew: false, noteLocal };
  }

  // (2) The job's one live visit, whatever day it sits on. THE ONE STEP THAT
  // CAN LAND A NOTE ON SOMEBODY ELSE'S TRIP: there is no crew test here, by
  // design — a note about this job with one trip open belongs on that trip far
  // more often than it belongs nowhere. We record that we assumed it.
  if (live.length === 1) {
    const crew = participantIdsOf(live[0], input.tenantId);
    return {
      visit: live[0],
      created: false,
      offCrew:
        crew.length > 0 && (input.technicianId === null || !crew.includes(input.technicianId)),
      noteLocal,
    };
  }

  // (3) A trip with no booking behind it — technician channels only.
  if (!input.mayCreate) return { visit: null, created: false, offCrew: false, noteLocal };
  const created = await createVisit({
    tenantId: input.tenantId,
    jobId: input.jobId,
    technicianId: input.technicianId,
    // Untimed and already done: nobody scheduled it, and it is not going to
    // happen again. `completed_at` is the note's own time, in the visit's
    // convention.
    startsAt: null,
    endsAt: null,
    status: 'completed',
    completedAt: noteLocal,
    laborHours: input.laborHours ?? null,
    attributes: input.attributes ?? {},
    sourceCaptureId: input.captureId,
  });
  // createVisit returns the BARE row, and the caller's contract is a row that
  // carries its crew. Reading it back rather than assuming: an empty list here
  // would be a typed lie — the trip has the filer on it — and any later
  // participantsOf() on this value would report nobody.
  const visit: VisitWithParticipants = {
    ...created,
    visit_participants: (await listParticipants(created.id)).map((p) => ({
      technician_id: p.technician_id,
      created_at: p.created_at,
      tenant_id: p.tenant_id,
      technicians: null, // names are not this path's business; ids are
    })),
  };
  // She is the crew of a trip her own note just made.
  return { visit, created: true, offCrew: false, noteLocal };
}
