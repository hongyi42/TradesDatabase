---
date: 2026-09-02
branch: feat/the-record-has-authors
commit: 06ed9e1
topic: "Build 8 — a visit is not a person: where the one-person-per-visit assumption lives"
supersedes: docs/engineering-memory.md §8 (one factual claim only — see "Correction" below)
---

> **SUPERSEDED IN PART, 2026-09-06.** Its Constraints 1 and 4 and Decisions (a) and (h) were
> overturned by `thoughts/shared/research/2026-09-06-a-visit-carries-a-crew.md` and built as rung
> 9c (`thoughts/shared/plans/2026-09-06-a-visit-carries-a-crew.md`). In short: the crew has NO
> lead — this document still assumed a primary technician — and the `no_confirmed_overlap` guard
> MOVED onto `visit_participants` rather than staying on `visits`. The survey of where the
> one-person assumption lives is still the useful half; the design conclusions are not.

**`supersedes:`** This document overturns exactly one recorded fact in `docs/engineering-memory.md`
§8 (line 4386) and in the memory file `a-visit-is-not-a-person.md`: both say the `visits` table is
**dormant** because `createVisit` has *"no production caller"*. That is wrong on this branch and was
wrong when written — see **Correction 1**. Everything else those two records state was re-verified
and stands. No research or plan document is superseded.

## Summary

A **visit** — one trip to one address at one time — is not a thing this codebase can name. What it
stores is an **assignment**: a row saying *"this person, this job, this time window."* Put two
technicians on one visit and you get two rows, and nothing anywhere says those rows are the same
trip. The user's ruling (2026-09-01) is that two technicians on one visit must count as **one**.

The storage is fine and does not need fixing. `assignments` deliberately permits two people in one
slot (`no_confirmed_overlap` is keyed on `technician_id`, so it blocks one *person* double-booked and
never two people sharing a slot — `supabase/migrations/20260724130000_unplaced_visits.sql:27-31`),
and `technician_id` has been **nullable** since 2026-07-17 (`20260717120000_technician_optional_bookings.sql:15`)
precisely so a visit can exist with nobody attached. The assumption lives in three layers above it:

```
      what is stored                what is assumed
      ──────────────                ───────────────
  assignments (job, person, window)
      │  two rows, one trip
      ├─► COUNTING    get_team_schedule counts STOPS  → "2 visits"   ✗
      │               v_schedule's catalog text: "count(*) here is real bookings"  ✗
      ├─► DETECTION   subject_ref = the ASSIGNMENT id → 2 gaps, 2 people, 1 visit  ✗
      │               …and the shared-evidence warning then tells the planner
      │               they are DIFFERENT questions                                 ✗
      └─► ASKING      technician_id is ONE column; countsAsTheAsk requires the
                      message go to the person the gap names                       ✗
```

The load-bearing discovery of this survey is that the singular `technician_id` on `nudges` /
`observations` is **not a display field** — it is the key that `countsAsTheAsk` matches against
(`planner.ts:2348`), the key attribution looks up by (`nudges.ts:622`), and the row the delivery pull
resolves a phone number from (`nudgeQueue.ts:161-201`). Nulling it to make a gap visit-scoped turns
off the ask, the attribution and the metric together. That is the real hinge of build 8, and it is
larger than the "one gap per assignment vs one gap per visit" framing §8 records.

## Corrections to the record

