---
date: 2026-09-22
task: Merge the desk into the office — one office prompt and runner; the question, access and inbound-call doors all run on it; code guards what a technician-facing office can see
research: thoughts/shared/research/2026-09-22-merging-the-desk-into-the-office.md
status: draft
supersedes: thoughts/shared/plans/2026-09-19-access-plan-b-the-request-flow-through-the-office.md (its "the desk filters; narrow asks are opened by the desk" shape — already fenced 2026-09-20; this plan moves the remaining judgment from code to the office)
---

## Overview

Today the team lead is reached through three unrelated paths: the read-only desk (`desk.ts`, its own
prompt, 40s/4 turns), the model-less access desk (`accessDesk.ts`, five judgments hard-coded), and the
planner's `runPlanner`, whose focused pass handles inbound calls on the PLANNER's prompt. This plan
gives the office its own operational prompt (`OFFICE_SYSTEM`) and one runner, and puts all three
pinged doors on it: a seat's question, a seat's access ask, and an inbound call. The planner (30-min
cron) keeps `PLANNER_SYSTEM`. What a technician-facing office can SEE is bounded by its tools
(catalog identifiers + its own business with that person); what it SAYS is steered by prompt.

## Decisions

- **Office ≠ planner prompt (operator).** Different jobs, different time frames. The office (pinged:
  question, access, call) shares `OFFICE_SYSTEM`; the planner keeps `PLANNER_SYSTEM`. Shared doctrine
  (send, calls, writing a text, notes, reading the record) is extracted into named section arrays both
  prompts compose, so `PLANNER_SYSTEM` stays byte-identical apart from its stale ACCESS paragraph.
- **No short clock (operator).** Waiting doors get `OFFICE_WAITING_BUDGET_MS = 240_000`,
  `maxTurns: null`; speed comes from the prompt ("someone is waiting: answer, not a review").
  `DESK_BUDGET_MS`/`DESK_MAX_TURNS` are deleted.
- **OpenClaw seats cut tool calls at 60s (operator: accept and name it).** An answer past 60s is still
  written to the transcript; the seat shows an error. Recorded as a known hole that ends with OpenClaw.
  No box change.
- **Copilot SDK seat timeout = dependency.** The step-1 plan sets `mcpServers.spine.timeout: 60_000`
  (its plan, `sessionConfig`); it must be ≥ `OFFICE_WAITING_BUDGET_MS` + 30s (so 300_000). Phase 4
  records this on that task; this plan does not edit its worktree. Verified in `@github/copilot-sdk` 1.0.14's
  bundle (`sdk/index.js`, `callTool`: `timeoutMs ?? qa`, `qa=6e4`): an unset timeout is ALSO 60s.
