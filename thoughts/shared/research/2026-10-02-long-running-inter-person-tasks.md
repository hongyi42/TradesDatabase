---
date: 2026-10-02
branch: main (read at origin/main, detached)
commit: 5f36e45
topic: Long-running inter-person tasks — what the system must have, from first principles, and what the code on main has and lacks today
supersedes: nothing
---

# Long-running inter-person tasks: requirements and inventory

**Asked by the operator (2026-10-02):** *"Give a first principles led evaluation on what is required
of the system for this type of workflow to be possible. Then research the things that we have
already and those we lack. Remember, we've built an agentic plumbing with people on the other end of
it… We take it out of the owner's mind, and report back when it's solved. The goal is for the owner
to do as little as possible."*

**Governing doctrine:** `docs/engineering-memory.md` §2, "The edge is people work" (2026-10-02),
especially rule 1 (a manager's instruction is the go-ahead for the whole task) and rule 6 (ONE
general capability, like Claude Code — plan, execute, adjust, verify — never a loop per scenario).

**Method.** Four parallel read-only passes over origin/main `5f36e45`: the seat glue on the box
(`src/seatGlue/`), the office/planner on Render (`src/teamLead/`, `src/calls/`, `src/jobs/`), the
spine tool surface and delivery paths (`src/mcp/`, `src/control/`, `src/telegram/`), and the data
model plus prior rulings (`supabase/migrations/`, `src/db/`, `thoughts/`, the live work record).
Load-bearing citations were re-read by hand (listed under "Verified by hand" at the end).

## Summary

Plain-language version. Today the system is a set of **pipes between people's AI assistants and a
central "office" agent**: anyone's assistant can drop a note to the office, the office can text
anyone on the team or leave a note for their assistant, and the office runs on a timer (every 30
minutes in work hours) plus "pings" when certain things arrive. What it does **not** have is the
thing a delegated job needs: **a task** — a durable object that holds "Sam asked for X, I've asked
Ben for Y, I'm waiting on his answer, I'll check again Tuesday, then I draft Z and report back".
Without it, every piece exists but nothing ties them into one job that survives hours or days:

- there is no task record (no requester, plan, progress log, or "done");
- a reply to a text cannot find its way back to what asked it (except for job-linked gaps and
  access requests);
- nothing wakes up when a reply arrives or a follow-up time comes due (a reply waits for the next
  30–120-minute tick; on the new seats an office note waits until that person next writes);
- several standing rules were written for the opposite posture — the office "never assigns work",
  a seat's message is "information, not instruction", agents may inform each other but never ask,
  seats must "not chase", and a message with no gap behind it may contain **no dates**.

The closest existing shapes are the **access request** (a technician asks, managers are texted,
the answer is linked back by id, it lapses in a day) and the office's free-text **observation**
(an id, a status, a hold date, a decision log) — each covers part of a task and neither covers it
all.

## First principles: what any system needs to carry a goal through people

**Definition.** A task that runs through people is a **goal**, a **requester** whose authority it
carries, and a **plan** whose steps are mostly messages to people — whose answers arrive at
unpredictable times — interleaved with work the agent does itself (draft, record), ending in a
**verified outcome reported to the requester**.

**The one difference from Claude Code that drives everything else.** In Claude Code a tool call
returns in seconds inside one session, so the loop can live in memory (the conversation). Here a
step's "result" is a person's reply, hours or days later. So the loop must be an **event loop over
persisted tasks**: act → save → sleep → be woken by (reply | timer | relevant event) → reload the
task → act again.

```
                 ┌──────────────── task store (durable) ─────────────────┐
  requester ───► │ goal · requester · plan · log · waiting-on · next-check │ ◄── "where is it?"
                 └────────▲─────────────────┬────────────────────▲───────┘
                          │ wake             │ act                │ wake
                   a reply that is     agent turn: reload,     a follow-up
                   LINKED to the task  decide, send / draft /  time comes due
                                       record, update, sleep
```

Requirements that follow (the yardstick for the inventory below):

