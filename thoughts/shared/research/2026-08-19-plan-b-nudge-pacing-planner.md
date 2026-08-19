---
date: 2026-08-19
branch: fix/cost-detector-paid-and-corrections (src/ + migrations byte-identical to origin/main)
commit: 16f0778
topic: "Plan B — the nudge pacing planner: what exists in the code today that its three parts must attach to"
---

## Summary

A "nudge" is one question the spine's team-lead identity asks a technician through their own
chat agent — *"how did the water heater job go?"*. The **ladder** is the machinery that notices
a gap, writes the question, delivers it, and decides when it has been answered or must be
handed to a manager. **Plan B is the pacing layer for that machinery, and it has no code at
all today.** Its three ratified parts are: *earn the ask* (a detector declares at design time
whether its gap can be derived instead of asked), *urgency sets latency* (urgent gaps
interrupt, routine gaps trickle), and *batch the unimportant* (several low-urgency gaps ride
in one message). What exists instead is a ladder that asks about **every** gap **immediately**,
one message per gap, throttled only by per-tick counters. This document maps the machinery
those three parts must attach to, and the seams where a pacing layer would insert.

The single most consequential fact for planning: **there is no place in the code where more
than one gap is ever considered together.** Every stage — detection, dedup, compose, delivery,
escalation — is keyed on one gap at a time, and the per-gap key differs by detector. Batching
is not a change to a function; it is the introduction of a grouping concept the schema and the
transport currently have no representation for.

## Entry Points

- `src/jobs/lifecycle.ts:319` — the 5-minute cron's call into `runWatchers(nowIso, watchersMode, {}, nudgeMode)`.
- `src/jobs/lifecycle.ts:298,302` — `WATCHERS_MODE` and `NUDGES_MODE` read from env; `NUDGES_MODE`
  unset means `'off'` silently, an invalid value is a step error (`:312`).
- `src/jobs/lifecycle.ts:342` — `runTeamLeadCompose(nowIso)` runs in the SAME tick, gated at `:336` on `nudgeMode === 'live'`.
- `src/jobs/watchers.ts:208` — `runWatchers`, the detection + sweep + escalation pass.
- `src/teamLead/compose.ts:146` — `runTeamLeadCompose`, the one model call in the ladder.
- `src/control/nudgeQueue.ts:63` — `buildNudgeDelivery(hostId)`, what the box pulls.
- `GET/POST /control/nudges` (host token) — the box's transport; box side is `nudge-runner.timer`,
  a 5-minute systemd timer.

## Key Files

| path | role | key exports |
|---|---|---|
| `src/jobs/watchers.ts` (864 lines) | detection for both kinds, the open-nudge sweep, rung-2 escalation, expiry | `runWatchers`, `wallClockLabel`, `OVERDUE_HOURS`, `LOOKBACK_HOURS`, `MAX_NEW_ITEMS_PER_TENANT_TICK`, `NUDGE_ESCALATE_HOURS`, `NUDGE_DELIVERY_DEADLINE_HOURS` |
| `src/jobs/nudgeKinds.ts` (311 lines) | the kind registry — per-detector behaviour as data | `NudgeKindSpec`, `SweepFacts`, `OVERDUE_VISIT_GAP_SPEC`, `JOB_COST_GAP_SPEC`, `NUDGE_KIND_SPECS`, `specFor` |
| `src/teamLead/compose.ts` (278 lines) | the compose sweep + ask window + manager handoff | `runTeamLeadCompose`, `insideAskWindow`, `handToManager`, `ASK_WINDOW_START_HOUR/END_HOUR`, `MAX_COMPOSE_ATTEMPTS` |
| `src/teamLead/composeCopy.ts` (234 lines) | verbatim prompts + message assembly, per kind | `COMPOSE_SYSTEM/TOOL`, `assembleNudgeMessage`, `COST_COMPOSE_SYSTEM/TOOL`, `assembleCostNudgeMessage`, `flatten`, `relativeDayPhrase` |
| `src/control/nudgeQueue.ts` (160 lines) | host-scoped serve + delivery report | `buildNudgeDelivery`, `completeNudgeDelivery`, `MAX_SERVE_COUNT` |
| `src/db/nudges.ts` (259 lines) | typed access to the `nudges` table | `createPendingNudge`, `listNudgesByStatus`, `listNudgedSubjectRefs`, `markNudgeQueued`, `markNudgeAsked`, `markNudgeOutcome`, `OPEN_NUDGE_STATUSES` |
| `supabase/migrations/20260817090000_nudges.sql` (78 lines) | the table, its lifecycle CHECK, and the once-ever unique constraint | — |

