---
date: 2026-09-23
task: Step 3: office messages and nudges reach glue seats — readers in the seat glue replace office-runner and nudge-runner (Ben's office traffic fails until then)
status: complete
origin: 
files: src/seatGlue/seat.ts, src/seatGlue/main.ts, src/seatGlue/telegram.ts, src/control/nudgeQueue.ts, src/control/officeQueue.ts, src/mcp/httpServer.ts, Box_Setup_Stuff/nudge-runner.sh, Box_Setup_Stuff/office-runner.sh, thoughts/shared/research/2026-09-23-step-3-office-messages-and-nudges-reach-glue-seats.md, docs/engineering-memory.md, thoughts/shared/plans/2026-09-23-step-3-office-reaches-glue-seats.md, supabase/migrations/20260924120000_seat_inbox.sql, src/db/nudges.ts, src/db/officeMessages.ts, src/db/personPushes.ts, src/db/seats.ts, src/seatGlue/inbox.ts, src/seatGlue/state.ts, src/seatGlue/doctrine.ts, src/seatGlue/inbox.test.ts, supabase/migrations/20260924130000_seat_turns.sql, src/db/seatTurns.ts, src/db/seatTurns.test.ts, src/seatGlue/transcript.ts, src/seatGlue/transcript.test.ts, src/mcp/tools/seatConversation.ts
supersedes: nothing
---

## Files

- src/seatGlue/seat.ts
- src/seatGlue/main.ts
- src/seatGlue/telegram.ts
- src/control/nudgeQueue.ts
- src/control/officeQueue.ts
- src/mcp/httpServer.ts
- Box_Setup_Stuff/nudge-runner.sh
- Box_Setup_Stuff/office-runner.sh
- thoughts/shared/research/2026-09-23-step-3-office-messages-and-nudges-reach-glue-seats.md
- docs/engineering-memory.md
- thoughts/shared/plans/2026-09-23-step-3-office-reaches-glue-seats.md
- supabase/migrations/20260924120000_seat_inbox.sql
- src/db/nudges.ts
- src/db/officeMessages.ts
- src/db/personPushes.ts
- src/db/seats.ts
- src/seatGlue/inbox.ts
- src/seatGlue/state.ts
- src/seatGlue/doctrine.ts
- src/seatGlue/inbox.test.ts
- supabase/migrations/20260924130000_seat_turns.sql
- src/db/seatTurns.ts
- src/db/seatTurns.test.ts
- src/seatGlue/transcript.ts
- src/seatGlue/transcript.test.ts
- src/mcp/tools/seatConversation.ts

## Notes

Openclaw retirement step 3 (memory openclaw-retirement-plan; operator parked it 2026-09-23). Since 2026-09-23 03:00 UTC every planner question, office note and push for Ben (s5) FAILS on Render: nudge-runner.sh:135-150 and office-runner.sh:115-131 deliver by `nemoclaw <seat> exec` INSIDE the seat's container, which cut-over stopped (decision 5 = C, accepted). Build readers in the seat glue that drain GET/POST /control/nudges (a plain Telegram send, verbatim) and /control/office (enqueue into the seat's conversation, nothing sent to the person), and make the bash runners skip seats the glue serves — Render serves items per HOST and addresses them by technicians.sandbox_ref (src/control/nudgeQueue.ts:177,242,290), so both pollers would otherwise take the same items.
Gate: a planner question reaches Ben's phone and his answer returns through the spine.
Depends on: the office-message code in flight in 20260922-merge-the-desk-into-the-office-one-agent and rung 10c (20260912-rung-10c-…) — the memory's rule is to wait for 10c to land.

## Decisions

- 2026-09-23 (operator, after research `thoughts/shared/research/2026-09-23-step-3-office-messages-and-nudges-reach-glue-seats.md`):
  NO QUIET TURN. Office traffic triggers zero model calls on a glue seat's assistant. Verbatim texts
  (nudges, chat, pushes) go straight to Telegram AND are remembered by the glue; they, plus every
  assistant-leg office note, are attached to the person's NEXT message ("since you last spoke").
  Rejected: a silent model turn per note (openclaw parity) — the SDK has no documented
  add-without-a-turn (1.0.14 types: `source:"system"` still runs a turn; `sendSystemNotification`
  is internal), and the operator ruled the office should READ the seat instead of asking it.
