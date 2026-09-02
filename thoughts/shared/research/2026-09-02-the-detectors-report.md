---
date: 2026-09-02
branch: feat/one-send-verb
commit: a6fabae
topic: "Build 7 — the detectors report: they stop minting; the record is planner-kept. What is left after builds 4, 5, 6 and 6.5."
supersedes: nothing
---

**`supersedes:` — nothing.** This document overturns no decision. It reports the ground on the
6.5 branch and, where an earlier document's claim no longer matches the code, says so in place
(three such corrections are marked **CORRECTION** below) rather than superseding the document,
because in each case the claim was true when written and the code moved under it.

## Summary

Build 7's headline is "the detectors report — they stop minting; the record is planner-kept."
**Most of that headline has already shipped.** Build 4 turned the detector sweep's output from
*questions addressed to a person* into *observations* — a plain record of the system having
noticed something. Build 5 deleted every clock that acted on a gap. Build 6 gave the planner
`dismiss` and `recover` at every stage. Build 6.5 gave it one `send` that reaches anybody.

What is left is narrower and sharper than the headline suggests, and it is mostly about
**authorship and identity**, not about minting:

1. **Nothing the detector sweep writes is a "mint" any more, with one exception** — it writes
   observations, which is the recording the charter asked for. It files no review item, opens no
   nudge, and moves no row's state. The one thing still shaped like minting is that **the sweep is
   the only thing in the system that may create an observation at all.**
2. **The planner cannot open its own observation.** The direction's second half — "the detector
   must not be the only way a gap opens" — is entirely unbuilt. `createObservation` has exactly one
   production caller.
3. **The record's dedup is still code-made and permanent, and it is not the same thing as
   dismissal.** `uq_observations_subject_ever` blocks a subject from ever entering the record
   twice; dismissal hides an existing row from the planner. The observations migration's own
   header describes these as one mechanism. They are two, and the difference is load-bearing for
   this build.
4. **Nothing decides what a gap's SUBJECT is except the shape of the detector's source query** —
   which is where build 8 ("a visit is not a person") collides with this build, and why §6a calls
   build 7 the load-bearing seam.

Alongside those, `review_items` has quietly become two tables sharing one name: a live
staged-action token store, and a dead sediment of detector findings nothing writes any more.

**Plain language, for a reader who is not deep in this:** the "detectors" are two small
deterministic checks that run every five minutes and notice two things — a visit whose scheduled
end passed with nothing written about it, and a finished job with no parts cost recorded. They
used to *ask a technician a question* the moment they noticed. Since build 4 they only *write
down that they noticed*, and the planner (the model that runs every 30 minutes) decides whether
anyone gets asked. Build 7 is about who owns that written-down record — and today the answer is
still "code owns whether something enters it; the planner owns only what happens to it after."

## Entry Points

| Where the area begins | File:line |
|---|---|
| The detector sweep (both detectors, the alarm pass) | `src/jobs/watchers.ts:267` (`runWatchers`) |
| Detector #1 — overdue visit, records observations | `src/jobs/watchers.ts:579-620` |
| Detector #2 — job cost, records observations | `src/jobs/watchers.ts:634-682` |
| The alarm pass (three counters, acts on nothing) | `src/jobs/watchers.ts:693-869` |
| The observation store | `src/db/observations.ts:34` (`createObservation`) |
| The observations schema, and the design in its header | `supabase/migrations/20260901130000_observations.sql` |
| The planner's tick, both gap sources merged | `src/teamLead/planner.ts:3279-3322` |
| An observation worn as a gap row | `src/teamLead/planner.ts:1504` (`observationAsGapRow`) |
| The gap block the planner reads | `src/teamLead/planner.ts:1138` (`buildGapView`) |
| The kind registry (one production reader: the sweep) | `src/jobs/nudgeKinds.ts:118` (`NUDGE_KIND_SPECS`) |
| The review-item store | `src/db/reviewItems.ts:9-63` (the `ReviewKind` union) |
| The planner's tool allowlist and its stated rule | `src/teamLead/identity.ts:12-14, 37` |

## Key Files

**`src/jobs/watchers.ts`** (872 lines) — the whole detector surface. Exports `WatcherMode`,
`ASK_UNATTENDED_ALARM_HOURS` (24), `DELIVERY_STUCK_ALARM_HOURS` (18), `OBSERVATION_STALE_HOURS`
(72), `PLANNER_JUDGMENT_ACTIONS`, `wallClockLabel`, `runWatchers`. Re-exports `OVERDUE_HOURS` /
`LOOKBACK_HOURS` from `tenantSettings.ts` so every historic importer still finds them
(`watchers.ts:103`).

**`src/db/observations.ts`** (168 lines) — raw accessors only. `createObservation` (34),
`listObservationsByStatus` (59), `listObservedSubjectRefs` (85), `listDismissedObservationIds`
(105), `setObservationStatus` (131). `PAGE = 1000` and both list readers page past PostgREST's
silent 1000-row cap, explicitly because "the open set is unbounded BY DESIGN"
(`observations.ts:52-56`).

**`src/jobs/nudgeKinds.ts`** (128 lines) — `SweepFacts`, `OpenItemView`, `NudgeKindSpec`,
`OVERDUE_VISIT_GAP_SPEC`, `JOB_COST_GAP_SPEC`, `NUDGE_KIND_SPECS`, `specFor`. A spec now carries
exactly two members: `subjectIsVisit` and `itemResolved`.

**`src/db/reviewItems.ts`** (~400 lines) — `ReviewKind` (22 members), `upsertOpenReviewItem`,
`flagUnknownRefCapture`, `listEverFlaggedSubjectRefs`, `openUnlinkedCallReview`,
`openCallActionReview`, `findOpenReviewItem`, `resolveOpenReviewItemFor`,
`flagOffboardingReminder`, `updateOpenReviewItemDetail`, `getOpenReviewItem`,
`findOpenReviewItemsByKind`, `listOpenReviewItems`, `annotateResolvedReviewItem`,
`resolveReviewItem`. Carries `flagNudgeGap`'s tombstone at lines 138-146.

**`src/teamLead/planner.ts`** (4267 lines) — `PLANNER_ACTIONS`, `UNMENTIONED_CAP`,
`buildGapView`, `observationAsGapRow`, `validateDecisions`, `buildPlannerUserMessage`,
`applyDecision`, `runPlanner`.

**`src/teamLead/plannerPrompt.ts`** (478 lines) — `PLANNER_SYSTEM` (a joined string array) and
`SUBMIT_PLAN_TOOL`.

**`src/teamLead/identity.ts`** (57 lines) — `TEAM_LEAD_REF`, `TEAM_LEAD_TOOL_NAMES` (8 tools).

**`src/eval/plannerSim.ts`** — `SimNudgeKind`, `SimNudgeStatus`, `ScenarioNudgeSpec`,
`ScenarioWorld`, `seedScenario`, `runArc`. **`src/eval/plannerCorpus.ts`** — `TimelineStep`,
`ScenarioExpect`, `PlannerScenario`, 68 scenarios across 10 families.

---

## Area 1 — What still mints

### What the sweep creates today

```
runWatchers (every 5 min, mode 'live')
│
├─ per tenant ────────────────────────────────────────────────────
│   │
│   ├─ READS  listOverdueConfirmedAssignments   → candidates
│   │         listJobStampedCaptureTimes / listVisitTimesForJobs
│   │         listEverFlagged / listNudged / listObserved  (the fresh filter)
│   │
│   ├─ RESOLVES  open review_items of registered kinds  ── the ONLY write
│   │            that touches review_items                  besides nothing
│   │
│   ├─ CREATES   observations  (overdue_visit_gap)      watchers.ts:592
│   │            observations  (job_cost_gap)           watchers.ts:663
│   │
│   └─ (nothing else)
│
└─ alarm pass (outside the detection try) ─── counters only, acts on NOTHING
```

