---
date: 2026-08-27
branch: feat/the-decline-verb
commit: 3e2d30a
topic: Every path by which a nudge reaches a terminal status without the planner deciding it, and whether each survives the 2026-08-22 closing ruling
supersedes: nothing
---

**`supersedes:` note.** Overturns nothing. It documents behaviour that the 2026-08-22 ruling
(commit `5a3c8ed`) deliberately preserved, and records a consequence of one carve-out that the
commit's own reasoning does not appear to have considered. It also corrects a stale inline comment
in `watchers.ts` (see Invariant 6) and supplies the reason
`thoughts/shared/plans/2026-08-26-the-decline-verb.md` withdrew its PJ-09 scenario.

## Summary

A **gap** is a hole in the record the system found on its own — most often a visit that has ended
with nothing written about it. Each becomes a row in `nudges`. The **sweep** runs every 5 minutes;
the **planner** (the pipeline's one model call) runs every 30.

On 2026-08-22 the user ruled that **closing a gap is the planner's judgment**, because the fast
deterministic sweep always won the race and the planner never saw an answer at all. That ruling
holds — for a gap that has been **asked**. Seven paths still write a terminal status with no
planner decision, and they are not equivalent: four hand the gap to a manager first, and three
close it with no manager surface at all.

The most consequential of the three is the **pre-ask carve-out**: a gap nobody has been asked
about is closed as `answered` the moment *anything* touches its job. The predicate reads
timestamps and never text, so a technician's note saying *"I was never on site"* closes the gap and
stamps it *"a field report arrived — the gap filled itself"*. Because the once-ever index is
deliberately non-partial and no manager item is written, that visit leaves **both** surfaces
permanently.

## Entry Points

- **`src/jobs/watchers.ts:731`** — the pre-ask carve-out, `if (!x.n.asked_at)`.
- **`src/jobs/watchers.ts:743`** — the moot close.
- **`src/jobs/watchers.ts:803`** — the escalation-deadline fail-safe.
- **`src/jobs/watchers.ts:926`** — the 18-hour delivery expiry.
- **`src/jobs/watchers.ts:1047`** — the escalation (rung 2).
- **`src/control/nudgeQueue.ts:157`** — the serve-cap failure.
- **`src/control/nudgeQueue.ts:291`** — the delivery-report failure.
- **`src/jobs/watchers.ts:499-512`** — `latestByJob` / `hasActivitySince`, the predicate under
  the carve-out and the fail-safe.

## Key Files

| Path | Role |
|---|---|
| `src/jobs/watchers.ts` | The 5-minute sweep. Owns five of the seven terminal paths. |
| `src/control/nudgeQueue.ts` | The delivery transport. Owns the other two. |
| `src/jobs/nudgeKinds.ts` | The per-kind predicates: `filled`, `moot`, `itemResolved`, `handoff`. |
| `src/db/nudges.ts` | `markNudgeOutcome` (`:323`), and `listNudgedSubjectRefs` (`:75`) — the any-status dedup read. |
| `src/db/reviewItems.ts` | `flagNudgeGap` (`:145`), `listEverFlaggedSubjectRefs` (`:266`). |
| `src/teamLead/planner.ts` | `buildGapView` — what the planner is shown about a gap (`:580`, `:694`). |
| `supabase/migrations/20260817090000_nudges.sql` | `uq_nudges_subject_ever` (`:51-56`), deliberately non-partial. |
| `supabase/migrations/20260823120000_planner_read_surface.sql` | `v_nudges`, which gave `nudges.resolution` its first reader (`:68`, `:89`). |

## Data Flows

### 1. The complete inventory

Every write of a terminal status with **no** planner decision behind it. Ranked by whether the gap
reaches a human afterwards, which is the severity axis.

| # | Path | file:line | Trigger | Writes | Manager item? |
|---|---|---|---|---|---|
| 1 | **Pre-ask carve-out** | `watchers.ts:734` | `!asked_at` && `spec.filled` | `answered` — *"a field report arrived — the gap filled itself"* | **NO** |
| 2 | **Moot** | `watchers.ts:744` | `spec.moot` — visit `cancelled`\|`completed`, or job `cancelled` | `cancelled` — *"the visit was X — nothing left to ask"* | **NO** |
| 3 | **Fail-safe** | `watchers.ts:804` | past `escalate_after` && `filled` && sole gap on job && planner silent ≥24h | `answered` | **NO** |
| 4 | 18h delivery expiry | `watchers.ts:926` | `created_at ≤ now−18h` && `pending`\|`queued` | `failed` — *"never delivered — handed to the manager"* | yes, flagged first |
| 5 | Escalation (rung 2) | `watchers.ts:1047` | `asked` && past `escalate_after` | `escalated` | yes, flagged first |
| 6 | Serve cap | `nudgeQueue.ts:157` | `serve_count ≥ MAX_SERVE_COUNT` | `failed` — *"undeliverable: served Nx"* | yes, `handToManager` first |
| 7 | Delivery failure | `nudgeQueue.ts:291` | delivery report `failed` past the retry cap | `failed` — *"delivery failed Nx"* | yes, `handToManager` first |

Paths 4–7 are the **terminal-failure doctrine** working as designed: flag first, close second, so a
gap that dies still reaches somebody. Paths 1–3 close with no handover, on the premise that nothing
is owed.

### 2. The pre-ask carve-out, end to end

```
visit ends, nothing written  ──►  detector mints a PENDING nudge
                                            │
              a capture — ANY capture — lands on the job
                                            │
                          sweep tick (every 5 min)
                                            │
                 watchers.ts:731  if (!n.asked_at)
                 watchers.ts:732    spec.filled(n, facts)
                                            │
                 hasActivitySince(jobId, startsAtLocal)      ← watchers.ts:511
                   latestByJob ← capture.captured_at         ← watchers.ts:504
                               ← visit.created_at            ← watchers.ts:505
                   ***timestamps only — the text is never read***
                                            │
                 watchers.ts:734  resolveNudge(… 'answered',
                                    'a field report arrived — the gap filled itself')
                                            │
                     ┌──────────────────────┴──────────────────────┐
              no review_items row                        uq_nudges_subject_ever
              (this path never flags)                    blocks any future nudge
                     └──────────────────────┬──────────────────────┘
                                            ▼
                          the visit is gone from both surfaces
```

The planner is never consulted: the sweep runs first in the lifecycle tick, and by the time the
planner reads open gaps the row is terminal.

### 3. The permanence chain

Three independent mechanisms combine, none of which is a defect on its own:

1. **`uq_nudges_subject_ever`** (`20260817090000_nudges.sql:51-56`) is `unique (tenant_id, kind,
   subject_ref)` and **deliberately not partial**. Its header: *"a resolved nudge must keep
   blocking: an assignment's end never recurs, so re-asking is never right."* `createPendingNudge`
   treats the 23505 as "already considered".
2. **The fresh pre-filter** (`watchers.ts:518-527`) excludes any subject ever nudged, via
   `listNudgedSubjectRefs` — which is explicitly **any status** (`nudges.ts:70-74`).
3. **No review item.** Paths 1–3 never call `flagNudgeGap`, so the manager surface has nothing
   either.

For paths 4–7 only (1) and (2) apply, and the review item is what keeps the gap alive for a human.

### 4. What the planner can see about a PENDING gap

Precision matters here: the planner is **not blind**, but nothing is pushed to it.

**Pushed into the gap block** (`buildGapView`, `planner.ts:~640-700`):

| Surface | Pending gap |
|---|---|
| `evidence since the ask` | **Empty by construction.** `askedAtMs` is `NaN` when `asked_at` is null, so `relevant = []` (`planner.ts:580-585`). The block prints *"(nothing was asked yet, so there is none)"* (`planner.ts:694`). |
| money on the job | Same gate — pinned by `planner.test.ts:332`, *"a never-asked gap is shown no money at all"*. |
| `THE RECORD` line | **Cost gaps only** (`planner.ts:666`). For a pending cost gap it reads *"no cost is recorded against this job yet."* A visit gap gets no RECORD line at all. |
| `historyLine` | Present — prior decisions on this gap. |
| context | customer, job title, technician, dates, `noticed Nh ago`, `asked: not yet`. |

**Pullable** — `spine_read` over `v_captures`, which the prompt names explicitly
(`plannerPrompt.ts:209-214`) along with the job id to filter by. So the note *is* reachable; the
planner must choose to go and look, against a line in the same block stating there is none.

The push side is pinned: `planner.test.ts:460`, *"a never-asked gap is shown no evidence at all —
there is no question to answer yet."*

## External Dependencies

None. Every path documented here is in-repo. The manager surface is `review_items`, read through
the manager-tier `list_pending_reviews`; `nudges` is read through `v_nudges` (`query_spine`).

## Constraints and Invariants

1. **The ruling's exact boundary, from the commit that made it.** `5a3c8ed` (2026-08-22),
   Phase 2: *"spec.filled no longer closes an ASKED gap: the sweep runs every 5 minutes against a
   planner that runs every 30, so the fast deterministic thing always won the race and the planner
   never saw an answer. **It still closes a gap nobody was asked yet (the detector re-checking
   itself).** The sweep keeps a fail-safe at the escalation deadline for a planner silent a full
   working day; it declines when the job carries more than one open gap."*
   The carve-out is therefore **reasoned about and kept**, not stale — `git blame` puts it in that
   same commit.
2. **What was reasoned about, and what was not.** The recorded justification for the carve-out
   (`nudgeKinds.ts:~150`) is a *timing* argument: *"the planner decides about pending rows without
   re-checking this, and its ask window holds an evening gap till 7am, so removing it means asking
   a technician at 7am about a job they **reported** at 8pm."* The argument is about a **report**.
   The predicate tests *any activity*. No comment, commit message, or plan in the corpus addresses
   activity that is not a report — the case appears **not considered** rather than accepted.
3. **The proxy gap, per predicate.**
   | Predicate | Literally tests | Justification claims | Content-blind? |
   |---|---|---|---|
   | `hasActivitySince` (`watchers.ts:511`) | max(capture.captured_at, visit.created_at) ≥ visit start | "they already reported" | **yes** |
   | `OVERDUE_VISIT_GAP_SPEC.moot` (`nudgeKinds.ts:279`) | assignment status ∈ {cancelled, completed} | "nothing left to ask" | n/a — reads status, not text |
   | `JOB_COST_GAP_SPEC.filled` (`nudgeKinds.ts:396`) | activity **since the ask** | "the technician answered" | yes, but bounded by the ask |
   | `itemResolved` | activity since flag, or terminal visit/job status | "the manager did the thing" | yes |
4. **The cost/visit asymmetry is deliberate and documented — on the cost side.**
   `JOB_COST_GAP_SPEC.filled` returns at its own `!n.asked_at` guard (`nudgeKinds.ts:401`), with the
   reason recorded: *"A completed job almost always already has a field note (that is usually what
   completed it), so comparing against the visit would mark every cost nudge answered the instant it
   was created."* There is a test named for the hazard —
   `watchers.test.ts:1413`, *"activity BEFORE the ask does NOT close it (the trap this bound exists
   for)"*. **The same hazard is the intended behaviour for visit gaps.** So a pending cost gap
   escapes the carve-out entirely, and a pending visit gap cannot.