- 2026-09-23 (operator): THE READING PIECE IS IN STEP 3, not parked separately — it must land
  before step 5 deletes office-runner, and step 5 is next. The glue uploads each reply's turns live
  to Render (seat-token route, deletable table, NOT L1); the office gets a search tool (snippets,
  table-of-contents rule) and its instructions say "read the conversation", not "ask the assistant".
  The live upload also covers step 5's planned nightly session backup. Coordinate the memory table
  with step 2 (20260923-step-2-manager-seat-s2-on-the-seat-glue).
  Still open for /plan: what is uploaded (said-only vs tool calls too), retention, who may read it
  (office only vs managers), technician disclosure wording.

## Handoff 2026-09-24T02:02:55.590Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/step-3-office-messages-and-nudges-reach on work/step-3-office-messages-and-nudges-reach, from origin/main 09d65f4.

Overlap check: 2 overlaps with active tasks — the operator read them and proceeded (--proceed):

  LOW   same file only      src/seatGlue/seat.ts
        20260923-step-2-manager-seat-s2-on-the-seat-glue lists it but has not changed it; 20260923-step-3-office-messages-and-nudges-reach names it
  LOW   same file only      src/seatGlue/telegram.ts
        20260923-step-2-manager-seat-s2-on-the-seat-glue lists it but has not changed it; 20260923-step-3-office-messages-and-nudges-reach names it

## Handoff 2026-09-24T16:33:10.376Z

**What changed** — Office traffic reaches glue seats (#283, live on s5 since 2026-09-24 06:51 UTC; phone gate PASSED 16:30 UTC).
- The glue pulls `/seat/inbox` with its seat token every 10 s. Phone items (nudges, chat, pushes) go to Telegram word for word. Every item then waits in state.json and rides on top of the person's next message, so there are zero seat model calls.
- The box runners skip a person whose glue stamped `seats.last_pulled_at` within 120 s.
- The glue uploads its turns (words + spine tool name/args/ok, never results) to `seat_turns` (not L1, pruned at 90 days by lifecycle-heart).
- The office reads a seat's turns with `read_conversation` (planner + the manager-facing door only).
- Follow-ups merged: #284 npm audit fix; #285 a MANAGER's conversation is private.
- In-place pilot actions:
  - Applied both migrations by MCP (ledgered under apply time, not file names).
  - Closed Ben's 5 frozen office rows (status 'failed', operator's choice).
  - Inserted 2 test office rows for the gate (f3018591 chat, 7eae40aa note, both delivered).

**Decisions** —
- **Operator:**
  - No quiet turn.
  - The office READS, never asks.
  - Upload = words + tool calls.
  - Readers = planner + manager-facing door.
  - One-time notice + honest-if-asked.
  - 90-day retention.
  - **2026-09-24: a manager's chat is private** (no recorder, no notice, Render drops their uploads, read_conversation returns 'private' → ask them directly).
- **Mine:**
  - Seat-token routes, not the host pull (the host token never enters a glue env).
  - Runner exclusion by a liveness stamp, not by the seats row, so rollback.sh hands a person back automatically. The rejected alternative (skip-by-row) strands a rolled-back seat.
  - A missing shareConversation flag means private.
- **Rejected (SDK research):** `sendSystemNotification` passive mode is internal and undocumented. `source:"system"` still runs a turn.

**Assumptions** —
- `seat.host_id` == the person's `technicians.host_id`. They agree by construction; there is a code comment in httpServer.ts, but no DB constraint.
- The queues still require `technicians.sandbox_ref`. Glue seats carry their seat_ref there.
- Telegram HTML conversion of a "verbatim" office text matches what openclaw sent. Not re-proven.

**Open** —
- **Deploy #284 + #285 to the web service AND lifecycle-heart, then restage + `install.sh s5`.** The operator deferred this. It MUST happen before step 2 moves a manager (s2) onto the glue, or that manager's chat would be uploaded.
- The live person_push check was not run (same leg as chat; tests cover it).
- Nit left: transcript-outbox.json is rewritten in full per turn (matters only in a long Render outage).
- The nudge closed as 'cancelled' (visit completed) rather than 'answered', with answered_by set. That's how the planner closes questions, not a bug, but readers of nudge status should know it.

**Downstream** —
- Step 2 (worktree step-2-manager-seat-s2-on-the-seat-glue) also edits src/seatGlue/doctrine.ts and seat.ts. Expect conflicts. Its memory table should be searchable by the office EXCEPT that a manager's chat is private.
- Step 5 must keep `sandbox_ref` set for glue seats (or change the serve filter) and can drop its "nightly session backup" (seat_turns covers it).
- The box runners stay for openclaw seats until step 5.
