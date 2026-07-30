// undo_run (plan 2026-07-30 Phase 5): put the LATEST committed batch run
// (freeze or re-solve) back the way it was. RESTORE, never re-optimize — no
// solver call; the run-stamped ledger events plus the cancelled predecessor
// rows ARE the memory (every move cancels + remints, so each prior state
// still exists as a row).
//
// Two halves, the house shared-core pattern:
//   planUndo    — read-only: collapse the run's ledger trail into restore
//                 steps, skipping anything that changed since the run (drift),
//                 anything pinned since (the manager's hands-off), and any
//                 restore whose pre-run technician is gone.
//   commitUndoRun — replay through the NORMAL verbs: (1) every unschedule
//                 first (the run's placements landed in freed gaps — they must
//                 vacate before inverse moves return), (2) inverse moves via
//                 the shared Phase-2 batch executor (ordering + park + the
//                 promise belt), (3) time-TBD rebooks last (they claim no
//                 slot). Stop-on-failure, freeze parity.
//
// Chain collapse is the crux: a swap the run parked writes TWO `moved` events
// for one visit (old→parked, parked→attached). Naive per-event replay would
// try to restore the parked intermediate (a person-less row that no longer
// exists) and misread the same-run cancellations as drift. Chains are keyed
// on same-run `previousAssignmentId` links: the FINAL created row is the live
// target; the EARLIEST predecessor is the true pre-run state.
//
// Ignored on purpose: the run's `move_failed` strandings (cancel succeeded,
// re-book failed) — no live row exists to restore, and the stranding was
// already reported loudly at commit time.

import {
  appendScheduleEvent,
  getAssignmentForTenant,
  getCustomer,
  getJob,
  getTechnicianById,
  isInactiveState,
  isPlaced,
  listEventsByRunStamp,
  type Assignment,
  type CommittedRun,
  type Json,
  type PromiseLevel,
  type ScheduleEvent,
  type Technician,
} from '../db/index.js';
import { bookVisit, unscheduleVisit, visitDay } from './booking.js';
import {
  executeOrderedMoves,
  type BatchMove,
  type BatchMoveResult,
  type ExecutedMove,
} from './resolveCommit.js';
import { skipLabel, type FreezeSkip } from './freezeSolve.js';

export interface UndoUnschedule {
  assignmentId: string; // the live row the run booked from a queue
  label: string;
  day: string; // for the stage preview line
}

export interface UndoTbdRestore {
  assignmentId: string; // the live PLACED row (the run placed a time-TBD visit)
  jobId: string;
  label: string;
  fromLabel: string; // its current slot, for the stage preview line
  earliestDate: string;
  latestDate: string;
  promiseLevel: PromiseLevel;
  technicianRef: string | null;
}

export interface UndoPlan {
  run: CommittedRun;
  unschedules: UndoUnschedule[]; // queue placements → back to the loose bucket
  moves: BatchMove[]; // inverse moves (toTechnicianRef null = pre-run park)
  tbdRestores: UndoTbdRestore[]; // placed → back to time-TBD
  skipped: FreezeSkip[]; // drift / pinned / gone-technician — left alone
}

const hhmm = (iso: string): string => iso.slice(11, 16);

