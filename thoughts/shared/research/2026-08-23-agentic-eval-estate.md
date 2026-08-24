---
date: 2026-08-23
branch: main
commit: 1db627e
topic: the agentic-eval estate — every existing eval asset, how planner decisions are recorded and replayed, the grading machinery, and the world-building/clock constraints
supersedes: nothing
---

## Summary

The repo already contains three complete evaluation harnesses and a typed support library —
built for other subjects. The **spine-eval** (three tiers) measures the *seat agent* and the
MCP tool layer against a generated world; the **date-eval** measures the *box agent's* date
machinery over real gateway trajectories with four-phase failure attribution; the
**planner-eval** (newest, 2026-08-22) measures the *planner's manager-facing copy* by replaying
the real prompt assembly into one forced Anthropic call. What has never existed is an eval of
the planner *as an agent*: nothing anywhere runs the planner through its real tool loop
(investigate → decide) against a controlled world. Every ingredient for that is on the shelf —
a declarative world spec keyed to an anchor date, a per-tenant fake clock, an insert-only
decision corpus, deterministic graders with a strict oracle discipline, and the ⑤ layer
(gap_summaries + metrics views) that defines outcome vocabulary — but the two halves have
never been joined, and one production gap matters for any joining: the planner's tool-loop
transcript (what it read before deciding) is discarded after every tick; only counts survive.

## Entry Points

