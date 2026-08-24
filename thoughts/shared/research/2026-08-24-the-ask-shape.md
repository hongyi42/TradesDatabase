---
date: 2026-08-24
branch: main
commit: 2937099
topic: The ask shape — batching several gaps into one message, follow-up asking on the response leg, and the attribution that must survive both
supersedes: nothing
---

**`supersedes:` note:** this overturns nothing. It documents the surface left standing after the
one-call collapse (PR #179, merged 2026-08-24) and answers four questions asked against it. One
claim made verbally earlier in the session — "the delivered question is anonymous to the seat
agent" — was already false at this commit; see [The anchor](#the-anchor-is-the-job-level-link)
below. That claim was never written to a document, so there is nothing to supersede.

## Summary

When the office notices something missing from a job's record — nobody wrote up the visit, no
parts cost was ever entered — it opens a **gap** (a row in the `nudges` table). Twice an hour a
single model call, the **planner**, looks at every open gap in the firm at once and decides what
to do with each one: ask now, wait, close it, hand it to a manager. Since the collapse, when the
planner decides to ask, it writes the entire message itself and queues it in the same breath;
a script on the technician's phone-box delivers that text word for word.

Everything in that pipeline is keyed to **one gap at a time**. One gap owns one `question`
column; the box sends one message per queued row; a planner decision names exactly one `nudgeId`.
So a job with three holes in its record produces three separate messages. This document maps
what would have to change for one message to cover several gaps, what the technician's own
assistant can and cannot see about those gaps, how the answer gets linked back to the question it
answered, and one verb the collapse left missing.

## Entry Points

| Where | File | What begins here |
|---|---|---|
| Gap is opened | [watchers.ts](src/jobs/watchers.ts) via `createPendingNudge` ([nudges.ts:38](src/db/nudges.ts#L38)) | a detector notices a hole; row starts `pending` |
| Gap is decided | [planner.ts:1252](src/teamLead/planner.ts#L1252) `runPlanner` | the half-hourly model call |
| Decision is applied | [planner.ts:1161](src/teamLead/planner.ts#L1161) `applyDecision` | `send` queues the message |
| Message is delivered | [nudgeQueue.ts:70](src/control/nudgeQueue.ts#L70) `buildNudgeDelivery` | the box's 5-minute pull |
| Delivery is acked | [nudgeQueue.ts:132](src/control/nudgeQueue.ts#L132) `completeNudgeDelivery` | `queued` → `asked` |
| Answer is recorded | [server.ts:2012](src/mcp/server.ts#L2012) `attributeAnswerToGap` | the capture↔gap stamp |
| Gap expires undelivered | [watchers.ts:826](src/jobs/watchers.ts#L826) | the 18h never-asked sweep |

## Key Files

- **[src/teamLead/planner.ts](src/teamLead/planner.ts)** (1719 lines) — the only model call in the
  ladder. Exports `buildGapView`, `validateDecisions`, `buildPlannerUserMessage`, `anchorLine`,
  `cleanQuestionDraft`, `cleanHandoffNote`, `cleanAgentContext`, `runPlanner`, `PLANNER_ACTIONS`,
  `UNMENTIONED`, `EVIDENCE_PER_GAP`, `EVIDENCE_TEXT_CHARS`, `MIN_CITATION_CHARS`,
  `MIN_CITATION_WORDS`, `UNMENTIONED_CAP`.
- **[src/teamLead/plannerPrompt.ts](src/teamLead/plannerPrompt.ts)** (298 lines) — `PLANNER_SYSTEM`
  and `SUBMIT_PLAN_TOOL`, the JSON schema every decision must satisfy.
- **[src/db/nudges.ts](src/db/nudges.ts)** (391 lines) — every read and write of the `nudges`
  table. Note `OPEN_NUDGE_STATUSES`, `markNudgeQueued`, `markNudgeAsked`, `setNudgeSchedule`,
  `listAskedNudgesForTechnicianJob`, `setNudgeAnsweredBy`.
- **[src/control/nudgeQueue.ts](src/control/nudgeQueue.ts)** (170 lines) — the transport. Exports
  `buildNudgeDelivery`, `completeNudgeDelivery`, `MAX_SERVE_COUNT` (10),
  `MAX_DELIVERY_ATTEMPTS` (3), and the `NudgeDeliveryItem` shape.
- **[src/jobs/watchers.ts](src/jobs/watchers.ts)** (1271 lines) — the 5-minute sweep. Owns
  `NUDGE_DELIVERY_DEADLINE_HOURS` (18), `NUDGE_ESCALATE_HOURS`, `NUDGE_ESCALATE_MAX_HOURS`,
  `PLANNER_SILENCE_HOURS` (24), `PLANNER_JUDGMENT_ACTIONS`.
- **[src/mcp/server.ts](src/mcp/server.ts)** — the tool surface and the three tier gates
  ([2303](src/mcp/server.ts#L2303), [2311](src/mcp/server.ts#L2311),
  [2324](src/mcp/server.ts#L2324)); `attributeAnswerToGap` at
  [2012](src/mcp/server.ts#L2012); `commitNote` at [2038](src/mcp/server.ts#L2038).
- **[src/jobs/summarize.ts](src/jobs/summarize.ts)** — ⑤'s gap summaries; copies
  `answered_by_capture_id` onto each summary row ([162](src/jobs/summarize.ts#L162)).
- **[src/eval/plannerCorpus.ts](src/eval/plannerCorpus.ts)** — the 65 scenarios, including
  `twoGapWorld` and the eight `multi-gap` scenarios (MG-01…MG-08, lines 689–790).
- **[src/eval/plannerSim.ts](src/eval/plannerSim.ts)** — `runArc`; the timeline executor.
- **[Box_Setup_Stuff/bootstrap-box.sh](Box_Setup_Stuff/bootstrap-box.sh)** (~line 1018) — writes
  the §0k "Questions and items from the office" doctrine into every seat's `AGENTS.md`.
- **[Box_Setup_Stuff/nudge-runner.sh](Box_Setup_Stuff/nudge-runner.sh)** — the box-side delivery
  loop.

Migrations: `20260817090000_nudges.sql` (table), `20260819150000_nudge_deadlines.sql`
(`not_before`, `escalate_after`), `20260820120000_nudge_decisions.sql` (decision log),
`20260822120000_nudge_answered_by.sql` (the stamp), `20260823120000_planner_read_surface.sql`
(`v_nudges` et al), `20260823230000_planner_metrics_views.sql` +
`20260824020000_planner_metrics_v2.sql` (`closed_by_technician`),
`20260824000000_gap_summaries.sql`.

## Data Flows

### One gap, end to end

```
 detector           planner (½-hourly)          box (5-min pull)        technician
────────────────────────────────────────────────────────────────────────────────────
 createPendingNudge
   status=pending ──────► buildGapView → one text block per gap
                          submit_plan {nudgeId, action:'send', question}
                          validateDecisions → cleanQuestionDraft
                          applyDecision:
                            markNudgeQueued(id, `${question}${anchorLine(row)}`)
                            status=queued ──────► buildNudgeDelivery
                                                    one item per queued row
                                                    directMessageB64 ──────► message
                                                  completeNudgeDelivery
                                                    markNudgeAsked
                                                    status=asked
                                                                          ◄──── reply
 record_field_note ◄───────────────────────────────────────────────────────────┘
   commitNote → attributeAnswerToGap
     exactly 1 gap in status 'asked' for (tech, job) → setNudgeAnsweredBy
     2 or more → stamp nothing
                        ◄── next tick: buildGapView shows the note as evidence
                          submit_plan {nudgeId, action:'close', basis:'evidence', citation}
                          applyDecision → markNudgeOutcome('answered')
```

### Where "one" is hard-coded

Five independent places, each on its own:

1. **The column.** `nudges.question text` — one message text per row
   ([20260817090000_nudges.sql](supabase/migrations/20260817090000_nudges.sql)).
2. **The queue write.** `markNudgeQueued(id, tenantId, question)` moves exactly one row
   `pending → queued`, guarded `.eq('status','pending')` ([nudges.ts:98](src/db/nudges.ts#L98)).
3. **The serve loop.** `buildNudgeDelivery` iterates `listQueuedNudgesForHost(hostId)` and pushes
   one `NudgeDeliveryItem` per row, with `sessionId: nudge-${row.id}`
   ([nudgeQueue.ts:82-117](src/control/nudgeQueue.ts#L82-L117)).
4. **The ack.** `completeNudgeDelivery(hostId, id, report, …)` takes one id and calls
   `markNudgeAsked(row.id, row.tenant_id)` — one row `queued → asked`
   ([nudgeQueue.ts:132](src/control/nudgeQueue.ts#L132)).
5. **The decision schema.** `SUBMIT_PLAN_TOOL` requires `nudgeId` (singular) on every entry;
   `validateDecisions` refuses "a second decision for the same gap" and looks each up in a
   `Map<string, GapView>` ([plannerPrompt.ts:214](src/teamLead/plannerPrompt.ts#L214),
   [planner.ts:830-843](src/teamLead/planner.ts#L830-L843)).

There is **no per-tick cap** on how many decisions one plan may contain, and no cap on how many
`send` decisions may be applied in one tick. N gaps on a job therefore already produce N queued
rows and N messages, all within seconds of each other.

### The anchor is the job-level link

`anchorLine(n)` ([planner.ts:757](src/teamLead/planner.ts#L757)) builds `"\n\n(re: customer — job)"`
from `context.customerName` / `context.jobTitle`, and `applyDecision` appends it to the planner's
text at queue time: `markQueued(d.nudgeId, tenantId, \`${d.questionDraft}${anchor}\`)`
([planner.ts:1183](src/teamLead/planner.ts#L1183)). It is code-printed, never model-written, and
returns `''` when the row cannot name itself — a thin row ships bare rather than with a fabricated
anchor.

The receiving half is standing box doctrine, written into every seat's `AGENTS.md` by
`bootstrap-box.sh`:

> 1. When the person answers an office question — even "nothing to report" or "no parts" —
>    record the answer with record_field_note **for the job the "(re: …)" line names** […] and
>    never re-ask a question the office already asked and the person already answered.
> 2. Open items in the office's review queue (list_pending_reviews, **where you have it**) may
>    carry `agentContext` […]
> 3. If you cannot tell which open question or item a person's reply answers, **ask them** —
>    never guess which record to close.

So the delivered question carries a **job-level** identifier that the seat agent is instructed to
key on. It carries no gap-level identifier, and the doctrine's own hedge — "where you have it" —
acknowledges that clause 2 does not apply to technician seats.

### What the seat agent can see

Three tier gates, all in `dispatch` and all applied by tool NAME:

| Gate | Line | Effect |
|---|---|---|
| `spine:` identity capped to `TEAM_LEAD_TOOL_NAMES` | [2303](src/mcp/server.ts#L2303) | the planner may only call `spine_read`, `recall_decisions` |
| `TEAM_LEAD_ONLY_TOOL_NAMES` refused to non-`spine:` badges | [2311](src/mcp/server.ts#L2311) | **a technician cannot call `spine_read`** |
| `ADMIN_TOOL_NAMES` require `activeManager` | [2324](src/mcp/server.ts#L2324) | `query_spine`, `list_pending_reviews` are manager-only |

The technician surface is the `TOOLS` array,
[server.ts:266-629](src/mcp/server.ts#L266-L629) — fourteen tools:

```
record_field_note  find_customer  get_customer_context  get_job  resolve_date
list_recent_captures  brief_customer  answer_customer_question  get_schedule
web_search  read_webpage  send_email  retract_capture  record_standing_fact
```

None of them reads the `nudges` table. `v_nudges` exists
([20260823120000_planner_read_surface.sql:78](supabase/migrations/20260823120000_planner_read_surface.sql#L78))
and does expose `question`, `status`, `job_id`, `answered_by_capture_id` — but it is scoped by
`current_setting('spine.tenant_id')` and is reachable only through `spine_read` (team lead) or
`query_spine` (manager). A technician badge has no path to it.

**Consequence:** the seat agent can look up the job the anchor names (`get_job`,
`get_customer_context`, `list_recent_captures`), but it cannot discover that the job has other
open questions, cannot enumerate the questions asked of its own technician, and is told by its
own doctrine to ask the person rather than guess when it cannot tell which question a reply
answers.

### Attribution, and everything that reads it

`attributeAnswerToGap` ([server.ts:2012-2033](src/mcp/server.ts#L2012-L2033)) runs inside
`commitNote`, the one commit shared by all three field-note paths
([server.ts:2431](src/mcp/server.ts#L2431), [2585](src/mcp/server.ts#L2585),
[2636](src/mcp/server.ts#L2636)):

```js
if (!technicianId || !jobId) return;
const open = await listAskedNudgesForTechnicianJob(tenantId, technicianId, jobId);
if (open.length !== 1) return;          // 2 or more → stamp nothing
await setNudgeAnsweredBy(open[0].id, tenantId, captureId);
```

`listAskedNudgesForTechnicianJob` filters `status = 'asked'` **alone**, not
`OPEN_NUDGE_STATUSES`, and scopes by `technician_id` and `context->>jobId`
([nudges.ts:337](src/db/nudges.ts#L337)). The header records why the narrower read was chosen:
a `pending` gap could otherwise claim a routine note as its answer before anyone was asked, and
the stamp is first-write-wins. `setNudgeAnsweredBy` guards `.is('answered_by_capture_id', null)`
and is deliberately **not** status-guarded — stamping a just-closed gap is wanted, because that
is the audit trail for why it closed. The whole helper swallows its errors: "a lost link is a
lost link", and attribution must never fail a write that landed.

Six consumers of `answered_by_capture_id`:

| Consumer | Where | Use |
|---|---|---|
| Gap view marker | [planner.ts:446-447](src/teamLead/planner.ts#L446-L447), [581](src/teamLead/planner.ts#L581) | prints `<-- LINKED TO THIS GAP` on the matching evidence line |
| `sharesJob` warning wording | [planner.ts:551-560](src/teamLead/planner.ts#L551-L560) | narrows the shared-evidence warning; never switches it off |
| Gap summaries (⑤) | [summarize.ts:162](src/jobs/summarize.ts#L162) | copied onto each `gap_summaries` row |
| `gap_summaries` column | [20260824000000_gap_summaries.sql:37](supabase/migrations/20260824000000_gap_summaries.sql#L37) | stored |
| `mv_gap_outcomes.closed_by_technician` | [20260824020000_planner_metrics_v2.sql:37](supabase/migrations/20260824020000_planner_metrics_v2.sql#L37), [20260823230000_planner_metrics_views.sql:52](supabase/migrations/20260823230000_planner_metrics_views.sql#L52) | `(answered_by_capture_id is not null)` — the metric's whole definition |
| `v_nudges` | [20260823120000_planner_read_surface.sql:90](supabase/migrations/20260823120000_planner_read_surface.sql#L90) | exposed to the planner through `spine_read` |

### The close path, and the quote→capture alignment

`validateDecisions` checks an evidence-basis close in this order
([planner.ts:958-991](src/teamLead/planner.ts#L958-L991)): citation non-empty → at least
`MIN_CITATION_CHARS` (12) and `MIN_CITATION_WORDS` (2) → **findable in `view.evidenceText`** →
not already used by another close in this plan (`usedQuotes`).

The alignment asked about does hold, but only *inside* `buildGapView`:

```js
// planner.ts:435-439
const relevant = evidence.filter(e => e.jobId === jobId && …).slice(-EVIDENCE_PER_GAP);
const evidenceText = relevant.map(e => flat(e.capture.raw_text ?? '', EVIDENCE_TEXT_CHARS));
```

`evidenceText[i]` is exactly `relevant[i].capture.raw_text`, flattened and truncated, and
[line 581](src/teamLead/planner.ts#L581) already indexes the two together to print capture ids.
But the `GapView` interface ([planner.ts:330-345](src/teamLead/planner.ts#L330-L345)) exports
`evidenceText: string[]` and **not** `relevant` — the capture ids are dropped at the struct
boundary. `validateDecisions` therefore sees strings only, and its check is
`shown.some(text => text.includes(wanted))` — a boolean, not an index.

The `usedQuotes` rail is **per-plan, per-quote, not per-note**: two distinct quotes drawn from
the same capture close two gaps in one tick without objection. Its comment states the intent —
"this does not make a single wrong close impossible, but it stops one note from closing every
open gap on a job".

### What the corpus actually covers

`twoGapWorld` ([plannerCorpus.ts](src/eval/plannerCorpus.ts)) seeds **both** gaps at
`status: 'asked'`, `createdAt: '-24h'`, `askedAt: '-23h'`, each with its own pre-written
`question` ("How did the … go?" and "What did it run in parts?"). Every MG scenario therefore
begins *after* two separate asks have already gone out. The `send` verb is never exercised on a
multi-gap job anywhere in the `multi-gap` family; the arc expectations are about closing
(`maxCloses`, `minCloseTicks` — "the cross-credit catch: two gaps closed off one note in one
tick").

The timeline executor writes captures **directly into `raw_captures` via Supabase**
([plannerSim.ts:679-691](src/eval/plannerSim.ts#L679-L691)), bypassing `record_field_note`
entirely. `attributeAnswerToGap` therefore **never runs in the eval**, and no corpus gap is ever
stamped.

Observed Opus behaviour in `spine-eval-runs/agentic-opus-2026-08-24T10-28-33-080Z/`, all eight
MG scenarios, one decision per gap in every tick:

| Scenario | Decisions | Note |
|---|---|---|
| MG-01 | `close` + `extend` | closed the visit gap, extended the cost gap |
| MG-02 | `close` + `extend` | mirror image |
| MG-03 | `close` + `extend` | one close only, as the rail intends |
| MG-04 | `close` (record) + `extend` | ledger closed cost, visit extended |
| MG-05 | `extend` + `extend` | both past deadline, neither escalated |
| MG-06 | 3 ticks: `leave`+`extend` → `close`+`leave` → `close` | the two-note arc, closes on distinct ticks |
| MG-07 | `close` + `extend` — **FAILED** (`arc-closes: 1 applied close(s), max 0`) | cross-credited on a vague note |
| MG-08 | `close` + `close` | **two gaps closed in one tick from two distinct notes** |

`extend` is the dominant verb on the still-open sibling — six of eight scenarios — and the
reasons are explicitly about pacing ("give him the working day", "the ask spanned a Sunday", "a
parts figure blocks the books without decaying"). MG-07's reason cites "note is stamped directly
to this job"; since the harness never stamps, that phrase does not correspond to anything the
block contained.

## External Dependencies

- **Supabase / PostgREST** — every nudge read and write goes through `getClient()`. Two
  PostgREST behaviours are load-bearing and commented as such: `.in('status', [])` errors on an
  empty list ([nudges.ts:59](src/db/nudges.ts#L59), [80](src/db/nudges.ts#L80)), and
  `.eq(col, null)` matches zero rows so `.is(col, null)` is mandatory
  ([nudges.ts:356-361](src/db/nudges.ts#L356-L361)).
- **The model provider** via `runToolLoop` ([src/model/toolLoop.ts](src/model/toolLoop.ts)) with
  `PLANNER_MAX_TOKENS = 8192`, `PLANNER_REASONING = 'low'`, terminal tool `submit_plan`.
- **OpenClaw on the box** — `openclaw message send`, driven by
  [Box_Setup_Stuff/nudge-runner.sh](Box_Setup_Stuff/nudge-runner.sh) on a 5-minute systemd timer.
- **Telegram** — `technicians.telegram_user_id` is the `replyTo` on every delivery item.

## Constraints and Invariants

1. **`uq_nudges_subject_ever (tenant_id, kind, subject_ref)`** — ask once per subject, EVER,
   deliberately not partial. `createPendingNudge` treats 23505 as "already considered". Grouping
   several gaps into one message does not touch this: each gap keeps its own subject.
2. **A question-less queued row is treated as tampered.** `if (!row.question) continue;` —
   "queued implies composed; tampered row stays frozen"
   ([nudgeQueue.ts:88](src/control/nudgeQueue.ts#L88)). The row is never served, never fails,
   and is re-read on every 5-minute pull.
3. **The delivery item is keyed one-to-one on the row**, including
   `sessionId: nudge-${row.id}` ([nudgeQueue.ts:112](src/control/nudgeQueue.ts#L112)).
4. **Every state move is a status-guarded conditional UPDATE** returning null when the row moved
   under the caller — `markNudgeQueued` (pending), `markNudgeAsked` (queued),
   `setNudgeServeCount`/`setNudgeDeliveryAttempts` (queued), `setNudgeSchedule` (open statuses by
   default, narrowed per call site). A null return must never be recorded as `applied`.
5. **The escalation clock starts at `asked_at`**, per row. `currentDeadlineMs` reads
   `escalate_after` if parseable, else `asked_at + NUDGE_ESCALATE_HOURS`.
6. **`hold` clamps to `created_at + 18h`** (`holdCeilingMs`) — a longer hold would convert the
   gap into a manager item captioned "never delivered".
7. **`not_before` is now the planner's own pacing note and nothing else.** The comment at
   [planner.ts:855-860](src/teamLead/planner.ts#L855-L860) records that the delivery pull does not
   read it; `buildNudgeDelivery` has no `not_before` predicate.
8. **The ask window is 7am–7pm firm-local** (`insideAskWindow`, still exported from
   `compose.ts`), applied to the whole tenant: outside it, the planner call is skipped entirely
   ([planner.ts:1325](src/teamLead/planner.ts#L1325)). The 18h delivery deadline is sized around
   that window with ~5h of margin — the header warns that any window change that ever excludes
   whole days must lengthen the deadline first.
9. **Attribution is fail-closed and silent at 2+.** It also never throws.
10. **`answered_by_capture_id` is first-write-wins with no FK.** A retracted capture's marker
    disappears from the evidence reader while the slot stays taken.
11. **`PLANNER_JUDGMENT_ACTIONS` must list every planner verb.** A new verb not added there stops
    counting as liveness and the 24h fail-safe starts firing under a working planner
    ([watchers.ts:188](src/jobs/watchers.ts#L188)). A test pins the pair.
12. **`nudge_decisions.action` is CHECK-constrained** and `recordNudgeDecisions` inserts one
    statement per chunk with no partial insert — one un-migrated action value rejects up to 500
    decisions at once. Every past verb addition shipped its migration first.
13. **`UNMENTIONED` is unwritable by the model** by construction, and `UNMENTIONED_CAP` is 200.
14. **Citations are checked against the truncated text** (`EVIDENCE_TEXT_CHARS = 600`,
    `EVIDENCE_PER_GAP = 6`), never the full row — "a valid-looking quote from unseen text would
    pass" otherwise.
15. **`send` and `hold` are refused on any row that is not `pending`**; `leave` is refused on
    `pending`; `escalate` and `extend` are refused unless `asked`; `escalate` is additionally
    refused when `sweepLive` is false.

## Decision Points

### 1. Where a grouped message's text lives

A group needs one text shown to one person. Two shapes are consistent with what exists:

- **Lead row carries the text, siblings carry a pointer.** One row keeps `question`; the others
  hold a group id and a null `question`. Consequence: the serve loop's
  `if (!row.question) continue` currently classifies exactly this row as tampered and freezes it,
  so that branch would have to distinguish "rides with a lead" from "broken" — and the frozen-row
  doctrine it implements is the only thing standing between a malformed row and an infinite
  re-serve loop.
- **Every row carries the same text, dedup at serve time.** No null-question rows, so the
  tamper branch is untouched; instead `buildNudgeDelivery` must collapse rows sharing a group id
  into one `NudgeDeliveryItem`, and pick which row's id becomes the item id and the `sessionId`.

### 2. What the box acks

`completeNudgeDelivery(hostId, id, …)` moves one row. With a group, one ack has to move several,
which is a choice between:

- **Ack the group.** `markNudgeAsked` becomes group-aware; all rows move together and every
  `asked_at` is identical, so all sibling escalation clocks start at the same instant.
- **Ack each row.** The box reports N times for one delivery, or the server expands one report
  into N writes. The `sent-marker` file on the box is per item id
  ([nudge-runner.sh](Box_Setup_Stuff/nudge-runner.sh)), so the box-side half is affected either
  way.

Either way, `MAX_SERVE_COUNT` and `MAX_DELIVERY_ATTEMPTS` are currently per-row counters on rows
that would now share a fate.

### 3. How the decision schema expresses a group

`SUBMIT_PLAN_TOOL` requires `nudgeId` per entry and `validateDecisions` refuses two decisions for
the same gap. Options visible in the code's own grain:

- **`nudgeIds: string[]` on a `send`.** Every rail that reads `view.nudge.status` would run per
  member; `seen` currently keys on a single id.
- **A separate grouping verb** naming a lead and its followers, leaving `send` singular.
- **Leave the schema alone and group in code** — e.g. by job — which is a policy the planner does
  not choose, and would sit against the stated "build the verb, no policy" rule.

### 4. When attribution happens

Today: at `record_field_note` time, code-side, only when exactly one gap is `asked`. Batching puts
N gaps into `asked` simultaneously, which is exactly the case the stamp declines. The choices:

- **Leave attribution as it is.** Batched asks are unstamped. Six consumers see the difference;
  `mv_gap_outcomes.closed_by_technician` is defined *entirely* as `answered_by_capture_id is not
  null`, so batched gaps would read as not-closed-by-technician regardless of what happened.
- **Derive the stamp from a close's verified quote.** The index alignment exists inside
  `buildGapView` but `GapView` does not export the capture ids, and `validateDecisions` uses
  `.some()` rather than `.findIndex()` — so this is a struct-boundary change plus an index lookup,
  not a new inference. It moves the stamp from record time to close time: a gap that stays open
  would carry no link until the planner acts, where today the link lands immediately.
- **Give the seat agent an attribution tool.** The stamp is first-write-wins on an append-only
  substrate, and the code's own recorded doctrine is "an unattributed answer is a missing link, an
  unattributable one stamped anyway is a lie".

### 5. How the seat agent would learn a sibling gap exists

- **A technician-tier read tool** over `nudges` (or a scoped view). Note `v_nudges` is scoped by
  `current_setting('spine.tenant_id')` and is currently reachable only by the `spine:` identity;
  a technician-tier reader would need its own scoping by `technician_id`, not just tenant.
- **Carry the sibling context on the delivered payload.** `NudgeDeliveryItem` is deliberately
  "exactly what the runner needs and nothing else", and the payload is what gets sent verbatim —
  anything added would either be shown to the person or need a second field the box does not read.
- **Reuse the `agentContext` pattern.** It exists today only on `nudge_decisions` for an applied
  **escalate**, and reaches the manager's agent through `review_items.detail` +
  `list_pending_reviews` — a tool technicians do not have. A technician-side equivalent has no
  carrier today.

Note that §0k doctrine currently instructs the seat agent to "never re-ask a question the office
already asked and the person already answered", and to ask the person rather than guess which
record a reply belongs to. Any follow-up-asking behaviour interacts with both clauses.

### 6. The missing decline verb on a pending row

`send`/`hold` require `pending`; `leave` is refused on `pending`; `escalate` requires `asked`;
`close` requires evidence or a filled record. So a pending gap the planner judges should not be
asked at all has no verb: it waits out the 18h `NUDGE_DELIVERY_DEADLINE_HOURS` and is then handed
to the manager by the expiry sweep with the copy "never delivered — handed to the manager"
([watchers.ts:882](src/jobs/watchers.ts#L882)) — which is the Stage-0 copy, deliberately not the
escalation copy. Any new verb must also be added to `PLANNER_JUDGMENT_ACTIONS` and to the
`nudge_decisions.action` CHECK constraint in a migration that lands before the code.

## Open Questions

1. **Does the box's `sent-marker` scheme tolerate one send acking several ids?** The marker is
   `/var/lib/nudge-runner/sent-<id>`; reading `nudge-runner.sh` end to end (and testing against a
   real box) is the only way to know whether a group ack re-pings.
2. **What happens to `mv_gap_outcomes.closed_by_technician` historically** if attribution moves to
   close time — whether the metric is read anywhere that would silently change meaning, or is only
   ever computed fresh. Not determinable from the view definition alone.
3. **Where MG-07's "note is stamped directly to this job" came from.** The harness never calls
   `attributeAnswerToGap`, so no corpus gap is stamped, and the phrase does not correspond to
   anything `buildGapView` would have rendered. Whether the model invented it or read the
   `sharesJob` warning as a stamp cannot be settled from the results file; the tick's full
   trajectory would be needed.
4. **Whether `insideAskWindow`'s tenant-level skip interacts with grouping.** The planner call is
   skipped for the whole tenant outside 7am–7pm, so no group can be formed then; whether a group
   spanning the window edge is reachable at all is untested.
5. **Whether any seat's `AGENTS.md` has drifted from the §0k block** `bootstrap-box.sh` writes.
   The script refreshes it per run, but per the bootstrap-copy-drift trap the six copies have
   differed before; only an md5 against a live box settles it.
6. **What the technician tier would need for `v_nudges`-style scoping.** The view keys on
   `spine.tenant_id`; a technician read would additionally need `technician_id` scoping, and
   whether the existing session-variable mechanism can carry that is not visible from the
   migration.
