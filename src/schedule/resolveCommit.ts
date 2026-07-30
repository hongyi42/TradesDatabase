// The re-solve COMMIT (plan 2026-07-30 Phase 2): moves first — dependency-
// ordered so vacate-before-arrive always holds under the no_confirmed_overlap
// guard — then queue placements through the freeze walker. Shared-core house
// pattern: run_resolve's MCP handler calls this; everything here stays
// testable outside the tool surface.
//
// Ordering model: the verbs commit one row at a time, and the DB guard sees
// every OTHER confirmed row — so a move into a slot a sibling hasn't vacated
// yet throws. Chains order topologically; a strict swap (A↔B) has NO valid
// sequential order through plain moves, so one cycle member is PARKED
// person-less at its current times (exempt from the guard), the rest commit
// in order, and the parked row re-attaches LAST — against its REMINTED id
// (moveVisit cancels + re-creates; the pre-park id is a cancelled row).
//
// Failure model (freeze parity): a row failure STOPS the run; everything
// already committed stands; the honest report names the stopping row. A
// mid-run failure can strand one visit (cancel-first move mechanics) —
// recorded, accepted posture.

import { appendScheduleEvent, type Json } from '../db/index.js';
import { moveVisit, previewMoveVisit, type MoveVisitInput } from './booking.js';
import { commitFreezePlan, type FreezeCommittedRow } from './freezeCommit.js';
import { skipLabel, type FreezeSkip, type ResolveMove, type ResolvePlan } from './freezeSolve.js';

// The executor's row shape: a solver move, except the TARGET may be nobody
// (undo_run restores a pre-run person-less park with toTechnicianRef null —
// plan 2026-07-30 Phase 5). ResolveMove is assignable, so the resolve path
// changes not at all. A null-target move claims no technician slot (the DB
// guard ignores NULL rows), so it never grows edges and never lands on a
// cycle — orderMoves needs no null handling beyond the === below.
export type BatchMove = Omit<ResolveMove, 'toTechnicianRef'> & {
  toTechnicianRef: string | null;
};

export interface OrderedMoves {
  ordered: BatchMove[]; // dependency order; disjoint moves keep input order
  parked: BatchMove[]; // cycle members — park first, re-attach after `ordered`
}

// HH:MM strings compare lexicographically (fixed width) — interval overlap
// needs no date math.
const targetHitsCurrent = (m: BatchMove, n: BatchMove): boolean =>
  m.toTechnicianRef !== null &&
  m.toTechnicianRef === n.fromTechnicianRef &&
  m.toDate === n.fromDate &&
  m.toStartTime < n.fromEnd &&
  n.fromStart < m.toEndTime;

// Edge N→M when M ≠ N and M's TARGET overlaps N's CURRENT slot on the same
// technician: N must vacate first. NEVER a self-edge — a same-tech shift
// (09:00→09:30, the commonest re-solve move) needs no ordering because the
// verb's own pre-check already excludes the moved row (booking.ts excludeId);
// treating M==N as a cycle would pointlessly park it. Target-vs-target
// conflicts cannot exist (the solver never double-books) — no handling.
export function orderMoves(moves: BatchMove[]): OrderedMoves {
  const waitsOn = new Map<BatchMove, Set<BatchMove>>(moves.map((m) => [m, new Set()]));
  for (const m of moves) {
    for (const n of moves) {
      if (m !== n && targetHitsCurrent(m, n)) waitsOn.get(m)?.add(n);
    }
  }
  const ordered: BatchMove[] = [];
  const parked: BatchMove[] = [];
  let remaining = [...moves];
  while (remaining.length > 0) {
    const ready = remaining.filter((m) => (waitsOn.get(m)?.size ?? 0) === 0);
    if (ready.length > 0) {
      for (const m of ready) {
        ordered.push(m);
        for (const r of remaining) waitsOn.get(r)?.delete(m);
      }
      remaining = remaining.filter((m) => !ready.includes(m));
      continue;
    }
    // Genuine cycle: park the CYCLE MEMBER with the lowest assignmentId
    // (deterministic). Candidates are restricted to nodes actually ON a cycle
    // — the stuck set also contains nodes merely DOWNSTREAM of one, and
    // parking those would cost needless remints, ledger events, and a
    // spurious moved-off/landed push pair (review finding). Parking vacates
    // the member's CURRENT slot before any ordered move runs, so every edge
    // through it dissolves.
    const onCycle = (start: BatchMove): boolean => {
      const seen = new Set<BatchMove>();
      const stack = [...(waitsOn.get(start) ?? [])].filter((n) => remaining.includes(n));
      while (stack.length > 0) {
        const n = stack.pop() as BatchMove;
        if (n === start) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        stack.push(...[...(waitsOn.get(n) ?? [])].filter((x) => remaining.includes(x)));
      }
      return false;
    };
    const candidates = remaining.filter(onCycle);
    // A stuck finite graph must contain a cycle; the fallback is pure defense
    // against an impossible state (never park nothing and spin forever).
    const pool = candidates.length > 0 ? candidates : remaining;
    const cycleNode = pool.sort((a, b) => a.assignmentId.localeCompare(b.assignmentId))[0];
    parked.push(cycleNode);
    remaining = remaining.filter((m) => m !== cycleNode);
    for (const r of remaining) waitsOn.get(r)?.delete(cycleNode);
  }
  return { ordered, parked };
}

