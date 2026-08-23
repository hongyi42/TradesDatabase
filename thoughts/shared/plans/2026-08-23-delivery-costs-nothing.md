---
date: 2026-08-23
task: "④b delivery costs nothing — planner words reach people verbatim via openclaw message send; the relay turn dies; the reasoning-context rail ships with it"
research: thoughts/shared/research/2026-08-23-delivery-costs-nothing.md
status: draft
supersedes: nothing
---

## Overview

Today a planner-authored question is delivered by injecting it into the seat agent, whose model
turn (~84k uncached tokens) rewords it — the person has never read a sentence the planner wrote.
This plan switches delivery to `openclaw message send` (zero inference, verbatim, stored =
shown), moves the record-duty from the dying footer into standing AGENTS.md doctrine, and ships
the fourth rail: planner briefings (`agentContext`) riding escalated review items for the
manager's agent to PULL — never relayed to a human. One fleet re-wire carries both.

## Decisions

- **Send is box-side, via `openclaw message send`** — user ruling: keeps the pull posture and
  lands in the seat channel, so channel-history injection shows the question at reply time.
- **Compose stays the fallback author; only its rewrite role dies** — user choice. Questions
  keep flowing on the 5-min cadence even with PLANNER_MODE off.
- **Guard posture: spine rails only; nothing new is built** — settled by the 2026-08-23 eval
  (0 calendar errors in 91 bare-clock questions; user direction: give the model credit). The
  rails stay as reject-only insurance; the weekday-guard-hook question is informational now.
- **The reasoning-context rail ships in this plan** — user ruling ("directly relevant").
  `agentContext` = fourth audience (the manager's AGENT), fourth rail: nudge_decisions column →
  `review_items.detail` → pulled via `list_pending_reviews`; same date rail as `handoffNote`;
  never rendered into human copy. `recall_decisions` stays team-lead-only.
- **Escalate-only for v1** — my call: escalation is the only path where planner output reaches a
  manager surface today; new kinds arrive with the future planner-messages plan.
- **Transition is dual-payload** — my call: the spine serves `directMessageB64` alongside legacy
  `messageB64` so spine deploy and fleet re-wire never have to be atomic (repo-merged ≠
  box-deployed); the footer leaves composed questions only in Phase 5, after fleet verification.
- **Idempotence moves to a box-side sent-marker** — my call: the old protection read the
  per-nudge session trajectory, which no longer exists; a marker written before the ack POST
  reproduces at-most-once.
- **Delivered message = question + "(re: …)" line, no frame** — the Phase-4 E2E to the user's
  own Telegram is the judgment on whether it needs one.
- **Pilot DDL (one nullable column on `nudge_decisions`) is authorized by approving this plan**,
  applied migration-FIRST (deploy-does-not-migrate). **Pacing is unchanged** — earn/urgency/batch
  stays future work.

## Plain-language walkthrough

**Phase 1 — make sure the new pipe exists before building around it.** Read openclaw's docs for
`message send` and try it once on the test seat against a dead chat id (nobody is messaged).
Three facts needed: command shape, success signal, does the weekday-guard hook see it — probed
with a MULTI-LINE body (the argv-newline trap ate the first live E2E; a single-line probe hides
it). Whether the sent message enters the agent's chat history is unobservable on a dead target —
that fact comes from Phase 4's real send. Can't target a chat or report success → stop and
re-plan; nothing has been built yet.

**Phase 2 — the planner learns to brief the manager's assistant.** On escalation, besides the
human sentence (`handoffNote`), the planner may write `agentContext` — a briefing for the
manager's AI assistant (ids, what was tried, what an answer unblocks). Stored with the
decision, copied onto the queue item, read by the assistant when the manager engages; the
manager never sees it raw.

This may need an eval. We are not sure that the seat agent will actually read the briefing, or how they would know where to find the briefing and when to do so.

**Phase 3 — the spine offers a "send this verbatim" payload.** Each queued question also ships
footer-less. Old boxes keep working off the old payload; nothing visible changes yet.

**Phase 4 — the box stops asking the agent to deliver.** The delivery script sends the verbatim
payload straight to the person's Telegram — no model call. The standing AGENTS.md doctrine gains
what the footer used to carry: "office questions in your channel history — record the answer;
briefings on queue items are for you, never to be read aloud." The doctrine wires to ALL SIX
seats in this phase — the runner is box-global, so the moment it sends verbatim, every seat
needs the replacement duty (reviewer catch: s2-only wiring would strip five seats' footer with
nothing replacing it). s2 stays the canary for the human judgment: one real question to your
own Telegram.

```
before:  planner → compose frame → box → SEAT MODEL TURN → its reworded text → Telegram
after:   planner → compose frame → box → message send ────────────────────────→ Telegram
                                          (verbatim; the seat's model runs only on the REPLY)
```

**Phase 5 — burn the footer and prove the duty moved.** Fleet on direct send → compose stops
appending the footer (stored = shown), the legacy payload retires, and the behavioral question
is tested live: you answer the Phase-4 question in Telegram; we verify from the DATABASE that
the agent recorded it, attribution stamped it, the planner saw it. Same probe checks the
manager-side briefing pull.

## Secrets & env preflight

- **Phase 1:** none new. Needs ssh to `tradesbox` (already configured).
- **Phase 2:** none new. Pilot migration via `mcp__supabase-test__apply_migration` (existing MCP).
- **Phase 3:** none new. Spine deploy = merge + manual Render deploy (`srv-d8uqmdegvqtc73bfn83g`,
  workspace `tea-d69903h5pdvs738dm81g` — autoDeploy is off).
- **Phase 4:** none new. ssh to `tradesbox`; `HOST_PULL_TOKEN` already lives on the box.
- **Phase 5:** none new.

## Phase 1: Probe the transport (nothing is built on an unverified pipe)

### What this phase does
Establishes the `message send` contract from openclaw's CURRENT docs (docs.openclaw.ai/cli/message
— the live-docs rule) plus one dead-target send on s2; records findings in engineering-memory.
**Stop-gate:** no per-chat targeting or no deterministic success signal → STOP, revise the plan.