export async function planUndo(tenantId: string, run: CommittedRun): Promise<UndoPlan> {
  const key = run.kind === 'freeze' ? ('freezeRun' as const) : ('resolveRun' as const);
  const events = await listEventsByRunStamp(tenantId, key, run.stamp);
  const movedEvents = events.filter((e) => e.kind === 'moved' && e.assignment_id);
  const bookedEvents = events.filter((e) => e.kind === 'booked' && e.assignment_id);

  const prevOf = (ev: ScheduleEvent): string | null => {
    const d = (ev.detail ?? {}) as Record<string, unknown>;
    return typeof d.previousAssignmentId === 'string' ? d.previousAssignmentId : null;
  };

  // Per-call memo: identity/technician reads repeat across chains.
  const techByIdCache = new Map<string, Technician | null>();
  const techById = async (id: string): Promise<Technician | null> => {
    const hit = techByIdCache.get(id);
    if (hit !== undefined) return hit;
    const tech = await getTechnicianById(id, tenantId);
    techByIdCache.set(id, tech);
    return tech;
  };
  const identityFor = async (
    row: Assignment,
  ): Promise<{ customer: string | null; jobTitle: string | null }> => {
    const job = await getJob(row.job_id);
    const customer = job ? await getCustomer(job.customer_id) : null;
    return { customer: customer?.name ?? null, jobTitle: job?.title ?? null };
  };

  const unschedules: UndoUnschedule[] = [];
  const moves: BatchMove[] = [];
  const tbdRestores: UndoTbdRestore[] = [];
  const skipped: FreezeSkip[] = [];

  // The shared drift/pin gate on a chain's LIVE row. Returns the row when the
  // restore may proceed; pushes the skip and returns null otherwise.
  const liveOrSkip = async (liveId: string): Promise<Assignment | null> => {
    const live = await getAssignmentForTenant(liveId, tenantId);
    if (!live) {
      skipped.push({ ref: liveId, label: liveId, reason: 'row not found — left alone' });
      return null;
    }
    const { customer, jobTitle } = await identityFor(live);
    const label = skipLabel(customer, jobTitle);
    if (live.status !== 'confirmed' && live.status !== 'proposed') {
      // A hand-move since the run reminted the row (this id is now cancelled);
      // a hand-cancel is terminal too. Either way: the manager touched it —
      // never force-revert their change.
      skipped.push({
        ref: liveId,
        label,
        reason: `changed since the run (now ${live.status}) — left alone`,
      });
      return null;
    }
    if (live.locked) {
      // The pin OFFER makes pinned-after-run rows a NORMAL state, and a pin
      // means hands-off — the undo honors it like every scheduler does.
      skipped.push({
        ref: liveId,
        label,
        reason: 'pinned since the run — left as-is; unpin it to restore',
      });
      return null;
    }
    return live;
  };

  // ---- moved chains → inverse moves / tbd restores
  const createdIds = new Set(movedEvents.map((e) => e.assignment_id as string));
  const byPrev = new Map<string, ScheduleEvent>();
  for (const ev of movedEvents) {
    const prev = prevOf(ev);
    if (prev) byPrev.set(prev, ev);
  }
  const heads = movedEvents.filter((ev) => {
    const prev = prevOf(ev);
    return prev !== null && !createdIds.has(prev);
  });
  for (const head of heads) {
    let tail = head;
    while (byPrev.has(tail.assignment_id as string)) {
      tail = byPrev.get(tail.assignment_id as string) as ScheduleEvent;
    }
    const liveId = tail.assignment_id as string;
    const predecessorId = prevOf(head) as string;
    const live = await liveOrSkip(liveId);
    if (!live) continue;
    const { customer, jobTitle } = await identityFor(live);
    const label = skipLabel(customer, jobTitle);
    const prior = await getAssignmentForTenant(predecessorId, tenantId);
    if (!prior) {
      skipped.push({ ref: liveId, label, reason: 'its pre-run state cannot be read — left alone' });
      continue;
    }
    if (!isPlaced(live)) {
      // A run-minted row is always placed; a live UNPLACED row means someone
      // reshaped it since — the drift rule, one more way.
      skipped.push({ ref: liveId, label, reason: 'changed since the run — left alone' });
      continue;
    }
    // Resolve the pre-run technician BEFORE staging the step: a deactivated
    // (or vanished) predecessor tech must skip-and-report here, never let the
    // commit-time resolveTechnician throw stop the whole undo.
    let toRef: string | null = null;
    if (prior.technician_id) {
      const tech = await techById(prior.technician_id);
      if (!tech || isInactiveState(tech.state)) {
        skipped.push({
          ref: liveId,
          label,
          reason:
            'its pre-run technician is no longer active — left where the run put it ' +
            '(reassign it by hand)',
        });
        continue;
      }
      toRef = tech.ref;
    }
    if (isPlaced(prior)) {
      const fromTech = live.technician_id ? await techById(live.technician_id) : null;
      moves.push({
        assignmentId: liveId,
        jobId: live.job_id,
        customer,
        jobTitle,
        // '' when the live row is person-less (a stranded park): matches no
        // target ref, so it grows no ordering edges — correct, its slot is
        // guard-exempt anyway.
        fromTechnicianRef: fromTech?.ref ?? '',
        fromDate: visitDay(live),
        fromStart: hhmm(live.starts_at as string),
        fromEnd: hhmm(live.ends_at as string),
        toTechnicianRef: toRef, // null = restore the pre-run person-less park
        toDate: prior.starts_at?.slice(0, 10) as string,
        toStartTime: hhmm(prior.starts_at as string),
        toEndTime: hhmm(prior.ends_at as string),
      });
    } else {
      // Pre-run state was UNPLACED (time-TBD): no verb converts placed →
      // unplaced in one step, so the commit unschedules the live row and
      // re-books the job time-TBD with the predecessor's fence + promise
      // (the twin guard can't fire — the original row is cancelled).
      tbdRestores.push({
        assignmentId: liveId,
        jobId: live.job_id,
        label,
        fromLabel: `${visitDay(live)} ${hhmm(live.starts_at as string)}–${hhmm(live.ends_at as string)}`,
        earliestDate: prior.earliest_date as string,
        latestDate: prior.latest_date as string,
        promiseLevel: prior.promise_level,
        technicianRef: toRef,
      });
    }
  }

  // ---- booked rows (queue placements) → back to the loose bucket
  for (const ev of bookedEvents) {
    const live = await liveOrSkip(ev.assignment_id as string);
    if (!live) continue;
    const { customer, jobTitle } = await identityFor(live);
    unschedules.push({
      assignmentId: live.id,
      label: skipLabel(customer, jobTitle),
      day: visitDay(live),
    });
  }

  return { run, unschedules, moves, tbdRestores, skipped };
}