5. **`moot` fires on `completed`, not only `cancelled`.** `nudgeKinds.ts:279` returns for
   `status === 'cancelled' || status === 'completed'`, and the assignment state machine allows
   `confirmed → ['completed','cancelled']` (`assignments.ts:24`). A visit marked *completed* closes
   its write-up gap as `cancelled` — *"nothing left to ask"* — with no manager item. Whether
   marking a visit complete is equivalent to reporting on it is not addressed anywhere in the
   corpus.
6. **A stale comment, and the migration that already knew.** The fail-safe's inline comment
   (`watchers.ts:~806-814`) states *"WHO ACTUALLY READS THIS… nobody today. `nudges.resolution` has
   no reader outside this file — there is no v_nudges view, query_spine has no grant on the
   table."* That was true when written and is **false now**:
   `20260823120000_planner_read_surface.sql:68` records its own purpose as giving *"nudges.resolution
   a reader (the ③ fail-safe's audit line had none)"*, and `:89` selects it. Every resolution string
   in the table above is manager-reachable through `query_spine`.
7. **THE PILOT CANNOT ANSWER FREQUENCY QUESTIONS ABOUT THIS AREA AT ALL — and the reason is
   sharper than low volume** (user, 2026-08-27). Its capture table spans a schema change: most rows
   predate `job_id` stamping and were never eligible to carry one. So any ratio computed across it
   (e.g. "5 of 269 captures carry a job_id") measures how much of the table is historical, NOT how
   often a capture is job-stamped. There is no sample size that repairs this — the population is
   mixed, not small. The repo states the underlying fact itself: *"a tech note's capture often
   carries no job_id stamp (identity resolves after L1, which is immutable)"*
   (`rawCaptures.ts:167-168`).
   Two readings taken on 2026-08-27 are recorded here so nobody re-derives them as evidence:
   0 of 18 `overdue_visit_gap` nudges closed by the carve-out, and 5 of 269 captures job-stamped.
   **Neither supports a claim about production behaviour.** The answerable version of "how wide is
   this" is a CODE question — which paths stamp `job_id`, and what mints a visit row — see Open
   Question 2.

## Decision Points

**1. Whether the carve-out's premise should be narrowed, and how.** Three directions, costed
against what exists today. No recommendation.

   - **(a) Narrow what counts as activity.** Make `hasActivitySince` (or a new predicate beside it)
     require something stronger than "a row touched this job" — e.g. a capture whose classification
     marks it a field report. Stays fully deterministic, so the ruling's principle is untouched: no
     judgment re-enters the sweep. Touches `watchers.ts:499-512` and every caller of
     `hasActivitySince` — which includes the **fail-safe** (path 3) and `itemResolved`, so it moves
     more than the carve-out. Requires a fact the capture pipeline may not currently carry; whether
     one exists is Open Question 1.
   - **(b) Let the pending gap reach the planner with its notes rendered.** Delete or narrow the
     carve-out and lift the pending-gap evidence gate (`planner.ts:580-585`, `:694`) so the block
     shows what is on the job. The planner then chooses — including `decline`, which now exists.
     This is the direction that would also make the decline verb reachable on visit gaps. Costs:
     the ruling's *timing* argument comes back (a gap noticed at 8pm is held by the ask window until
     7am, so the planner would decide the next morning about a job already reported on — though it
     would now decide with the note in front of it); `planner.test.ts:460` and `:332` pin the gate
     shut and would have to be rewritten with their reasons; the eval corpus's pending-gap scenarios
     (PM-06, PM-07, WD-06, MG-09, WD-04) all change shape, since their blocks gain content.
   - **(c) Close, but hand over.** Keep the carve-out's trigger and add a `flagNudgeGap` before the
     close, so paths 1–3 join 4–7 in the terminal-failure doctrine. Smallest change to the sweep's
     logic and it ends the orphan outright. Costs: the manager's queue gains an item for **every**
     pre-ask close, including the overwhelmingly common benign one (the technician did write it up),
     which is precisely the churn the carve-out's header says it exists to prevent — *"a manager's
     attention spent on nothing."* Volume unknown; see Open Question 3.