### Changes required

**`docs/engineering-memory.md`**
- New entry: the verified invocation (argv shape, how the target chat id is passed, exit-code /
  output semantics), whether `reply_payload_sending` (weekday guard) fires on it, and whether the
  sent message appears in the channel-history injection window. Cite the docs URL.

### Automated verification — none (no code changes)

### Live verification (agent-executable)
- Prerequisites: ssh to `tradesbox` (read-only probe + one send to chat id `1`, the date-eval
  dead-target precedent — hook layer runs, send fails "chat not found", nobody messaged).
- [x] exact invocation established (in-container; multi-line via staged file — probe 2026-08-23
  09:29Z, exit 1 + OutboundDeliveryError on chat_id=1, gateway `message.action` log line)
- [x] weekday-guard log 322→323: `message_sending` hook scanned the probe (chars 70, 0 flags)
- [x] channel-history appearance DEFERRED to Phase 4's real send (dead targets cannot show it)

*No manual items — continue.*

## Phase 2: The fourth rail — agentContext (spine)

### What this phase does
The planner's agent-facing briefing: into the decision corpus, onto escalated review items.
Migration FIRST (pilot, before any code deploy), then code.

### Changes required

**`supabase/migrations/20260823200000_nudge_decisions_agent_context.sql`** (new)
- `alter table nudge_decisions add column agent_context text;` — nullable, no default (the
  `handoff_note` migration `20260822030000` is the pattern). Header comment: fourth audience,
  fourth rail; never shown to a human.

