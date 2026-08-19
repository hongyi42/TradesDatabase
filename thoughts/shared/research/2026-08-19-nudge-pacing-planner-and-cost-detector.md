---
date: 2026-08-19
branch: feat/nudge-pacing-planner
commit: 3763779
topic: "The nudge pacing planner (post-cap) and cost-chasing as detector #2 — what the shipped code forces"
related:
  - thoughts/shared/research/2026-08-19-nudge-pacing-replacement-design.md (the six settled constraints — NOT re-derived here)
  - thoughts/shared/research/2026-08-18-job-costing-money-ledger-gap.md (the cost/margin gap; untracked in the primary checkout)
  - thoughts/shared/plans/2026-08-15-feature-B-intelligent-spine-stage1-voice.md (Stage 1, closed)
---

## Summary

This documents the machinery that carries a question from "a computer noticed something missing"
to "a human was asked about it", as it stands on this branch — the branch where the per-person
ask cap has just been deleted. In plain terms there are four moving parts, each a separate
program run on a five-minute timer: a **watcher** that finds gaps with plain database queries and
writes one row per gap into a table called `nudges`; a **compose** step that makes the single
model call in the whole system, turning that row into one warm sentence; a **queue** the agent
boxes pull from; and a **runner** on the box that delivers the sentence through the technician's
own assistant. The important structural fact for the upcoming work is that **there is no layer
anywhere that looks at more than one gap at a time.** The watcher writes rows one at a time in a
loop, compose reads them one at a time in a loop, and the runner delivers them one at a time in a
loop. Ranking, grouping, and timing — the three things the pacing work needs — have no home in
the current code. Separately, and more consequentially than it first appears, **every one of
these stages is filtered to the single literal string `'overdue_visit_gap'` in four places**, so
a second detector is not a matter of writing a new detector: it is a matter of widening four
hardcoded filters, one of which (the resolve/escalate sweep) would silently strand any nudge of a
new kind open forever.

## Entry Points

