---
date: 2026-08-28
branch: feat/check-the-bill
commit: 8ff12d1
topic: The planner's harness — every constraint code imposes on the planner's decision space, where each came from, and what would have to move to make the harness firm-adaptive
supersedes: nothing
---

**`supersedes:` — nothing.** This document does not overturn a decision. It inventories the
constraints earlier decisions created and makes their combined shape visible for the first time.
It is READ-ONLY research: it proposes nothing.

## Summary

The ladder is a pipeline in which **code decides what a gap is, whether it is worth chasing, and
what order things happen in**, and a language model (the "planner") decides only *how to handle a
gap that code has already committed to*. This document inventories every place that boundary sits.

The finding, in one line: **the harness constrains three very different things at the same level of
confidence** — the model's *output format* (dates, quotes, verbatim sends), the *firm's parameters*
(hours, patience, volume), and the *ontology* (what counts as a gap at all). Only the first of those
is genuinely code's business. The second is data that today is hard-coded, globally, for every firm.
The third is a set of positions that were reasoned about once, for one firm archetype, and are now
structural.

A second finding falls out of the first: **five separate actors can write a nudge's terminal status,
and the planner is only one of them.** The planner is not told the other four exist. Every conflict
this produces so far has been found by accident.

## Entry points

| Where | File:line | What it decides |
|---|---|---|
| Detector, visits | `src/db/assignments.ts:533` `listOverdueConfirmedAssignments` | which visits are candidates |
| Detector, costs | `src/db/jobs.ts:223` `listCostGapCandidates` | which jobs are candidates |
| Kind registry | `src/jobs/nudgeKinds.ts:468` `NUDGE_KIND_SPECS` | **what a gap can be** — exactly 2 |
| Sweep | `src/jobs/watchers.ts:301` `runWatchers` | mints rows; closes/escalates/expires them |
| Planner | `src/teamLead/planner.ts:1544` `runPlanner` | the one model call in the ladder |
| Doctrine | `src/teamLead/plannerPrompt.ts:30` `PLANNER_SYSTEM` | the judgment, as words |
| Rails | `src/teamLead/planner.ts:934` `validateDecisions` | which decisions are even legal |
| Corpus | `src/jobs/summarize.ts:51` `runGapSummaries` | the continual-learning experience unit |
| Distiller | `src/teamLead/reflector.ts:171` `runReflector` | proposes lessons, daily, **dark** |

## 1. The gap ontology is code, and it has exactly two entries

`NUDGE_KIND_SPECS = [OVERDUE_VISIT_GAP_SPEC, JOB_COST_GAP_SPEC]` (`nudgeKinds.ts:468`).

A kind is a TypeScript object implementing five members: `filled`, `moot`, `itemResolved`,
`handoff`, plus `subjectIsVisit` / `maxNewPerTenantTick`. Registration is load-bearing in both
directions — `watchers.ts` refuses to mint an unregistered kind, and `runPlanner` filters open
rows through `specFor` before building views, so an unregistered kind is invisible to the planner
too.

**Consequence.** A firm whose real gaps are "the customer never signed off the quote", "no
before/after photo on a warranty job", or "the permit was never filed" cannot have them. There is
no data path — a gap kind is a code artifact, and its predicates are pure functions over
`SweepFacts`, a struct with five fixed fields.

**What the registry was for.** Its own header says: before it, `'overdue_visit_gap'` was a literal
in four places, and an unregistered kind "is simply never swept, so it can never be answered,
escalated or expired. It sits open forever with nothing logged." The registry makes *"every kind
is swept"* structural. It also — not stated anywhere — makes *"every kind is ours"* structural.

## 2. Worthiness is not in the planner's decision space

The six verbs (`planner.ts:66`) are `send | hold | close | escalate | extend | leave`.

Read as an exit graph, **every terminal state of a gap is either an answer or a human's
attention**:

| Terminal status | Reached by | Manager item? |
|---|---|---|
| `answered` | planner `close` (basis record/evidence) | no |
| `answered` | sweep pre-ask carve-out (`watchers.ts:727`) | **no** |
| `answered` | sweep fail-safe at the deadline (`watchers.ts:800`) | **no** |
| `cancelled` | sweep `moot` — visit/job cancelled (`watchers.ts:740`) | no |
| `escalated` | sweep, at the escalation deadline (`watchers.ts:1043`) | yes |
| `failed` | sweep, 18h delivery deadline (`watchers.ts:922`) | yes |
| `failed` | queue serve cap — `MAX_SERVE_COUNT` 10 (`nudgeQueue.ts:156`) | yes |
| `failed` | queue delivery cap — `MAX_DELIVERY_ATTEMPTS` 3 (`nudgeQueue.ts:290`) | yes |

