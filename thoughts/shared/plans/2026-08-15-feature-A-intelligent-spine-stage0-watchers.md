---
date: 2026-08-15
task: Feature A — Intelligent-spine Stage 0 ("the watchers"): deterministic gap detectors on the existing 15-minute cron, surfacing into existing channels only
research: thoughts/shared/research/2026-08-15-feature-A-intelligent-spine-stage-0-watchers.md
direction: thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md
status: implemented (awaiting copy-tone sign-off; ships shadow-first — live flip is a later joint decision)
---

## Overview
A deterministic detector as a new step in the existing 15-minute lifecycle cron. It notices the
archetype gap — *a confirmed visit whose scheduled end passed hours ago with no status change and
no linked capture* — and surfaces it into channels that already exist: the manager's
pending-review queue (`review_items`) and one batched `notifyManagers` Telegram line. No new
agent, no new identity, no model calls, no migration. Ships **shadow-first**: detection counts
into the cron's JSON summary before anything is written, because the research measured the
archetype firing on 100% of the pilot's historical schedule (67/67) — volume must be observed
before anything speaks.

## Decisions
- **Detect the literal archetype, bounded by a look-back window** — options: (a) literal
  archetype + suppression, (b) build the missing `confirmed → completed` edge first, (c) a
  different signal (quiet-open-jobs). Chose (a): (b) is a write-path change beyond Stage 0 scope;
  (c) is already the money plan's Phase 3 nudge. The 72h window + per-tick cap makes "fires on
  all of history" harmless — the historical backlog deliberately never surfaces, only fresh gaps.
- **"No linked capture" = job-level activity after the visit's end** — any job-stamped
  `raw_captures` row OR any `visits` row on the job whose firm-local time is after `ends_at`.
  Both homes read (research: reading one under-counts). Accepted imprecision: one note closes the
  gap for every visit on that job — persisting the assignment↔capture link is a write-path
  change, out of scope (Stage-1 candidate).
- **Naive-local handled per column** — `ends_at` is firm wall-clock stored as if UTC;
  `captured_at`/`created_at` are real UTC. Comparisons convert the real-UTC side to the firm's
  wall clock via `localDateISO`/`localTimeHHMM` (Intl owns DST), never the reverse. DB-side
  bounding uses a conservative UTC floor (wall-clock floor − 14h, the max legal UTC offset) so
  the precise compare stays in JS without unbounded reads.
- **Re-fire: once per assignment, ever** — any-status dedup on
  `(tenant, 'overdue_visit_gap', assignmentId)`, the `flagUnknownRefCapture` idiom (open-row
  dedup alone would re-open a resolved item forever — decision point 5). Plus **auto-resolve**:
  an open item whose job gains activity after the visit's end is resolved by the watcher, so the
  queue self-cleans.
- **Escalation ladder RATIFIED (user, 2026-08-16): at most TWO touches per gap — technician
  first, manager second.** End state (once Stage 1's voice exists): touch 1 = the technician's
  own agent asks about the gap, and follows up in-conversation until the gap is *verifiably*
  filled — "filled" means a capture/visit actually landed on the job, the same deterministic
  activity-after-end check auto-resolve uses, never the model's judgment that the chat felt
  sufficient. If the nudge is dismissed or goes unanswered, touch 2 opens the manager review
  item. Never a third touch. **In this plan (pre-voice), only rung 2 exists** — the manager item
  is the sole touch, so the once-per-assignment-ever dedup above is unchanged; Stage 1's rebase
  inserts rung 1 in front of it and demotes this plan's surface to the escalation rung.
  *Sub-question deferred to the Stage-1 rebase:* whether an explicit tech answer of "nothing to
  report / visit didn't happen" counts as filled or still escalates (as stated, any dismissal
  escalates).