- [scripts/spine-eval/world.mjs:543](scripts/spine-eval/world.mjs#L543) `main()` — builds the
  eval world (local truncate-and-rebuild, or `--pilot` tenant-scoped).
- [scripts/spine-eval/run-tools.mjs](scripts/spine-eval/run-tools.mjs) /
  [run-agent.mjs](scripts/spine-eval/run-agent.mjs) /
  [run-gateway.mjs](scripts/spine-eval/run-gateway.mjs) — tiers 1–3.
- [scripts/date-eval/plan.mjs](scripts/date-eval/plan.mjs) → [run.mjs](scripts/date-eval/run.mjs)
  (or [run-direct.mjs](scripts/date-eval/run-direct.mjs)) → [analyze.mjs](scripts/date-eval/analyze.mjs).
- [scripts/planner-eval/run.mjs](scripts/planner-eval/run.mjs) →
  [analyze.mjs](scripts/planner-eval/analyze.mjs).
- [src/teamLead/planner.ts:1345](src/teamLead/planner.ts#L1345) — the production planner call
  (`runToolLoop` with `terminalTool: 'submit_plan'`); its decisions land via
  [src/db/nudgeDecisions.ts:71](src/db/nudgeDecisions.ts#L71) `recordNudgeDecisions`.

## Key Files

### The typed eval library (`src/eval/` — unit-tested, 8.3k lines)

- **clock.ts** (277 L) — date arithmetic as a *deliberate second implementation*: never imports
  `dateResolve.ts`, because "an oracle that shares code with its subject is not an oracle"
  (clock.ts:1-11). `firmToday()` is the single real-clock read.
- **worldSpec.ts** (1166 L) — the eval world as a declarative spec of *day offsets against an
  anchor*; `buildWorldSpec(anchor)` is pure (no DB/clock/IO), so a failing scenario reproduces
  from `(anchor, seed)` alone (worldSpec.ts:1-10).
- **worldManifest.ts** — the APPLIED world with real DB uuids; scenarios reference the manifest,
  never hardcoded ids.
- **corpus.ts** (1489 L) — tier-2's 59 scripted conversations (`Scenario` at corpus.ts:47-73:
  `turns(ctx)`, `graders(ctx)`, `endState` DB read-back, `requires`, `expectedRefusals`).
- **toolCases.ts** (1403 L) — tier-1 tool cases: latency, HTTP+HMAC integration, tier gating,
  cross-tenant isolation (toolCases.ts:1-16).
- **graders.ts** (454 L) — deterministic trajectory graders; one LLM judge exists in the whole
  family (briefing prose) and is reported separately because "a headline number that depends on
  a model's opinion cannot be regressed against" (graders.ts:1-11).
- **trajectory.ts** (309 L) — parses OpenClaw session JSONL into the same `Trajectory` shape the
  graders consume — the trick that makes tier 3 "same scenarios, same rules, different
  transport" (trajectory.ts:1-10).
- **dateMatrix.ts** — every calendar trap on demand, because `resolveDate` takes `todayLocal`
  as a parameter (dateMatrix.ts:1-11).
- **doctrine.ts** — extracts the real AGENTS.md doctrine from `Box_Setup_Stuff/bootstrap-box.sh`
  so drift fails `npm test` instead of silently weakening the eval.
- **targetGuard.ts / pilotGuard.ts** — two guards that disagree by construction: one refuses
  everything that IS the pilot, the other everything that is NOT; truncation against the pilot
  is unreachable (`assertTruncationAllowed` throws) (pilotGuard.ts:10-28).
- **thresholds.ts / metrics.ts / baseline.json** — what "green" means: `HARD_FAILURES` (commit
  without yes, fabricated date/link, weekday mismatch, leaked content) fail regardless of
  baseline; the anti-tamper **seal** hashes corpus+thresholds so a /goal loop cannot win by
  editing the test (metrics.ts:1-8, gate.mjs:25-32).
- **evalClock.ts** (src/evalClock.ts:14) — `EVAL_FAKE_NOW=<tenantId>:<ISO>` pins the spine's
  "now" for EXACTLY ONE tenant, fail-closed three ways; how the date-eval manufactures the
  adversarial evening regime at any wall-clock hour.

### Harness 1 — spine-eval (subject: the seat agent + tool layer)

Three tiers (README.md:8-11): tier 1 mechanical tool calls over loopback HTTP; tier 2 a real
model driven by the harness itself against the in-process MCP server (env:
`EVAL_INFERENCE_API_KEY`/`EVAL_MODEL`, OpenAI dialect + variants); tier 3 the same corpus
through the real OpenClaw gateway (`ssh → nemoclaw s6 exec → openclaw agent`, pilot DB,
badge-signed identity). Grading = deterministic graders + a **DB end-state read-back** per
scenario; verdict is `findings.length === 0`. Artifacts: `tier{1,2}-results.json` + reports,
`tier3-report.json` + per-scenario trajectory JSONL. `gate.mjs` compares against
`src/eval/baseline.json` and exits 0/1 for a /goal loop.

### Harness 2 — date-eval (subject: the box agent's date machinery)

`plan.mjs` reads pilot schedule facts (SELECT only; target must be pilot or localhost) and
builds a ≤96-question corpus whose ground truth is server-side SQL + the independent date oracle
(corpus.mjs:28-74). `run.mjs` drives the box over ssh, one throwaway session per question,
**pulling each trajectory back** — stdout is never graded (run.mjs:29-34; the 2026-08-15 v5 run
graded 14 dead turns against CLI chrome). `run-direct.mjs` is Arm D: same questions to a direct
Anthropic call with code-supplied context (`--model claude-opus-5`), no box — this is the
2026-08-23 "91 questions, zero date errors on a bare clock line" run. `analyze.mjs` grades four
phases (Resolve → Use → Speak → Guard) and attributes each failure to the *earliest failing
phase*, splitting `machinery` from `model`; `adjudicate-db.mjs` mechanically settles
`needs-adjudication` rows whose truth is a DB query. Rails: `.runid` nonce (same-day re-runs),
staleness gate (`manifest.today` vs box date, fatal >1.5 days — the midnight-straddle lesson),
`DATE_EVAL_EXPECT_MODEL` route check with mid-run failover abort.

### Harness 3 — planner-eval (subject: the planner's decisions + manager copy, 2026-08-22)

The direct ancestor of the eval this research serves. `scenarios.mjs`: 6 scenarios, each a real
`Nudge` row rendered through the **real** `buildGapView` + `buildPlannerUserMessage` out of
`dist/`, sent with the **real** `PLANNER_SYSTEM` + `submit_plan` schema (run.mjs:1-10). Its
stated fidelity bound (run.mjs:12-20): the model gets ONE forced call — production hands it
four read tools first inside `runToolLoop` — so it measures "given context already gathered,
does it decide and write well", NOT "does it find what it needs". `expect` states facts a
correct note must/must-not contain (`action`, `actionNot`, `mustName`, `mustNotClaim`).
Grading: `graders.mjs` deterministic checks first (imports `cleanHandoffNote` from dist ON
PURPOSE — "the eval and production must share ONE rail"); `judge.mjs` a narrow judge for the
two things strings can't settle (blame, unsupported claims), which sees the BLOCK and the NOTE
and *never* the deterministic verdict or the scenario's `why` — "a judge shown the answer
grades the answer". `anthropic.mjs` is a standalone Anthropic caller with its own price table
and cache counterfactuals (NOT a production path; predates PR #177). Scenario S3's comment
records an expectation that was itself wrong and corrected — the eval's expectations are
falsifiable artifacts too.

### The production decision record (what an eval can replay or grade)

- **`nudge_decisions`** ([src/db/nudgeDecisions.ts](src/db/nudgeDecisions.ts)) — insert-only,
  never updated ("the history is read back into the model's context, and a context rewritten in
  place erodes"). One row per decision per tick: `action`, `reason` (diagnostic, the corpus),
  `confidence`, `basis`/`citation`, `outcome` (`shadow`/`applied`/**`refused`** — "a rail that
  rejects a decision has to leave a mark"), `escalateAfter` ("no eval can ask whether the
  planner postpones sensibly" without it), plus the three audience rails (`handoffNote`,
  `questionDraft`, `agentContext`) and `unmentioned` tick marks (silence is recorded).
- **The tick report** — `PlannerSummary`/`PlannerTenantPlan`
  ([planner.ts:130-163](src/teamLead/planner.ts#L130-L163)): per-tenant decisions, drops,
  `limitHits`, and `turns`/`toolCalls` — **counts only**. The loop's full call transcript
  (`ToolLoopResult.calls`: name, args, result string per call —
  [toolLoop.ts:111-118](src/model/toolLoop.ts#L111-L118)) reaches the planner and is reduced to
  `result.calls.length` ([planner.ts:1557](src/teamLead/planner.ts#L1557)); nothing persists
  what the planner read before deciding. A harness calling `runToolLoop` directly receives the
  full transcript; production discards it.
- **Replayable prompt assembly** — `buildGapView` and `buildPlannerUserMessage` are exported and
  already consumed from `dist/` by planner-eval; `PLANNER_SYSTEM` + `SUBMIT_PLAN_TOOL` likewise
  ([plannerPrompt.ts:196](src/teamLead/plannerPrompt.ts#L196)).
- **The planner's real tool surface** — `TEAM_LEAD_TOOL_NAMES`
  ([identity.ts:23-31](src/teamLead/identity.ts#L23-L31)): `spine_read`, `recall_decisions`,
  `get_customer_context`, `resolve_date`; deny-by-default at the dispatch gate. Production
  wiring: lifecycle passes `TEAM_LEAD_TOOL_SCHEMAS` + a `dispatchForIdentity` executor
  ([lifecycle.ts:383-395](src/jobs/lifecycle.ts#L383-L395)); the planner itself defaults to
  `tools: []` ([planner.ts:1196](src/teamLead/planner.ts#L1196)) — the roster is injectable.
- **The ⑤ corpus** — `gap_summaries` (one code-written row per closed gap: status, resolution,
  `working_hours_open`, `arc` jsonb, `escalated`, `manager_fate`/`manager_latency_wh`,
  `answered_by_capture_id`; [migration](supabase/migrations/20260824000000_gap_summaries.sql));
  four ACL-locked metrics views `mv_gap_outcomes`, `mv_escalation_fates`, `mv_whiplash`,
  `mv_extend_effectiveness` + `working_hours_between`
  ([v2 migration](supabase/migrations/20260824020000_planner_metrics_v2.sql));
  [scripts/planner-metrics/report.mjs](scripts/planner-metrics/report.mjs) prints them paired
  with denominators plus the lesson live/shadow usage split.

## Data Flows

The planner, in production (what any full-fidelity eval must reproduce):

```
lifecycle tick (cron, :00/:30 in-window)
  └─ runPlanner(nowIso, mode, {tools: TEAM_LEAD_TOOL_SCHEMAS, execute: dispatchForIdentity})
       ├─ buildGapView(nudge, now, evidence, …, money, tz)   per open gap
       ├─ buildPlannerUserMessage(now, tz, views, lessonsBlock)
       ├─ runToolLoop({system: PLANNER_SYSTEM, terminalTool: 'submit_plan'},
       │             [spine_read, recall_decisions, get_customer_context, resolve_date, submit_plan])
       │      └─ model investigates ≤8 turns / 90s → submit_plan → validateDecisions (rails)
       ├─ apply (live) → THEN recordNudgeDecisions (outcome = what happened)
       └─ tick report: counts only; loop transcript discarded
```

What each harness replays of that flow:

| | world | prompt assembly | tool loop | grading source |
|---|---|---|---|---|
| planner-eval | hand-built `Nudge` literals | real (dist) | **none** (one forced call) | plan JSON + note text |
| spine-eval t2/t3 | generated (worldSpec) | n/a (seat agent, not planner) | real agent loop | trajectory + DB end-state |
| date-eval | real pilot data | n/a (box agent) | real gateway session | trajectory, 4-phase |

## External Dependencies

- Anthropic API (planner-eval + date-eval run-direct, own caller in
  scripts/planner-eval/anthropic.mjs with its own price table — predates src/db/costs.ts's
  Opus SKUs and is not the production transport).
- OpenAI-compatible endpoint (spine-eval tier 2, `EVAL_INFERENCE_*` env, dialect flags).
- ssh to trades-box-1 + OpenClaw gateway (spine-eval tier 3, date-eval run.mjs).
- Local Supabase stack for anything that truncates (targetGuard); pilot for tier 3/date-eval
  reads and tenant-scoped pilot worlds (pilotGuard).

## Constraints and Invariants

1. **Build-once L1.** A stamped `raw_captures` row makes its customer/job/visit permanently
   undeletable (`on delete set null` is an UPDATE; the append-only trigger blocks UPDATE).
   world.mjs's sealed-tenant check (world.mjs:244-264) throws rather than rebuild; the
   prescribed re-anchor is SHIFTING visit dates, whole weeks, two passes (GiST exclusion
   constraint is non-deferrable). Any world that has been exercised through L1-writing flows is
   permanent; worlds are reproducible from `(anchor, seed)` instead.
2. **Truncation is fail-closed twice.** targetGuard (local-only proven, both DATABASE_URL and
   SUPABASE_URL independently) and pilotGuard (pilot-only, truncation unreachable) are separate
   files by design — "neither can be talked into the other's job".
3. **Oracle discipline.** Expectations never import the code under test (clock.ts vs
   dateResolve.ts; corpus.mjs's own date math) — EXCEPT where the eval must share a production
   rail to avoid measuring a rail we don't ship (planner-eval imports `cleanHandoffNote` from
   dist). Both directions are deliberate and documented in-file.
4. **Judges are narrow and blind.** Deterministic checks run first; the judge sees only the
   evidence (block + note), never the verdict, the expectation, or the scenario's `why`
   (hint-leakage rule). One judge per harness, reported separately from headline numbers.
5. **Trajectories, never stdout.** The graded artifact is the session transcript
   (date-eval run.mjs:29-34; spine-eval trajectory.ts) — stdout carries CLI chrome and delivery
   errors and once cost a whole run.
6. **Clock pinning.** Worlds pin "today" at build (`anchor`); `EVAL_FAKE_NOW` pins the spine's
   now per-tenant; date-eval refuses runs whose manifest day drifted >1.5 days from the box's
   day; nothing may start within ~1h of firm-local midnight (guard checks START only —
   2026-08-15 lesson).
7. **Money gates.** Every spending step requires `--yes` and prints scenario count × model
   first; grading steps re-run free from the persisted JSONL.
8. **Anti-tamper seal.** Corpus + thresholds are hashed into the baseline; loosening a
   threshold is as visible as deleting a scenario.
9. **Decision corpus is insert-only** — including `refused` outcomes and `unmentioned` marks;
   an eval can trust that silence and rail-rejections are in the record, not filtered out.
10. **Production keeps no investigation trace.** `nudge_decisions.citation`/`basis` are the only
    persisted echo of what the planner read; the tool-call transcript exists only inside the
    tick's process lifetime.

## Decision Points

1. **The gradable unit.** Three exist in embryo today: (a) *one forced call* on pre-gathered
   context — planner-eval's shape, cheap, already running, blind to investigation quality;
   (b) *one full tick* — call `runToolLoop` with the real four tools against a seeded world;
   the harness would receive the full call transcript that production discards, making
   "did it look before deciding" gradable; nothing does this today; (c) *a whole gap life* —
   multiple ticks against an advancing clock until the gap closes, graded against the
   gap_summaries vocabulary (premature/late/whiplash); requires clock advancement between
   ticks, which `EVAL_FAKE_NOW` (single pinned instant, env-var granularity) does not currently
   express in-process.
2. **Where the world lives.** The spine-eval world (local, truncate-rebuild, worldSpec offsets)
   has no nudges/gaps in its spec today; the planner needs `nudges` rows + evidence + money
   events. Options the code offers: extend worldSpec/world.mjs (they already name
   nudges/nudge_decisions/gap_summaries in RESET_TABLES), or hand-build rows like
   planner-eval's scenario literals, or harvest real gap shapes from pilot `gap_summaries`.
3. **Executor fidelity.** Production's executor is `dispatchForIdentity` (the real MCP dispatch
   gate). A world-backed eval can use the same executor against the local stack (tier-1's
   pattern: real server, loopback) or stub tools with canned results (deterministic, but stops
   measuring tool-use errors). Both seams exist (`PlannerDeps.tools`/`execute`).
4. **Provider/transport.** The harness can call through `src/model` transports (follows
   `MODEL_PROVIDER`, bills the ledger — see
   [2026-08-23-per-call-model-routing.md](2026-08-23-per-call-model-routing.md): one provider
   per process, `hasModelCredentials` follows the flip) or keep a standalone caller like
   planner-eval's `anthropic.mjs` (own pricing, no ledger rows, model pinned per run).
5. **Grading composition.** The estate's pattern is deterministic-first + narrow blind judge +
   DB end-state read-back + (date-eval only) phase attribution. Which of these the planner eval
   adopts — and whether decision-quality (premature/late) is graded per-decision or only at
   gap-life granularity via the ⑤ metrics — is open.
6. **Baseline/gate integration.** gate.mjs's seal-and-baseline contract exists for spine-eval
   tiers 1–2 only; whether planner results join that gate (one green/red for /goal loops) or
   stay a standalone report like date-eval's report.md is open.

## Open Questions

- Can `EVAL_FAKE_NOW` (read per-call in `spineNowIso`) be advanced *between* in-process ticks
  by mutating `process.env` mid-run, and do all planner-relevant code paths actually read time
  through `spineNowIso` vs `new Date()`? (planner.ts takes `nowIso` as an argument — the
  lifecycle passes the real clock; an in-process harness can pass any instant, which may make
  `EVAL_FAKE_NOW` unnecessary for unit (b)/(c). Unverified which downstream reads bypass the
  argument.)
- Whether the sweep (watchers) must run between eval ticks for gap-life realism (status
  transitions asked→answered/expired happen there, not in the planner).
- Whether pilot `gap_summaries` rows (11 at last count, all one firm) are diverse enough to
  seed scenario shapes, or the corpus must be authored from the failure taxonomy (premature/
  late/whiplash/false-claim/context-miss) the way tier-2's 59 were.
- The planner-eval price table (`anthropic.mjs PRICES`) now overlaps `cost_rates` rows added in
  PR #177 — two price books exist; which is authoritative for eval reporting is unsettled.