**2. Whether paths 2 and 3 are in scope with path 1.** They share the no-manager-item property and
therefore the orphan, but not the proxy gap: `moot` reads a status, and the fail-safe already
requires the planner to have been silent a full working day. A fix aimed only at path 1 leaves two
paths that can still close a gap with nothing owed to anyone. Invariant 5 records that `moot` on
`completed` has its own unexamined premise.

**3. Whether `answered` is the honest status for path 1 at all.** Independent of the trigger: the
resolution string *"a field report arrived — the gap filled itself"* asserts something the predicate
did not check, and it is manager-readable (Invariant 6). A code-written line that claims only what
was tested — activity on the job — would be a smaller change than any of the three directions above
and is orthogonal to all of them.

**4. Whether the eval corpus should be able to express this at all.** No scenario in the 66-strong
corpus seeds a capture on a **pending** visit gap; the shape is currently untestable end to end
because the sweep closes it inside the harness too. That is why
`thoughts/shared/plans/2026-08-26-the-decline-verb.md` withdrew PJ-09. Whichever direction is taken,
a scenario asserting the new behaviour has to be written against it.

## Open Questions

- **Does a capture carry anything that distinguishes a field report from an aside?**
  Direction (a) depends on it. `raw_captures` has `channel` and the classifier's metadata; whether
  any existing column separates "a write-up" from "a note that mentions the job" was not established
  by reading, and would decide whether (a) is cheap or needs new classification.
- **What actually creates the captures that trigger this in production?** The carve-out fires on any
  capture with a `job_id`. Which paths stamp a `job_id` — `record_field_note`, the inbound email
  classifier, Composio log ingest — determines how often a non-report capture lands on a job with an
  open pending gap. Not derivable from reading alone.
- **How often would direction (c) fire?** The benign case (technician writes it up before the ask
  goes out) is presumably the common one, and it is exactly the case that would generate a manager
  item under (c). Measuring it needs production volume the pilot does not have.
- **Is `moot` on a `completed` visit intended to close a write-up gap?** The state machine allows
  it and the copy says "nothing left to ask", but marking a visit complete is not a write-up.
  Whether this was considered is not recorded anywhere found.
- **Does the fail-safe's `soleGapOnJob` guard hold for a pending gap?** The guard was written for
  the asked-gap case; whether the same ambiguity argument applies to path 1 (which has no such
  guard) was not examined here.
