// The freeze COMMIT (plan 4b-3 Phase 4): walk a confirmed FreezePlan through
// the EXISTING booking verbs, sequentially — every guard (tenant, overlap,
// duplicate twins, state machine) fires per row exactly as it would for a
// hand booking. Shared-core house pattern: run_freeze's MCP handler calls
// this; the loop stays testable outside the tool surface.
//
// Failure model (plan decision): a row failure STOPS the run and the summary
// says exactly what landed — the token is already consumed, and the remedy is
// re-running the freeze (idempotent: placed rows leave the queues).
//
// The promise belt (plan review finding 9): placing never breaks a promise BY
// CONSTRUCTION (day-fenced visits land inside their fence), so a
// promiseBroken preview here means a window-construction bug — such a row is
// SKIPPED and reported, never committed. The manager's plan-level yes must
// not be converted into an unreviewed promise break.

import { appendScheduleEvent, type Json } from '../db/index.js';
import {
  bookVisit,
  moveVisit,
  previewMoveVisit,
  type MoveVisitInput,
} from './booking.js';
import type { FreezePlacement, FreezePlan, FreezeSkip } from './freezeSolve.js';

export interface FreezeCommittedRow {
  placement: FreezePlacement;
  assignmentId: string; // the resulting PLACED row's id (moves remint)
}

export interface FreezeCommitResult {
  committed: FreezeCommittedRow[];
  skippedAtCommit: FreezeSkip[]; // the promise belt's refusals
  // Non-null = the run STOPPED here: everything in `committed` IS booked,
  // this placement and everything after it are untouched.
  failed: { placement: FreezePlacement; error: string } | null;
}

export async function commitFreezePlan(
  tenantId: string,
  plan: FreezePlan,
  actorRef: string,
  runStamp: string, // ISO — the freeze run's identity in every ledger row
): Promise<FreezeCommitResult> {
  const reason = `freeze ${runStamp.slice(0, 10)}`;
  const eventDetailExtra: Json = { freezeRun: runStamp };
  const committed: FreezeCommittedRow[] = [];
  const skippedAtCommit: FreezeSkip[] = [];
  let failed: FreezeCommitResult['failed'] = null;

  for (const p of plan.placements) {
    try {
      if (p.kind === 'unscheduled_job') {
        const booked = await bookVisit({
          tenantId,
          jobId: p.jobId,
          technicianRef: p.technicianRef,
          date: p.date,
          startTime: p.startTime,
          endTime: p.endTime,
          reason,
          eventDetailExtra,
          actorRef,
        });
        committed.push({ placement: p, assignmentId: booked.assignment.id });
        continue;
      }
      // unassigned_visit: SAME stored times, the solver only chose WHO.
      // unplaced_visit: the solver's date + times; technicianRef attaches the
      // solver's person (for already-attached rows it names the same person —
      // a no-op reassignment).
      const moveInput: MoveVisitInput = {
        tenantId,
        assignmentId: p.assignmentId as string,
        date: p.date,
        startTime: p.startTime,
        endTime: p.endTime,
        technicianRef: p.technicianRef,
        reason,
        eventDetailExtra,
        actorRef,
      };
      const preview = await previewMoveVisit(moveInput);
      if (preview.promiseBroken) {
        skippedAtCommit.push({
          ref: p.assignmentId as string,
          label: [p.customer, p.jobTitle].filter(Boolean).join(' — ') || 'unnamed',
          reason:
            'placing it here would break what the customer was told — left untouched ' +
            '(move it by hand if the promise really changed)',
        });
        continue;
      }
      const moved = await moveVisit(moveInput);
      committed.push({ placement: p, assignmentId: moved.created.id });
    } catch (err) {
      failed = { placement: p, error: err instanceof Error ? err.message : String(err) };
      break;
    }
  }

  // The run summary joins the ledger either way — an honest record of what
  // this freeze actually did (drives the manager-directed push, boardNotify).
  // BEST-EFFORT (the booking.ts event-append doctrine): by this point rows
  // ARE booked and the token is consumed — a transient fault here must not
  // mask the result the manager needs to hear (phase-review finding 2); the
  // cost is one lost summary push.
  try {
    await appendScheduleEvent({
      tenantId,
      kind: 'freeze_committed',
      actorRef,
      detail: {
        freezeRun: runStamp,
        horizonFrom: plan.horizonFrom,
        horizonTo: plan.horizonTo,
        placed: committed.length,
        skipped: plan.skipped.length + skippedAtCommit.length,
        ...(failed
          ? { stoppedAt: failed.placement.assignmentId ?? `job:${failed.placement.jobId}`, error: failed.error }
          : {}),
      },
    });
  } catch (err) {
    console.error('freeze_committed ledger append failed (commit result stands):', err);
  }

  return { committed, skippedAtCommit, failed };
}