export interface UndoCommitResult {
  unscheduled: { assignmentId: string; label: string }[]; // back in the bucket
  movedBack: ExecutedMove[]; // minted post-restore ids
  rebooked: { assignmentId: string; label: string }[]; // fresh time-TBD rows
  // Time-TBD restores this undo VACATED in step (1) but never re-booked (a
  // later failure stopped the run before or inside step (3)): each placed row
  // IS cancelled and its job sits in the loose bucket, fence/promise gone
  // from live data. Surfaced by row so the caller's report can name them —
  // "the failed row and everything after it are unchanged" is FALSE for
  // these, and hiding them inside `failed` would repeat the strandedParks
  // mistake (review finding).
  strandedUnplaced: { assignmentId: string; jobId: string; label: string }[];
  skippedAtCommit: FreezeSkip[]; // the executor's promise-belt refusals
  strandedParks: BatchMoveResult['strandedParks'];
  failed: { ref: string; label: string; error: string } | null;
}

export async function commitUndoRun(
  tenantId: string,
  plan: UndoPlan,
  actorRef: string,
  undoStamp: string, // ISO — this undo's identity in every ledger row
): Promise<UndoCommitResult> {
  const reason = `undo ${plan.run.kind} ${plan.run.stamp.slice(0, 10)}`;
  const eventDetailExtra: Json = { undoRun: undoStamp };
  const unscheduled: UndoCommitResult['unscheduled'] = [];
  const rebooked: UndoCommitResult['rebooked'] = [];
  let movedBack: ExecutedMove[] = [];
  let skippedAtCommit: FreezeSkip[] = [];
  let strandedParks: BatchMoveResult['strandedParks'] = [];
  let failed: UndoCommitResult['failed'] = null;

  // (1) EVERY unschedule first: the run's queue placements landed in freed
  // gaps, and a tbd-restore's live row occupies a slot too — both must vacate
  // before the inverse moves return, or those moves hit the overlap guard.
  const vacatedTbd = new Set<string>();
  const rebookedFor = new Set<string>();
  const vacates = [
    ...plan.unschedules.map((u) => ({ ...u, rebook: false })),
    ...plan.tbdRestores.map((t) => ({ assignmentId: t.assignmentId, label: t.label, rebook: true })),
  ];
  for (const v of vacates) {
    try {
      await unscheduleVisit({
        tenantId,
        assignmentId: v.assignmentId,
        reason,
        eventDetailExtra,
        actorRef,
      });
      if (v.rebook) vacatedTbd.add(v.assignmentId);
      else unscheduled.push({ assignmentId: v.assignmentId, label: v.label });
    } catch (err) {
      failed = {
        ref: v.assignmentId,
        label: v.label,
        error: err instanceof Error ? err.message : String(err),
      };
      break;
    }
  }

  // (2) inverse moves through the shared batch executor — same ordering, same
  // park-and-reattach, same promise belt as the forward run (a promise
  // recorded on a run-minted row after the run must skip+report, never
  // silently move back).
  if (!failed) {
    const batch = await executeOrderedMoves(tenantId, plan.moves, actorRef, reason, eventDetailExtra);
    movedBack = batch.moved;
    skippedAtCommit = batch.skippedAtCommit;
    strandedParks = batch.strandedParks;
    failed = batch.failed;
  }

  // (3) tbd rebooks last — an unplaced booking claims no slot, so nothing
  // downstream depends on it.
  if (!failed) {
    for (const t of plan.tbdRestores) {
      try {
        const booked = await bookVisit({
          tenantId,
          jobId: t.jobId,
          timeTbd: true,
          earliestDate: t.earliestDate,
          latestDate: t.latestDate,
          promiseLevel: t.promiseLevel,
          ...(t.technicianRef ? { technicianRef: t.technicianRef } : {}),
          reason,
          eventDetailExtra,
          actorRef,
        });
        rebooked.push({ assignmentId: booked.assignment.id, label: t.label });
        rebookedFor.add(t.assignmentId);
      } catch (err) {
        // Step (1) already unscheduled this visit — the honest state is "its
        // job is back in the loose bucket", and the error must say so.
        failed = {
          ref: t.assignmentId,
          label: t.label,
          error:
            `${err instanceof Error ? err.message : String(err)} — the visit was already ` +
            'unscheduled by this undo, so its job now sits in the loose bucket; rebook it by hand',
        };
        break;
      }
    }
  }

  // Every tbd row vacated in step (1) that step (3) never re-booked, whatever
  // stopped the run — see the UndoCommitResult comment.
  const strandedUnplaced = plan.tbdRestores
    .filter((t) => vacatedTbd.has(t.assignmentId) && !rebookedFor.has(t.assignmentId))
    .map((t) => ({ assignmentId: t.assignmentId, jobId: t.jobId, label: t.label }));

  // The run summary — best-effort, freeze idiom: restores ARE committed by
  // now; a transient fault here must not mask the result.
  const restored = unscheduled.length + movedBack.length + rebooked.length;
  try {
    await appendScheduleEvent({
      tenantId,
      kind: 'undo_committed',
      actorRef,
      detail: {
        undoRun: undoStamp,
        undid: plan.run.stamp,
        undidKind: plan.run.kind,
        restored,
        skipped: plan.skipped.length + skippedAtCommit.length,
        ...(strandedParks.length > 0 ? { stranded: strandedParks.length } : {}),
        ...(strandedUnplaced.length > 0 ? { strandedTbd: strandedUnplaced.length } : {}),
        ...(failed ? { stoppedAt: failed.ref, error: failed.error } : {}),
      },
    });
  } catch (err) {
    console.error('undo_committed ledger append failed (restore result stands):', err);
  }

  return {
    unscheduled,
    movedBack,
    rebooked,
    strandedUnplaced,
    skippedAtCommit,
    strandedParks,
    failed,
  };
}