- **Cadence — cron pulse moves to `*/5`, watcher every tick, heavy sweeps stay quarter-hourly
  (user, 2026-08-16).** The user wants ~5-minute detection. Rather than tripling all seven
  existing sweeps (Composio API calls, cost backfill, …), the schedule changes to `*/5` and step
  scheduling becomes minute-gated and stateless: steps 1–7 run only on quarter-hour ticks
  (`new Date(nowIso).getUTCMinutes() % 15 < 5`, tolerant of small firing delays — exactly their
  previous cadence), step 8 runs every tick. Off-cadence ticks report the skipped steps in the
  summary. Freshness gain for detection is modest (OVERDUE_HOURS dominates), but auto-resolve
  now clears a flagged item within ~5 minutes of the field note arriving, and 5 minutes is the
  pulse Stage 1's outreach will want.
- **Knobs approved at review (user, 2026-08-16):** archetype (overdue confirmed visits) and the
  72h look-back confirmed as v1; `OVERDUE_HOURS = 3` and the 5-items/tick cap stand
  unobjected — still tunable at the shadow-volume review.
- **Tenant loop = `listTenantIdsWithTelegramBindings()`** — paginated, skips tenants with nobody
  reachable, and (unlike `listTenantSeats`) skips the eval tenants, whose build-once worlds must
  not accumulate watcher items. Trade-off: detection coupled to notification reachability. When
  money Phase 3 lands, the two steps should share one enumerator.
- **Findings land in `review_items` + ONE batched count-only push per tenant per tick** — the
  call-router shape; push fires only when NEW items opened (dedup → no 15-minute repetition), no
  names/PII in the Telegram text. `OPEN for review:` push at all vs pull-only — default is
  push-on-new; pull-only = deleting one call.
- **`WATCHERS_MODE` gate: unset → skipped, `shadow` → count only, `live` → write + push; any
  other value → stepError (red)** — unset-skips matches the `COMPOSIO_API_KEY` precedent and
  keeps `lifecycle.test.ts` pure; a typo fails loud. Unsetting the var is the escape hatch.
- **No `src/mcp/server.ts` change** — the kind is a non-token review (`resolve_review` already
  handles it freely; `detail` is small, no summarizer needed). Keeps the busiest file out of the
  footprint. **No migration** — free-text kind, no new tables; a watermark was rejected as new
  state for no Stage-0 benefit (window + any-status dedup are idempotent statelessly).
- **Constants (defaults, tune at review):** `OVERDUE_HOURS = 3`, `LOOKBACK_HOURS = 72`,
  `MAX_NEW_ITEMS_PER_TENANT_TICK = 5`.
- **Surveillance framing** — prose about the JOB/visit, never "this person is behind"; the
  scheduled tech's ref rides in `detail` as routing data (the manager must know whom to ask).
- **Sequencing vs money-inference Phase 3 — DECIDED (user, 2026-08-15): this plan lands
  first.** The user judged the watcher framework the more general piece; money-inference waits
  and, when approved, its quiet-open-jobs nudge becomes this framework's second detector (shared
  tenant loop + step), not a parallel copy. (Original concern: both touch `lifecycle.ts`,
  `reviewItems.ts`, `assignments.ts`.)

## Plain-language walkthrough
**Phase 1 — teach the database layer the questions.** Four small, tenant-scoped query helpers:
"which confirmed visits ended between X and Y?", "what activity (notes/visits) exists on these
jobs since T?", "flag this visit-gap once, ever". All in `src/db/` per the repo rule, each with a
two-tenant test proving tenant A's rows never leak into tenant B's answer.

**Phase 2 — the watcher brain, as a pure module.** `src/jobs/watchers.ts` strings the helpers
together per tenant: find recently-ended confirmed visits, subtract the ones with activity after
their end, and (in live mode) open review items, auto-resolve stale ones, send one counting push.
Every collaborator is injectable, so its tests are pure unit tests (`lifecycle.test.ts` pattern).

**Phase 3 — plug into the heartbeat, roll out shadow-first.** Step 8 in the cron, gated by
`WATCHERS_MODE`. Deployed with `shadow`, the cron's JSON line reports gap counts every 15 minutes
and nothing else changes; once the volume is judged sane, flipping the env var to `live` turns on
the queue + push.

