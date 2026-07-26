---
date: 2026-07-26
task: Plan 4b-3 — the freeze: human-privilege visit locks, geocoding, ROI-backed solve, manager-invoked run_freeze with staged batch commit, and the autonomy switch + cron auto-run
research: thoughts/shared/research/2026-07-26-plan-4b3-weekly-freeze-foundations.md
status: draft
---

## Overview

Build the freeze: a solve that takes the three loose queues (open jobs with no visit,
person-less visits, time-TBD visits) and places them onto real slots via Google's Route
Optimization API ("ROI"), behind a staged whole-plan confirmation — plus the lock model that
makes "don't auto-move this" a deliberate human act, and the per-tenant autonomy switch with
a cron auto-run for hands-off firms.

## Decisions

- **Scope (user, 2026-07-26): autonomy switch + cron auto-run INCLUDED** (rejected the
  defer-autonomy slice).
- **Drain scope (user): the three queues only.** The freeze never re-places anything already
  placed. Re-solve mode is a later plan.
- **Lock model (user): locking is a human privilege.** Nothing auto-locks anymore —
  `bookVisit`/`moveVisit` stop stamping `locked: true` (today they always do,
  booking.ts:507/:755); moves carry the old row's flag. `locked` now means "a manager pinned
  this; auto-scheduling must never touch it" — including on unplaced rows ("I'll place this
  myself"; the freeze skips them and says so). Managers see the state (board "Pinned" chip
  returns per the recorded 4a.5 note; chat payloads already carry `locked`) and set it via
  singular + batch verbs. Existing pilot rows are ALL auto-stamped `true` — a one-time reset
  to `false` ships with rollout (operator SQL, user-gated; they are noise, no human chose them).
- **Trigger (user): chat verb, default horizon today→+13 days**, explicit override allowed
  ("freeze through next Friday").
- **Engine (user, recorded 2026-07-24): ROI / Fleet Routing.** NEW verified fact
  (2026-07-26): ROI **cannot auth with an API key** — it requires a Google Cloud service
  account (Route Optimization Editor role) via OAuth2; "Route Optimization requests cannot
  be authenticated with end-user credentials"
  (https://developers.google.com/maps/documentation/route-optimization/client-libraries,
  https://github.com/googlemaps/js-route-optimization-app/blob/main/docs/development.md).
  A service-account JSON lands on Render; `google-auth-library` mints tokens.
- **Geocoding storage** (implementer): real columns on `customers` (`lat`, `lng`,
  `geocoded_at`) — solver hot path, structural not elastic (L3 rejected). Lazy: geocode at
  freeze time when null, persist; any writer of address columns clears them; non-geocodable
  → surfaced as skipped-with-reason, never dropped (the `skippedNoPattern` precedent).
- **Staging** (implementer): ONE `pending_freeze` review item **per tenant** (the partial
  unique index is per subjectRef, so staging must first dismiss ANY open `pending_freeze`
  kind-wide — new `findOpenReviewItemsByKind` helper — or two managers hold two plans;
  review finding 5) holding the whole plan + `scheduleVersion` pinned at solve time; confirm
  re-checks the version — drift = a clear "schedule changed, run the freeze again" error,
  never a merge. Expiry is lazy (nothing sweeps), so every gate that asks "is a token open?"
  must treat a token past its 15-min expiry as ABSENT (and dismiss it) — otherwise one
  abandoned run blocks the autonomy cron forever. The unused `proposed` tier stays unused.
- **Commit** (implementer): sequential, through the existing verbs only (every gate fires per
  row). Mid-batch failure: stop, report exactly what landed, token consumed — the remedy is
  re-running the freeze (idempotent: placed rows leave the queues).
- **Events/pushes** (implementer): committed rows reuse `booked`/`moved` (actor = the
  confirming manager, or `'system'` on autonomous runs; `detail.freezeRun: <ISO>` marker) —
  technicians get today's push copy unchanged. NEW kind `freeze_committed` + boardNotify copy
  pushes the run summary to the tenant's MANAGERS (first manager-directed push; autonomous
  runs must say what they did — the doctrine).