**Correction 1 — `visits` is NOT dormant. It is written on the main production write path.**
§8 and the memory file both say `createVisit` has no production caller and call the table *"a decoy
when reasoning about this."* On this branch `recordFieldNote` calls it unconditionally on every
successfully-matched field note (`src/writePath/recordFieldNote.ts:267`), and `recordFieldNote` is
called from all three inbound routes: the seat agent's `record_field_note` tool
(`src/mcp/server.ts:2355`), the inbound email/webhook path (`src/inbound/webhook.ts:257`) and the
phone-call worker (`src/calls/worker.ts:127`). It is also **read by the detector's own freshness
test** — `listVisitTimesForJobs` (`src/db/visits.ts:42`, its header calls itself *"the watcher's
OTHER activity home"*) feeds `latestByJob` in `watchers.ts:433-459` (the visit rows at :459), which
is what `hasActivitySince` (:465) reads. So `visits` is both written and load-bearing. What is true is the narrower claim: `visits` is
**not the schedule** — it is a per-note record of a trip that happened, and no scheduling surface
reads it. Its `technician_name` is a single TEXT column, so two crew-mates filing notes produce two
`visits` rows. The "retire it?" question in §8 is therefore a much bigger question than recorded.

**Correction 2 — reschedule is `cancel + insert`, so an assignment id is not a stable visit name.**
`rescheduleAssignment` (`src/db/assignments.ts:174-205`) cancels the old row and inserts a **new row
with a new id**; `moveVisit` (`src/schedule/booking.ts:811`) is its only real caller. Any visit
identity derived from `assignments.id` changes every time the visit moves. §8 discusses
`visit_group_id` vs a derived key without recording this, and it is decisive for both.

## Entry Points

| Where the assumption enters | File:line |
|---|---|
| The candidate read that mints gaps | `src/jobs/watchers.ts:374` → `listOverdueConfirmedAssignments` (`src/db/assignments.ts:550`) |
| The subject a gap is keyed by | `src/jobs/watchers.ts:603` (`subjectRef: g.id` — the assignment id) |
| The manager's "how many visits" answer | `src/mcp/server.ts:4450-4457` (`counts.byDay` / `counts.total`) |
| The model's SQL counting doctrine | `src/mcp/server.ts:762-765` (`v_schedule` … *"count(\*) here is real bookings"*) |
| The one-person-per-gap key | `src/teamLead/planner.ts:2348` (`gapNames`), `src/db/nudges.ts:622` |
| The booking write path | `src/schedule/booking.ts:266` (`resolveBooking`), `:528` (`bookVisit`) |
| The reserved crew identity | `office_messages.message_group_id` (`supabase/migrations/20260903130000_office_messages_via.sql:40-59`) |

## Key Files

- **`supabase/migrations/20260704210155_scheduling_foundation.sql`** — creates `assignments`. Its
  header states the design rule *"Times are IMMUTABLE per row (reschedule = cancel + insert); status
  is the only mutable business field. History = the accumulated rows."*
- **`supabase/migrations/20260717120000_technician_optional_bookings.sql`** — drops `NOT NULL` from
  `technician_id`. Its header is the closest thing in the repo to a "a visit is not a person"
  statement: *"a visit may sit on the calendar with NOBODY attached."*
- **`supabase/migrations/20260724130000_unplaced_visits.sql:27-31`** — the current
  `no_confirmed_overlap` shape.
- **`src/db/assignments.ts`** — every assignment read/write. `listOverdueConfirmedAssignments` (:550),
  `rescheduleAssignment` (:174), `listIdenticalUnassignedVisits` (:628), `listIdenticalUnplacedVisits` (:720).
- **`src/schedule/booking.ts`** — `resolveBooking` (:266), `bookVisit` (:528), `moveVisit` (:811),
  `unscheduleVisit` (:924), `liveRowsForJob` (:1351).
- **`src/jobs/watchers.ts`** — the 5-minute sweep. Visit detector at :374-468 and :583-624; cost
  detector at :637-687; `hasActivitySince` at :465.
- **`src/jobs/nudgeKinds.ts`** — `subjectIsVisit` (:61) is the only place the code says what a
  `subject_ref` names.
- **`src/db/jobs.ts:223-278`** — `listCostGapCandidates`. **Already collapses to one candidate per
  job** (:268) and picks a technician by most-recent `ends_at` (:249).
- **`src/teamLead/planner.ts`** — `personLine` (:1115), the shared-evidence warning (:1496),
  `resolveTo` (:1903), `gapNames`/`countsAsTheAsk` (:2348-2389), the group rail (:2435-2495), the
  send apply path (:3042-3081), `observe`'s `randomUUID()` subject (:3241), `mootFactFor` (:3813).
- **`src/control/nudgeQueue.ts`** — `buildNudgeDelivery` (:96). One item → one `sandboxRef` +
  one `replyTo` (:200-208); the chat leg the same (:220+).
- **`src/mcp/server.ts`** — `get_team_schedule` (:4227), `attributeAnswerToGap` (:2248),
  `openQuestionsFor` (:2299), the ADMIN gate (:2618), `SPINE_VIEW_CATALOG` (:760).
- **`src/eval/plannerSim.ts:155-198`** — `ScenarioWorld` has ONE `technician` and ONE `visit`.

## Data Flows

### One crew visit through the whole machine, today

```
 manager's agent: book_visit(jobId=J, ref=ben,  2pm-3:30pm)   ─┐
 manager's agent: book_visit(jobId=J, ref=joy,  2pm-3:30pm)   ─┘  two calls, 1.7s apart
        │                     resolveBooking checks ONLY that technician's own overlap
        ▼                     (booking.ts:400) — nothing looks at who else is on the slot
   assignments:  A1(J, ben, 2pm)      A2(J, joy, 2pm)      ← no shared id, no link
        │
        ├─► get_team_schedule  → days[].stops = [A1, A2],  counts.total = 2
        │                        countsNote: "ALWAYS use these … never count the stop rows yourself"
        │
        ▼   3h later, nobody filed a note
   watchers.ts:374  listOverdueConfirmedAssignments → [A1, A2]   (no tier filter, no collapse)
   watchers.ts:468  hasActivitySince(J, …)  ← JOB-scoped: either note silences BOTH   ✔ correct
   watchers.ts:603  createObservation × 2   subject_ref = A1.id, A2.id
                                            technician_id = ben, joy
        │
        ▼
   planner tick:  two gaps, same job
   planner.ts:3909  sharesJob = gapsPerJob(J) > 1  → TRUE
   planner.ts:1496  "this job has more than one open gap, so everything below is SHARED
                     between them. Make sure it answers THIS question, not the other one."
                                                  ↑ actively WRONG for a crew: it is one question
        │
        ├─ planner sends to ben  → nudge(A1) asked;  planner sends to joy → nudge(A2) asked
        │  planner.ts:2487 REFUSES to group them: "not the same person on the same job —
        │  one message can only be anchored to one job and delivered to one person"  ✔ correct today
        ▼
   ben files a note → attributeAnswerToGap(tenant, ben.id, J, capture)
                      nudges.ts:622 keyed (technician_id = ben, jobId = J) → stamps A1's nudge only
                      mv_gap_outcomes: A1 closed_by_technician = true, A2 = false
```

Every ✗ in this trace is a *reading* problem. No write is wrong.

### What `technician_id` is actually used for (the singular-column audit)

`observations.technician_id` and `nudges.technician_id` are both **nullable** (verified on the local
stack). Their uses, in order of how much they cost to give up:

| Read site | File:line | What it does | Cost of `null` on a visit-scoped gap |
|---|---|---|---|
| `gapNames` / `countsAsTheAsk` | `planner.ts:2348-2350` | `wouldBeTheAsk` requires `nudge.technician_id === addressee.technicianId` | **The gap can never be asked.** `countsAsTheAsk` is refused (`:2382`), so `asked_at` never sets |
| `send` apply, no `to` | `planner.ts:3045-3050` | falls back to `n.technician_id` | refused: *"send with nobody to reach — no `to`, and the record names no person"* |
| Attribution | `nudges.ts:622`, `server.ts:2260` | `(technician_id, context->>jobId, status='asked')`, stamps only on a unique match | no match → `answered_by_capture_id` never set |
| Follow-up prompt | `server.ts:2306` (`openQuestionsFor`) | same lookup | the person is never told what is still open |
| `closed_by_technician` | `mv_gap_outcomes` (`20260824020000_planner_metrics_v2.sql:37`) | `answered_by_capture_id is not null` | permanently false |
| Group-send rail | `planner.ts:2435,2487` | lead's `technician_id` is the group key | a null lead is refused at `:2441` |
| Delivery | `nudgeQueue.ts:161-208` | joins `technicians` for `sandbox_ref` + `telegram_user_id` | nothing to deliver to |
| `person:` display | `planner.ts:1115` (`personLine`) | roster lookup, falls back to `context.technicianName`, then `'unknown'` | prints `unknown` — already a reachable state |
| `idx_nudges_budget` | `(tenant_id, technician_id, created_at)` | index only | none |

Only the last two are cosmetic. The first seven are the machinery.

### The dedup stores, and what a visit-scoped `subject_ref` does to each

| Store | Shape | Effect of a visit key |
|---|---|---|
| `uq_observations_subject_ever` | UNIQUE `(tenant_id, kind, subject_ref) WHERE author='detector'` (partial since `20260904110000:81`) | **collapses the crew for free** — the second row's insert returns null and `createObservation` treats it as "noticed concurrently" (`watchers.ts:620`) |
| `listObservedSubjectRefs` | `.eq('author','detector')` + `.in('subject_ref', ids)` (`observations.ts:138-149`) | works on any key; the caller must pass visit keys, not assignment ids |
| `uq_nudges_subject_ever` | UNIQUE `(tenant_id, kind, subject_ref)` — **NOT partial** (`20260817090000_nudges.sql:56`) | one nudge per visit ever. Build 7 already documented the trap this creates (`planner.ts:3204-3223`): a second observation sharing a subject gets 23505 on the send, and the heal path then stamps it `asked` although nobody was asked |
| `uq_review_items_open` | `(tenant_id, kind, subject_ref) WHERE status='open'` | pre-split history only; nothing mints items now |
| `mootFactFor` | `planner.ts:3795,3813` — `subject_ref` filtered by `UUID_ISH_RE`, looked up in `assignments` | **a derived non-uuid key silently yields no moot fact.** The planner would never learn the visit was cancelled |
| `itemResolved` (visit spec) | `nudgeKinds.ts:87` — `visitStatusById.get(item.subjectRef)` | same |
| `watchers.ts:498` | `spec.subjectIsVisit` → `listAssignments(statusSubjects)` | same |

`nudge_decisions` is unaffected: it keys on `nudge_id` / `observation_id` (uuid FKs), never on
`subject_ref`.

## External Dependencies

None specific to this area. PostgREST (via `@supabase/supabase-js`) shapes two constraints that
recur: an `in()` containing a malformed uuid 400s the **whole** query (hence `UUID_ISH_RE` at
`planner.ts:3794`), and reads are silently capped at 1000 rows unless paged (`visits.ts:48-64`).
`btree_gist` backs `no_confirmed_overlap`.

## Constraints and Invariants

1. **Nothing names a visit.** No column, no derived key, no helper. The only near-misses are
   `listIdenticalUnassignedVisits` (`assignments.ts:628`, exact `(tenant, starts_at, ends_at)` on
   person-less rows) and `listIdenticalUnplacedVisits` (:720) — both duplicate-booking guards, both
   deliberately keyed on `technician_id` too. The comment at :715-719 records why: *"a legitimate
   second same-range visit for one customer with a DIFFERENT technician (two trades, same week)"*
   must not be refused as a twin. **That is build 8's ambiguity, already met and already decided the
   other way.** Two rows sharing a job and a window are indistinguishable from two trades at one
   address today.
2. **`assignments` is NOT L1-pinned.** Verified: `raw_captures` has FKs to `customers`, `jobs`,
   `visits` and itself — never to `assignments`; only `schedule_events` references it (`ON DELETE SET
   NULL`). So the `l1-pins-l2-undeletable` rule does **not** constrain an assignments backfill: adding
   and populating `visit_group_id` is an ordinary `UPDATE`. What *is* undeletable is `observations` /
   `nudges` history, whose `subject_ref` is plain TEXT with no FK — rows written under the old key
   keep pointing at assignment ids forever, and no cascade fixes them.
3. **Assignment times are naive-local** — the firm's wall clock stored as if UTC
   (`20260714120000:11-18`). Raw `starts_at` IS the firm wall clock; `at time zone` on it yields a
   wrong answer. A derived visit key must therefore use the raw column. Note `v_schedule.local_day`
   does apply `at time zone tn.timezone` (`20260806120000:82`) — a pre-existing recorded trap, not
   build 8's, but it rules that view out as a source for a derived key.
4. **A visit id is not stable across a move** — see Correction 2.
5. **The freshness test is JOB-scoped and already correct under no-lead.**
   `hasActivitySince(job_id, starts_at)` (`watchers.ts:465`) draws from both activity homes —
   `listJobStampedCaptureTimes` and `listVisitTimesForJobs` — so **either** crew-mate's note
   suppresses **both** gaps before they are minted. This is the "accidental crew handling" §8 records
   and it needs no new machinery.
6. **`cancel_job` already handles a crew correctly.** `liveRowsForJob` (`booking.ts:1351`) cancels
   *every* live row for the job, so cancelling the work cancels both people's rows.
7. **`move_visit` and `unschedule_visit` do not.** Both take ONE `assignmentId`
   (`server.ts:1106,1136`) and touch one row. Moving a crew visit moves one person and silently leaves
   the other at the old time. **Nothing detects or prevents this** — there is no cross-row check
   anywhere in `resolveMove`, and the confirmation says nothing about who else was on the slot.
8. **Booking says nothing about who else is there.** `resolveBooking`'s only person-check is that
   technician's own overlap (`booking.ts:400`). `BookVisitResult` (`booking.ts:521`) carries
   `assignment | job | customer | warning?` — no crew field. And `get_schedule`, the technician's own
   route view (`src/routes/daySource.ts:40-90`), lists customer + address + time only, so **a
   technician has no way to learn a colleague is coming to the same visit.**
9. **The cost detector already collapses per job — with an undefined tie-break.**
   `listCostGapCandidates` (`jobs.ts:257-270`) keeps the FIRST row per job after ordering by `ends_at`
   descending, *"the technician who was there last is the one who knows what the job ended up
   costing."* For a crew both rows share `ends_at` exactly, so the sort is a tie and **which of the
   two people the cost gap names is nondeterministic.** This is a live precedent for "collapse and
   pick a person", and its tie-break was never specified for equal ends.
10. **`book_visit`, `move_visit`, `unschedule_visit` are all `ADMIN_TOOLS`** (the array spans
    `server.ts:866-1785`), gated at tools/list (`MANAGER_TOOLS`, :2012) **and** at dispatch
    (`ADMIN_TOOL_NAMES.has(name) && !activeManager`, :2618). Re-confirmed on this branch. Tier gates
    who may CALL, never who may be BOOKED.
11. **`office_messages.message_group_id` exists, is nullable, has no FK and no index, and nothing
    reads or writes it** (`20260903130000:53`; `officeMessages.ts:47-50` deliberately keeps it off
    the input type). Its migration comment names build 8 explicitly.
12. **One message row reaches one chat.** Both delivery legs resolve `sandbox_ref` +
    `telegram_user_id` from a single joined `technicians` row (`nudgeQueue.ts:161,200-208` and the
    chat leg at :220+). `nudges.ask_group_id` expresses *several gaps → one person*; there is no
    analogue for *one message → several people*.
13. **The eval world cannot express a crew.** `ScenarioWorld` (`plannerSim.ts:155-186`) has
    `technician: {ref, name}` and `visit?: {...}` — both singular — and `SeededScenario` returns one
    `technicianId` and one `assignmentId`. `subject_ref` is pinned by kind at :255. This is the same
    wall build 6.5 hit with `B65-REACH-A-MANAGER`. `FAMILY_COUNTS` (`plannerCorpus.ts:1392`) is a
    hard-coded pin that any new scenario must update.
14. **The counting claim is doctrine, not just code.** `SPINE_VIEW_CATALOG`
    (`server.ts:762-765`) tells the model of `v_schedule`: *"the schedule that STANDS: confirmed and
    completed visits only, so **count(\*) here is real bookings**"*, and `query_spine`'s worked
    example (:1349) is literally `select technician_name, count(*) as visits from v_schedule … group
    by 1`. `get_team_schedule`'s `countsNote` (:4469) says *"ALWAYS use these … never count the stop
    rows yourself."* The seat doctrine says the same thing from the other side — its worked
    per-day example is *"Wed YYYY-MM-DD — 16 visits"* (`Box_Setup_Stuff/bootstrap-box.sh:876`), with
    two further clauses (:890, :892) governing how such a count is labelled and what it misses.
    Fixing the query without fixing this prose leaves both agents instructed to believe the old
    answer.

### Counting surfaces, classified

| Surface | File:line | Returns | Per-person by design? |
|---|---|---|---|
| `get_team_schedule` `counts.byDay` / `.total` | `server.ts:4450-4457` | a **COUNT** | **No** — a team view. Double-counts a crew |
| `get_team_schedule` `days[].stops` | `server.ts:4348` | rows | one stop per person; the crew reads as two stops |
| `v_schedule` + catalog prose | `20260806120000:80`, `server.ts:762,1349` | rows, with a `count(*)` instruction | **No** — the instruction is the defect |
| `get_schedule` / `listDayStops` | `routes/daySource.ts:40` | rows | **Yes** — a person's own route |
| Board day grid | `schedule/boardRead.ts:157` | rows | mixed; caller counts, no total emitted |
| `get_customer_context.upcomingVisits` | `db/context.ts:103-130` | rows | **No** — a crew visit is listed twice to the customer brief |
| `find_slots` / freeze solver | `schedule/fit.ts:372,462` | rows | **Yes** — occupancy is per technician |
| `mv_gap_outcomes`, `mv_whiplash` | `20260824020000:21,75` | one row per **nudge** | **No** — a crew visit contributes two rows to every gap metric |

## Decision Points

**(a) What names a visit — a derived key or a `visit_group_id` column.**
*Derived* = `job_id` + the raw `starts_at` (and `ends_at`), composed into a string. Costs no
migration and no backfill, is correct retroactively for every row that already exists, and survives a
crew booked by two independent `book_visit` calls with no coordination. It breaks three things that
assume `subject_ref` is a uuid naming an assignment: `mootFactFor` (`planner.ts:3795` filters by
`UUID_ISH_RE` and would silently drop it), `nudgeKinds.ts:87`, and `watchers.ts:498`. It also has no
answer for "the same visit after it moved" — a move writes a new row at a new time, so the key
changes by construction.
*Column* = `visit_group_id uuid` on `assignments`, written at booking. No L1 obstruction (Constraint
2), so the backfill is a plain UPDATE — but the backfill has to *guess*, since two rows sharing a job
and a window are exactly the case `listIdenticalUnplacedVisits`'s comment (:715) says may legitimately
be two different trades. And *who writes it* is unanswered: `book_visit` takes one person and mints
one row, so a second call has to find and join the first — which is the same guess, made at write
time instead of backfill time. `moveVisit` would have to carry the group across the cancel+insert.

**(b) What `technician_id` holds on a visit-scoped gap.**
Both columns are already nullable, so *null* costs no migration — but it costs the seven machinery
reads in the singular-column audit above, headed by `countsAsTheAsk`. *One of the two people* keeps
every mechanism working and contradicts the no-lead ruling in the record even if not in the UI (and
the cost detector already does exactly this, nondeterministically — Constraint 9). *A join table*
(`gap_participants`) keeps both truths but is a new table, a new write path, and touches every reader
in the audit.

**(c) Does the gap become visit-scoped at all, or do only counting and asking collapse?**
The narrow option: leave detection per-assignment (two rows, two subjects, every mechanism intact)
and fix only `counts.total`, the catalog prose, and the shared-evidence warning — plus teach the
planner that two gaps can be one visit. Nothing in the schema changes and `technician_id` stays
meaningful on every row. What it does not fix: the planner is still shown two gaps and can still text
two people about one visit, and every gap metric still counts a crew visit twice. The wide option
(one gap per visit) fixes those and pays (b) in full.

**(d) Counting — fix at the query or at the caller.**
`get_team_schedule` computes `counts` in the handler from rows it already has (`server.ts:4450`), so a
collapse could be a few lines there — but `days[].stops` would still list two stops, and the two would
disagree unless the stop list gains a crew shape. `v_schedule` is a different surface entirely: the
model writes its own SQL against it, so the only levers are the view's columns and the catalog prose
(:762). Whichever is chosen, Constraint 14 means the prose must change with it.

**(e) One message to N people — N rows sharing `message_group_id`, or one row with N addressees.**
`message_group_id` exists and is unused, and the delivery legs are built for one row → one chat
(Constraint 12), so N rows is the shape the pull already serves — it needs a group-aware read so the
same text is not composed twice, and a decision about whether one reply threads to all N.
One row with N addressees would need `technician_id` to become a list, which breaks the
`office_messages_addressee_check` CHECK and the `technicians` join in both delivery legs.

**(f) A booking verb that takes several people, vs N calls plus a crew statement.**
N calls is what works today and is how the pilot specimen was created. A crew statement in the
confirmation (*"Joy is already on this slot"*) requires only a read inside `resolveBooking` — nothing
structural — and is the cheapest thing that makes a crew visible to the manager. A verb taking
`refs: string[]` would mint N rows atomically and is the natural writer for a `visit_group_id`, but
`bookVisit` currently returns one `assignment` and every caller and confirmation path assumes that.

**(g) Reschedule / cancel divergence — prevent, detect, or accept.**
Today: accepted silently and invisibly (Constraint 7). *Prevent* = `moveVisit` moves every row in the
group, which presupposes (a) and changes the meaning of a verb managers already use. *Detect* = a
detector that flags rows that used to share a window and no longer do — which is build 9's shape, not
build 8's, and needs (a) to know what "used to share" means. *Accept* = say so in the confirmation
(*"Ben has been moved; Joy is still at 2pm"*), which needs only a read.

**(h) Retire the dormant `visits` table, or leave it.** **This decision is void as recorded** — the
table is not dormant (Correction 1). The real question is narrower and new: `visits.technician_name`
is one TEXT column per note, so a crew that both file notes produces two `visits` rows for one trip.
Whether that matters depends on who reads it: `mv_whiplash`'s "new information arrived" test
(`20260824020000:105-115`), `hasActivitySince`, the customer brief's `recentVisits`
(`db/context.ts:87`), the retraction fold (`db/foldImpact.ts:70`) and `v_visits` via `query_spine`.
All of them are job-scoped or per-note, so all of them are arguably *already right*.

**(i) Backfill.** Nothing is deployed (harness-rebuild rule) and the pilot DB runs pre-build-4 code,
so no observation or nudge row written under the current subject scheme exists in production from
builds 4-7. A `visit_group_id` backfill would face only historical `assignments` rows, and those are
not L1-pinned (Constraint 2). The undeletable surface is `observations` / `nudges` `subject_ref`,
which has no FK — so the question is whether build 8 changes the key *before* the evaluation phase
writes history under it, or after.

## Open Questions

1. **What distinguishes a crew from two trades at one address?** The code has already answered this
   once, in the opposite direction (Constraint 1). If `(job, window)` is the definition, then a
   plumber and an electrician booked to one job in one window are declared one visit by fiat. If it
   is not the definition, something has to be recorded at booking time — and only a manager knows.
   This is a product question and it gates (a), (c) and (f).
2. **Under no-lead, can a visit-scoped gap be asked at all?** `countsAsTheAsk` requires a single named
   addressee (`planner.ts:2348`). Asking one crew-mate on behalf of the visit is functionally a lead.
   Asking both means two messages that are one question, which `uq_nudges_subject_ever` (not partial)
   forbids for one subject. Either the ask stops being gap-bound for crews, or one of these rails
   changes.
3. **Does `move_visit` on one row of a crew currently produce a wrong answer anyone has seen?**
   Unverifiable by reading — needs a driven test on the local stack (book two, move one, read both).
4. **Is the cost detector's crew tie-break stable in practice?** `ends_at` ties, and PostgREST adds no
   secondary sort (`jobs.ts:249`). Whether Postgres returns a consistent order for tied rows is an
   implementation detail, not a guarantee — needs a probe.
5. **How much of the seat doctrine has to change with the count?** The box doctrine is not a file —
   it is heredoc'd into every sandbox's `AGENTS.md` by `Box_Setup_Stuff/bootstrap-box.sh` and read
   back by `src/eval/doctrine.ts:65`. It never says "one person per visit", but it counts
   `v_schedule` rows as visits throughout: the worked per-day example is *"Wed YYYY-MM-DD — 16
   visits"* (:876), clause 7 (:890) governs how a count must be labelled, and clause 8 (:892) is a
   whole rule about which rows a count misses. If the count changes meaning, these are the sentences
   that go stale — and per `bootstrap-copy-drift-trap`, six copies of that script exist at different
   vintages, so any doctrine change needs the md5 sweep. Not verified: whether the deployed boxes'
   copy matches this one.