| Where a flow begins | What starts there |
|---|---|
| [src/jobs/lifecycle.ts:347](../src/jobs/lifecycle.ts#L347) | Cron step 8 — `runWatchers(nowIso, watchersMode, {}, nudgeMode)`; the only caller |
| [src/jobs/lifecycle.ts:370](../src/jobs/lifecycle.ts#L370) | Cron step 9 — `runTeamLeadCompose(nowIso)`; runs immediately after step 8 in the same process |
| [src/jobs/watchers.ts:564](../src/jobs/watchers.ts#L564) | `const top = fresh.slice(0, MAX_NEW_ITEMS_PER_TENANT_TICK)` — the routing loop; where a gap becomes a nudge or a manager item |
| [src/teamLead/compose.ts:288](../src/teamLead/compose.ts#L288) | The pending-nudge read + kind filter; the ask-window gate is at :293 |
| [src/mcp/httpServer.ts:519](../src/mcp/httpServer.ts#L519) | `GET /control/nudges` — the box's pull |
| [src/mcp/httpServer.ts:523](../src/mcp/httpServer.ts#L523) | `POST /control/nudges` — the box's delivery report |
| [Box_Setup_Stuff/nudge-runner.sh:92](../Box_Setup_Stuff/nudge-runner.sh#L92) | The box-side delivery loop |

## Key Files

- **[src/jobs/watchers.ts](../src/jobs/watchers.ts)** (663 lines) — detection, the resolve/escalate/expire sweeps, and rung-1/rung-2 routing. Exports `runWatchers`, `WatcherDeps` (the injectable-seam interface every test uses), `WatchersSummary`, and the tuning constants `OVERDUE_HOURS = 3` (:83), `LOOKBACK_HOURS = 72` (:84), `MAX_NEW_ITEMS_PER_TENANT_TICK = 5` (:85), `NUDGE_ESCALATE_HOURS = 48` (:100), `NUDGE_DELIVERY_DEADLINE_HOURS = 24` (:110). Also `wallClockLabel` (:120), imported by compose.
- **[src/teamLead/compose.ts](../src/teamLead/compose.ts)** (384 lines) — the one model call. Exports `runTeamLeadCompose`, `MAX_COMPOSE_ATTEMPTS = 3` (:26), `ASK_WINDOW_START_HOUR = 7` / `ASK_WINDOW_END_HOUR = 19` (:90-91), `insideAskWindow` (:93), `relativeDayPhrase` (:69), `readComposeContext` (:136), `handToManager` (:165), `assembleNudgeMessage` (:224).
- **[src/db/nudges.ts](../src/db/nudges.ts)** (259 lines) — the typed layer. `NudgeStatus` (:12), `OPEN_NUDGE_STATUSES` (:23), `createPendingNudge` (:38, insert-catch-23505), `listNudgesByStatus` (:55), `listNudgedSubjectRefs` (:75), `markNudgeQueued` (:98), `listQueuedNudgesForHost` (:129), `getQueuedNudgeForHost` (:143), `setNudgeServeCount` (:161), `setNudgeDeliveryAttempts` (:178), `markNudgeAsked` (:197), `markNudgeOutcome` (:217), `setNudgeAttempts` (:244).
- **[src/control/nudgeQueue.ts](../src/control/nudgeQueue.ts)** (149 lines) — the transport, spine side. `MAX_SERVE_COUNT = 10` (:28), `MAX_DELIVERY_ATTEMPTS = 3` (:31), `NudgeDeliveryItem` (:37), `buildNudgeDelivery` (:61), `completeNudgeDelivery` (:114).
- **[supabase/migrations/20260817090000_nudges.sql](../supabase/migrations/20260817090000_nudges.sql)** — the table (:19-45), the status CHECK (:30), `uq_nudges_subject_ever` (:55-56), `idx_nudges_tenant_status` (:60), `idx_nudges_budget` (:61), RLS-with-no-policy (:68-69).
- **[src/db/reviewItems.ts](../src/db/reviewItems.ts)** — `ReviewKind` (:10-59, 21 kinds, `'overdue_visit_gap'` last at :59). `nudges.kind` is typed as `ReviewKind`, so **a new gap kind must be added here first**. `flagOverdueVisitGap` hardcodes `kind: 'overdue_visit_gap'` at :164.
- **[Box_Setup_Stuff/nudge-runner.sh](../Box_Setup_Stuff/nudge-runner.sh)** (172 lines) — the box half. Trajectory verdict `traj_has_text` (:79-90), the idempotence pre-check (:127-130), the `--message-file` staging (:132-149), the `--deliver` call (:152-158).

## Data Flows

### The full path a question takes

```
  ┌──────────────── one cron process, every 5 min (lifecycle.ts) ─────────────────┐
  │                                                                              │
  │  STEP 8  runWatchers                          STEP 9  runTeamLeadCompose     │
  │  ┌────────────────────────────┐               ┌────────────────────────────┐ │
  │  │ SQL: overdue confirmed     │               │ read nudges status=pending │ │
  │  │      assignments (3h..72h) │               │ FILTER kind==overdue_… :289│ │
  │  │ minus: activity since      │               │ ask window 7am-7pm?  :293  │ │
  │  │ minus: ever-flagged        │               │   no  → held, untouched    │ │
  │  │ minus: ever-nudged         │               │   yes → for (n of pending) │ │
  │  │ = fresh, oldest-end-first  │               │        ONE model call each │ │
  │  │ slice(0, 5)      :564      │               │        462 in / 66 out     │ │
  │  │   reachable? → createNudge │               │        markNudgeQueued     │ │
  │  │   else       → flagGap     │               └────────────────────────────┘ │
  │  └────────────────────────────┘                                              │
  └──────────────────────────────────────────────────────────────────────────────┘
                    pending ──────────────────────► queued
                                                       │
        ┌──────────────────────────────────────────────┘
        │  GET /control/nudges  (host token; cross-tenant by host, by design)
        ▼
  buildNudgeDelivery(hostId)                nudge-runner.sh, every 5 min on the box
    liveness RE-checked at serve time         1. traj_has_text? → already delivered, re-ack
    serve_count += 1 BEFORE shipping :91      2. stage body to /tmp/nudge-<sid>.txt IN sandbox
    → { id, sandboxRef, replyTo,              3. nemoclaw <ref> agent --message-file --deliver
        sessionId: `nudge-<id>`  :97,         4. verdict = assistant TEXT in TRAJECTORY
        messageB64               :98 }        5. POST outcome
        ▼
  completeNudgeDelivery → markNudgeAsked (sets asked_at)  ──► status 'asked'
```

### How a nudge closes — and why this is the crux for batching

The sweep runs inside `runWatchers` **before** routing, over `openNudges` read at
[watchers.ts:293-297](../src/jobs/watchers.ts#L293-L297). Three exits, checked in this order per
row ([watchers.ts:417-458](../src/jobs/watchers.ts#L417-L458)):

```
for each open nudge (pending|queued|asked):
  1. hasActivitySince(x.jobId, x.startsAtLocal)  ──► 'answered'   :418-427
  2. visit status ∈ {cancelled, completed}       ──► 'cancelled'  :428-438
  3. status=='asked' AND asked_at <= now-48h     ──► escalations  :439-446
  4. status∈{pending,queued} AND created_at <= now-24h ──► expired :452-457
```

`hasActivitySince` is defined at [watchers.ts:346-347](../src/jobs/watchers.ts#L346-L347):

```js
const hasActivitySince = (jobId, startsAtIso) =>
  (latestByJob.get(jobId) ?? -Infinity) >= minuteFloor(startsAtIso);
```

**It is keyed on `jobId`, not on the nudge's subject.** `latestByJob` accumulates the latest
capture time and the latest visit-creation time per job
([watchers.ts:335-340](../src/jobs/watchers.ts#L335-L340)). The practical consequence for the
partial-answer behaviour the plan must assert: *whether one answer closes one nudge or several
depends entirely on whether the batched nudges share a `jobId`.* Three nudges on three different
jobs → one answer closes exactly one, the other two keep their own clocks. Two nudges on the
**same** job → a single field note closes **both**, because any capture on that job after the
visit start satisfies the predicate for both rows.

### The escalation clock, and where a rider would lose it

`asked_at` is written in exactly one place —
[nudges.ts:197-208](../src/db/nudges.ts#L197-L208), `markNudgeAsked`, a conditional UPDATE
guarded `status = 'queued'`:

```js
.update({ status: 'asked', asked_at: new Date().toISOString() })
.eq('status', 'queued')
```

and it is reached from exactly one caller,
[nudgeQueue.ts:131](../src/control/nudgeQueue.ts#L131), on a `delivered` report for **one id**.
The 48h escalation at [watchers.ts:439-443](../src/jobs/watchers.ts#L439-L443) reads
`x.n.status === 'asked' && x.n.asked_at`. A rider row that never passes through
`queued → asked` therefore satisfies neither half of that condition: it never escalates. It would
instead fall to the 24h expiry branch at :452-457 (`pending|queued` + `created_at` old enough),
which flags the manager with the **Stage-0 "never delivered" copy** and marks the row `failed` —
so an un-stamped rider does not vanish silently, but it reaches the manager with copy asserting
the ask never landed, 24h after creation rather than 48h after asking. That is the concrete shape
of the failure the design note warns about.

## External Dependencies

Nothing new. Postgres via the typed Supabase layer; `src/model/forcedTool.ts` for the single
compose call (GLM-5.2 via whatever `MODEL_PROVIDER` selects); `nemoclaw`/`openshell` on the box;
`curl` + `jq` in the runner. No scheduler beyond Render cron and the box's systemd timers.

## Constraints and Invariants

1. **Four hardcoded `'overdue_visit_gap'` filters.** Creation [watchers.ts:598](../src/jobs/watchers.ts#L598); the resolve/escalate sweep [watchers.ts:295](../src/jobs/watchers.ts#L295); the compose read [compose.ts:289](../src/teamLead/compose.ts#L289); `flagOverdueVisitGap` [reviewItems.ts:164](../src/db/reviewItems.ts#L164). **The sweep filter is the dangerous one**: a nudge of a new kind is invisible to it, so it can never be answered, cancelled, escalated, or expired — it stays open forever with no surface. Nothing errors; the row simply sits.
2. **`nudges.kind` is typed `ReviewKind`** ([nudges.ts:27](../src/db/nudges.ts#L27)). A new kind is a TypeScript union edit in [reviewItems.ts:10-59](../src/db/reviewItems.ts#L10-L59), not a migration — the DB column is plain `text`.
3. **`uq_nudges_subject_ever unique (tenant_id, kind, subject_ref)`** ([nudges.sql:55-56](../supabase/migrations/20260817090000_nudges.sql#L55-L56)) — deliberately not partial. Its stated rationale is *"an assignment's end never recurs, so re-asking is never right."* **That rationale is assignment-specific and does not transfer to a job-scoped subject**: a job accrues costs repeatedly, so once-ever on `(tenant, cost_kind, jobId)` means the second material purchase on a job can never be asked about.
4. **One compose call per nudge, one delivery per nudge.** `for (const n of pending)` [compose.ts:299](../src/teamLead/compose.ts#L299); `for (const row of rows)` [nudgeQueue.ts:72](../src/control/nudgeQueue.ts#L72); `while read -r item` [nudge-runner.sh:92](../Box_Setup_Stuff/nudge-runner.sh#L92). No stage groups.
5. **`sessionId` is `nudge-<row.id>`** ([nudgeQueue.ts:97](../src/control/nudgeQueue.ts#L97)) — one fresh session per nudge row (decision D6: id reuse resumes stale conversations). A carrier would deliver in the carrier's session; riders have no session of their own.
6. **The ask window gates COMPOSE, not the outbox** ([compose.ts:79-91](../src/teamLead/compose.ts#L79-L91)). Out-of-window rows are held untouched — no model call, no attempts, no state change. The reason is that `relativeDayPhrase` bakes "earlier today"/"yesterday" into the question at composition time. **Consequence for verification: no live delivery test is possible outside 7am–7pm firm-local.**
7. **The 24h delivery deadline must stay longer than the longest window hold** ([watchers.ts:104-110](../src/jobs/watchers.ts#L104-L110)) — 12h, or 13h on a DST fall-back night. The comment states explicitly that a window excluding whole days must lengthen this constant.
8. **Serve counting happens before shipping** ([nudgeQueue.ts:91](../src/control/nudgeQueue.ts#L91)), at-most-N-serves even if the response is lost; `MAX_SERVE_COUNT = 10` then hands to the manager and fails the row.
9. **Terminal-failure doctrine**: every path that fails a nudge without the ask landing calls `handToManager` FIRST, then closes the row ([compose.ts:157-205](../src/teamLead/compose.ts#L157-L205), and at :309, :335, :366; [nudgeQueue.ts:80](../src/control/nudgeQueue.ts#L80), :141). Rows too thin even to flag are **frozen** (logged, left pending), never cancelled.
10. **`nudges` has no append-only trigger** — only `set_updated_at` ([nudges.sql:47-49](../supabase/migrations/20260817090000_nudges.sql#L47-L49)). `created_at` and `asked_at` are code-writable, which is what makes a synthetic-timestamp plant a viable test (and is how the Stage-1 escalation regression was run).
11. **The resolve sweep runs regardless of `NUDGES_MODE`** ([watchers.ts:280-297](../src/jobs/watchers.ts#L280-L297)) but only in `mode === 'live'`. Only rung-1 *creation* is nudge-mode-gated — deliberate, so a rollback cannot strand in-flight rows.
12. **Delivery verdict is trajectory text, never CLI stdout** ([nudge-runner.sh:72-90](../Box_Setup_Stuff/nudge-runner.sh#L72-L90)); the file's own comment records that stdout "is chrome and has rotted before."
13. **`--message-file`, not `-m`** ([nudge-runner.sh:132-149](../Box_Setup_Stuff/nudge-runner.sh#L132-L149)): `openshell exec` rejects any argv containing a newline, and the deliverable is multi-line by construction. The comment states the lesson verbatim: *"Single-line test messages hide this bug — always exercise a real one."*
14. **The gateway's conversation-context block is *selected*, not complete** — recorded at [the Stage-1 plan's D6 resolution](../thoughts/shared/plans/2026-08-15-feature-B-intelligent-spine-stage1-voice.md#L602-L616) as an explicit *"Caveat for batching."* Reply continuity works because the gateway compiles Telegram chat history into each turn, but it selects what to include.
15. **Two-touch ceiling**: tech's agent, then manager, never a third.
16. **`idx_nudges_budget (tenant_id, technician_id, created_at desc)`** ([nudges.sql:61](../supabase/migrations/20260817090000_nudges.sql#L61)) now serves no query — its only reader, `countRecentAsks`, was deleted on this branch's parent commit.

### Stale comments left by the cap removal (found while reading; not fixed here)

Three sites in `watchers.ts` still describe the deleted per-person budget as live behaviour:
[:72](../src/jobs/watchers.ts#L72) *"reachable and their budget allows"*;
[:560-563](../src/jobs/watchers.ts#L560-L563) *"reachable within budget … A budget-exhausted gap
takes NEITHER path: it stays fresh and retries when the rolling window frees a slot"*;
[:590-592](../src/jobs/watchers.ts#L590-L592) *"Counted BEFORE budget (shadow creates nothing, so
the budget read would always say 0 anyway)"*. Note [:354](../src/jobs/watchers.ts#L354) *("burn a
cap slot")* is **not** stale — it refers to `MAX_NEW_ITEMS_PER_TENANT_TICK`, which stays.

## Decision Points

**1. Where the planner runs.** Step 8 and step 9 are separate functions in one cron process
([lifecycle.ts:347](../src/jobs/lifecycle.ts#L347), :370). A planner can be (a) a third step
between them, reading `pending` rows and annotating/grouping them; (b) a pre-write stage inside
`runWatchers` before `createNudge`; or (c) a pre-read stage at the head of `runTeamLeadCompose`.
(a) and (c) see all pending rows across kinds and detectors, including ones left over from earlier
ticks; (b) sees only this tick's fresh gaps for one detector and would have to re-derive
cross-kind state. Today nothing sits between them.

**2. Whether a carrier is a `nudges` row or a new table.** A carrier as a `nudges` row inherits
status/lifecycle/transport for free but must satisfy `uq_nudges_subject_ever (tenant, kind,
subject_ref)` — it needs a synthetic `subject_ref` that cannot collide and cannot recur. A
separate `nudge_batches` table keeps `nudges` semantics clean but re-earns the host-scoped pull,
the serve/ack counters, and the terminal-failure doctrine. Either way the rider→carrier link is a
new column or table; `nudges` has no self-reference today.

**3. How riders get `asked_at`.** Today the only writer is `markNudgeAsked`, guarded
`status = 'queued'` and reached per-id from a `delivered` report ([nudgeQueue.ts:131](../src/control/nudgeQueue.ts#L131)).
Options: extend `completeNudgeDelivery` to stamp the carrier's riders in the same call; give
riders a `queued` status and a group-scoped `markGroupAsked`; or stamp riders at carrier-compose
time (which would start their clocks before delivery). The first two keep "asked means delivered"
true; the third breaks it.

**4. Whether the once-ever index survives a job-scoped subject.** Constraint 3 above. Options:
keep once-ever and accept that only the first cost gap per job is ever asked; make the subject
finer-grained so it recurs legitimately (e.g. `jobId:visitId` or `jobId:<period>`); or make the
index partial on open statuses for the new kind only, which changes the "ask once, ever" guarantee
that the current comment calls *a database guarantee, not a promise*.

**5. How the resolve sweep generalises.** Constraint 1. The sweep's three predicates are all
`overdue_visit_gap`-shaped (activity-since-visit-start, visit status, context carrying
`jobId`/`startsAtLocal`). A cost gap's "filled" test is a different question — does a cost event
now exist for this job — so either the sweep grows a per-kind predicate table, or each detector
brings its own sweep. Choosing neither leaves new-kind rows open forever (silently).

**6. Where the per-detector brake lives.** Nothing counts nudges per kind today. It can be a
count over `nudges` filtered by `(tenant, kind, created_at > …)` before creation (the shape
`countRecentAsks` had, which is why `idx_nudges_budget` still fits), or a per-tick slice like
`MAX_NEW_ITEMS_PER_TENANT_TICK` applied per kind, or a detector-declared constant checked in its
own routing branch. The deleted counter was per **person**; the ratified replacement is per
**detector**, so it does not re-create the bottleneck the user removed.

## Open Questions

- **Does the receiving agent handle three questions in one message as well as one?** Constraint 14
  says the gateway's context block is *selected, not complete*, and the footer at
  [compose.ts:224-240](../src/teamLead/compose.ts#L224-L240) instructs the agent to record the
  answer with `record_field_note` — singular. Only a live test with a real three-question payload
  answers this; it cannot be read off the code.
- **Does a batched carrier's longer payload survive the transport unchanged?** The `--message-file`
  path is length-agnostic in principle, but the one bug that made delivery fail 100% was a payload
  *shape* bug that every single-line test missed ([nudge-runner.sh:132-141](../Box_Setup_Stuff/nudge-runner.sh#L132-L141)).
- **Whether `serve_count`/`attempts` semantics need a group notion.** `MAX_SERVE_COUNT` and
  `MAX_DELIVERY_ATTEMPTS` are per row; a carrier failing delivery would burn its own counters while
  riders' counters stay at zero.
- **What "cost recorded" means as a SQL predicate.** No cost event kinds exist yet
  ([money_events enum](../supabase/migrations/20260815160000_money_events.sql#L12-L25) is 12
  revenue/AR kinds), so the cost detector's *detection* query and its *resolve* predicate both
  depend on a schema decision made in the job-costing research, not in this one.
- **Whether the pilot has enough real volume to exercise batching at all.** The pilot has one
  nudgeable seat and roughly one gap per day; a batch of three may not occur naturally, which
  affects whether the live E2E can be observed or must be staged.