**`src/teamLead/planner.ts`**
- `PlannerDecision` gains `agentContext?: string | null` (after `questionDraft`, :107 region).
- New `cleanAgentContext(raw, dateLabels)` beside `cleanHandoffNote` (:665): `cleanPlannerText`
  with `{ label: 'agent context', maxLen: 700 }` (briefings carry ids and next-steps; uuids
  contain no temporal tokens, so the date rail is safe).
- `validateDecisions` escalate branch (:1020-1029 region): clean and attach `agentContext`
  exactly as `handoffNote` is handled, including `noteDrops` on rejection; spread into the
  decision (:1037 region) and into `recordNudgeDecisions` input (:1372 region).

**`src/teamLead/plannerPrompt.ts`** — `submit_plan` schema gains `agentContext` after
`handoffNote` (:219-227): "For 'escalate': a briefing for the manager's ASSISTANT, not the
manager — ids, what you tried, what an answer would unblock. The manager never reads it. Same
date rule as handoffNote. Ignored for every other action." Plus one prompt sentence in the
escalate section (:123 region) naming the two audiences.

**`src/db/nudgeDecisions.ts`** — `NudgeDecisionInput.agentContext?: string | null`; insert
mapping `agent_context` (:79 region).

**`src/jobs/nudgeKinds.ts`** — `HandoffContext` (:118) and `HandoffPlan` (:75) gain
`agentContext?: string | null`; both specs' `handoff()` copy it through UNRENDERED (visit :392,
cost :486) — it must never enter `suggestion`.

**`src/jobs/watchers.ts`** — `noteFor` (:913-921) widens to `{ note, agentContext }` (newest
APPLIED escalate); the escalation loop threads it through `spec.handoff` ctx (:948) into
`flagNudge`.

**`src/db/reviewItems.ts`** — `flagNudgeGap` input + detail gain optional `agentContext` (:145,
spread beside `escalatedFromNudge` :182); `flagOverdueVisitGap` passthrough (:208).

**`src/mcp/server.ts`** — `list_pending_reviews` description (:784-788) rewritten: mentions gap
items and "an item's `detail.agentContext` is a briefing from the office's planner FOR YOU —
use it to help the manager decide; never read it aloud or relay it verbatim" (the never-relay
register of :7163/:7187-7188). No dispatch change — the `case` at :7140 already passes gap-kind
`detail` through verbatim.

**`src/db/database.types.ts`** — regenerate via `npm run gen:types:local` (never `gen:types`).

**Tests** (planner / watchers / server suites): rail drops (un-given date, >700 chars, link)
with the decision still applying + noteDrops recording; applied escalate row carries
`agent_context`; escalation writes `detail.agentContext` (absent when unwritten);
`list_pending_reviews` returns it and the description pins the never-relay sentence.