**"Not worth chasing at this firm" is not in that table.** `leave` is an explicit no-op whose own
doctrine says it "does not buy anyone more time — the automatic clock keeps running either way"
(`plannerPrompt.ts`). A gap the planner judges pointless still escalates to a manager at its
deadline.

(The unmerged `feat/the-decline-verb` branch adds a seventh verb. As built it closes as `cancelled`
*and hands the gap to a manager* — it is a routing decision, not a "drop it" decision. It is not on
`main`: `git merge-base --is-ancestor feat/the-decline-verb origin/main` → not merged.)

**There is also no re-ask.** `uq_nudges_subject_ever` is `unique (tenant_id, kind, subject_ref)`,
non-partial (`20260817090000_nudges.sql:56`) — a closed nudge permanently blocks a second one on
the same subject. Asking the wrong person is unrecoverable: no verb re-routes, and the index
forbids a fresh row.

## 3. Sixteen global constants encode one firm archetype

Every number below is a module-scope `const`. **None is per-tenant.**

| Constant | Value | File | What it asserts about a firm |
|---|---|---|---|
| `OVERDUE_HOURS` | 3 | watchers.ts:94 | a visit is "late to report" after 3h |
| `LOOKBACK_HOURS` | 72 | watchers.ts:95 | nothing older than 3 days is worth noticing |
| `MAX_NEW_ITEMS_PER_TENANT_TICK` | 5 | watchers.ts:96 | a firm can absorb 5 new asks per tick |
| `NUDGE_ESCALATE_HOURS` | 24 | watchers.ts:120 | 24h of silence means give up |
| `NUDGE_ESCALATE_MAX_HOURS` | 48 | watchers.ts:128 | patience may never exceed 48h |
| `NUDGE_DELIVERY_DEADLINE_HOURS` | 18 | watchers.ts:158 | undelivered for 18h = broken pipe |
| `PLANNER_SILENCE_HOURS` | 24 | watchers.ts:174 | a planner silent 24h is dead |
| `ASK_WINDOW_START_HOUR` | 7 | compose.ts:32 | **nobody works before 7am** |
| `ASK_WINDOW_END_HOUR` | 19 | compose.ts:33 | **nobody works after 7pm** |
| `maxNewPerTenantTick` (visit) | 5 | nudgeKinds.ts:213 | per-detector runaway brake |
| `maxNewPerTenantTick` (cost) | 3 | nudgeKinds.ts:391 | per-detector runaway brake |
| `REFLECT_FROM_HOUR` | 2 | reflector.ts:35 | distil after 2am firm-local |
| `MIN_SUMMARIES` | 15 | reflector.ts:33 | no learning below 15 closed gaps |
| `MIN_NEW_SINCE_LAST_RUN` | 5 | reflector.ts:34 | re-distil after 5 new |
| `LESSONS_BLOCK_BUDGET` | 2000 chars | lessons.ts:16 | the firm's whole learned memory |
| `RETIRE_STRIKES` | 2 | lessons.ts:23 | two contradictions kill a lesson |
| `PROPOSAL_STALE_DAYS` | 60 | lessons.ts:20 | proposal shelf life |

**The firm's entire configurable surface**, for contrast, is the `tenants` table
(`database.types.ts:1997`): `timezone`, `default_job_minutes`, `technician_horizon_days`,
`manager_seats`, `technician_seats`, `name`, `created_at`, `id`. There is **no** working-hours
column, no attributes/JSONB column, and no firm-level standing-fact store — `standingFacts.ts` is
customer/job-scoped only.

### 3a. The ask window in particular

`insideAskWindow` (`compose.ts:35`) gates the **entire planner tick**:

```
runPlanner → for each tenant → if (!insideAskWindow(now, tz)) { skippedWindow++; continue }
```

Outside 07:00–19:00 firm-local **the model is never called at all** — the comment calls it "the
single largest lever on what the planner costs." A firm whose crews start at 04:00 is not merely
asked at an awkward hour; its planner does not run during the hours its work actually happens.

