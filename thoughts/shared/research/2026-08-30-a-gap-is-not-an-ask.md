---
date: 2026-08-30
branch: main
commit: a60af27
topic: Build 4 — "a gap is not an ask": the ground detection-stops-implying-a-question stands on
supersedes: nothing
---

## Summary

A **gap** is the system noticing a hole in a job's record — a visit that finished with nothing
written about it, or a job with no parts cost on the books. Today a gap has no existence of its
own: the moment a detector notices one it writes a `nudges` row, and that row **is a question
addressed to a named person**. Its founding migration says so in its first sentence — *"One row =
one question the team-lead identity ever CONSIDERS asking a technician about a gap"*
(`supabase/migrations/20260817090000_nudges.sql:2`). The row carries a `technician_id`, a status
vocabulary of `pending → queued → asked`, an 18-hour deadline for the question to be delivered, and
a 24-hour deadline for the person to answer. If the technician is unreachable, the detector writes
a **manager** question instead. There is no third outcome and no other place a noticed gap can be
recorded. Meanwhile the planner's doctrine already tells the model the opposite — *"A gap is a HOLE
IN THE RECORD, not an unanswered message"* (`src/teamLead/plannerPrompt.ts:34`). Build 4 is the
work of making the data agree with that sentence.

## Entry Points

- `src/jobs/watchers.ts:328` — `runWatchers`, the whole detection sweep. Runs on the 5-minute
  lifecycle cron.
- `src/jobs/watchers.ts:1179` and `:1274` — the two `createNudge` calls. **These are the only two
  places in production where a gap comes into existence.**
- `src/jobs/watchers.ts:1206`, `:1299` — the manager-item fallback (`flagGap` / `flagNudge`) taken
  when the technician is unreachable.
- `src/jobs/nudgeKinds.ts:466` — `NUDGE_KIND_SPECS`, the registry of the two kinds.
- `src/teamLead/planner.ts:731` — `buildGapView`, which renders a gap for the model.
- `src/teamLead/plannerPrompt.ts:28` — `PLANNER_SYSTEM`, where the judgment lives as words.

## Key Files

| file | role |
|---|---|
| `supabase/migrations/20260817090000_nudges.sql` | the table, the status CHECK, `uq_nudges_subject_ever` |
| `supabase/migrations/20260819150000_nudge_deadlines.sql` | `not_before`, `escalate_after` — deadlines as data |
| `supabase/migrations/20260822120000_nudge_answered_by.sql` | `answered_by_capture_id` — which capture answered |
| `supabase/migrations/20260825000000_nudge_ask_group.sql` | `ask_group_id` — one message, several gaps |
| `src/jobs/watchers.ts` | detection, minting, the sweep, escalation, expiry |
| `src/jobs/nudgeKinds.ts` | per-kind predicates: `filled`, `moot`, `itemResolved`, `handoff` |
| `src/db/nudges.ts` | every accessor; `createPendingNudge` treats 23505 as "already considered" |
| `src/control/nudgeQueue.ts` | the box's pull-based delivery; `buildNudgeDelivery`, `completeNudgeDelivery` |
| `src/teamLead/planner.ts` | the gap view, the six verbs, the rails, `unmentioned` |
| `src/eval/plannerSim.ts` | seeds `nudges` rows directly as the eval's world |

## (1) What a gap is today

**`nudges`** — every column:

| column | type | default | who writes it |
|---|---|---|---|
| `id` | uuid | `gen_random_uuid()` | DB |
| `tenant_id` | uuid | — | detector |
| `kind` | text | — | detector, from the spec (`watchers.ts:1183`, `:1276`) |
| `subject_ref` | text | — | **assignment id** for `overdue_visit_gap`, **job id** for `job_cost_gap` |
| `technician_id` | uuid | — | detector — **set at creation, never changed** |
| `status` | text | `'pending'` | CHECK: `pending, queued, asked, answered, escalated, cancelled, failed` |
| `question` | text | null | the planner, on an applied `send` |
| `context` | jsonb | `'{}'` | detector — customerName, jobTitle, technicianRef, jobId, startsAtLocal, endsAtLocal |
| `attempts` | int | 0 | `nudgeQueue.ts` delivery reports |
| `serve_count` | int | 0 | `nudgeQueue.ts` each serve |
| `actor_ref` | text | `'spine:team-lead'` | detector |
| `resolution` | text | null | the sweep, on every terminal transition |
| `not_before` | timestamptz | null | the planner's `hold` |
| `escalate_after` | timestamptz | null | the planner's `extend`/`escalate` |
| `answered_by_capture_id` | uuid | null | two writers, first-write-wins (see below) |
| `ask_group_id` | uuid | null | `markNudgeGroupQueued` at queue time |
| `queued_at` / `asked_at` / `resolved_at` / `created_at` / `updated_at` | timestamptz | — | the transitions below |

**The status transitions, and who performs each:**

```
          detector (watchers.ts:1179/:1274)
                    │
                    ▼
              ┌──────────┐   planner `send` → markNudgeGroupQueued   ┌────────┐
              │ pending  │ ─────────────────────────────────────────▶│ queued │
              └──────────┘                                           └────────┘
                    │                                                     │
                    │ 18h since created_at                                │ box ACKs
                    │ (NUDGE_DELIVERY_DEADLINE_HOURS)                     ▼
                    │                                                ┌────────┐
                    ├───────────────────────────────────────────────▶│ asked  │
                    ▼            watchers.ts:934-984                  └────────┘
              ┌────────┐  "never delivered — handed to the manager"        │
              │ failed │  + a manager review_item is opened first     ─────┤
              └────────┘                                                   │
                                                                           │ escalate_after passes
   spec.moot() — visit or job cancelled                                    │ (default asked_at+24h)
   watchers.ts:782 ─────────────▶ ┌───────────┐                            ▼
                                  │ cancelled │                      ┌───────────┐
                                  └───────────┘                      │ escalated │
                                                                     └───────────┘
   planner `close`  ─────────────▶ ┌──────────┐   ◀── the sweep's fail-safe, only when the
                                   │ answered │       planner has been silent 24h AND the gap
                                   └──────────┘       is the sole one on its job (watchers.ts:843)
```

**`uq_nudges_subject_ever`** (`nudges.sql:56`) — `unique (tenant_id, kind, subject_ref)`,
**deliberately not partial**. It forbids a second gap of the same kind about the same subject
*ever*, in any status. The migration's stated reason: *"an assignment's end never recurs, so
re-asking is never right"*. `createPendingNudge` treats the resulting 23505 as *"already
considered"* rather than as an error. For `job_cost_gap` the subject is the **job**, so this reads
as *ask once per job forever* — recorded as an accepted limitation at `watchers.ts:1277-1279`.

**Two kinds only** (`nudgeKinds.ts:466`):

| kind | subject | `subjectIsVisit` | per-kind brake | added by |
|---|---|---|---|---|
| `overdue_visit_gap` | assignment id | true | `maxNewPerTenantTick: 5` | `20260817090000_nudges.sql` |
| `job_cost_gap` | job id | false | `maxNewPerTenantTick: 3` | `20260819130000_job_cost_gap_backstop.sql` |

## (2) Who mints one, and the load-bearing fact

**Detector 1 — overdue visit.** A confirmed assignment whose scheduled end fell between
`lookbackHours` and `overdueHours` ago (per-firm, defaulting 72h / 3h), with **no job activity
since the visit STARTED** (`watchers.ts:565`). "Activity" = a `raw_captures` row or a
`visits.created_at` row, converted to the firm's wall clock.

**Detector 2 — job cost.** A job whose visit has ended in the same window with **no live row on the
money ledger** (`watchers.ts:1236-1248`).

Both then filter to `fresh` — never surfaced on *either* rung, any status, via the two once-ever
stores (`listEverFlagged` ∪ `listNudged`, `watchers.ts:576-581`).

