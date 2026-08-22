---
date: 2026-08-22
branch: research/the-brain-memory
commit: 590998c
topic: The brain's memory foundations — attribution, closure semantics, and continuity in the nudge ladder
---

## Summary

The nudge ladder notices holes in a firm's record, asks the technician who would know, and
hands the gap to a manager if nobody answers. This document maps three things it does **not**
currently do, all of which the planner's memory would need. **Attribution:** when an answer
comes back, nothing records which question it answered — the link is inferred from "some
activity landed on the job", and two gaps on one job are indistinguishable. **Closure
semantics:** the words `answered` and `filled` are the same word in this code, so a gap can be
recorded as answered while the hole it names is still open — this is observable on the pilot
today. **Continuity:** the planner writes a row only for gaps it *acts on*, so a tick that
looks at fifteen gaps and decides all fifteen can wait leaves no trace at all.

Plain-language terms: **L1** is `raw_captures`, the append-only verbatim record of what people
said. **L2** is the structured record — `customers → jobs → visits`. **L3** is the `attributes`
JSONB column on L2 rows. **A gap** is a hole in the record the ladder is chasing; its row lives
in `nudges`. **A seat agent** is the technician's own assistant, running in a sandbox on
trades-box-1. **The sweep** is `runWatchers`, a model-free SQL pass every 5 minutes. **The
planner** is `runPlanner`, one model call per firm per 30 minutes.

## Entry Points

