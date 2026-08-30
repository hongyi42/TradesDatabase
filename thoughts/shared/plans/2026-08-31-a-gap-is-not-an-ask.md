---
date: 2026-08-31
task: Build 4 — a gap is not an ask: detection writes an observation the planner keeps; asking is a decision, never a birthright
research: thoughts/shared/research/2026-08-30-a-gap-is-not-an-ask.md
status: draft
supersedes: thoughts/shared/plans/2026-08-26-the-decline-verb.md
---

**Why the supersession:** the decline verb let the planner refuse an ask the detector had already
committed to. Here the detector commits to nothing — an un-askable observation stays un-asked or is
dismissed — so the draft's symptom no longer exists. Its 2026-08-26 decisions do not carry over.

## Overview

Today noticing IS asking: `createNudge` mints a question addressed to a person, and anything past
the per-tick cap is silently dropped. This build splits the two: detectors write **observations** —
kept, unbounded, planner-curated — and a question exists only when the planner chooses `send`.
Direction: `docs/engineering-memory.md` §6a entry 4 (user, 2026-08-31).

## Decisions

- **The observation is its own table** *(user, decision brief 2026-08-31)* — not a status on
  `nudges`. `nudges` survives untouched as the ASK record: delivery queue, 18h/24h clocks, manager
  escalation all keep working on asks. Ask-shaped rules never sit on non-ask rows.