```
Render Cron */15 ─► runLifecycle ─ steps 1..7 (unchanged)
                        └─ 8. watchers (WATCHERS_MODE gate)
                             for each tenant with Telegram bindings:
                               ends_at in [now-72h, now-3h) & confirmed   ── candidates
                               minus: job activity after ends_at           ── gaps
                               shadow → count into JSON summary only
                               live   → flag once per assignment ─► review_items
                                        auto-resolve items whose gap closed
                                        1 batched count-only push ─► notifyManagers
```

## Assumptions
Non-interactive planning run — no user questions possible; defaults chosen and marked above
(`OPEN` items settle at plan review). The adversarial plan review (plan.md step 7) could not
spawn a Task subagent in this environment; a self-review pass against every referenced file was
done instead — its catches (PostgREST row-cap bounding via the −14h UTC floor;
`lifecycle.test.ts` env hygiene for `WATCHERS_MODE`; eval-tenant pollution via `listTenantSeats`)
are baked in. Verification triage per `verifying-behavior`: everything is codifiable (Vitest on
the local stack) except copy tone, the one human check. No third-party doc check needed —
detection is SQL over our own schema.

## Secrets & env preflight
- **Phases 1–2:** local stack only — `.env.test` (already required; `npx supabase start`).
- **Phase 3:** `WATCHERS_MODE` — NEW, set in the Render cron env at rollout (`shadow` first);
  unset = step skipped. `BOARD_BOT_TOKEN` — already required by the board worker; needed in the
  **cron** env only for live pushes, and the push path is gated on its presence (absent → pushes
  report `pushSkipped`, never a red run). DB env vars unchanged (already required).

## File footprint
Every file created (C) / modified (M) — compare against feature B's plan before implementing
either (CLAUDE.md two-concurrent-features rule):
- M `src/db/assignments.ts` — `listOverdueConfirmedAssignments`
- M `src/db/rawCaptures.ts` — `listJobStampedCaptureTimes`
- M `src/db/visits.ts` — `listVisitTimesForJobs`
- M `src/db/reviewItems.ts` — `'overdue_visit_gap'` kind + `flagOverdueVisitGap`
- M `src/db/scheduling.test.ts` — lister boundary + two-tenant tests
- M `src/db/spine.test.ts` — activity-lister tests (two-tenant)
- M `src/db/reviewItems.test.ts` — flag dedup-across-status tests
- C `src/jobs/watchers.ts` — the watcher module
- C `src/jobs/watchers.test.ts` — pure unit tests
- M `src/jobs/lifecycle.ts` — step 8 + `LifecycleDeps.runWatchers` + summary field
- M `src/jobs/lifecycle.test.ts` — env hygiene + step-8 tests
- M `docs/engineering-memory.md` — live-state entry (step, env gate, rollout state)
- C `thoughts/shared/plans/2026-08-15-feature-A-intelligent-spine-stage0-watchers.md` (this plan)

NOT touched (load-bearing for parallelism): `src/mcp/server.ts`; `src/calls/notify.ts` (reused
as-is); `src/db/index.ts` (`export *` re-exports automatically); `supabase/migrations/`;
`src/writePath/*`; `src/schedule/*` (availability helpers imported, unmodified).

## Phase 1: Typed-layer primitives

### What this phase does
Adds the four tenant-scoped DB helpers the watcher needs, with tests. No behavior change anywhere
— pure additions to `src/db/`.

### Changes required

**`src/db/assignments.ts`** — after `listUnassignedAssignments` (~line 525):
`listOverdueConfirmedAssignments(tenantId, endedFromNaive, endedToNaive): Promise<PlacedAssignment[]>`
— confirmed placed rows with `ends_at ∈ [from, to)`, oldest end first. Bounds are firm wall-clock
formatted as if UTC (the storage convention); callers derive BOTH from the same firm-local
moment. Query: `.eq('tenant_id', …).eq('status','confirmed').gte('ends_at', from)
.lt('ends_at', to).order('ends_at')`; placed by construction (time filters never match NULL).