The window is also structurally coupled to the delivery deadline. `NUDGE_DELIVERY_DEADLINE_HOURS`'s
own header: *"A window that ever excludes whole DAYS (a weekend rule, say) must lengthen this
deadline with it, or weekend-held rows expire to the manager without the technician ever being
asked."* So the window is not a free parameter — widening or narrowing it moves an invariant in
another file.

## 4. Eight terminal paths; the planner owns one

```
                      ┌──────────────────────────────────────────┐
   detectors ────────▶│              nudges row                  │
   (mint)             │  pending → queued → asked → terminal      │
                      └──────────────────────────────────────────┘
                            ▲        ▲        ▲        ▲       ▲
        planner `close` ────┘        │        │        │       │
        sweep: pre-ask carve-out ────┘        │        │       │
        sweep: moot ──────────────────────────┘        │       │
        sweep: escalation deadline ────────────────────┘       │
        sweep 18h + queue serve-cap + queue delivery-cap ──────┘
```

The sweep runs **every 5 minutes**; the planner **every 30, and only inside the ask window**. So
the deterministic writers win every race by construction.

**What the planner is told.** `PLANNER_SYSTEM` tells it: the automatic escalation instant, that the
clock runs whether or not it looks, that it is awake twice an hour, and that closing is its own
("nothing else closes it — not activity on the job, not a note landing, not time passing").

**What the planner is not told, and which is false in each case:**

1. *"nothing else closes it"* is **not true of a pending gap.** `watchers.ts:727` — if
   `!n.asked_at` and `spec.filled` is true, the sweep closes it `answered`. The predicate is
   `hasActivitySince(jobId, startsAtLocal)`, built from capture timestamps and `visits.created_at`
   only — **it never reads text.** Any capture touching the job satisfies it.
2. A `moot` close (`watchers.ts:740`) fires on visit status `cancelled` **or `completed`**, and on
   job status `cancelled`. A gap the planner decided about an hour ago can vanish because someone
   marked the visit complete.
3. The fail-safe (`watchers.ts:800`) closes an *asked* gap as `answered` when
   `filled && soleGapOnJob && !plannerAlive`. Liveness is `PLANNER_JUDGMENT_ACTIONS` — a set that
   must be kept in sync with `PLANNER_ACTIONS` by hand (`planner.ts:63` says so explicitly).
4. The 18h delivery deadline (`watchers.ts:922`) hands the gap to a manager as `failed`.

Each close is **permanent**: `uq_nudges_subject_ever` blocks a replacement, and the detectors'
fresh pre-filter (`listEverFlaggedSubjectRefs` / `listNudgedSubjectRefs`) excludes ever-nudged
subjects. Paths 1 and 3 write **no review item**, so the gap leaves both surfaces forever.

This is documented in more depth in `2026-08-27-the-sweep-auto-close.md`.

## 5. The order of operations is doctrine enforced as a state machine

`validateDecisions` (`planner.ts:934`) refuses, by status:

| Refusal | Line | Rule |
|---|---|---|
| `escalate` when `!sweepLive` | ~1024 | the deployment cannot perform it |
| `escalate` on a non-`asked` row | ~1032 | "escalation is for silence after a question went out" |
| `send`/`hold` on a non-`pending` row | ~1041 | "the question is with the person now" |
| a group spanning two jobs or two people | ~1080 | the anchor names one record |
| a second decision for the same gap | ~983 | one entry decides |

The comments are explicit that these encode *judgment about the lifecycle*, not just safety:
*"Inventing a mapping from `hold` to `escalate_after` would be code doing the model's judgment for
it, which is the one thing this design does not do."* — which is right in intent, and yet the rail
above it does decide, on the model's behalf, that patience before an ask and patience after an ask
are different verbs.

