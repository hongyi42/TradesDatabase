---
date: 2026-09-19
task: Access plan B of 2 — the request flow; the seat asks, the desk filters, narrow asks are opened by the desk at once, the rest are texted to the managers, the answer goes back to the technician, and the planner sees the history
research: thoughts/shared/research/2026-09-19-the-technician-access-request-flow.md
status: draft
supersedes: nothing
---

## Overview

Builds on plan A (`2026-09-19-access-plan-a-the-managers-access-tools.md`, which lands first).
Today a technician who hits "outside your view" is told "only a manager can open this one" and
nothing happens. This plan makes the desk (`ask_team_lead`, the office's quick voice) the filter
the operator described: a narrow ask — the customer's details and one job — is opened by the desk
on the spot for a day; anything with money, every note, or wider is texted to the managers, whose
seats answer with `grant_access` / `decline_access`; the technician is texted the answer; the
planner sees every step of the history and chases what goes unanswered. Phase 4 rides the same
rollout: a note that lands where the record did not expect it now says so to the seat.

## Decisions

- **The request goes through the desk** (operator ruling 4, 2026-09-15; 2026-09-19: "the seat asks
  the office, who is basically a filter"). `ask_team_lead` gains an optional `accessRequest`.
- **The desk grants; the scheduled planner never does** (operator, 2026-09-19: "the desk is the one
  picking it up… in a timely manner. The planner doesn't need to grant access, but they should
  probably be seeing the history"). The planner gets no new tool or decision type.
- **Narrow = the customer's details and one job, the record only, for one day** (operator,
  2026-09-19). A customer ask becomes that customer's one unfinished job when there is exactly one
  and it is out of view. Money, every note, customer-wide and standing always go to a manager.
- **The desk decides a narrow ask with one bounded model call; code does the write, by
  construction** (my call). The call returns `open` or `ask_manager`; on `open`, code inserts a
  grant whose every field is fixed (that job, `record`, no money, 1 day). No model output reaches a
  grant field, so there is nothing for a ceiling to check. The call has a 20 s timeout and falls to
  `ask_manager` on any failure (towards the human); it is billed to the tenant (`CostContext`, lane
  `desk`). Sensitive asks skip the model. The general desk loop and its read-only toolset are
  untouched (`desk.test.ts` stands).
- **The grant's `reason` is the technician's own words, quoted by code** ("asked by Sam: …"); the
  model's reasoning goes only into the desk transcript row, which `v_office_messages` already
  excludes (`20260916130000_desk_answers_not_citable.sql`), because `spine_read` is citable and
  `v_access_grants` (plan A) shows `reason`.
- **The planner sees the history**: a desk-opened ask as a desk Q&A pair in its desk appendix on
  its next run (`planner.ts:4940-4968`; the newest 5 pairs since its last run, the answer cut at
  300 characters, so the desk row leads with "Opened <what> for <tech> until <day>"), every
  manager grant, decline and revoke as one inbox row from that manager, and `v_access_grants` as
  the complete record (the appendix can drop pairs in a burst; the view cannot).
- **A forwarded request is an observation** (kind `access_request`, author `planner`, a fresh-uuid
  `subject_ref`, a `requestKey` in `context`). It stays in the planner's list until answered
  (operator accepted), so the planner can chase the manager or tell the technician. A partial
  unique index on open requests by `requestKey` stops a retried ask from opening two. Code closes
  it when a manager answers. Two planner guards keep its old verbs off it: `send` refuses
  `countsAsTheAsk` on it (a same-subject nudge would outlive the answer, the `observe` hazard at
  `planner.ts:~3945-3960`), and `recover` refuses it (it would reopen an answered request).
- **The managers are texted once**, through `person_pushes` (a new kind `access`; ~10–15 s; their
  own assistant's bot), every active manager with Telegram. No ids in the text; the manager's seat
  finds the request with `list_access`. When exactly one request is open, a plain "yes" answers it;
  with more than one, the seat asks which (plan review).
- **The first answer wins**: close the request under its status guard, then insert the grant (the
  ledger cannot delete a losing grant), reopening the request if the insert fails (plan review).
- **The technician is texted every manager answer, yes and no** (operator accepted). A desk-opened
  ask is answered inside the same call, so no text.
- **`decline_access` is a manager-only tool.**
- **A filing that does not match the record is the seat's to notice; code never refuses it**
  (operator doctrine 2026-09-19, `docs/engineering-memory.md` "Contradictions are raised at points
  of inference"; the research's hard-coded detector, Decision Point 11, is withdrawn). An off-crew
  note still attaches and completes ("entirely possible"); `record_field_note` now says what it
  assumed, the seat asks and informs the office, the planner notes it (phase 4, operator's call).

## Plain-language walkthrough

```
Sam's assistant ─ get_job → {inView:false, note: "…the office can ask a manager for you…"}
   │  "Want me to ask the office to open it?"   Sam: "yes, I need the gate code"
   ▼
ask_team_lead { question: why, accessRequest: {jobId, wants:'record'} }
   ├─ already open / already asked ─▶ says so
   ├─ narrow ─ desk decides ─ open ─▶ 1-day grant ─▶ "Opened until tomorrow, read it again"
   │                        └ ask_manager ┐
   └─ money / notes / wider ──────────────┴▶ request + text to every manager
                                             "Asked your manager, you'll get a text"
Manager: "yes for a week" ─▶ their assistant: list_access → grant_access{requestId}
   └─▶ grant · request closed · planner inbox line · text to Sam "…ask me again"
Planner, next run: sees each step; chases requests still waiting.
```

**1 — asking:** the desk opens a narrow ask on the spot, or files it and texts the managers.
**2 — answering:** the manager's seat says yes or no; the technician is texted; the planner's inbox
gets a line. **3 — the planner and the seats** learn the flow. **4 — the note says what it
assumed** ("you are not on this trip's crew"): the seat asks and tells the office; nothing is
refused. **5 — rollout and a live run** with a real technician and manager seat.

## Secrets & env preflight

- **Phase 1–4:** none for the tests (the model is stubbed). `OPENROUTER_API_KEY` (already required
  on the services; copy the main checkout's `.env`) only for an optional live-model spot check.
- **Phase 5:** `GATEWAY_IDENTITY_SECRET` (already required); `supabase-test` and `render` MCPs;
  `ssh tradesbox`.

## Phase 1: the ask

### Changes required

**`supabase/migrations/20260919130000_access_requests.sql`** (new) — `person_pushes_kind_check`
becomes `kind in ('schedule','call','ops','access')` (pattern: `20260917200000_person_pushes_ops_kind.sql:33-38`);
`create unique index uq_open_access_request on observations (tenant_id, (context->>'requestKey'))
where kind = 'access_request' and status in ('open','asked');`. Local apply + `gen:types:local`.
`src/db/personPushes.ts:10` — `PersonPushKind` gains `'access'`. `src/db/reviewItems.ts:10` —
`ReviewKind` gains `'access_request'` (task `20260916-retire-the-manager-review-queue-keep-rev`
edits this file too: merge both).

**`src/db/accessRequests.ts`** (new; export from `src/db/index.ts`). Every read and update filters
`kind = 'access_request'` (an arbitrary observation id must never be closed through it).
`openAccessRequest(input)` → `createObservation({ kind, author:'planner', subjectRef:
\`access:${randomUUID()}\`, technicianId, context })` (null on the unique index = already asked);
`findOpenAccessRequest(tenantId, requestKey)`; `getAccessRequest(tenantId, id)`;
`listOpenAccessRequests(tenantId)`; `closeAccessRequest(tenantId, id, outcome)` (a guarded update
`open|asked → dismissed`, null when answered first); `reopenAccessRequest(tenantId, id)`.
`requestKey = <technicianId>:<jobId | 'c:'+customerId>:<wants>`. Context: `{ requestKey,
technicianRef, technicianName, jobId?, customerId, targetName, wants, why, managersTexted }`.

**`src/teamLead/accessDesk.ts`** (new) — `answerAccessRequest(input, deps)`; deps injectable
(`decide`, `now`, db writers, `queuePush`).
1. Refuse a manager asker ("managers already see everything") and a roster-less badge.
2. Load the target (`UUID_RE` first; compare `tenant_id`). A `customerId` becomes a job only when
   that customer has exactly one unfinished job and it is out of her view.
3. Already open: `wants:'record'` + a job in view, or `wants:'money'` + `viewShowsMoney` → "already
   open to you — read it again". A customer target or `wants:'notes'` is never short-circuited.
4. `findOpenAccessRequest` → "already asked on <weekday date>; still waiting".
5. Narrow (`record` + one job): `deps.decide` = `runForcedTool` with one tool `decide_access`
   `{ decision: 'open'|'ask_manager', reason }`, reasoning `minimal`, a 20 s `Promise.race`, ctx
   `{ tenantId, technicianRef: TEAM_LEAD_REF, lane: 'desk' }`; system text in
   `src/teamLead/accessDeskPrompt.ts` (the planner's memory index, the request, the job's customer,
   title and status, who is booked on it). `open` → `insertAccessGrant({ jobId, opens:'record',
   opensMoney:false, expiresAt: now+24h, requestedBy: techRef, grantedBy: TEAM_LEAD_REF, reason:
   \`asked by ${name}: ${why}\` })`; answer "Opened for you until <day>: <what>. Read it again now."
6. Otherwise read `listManagersWithTelegram(tenantId)` filtered to rows with a `sandbox_ref` (the
   push leg skips any without one, `nudgeQueue.ts:290`, so naming them would be untrue),
   `openAccessRequest` (their names in `managersTexted`), then `queuePersonPush({ kind:'access' })`
   to each: "<Tech> asks to open <what> — they say: "<why>". Reply to
   answer: yes, yes for good, yes with prices, or no." (money and notes asks name what was asked).
   Answer "Asked your manager by text (<names>). You'll get a message here when they answer.", or
   with nobody reachable "No manager can be texted right now; the office has your request."
7. For steps 5–6, write the desk pair the planner reads (the `answerDeskQuestion` shape,
   `desk.ts:155-163, 228-245`): an `ask` row (the technician's words) and a `desk` row born read
   (the outcome and, for step 5, the model's reason), then mark the ask read.

**`src/mcp/server.ts`** — `ask_team_lead` (:109-128): `question` stays required (it is the why); new
optional `accessRequest: { jobId?, customerId?, wants?: 'record'|'notes'|'money' }`; the
description's "it cannot act, promise, or send anything" becomes "it does not act — except that
it can ask for access for you (accessRequest)". Handler (:701-744): with `accessRequest`, call
`(deps.accessDesk ?? answerAccessRequest)`; return `{ status: 'opened'|'asked_manager'|
'already_open'|'already_asked'|'refused', answer }`. `ServerDeps` gains `accessDesk?`.

**Out-of-view texts** — `OUTSIDE_VIEW_NOTE` (`src/mcp/tools/shared.ts:73-76`): replace "Only a
manager can open this one; say so" with "the office can ask a manager to open it for you: ask your
person first, and only on their yes call ask_team_lead with accessRequest and their reason". The
same offer, naming `customerId` or `wants:'notes'`, in the hidden-jobs note
(`customers.ts:502-504`) and the closed-notes note (`captures.ts:736`). Pins use
`toContain('outside your view')` (`server.test.ts:10165`, `:10172-10177`).

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass; `desk.test.ts` unchanged and green
- [ ] New `src/teamLead/accessDesk.test.ts` (everything stubbed): narrow + `open` → one grant row
      (1 day, `record`, no money, reason = the technician's words), no request, no push, one desk
      pair; `ask_manager`, a timeout, `wants:'money'`, `wants:'notes'`, a customer with two open
      jobs → one open request and one push per reachable manager, and no model call on the
      sensitive ones; a second identical ask → `already_asked`; an in-view job → `already_open`;
      a manager asker refused; a malformed id refused without a database error.
- [ ] `server.test.ts`, in a block that sets the firm rule to default and truncates
      `access_grants` (the seed firm runs `whole_firm`): `ask_team_lead` with `accessRequest
      { wants:'money' }` from `tech-mcp` → `asked_manager` and an `access` push for `mgr-test`
      (given a `telegram_user_id`); `deps.accessDesk` is stubbed for any narrow case.

## Phase 2: the answer

### Changes required

**`src/mcp/tools/access.ts`** (plan A's module)
- `grant_access` gains `requestId`: load it (`getAccessRequest`; another firm's or a closed one is
  refused with who answered and how); fill `technician`, the target and `wants` from it (`money` →
  `money:true`, `notes` → `opens:'record_and_notes'`) unless the manager overrides;
  `closeAccessRequest` FIRST ("opened by <manager> until <day>"), then insert with `requestedBy`;
  if the insert throws, `reopenAccessRequest` and rethrow the insert's error. The reopen tolerates
  a 23505 (an identical ask opened a new request in the gap) and never masks the original error.
- `decline_access` (new, admin): `{ requestId, reason }` → close with "declined by <manager>: <reason>".
- After every manager grant (with or without a request), decline and revoke: one
  `createOfficeMessage({ direction:'to_planner', kind:'inform', fromRef: manager ref, toRef:
  TEAM_LEAD_REF, tier:'manager', body })` in words ("Opened the <job> job for <tech> until <day> —
  <tech> had asked: …"). After a grant or decline answering a request: `queuePersonPush({
  kind:'access' })` to the requester — "<Manager> opened <what> for you until <day>. Ask me again
  and I'll read it." / "<Manager> said no to opening <what>: <reason>."
- `list_access` adds `openRequests` (id, technician, what, wants, why, asked day, managers texted).

**`surface.expected.ts`** — `MANAGER_ONLY_TOOLS` gains `decline_access`. **`src/eval/toolCases.ts`** —
a `decline_access` case on a random uuid (refused in words, not a crash).

### Automated verification
- [ ] Gates pass; surface tests pass
- [ ] New `server.test.ts` cases (same reset + truncate): a manager's `grant_access { requestId }`
      opens the job for `tech-mcp`, closes the request, texts the technician and files one inbox
      line; a second answer is refused with no second grant row; `decline_access` closes with the
      reason and texts the technician; `list_access` lists open requests only; a technician badge
      is refused `decline_access`; a revoke files an inbox line.

## Phase 3: the planner and the seats

### Changes required

**`src/teamLead/planner.ts`** — `buildGapView` (:1387): an `access_request` branch beside the
`PINGED_KINDS` one (:1583): "<Tech> asked <ago> to open <what> (wants <the record | every note |
money figures>): "<why>". Managers texted: <names | nobody reachable>." (the gap id stays: the
planner names gaps by it). `send`: refuse `countsAsTheAsk` when the lead gap **or any member of
`d.nudgeIds`** is an `access_request` (beside `isInboundAsk`, :3681-3690 — which checks the lead
only, while the group rule at :2974-3050 never checks kind and apply asks every member,
:3827-3890). `recover` (:4046): `setObservationStatus` gains an optional `excludeKinds` filter
(`.not('kind', 'in', …)`), and recover's observation write passes `['access_request']`, so an
answered request is simply not recoverable (the attempt matches nothing). No new database read in
the planner: the recover tests (`planner.test.ts:4430-4549`) stub every reader with non-uuid ids,
and a real read there would throw 22P02 (the warning at `planner.ts:5394-5398`).
**`src/teamLead/plannerPrompt.ts`** — `:72-75` names the list's third source (technicians' requests
to open a record, already texted to the managers once); one short ACCESS paragraph: a manager
answers these, not you; you may remind a manager or tell the technician it is still waiting, or
dismiss one that no longer matters; the MONEY rule (:92-97) is unchanged.
**`Box_Setup_Stuff/bootstrap-box.sh`** — technician side, office block §0l (:1194-1250): on "outside
your view", offer once to ask the office; never ask without your person's yes; say what you did,
never "you now have access" unless the answer says opened. Manager side, branched on "whether you
have grant_access in your tool list" (the rule-7 precedent, :825-841): an access text is answered
with `list_access` then `grant_access`/`decline_access`; one open request = a plain yes is enough,
more than one = ask which.
**`docs/nemoclaw-tech-agent.md`** (§4, :335-350), **`docs/doorman-runbook.md:371-385`** — the flow
and the manager count.

### Automated verification
- [ ] Gates pass; `planner.test.ts`: the gap view renders an `access_request` in words with no date
      and no figure; `send countsAsTheAsk` is refused with one as the lead AND as a group member;
      `recover` on one changes nothing (the existing recover tests stay green); the prompt carries the
      ACCESS paragraph; "NEVER A MONEY AMOUNT" still pinned (`planner.test.ts:7886-7890`)
- [ ] `bash -n Box_Setup_Stuff/bootstrap-box.sh`; md5 of every deployed copy matches the repo after
      the re-wire (the seven-copies trap, `docs/engineering-memory.md`)

## Phase 4: the note says what it assumed

### Changes required

**`src/writePath/attachNote.ts`** — `ResolvedVisitForNote` gains `offCrew: boolean`: true when the
visit came from step 2 (the job's one live visit, :112) and has a crew the filer is not on
(`participantIdsOf`, `src/db/visits.ts:81`); false for step 1 (it already requires her or an empty
crew) and step 3 (`created`, she is the crew). No behaviour change: nothing is refused or re-routed.
**`src/writePath/recordFieldNote.ts`** — `RecordFieldNoteResult` (:125-140) gains
`assumed?: string[]`, plain sentences for the SEAT, no ids, technician channels only:
`created` → "No trip was booked for you on this job, so your note was recorded on a new finished
trip. A trip your own note made does not open the rest of this customer's record to you.";
`offCrew` → "Your note went on <crew names>'s trip; you are not on that trip's crew." (names from
`listTeam`, `src/db/technicians.ts:146`), plus " It also marked that trip done." when the happened
flip (:854-865) ran.
**`src/mcp/tools/shared.ts`** `commitNote` (:422-510) — pass `assumed` through on `recorded`, only
when present (all three commit sites share it).
**`record_field_note` description** (`src/mcp/tools/captures.ts`) and **`bootstrap-box.sh`** (the
technician's field-note duty, beside the phase 3 edit): when `assumed` is present, ask your person
once, in your own words, what happened; then `inform_team_lead` with their answer; offer the access
ask if they need the record; never refuse or re-file the note.
**`src/teamLead/plannerPrompt.ts`** (office messages, :112-126) — one line: a seat may report a note
that landed where the record did not expect it; find out what happened (ask the manager if you
need to) and write it on the job's notes (`write_job_note`).

### Automated verification
- [ ] Gates pass
- [ ] `src/writePath/attachNote.test.ts` / `recordFieldNote.test.ts`: `offCrew` true for a step-2
      visit crewed by someone else, false for step 1 and for a created trip; `assumed` carries the
      created sentence, the off-crew sentence, and "marked that trip done" when the flip ran; no
      `assumed` for an on-crew filing; in every case the note is recorded (never refused)
- [ ] `server.test.ts`: a `tech-mcp` note on a job whose one trip is crewed by `mgr-test` returns
      `recorded` with `assumed` on the confirm; an ordinary filing has no `assumed` key

## Phase 5: rollout and live run

### Changes required
After plan A is live: the **operator** applies `20260919130000` to the pilot (`supabase-test`),
`NOTIFY pgrst`; merge (Calls-worker deploys itself and picks up the planner guards); deploy
`lifecycle-heart` and confirm Calls-worker is on the new build **before** triggering
`TradesDatabase` — the web service starts creating requests the moment it is live, and a planner
without the guards could make one "the ask" or recover it (read `autoDeploy` from `list_services`);
re-run the bootstrap wire on trades-box-1 and `nemoclaw <s> gateway restart` on **every** seat
(`ask_team_lead` changed for both tiers), s2 first.

### Live verification
- Prerequisites: `supabase-test`, `render` MCPs, `ssh tradesbox`, `.env` with `GATEWAY_IDENTITY_SECRET`.
- [ ] Operator-run (pilot writes are permanent: a request row, pushes, a grant; the agent prepares
      the commands): a signed technician `ask_team_lead` with `accessRequest { wants:'money' }` on
      an out-of-view job → `asked_manager`; then a signed manager `list_access` →
      `grant_access { requestId }`. Agent reads back: the request (open, then dismissed), one push
      per reachable manager then the technician's push, each `delivered`; the grant row; the inbox
      line; the technician's `get_job` in view with figures; the next planner run marked the line read.

### Manual verification
- [ ] On s2 and a manager seat: ask about an out-of-view customer, say yes, answer the text
      "yes for a week" — judge each message for readability, and that no id or figure leaks.

---
*Pause after Phase 5's manual check.*