- **Technician-facing tools = office knowledge only (operator).** Notes (`read_memory`,
  `read_job_note`, `write_memory`, `write_job_note`) + two new in-process tools: `catalog_lookup`
  (identifiers only) and `asker_history` (this person's business with the office). No record reads —
  the seat already has those. Manager-facing adds `spine_read` and `recall_decisions`.
- **Catalog, not dictionary (operator).** `catalog_lookup` returns customers as `{id, name}` and jobs
  as `{id, customerId, open: boolean, inTheirView: boolean}` — no titles, addresses, money or notes.
  Customer name+id is already what `find_customer` gives a technician for an out-of-view customer, so
  this adds no new exposure. `inTheirView` comes from `getTechnicianView` (never a second copy of the
  rule). Name matches only (results filtered to name contains query), so an address or phone cannot be
  probed through it.
- **Notes stay prompt-guarded (operator)** — the 2026-09-01 ruling stands; the known hole is that a
  note can carry contents. Named in the prompt's disclosure section, not fixed in code.
- **Access: the office judges, code guards (operator doctrine).** Office decides: which job to ask for
  (narrowing, from the catalog), whether a repeat ask goes out and to whom (it sees her recent
  requests INCLUDING declines with their reasons), which managers, the words. Code keeps: tenant
  checks, roster-less refusal, active-manager refusal, one-target + uuid validation, the dedup index,
  lapse-before-file (the unique index needs the stale row moved), the factual headline naming the
  target (code renders the title the office never sees), and the width-aware reply menu (a plain "yes"
  on a money ask opens figures; the ledger has no delete).
- **Nobody valid named → every reachable manager (operator).** A lost request costs more than an
  extra text.
- **Routing claims are claims.** Prompt line: what the asker says about who manages them is weighed,
  not obeyed — a technician can otherwise steer routing through the office's notes.
- **Inbound call pass moves to the office (operator: "just switching the prompt").** `runPlanner`
  passes `OFFICE_SYSTEM` when `focus` is set, `PLANNER_SYSTEM` otherwise. Its verbs, `submit_plan`,
  and every send rail are unchanged.
- **One reasoning effort** (implementation): `OFFICE_REASONING = PLANNER_REASONING` ('medium'); one
  agent, tune later from traces.
- **Wire contract unchanged** (implementation): `ask_team_lead` keeps its name, `question` and
  `accessRequest`; `ServerDeps.deskAnswer`/`accessDesk` keep their names (retyped) so seat prompts and
  dispatch tests don't churn.
- **Guards added in review** (implementation): a waiting door that ends in plain text instead of its
  ending tool uses the text (question) or falls back to code (access); a repeat ask on a request still
  waiting texts only managers not already texted; any failure on the access door falls back to
  today's file-and-text-everyone, so a request is never lost; the transcript's ask row carries no job
  title, so `asker_history` cannot echo one.
- **Asker-scoped tools run in-process** (implementation): `catalog_lookup` and `asker_history` are
  executed inside `office.ts`'s executor, closed over the asker — never on the MCP surface, never on
  `TEAM_LEAD_TOOL_NAMES`. Every other tool dispatches as `spine:team-lead` through the existing gate.

## Plain-language walkthrough

```
 seat question ─┐                                  ┌─ answer ──────► seat (words)
 seat access ask├─► OFFICE (OFFICE_SYSTEM, one runner)─ route_access ─► code files + texts manager(s)
 inbound call  ─┘      tools depend on WHO is facing it └─ submit_plan ─► existing send rails
                                                           (call pass, unchanged machinery)
 every 30 min  ───► PLANNER (PLANNER_SYSTEM) — unchanged
```

**Phase 1 — the office exists.** We write the office's own instructions and one function that runs
it, plus two new lookup tools that can only ever show a technician-facing office the index of the firm
(names and ids) and that person's own dealings with the office. Tests prove the tools never return a job
title or another person's messages.

**Phase 2 — questions go to the office.** When a seat asks something, the office answers instead of
the desk, with up to four minutes and the tools that fit the asker.

**Phase 3 — access asks go to the office.** The office reads the request, her recent requests
(including a manager's "no"), the team list, and the catalog, then decides whom to ask and what to
say. Code files the request, names the job in the manager's text, adds the yes/no menu, and falls back
to every manager if the office names nobody valid. If Ben hangs up, the office stops.

**Phase 4 — calls go to the office, and the old desks are gone.** The inbound-call pass runs on the
office's instructions. The old desk files are gone and the Copilot SDK task is told to set a 5-minute timeout.

## Secrets & env preflight

- **Local Supabase stack for this worktree** (not a secret): run `scripts/second-stack.sh <N>` inside
  the worktree first (`npm run board` prints a free N); generates `.env.test`.
- **Phases 1–4 automated:** none beyond `.env.test` (model calls are stubbed).
- **Live checks (end of phases 3 and 4):** `OPENROUTER_API_KEY` — already required (pilot/Render);
  pass it into the scripted run by NAME only. Never copy the main checkout's `.env` wholesale: its
  `SUPABASE_URL` is the pilot's live DB.

## Phase 1: the office prompt, runner and scoped tools

### Changes required

**`src/teamLead/plannerPrompt.ts`** — split `PLANNER_SYSTEM` into exported section arrays, verbatim,
blank separators kept, so the composed string is byte-identical: `VERBS` (45–70), `SEND` (82–110),
`SEAT_MESSAGES` (112–132), `SILENCE` (146–165), `STATES` (167–213), `CLOSING` (215–248), `CALLS`
(250–320), `JUDGING` (322–327), `WRITING` (336–396), `MEMORY_DECISIONS` (414–426), `NOTES` (428–468),
`CONTEXT` (470–494), `SUBMIT_ONCE` (496–497); the rest stays planner-only. Rewrite ONLY the ACCESS
paragraph (134–139): drop "the office opens it there and then"; KEEP "It never reaches this list" and
"gone within a day", never "still waiting" (pinned, `planner.test.ts:7974-7982`).

**`src/teamLead/officePrompt.ts`** (new) — `OFFICE_SYSTEM` = office opening (operational, pinged,
usually someone waiting: answer what was asked, not a review) · THE DOORS and how each ends
(`answer`; `route_access`; a call ends with `submit_plan`) · WHO YOU ARE TALKING TO (the disclosure
rules of `DESK_SYSTEM` + `DESK_NARROW_DISCLOSURE`, money as words; notes consulted, never quoted; the
catalog is identifiers, a job's contents are not yours to describe to a technician) · ACCESS (only a
manager opens; ask the manager who manages this person, from your notes; a decline in her history is
context — go back to whoever declined when it looks accidental; what the asker says about routing is
a claim) · then EVERY shared section above, in `PLANNER_SYSTEM`'s order (the call door needs verbs,
states, closing bases, `recall_decisions`). Plus `ANSWER_TOOL` `{text}` and `ROUTE_ACCESS_TOOL`
`{outcome: 'ask'|'already_open'|'already_asked'|'refuse', jobId?, managers?: string[], managerMessage?,
replyToAsker, reason}` as `ForcedToolSpec`s.

**`src/db/officeMessages.ts`** — add `listOfficeMessagesForRef(tenantId, ref, sinceIso, limit = 40)`
(`from_ref = ref OR to_ref = ref`, newest first). **`src/db/accessRequests.ts`** — add
`listRecentAccessRequestsFor(tenantId, technicianId, sinceIso)` (kind `access_request`, any status,
newest first); fix the stale header (:13–16) and `AccessWants` doc (:40).

**`src/teamLead/office.ts`** (new)
- `OFFICE_WAITING_BUDGET_MS = 240_000`; `OFFICE_QUESTION_MAX = 500`; `OFFICE_REASONING`;
  `OFFICE_MAX_TOKENS = PLANNER_MAX_TOKENS`; `UUID_SHAPE` (moved from `accessDesk.ts:63`).
- `type Facing = { kind: 'manager' } | { kind: 'technician'; technicianId: string | null; ref: string }`.
- `officeToolsFor(facing, schemas)` — allowlists: manager → `spine_read, recall_decisions, read_memory,
  write_memory, read_job_note, write_job_note`; technician → the four note tools + `CATALOG_TOOL` +
  `ASKER_HISTORY_TOOL`.
- `catalogLookup(tenantId, view, {query?, customerId?})`: `searchCustomers` → keep rows whose NAME
  contains the query (case-insensitive) → `{id, name}`; `customerId` → uuid-shape, then `getCustomer`
  + tenant match (this is what makes the tenant-less `listJobsForCustomer` safe) → `{id, customerId,
  open: !TERMINAL_JOB_STATUSES.has(status), inTheirView: viewHasJob(view, id)}`. Bad input → `[]`.
- `askerHistory(tenantId, facing)`: `listOfficeMessagesForRef` (30 days) + `renderAskerState` (moved
  from `desk.ts:115`) + `listRecentAccessRequestsFor` (14 days) rendered from context IDS and fields
  (`wants`, `customerId`, `jobId`, `why`, status, `dismiss_reason`) — never `targetName`.
- `runOfficeDoor({tenantId, facing, userMessage, terminal, tools, dispatch}, deps)` — `deps.runLoop`
  seam: memory index + `userMessage` → `runToolLoop({system: OFFICE_SYSTEM, maxTurns: null, budgetMs:
  OFFICE_WAITING_BUDGET_MS, terminalTool: terminal.name, reasoningEffort: OFFICE_REASONING, label:
  'office'}, [...tools, terminal], executor)`. The executor answers the TERMINAL tool locally (captures
  its args, returns `'ok'`) and the two scoped tools locally; everything else → `dispatch(name, args,
  {tenantId, technicianRef: TEAM_LEAD_REF})`. Returns `{ args: captured | null, text: result.text }`
  — a text-only ending leaves `args` null and each door decides (below).

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test`
- [ ] `office.test.ts`: `catalogLookup` rows carry only the listed keys and no job title appears in
  the serialized result; an address/phone query → `[]`; a malformed or other-tenant `customerId` →
  `[]`; `askerHistory` returns nothing about another ref and no job title from a request's
  `targetName`; the technician tool list has no `spine_read`/`recall_decisions`; a stub loop that
  calls the terminal tool gets its args back; a text-only stub gets `args: null`.
- [ ] a test that `PLANNER_SYSTEM` equals the pre-refactor string with only the ACCESS paragraph
  swapped; `OFFICE_SYSTEM` contains each shared section's first line; the `planner.test.ts:3150+`
  and `:7974` pins pass.

---

## Phase 2: the question door runs on the office

### Changes required

**`src/teamLead/office.ts`** — `answerAsOffice(input: DeskQuestionInput, deps)` (the shape of
`desk.ts:75`): `ask` row first (unread); user message = asker, tier, question (+ inlined
`renderAskerState` for a technician); `runOfficeDoor` with `ANSWER_TOOL`; answer = `args.text` or, on a
text-only ending, `result.text`; cap at `OFFICE_MESSAGE_BODY_MAX`; `desk` row born read + ask marked
read. Empty answer or any throw → ask stays unread, `{answer: null, note: OFFICE_FALLBACK_NOTE}`.
Facing = manager exactly when `managerDesk`; roster-less = technician with `technicianId: null`.

**`src/mcp/server.ts`** — `:6,8` import from `office.js`; `:85` retype `deskAnswer?: typeof
answerAsOffice`; `:807` call it; `:759` use `OFFICE_QUESTION_MAX`; `ask_team_lead` description
(`:113`): it is the office, may take a few minutes.

**`src/teamLead/planner.test.ts:39`, `:7886-7891`** — the `DESK_NARROW_DISCLOSURE` import and test
become the same assertions on `OFFICE_SYSTEM`.

**Delete `desk.ts`, `desk.test.ts`, `deskPrompt.ts`** after porting `desk.test.ts`'s pins
(ask-row-first, unread on failure, transcript pair, tier toolsets, answer cap) into `office.test.ts`.
Update the comments naming the desk at `officeMessages.ts:136`, `querySpine.test.ts:393`.

### Automated verification
- [ ] typecheck, lint, test; `server.test.ts:7462-7535` pass with the retyped seam.
- [ ] `office.test.ts`: technician vs manager tool lists; a throwing loop leaves the ask unread and
  returns the fallback; a text-only ending is used as the answer; `desk.in_reply_to` = ask id.

---

## Phase 3: the access door runs on the office

### Changes required

**`src/teamLead/office.ts`** — `routeAccessAsOffice(input: AccessRequestInput, deps)` (type moved from
`accessDesk.ts:66`; `deps` carries `toolSchemas`, `dispatch`, `runLoop` and today's db seams):
1. Code refusals verbatim from `accessDesk.ts:157-219` (active manager, roster-less, one target, uuid,
   tenant).
2. User message: asker, `wants`, her reason; the target as catalog identifiers; `inTheirView` /
   `viewShowsMoney` for it; the customer's jobs as catalog rows; the reachable managers
   (`listManagersWithTelegram` filtered on `sandbox_ref`, names only); `askerHistory`.
3. `runOfficeDoor` with `ROUTE_ACCESS_TOOL`, facing = technician.
4. Apply, inside one try: `already_open` / `already_asked` / `refuse` → reply only. `ask` → target =
   `jobId` only if uuid-shaped, `getJob` finds it, and it belongs to the target customer on this
   tenant; else the asked target. `requestKey` keyed on what she ASKED (`accessDesk.ts:305`). Stale
   open row → `lapseAccessRequest`, then `openAccessRequest`; live open row → no new row, and text
   ONLY chosen managers not already in its `managersTexted` (so a repeat names someone new or sends
   nothing). Managers = office names resolved against the reachable list; none valid → every
   reachable manager. Body = code headline (`${askerName} asks to open ${whatWords(target, wants)} —
   they say: "${why}".`) + `managerMessage` + the width menu (`accessDesk.ts:405-410`).
   `queuePersonPush` per manager, failure-isolated; `recordPair` with a TITLE-FREE ask body (customer
   name + width + job id), so `askerHistory` never echoes a title. Return statuses keep today's
   vocabulary (`asked_manager | already_open | already_asked | refused`) — seat doctrine keys on them.
5. `args` null, a throw in 3 or 4 → today's path: file (or converge on a live row) and text every
   reachable manager with the code template. A request is never lost.

**`src/mcp/server.ts`** — `:7` import; `:88` retype `accessDesk?: typeof routeAccessAsOffice`; `:791`
pass the same `toolSchemas` + `dispatch` as `:825`; `accessRequest` description (`:124`) keeps "ONLY A
MANAGER CAN OPEN A RECORD", "the office narrows that", "ASK FOR THE LEAST THAT ANSWERS THEM"
(pinned, `server.test.ts:10464-10475`).

**`src/mcp/server.test.ts:10280+`** — these run the real path (no stub, `.env` loaded by
`test.setup.ts:8`): inject `runLoop` through `ServerDeps` (new optional `officeLoop?`) and stub it
per test, so no test reaches a live model; "same request twice → one row, one text" holds by the
live-row rule in 4.

**Cancel when the seat hangs up** (operator, 2026-09-22). `httpServer.ts:985-988`: an
`AbortController` aborted on `res` `'close'` before `res.writableFinished`, passed as
`createServer({identity, signal})` → `ServerDeps.signal` → both doors' `deps.signal`. `runToolLoop`
gains optional `signal` (combined with its budget signal via `AbortSignal.any`; checked before each
turn). The access door checks `signal.aborted` once more right before step 4's first write; aborted
→ no file, no text, no fallback (the seat is gone). Known hole: a hang-up after that check leaves the
request standing. The step-1 glue exempts `ask_team_lead` from "Stop waits for the tool".

**Delete `accessDesk.ts`, `accessDesk.test.ts`** after porting: target resolution, tenant refusals,
key-on-asked, lapse-then-file, collision → converge, menu per width, one manager's queue failure
isolated, transcript pair.

### Automated verification
- [ ] typecheck, lint, test (with `.env` present AND absent — no live call either way).
- [ ] `office.test.ts` (stubbed loop): names Sam → only Sam pushed; names "Nobody" → every reachable
  manager; a foreign or malformed `jobId` → the asked target; a DECLINED request appears in the user
  message with its reason; body = headline with title + office words + menu; a live row + same
  manager → no new text; `args` null and a throwing apply both still file and text.
- [ ] an aborted `signal` stops the loop before its next turn and, on the access door, files and
  texts nothing; `httpServer` aborts the signal when the client closes before the reply.

### Live verification (agent-executable)
- Prerequisites: this worktree's stack (`second-stack.sh`) + `npm run seed:local`; `npm run build`;
  new `scripts/planner-eval/office-run.mjs` that loads `.env.test`, calls `assertLocalTestEnv`,
  seeds Ben (technician) and a second manager beside Sam, each with `telegram_user_id` + `sandbox_ref`,
  then drives `routeAccessAsOffice`/`answerAsOffice` from `dist/`; `OPENROUTER_API_KEY` exported for
  that one command.
- [ ] Ben asks customer-wide for a customer with one unfinished out-of-view job → the request row's
  `context.jobId` is that job; pushes exist.
- [ ] A manager declines via `decline_access`; Ben re-asks → the push goes to that manager only and
  mentions the earlier no; evidence: `person_pushes` + the office's `reason`.
- [ ] a scripted client drops an access call mid-office → no request row, no push (then repeat on
  Render with the step-1 glue's Stop, once deployed, to confirm the proxy passes the hang-up).
- [ ] Ben asks "what's on <that job>?" → the `desk` row names no title or detail.

---

## Phase 4: the call pass on the office, and cleanup

### Changes required

**`src/teamLead/planner.ts`** — at the loop call (`:5098`), `system: focus ? OFFICE_SYSTEM :
PLANNER_SYSTEM`; fix the stale comment `:4387-4389`. **`docs/engineering-memory.md`** — the office
section: three doors, `OFFICE_SYSTEM`, catalog vs dictionary, the OpenClaw 60s hole, the Copilot
timeout dependency. **Task record** — `/handoff` names the dependency; message the step-1 session:
`mcpServers.spine.timeout` must be 300_000. `notes-run.mjs` is unchanged (it measures the planner);
drop it from the task's file list.

### Automated verification
- [ ] typecheck, lint, test, build
- [ ] `planner.test.ts`: a focused run hands the loop `OFFICE_SYSTEM`, a tick `PLANNER_SYSTEM`; every
  rung-10/10b focused-pass test passes unchanged.
- [ ] `grep -rn "answerDeskQuestion\|answerAccessRequest\|DESK_BUDGET_MS\|deskPrompt" src scripts` → nothing.

### Live verification (agent-executable)
- Prerequisites: phase 3's, plus `PLANNER_MODE=live`, an `INFERENCE_MODEL` the spine rail allows, and a
  Telegram binding on the seeded tenant (`plannerPass.ts:69-77,108-112`), all set by `office-run.mjs`.
- [ ] A seeded `inbound_unmatched` call through `runFocusedObservationPass` → the manager text + quiet
  note pair (rung 10b's shape); a seeded thank-you call → `dismiss` with a reason. Evidence:
  `office_messages`, the observation's status, the decision log.

*No manual verification: every check is codified or agent-run.*