**`src/db/rawCaptures.ts`** — after `listRawCapturesForJob`:
`listJobStampedCaptureTimes(tenantId, jobIds, sinceUtcIso): Promise<{job_id, captured_at}[]>` —
`.select('job_id, captured_at').eq('tenant_id', …).in('job_id', jobIds)
.gte('captured_at', sinceUtcIso)`; early-return `[]` on empty `jobIds`. The UTC floor keeps the
read bounded (PostgREST silently caps at 1000 rows). Comment the two-homes caveat: pair with the
visits lister — a note's capture may carry no `job_id` stamp, but `recordFieldNote` ALWAYS mints
its visit row.

**`src/db/visits.ts`** — same shape: `listVisitTimesForJobs(tenantId, jobIds, sinceUtcIso)` →
`{ job_id, created_at }[]`, tenant-scoped, `.gte('created_at', sinceUtcIso)`.

**`src/db/reviewItems.ts`** — add `'overdue_visit_gap'` to `ReviewKind` (comment: Stage-0
watcher, non-token — manager resolves/dismisses freely) and
`flagOverdueVisitGap({ tenantId, assignmentId, jobId, technicianRef, endsAtLocal, suggestion }):
Promise<ReviewItem | null>` — ONCE PER ASSIGNMENT, EVER: select any row (ANY status) for
`(tenant, kind, subject_ref=assignmentId)`; if found return null, else `upsertOpenReviewItem`
with `detail: { jobId, technicianRef, endsAtLocal }` (the `flagUnknownRefCapture` idiom without
the detail key — an assignment's end never recurs, so a closed item must never re-open).

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (local stack per `.env.test`) —
      1719 passed / 8 skipped, 2026-08-16
- [x] `scheduling.test.ts`: ends_at exactly at each bound (∈ from, ∉ to), cancelled/completed/
      unplaced rows excluded, **tenant-B row with identical times never returned** (run under a
      DEDICATED tenant — review finding: the file's relative-date fixtures would collide with the
      fixed window on exactly 2026-08-20)
- [x] `spine.test.ts`: both listers — empty `jobIds` → `[]`, `sinceUtcIso` floor respected,
      **tenant-B rows on the same job ids never returned**
- [x] `reviewItems.test.ts`: first flag opens; second returns null; resolve then re-flag → null
      (dedup across status); detail carries jobId/technicianRef/endsAtLocal; + tenant-scoped
      dedup test (review finding: tenant A's flag must never suppress tenant B's)

### Live verification (agent-executable)
- Prerequisites: none beyond the local stack (covered by the codified tests above).

### Manual verification
- [ ] none — *continue.*

## Phase 2: The watcher module

### What this phase does
`src/jobs/watchers.ts`: pure orchestration with injected collaborators — detection, shadow/live
branching, cap, dedup, auto-resolve, batched push. Fully unit-tested; nothing calls it yet.

### Changes required

**`src/jobs/watchers.ts`** (new) — exports `WatcherMode = 'shadow' | 'live'`; `WatcherDeps`
(every collaborator injectable, LifecycleDeps style — defaults:
`listTenantIdsWithTelegramBindings`, `getTenant`, `listOverdueConfirmedAssignments`,
`listJobStampedCaptureTimes`, `listVisitTimesForJobs`, `listTeam`, `listJobsWithCustomerByIds`,
`flagOverdueVisitGap`, `findOpenReviewItemsByKind`, `resolveOpenReviewItemFor`, `notifyManagers`,
`hasPushToken: () => !!process.env.BOARD_BOT_TOKEN`); `WatchersSummary { mode, tenants,
gapsFound, itemsOpened, itemsResolved, pushed, pushSkipped, tenantErrors }`; the three constants;
`runWatchers(nowIso, mode, deps = {}): Promise<WatchersSummary>`.

Per tenant (each in try/catch → `tenantErrors++`, siblings continue):
1. `tz = (await getTenant(t))?.timezone ?? 'UTC'`; helper
   `naiveLocal(ms) = localDateISO + 'T' + localTimeHHMM + ':00.000Z'` (imports from
   `src/schedule/availability.js` — Intl owns DST). Cutoffs `to = naiveLocal(now − 3h)`,
   `from = naiveLocal(now − 72h)`.
2. `candidates = listOverdue(t, from, to)`; live mode also loads
   `openItems = findOpenReviewItemsByKind(t, 'overdue_visit_gap')`.
3. ONE batched activity fetch over candidates' + open items' jobIds, floored at
   `min(from, open items' endsAtLocal) − 14h` in real UTC (max legal offset → conservative,
   bounded). Precise per-row test in JS: activity counts against an assignment iff
   `Date.parse(naiveLocal(activity time)) > Date.parse(ends_at)` — parse BOTH sides (PostgREST
   returns `+00:00`, the helper emits `Z`; string compare would break on the suffix).
4. `gaps` = candidates with no such activity; `gapsFound += gaps.length`. **Shadow stops here.**
5. Live: auto-resolve each open item whose job now HAS activity after its `detail.endsAtLocal`
   (missing/malformed detail → skip, never resolve — fail closed), resolution text
   `'field report arrived after this was flagged'`.
6. Live: for up to 5 gaps (oldest `ends_at` first): tech ref via one `listTeam` map, job
   title/customer via one `listJobsWithCustomerByIds` (re-check nested `tenant_id` — id-only FK
   rule); `flagGap(...)`; non-null returns count as `itemsOpened`. Suggestion copy (job-focused):
   `Visit for '<title>' (<customer>) scheduled to end <endsAtLocal> has no field report or
   status update — ask how it went, or dismiss if nothing was needed.`
7. Live, `itemsOpened > 0`: if `hasPushToken()`, one count-only push per tenant —
   `Spine check: N recent visit(s) have nothing on record — see pending reviews.` — else
   `pushSkipped = true`.

**`src/jobs/watchers.test.ts`** (new) — pure unit tests, `lifecycle.test.ts` pattern.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` — 1730 passed / 8 skipped, 2026-08-16
- [x] Unit tests: boundary in/out of both cutoffs; activity after end suppresses, before end
      does not; **UTC-straddle fixture** (America/Los_Angeles evening: 6pm PDT capture = next
      UTC day) detects/suppresses correctly; visits-only activity suppresses (note with no
      job-stamped capture); shadow mode calls no write dep and no notify; live opens ≤ cap,
      oldest first; dedup null → not counted opened; push only when opened > 0, once per tenant
      (review finding: + tenantErrors:0 so the throwing-notify sentinel actually bites);
      no token → pushSkipped, no throw; auto-resolve fires on arrived activity, skips malformed
      detail; one tenant throwing → others still processed, tenantErrors counted.
      *Deviation for the copy-tone check:* the suggestion renders the end as `2026-08-15 01:00`
      (wall-clock label), not the raw naive ISO — the `Z` suffix would falsely read as UTC.

### Live verification (agent-executable)
- Prerequisites: none (module is unreferenced until Phase 3; unit coverage above).

### Manual verification
- [ ] none — *continue.*

## Phase 3: Cron wiring, docs, rollout

### What this phase does
Wires `runWatchers` in as step 8 of the heartbeat behind the `WATCHERS_MODE` gate, records the
rollout, and verifies end-to-end on the local stack.

### Changes required

**`src/jobs/lifecycle.ts`** — header comment gains step 8 + the cadence note; `LifecycleDeps`
gains `runWatchers?: typeof runWatchers`; `LifecycleSummary` gains
`watchers: WatchersSummary | { skipped: string } | { stepError: string }`. **Cadence gate
(user decision 2026-08-16):** the cron schedule becomes `*/5`; steps 1–7 run only on
quarter-hour ticks (`getUTCMinutes() % 15 < 5` on the run's `nowIso`), each reporting
`{ skipped: 'off-cadence tick' }` otherwise — stateless, no new env. Step 8 runs every tick.
Step 8 after step 7:
read `process.env.WATCHERS_MODE` — unset → `{ skipped: 'WATCHERS_MODE unset (shadow|live)' }`
(the `COMPOSIO_API_KEY` precedent: a cron deployed before the var is chosen never goes red);
any value other than `shadow`/`live` → `{ stepError }` + `ok = false` (a config typo must be
LOUD, not silently off); else `watchers = await (deps.runWatchers ?? runWatchers)(nowIso, mode)`
in try/catch (`stepError` + `ok = false` on throw), and after a clean run
`if (watchers.tenants > 0 && watchers.tenantErrors === watchers.tenants) ok = false` — every
tenant failing is systemic, the pairing-sweep detector.

**`src/jobs/lifecycle.test.ts`** — add `'WATCHERS_MODE'` to the `beforeEach` env-clear list
(same reason as `COMPOSIO_API_KEY`: `.env` may carry it, and the default dep would hit the DB).
New tests: unset → `{ skipped }`, real deps never called; invalid value → stepError + `ok:false`;
`shadow`/`live` passed through to an injected stub; stub throw → stepError + `ok:false`;
all-tenants-failed summary → `ok:false`; **cadence gate**: a quarter-hour `nowIso` (:00/:15 and a
delayed :16) runs steps 1–7, an off-cadence `nowIso` (:05) skips them all with
`{ skipped: 'off-cadence tick' }` while step 8 still runs.

**`docs/engineering-memory.md`** — live-state entry: step 8 exists, `WATCHERS_MODE` semantics,
rollout state (shadow until volume reviewed), the 67/67-backlog rationale for the 72h window, and
the money-Phase-3 shared-loop note.

### Rollout order (a design artifact — deploy ≠ enable)
1. Merge via PR (gates green). No migration to apply.
2. Render cron: set `WATCHERS_MODE=shadow` AND change the schedule `*/15` → `*/5`, then
   **Manual Deploy → latest commit** (recorded traps: "Redeploy" and env-save both run the OLD
   commit). Verify from the next few log lines that quarter-hour ticks run steps 1–7 and
   off-cadence ticks skip them.
3. Observe days of JSON summaries (`watchers.gapsFound`) in Render logs; judge volume with the
   user. Then flip to `live` (+ `BOARD_BOT_TOKEN` in the cron env if pushes wanted). Escape
   hatch: unset `WATCHERS_MODE` — nothing to unwind beyond open items managers can dismiss.

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` (PR gate) — 1736
      passed / 8 skipped + clean build, 2026-08-16
- [x] New lifecycle tests above pass; existing lifecycle tests untouched-green (proves the
      default path stays pure)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack + `npm run seed:local` (LOCAL ONLY — never `--hosted`;
  `testEnvGuard` host rule) + a seeded confirmed assignment with a past `ends_at`.
- [x] `WATCHERS_MODE=shadow npm run job:lifecycle` (local-stack env, `COMPOSIO_API_KEY` unset)
      → JSON line shows `watchers.mode:'shadow'`, `gapsFound ≥ 1`, `itemsOpened: 0`; psql
      read-back (maker≠checker): zero `overdue_visit_gap` rows — VERIFIED 2026-08-16 by a
      fresh-context subagent: `{"mode":"shadow","tenants":1,"gapsFound":1,"itemsOpened":0}`,
      pg count 0
- [x] `WATCHERS_MODE=live …` twice → psql read-back: exactly ONE open item for the assignment
      after both runs (dedup); then insert a visit row for the job dated after `ends_at`, run
      again → item auto-resolved with the arrival resolution text — VERIFIED: run1
      `itemsOpened:1`, run2 `itemsOpened:0`, pg = 1 row, suggestion carries job+customer; after
      visit insert `itemsResolved:1`, row `resolved` with 'field report arrived after this was
      flagged'
- [x] Push path: with `BOARD_BOT_TOKEN` unset locally, summary reports `pushSkipped: true`,
      exit code 0 — VERIFIED (`pushSkipped:true`, exit 0)
- [x] **RE-VERIFIED after the final-review amendments** (fresh build, all 5 steps): shadow
      reports `gapsFound:1, freshGaps:1`; a during-visit `visits` row SUPPRESSES its assignment;
      live×2 opens exactly one item (run2 `freshGaps:0`), detail carries startsAtLocal +
      endsAtLocal; cancelling the assignment auto-resolves the item with 'visit was cancelled
      after this was flagged'; the cadence gate observed live in both directions (:29 tick →
      steps 1-7 `{skipped:'off-cadence tick'}`, :30 tick → heavy steps run; watcher every tick)

