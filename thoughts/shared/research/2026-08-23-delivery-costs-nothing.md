---
date: 2026-08-23
branch: docs/plan4-premise (at origin/main)
commit: 6b4a0dd
topic: "④b delivery costs nothing — how a planner-composed question reaches a person today, and every surface a zero-inference delivery re-wire touches"
supersedes: nothing
---

**`supersedes:` note.** Nothing is overturned; this documents the delivery pipeline as built.
One stale doc claim is flagged below (docs/nemoclaw-tech-agent.md still describes the removed
2-asks/person budget) — that is drift inside an existing doc, not a superseded decision.

## Summary

When the spine (our customer/job database plus its watchers) wants to ask a technician a
question — "how did Friday's visit at the Hendersons go?" — the question text is written on the
spine (by the planner, or by a small dedicated model call named *compose*), stored on a `nudges`
row, and then pulled by the technician's agent box every 5 minutes. The box does **not** simply
send the text to Telegram. It injects the text into the technician's own AI assistant (the "seat
agent") as a message, and the assistant's *reply* is what the technician sees. That relay turn is
a full model call: measured on 2026-08-22, one nudge costs **6 turns and 84,251 uncached input
tokens**, almost all of it the assistant searching for ids the message never gave it. Meanwhile
the deployed openclaw version (2026.6.34) has a CLI command, `openclaw message send`, that posts
a message to the person's channel with **zero inference**, and openclaw already injects recent
channel history into the assistant's next turn — so the assistant would still see the question
when the person replies. ④b is the re-wire from "relay through a model turn" to "send directly";
this document maps everything that re-wire touches: the pipeline, the reply/record path, the
doctrine that must move, the substrate for injecting the planner's reasoning, and the fleet
re-wire mechanics.

## Entry Points

- `src/jobs/lifecycle.ts:308-410` — the cron tick: NUDGES_MODE / PLANNER_MODE gates; planner runs
  BEFORE compose in the same tick (lifecycle.ts:51).
- `src/teamLead/compose.ts:151` (`runTeamLeadCompose`) — pending → queued, question authored.
- `src/control/nudgeQueue.ts:63` (`buildNudgeDelivery`) / `:122` (`completeNudgeDelivery`) — the
  spine side of the transport.
- `src/mcp/httpServer.ts:530-537` — `GET /control/nudges` (pull) and `POST /control/nudges`
  (per-item outcome report), host-token gated.
- `Box_Setup_Stuff/nudge-runner.sh` — the box side: 5-min root systemd timer
  (`nudge-runner.timer`), delivers each item through the seat agent.
- `src/mcp/server.ts:1994` (`attributeAnswerToGap`) — where a recorded reply is stamped onto the
  gap it answered (③).
- `src/mcp/server.ts:7113` (`case 'list_pending_reviews'`) — the manager agent's pull surface and
  the never-relay precedent (:7136, :7160-7161).
- `Box_Setup_Stuff/bootstrap-box.sh:551` (`phase_wire`) — how doctrine reaches a seat's AGENTS.md.

## Key Files

