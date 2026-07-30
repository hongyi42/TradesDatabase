---
date: 2026-07-30
task: run_resolve — horizon-wide re-optimizer; unpinned placed visits become movable, promise ladder sets each visit's freedom
research: thoughts/shared/research/2026-07-30-resolve-mode-foundations.md
status: draft
---

## Overview

Add `run_resolve`: a sibling of `run_freeze` that lets the route solver MOVE already-placed
visits (everything unpinned, graded by promise level) while also draining the loose queues
into the freed gaps. Same shape as the freeze: stage a whole plan behind one token, one
manager yes, commit through the normal booking verbs. New ground: movable-visit shipments
with soft time windows (displacement priced), dependency-ordered batch moves with a
park-and-reattach escape for swaps, a moves section in the proposal view.

## Decisions

- **Trigger (user, 2026-07-30):** new `run_resolve` verb sharing the freeze machinery; freeze
  copy/doctrine untouched.
- **Scope (user):** freeze-style horizon (firm-local today → +13, `throughDate` ≤ +31) with
  optional narrowing args `technicianRef` (one person's rows movable) and `onDate` (one day's
  rows movable). Narrowing limits WHO/WHAT may move — vehicles and fixed context stay
  horizon-wide so moves can land anywhere legal.
- **Movability (user, from the 2026-07-29 framing):** every unpinned, confirmed, PLACED,
  future visit in scope. Promise grading: `none` → any day/time in horizon; `day` → its
  promised day only; `time`/`time_only` → NOT movable in v1 (modeled as fixed context; a
  time-promised row's window is pinpoint anyway, and `time_only`'s "same clock, any day"
  needs per-day pinpoint windows — deferred, reported as kept).
- **Disruption (user):** fixed default, no knob. Soft time window pinned at the current
  start: `DISRUPTION_COST_PER_HOUR = 1` (moving a visit 1h ≈ 1 drive-hour), technician change
  `TECH_CHANGE_COST = 2` via `costsPerVehicle`. Emergent: day changes cost ~24/day — same-day
  shuffles are cheap, day hops need big wins. Constants exported in one home, re-tuned on
  live evidence. (Vendor facts verified 2026-07-30: TimeWindow has `softStartTime/softEndTime`
  + `costPerHourBeforeSoftStartTime/costPerHourAfterSoftEndTime`; Shipment has
  `costsPerVehicle[]` — ShipmentModel reference,
  https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel.)
- **Promises (user question resolved):** promise limits live in the solver's HARD windows;
  the commit keeps the freeze's belt (previewMoveVisit promiseBroken → skip + report) purely
  as a bug backstop.
- **Queues included (implementer):** the resolve model keeps the freeze's queue shipments —
  freed gaps fill in the same solve; the proposal reports `moves` and `placements`
  separately. Running resolve ⊇ freeze is intentional; freeze remains for place-only runs.
- **Movable rows are near-mandatory (implementer):** movable shipments carry
  `penaltyCost: CONTEXT_PENALTY` (1M) — the solver may not silently DROP an existing visit;
  a skipped movable row means "kept as booked" and is reported.
- **Commit ordering (implementer):** moves first (dependency-ordered; cycles broken by
  park-and-reattach through `moveVisit unassign:true`), then placements via the existing
  freeze walker. Stop-on-failure model unchanged; mid-batch stranding accepted and recorded
  (`move_failed` + honest error — the shipped posture).
- **Token/kind (implementer):** new `pending_resolve` review kind; staleness kernel
  generalized in freezeProposal.ts (12h TTL + version pin identical). No cross-kind
  supersede with `pending_freeze`: committing either bumps the schedule version, which
  stales the other at confirm — the version pin is the guard.
- **Stamp (implementer):** every event carries `resolveRun` (not `freezeRun`); summary event
  kind `resolve_committed`; boardNotify digest gets a resolve header.
- **Board view (implementer):** the proposal endpoint/pill/sheet become kind-agnostic (open
  freeze OR resolve token) with a Moves section; deep-link param stays `startapp=freeze`
  (now meaning "the open proposal") — no new BotFather/board plumbing.