### Manual verification
- [ ] Read the suggestion + push copy as a manager would: does it read as a colleague's
      question about the job, not an audit of the person? (direction constraint 5)
- [ ] With the user: judge shadow-mode volume before flipping `live` (rollout step 3)

---
*Pause after this phase: Manual verification is non-empty (copy tone + the live-flip decision).*

## Final-review amendments (2026-08-16, multi-angle review round)

The full-diff review (10 finder angles + verification) drove these deviations from the plan text
above — each is a correctness fix, implemented and re-verified:

1. **"Filled" = activity since the visit's START, not strictly after its end.** A field note
   dictated mid-visit IS the report; the end-based predicate flagged exactly those punctual
   reports and could never auto-resolve them (plausibly a contributor to the 67/67 research
   rate). Compare is minute-floored `>=` (the naive-local conversion is minute-precision, so
   same-minute activity counts as filling — the safe direction). Item detail now carries
   `startsAtLocal` (+ `endsAtLocal` for display).
2. **The cap meters FRESH gaps.** New `listEverFlaggedSubjectRefs` batch read filters
   ever-flagged assignments out BEFORE the 5-slot cap — without it, stale flagged-but-unfilled
   gaps occupied the slots and starved new gaps for up to 72h. The summary gained `freshGaps`
   (computed in both modes): it is the number the shadow→live flip decision should read, since
   it is exactly what live would open.
