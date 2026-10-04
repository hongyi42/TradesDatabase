---
date: 2026-10-02
branch: main (read at origin/main, detached)
commit: b22c8d4
topic: Rulings update — which old rulings collide with the 2026-10-02 rulings (say it and it's done; text a teammate; the edge is people work)
supersedes: nothing
status: AWAITING OPERATOR JUDGMENT — the recommendations below are Claude's, not rulings
---

# Rulings collision review (2026-10-02)

**Asked by the operator:** *"Before we proceed, to ensure the new rulings and old rulings don't
collide, I want you to review all of the old rulings, see which ones may collide, and return those
to me for judgement. Basically we're doing an update on the rulings."*

**Method.** Seven parallel read-only sweeps of origin/main `b22c8d4`: `docs/engineering-memory.md`
in three slices (§1–2; §5–6a; §3, §4, §6, §7), all 179 local memory notes, the doctrine and rails
compiled into code (`src/seatGlue/doctrine.ts`, `src/teamLead/plannerPrompt.ts`,
`src/teamLead/officePrompt.ts`, `src/teamLead/planner.ts` rails, `src/control/*Queue.ts`,
`src/mcp/tools/*`, CLAUDE.md, the OpenClaw bootstrap for s8), `thoughts/shared/findings/` + July/Aug
plans, and Sep/Oct plans + every research doc recording a ruling. ~260 raw candidates, merged into
the 14 decisions below. Quotes behind the recommendations were re-read by hand (end of file).

## The new rulings (the yardstick)

- **N1 — say it and it's done** (operator, 2026-10-02; task `20261003-say-it-and-it-s-done…`, being
  built): a person's instruction is the go-ahead, no confirmation step; can't → say why in a line;
  replies super concise. Scope EVERYONE. Asking WHICH thing when the words fit two is kept.
- **N2 — text a teammate** (same): a new tool texts a technician verbatim with a code-added
  "From <name>:" header; manager → technician only; technician → manager through the office.
  Principle: agents' paths mirror people's real-world paths; managers come first.
- **N3 — the edge is people work** (`docs/engineering-memory.md` §2): a manager's instruction is the
  go-ahead for the whole task; the agent works out the steps, says the plan in a line, proceeds,
  waits, follows up, drafts, records, verifies, reports back; manager pulled in only for what only
  they can decide or when someone won't respond; the task outlives the conversation.
- **N4 — one general capability** (rule 6): like Claude Code, never a loop per scenario.
- **N5 — the owner does as little as possible**; manager touches per finished task is the measure.
- **N6 — narrowing**: "proposed and confirmed, never performed silently" holds only for what the
  agent thinks of unasked.

## The pattern: most collisions are one question — who asked?

Nearly every old ruling in the "collides" pile was written for **the office's own record-keeping
questions** — things the system noticed and asked about, unasked by anyone. For those, the old
rules still read right (don't chase, ask once, don't say where it came from, treat seat messages
as information). They collide only when applied to **work a person asked for**. So most clusters
resolve with one principle — **who asked decides which rules apply** — which N6 already states for
confirmations.

```
                      SOMEBODY ASKED FOR IT (a task)          THE SYSTEM NOTICED IT (a gap)
 does it direct?      yes — the asker's authority             no — information, weighed
 confirm first?       no — the instruction is the yes (N1)    propose it (N6)
 follow up?           yes, until solved, paced by judgment    ask once-ish; don't chase
 say who asked?       yes — "Sam asked me to…"                no — it's the agent's own question
 wake on a reply?     yes — the task moves on                 next look is fine
```

## Decisions — Group A: resolved by "who asked decides"

### A1. Does a manager's request direct the agents? (authority)
- **Old:** "Information not instruction — tier rides as metadata, never authority" (user 2026-08-31;
  `docs/engineering-memory.md:6222-6223`, `:5460-5468`; `src/teamLead/planner.ts:3482-3484, 3554`;
  migration `20260901150000_office_messages.sql:38-40`; `src/mcp/tools/office.ts:45-51, 248-250`;
  wrappers `src/control/officeQueue.ts:45-50, 70-81`; seat "never a command" `src/seatGlue/doctrine.ts:77`).
  "You never assign work — nobody here is yours to task" (`src/teamLead/plannerPrompt.ts:174-175`).
  "NOT orchestration — the planner never tasks agents" (user 2026-08-31;
  `thoughts/shared/plans/2026-08-31-the-planners-inbox.md:27-29`; `docs/engineering-memory.md:6210-6212`).
  "An item is a suggestion the planner may decline" (user 2026-09-14; `docs/engineering-memory.md:6058-6060`).
  "Seat channel: weigh, never a command"; "SAY WHAT YOU DID, NEVER WHAT IT ACHIEVED" (`doctrine.ts:77`).