| Path | Role |
|---|---|
| `src/teamLead/compose.ts` | The compose sweep: ask window (7-19 firm-local, :55-56), planner-draft consumption (:212-231, :262-266), the ONE model call (`runForcedTool`, maxTokens 300, effort none), decline→`handToManager` (F1), `markNudgeQueued`. |
| `src/teamLead/composeCopy.ts` | User-ratified copy: `COMPOSE_SYSTEM`/`COST_COMPOSE_SYSTEM`, `relativeDayPhrase` (served phrases), `flatten` (frame-forgery guard), `assembleNudgeMessage` / `assembleCostNudgeMessage` — question + code-printed evidence line + the "Note for the assistant" footer. |
| `src/teamLead/planner.ts` | `PLANNER_ACTIONS` (:62); `send` carries `questionDraft` railed by `cleanQuestionDraft` (:713, applied :1014-1018); `hold` rails against the 18h delivery deadline (:942). |
| `src/db/nudges.ts` | The state machine: pending→queued→asked→answered/escalated/cancelled/failed; `markNudgeQueued` (attempts reset, queued_at), `markNudgeAsked`, `setNudgeServeCount`, `setNudgeDeliveryAttempts`, `listAskedNudgesForTechnicianJob` + `setNudgeAnsweredBy` (③ attribution, first-write-wins via `.is(col,null)`). |
| `src/db/nudgeDecisions.ts` | The decision corpus: `question_draft` (technician-facing, third rail) and `handoff_note` (manager-facing, second rail) live here, insert-only. |
| `src/control/nudgeQueue.ts` | Serve-side: liveness re-filter, `MAX_SERVE_COUNT` 10 (poison brake), `MAX_DELIVERY_ATTEMPTS` 3, serve-count-before-ship, `NudgeDeliveryItem` (id, sandboxRef, replyTo = telegram user id, sessionId `nudge-<id>`, messageB64). |
| `Box_Setup_Stuff/nudge-runner.sh` | Box side: validate → decode → idempotence pre-check (`traj_has_text`) → stage body in sandbox (`--message-file`; `-m` rejects newlines) → `nemoclaw <sref> agent --agent main --session-id nudge-<id> --message-file … --deliver --reply-channel telegram --reply-to <id>` → verdict from TRAJECTORY assistant text, never stdout → report. |
| `src/jobs/watchers.ts` | Detection + sweeps: `MAX_NEW_ITEMS_PER_TENANT_TICK` 5 (:97), no-per-person-cap ruling (:99-110), `NUDGE_ESCALATE_HOURS` 24 (:123), `NUDGE_ESCALATE_MAX_HOURS` 48 (:128), `NUDGE_DELIVERY_DEADLINE_HOURS` 18 (:158), escalation copy takes `handoff_note` never `reason` (:910-921), count-only manager heads-up push (:1240-1253). |
| `src/calls/notify.ts` + `src/telegram/boardBot.ts` | `notifyManagers` → `sendBoardMessage`: plain Telegram Bot API from Render (BOARD_BOT_TOKEN) — an existing **zero-inference push** to managers, on the board bot's channel. |
| `src/db/reviewItems.ts` | `review_items` writers; gap items' `detail` = `{jobId, technicianRef, startsAtLocal?, endsAtLocal?, escalatedFromNudge?}` (:174-186). |
| `src/mcp/server.ts` | `list_pending_reviews` dispatch (:7113) with the summarize-never-relay pattern (:7136, :7160-7161); tool description (:769-773); `attributeAnswerToGap` (:1994). |
| `Box_Setup_Stuff/bootstrap-box.sh` | `phase_wire` (:551): docker-exec's AGENTS.md doctrine blocks into the seat container; delete-then-append blocks refresh, presence-grep blocks pin (:617-623 records that trap). "Permanent-record writes" block at :627-664. |
| `docs/nemoclaw-tech-agent.md` | Box architecture doc; nudge delivery section :415-427 — **contains stale text**: ":424-425 still says 'Budget: ≤2 asks/person'", removed 2026-08-18 (PR #153). |
| `docs/engineering-memory.md` | The measured facts this plan rests on: one-way nudge session, channel-history injection, `openclaw message send` on 2026.6.34, the 6-turn/84k cost, the four direct-send requirements (~:3055-3090); ladder table :3018; wire run + six-copy correction (~:3031-3050); s2 canary rule :2466. |
| `thoughts/shared/plans/2026-08-22-the-brain-can-attribute.md` | :50-52 — "Delivery cost is a separate plan — decided here", with the measurement and the box-side/fleet-re-wire scoping. |
| `thoughts/shared/research/2026-08-19-nudge-pacing-replacement-design.md` | §5 — the per-detector brake owed when detector #2 lands. |

## Data Flows

### The full path today (one nudge, ask → Telegram → record → close)

```
 SPINE (Render, cron tick ~5 min; planner gate 30 min)
 ┌──────────────────────────────────────────────────────────────────┐
 │ watcher sweep          creates nudges row (pending)              │
 │   └ once-ever unique (tenant,kind,subject); ≤5 new/tenant/tick   │
 │ planner (30 min)       may decide `send` + write question_draft  │
 │   └ nudge_decisions row (applied send)                           │
 │ compose sweep          pending → queued                          │
 │   ├ ask window 7-19 firm-local; not_before hold                  │
 │   ├ planner draft found → NO model call (draftedByPlanner)       │
 │   ├ else ONE forced-tool call (300 tok, effort none) — or decline│
 │   └ markNudgeQueued(question = assembled deliverable, whole)     │
 │ outbox                 GET /control/nudges  (host token pull)    │
 │   └ serve_count++ BEFORE ship; cap 10; liveness re-filter        │
 └──────────────┬───────────────────────────────────────────────────┘
                │ every 5 min, box pulls
 BOX (trades-box-1, root timer)
 ┌──────────────▼───────────────────────────────────────────────────┐
 │ nudge-runner.sh per item:                                        │
 │   stage body in sandbox → nemoclaw <seat> agent --deliver        │
 │       --session-id nudge-<id> --message-file …                   │
 │       --reply-channel telegram --reply-to <tg user id>           │
 │   = a FULL SEAT-AGENT MODEL TURN (GLM-5.2 on Fireworks):         │
 │     the agent reads the question + footer, may reword it,        │
 │     its reply text goes to the technician's Telegram             │
 │     (--deliver fires outbound plugin hooks: weekday guard)       │
 │   verdict = assistant text in nudge-<id> trajectory              │
 │   POST /control/nudges {delivered|failed}                        │
 └──────────────┬───────────────────────────────────────────────────┘
                │ delivered → markNudgeAsked (queued→asked)
 TECHNICIAN replies in Telegram (their normal chat)
 ┌──────────────▼───────────────────────────────────────────────────┐
 │ reply lands in the seat agent's NORMAL session (nudge session is │
 │ ONE-WAY; measured 2026-08-22 — sessions_list count: 0).          │
 │ openclaw injects recent CHANNEL history into the turn, so the    │
 │ delivered question is visible context (~11 msgs / 3 days, n=1).  │
 │ Footer duty ("save it with record_field_note") does NOT cross —  │
 │ it lives only in the nudge session's inbound message.            │
 │ Agent records: record_field_note → L1 capture + visit            │
 │   └ attributeAnswerToGap: exactly ONE asked gap for that person  │
 │     on that job → setNudgeAnsweredBy (first write wins)          │
 │ planner (next tick) reads the answer on the gap view → close     │
 │   with basis 'evidence' + citation from the gap's own lines (③)  │
 └──────────────────────────────────────────────────────────────────┘
```

### Where the tokens go (the measured 2026-08-22 trajectory)

One nudge: **6 turns, 84,251 uncached input + 156,608 cacheRead + 3,245 output** (engineering-
memory ~:3082). The turns are the seat agent searching for ids the message never gave it —
`memory_search` (returns `{"disabled": true}` on s2 and is burned every turn), `find_customer`,
`list_recent_captures`, `sessions_list`, `get_customer_context`, `list_team`.
`assembleNudgeMessage` prints a customer NAME and job TITLE, no ids — the repo's own "you cannot
prompt your way to a UUID" finding, fixed for the planner (④'s views) and never for the seat. The
footer's "First read back through this conversation" is unsatisfiable in a fresh per-nudge
session, which is exactly why the agent reaches for `sessions_list`.

### What `openclaw message send` changes (repo knowledge, nothing built)

- Present on the deployed 2026.6.34; **no inference**; docs at docs.openclaw.ai/cli/message
  (engineering-memory ~:3070 — the live-docs rule applies before building: re-verify upstream).
- The channel is shared context: openclaw injects a rolling window of recent CHANNEL messages
  into every turn ("Conversation context (untrusted, chronological, selected for current
  message)"), whatever session produced them — so a directly-sent question is still visible to
  the seat agent when the person replies. There is no documented way to append to a session
  transcript without inference, and none is needed.
- No script, service, or code path in this repo invokes `openclaw message send` today (grep:
  only engineering-memory :3018/:3070 and the attribution plan :51 mention it).

### The planner-reasoning substrate (recorded ④b design — nothing built)

Two rails already carry planner words to a specific audience, both via the durable record:

1. **`handoff_note`** (manager-facing, escalate only): planner → `nudge_decisions.handoff_note` →
   escalation sweep's `noteFor()` (watchers.ts:913-921, newest APPLIED escalate only, never
   `reason`) → `spec.handoff(…, {plannerNote})` → the review item's rendered copy.