**Brakes.** Per-kind (`spec.maxNewPerTenantTick`, slicing at `:1140` and `:1251`) *and* a
tenant-wide ceiling checked inside both loops (`settings.maxNewPerTick`, `:1158` and `:1259`).
Passes run in order and there is no fairness mechanism — a tick with 5 fresh visit gaps surfaces no
cost gaps at all (`:1122-1128`).

**THE LOAD-BEARING FACT, checked rather than assumed: no. There is no representation anywhere of
"the system noticed something" that is not a question to a person.** Both mint sites have the same
shape —

```ts
if (reachable && nudgeMode === 'live') { await createNudge({...}); continue; }  // ask the TECHNICIAN
const item = await flagGap({...});                                             // ask the MANAGER
```

— so a routed gap becomes a technician question or a manager question, never a bare observation.
The alternatives were checked: `review_items` is a manager **queue** (`kind`, `subject_ref`,
`suggestion`, `status`, `resolution`) — a different addressee, still a question; `lifecycle_runs`
holds one tenant-agnostic row per tick with counts only; `jobs.attributes` holds
`StandingFactBundle`, written solely by the agent-facing `record_standing_fact`; `money_events` is a
ledger of facts, not of noticing.

**And a gap outside the cap is not recorded at all.** `top = fresh.slice(0, brake)` — everything
past the slice is simply dropped and re-derived next tick. So the system's *entire* memory of
having noticed something is the ask it sent about it.

## (3) Where "detection implies a question" is baked in

**In the schema.** `technician_id` on the row; the statuses `pending`/`queued`/`asked` name stages
of a message, not of a hole; `question` is a column of the gap itself.

**In the clocks.** `NUDGE_DELIVERY_DEADLINE_HOURS = 18` (`watchers.ts:173`) — a gap not *asked*
within 18h is closed `failed` with resolution `'never delivered — handed to the manager'`
(`:973-979`), after opening a manager item first. `NUDGE_ESCALATE_HOURS = 24`
(`watchers.ts:128`), `NUDGE_ESCALATE_MAX_HOURS = 48` (`:136`) — the answering clock, measured from
`asked_at`. Both clocks start from the *ask*, and a gap that has not been asked is treated as
**broken machinery**, not as a decision: *"The ask is not happening — the manager takes the gap."*

**In the doctrine.** `plannerPrompt.ts` states the intended semantics and then contradicts them
structurally. Verbatim, `:34-39`:

> WHAT A GAP ACTUALLY IS. A gap is a HOLE IN THE RECORD, not an unanswered message. Asking somebody
> is just the usual way to fill it — it is not what the gap is for. So the question to ask yourself
> is never "did they reply to me", it is "is the hole still there".

But `:72-79` immediately makes the ask's delivery state the thing that gates every verb:

> WHAT EACH ACTION CAN DO, AND WHEN. Every gap tells you its `state`, and the state decides which
> actions are even possible:
>   state "pending" — nothing has gone out yet, and nothing goes out until YOU choose `send`.
>                     send and hold both work here; `leave` does NOT — an unowned wait just lets
>                     the gap drift, so waiting is `hold` with a time.
>   state "queued"  — the question is written and waiting to be delivered. Leave it alone.
>   state "asked"   — the question is already with the person. close, escalate and extend are
>                     what mean anything now; there is no way to ask again.

**In the gap block.** `buildGapView` (`planner.ts:828-841`) prints `person:` and `state:` on every
gap, and `asked: not yet` when nobody has been contacted — framing absence-of-ask as the gap's
defining property.

## (4) The answer already written and never landed

`thoughts/shared/plans/2026-08-26-the-decline-verb.md` — **`status: draft`, never implemented.** Its
Overview states build 4's problem in one paragraph:

> A `pending` nudge is a gap nobody has been contacted about. The planner sees it twice an hour and
> picks one of six verbs. None of them means *"this should not be asked of this person at all."* So
> a gap the planner correctly judged un-askable at 10:00 AM sits untouched until the 18-hour
> delivery deadline hands it to the manager labelled **"never delivered"** — neglect-shaped, 18
> hours late, for what was a sound decision made immediately.