- **Post-commit pin offer (user, 2026-07-30):** freeze AND resolve commit responses instruct
  the agent to OFFER pinning the just-committed placements ("want these N pinned so future
  re-plans leave them alone?") — one yes → one `set_visit_locks { assignmentIds }` call with
  the ids the result already carries. Closes the "freeze feels final" assumption mismatch
  WITHOUT reversing the recorded nothing-auto-locks doctrine; auto-pin was considered and
  rejected (machine pins would accrete until re-solve has nothing to work with).
- **undo_run (user, 2026-07-30):** generic go-back verb for the LATEST committed run
  (freeze or re-solve). **Restore, never re-optimize**: no solver call — the ledger events
  (run-stamped) plus the cancelled predecessor rows ARE the memory (a move cancels + remints,
  so every prior state still exists as a row). Two-step: stage previews exactly what gets
  restored; rows changed since the run are skipped-and-reported, never force-reverted.
  15-min TTL (fresh-mistake tool, the send_email idiom — not the 12h proposal TTL).
  Limitation (recorded): undo keys on the run's summary event; a run whose best-effort
  summary append failed is not undoable via the verb (rare, logged; manual ledger recovery).
  Chat-only preview — no board view for undo in v1. Undo events stamp `{ undoRun }`; the
  digest's generic header covers them (no third header).
- **ROI limits/pricing (verified live 2026-07-30,
  https://developers.google.com/maps/documentation/route-optimization/usage-and-billing):**
  optimizeTours QPM 60; no per-request shipment cap documented (batch mode bounds requests
  at 100MB — orders of magnitude above the pilot's ~240 shipments); billing is **per
  shipment unit** on the Fleet Routing SKU (≥2 vehicles), so a re-solve run bills ~2× a
  same-horizon freeze (~240 vs ~130 units). Current unit price: check the console pricing
  table at rollout — record it in the Phase 5 evidence.
- **No migration:** verified — `review_items.kind` and `schedule_events.kind` are plain
  text columns (20260702194603:59, 20260714120000:34); `ReviewKind` is a TS union.

## Plain-language walkthrough

**Phase 1 — teach the solver that placed visits can move.** Today every placed visit enters
the solve as a statue: arrival pinned to its exact current time. This phase adds a second
encoding — "movable": the hard window says where the visit MAY go (whole horizon for
no-promise visits, only the promised day for day-promised ones), and a soft window centered
on its current slot makes every hour of displacement cost as much as an hour of driving, so
the solver only moves things when the route actually gets better. Pinned and time-promised
visits stay statues. You'd see it working in tests: a solve whose fake response reshuffles
rows comes back as a tidy list of from→to moves, and anything the solver didn't move reports
as "kept".

```
placed visit ──┬─ pinned / time-promised / past / out of scope → statue (fixed context)
               └─ else → movable shipment
                    hard window  = promise-allowed range
                    soft window  = current slot (displacement costs/hour)
                    vehicle cost = +2 if a different technician takes it
```

**Phase 2 — commit a batch of moves without tripping the double-booking guard.** Moves
commit one at a time through the normal move verb, and a visit can't land in a slot its
colleague hasn't vacated yet. This phase orders the moves so vacate-before-arrive always
holds, and for true swaps (A and B trading slots — no order works) it parks one visit
person-less for a moment, moves the other, then re-attaches. Every move re-checks promises
(skip + report if a bug ever proposes a break) and stamps the run id so the ledger reads as
one operation.

**Phase 3 — the `run_resolve` verb.** Chat surface, exactly like the freeze: first call
solves and stages the whole plan behind a token (12-hour life, dies if the schedule changes
underneath); the reply is a short summary — N moves, N placements, N kept, N skipped, pin
line — plus the board link; booking happens only after the manager's explicit yes.

**Phase 4 — the board shows the plan.** The existing proposal pill and read-only sheet learn
a Moves section ("Tue 09:00 Maria G → Wed 08:00, Joy → Hman") and open for whichever
proposal is live (freeze or re-solve). Chat stays the place you say yes.

**Phase 5 — the safety net.** `undo_run` puts the latest committed run back the way it was —
no solver involved. Every move in this system cancels the old row and mints a new one, so
the "before" state still exists in the database; undo just replays the run's ledger trail
backwards through the normal verbs (moves reversed, freeze placements returned to the loose
bucket). You see a preview of exactly what will be restored, say yes, and anything you
hand-edited since the run is left alone and reported. Both commit replies also now end with
the pin OFFER — one yes pins everything the run just placed.

**Phase 6 — docs and rollout.** The agents' standing instructions (§0h ritual: a scheduled
firing proposes and STOPS) extend to `run_resolve` and `undo_run`; deploy, wire the five
sandboxes, restart gateways, then a stage-only live E2E on the pilot's seeded schedule and
an undo E2E of the scoped commit.

## Secrets & env preflight

- **Phases 1–5:** none new. Key-gated live-model tests use `GOOGLE_ROUTES_SA_KEY_JSON` +
  `GOOGLE_MAPS_API_KEY` in `.env` — `already required` (skip cleanly when absent).
- **Phase 6:** ssh access to trades-box-1 (`ssh tradesbox`, existing) — not an env var;
  Render deploy is user-driven.

## Phase 1: Solver — movable placed visits

### What this phase does
Extends `src/schedule/freezeSolve.ts` (same module family — resolve IS a freeze variant)
with movable-context assembly, model building, and response parsing. Pure over inputs past
assembly; no writes.

### Changes required

**`src/schedule/freezeSolve.ts`**
- Extend `FreezeContextVisit` (`:79`) with fields the assembler already has in hand
  (`freezeSolve.ts:245-280` reads full rows + jobs+customers): `locked: boolean`,
  `promiseLevel: PromiseLevel`, `promisedDay: string | null`, `jobId: string`,
  `customer: string | null`, `jobTitle: string | null`. Freeze paths ignore them.
- New exports:
  ```ts
  export const DISRUPTION_COST_PER_HOUR = 1;
  export const TECH_CHANGE_COST = 2;
  export interface ResolveScope { technicianRef?: string; onDate?: string }
  export interface ResolveMove { assignmentId: string; jobId: string; customer: string | null;
    jobTitle: string | null; fromTechnicianRef: string; fromDate: string; fromStart: string; // HH:MM
    fromEnd: string; toTechnicianRef: string; toDate: string; toStartTime: string; toEndTime: string }
  export interface ResolvePlan extends FreezePlan { moves: ResolveMove[]; keptCount: number }
  ```
- `partitionMovable(inputs: FreezeInputs, scope: ResolveScope, nowHHMM: string)`
  (exported, pure): context row is MOVABLE iff `!locked` ∧ promiseLevel `'none' | 'day'` ∧
  (no `technicianRef` scope or row's tech matches) ∧ (no `onDate` or row's date matches) ∧
  NOT already begun (day-0 rows with `startISO` time < `nowHHMM` stay fixed). Movable rows
  with `coords: null` stay FIXED and add a skip line reusing `coordSkipReason` semantics
  ("kept as booked — address can't be located"): a location-less shipment with a wide window
  would float freely with zero travel cost.
- `buildResolveModel(inputs, movable: FreezeContextVisit[])`: calls
  `buildFreezeModel({ ...inputs, context: fixedOnly })`, then appends one shipment per
  movable row (label `mv|<assignmentId>`, `penaltyCost: CONTEXT_PENALTY`):
  ```ts
  timeWindows: [{ startTime: hardFrom, endTime: hardTo,        // promise-graded freedom
    softStartTime: rfcFromISO(v.startISO), softEndTime: rfcFromISO(v.startISO),
    costPerHourBeforeSoftStartTime: DISRUPTION_COST_PER_HOUR,
    costPerHourAfterSoftEndTime: DISRUPTION_COST_PER_HOUR }],
  costsPerVehicle, costsPerVehicleIndices,   // TECH_CHANGE_COST on every other tech's vehicles
  ```
  hard window: `'none'` → horizon (end-inside `23:59:59` rule, `:566-575`); `'day'` → that
  one day. Duration = `spanMinutes(v.startISO, v.endISO)`. Day-0 hard windows respect the
  now-clamp (start ≥ today's `nowHHMM` when window opens day 0).
- `solveResolve(inputs, scope, nowHHMM, deps)`: partitions, then guards BEFORE any API call
  (the `solveFreeze:676-690` idiom): empty queue AND empty movable → honest plan;
  `vehicles.length === 0` → everything kept + queue skipped with the no-pattern reason
  (context can exist without vehicles — full-horizon time off). Then one `optimizeTours`;
  parses `mv|` labels — a row whose (technicianRef, date, HH:MM start) all match its current
  values counts as KEPT, not a move; skipped `mv|` shipments → KEPT + skip line ("kept as
  booked — no better slot"). Queue `q|` parsing unchanged (reuse the `:699-732` loop —
  factor the route-walk into a helper both solvers call). Capacity rebalance per accepted
  move: the visit's span leaves `fromTechnicianRef.committedMin` and joins
  `toTechnicianRef`'s whenever the technician changes (assembly pre-counted every context
  span at `:464-476`; without this the stage response, note relay, and board Capacity
  section all misreport cross-tech moves). Returns `ResolvePlan`.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (855 + 5 key-gated skips)
- [x] New tests (`freezeSolve.test.ts` idiom, injected `RoiTransport` fake): partition
      matrix (pinned / time-promised / day-0-past / scope args / coord-less → fixed+skip);
      movable shipment shape (soft window at current start, hard window per promise,
      costsPerVehicle on other techs only, penalty 1M); parse: changed row → move,
      identical row → kept, skipped label → kept+reported; capacity rebalances on a
      cross-tech move (from's committed shrinks, to's grows) and stays flat on a same-tech
      shift; zero-vehicles inputs → no API call, all movable kept; unchanged freeze path
      (`buildFreezeModel` output byte-stable for freeze inputs).

### Live verification (agent-executable)
- Prerequisites: none (transport injected).

### Manual verification
- (none)

---

## Phase 2: Commit — ordered batch moves

### What this phase does
New `src/schedule/resolveCommit.ts`: commits a confirmed `ResolvePlan` — moves in
dependency order (park-and-reattach for cycles), then placements via the existing freeze
walker. Stop-on-failure; `resolveRun` stamps; `resolve_committed` summary event.

### Changes required

**`src/schedule/resolveCommit.ts`** (new)
- `orderMoves(moves: ResolveMove[]): { ordered: ResolveMove[]; parked: ResolveMove[] }`
  (exported, pure): edge M→N when M ≠ N and N's target interval overlaps M's CURRENT
  interval on the same technician (M must vacate first). **Never a self-edge**: a same-tech
  overlapping shift (09:00→09:30, the commonest re-solve move) needs no ordering — the verb's
  pre-check already excludes the moved row itself (`booking.ts:689`); treating M==N as a
  cycle would pointlessly park it. Kahn's toposort; on a genuine cycle, pull one member into
  `parked` (deterministic: lowest assignmentId), recompute. Target-vs-target conflicts can't
  exist (the solver never double-books) — assert-style comment only.
- `commitResolvePlan(tenantId, plan, actorRef, runStamp)`:
  1. parked rows: `moveVisit({ unassign: true, date: fromDate, startTime: fromStart,
     endTime: fromEnd, reason, eventDetailExtra: { resolveRun } })` — person-less at current
     times, exempt from the overlap guard (`booking.ts:688-694` / migration predicate).
     **Capture `moved.created.id` per park** — moveVisit REMINTS the row (cancel-then-insert,
     `booking.ts:769`/`assignments.ts:191-192`), so the pre-park `assignmentId` is now a
     cancelled row and any later call against it throws "cannot move a cancelled assignment".
  2. ordered moves (parked members last, as attach moves **against their captured post-park
     ids**, with `technicianRef`): per row `previewMoveVisit` → `promiseBroken` → skip +
     report (belt; NOTE: a skipped mid-chain row can make a dependent later move fail its
     pre-check → run stops there, honest). Else `moveVisit({ date, startTime, endTime,
     technicianRef: toTechnicianRef, reason, eventDetailExtra: { resolveRun } })` — always
     pass `technicianRef` (same-tech moves resolve to the same person; `booking.ts:774-776`).
  3. placements: reuse `commitFreezePlan` (`freezeCommit.ts:44`) via a new options param
     (below) so placement rows stamp `{ resolveRun }`, carry reason `re-solve …`, and **no
     `freeze_committed` summary fires**.
  4. summary event `resolve_committed` `{ resolveRun, horizonFrom, horizonTo, moved,
     placed, kept, skipped, stoppedAt?, error? }`, best-effort (freeze idiom `:121-139`).
  - Result: `{ movedRows, committed, skippedAtCommit, failed }` (freeze shapes + moves).
- Reason string: `` `re-solve ${runStamp.slice(0, 10)}` ``.

**`src/schedule/freezeCommit.ts`**
- `commitFreezePlan(tenantId, plan, actorRef, runStamp, opts?: { eventDetailExtra?: Json;
  reasonPrefix?: string; skipSummaryEvent?: boolean })` — defaults reproduce today's
  behavior byte-for-byte (`freezeRun` stamp, `` `freeze ${…}` `` reason at `:50`, summary at
  `:121-139` fires). Resolve passes `{ eventDetailExtra: { resolveRun }, reasonPrefix:
  're-solve', skipSummaryEvent: true }` — otherwise every resolve commit would append a
  false `freeze_committed` ledger row AND double-push managers ("Freeze ran…" +
  "Re-solve ran…", `boardNotify.ts:163-177`).

**`src/telegram/boardNotify.ts`**
- `pushesFor`: tag pushes with `detail.resolveRun` the same way as `freezeRun` (`:178`);
  digest header for an all-same-`resolveRun` burst: `'The schedule re-plan updated your
  schedule:'`. `resolve_committed` → manager push mirroring `freeze_committed` (`:157-172`):
  `` `Re-solve ran (by ${actor}): moved M, placed P, kept K — see the board.` ``

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (868 + 5 key-gated skips)
- [x] `orderMoves` unit tests: chain orders correctly; 2-cycle parks exactly one;
      **same-tech overlapping shift (09:00→09:30) yields NO park and no self-edge**;
      disjoint moves keep input order; cross-tech moves need no edges.
- [x] Commit integration tests (local stack, real verbs): chain (A into B's vacated slot)
      commits in-order with zero overlap errors; swap commits via park (read back: both rows
      at targets, ledger shows park+attach **on the reminted id**, nothing stranded);
      promiseBroken fixture skips + reports; mid-batch failure stops run, prior rows booked
      (freeze test idiom); every event carries `resolveRun` and **NO `freeze_committed`
      event exists after a resolve commit** (assert absence); placement reasons read
      `re-solve …`; freeze regression: `commitFreezePlan` with no opts is byte-identical
      (existing suite green); boardNotify digest test: resolve-stamped burst → re-plan
      header; manager summary push.

### Live verification (agent-executable)
- Prerequisites: none.

### Manual verification
- (none)

---

## Phase 3: The run_resolve verb

### What this phase does
Stage/confirm handler + tool definition + token kind, mirroring `run_freeze`
(`server.ts:4642-4830`) with the generalized staleness kernel.

### Changes required

**`src/db/reviewItems.ts`** — add `'pending_resolve'` to `ReviewKind` (`:27`).

**`src/schedule/freezeProposal.ts`**
- Generalize: `StagedResolveDetail = StagedFreezeDetail & { plan: ResolvePlan }`;
  `assessStagedResolve(detail, latestVersion, nowMs)` sharing the internals (extract the
  common validate/expiry/version core; resolve's `validDetail` additionally requires
  `moves` array). `assessStagedFreeze` behavior byte-identical.

**`src/mcp/server.ts`**
- `ADMIN_TOOLS` (`:536` array): add `run_resolve` def — args `throughDate?`, `technicianRef?`
  (roster ref — "only this person's visits may move"), `onDate?` (YYYY-MM-DD — "only this
  day's visits may move"), `confirmId?`. Description mirrors `run_freeze`'s (`:853`) plus:
  moves existing UNPINNED visits; promises limit movement; SHORT summary = moves/placements/
  kept/skipped counts + pin line + proposal board link line; same no-proposalLink fallback
  sentence; "pin anything you don't want rearranged, then rerun".
- Handler `case 'run_resolve'` (beside `:4642`): STAGE = version pin → `getTenant` tz →
  `assembleFreezeInputs(tenantId, today, horizonTo, nowHHMM, geocodeDeps)` →
  `solveResolve(inputs, { technicianRef?, onDate? }, nowHHMM, freezeDeps)` — validate
  `technicianRef` resolves on the roster and `onDate` is a real date inside the horizon
  (reject otherwise); kind-wide supersede of open `pending_resolve` tokens; stage +
  stage-race re-pin (`:4706-4720` idiom); response: `moves` (with `weekday` on both ends),
  `placements`, `keptCount`, `skipped`, `capacity`, pin line count, 12h/staleness note.
  CONFIRM = `assessStagedResolve` verdicts (same dismissals) → consume-first →
  `commitResolvePlan` → relay per-row warnings + `skippedAtCommit` + `failed` (freeze copy).
- **Pin offer (both verbs):** the commit-response `note` of `run_resolve` AND `run_freeze`
  (`:4820-4830` region) gains one sentence: "Offer to PIN what this run just scheduled
  (moves and placements are listed with assignmentIds above) so future re-plans leave it
  alone — on the manager's yes call set_visit_locks with exactly those ids." **The resolve
  confirm response MUST list moves with their POST-COMMIT minted ids** (`movedRows`'
  `created.id` — the staged plan's `ResolveMove.assignmentId`s are cancelled rows after
  commit; passing them would make `setVisitLocks` throw on the first terminal row and abort
  the whole pin batch, `booking.ts:1139-1144`). Freeze side already returns minted ids
  (`:4812-4816`).
- Routing/decoration: `resolve_review` kind map (`:5415`) gains
  `pending_resolve: 'run_resolve'`; `list_pending_reviews` summary line (`:5340` idiom):
  `'a staged re-solve plan — confirm or restage via run_resolve, never relay from here'`;
  `BOARD_LINK_TOOL_NAMES` (`:1206`) adds `'run_resolve'`; the staged-tool proposalLink
  exception (`:5515`) covers `run_resolve`'s stage result too (same `boardMiniAppLink('freeze')`
  param — one open proposal, one board view).

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (873 + 5 key-gated skips)
- [x] server.test.ts (freeze suite idiom, fake transport): stage returns moves+placements+
      kept + confirmId; bad `technicianRef`/`onDate` rejected; confirm books moves (read
      back real rows); stale/expired/malformed dismiss with freeze-parity copy; version pin
      pinned BEFORE solve (test races a booking); stage result carries `proposalLink` +
      fused `boardNote`; resolve_review dismissed cancels the token; BOTH commit notes pin
      the offer copy ("set_visit_locks with exactly those ids" pinned verbatim).
- [x] freezeProposal.test.ts: kernel parity matrix for resolve details incl. moves-less
      detail → malformed; freeze assessments unchanged.

### Live verification (agent-executable)
- Prerequisites: none (fake transport in tests; real-solve E2E lands in Phase 5).

### Manual verification
- (none)

---

## Phase 4: Proposal view — moves on the board

### What this phase does
The board's proposal endpoint/pill/sheet become kind-agnostic and learn a Moves section.

### Changes required

**`src/schedule/freezeProposal.ts`** — `projectFreezeProposal` (`:96`) → generalized
`projectOpenProposal(freezeItems, resolveItems, latestVersion, nowMs)`: newest OPEN token of
either kind wins (both open can't happen for long — version pin stales the loser; pick
newest `created_at`); view gains `kind: 'freeze' | 'resolve'` and, for resolve,
`moves: { fromLabel, toLabel, customer, jobTitle }[]` + `keptCount` (weekday-labeled both
ends, no confirmId leak — same rules).

**`src/telegram/boardApi.ts:313`** — the endpoint also fetches `pending_resolve` items and
calls the generalized projection (managers only, unchanged).

**`web/board/board.js`** — pill text by kind (`Freeze proposal` / `Re-plan proposal`,
`syncFreezePill` `:552`); `renderProposalSheet` (`:579`) renders a Moves section before
Placements: per-day groups, `Tue 09:00–10:00 Maria Gonzalez → Wed 08:00–09:00 · Joy → Hman`
(arrow lines, tech shown only when it changes), kept-count line; sheet footer/hint copy
says "re-plan" when kind is resolve.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (880 + 5 key-gated skips;
      board.js lint-gated)
- [x] boardApi.test.ts: open resolve token → kind 'resolve' + moves array, no confirmId;
      freeze token → unchanged shape; both-open → newest wins; expired/stale parity.
      Plus the pure matrix in freezeProposal.test.ts (resolve view compose/sort/techChange,
      kind-aware expired/stale copy, misfiled-detail degradation).

### Live verification (agent-executable)
- Prerequisites: local stack.
- [x] Staged a resolve token, `GET /board/api/freeze-proposal` over real HTTP with a manager
      slip → served JSON captured 2026-07-30: `kind:"resolve"`, `moves[0]` =
      `{fromLabel:"Mon 2026-08-24 11:00–12:00", toLabel:"Mon 2026-08-24 08:00–09:00",
      techChange:"Tess One → board-t2", toDate, toWeekday}`, `keptCount:2`, freeze sections
      intact, no confirmId/row-id in the payload.

### Manual verification
- [ ] On the phone: pill reads "Re-plan proposal"; sheet's Moves section is readable
      (from→to lines, tech-change visible); chat deep link opens it.

---
*Pause after Phase 4 for the phone check.*

## Phase 5: undo_run — restore the latest committed run

### What this phase does
A generic go-back verb: stage a preview of reverting the latest committed run (freeze or
re-solve) from its ledger trail, commit on yes through the normal verbs. No solver call.

### Changes required

**`src/db/scheduleEvents.ts`**
- `latestCommittedRun(tenantId): Promise<{ stamp: string; kind: 'freeze' | 'resolve';
  eventId: number } | null>` — newest event of kind `freeze_committed` | `resolve_committed`
  (order id desc, limit 1; stamp from `detail.freezeRun` / `detail.resolveRun`).
- `listEventsByRunStamp(tenantId, key: 'freezeRun' | 'resolveRun', stamp)` — PostgREST JSON
  filter `.eq(`detail->>${key}`, stamp)`, order id ASC; callers reverse for undo order.

**`src/schedule/booking.ts`**
- `UnscheduleVisitInput` gains `eventDetailExtra?: Json` (spread into the `'cancelled'`
  event detail at `:886-892`, computed keys win) — without it the undo's unschedule steps
  cannot stamp `{ undoRun }` and the run's forensics/tests are unsatisfiable.
- `moveVisit`'s `move_failed` event detail also spreads `input.eventDetailExtra`
  (`:797-803` builds `{ toDay, reason }` only today) — a resolve/undo-run stranding's
  ledger row must carry the run stamp or `listEventsByRunStamp` misses it (Phase-2 review
  flag-forward).

**`src/schedule/undoRun.ts`** (new)
- `planUndo(tenantId, run)`: **collapse first** — group the run's `moved` events per visit
  by following same-run `previousAssignmentId` chains (a park+attach swap writes TWO events
  for one visit; the chain's FINAL created row is the live target, the chain's EARLIEST
  predecessor is the true prior state — naive per-event replay would restore parked rows
  and misread same-run cancellations as drift). One restore step per collapsed chain:
  - prior state PLACED-with-tech → inverse move { predecessor date/times, technicianRef };
    person-less → inverse move { predecessor times, unassign: true }; UNPLACED (timeTbd) →
    `unscheduleVisit` live row + `bookVisit` { jobId, timeTbd: true, earliest/latest +
    promiseLevel from predecessor, technicianRef? } (no verb converts placed→unplaced in
    one step; twin guard can't fire — the original is cancelled).
  - `booked` event (queue placement) → `unscheduleVisit` (job back to the open queue).
  - DRIFT rule (on the chain's LIVE row only): status no longer `confirmed`/`proposed` →
    skip + report. **Pinned targets → skip + report** ("pinned since the run — left as-is;
    unpin to restore"): the manager's pin means hands-off, and the pin OFFER makes
    pinned-after-run rows a normal state, not an anomaly. **Unresolvable predecessor tech**
    (deactivated since the run) → skip + report, never let `resolveTechnician`'s throw
    stop the whole undo.
- `commitUndoRun(tenantId, plan, actorRef, undoStamp)`: order = **(1) ALL unschedule steps
  first** (run placements landed in freed gaps — they must vacate before inverse moves
  return), **(2) inverse moves via the Phase-2 batch executor** — factor
  `commitResolvePlan`'s ordered-move loop (orderMoves + park-with-captured-reminted-id +
  `previewMoveVisit` promise belt) into a shared helper both commits call; the undo gets
  the SAME belt (a promise recorded on a run-minted row after the run must skip+report,
  never silently move back — `moveVisit` alone only reports breaks, `booking.ts:679/:829`).
  Stamp every verb call `eventDetailExtra: { undoRun: undoStamp }`, reason
  `` `undo ${run.kind} ${…date}` ``, stop-on-failure; summary event `undo_committed`
  `{ undoRun, undid: run.stamp, undidKind, restored, skipped, stoppedAt? }` best-effort.

**`src/db/reviewItems.ts`** — add `'pending_undo'` to `ReviewKind`.

**`src/mcp/server.ts`**
- `ADMIN_TOOLS`: `undo_run { confirmId? }` — description: undoes the LATEST committed
  freeze/re-solve; restore not re-optimize; two-step; 15-min expiry; rows changed since are
  left alone and listed; add to `BOARD_LINK_TOOL_NAMES` (schedule answer) and the
  `resolve_review`/`list_pending_reviews` maps (`pending_undo: 'undo_run'`).
- Handler: STAGE = `latestCommittedRun` (null → "nothing to undo"); `planUndo`; kind-wide
  supersede of open `pending_undo`; stage `{ run, restores, skippedDrift, scheduleVersion,
  stagedAt }`; response lists every restore in plain lines + drift/pin skips; 15-min TTL
  (`send_email` idiom `:2183`, NOT the proposal kernel). CONFIRM = token lookup → expiry →
  **staged `scheduleVersion` vs `latestScheduleVersion` (ANY edit in the stage→confirm
  window → dismiss "the schedule changed since this undo was staged — restage"; freeze
  parity — without it a hand edit is invisible to the run re-check and the undo dies
  mid-run instead of dismissing cleanly)** → re-check `latestCommittedRun` still equals the
  staged run (newer commit → dismiss: "a newer run committed — undo targets only the
  latest run") → consume-first → `commitUndoRun` → report restored/skipped/failed.
- `list_pending_reviews` summarizer (`:5328-5349`) gains the `pending_undo` line
  ('a staged undo — confirm or restage via undo_run, never relay from here') — an
  unsummarized token would dump a horizon-wide restore list into context.

**`src/telegram/boardNotify.ts`** — no header change (undo bursts use the generic digest
header); `undo_committed` → manager push: `` `Undo ran (by ${actor}): restored N, skipped
K — see the board.` ``

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (890 + 5 key-gated skips)
- [x] undoRun tests (local stack, real verbs): full-cycle — commit a resolve fixture, undo,
      read back EVERY row at its original slot/person/fence and queue jobs re-open;
      **swap/park fixture — a run that parked collapses to ONE restore per visit (no bogus
      drift skips, nothing left person-less)**; placements-in-freed-gaps fixture — undo
      unschedules the placement BEFORE the inverse move returns (no overlap error); drift —
      hand-move one row post-run → undo skips exactly it, restores the rest; **pinned-since
      row skipped + reported; post-run promise on a minted row → belt skips it; deactivated
      predecessor tech → skip, run completes**; placed→timeTbd restore reproduces the
      fence + technician; a newer commit AND a plain version bump each dismiss the staged
      undo at confirm (version-bump wired live; the newer-run belt proven via a doctored
      runEventId — a real newer run always trips the version pin first); `undo_committed`
      summary + manager push; every event (incl. unschedules) carries `undoRun`; freeze-run
      undo returns placements to the loose bucket (bucket counts match pre-freeze read).
      Plus verb-level: nothing_to_undo / nothing_to_restore (no token minted), 15-min
      expiry + malformed dismissals with replay closure, list_pending_reviews summarizer
      (counts only, plan internals withheld), resolve_review dismiss-only, surface 39..

### Live verification (agent-executable)
- Prerequisites: none (all local-stack).

### Manual verification
- (none)

---

## Phase 6: Docs + rollout + live E2E

### Changes required
- **`Box_Setup_Stuff/bootstrap-box.sh`** §0h block: ritual copy covers `run_resolve` and
  `undo_run` (scheduled fire = proposal + STOP — identical rules; refreshed per wire run).
- **`docs/nemoclaw-tech-agent.md`** — freeze section gains the re-solve + undo sibling
  paragraph and the pin-offer sentence.
- **`docs/engineering-memory.md`** — feature status + the ordering/park + undo-restore
  design notes.
- **Tool-surface count pins (Phase-3 review flag-forward):** the manager surface is now
  **38 tools** (was 37) — update `docs/nemoclaw-tech-agent.md:102` ("24 seat/lifecycle+
  scheduling tools, for a 37-tool manager surface" → 26/39 after Phase 5 adds undo_run;
  recount at close-out) and the engineering-memory surface line; the Box_Setup_Stuff
  verification steps cite the same count.

### Automated verification
- [ ] Full gates green on merged main; `npm run build`.

### Live verification (agent-executable)
- Prerequisites: PR merged + Render deploy (user), box ssh, s2 probe session; pilot has the
  seeded WA schedule.
- [ ] Deploy byte-check (`board.js` served == main), wire ×5 (`run_resolve` grep in
      AGENTS.md), gateway restarts ×5 health-passed.
- [ ] s2 stage-only E2E: "re-optimize next week" → SHORT summary (moves/placed/kept counts +
      pin line) ending with the proposal deep-link line; SQL read-back: pending_resolve
      open, ZERO schedule writes; then unaided dismiss ("get rid of that plan") → token
      dismissed, still zero writes. Capture transcript + SQL as evidence.
- [ ] Scoped commit E2E (small blast radius): FIRST SQL-check the pilot's loose queues —
      `technicianRef` narrows who may MOVE, but queues still drain tenant-wide in the same
      solve, so any open queue item would also book (either empty the queues for the test
      or extend expectations to include those placements). Then `run_resolve` with
      `technicianRef: 'manager-sam'` (5 seeded visits) → confirm → read back moved rows at
      solver times (response carries MINTED ids), all `locked=false` intact, ledger
      `resolveRun` uniform + `resolve_committed` last; the commit reply OFFERS the pin
      (copy check); Sam's phone gets ONE re-plan digest (header check).
- [ ] Undo E2E (rides the scoped commit): `undo_run` → stage lists exactly the moved rows'
      restores → confirm → read back every row at its ORIGINAL slot, `undo_committed` last,
      `undoRun` uniform; Sam's phone gets the restore burst as one digest.

### Manual verification
- [ ] Owner judges the horizon-wide plan's route quality on the seeded data (their E2E) —
      moves make geographic sense; disruption default not too chaotic/timid.

---
*Total: 6 phases (exceeds the skill's 5-phase/300-line caps — flagged, not split: one
coherent feature; the undo net ships WITH the reshuffler by user decision, and the overrun
is review-hardening detail). Rollback = revert PR. No migration — `review_items.kind` and
`schedule_events.kind` are plain text columns (verified: 20260702194603:59,
20260714120000:34) and `ReviewKind` is a TS union. Adversarial plan review 2026-07-30,
round 1: 6 findings, all folded in — park re-attach must use the reminted post-park id;
freeze-walker reuse needed opts (stamp/reason/summary suppression) to avoid a false
`freeze_committed` + double manager push; orderMoves must exclude self-edges (same-tech
shifts are not cycles); capacity must rebalance on cross-tech moves; solveResolve needs the
zero-vehicles guard; ROI limits/pricing verification recorded with citation in Decisions.
Round 2 (pin-offer + undo_run additions), 10 findings, all folded in: same-run park chains
must COLLAPSE before restore (else bogus drift + person-less strands); undo order =
unschedules first, then inverse moves through a shared batch executor (orderMoves + park +
promise belt — extracted from commitResolvePlan); `UnscheduleVisitInput` needs
`eventDetailExtra` for undoRun stamps; resolve confirm must return MINTED move ids or the
pin offer aborts on cancelled rows; undo confirm re-checks the staged scheduleVersion;
scoped E2E must pre-check queues (resolve drains them tenant-wide); pinned-since-run rows
skip+report in undo; deactivated predecessor tech skips instead of stranding;
`pending_undo` joins the list_pending_reviews summarizer.*

*FINAL 8-angle code review 2026-07-30 (whole-branch diff, after per-phase reviews): 25
candidates → 10 fixed, gates re-green (892+5): (1) pinned PLACED visits now emit
PINNED_SKIP_REASON entries from `partitionMovable` — the stage pin line and board
pinnedCount no longer read "0 pinned" when a manager pinned placed rows; (2) undo confirm's
malformed gate validates the FULL plan shape (run.kind/stamp + all arrays) before
consuming — a shapeless token dismisses cleanly instead of burning + crashing; (3)
`validResolveDetail` validates per-MOVE fields — a corrupt `toTechnicianRef: null` is
malformed, never a silent person-less park; (4) undo stage supersedes open tokens BEFORE
its nothing_to_* early returns (no dangling dead-end token); (5) `findUndoOfRun` — a
re-stage after a successful undo now says "ALREADY undone", not "changed since the run";
(6) resolve/undo manager pushes carry STRANDED tails; (7) both pin offers gate on nonzero
committed rows (no offer against empty lists); (8) NONE_MESSAGE verb-neutral; (9)
`assessStagedResolve` returns verdicts explicitly (cast removed — a future kernel verdict
degrades to malformed, never falls through post-consume); (10) `planUndo` reads identity
once per row (liveOrSkip returns it). (11, user-requested same day) planUndo reads BATCHED:
chains collapse first (pure), then FOUR queries total regardless of run size — events, one
`listAssignmentsByIds` .in() over live rows + cancelled predecessors, `listTeam`, one
`listJobsWithCustomerByIds` — replacing 5-6 sequential point reads per row (~600 round-trips
to stage a 121-visit undo → 4); all nine undo integration arms pass unchanged. Recorded
follow-ups, deliberately NOT done here: merge the
board endpoint's two kind reads into one `.in()`; factor the run_freeze/run_resolve
stage/confirm skeleton + single-source horizon constants; TTL-parameterize the staleness
kernel so undo_run's inline trio joins it; board.js per-day-section helper; shared
ResolvePlan test-fixture builder; boardNotify manager-push helper; orderMoves pool-fallback
loudness.*