export interface ExecutedMove {
  move: BatchMove;
  assignmentId: string; // the resulting row's id (moves remint)
  warning?: string; // the verb's advisory — relayed, never swallowed
}

export interface BatchMoveResult {
  moved: ExecutedMove[];
  skippedAtCommit: FreezeSkip[]; // the promise belt's refusals
  // Parked rows that never got their re-attach (a later failure stopped the
  // run, or the belt refused the attach): each sits CONFIRMED but PERSON-LESS
  // at its original times. Surfaced by id so the caller's report can name
  // them — a strand must never hide inside a routine skip list (review
  // finding). assignmentId = the LIVE (post-park) row.
  strandedParks: { move: BatchMove; assignmentId: string }[];
  // Non-null = the run STOPPED here: everything in `moved` IS moved, this row
  // and everything after it are untouched (except a stranding — see header).
  failed: { ref: string; label: string; error: string } | null;
}

// The batch-move executor — shared with undo_run (Phase 5), which replays the
// same mechanics in reverse. Every row goes preview-first: the promise belt
// (freeze precedent) means a promiseBroken preview SKIPS the row — a
// plan-level yes must never convert into an unreviewed promise break; by
// window construction it should never fire, so a hit means a solver-window
// bug. NOTE: skipping a mid-chain row can make a dependent later move fail
// its pre-check — the run then stops there, honestly.
export async function executeOrderedMoves(
  tenantId: string,
  moves: BatchMove[],
  actorRef: string,
  reason: string,
  eventDetailExtra: Json,
): Promise<BatchMoveResult> {
  const { ordered, parked } = orderMoves(moves);
  const moved: ExecutedMove[] = [];
  const skippedAtCommit: FreezeSkip[] = [];
  const parkedIds = new Map<BatchMove, string>();
  const reattached = new Set<BatchMove>();

  const fail = (m: BatchMove, err: unknown): BatchMoveResult['failed'] => ({
    ref: m.assignmentId,
    label: skipLabel(m.customer, m.jobTitle),
    error: err instanceof Error ? err.message : String(err),
  });
  // Every parked row that never re-attached, whatever stopped it — each is
  // live, confirmed, and PERSON-LESS at its original times.
  const strands = (): BatchMoveResult['strandedParks'] =>
    parked
      .filter((m) => parkedIds.has(m) && !reattached.has(m))
      .map((m) => ({ move: m, assignmentId: parkedIds.get(m) as string }));

  // Parks first: person-less at the CURRENT times (guard-exempt), so every
  // cycle edge dissolves before the ordered moves run.
  for (const m of parked) {
    try {
      const park = await moveVisit({
        tenantId,
        assignmentId: m.assignmentId,
        date: m.fromDate,
        startTime: m.fromStart,
        endTime: m.fromEnd,
        unassign: true,
        reason,
        eventDetailExtra,
        actorRef,
      });
      parkedIds.set(m, park.created.id);
    } catch (err) {
      return { moved, skippedAtCommit, strandedParks: strands(), failed: fail(m, err) };
    }
  }

  // Ordered moves, then the parked rows' re-attaches (their targets are free
  // once everything else has landed) — against the REMINTED post-park ids.
  const sequence: { move: BatchMove; rowId: string; isParked: boolean }[] = [
    ...ordered.map((move) => ({ move, rowId: move.assignmentId, isParked: false })),
    ...parked.map((move) => ({ move, rowId: parkedIds.get(move) as string, isParked: true })),
  ];
  for (const { move, rowId, isParked } of sequence) {
    const input: MoveVisitInput = {
      tenantId,
      assignmentId: rowId,
      date: move.toDate,
      startTime: move.toStartTime,
      endTime: move.toEndTime,
      // A null target (undo restoring a pre-run person-less row) is a PARK,
      // not a reassignment — the verb's unassign arm, guard-exempt.
      ...(move.toTechnicianRef === null
        ? { unassign: true }
        : { technicianRef: move.toTechnicianRef }),
      reason,
      eventDetailExtra,
      actorRef,
    };
    try {
      const preview = await previewMoveVisit(input);
      if (preview.promiseBroken) {
        // A parked row refused here is NOT "left as booked" — it is sitting
        // person-less; the copy must say so (review finding).
        skippedAtCommit.push({
          ref: rowId,
          label: skipLabel(move.customer, move.jobTitle),
          reason: isParked
            ? 'its re-attach would break what the customer was told — the run parked it for ' +
              'a swap, so it is currently UNASSIGNED at its original times; reassign it by hand'
            : 'moving it there would break what the customer was told — left as booked ' +
              '(move it by hand if the promise really changed)',
        });
        continue;
      }
      const result = await moveVisit(input);
      if (isParked) reattached.add(move);
      moved.push({
        move,
        assignmentId: result.created.id,
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } catch (err) {
      return { moved, skippedAtCommit, strandedParks: strands(), failed: fail(move, err) };
    }
  }
  return { moved, skippedAtCommit, strandedParks: strands(), failed: null };
}

export interface ResolveCommitResult {
  movedRows: ExecutedMove[];
  committed: FreezeCommittedRow[]; // queue placements (freeze walker)
  skippedAtCommit: FreezeSkip[];
  strandedParks: { move: BatchMove; assignmentId: string }[]; // see BatchMoveResult
  failed: { ref: string; label: string; error: string } | null;
}

export async function commitResolvePlan(
  tenantId: string,
  plan: ResolvePlan,
  actorRef: string,
  runStamp: string, // ISO — the run's identity in every ledger row
): Promise<ResolveCommitResult> {
  const reason = `re-solve ${runStamp.slice(0, 10)}`;
  const eventDetailExtra: Json = { resolveRun: runStamp };

  // Moves FIRST: placements land in gaps the moves free up.
  const batch = await executeOrderedMoves(tenantId, plan.moves, actorRef, reason, eventDetailExtra);
  let committed: FreezeCommittedRow[] = [];
  let skippedAtCommit = [...batch.skippedAtCommit];
  let failed = batch.failed;

  if (!failed) {
    const placed = await commitFreezePlan(tenantId, plan, actorRef, runStamp, {
      eventDetailExtra,
      reasonPrefix: 're-solve',
      // The resolve_committed summary below replaces it — see FreezeCommitOpts.
      skipSummaryEvent: true,
    });
    committed = placed.committed;
    skippedAtCommit = [...skippedAtCommit, ...placed.skippedAtCommit];
    if (placed.failed) {
      failed = {
        ref: placed.failed.placement.assignmentId ?? `job:${placed.failed.placement.jobId}`,
        label: skipLabel(placed.failed.placement.customer, placed.failed.placement.jobTitle),
        error: placed.failed.error,
      };
    }
  }

  // The run summary — best-effort, freeze idiom: rows ARE moved/booked by
  // now; a transient fault here must not mask the result.
  try {
    await appendScheduleEvent({
      tenantId,
      kind: 'resolve_committed',
      actorRef,
      detail: {
        resolveRun: runStamp,
        horizonFrom: plan.horizonFrom,
        horizonTo: plan.horizonTo,
        moved: batch.moved.length,
        placed: committed.length,
        kept: plan.keptCount,
        skipped: plan.skipped.length + skippedAtCommit.length,
        ...(batch.strandedParks.length > 0 ? { stranded: batch.strandedParks.length } : {}),
        ...(failed ? { stoppedAt: failed.ref, error: failed.error } : {}),
      },
    });
  } catch (err) {
    console.error('resolve_committed ledger append failed (commit result stands):', err);
  }

  return {
    movedRows: batch.moved,
    committed,
    skippedAtCommit,
    strandedParks: batch.strandedParks,
    failed,
  };
}