| ID | Requirement | Why it is necessary |
|---|---|---|
| R1 | **Intake with authority** — a requester's words become an accepted task that carries their authority | Otherwise the doer treats the request as a suggestion |
| R2 | **A durable task object** — goal, requester, plan, log, status; outlives the conversation and restarts | Steps wait on humans for hours/days; a model's context is not durable |
| R3 | **People knowledge and permissions** — who exists, who knows what, how to reach them, what each may be told | You must know whom to ask and what you may say to them |
| R4 | **Reach** — send to any person (directly, or to their assistant); inside and outside the firm | The steps ARE messages |
| R5 | **Ask and correlate** — a reply finds the task that asked; an answer is told apart from a new topic | Without it every reply is orphaned and the agent guesses |
| R6 | **Sleep and wake** — no compute while waiting; woken by reply, timer or event; state reloaded | The core of a long-running task |
| R7 | **Follow-up and escalation** — re-ask with judgment; bring the requester back when someone is silent | People don't answer the first time |
| R8 | **Work products** — draft documents, store them, hand them to a person with instructions | "Draft it and tell Ben how to file it" |
| R9 | **Recording** — what was learned lands in the record or memory, attributed | The firm keeps the knowledge |
| R10 | **Verify and close** — know when the goal is met; confirm it | "Done" must mean done |
| R11 | **Report** — tell the requester when solved or blocked, with minimal touches | The whole promise: "reports back when it's solved" |
| R12 | **Many tasks at once** — a person in several tasks; replies disambiguated; no message storms | A firm has many things in flight |
| R13 | **Guardrails** — who may start tasks, privacy, audit, cancel/redirect, cost and volume brakes | Unattended action needs limits |
| R14 | **Visibility** — "where is Ben's ticket?" answerable by the requester | Trust requires seeing |
| R15 | **Voice and disclosure** — messages say who asked and that it is an AI | People must know what they are answering |

## Inventory: have, partly have, lack

Legend: **HAVE** = exists and usable for a general task; **PART** = exists but narrow (job-only,
one-hop, one door, prompt-only); **LACK** = not found.