**The complete list of what the sweep writes:** two kinds of `observations` row, and status
updates on `review_items` that were opened before build 6. That is all. Verified by reading the
import list (`watchers.ts:1-21`): no review-item *creation* function is imported —
`findOpenReviewItemsByKind` and `resolveOpenReviewItemFor` are the only two review-item names it
holds.

### `flagNudgeGap` — CONFIRMED deleted

`src/db/reviewItems.ts:138-146` carries its tombstone verbatim:

> `(flagNudgeGap stood here until build 6 Phase 1. […] Its only caller was escalate, which is
> deleted, so nothing files a gap item any more. EVERY ITEM EVER FILED STAYS — the rows, the two
> any-status unique indexes, escalated_from_nudge, list_pending_reviews and the board all read
> unchanged; only the writer is gone.)`

### "watchers.ts no longer touches a nudge's or an observation's STATE" — CONFIRMED

`watchers.ts:553-557` states it, and the code agrees. The only state writes in the function are
`resolveGap(...)` (`watchers.ts:544-550`) against `review_items`, and `createObs(...)` — an
insert, not a state move. `listNudgesByStatus` / `listObservationsByStatus` appear only in the
alarm pass, read-only.

### The consequence nobody has written down yet

**The review-item auto-resolve loop is now a drain with no source.** It iterates
`NUDGE_KIND_SPECS` (2 kinds), finds their OPEN review items, and closes the ones whose subject has
been satisfied (`watchers.ts:370-383` for the read, `watchers.ts:526-551` for the loop). But
nothing has written an `overdue_visit_gap` or `job_cost_gap` review item since build 6 Phase 1.
So the loop's input set can only ever shrink, and once the last pre-build-6 row closes it runs
forever over an empty set.

