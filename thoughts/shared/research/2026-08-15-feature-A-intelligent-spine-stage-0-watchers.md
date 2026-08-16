---
date: 2026-08-15
branch: docs/agent-first-front-door
commit: 6d4684c
topic: Feature A — Intelligent-spine Stage 0 ("the watchers"): deterministic gap detectors over the spine on the existing 15-minute Render cron, surfacing into existing channels only
direction: thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md
---

## Summary

"Stage 0" of the intelligent-spine direction wants plain SQL-shaped detectors that run on the
cron heartbeat we already have, notice that something in the customer/job record is *missing*,
and surface that into channels that already exist — the manager's pending-review queue and the
Telegram push/digest path. No new agent, no new identity, no model call.

This document maps what exists today for exactly that. In plain language: the heartbeat is a
single Node script (`src/jobs/lifecycle.ts`) that Render runs every 15 minutes; it already
performs seven sweeps and reports one JSON line. The pending-review queue is a real table
(`review_items`) with a "one open item per tenant+kind+subject" rule that makes repeat detection
naturally idempotent. The push path is a separate always-on worker that polls the schedule's
event log and fans canned Telegram messages out to managers; there is a per-tick burst digest
but **no periodic/scheduled digest anywhere in the codebase today** — every "digest" the
direction doc refers to is either that burst collapse or a plan not yet built.

The single most consequential finding is about the archetype detector itself. The schedule lives
in the `assignments` table, whose status enum has a `completed` value and a legal
`confirmed → completed` edge — **and no production code path ever walks that edge.** The only
status write in the whole repo is `'cancelled'`. So "the scheduled end passed and the status
never changed" is not an anomaly in this system; it is the condition of *every* past visit. A
live read of the pilot database confirms it: 67 of 67 confirmed assignments whose end time has
passed carry no status change and no capture linked to their job. A detector written literally to
the archetype would fire on 100% of history on its first tick.

## Entry Points