3. **Activity listers paginate** past PostgREST's silent 1000-row cap (unordered truncation
   could drop the one capture proving a visit was reported → false flag). Floor additionally
   clamped: never more than 7 days before the window (one stuck open item must not drag every
   tick's read back unboundedly).
4. **Auto-resolve second path:** an open item whose assignment left `confirmed`
   (cancelled/completed — the "status update" the item copy promises) resolves with
   `visit was <status> after this was flagged`, via the existing `listAssignmentsByIds`.
5. **One cadence gate, not seven** in lifecycle.ts (the seven copy-pasted gates invited a
   future step that forgets its gate and silently runs a vendor sweep every 5 minutes).
6. **naiveLocal composes booking.ts's canonical `naiveLocalISO`** (was a third silent copy of
   the storage-form literal); doc contradictions fixed (control-plane/eng-memory §4 now say
   the `*/5` schedule is a ROLLOUT TARGET flipped in the dashboard, and control-plane's step
   list is flagged as predating the bill-pull/watcher steps).

**Surfaced, deliberately NOT changed (decide at review / Stage-1 rebase):**
- Should inbound customer traffic (a job-stamped complaint email/call) count as "activity" that
  suppresses the flag? Today any job-stamped capture counts; the highest-signal case ("nobody
  came" complaint) is thereby suppressed. Product call — narrowing the captures home to
  technician/agent channels is a small filter if wanted.
- `pushed` counts notifyManagers calls, not deliveries (it swallows errors and sends only to
  managers, while the tenant enumerator accepts any bound technician) — a manager-less-binding
  tenant reports pushes that reached nobody. Honest fix = notifyManagers returning a count.
- The once-per-assignment-ever guarantee is app-level (select-then-insert); a one-line partial
  unique index migration would give it a DB backstop before Stage 1 adds a second writer.
- Flipping live→shadow (or unsetting the mode) freezes auto-resolve, so open items stop
  self-cleaning on rollback — plan-consistent but worth knowing.
- First-hour live-flip burst: the cap is per-tick, so the initial backlog burns at 5 items/5min
  (bounded by the 72h window's fresh-gap count — read `freshGaps` in shadow before flipping).
- A `*/15` schedule left un-flipped + persistent ≥5-min cron firing delay would silently skip
  the heavy sweeps (all green) — flip the schedule in the SAME dashboard visit as
  `WATCHERS_MODE` (rollout step 2, now also in control-plane.md).

## Parallel/stack verdict (plan-two)

**Recommendation: STACK — land Feature A (this plan) first, then re-check/rebase Feature B's plan
on the result.** Do not open two worktrees for these.

**Shared files (exact-path intersection):** `src/db/assignments.ts`, `src/db/reviewItems.ts`,
`src/jobs/lifecycle.ts`, `src/jobs/lifecycle.test.ts`, `docs/engineering-memory.md`.

**Reasoning.** The exact-path overlap alone would already force a merge, but the semantic overlap
is disqualifying for parallel work:

1. **Same function name, incompatible contracts.** Both plans add
   `listOverdueConfirmedAssignments` to `src/db/assignments.ts` (verified absent from the current
   tree). Plan A's takes `(tenantId, endedFromNaive, endedToNaive)` — a bounded window returning
   plain `PlacedAssignment[]`; Plan B's takes `(tenantId, cutoffs)` with a single cutoff,
   `technician_id not null`, and `jobs!inner`/`technicians` embeds filtered to open jobs. A git
   merge would either conflict or, worse, silently keep one shape while the other feature's code
   assumes the other.
2. **Both claim lifecycle step 8.** Plan A: step 8 = `runWatchers` behind `WATCHERS_MODE`.
   Plan B: step 8 = `teamLeadSweep`, step 9 = `teamLeadCompose`, key-gated. Step numbering,
   `LifecycleSummary` shape, env-gating idiom, and the `lifecycle.test.ts` env-hygiene list all
   collide.
3. **Same detection archetype, two dedup stores.** Both detect the identical gap (confirmed visit
   ended 3+ hours ago, no capture/status change). A dedups via `review_items`
   (`overdue_visit_gap`, once per assignment ever); B dedups via the new `nudges` table. Merged
   naively, one gap fires BOTH surfaces — a manager review item + push AND a technician nudge —
   with two independent auto-resolve sweeps re-implementing the same "activity after end" logic
   (A: captures + visits, both homes; B: captures only). This is exactly the "parallel copy" this
   plan's own OPEN item warns against for money Phase 3; Stage 1 should consume Stage 0's
   detector/helpers, not rebuild them (B's D8 explicitly assumes "Stage 0 never ran").
4. **Two batched `notifyManagers` pushes per tenant per tick** if merged as written — the
   one-batched-line principle each plan holds individually breaks in combination.
5. **Background WIP hazard.** `scripts/seed.mjs`, `scripts/spine-eval/world.mjs`,
   `src/mcp/server.ts`, `src/db/index.ts` already carry uncommitted money-ledger/firm-profile
   changes in the working tree, and a concurrent-session `commit -a` sweep has already bitten
   this repo once (eng-memory). Adding two more sessions to the same surfaces multiplies that.

**Order: A first.** A is smaller, migration-free, and model-free; B's rebase then (a) reuses A's
`listOverdueConfirmedAssignments` (widening it if B needs embeds), (b) becomes steps 9/10 (or
replaces/extends step 8's framework as its second consumer), (c) decides ONE surfacing policy per
gap (nudge the tech OR flag the manager, with escalation between them — not both at once), and
(d) renumbers its migration if needed.

**Risk areas to re-check when rebasing B:**
- `src/db/assignments.ts` — unify the overdue lister (one function, one time-convention comment).
- `src/jobs/lifecycle.ts` + test — step numbering, summary shape, env-clear list, gating idioms.
- Watcher-vs-nudge interaction — dedup keys (`(tenant, kind, assignmentId)` in `review_items`
  vs `(tenant, kind, subject_ref)` in `nudges`) must not double-fire on the same assignment.
- `src/db/reviewItems.ts` — `ReviewKind` gains both `'overdue_visit_gap'` and
  `'unanswered_nudge'` (trivial textually, but escalation semantics should be one ladder).
- `notifyManagers` batching — a single combined per-tenant line once both features speak.
- `docs/engineering-memory.md` — sequential live-state entries, trivial after stacking.