2. **`question_draft`** (technician-facing, send only): planner → `nudge_decisions.question_draft`
   → compose consumes it instead of a model call (compose.ts:262-266).

The recorded ④b design adds a **fourth audience, fourth rail**: `agentContext` inside
`review_items.detail` for manager-directed sends, PULLED by the manager's seat agent via
`list_pending_reviews` when the manager responds — never pushed onto the channel (human-facing)
and never into box memory (drifts). The agent-reads-but-never-relays precedent already exists at
server.ts:7136/:7160-7161, where staged-plan detail is replaced by a summary saying "never relay
from here". The ambiguity rule travels with it: when the agent cannot tell which open item a
reply answers, it asks. **Recorded 2026-08-23 in session memory (`ladder-build-schedule`) only —
this design is not yet written into docs/engineering-memory.md or any thoughts/ document; this
research doc is its first in-repo record.** Two adjacent recorded facts: future non-gap planner
suggestions become a new review-item KIND (which dissolves the `escalatedFromNudge`-style
nudge-coupling for those items), and `recall_decisions` stays team-lead-only — `agentContext` is
a written briefing, not the deliberations (the ④ ruling that kept `nudge_decisions` view-less).

What the substrate holds today: `review_items` columns are `tenant_id, kind, subject_ref, status,
suggestion, detail (jsonb), resolution, resolved_at, created_at` (database.types.ts); a gap
item's `detail` is `{jobId, technicianRef, startsAtLocal?, endsAtLocal?, escalatedFromNudge?}`
(reviewItems.ts:174-186). `list_pending_reviews` returns open rows verbatim except the three
staged-plan kinds. How a manager's agent learns of queue items today: **pull-only** via
`list_pending_reviews` (whose tool description, server.ts:769-773, still names only "email from
unrecognized team refs, pairing verifications, pending confirmations" — not gap items), plus a
**count-only** Telegram heads-up at escalation-open via `notifyManagers` → `sendBoardMessage`
(watchers.ts:1240-1253) — a plain Bot API POST from Render using `BOARD_BOT_TOKEN`: an existing
zero-inference push, but on the BOARD bot's chat, not the seat-agent channel, so it creates no
channel-history adjacency with the seat conversation.

## External Dependencies

- **openclaw 2026.6.34** (gateway in each seat sandbox): `agent --deliver` (fires outbound plugin
  hooks — weekday guard), `message send` (unused, the ④b target), channel-history injection.
- **nemoclaw CLI** (box): wraps per-sandbox exec/agent; argv rejects newlines (`--message-file`
  is the escape hatch); exec/agent eat stdin (`</dev/null` discipline).
- **Telegram Bot API**: seat bots (per-person, tokens on the box) and the board bot (Render,
  `BOARD_BOT_TOKEN`, plain `sendMessage`).
- **Models** (corrected 2026-08-23, operator statement): the SEAT agents run GLM-5.2 via
  Fireworks Fast — that is the relay inference being spent today. The SPINE's calls (planner
  `runToolLoop` and compose `runForcedTool`) share one config (`src/model/forcedTool.ts:55-92`,
  `MODEL_PROVIDER`) and are deployed on the Anthropic side — Opus 5. So the relay turn today is
  GLM-5.2 rewording Opus-5-authored questions: the weakest model in the chain holds the final
  edit, and what the person reads is its rendition, not the planner's sentence.