It proposed a seventh verb `decline`: hand to the manager now, in the planner's own words, closing
the row as the existing `cancelled` status plus a citing review item (the compound test, since
`cancelled` also means "the visit was cancelled").

**Drift check against `a60af27` — every construct it names still exists; only line numbers moved:**

| the plan cites | today |
|---|---|
| `nudgeKinds.ts:352` — `suggestion: plannerNote ?? template` | present, ~`:350-355` |
| `watchers.ts:738-744` — the moot path | present, `watchers.ts:782` |
| `src/db/nudges.ts:244` — `markNudgeGroupQueued` | present, `:225` |
| `planner.ts:103-105` — `reason` is diagnostic, never shown to a manager | present, `:115` |
| `src/mcp/server.ts:696` — `v_nudges` in the catalogue | present, `:707` |
| `20260824020000_planner_metrics_v2.sql:31-35` — `mv_gap_outcomes` | present |
| corpus `FAMILY_COUNTS` 8 → 9, total 66 → 67 | **stale** — the corpus is 62 today (four `lessons` scenarios retired 2026-08-30) |

## (5) What the planner can do with a gap today

Six verbs (`plannerPrompt.ts:53-59`, enum at `:289`): `send`, `hold`, `close`, `escalate`,
`extend`, `leave`. Five of the six are about the **ask**; only `close` is about the **hole**.

Rails, applied by code after the model returns:
- `escalate` refused when the sweep is not live, or when `status !== 'asked'` (`planner.ts:1258`,
  `:1266`).
