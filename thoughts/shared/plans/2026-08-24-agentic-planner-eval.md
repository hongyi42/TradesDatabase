---
date: 2026-08-24
task: the agentic planner eval at scale — multi-tick gap-life harness, ~60 scenarios, Opus 5 vs GLM
research: thoughts/shared/research/2026-08-23-agentic-eval-estate.md
status: draft
supersedes: nothing
---

## Overview

Build the eval that has never existed: the planner run **as an agent** — through its real tool
loop, against a seeded local world, across a gap's whole life. Today's harnesses measure other
subjects (seat agent, box agent, planner *copy* on pre-gathered context); none can answer "did
the planner look before deciding" or "was this escalation premature," which are our two
measured failure modes. The deliverable is a corpus of ~60 scenarios drawn from documented
specimens/rulings/metric definitions, a simulator that advances a fake clock through
watchers+planner ticks, deterministic graders plus one blind judge, and a two-arm report
(Opus 5 vs GLM-5.2) that becomes the baseline the one-call collapse must beat.

## Decisions

- **Gradable unit** — user choice (2026-08-24): the **multi-tick gap-life engine** (option 2),
  which nests single-tick staged-mid-life scenarios as 1-tick arcs. Most scenarios stay
  single-tick; ~a dozen are true arcs.
- **Corpus** — user choice: **~60 authored scenarios** from the failure taxonomy (false claims,
  context-miss, premature, late/stuck, people-judgment, multi-gap, lessons, date/window edges).
  Pilot rows inform authoring, are not the source.
- **Model arms** — user choice: **Opus 5 + GLM-5.2/Fireworks**, same corpus, two runs.
  *Implementation note (Phase 1): the GLM arm pins the PRODUCTION endpoint explicitly
  (`FIREWORKS_API_KEY` + the fast-router model), not `lib/env.mjs modelConfig()` — the
  `EVAL_INFERENCE_*` values in `.env` point at DeepInfra, retired 2026-08-18, whose host no
  longer maps to any ledger vendor.*
- **Tick = watchers + planner, compose skipped** (mine): production's tick is sweep→planner→
  compose; the sweep drives state transitions the arcs need (answered/escalated/expired), but
  compose only writes delivery copy — not the graded surface, and it would double model spend.
  `sweepLive: true` is passed so escalations actually hand off (review items), mirroring
  lifecycle.ts:383-395.
- **Transport = the real `src/model` stack** (mine): the harness pins the provider per arm via
  env (`MODEL_PROVIDER`, `ANTHROPIC_MODEL` / `INFERENCE_*`) before running; `activeProvider()`
  reads env per call so one process = one arm. Costs land in the LOCAL stack's `cost_events`
  (tenant known), which the report reads back — the eval prices itself off the real ledger, and
  the planner-eval's private price table is not extended (research open question resolved:
  `cost_rates` is authoritative).
- **Clock** — (mine): the tick time is the `nowIso` argument to `runWatchers`/`runPlanner`; the
  TOOL side (grounding riders, `resolve_date`) follows `EVAL_FAKE_NOW=<tenantId>:<iso>`
  (src/evalClock.ts:13, read per call), so the harness sets both together and mutates
  `process.env.EVAL_FAKE_NOW` between ticks. A drift between the two would be an invalid run,
  so the harness owns one `setSimClock(tenantId, iso)` helper and nothing else touches either.
