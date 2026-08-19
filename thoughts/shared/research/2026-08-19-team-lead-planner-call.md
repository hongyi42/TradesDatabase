---
date: 2026-08-19
branch: fix/cost-detector-paid-and-corrections (src/ + migrations byte-identical to origin/main)
commit: 16f0778
topic: "The team-lead planner call — where centralized inference would attach, and how much per-detector decision code exists today"
---

## Summary

The spine has a "team lead": an identity (`spine:team-lead`) that notices gaps in the firm's
record and asks technicians about them through their own chat agents. **Today that identity makes
exactly one model call, and it writes a sentence.** `src/teamLead/compose.ts:18-19` states it
directly — *"the ONLY model call in the ladder"* — 462 tokens in, 66 out, `reasoningEffort:
'none'`, roughly $0.0014. Every other decision the team lead appears to make is hard-coded:
which gaps exist, who to ask, when to ask, when a gap counts as answered, when to escalate, and
what to tell the manager.

This document maps that decision surface for a proposed change of shape: **one planner model call
per firm per tick, over all open gaps at once**, replacing per-detector decision code with
centralized inference. The organizing constraint (user, 2026-08-19): detectors are the team
lead's *eyes* and will keep multiplying; the *decisions* they feed must not multiply in code with
them. Guard rails stay coded.

The measured finding that bears on that: **adding detector #2 cost about 370 lines of production
code**, of which roughly 110 are decision/copy code a planner could absorb and about 260 are the
eye itself — detection SQL and closure predicates — which are facts, not judgments, and would
remain.

## Entry Points

- `src/jobs/lifecycle.ts:319` — cron calls `runWatchers(nowIso, watchersMode, {}, nudgeMode)`.
- `src/jobs/lifecycle.ts:342` — `runTeamLeadCompose(nowIso)` in the SAME tick, gated at `:336`.
- `src/teamLead/compose.ts:146` — `runTeamLeadCompose`, the sweep containing the only model call.
- `src/teamLead/compose.ts:204-214` — the call itself: `runForcedTool(spec.compose.tool, {...})`.
- `src/model/forcedTool.ts:336` — `runForcedTool(tool, req, ctx)`, returns a schema-coerced object.
- `src/jobs/nudgeKinds.ts:83-106` — `NudgeKindSpec`, the per-detector contract.

## Key Files

| path | role in the decision surface |
|---|---|
| `src/jobs/nudgeKinds.ts` | the per-detector contract: brake, `filled`, `moot`, `handoff`, `compose` |
| `src/teamLead/compose.ts` | the ask window, the one model call, the manager-handoff doctrine |
| `src/teamLead/composeCopy.ts` | per-kind prompts + message assembly (the copy burden) |
| `src/jobs/watchers.ts` | detection passes, the sweep, escalation, rate brakes |
| `src/model/forcedTool.ts` | the structured-output seam any planner call would use |
| `src/control/nudgeQueue.ts` | host-scoped serve; one delivery item per row |

## Data Flows

### Where decisions are made today

```
runWatchers (per tenant)
 ├─ WHICH gaps exist ............ code   (SQL per detector)
 ├─ WHO to ask .................. code   (assignment's technician; reachability test)
 ├─ HOW MANY this tick .......... code   (spec.maxNewPerTenantTick + tenant ceiling 5)
 ├─ IS IT ANSWERED .............. code   (spec.filled over SweepFacts)
 ├─ IS IT MOOT .................. code   (spec.moot)
 ├─ ESCALATE? ................... code   (asked_at + 48h)
 └─ GIVE UP? .................... code   (created_at + 24h)

runTeamLeadCompose (per tenant)
 ├─ MAY WE ASK NOW .............. code   (7am–7pm firm-local)
 ├─ WHAT TO SAY ................. MODEL  ◀── the only inference in the ladder
 └─ SHOULD WE ASK AT ALL ........ MODEL  ◀── the `ask:false` decline path
```

### Where a planner call would attach

The seam between the two sweeps is the only point where all of a firm's open gaps are
simultaneously visible and none has been acted on yet. `runWatchers` has just created `pending`
rows; `runTeamLeadCompose` is about to compose every one of them.

```
runWatchers ──▶ pending rows (N gaps, all kinds)
                      │
                      ▼
              [ PLANNER CALL — one per tenant per tick ]
                 in : the open gaps + facts already fetched
                 out: for each gap — send now / hold until / group with
                      │
                      ▼
              code enforces the rails, then compose + deliver
```

`SweepFacts` (`nudgeKinds.ts:39-49`) is already assembled once per tenant per tick and already
carries activity, visit status, job status and the timezone closure — so a planner's input is
largely fetched today for other reasons.

## External Dependencies

- `runForcedTool` → OpenAI-compatible path, default `accounts/fireworks/routers/glm-5p2-fast`
  (`forcedTool.ts:55`), or the Anthropic path when `MODEL_PROVIDER` says so. Output is coerced
  against the tool's `inputSchema` (`forcedTool.ts:351`), and every call is billed through one
  site (`recordModelUsage`, `:350`).
- `reasoningEffort: 'none'` collapses GLM-5.2's default thinking to ~7 tokens (probed 2026-08-04,
  documented at `forcedTool.ts:42-51`). All four spine model calls currently set it.

## Constraints and Invariants

1. **The only model call today is deliberately trivial.** `compose.ts:18-26` — the model sees
   NOTHING but code-built context (fabrication guard), writes one sentence, and code assembles
   the delivered message around it.
2. **`ask:false` already exists as a model judgment.** `compose.ts:215-234` — the model may
   decline to ask. A decline is treated as a judgment about *asking*, not about the gap: the
   manager still gets it.