- **Autonomy semantics** (implementer, from the definition "may act on its own"): `on` =
  the cron solves AND commits without asking, then reports. Structurally safe under the
  doctrine because drain-only placements are all reversible one-shots: an unplaced row can
  hold promise `none`/`day` only, and a day-promise placement inside its one-day fence is
  never a break (booking.ts:639-646). Anything the solve can't place is reported, never
  forced. `off` = the cron does nothing (the freeze-due nudge is 4c's, recorded).
- **Cadence v1** (implementer): autonomous runs at most once per 24h per tenant
  (`last_auto_freeze_at` stamp), only when loose work exists and no `pending_freeze` token is
  open. Finer tuning deferred until a firm asks (recorded 2026-07-22 constraint).
- **ROI model mapping** (implementer; review-hardened): one ROI vehicle per (technician,
  working day in horizon) — pattern-having techs only; vehicle window = the day's pattern
  span, interior pattern gaps as `BreakRequest`s. Already-placed visits of vehicle-having
  techs enter as CONTEXT shipments: exact start–end window, `allowedVehicleIndices` = that
  vehicle, and a **large `penaltyCost` (never mandatory)** — a visit booked outside the
  pattern (bookings only ever warn) must degrade to a capacity warning, not an infeasible
  solve (review finding 1). Context shipments are NEVER committed. Placed visits of
  pattern-less techs are omitted entirely (those techs have no vehicle and receive no new
  work). Queue items = shipments with `penaltyCost` (skippable, reported): unplaced rows get
  fence∩horizon windows (per-day windows for ranges); a placed person-less visit gets **its
  own exact start–end as the window** — the solver only picks WHO, and the commit attaches at
  the same times (review finding 2); `duration` from the job; `allowedVehicleIndices` when a
  technician is attached. No depot: vehicles omit start/end locations (recorded limitation:
  home→first-job drive invisible). Naive-local ↔ RFC3339 only at the API boundary.

## Plain-language walkthrough

**Phase 1 — locks become a choice.** Today the system quietly marks every visit you book as
"pinned" — a flag meant to tell a future scheduler "hands off," stamped so universally it
means nothing. This phase flips it: nothing is pinned unless a person pins it. You get chat
verbs to pin/unpin one visit or a whole week ("lock everything next week"), the board shows
a small **Pinned** chip, and the visit sheet gets a toggle. You'd notice: book a visit, the
agent mentions it's not pinned; say "pin it," the chip appears.

**Phase 2 — the map layer.** Google's solver needs coordinates, not street addresses. This
phase adds latitude/longitude columns to customers and a translator (Google's Geocoding API)
that fills them the first time each customer is needed. Invisible day-to-day; you'd notice it
only in a freeze preview saying "skipped: address couldn't be located" for a bad address.

**Phase 3 — the solver harness.** The pure machinery that turns "these 6 loose visits, these
2 technicians, these working hours, these day fences" into a Google solve request and reads
the answer back as a placement plan. No writes, no chat surface — just a well-tested engine.

```
 loose queues ─┐
 patterns/time off ─┤→ freezeSolve → ROI (service acct) → plan: placements + skipped + capacity
 placed visits ─┘        (fences → time windows, durations, pinned rows skipped)
```

**Phase 4 — the freeze itself.** A `run_freeze` chat verb: the agent shows you the whole
proposed plan — who goes where when, what couldn't be placed and *why* (no length set, no
working pattern, pinned, address failed), and each technician's committed-vs-available hours
— then books it all in one confirmed go. Placing never breaks a promise (day-fenced visits
land inside their fence), so the only gate is your yes to the plan.

**Phase 5 — hands-off mode.** A per-firm switch: `autonomy on` lets the nightly sweep run
the freeze by itself when loose work is waiting — it commits, then messages the manager
"freeze ran: placed 4, skipped 1 (no duration)." `off` (the default) = nothing ever runs
unasked.

## Secrets & env preflight

- **Phase 2:** `GOOGLE_MAPS_API_KEY` in `.env` (already present locally) — **user must
  confirm** (a) it's set on the Render web service (open question since 07-20) and (b) the
  **Geocoding API is enabled** on the Google Cloud project (console → APIs & Services).
- **Phase 3:** `GOOGLE_ROUTES_SA_KEY_JSON` in `.env` (NEW) — a service-account key JSON
  (console → IAM → Service Accounts → create, grant **Route Optimization Editor**, create
  JSON key; paste the JSON as the env value). Also: **Route Optimization API enabled**, and
  the user's recorded open question — **does Enterprise-tier Fleet Routing enable without a
  sales agreement?** Check in console billing BEFORE this phase; if it needs a contract, stop
  and surface.
- **Phase 5:** both Google vars must ALSO be set on the **Render cron service** (review
  finding 8 — `runLifecycle` runs there, not on the web service; without them the autoFreeze
  step key-gates itself off).
- **Phases 1/4:** none new. Phase 2/5 migrations touch the pilot only on explicit user go.

`npx supabase start` running for every phase (`.env.test`, per CLAUDE.md).

## Phase 1: Human-privilege locks

### What this phase does
Stops auto-locking, adds the lock verbs (chat: singular + batch; board: sheet toggle), the
board Pinned chip, `lock_updated` ledger events, and the freeze-facing meaning ("locked =
skip in auto-scheduling") as recorded doctrine. Independently shippable.

### Changes required

**`src/schedule/booking.ts`**
- `bookVisit` (:507): drop `locked: true` → rows default `false` (createAssignment default,
  assignments.ts:80). `moveVisit` (:755): drop the override so `rescheduleAssignment` carries
  the old row's flag (assignments.ts:200). `attachUnplacedVisit` already carries (:965).
- New shared core `setVisitLocks(tenantId, selector, locked, actorRef)`:
  `selector = { assignmentIds: string[] } | { from: string; to: string; technicianRef?: string }`.
  Range selects confirmed rows whose day intersects [from,to] — placed by start-day, unplaced
  by fence overlap. Refuse an empty resolution ("nothing matched"). Per-row update via a new
  `updateAssignmentLocked` in `src/db/assignments.ts`; ONE `lock_updated` event per run
  (detail: `{ locked, assignmentIds, from?, to? }`) — batch = one ledger entry, not N.
- Reversible + internal → one-shot, no confirmation (doctrine).

**`src/mcp/server.ts`**
- New tool `set_visit_locks` (manager-only): args mirror the selector + `locked: boolean`.
  Description: locked = "pinned — automatic scheduling will never place, move, or consider
  this visit; unpinning is how you hand it back". Echo count + days touched. Update
  `get_team_schedule`/`book_visit` descriptions: `locked` renamed in copy to "pinned",
  booked results mention "not pinned — say 'pin it' to keep the scheduler's hands off".
- Rollout note: tool-list change ⇒ fleet gateway restarts + wire pass (AGENTS.md doctrine
  block gains one line on pinning).

**`src/telegram/boardApi.ts` + `web/board/board.js`**
- `/board/api/lock` (manager, one-shot): `{ assignmentId, locked }` → the shared core.
- Sheet: "Pinned" row with toggle (uses existing `locked` in VisitDetail, boardRead.ts:413);
  day-grid + strip cards get a small 📌/"Pinned" chip (payloads already carry it,
  boardRead.ts:54/:213). Replaces the removed-in-4a.5 badge with the now-true meaning.

**Pilot data reset (rollout, user-gated):** `update assignments set locked = false where
status in ('confirmed','proposed')` — auto-stamped noise, no human chose them.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] booking.test.ts: booked + moved rows land `locked:false`; a move of a locked row keeps it
- [ ] EXISTING pins flipped (review finding 6): boardApi.test.ts:295/:458 and
      server.test.ts:3681 assert `locked: true` on verb-created rows — update to `false`
      (or explicit-lock fixtures); booking.test.ts:98/:352/:523 likewise
- [ ] new setVisitLocks tests: ids path, range path (placed + unplaced fence overlap), empty
      refusal, `lock_updated` event shape
- [ ] server.test.ts: `set_visit_locks` both selectors; boardApi.test.ts: `/lock` toggle + tier gate

### Live verification (agent-executable)
Deferred to Phase 5 rollout (no pilot schema change in this phase).

### Manual verification
- [ ] Pinned chip renders on a locked visit (day grid + sheet); toggle flips it

---
*Pause: manual item above (one phone glance) — confirm before Phase 2.*

## Phase 2: Geocoding

### What this phase does
Coordinates for customers: migration, Geocoding API client, lazy fill, invalidation on
address writes, fail path.

### Changes required
- **Migration** `customers_geocoding.sql`: `lat double precision`, `lng double precision`,
  `geocoded_at timestamptz` (all nullable). LOCAL now; pilot on user go (MCP apply stamps its
  own version — verify by read-back, recorded trap).
- **`src/routes/geocode.ts`** (new): `geocodeAddress(text, deps): Promise<{lat,lng} | null>`
  — Geocoding API, `GOOGLE_MAPS_API_KEY`, injectable transport (googleRoutes idiom); null on
  ZERO_RESULTS, throw on transport errors. `ensureCustomerCoords(customer)` — returns stored
  coords, else geocodes `formatAddress(...)` output, persists via new
  `updateCustomerCoords` in `src/db/customers.ts`, returns null when address absent/unlocatable.
- **Invalidation:** implementer greps writers of `address_line1/2|city|state|postal_code`
  (expected: `createCustomer` inserts; check the capture write path for address updates) and
  clears `lat/lng/geocoded_at` in the same update. If no updater exists, record that as the
  finding.

### Automated verification
- [ ] gates; geocode tests (fake transport: success persists + reuses without re-call;
      ZERO_RESULTS → null, nothing persisted; missing address → null, no API call)
- [ ] schema test: columns exist, nullable

### Live verification — deferred to Phase 5 rollout. Manual: none.
---

## Phase 3: ROI client + freeze solve

### What this phase does
The pure solve: queues + capacity in, placement plan out. No chat surface, no writes.

### Changes required
- **`src/routes/roiClient.ts`** (new): `optimizeTours(model, deps)` → POST
  `https://routeoptimization.googleapis.com/v1/projects/{PROJECT_ID}:optimizeTours`; OAuth2
  Bearer via `google-auth-library` (`GoogleAuth` from `GOOGLE_ROUTES_SA_KEY_JSON`, scope
  `https://www.googleapis.com/auth/cloud-platform`); injectable transport + token minting;
  `GOOGLE_CLOUD_PROJECT_ID` read from the SA JSON's `project_id`. NEW dep:
  `google-auth-library` (explicit, though `googleapis` already vendors it).
- **`src/schedule/freezeSolve.ts`** (new): `assembleFreezeInputs(tenantId, horizonFrom,
  horizonTo)` — the three queues (`listUnscheduledOpenJobsWithCustomer` — customer NAME only
  is embedded, so geocoding queue-1 needs a per-row `getCustomer` for the address, review
  finding 11; `listUnassignedAssignmentsWithRefs`; `listUnplacedAssignedForRange`),
  skip-and-record: locked rows, no-duration jobs (ladder remedy text), no-pattern techs
  (`assembleFitContext` precedent), no-coords customers (Phase 2), and beyond-horizon
  person-less rows (that reader is unbounded above — filter + report; the assigned-unplaced
  reader is range-bounded, so wholly-outside rows simply aren't in the run — no skip line
  for them, review finding 10). Then
  `solveFreeze(inputs, deps)` → build the ROI model per the Decisions mapping → parse routes
  into `FreezePlan { placements: {assignmentId?, jobId, technicianRef, date, startTime,
  endTime}[], skipped: {ref, reason}[], capacity: {technicianRef, committedMin, availableMin}[] }`
  (skipped shipments from the response join the input-side skips). RFC3339↔naive-local at
  this boundary only.

### Automated verification
- [ ] gates; freezeSolve tests with a FAKE transport: model shape (windows from fences,
      breaks from split patterns, fixed shipments for placed rows, allowedVehicleIndices for
      assigned rows, penaltyCost present), response parsing, every skip reason, capacity math
- [ ] roiClient test: auth header minted from fake key, error propagation

### Live verification — none here (first live call is Phase 4's E2E). Manual: none.
---

## Phase 4: run_freeze — stage and commit

### What this phase does
The manager-facing verb: solve → staged plan → confirm → sequential commit → summary.

### Changes required
- **`src/db/reviewItems.ts`**: kind `'pending_freeze'` + `findOpenReviewItemsByKind` (the
  kind-wide, tenant-wide lister — see Staging decision).
- **`src/schedule/booking.ts`** (review finding 3 — the markers are unimplementable without
  this): `BookVisitInput` and `MoveVisitInput` gain optional `eventDetailExtra?: Json`,
  merged into the `booked`/`moved` event detail (spread last, never overriding computed
  keys). `bookVisit` also gains optional `reason?` recorded in the detail.
- **`src/schedule/freezeCommit.ts`** (new — review finding 8: lifecycle must not import the
  MCP handler): `commitFreezePlan(tenantId, plan, actorRef)` — sequential per placement:
  unscheduled job → `bookVisit`; person-less placed → `moveVisit` (SAME times +
  `technicianRef`); unplaced → `moveVisit` (date + times). Every call carries
  `reason: 'freeze <runDate>'` + `eventDetailExtra: { freezeRun }`. **Belt (review finding
  9): before each `moveVisit`, `previewMoveVisit` — any `promiseBroken: true` placement is
  SKIPPED and reported, never committed** (the autonomy-safety claim must not rest on window
  construction alone). Row failure: stop, return partial summary. Ends with the
  `freeze_committed` event.
- **`src/mcp/server.ts`**: tool `run_freeze` (manager-only). No args → horizon today→+13
  (firm-local); `throughDate` overrides (≥ today, cap 31 days). Solve → dismiss any open
  `pending_freeze` kind-wide → stage ONE item (detail: plan + `scheduleVersion` + horizon) →
  preview: placements (day, server-computed weekday, time, who, customer),
  skipped-with-reasons, capacity lines, `requiresConfirmation: true`. Confirm: expiry check,
  version recheck (drift → consume + "the schedule changed — run the freeze again"), then
  `commitFreezePlan`. **Add `pending_freeze` to `STAGED_ACTION_KINDS` (server.ts:5006-5015)
  as dismiss-only** — review finding 4: without it, `resolve_review_item` silently
  "resolves" the token while booking nothing.
- **`src/telegram/boardNotify.ts`**: copy for `freeze_committed` → push to every ACTIVE
  manager-tier binding (new `listManagersWithTelegram` in technicians.ts): "Freeze ran (by
  {actor}): placed N, skipped M — see the board."

