---
date: 2026-08-20
branch: feat/planner-phase-4-decisions
commit: c0bbfdb
topic: The planner's memory surfaces after Phase 4 — what stores agent experience, what reads it, and what would be needed to measure whether it helps
---

## Summary

The team-lead planner decides, every 30 minutes, what should happen to each open gap in a firm's
record. As of Phase 4 (commit `c0bbfdb`) it has, for the first time, somewhere to put what it
decided and a way to read it back. This document maps every place agent experience is currently
stored, who can read each one, how a "lesson" would relate to the business record if one were ever
written, and what the existing date-eval harness shows about what measuring decision quality
actually takes.

Plain-language terms used throughout: **L1** is `raw_captures`, the append-only verbatim record of
things people said. **L2** is the structured record — `customers → jobs → visits`. **L3** is the
`attributes` JSONB column on L2 rows. **A gap** is a hole in the record that the ladder is chasing;
its row lives in `nudges`.

## Entry Points

| Where it begins | File:line |
|---|---|
| The planner tick (cadence gate, mode read) | [lifecycle.ts:352](src/jobs/lifecycle.ts#L352) |
| `runPlanner` — the whole per-firm loop | [planner.ts:593](src/teamLead/planner.ts#L593) |
| History read for the tick's gaps | [planner.ts:684](src/teamLead/planner.ts#L684) |
| The one pushed history fact | [planner.ts:231](src/teamLead/planner.ts#L231) |
| Decisions applied, then recorded | [planner.ts:783](src/teamLead/planner.ts#L783) |
| One decision → one write | [planner.ts:558](src/teamLead/planner.ts#L558) |
| `recall_decisions` dispatch | [server.ts:5076](src/mcp/server.ts#L5076) |
| The team-lead-only gate | [server.ts:2070](src/mcp/server.ts#L2070) |

## Key Files

**`src/db/nudgeDecisions.ts`** (new, Phase 4) — the decision log's typed layer.
- `recordNudgeDecisions(inputs)` ([:37](src/db/nudgeDecisions.ts#L37)) — insert-only, chunked at 500.
- `listDecisionsForNudges(tenantId, nudgeIds)` ([:78](src/db/nudgeDecisions.ts#L78)) — the batched
  per-tick read; returns `Map<nudgeId, NudgeDecision[]>`, oldest first, paged at 1000.
- `listDecisionsForNudge` / `listDecisionsForJob` — the two `recall_decisions` lookups, capped at
  200 rows.

**`supabase/migrations/20260820120000_nudge_decisions.sql`** — 14 columns. Identity
(`tenant_id`, `nudge_id` FK cascade, `job_id` denormalised, no FK), the decision (`mode`, `action`,
`not_before`, `basis`, `citation`, `confidence`, `reason`), and the outcome (`outcome`,
`outcome_detail`). No `updated_at`, no trigger — append-only by convention, enforced only by the
fact that no model-reachable tool can write here.

**`src/teamLead/planner.ts`** — `historyLine()` ([:231](src/teamLead/planner.ts#L231)) renders the
single pushed fact; `applyDecision()` ([:558](src/teamLead/planner.ts#L558)) performs one decision
and reports what happened; the record block ([:783](src/teamLead/planner.ts#L783)) writes both
accepted and rail-refused entries.

**`src/mcp/server.ts`** — `TEAM_LEAD_TOOLS` now holds two entries (`spine_read`,
`recall_decisions`); `TEAM_LEAD_ONLY_TOOL_NAMES` is derived from that array, and the inverse gate at
[:2070](src/mcp/server.ts#L2070) refuses both to any non-`spine:` badge.

**`src/db/standingFacts.ts`** — the repo's existing "fact with provenance" pattern, and the closest
structural analogue to a distilled lesson. See Constraints.

**`scripts/date-eval/`** — the only decision-quality eval that exists. `corpus.mjs` (507 lines),
`plan.mjs` (179), `run.mjs` (320), `analyze.mjs` (628), `adjudicate-db.mjs` (133), `README.md` (167).

## Data Flows

### One planner tick, end to end

```
lifecycle cron (*/5)  ──gate: getUTCMinutes() % 30 < 5──▶  runPlanner(nowIso, mode)
                                                                │
   per tenant: open nudges → ask-window check → 3 BATCHED READS │
        ├─ listJobEvidenceSince   (L1 captures after the ask)   │
        ├─ listJobIdsWithCostEvents (the ledger test)           │
        └─ listDecisionsForNudges  (the planner's own history)  │
                                                                ▼
                      buildGapView per gap ──▶ prompt: keys + evidence + ONE history line
                                                                │
                                            runToolLoop (spine_read, recall_decisions, submit_plan)
                                                                │
                                          validateDecisions  (rails; runs in BOTH modes)
                                                                ▼
                              live? ──yes──▶ applyDecision ──▶ setNudgeSchedule / markNudgeOutcome
                                 │                                        │
                                 └──no (shadow)──────────────┐            │
                                                              ▼            ▼
                                              recordNudgeDecisions(outcome = shadow|applied|refused)
```

The order is load-bearing: **apply, then record**, so `outcome` describes what happened rather than
what was intended.

### What reaches the model about its own past

Two channels, deliberately different sizes:

| channel | content | cost |
|---|---|---|
| **pushed** (always present) | `prior decisions: N (last: <action><marker>, Xh ago)` | ~15 tokens/gap |
| **pulled** (`recall_decisions`) | full rows: action, reason, confidence, basis, citation, outcome, outcomeDetail | one loop turn |

The marker distinguishes the three outcomes: nothing for `applied`, ` — REFUSED`, and
` — shadow, not applied` ([planner.ts:231-247](src/teamLead/planner.ts#L231-L247)).

### Every store of agent experience that exists today

| store | what it holds | keyed by | who reads it |
|---|---|---|---|
| `nudge_decisions` | one decision + outcome per gap per tick | `nudge_id`, `job_id` | the planner (`recall_decisions`, and the pushed line) |
| `nudges` | the gap itself: question text, state, timings, `resolution` | `subject_ref` | watchers, compose, the box runner, the planner |
| `review_items` | manager-facing handoffs, `detail` JSONB + `suggestion` | `subject_ref` | managers (via admin tools), the sweep |
| `raw_captures` (L1) | verbatim human text, plus outbound agent actions | `job_id`, `customer_id` | everything; append-only |
| `cost_events` | token/tool spend | `technician_ref` (`spine:team-lead`) | the cost rollup |
| L3 `attributes` | standing facts about a customer/job | the L2 row | `get_job` / `get_customer_context`, rendered to managers |
| box transcripts | seat-agent conversation history | the sandbox session | the agent itself, on its own box |

**Tool calls are not in this table because they are not stored anywhere.** `runToolLoop` returns a
`calls[]` array carrying turn number, tool name, arguments, result and success flag;
[planner.ts:863](src/teamLead/planner.ts#L863) consumes `result.calls.length` and the rest is
garbage-collected when the tick ends.

**`cost_events` has the hooks for attribution and does not use them.** The table carries
`source_ref` and `metadata` columns, but `recordModelUsage` ([costs.ts:173](src/db/costs.ts#L173))
builds its rows from `{tenantId, technicianRef, provider, unit, method}` only. So spend is
attributable to *the planner as a whole* and to nothing finer — not a firm's gap, not a job, not a
decision.

## External Dependencies

- **Supabase / PostgREST** — every store above. The 1000-row default cap is silent, which is why
  each batched read pages explicitly.
- **The inference provider** (GLM-5.2 via Fireworks, `deepinfra-prod` as manual rollback) — the
  planner's single model call per firm per tick.
- **Render cron** (`*/5`) — the only thing that invokes `runPlanner`.
- **ssh to trades-box-1** — required by `date-eval/run.mjs`, which drives the agent on the box.

## Constraints and Invariants

1. **`StandingFactBundle` cannot hold a lesson as it stands.** The bundle is exactly three keys —
   `{value, sourceCaptureId, recordedAt}` — `value` must be a **scalar**, and `isFactBundle`
   ([standingFacts.ts:20](src/db/standingFacts.ts#L20)) checks for *exactly* those keys so that a
   plain attribute is never misread as a fact. Provenance is **one L1 capture id**. A lesson
   distilled from decisions has no capture to cite: its evidence is a set of `nudge_decisions` rows.

2. **The only removal path for an L3 fact is retracting its evidence capture.**
   `foldRetractedFacts` ([standingFacts.ts:42](src/db/standingFacts.ts#L42)) drops a fact when its
   `sourceCaptureId` was retracted; there is no delete tool. A fact whose provenance is not a
   capture therefore has no removal path at all.

3. **L3 is rendered to managers as business fact.** `get_job` folds retractions and returns
   `attributes` ([server.ts:2460-2462](src/mcp/server.ts#L2460-L2462)); `get_customer_context` does
   the same for customers. Anything written there is read as record, not as inference.

4. **`recall_decisions` is reachable only from the `spine:` namespace**, and only because it appears
   in *both* `TEAM_LEAD_TOOLS` (schema handed to the loop) and `TEAM_LEAD_TOOL_NAMES`
   ([identity.ts:22](src/teamLead/identity.ts#L22)). The allowlist is deny-by-default: a tool in one
   list and not the other is dead — the exact state `query_spine` was in before its removal.

5. **`SPINE_VIEW_CATALOG` is shared** between `query_spine` (managers) and `spine_read` (planner),
   so any new *view* is visible to both. `recall_decisions` is a tool rather than a ninth view for
   this reason.

6. **Decision-log growth is bounded by the sweep, not by this table.** While the ladder is live a
   gap cannot outlive its escalation or delivery deadline. With `NUDGES_MODE` rolled back the
   planner still runs (deliberate, [lifecycle.ts:346](src/jobs/lifecycle.ts#L346)) and nothing
   closes the gap, so rows accrue at ~24/day indefinitely.

7. **A refused close stores no citation.** [planner.ts:825-838](src/teamLead/planner.ts#L825-L838)
   records rail-refused decisions but deliberately omits `citation`, so a quote the rails rejected
   as unfindable is never preserved in a column read as evidence.

8. **Only the last submission is recorded.** `outcome` holds the most recent `submit_plan`; if a
   wholly-refused first attempt is followed by a corrected one, the first attempt's refusals are not
   written anywhere.

9. **An empty plan writes nothing.** Leaving every gap alone is a legitimate choice, and it is
   indistinguishable in `nudge_decisions` from the planner not having run. `cost_events` under
   `spine:team-lead` is the only record that a tick occurred.

### What the date-eval harness required to be trustworthy

Read as a specification of the cost of measuring decision quality, `scripts/date-eval/README.md`
documents these properties:

- **An independent second implementation of the truth.** `corpus.mjs` reimplements the date math and
  "must never import `src/schedule/dateResolve.ts`: that is the code under test, and a shared helper
  would make the resolve check agree with the machinery exactly when the machinery is wrong."
- **Truth derived at plan time from the live DB**, not pinned in the file, so a shifted schedule
  moves the corpus with it.
- **Phase attribution by earliest-failing-phase**, with downstream phases marked `inherited` and
  dropped from their own denominators.
- **A separation of machinery failure from model failure** — the analyzer recomputes every tool call
  independently to tell "the tool returned the wrong thing" from "the model asked the wrong thing".
- **Plan / run / report as three commands**, with `run` refusing to start without `--yes`, a model
  check, a failover abort that re-reads the inference route after every question, and a stale-manifest
  guard.
- **A fresh session per question** (`dateval-<date>-<id>`), never the live chat.
- **A mechanical adjudicator** (`adjudicate-db.mjs`) for the rows the text grader cannot settle,
  written because 34 of 94 rows on the 2026-08-13 run "were judged by hand-run SQL … the judgments
  were right, but they lived in a conversation."
- **A documented blind spot**: `run.mjs` drives the box over ssh, where AGENTS.md has been observed
  truncating at 12,000 characters, so doctrine-dependent behaviour cannot be judged from this path.

## Decision Points

1. **Where a distilled lesson would live.** L3 `attributes` is the existing home for durable
   customer/job facts, but the bundle shape admits only a scalar `value` with one L1 capture as
   provenance, and `get_job` renders L3 to managers as fact. A lesson derived from decisions fits
   neither constraint. The forks: widen `StandingFactBundle` (which changes `isFactBundle`'s
   exact-keys guard and the retraction fold that depends on it); add a separate table alongside
   `nudge_decisions` keyed by customer/job; or keep lessons only as derived reads over
   `nudge_decisions` with nothing new stored.

2. **Whether traces get stored at all.** Tool calls exist in memory during a tick and are discarded.
   Storing them makes replay and a future distillation pass possible; not storing them keeps the
   only persisted artifact the already-abstracted decision row.

3. **Whether spend becomes attributable.** `cost_events.source_ref` and `.metadata` exist and are
   unused by `recordModelUsage`. Populating them would make "what did deciding about this gap cost"
   answerable; leaving them keeps one writer and one shape for all spine model spend.

4. **Whether an eval precedes further memory work.** The only decision-quality harness in the repo
   is `date-eval`, and its README documents what made it trustworthy: an independent truth
   implementation, truth derived from the live DB, phase attribution, and a mechanical adjudicator.
   No equivalent exists for planner decisions. The fork is ordering: build the measurement first and
   evaluate each memory change against it, or build memory first and measure later against a corpus
   that `nudge_decisions` will have accumulated in the meantime.

5. **What the unit of a planner eval would be.** `date-eval` grades one *answer* per question in a
   fresh session. A planner tick produces a *set* of decisions over a live queue whose state changes
   between ticks, and `nudges` rows are `uq_nudges_subject_ever`-deduped, so the same gap cannot be
   re-created to re-run it. The fork is whether the gradable unit is a replayed prompt, a whole tick,
   or a gap's full life.

## Open Questions

- **Does the pushed history line change behaviour?** It landed with Phase 4 and has not been
  observed against a gap that has any history — at the time of writing `nudge_decisions` holds zero
  rows on the pilot.
- **Does the planner call `recall_decisions` unprompted?** The prompt instructs it to, but tool
  choice is the model's, and no tick has yet run with a non-empty history to consult.
- **Is `nudge_decisions` growth real in practice?** Constraint 6 describes an unbounded path that
  requires `NUDGES_MODE` to be rolled back while `PLANNER_MODE` stays on; whether that combination
  ever persists long enough to matter is unmeasured.
- **Can a decision be replayed?** `date-eval`'s "make every task roll-outable" property has no
  analogue here: reconstructing the exact prompt for a past tick would need the evidence and ledger
  reads as they were at that moment, and neither is snapshotted.
- **What does the manager see when the planner is wrong?** `review_items.suggestion` carries the
  escalation copy, and the 2026-08-20 specimen shows that copy can be confidently false; whether a
  dismissal is recorded anywhere the planner could later read is not established by reading alone.