- **systemd timers on trades-box-1**: `nudge-runner.timer` (5 min), sharing
  `/etc/doorman/badge-pull.env` (PULL_URL + HOST_PULL_TOKEN); no new secret was minted.

## Constraints and Invariants

- **The spine never reaches into the box.** Delivery is pull-based on the host token, serve-until-
  acked, self-healing on lost ticks (nudgeQueue.ts header). Any ④b send issued *from the spine*
  would be a posture change; a send issued *on the box* (runner calls `openclaw message send`)
  keeps it.
- **Serve-before-ship, at-most-N**: `serve_count` increments before the item ships; cap 10 = the
  poison brake. Delivery failures get their own ledger (attempts reset at queue time; cap 3).
- **Idempotence rides on the per-nudge session file** (`traj_has_text` pre-check re-acks a
  delivered-but-unacked nudge instead of re-pinging). A direct send has no session file — the
  idempotence key must come from somewhere else (the send result, or a spine-side stamp).
- **The verdict is never CLI stdout** — today it is assistant text in the trajectory; stdout has
  rotted before (date-eval finding). A direct send needs the send's own result as the verdict.
- **What the person sees today is NOT `nudges.question`.** The stored deliverable is what was
  injected into the agent; the agent may reword ("in your own words if that reads better"), so
  the audit records what was delivered *to the agent*, not what the human read. Under a direct
  send the two collapse into one string — the audit becomes exact.