| Where it begins | File:line |
|---|---|
| The sweep — detection, resolution, escalation | [watchers.ts:274](src/jobs/watchers.ts#L274) |
| `hasActivitySince` — the one predicate all closure rests on | [watchers.ts:455](src/jobs/watchers.ts#L455) |
| The nudge auto-resolve loop | [watchers.ts:565](src/jobs/watchers.ts#L565) |
| Rung 2 — escalation to the manager | [watchers.ts:669](src/jobs/watchers.ts#L669) |
| The question's final assembly (visit) | [composeCopy.ts:130](src/teamLead/composeCopy.ts#L130) |
| The question's final assembly (cost) | [composeCopy.ts:219](src/teamLead/composeCopy.ts#L219) |
| The deliverable handed to the box | [nudgeQueue.ts:99](src/control/nudgeQueue.ts#L99) |
| `record_field_note`'s tool schema | [server.ts:256](src/mcp/server.ts#L256) |
| Evidence attribution, capture → job | [rawCaptures.ts:259](src/db/rawCaptures.ts#L259) |
| What the planner is shown about one gap | [planner.ts:352](src/teamLead/planner.ts#L352) |
| The pushed history line | [planner.ts:331](src/teamLead/planner.ts#L331) |
| Which decisions become rows | [planner.ts:1227](src/teamLead/planner.ts#L1227) |

## Key Files

**`src/jobs/nudgeKinds.ts`** (471 lines) — the kind registry. Two specs
(`OVERDUE_VISIT_GAP_SPEC`, `JOB_COST_GAP_SPEC`), each supplying five pure predicates over
`SweepFacts`: `filled`, `moot`, `itemResolved`, `handoff`, `compose`. The predicates take
pre-fetched facts, never a DB client — a deliberate structural guard against turning one
batched read into N per-row reads.

**`src/jobs/watchers.ts`** (1021 lines) — the sweep. Builds `SweepFacts` once per tenant per
tick, runs every open item and nudge through its spec, escalates the silent ones, then routes
fresh gaps. `WatcherMode` and `NudgeMode` gate it independently.

**`src/teamLead/composeCopy.ts`** (234 lines) — every string a technician sees, plus the two
compose prompts. Exports `assembleNudgeMessage` / `assembleCostNudgeMessage`, which produce the
whole deliverable stored in `nudges.question`.

**`src/control/nudgeQueue.ts`** (160 lines) — the transport. `buildNudgeDelivery` serves queued
nudges on a host-token pull; `completeNudgeDelivery` takes the box's ack. Carries the
serve-cap and delivery-attempt ceilings.

**`src/db/rawCaptures.ts`** (362 lines) — L1's typed layer. `listJobEvidenceSince` is the
planner's evidence read and the only place a capture is attributed to a job.

**`src/db/nudgeDecisions.ts`** (175 lines) — the decision log. `recordNudgeDecisions`
(insert-only, chunked at 500), `listDecisionsForNudges` (the batched per-tick read),
`listDecisionsForNudge` / `listDecisionsForJob` (the two `recall_decisions` lookups).

**`src/teamLead/planner.ts`** (1354 lines) — the planner. `buildGapView` renders one gap;
`validateDecisions` runs the rails; `applyDecision` performs one decision; the block at
[:1227](src/teamLead/planner.ts#L1227) builds the rows to record.

**`supabase/migrations/20260820120000_nudge_decisions.sql`** plus three amendments
(`_extend`, `_handoff_note`, `_question_draft`) — 17 columns now.

---

## Data Flows

### 1. Attribution — the question goes out, the answer comes back

```
nudges row                     compose                    nudgeQueue
  id: cf90711d…      ──▶  assembleNudgeMessage   ──▶   NudgeDeliveryItem
  kind, context                   │                       id: cf90711d…
  jobId: 855f88ca…                │                       sessionId: "nudge-cf90711d…"   ◀── the id
                                  ▼                       messageB64: <the question>          survives
                        stored in nudges.question                                              HERE
                                  │                              │
                                  │                              ▼
                                  │                        box runner → seat agent
                                  │                              │
                                  ▼                              ▼
       "(re: Linda Tran — Smoke/CO swap, visit on 2026-08-21)    technician answers
        …save it with record_field_note for this job"            │
                                                                 ▼
                                                    record_field_note({ text })
                                                                 │
                                                                 ▼
                                                    recordFieldNote → L1 + L2
```

**The gap id is not in the message.** `assembleNudgeMessage`
([composeCopy.ts:130](src/teamLead/composeCopy.ts#L130)) renders the question, a `(re: …)` line
naming the customer and job by *name*, and a footer for the receiving agent. `assembleCostNudgeMessage`
([:219](src/teamLead/composeCopy.ts#L219)) is the same shape without the date. Neither carries
the nudge id, and neither carries the **job id** — the footer says "for this job" while the only
identifying data is a customer name and a job title.

**The nudge id does cross the boundary, in exactly one place.**
[nudgeQueue.ts:105](src/control/nudgeQueue.ts#L105) sets `sessionId: \`nudge-${row.id}\`` — a
fresh session per nudge, named for it. That id reaches the box, is used to pin the session, and
is not read back by anything on the spine side.

**`record_field_note` cannot accept it.** Its schema
([server.ts:256](src/mcp/server.ts#L256)) is `text`, `blobPath`, `channel`, `confirmId`,
`confirmed` — with `required: []`. There is no `jobId`, no `nudgeId`, no `answersGap`.

**So the answer's only link to the job is derived, twice over**, by
`listJobEvidenceSince` ([rawCaptures.ts:259](src/db/rawCaptures.ts#L259)):

1. **`via: 'job_stamp'`** — captures whose own `job_id` matches. This is populated only when
   `input.resolved.jobId` was known *at the moment of the L1 append*
   ([recordFieldNote.ts:157](src/writePath/recordFieldNote.ts#L157)).
2. **`via: 'visit'`** — visits minted since the floor, reached through their
   `source_capture_id`. This recovers the case where the job was resolved *after* L1 was
   written.

Path 2 matters because L1 is append-only: [recordFieldNote.ts:251-267](src/writePath/recordFieldNote.ts#L251-L267)
resolves the job *after* the capture is already durable (matcher job → most recent non-terminal
job → create a new one), so a capture that resolved only to a customer can never gain its
`job_id`. Path 2 is what keeps such a capture visible to the planner.

**What `buildGapView` can and cannot say when two gaps share a job**
([planner.ts:352](src/teamLead/planner.ts#L352)): `sharesJob` is computed from a
`gapsPerJob` count ([planner.ts:1131](src/teamLead/planner.ts#L1131)) and, when true, renders a
warning into the prompt. Its own comment states the limit:

> `NOTE: this job has more than one open gap, so everything below is SHARED between them`
> — *"Two gaps on one job see the same notes, and nothing below can tell which question a given
> sentence answers."*

Evidence is bounded by `e.jobId === jobId && Date.parse(e.capture.captured_at) > askedAtMs`,
capped at `EVIDENCE_PER_GAP`. There is no per-gap filter finer than the job.

### 2. Closure — every path that closes a nudge or an item

All closure rests on one function, [watchers.ts:455](src/jobs/watchers.ts#L455):

```ts
const hasActivitySince = (jobId: string, startsAtIso: string): boolean =>
  (latestByJob.get(jobId) ?? -Infinity) >= minuteFloor(startsAtIso);
```

`latestByJob` is fed by exactly two sources ([watchers.ts:448-449](src/jobs/watchers.ts#L448-L449)):

```ts
for (const c of captures) note(c.job_id, c.captured_at);   // raw_captures, job-stamped only
for (const v of visits)   note(v.job_id, v.created_at);    // visits.created_at
```

`note()` begins `if (!jobId) return;` — a capture with a null `job_id` contributes nothing.
`money_events` is not read here at all.

**Every closure path, and what its string asserts:**

| path | file:line | resolution written | what actually established it |
|---|---|---|---|
| visit nudge `filled` | [nudgeKinds.ts:246](src/jobs/nudgeKinds.ts#L246) | `a field report arrived — the gap filled itself` | any activity on the job since the **visit start** |
| visit nudge `moot` | [nudgeKinds.ts:256](src/jobs/nudgeKinds.ts#L256) | `the visit was {cancelled\|completed} — nothing left to ask` | assignment status |
| cost nudge `filled` | [nudgeKinds.ts:376](src/jobs/nudgeKinds.ts#L376) | `the technician answered — a note landed on the job` | any activity on the job since the **ask** |
| cost nudge `moot` | [nudgeKinds.ts:389](src/jobs/nudgeKinds.ts#L389) | `the job was cancelled — nothing left to ask` | job status |
| escalation | [watchers.ts:757](src/jobs/watchers.ts#L757) | `no reply — handed to the manager` | deadline passed, nothing filled it |
| expiry | [watchers.ts:653](src/jobs/watchers.ts#L653) | `never delivered — handed to the manager` | 18h with no ask |
| serve cap | [nudgeQueue.ts:82](src/control/nudgeQueue.ts#L82) | `undeliverable: served Nx with no delivery ack` | serve count ≥ 10 |
| delivery cap | [nudgeQueue.ts:157](src/control/nudgeQueue.ts#L157) | `delivery failed Nx: …` | 3 failed attempts |
| planner `close` | [planner.ts:1018](src/teamLead/planner.ts#L1018) | `answered — "<citation>"` or `closed on the record — <citation>` | the model's judgment, rail-checked |

**The item half diverges from the nudge half, deliberately.**
`JOB_COST_GAP_SPEC.itemResolved` ([nudgeKinds.ts:398](src/jobs/nudgeKinds.ts#L398)) reads
`f.jobsWithCostEvents` — the ledger. `JOB_COST_GAP_SPEC.filled`
([:376](src/jobs/nudgeKinds.ts#L376)) does not. `SweepFacts.jobsWithCostEvents`
([nudgeKinds.ts:53-58](src/jobs/nudgeKinds.ts#L53-L58)) documents this as intentional:

> *"Deliberately NOT consumed by any `filled` predicate. A cost recorded by the manager still
> does not close an open cost NUDGE — that is one of three 'the ladder cannot see the money
> ledger' defects the user ruled should be designed once, together, in a later plan."*

So for the same gap, the manager's copy closes on the ledger and the technician's copy closes on
activity. Only one of the two is measuring the hole.

**The declared consequence**, at [nudgeKinds.ts:363-366](src/jobs/nudgeKinds.ts#L363-L366):

> *"The answer closes the nudge but does NOT become a countable number: the technician's agent
> cannot write money (`record_money_event` is manager-only), so the amount lands as PROSE on
> the job and a manager must record it. Nothing chases the manager yet."*

**Live instance on the pilot (2026-08-19, job `855f88ca`, "Water heater replacement"):**
two gaps — `1bd36166` (visit) and `1e1c0a27` (cost) — both closed at `18:05:42`, 137 ms apart,
in one sweep tick. The technician's answer was capture `e338c387`: *"Picked up a 50-gallon tank
and a couple of fittings for the water heater replacement. Materials cost about $780."* That row
carries `customer_id` and **`job_id = NULL`**. It minted visit `b672132a` with
`attributes.materialsCost: "$780"`. `money_events` for that job: **0 rows**. So
`hasActivitySince` was satisfied by `visits.created_at`, not by the note's own stamp; the cost
gap's resolution reads *"the technician answered — a note landed on the job"*; and the figure
the ask existed to obtain is a string in an L3 attribute.

### 3. Continuity — exactly when a decision row is written

```
runPlanner(nowIso, mode)
   │
   ├─ open = listNudges(OPEN_NUDGE_STATUSES) ∩ registered kinds
   │     └─ empty?  → skippedNoGaps++, CONTINUE          ← no rows
   │
   ├─ insideAskWindow(now, tz)?  7am–7pm firm-local
   │     └─ no      → skippedWindow++, CONTINUE          ← no rows, no model call
   │
   ├─ 4 batched reads → buildGapView per gap → ONE model call
   │
   ├─ submit_plan → validateDecisions → { decisions, dropped, noteDrops }
   │
   └─ records = [ ...decisions, ...dropped ]              ← THE WHOLE SOURCE
         │
         └─ recordNudgeDecisions(records)
```

`records` is built at [planner.ts:1227](src/teamLead/planner.ts#L1227) from **two arrays only**:
`decisions` (what the model named and the rails accepted) and `dropped` (what the model named
and the rails refused). **A gap the model did not name in `submit_plan` appears in neither.**

The executor treats this as legitimate ([planner.ts:1194](src/teamLead/planner.ts#L1194)):

> *"A submission where EVERY decision was refused is a correctable mistake, not an answer. An
> EMPTY plan is a legitimate choice ('leave them all alone') and is accepted as it is."*

`recordNudgeDecisions` returns `0` immediately on an empty array
([nudgeDecisions.ts:67](src/db/nudgeDecisions.ts#L67)).

**Measured on the pilot:** `nudge_decisions` holds **2 rows, ever** — `2026-08-21 01:31:29Z`
(escalate) and `2026-08-22 14:01:45Z` (extend, the first ever). Nudge `cf90711d` was asked
`2026-08-21 19:07:28Z` = Friday 12:07 firm-local. Between that ask and the Saturday 07:01
decision, the ask window covered roughly fourteen 30-minute ticks on Friday afternoon. All
fourteen produced zero rows.

**What reaches the model about its own past** — two channels of deliberately different size:

| channel | content | cost |
|---|---|---|
| **pushed**, always present | `prior decisions: N (last: <action><marker>, Xh ago). Use recall_decisions for the detail.` | ~15 tokens/gap |
| **pulled**, `recall_decisions` | full rows: action, reason, confidence, basis, citation, outcome, outcomeDetail | one loop turn |

`historyLine` ([planner.ts:331](src/teamLead/planner.ts#L331)) returns `null` when
`history.length === 0`, and marks the last row's outcome: `''` for applied, `' — REFUSED'`,
`' — shadow, not applied'`. It reports **count and last action only** — never elapsed time
since first sighting, never how many times the gap was considered without action.

## External Dependencies

- **Supabase / PostgREST** — every store. The 1000-row default cap is silent; each batched
  read pages explicitly.
- **The inference provider** — GLM-5.2 via `deepinfra-prod` (parked state), one planner call per
  firm per in-window tick.
- **Render cron** (`*/5`) — invokes both the sweep and, on a `% 30 < 5` gate, the planner.
- **trades-box-1** — hosts the seat agents; pulls nudges on a host token.

## Constraints and Invariants

1. **L1 is append-only, so a late-resolved job id can never be back-stamped.** The capture is
   written at [recordFieldNote.ts:141](src/writePath/recordFieldNote.ts#L141); the job is
   resolved at [:251](src/writePath/recordFieldNote.ts#L251). Anything the append did not know
   is permanently absent from that row. The `via: 'visit'` path exists to compensate.

2. **`uq_nudges_subject_ever` — a subject is asked about once, EVER.** For `job_cost_gap` the
   subject is the **job id**, so only the first cost gap on a job is ever asked
   ([nudgeKinds.ts:359-361](src/jobs/nudgeKinds.ts#L359-L361)).

3. **Gap lifetime is bounded by code, not judgment.** `NUDGE_DELIVERY_DEADLINE_HOURS = 18`
   ([watchers.ts:158](src/jobs/watchers.ts#L158)) for a never-asked row;
   `NUDGE_ESCALATE_HOURS = 24` default ([:120](src/jobs/watchers.ts#L120)); and
   `NUDGE_ESCALATE_MAX_HOURS = 48` ([:128](src/jobs/watchers.ts#L128)) as an absolute ceiling
   anchored to `asked_at`, not to the current deadline
   ([planner.ts:891](src/teamLead/planner.ts#L891)) — so repeated `extend`s cannot ratchet.

4. **That bound is the SWEEP's, not the table's.** With `NUDGES_MODE` at `off`/`shadow` while
   `PLANNER_MODE` stays `live`, the sweep returns at
   [watchers.ts:477](src/jobs/watchers.ts#L477) before any resolve/escalate path, so no deadline
   fires and gaps stay open indefinitely. This combination is deliberate.

5. **`nudge_decisions` is append-only by convention only.** No `updated_at`, no trigger. The
   migration header states the rule binds the code, and that the model has no write tool
   reaching the table.

6. **A refused close stores no citation** ([planner.ts:1270-1285](src/teamLead/planner.ts#L1270-L1285)),
   so a quote the rails rejected as unfindable is never preserved in a column read as evidence.

7. **Only the last submission is recorded** — `outcome = checked` overwrites
   ([planner.ts:1185](src/teamLead/planner.ts#L1185)), so a wholly-refused first attempt
   followed by a corrected one leaves the first attempt's refusals unwritten.

8. **Nudges are never deleted.** `markNudgeOutcome` ([nudges.ts:217](src/db/nudges.ts#L217)) is
   an `UPDATE`; there is no `.delete()` on `nudges` in `src/`. The `on delete cascade` on
   `nudge_decisions.nudge_id` therefore never fires in normal operation — only
   [seed.mjs:164](scripts/seed.mjs#L164) truncates.

9. **`review_items` has a manager-facing close path that is never exercised.**
   `resolve_review` ([server.ts:1091](src/mcp/server.ts#L1091)) accepts
   `resolved | dismissed`. The pilot holds **90 open items and zero ever resolved or
   dismissed** (up from 80 on 2026-08-21). `job_cost_gap` has produced zero review items ever.

10. **`sensitivity: 'manager_only'` captures and retracted captures are dropped from evidence**
    ([rawCaptures.ts:331-338](src/db/rawCaptures.ts#L331-L338)) — so a technician's answer marked
    manager-only is invisible to the planner while still satisfying `hasActivitySince`.

## Decision Points

1. **Where the gap id would be carried to the seat agent.** Three places already cross the
   boundary: `nudges.question` (the assembled message text), the `NudgeDeliveryItem` envelope,
   and `sessionId`, which already *is* `nudge-<uuid>`. Putting it in the message text means the
   model must copy it back; putting it in the envelope means the box runner must forward it;
   using the session id means deriving it from a name the runner already holds. Each implies a
   different change surface — compose copy, `nudge-runner.sh`, or neither.

2. **What `record_field_note` would accept.** Its schema is `required: []` today, and the tool
   description is the discovery surface for a seat agent. An added argument is optional by
   construction, so every existing caller keeps working; what changes is whether an agent that
   omits it is treated as having failed to attribute, or as normal.

3. **Whether `filled` and `itemResolved` converge.** They diverge today by an explicit
   decision recorded in `SweepFacts.jobsWithCostEvents`. Converging them means a cost nudge
   stops closing on notes and escalates instead, adding volume to a queue with no observed drain
   rate. Leaving them means `nudges.status = 'answered'` continues to describe reply behaviour
   rather than record state.

4. **Whether a gap the planner did not name gets a row.** The two arrays feeding `records` are
   both "gaps the model named". A third source would be `views` minus those two — every gap
   seen and not mentioned. That set does not distinguish a deliberate omission from an
   oversight, because `submit_plan` has no vocabulary for "considered, leaving alone" separate
   from silence.

5. **What the pushed line would say.** `historyLine` returns null on empty history and is the
   only always-present channel. Widening it to carry elapsed-since-first-seen and a
   consideration count changes a string every gap block renders, and the planner-copy eval
   (`scripts/planner-eval/`) renders the real block rather than a copy.

## Open Questions

- **Does the seat agent reliably supply an optional argument it is told about only in a tool
  description?** The repo's own record says a tool description is the discovery surface and that
  discovery failure must be ruled out before blaming the model, but no measurement exists for an
  optional argument specifically.
- **Why did capture `e338c387` resolve to a customer but not a job?** The path is visible
  (`resolved.customerId` set, `resolved.jobId` absent) but which branch of `matchIdentity`
  produced it, and whether that is the common case for a nudge reply, cannot be determined by
  reading alone.
- **Does the box runner have the nudge id available at the moment it invokes the agent?**
  `sessionId` is `nudge-<uuid>` in the delivery item, but whether `nudge-runner.sh` retains it
  in a form the agent could be told is not established from the spine side.
- **Has any `review_item` ever been resolved on any tenant?** The pilot shows zero; whether the
  path works at all is untested by these reads.
- **What happens to `nudge_decisions` growth under constraint 4 in practice?** The combination
  has not been observed persisting; today's ~2 rows / 3 days makes it invisible either way.