### Automated verification
- [ ] gates; server.test.ts suite: stage→confirm happy path (rows read back placed+unlocked,
      queues drained), version-drift refusal, skip reporting (locked row stays untouched),
      partial-failure honesty (fake solver + a forced verb failure), horizon default + cap
- [ ] boardNotify test: `freeze_committed` pushes to managers only

### Live verification (agent-executable) — the Phase-5-style rollout E2E, run AFTER deploy:
- Prerequisites: `supabase-test` MCP; s2 CLI probe; SA key + APIs enabled on the Google
  project; **the Phase-1 pilot lock reset has run** (review finding 7: every pre-existing
  row carries an auto-stamped lock — without the reset the freeze legitimately skips the
  whole backlog and the E2E is inconclusive).
- [ ] Seed durations/patterns confirmed (16-pair seed + `set_availability`); then from live
      chat: `run_freeze` → preview names placements + skips; confirm → SQL read-back of
      placed rows (times set, `locked=false`, ledger `freezeRun` markers); restore by
      unscheduling the probe placements. Evidence: chat exchange + row read-backs.

### Manual verification
- [ ] The proposal reads sensibly on the phone (a judgment call: would you approve it?)
---
*Pause after Phase 4 for the manual read + the live E2E gate.*

## Phase 5: Autonomy switch + cron auto-run