| Entry point | File / line | What begins here |
|---|---|---|
| The 15-minute pulse | [src/jobs/lifecycle.ts:287-304](src/jobs/lifecycle.ts#L287) (`main`), [:95](src/jobs/lifecycle.ts#L95) (`runLifecycle`) | The one scheduled entrypoint. `npm run job:lifecycle` → `node dist/jobs/lifecycle.js`; Render cron `*/15 * * * *` |
| The pending-review queue (write) | [src/db/reviewItems.ts:69-91](src/db/reviewItems.ts#L69) (`upsertOpenReviewItem`) | Every "flag this for the manager" path |
| The pending-review queue (read) | [src/mcp/server.ts:669](src/mcp/server.ts#L669) (tool def), [:6583](src/mcp/server.ts#L6583) (handler) | `list_pending_reviews` — what a manager's agent sees |
| Manager push (one-liner) | [src/calls/notify.ts:11-24](src/calls/notify.ts#L11) (`notifyManagers`) | Best-effort Telegram fan-out to every active bound manager |
| Schedule-event push worker | [src/telegram/boardNotify.ts:248-306](src/telegram/boardNotify.ts#L248) (`pollOnce`) | Separate long-running worker (`npm run board:worker`), not the cron |
| The schedule itself | `assignments` table — [supabase/migrations/20260704210155_scheduling_foundation.sql:51-79](supabase/migrations/20260704210155_scheduling_foundation.sql#L51) | Where "a visit's scheduled end" actually lives |
| The agent-readable schedule view | `v_schedule` — [supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql:30-58](supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql#L30) | Confirmed + completed only, tenant-scoped by GUC |

## Key Files

### The pulse

- **[src/jobs/lifecycle.ts](src/jobs/lifecycle.ts)** — the whole heartbeat, 305 lines. Exports
  `runLifecycle(nowIso, deps)` and the `LifecycleDeps` / `LifecycleSummary` interfaces. Seven
  steps run in a fixed order (the header comment at [:19-43](src/jobs/lifecycle.ts#L19) is the
  authoritative description): pairing sweep, grace expiry, Composio session provisioning,
  execution-log ingestion, Brave cost backfill, DeepInfra bill collection, cost rollup. Every
  step is wrapped in its own try/catch and contributes a field to one summary object; a failing
  step sets `ok:false` (→ exit 1 → Render marks the run failed) but never blocks its siblings.
  Two established shapes a new step would copy:
  - **`{ skipped: '…' }` is not an error** — used when a key is unset or a migration has not
    landed yet, so a deploy that precedes a migration does not turn the heartbeat permanently red
    ([:218-224](src/jobs/lifecycle.ts#L218)).
  - **Every collaborator is injectable via `deps`** ([:45-58](src/jobs/lifecycle.ts#L45)), which
    is why [src/jobs/lifecycle.test.ts](src/jobs/lifecycle.test.ts) (491 lines) is a pure unit
    test with no database.
  - **Iteration is roster-wide, not tenant-wide.** Steps 1/3/4 iterate
    `listTechniciansInStates([...])` ([src/db/technicians.ts:198-208](src/db/technicians.ts#L198)),
    which has **no tenant filter** — it returns every matching row across all tenants. Steps 5-7
    are global too. There is presently **no per-tenant loop in the cron**;
    `listTenantSeats()` ([src/db/tenants.ts:65-87](src/db/tenants.ts#L65)) is the only existing
    tenant enumerator and it lives in the cost/admin path.

### The gap surfaces that already exist

- **[src/db/reviewItems.ts](src/db/reviewItems.ts)** — the pending-review queue's typed layer.
  - `ReviewKind` ([:10-53](src/db/reviewItems.ts#L10)) is a **compile-time union over a free-text
    DB column** — a new kind needs no migration, only a line here.
  - `upsertOpenReviewItem` ([:69-91](src/db/reviewItems.ts#L69)) is insert-then-catch-23505,
    because supabase-js cannot express `onConflict` against a *partial* unique index. On conflict
    it returns the existing open row. This is the core idempotency primitive: **calling it every
    15 minutes for the same subject produces one row, not 96 a day.**
  - Two richer dedup idioms already exist for cases where "one open row" is not enough:
    - *any-status, keyed on a detail field* — `flagUnknownRefCapture`
      ([:100-127](src/db/reviewItems.ts#L100)) keys on `detail->>externalId` so a message the
      manager already resolved never re-opens.
    - *once per episode, with supersede* — `flagOffboardingReminder`
      ([:230-263](src/db/reviewItems.ts#L230)) keys on `detail->>startedAt`, and explicitly closes
      a stale open item from a previous episode before inserting the new one. This is the closest
      existing precedent for a recurring watcher that must re-fire on a genuinely new occurrence
      but stay silent on the same one.
  - `listOpenReviewItems(tenantId)` ([:329-338](src/db/reviewItems.ts#L329)) — what
    `list_pending_reviews` returns, oldest first, **unpaginated and uncapped**.
- **[supabase/migrations/20260702194603_technicians_and_review_items.sql:56-72](supabase/migrations/20260702194603_technicians_and_review_items.sql#L56)**
  — the table and `uq_review_items_open` (unique on `(tenant_id, kind, subject_ref) where status =
  'open'`). `subject_ref` is plain text with no FK, so it can hold an assignment id, a job id, a
  capture id, or a roster ref.
- **[src/mcp/server.ts:6645-6740](src/mcp/server.ts#L6645)** — `resolve_review`. Kinds fall into
  two classes: **staged-action tokens** (listed in the local `STAGED_ACTION_KINDS` map at
  [:6700-6712](src/mcp/server.ts#L6700), plus five hard-coded `if` blocks above it) which may only
  be *dismissed* here, and everything else, which the manager may resolve or dismiss freely. A
  watcher-produced item is naturally in the second class — it stages no action.

### The notification surfaces

- **[src/calls/notify.ts](src/calls/notify.ts)** — `notifyManagers(tenantId, text)`. Sends one
  line to every active manager with a Telegram binding. **Never throws**: the durable record is
  the review item; a Telegram blip must not fail the thing being notified about. This is the
  simplest existing "surface it to the manager" call and is what the money plan's Phase 3 assumes.
- **[src/telegram/boardNotify.ts](src/telegram/boardNotify.ts)** — the schedule-change pusher.
  Runs in the **board worker** ([src/telegram/boardWorker.ts](src/telegram/boardWorker.ts)), an
  always-on Render service, **not** the cron. `pollOnce(lastSeen)` walks `schedule_events` since
  an **in-memory** per-tenant cursor and fans canned copy out. The "digest" here is a *burst
  collapse*: more than `DIGEST_THRESHOLD = 3` ([:44](src/telegram/boardNotify.ts#L44)) messages
  owed to one recipient in one tick become one bulleted message capped at
  `DIGEST_MAX_LINES = 12` ([:47](src/telegram/boardNotify.ts#L47)). Recorded limitation: the
  cursor is in-memory, so a restart seeds at the current version and pre-boot events are never
  pushed ([:244-247](src/telegram/boardNotify.ts#L244)).
- **[src/db/technicians.ts:96-141](src/db/technicians.ts#L96)** —
  `listTenantIdsWithTelegramBindings()` (the worker's tenant enumerator) and
  `listManagersWithTelegram(tenantId)`. Both apply the liveness filter; deactivation does not clear
  `telegram_user_id`, so every push surface must filter on state.
- **[src/db/opsEvents.ts](src/db/opsEvents.ts)** + **[supabase/migrations/20260813000000_ops_events.sql](supabase/migrations/20260813000000_ops_events.sql)**
  — the closest thing in the repo to a *watcher's* durable state model, built for box health.
  Its stated doctrine is directly applicable: **one row per incident, not per tick**; the reporter
  is stateless and re-asserts current truth every tick; the *server* folds observations into
  open/close transitions; a partial unique index (`where closed_at is null`) is the real guarantee,
  not the read-then-insert. The migration comment says it outright: *"any notifier built on it
  would fire six times and get muted. Suppression is the feature, not an optimisation."*
  Note it is **host-scoped** (`host_id references hosts(id)`), so it cannot host tenant-scoped
  watcher state without a schema change.

### The spine data a watcher would read

- **[supabase/migrations/20260620005307_context_spine.sql](supabase/migrations/20260620005307_context_spine.sql)**
  — L1 `raw_captures` (append-only, trigger-enforced, [:116-119](supabase/migrations/20260620005307_context_spine.sql#L116)),
  L2 `customers → jobs → visits`, L3 `attributes` JSONB on each L2 row. `raw_captures` carries
  nullable `customer_id` / `job_id` / `visit_id` back-links.
- **[supabase/migrations/20260704210155_scheduling_foundation.sql:51-79](supabase/migrations/20260704210155_scheduling_foundation.sql#L51)**
  — `assignments`: the actual schedule. `starts_at` / `ends_at` are **immutable per row** (a
  reschedule is cancel + insert), `status` is the only mutable business field, and a GiST exclusion
  constraint forbids two overlapping *confirmed* rows for one technician.
- **[supabase/migrations/20260714120000_schedule_core_promise_ladder.sql](supabase/migrations/20260714120000_schedule_core_promise_ladder.sql)**
  — the promise ladder (`promise_level`, `promised_day`, `locked`), the append-only
  `schedule_events` log, and — at [:11-15](supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L11) —
  the **naive-local storage convention** (see Constraints).
- **[src/db/assignments.ts](src/db/assignments.ts)** — 798 lines, the schedule's typed layer.
  `ASSIGNMENT_TRANSITIONS` ([:22-27](src/db/assignments.ts#L22)),
  `updateAssignmentStatus` ([:111-146](src/db/assignments.ts#L111)),
  `listAssignmentsForTenant` ([:340-357](src/db/assignments.ts#L340)),
  `listUnassignedAssignments` ([:507-525](src/db/assignments.ts#L507)),
  `listUnscheduledOpenJobsWithCustomer` ([:766-785](src/db/assignments.ts#L766)) — the last is the
  **single body** for the "job has a live assignment" predicate, deliberately anti-joined in JS.
  There is **no existing lister for past/overdue assignments**; every time-window reader takes an
  explicit `[fromISO, toISO)`.
- **[src/db/jobs.ts:30-38](src/db/jobs.ts#L30)** — `ALLOWED_TRANSITIONS`, the job state machine.
  The money-ledger work added two backward edges (`completed → in_progress`,
  `invoiced → completed`) so ledger-derived status stays undoable.
- **[src/db/rawCaptures.ts](src/db/rawCaptures.ts)** — `captureHasLinkedL2`
  ([:136](src/db/rawCaptures.ts#L136)), `listRawCapturesForJob` ([:153](src/db/rawCaptures.ts#L153)),
  `captureHasLinkedVisit` ([:169](src/db/rawCaptures.ts#L169)). Note the comment at
  [:151-152](src/db/rawCaptures.ts#L151): captures resolved via `L2.source_capture_id` do **not**
  appear in `listRawCapturesForJob` — "captures on this job" has two homes and reading only one
  under-counts.
- **[src/db/context.ts:96-134](src/db/context.ts#L96)** — `getCustomerContext`'s `upcomingVisits`,
  added 2026-08-13 after an eval found the aggregate read only `visits` (past evidence) and
  reported "no visits scheduled" for customers with four confirmed bookings. Same class of mistake
  a watcher can make: **`visits` and `assignments` are different things.**

### The write path (why gaps appear at all)

- **[src/writePath/recordFieldNote.ts](src/writePath/recordFieldNote.ts)** — L1 → extract → match
  → L2. Critically, at [:266-274](src/writePath/recordFieldNote.ts#L266) it creates a **new
  `visits` row per note** — *"The visit is this note's trip."* It does **not** touch, reference, or
  close the `assignments` row the technician was scheduled on. Job status advances only when the
  extractor emits a `statusSignal` that is legal for the current status
  ([:283-288](src/writePath/recordFieldNote.ts#L283), gated by `NOTE_SIGNAL_TRANSITIONS` at
  [:89-95](src/writePath/recordFieldNote.ts#L89)).
- **[src/writePath/identityMatch.ts:73-113](src/writePath/identityMatch.ts#L73)** — the schedule
  branch: it consults confirmed assignments for that technician on the capture's **firm-local**
  day, and if exactly one has an address, proposes it for confirmation. It resolves the assignment
  to its `jobId` and `customerId` and then **discards the `assignmentId`** except as a display hint
  in `suggestion` ([:127-132](src/writePath/identityMatch.ts#L127)). So even the one place that
  knows "this note is about that scheduled visit" does not persist the link.

## Data Flows

### Today: the pulse, and where a watcher step would sit

```
Render Cron  */15 * * * *
      │  node dist/jobs/lifecycle.js
      ▼
runLifecycle(nowIso)                          ← src/jobs/lifecycle.ts:95
  1 pairing sweep ────────► technicians (roster-wide, no tenant loop)
  2 grace expiry  ────────► technicians / Composio
  3 session provisioning ─► Composio          (skipped if COMPOSIO_API_KEY unset)
  4 execution-log ingest ─► raw_captures (L1)  (same key gate)
  5 Brave cost backfill ──► cost_events
  6 DeepInfra bill  ──────► infra_costs
  7 cost rollup     ──────► tenant_cost_rollup
      │                                        ┌── a Stage-0 watcher step would
      ▼                                        │   land here: read spine → upsert
  JSON summary → stdout; ok:false → exit 1     └── review_items → notifyManagers
```

### Today: how a manager learns anything

```
review_items (durable)                    schedule_events (durable, append-only)
      │                                            │
      │ list_pending_reviews (PULL —               │ board worker polls, in-memory cursor
      │ the manager must ask)                      ▼
      ▼                                     boardNotify.pollOnce
manager's agent, in Telegram                       │ canned copy per event kind
                                                   │ >3 to one person ⇒ burst digest
                                                   ▼
                                            sendBoardMessage → Telegram

notifyManagers(tenantId, text)  ← one-line PUSH to every active bound manager
   used today only by the inbound-call router (src/calls/worker.ts)
```

**There is no scheduled/periodic digest in the codebase.** The burst digest above is per poll
tick; the "weekly money digest" exists only as a plan
([2026-08-15-money-inference-v1.md:53-57](thoughts/shared/plans/2026-08-15-money-inference-v1.md#L53)),
and would introduce cadence state as a new `tenants.money_digest_last_sent_at` column.

### The archetype gap, traced through the actual tables

The direction doc's archetype is *"a visit's scheduled end passed hours ago with no status change
and no linked capture."* Each of the three clauses lands on a different object:

```
  assignments row              jobs row                  raw_captures / visits
  ───────────────              ────────                  ─────────────────────
  ends_at  (naive-local)  ──┐
  status='confirmed'        │  job_id ──►  jobs.status   ◄── advanced ONLY by a note's
                            │              (open/…)          statusSignal
                            │                    ▲
                            │                    │ recordFieldNote
                            └────────────────────┴──── creates a NEW visits row
                                                       + a raw_captures row
                                                       linked to the JOB,
                                                       NEVER to the assignment
```

There is **no foreign key from `visits` or `raw_captures` to `assignments`.** Confirmed by
schema and by grep: `assignment_id` appears only on `schedule_events`
([src/db/database.types.ts:1298](src/db/database.types.ts#L1298)). The only join available to a
watcher is `assignments.job_id = raw_captures.job_id` (or `visits.job_id`), which is
**many-to-many in practice**: one job can have several assignments (reschedules create rows), and
one capture on a job cannot say *which* visit it reports on.

### Measured: what the archetype detector would actually find (pilot DB, read-only, 2026-08-16 05:04 UTC / 22:04 firm-local)

Queried live against the pilot database (`supabase-test` = the deployed pilot's live DB; SELECT
only, no writes).

| Tenant | confirmed | cancelled | completed | unplaced (no times) |
|---|---|---|---|---|
| Default Tenant (pilot demo data) | 149 | 94 | **0** | 4 |
| spine-eval-main (eval world) | 138 | 3 | 62 | 4 |
| spine-eval-other | 1 | 0 | 0 | 0 |

The 62 `completed` rows in `spine-eval-main` are **fixture data**: `scripts/spine-eval/world.mjs`
passes `status: v.status` straight into `createAssignment`
([world.mjs:432-446](scripts/spine-eval/world.mjs#L432)). No production path produces them.

Overdue confirmed placed assignments (`ends_at` < firm-local now):

| Tenant | overdue | >2h overdue | >24h overdue | still future |
|---|---|---|---|---|
| Default Tenant | 67 | 67 | 57 | 78 |
| spine-eval-main | 30 | 30 | 27 | 104 |

And the "no linked capture" leg, over those >2h-overdue rows:

| Tenant | overdue | job has *any* capture | capture after `ends_at` | job has a `visits` row | visit after `ends_at` |
|---|---|---|---|---|---|
| Default Tenant | 67 | 2 | **0** | 2 | **0** |
| spine-eval-main | 30 | 0 | 0 | 0 | 0 |

**Every single overdue visit in the pilot satisfies all three clauses of the archetype.** Supporting
context for the same tenant: 163 jobs of which 0 are `in_progress`, 0 `completed`, 1 `invoiced`,
6 `cancelled` (so ~156 still `open`); 7 `visits` rows total; 51 captures, the most recent
`technician_note` dated 2026-07-21; 37 customers; 3 active managers with Telegram bindings;
7 open review items (6 `unlinked_call`, 1 `call_action`) against **54 review items ever created**
in the tenant's whole history.

Other candidate detectors, measured on the same data:

| Candidate gap | Default Tenant | spine-eval-main |
|---|---|---|
| Open jobs with no live (proposed/confirmed) assignment | 8 | 45 |
| Unplaced confirmed rows whose `latest_date` window expired | 0 | 0 |
| Past-dated confirmed assignments with nobody assigned | 1 | 0 |
| Jobs stuck `in_progress` | 0 | 0 |

## External Dependencies

- **Render** — hosts the cron job (`*/15 * * * *`, at most one concurrent run, per the header
  comment at [src/jobs/lifecycle.ts:19-21](src/jobs/lifecycle.ts#L19)) and the always-on board
  worker. The schedule is configured in the Render dashboard; **there is no `render.yaml` in this
  repo**, so cron configuration is not in version control. Recorded traps
  ([docs/engineering-memory.md §3](docs/engineering-memory.md)): the "Redeploy" button re-runs the
  *old* commit, and **nothing auto-applies DB migrations to the pilot**.
- **Supabase / PostgREST** — all DB access via `src/db/` and the service-role key. PostgREST
  silently caps responses at 1000 rows (`db-max-rows`); `listTenantSeats` pages around it, most
  other listers do not.
- **Telegram Bot API** — one global board bot (`@DashboardMan_bot`) for pushes; `sendMessage` has a
  4096-character limit, which is why `DIGEST_MAX_LINES` exists.
- **Composio** — irrelevant to detection, but note steps 3/4 of the cron skip cleanly when
  `COMPOSIO_API_KEY` is unset; a watcher step needs no key at all.
- No model provider is involved in Stage 0 by definition.

Nothing in Stage 0 requires a third-party doc check, since detection is pure SQL over our own
schema. (CLAUDE.md's "verify against live docs" rule bites at Stage 1, when the transport question
returns.)

## Constraints and Invariants

1. **Nothing ever completes an assignment.** `assignment_status` includes `completed` and
   `ASSIGNMENT_TRANSITIONS` permits `confirmed → completed`
   ([src/db/assignments.ts:22-27](src/db/assignments.ts#L22)), but the only calls to
   `updateAssignmentStatus` in the repo pass `'cancelled'`
   ([src/schedule/booking.ts:940](src/schedule/booking.ts#L940),
   [:1039](src/schedule/booking.ts#L1039), [:1419](src/schedule/booking.ts#L1419)). Grep for
   `'completed'` finds no other writer. `v_schedule` deliberately includes `completed`
   ([the 2026-08-12 migration](supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql#L57))
   for a status that only fixtures produce. **"Status unchanged after the end time" therefore
   describes the entire past schedule, not an anomaly.**
2. **Assignment timestamps are naive-local; `created_at`/`captured_at` are real UTC.** The
   convention is recorded at
   [20260714120000_schedule_core_promise_ladder.sql:11-15](supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L11)
   and implemented by `naiveLocalISO` ([src/schedule/booking.ts:55-57](src/schedule/booking.ts#L55)):
   the firm's wall clock written *as if* UTC, so the `+00` on the wire is a lie
   ([src/db/assignments.ts:566](src/db/assignments.ts#L566)). Any "has it passed yet?" comparison
   must convert real now into the firm's wall clock first (`localDateISO` /
   `localTimeHHMM`, [src/schedule/availability.ts:22-41](src/schedule/availability.ts#L22)), and
   any watcher touching both a time column and a `created_at` column needs **two cutoffs derived
   from the same firm-local moment** — a hazard the money plan already names
   ([money-inference-v1.md:280-288](thoughts/shared/plans/2026-08-15-money-inference-v1.md#L280)).
   `v_schedule` bakes `local_day`/`local_weekday` for exactly this reason; the typed layer has no
   equivalent helper.
3. **`visits` ≠ `assignments`.** `visits` (L2) is evidence a trip happened, minted per field note;
   `assignments` is the schedule. Nothing links them. The 2026-08-13 eval failure
   ([src/db/context.ts:52-61](src/db/context.ts#L52)) was caused by reading the wrong one.
4. **L1 is append-only and undeletable** — enforced by trigger. Anything a watcher writes into
   `raw_captures` is permanent; the classify-before-insert rule applies at full strength (CLAUDE.md;
   the direction doc's constraint 5). `review_items` is a normal mutable table and carries no such
   constraint.
5. **One open review item per `(tenant_id, kind, subject_ref)`**, enforced by the partial unique
   index `uq_review_items_open`. `upsertOpenReviewItem` returns the existing row on conflict, so
   naive re-detection every 15 minutes is already idempotent — **but only while the item is open.**
   Once a manager resolves or dismisses it, the next tick re-opens it, forever. Both existing
   escapes from that (any-status `detail` key; episode key + supersede) are hand-rolled per kind.
6. **`review_items.detail` is uncapped JSONB and `list_pending_reviews` is unpaginated.**
   `listOpenReviewItems` has no `.limit()`, and `list_pending_reviews` returns every open row
   into the agent's context. The handler already hand-summarizes the three plan-carrying kinds
   ([src/mcp/server.ts:6583-6644](src/mcp/server.ts#L6583)) precisely because a fat `detail` floods
   context. 67 new items would be delivered whole.
7. **A cron step that throws turns the heartbeat red.** `ok:false` → exit 1 → Render marks the run
   failed. Established mitigation: per-step try/catch, and `{ skipped }` for "not migrated /
   not configured here yet" so a deploy that precedes its migration does not go permanently red.
8. **The cron has no per-tenant loop and no cadence state.** Steps iterate roster rows or run
   globally. There is no `last_run_at` anywhere for cron work; the only cursor-like state in the
   product is `boardNotify`'s **in-memory** map, which resets on restart. `ops_events` holds
   incident state but is keyed on `host_id`, not tenant.
9. **Notification liveness filter.** Deactivation revokes badge and board access but does not clear
   `telegram_user_id` ([src/telegram/boardNotify.ts:90-96](src/telegram/boardNotify.ts#L90)), so
   every push audience must filter on state. `listManagersWithTelegram` does this already.
10. **The pilot database is behind the repo.** Its migration ledger tops out at
    `20260815175254 fireworks_rates`; `money_events` and `tenant_profiles` (both merged in
    `beea5b2`, PR #146) are **not applied there**. Migrations are applied by hand via the
    Supabase MCP.
11. **Detection must be deterministic (direction doc constraint 1, overview §5).** Identity
    matching, permission boundaries and status machines are code; the model interprets. A Stage-0
    watcher is entirely on the hardcoded side.
12. **Attention economics (direction doc constraint 3).** Over-pinging trains people to ignore
    pings. The repo's own precedent is unambiguous: `ops_events`' migration comment says a notifier
    without suppression "would fire six times and get muted", and `boardNotify`'s digest exists
    because a freeze commit machine-gunned one push per placed visit.
13. **Surveillance framing (direction doc constraint 5).** A detector that names a *person* who is
    behind reads differently from one that names a *job* that is quiet. The money plan already
    codifies the softer form — its nudge is *"phrased about the JOB, never a visit"*
    ([money-inference-v1.md:272-274](thoughts/shared/plans/2026-08-15-money-inference-v1.md#L272)).

## Decision Points

These are the forks the current code creates. Stated factually; no recommendation.

**1. What "no status change" can even mean, given nothing ever completes an assignment.**
- *Treat `confirmed` + past `ends_at` as the gap signal.* Matches the archetype literally. Given
  finding 1 and the measured 67/67, this fires on the entire past schedule; it needs a separate
  suppression mechanism to be usable at all.
- *Build the missing edge first* — give something (a field note's status signal, a manager verb, a
  board action) the ability to walk `confirmed → completed`, so "still confirmed after the end
  time" becomes meaningful. This is a write-path change, i.e. more than Stage 0 as scoped.
- *Detect on a different signal entirely* — e.g. "job still `open` N days after its last
  assignment ended", which is the money plan's `listQuietOpenJobs` shape and does not depend on
  assignment status at all.

**2. How to establish "no linked capture", given no assignment↔capture link exists.**
- *Job-level, time-windowed* — any capture or `visits` row on the assignment's `job_id` created
  after `ends_at`. Cheap; wrong for multi-visit jobs (one note closes the gap for every visit on
  that job) and needs both `raw_captures.job_id` **and** the `L2.source_capture_id` path
  ([src/db/rawCaptures.ts:151-152](src/db/rawCaptures.ts#L151)) to avoid under-counting.
- *Job-level, any time* — simpler still, and per the measurement (2/67 vs 0/67) barely differs on
  current data.
- *Add the link* — persist `assignmentId` when the write path already knows it
  ([src/writePath/identityMatch.ts:127-132](src/writePath/identityMatch.ts#L127)), on the visit row
  or in capture metadata. Makes the detector exact; touches L1/L2 write paths and, if it goes in
  capture metadata, is permanent by construction.

**3. Cold-start volume: 67 items on tick one.**
- *No horizon* — flag everything historical. Against 54 review items in the tenant's entire
  history, and an unpaginated `list_pending_reviews`, this is the whole queue.
- *Look-back window* (e.g. only visits that ended in the last N hours) — the natural way to make
  the first tick quiet, at the cost of never seeing the backlog.
- *Watermark / high-water mark* — record where the watcher has swept to. There is no cadence-state
  precedent in the cron; the nearest patterns are the Brave backfill's derived watermark
  ([src/jobs/lifecycle.ts:210-216](src/jobs/lifecycle.ts#L210)) and the money plan's proposed
  `tenants.money_digest_last_sent_at` column.
- *Per-tick cap* — surface at most K per tenant per tick. No precedent in the cron; `DIGEST_MAX_LINES`
  is the analogous idea on the display side.

**4. Where a finding lands.**
- *`review_items` (pull)* — durable, deduped by the existing index, visible only when the manager
  asks. Requires one `ReviewKind` line and no migration. Silent by default, which is either the
  virtue or the flaw depending on intent.
- *`notifyManagers` (push)* — a Telegram line to every bound manager. Immediate; nothing dedupes it
  — the caller must, or 15-minute repetition follows.
- *Both* — the established shape for the call router: durable item + one batched push
  ([src/calls/worker.ts](src/calls/worker.ts)).
- *A periodic digest* — does not exist yet in any form. Building it means inventing cadence state
  (a tenant column, per the money plan) and a per-tenant cron loop.

**5. Re-fire policy after a manager acts.**
- *Open-row dedup only* — the default. A resolved item re-opens on the next tick because the
  condition is still true. For a permanently-true condition like "this visit never completed", that
  is an infinite loop.
- *Any-status dedup on a `detail` key* — the `flagUnknownRefCapture` idiom; asks once per subject,
  ever.
- *Episode key + supersede* — the `flagOffboardingReminder` idiom; asks once per occurrence, and a
  genuinely new occurrence supersedes the old item.

**6. Where the watcher's tenant loop comes from.**
- *`listTenantSeats()`* — the existing enumerator (paginated), what the money plan Phase 3 assumes.
  Returns every tenant including eval/test tenants.
- *`listTenantIdsWithTelegramBindings()`* — only tenants with someone reachable; naturally excludes
  the eval tenants but couples detection to notification.
- *A new lister* — e.g. tenants with any live assignment.

**7. Footprint collision with money Phase 3 (both features want the same three files).**
[money-inference-v1.md:254-299](thoughts/shared/plans/2026-08-15-money-inference-v1.md#L254)
already specifies: a new cron step iterating tenants via `listTenantSeats()`, a new `ReviewKind`
(`job_done_check`) for quiet jobs, a `listQuietOpenJobs` lister in `src/db/assignments.ts`, a
`notifyManagers` batch, and a digest with cadence state. That is Stage-0 watcher machinery under a
money label — it touches `src/jobs/lifecycle.ts`, `src/db/reviewItems.ts` and
`src/db/assignments.ts`, the same three files any watcher must. The fork: *build the watcher
framework first and let the money nudge be its first detector*, *build them independently and
reconcile later*, or *stack them* (CLAUDE.md's two-concurrent-features rule requires comparing
footprints before either implementation starts — these overlap). Note the money plan is
`status: draft`, unapproved, and its Phase 1/2 depend on model calls that Stage 0 does not.

**8. Calibrating on data that cannot calibrate.** The pilot's `Default Tenant` is demo data whose
last technician note is ~3.5 weeks old and whose 156 open jobs never advance status. Every gap
detector reads 100% positive there. The options the code permits: *calibrate on the local stack
with purpose-built seeds* (`npm run seed:local`), *calibrate on the eval world*
(`scripts/spine-eval/world.mjs`, which at least contains `completed` assignments — though only as
fixtures), or *ship detection in dry-run* (count and log into the cron's JSON summary, write
nothing) until a real firm generates real traffic. The cron summary already has a slot for exactly
that shape.

## Open Questions

1. **Is `confirmed → completed` dead by design or by omission?** The enum, the transition table and
   `v_schedule` all anticipate it; no writer exists. Whether a completion verb was descoped or
   simply never built is not answerable from the code — it needs the owner, or a dig through the
   Telegram-schedule series plans.
2. **Does the Render cron currently succeed?** Steps 3/4 skip without `COMPOSIO_API_KEY`, step 6
   skips without a DeepInfra billing key, and memory records the Render spine is still on a
   suspended Fireworks key. A watcher step inherits whatever red/green state the heartbeat is in;
   confirming that needs the Render dashboard.
3. **Do managers actually read `list_pending_reviews`?** 7 items are open in the pilot, the oldest
   from 2026-08-06, and 6 of them are `unlinked_call`. Whether that is "unread" or "correctly
   ignored" is not inferable from the table.
4. **What is a real firm's overdue-visit rate?** Every figure above comes from demo/eval data.
   The direction doc's open question 2 ("which gaps actually occur in pilot data, at what volume?")
   is, on this evidence, **not answerable from the pilot database as it stands.**
5. **Would a watcher's own output be captured to L1?** Direction doc constraint 4 flags this as an
   open capture-policy decision. Stage 0 as scoped writes only `review_items` (not L1), so the
   question may not bind here — but a push to a manager is arguably an outbound agent action, and
   the 2026-07-04 classifier-free exception is explicitly stated **not** to cover this by analogy.
6. **Is the burst-digest path reachable from a cron step at all?** `boardNotify` is a separate
   always-on worker driven by `schedule_events` with an in-memory cursor. A watcher wanting burst
   collapse would either emit `schedule_events` rows (which are the tenant's *schedule version* —
   writing non-schedule events there would move the version and, per the migration comment, could
   "silently falsify what changed since you looked") or re-implement the collapse in its own step.
7. **Does `review_items` need an index for a "count open by kind" read?** Only
   `idx_review_items_tenant` and the partial unique index exist. At 67+ rows per tenant it does not
   matter; at scale a watcher that counts before it writes would be a new access pattern.

## Assumptions

I am a non-interactive subagent and could not ask the user anything. Where the research command
says to confirm scope, I assumed:

- **Scope.** "Feature A" = Stage 0 only, as bounded by the direction doc's staging sketch:
  deterministic detectors on the existing cron, surfacing into `review_items` and/or the existing
  manager-notify path. I documented Stage 1 (the voice / `/hooks/agent` transport) and Stage 2
  (anticipation) only where they constrain Stage 0. I did not research the CLI-gateway or
  `/hooks/agent` transports.
- **"The archetype" is a specification to test, not to accept.** I read it as the direction doc
  presents it — the canonical example — and checked whether the schema and the live data support
  it. Reporting that they do not is a finding, not a recommendation.
- **Reading the pilot database is in scope and safe.** The task forbade seeding and any DB write.
  I issued SELECT-only queries against the hosted `supabase-test` project (the pilot's live DB),
  which CLAUDE.md and engineering-memory explicitly permit as "read-backs". No writes, no
  `apply_migration`, no local stack, no `npm test`.
- **Volume figures are a snapshot,** taken 2026-08-16 05:04 UTC (2026-08-15 22:04 firm-local,
  America/Los_Angeles). Overdue counts move with the clock.
- **Filename.** Date prefix from `date +%F` (2026-08-15) with `feature-A` in the name, per the
  task's collision rule.
- **Read-only.** No file under `src/`, `scripts/`, `supabase/` or `docs/` was modified; this
  document is the only file created.