- **World** — (mine): LOCAL stack only, guarded by `requireLocalStack()`
  (scripts/spine-eval/lib/env.mjs:44, wraps `assessTarget`) — truncation is legal locally, so
  worlds are rebuildable and build-once/pilot constraints don't bind. The spine-eval worldSpec
  is NOT extended (it has no gap vocabulary and doesn't need one).
- **Seeding and sim-time are DIRECT SQL, not the typed layer** (mine, review finding): the
  typed layer stamps real wall-clock everywhere (`markNudgeAsked`/`markNudgeOutcome` use
  `new Date()`, `decided_at`/`created_at`/`captured_at` are server defaults, money
  `created_at` is deliberately unspoofable) — so back-dated worlds are unreachable through it.
  The harness seeds nudges/captures/money/decision-history via SQL with explicit timestamps,
  and after EVERY tick rewrites that tick's new `decided_at`/`resolved_at`/`queued_at` (and a
  detector-minted nudge's `created_at`) to sim-now. *Implementation note (Phase 1): the
  fix-up identifies "what this tick wrote" by an id/value SNAPSHOT DIFF, not the planned
  wall-clock `gte` boundary — sim stamps and the real clock are not comparable in either
  direction (t0 sits in the real future on early-morning runs, and a prior tick's sim-stamped
  rows must not be re-captured by a later tick's fix-up). Caught by the Phase 1 test.* Without the fix-up, watchers' `plannerAlive` check (real `decided_at` vs
  sim-now−24h, watchers.ts:668-677) reads the planner as dead mid-arc and auto-closes gaps —
  corrupting exactly the late/stuck arcs the corpus exists to grade.
- **Transcript capture** — (mine): inject `runLoop` in `PlannerDeps` with a wrapper that
  delegates to the real `runToolLoop` and keeps each `ToolLoopResult` (`calls`: name/args/
  result per call) — recovering exactly what production discards (planner.ts:1557).
- **Grading composition** — (mine, the estate's pattern): deterministic first (action,
  claims-vs-world, citation resolution, `mustRead` investigation checks over the captured
  transcript, arc shape), then ONE blind judge (planner-eval's judge.mjs shape: sees block +
  note only) for blame/unsupported-claims, reported separately. Oracle discipline: expectations
  never import planner code EXCEPT the shared production rail (`cleanHandoffNote`), same as
  planner-eval — both exceptions documented in-file.
- **Report, not gate** — (mine): standalone `report.md` per run + a comparison table, like
  date-eval. Joining gate.mjs's seal/baseline contract is a later decision once the corpus
  stabilizes.
- **Scenario/grader code is TYPED** (mine): scenarios+graders live in `src/eval/` (unit-tested,
  linted, like corpus.ts/graders.ts); only the drivers are `.mjs` under
  `scripts/agentic-eval/`.

## Plain-language walkthrough

**Phase 1 — the simulator core.** A scenario is a small world (customer, job, visit, an open
gap stamped in the past) written into the local test database, plus a chosen "now". The runner
executes one production-faithful tick — the watcher sweep, then the real planner with its four
read tools wired to that database — and captures everything: the decision it recorded, and the
full list of what it chose to read first (which production throws away). You'd see it working
as: two smoke scenarios run end to end and print "escalate — and here are the 3 spine_reads it
made first."

```
scenario ──seed──▶ local DB ◀──reads── planner's 4 tools
   │                                        ▲
   └─ setSimClock(now) ─▶ tick: runWatchers(now) → runPlanner(now)
                                    │              │
                              state moves     decision + captured
                              (answered/      tool transcript
                               escalated)          │
                                    ▼              ▼
                              results.jsonl (one row per tick)
```

**Phase 2 — time travel.** Arcs need more than one moment: the harness advances the fake clock
through a scenario's scripted timeline (tick at 10:00, a technician note lands at 14:20, tick
at 14:30, …) until the gap closes or the script ends. Both clocks — the tick argument and the
tool-side `EVAL_FAKE_NOW` — move together. At the end, the real gap-summarizer runs so the arc
is also expressed in the ⑤ vocabulary (escalated? manager fate? working-hours open?).

**Phase 3 — the corpus.** ~60 scenarios authored from the documented failure families, each
one a seeded world + timeline + expectations stated as facts ("must not claim the record is
empty", "must have read the job's money events", "arc must not whiplash"). This is the same
process that produced tier-2's 59 and planner-eval's 6 — the money-blindness specimen, your
rulings, and the ⑤ metric definitions become executable checks.

**Phase 4 — grading and the report.** Free deterministic checks run first; a narrow blind
judge (shown only the record block and the note, never the expected answer) settles the two
things strings can't — blame and unsupported claims. The report prints pass rates per family
per arm, every failure with the evidence quoted, investigation stats (reads per decision), and
the measured cost per arm from the local ledger.

**Phase 5 — the run.** Execute the corpus twice — Opus 5 arm, GLM arm — analyze, and write the
findings document. That pair of numbers is the Opus-switch verdict and the collapse baseline.

## Secrets & env preflight

- **Phase 1:** local stack running (`npx supabase start`, `.env.test` — already required);
  `ANTHROPIC_API_KEY` in `.env` (already present); `INFERENCE_API_KEY` in `.env` (already
  present). No new secrets anywhere.
- **Phases 2–4:** none beyond Phase 1.
- **Phase 5:** same keys; spends real money (est. $12–17 Opus arm + $1–2 GLM arm) — both
  drivers require `--yes`.

## Phase 1: Simulator core — seed, tick, capture

### What this phase does
Creates `scripts/agentic-eval/` (driver) and `src/eval/plannerSim.ts` (typed core): scenario
seeding into the local stack, the single-tick runner with production-faithful wiring, transcript
capture, per-arm env pinning, and JSONL results. Two smoke scenarios prove the loop.

### Changes required

**`src/eval/plannerSim.ts`** (new)
- `interface PlannerScenarioWorld` — declarative rows: customer/job/visit/technicians, the
  nudge (kind, status `asked`, `asked_at`/`escalate_after` as OFFSETS from sim-now,
  **`subject_ref` PINNED by kind** — assignmentId for `overdue_visit_gap`, jobId for
  `job_cost_gap`, so the live detectors' once-ever dedup suppresses re-detection instead of
  minting duplicate gaps every tick — and context matching watchers.ts's shape), optional
  evidence captures, money events, prior `nudge_decisions` history rows (back-dated), optional
  active `planner_lessons`.
- `seedScenario(sql, tenantId, world, nowMs)` — resolves offsets to instants; direct SQL with
  explicit timestamps (see Decisions). Captures are inserted right the first time — L1 forbids
  UPDATE even locally.
- `setSimClock(tenantId, iso)` — sets `process.env.EVAL_FAKE_NOW = tenantId + ':' + iso`;
  the ONLY writer.
- `runTick(tenantId, nowIso, capture)` — mirrors lifecycle.ts:383-395: `runWatchers(nowIso,
  'live', {listTenants: async () => [tenantId], notify: async () => {}, hasPushToken: () =>
  false}, 'live')` then `runPlanner(nowIso, 'live', {listTenants: async () => [tenantId],
  tools: [...TEAM_LEAD_TOOL_SCHEMAS], sweepLive: true, execute: (t, name, args) =>
  dispatchForIdentity(name, args, {tenantId: t, technicianRef: TEAM_LEAD_REF}), runLoop:
  capture.wrap(runToolLoop)})`. The notify/push no-ops are load-bearing: `.env` holds a real
  `BOARD_BOT_TOKEN`, and an un-stubbed item-opening tick would message a real Telegram chat.
  Mode 'live' so decisions APPLY — arcs need real state motion. After the tick: the sim-time
  fix-up UPDATE (Decisions), then read back.
- `interface TickRecord` — `{nowIso, plannerSummary, decisions (read back from
  nudge_decisions since tick start), toolCalls: ToolLoopCall[], userPrompt (the runLoop
  request's `user` string — the rendered gap blocks + lessons block, captured by the wrapper;
  Phase 4's judge and claims-grading need it and it cannot be reconstructed after the
  per-scenario delete), nudgeAfter}`.
- Window guard: `runTick` throws if `nowIso` falls outside the 7:00–19:00 firm-local ask
  window (`insideAskWindow`, src/teamLead/compose.ts) unless the scenario declares
  `expectWindowSkip` — outside it the planner records NOTHING and a grader would fail
  spuriously.

**`scripts/agentic-eval/run.mjs`** (new)
- Flags: `--arm opus|glm` (sets `MODEL_PROVIDER`/`ANTHROPIC_MODEL=claude-opus-5` or
  `MODEL_PROVIDER=openai` before anything runs), `--yes` (money gate printing scenario count ×
  arm first), `--dry` (list scenarios/families/est. cost, exit 0, spend nothing), `--only
  <ids>`, `--out`. Target guard: `requireLocalStack()` from scripts/spine-eval/lib/env.mjs.
- Creates ONE eval tenant (`Eval PlannerSim`, tz America/Los_Angeles) per run; run-start
  truncate uses a reset list COPIED into this script — world.mjs exports nothing and executes
  `main()` on import, so its `RESET_TABLES` cannot be imported — and the copy adds
  `money_events` (absent from world.mjs's list; it relies on cascade there). Per-scenario:
  delete tenant-scoped gap-family rows (nudges cascades nudge_decisions + gap_summaries;
  review_items by tenant); captures stay (L1 append-only — inserts only between truncates).
- Writes `spine-eval-runs/agentic-<arm>-<stamp>/results.jsonl` (one row per scenario:
  scenario id, expects, all TickRecords, wall ms) + `meta.json` (arm, model, started).

**`src/eval/plannerSim.test.ts`** (new)
- Seeding round-trip on the local stack; `setSimClock` fail-closed shape; a full smoke tick
  with a STUBBED `runLoop` (no model). The stub MUST drive the executor it is handed — call
  `execute('submit_plan', <plan>)` then return `{text, turns, calls}` — because decisions
  exist only via `validateDecisions` inside the submit_plan branch (planner.ts:1355-1383); a
  stub that merely returns records nothing. Asserts: watchers ran, decision recorded,
  transcript + userPrompt captured, sim-time fix-up applied (decided_at == sim-now).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (2225 passed incl. 7 new
      plannerSim tests; 2026-08-24)
- [x] `npm run build`, then `node scripts/agentic-eval/run.mjs --arm glm --only
      SMOKE-1,SMOKE-2 --yes` completes on the local stack; results.jsonl has 2 rows each with
      a captured transcript, a stored userPrompt, and a decision read back from
      `nudge_decisions` (run agentic-glm-2026-08-24T08-44-41: escalate/applied + leave/applied)

### Live verification (agent-executable)
- Prerequisites: local Supabase stack + `FIREWORKS_API_KEY`.
- [x] The GLM smoke run above IS the live check (real model, real tools). Evidence: SMOKE-1's
      transcript shows `recall_decisions` echoing the SEEDED history (decidedAt at the exact
      −8h offset) plus six `spine_read`s before submit_plan; the block renders the seeded
      capture; the date rail fired live on GLM's agentContext ("Monday"/"today" dropped);
      ledger rows: glm-5.2-fast cached-input/input/output + spine tool_call on the local
      stack. (SMOKE-1's lure is history via recall_decisions rather than the originally
      drafted pre-ask evidence — evidence seeding is exercised and asserted in the round-trip
      test instead.)

### Manual verification
- [ ] none

---

## Phase 2: The multi-tick engine

### What this phase does
Adds timelines: scripted events between ticks, clock advancement, arc capture, and the ⑤
epilogue.

### Changes required

**`src/eval/plannerSim.ts`**
- `interface TimelineStep` — `{at: '+20h', kind: 'tick' | 'capture' | 'money' | 'deliver' |
  'manager_resolve'}` with payloads; `runArc(tenantId, scenario, deps)` — iterates steps in
  order: `setSimClock` + insert/update for non-tick steps, `runTick` for ticks; stops early
  when the nudge leaves open statuses; guards: max 12 ticks, monotonic offsets (throw on
  regression — a backwards clock invalidates the arc).
- `deliver` step (review finding): compose and the box are out of the loop, so nothing else
  moves a `pending` nudge to `asked` — this step is the simulated delivery (SQL flip to
  `asked` + sim `asked_at`). Without it, send/hold arcs stall until the 18h expiry.
- `manager_resolve` step: resolves/dismisses the scenario's review item at sim-now — needed
  both for manager-fate arcs AND because the gap-summaries HOLDBACK (open item within 7 days,
  summarize.ts:118-124) would otherwise swallow every escalated arc's epilogue in a same-day
  run.
- Handoff timing (review finding): a planner `escalate` only moves the deadline; the SWEEP
  performs the handoff on the NEXT tick (planner.ts:1138, watchers.ts:744-820) — so any arc
  grading the handoff schedules one more tick after the expected escalate decision. Recorded
  here so corpus authors don't rediscover it.
- Epilogue: `runGapSummaries(finalNowIso)` then read back the gap's `gap_summaries` row
  (absent for still-open gaps — recorded, not an error).
- Single-tick scenarios become 1-step timelines — one code path.

**`src/eval/plannerSim.test.ts`**
- An arc with a scripted mid-life capture: stubbed runLoop first extends then escalates;
  assert state transitions between ticks (escalate_after moved, review item opened by the
  sweep), the clock strictly advanced, and the epilogue summary row matches the arc.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` (2227 passed incl. 2 new arc tests)
- [x] Stubbed-loop arc test passes incl. sweep-driven transition and epilogue read-back
      (extend → capture → escalate → sweep handoff on tick 3 → manager_resolve at sim +6h →
      summary with manager_fate 'resolved' and non-null manager_latency_wh)

### Live verification (agent-executable)
- Prerequisites: same as Phase 1.
- [x] One real-model arc (GLM) via `--only ARC-SMOKE --yes`: 2 ticks; tick 1 saw the open
      cost hole (recorded `unmentioned`); the mid-arc material_cost is visible in tick 2's
      prompt (THE RECORD line fired); GLM closed basis `record` with code's citation; epilogue
      gap_summaries row `answered`, working_hours_open 3.5 (10:00→13:30 firm-local — the
      working-hours math riding the sim clock). Run agentic-glm-2026-08-24T08-54 + re-run
      after review fixes.

### Manual verification
- [ ] none

---

## Phase 3: The corpus — ~60 scenarios

### What this phase does
Authors the corpus in `src/eval/plannerCorpus.ts` from the failure taxonomy, with expectations
as data.

### Changes required

**`src/eval/plannerCorpus.ts`** (new)
- `interface PlannerScenario` — `{id, family, why (provenance: which specimen/ruling/metric),
  world: PlannerScenarioWorld, timeline: TimelineStep[], expect}`; `expect` fields:
  `action`/`actionNot` (per named tick), `mustName[]`, `mustNotClaim[]`, `mustRead` (predicate
  DATA over the transcript, e.g. `{tool: 'spine_read', touching: 'money'}`), `arc`
  (`maxEscalations`, `noWhiplash`, `closedBy`, `escalatedBy` — offsets), `lessonCited?`.
- Families and counts (≈60): false-claims 10 (incl. the 2026-08-20 specimen shape), context-
  miss 10, premature 8, late/stuck 8 (mostly arcs), people-judgment 8, multi-gap 8, lessons 4,
  date/window edges 6 (evening asks, weekend, DST week). ~12–15 are multi-tick arcs.
- Every `why` cites its provenance (eng-memory entry, plan, mv_ definition) — the corpus is a
  record, not folklore.

**`src/eval/plannerCorpus.test.ts`** (new)
- Every scenario seeds cleanly against the local stack (loop, no model); ids unique; offsets
  monotonic; every `mustNotClaim` string lowercase-normalized; family counts pinned. Plus the
  three review-mandated structural asserts, per scenario: (a) every `tick` offset lands inside
  the 7:00–19:00 firm-local window unless `expectWindowSkip`; (b) every seeded OPEN gap's due
  time (`dueAtOf` semantics) is LATER than the first tick — or the scenario explicitly expects
  the sweep, not the planner, to act (the sweep runs first and would escalate/auto-close a
  stale gap before the planner ever sees it); (c) `subject_ref` is pinned to the
  kind-appropriate id (assignmentId / jobId).

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` (corpus render test = the gate)
- [ ] `node scripts/agentic-eval/run.mjs --arm glm --dry` lists all ~60 with families and
      estimated ticks/cost, exits 0 without spending

### Live verification (agent-executable)
- [ ] none this phase (authoring; Phase 5 exercises it)

### Manual verification
- [ ] User skim of the corpus listing (`--dry` output): do the families and specimens match
      what you meant? (judgment call on coverage, not mechanics)

---
*Pause after Phase 3 for the corpus skim.*

## Phase 4: Grading and the report

### What this phase does
Deterministic graders (typed, tested), the blind judge, and `analyze.mjs` producing report.md
and a two-arm comparison.

### Changes required

**`src/eval/plannerEvalGraders2.ts`** (new; name avoids colliding with existing
plannerEvalGraders.test.ts which tests the OLD scripts/planner-eval graders)
- `gradeScenario(row) => Finding[]` — checks in order: expected action per tick;
  claims (`mustNotClaim`/`mustName`) against handoffNote+reason, reusing `cleanHandoffNote`
  from dist for the date rail; `citation` resolves to a seeded row id; `mustRead` predicates
  over captured `toolCalls`; arc shape (escalation count, whiplash = extend→escalate→extend
  patterns from decisions, deadlines vs `escalatedBy`); `lessonCited`. `Finding = {kind,
  detail, tick}` — empty = pass. Pure functions over the results row; no DB.

**`scripts/agentic-eval/analyze.mjs`** (new)
- Reads a run dir; applies graders; `--judge` adds the blind judge per failed-or-flagged note
  (adapt scripts/planner-eval/judge.mjs — the block is the gap's section of the stored
  `userPrompt` from the TickRecord, never re-rendered); prints per-family table, every
  failure with quoted evidence,
  investigation stats (reads/decision, % decisions preceded by a relevant read), cost per arm
  read back from local `cost_events` since run start; writes `report.md` + `rows.json`.
- `--compare <dirA> <dirB>` renders the Opus-vs-GLM table (per-family pass rates, hard
  failures, cost, latency, reads/decision).

**`src/eval/plannerEvalGraders2.test.ts`** — grader unit tests from fixture rows: one
passing, one per failure kind (wrong action, false claim, missing read, whiplash arc,
unresolvable citation).

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test`
- [ ] `analyze.mjs` on Phase 1/2's smoke run dirs produces report.md with zero crashes and the
      cost line matching the ledger sum

### Live verification (agent-executable)
- Prerequisites: `ANTHROPIC_API_KEY` (judge uses a cheap Anthropic model).
- [ ] `--judge` on one deliberately-false note (fixture) returns unsupportedClaims non-empty;
      evidence: the verdict JSON quoted in the phase report

### Manual verification
- [ ] none

---

## Phase 5: The at-scale run — Opus 5 vs GLM

### What this phase does
Runs the full corpus on both arms, analyzes, compares, and records findings.

### Changes required
- No source changes. Runs: `run.mjs --arm glm --yes`, `run.mjs --arm opus --yes`,
  `analyze.mjs` each + `--compare`; findings written to
  `docs/agentic-eval-baseline-2026-08.md` (headline per-family table, hard failures, cost,
  the not-a-benchmark caveat if scenario count or arms change later); eng-memory entry.

### Automated verification
- [ ] Both runs complete with 0 harness errors (scenario failures are results, not errors)
- [ ] `--compare` report renders; cost lines match `cost_events` sums per arm

### Live verification (agent-executable)
- Prerequisites: both API keys, local stack.
- [ ] The runs themselves; evidence: results.jsonl row counts = corpus size × arms, report.md
      committed alongside the findings doc

### Manual verification
- [ ] Read the findings with the user: which families each model fails, and whether the
      collapse baseline is trustworthy enough to proceed

---
*Pause after Phase 5 — the findings review is the point of the exercise.*