### What this phase does
The per-tenant switch, its chat verb, and the daily hands-off run.

### Changes required
- **Migration** `tenant_autonomy.sql`: `tenants.autonomous_freeze boolean not null default
  false`, `tenants.last_auto_freeze_at timestamptz` (nullable).
- **`src/db/tenants.ts`**: `setAutonomousFreeze(tenantId, on)`,
  `listAutonomousFreezeTenants()`, `stampAutoFreeze(tenantId)` (review finding 8 — none
  exist; horizon-setter idiom).
- **`src/mcp/server.ts`**: tool `set_autonomy` (manager-only, one-shot, old→new echo):
  description states exactly what `on` unlocks ("the assistant may run the freeze by itself,
  at most daily, and reports every run") — never oversells beyond the freeze.
- **`src/jobs/lifecycle.ts`**: step 5 `autoFreeze`: for `listAutonomousFreezeTenants()`
  where (`last_auto_freeze_at` null or >24h) and loose work exists and no LIVE (unexpired)
  `pending_freeze` — expired tokens count as absent and are dismissed (the Staging
  decision's deadlock rule) → `solveFreeze` + `commitFreezePlan` with `actorRef: 'system'`
  (no staging token), stamp via `stampAutoFreeze`, manager push via `freeze_committed`.
  Key-gated like steps 3/4: missing `GOOGLE_ROUTES_SA_KEY_JSON`/`GOOGLE_MAPS_API_KEY` →
  step skips cleanly, never a permanently red cron. Isolated-step idiom.

### Automated verification
- [ ] gates; lifecycle test: on/off gating, 24h stamp, no-loose-work no-op, open-token no-op,
      system actor on events; tenants schema test

### Live verification (agent-executable)
- Prerequisites: as Phase 4.
- [ ] Pilot rollout (user-gated migrations first, deploy, fleet restarts + wire pass for the
      new tools): `set_autonomy on` via chat → echo; flip back off after observing one
      cron-window behavior (or verify gating via SQL stamp read-back). Evidence: echoes + rows.

### Manual verification
- [ ] Manager push copy for an autonomous run reads right on the phone
