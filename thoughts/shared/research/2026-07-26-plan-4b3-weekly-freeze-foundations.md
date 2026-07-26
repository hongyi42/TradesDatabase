---
date: 2026-07-26
branch: main
commit: f9f64ff
topic: Plan 4b-3 — the weekly freeze (auto-placement of unplaced work). Delta map of everything the freeze builds on, as the code stands after 4b-1 (duration ladder) and 4b-2 (unplaced visits) shipped.
---

## Summary

The freeze is the recurring moment when loose work — jobs with no visit, visits with no
person, and (new since 4b-2) visits with a day fence but no time — gets placed onto real
calendar slots, batch-committed, and announced. Three prior research documents map this
territory and **still stand**: the [2026-07-22 freeze-ritual surfaces
map](2026-07-22-plan-4-freeze-ritual-surfaces.md) (commit path, staging options, sender fork,
cadence addendum), the [2026-07-24 4b decision brief](2026-07-24-plan-4b-freeze-autonomy-time-tbd.md)
(engine evidence, autonomy, time-TBD shapes, the ROI input-model table), and the
[2026-07-24 ROI pricing verification](2026-07-24-roi-engine-live-pricing-verification.md)
(cited vendor facts). This document is the **delta**: what 4b-1/4b-2 shipped closes, what it
newly creates, and fresh line anchors — the prior docs' anchors are stale (`fit.ts` grew
569→606 lines, `booking.ts` 765→1,257).