- **One gap, one id, two stages** *(implementation call, the plan's load-bearing trick)* — a `send`
  creates the nudge **with the observation's own uuid**. `nudge_decisions` rows keyed by that uuid
  span the pre-ask and post-ask life, so `historyLine`, `recall_decisions`, the eval's
  `seeded.nudgeIds` mapping, and `ask_group_id = lead id` all survive unchanged. The cost — two
  tables sharing an id space — is recorded in the migration header.
- **Aging counter, not a deadline** *(user)* — un-asked observations carry no clocks. A watched
  `observationsStale` count (open > `OBSERVATION_STALE_HOURS = 72`, no applied real verb) rides the
  planner summary into `lifecycle_runs` and `npm run ticks`. An alarm, not an actor.
- **Open-own-observation waits for build 6** *(user)* — dismiss/recover ship now (the record does
  not function without them); the planner-opens-its-own-gap verb lands with the intent vocabulary.
- **The mint-time manager fallback dies** *(user)* — the detector writes an observation regardless
  of reachability. The ASK lifecycle's manager handoffs (18h never-delivered, 24h silence) stay
  code-written until build 5.
- **Nudges are born `queued`** *(consequence)* — `send` writes the question directly. `pending`
  survives in the CHECK for pre-existing rows; the 18h expiry path keeps covering both `pending`
  relics and `queued`-but-never-acked rows. `hold` moves to the observation
  (`observations.not_before`, advisory — nothing enforces it but the planner's own next look).
- **Send does not check reachability** *(implementation call)* — a send to an unreachable person
  queues, is invisible to every host pull, and the 18h broken-machinery clock hands it to the
  manager. That clock exists for exactly this; a mint-time reachability gate is detection deciding.
- **`dismiss`/`recover` are submit_plan actions, not tools** — applied by code after the loop, like
  every verb. `TEAM_LEAD_TOOL_NAMES` / `TEAM_LEAD_TOOLS` and the dispatch gate are untouched.
- **Dismissed rows are reachable via a new `v_observations`** — the planner recovers by id found
  through `spine_read`. The view joins the shared catalog, so managers can see observations and the
  planner's `dismiss_reason` prose through `query_spine` — accepted, same posture as
  `nudges.resolution` (already manager-readable, written to stand alone).
- **`NUDGES_MODE` stops gating anything** *(consequence)* — it only ever gated rung-1 creation at
  mint, which no longer exists. The parameter stays in signatures this build (lifecycle passes it);
  removing it is build 5 cleanup. `nudgesWouldCreate`/`nudgesCreated` stay in `WatchersSummary` at 0
  with a retirement comment; `observationsCreated` + per-kind counts join.
- **Eval re-levelling stays deferred** *(user ruling 2026-08-30)* — Phase 5 keeps the suite green,
  nothing more.

## Plain-language walkthrough

**Phase 1 — the store.** A new `observations` table: one row per thing noticed — kind, subject,
what the detector saw, status `open`/`dismissed`/`asked`, noticed once ever per subject. The
decision log learns to point at an observation as well as an ask. You'd notice: nothing yet.

**Phase 2 — detection records, nothing asks.** Every fresh finding becomes an observation row — no
cap, no reachability check, no manager fallback. A tick against a gappy world creates observations
and zero nudges, zero review items.

**Phase 3 — the planner takes over the pre-ask life.** Open observations join the view in state
"noticed". `send` now *creates* the question (born queued, same id); `dismiss` stops it resurfacing
(revisably); `recover` brings one back; `hold` notes "not before". Asked gaps: exactly as today.

```
BEFORE  detector ──▶ nudge(pending, addressed) ──▶ planner send ──▶ queued ──▶ box
AFTER   detector ──▶ observation(open) ──▶ planner: send ─▶ nudge(queued, SAME id) ──▶ box
                                      └──▶ dismiss ⇄ recover · hold · leave
```

**Phase 4 — the instrument and the read surface.** The stale counter reaches the tick report;
`v_observations` reaches `spine_read`/`query_spine`; history reads span both stages.

**Phase 5 — the eval harness keeps breathing.** The simulator seeds observations for pre-ask
worlds, nudges for asked ones; the readback presents one id-space. Green suite, no re-levelling.

## Secrets & env preflight

- **All phases:** local stack only — `.env.test` via `npx supabase start` (already required). No
  new secrets. `npm run gen:types:local` after Phase 1 (never `gen:types` — that is the pilot).

## Phase 1: The store

### What this phase does
The table, its view, the `nudge_decisions` widening, typed accessors — no production writer yet.

### Changes required

**`supabase/migrations/20260901130000_observations.sql`** (new)
- `observations`: `id uuid pk default gen_random_uuid()`, `tenant_id uuid not null references
  tenants(id)`, `kind text not null`, `subject_ref text not null`, `technician_id uuid references
  technicians(id)` (advisory — who the detector thinks could answer), `context jsonb not null
  default '{}'`, `status text not null default 'open' check (status in ('open','dismissed','asked'))`,
  `dismiss_reason text`, `dismissed_at timestamptz`, `not_before timestamptz`, `noticed_at
  timestamptz not null default now()`, `updated_at timestamptz not null default now()` + the
  `set_updated_at` trigger.
- `uq_observations_subject_ever unique (tenant_id, kind, subject_ref)` — "noticed once, ever";
  header explains the once-ever semantics MOVED here from the ask, and the same-id design.
- Indexes: `(tenant_id, status)`; RLS-on-no-policy + `revoke all ... from anon, authenticated`
  (the `nudges` posture, stated reason included).
- `v_observations`: id, kind, subject_ref, technician ref/name (left join technicians), job_id
  (the `v_nudges` context->>'jobId' guarded-cast pattern, copied), status, dismiss_reason,
  dismissed_at, not_before, noticed_at; **`where tenant_id =
  current_setting('spine.tenant_id')::uuid`** — the predicate every spine view carries
  (`20260823120000_planner_read_surface.sql:101`); `grant select ... to spine_reader`.
- `nudge_decisions`: `alter column nudge_id drop not null`; `add column observation_id uuid
  references observations(id) on delete cascade`; `add constraint nudge_decisions_subject_check
  check (nudge_id is not null or observation_id is not null)`; replace
  `nudge_decisions_action_check` with the current set + `'dismiss','recover'` (implementer: read
  the live constraint from `pg_constraint` first — the set has been amended twice); index
  `(observation_id, decided_at desc)`.

**`src/db/observations.ts`** (new)
- `createObservation(input)` → row | null (23505 → null, the `createPendingNudge` idiom);
  `listObservationsByStatus(tenantId, statuses)`; `listObservedSubjectRefs(tenantId, kind,
  subjectRefs)` (the dedup read, any status — mirror `listNudgedSubjectRefs` at
  `src/db/nudges.ts:75`); `setObservationStatus(id, tenantId, patch, fromStatuses)` (guarded
  update returning the row or null — the `setNudgeSchedule` idiom) covering dismiss/recover/hold/
  mark-asked.

**`src/db/index.ts`** — export the new module. **`src/db/database.types.ts`** — `npm run
gen:types:local`.

**`src/db/nudges.ts`** — `createNudgeFromObservation(input & { id: string })`: insert with explicit
id, `status: 'queued'`, `queued_at`, question; 23505 → null (the race: send applied twice).

### Automated verification
- [ ] `npx tsc --noEmit` · `npm run lint` · `npm test`
- [ ] new `src/db/observations.test.ts`: round-trip; uq blocks re-notice in EVERY status; dismiss
      guard refuses on non-open; recover guard refuses on non-dismissed; RLS/grant posture probe
      (the `jobNotes.test.ts` `pg_constraint`/`has_table_privilege` pattern); decisions row with
      observation_id only satisfies the check; cascade from observations deletes its decisions
- [ ] `createNudgeFromObservation` with a taken id returns null, does not throw

### Live verification (agent-executable)
- Prerequisites: local Supabase stack (`npx supabase start`)
- [ ] After `supabase db reset`: `\d observations` via psql shows the CHECKs; `select` on
      `v_observations` as `spine_reader` succeeds, as `anon` fails; TWO-TENANT probe — tenant B's
      `spine.tenant_id` setting sees zero of tenant A's observations (review F1)

### Manual verification
- [ ] none
---
*No pause — automated checks suffice.*

## Phase 2: Detection records, nothing asks

### What this phase does
The mint sites write observations; cap, reachability check, mint-time manager fallback, and
`NUDGES_MODE`'s gate die. The sweep over existing asks is untouched.

### Changes required

**`src/jobs/watchers.ts`**
- Visit pass (`:1140-1227`): delete the `top` slice, the `routedThisTick` ceiling, the reachability
  test, the `createNudge` call and the `flagGap` fallback. For every `fresh` gap:
  `createObservation({tenantId, kind, subjectRef: g.id, technicianId: tech?.id ?? null, context})`
  — context exactly as today (`:1188-1198`). Count `observationsCreated` + `bumpKind`.
- Cost pass (`:1229-1320`): same surgery, **and delete the `nudgeMode !== 'off'` wrapper at
  `:1235`** — it gates the ENTIRE cost pass, so left standing, cost gaps produce no observations
  under lifecycle's default `'off'` (review F2). Detection gates on watcher mode alone. Keep the
  three-store `surfaced` filter and add `listObservedSubjectRefs` to it (`:576-581`, `:1242-1248`).
- `WatcherDeps` gains injectable seams (+ defaults) for `createObservation` /
  `listObservedSubjectRefs` — un-injected, fixture tenant ids hit the real DB and 22P02
  (`watchers.ts:278-280`). **`src/jobs/lifecycle.test.ts:293-311`** (`WATCH_OK` + every
  `runWatchers` stub) updates with the `WatchersSummary` shape (review F10).
- `WatchersSummary`: add `observationsCreated: number`; comment `nudgesWouldCreate`/`nudgesCreated`
  as retired-at-mint (kept at 0 — lifecycle summary shape is pinned by tests).
- The manager PUSH (`:1327-1358`) now fires only for sweep-opened items (expiry/escalation) —
  `opened` no longer counts mint-time fallbacks; verify the copy still reads true.
- Keep: every sweep path (moot, fail-safe, escalation, expiry, group expansion), the
  per-firm settings read, `stage0Suggestion` (expiry handoff still uses it).

### Automated verification
- [ ] gates; watcher tests rewritten: a fresh gap in live mode creates an observation and NO nudge,
      NO review item, regardless of reachability; an unreachable-tech gap creates the same row; 8
      fresh gaps create 8 observations (the cap is dead); a dismissed observation's subject is not
      re-noticed; shadow mode still writes nothing; **cost observations created with nudgeMode
      `'off'`** (review F2)
- [ ] existing escalation/expiry/moot tests pass unmodified (the sweep did not change)

### Live verification (agent-executable)
- Prerequisites: local stack, `npm run seed:local`
- [ ] Drive one live tick against a seeded overdue visit; read back via psql: 1 observation row,
      0 new nudges, 0 new review_items
---
*No pause.*

## Phase 3: The planner takes over the pre-ask life


### Changes required

**`src/teamLead/planner.ts`**
- `runPlanner` read (`:1918`): also `listObservationsByStatus(tenantId, ['open'])`; map each to the
  gap-subject shape with `status: 'noticed'` (a mapped pseudo-row: `asked_at: null`, `question:
  null`, `created_at: noticed_at`). `skippedNoGaps` counts both sources empty.
- `buildGapView`: accept state `'noticed'` — print `state: noticed`, `noticed: Nh ago`, no
  escalates-at line, no "asked:" line; evidence window since `noticed_at` (the existing `sinceMs`
  fallback already does this); held-until from `observations.not_before`.
- `PLANNER_ACTIONS` (`planner.ts:78`) + the `PlannerAction` type gain `'dismiss','recover'` — the
  unknown-action rail (`:1222`), the recorder filter (`:2276`), and the enum pin test
  (`planner.test.ts:2863`) all key on it; prompt-enum-only leaves both verbs refused (review F7).
- `validateDecisions` state rails: on `'noticed'` allow `send`/`hold`/`dismiss`/`leave`; refuse
  `close`/`escalate`/`extend` on observations with the existing refusal-string style. `recover` ids
  are validated against a READ of the tenant's dismissed observation ids — an unknown id is DROPPED
  (no record row, the `views.has` skip at `:2277`), never recorded: keyed as `observation_id` it
  would 23503 and reject the tick's ENTIRE chunked decision insert
  (`nudgeDecisions.ts:70-97`) (review F4). A send GROUP may not mix a relic pending nudge with
  noticed observations — one stage per group, or the same-id insert 23505s into a leaderless group
  (review F8).
- `hold` on `'noticed'` is EXEMPT from `holdCeilingMs` (`:986-988`, enforced `:1480-1486`) — the
  18h ceiling and its never-asked refusal copy are ask-shaped; observations never expire. Test: a
  hold on an 80h-old observation applies (review F6).
- `applyDecision` (`:1665`): `send` on an observation → `createNudgeFromObservation` (same id,
  message = `questionDraft + anchor`, group = N observations same person+job → N nudges, lead's id
  as `ask_group_id` via `markNudgeGroupQueued`'s semantics — implementer: the group members are
  CREATED here, so write a `createNudgeGroupFromObservations` that inserts all rows then stamps
  `ask_group_id`), then `setObservationStatus(..., {status:'asked'}, ['open'])` per member —
  best-effort after the nudge lands, console.error on failure (a stale 'open' observation is a
  display defect; the ask exists). `hold` → `setObservationStatus` not_before, `['open']`.
  `dismiss` → status dismissed + `dismiss_reason: d.reason`, `['open']`. `recover` → status open +
  clear reason/stamp, `['dismissed']`.
- `recordNudgeDecisions` writer: key by stage — observation ids → `observation_id`, nudge ids →
  `nudge_id`. `listDecisionsForNudges` (`src/db/nudgeDecisions.ts`): `.or()` over both columns —
  same-id makes one id list serve both — **and the grouping key becomes
  `row.nudge_id ?? row.observation_id`** (`:151-155`): pre-ask rows group under null otherwise and
  vanish from `historyLine` AND watchers' `plannerAlive` (review F9). `PlannerDeps` gains seams for
  the new observation collaborators (review F10).
- `PLANNER_JUDGMENT_ACTIONS` (`watchers.ts:203`): add `'dismiss','recover'` (the pinning test too).

**`src/teamLead/plannerPrompt.ts`**
- State section (`:72-85`): add `state "noticed"` — nothing exists to deliver until YOU send;
  dismiss = "stop showing me this — it stays on the record and you can bring it back"; rewrite the
  `pending` lines to past-tense relic ("rows from before the split — treat as noticed").
- `submit_plan` enum (`:289`): + `'dismiss','recover'`; description lines for both (dismiss uses
  `reason`; recover takes an id you found via spine_read over v_observations).
- CONTEXT section: name `v_observations` beside `v_nudges`.

### Automated verification
- [ ] gates; planner tests: send-on-observation creates a queued nudge with the SAME id and stamps
      the observation asked; the race (observation asked between plan and write) refuses; dismiss
      hides from next view; recover restores; dismissed subject never re-noticed by Phase-2 sweep
      test; close/escalate on an observation refused with the state named; historyLine spans a
      dismiss (pre-ask) and an extend (post-ask) on one id
- [ ] `submit_plan` schema snapshot updated; `PLANNER_JUDGMENT_ACTIONS` pin test updated
---
*No pause.*

## Phase 4: The instrument and the read surface

### Changes required
- **`src/teamLead/planner.ts`**: `OBSERVATION_STALE_HOURS = 72`; per-tenant
  `observationsStale` (open, `noticed_at` older, no applied non-`leave` decision) into
  `PlannerSummary` (`:218`) and each `PlannerTenantPlan`; never reddens a tick.
- **`scripts/ticks/report.mjs`**: print `stale observations: N` per firm when > 0.
- **`src/mcp/server.ts`**: `v_observations(...)` column line in the view catalog (`:707` region,
  both tool descriptions that enumerate views).
- **`src/db/nudgeDecisions.ts`**: confirm `listDecisionsForJob` needs nothing (job_id is stamped on
  observation decisions too — writer sets it from context, same as today).

### Automated verification
- [ ] gates; a seeded 80h-old untouched observation yields `observationsStale: 1` and `ok: true`;
      catalog string test updated; `v_observations` answers through the real `spine_read` dispatch
      (the toolCases idiom)
---
*No pause.*

## Phase 5: The eval harness keeps breathing

### Changes required
- **`src/eval/plannerSim.ts`**: `seedScenario` — spec status `'pending'` → observation row (id
  recorded in `seeded.nudgeIds` unchanged); `'queued'`/`'asked'` → nudge as today PLUS an
  `observations` row in status `'asked'` with the same id (keeps the once-ever store coherent).
  `runTick` readback: decisions `coalesce(nudge_id, observation_id)` presented as `nudge_id`;
  `nudgesAfter` gains observation-only subjects rendered as `{status:'noticed'|'dismissed'}` rows.
  Snapshot/rewrite (sim-clock fix-up) covers `observations.noticed_at/dismissed_at/updated_at`.
- `runArc`'s all-closed short-circuit (`plannerSim.ts:717-722`): the `openLeft` filter adds
  `'noticed'` (dismissed counts as closed) — otherwise a held pending-seed scenario loses every
  remaining scripted tick as "all gaps closed" (review F3).
- **`scripts/agentic-eval/run.mjs:224`** and **`plannerCorpus.test.ts:185`**: per-scenario cleanup
  also deletes `observations` for the tenant — or scenario N's rows leak into scenario N+1's
  planner view and pre-ask decision rows never cascade away (review F5).
- **`plannerCorpus.test.ts:198-206`** (the seeds-cleanly pin): counts nudges PLUS observations by
  seeded status. The deadline authoring rail is ALREADY asked-only (`:69`) — no change there
  (review F11 corrected this plan's earlier claim). Scenario `expect` blocks are NOT re-levelled
  (deferred, user ruling) — a scenario whose expectation can no longer be expressed is marked
  skipped with a dated comment naming the evaluation phase, not deleted.
- **`src/eval/plannerEvalGraders2.ts`**: no grading changes; extend the `OPEN` status set
  (`:41`) with `'noticed'` so arc checks treat an unsent observation as open.

### Automated verification
- [ ] gates; full `npm test` green twice (the flake discipline); a vitest smoke that SEEDS a
      pending-seed scenario world and runs one `runTick` through the injected eval caller,
      asserting no `harnessError` — `--dry` proves nothing, it exits before seeding
      (`run.mjs:103-115`, review F12)
- [ ] `npm run decisions:index` regenerated and committed with the plan
---
*No pause. Build gates only — production deploy stays frozen until the whole order is evaluated.*