**Two classes are fused here.** Some rails protect the world from a wrong output (a group spanning
two people would mark somebody's gap asked on a message they never saw). Others protect a lifecycle
model (`hold` vs `extend`). Only the first class stays valuable as models improve.

## 6. There is no inference fallback, and the planner-absence fallbacks are load-bearing

`src/model/forcedTool.ts` resolves **one** endpoint:

- `resolveOpenAiEndpoint` (`:63`) — `INFERENCE_API_KEY`, `INFERENCE_BASE_URL`, `INFERENCE_MODEL`
  (default `accounts/fireworks/routers/glm-5p2-fast`)
- `resolveAnthropicEndpoint` (`:73`) — `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
- `activeProvider()` (`:92`) — `MODEL_PROVIDER === 'anthropic' ? 'anthropic' : 'openai'`

There is **no second endpoint, no retry to another provider, no model failover.** `src/model/`
contains exactly `forcedTool.ts` and `toolLoop.ts` — no router.

On failure, `runPlanner`'s catch (`planner.ts:2020`) increments `tenantErrors`, writes one
`unmentioned`/`refused` row per gap, and moves on. Its own comment states the design:

> *"a whole-call failure leaves every row untouched: the sweep's constants still apply, so a dead
> planner degrades to exactly the behaviour that shipped before it existed."*

**The machinery that exists solely to hedge planner absence:** `PLANNER_SILENCE_HOURS`,
`PLANNER_JUDGMENT_ACTIONS`, the `decisions`/`decisionsReadable`/`plannerAlive` read and its
fail-open direction, and the auto-close branch — roughly 120 lines of `watchers.ts`, plus the
`nudgesAutoClosed` counter, described in its own doc comment as *"not throughput, it is an ALARM."*

**Not every deterministic path is a planner-absence hedge**, and the distinction matters for any
strip:

- `moot` — a fact (visit cancelled). Nothing to do with the planner being up.
- 18h delivery deadline — fires when the *delivery pipe* is broken (offboarded technician, recycled
  sandbox clearing `host_id`, a rollback freezing pending rows). The planner is healthy and has
  already decided.
- pre-ask carve-out — a **race patch**: it exists because the sweep is 6× faster than the planner
  and the ask window holds evening gaps until 7am.
- `PLANNER_SILENCE_HOURS` + auto-close — pure planner-absence hedge.
- `NUDGE_ESCALATE_HOURS` — mixed: a fallback *and* the firm's default patience.

## 7. Continual learning can only learn about the structure it was born in

### The corpus

`runGapSummaries` (`summarize.ts:51`) writes one row per **closed** nudge
(`listUnsummarizedClosedNudges`, filtered to `CLOSED_NUDGE_STATUSES`). Fields:
`kind, subject, asked_at, closed_at, status, resolution, working_hours_open, arc, considered,
extended_to, escalated, manager_fate, manager_resolution, manager_latency_wh,
answered_by_capture_id`.

### What the Reflector actually sees

`renderSummary` (`reflector.ts:88`) renders each row as:

```
- {id} · {kind} · {subject} · {status} ("{resolution}") · open {N}wh · considered {N} ({arc}) manager:{fate} "{res}"
```

Decompose that: **one of 2 kinds**, one of **4 terminal statuses**, a **code-written** resolution
string from a fixed set, hours-open measured against **the 7am–7pm window**
(`workingHoursBetween`), a count, a histogram over **the 6 verbs**, and the manager's disposition.

**Every single field is a coordinate inside the structure code imposed.** A rule distilled from
this corpus can only be a rule about pacing within our lifecycle. There is no field in which "this
firm does not care about cost gaps", "these crews work 04:00–12:00", or "the thing we should have
noticed was the unsigned quote" could be represented — so no lesson can say it.

### Three further limits, each checkable in the code

1. **The loop is open.** `runReflector`'s header: *"NOTHING reaches any prompt in this phase:
   shadow is the only real mode, and `live` is deliberately shadow-equivalent here — activation
   stays a human act."* Proposals sit at `status: 'proposed'`; only `activateLesson` — called by a
   human — puts one in front of the planner.
2. **A lesson can be unactionable and nothing detects it.** Lesson text is free-form prose bounded
   only by `LESSON_TEXT_MAX` (300) and a date rail (`cleanLessonText`, `lessons.ts:38`). Nothing
   checks a lesson against the verbs or the constants. A lesson reading *"this firm's crews answer
   early — ask before 7am"* would pass the Curator, could be activated, would be rendered into
   every prompt, and **could never be complied with**: `insideAskWindow` skips the tenant before
   the model is called. There is no test for this class and no counter that would show it.
3. **No negative channel.** The corpus is closed nudges only. A gap that *should have been detected
   and was not* is invisible by construction. And the single strongest signal we do collect —
   a manager **dismissing** a review item, which is a human saying "this was not worth chasing" —
   lands in `manager_fate: 'dismissed'` and travels no further than a prompt line.


## 8. Escalation is not a rung — it is the exit from software

`grep review_items src/teamLead/planner.ts` returns nothing. **The planner reads only the `nudges`
table.** It can query `v_review_items` through `spine_read` once it is already running on some other
gap, but a review item can never bring it to a firm.

So the moment a gap becomes a manager item it leaves the planner's world permanently — the nudge
row is terminal, `uq_nudges_subject_ever` blocks a replacement, and nothing in software follows up.
The manager surface itself has no ladder: `notifyManagers` fires only `if (opened > 0)`
(`watchers.ts:1274`), described in its own comment as "a quiet queue never re-pings on any cadence."

The lifecycle is therefore not a loop with an escalation branch. It is a **funnel with one drain**,
and the drain is a human queue with no follow-up mechanism.

## 9. The lessons loop is open at BOTH ends

Already noted (§7) that activation is a human act. The same is true of retirement:

```
$ grep -rn "strikeLesson" src --include="*.ts" | grep -v "lessons.ts\|test"
(no output)
```

`strikeLesson` — the function that records a lesson being contradicted, and retires it at
`RETIRE_STRIKES = 2` — **has no caller anywhere in the system.** Nothing observes a lesson failing.
So a lesson, once activated by hand, stays in every prompt until a human removes it by hand.

The full loop as built: propose (automatic, dark) → activate (manual) → influence prompts →
**nothing measures the effect** → retire (manual). Two of the five stages are automatic.

## Constraints and invariants (what any change must not break)

- **L1 is append-only.** Any classification must gate the insert (CLAUDE.md).
- **`uq_nudges_subject_ever` is non-partial by design** — "a resolved nudge must keep blocking".
  Any re-ask verb requires changing this index, and with it the volume brake it doubles as.
- **The detector fresh pre-filter** (`listEverFlaggedSubjectRefs`, `listNudgedSubjectRefs`) is the
  other half of that brake.
- **Registry-gating is bidirectional** — an unregistered kind is neither minted, swept, nor planned
  for. Stranding is possible from both ends.
- **`PLANNER_ACTIONS` ↔ `PLANNER_JUDGMENT_ACTIONS`** must be edited together, by hand
  (`planner.ts:63`). A verb added to one and not the other silently changes when the fail-safe fires.
- **The ask window ↔ the delivery deadline** are coupled (see §3a).
- **The import cycle** `watchers.ts ↔ nudgeKinds.ts` is safe only because `wallClockLabel` is a
  hoisted `function` and nothing calls it at module-evaluation time.
- **Dates are code-owned end to end**: `dateLabels` are pre-rendered from the row, and
  `cleanHandoffNote`/`cleanPlannerText` admit only those literal strings. This makes "did it invent
  a date" a string check rather than a judgment.

## Decision points

Stated factually. No recommendation.

1. **Who mints a gap.** Today a detector's SQL match *is* a commitment to chase. The alternative is
   a detector that reports an observation and a planner that decides whether it becomes a gap —
   which requires moving the volume brake, since `uq_nudges_subject_ever` plus the fresh pre-filter
   currently serve as both dedup and cap.

2. **Where the firm's parameters live.** All sixteen constants are module-scope. Making any of them
   per-firm requires a firm-config surface, which does not exist: `tenants` has no attributes
   column and `standingFacts` is customer/job-scoped.

3. **Whether the sweep may write terminal statuses at all.** Each of its four closing paths could
   instead render a *fact* into the gap view and leave the write to the planner. That trade is: one
   writer and no races, against a gap that stays open when the planner is down.

4. **Whether the planner-absence fallbacks survive.** They are ~120 lines of `watchers.ts` and one
   set-sync invariant. Removing them presupposes inference availability that does not exist today —
   `src/model/` has one endpoint and no failover.

5. **Whether the planner may write structure.** Today it consumes structure (kinds, constants,
   lessons) and can write only nudge state. Verbs that write a firm profile, open a gap, or retire a
   gap kind would change what the planner *is* from a dispatcher to an operator.

6. **What the CL corpus is made of.** Closed nudges only, rendered in eight fixed fields. Widening
   it (observations, declined gaps, manager dismissals as labelled negatives) is what would let a
   lesson be about the firm rather than about our lifecycle.

## Open questions

- Does any live firm actually want a different ask window? Unknown from code; the pilot is a test
  surface and its data cannot answer this (standing user rule).
- What fraction of manager dismissals mean "not worth chasing" versus "already handled"? The
  `resolution` text is free-form and nothing classifies it.
- Would a planner given the observation list rather than the gap list produce a *smaller* ask
  volume or a larger one? Untested — there is no shadow mode for that shape.
- `nudges.resolution` has no reader outside `watchers.ts` today (the fail-safe's own comment checks
  this). If gap outcomes become the CL corpus's substance, that string becomes load-bearing.