The headline: **two of the 07-24 brief's six decision points are now closed by shipped
code.** Time-TBD storage is decided and live (unplaced visits: `earliest_date`/`latest_date`
day fences, null times, the overlap guard narrowed to placed rows — exactly the shape the
brief's "option (a)" described, and exactly ROI's native `TimeWindow` input). The duration
model is decided and live (the 4b-1 ladder: `jobs.duration_minutes`, required-when-asked,
never defaulted). The freeze's *placing verb* also now exists: `moveVisit` turns an unplaced
visit into a placed one (with the job's length proposing the end time), and
`attachUnplacedVisit` assigns without placing — so a freeze can decide *who* and *when* as
separate passes. What is still absent is unchanged from 07-22: **no ROI client, no geocoder,
no lat/lng storage, no autonomy setting, no batch/version-pinned commit, no freeze trigger.**
And the input-coverage bottleneck the 07-24 brief measured is **still the binding
constraint**: today the pilot has 17 open jobs with exactly **1** stored duration (the
16-pair backfill drafted in 4b-1 Phase 4 is still awaiting the owner's go) and **2 of 5**
active technicians with a working pattern — a freeze run today would correctly place almost
nothing.

## Entry Points

- **The candidate engine**: [src/schedule/fit.ts](../../src/schedule/fit.ts) —
  `generateCandidates` (:187), `sortCandidates` (:236), `assembleFitContext` (:339),
  `findDisplacementCandidates` (:448), `measureDriveDeltas` (:534).
- **The write path every freeze commit must use**:
  [src/schedule/booking.ts](../../src/schedule/booking.ts) — `bookVisit` (:459), `moveVisit`
  (:736, the PLACING verb), `attachUnplacedVisit` (:942, assign-without-placing),
  `unscheduleVisit` (:840), `cancelJob` (:1220).
- **What the freeze consumes**: [src/schedule/boardRead.ts:333](../../src/schedule/boardRead.ts#L333)
  `readLooseBucket` (person-less visits + unscheduled jobs) and
  [src/db/assignments.ts:503](../../src/db/assignments.ts#L503) `listUnplacedAssignedForRange`
  (assigned-but-unplaced rows — the third queue, new in 4b-2).
- **The only scheduled entrypoint**: [src/jobs/lifecycle.ts:44](../../src/jobs/lifecycle.ts#L44)
  `runLifecycle` — Render Cron `*/15 * * * *`, idempotent-sweep idiom.
- **The per-tenant settings precedent**: [src/db/tenants.ts:69](../../src/db/tenants.ts#L69)
  `setTechnicianHorizonDays` + [src/schedule/policy.ts](../../src/schedule/policy.ts) (one
  policy home; `horizonDaysFor` :22, DB CHECK 7–84 as backstop).
- **The staged-confirm machinery**: [src/db/reviewItems.ts](../../src/db/reviewItems.ts) —
  kinds :20-28 (`pending_booking` … `availability_setup`), `upsertOpenReviewItem` :44, at most
  ONE open item per (tenant, kind, subjectRef) via partial unique index (:39-43).
- **find_slots** (the one-visit sibling): [src/mcp/server.ts:4466](../../src/mcp/server.ts#L4466)
  handler; tool description :1010.

## Key Files (what changed since the prior maps)

| File | Freeze-relevant state, 2026-07-26 |
|---|---|
| `src/schedule/fit.ts` (606 ln) | Gained `commitmentsByDate` (:136, :396-417): unplaced-assigned load now weighs a day's score (`LIGHT_DAY_PER_STOP` on commitments, :264) without flipping its density mode (`DENSE_DAY_STOPS = 2` on placed stops only, :159). `assembleFitContext` reads placed + unplaced in parallel (:369-377) and honors `excludeAssignmentId` for both. Scoring weights :171-179 (`EARLINESS_PER_DAY` 30/15/3/1 by priority, morning 10, light-day 5/stop, same-city 15); drive delta 1 pt/min (:509), top-5 measured (:503). |
| `src/schedule/booking.ts` (1,257 ln) | The unplaced arm of `resolveBooking` (:245-311): fence validation, promise refusals (`time`/`time_only` refused on timeless rows; `day` needs a one-day fence), technician-keyed twin guard (:281). `resolveMove`'s endTime chain (:615-630): explicit → old span → `job.duration_minutes` → refuse. `timeChanged` guarded by `isPlaced` (:643) — **placing an unplaced visit is never a time break**, and placing a day-promised visit on its promised day is not a day break either (`dayChanged`, :639) → such placements are one-shot under the doctrine. `visitDay` (:61) is the day-label rule. |
| `src/db/assignments.ts` | `PlacedAssignment` (:15) — time-filtered readers return placed rows by construction. `createAssignment` defaults `locked: false` (:80); `rescheduleAssignment` carries the old row's flag (:200). The three queue readers: `listUnassignedAssignments` (:428, widened to include unplaced), `listUnplacedAssignedForRange` (:503), `listUnassignedOpenJobs` (via jobs.ts). |
| `supabase/migrations/20260724130000_unplaced_visits.sql` | The fence schema: nullable times, `earliest_date`/`latest_date` DATE, `assignment_placed_or_windowed` CHECK (one shape only), `no_confirmed_overlap` narrowed `where (status='confirmed' and starts_at is not null)`. Applied to the pilot 2026-07-25 — **as version `20260726043149`, not the repo timestamp** (MCP-applied migrations stamp their own version; trust schema read-backs, not the ledger — recorded trap for 4b-3's own migration). |
| `src/mcp/server.ts` | `get_team_schedule` windowed mode now folds assigned-unplaced rows (chat can see/manage every freeze input); `find_slots` clamps subject-defaulted windows to today+14 inside the fence (:4712-4725 area) — the recorded stance that a wide fence narrows to a bounded search. Every successful object result carries the temporal-grounding `now` rider (PR #83) — a freeze tool inherits this decoration seam automatically. |
| `src/telegram/boardNotify.ts` | Copy for 4 kinds only (:63-126); unplaced-aware `day`/`span` fallbacks (:32-36). A freeze's per-row `moved`/`booked` events push with today's copy; any NEW event kind is silent until copy is added. Worker cursor is in-memory (:130-140) — a freeze's event burst enlarges the restart-loss window (deferred fix still open). |
| `src/routes/googleRoutes.ts` | Unchanged: `computeRoutes` only (free-text addresses, 25-stop cap, <3-stop short-circuit). Still NO ROI client, NO geocoder, NO lat/lng column anywhere. |
| `src/db/tenants.ts` | Still no autonomy column (verified against the pilot's information_schema 2026-07-26: zero `%autonom%` columns). `technician_horizon_days` is the settings precedent. |

## Data Flows

The freeze pipeline against what is now shipped (✅ new since the 07-22 version of this diagram):

```
 CONSUME                          SOLVE                    STAGE            COMMIT                    INFORM
 ───────                          ─────                    ─────            ──────                    ──────
 ✅ readLooseBucket               ✗ no ROI client          ✗ no batch       ✅ moveVisit places       ✅ schedule_events
    (person-less visits           ✗ no geocoder               token/           (endTime ← job length)     → boardNotify
     + unscheduled jobs)          ✅ fences ARE ROI            version pin  ✅ attachUnplaced assigns     → tech pushes
 ✅ listUnplacedAssignedForRange     TimeWindows           ✅ `proposed`    ✅ bookVisit books            (in-memory cursor)
    (assigned time-TBD, NEW)      ✅ durations exist          tier exists,     (timeTbd or placed)    ✗ customers: 4c
 ✅ get_team_schedule shows all      (ladder, 1/17 filled)    unused       ✅ per-row promise gates      (sender fork)
 ⚠ duration 1/17, patterns 2/5   ✅ fit.ts greedy exists                     fire mechanically
                                     as fallback           ⚠ every manual row locked:true; nothing unlocks
```

**The fence → ROI translation now has a storage source.** The 07-24 brief's mapping table
(its §"How the optimizer actually takes input", with vendor citations) maps directly onto
shipped columns: a single-day fence (`earliest_date = latest_date`) = one `TimeWindow`
covering that day's working hours; a range fence = one window per working day in
[earliest, latest]; `jobs.duration_minutes` = `VisitRequest.duration`; patterns =
`Vehicle.startTimeWindows`/`endTimeWindows`; an assigned-unplaced row =
`allowedVehicleIndices` pinned to one vehicle; placed+locked rows = `injectedSolutionConstraint`
(frozen routes). Day-promised rows add a hard edge: the promise gate makes any placement
outside `promised_day` a confirm-gated break, so a solver treating the promise as soft would
generate a plan the commit path then interrogates row by row.

**What a batch commit traverses per row** (unchanged mechanics, now with the unplaced arm):
`moveVisit` → `resolveMove` guards → `rescheduleAssignment` (cancel + insert — each row is
its own stranding window; `move_failed` event + honest UNSCHEDULED error on crash; **no batch
rollback concept exists**) → `moved` event → boardNotify push. N placements = N sequential
verb calls = N gates, N events, N pushes.

## External Dependencies

All verified state lives in the [ROI pricing verification](2026-07-24-roi-engine-live-pricing-verification.md)
(fetched 2026-07-24, URLs cited there): Fleet Routing = Enterprise SKU, $30/1k shipments,
1,000 free/month, billed per shipment, dry-run/VALIDATE_ONLY free; **input is lat/lng or
place ID only — never free-text addresses**; Geocoding SKU 10k free/month. Two of its flags
remain unresolved and are now 2 days old: whether Enterprise-tier Fleet Routing needs a sales
agreement, and whether `GOOGLE_MAPS_API_KEY` is set on Render (open since 2026-07-20). The
2026-07-04 OptimoRoute pricing is 22 days stale; per CLAUDE.md it must be re-verified live
if the engine choice is ever revisited. No other freeze-relevant vendor claims exist in the
repo without citations.

## Constraints and Invariants

Everything in the two prior Constraints sections stands. New or sharpened since:

- **The user already chose the engine** (recorded 2026-07-24, User decisions): Google Route
  Optimization API, "with the geocoding cost stated" — geocoding + coordinate storage +
  re-geocode rule + non-geocodable fail path are accepted consequence phases, and confirming
  Enterprise SKU access is a recorded hard prerequisite. 4b-1 (durations) and 4b-2 (fences)
  were built as this choice's input prerequisites. The 07-24 ROI doc's "honest baseline"
  note (bucket is single digits; a heuristic may be indistinguishable) is recorded context,
  not a decision.
- **A freeze placement through `moveVisit` today stamps `locked: true`** (:755,
  unconditional). `locked` is documented as "manual manager placement — the optimizer routes
  around it" ([assignments.ts:45](../../src/db/assignments.ts#L45)). Without a change, the
  freeze's own placements would be indistinguishable from manager pins — the next freeze
  could never re-place anything it placed. `rescheduleAssignment` accepts a `locked` override
  (:200); `moveVisit` does not expose it.
- **Placements inside the fence are structurally one-shot.** `promiseBroken` derives from
  `dayChanged`/`timeChanged`; an unplaced row has no time to break and a day-promised
  single-day fence equals its `promised_day` — so a fence-respecting freeze never trips a
  confirm gate per row. The confirmation surface for a freeze is therefore the PLAN (the
  human gate before commit), not the rows. Conversely: `promise_level` on unplaced rows can
  only be `none` or `day` (enforced at booking and `set_promise`).
- **The three queues have different keys**: unscheduled jobs (no assignment at all — need
  `bookVisit`), person-less visits (placed or unplaced — need a technician and possibly
  times), assigned-unplaced (need only times — `moveVisit`). Pilot counts 2026-07-26: 2 / 2 /
  0. A freeze's scope definition must name which queues it drains.
- **Input coverage is still the gate**: 1 of 17 open jobs has a duration (the drafted 16-pair
  4b-1 seed is awaiting the owner's explicit go and would close most of this); 2 of 5 active
  technicians have patterns. Both inputs are fail-closed by standing user decisions — the
  freeze inherits "refuse, don't guess" and must surface what it skipped
  (`skippedNoPattern` precedent, never silent).
- **The staged-confirm home is single-slot per (tenant, kind, subjectRef)** (partial unique
  index). A whole-plan token fits as ONE review item (e.g. kind `pending_freeze`, subject =
  the manager); N per-row tokens would collide with the replace-on-restage semantics.
  **No review-item kind stores a pinned `scheduleVersion`** — the version-pinned batch
  commit remains the deliberately-unjoined halves recorded in 3b/3c.
- **The `proposed` assignment status is still designed-but-unused** (readers filter
  `['confirmed']`; overlap guard ignores `proposed`) — the schema-level staging alternative.
- **`completed` still has no writer** — nothing records that a visit happened; a freeze that
  re-places "everything not done" cannot distinguish done from not-yet except by date.
- **Migration trap for 4b-3's own schema work** (autonomy column, lat/lng storage): pilot
  migrations applied via the MCP stamp apply-time versions — `supabase migration list
  --linked` under-reports and `db push --linked` would re-apply repo files. Verify by schema
  read-back.
- **Cadence/trigger constraints recorded 2026-07-22 (addendum)**: firm cadence varies —
  the discussed shape is a manager-invoked verb with a per-run horizon argument, automation
  as a bucket-size *nudge* (and the 4b-2 decision log assigns the freeze-due nudge to Plan
  4c as the over-commitment backstop). The Telegram-only doctrine requires the trigger be
  chat/board-reachable either way.

## Decision Points

Closed since the 07-24 brief (recorded here so the plan doesn't reopen them):
**time-TBD shape** (shipped as unplaced visits, 4b-2); **duration model** (shipped as the
4b-1 ladder); **engine** (user chose ROI 2026-07-24, geocoding costs accepted).

Still open — the forks 4b-3's plan must settle:

1. **What the freeze drains.** The three queues (unscheduled jobs / person-less visits /
   assigned-unplaced), and whether it may also *re-place* promise-free placed visits — which
   forces fork 2. Each queue needs different solver inputs and commit verbs (see
   Constraints).
2. **What `locked` means for solver rows.** (a) Freeze placements land `locked: false` (the
   first unlocked rows ever written; `moveVisit` needs a `locked` override exposed) and
   `locked` becomes the recorded "pinned — won't be auto-moved" vocabulary; or (b) freeze
   placements lock like everything else and the freeze only ever drains queues, never
   re-solves its own output.
3. **Geocoding storage + lifecycle** (consequences of the made engine choice): lat/lng as an
   L3 customer attribute vs new columns; when geocoding runs (at freeze time vs at
   customer-create/address-edit); the re-geocode rule on address edits; the fail path for
   non-geocodable addresses (must surface, never silently drop a visit from the solve — the
   `skippedNoPattern` precedent).
4. **Staging and commit shape.** One `pending_freeze` review-item token holding the whole
   plan vs the unused `proposed` tier vs plain chat preview; whether the commit is
   version-pinned to `scheduleVersion` at solve time with a typed conflict on drift; and the
   mid-batch failure story (N cancel+insert windows, no rollback — today's honest per-row
   stranding vs solve-order tricks vs a resumable batch, the deferred 3c sketch).
5. **Autonomy switch semantics.** No column, no enforcement point exists. One boolean
   ("may act unprompted") vs per-capability flags; where it gates (the trigger only, or also
   batch size / promise-adjacent actions); `technician_horizon_days` + `policy.ts` is the
   recorded settings pattern (column + CHECK + one policy home + a chat verb with old→new
   echo).
6. **Trigger and cadence.** Manager-invoked verb with a horizon argument (the recorded
   2026-07-22 lean) vs a cron step in the lifecycle sweep gated by the autonomy switch vs
   nudge-only (with the nudge itself recorded as 4c's). Determines whether the autonomy
   switch has anything to gate in 4b-3 at all.
7. **Wide-fence placement behavior** (recorded open, 2026-07-25): inside a multi-day fence,
   earliest-feasible vs load-balancing vs cost-optimal-only. `find_slots` precedent: earliness
   is priority-weighted (30/15/3/1 pts/day) and its defaulted window clamps to 14 days —
   whether the freeze inherits that clamp for wide fences is part of this fork.
8. **Over-commitment math** (deferred TO 4b-3 by the 4b-2 decision log): committed minutes
   vs available minutes across a window — computed as the freeze's capacity report
   (skipped-shipment output under ROI's `penaltyCost` model) vs a standing metric surfaced
   outside freeze runs. The 4b-2 log explicitly rejected a row-count warning as "worse
   arithmetic done twice."
9. **Freeze events and pushes.** Reuse `booked`/`moved` with `actorRef: 'system'` (inherits
   today's push copy — technicians get N individual pushes per freeze) vs new event kinds
   (silent until boardNotify copy is added — room for one digest push per person); and
   whether the freeze burst forces the board worker's persistent-cursor upgrade first.
10. **The input-coverage opening move** (the 07-24 open question, still live): durations and
    patterns collected as an onboarding chore vs as the freeze's own first move ("before I
    place these 15, how long does each take?"). The pending 16-pair seed materially changes
    this fork's starting point.

## Open Questions

- Does Enterprise-tier Fleet Routing require a sales agreement to enable on our billing
  account? (Hard prerequisite; recorded 07-24, unresolved.)
- Is `GOOGLE_MAPS_API_KEY` set on the Render web service? (Open since 07-20; also gates the
  existing drive-delta term.)
- Will the 16-pair duration seed run before 4b-3 planning? (Changes the coverage numbers the
  plan starts from; awaiting the owner's go since 4b-1.)
- What cadence does the pilot manager actually run their week on? (No artifact records
  asking; shapes fork 6.)
- Does Judy's tenant participate in freeze v1? (Her tenant is schedule-empty; per-tenant
  machinery on a one-real-tenant pilot.)
- Does placing an unplaced visit via the board's Place flow vs chat vs a freeze need
  different `reason` strings for the ledger? (Cosmetic but user-visible in events; no
  convention recorded.)
