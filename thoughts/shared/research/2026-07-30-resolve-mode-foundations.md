---
date: 2026-07-30
branch: main
commit: 2dc9f9d
topic: Re-solve mode foundations — everything the horizon-wide re-optimizer (movable placed visits, promise-graded freedom) would extend, as shipped by 4b-3
---

## Summary

"Re-solve mode" is the future feature where the route optimizer may **move already-placed
visits** — everything unpinned becomes fair game, and the promise ladder grades each visit's
freedom ('time'/'time_only' fixed in time, 'day' slides within its told day, 'none' free). It
was explicitly scoped OUT of the shipped freeze (the 4b-3 "drain scope" decision: "the freeze
never re-places anything already placed; re-solve mode is a later plan") and subsumes the
deferred 3c `reflow_day` sketch. This document maps what exists: the freeze pipeline
(assemble → solve → stage → confirm → commit) that a re-solve would extend at every stage, the
movability semantics already in the data (pins, promises), and — the structural crux — how the
double-booking guard and the move verb's cancel-then-reinsert mechanics behave when a *batch*
of interdependent moves commits one row at a time.

## Entry Points

- `src/mcp/server.ts:4642` — `run_freeze` (STAGE `:4655`: horizon today→+13, cap +31 `:4672`;
  version pinned BEFORE solve `:4683`; kind-wide supersede `:4696`; stage-race close `:4717`.
  CONFIRM `:4748`: staleness kernel `:4765`, consume-first `:4788`, commit `:4798`).
- `src/schedule/freezeSolve.ts:160` — `assembleFreezeInputs`; `:522` `buildFreezeModel`;
  `:646` `solveFreeze`.
- `src/schedule/freezeCommit.ts:44` — `commitFreezePlan` (sequential, failure-stops-run).
- `src/schedule/booking.ts:616` — `resolveMove`; `:763` `moveVisit`; `:1125` `setVisitLocks`.
- `src/routes/roiClient.ts:61` — `optimizeTours` (SA-key OAuth, projectId from the key).
- `src/schedule/freezeProposal.ts:80/:96` — `assessStagedFreeze` / `projectFreezeProposal`.
- `src/telegram/boardApi.ts:313` + `web/board/board.js:552/:579` — the proposal pill/sheet.

## Key Files

- **`src/schedule/freezeSolve.ts`** — model mapping (header `:5-38`): vehicle = one
  (pattern-having tech, working day), pattern gaps as mandatory breaks, NO depot; queue rows =
  skippable shipments (`QUEUE_PENALTY = 1_000`, `:514`); **already-placed visits = "context"
  shipments** (`:598-618`): arrival pinned to the stored start (`startTime = endTime`), locked
  to that one tech-day vehicle, `CONTEXT_PENALTY = 1_000_000` (never mandatory — an
  out-of-pattern booking degrades to a capacity warning, never an infeasible solve), and
  **never committed** (`:705` — labels `ctx|` are filtered out of placements). Vendor facts
  header: TimeWindow bounds ARRIVAL; windows must be non-adjacent → ONE contiguous window per
  fence; omitted penaltyCost = mandatory; label-keyed parsing (proto3 omits zero indexes).
  Pins: assembly skips `locked` queue rows with `PINNED_SKIP_REASON` (`:152`, `:322`, `:416`);
  context rows are not pin-checked (they are untouchable regardless). Pattern-less techs are
  invisible (no vehicle, context omitted, `:174-186`). Day-0 windows trim to firm-local now
  (`:207-211`). Capacity = committed (context spans) vs available (pattern − time off).
- **`src/routes/roiClient.ts`** — POSTs the body verbatim to
  `projects/{projectId}:optimizeTours`; auth = service-account JSON in
  `GOOGLE_ROUTES_SA_KEY_JSON`; errors propagate (an outage is a failed solve, never an empty
  plan).
- **`src/schedule/freezeCommit.ts`** — walks the confirmed plan **sequentially through the
  normal verbs**: `unscheduled_job` → `bookVisit`; `unassigned_visit`/`unplaced_visit` →
  `previewMoveVisit` (promise belt: a `promiseBroken` preview SKIPS the row, `:92-101`) then
  `moveVisit`. Every event stamped `eventDetailExtra: { freezeRun }` (`:51`). A row failure
  STOPS the run (`:109-112`); everything before it stays booked. Summary event
  `freeze_committed` appended best-effort.
- **`src/schedule/booking.ts`** — movability semantics live here:
  - `carriesPromisedDay`/`carriesPromisedTime` (`:79/:87`); `promiseBroken` = day-carrying ∧
    day changed, or time-carrying ∧ start-time changed (`:673-680`). `previewMoveVisit`
    returns `requiresConfirmation: promiseBroken` (`:751`) — the move doctrine.
  - Overlap PRE-check (`:688-694`): `overlappingConfirmed(targetTechId, newISO, excludeId =
    old.id)` — excludes **only the row being moved**, so any OTHER confirmed row (including a
    sibling batch member not yet moved) counts as a clash and the move throws before writing.
  - `moveVisit` (`:763`): `rescheduleAssignment` **cancels FIRST, then inserts**
    (`assignments.ts:191-192`); a raced overlap or transient insert failure leaves the visit
    **stranded UNSCHEDULED** with a `move_failed` ledger event and an honest error
    (`:785-811`). The new row carries `locked` and `promise_level`; `promised_day` re-derives
    to the new date for day-carrying levels (`:783`).
  - `setVisitLocks` (`:1125`): pins are a human privilege; batch by ids or date-range
    (+optional tech); ONE guarded bulk UPDATE (`assignments.ts:216`), status-predicated.
- **`supabase/migrations/20260704210155_scheduling_foundation.sql:70` +
  `20260724130000_unplaced_visits.sql:27-31`** — the double-booking guard is a **DB-level GiST
  exclusion constraint**: `(technician_id with =, tstzrange(starts_at, ends_at) with &&) where
  (status = 'confirmed' and starts_at is not null)`. Proposed rows may overlap; NULL-technician
  and NULL-times rows are exempt.
- **`src/schedule/freezeProposal.ts`** — `FREEZE_PROPOSAL_TTL_MS = 12h` (`:25`);
  `assessStagedFreeze` (`:80`) = the ONE staleness kernel (malformed/expired/stale/open) shared
  by confirm + board; its `validDetail` requires `plan.placements/skipped/capacity` ARRAYS — a
  detail without those is **malformed and gets dismissed**. `projectFreezeProposal` (`:96`)
  renders **placements only** — no move/diff vocabulary exists in the view.
- **`src/telegram/boardApi.ts:313` / `web/board/board.js:552-668`** — manager-only endpoint,
  ONE pill renderer, read-only sheet (placements grouped by date, skips verbatim, capacity,
  pin line, "reply yes in chat" footer), deep link `?startapp=freeze`.
- **`src/db/reviewItems.ts`** — `pending_freeze` kind (`:27`); partial unique index is per
  (tenant, kind, **subject**), so ONE-plan-per-tenant is enforced procedurally by the
  stage-time kind-wide supersede (`:237-242` comment; `server.ts:4696`).
- **`src/telegram/boardNotify.ts`** — the staff-push consumer: per-tick digest (>3 msgs per
  recipient collapse), freeze-stamped bursts get the header "The schedule freeze updated your
  schedule:" keyed on every event sharing one `detail.freezeRun`; a same-person move renders
  ONE "moved" message, a reassignment renders landed+removed.
- **`thoughts/shared/research/2026-07-20-flexible-scheduling-agent-toolset.md:157-165`** — the
  deferred `reflow_day` sketch (Tier 2): `reflow_day(technicianRef, date, fromTime?)` →
  proposed move-set as a **preview with a token pinned to scheduleVersion**, executed on
  confirm "via repeated `moveVisit` (each guard still fires)"; triage order sketched as
  "promises kept today, maintenance bumped first"; open question `:199` — whether a 2–5-tech
  pilot needs it at all ("cost/benefit is thin at 3 trucks").

## Data Flows

The shipped freeze pipeline (a re-solve would extend every box):

```
run_freeze (stage)                                     confirm
  ├ version pin (BEFORE solve)                           ├ assessStagedFreeze (12h TTL,
  ├ assembleFreezeInputs                                 │   version recheck, malformed guard)
  │   vehicles = tech×workday (patterns − time off)      ├ CONSUME token (at-most-once)
  │   queue    = 3 loose queues (pins/duration/coords    └ commitFreezePlan
  │             skipped-with-reason)                         sequential bookVisit/moveVisit
  │   context  = placed visits, arrival-pinned, 1M           promise belt skips promiseBroken
  ├ buildFreezeModel → optimizeTours (ROI, SA-key)           failure STOPS the run
  ├ kind-wide supersede → ONE pending_freeze/tenant          freezeRun stamped on every event
  └ SHORT summary + proposalLink (board pill/sheet)              ↓
                                                     schedule_events → boardNotify digest
```

**The crux — what sequential interdependent moves do today.** The commit path writes one row
at a time through `moveVisit`, and two independent mechanisms police overlap: the pre-check
(excludes only the moved row) and the DB exclusion constraint (sees all confirmed placed
rows). Consequences, purely from the code:

- *Chain* (A moves into the slot B vacates): succeeds **only if B commits first** — in any
  other order A's pre-check sees B's still-confirmed row and throws ("the booking was NOT
  moved", nothing written). Dependency-ordered chains are feasible; the current
  `commitFreezePlan` has no ordering logic (queue rows never conflict with each other's
  *old* positions because they have none that block: person-less and timeless rows are exempt
  from the guard).
- *Strict swap* (A and B exchange slots): **no sequential order through `moveVisit` alone can
  commit it** — whichever moves first collides with the other's still-confirmed row. The
  code's escape hatch is the park path: `unassign: true` detaches a visit person-less at the
  same times (exempt from the guard), after which the other row moves, then the parked one
  re-attaches — three verb calls.
- *Mid-batch failure*: `rescheduleAssignment` cancels before inserting, so a failed move
  strands that ONE visit unscheduled (`move_failed` event, honest error), and
  `commitFreezePlan` stops the run there — prior rows stay booked, later rows stay put. This
  stranding hazard exists in today's freeze too (its `unassigned_visit` moves), but a
  re-solve multiplies the number of moves exposed to it.

**Version-pin blind spots** (recorded 4b-3 limitation, `server.ts:4799-4801`):
`set_availability` / time-off changes append **no schedule event**, so the version recheck
cannot see them; the only mitigation is relaying the verbs' per-row warnings at commit. A
re-solve moving dozens of existing rows widens the exposure window and the blast radius of a
solve computed against stale availability.

**Disruption accounting today:** the solver's objective is drive time
(`costPerTraveledHour: 1`, `freezeSolve.ts:552`) plus per-shipment `penaltyCost` for
*skipping*. There is **no cost anywhere for moving a visit away from its current slot** —
context rows can't move at all, queue rows have no current slot. The model builder has no
vocabulary for "prefer the plan that changes less."

**Scale reality:** the seeded pilot holds ~121 placed visits in the 2-week horizon. Today's
solve ships them as ~121 arrival-pinned context shipments plus a small queue. A re-solve
would make those 121 rows *movable* shipments with wide windows — a categorically larger
search space in the same request shape. ROI per-request shipment/vehicle limits and pricing
at that shape: **flagged for plan-time live-doc verification** (as are soft-time-window /
per-shipment cost expressiveness questions — e.g. whether ShipmentModel can price "arrival
far from current time" per shipment).

## External Dependencies

- **Google Route Optimization API** (`optimizeTours`, SA-key OAuth via `google-auth-library`;
  self-serve enablement proven live 2026-07-27). Capability/limit questions above are
  plan-time verification items.
- **Google Geocoding API** (lazy coords fill; all 37 pilot customers now carry coords).
- No new vendor is implied by re-solve itself.

## Constraints and Invariants

- **Pins are absolute:** `locked` means "auto-scheduling must never place, move, or consider
  it" (`booking.ts:1110-1113`) — already the recorded contract for ANY future solver, and the
  only per-visit "don't touch" flag that exists.
- **Promise semantics are move-ready:** `promiseBroken` is already computed per move from the
  ladder predicates; `time_only` has `promised_day` NULL by CHECK; unplaced rows cannot carry
  time promises. The freeze belt's shape (skip promiseBroken rows at commit, never convert a
  plan-level yes into an unreviewed break) is the shipped precedent.
- **Promise-capture reality bounds the ladder's usefulness:** agents historically
  under-record promises (the `set_promise` origin story), and **all 121 seeded pilot visits
  carry `promise_level 'none'`** — under promise-graded freedom, today's pilot data makes
  *everything* maximally movable; the grading only bites if promises are actually recorded.
- **One-write-path guardrail:** every schedule mutation goes through the booking verbs (the
  recorded product principle; board gestures and the freeze both comply). A re-solve commit
  that bypassed verbs to dodge ordering problems would break the guardrail every prior plan
  preserved.
- **The staleness kernel is strict:** `validDetail` requires the exact plan arrays; a NEW
  staged shape (e.g. with `moves`) fails `assessStagedFreeze` as malformed unless the kernel
  learns it — shared-token-kind reuse is not free.
- **The proposal view renders placements only** — no from→to diff vocabulary on the board or
  in chat copy.
- **Digest copy is freeze-specific:** the burst header keys on `detail.freezeRun` and says
  "The schedule freeze updated your schedule:"; move events already have per-kind copy
  (moved / landed / removed).
- **Blast-radius controls that exist:** horizon = firm-local today → +13 (override ≤ +31);
  day-0 now-clamp; only `status='confirmed'` rows enter context; pattern-less techs excluded.
  `technician_horizon_days` governs technician *visibility*, not solve scope.
- **`updateOpenReviewItemDetail` + kind-wide supersede** give one live plan per tenant;
  the partial unique index alone would allow one per (tenant, kind, subject).

## Decision Points

1. **Trigger surface** — extend `run_freeze` (one verb stages placements AND moves), a new
   `run_resolve` verb, or a board action. `run_freeze`'s stage note, proposal view, and §0h
   ritual copy are all placement-shaped today.
2. **Scope selector** — whole horizon (the freeze's shape), one technician-day lane (the
   `reflow_day` sketch: `technicianRef, date, fromTime?`), or a technician/date-range subset.
   Scope determines both solver search space and how many moves a manager must review.
3. **Default movability** — all unpinned confirmed future placed visits, or an opt-in subset
   (e.g. only visits the manager names, only promise-'none' rows). With the pilot's promises
   at 'none' across the board, promise-graded freedom alone excludes nothing today.
4. **Disruption objective** — whether and how strongly the solver should prefer plans with
   fewer moves (fixed weight vs user-visible knob), given the model currently has no
   move-cost vocabulary at all; ROI expressiveness here is an unverified vendor question.
5. **Promise-break handling in a re-solve** — the freeze precedent skips `promiseBroken` rows
   at commit; a re-solve could skip, or surface each break for an explicit per-row yes.
   Within-day moves of 'day'-promised visits are allowed by the ladder and need no gate.
6. **Commit ordering/atomicity** — dependency-order the move sequence (chains), park-and-
   reattach for swaps (three verb calls), tolerate mid-batch stops (the freeze model), or
   introduce any new transactional facility — which would be the first departure from
   verb-at-a-time commits.
7. **Proposal diff presentation** — how a move reads in chat copy and on the board sheet
   (from→to per row; grouped by technician or by day), and whether the staleness kernel/
   token detail shape is shared with `pending_freeze` or a new kind.
8. **Notification stamping** — reuse `freezeRun` (digest header says "freeze") vs a distinct
   run stamp with its own header copy; move events already digest-collapse per tick.
9. **Stranding posture** — whether a re-solve ships on today's cancel-first move mechanics
   (mid-batch failure strands one visit unscheduled, run stops) or waits for a
   recovery/ordering improvement first.

## Open Questions

- ROI request limits (shipments/vehicles per request) and pricing at ~120 movable shipments;
  whether the ShipmentModel can express per-shipment "cost of arriving far from current
  time" (soft time windows / convex costs) — plan-time live-doc verification.
- Solve latency/cost at re-solve scale (today's solves are a handful of movable shipments).
- Does the pilot ever need strict swaps in practice, or are chains + parks sufficient?
- Should `move_failed` stranded rows get a recovery sweep before any batch-move feature
  multiplies their likelihood?
- Manager appetite: how much reshuffling is acceptable per run (the disruption knob's
  default), and does the pilot want lane-scoped reflow more than horizon re-solve at
  3-technician scale (the 2026-07-20 open question, still unanswered)?