- **The footer is the record-duty's only carrier, and it does not cross the channel.** Measured:
  "record-keeping check" scored 0 hits in the technician's main session. The always-loaded
  AGENTS.md doctrine (bootstrap-box.sh's wire blocks) governs *how* to record
  (`record_field_note` records on the first call, etc.) but contains no "when the office asks
  about a visit/cost, record the answer" duty. Under direct send there is no agent turn to carry
  the footer at all.
- **Freshness is baked at compose time.** `relativeDayPhrase` ("earlier today"/"yesterday") is
  written into the question when composed; the ask window gates COMPOSE for exactly this reason
  (a held message would lie at 7 AM). Any design that separates composing from sending re-opens
  this: the phrase must be re-validated at send time or composed at send time.
- **No per-person ask cap exists** (user ruling 2026-08-18; code removed in PR #153). Bounds
  today: once-ever unique index per subject, `MAX_NEW_ITEMS_PER_TENANT_TICK` 5 (per-tenant surge
  brake), the ask window, the planner's `hold`/`not_before`, 18h delivery deadline, 24h default /
  48h max escalation. The earn/urgency/batch replacement is **unbuilt**; the per-detector brake
  is owed when detector #2 lands (watchers.ts:106-110; pacing research §5).
- **Disclosure duty** (CLAUDE.md, outbound-capture exception): people must be told "messages sent
  via the assistant are logged." The nudge question itself is stored whole in `nudges.question`
  and the decision corpus in `nudge_decisions`; nothing in the delivery path writes L1 (the
  reply's `record_field_note` does).
- **③'s attribution needs no message artifact** — it is spine-side and code-only (who recorded,
  which job, exactly-one open asked gap). It survives any delivery mechanism unchanged; the
  gap-id-stamp alternative is dead precisely because refs cannot survive *either* path.
- **Doctrine drift found**: docs/nemoclaw-tech-agent.md:424-425 still documents the removed
  "≤2 asks/person" budget. Not fixed here (read-only research).

## Decision Points

1. **Where the send is issued from.** (a) Box-side: nudge-runner (or successor) calls
   `openclaw message send` on the seat's gateway — keeps the pull posture, lands in the seat
   bot's channel, so channel-history injection shows the question to the agent on the person's
   next reply. (b) Spine-side direct Telegram (the `sendBoardMessage` precedent) — no box change,
   but the board bot's chat is a different channel: the seat agent gets no history adjacency, and
   replies to the board bot go nowhere (it has no update listener).
2. **Who stamps `asked`, on what evidence.** Today: box reports `delivered` only after finding
   assistant text in the trajectory. With `message send` there is no trajectory turn — the send's
   own CLI/API result becomes the evidence, and the idempotence key (today the per-nudge session
   file) must be reinvented (e.g. spine-side: a row already `asked` is never re-served — which
   the state machine already provides if the ack is reliable).
3. **Whether the seat agent ever sees the outbound question — and when.** Today it *is* the
   agent's turn (guaranteed sight, plus rewrite risk). Under direct send the agent sees it only
   via channel-history injection at the person's NEXT message — a bounded window (~11 messages /
   3 days, n=1, selection logic unverified). A reply that comes days later may arrive with the
   question outside the window.
4. **Where the record-duty moves.** The footer dies with the relay turn. The four-requirement
   list (engineering-memory ~:3086) already names the landing zone: always-loaded AGENTS.md
   doctrine — which means a `wire` block change and a fleet re-wire, and behavioral sufficiency
   (does the agent record unprompted?) is untested.
5. **What happens to compose.** ②b already made the planner the preferred author
   (`draftedByPlanner` path spends nothing); the recorded direction is that retiring compose's
   rewrite role is a small step inside ④b, while the full investigate/plan/compose collapse into
   one call stays sequenced AFTER ⑤ memory and ⑥ eval (engineering-memory :730-742). Open inside
   ④b: who authors a question when no planner draft exists (keep compose as fallback author vs
   require a draft), and who exercises the decline judgment (`ask:false` → manager handoff) that
   compose owns today. Two properties the full collapse gives up are already recorded:
   independent rollback of the technician-facing voice (compose gates on NUDGES_MODE, not
   PLANNER_MODE) and per-gap failure isolation.
6. **Guard coverage.** `--deliver` fires the outbound plugin hooks (weekday guard's streamed-
   reply coverage). Whether `openclaw message send` passes through `reply_payload_sending` /
   `scanMessage` is unverified. If it bypasses the guard, date safety rests entirely on the
   spine's own rails (`cleanQuestionDraft` date rail, planner.ts:713; served phrases; the
   code-printed bare date) — which were designed to make the guard have nothing to catch, but the
   guard's endemic-failure statistics (23/419) were measured on agent-authored text, not on this.
