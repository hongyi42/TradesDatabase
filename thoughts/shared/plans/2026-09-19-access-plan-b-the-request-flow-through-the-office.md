---
date: 2026-09-19
task: Access plan B of 2 — the request flow; the seat asks, the desk filters, narrow asks are opened by the desk at once, the rest are texted to the managers, the answer goes back to the technician, and the planner sees the history
research: thoughts/shared/research/2026-09-19-the-technician-access-request-flow.md
status: complete
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
- **SUPERSEDED 2026-09-19 (operator ruling, at the final review): THE OFFICE DOES NOT FOLLOW UP.**
  "The planner is the middleman here, and we only ever needed the planner in between for
  inference on narrow cases. The ask for access should go to the planner exactly once, and then
  the planner either gives the access itself or passes through the manager. If the manager does
  not respond, then the item is automatically gone. When the technician asks, the only decision
  that the planner makes is to give access or send to the manager. After that, it is not the
  planner's job to follow up. This is different from the observations that the planner has been
  working with so the verb 'dismiss' doesn't really make sense here."

  What this overturned in the two bullets below, and in phase 3 as first built: the request does
  NOT stay on the planner's list, the planner does NOT chase a manager or tell the technician it
  is still waiting, and there is no dismissal to make. The kind is filtered out of the planner's
  one observation read, so no verb needs a special case; the gap-view branch and the
  `countsAsTheAsk` guard were deleted as unreachable. The `recover` ceiling STAYS — a settled
  request is dismissed, so its id still reaches the planner through the dismissed-ids list.
  An unanswered request LAPSES after 24 hours (operator's choice at the same moment), applied
  where it is read rather than by a sweep: `findOpenAccessRequest` + `hasLapsed` closes the stale
  row on the next ask and files a fresh one, and both answer doors refuse a lapsed id. Nothing
  runs on a timer.

  And because nothing chases, the desk stopped promising a reply: "you'll get a message here when
  they answer" became "if they open it you'll get a message here; if you hear nothing, ask me
  about this job again". A manager's yes or no still texts her; silence does not. The operator
  chose this over adding a sweep to text her on the lapse.

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
`src/db/personPushes.ts:10` — `PersonPushKind` gains `'access'`. `src/db/reviewItems.ts:17` (#261 rewrote this file; the union moved) —
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

**`src/mcp/server.ts`** — `ask_team_lead` (:105-122 on main after #262/#264; re-grep, these move): `question` stays required (it is the why); new
optional `accessRequest: { jobId?, customerId?, wants?: 'record'|'notes'|'money' }`; the
description's "it cannot act, promise, or send anything" becomes "it does not act — except that
it can ask for access for you (accessRequest)". Handler (:704-747): with `accessRequest`, call
`(deps.accessDesk ?? answerAccessRequest)`; return `{ status: 'opened'|'asked_manager'|
'already_open'|'already_asked'|'refused', answer }`. `ServerDeps` gains `accessDesk?`.

**Out-of-view texts** — `OUTSIDE_VIEW_NOTE` (`src/mcp/tools/shared.ts:73-76`): replace "Only a
manager can open this one; say so" with "the office can ask a manager to open it for you: ask your
person first, and only on their yes call ask_team_lead with accessRequest and their reason". The
same offer, naming `customerId` or `wants:'notes'`, in the hidden-jobs note
(`customers.ts:502-504`) and the closed-notes note (`captures.ts:736`). Pins use
`toContain('outside your view')` (`server.test.ts:10165`, `:10172-10177`).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass; `desk.test.ts` unchanged and green
      (2026-09-19: 3326 passed, 9 skipped, 0 failed; `npm run build` clean)
- [x] New `src/teamLead/accessDesk.test.ts` (everything stubbed): narrow + `open` → one grant row
      (1 day, `record`, no money, reason = the technician's words), no request, no push, one desk
      pair; `ask_manager`, a timeout, `wants:'money'`, `wants:'notes'`, a customer with two open
      jobs → one open request and one push per reachable manager, and no model call on the
      sensitive ones; a second identical ask → `already_asked`; an in-view job → `already_open`;
      a manager asker refused; a malformed id refused without a database error. (32 tests.)
- [x] `server.test.ts`, in a block that sets the firm rule to default and truncates
      `access_grants` (the seed firm runs `whole_firm`): `ask_team_lead` with `accessRequest
      { wants:'money' }` from `tech-mcp` → `asked_manager` and an `access` push for `mgr-test`
      (given a `telegram_user_id`); `deps.accessDesk` is stubbed for any narrow case. (6 tests —
      and the narrow case stubs only the DECISION, so the grant, the view change and the
      expiry are exercised for real.)

### What phase 1 actually shipped, where it differs from the plan above
- The migration is **`20260919170000`**, not `20260919130000`: `20260919160000` had already landed
  and the ledger keys on the version number, so the plan's number would have applied out of order
  (the same-version trap from plan A's handoff, one step removed). **Phase 5's pilot command must
  use the real name.**
- A `customerId` ask is narrowed to a single unfinished job **only when she cannot already open
  it** — the plan said so and the first cut dropped it. Without the test, the commonest ask of all
  dead-ends: `get_customer_context` offers `{ customerId }` exactly when the customer IS in view
  but has hidden jobs, and such a customer usually has one unfinished job (the one she is on).
- `wants:'money'` is only answered "already open" when she can open the TARGET too. A firm rule of
  `money: 'amounts'` opens the figures on a page that may still be outside her view, and
  "ask again and they will be in the answer" would be false.
- Ids are shape-checked (`UUID_SHAPE`) before any read. The regex is local to `accessDesk.ts`
  rather than imported from `src/mcp/tools/shared.ts`: `src/teamLead` does not import the MCP
  surface, and that boundary is worth more than one shared regex.
- `get_customer_context`'s `restrictedCount` copy also lost its "a manager can open them" (it
  contradicted the new runtime note); the plan named only two of the three copies.
- KNOWN AND ACCEPTED: `managersTexted` is written before the pushes, so a queue-write failure
  (logged, never fatal) can leave the context naming a manager who was not in fact texted. Filing
  first is what stops a duplicate ask double-texting, which is the worse failure. Phase 3 renders
  this list — say "texted" there, not "read it".

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
- **Five fixes to plan A's tools, from its final code review (2026-09-19), all in
  `src/mcp/tools/access.ts`** — none urgent, and four of them need the fleet restart this plan
  already does (operator: fold them in):
  1. `revoke_access` says "<Name> can no longer open <what>", but access is the UNION of every live
     grant plus the firm's rule. Revoking one of two overlapping grants, or a person-wide money
     grant while the firm's rule already says `amounts`, makes that sentence false — and it is the
     sentence a manager acts on. Re-read the view after the revoke and say what is actually closed
     ("…but she still opens it through another grant, granted by <who> until <day>").
  2. An `everywhere` money grant defaults to STANDING (plan A's choice) but the tool description
     never says so, and `standing: false` is silently ignored on that path. Say it in the
     description, and let `standing: false` mean "use `days`, default 7".
  3. `set_technician_view` reports a change whose `from` and `to` render identically when a stored
     value replaces a null that meant the same thing (`money: 'status'` on a firm with no rule).
     Report a change only when the WORDS differ; keep the stored diff as the gate for writing.
  4. `ruleWords` renders a stored EMPTY `technician_channels` as a blank string, when `{}` is the
     most restrictive setting there is (every note but her own closed). Say that in words.
  5. `grantWhat` falls back to `the "untitled" job` when `sameFirmNames` nulled an embed — a grant
     that opens NOTHING (another firm's id) is described as opening a job and a customer's details.
     Say "a record on another firm: this grant opens nothing". Plan B writes grants through the
     same `insertAccessGrant`, so this becomes reachable here.
- **Ids stay out of the chat** (live seat check, 2026-09-19, plan A): asked "what have I opened up
  for people?", the manager's seat relayed `Ben Shelton (ben-shelton)` and `Grant ID: 78d754c7-…`
  straight into Telegram, against the standing rule from the 2026-09-14 finding. The ids are there
  because the seat needs them for its NEXT call, and nothing said so. Add to `list_access`,
  `grant_access` and `revoke_access` descriptions: "the id is for your own next call (revoke_access,
  grant_access requestId) — never say an id or a roster ref to your person; name the technician and
  the job in words." Rides this plan's rollout, which restarts every seat anyway.

**`surface.expected.ts`** — `MANAGER_ONLY_TOOLS` gains `decline_access` (manager catalog 43 → 44). **`src/eval/toolCases.ts`** —
a `decline_access` case on a random uuid (refused in words, not a crash).

### Automated verification
- [x] Gates pass; surface tests pass (2026-09-19: 3343 passed, 9 skipped, 0 failed; lint and
      build clean). The eval coverage gate caught the missing `decline_access` tier-1 case itself.
- [x] New `server.test.ts` cases (same reset + truncate): a manager's `grant_access { requestId }`
      opens the job for `tech-mcp`, closes the request, texts the technician and files one inbox
      line; a second answer is refused with no second grant row; `decline_access` closes with the
      reason and texts the technician; `list_access` lists open requests only; a technician badge
      is refused `decline_access`; a revoke files an inbox line. (23 in the block.)

### What phase 2 shipped beyond the list above
The phase review found ten things; all are fixed and each behaviour has a test that fails
without its fix (the two most serious were verified by reverting the fix and watching them fail):
- **A `requestId` answer naming a DIFFERENT technician is refused, not obeyed.** Obeying it opened
  the job for the named person, texted THEM about someone else's ask, and closed the requester's
  request as answered — she is never told, nothing is opened for her, and the one channel she
  could have re-asked through is now closed. This was the worst of the ten.
- **The technician is texted what was GRANTED, not what she asked for** — a manager may answer a
  customer-wide money ask with one job and no figures, and telling her she got what she asked for
  sends her back to a page that is still half closed.
- `technician` left `required` in the schema, which defeats the plain-yes path: `openRequests`
  exposes a display name, never a ref, so a seat that filled it in from there would dead-end.
- Revoking a CUSTOMER grant now finds the JOB grant that still opens that customer
  (`technician_view_of` adds a job grant's customer to `customer_ids`). The old asymmetry sent the
  manager to change the firm's rule — the one remedy that could not have closed it.
- A person-wide money grant is attributed only to ANOTHER person-wide grant or the firm's rule; a
  job-scoped money grant cannot produce `moneyAll` and must not be offered as the cause.
- **The overlapping grant's granter is NAMED, not ref'd** — `granted_by` is a roster ref (or
  `spine:team-lead`), and this phase's own rule forbids saying one to a person. The same fix was
  applied to the already-revoked note, which had the bug before this plan.
- `everywhere` can answer a request (a request always carries a customerId, which used to collide
  with it); naming two scopes is still refused; context-supplied ids get the same shape check as
  manager-supplied ones; and the post-revoke reads can no longer turn a committed revoke into an
  error.

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
**`Box_Setup_Stuff/bootstrap-box.sh`** (#264 rewrote the email paragraph in this block on 2026-09-19 — re-read §0l before editing; `inform_team_lead` sits at :1214 now) — manager side also gets the ids rule beside the access
doctrine (the office block already carries it for `inform_team_lead`; the access replies are a
second place it was needed). Technician side, office block §0l (:1194-1250): on "outside
your view", offer once to ask the office; never ask without your person's yes; say what you did,
never "you now have access" unless the answer says opened. Manager side, branched on "whether you
have grant_access in your tool list" (the rule-7 precedent, :825-841): an access text is answered
with `list_access` then `grant_access`/`decline_access`; one open request = a plain yes is enough,
more than one = ask which.
**`docs/nemoclaw-tech-agent.md`** (§4, :335-350), **`docs/doorman-runbook.md:371-385`** — the flow
and the manager count.

### Automated verification
- [x] Gates pass (2026-09-19: 3351 passed, 9 skipped, 0 failed; lint and build clean);
      `planner.test.ts`: the gap view renders an `access_request` in words with no figure;
      `send countsAsTheAsk` is refused with one as the lead AND as a group member;
      `recover` on one changes nothing (the existing recover tests stay green); the prompt carries the
      ACCESS paragraph; "NEVER A MONEY AMOUNT" still pinned
- [x] `bash -n Box_Setup_Stuff/bootstrap-box.sh` passes.
      **Still owed at rollout:** md5 of every deployed copy against the repo after the re-wire
      (the seven-copies trap, `docs/engineering-memory.md`) — that is a phase 5 step, on the box.

### What phase 3 shipped beyond the list above, and one correction worth keeping
- **The date-rail wording in the plan was imprecise and the first implementation's comment was
  simply wrong.** The elapsed phrase IS this kind's only `dateLabel` — `dateLabels` is built from
  `asked_at`, `endsAtLocal` and `elapsedLabel(asked_at ?? created_at)`, and `observationAsGapRow`
  hardcodes `asked_at: null` — so "asked 3 days ago" is safe to print *because* it is in the list,
  not despite it. Anything else temporal (a weekday, a date, "yesterday") still drops the
  planner's whole message. The comment in `planner.ts` now says this; the reviewer measured both
  the kept and the dropped case.
- **The group-member half of the `countsAsTheAsk` refusal is LIVE CODE, not a dormant layer.** The
  first cut assumed an earlier rail blocked it (a group member must be `pending` or `noticed`) —
  but an observation renders `noticed`, so a real group of two observations on the same person and
  job reaches the member check. The test builds that shape and fails when the member half is
  removed.
- `setObservationStatus`'s new `excludeKinds` has a test against a REAL database, because `recover`
  passes it on every call: a malformed PostgREST filter would throw, be swallowed by the planner's
  catch, and make every observation kind unrecoverable with the planner suite still green (it
  stubs that writer).
- A request the PLANNER set aside is no longer reported to a manager as "already answered" — it is
  "no longer open", with the reason. The ACCESS doctrine also now says a dismissal here is final,
  which is true for this kind and for no other.

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
- [x] Gates pass (2026-09-19: 3360 passed, 9 skipped, 0 failed; lint, build and `bash -n` clean)
- [x] `recordFieldNote.test.ts` (there is no `attachNote.test.ts`; the resolver is tested through
      its caller): `offCrew` true for a step-2 visit crewed by someone else, false for step 1 and
      for a created trip; `assumed` carries the created sentence, the off-crew sentence, and
      "marked that trip done" when the flip ran; no `assumed` for an on-crew filing; in every case
      the note is recorded (never refused). Plus two guard tests the review asked for, both
      verified by removing the guard and watching them fail.
- [x] `server.test.ts`: a `tech-mcp` note on a job whose one trip is crewed by `mgr-test` returns
      `recorded` with `assumed` on the confirm; an ordinary filing has no `assumed` key; and a
      MANAGER's filing has none either.

### What phase 4 corrected in this plan's own wording
- **The created-trip sentence in the plan is WRONG and was shipped corrected.** "A trip your own
  note made does not open the rest of this customer's record to you" — it opens NOTHING, this job
  included: `technician_view_of` drops any visit whose `source_capture_id` is a technician-channel
  capture, so the minted trip contributes neither the job nor the customer. The old wording would
  have had the seat tell her the job was readable and her next `get_job` refuse her. Recorded in
  `docs/engineering-memory.md`, because the rule lives only in a SQL comment.
- **"Technician channels only" was not enough: channel is not tier.** `record_field_note` is on
  every badge, with technician channels, so a manager on the tools would have been told they are
  off a crew on every note — always true, never news, and a planner item each time. Gated on the
  filer's tier as well.
- **"No trip was booked for you on this job" could be false**, since step 3 also fires when she is
  on a trip for that job on another day and a second live visit exists. It says what MATCHED now.

## Phase 5: rollout and live run

### Changes required

**The migration is `20260919170000_access_requests.sql`, NOT the `20260919130000` this plan first
named** — `20260919160000` had already landed, and a lower number would have applied out of order.

**EXPECT THE CLI TO REFUSE IT, and that is correct.** PR #267 (the timestamp brand) merges FIRST by
the operators' agreement, and its migration is `20260920120000` — a HIGHER number. So once that one
is on the pilot, `supabase migration up` will stop on ours with:

```
Found local migration files to be inserted before the last migration on remote database.
Rerun the command with --include-all flag to apply these migrations:
supabase/migrations/20260919170000_access_requests.sql
```

Exit 1, nothing applied. **Nothing is wrong.** Re-run with `--include-all`, which is safe here and
only here: the two migrations touch different tables (`visits.started_at` vs
`observations` / `person_pushes`), so applying ours after theirs is a reorder with no dependency
between them — the one case `docs/engineering-memory.md` records as harmless. Never make
`--include-all` a habit: it converts that loud refusal into a silent reorder for migrations that
DO depend on each other.

Then verify the artefact rather than the ledger, per the same entry:

```sql
select count(*) from pg_indexes where indexname = 'uq_open_access_request';           -- 1
select pg_get_constraintdef(oid) from pg_constraint where conname = 'person_pushes_kind_check';
-- must contain 'access'
```

Then: `NOTIFY pgrst`; merge (Calls-worker deploys itself and picks up the planner guards); deploy
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