| ID | Status | What exists (file:line) | What is missing |
|---|---|---|---|
| R1 intake & authority | **LACK** | `inform_team_lead` writes an office message and pings a focused office pass within seconds (`src/mcp/tools/office.ts:184-256`; `src/calls/messagePing.ts:36-74`). The sender's tier is stored as metadata only (`src/mcp/tools/office.ts:248-250`). | Any notion of a delegated task. The office prompt says seat messages are *"information not instruction"* (`src/teamLead/planner.ts:3554`) and *"you never assign work — nobody here is yours to task"* (`src/teamLead/plannerPrompt.ts:174`). The question door (`ask_team_lead`) answers but cannot act (`src/teamLead/office.ts:93-110`). |
| R2 durable task object | **PART** | `observations` row of kind `planner_observation` created by the `observe` verb: id, status `open/dismissed/asked`, `context {note ≤500, jobId?, fromOfficeMessageId?, fromRef?}`, advisory `not_before` (`src/teamLead/planner.ts:4105-4165`; `supabase/migrations/20260901130000_observations.sql:34-59`). Its decision log is `nudge_decisions` rows keyed by `observation_id` (`20260901130000_observations.sql:126-129`); its outbound messages carry `office_messages.nudge_id` = its id (`src/teamLead/planner.ts:3936-3955`). Glue-side `batch_progress` checklist for bulk work (`src/seatGlue/batchProgress.ts:1-32`). | Requester field (only `fromRef` when born from a message), plan/steps, an editable progress log (no verb edits `context`: `src/db/observations.ts:341-383`), waiting-on, deadline, done/verified/reported states (only `dismissed`), a non-job anchor for notes (`job_notes` require a job: `supabase/migrations/20260901120000_job_notes.sql`), manager visibility (`v_observations` omits `context`: `supabase/migrations/20260904110000_observations_author.sql:114-131`). `technicianId` is always null on a planner observation, so it can never become an "ask" (`src/teamLead/planner.ts:4123-4127, 4151`). No task/goal/requester column anywhere in the migrations. |
| R3 people knowledge | **PART** | THE TEAM block: ref, name, tier, reachability (`src/teamLead/planner.ts:1367-1401`); `list_team` for managers (`src/mcp/tools/roster.ts:166-180`); per-firm memory files (`src/db/plannerMemory.ts`; `src/teamLead/memory.ts:21-30`); `read_conversation` over technician seats, 7 days default, 90-day retention (`src/mcp/tools/seatConversation.ts:17-33`); tier gates and the technician view (`src/mcp/server.ts:629-749`; `src/db/technicianView.ts`). | No structured store of who does what, preferences or response patterns; no manager→technician relation in the schema; a manager's chat is never readable (`src/mcp/tools/seatConversation.ts:76-84`); technicians have no roster listing. The office's money rule for what it may say is prompt-only (`src/teamLead/plannerPrompt.ts:116-121`). |
| R4 reach | **PART** | Office `send` to anyone on THE TEAM, by `chat` (verbatim to their phone) or `assistant` (a note to their assistant) (`src/teamLead/planner.ts:2463-2525, 3880-3955`); `inform_teammate` seat→seat when one side is an active manager (`src/mcp/tools/office.ts:293-303`); `send_email` from a seat to any address, two-step (`src/mcp/tools/comms.ts:56-89`); manager seats' Composio relay (`src/composio/sessions.ts:31-33`). | A manager seat cannot text a technician directly (only the office writes `via='chat'`, `src/teamLead/planner.ts:3954`) — the in-flight task "say it and it's done" adds one, manager→technician only. The office has no `send_email` and no channel outside the roster. On glue seats a note to an assistant waits for that person's next message (see R6). |
| R5 ask & correlate | **PART** | Gap asks: a later `record_field_note` on the same job is linked when exactly one asked gap is open for that person on that job (`src/mcp/tools/shared.ts:352-373`; `src/db/nudges.ts:641-656`). Assistant-leg notes carry an id; a seat replying with `inform_team_lead(replyToMessageId)` becomes kind `reply` and inherits the item id (`src/mcp/tools/office.ts:208-254`; `src/control/officeQueue.ts:70-74`). Access requests are answered by `requestId` (`src/mcp/tools/access.ts:98-100`). | **Chat-leg replies are never linked**: *"A person answering a CHAT message answers their own assistant, which files a record_field_note and no office row at all"* (`src/db/officeMessages.ts:147-151`; `src/teamLead/planner.ts:3605-3613`). Glue phone items reach the model with no id (`src/seatGlue/seat.ts:711-724`). `inform_teammate` has no reply path. `office_messages.message_group_id` is reserved and unwritten (`supabase/migrations/20260903130000_office_messages_via.sql:53`). No `task_id`/correlation id exists in `src`. |
| R6 sleep & wake | **PART** | Office cadence: 30 min in work hours, 120 outside (`src/teamLead/planner.ts:568, 585`), run from the 5-minute `lifecycle-heart` cron (`src/jobs/lifecycle.ts:30-31, 548-598`); pings for `inform` messages and inbound observation kinds, 180-second focused passes (`src/db/officeMessages.ts:419-423`; `src/db/observations.ts:405-410`; `src/jobs/plannerPass.ts:89`). `hold(notBefore)` on any item (`src/teamLead/planner.ts:3380-3410`). Seat sessions resume across restarts (`src/seatGlue/engine.ts:273-291`). | `hold` wakes nothing — the item is re-shown every tick and held items only sort last (`src/teamLead/planner.ts:671-685`; `src/teamLead/plannerPrompt.ts:66-68`). A linked `reply` does not wake the office (`src/db/officeMessages.ts:419-423`). **A glue seat never starts a turn on office traffic**: items are marked delivered and wait for the person's next message (`src/seatGlue/seat.ts:652-689`; ruling at `thoughts/shared/plans/2026-09-23-step-3-office-reaches-glue-seats.md:23`). Seats have no timers (*"Scheduled / recurring work … this engine has neither"*, `src/seatGlue/doctrine.ts:11-12`). No `wake_at`/`next_ask_at` column anywhere. |
| R7 follow-up & escalation | **PART** | The office may re-ask as an ordinary message, paced by judgment (`src/teamLead/plannerPrompt.ts:240-252, 395-403`); logged-only alarms at 24 h/18 h/72 h (`src/jobs/watchers.ts:123-130`). | Seat doctrine forbids chasing: *"nothing chases this"* (`src/seatGlue/doctrine.ts:72`), *"drop it — do not chase"* (`:76`), *"nothing chases a manager who does not answer"* (`:77`). `escalate` was deleted (`src/teamLead/planner.ts:145-158`). Delivery status of office messages is not shown to the planner (`src/teamLead/planner.ts:3629-3639`). The office prompt calls asking again next tick "chasing" (`src/teamLead/plannerPrompt.ts:174-177`). |
| R8 work products | **PART** | Manager E2B sandbox builds PDF/DOCX (`src/seatGlue/fileTools.ts:176-426`; gated at `src/seatGlue/main.ts:124-148`); `save_file`/`link_file` file store (`src/db/files.ts:25-31`); `draft_document` for invoices/estimates (`src/mcp/tools/documents.ts:33-67`); email attachment (`src/mcp/tools/comms.ts:246-257`). | No general document type; `link_file` targets customer/job/visit/money/document only — no person, no task; **no tool sends a file to a teammate** (`send_file`/`share_file` reach the seat's own person only). Office messages are ≤500 chars (≤1200 grouped), refuse links (`src/teamLead/planner.ts:2295, 2364-2372`), and a message with no gap behind it may contain **no dates** (`src/teamLead/planner.ts:2729-2733`). Technicians have no sandbox. |
| R9 recording | **PART** | L1 writers: `record_field_note`, `record_standing_fact`, `send_email`, Composio log ingest (`src/mcp/tools/captures.ts:91-306`; `src/mcp/tools/comms.ts:446-466`; `src/composio/logIngest.ts:10-23`); office memory and job notes (`src/mcp/tools/office.ts:404-454`; `src/teamLead/jobNotes.ts:20-57`); `nudge_decisions` log. | The office cannot write a note or standing fact (only kind-locked `record_caller`/`record_sent_invoice`, `src/teamLead/identity.ts:54-91`). Telegram messages between agents and people are not in L1 (`office_messages`, `nudges`, `person_pushes`, `seat_turns` are operational). No "acted for X at Y's request" attribution; the `manager_assistant` channel exists in the enum but nothing writes it. |
| R10 verify & close | **PART** | `close` with a verified citation or a code-computed record fact (`src/teamLead/planner.ts:3239-3354`); `spine_read` is citable. | `read_conversation` results are not citable (`CITABLE_TOOLS`, `src/teamLead/planner.ts:2163`); a planner observation can close only by dismissal or an evidence quote; no "verified" state; nothing outside the firm's record can be checked. |
| R11 report to requester | **PART** | A gap-less office `send` to a manager (`src/teamLead/plannerPrompt.ts:132-134`). | No requester field, so nothing says whom to report to; no required report step; the report is not linked to the request; the manager's seat cannot be woken to tell the manager (it waits until the manager writes, `src/seatGlue/seat.ts:652-689`). |
| R12 many tasks at once | **PART** | The planner sees all open items, ≤100 per look (`src/teamLead/planner.ts:660-685`); ≤30 messages per tick (`:3500`); `ask_group_id` folds several gaps into one message (`supabase/migrations/20260825000000_nudge_ask_group.sql:22`). | One firm-wide loop re-reads every item every tick inside a 15-minute clock (`src/model/toolLoop.ts:70`); firms run serially (open finding 20260915); one seat session = one shared context for everything (`src/seatGlue/turnPolicy.ts:47-93`); glue pending items capped at 30, oldest dropped (`src/seatGlue/seat.ts:48, 674-683`). |
| R13 guardrails | **PART** | Roster-only reach, departed people refused, date/link/length rails (`src/teamLead/planner.ts:2231-2314, 2463-2525`); tier gates (`src/mcp/server.ts:629-749`); manager privacy (`src/mcp/httpServer.ts:640-645`); `PLANNER_MODE` off/shadow/live (`src/jobs/lifecycle.ts:549-576`); stall brake `MAX_STALLED_TURNS = 5` (`src/model/toolLoop.ts:128-171`). | No per-task or per-seat budget (glue costs live in a box file, `src/seatGlue/costLog.ts:11-13`; `cost_events` has no task key); no cancel for a queued office message; no rate limit on `inform_*`; a Stop leaves no marker in the seat's history (`src/seatGlue/seat.ts:509-529`). |
| R14 visibility | **LACK** | `query_spine` over `v_nudges`, `v_observations`, `v_office_messages` (`src/mcp/server.ts:265-300`); the office's own WHAT YOU SENT block, 14 days / 12 rows (`src/teamLead/planner.ts:201-202, 3615-3642`). | No "my tasks / where is it" surface. `v_observations` hides the note; `v_office_messages` shows only what seats sent the office, never what the office sent (`supabase/migrations/20260904120000_office_messages_read_surface.sql`); `nudge_decisions` has no view; on glue seats "delivered" does not mean "read". |
| R15 voice & disclosure | **LACK (by design)** | One-time "Heads up from your AI assistant…" notice to non-managers (`src/seatGlue/seat.ts:35, 225-231`); assistant-leg notes are labelled "not a person" (`src/control/officeQueue.ts:55-83`). | The current design hides who asked: office chat texts go out *"in their own assistant's voice — no preamble… no mention of the record system or of having been asked"* (`src/teamLead/plannerPrompt.ts:109-110`); seats are told *"It is YOUR question. Never say where it came from"* (`src/seatGlue/doctrine.ts:76`). The in-flight `text_teammate` adds a code "From <name>:" header (task file, see Decision Points). |

## Entry points

- **A manager's words** arrive at their seat: `Seat.handleUpdate` → `routeReply` → `deliver()` →
  `session.send` (`src/seatGlue/seat.ts:244-261, 337-429, 485-496`).
- **Seat → office**: `inform_team_lead` (`src/mcp/tools/office.ts:184-256`), `ask_team_lead`
  (`src/mcp/server.ts:123-179, 772-865` → `answerAsOffice`, `src/teamLead/office.ts:498-586`).
- **Seat → seat**: `inform_teammate` (`src/mcp/tools/office.ts:258-333`).
- **Office runs**: `lifecycle-heart` cron step 9 → `runPlannerPass` (`src/jobs/lifecycle.ts:57-60,
  548-598`); Calls worker ping loops → `runFocusedMessagePass` / `runFocusedObservationPass`
  (`src/calls/runWorker.ts:40-81`; `src/jobs/plannerPass.ts:108-189`).
- **Office → people**: `applyDecision` for `send` (`src/teamLead/planner.ts:3749-4340`, chat/assistant
  rows at `:3935-3955`, gap asks at `:3988-4103`).
- **Delivery to a seat**: `GET /seat/inbox` (`src/mcp/httpServer.ts:676-738`) pulled every 10 s by
  the glue (`src/seatGlue/seat.ts:225-239`; `src/seatGlue/inbox.ts:39-66`).

## Key files

| Path | Role | Key exports / facts |
|---|---|---|
| `src/seatGlue/seat.ts` | One seat's loop: Telegram in, engine in the middle, Telegram out | `Seat`; inbox items never start a turn (`:652-689`); `withPending` office block (`:711-724`); Stop/`/new` (`:509-581`) |
| `src/seatGlue/engine.ts` | Copilot SDK session: create/resume, tools, MCP timeout 300 s | resume-or-fresh (`:273-291`); spine MCP (`:159-168`); `ask_user` managers only (`:208-216`) |
| `src/seatGlue/doctrine.ts` | Static seat system prompts compiled into the glue | no cron (`:11-12`); office traffic rides the next message (`:41-42`); "do not chase" (`:72, 76, 77`) |
| `src/seatGlue/state.ts` | `state.json`: sessionId, Telegram offset, `pending[]`, `handledIds[]` | the only glue-side durable state besides the engine's |
| `src/seatGlue/batchProgress.ts` | Per-job checklist file in the manager sandbox | the only "plan that survives" on the seat side |
| `src/teamLead/planner.ts` | The office/planner: prompt assembly, validation, `applyDecision` | `PLANNER_ACTIONS = send, hold, close, dismiss, recover, observe` (`:159-171`); cadence (`:568, 585`) |
| `src/teamLead/plannerPrompt.ts` | Planner doctrine text | "never assign work" (`:174`); chat voice hides the record system (`:109-110`) |
| `src/teamLead/office.ts` | The office's waiting doors (question, access) | answer-only toolsets (`:93-146`); access request flow (`:697-1058`) |
| `src/mcp/tools/office.ts` | `inform_team_lead`, `inform_teammate`, `recall_decisions`, memory tools | reply linking (`:208-254`); "reads it within minutes" return text (`:326-332`) |
| `src/mcp/tools/surface.expected.ts` | Authority for the per-tier tool catalog | technician 20 tools, manager-only 37, planner list |
| `src/control/officeQueue.ts`, `src/control/nudgeQueue.ts` | Wrapping and delivery state for office rows and gap asks | assistant-leg wrapper with id (`officeQueue.ts:55-83`); chat leg verbatim, no id (`nudgeQueue.ts:263-273`) |
| `src/db/observations.ts`, `src/db/nudges.ts`, `src/db/officeMessages.ts` | Typed accessors for the three durable "work" tables | no context-edit verb (`observations.ts:341-383`); only `inform` pings (`officeMessages.ts:419-423`) |
| `src/db/accessRequests.ts` | The access request as an observation | 24 h lapse applied at read time (`:30-53`); first answer wins (`:262-277`) |
| `src/mcp/tools/seatConversation.ts` | `read_conversation` for the office | managers private (`:76-84`) |

## Data flows

### Today's path for "help Ben defer his ticket" (the s2 specimen, 2026-10-02)

```
Sam ─Telegram─► s2 seat (box; private Copilot session; one context)
                  │ spine-inform_teammate(ben-shelton, note)
                  ▼
        Render: office_messages {to_agent, kind inform, via assistant, queued}
                  │ GET /seat/inbox every 10 s (s5)
                  ▼
        s5 glue: marks it DELIVERED, parks it in state.pending  ──►  waits for Ben's NEXT message
                  │ (Ben writes — hours or days later)
                  ▼
        s5 turn: "[Since your person last wrote — for you, not from them] <note>" + Ben's text
                  │ Ben's assistant asks Ben "the normal way"; Ben answers his own assistant
                  ▼
        the answer stays in s5's conversation (seat_turns; office may read it, not cite it)
                  ✗ nothing carries it back to s2 or Sam · no task to update · nobody reports
```

### The office's path, if the request goes through it instead

```
s2 ── inform_team_lead(note) ──► office_messages {to_planner, inform}
                                   │ message ping (~10 s) → focused pass (180 s, ONE message, no gaps shown)
                                   ▼
                     office may: send(to Ben, chat | assistant)   [no dates allowed; ≤500 chars]
                                 observe(note)                    [planner_observation, no person]
                                 write_memory / write_job_note    [job note needs a job]
                                   │ message marked READ — seen once
                                   ▼
Ben replies on the CHAT leg ──► answers his own assistant ──► no office row
                                   (only read_conversation, not citable; or a field note on a job)
Ben's assistant replies on the ASSISTANT leg ──► inform_team_lead(replyToMessageId) ──► kind 'reply'
                                   │ does NOT wake the office → next tick (30–120 min)
                                   ▼
                     planner sees "in reply to …" → close/dismiss the observation; send to Sam (no dates)
```

### The closest existing end-to-end shape: the access request

```
technician ─ ask_team_lead(accessRequest) ─► office picks the manager + words (office.ts:810-879)
   code files an observation {kind access_request, requestKey} and texts managers (office.ts:1018-1058)
manager ─ grant_access / decline_access(requestId) ─► technician texted; her seat noted;
   office gets 'news' (access.ts:342-375).  Lapses after 24 h at read time (accessRequests.ts:53).
```

It has a requester, a linked answer, and an ending, but it is one fixed shape, it never chases,
and it covers one kind of question.

## External dependencies

- **GitHub Copilot SDK** (`@github/copilot-sdk`, seat engine; sessions as files; `ask_user`,
  `exit_plan_mode`; MCP over HTTP with a 300 s timeout) — `src/seatGlue/engine.ts`.
- **OpenRouter** — seat model route `@preset/trades-seats`; the planner model on `lifecycle-heart`
  is `z-ai/glm-5.3` per `docs/engineering-memory.md` (not in code).
- **Telegram Bot API** — long polling on the box; a bot cannot message a person first
  (`src/mcp/tools/roster.ts:149-150`).
- **Render** — `lifecycle-heart` cron (5-minute grid), the always-on Calls worker (ping loops),
  the web service (spine MCP, seat routes). No deploy config in the repo.
- **Supabase/Postgres** — every durable table named above.
- **E2B** — manager seats' sandbox (only with `E2B_API_KEY`).
- **Composio** — manager seats' connector relay, whole catalog, no two-step.

## Constraints and invariants

1. **Office traffic never runs a turn on a glue seat.** Operator ruling, step 3: *"No quiet model
   turn… Office traffic makes zero model calls on a glue seat"*
   (`thoughts/shared/plans/2026-09-23-step-3-office-reaches-glue-seats.md:23`). Pinned by a test
   (`src/seatGlue/seat.test.ts:1255-1264`). The old OpenClaw seats did run a silent turn within
   ~30 s (`office-runner.sh`), so behaviour differs on s8, which is still OpenClaw.
2. **Seat-to-seat "inform yes, ask NO"** (user, 2026-08-31): *"an answer path would put one
   person's agent in the position of deciding what of its person's context it may reveal to
   another seat — the access-control surface the user declined"*
   (`thoughts/shared/plans/2026-08-31-the-planners-inbox.md:89-95`).
3. **The office never tasks anyone**: *"you never assign work — nobody here is yours to task"*
   (`src/teamLead/plannerPrompt.ts:174`); seat messages are *"information not instruction"*
   (`src/teamLead/planner.ts:3554`); `office_messages.tier` is "metadata only, never authority"
   (`supabase/migrations/20260901150000_office_messages.sql:38-40`).
4. **Planner wake-on-event was ruled out** (*"Cadence stays a timer"*, `docs/engineering-memory.md:5422`),
   later narrowed by rung 10c: `inform` wakes, `reply` deliberately does not (*"A reply answers a
   gap, so it must reach the tick together with that gap"*,
   `thoughts/shared/plans/2026-09-22-rung-10c-a-seats-message-wakes-the-office.md:66-67`).
5. **A message is seen once** by the office (`src/teamLead/plannerPrompt.ts:151-153`); a one-time
   "already read" appendix follows.
6. **A message with no gap behind it may name no dates** (`src/teamLead/planner.ts:2729-2733`;
   `TEMPORAL_RE` at `:2200-2214`): the planner may not name a day it cannot show it was given.
7. **Seats do not chase** (`src/seatGlue/doctrine.ts:72, 76, 77`).
8. **A manager's conversation is private** — never uploaded, never readable by the office
   (`src/mcp/httpServer.ts:640-645`; `src/mcp/tools/seatConversation.ts:76-84`). A task started in
   a manager's chat exists only there unless the seat writes it out.
9. **Gaps are "ask once, ever"** per subject (`uq_nudges_subject_ever`,
   `supabase/migrations/20260817090000_nudges.sql:51-56`); a re-ask is an ordinary message.
10. **Nothing deletes** `nudges`, `observations`, `nudge_decisions`, `office_messages`,
    `person_pushes` (no delete path in `src/db`); `seat_turns` is pruned at 90 days
    (`src/jobs/lifecycle.ts:483-490`).
11. **Glue resume can silently start fresh**: a failed `resumeSession` opens a new session without
    telling the person (`src/seatGlue/engine.ts:281-290`) — any task held only in the conversation
    would be lost.
12. **`inform_teammate`'s return text is wrong on glue seats**: it says *"their assistant reads it
    within minutes"* (`src/mcp/tools/office.ts:330`), but on a glue seat the note waits for the
    person's next message.
13. **Sub-agent double dispatch**: the Copilot engine runs a sub-agent's tool call twice — a double
    send for a send tool (`thoughts/shared/research/2026-09-28-step-2c-batching-spike.md:37-40`).

## Decision points

Each is a fork the current code creates; stated as what each option would involve today.

1. **Where a task lives.**
   - *On the manager's seat (box):* the request is already there, and the seat has the manager's
     context. But the seat is one private Copilot session with no timers, no turn on office
     traffic, and nothing durable but the conversation and `state.json`; the office cannot read it.
   - *In the office (Render):* it has durable tables, a cron, pings, roster-wide reach, and a
     decision log. But its doctrine treats seat messages as information, it sees each message once,
     and its message pass sees no gaps.
   - *Split:* the seat states the plan and hands the task over; the office carries the waiting and
     reports back. This needs a handover object, because the manager's chat is private.

2. **The task object.**
   - *Extend `observations`:* it already has an id, status, `not_before`, a decision log through
     `nudge_decisions.observation_id`, and message linkage through `office_messages.nudge_id`. It
     lacks a requester, plan/log fields, a context-edit verb, a person (so it can never be an "ask"),
     done/verified states, and a view that shows the note.
   - *A new table:* starts clean, but needs its own links to `office_messages` and
     `nudge_decisions` and its own place in the planner's prompt.

3. **How a task wakes.** Today only the 30/120-minute cadence and `inform` pings wake anything.
   - *Reply wakes:* add `reply` to `PINGED_MESSAGE_KINDS` — the rung 10c plan's deferred "fix B
     with 10d".
   - *`not_before` becomes a wake:* nothing reads it as one today.
   - *Seats get a turn on office traffic:* reverses the step-3 "no quiet model turn" ruling and
     costs a model call per item.
   - *Timers on the seat:* the engine has none (`doctrine.ts:11-12`).

4. **How a reply finds its task.** Chat-leg texts carry no id and leave no office row.
   - *An anchor on chat texts,* like the gap path's code-printed "(re: …)".
   - *Route answers through the assistant leg,* where `replyToMessageId` already links.
   - *Make `read_conversation` citable.*
   - *A field note on a job* — but only job-linked subjects have one.

5. **Authority — which prior rulings stand.** Rule 1 of the 2026-10-02 doctrine (a manager's
   instruction is the go-ahead for the whole task) meets four standing rules: "inform yes, ask NO",
   "never assign work", "information not instruction", and "seats do not chase". Each would be
   kept, narrowed, or superseded for manager-started tasks.

6. **Voice and disclosure.** The current chat voice hides that anyone asked (`plannerPrompt.ts:109-110`;
   `doctrine.ts:76`). The in-flight `text_teammate` puts a code-added "From <name>:" header on a
   manager's verbatim text. A task's messages would follow one or the other posture.

7. **Dates in task messages.** The date rail admits no date in a gap-less message, so "file by
   Nov 1" is refused today. A task deadline would need a source the rail can check against, or a
   different rail for task messages.

8. **Reach outside the firm** (open in the doctrine). The office has no `send_email`; seats do, and
   manager Composio sends skip the two-step. A task step outside the firm runs either from a seat
   or from a new office channel.

9. **Work products to a teammate.** No tool sends a file to another person's Telegram, and
   `link_file` has no person or task target. A drafted letter for Ben reaches him either by email
   (`send_email` with `fileId`, Ben's address supplied by the manager), by a new file-to-teammate
   path, or by attaching it to a task the seat can read.

10. **Visibility.** A requester-facing "where is it" view needs task rows visible to managers;
    today `v_observations` hides `context` and `v_office_messages` hides the office's sends.

## Open questions

- **Latency on glue seats in practice:** how often does a technician write to their seat? On glue
  seats this sets the latency of every assistant-leg note (it waits for the next message). The
  pilot has no organic users, so it cannot be measured there.
- **Cost of waking:** a woken seat turn on a long session costs a full prompt (the manager seat's
  baseline is large; compaction on long sessions is untested, `docs/engineering-memory.md:1891`).
  What a woken task turn costs is unmeasured.
- **s8 is still OpenClaw:** office notes there run a silent turn within ~30 s; glue seats wait.
  Any task design meets two behaviours until step 5 retires OpenClaw.
- **What the manager's seat may hand over:** the manager's chat is private by ruling; how much of
  "Sam asked me to…" may leave the seat as task text is not settled anywhere.
- **The firm-serial planner** (open finding 20260915): every tick re-reads every open item within
  15 minutes per firm, firm after firm. How this behaves with tens of live tasks per firm is
  unmeasured.
- **Telegram first contact:** a bot cannot message a person who never started it
  (`roster.ts:149-150`); every reachable person today is bound, but a task that names someone not
  yet bound has no channel.
- **Double dispatch** for send tools if a task runner uses Copilot sub-agents (constraint 13).

## Verified by hand

Re-read at `5f36e45` after the four passes: `src/seatGlue/seat.ts:652-656`;
`src/seatGlue/doctrine.ts:11-12, 42, 72, 76, 77`; `src/mcp/tools/office.ts:326-332`;
`src/teamLead/planner.ts:2729-2733, 3554-3558, 3605-3613`; `src/teamLead/plannerPrompt.ts:173-179`;
`src/db/officeMessages.ts:147-151`; `thoughts/shared/plans/2026-09-23-step-3-office-reaches-glue-seats.md:23`;
`thoughts/shared/plans/2026-08-31-the-planners-inbox.md:89-95`; `docs/engineering-memory.md:5422`;
`thoughts/shared/plans/2026-09-22-rung-10c-a-seats-message-wakes-the-office.md:66-67`;
`supabase/migrations/20260904110000_observations_author.sql:114-131`; the live task file
`.claude/work/tasks/20261003-say-it-and-it-s-done-no-confirmation-on.md:18-26`. Other line numbers
come from the four passes and were not each re-read.
