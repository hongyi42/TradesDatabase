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
- [ ] exact invocation established (docs + --help); dead-target send executed **with a
  multi-line body** (the openshell-exec argv-newline trap — nudge-runner.sh:132-141); exit
  code, output and the gateway's success-signal log line captured
- [ ] weekday-guard log checked before/after the send (informational either way)
- [ ] channel-history appearance explicitly DEFERRED to Phase 4's real send (dead targets
  cannot show it)

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
- [ ] gates (`typecheck` · `lint` · `test` · `build`) + new tests pass
- [ ] migration applied to LOCAL stack (`grep project_id supabase/config.toml` first — worktree trap)

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test__apply_migration` + `execute_sql` (pilot).
- [ ] migration applied to the PILOT; verified via `information_schema.columns` (never
  `list_migrations` — the ledger lies), BEFORE the Phase-3 deploy

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
- [ ] gates (typecheck / lint / test / build) + new tests pass

### Live verification (agent-executable)
- Prerequisites: Render MCP (workspace confirmed) after user merges.
- [ ] deploy live on the merge commit; `GET /control/nudges` shape confirmed via a pilot read
  (host-token endpoint — verify via the next real pull's gateway log, or a curl with the box's
  env on the box itself)

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
- [ ] `bash -n` both scripts; repo gates pass (docs/scripts only)

### Live verification (agent-executable)
- Prerequisites: ssh to `tradesbox`; rsync + md5 discipline (six-copy trap: verify the box copy
  matches the repo BEFORE running anything from it).
- [ ] `wire` run on ALL SIX seats (the runner is box-global — every seat needs the duty the
  moment sends go verbatim); in-container grep on s2 + one NON-s2 seat: new block once, §0f and
  all prior blocks intact
- [ ] runner v2 installed (md5 of `/usr/local/sbin/nudge-runner.sh` = repo); timer ticks clean;
  `/var/lib/nudge-runner/` exists
- [ ] one REAL nudge end-to-end: mint a THROWAWAY visit/assignment on 'Default Tenant' (pilot
  write, allowed per-path; `uq_nudges_subject_ever` consumes the subject forever — never use a
  real one) for manager-sam → runner sends → row reaches `asked`; the footer-less stored
  question is byte-what-arrived (runner log evidence); message visible in the agent's
  channel-history injection (the fact Phase 1 deferred). Preconditions stated: run INSIDE the
  7am-7pm firm-local ask window and with `NUDGES_MODE=live`, or the row holds and nothing
  distinguishes a break from the hold
- [ ] duplicate-protection: re-serve with the ack suppressed once — the marker prevents a second
  ping and re-acks instead

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
- [ ] record-duty probe: after the user replies to the Phase-4 question in Telegram, verify by DB
  read-back: `raw_captures` row landed; `nudges.answered_by_capture_id` stamped; next planner
  tick's decision mentions/closes the gap (query `nudge_decisions`)
- [ ] briefing probe: escalate a test gap carrying `agentContext` → ask s2's agent about the item
  in Telegram → transcript shows it USED the briefing (names the specifics) without quoting it
  verbatim

### Manual verification
- [ ] you reply to the Phase-4 question in Telegram (one message; the probe reads the rest)
- [ ] the agent's briefing-informed answer reads like help, not like a machine quoting a log

---
*Pause — both live probes need your Telegram replies.*