7. **Freshness across the compose/send split.** Keep the day phrase valid: compose-at-send
   (collapse the queued state's dwell), re-verify the phrase at send time, or drop relative-day
   words from delivered questions entirely (the cost kind already uses no dates).
8. **The reasoning-context rail rides along.** The user ruling: ④b MUST carry the recorded
   design — `agentContext` in `review_items.detail` for manager-directed sends, pulled via
   `list_pending_reviews`, never relayed (the :7136 precedent), ambiguity → ask. The manager-
   directed send itself is new surface: today NOTHING the planner writes is delivered to a
   manager as a message (managers get count-only heads-ups and the pull queue).

## Open Questions

- Does `openclaw message send` fire the outbound plugin hooks (weekday guard)? Testable with the
  existing weekday-guard probe on s2. Related: does a sent message appear in channel history the
  same way an agent reply does (assumed from the injection being channel-scoped; n=1)?
- Exact `message send` invocation shape per seat (channel/account/target arguments, auth context
  on the gateway, exit-code semantics for the verdict) — must be read from
  docs.openclaw.ai/cli/message per the live-docs rule before any plan cites it.
- Channel-history injection guarantees: window size/age policy, and what "selected for current
  message" selects on (recency vs relevance) — one observation (s2, #761-#771) exists.
- Is AGENTS.md-doctrine record-duty behaviorally sufficient without a per-message footer? (The
  planner-copy eval pattern — render through real templates, judge the behavior — has no seat
  analog today.)
- Where does the technician's *reply* live for audit today? The answer reaches L1 only if the
  agent records it; the transcript-harvest direction (ratified, with disclosure + pre-L1 gate)
  is the standing answer but its build status is outside this scope.
- `sendBoardMessage`'s board bot has no update listener — confirmed one-way. Whether any seat-bot
  send from the spine side is even possible without the box (seat bot tokens live in sandbox
  provider config) was not traced here.