- **Why made:** a seat's message is a claim, not the record's finding; trust boundary.
- **Collides:** N3 rule 1. CONTRADICTS.
- **Recommended:** narrow — a manager's request for something to be done is a task the agents carry
  with the manager's authority; claims of fact, and messages from non-managers, stay information.

### A2. "Everyone" in say-it-and-it's-done — up to what limit?
- **Old:** "A technician's standing request is weighed, not obeyed" (user 2026-09-24; memory
  `technician-requests-are-weighed`). "We do not trust technicians to CREATE or CHANGE L2" (user
  2026-09-09; memory `l2-is-the-managers-book`). "Only a manager widens a view" (user 2026-09-20/22;
  `docs/engineering-memory.md:5234-5239`). "Routing claims are claims" (operator 2026-09-22;
  `thoughts/shared/plans/2026-09-22-the-office-one-agent-three-doors.md:56-57`). Money to
  technicians as words (user 2026-09-15).
- **Collides:** N1's scope EVERYONE. NEEDS-SCOPE.
- **Recommended:** N1 removes the confirmation step for everyone, **within what that person may do**:
  a technician's word is the go-ahead for their own actions (their email, their note), never for
  what only a manager decides (the record's jobs, access, standing instructions to the office).
- **Also:** the 10-02 marker on memory `agent-confirmation-ux-tone` says "a MANAGER"; the
  §2 doctrine entry quotes "the manager" — both narrower than N1's stated scope.

### A3. Following up
- **Old (seat):** "If they do not engage, drop it — do not chase"; "nothing chases this"; "DO NOT
  PROMISE A REPLY" (user feedback 2026-08-25; `doctrine.ts:72, 76, 77`; s8 `bootstrap-box.sh:1184,
  1296`). **(office):** "asking again next tick because none has come yet is chasing"
  (`plannerPrompt.ts:174-177` — while `:248-252` calls a re-send "how you chase silence": the prompt
  disagrees with itself today); "THERE IS NO HANDOVER" (`plannerPrompt.ts:471-485`); "never suggest
  they are late or have been asked before" (`:427-439`). **(caps):** ask once per subject, ever (DB
  `uq_nudges_subject_ever`, `20260817090000_nudges.sql:51-56`); solo operator asks once (user
  2026-08-26); access requests not followed up, lapse 24 h (operator 2026-09-19;
  `src/db/accessRequests.ts:53`); one text per call per day (`planner.ts:687-692`); one text per sent
  invoice, ever (operator 2026-09-30; `plannerPrompt.ts:320`); code-printed replies telling people to
  chase themselves (`src/teamLead/office.ts:998-1009, 1113`).
- **Why made:** anti-spam — "over-pinging trains people to ignore pings".
- **Collides:** N3 (follows up; manager pulled in when someone won't respond). CONTRADICTS as written.
- **Recommended:** scope — for a task somebody asked for, following up until solved is the agent's
  duty, paced by judgment, honest that it is a follow-up, with silence going back to the asker; the
  anti-chase rules stay for the office's own questions. (The anti-spam reason is exactly the
  "Ben stops answering" risk, so it stays live for unasked asks.)

### A4. Confirmations — the edges of say-it-and-it's-done
- **Already overturned by N1** (operator judged 2026-10-02): the 2026-07-17 confirmation doctrine
  and its two-steps — `send_email`, `retract_capture`, `cancel_job`, `unschedule_visit` (placed),
  `add/deactivate_technician_seat`; "Show, then wait" (`doctrine.ts:70`); the 15-minute token
  machinery's purpose (`review_items`). Code: `src/mcp/tools/comms.ts:260-301`, `captures.ts:399-483,
  854-909`, `roster.ts:339-383, 495-551`, `customers.ts:713-743`, `schedule.ts:1427-1462`,
  `src/schedule/booking.ts:283`.
- **Not named by N1, need a call:**
  1. **Plan mode with Go/Change** (operator 2026-09-23/28; `src/seatGlue/jev.ts:63-75`,
     `seat.ts:887-906`, `doctrine.ts:141-149`) vs N3 "says the plan in a line, and proceeds".
  2. **The invoice send's Approve button** (user 2026-09-23; `src/seatGlue/engine.ts:239-255`).
  3. **record_field_note's new-customer preview** (user 2026-08-21: "a customer pinned by a stamped
     capture cannot be removed at all"; `captures.ts:419-476, 611-614`).
  4. **record_standing_fact's staged path** (`pending_standing_fact`, `captures.ts:1179-1212`) and
     invoices "recorded only when the manager says final" (operator 2026-09-29; `doctrine.ts:161-164`).
  5. **Unasked proposals** — "propose by staging" (`doctrine.ts:71` rule 4) and the access "offer
     first" (`doctrine.ts:77`).
  6. **The spine eval** grades commit-without-yes as a hard-zero safety failure
     (`thoughts/shared/plans/2026-08-12-spine-tool-eval.md:145`).
- **(1) ANSWERED by the operator 2026-10-04, against the recommendation below:** a task's plan is
  shown result-first, then its steps, and waits for "implement"; in normal mode each payment and
  each outside message asks again, in auto mode "implement" covers the plan. See
  `docs/engineering-memory.md` §2 "A task runs as research, plan, implement inside the chat".
- **Recommended:** (1) one-line plan then proceed — no Go button for a task the manager asked for;
  keep `ask_user` only for WHICH. (2) drop the Approve on an instructed send. (3) treat it as a
  WHICH question ("new customer, or one of these?"), which N1 keeps. (4) same as N1: an instruction
  is the yes. (5) keep staging for proposals nobody asked for (N6). (6) re-grade the eval to N1.

### A5. Saying who asked
- **Old:** "It is YOUR question. Never say where it came from" (user feedback 2026-08-25;
  `doctrine.ts:76` rule 1a, `:77` rules 3 and 5; memory `seat-agent-texts-like-a-person`); office
  chat texts "in their own assistant's voice — no preamble… no mention of having been asked"
  (`plannerPrompt.ts:109-110, 406-408, 699-702`); delivery "no frame" (user 2026-08-23); the
  rejected "server-authored verbatim sentences" (user 2026-07-15).
- **Collides:** N2's "From <name>:" header; N3 messages on a manager's behalf. TENSION.
- **Recommended:** scope — work somebody asked for says whose request it is ("Sam asked me to help
  you with…"); the office's own questions stay unattributed. Record that the "From <name>:" header
  is attribution of the manager's own words, not agent voice, so the 07-15 rejection does not apply.

### A6. Manager-touch rulings that stay (as they are about unasked or inbound work)
- **Old:** the schedule agent is reactive, "edits only when asked" (user 2026-09-05); "only the
  manager touches the schedule" (user 2026-09-06); inbound asks before it creates (user 2026-09-06/07);
  managers are nudgeable (user 2026-08-25); money class 3 needs a manager confirm (user 2026-08-15).
- **Recommended:** keep — they govern unasked/inbound work (N6). Clarify only that "when asked"
  includes the schedule steps an asked-for task works out for itself.

## Decisions — Group B: genuine choices

### B1. Waking up
- **Old:** "planner-wake-on-event — Ruled out… Cadence stays a timer" (user, §6a;
  `docs/engineering-memory.md:5422`); "Waking the planner on the answer event is RULED OUT… two
  voices in one chat" (user 2026-08-24/25; `docs/engineering-memory.md:8192-8194`; memory
  `ladder-build-schedule`); "answering is not waking" (2026-08-31); rung 10c "only `inform` wakes —
  `reply` stays OFF" (operator 2026-09-22, "A now, B with 10d"; `src/db/officeMessages.ts:423`);
  "No quiet model turn" on glue seats (operator 2026-09-23 — reason technical: SDK had no
  add-without-a-turn; `src/seatGlue/inbox.ts:7-12`); the quiet-firm skip (plan decision, cost;
  `planner.ts:4612-4616`); s8 cron only on explicit ask, open-ended jobs need approval
  (`bootstrap-box.sh:1112-1120`).
- **Collides:** N3's one structural piece — a task woken by a reply or its own follow-up time.
- **The real question:** the "two voices in one chat" reason. N2 deliberately adds a second voice
  ("From Sam:"). Does "two voices" still stand?
- **Recommended:** supersede the bans for tasks: a linked reply or a due follow-up wakes the task.
  Answer "two voices" with attribution (every message says who it is from) rather than silence.
  Leave the mechanism (office vs seat) to the plan.

### B2. Agents asking agents
- **Old:** seat-to-seat "inform yes, ask NO" (user 2026-08-31 — an answer path makes one person's
  agent decide what of its person's context to reveal; `thoughts/shared/plans/2026-08-31-the-planners-inbox.md:89-95`;
  `src/mcp/tools/office.ts:258-303`); "the office reads, never asks" (operator 2026-09-23;
  `thoughts/shared/plans/2026-09-23-step-3-office-reaches-glue-seats.md:26`; `plannerPrompt.ts:113-115`);
  agents get no private channel, the office is the hub (2026-08-15); inform_teammate lets a
  technician's seat reach a manager's seat (vs N2's one-way rule).
- **Collides:** N3 "messages people and other agents, knows whom to ask". TENSION/CONTRADICTS.
- **Recommended:** keep "agents don't ask agents" — a task asks **people** directly (a person asks a
  person, matching N2's principle) and reads a teammate's conversation when it needs context. The
  privacy reason still holds. Align `inform_teammate` with N2: technician → manager goes through the
  office.

### B3. One task vs. fresh ticks
- **Old:** "the planner's ticks are NOT one task… A persisted transcript carries forward assertions
  that were true at 17:30 and false at 18:00" (user 2026-08-29; `docs/engineering-memory.md:5874-5886`;
  `plannerPrompt.ts:520`); "cron or ping" split and fixed doors with budgets (operator 2026-09-22);
  15-minute envelope (user 2026-08-29); per-kind gap detectors and per-scenario office kinds
  (2026-08-15 → 2026-09-30).
- **Collides:** N4 adopts exactly the Claude-Code model this rejected.
- **Recommended:** both hold if a task persists as a **short plan + log** (not a transcript) and every
  wake **starts by reconciling** that plan against the record. Narrow "ticks are not one task" to
  the planner's housekeeping ticks. N4 governs new work; existing gap detectors stay until the
  general capability can absorb them (no rip-out now).

### B4. Where task records live, and privacy
- **Old:** L1 append-only, classify before L1 (CLAUDE.md); "the spine is the customer/job record,
  not a mirror" (user 2026-07-06); transcript harvest gated hard before L1 (2026-08-15); outreach not
  L1-captured (user 2026-08-16); office_messages deliberately not L1 (user 2026-08-31); agent sends
  ARE L1-captured, classifier-free, for audit (user 2026-07-04, CLAUDE.md); a manager's conversation
  is private (operator 2026-09-24; `src/mcp/tools/seatConversation.ts:76-84`).
- **Collides:** N3 puts non-job, personal matters in scope (Ben's ticket) and "writes the information
  down"; N2's texts are neither clearly an agent send nor a human's own words.
- **Recommended:** a task's plan and log live in a **deletable operational table**, never L1; only
  job facts reach L1 through the normal path; personal matters never enter L1. N2 texts are
  operational (like the office's texts today), not L1. When a manager hands over a task, the task
  record carries what the task needs; the manager's chat stays private.

### B5. Dates in agent-written messages
- **Old:** "A gap-less message may name NO DATES" (`docs/engineering-memory.md:6541-6542`;
  `planner.ts:2729-2744`); gap messages only the allowed dates (`planner.ts:2303-2311`); reason: the
  model fabricates dates, and "the manager is NEVER a verification layer for dates" (user 2026-08-11).
  Link rail and 500-char caps (`planner.ts:2295, 2359-2372, 2742`).
- **Collides:** N3 messages need dates ("file by Nov 1", "Thursday 9").
- **Recommended:** a message may name only dates the system can show the source of (the record,
  `resolve_date`, the asker's own words). Keeps the machine-side date safety; lets tasks speak.
  Links and length: allow what a task's step needs (a document link), decided in the plan.

### B6. The wording of today's narrowing (N6)
- **Old, all acting unasked with no confirm:** the office texts technicians record-keeping questions
  (2026-08-24 one-call collapse); a sent invoice is auto-recorded, then the manager told (operator
  2026-09-30); the extractor creates, doesn't stage (user 2026-09-03); money class 2 auto-records
  (user 2026-08-15).
- **Collides:** N6 read literally ("anything unasked is proposed and confirmed").
- **Recommended:** reword N6 to what it meant: **a new behaviour nobody asked for** (anticipation) is
  proposed first; routine record-keeping questions and recording what already happened stay as they are.

### B7. Two yardsticks
- **Old:** "Judge a feature by whether it thickens the fit… this outranks the plan" (user 2026-09-15).
- **New:** "Judge a feature by whether a task finishes with fewer manager touches… this outranks the
  plan" (2026-10-02). Also "could-not vs did-not" must split any answer metric (user 2026-08-21).
- **Recommended:** one sentence: fewer manager touches is the **output** we promise; the fit is what
  makes touches fall over time and what we keep. Count a correct hand-back to the manager as a
  could-not, not a failure.

### B8. Building the task runtime, and where it sits in the order
- **Old:** "I don't want to build the cowork harness" — bought harness (user 2026-09-20/21); six-step
  order 1 → {2,3,4} → 5 → 6, parked one at a time (operator 2026-09-22); nothing to production until
  the whole order is evaluated (user 2026-08-29, since loosened); sub-agents out of batching
  (operator 2026-09-28); outside-assistants direction (2026-09-30, not ruled).
- **Collides:** the sleep/wake task runtime is harness-shaped and has no slot in the order.
- **Recommended:** the task runtime is **ours** — it is the edge, not a commodity harness; the bought
  harness still runs each seat's conversation. Slot it after step 5 (OpenClaw removal), or say where.

### B9. Who may text a technician
- **Old:** tiers are only manager and technician; "technician" is the catch-all incl. office staff
  and call-takers (user 2026-07-02; memory `pricing-access-tiers`); the office (dispatcher) has no seat
  shape (2026-09-29 research).
- **Collides:** N2 is manager-only, "mirroring real-world paths" — but in a 10–29 person shop the
  dispatcher is who texts technicians.
- **Recommended:** keep N2 manager-only for now; the office-staff seat shape is its own decision (park it).

## Already dead or overtaken — no judgment needed

Send window 7am–7pm (deleted 2026-08-29); `escalate` and `leave` (deleted 2026-09-01); acting
clocks and `extend` (deleted 2026-08-31); the 2-asks/person cap (removed 2026-08-18); the
"nothing irreversible or externally visible" dispatch rule (retired 2026-09-08); the decline verb
(superseded); freeze / re-solve / undo (deleted, rung 8); invoice v1 (superseded by 2e);
booking/move previews (always one-shot since rung 9a, `booking.ts:525, 812`).

## Housekeeping owed after the operator rules (no judgment)

- Mark superseded in place: memory `pricing-access-tiers`, `composio-connector-layer`,
  `intelligent-spine-direction`, `solo-operator-no-escalation`, `harness-is-places-and-verbs` (wake
  line), `ladder-build-schedule` (wake line), `nudge-pacing-by-urgency` ("unchanged" list),
  `seat-agent-texts-like-a-person`, `agent-confirmation-ux-tone` (marker says MANAGER; N1 says everyone),
  and the MEMORY.md hooks that restate them; the matching `docs/engineering-memory.md` entries.
- Bugs found on the way (not rulings): the office prompt disagrees with itself on re-sending
  (`plannerPrompt.ts:174-177` vs `:248-252`); `inform_teammate` promises "within minutes" on glue
  seats (`src/mcp/tools/office.ts:330`); the office is told to "say the office will follow up"
  (`officePrompt.ts:97-98`) though nothing follows up; a failed seat resume silently starts fresh
  (`src/seatGlue/engine.ts:281-290`); the seat doctrine and office prompts listed above are prompt
  text that the build must change with the rulings.

## Verified by hand

`docs/engineering-memory.md:5422, 5874-5880, 8192-8194`; `src/teamLead/plannerPrompt.ts:173-179,
248-252`; `src/teamLead/officePrompt.ts:96-99`; `src/teamLead/planner.ts:2729-2733, 3554-3558`;
`src/seatGlue/doctrine.ts:11-12, 42, 72, 76, 77`; `src/seatGlue/seat.ts:652-656`;
`src/mcp/tools/office.ts:326-332`; `thoughts/shared/plans/2026-08-31-the-planners-inbox.md:89-95`;
`thoughts/shared/plans/2026-09-23-step-3-office-reaches-glue-seats.md:23`;
`thoughts/shared/plans/2026-09-22-rung-10c-a-seats-message-wakes-the-office.md:66-67`; memory
`technician-requests-are-weighed` (user doctrine 2026-09-24) and `agent-confirmation-ux-tone:10`.
Other line numbers come from the seven sweeps and were not each re-read.