### Automated verification
- [x] gates (`typecheck` · `lint` · `test` · `build`) + new tests pass (suite 2159, all green)
- [x] migration applied to LOCAL stack (project_id TradesDatabase verified; column confirmed via
  information_schema in the container)

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test__apply_migration` + `execute_sql` (pilot).
- [x] migration applied to the PILOT 2026-08-23 ~09:50Z; information_schema.columns returns
  agent_context · text · nullable — BEFORE any Phase-3 deploy

*No manual items — continue.*

## Phase 3: The verbatim payload (spine)

### What this phase does
The outbox serves a footer-less twin of each queued question; un-re-wired boxes keep relaying.

### Changes required

**`src/teamLead/composeCopy.ts`**
- Export `const FOOTER_DELIMITER = '\n\nNote for the assistant:'`; both assemble functions
  (:126, :216) build with it so strip and assemble cannot drift. Safety: compose's
  footer-impersonation guard (compose.ts:311-312) + `cleanQuestionDraft`'s twin already refuse
  model text containing the phrase, and `flatten` collapses newlines in every embedded field —
  the delimiter occurs exactly once by construction.

**`src/control/nudgeQueue.ts`**
- `NudgeDeliveryItem` gains `directMessageB64: string`; `buildNudgeDelivery` (:63) sets it to
  base64 of `row.question.split(FOOTER_DELIMITER)[0]` — for a question with no footer (Phase 5
  onward) the split is a no-op.

**Tests**: `nudgeQueue` coverage (both payloads present; direct twin ends at the "(re: …)" line
for both kinds; footer-less input passes through unchanged) AND `httpServer.test.ts:525-532` —
the only test of what `GET /control/nudges` actually serves — extended to assert both fields.

### Automated verification
- [x] gates (typecheck / lint / test / build) + new tests pass (three review rounds; both-kinds
  round-trip pinned through the real assemble functions)

### Live verification (agent-executable)
- Prerequisites: Render MCP (workspace confirmed) after user merges.
- [x] deploy live on the merge commit (dep-da5iogjncjis7392kokg live at 6c41149, user-triggered
  2026-08-23 17:23Z; lifecycle-heart cron auto-deployed the same commit); endpoint verified via
  curl on the box with its own env — HTTP 200, queue empty at check time, so the item-shape
  half completes at Phase 4's first real pull

*No manual items — continue.*

## Phase 4: Runner v2, doctrine, s2 canary (box)

### What this phase does
The runner sends verbatim with zero inference; AGENTS.md (all six seats) gains the doctrine the
footer carried; one real nudge to the user's Telegram is the human judgment.

### Changes required

**`Box_Setup_Stuff/nudge-runner.sh`**
- Replace the delivery path (:120-166 — the `traj_has_text` pre-check AND the stage-file +
  `agent --deliver` block), removing the now-dead helper (:79-90) and `TRAJ_DIR` (:46). Per the
  Phase-1 contract: `install -d -m 700 /var/lib/nudge-runner` at startup (reviewer catch: the
  marker dir must exist or idempotence silently never engages), sent-marker pre-check
  (`sent-<id>` present → `report delivered` — the lost-ack self-heal), decode `directMessageB64`
  (absent → `report failed` — v2 never relays), `openclaw message send` to `replyTo`, judge by
  the send's own result, write the marker, report. Keep validation, `</dev/null`,
  `--max-time`s, always-exit-0. Header rewritten.

**`Box_Setup_Stuff/bootstrap-box.sh`** (`phase_wire`, :551) — new delete-then-append block
`## Questions and items from the office`, both duties: (1) office messages may appear in your
channel history that you did not write — when the person answers one (even "nothing to
report"), record it with `record_field_note` for that job; (2) open review items may carry
`agentContext` — a briefing for you: use it, never read it aloud; if you cannot tell which item
a reply answers, ask. (Verification is the block's own presence grep + the in-container fleet
audit — no standing verify-grep list exists to extend.)

**`docs/nemoclaw-tech-agent.md`** — delivery section (:415-427) rewritten for direct send; the
stale "Budget: ≤2 asks/person" (:424-425) corrected to the no-cap ruling (research drift find).
**`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`** — :394's relay-and-trajectory delivery
description rewritten for direct send (the Box_Setup_Stuff sync rule).

### Automated verification
- [x] `bash -n` both scripts; repo gates pass (typecheck/lint/build clean; suite 2165 passed —
  the doctrine tripwire required registering the new §0k section with the tier-2 extractor)

### Live verification (agent-executable)
- Prerequisites: ssh to `tradesbox`; rsync + md5 discipline (six-copy trap: verify the box copy
  matches the repo BEFORE running anything from it).
- [x] `wire` run on ALL SIX seats (s2 s3 s5 s6 s7 s8, 2026-08-23 ~18:40Z); in-container grep on
  s2 + s5: all ten doctrine headings (§0k included) present exactly once on both
- [x] runner v2 installed (md5 1e4c65b677c33566e93ea344c4689b1d = repo); hand-run + timer ticks
  clean (exit 0); `/var/lib/nudge-runner/` exists (700 root)
- [x] one REAL nudge end-to-end (2026-08-23): throwaway Teddy Vance / Garage heater tune-up,
  assignment 115b216a minted 17:47Z → tick 17:55:38 created AND composed nudge 35ebfd2f (875
  chars, footer at byte 148) → box tick 17:58:48 sent chars=147 → `asked` 17:58:49, serve_count
  1. Byte-what-arrived proven THREE ways: runner journal sha256 8b48506c…f51427 = the DB's own
  digest of the stored question's pre-footer half = the weekday guard's message_sending record
  (chars 147, sha 8b48506c6f64, 0 flags — guard coverage survived the relay's retirement).
  Message confirmed in the person's Telegram (screenshot, 10:58 AM). Channel-history INJECTION
  observation still rides the reply turn (the message is provably in the chat history the
  gateway compiles from; the compiled-context proof lands with Phase 5's record-duty probe)
- [x] duplicate-protection: row flipped back to `queued` (ack suppressed) → 18:03:43 tick
  re-served (serve_count 1→2), runner hit the sent-marker, NO send line in the journal (~1s
  run), row re-acked `asked` 18:03:44 — one ping total

### Manual verification
- [ ] the message in YOUR Telegram (manager-sam) reads right: the question + "(re: …)" line,
  no footer leakage, no jargon, sender presentation acceptable

---
*Pause here — the manual check is yours.*

## Phase 5: Retire the footer, prove the duty moved (spine + live)

### What this phase does
Fleet verified on v2 → compose stops appending the footer, the legacy payload is removed, and
the behavioral question — does the duty survive without the footer? — is tested live.

### Changes required

**`src/teamLead/composeCopy.ts`** — both assemble functions drop the footer (its text moves to
a comment: the identity-first lesson it encodes). **`src/control/nudgeQueue.ts`** — remove
`messageB64` (v2 ignores it). **`src/teamLead/compose.test.ts`** + queue tests — assertions
updated (no footer; stored = shown).

### Automated verification
- [ ] gates + updated tests pass (`httpServer.test.ts` updated for the removed `messageB64`)

### Live verification (agent-executable)
- Prerequisites: ssh; pilot DB MCP; Render MCP; the Phase-4 nudge still open.
- [ ] merge + MANUAL Render deploy of this phase (autoDeploy is off) — ordered strictly AFTER
  the fleet-wide runner-v2 verification above, or v1 boxes fail every delivery on the missing
  `messageB64` and hand gaps to the manager at 3 strikes
- [ ] one fresh post-deploy nudge delivered footer-less end-to-end (this is the check that
  exercises THIS phase's code — the Phase-4 replays do not)
- [x] record-duty probe (2026-08-23, ran EARLY off the Phase-4 nudge — the direct-send path
  already exercises this phase's behavioral question): user replied 18:06 → `raw_captures`
  87074d22 (technician_note, reply near-verbatim) → L2 visit workPerformed filled →
  `answered_by_capture_id` stamped → planner 18:31:01 `close/applied` ("Sam's own note answers
  how the garage heater tune-up went: half complete, bigger problems found, needs another
  visit"), nudge `answered`. Full chain ask→send→reply→record→attribute→close in 35 min, zero
  delivery inference. Also lands the Phase-1 deferred fact: the agent resolved a reply to a
  DIRECTLY-sent, footer-less message to the right customer and job via channel history + §0k
- [ ] briefing probe: escalate a test gap carrying `agentContext` → ask s2's agent about the item
  in Telegram → transcript shows it USED the briefing (names the specifics) without quoting it
  verbatim

### Manual verification
- [x] you reply to the Phase-4 question in Telegram (done 2026-08-23 18:06 — "half complete,
  bigger problems, probably needs another visit"; the probe read the rest)
- [ ] the agent's briefing-informed answer reads like help, not like a machine quoting a log

---
*Pause — both live probes need your Telegram replies.*