3. **`SweepFacts` are pure facts, pre-fetched once per tenant per tick** (`nudgeKinds.ts:24-27`).
   A spec receives facts, never a DB client — deliberately, so a spec cannot turn the batched
   read into N queries.
4. **The ask window gates compose, not detection** (`compose.ts:40-52`). Out-of-window rows stay
   `pending`, untouched.
5. **Rate brakes are per detector and per tenant** — `spec.maxNewPerTenantTick`
   (`nudgeKinds.ts:90`, visit 5 / cost 3) inside `MAX_NEW_ITEMS_PER_TENANT_TICK = 5`
   (`watchers.ts:95`, enforced `:668` and `:767`).
6. **The orphan doctrine** (`compose.ts:68-75`, `watchers.ts:528-570`): any path that kills a
   nudge before the ask lands must hand the gap to the manager FIRST, because once-ever dedup
   blocks a second nudge.
7. **Escalation is per row, from its own `asked_at`** (`watchers.ts:503-507`).
8. **`nudges` has no grouping column** and `completeNudgeDelivery` moves exactly one row per
   delivery report.
9. **Dedup is `(tenant_id, kind, subject_ref)`, forever** (`nudges.sql:56`).

## The per-detector burden, measured

Detector #2 (`job_cost_gap`), landed in PR #155 + #156:

| file | lines | category |
|---|---|---|
| `watchers.ts:738-825` — detection pass | 88 | eye |
| `db/jobs.ts` — `listCostGapCandidates` | ~67 | eye |
| `db/moneyEvents.ts` — `listJobIdsWithCostEvents` | ~60 | eye |
| `nudgeKinds.ts:231-302` — the spec | 72 | mixed: `filled`/`moot` are facts; brake + handoff copy are decisions |
| `composeCopy.ts:148-234` — prompts + assembly | 87 | decision/copy |
| **total production code** | **~370** | |

Plus tests: PR #155 added 397 lines to `watchers.test.ts` alone.

Splitting by the facts/judgment line:

- **~260 lines are the eye** — the detection query, the freshness filters, and the `filled`/`moot`
  predicates. These answer questions with right answers.
- **~110 lines are decision/copy** — the compose system prompt, the forced-tool spec, `prepare`,
  the message assembly, the per-kind brake, and the handoff suggestion wording.

No urgency or batching code exists for either detector, so the future category the user names —
per-detector pacing decisions — currently measures zero and would grow from here.

## Decision Points

1. **Does the planner replace compose, or precede it?**
   - *Precede:* planner decides timing/grouping; each kind keeps its own `ComposeBlock` and writes
     its own sentence. Two model calls per gap-ish. The ~87 lines of per-kind copy stay, and every
     new eye writes a new prompt.
   - *Replace:* the planner also writes the outgoing message, so `ComposeBlock` leaves
     `NudgeKindSpec` entirely and per-kind prompts disappear. One call. The four review rounds of
     copy doctrine currently encoded in `COMPOSE_SYSTEM` / `COST_COMPOSE_SYSTEM` would have to be
     re-expressed once, centrally, and the fabrication guard (`compose.ts:22`) would need to hold
     over a larger, multi-gap context.

2. **What the planner is allowed to decide.** Today's rails are code: ask window, 48h escalation,
   24h delivery deadline, once-ever dedup, per-tenant/per-detector brakes, orphan doctrine.
   Options range from "planner proposes, code vetoes each rail" to "planner sees only gaps the
   rails already cleared."

3. **What the planner's decision is recorded as.** `nudges` has `context jsonb`, `resolution`,
   and timestamps, but no field for "held until X because Y" and no grouping column. Options: a
   new column pair, a key inside `context`, or nothing persisted (decision recomputed per tick).

4. **Per-tenant-per-tick versus per-firm-per-day.** The seam runs every 5 minutes. A planner call
   at that cadence is 288 calls/tenant/day even when nothing changed; the ask window narrows it to
   ~144. Alternatives: call only when the open-gap set changed, or on a coarser cadence with the
   tick handling only rail enforcement.

5. **Whether `maxNewPerTenantTick` survives.** It is a per-detector constant that exists as the
   runaway backstop after the per-person cap was removed. If the planner decides volume, the
   constant becomes either dead or a hard ceiling the planner cannot exceed.

6. **What happens when the planner call fails.** Compose's failure path is per-row with an attempt
   cap and a manager handoff. A planner failure is per-tenant and affects every gap that tick —
   there is no existing precedent in this module for a whole-tenant model failure.

7. **Whether the model can do it.** Unmeasured. The existing call is a one-sentence task at
   `reasoningEffort: 'none'`; reasoning over N gaps and returning a defensible send plan is a
   different class of task. The repo has two eval harnesses (`scripts/date-eval/`,
   `scripts/spine-eval/`) built for exactly this kind of question.

## Open Questions

- **What does the planner see about each gap?** The nudge `context` is written per detector and
  its shape differs by kind (`readComposeContext` vs `readCostComposeContext`). A planner over
  mixed kinds needs either a common projection or tolerance for heterogeneous blobs.
- **Does one delivery carry a grouped message?** The box runner script
  (`/usr/local/sbin/nudge-runner.sh`) was not read here; whether it can render one message per
  several nudge ids is unknown.
- **How does a grouped message's footer work?** `assembleNudgeMessage` (`composeCopy.ts:130-146`)
  names one technician and one job and instructs `record_field_note` **for this job**, singular.
- **Is `reasoningEffort: 'none'` viable for a planner?** Every current spine call sets it; a
  planning task may need more, which changes both latency and cost.
- **What is the cost at fleet scale?** One compose call measured 462 in / 66 out ≈ $0.0014. A
  planner's input grows with the open-gap count; no measurement exists.
