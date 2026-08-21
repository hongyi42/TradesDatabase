---
date: 2026-08-21
branch: plan/group-a
commit: 04a8ff5
topic: The money trio re-verified — which "the ladder cannot see the money ledger" defects still exist after the work that landed since 2026-08-19
---

## Summary

The **ladder** is the machinery that notices a hole in a job's record, asks somebody about it,
and escalates to a manager if nobody answers. The **money ledger** (`money_events`) is a separate
append-only table recording what a job earned and — since 2026-08-19 — what its materials cost.
On 2026-08-19 a defect was recorded: a technician answered a question with money ("the customer
paid 500 on the spot"), the answer became a ledger row, and the ladder could not see it, so the
gap stayed open and eventually told a manager the technician "hasn't heard back". That was called
one of three "the ladder cannot see the money ledger" defects, and the user ruled they be designed
together rather than patched one at a time.

This document re-verifies all of it against today's code. **Three of the six money-touching
components have become money-aware since then** — the cost detector, the review-item sweep, and
the planner's record-basis close. What remains is narrower but load-bearing: one shared predicate,
`hasActivitySince`, is money-blind and is used at BOTH ends of the ladder (opening a gap and
closing it) for BOTH gap kinds. Separately, money events are the only L2-adjacent rows in the
system that record no provenance.

The most important finding is a trap: **the obvious one-line fix does not fix the specimen.** The
set that is already in hand at the sweep, `jobsWithCostEvents`, is scoped to `kind='material_cost'`
only. The Tankless event was a `payment_received`. Wiring that set into the closure predicate would
leave the very case that motivated this work still broken.

## Entry Points

| Entry point | File:line | Money-aware today? |
|---|---|---|
| Visit gap DETECTION | `src/jobs/watchers.ts:444` (`candidates.filter(c => !hasActivitySince(...))`) | **NO** |
| Cost gap DETECTION | `src/jobs/watchers.ts:820-832` (`listCostCandidates` → `listCostEvents` filter) | **YES** |
| Nudge sweep — closure | `src/jobs/nudgeKinds.ts:181-189` / `:295-304` (both specs' `filled`) | **NO** |
| Review-item sweep — closure | `src/jobs/nudgeKinds.ts:315-323` (`itemResolved`) | **YES** |
| Planner — record-basis close | `src/teamLead/planner.ts:288-296` (`recordFilled`) | **YES**, cost gaps only |
| Escalation / expiry copy | `src/jobs/nudgeKinds.ts:151-159`, `:258-262`, `:341-348` | **NO** |
| Nudge resolution strings | `src/jobs/watchers.ts:555`, `:561`; `src/db/nudges.ts` | **NO** |
| Money write | `src/mcp/server.ts:5479` (`appendMoneyEvent`) | n/a — writes no provenance |

## Key Files

- **`src/db/moneyEvents.ts`** — the ledger's typed layer. `MONEY_EVENT_KINDS` (`:11-29`, now
  including `material_cost` at `:28`), `appendMoneyEvent` (`:88`), `listMoneyEventsForJob` (`:191`),
  `listMoneyEventsForJobs` (`:203`), `listJobIdsWithCostEvents` (`:229`), `summarizeMoney` (`:337`),
  `deriveStatusTarget` (`:397`), `syncJobStatusForMoney` (`:465`).
- **`src/jobs/watchers.ts`** — both detectors and both sweeps. `latestByJob` (`:402-436`),
  `hasActivitySince` (`:441-442`), `predicateJobIds` (`:488`), `jobsWithCostEvents` (`:506-508`),
  `facts: SweepFacts` (`:513-519`), the cost detector (`:818-845`).
- **`src/jobs/nudgeKinds.ts`** — the kind registry. `SweepFacts` (`:39-59`, the deferral note at
  `:52-58`), both specs' `filled` / `moot` / `itemResolved` / `handoff`, and all the manager copy.
- **`src/db/jobs.ts:223-280`** — `listCostGapCandidates`, the cost detector's candidate query.
- **`src/teamLead/planner.ts`** — `recordFilled` (`:288-296`), `jobsWithCostEvents` read (`:720`).
- **`supabase/migrations/20260819120000_material_cost_kind.sql`** — the cost kind.
- **`supabase/migrations/20260819130000_job_cost_gap_backstop.sql`** — `uq_review_items_job_cost_gap_ever`.
- **`supabase/migrations/20260815160000_money_events.sql:40`** — `source_capture_id uuid references raw_captures(id)`.

## Data Flows

### Money visibility, per component

```
                      ┌──────────────── money_events ────────────────┐
                      │  material_cost │ payment_received │ invoice… │
                      └───────┬──────────────────┬──────────────┬────┘
                              │                  │              │
  cost DETECTOR ──────────────┘                  ✗              ✗
    watchers.ts:827  listCostEvents → filters out costed jobs
                              │
  item SWEEP ─────────────────┘                  ✗              ✗
    nudgeKinds.ts:316  f.jobsWithCostEvents.has(item.jobId)
                              │
  PLANNER (cost gaps) ────────┘                  ✗              ✗
    planner.ts:293  recordFilled → "a cost is recorded … on the money ledger"

  visit DETECTOR ─────────────✗──────────────────✗──────────────✗
  nudge SWEEP (both kinds) ───✗──────────────────✗──────────────✗
    both route through hasActivitySince → latestByJob
    latestByJob = max(job-stamped raw_captures.captured_at, visits.created_at)
  COPY / resolutions ─────────✗──────────────────✗──────────────✗
```

### `latestByJob` — what "activity" means today

Built at `src/jobs/watchers.ts:402-436` from exactly two readers:

- `listJobStampedCaptureTimes` (`src/db/rawCaptures.ts:171-197`) — `raw_captures` rows with a
  non-null `job_id`;
- `listVisitTimesForJobs` (`src/db/visits.ts:42-65`) — `visits.created_at`.

Consumed by `hasActivitySince` (`:441-442`), which is used in three places: the visit detector's
gap filter (`:444`), `OVERDUE_VISIT_GAP_SPEC.filled` (`nudgeKinds.ts:186`), and
`JOB_COST_GAP_SPEC.filled` (`:301`, bounded by `naiveLocal(asked_at)` rather than the visit start).

**The predicate enumerates tables rather than asking "did anything land on this job".** That
phrasing is the 2026-08-19 doc's own diagnosis and it still describes the code exactly.

### The kind-scoping trap

`listJobIdsWithCostEvents` (`src/db/moneyEvents.ts:229-293`) is `.eq('kind', 'material_cost')`
(`:253`) with a second pass folding out rows cancelled by `NEGATING_KINDS` (`:265-288`). Its header
states the scoping deliberately: *"Kind-scoped: only 'material_cost' counts as 'cost recorded', so
a job with invoices but no cost is still a gap"* (`:220-221`).

Consequence for the specimen: job `eea05151` carries one `payment_received`. It is **not** in
`jobsWithCostEvents` and never will be. Any fix built by consuming that set leaves the Tankless
case broken.

There is no reader today for "did any money land on these jobs since a bound".
`listMoneyEventsForJobs` (`:203-216`) is the closest — batched by job, all kinds — but it takes no
time bound and, unlike its neighbours, runs **no pagination loop**, so it is exposed to PostgREST's
silent 1000-row cap.

### Provenance

`AppendMoneyEventInput.sourceCaptureId` exists (`src/db/moneyEvents.ts:64`) and is written to the
column at `:164`. **No caller anywhere passes it.** A grep for `sourceCaptureId` across `src/`
shows every other L2 surface stamped — `visits` (`recordFieldNote.ts:244`), `customers` (`:262`),
`jobs`/`assignments` (`:273`), standing facts (`server.ts:3265`) — and `money_events` alone
unstamped. The `record_money_event` dispatch (`server.ts:5479-5490`) passes ten fields; that is not
one of them.

## External Dependencies

- **Supabase / PostgREST** — every read here. The silent 1000-row cap is why `listJobIdsWithCostEvents`
  pages and chunks (`:234-237`) and is the reason `listMoneyEventsForJobs` is exposed.
- No third-party service is involved in the money ledger itself; it is entirely internal.

## Constraints and Invariants

1. **`money_events` is append-only, DB-enforced** (`20260815160000_money_events.sql:49`). A wrong
   row is never edited — it is cancelled by a new row pointing at it via `corrects_event_id`.
2. **Direction comes from `kind`, never sign** (`moneyEvents.ts:36-37`). Amounts are non-negative.
3. **"Live" is load-bearing.** `listJobIdsWithCostEvents`'s header (`:223-228`) records that a raw
   `kind='material_cost'` probe counted cancelled rows as real, so correcting a typo suppressed the
   gap **forever** — `subject_ref` is the job and `uq_nudges_subject_ever` is any-status.
4. **Ask once per subject, EVER** (`uq_nudges_subject_ever`; the review-item twin
   `uq_review_items_job_cost_gap_ever` landed 2026-08-19). A gap closed wrongly cannot be reopened.
5. **`record_money_event` is manager-tier only** (`server.ts:2083-2085`). A technician-tier answer
   containing an amount can only become prose — stated as an accepted limitation at
   `nudgeKinds.ts:280-283`.
6. **The two gap kinds bound activity differently.** The visit spec measures from the visit start;
   the cost spec measures from `naiveLocal(asked_at)`, because a job whose cost is being asked about
   "always already has a field note" (`nudgeKinds.ts:293-295`).
7. **`jobsWithCostEvents` is deliberately not consumed by any `filled`** (`nudgeKinds.ts:52-58`) —
   the recorded deferral.
8. **The two detectors use different notions of "already handled".** The cost detector asks the
   ledger directly (`watchers.ts:827`); the visit detector asks `hasActivitySince` (`:444`).

## Decision Points

**D1. Does a money event alone fill a VISIT gap?** Carried forward unanswered from the 2026-08-19
doc, which called it *"a product call, not an engineering one"*: a payment proves contact happened
but says nothing about how the work went. Option A — yes, it closes the nudge (somebody answered).
Option B — no; it proves contact but the job's record still lacks the field report, so it wants a
second predicate. Option C — it closes the nudge but simultaneously opens (or leaves) a
record-completeness gap. Today's code does none of these: it cannot see the event at all.

**D2. Which money kinds count as activity, and for which gap kind.** `jobsWithCostEvents` is
`material_cost`-only by deliberate design. A visit gap answered with `payment_received` needs a
different read. Option A — one broad "any money event since the bound" reader used by both kinds.
Option B — per-kind money scoping in the registry, so each spec declares which kinds answer it.
Option C — keep `material_cost` for cost gaps and add a separate broad reader for visit gaps.

**D3. Where the widening happens.** Option A — extend `latestByJob`'s accumulator so the closure
check asks "did anything land on this job", with the input list extensible by the kind registry
(the 2026-08-19 doc's own suggestion). This fixes detection AND closure for both kinds in one
place. Option B — leave `latestByJob` alone and add money as a separate fact on `SweepFacts` that
each spec consults, which keeps the visit detector blind unless changed too.

**D4. Whether widening the predicate should also change DETECTION.** `hasActivitySince` is used at
`watchers.ts:444` to decide whether to open a visit gap at all. Widening it means fewer gaps are
ever opened. Option A — accept that (a job with a payment right after the visit is arguably not a
gap). Option B — scope the widening to closure only, keeping detection's current sensitivity.
Note the two are the same function today, so "do nothing" is not available once it is widened.

**D5. Money-event provenance.** The column and the input field exist; nothing populates them.
Option A — leave it; an amount recorded from chat cites nothing. Option B — pass `sourceCaptureId`
when a capture exists in the same turn, which requires the note to be recorded first and the two
calls to be ordered. Option C — accept an amount with no capture and stamp the nudge id instead.
Flagged on 2026-08-19 as *"may be intended for manager-tier chat, or may be a second gap — confirm
before treating it as a bug."* Still unconfirmed.

**D6. Resolution strings.** `resolveNudge(… 'answered', filled)` and the escalation path write
free-text resolutions that are persisted and read by humans — `"no reply — handed to the manager"`
is on the Tankless row and is false. Option A — treat them as internal labels and leave them.
Option B — hold them to the same "assert nothing you were not given" rule as the manager copy.

## Open Questions

1. **What is on the pilot's ledger by kind?** This document establishes that `material_cost` is
   scoped out of the visit path, but not how often each kind actually appears. A `group by kind`
   over `money_events` would say whether `payment_received`-as-an-answer is the common shape or a
   one-off.
2. **Does `syncJobStatusForMoney` (`moneyEvents.ts:465`) already close some gaps indirectly?** It
   moves a job's status when money lands, and `JOB_COST_GAP_SPEC.moot` (`nudgeKinds.ts:306-309`)
   cancels on `status === 'cancelled'`. Whether a status move can incidentally resolve a gap was
   not traced here.
3. **Is `listMoneyEventsForJobs`'s missing pagination reachable?** It has no `PAGE` loop while its
   neighbours do. Whether any caller can pass enough job ids to exceed 1000 rows was not determined.
4. **How many open gaps would close immediately if the predicate widened?** Relevant to rollout —
   a widening could resolve a backlog in one tick. Needs a query against the pilot, not reading.
5. **Does the technician-tier limitation (constraint 5) interact with D1?** If a technician cannot
   write money at all, a money-answered visit gap can only arise from a manager-tier seat — which
   is what the pilot is. Whether that stays true as technician seats are added was not determined.