## Data Flows

```
   cron tick (every 5 min, Render)
        │
        ▼
   runWatchers ─── per tenant with a live Telegram binding
        │
        ├─ DETECT #1 overdue_visit_gap ── subject = ASSIGNMENT id
        ├─ DETECT #2 job_cost_gap ─────── subject = JOB id
        │      each: candidates → dedup (ever-flagged ∪ ever-nudged ∪ kind-specific)
        │             → slice(spec.maxNewPerTenantTick) → shared tenant ceiling (5)
        │             → reachable? createPendingNudge : flagNudgeGap(manager)
        │
        ├─ SWEEP open nudges (pending|queued|asked)
        │      spec.filled(n, facts)  → answered
        │      spec.moot(n, facts)    → cancelled
        │      asked_at + 48h         → escalated  (rung 2 → manager review item)
        │      created_at + 24h       → failed     (never delivered → manager)
        ▼
   runTeamLeadCompose ── SAME tick
        │  per tenant: pending rows, filtered to registered kinds
        │  ask-window gate (7am–7pm firm-local) — else held, untouched
        │  ONE forced-tool model call per row (maxTokens 300, reasoningEffort 'none')
        │  → markNudgeQueued(question)          status: pending → queued
        ▼
   box nudge-runner.timer (every 5 min) → GET /control/nudges
        │  buildNudgeDelivery(hostId): ONE item per queued row
        │  { id, sandboxRef, replyTo, sessionId: `nudge-<id>`, messageB64 }
        │  serve_count++ BEFORE shipping (at-most-N-serves)
        ▼
   openclaw agent --deliver  in the technician's sandbox → Telegram
        │
        ▼
   POST /control/nudges → completeNudgeDelivery → markNudgeAsked   status: queued → asked
```

**Measured live 2026-08-19 (pilot):** detect 17:55:37Z → compose 17:55:40Z (same tick) →
delivered 17:59:15Z → `answered` 18:05:42Z. One reply closed two nudges of different kinds.

### The per-gap keying, stage by stage

| stage | keyed on | grouping concept |
|---|---|---|
| detection | one candidate row | none |
| dedup | `(tenant_id, kind, subject_ref)` | none |
| creation | one `nudges` row | none |
| compose | one row → one model call | none |
| message | one `question` column | none |
| delivery | one item, one `nudge-<id>` session | none |
| ack | one row → `asked_at` | none |
| escalation | one row's `asked_at + 48h` | none |

## External Dependencies

- **Model provider** via `runForcedTool` (`src/model/forcedTool.ts`) — one call per nudge,
  `label: 'teamLeadCompose'`, `reasoningEffort: 'none'`. Measured live at 462 in / 66 out.
- **PostgREST / Supabase** — all reads; the silent 1000-row cap is a recurring hazard the
  listers page around.
- **OpenClaw gateway + `openclaw agent --deliver`** on trades-box-1, per-sandbox.
- **Telegram** — the delivery surface; the bot is determined by the SANDBOX, not the recipient.
- **systemd** `nudge-runner.timer` (5-min) on the box; kill switch `systemctl disable --now nudge-runner.timer`.

## Constraints and Invariants

1. **Dedup is per gap, forever.** `uq_nudges_subject_ever unique (tenant_id, kind, subject_ref)`
   (`nudges.sql:56`), deliberately NOT partial — a resolved nudge keeps blocking.
   `createPendingNudge` (`nudges.ts:38`) treats 23505 as "already considered".
2. **The two detectors use different subjects.** `overdue_visit_gap` → the assignment id
   (`watchers.ts:694`); `job_cost_gap` → the job id (`watchers.ts:788,810`). A 3-visit job with
   nothing recorded therefore yields 3 visit nudges + 1 cost nudge = 4 messages, across
   potentially 2 technicians.