- `send` / `hold` refused unless the row is pre-ask (`:1274`).
- `send` group rails — same person, same job, none already gone out (`:1290-1301`).
- `extend` must name a later instant, in the future, ≤ `NUDGE_ESCALATE_MAX_HOURS` after `asked_at`.
- `close` needs a `basis`: `record` (code-verified) or `evidence` (verbatim citation checked
  against the gap's own evidence lines).

**`unmentioned`** (`planner.ts:91`) is not a verb the model can choose. Code writes one row with
`outcome: 'applied'` for every gap in the view the model did **not** name, so *"considered 40 times
and left alone"* is distinguishable from *"never seen"* (`:2300-2302`). It is deliberately excluded
from `PLANNER_JUDGMENT_ACTIONS` (`watchers.ts:203-210`) — otherwise the sweep's liveness test would
be true for every gap on every tick and the auto-close fail-safe would never fire again.

A gap the planner never names therefore: gets an `unmentioned` row, keeps its clocks running
unchanged, and next tick shows the continuity line built by `historyLine` (`planner.ts:652-690`) —
`watched since <label> — considered 14×, last: leave 3h ago. Use recall_decisions for the detail.`
The prompt is explicit that this buys nobody time (`:80-83`).

## (6) The observability blocker

**How the spine learns a technician DID answer.** One path, and it is narrow. The technician speaks
to their own assistant, which calls `record_field_note`; the spine resolves the job and calls
`attributeAnswerToGap` (`src/mcp/server.ts:2124`):

```ts
if (!technicianId || !jobId) return;
const open = await listAskedNudgesForTechnicianJob(tenantId, technicianId, jobId);
if (open.length !== 1) return;              // two open gaps → a judgment, so code stamps nothing
await setNudgeAnsweredBy(open[0].id, tenantId, captureId);
```

A second writer stamps the same column at **close** time, derived from the citation the planner
quoted (`20260825000000_nudge_ask_group.sql`, amended comment). Both are first-write-wins, and
`NULL` means *"not attributed"*, never *"not answered"*.

**What it cannot learn.** Silence is inferred purely from **absence**: `spec.filled` asks
`hasActivitySince(jobId, ...)`, which reads `raw_captures` and `visits.created_at` and nothing else.
There is no delivery read-receipt, no "seen", no reply-channel event. Consequently the system
cannot distinguish, and has no column for:

- the message was never delivered (host unbound, sandbox recycled) — inferred at 18h as `failed`;
- it was delivered and not read;
- it was read and ignored;
- the person answered somewhere the spine cannot see (a phone call, another technician's note);
- the person **cannot** answer — they were not on site, they were swapped out.

The last of these is a documented live case (the decline-verb plan's walkthrough: *"Dave covered
the Holloway call, I was never on site"*). All five present identically as *nothing landed on the
job*, and all five reach the manager on the same clock.

## (7) Couplings a split would break

| consumer | what it assumes |
|---|---|
| `src/control/nudgeQueue.ts` (13 accessor call-sites) | a queued row is a deliverable: `buildNudgeDelivery` pulls by host, `MAX_SERVE_COUNT = 10`, `MAX_DELIVERY_ATTEMPTS = 3`, and every terminal failure hands to the manager first |
| `src/jobs/watchers.ts` (10) | the sweep reads `['pending','queued','asked']` as "open" |
| `src/teamLead/planner.ts` (11) | the gap view, all six verbs, every rail |
| `review_items` | the manager twin, deduped by two once-ever partial indexes on `(tenant_id, subject_ref)` per kind |
| `v_nudges` (`20260823120000_planner_read_surface.sql:78`) | 18 columns exposed to `spine_read` **and** to the manager's `query_spine` — `status`, `question`, `resolution`, `asked_at`, `serve_count`, `attempts` are all ask-shaped |
| `mv_gap_outcomes`, `mv_whiplash` (`20260824020000_planner_metrics_v2.sql`) | bucket on `escalated` or a citing review item |
| `npm run ticks` | reads `lifecycle_runs` only — no nudge coupling |
| `src/eval/plannerSim.ts` | **seeds `nudges` rows directly as the world**: `:238`, `:416`, `:553`, `:579`, `:757` |

The last row is the one that reaches furthest. The eval corpus's 62 scenarios each seed a nudge row
and grade what the planner did to it; the corpus's own authoring rail requires every seeded gap's
deadline to fall **after the first tick**, because the sweep would otherwise escalate it before the
planner ever saw it. Both the fixture shape and that rail are stated in terms of the object build 4
would split.

## Constraints and Invariants

- **`uq_nudges_subject_ever` is any-status.** A resolved gap keeps blocking a new one forever.
- **`createPendingNudge` swallows 23505** as "already considered" — concurrent ticks converge.
- **The 23505 path also means minting is not idempotent-with-a-read**: two ticks both pass the
  select-then-insert, and the constraint is what makes the loser lose loudly.
- **Deadlines fail safe through ABSENCE.** `escalate_after` null → the 24h constant. If the planner
  never runs, every row still escalates.
- **`filled` closes nothing** since 2026-08-29. It is read-only, feeding the fail-safe, the handoff
  copy, and the gap view.
- **Kinds without a spec are invisible** to the whole sweep — never answered, escalated, or
  expired. Creation is registry-gated at both ends for exactly this reason (`watchers.ts:1129-1134`).
- **`context` is naive-local; columns are real UTC.** Stated at `20260819150000_nudge_deadlines.sql`.
- **The nudge is NOT L1-captured** (user-ratified 2026-08-16) — the row is the whole audit, which is
  why it carries the question text and every timestamp.

## Decision Points

**(a) A separate observation record, or a new column/status on `nudges`.** A new table means every
consumer in area 7 needs a mapping and the eval's fixtures change shape; a column or status means
`uq_nudges_subject_ever`, the two 18h/24h clocks, and `technician_id NOT NULL`-in-practice all keep
applying to rows that are not asks. Note the ceiling: today an observation past the per-tick cap is
not stored at all, so either choice is also a decision about whether *un-routed* observations start
being recorded.

**(b) Whether an un-asked observation carries a deadline.** Both existing clocks measure the ask —
18h is explicitly *"how long before we admit the MACHINERY is broken"*, and 24h runs from
`asked_at`. An observation nobody has been asked about has neither referent. Leaving it deadline-less
removes the mechanism that currently guarantees every gap eventually reaches a human.

**(c) What `uq_nudges_subject_ever` means once the two are separate objects.** Today one constraint
enforces both *"notice this subject once"* and *"ask about it once"*. Split, those are different
rules: a subject could plausibly be re-observed while still only ever being asked about once, or the
reverse.

**(d) Whether the decline-verb draft is absorbed, superseded, or made unnecessary.** It solves one
symptom — the pre-ask gap with no way to say "not this person" — by adding a seventh verb inside
the current structure. If a gap stops implying an ask, that symptom may disappear rather than need a
verb. The plan is unimplemented and its user decisions (manager reads the planner's sentence;
`cancelled` reused rather than a new status; `pending` rows only) were all taken 2026-08-26 against
the old shape.

**(e) What the eval simulator seeds after the split.** Five call sites write `nudges` rows as the
scenario world. If the seeded object changes, all 62 scenarios' worlds change with it — and the
corpus's deadline rail, written because the sweep escalates before the planner looks, is stated
against the current sweep.

**(f) Whether "attention curation as a weighting" implies a rank on the observation.** The user's
2026-08-28 ruling is that curation is a weighting, never a gate. Today the only weighting that
exists is the per-tick cap, which *is* a gate — gaps past the slice are dropped silently. A score or
rank would need somewhere to live, and no column on `nudges` or `review_items` holds one.

## Open Questions

- Does anything outside the repo read `nudges.status` directly? The box-side `nudge-runner.sh`
  consumes the delivery item shape, not the row — but the box scripts live in `Box_Setup_Stuff` and
  on the pilot host, and were not read for this document.
- `NUDGE_DELIVERY_DEADLINE_HOURS = 18` is explicitly *inherited*: its derivation was the ask window,
  which is deleted, and `watchers.ts:166-169` says *"Treat 18 as inherited until someone measures
  it."* Nobody has.
- Whether a manager `review_items` row should be considered an "ask" for build 4's purposes, or the
  fallback surface that survives unchanged. The two rungs share a kind vocabulary and dedup
  discipline but nothing in the code names the relationship.
- Whether `job_cost_gap`'s ask-once-per-job-forever is acceptable once observation is separable — it
  is recorded as an accepted limitation of the *ask*, not of noticing.

## Addendum — 2026-08-31: a user direction reshapes the decision points

Recorded the day after the survey; everything above is unchanged and still accurate at `a60af27`.
The direction is recorded in full at `docs/engineering-memory.md` §6a entry 4. In one line: **the
record grows without bound and is planner-kept** — dismiss stops the detector re-reporting a
subject, recover un-dismisses it when stakes rise, detectors stay ours (they ARE the upweighting —
the planner's eyes), and the detector must not be the only way a gap opens: the planner may read
L1/L2 and open its own observation. A capability, not a doctrine push.

What that does to each decision point:

- **(a) own record vs column** — still formally open, but the direction adds an argument the
  survey could not: a planner-opened observation must pass the dispatch gate ("nothing
  irreversible or externally visible"), which an internal, reversible record passes cleanly and a
  half-filled ask row does not.
- **(b) deadline on an un-asked observation** — reframed. An observation the planner keeps carries
  no delivery/answer clock; the open question is now what replaces the "every gap eventually
  reaches a human" guarantee, not whether the ask clocks apply.
- **(c) `uq_nudges_subject_ever`** — answered by the direction: "surfaced once" becomes the
  planner's revisable dismissal rather than a permanent code decision made at first sight. The
  store survives; its owner changes.
- **(d) the decline-verb draft** — its symptom dissolves with the structure: an un-askable
  observation simply stays un-asked. Formal supersession waits for build 4's plan.
- **(e) eval seeding** — unchanged; still an open cost.
- **(f) rank/score on the observation** — answered by the direction: the weighting IS the
  detectors' existence and aim, not a rank column. No score lives anywhere.
- **The cap's silent drop** (area 2) — reclassified from fact-to-preserve to defect-to-fix: the
  user ruled the record unbounded. The 67/67 fire rate must not size anything — it is the pilot's
  seeded schedule, where nobody reports (the never-size-from-the-pilot rule).