This matters for build 7 because `NudgeKindSpec.itemResolved` is now the spec's *entire* reason to
exist (`nudgeKinds.ts:14-18` says so explicitly: "What remains is the ONE judgment the sweep
kept"). When the last gap review item closes, the registry's only surviving job is the one thing
its header does not mention: **gating whether an observation may be created at all**
(`watchers.ts:576-578`, "Creation stays REGISTRY-GATED").

### What "detectors stop minting" still has left to remove — the plain list

1. **Nothing.** There is no remaining path by which a detector files a question or a manager item.
2. What the charter's phrase can still *mean*, given the above, is the inverse of removal —
   **admitting a second author.** The sweep is the sole writer of `observations`
   (`createObservation`'s only production caller is `watchers.ts:283`), so "the record is
   planner-kept" is true of *curation* and false of *authorship*.
3. One genuine removal candidate that is not about the sweep: **the four dead-end review kinds and
   the two reminders** that §6.5 predicted would "leave in build 7 when detectors stop minting".
   See Area 6 — they are alive, they have production writers, and **none of those writers is the
   detector sweep.**

---

## Area 2 — Who keeps the record

### The four stores the fresh filter consults

Detector #1 (`watchers.ts:466-479`) and detector #2 (`watchers.ts:640-651`) each build an
`everSurfaced` set. Detector #1 consults three stores, detector #2 consults four (it adds a
"does a cost already exist" test that is a fact about the world, not a dedup store).

| Store | Reader | Table | What it is for | Status |
|---|---|---|---|---|
| `listEverFlaggedSubjectRefs` | `reviewItems.ts:153` | `review_items`, **any status** | The manager-queue history. Was the cap pre-filter. | **Pre-split history.** Nothing writes gap items any more, so this set is frozen. |
| `listNudgedSubjectRefs` | `nudges.ts:135` | `nudges`, **any status** | "Asked once, ever" — the pre-build-4 dedup. | **Pre-split history**, plus every gap the planner has since sent (a send writes a `nudges` row). |
| `listObservedSubjectRefs` | `observations.ts:85` | `observations`, **any status** | "Noticed once, ever" — the live store. | **Live.** This is the one that owns the rule now. |
| `listJobIdsWithCostEvents` | `moneyEvents.ts:259` | `money_events` | Detector #2 only: the hole is already filled. | Not a dedup store — a world fact. |

The first two are labelled in place: *"the older two keep pre-split history from re-surfacing"*
(`watchers.ts:469-471` and `watchers.ts:643-646`).

### The contradiction, stated precisely

The observations migration header (`20260901130000_observations.sql:66-72`) says:

> *"This index is the detector's half: a subject enters the record once, whatever later happens to
> the row — **and the DISMISSAL is what stops re-surfacing**, made by the planner and revisable,
> where the old dedup was made by code, permanently, at first sight."*

**CORRECTION — the two clauses describe two different mechanisms, and the sentence reads as though
they are one.**

```
                        DETECTOR                          PLANNER
                           │                                 │
      subject already in ──┤                                 │
      observations, ANY    │  uq_observations_subject_ever    │  status = 'open'
      status?              │  + listObservedSubjectRefs       │
                           │  ── PERMANENT, code-made ──      │  ── revisable ──
                           ▼                                  ▼
                  no new row, ever                  shown / not shown this tick
```

- **What the unique index stops** is a *second row for that subject* — for all time, whatever the
  row's status. `createObservation` catches 23505 and returns `null`
  (`observations.ts:47-48`).
- **What dismissal stops** is the row appearing in the planner's read, because `runPlanner` asks
  for `['open']` only (`planner.ts:3281`).

So "the dismissal is what stops re-surfacing" is true only if "re-surfacing" means *to the
planner*. To the *detector*, dismissal changes nothing — and it does not have to, because
`listObservedSubjectRefs` deliberately filters on no status at all
(`observations.ts:80-84`: *"a dismissed observation must keep blocking re-notice, or 'dismiss'
stops meaning 'stop showing me this'"*).

### Trace: a second detection after dismiss, and after recover

```
t0   detector notices assignment A          → observations row (A, open)
t1   planner dismisses it                   → same row (A, dismissed), dismiss_reason set
t2   sweep runs, A is still in the window   → listObserved returns A → NOT fresh → no write
t3   planner recovers it                    → SAME ROW (A, open), dismiss_reason/at/not_before
                                              cleared  (planner.ts:3026-3031)
t4   sweep runs                             → still not fresh; the row is already there
```

**There is exactly one observations row per (tenant, kind, subject_ref) for the life of the
firm.** A recovered observation is the same row, not a new one — `setObservationStatus` is an
UPDATE guarded on `['dismissed']` (`planner.ts:3026-3031`, `observations.ts:131`). The detector
never gets a second say about that subject, ever, regardless of what the planner did.

### The consequence already recorded elsewhere, in the sibling store

`src/db/moneyEvents.ts:253-259` documents what this shape cost once, on the `nudges` twin:

> *"A raw kind='material_cost' probe counted a cancelled row as real, so correcting a typo
> suppressed the gap FOREVER: subject_ref is the job and uq_nudges_subject_ever is any-status, so
> that job could never be asked again. **Doing the right thing was what buried it.**"*

The same shape now lives on `observations`, with the same any-status semantics.

### `OBSERVATION_STALE_HOURS = 72`

- **Where:** `watchers.ts:126`. Its comment says it was moved verbatim from `planner.ts` — build
  4's counter, re-homed into the sweep so it survives planner death (`watchers.ts:106-113`).
- **What it does:** in the alarm pass only. `staleCandidates` = open observations whose
  `noticed_at` is ≥72h old and which are not currently held (`watchers.ts:782-788`). Those are
  then filtered by `attendedWithin(o.id, 72, /* leaveCounts */ false)` and the remainder is counted
  into `summary.alarms.observationsStale` (`watchers.ts:841`) and named on stderr
  (`watchers.ts:846-861`).
- **Who acts on it:** **nobody.** The alarm pass never sets `ok = false` (`watchers.ts:110-113`),
  nothing is pushed, and the counter reaches `lifecycle_runs.summary` and `npm run ticks` only.
- **Whether it is a code judgment:** it encodes one number — *how long is too long for the planner
  to leave an observation alone* — and it is the only such number left on the observation side
  after build 5 deleted the acting clocks. It fires nothing, so it is an instrument, not a rail.
  `docs/observability-gaps.md`'s own opening rule classifies *"a stale observation"* as
  **somebody's judgment, not a malfunction**, and therefore explicitly not an operator alarm.

---

## Area 3 — The planner opening its own observation

### `createObservation` today

```ts
// src/db/observations.ts:22-50
export interface CreateObservationInput {
  tenantId: string;
  kind: ReviewKind;            // ← a CLOSED TypeScript union of 22 members
  subjectRef: string;
  technicianId: string | null; // ← "ADVISORY … Null is a normal value, not a defect"
  context?: Json;              // ← defaults to {}
}
export async function createObservation(input): Promise<Observation | null>
```

**NOT NULL in the table** (`20260901130000_observations.sql:34-60`): `id` (defaulted),
`tenant_id`, `kind`, `subject_ref`, `context` (defaulted `{}`), `status` (defaulted `'open'`),
`noticed_at`, `updated_at` (both defaulted). Nullable: `technician_id`, `dismiss_reason`,
`dismissed_at`, `not_before`.

So the *minimum* a planner-opened observation must supply is **a kind and a subject_ref**. Two
frictions follow:

1. **`kind` is a closed union in TypeScript but a plain `text` column with no CHECK in the DB.**
   The union is `ReviewKind` (`reviewItems.ts:9-63`), shared with `nudges.kind` and
   `review_items.kind` — *"one gap, one name"*. A planner-chosen kind is either a new union member,
   a widening of the parameter type, or a reserved literal.
2. **`subject_ref` is what `uq_observations_subject_ever` dedupes on.** A planner-opened
   observation must name a subject, and if it picks one a detector already owns (a job id, an
   assignment id) `createObservation` returns `null` — silently, as "already noticed".

**Only caller today:** `src/jobs/watchers.ts:283`. There is no second one.

### What the planner has to read L1/L2 first

| Tool | In `TEAM_LEAD_TOOL_NAMES`? | Citable? | Notes |
|---|---|---|---|
| `spine_read` | yes (`identity.ts:39`) | **yes** (`CITABLE_TOOLS`, `planner.ts:1598`) | ONE read-only SQL SELECT (`server.ts:1824-1839`). The catalog includes `v_observations`, `v_nudges`, `v_captures`, `v_visits`, `v_review_items`. |
| `get_customer_context` | yes (`identity.ts:55`) | **yes** | |
| `recall_decisions` | yes (`identity.ts:42`) | no | Its own decisions — quoting them "would make you the witness to your own conclusion" (doctrine). |
| `read_memory` / `write_memory` | yes | no | Build 3. The first write verb. |
| `read_job_note` / `write_job_note` | yes | no | The second write verb. |
| `resolve_date` | yes | no | |
| `query_spine` | **NO** | — | Removed 2026-08-19 as provably unreachable (`identity.ts:31-36`): the planner has no roster row, so the manager-tier gate refused it every time. |

**Note for a plan quoting §6a entry 6:** that entry's "ACCEPTED RESIDUE" paragraph names
`query_spine` as the SQL surface through which the planner could fabricate a quotable string.
`query_spine` is not reachable for this identity. The residue is real but the surface is
**`spine_read`**, which takes the same free SQL and IS in `CITABLE_TOOLS`.

Every `spine_read` call is written to `query_audit` with its SQL (recorded in §6a entry 6).

### The identity gate, verbatim

`src/teamLead/identity.ts:11-14`:

> *"There is no human behind this identity to confirm anything, so **nothing irreversible or
> externally visible** may ever dispatch for it; enforcement is mechanism (the gate), never prompt
> text."*

Build 3 admitted `write_memory` against that rule and wrote down why (`identity.ts:19-24`): not
irreversible (ten versions archived), not externally visible (no person receives anything). Build
3's job-notepad addition (`identity.ts:48-53`) added one stronger argument: `write_job_note` cannot
delete at all.

**Applied to opening an observation:** it is internal (nobody receives anything) and reversible
(`dismiss` hides it, and the row is a status machine with no delete path). §6a entry 4 already
records this reading: *"opening an observation is internal and reversible, so a planner-opened gap
passes 'nothing irreversible or externally visible' unchanged."* Nothing in the code contradicts
it. The one novelty `write_memory` introduced and that would apply here too: a tool that mutates
durable state from **inside** the tool loop has no post-loop validation stage —
`applyDecision` re-checks every rail *after* `runLoop` returns, and a tool call bypasses that
entirely (`identity.ts:25-30`).

### Decision vs tool — the distinction as the code draws it

```
   THE MODEL'S TURN                        AFTER THE LOOP RETURNS
   ────────────────                        ──────────────────────
   spine_read      ─┐                      validateDecisions(raw, views, …)
   recall_decisions │  dispatched TOOLS,        │  rails re-checked
   write_memory     │  effect is immediate      ▼
   write_job_note  ─┘  and unvalidated      applyDecision(...) per entry
                                                │  guarded conditional UPDATEs
   submit_plan     ──  TERMINAL: it is          ▼
                       a PROPOSAL only      rows move, or 'refused' is recorded
```

`submit_plan` is the loop's terminal tool, and its `decisions[]` are proposals that code performs.
A `send` is never a tool for this identity precisely because it is externally visible — *"the
planner PROPOSES it and code performs it after the loop, through applyDecision"*
(`identity.ts:22-24`).

### The gap-less decision slot build 6.5 just built

`PlannerDecision.nudgeId` is `string | null` (`planner.ts:182`). The DB CHECK that required a
subject was **dropped with no replacement** (`20260903120000_decisions_without_a_gap.sql:31-38`):

> *"NO REPLACEMENT CHECK. […] there is now no invariant left for the database to hold, because
> 'both null' is a legal, meaningful row."*

Two columns were added there for the message case: `to_ref`, `via`. The gap-less branch in
`validateDecisions` (`planner.ts:1915-1998`) **refuses any action but `send`**:

```ts
if (action !== 'send') {
  push(`${action} with no gap — copy the id of the gap it acts on from the list you were
        given. Only a message may be about nothing.`);
  continue;
}
```

So the row shape for a subject-less decision exists and is proven, but the vocabulary admits
exactly one verb into it.

### What breaks when a kind has no `NudgeKindSpec`

**Build 5 made the PLANNER spec-less; the SWEEP is still spec-gated.** Both halves verified:

- **Planner: no registry filter at all.** `planner.ts:3315-3318`:
  *"NO registry filter any more (build 5, rider 6): the planner sees every open gap of any kind — a
  kind with no NudgeKindSpec was invisible even to the component that would decide about it,
  exactly the constraint §6a entry 4 records against this build."*
- **Sweep: creation is registry-gated.** `watchers.ts:574-578`, then `specFor('overdue_visit_gap')`
  at 579 and `specFor('job_cost_gap')` at 634. The stated reason is the item sweep: *"an
  unregistered kind's manager items could never self-clean (the item sweep iterates the registry),
  which is the one sweep judgment left for a spec to carry."* Since nothing writes gap review items
  any more (Area 1), that reason no longer has a live referent.

**Every reader of `NUDGE_KIND_SPECS` / `specFor` in production — the complete list:**

| Reader | File:line |
|---|---|
| the sweep's spec list | `watchers.ts:24, 286` |
| detector #1's creation gate | `watchers.ts:579` |
| detector #2's creation gate | `watchers.ts:634` |
| *(tests only)* | `watchers.test.ts:26` |

**That is all.** The planner does not import it. The eval does not import it (`plannerSim.ts:115`
declares its own `SimNudgeKind` union of the same two literals, independently). The gap view does
not label kinds from it — `buildGapView` prints `kind: ${n.kind}` raw (`planner.ts:1266`), and the
one kind-specific line is a hardcoded `n.kind === 'job_cost_gap'` test at `planner.ts:1328`.

**So a planner-opened observation with an unregistered kind would today:** be created (if the
creation path did not go through the sweep's gate), be read by the planner, render in the gap view
with its raw kind string, get no `THE RECORD` line, get no moot fact, and be invisible to the item
sweep — which no longer matters. `planner.ts:1232` (`recordFilled`) and `planner.ts:3445`
(the batched cost-events read) both key on the literal `'job_cost_gap'`, not on a spec.

---

## Area 4 — The subject decision (the build-8 seam)

### `subject_ref` semantics today

| kind | subject_ref is | Set at |
|---|---|---|
| `overdue_visit_gap` | the **assignment** id (`g.id`) | `watchers.ts:597` |
| `job_cost_gap` | the **job** id (`c.jobId`) | `watchers.ts:668` |

The cost kind's exception is called out in three places: `observations.sql:41-43`,
`watchers.ts:665-667` (*"the only kind whose subject is not a visit. uq_observations_subject_ever
therefore notices once per job FOREVER (the accepted limitation moved store)"*), and
`nudgeKinds.ts:101` (`subjectIsVisit: false`).

The unique index is `unique (tenant_id, kind, subject_ref)` — `observations.sql:72-73`. Its twin on
`nudges` is `uq_nudges_subject_ever`, same shape (`20260817090000_nudges.sql:56`).

### `listOverdueConfirmedAssignments` — the shape, and the absence

```ts
// src/db/assignments.ts:550-566
export async function listOverdueConfirmedAssignments(
  tenantId: string,
  endedFromNaive: string,   // firm wall-clock as if UTC, inclusive
  endedToNaive: string,     // exclusive
): Promise<PlacedAssignment[]> {
  ... .from('assignments').select()
      .eq('tenant_id', tenantId).eq('status', 'confirmed')
      .gte('ends_at', endedFromNaive).lt('ends_at', endedToNaive)
      .order('ends_at', { ascending: true });
}
```

Raw assignment ROWS. **No grouping, no DISTINCT, no same-visit collapse.** One row per
(job, technician, slot). The `assignments` table has one technician per row
(`20260704210155_scheduling_foundation.sql:59`, `technician_id uuid not null`), so a two-person
visit is two rows, two `g.id` values, two `subject_ref`s, two observations.

### Is there an id that names a visit across its rows?

**No.** The `assignments` table as created (`20260704210155_scheduling_foundation.sql:55-73`)
carries `id, tenant_id, job_id, technician_id, starts_at, ends_at, status, reason,
source_capture_id, created_at, updated_at`. The only later `alter table assignments add` statements
are `promised_day_when_promised` (`20260723090001`), `earliest_date` / `latest_date` and the
placed-or-windowed check (`20260724130000`), and a re-added `no_confirmed_overlap` exclusion. There
is no `visit_group_id`, no `crew_id`, no shared token of any kind.

The two options §6a already names remain the only two the schema admits:
- **a `visit_group_id` column on `assignments`**, written at booking time; or
- **a derived key** (`job_id` + the time window), computed wherever a subject is minted.

### Every reader of `subject_ref` today

| Reader | Purpose |
|---|---|
| `observations.ts:85` `listObservedSubjectRefs` | the live dedup store |
| `nudges.ts:135` `listNudgedSubjectRefs` | pre-split dedup |
| `reviewItems.ts:153` `listEverFlaggedSubjectRefs` | pre-split dedup |
| `reviewItems.ts:124, 133, 172…` | the review-item upserts and finders |
| `watchers.ts:527-531` `statusSubjects` | routes visit-scoped subjects into the assignment status read (via `spec.subjectIsVisit`) |
| `nudgeKinds.ts:85` `OVERDUE_VISIT_GAP_SPEC.itemResolved` | `f.visitStatusById.get(item.subjectRef)` |
| `planner.ts` moot-fact read | `listAssignmentsByIds(tenantId, <every open gap's subject_ref>)` — see `assignments.ts:287-290` |
| `v_nudges` | `20260823120000_planner_read_surface.sql:82` |
| `v_review_items` | `20260823120000_planner_read_surface.sql:110` |
| `v_observations` | `20260901130000_observations.sql:95` |
| `plannerSim.ts:255` | pins the seeded subject by kind so the live detectors recognise it |
| unique indexes | `uq_observations_subject_ever`, `uq_nudges_subject_ever`, `uq_review_items_open`, plus two any-status item indexes (`20260817090000_nudges.sql:77`, `20260819130000_job_cost_gap_backstop.sql:15`) |

**Not read by:** `mv_gap_outcomes`, `mv_escalation_fates`, `mv_whiplash` — none of the three metric
views select `subject_ref`. The alarm pass does not read it either.

### The one thing that already behaves as if a crew were one visit

The freshness test is **job-scoped**: `hasActivitySince(jobId, startsAtIso)`
(`watchers.ts:453-455`). So if either person on a two-person visit files a note before the tick,
**neither** gap is minted. §6a entry 8 records the user's ruling that a crew has no lead and notes
this behaviour "RATIFIES the existing accident rather than asking for new machinery."

What is still missing, factually, is any statement that the two rows were the **same visit** — a
plumber and an electrician at one address on unrelated jobs render identically to a two-person
crew today.

---

## Area 5 — What the planner sees, and whether the read is bounded

### The read path

```
runPlanner (per tenant)
   listNudges(tenantId, OPEN_NUDGE_STATUSES)        planner.ts:3280   ['pending','queued','asked']
   listObservations(tenantId, ['open'])             planner.ts:3281
   listOffice(tenantId,'to_planner',['unread'])     planner.ts:3289
        │
        ├─ stageById: observations first, then nudges (nudge wins a collision)   3305-3306
        ├─ open = [...openNudges, ...openObs.filter(not a nudge id).map(observationAsGapRow)]
        │         .sort(oldest first)                                            3319-3322
        │
        ├─ if (open.length === 0 && unreadMessages.length === 0) → SKIP          3327-3331
        │
        └─ views: Map<string, GapView>  → buildPlannerUserMessage
                                            views.map(v => v.block).join('\n\n')  2721
```

- `OPEN_NUDGE_STATUSES = ['pending','queued','asked']` (`nudges.ts:34`). `'dismissed'` is
  deliberately absent.
- Observations are read with `['open']` only, so dismissed ones are invisible until `recover`.

**FINDING — the two gap reads are bounded differently, and only one of them knows it.**

| Reader | Pages? | Behaviour past 1000 rows |
|---|---|---|
| `listObservationsByStatus` (`observations.ts:59-78`) | **yes**, `PAGE = 1000`, ordered `noticed_at, id` | returns everything |
| `listNudgesByStatus` (`nudges.ts:114-128`) | **no** — a single `.select()` with `.order('created_at')`, no `.range()` | **silently truncated at PostgREST's default cap** |

The observations reader's own header says why it pages (`observations.ts:52-56`): *"the open set is
unbounded BY DESIGN (the record grows; the planner curates), so an unpaged read would silently show
the planner only the oldest 1000 and hide every newer observation with no error anywhere."* That
argument applies verbatim to the open-nudge set, which is equally unbounded now that build 5
deleted every clock that closed a gap — and `listNudgesByStatus` is the reader for **both** the
planner's gap read (`planner.ts:3280`) and the sweep's alarm pass (`watchers.ts:704`).

This is stated as an observed asymmetry, not as a defect claim: whether a firm can reach 1000 open
questions is exactly the kind of number [[never-size-from-the-pilot-box]] forbids estimating from
accumulated state. What is certain is the *shape* — one of the two readers fails loudly at scale
and the other fails silently.

### How an observation renders differently from a nudge

`observationAsGapRow` (`planner.ts:1504-1526`) wears the observation as a `Nudge` with
`status: 'noticed'` — *"deliberately NOT a nudges status: no row in `nudges` ever carries it, and
every rail keys on it to tell the two stages apart"*. `created_at` maps from `noticed_at`.
`attempts`, `serve_count` are hardcoded 0.

| Line in the gap block | On a `noticed` observation | On a nudge |
|---|---|---|
| `state:` | `noticed` | `pending` / `queued` / `asked` |
| `asked:` | **omitted entirely** (`planner.ts:1310-1312`: *"'noticed' gets NO asked line at all […] 'not yet' frames absence-of-ask as the gap's defining property, which is the exact framing this build removes"*) | `Nh ago, answered` / `no answer linked yet`, or `not yet` |
| `the question asked:` | absent (`question` is null) | present when written |
| `DELIVERY:` | never (queued-only, `planner.ts:1348`) | on `queued` rows |
| `THE RECORD:` | same rules as any stage (build 6 Phase 3 un-forked it) | same |
| evidence, money, history, job note, dates | identical | identical |

### Is the read bounded? — the constants, as rules

| What | Bound | Where |
|---|---|---|
| Open observations reaching the prompt | **NONE** | `planner.ts:2721` renders every view |
| Open nudges reaching the prompt | **NONE** | same |
| Unread office messages | `OFFICE_MESSAGES_SHOWN = 30`, oldest-first, remainder counted in the header | `planner.ts:2557` |
| Answered desk pairs | `DESK_PAIRS_SHOWN = 5` | `planner.ts:2549` |
| Outbound messages the planner sent | `OUTBOUND_SHOWN = 12` within `OUTBOUND_WINDOW_MS = 14 days` | `planner.ts:174-175` |
| Evidence lines per gap | `EVIDENCE_PER_GAP = 6`, each `EVIDENCE_TEXT_CHARS = 600` | `planner.ts:466-469` |
| Money rows per gap | `EVIDENCE_PER_GAP` | `planner.ts:1255` |
| Tick-mark filler per gap | `UNMENTIONED_CAP = 200` (a cap on the decision LOG, not the view) | `planner.ts:166` |
| The whole planning conversation | `MAX_TOOL_LOOP_BUDGET_MS = 900_000`, no turn ceiling | build 1b |

**So the gap list is the one unbounded surface in the prompt, by design.** Every other block that
could grow has a shown-count; the gaps do not. `observations.ts:52-56` states the design intent
(*"the open set is unbounded BY DESIGN (the record grows; the planner curates)"*) and pages the
read specifically so the unboundedness is honest rather than silently truncated at 1000.

The prompt-size consequence is therefore governed by exactly two things: the per-gap block size
(bounded by the constants above) and the number of open gaps (unbounded, drained only by the
planner's `close` and `dismiss`). Per [[never-size-from-the-pilot-box]] no figure is derived here
from the pilot's or the local stack's accumulated rows; the shape is: **one firm's prompt grows
linearly in gaps the planner has not ended, and the only thing that ends a gap is the planner.**

---

## Area 6 — `review_items` in full

### The 22 kinds, their writers and readers

| # | kind | Production writer | Notes |
|---|---|---|---|
| 1 | `sheet_ref_mismatch` | **NONE** | Dead kind. Only `server.test.ts:1005` and `technicians.test.ts:302,308` reference it, plus a comment in the 2026-07-02 migration. |
| 2 | `unknown_ref_capture` | `src/inbound/webhook.ts:141` via `flagUnknownRefCapture` | once per source message (`detail.externalId` dedup) |
| 3 | `pairing_verification` | `src/composio/pairing.ts:215` | resolved/dismissed acts on state first (`server.ts:7900`) |
| 4 | `pending_deactivation` | `server.ts:5387, 5401` | staged token |
| 5 | `pending_outbound_send` | `server.ts:3568` | staged token |
| 6 | `pending_field_note` | `server.ts:2734` | staged token |
| 7 | `pending_retraction` | `server.ts:3712` | staged token |
| 8 | `pending_standing_fact` | `server.ts:3936` | staged token |
| 9 | `offboarding_reminder` | `src/composio/offboarding.ts:88` via `flagOffboardingReminder` | reminder |
| 10 | `pending_booking` | `server.ts:4639` | staged token |
| 11 | `pending_visit_move` | `server.ts:4873` | staged token |
| 12 | `pending_visit_cancel` | `server.ts:5031` | staged token |
| 13 | `pending_job_cancel` | `server.ts:5127` | staged token |
| 14 | `pending_seat_add` | `server.ts:5260` | staged token |
| 15 | `pending_freeze` | `server.ts:6641` | staged token, one per TENANT |
| 16 | `pending_resolve` | `server.ts:6859` | staged token, one per TENANT |
| 17 | `pending_undo` | `server.ts:7078` | staged token, 15-min TTL |
| 18 | `availability_setup` | `server.ts:5338` | reminder; auto-resolved by `set_availability` (`server.ts:5802-5809`) |
| 19 | `unlinked_call` | `src/calls/worker.ts:160` | dead-end |
| 20 | `call_action` | `src/calls/worker.ts:186` | dead-end |
| 21 | `overdue_visit_gap` | **NONE since build 6 Phase 1** | gap kind |
| 22 | `job_cost_gap` | **NONE since build 6 Phase 1** | gap kind |

### **CORRECTION — "the 15 staged tokens" is 13**

§6a entry 6.5 says *"the 15 staged tokens + `pairing_verification` are the real job and stay."*
Counted from the code, the staged tokens — the kinds `resolve_review` refuses to mark `resolved`
because they commit through their own tool — are **13**:

- **5 as individual `if` blocks** (`server.ts:7832-7869`): `pending_deactivation`,
  `pending_outbound_send`, `pending_field_note`, `pending_retraction`, `pending_standing_fact`.
- **8 in `STAGED_ACTION_KINDS`** (`server.ts:7875-7886`): `pending_booking` → `book_visit`,
  `pending_visit_move` → `move_visit`, `pending_visit_cancel` → `unschedule_visit`,
  `pending_job_cancel` → `cancel_job`, `pending_seat_add` → `add_technician_seat`,
  `pending_freeze` → `run_freeze`, `pending_resolve` → `run_resolve`, `pending_undo` → `undo_run`.

13 staged + `pairing_verification` + 4 dead-end (`sheet_ref_mismatch`, `unknown_ref_capture`,
`unlinked_call`, `call_action`) + 2 reminders (`offboarding_reminder`, `availability_setup`) +
2 gap kinds = **22**, which matches the union exactly. The rest of §6a's breakdown is correct.

### **CORRECTION — the 4 dead-end kinds do not leave "when detectors stop minting"**

§6a entry 6.5 predicts *"its 4 dead-end kinds and 2 reminders leave in build 7 when detectors stop
minting."* Factually, **none of the six is written by the detector sweep.** Their writers are:

```
unknown_ref_capture   ← src/inbound/webhook.ts       (an email from an unrecognised sender)
unlinked_call         ← src/calls/worker.ts:160      (a phone call matching no customer)
call_action           ← src/calls/worker.ts:186      (a call needing a human to act)
sheet_ref_mismatch    ← nothing at all
offboarding_reminder  ← src/composio/offboarding.ts  (a 15-min cron, grace period ending)
availability_setup    ← src/mcp/server.ts:5338       (a seat confirmed, no pattern set)
```

The inbound webhook and the calls worker are not the detector sweep and are not in build 7's
charter. Whether these leave is a separate product question — *"should an unmatched phone call
become an observation the planner curates, or stay a manager queue item?"* — and answering it
would enlarge the build beyond "the detectors report."

### **CONFIRMED — after removing detector-minted kinds, `resolve_review` could resolve nothing**

§6.5's prediction holds, with one qualification. If build 7 removed kinds 19-22 (and 1, which is
already dead) and the 2 reminders, what remains is 13 staged tokens + `pairing_verification`.

- All 13 staged tokens **refuse** `resolution === 'resolved'` (`server.ts:7832-7891`). They accept
  only `dismissed` (= cancel).
- `pairing_verification` **does** accept both, and acts on state before closing (`server.ts:7900`).

So `resolve_review`'s `resolved` branch would serve exactly one kind, and
`list_pending_reviews` would list "what is staged" plus pending pairings. §6a's proposed renaming
("show me what is staged" / "cancel it") is consistent with the code.

**What a rename would touch:** `resolve_review`'s tool schema (`server.ts:1273`) and handler
(`server.ts:7820`); `list_pending_reviews`'s schema (`server.ts:925`) and handler
(`server.ts:7758`); the description at `server.ts:950` and the note at `server.ts:5631` and
`server.ts:7035`; the tool-surface counts in `src/eval/toolCases.ts`; and the planner doctrine's
`v_review_items` paragraph (`plannerPrompt.ts:318-327`). **Not** the box-side `AGENTS.md`: a grep
of `Box_Setup_Stuff/bootstrap-box.sh` for `observ|detector|noticed|gap` returns only one unrelated
prose line (`:793`) and one comment. The box doctrine names the three office tools
(`inform_team_lead`, `ask_team_lead`, `inform_teammate`), never the planner's verbs, never the
review kinds.

---

## Area 7 — Enum / pin sites and eval couplings

### The three pinned equalities, as they stand

```
PLANNER_ACTIONS           planner.ts:144   ['send','hold','close','dismiss','recover']
submit_plan enum          plannerPrompt.ts:370  ['send','hold','close','dismiss','recover']
PLANNER_JUDGMENT_ACTIONS  watchers.ts:142  {'send','hold','close','dismiss','recover'}
```

`watchers.ts:135-137` states the maintenance rule: *"Adding a new planner action means adding it
HERE too. Exported so a test pins exactly that."*

### `attentionActions` — the historic superset

`watchers.ts:809-822`: `PLANNER_JUDGMENT_ACTIONS ∪ {extend, escalate, leave, ask_agent,
inform_agent}`. The comment is explicit that *"the list only grows"* — a deleted verb must not turn
last week's judgments into this week's neglect. `leaveCounts` further governs whether a historic
`leave` counts (false for observations, true for asks).

### `nudge_decisions_action_check` — the DB superset, now on its **fifth** amendment

| Migration | Added |
|---|---|
| `20260821180000_nudge_decisions_extend.sql:19` | (1st) |
| `20260822140000_nudge_decisions_leave.sql:33` | `leave` (2nd) |
| `20260901130000_observations.sql:135` | `dismiss`, `recover` (3rd) |
| `20260901160000_office_verbs.sql:16` | `ask_agent`, `inform_agent` (4th — the file's own header says "FOURTH") |

Current value (`20260901160000_office_verbs.sql:16-18`):

```sql
check (action in ('send','hold','close','escalate','extend','leave','unmentioned',
                  'dismiss','recover','ask_agent','inform_agent'))
```

It is a **superset** of the live vocabulary by design, so removing a verb needs no migration and
adding one does. Build 6.5's own migration
(`20260903120000_decisions_without_a_gap.sql`) dropped `nudge_decisions_subject_check` and added
`to_ref` / `via` without touching the action check.

### The observations status CHECK and its OPEN set

`observations.sql:52-53`: `check (status in ('open','dismissed','asked'))`. The compile-time twin
is `ObservationStatus` (`observations.ts:19`). The planner reads `['open']` only
(`planner.ts:3281`); the alarm pass reads `['open']` too (`watchers.ts:705`).

### `applyDecision`'s exhaustiveness

`planner.ts:2765-2775` holds the belt for the nullable id:

```ts
if (d.action !== 'send' && !d.nudgeId) {
  return { outcome: 'refused', detail: '…' };
}
const gapId = d.nudgeId ?? '';   // Empty only on a gap-less send, which never reads it
```

The switch then forks on stage inside `hold` (`planner.ts:2973`), `dismiss` (`planner.ts:2995`)
and `recover` (`planner.ts:3006-3055`), using `getGap(gapId)?.status === 'noticed'` for the first
two and try-the-observation-write-then-fall-through for the third (a dismissed gap is invisible to
`getGap` by definition).

### The eval couplings

**Scenario kinds.** `plannerSim.ts:115` declares its own `SimNudgeKind = 'overdue_visit_gap' |
'job_cost_gap'` — independent of `NUDGE_KIND_SPECS`. `seedScenario` pins `subject_ref` by kind
(`plannerSim.ts:255`): assignment id for a visit gap, job id for a cost gap, *"so the live
detectors' once-ever dedup recognises the seeded gap as already surfaced instead of minting a
duplicate every tick"* (`plannerSim.ts:200-205`).

**A `pending` spec seeds an OBSERVATION, not a nudge** (`plannerSim.ts:272-278`), and the seeder
throws loudly if such a spec carries delivery ledgers, `priorStatus`, `askedAt` or `escalateAfter`
— an authoring-error posture, not a silent drop.

**Timeline steps that move the world:** `tick` (runs sweep **and** planner), `capture`,
`office_inform`, `office_sent` (build 6.5), `money`, `deliver`, `manager_resolve`
(`plannerCorpus.ts:74-116`). **There is no `observe` step.** A new observation can only appear
mid-arc if the live sweep detects one during a `tick`.

**`manager_resolve` grades nothing.** `plannerCorpus.ts:67-73`: *"the deterministic graders are
pure over the results row and never read review_items […] so a resolve and a dismiss currently
grade identically. The step still changes the world; it is the OBSERVATION that is missing."*

**Corpus size and families** — 68 scenarios: `context-miss` 10, `false-claims` 10, `multi-gap` 9,
`late-stuck` 8, `people-judgment` 8, `premature` 8, `day-edges` 6, `build6` 4, `smoke` 3,
`build65` 2.

**The standing eval damage inventory** (`plannerCorpus.ts:23-54`, unchanged by 6.5): 24 orphaned
action expectations (10 `action:'escalate'`, 14 `actionNot:'escalate'`) plus 24 claim clauses
weakened because `handoff_note` is never written and the graders build their haystack from
`[handoff_note, reason]`. The header is explicit that re-deciding them belongs to the evaluation
phase, *"which is an END phase (user ruling 2026-08-29), after build 7."*

**`seedScenario`'s one-person limitation** (`plannerSim.ts:161`, `plannerSim.ts:222-226`):
`ScenarioWorld.technician` is a single `{ ref, name }`, and the seeded person is created with
`seatExempt: true` — *"active immediately, deliberately UNREACHABLE (no telegram/sandbox/host)"*.
There is no field for a second person, so no scenario can pose a two-person visit **or** a message
to somebody the gap does not name.

### The doctrine lines build 7 would have to rewrite

`PLANNER_SYSTEM` never says where gaps come from. The closest it gets is the `state` glossary
(`plannerPrompt.ts:123-127`):

> `'  state "noticed" — something the record noticed, and NOBODY has been asked. It is not a',`
> `'                    message and it carries no deadline: it simply stays in front of you until',`
> `'                    you decide. Every verb works here — send, hold, dismiss, and close when',`
> `'                    its THE RECORD line says the hole is already filled. Choosing `send` is',`
> `'                    what CREATES the question.',`

and the two places that name the dismissed sets as `recover`'s source
(`plannerPrompt.ts:60-63` and `plannerPrompt.ts:320-322`):

> `'  recover  — bring a dismissed one back, when stakes changed. It returns to exactly the',`
> `'             stage it was dismissed from. Find dismissed ones with spine_read: observations',`
> `'             in v_observations, questions in v_nudges where status is \'dismissed\'. Name',`
> `'             the id.',`

**"the record noticed"** is the only phrase asserting authorship, and it is passive — it would
become false the moment the planner can open one itself, and it is the line a plan must rewrite.

**Two process rails from build 6, both paid for and both applying here** (§6a entry 6): pin prompt
text with a **contiguous single-line phrase** (`PLANNER_SYSTEM` is a joined array, so a pin
spanning a line break can never match), and **read the rendered artifact**, not the edit script.

`EXPECTED_SECTIONS` (`src/eval/doctrine.ts:28-46`) covers **box-side** `AGENTS.md` sections only,
extracted from `bootstrap-box.sh`. Twelve sections, none of which names a planner verb, a gap kind
or a detector. Build 7 would not touch it unless it changes the box.

---

## Area 8 — The three recorded evaluation-phase items, checked for build-7 overlap

### `docs/observability-gaps.md` entry 2 — a planner `dismiss` drains the broken-pipe counter

**Directly a build-7 concern**, and the reason is structural rather than incidental: build 7 makes
`dismiss` the *primary curation verb*. Today `alarms.deliveryStuck` counts open `pending`/`queued`
rows past 18h (`watchers.ts:706-746`), and `'dismissed'` is absent from `OPEN_NUDGE_STATUSES`
(`nudges.ts:34`), so each dismiss removes a row from the count while the pipe stays down. The
entry's proposed fix — *"count the pipe, not the question — a deliveryStuck signal derived from
rows that FAILED TO SERVE this pull"* — is independent of build 7's own work but is made more
pressing by it.

Note the scope boundary the same document draws in its own header: *"Conditions that are somebody's
judgment to make (an unattended gap, **a stale observation**) are not malfunctions and do not
belong here."* So `observationsStale` is explicitly **out** of the observability backlog, which
means the only home for "the planner is neglecting the record" is the evaluation phase.

### `docs/observability-gaps.md` entry 1 — a FROZEN delivery tells nobody

Four freeze causes, three of them decided at serve time in `buildNudgeDelivery` and not derivable
from the row afterwards. Build 6 Phase 5 gave the planner the DELIVERY line so it can *end* such a
gap; that is not the same as telling an operator the pipe is down. **Overlap with build 7: none
directly** — it is about `nudges`, and build 7's subject is `observations`. It shares entry 2's
fix location.

### The quiet-firm tick skip — CONFIRMED, and the recover-only tick is unreachable

```
planner.ts:3327   if (open.length === 0 && unreadMessages.length === 0) {
planner.ts:3328     summary.skippedNoGaps += 1;
planner.ts:3329     name(idlePlan(tenantId, 'no_gaps', 0));
planner.ts:3330     continue;                      ← returns HERE
planner.ts:3331   }
        ⋮
planner.ts:3389   for (const id of await listDismissedIds(tenantId))   ← never reached
planner.ts:3397   for (const id of await listDismissedNudges(tenantId)) ← never reached
```

The dismissed sets are read only for a firm that is **due** and that has at least one open gap or
one unread message. A firm whose every gap the planner has dismissed can therefore never
`recover` one — there is nothing to put in the prompt and the tick returns before the recoverable
set is even read. Pre-existing, recorded in §6a entry 6, and **it becomes materially more reachable
in build 7**, because build 7's whole design encourages dismissal as the normal way to curate.

There is a second-order effect worth stating: `runPlanner` also never reaches
`buildReachableBlock`, the office block or the memory index on such a tick, so a quiet firm's
planner does no memory reconciliation either — the "RECONCILE BEFORE YOU PLAN" doctrine
(`plannerPrompt.ts:289-295`) is unreachable for a firm with nothing open.

---

## Data Flows

### The gap's whole life, as the code now has it

```
   ┌─── DETECTOR (every 5 min) ──────────────────────────────────────────┐
   │  listOverdueConfirmedAssignments  /  listCostGapCandidates          │
   │        │                                                            │
   │        ├─ hasActivitySince(job, visitStart)?  ── yes ──► not a gap  │
   │        │                                                            │
   │        └─ everSurfaced (3 stores, ANY status)? ─ yes ──► not fresh  │
   │                    │ no                                             │
   │                    ▼                                                │
   │            createObservation(kind, subject_ref, tech?, context)     │
   │            └─ 23505 → null  ("already noticed, ever")               │
   └────────────────────┬────────────────────────────────────────────────┘
                        │  observations row: status 'open'
                        ▼
   ┌─── PLANNER (every 30 min, firm hours) ──────────────────────────────┐
   │  listObservations(['open'])  +  listNudges(OPEN_NUDGE_STATUSES)     │
   │        │                                                            │
   │        ├─ observationAsGapRow → status 'noticed'                    │
   │        ├─ buildGapView per gap  (UNCAPPED)                          │
   │        └─ submit_plan → validateDecisions → applyDecision           │
   │                                                                     │
   │   send    ─► createNudgeFromObservation(SAME uuid) → nudges 'queued'│
   │              + setObservationStatus('asked')                        │
   │   hold    ─► observations.not_before   |  nudges.not_before         │
   │   dismiss ─► observations 'dismissed'  |  nudges 'dismissed'        │
   │   recover ─► try observation, else nudge (prior_status)             │
   │   close   ─► observation dismissal w/ citation | nudges 'answered'  │
   └─────────────────────────────────────────────────────────────────────┘
```

**One gap, one id, two stages** (`observations.sql:18-27`): the nudge is created with the
observation's own uuid, so `nudge_decisions` rows keyed by it span pre-ask and post-ask. The two
tables share an id space for sent gaps, deliberately, and there is **no cross-table FK**.

### Where the once-ever rules sit, together

```
observations   uq_observations_subject_ever  (tenant, kind, subject_ref)   ← the LIVE dedup
nudges         uq_nudges_subject_ever        (tenant, kind, subject_ref)   ← blocks a 2nd SEND
review_items   uq_review_items_open          (tenant, kind, subject_ref) WHERE status='open'
               + two any-status indexes (20260817090000:77, 20260819130000:15)
```

`uq_nudges_subject_ever` is what makes `createNudgeFromObservation` return `null` on a second send
(`nudges.ts:110`) — the once-ever send rail build 6.5 deliberately kept (see
[[re-ask-belongs-to-6-5]]; a re-ask is a *message* now, not a second ask).

## External Dependencies

None specific to this area. The detector sweep is pure SQL through PostgREST (supabase-js); the
planner reaches its model through OpenRouter (build 1). No third-party product decision is load-
bearing for build 7, so the "verify against live docs" rule has no target here.

## Constraints and Invariants

1. **One observations row per (tenant, kind, subject_ref), for the life of the firm.** Enforced by
   `uq_observations_subject_ever`. A recovered observation is the same row.
2. **The dedup read is any-status on purpose.** `listObservedSubjectRefs` filters no status
   (`observations.ts:85-100`).
3. **`observations.id` and `nudges.id` share an id space for sent gaps.** Same uuid = same gap at
   two stages, not a collision. No cross-table FK — the observation predates and outlives the ask.
4. **On an id collision in the planner's read, the NUDGE row wins** (`planner.ts:3307-3312`) —
   a failed asked-stamp leaves an open observation beside its own live nudge, and showing the
   ghost would invite a dismiss that orphans a live question.
5. **`kind` is a shared vocabulary across three tables** (`observations`, `nudges`,
   `review_items`) typed as one union, `ReviewKind`. The DB columns are plain `text` with no CHECK.
6. **A spec gates CREATION but nothing else.** The planner is registry-free (build 5, rider 6).
7. **Observation `not_before` is advisory.** *"nothing enforces it but the planner's next look;
   there is no compose step left to gate"* (`observations.sql:56-58`). It does silence the
   `observationsStale` alarm while it runs (`watchers.ts:787`).
8. **The alarm pass never sets `ok = false`** and lives OUTSIDE the per-tenant detection try, so a
   firm whose detection is broken still gets its neglect counted (`watchers.ts:691-695`).
9. **Naive-local vs real UTC.** `assignments.starts_at`/`ends_at` are the firm's wall clock stored
   as if UTC; `raw_captures.captured_at` and `visits.created_at` are real UTC. Every comparison
   converts the real-UTC side through `localDateISO`/`localTimeHHMM` composed via `naiveLocalISO`,
   never the reverse (`watchers.ts:70-79`). Compares are minute-floored.
10. **`observations` is RLS-enabled with no policy and explicitly revoked from anon/authenticated**,
    and so is `v_observations` — because `auto_expose_new_tables` grants the publishable keys
    SELECT on every new entity including views (`observations.sql:79-113`). A forged observation
    would put attacker-chosen "evidence" in front of the planner.
11. **`listTenantIdsWithTelegramBindings`, not all tenants**, is the sweep's and the planner's
    tenant source. Eval tenants bind no Telegram ids and are therefore excluded *incidentally, not
    by enforcement* (`watchers.ts:295-302`).

## Decision Points

**(a) Does `uq_observations_subject_ever` die, so dismissal is the only re-surfacing gate?**
Today they are two mechanisms doing two jobs (Area 2). *Keeping both* means a subject the planner
dismissed can never be re-noticed even if the world changes materially — the `moneyEvents.ts:253`
specimen is what that costs in practice. *Dropping the index* means `createObservation`'s
23505-catch has nothing to catch and the fresh filter must consult status: the detector would then
re-notice a dismissed subject and either open a second row (a new object each time the world
re-presents it) or need an explicit "is this subject dismissed" read. Both listers already exist;
`listObservedSubjectRefs` would need a status argument, and its own header argues against exactly
that change.

**(b) How is "the planner opens its own observation" expressed?** Three shapes the code admits:
- **A sixth verb in `PLANNER_ACTIONS`** — rides `submit_plan`, gets the full post-loop validation
  and the `applyDecision` guard, is recorded in `nudge_decisions` (the gap-less row shape now
  exists), and needs the three pinned equalities plus a fifth `nudge_decisions_action_check`
  amendment. It would be the first verb whose subject id the *planner* supplies rather than copies.
- **A dispatched tool** through `TEAM_LEAD_TOOL_NAMES` — the `write_memory` / `write_job_note`
  precedent, immediate effect, **no post-loop validation stage** (`identity.ts:25-30`), and the
  observation would exist before the same turn's `submit_plan` could act on it.
- **A parameter on `send`** — collapses opening and asking into one act, which is the coupling
  build 4 spent itself breaking.

**(c) What kind and subject does a planner-opened observation carry?** `kind` is a closed
TypeScript union with no DB CHECK; `subject_ref` is `not null` and is the dedup key. Options the
code admits: a reserved literal kind (one new union member, dedup then keyed on whatever string
the planner supplies), free text (widens the parameter type, and the shared vocabulary across
three tables stops being closed), or reusing a detector kind (which makes the planner's row
collide with the detector's own dedup and return `null`).

**(d) Subject = assignment row or visit (the 7 < 8 seam).** No visit-naming id exists (Area 4).
A `visit_group_id` column on `assignments` is a migration plus a write at every booking site;
a derived key (`job_id` + window) is code-only but must be computed identically everywhere a
subject is minted or looked up. Either way `uq_observations_subject_ever` collapses the duplicate
for free once the subject is visit-scoped — that is the property §6a already identified.

**(e) The 4 dead-end review kinds and the 2 reminders.** They have production writers, none of
which is the detector sweep (Area 6). Deleting them means changing the inbound webhook, the calls
worker, offboarding and seat confirmation. Converting them to observations means the planner
curates unmatched phone calls and onboarding reminders — a scope enlargement. Leaving them means
`review_items` keeps its double identity.

**(f) `OBSERVATION_STALE_HOURS`.** It fires nothing and is explicitly excluded from the
observability backlog as a judgment rather than a malfunction. Keeping it keeps one number in
code that says how patient the planner should be; deleting it removes the only instrument that
counts planner neglect of the record; handing it to the planner means it stops being an
independent measurement of the planner (the same argument that put the alarm pass in the sweep
rather than in the planner in the first place — `watchers.ts:115-117`).

**(g) Does the observation read stay unbounded?** It is the only unbounded block in the prompt
(Area 5), and that is stated as design intent in the reader itself. The bound that exists is
indirect: the planner's own `close`/`dismiss` drain the set, and the tool loop's 900s budget is
what fails when a prompt outgrows the model. Adding a shown-count would reintroduce the silent
drop build 4 deleted; leaving it means prompt size is governed by planner behaviour.

**(h) Is `review_items` renamed in this build or after it?** §6a says "cleanup after build 7, not
before," and the code agrees that the rename cannot be *correct* until the detector-minted kinds
stop existing — but Area 6 shows those kinds already have no writer, so the precondition is
arguably met today for kinds 21-22 and never will be for 19-20 unless (e) is answered first.

## Open Questions

1. **Is the last pre-build-6 gap review item closed on the pilot?** The item auto-resolve loop's
   input set can only shrink (Area 1). Whether it is already empty is a DB read against the pilot,
   not a code question — and the pilot is read-only.
2. **Does any pilot firm have a dismissed observation whose subject a detector has since
   re-presented?** That is the case (a) turns on, and it is observable only against live data.
3. **What does the planner currently do with a `noticed` gap it has seen for weeks?** The corpus
   has no long-arc observation scenario (`MAX_ARC_TICKS = 12`), and `observationsStale` is counted
   but never attributed by firm in any stored artifact. Evaluation-phase material.
4. **Would a planner-opened observation need to be distinguishable from a detector-opened one in
   the record?** Nothing in the schema carries an author today — `actor_ref` exists on `nudges`
   (hardcoded `'spine:team-lead'` in `observationAsGapRow`) but not on `observations`.
5. **Does `flagUnknownRefCapture` still fire in production?** It has a caller
   (`src/inbound/webhook.ts:141`) but the four dead-end kinds' live volume is unknown from reading
   alone, and per [[never-size-from-the-pilot-box]] it must not be estimated from the pilot's
   accumulated rows — a driven test would be the honest instrument.