3. **Rate brakes exist; grouping does not.** `MAX_NEW_ITEMS_PER_TENANT_TICK = 5`
   (`watchers.ts:95`) is a shared per-tenant ceiling both detectors spend from
   (`watchers.ts:668` visit, `:767` cost), and each spec declares `maxNewPerTenantTick` (visit 5, cost 3 —
   `nudgeKinds.ts:140,236`). These SPREAD asks across ticks; nothing combines them.
4. **There is no per-person cap.** Removed 2026-08-19 (PR #153) by user ruling.
   `idx_nudges_budget` (`nudges.sql:61`) is now orphaned but retained.
5. **Compose is gated by the ask window, detection is not.** 7am–7pm firm-local, seven days
   (`compose.ts:51-52`). The gate sits on compose because the day phrase is baked in at write
   time; out-of-window rows stay `pending`, untouched, and `summary.held` counts them.
   **Consequence for planning: a live delivery test is only possible inside that window.**
6. **The longest overnight hold (12h; 13h on a DST fall-back night) must stay inside
   `NUDGE_DELIVERY_DEADLINE_HOURS = 24`** (`watchers.ts:120`). Both files state that a window
   which ever excludes whole DAYS must lengthen that deadline with it, or weekend-held rows
   expire to the manager unasked. **Any latency/batching delay added by Plan B spends from the
   same 24h budget.**
7. **Each row's escalation clock starts at its own `asked_at`** (`watchers.ts:503-507`), which
   `markNudgeAsked` stamps on the delivery ack. A row that never reaches `asked` never starts a
   48h clock — it exits via the 24h expiry instead.
8. **The orphan doctrine.** Any path that kills a nudge before the ask lands must hand the gap
   to the manager FIRST (`compose.ts:76-122`, `watchers.ts:528-570`), because the fresh
   pre-filter excludes ever-nudged subjects and the once-ever index blocks a second nudge —
   without the handoff the gap reaches NEITHER surface, ever.
9. **Closure is by evidence in the record, never by "the person replied."** Both specs route
   through `hasActivitySince(jobId, bound)` (`watchers.ts:391`), whose map `latestByJob`
   (`watchers.ts:356`) is built from `raw_captures` + `visits` only. The bounds differ: the
   visit kind uses the visit START (`nudgeKinds.ts:142-151`), the cost kind uses `asked_at`
   (`nudgeKinds.ts:238-250`).
10. **The activity map cannot see the money ledger.** Documented defect, unfixed; a live
    specimen is deliberately open on the pilot as the rung-2 escalation test. See
    `2026-08-19-nudge-money-answer-blindspot.md`.
11. **`job_cost_gap` has no any-status review-item backstop.** The unique index
    `uq_review_items_overdue_gap_ever` (`nudges.sql:76-78`) is partial —
    `where kind = 'overdue_visit_gap'`. The cost kind relies on `flagNudgeGap`'s app-level dedup
    alone.
12. **`openedByKind` is a hardcoded two-slot bucket** (`watchers.ts:476`) populated by
    `if (spec.kind === 'job_cost_gap') … else …` (`:551,599`) — a third kind falls into the
    `overdue` slot and the manager push says "a recent visit" about a non-visit gap.
13. **`byKind.gapsFound` is not comparable across detectors.** The visit detector bumps it
    pre-dedup and in shadow mode (`watchers.ts:396`); the cost detector bumps it post-dedup and
    live-only (`watchers.ts:758`).
14. **The message is a single assembled string** (`composeCopy.ts:130`): question, then a
    code-printed `(re: customer — job, visit on YYYY-MM-DD)` evidence line, then a standing
    footer addressed to the receiving agent. The footer names ONE technician and ONE job and
    instructs `record_field_note` **for this job**.
15. **Serve counting precedes shipping** (`nudgeQueue.ts:~104`) — at-most-N-serves even if the
    response is lost; `MAX_SERVE_COUNT` exhaustion hands to the manager and closes the row.
16. **Liveness is re-checked at serve time** (`nudgeQueue.ts:78`): a technician who went
    inactive or lost their sandbox between queue and serve is SKIPPED, not failed.
17. **`nudges` has no append-only trigger** — `created_at`/`asked_at` are code-writable, so a
    synthetic `asked_at` plant is a viable test for escalation timing.
18. **Detector #2 is gated on `nudgeMode !== 'off'` wholesale** (`watchers.ts:744`), so a
    rollback disables cost detection including its manager-item fallback.

## Decision Points

1. **Where the planner layer sits.** Today `runWatchers` creates `pending` rows and
   `runTeamLeadCompose` composes every one of them in the same tick. A pacing layer could
   (a) sit between them, deciding which `pending` rows compose now — leaving `pending` as the
   holding state, which the 24h expiry already counts against; or (b) sit at creation, stamping
   urgency/grouping onto the row so compose reads it. (a) requires no schema change to defer;
   (b) requires columns but keeps compose ignorant of timing.

2. **What a carrier is, in the schema.** `nudges` has no parent/child or group column, and
   `uq_nudges_subject_ever` is per gap. A batch could be (a) a new `nudge_groups` table with
   `nudges.group_id`; (b) a self-reference (`nudges.carrier_id` nullable); or (c) no schema
   change, deriving groups per tick from `(technician_id, tenant_id)` and marking only which row
   carried. (c) leaves no audit of what rode with what; (a) and (b) both need every rider's
   `asked_at` stamped when the carrier acks.

3. **What the delivery item looks like for a batch.** `buildNudgeDelivery` returns one item per
   row with `sessionId: nudge-<id>` and a single `messageB64`. A carrier needs either one item
   whose `id` the ack maps back to N rows, or N items the box is told to render as one — the
   first changes `completeNudgeDelivery`'s contract (one report currently moves exactly one row),
   the second changes the box runner.

4. **Whether a batch is one model call or N.** Compose is kind-scoped: each spec owns its own
   system prompt and tool (`nudgeKinds.ts` → `composeCopy.ts`). A mixed-kind carrier has no
   single prompt today. Options: compose each rider separately and have code concatenate; or add
   a carrier-level prompt that sees several contexts at once (a larger, differently-shaped call
   than the measured 462-in/66-out).

5. **Where urgency comes from.** No urgency field or function exists anywhere. The ratified
   design says a declared base tier per detector plus deterministic SQL modifiers. The registry
   (`NudgeKindSpec`) is the natural home for the base tier; the modifiers have no home yet.

6. **Whether "earn the ask" needs any code for the current two detectors.** The ratified design
   classes each detector as `ask` / `derive` / `attempt`. Both shipped detectors are already
   effectively `ask`, and the `derive` precedent already exists as the activity check that
   suppresses asks pre-creation. So part 1 may be a declaration on the spec plus documentation
   rather than new machinery — or it may want the class enforced somewhere.

7. **Whether the 24h expiry budget is enough.** Any deliberate delay (part 2's "routine gaps
   trickle") competes with the ask window's overnight hold inside the same 24h deadline
   (constraint 6). Raising the deadline, or exempting deliberately-delayed rows, is a fork.

## Open Questions

- **Does the box runner render one message per delivery item, or could it render a grouped
  one?** `buildNudgeDelivery`'s contract is known from this repo; the runner script
  (`/usr/local/sbin/nudge-runner.sh`, md5 `a84f1a37…`) lives on the box and was not read here.
- **Can one `openclaw agent --deliver` call carry a multi-part message reliably?** Stage 1's
  history includes a delivery bug that only appeared with a real multi-line payload, so this
  needs reproducing with the real shape rather than a hand-crafted single line.
- **What does the receiving agent do with a message naming several jobs?** The footer is written
  for exactly one technician and one job and says `record_field_note` **for this job**; its
  behaviour with several is untested.
- **Should a deliberately-delayed nudge count against `NUDGE_DELIVERY_DEADLINE_HOURS`?** The
  constant's comment reasons only about rows stuck by failure, not rows held on purpose.
- **Is there a per-tenant tick ordering guarantee worth relying on?** `listNudgesByStatus`
  orders by `created_at` ascending (`nudges.ts:65`), but the detectors' candidate order is
  per-query and the tenant loop order comes from `listTenantIdsWithTelegramBindings`.
