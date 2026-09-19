---
date: 2026-09-19
branch: work/the-technician-access-request-flow-tech
commit: 97e61dc
topic: The technician access request flow — what exists today for each hop (the out-of-view answer a technician's seat receives, the desk, the paths a message can take to a manager's seat and back to a technician's seat, the grants and firm-rule ledgers, the record_caller shared-verb precedent, the planner's tick, money doctrine and detector layer), as the ground for task 20260915-the-technician-access-request-flow-tech
supersedes: nothing
---

**Builds on** the technician limited view (plan
`thoughts/shared/plans/2026-09-15-the-retrieval-layer-2-the-technician-limited-view.md`, finding
`thoughts/shared/findings/2026-09-15-retrieval-layer-2-the-technician-limited.md`, PR #247, on main
and deployed) and the operator's rulings "TECHNICIAN VIEW + GRANT ACCESS" 1-9 in
`thoughts/shared/findings/2026-09-15-customer-context-becomes-a-table-of-cont.md:98-107`. The
task's own decisions (planner may grant, firm-rule verb, revoke verb, contradiction detector, the
money mismatch) are in `.claude/work/tasks/20260915-the-technician-access-request-flow-tech.md`.

## Summary

A technician's AI assistant in Telegram (their **seat**) can only open the customers and jobs the
technician is serving; anything else comes back as a short "outside your view" answer. The operator
has ruled how a technician gets more: the seat asks the technician whether to request access
(hop 1); the **desk** — `ask_team_lead`, a small read-only model call that answers a seat's
question in the planner's name — passes the request to the manager at once (hop 2); the manager
says yes through a `grant_access` verb on their own seat (hop 3); a message goes back to the
technician's seat, and the technician asks again (hop 4). The **planner** (the background model
that keeps the firm's book, running every 30–120 minutes per firm) records the request and its
outcome, and may itself grant or deny in special cases.

The storage half is already built and live: a grants ledger (`access_grants`), a per-firm rule
(`technician_view_rules`), their TypeScript writers, and a database rule that reads them on every
technician request, so a grant takes effect on the very next read. **Nothing in the product calls
those writers yet.** Every other hop has a nearest existing mechanism but none does the job as
ruled: the desk writes two inbox rows but its model has no write tools; the only server-to-person
push (`person_pushes`) reaches a phone in ~10–15 s but is invisible to the planner; a seat-to-seat
note arrives silently up to 5 minutes later and is also invisible to the planner; and the planner
hears about a seat's message only at its next scheduled tick (a seat message does not wake it).

```
TODAY (what each hop would ride on)

 Technician ──▶ Tech seat ──tool call──▶ MCP server (Render web service "TradesDatabase")
                   ▲                         │ find_customer / get_job / … → {inView:false, note}
                   │                         │   note says "Only a manager can open this one; say so"
                   │                         ▼
                   │                  ask_team_lead ──▶ desk (read-only model, 40 s budget)
                   │                         │   writes office_messages: ask (to_planner) + desk answer
                   │                         │   NO path from here to the manager's phone
                   │                         ▼
                   │                  planner tick (every 30 / 120 min per firm)
                   │                         │   sees the desk Q&A in an appendix; can `send`
                   │                         ▼
                   │          office_messages to_agent ──▶ box runner ──▶ Manager seat
                   │                                                      │ grant_access: DOES NOT EXIST
                   │                                                      │ (insertAccessGrant exists,
                   │                                                      │  called only by tests)
                   └──── nothing routes a "granted" message back ◀────────┘
```

## Entry Points

| Hop | Where it begins today |
|---|---|
| 1 — the out-of-view answer | `OUTSIDE_VIEW_NOTE`, `src/mcp/tools/shared.ts:73-76`; emitted by `find_customer` (`src/mcp/tools/customers.ts:406`), `get_customer_context` (`customers.ts:441-443`), `get_job` (`customers.ts:530-531`), `list_recent_captures` (`src/mcp/tools/captures.ts:721-731`), `search_captures` (`captures.ts:796-810`), `record_standing_fact` (`captures.ts:1123-1141`) |
| 2 — the desk | `ask_team_lead` definition `src/mcp/server.ts:109-128`, handler `server.ts:701-744` → `answerDeskQuestion`, `src/teamLead/desk.ts:141-253` |
| 3 — the grant | `insertAccessGrant` `src/db/technicianView.ts:106`, `revokeAccessGrant` `:129`, `setTechnicianViewRule` `:156` (no production caller) |
| 4 — the message back | planner `send`, `src/teamLead/planner.ts:3657` (writes at `:3771-3790`); `queuePersonPush`, `src/db/personPushes.ts:19-43`; `inform_teammate`, `src/mcp/tools/office.ts:258-338` |
| Planner records it | tick entry `src/jobs/lifecycle.ts:477` → `runPlannerPass` `:540` → `runPlanner` `src/teamLead/planner.ts:4169` |
| The view rule itself | `technician_view_of`, `supabase/migrations/20260917120000_technician_view.sql:200-337` |

## Key Files

**The view and the ledgers**
- `supabase/migrations/20260917120000_technician_view.sql` — `technician_view_rules` (:61-87),
  `access_grants` (:91-159) with its ledger trigger (:123-156), `capture_tags` (:163-174), the
  `technician_view` composite type (:178-195), `technician_view_of` (:200-337), predicates
  `view_has_job` (:342-349), `view_money_open` (:355-363), `view_has_customer` (:365-372),
  `capture_in_scope` (:377-405), `capture_content_open` (:410-437), 5-arg `capture_visible`
  (:440-453), `capture_restricted` (:459-476), 3-arg `capture_visible` (:482-488, true only for
  manager and planner). Header comment :38-41 names the contradiction detector as "a later task".
- `supabase/migrations/20260917160000_pg_temp_on_security_definer.sql:51-53` — sets
  `search_path = public, pg_temp` on `technician_view_of` and the four readers; :26-27 warns that
  anyone re-creating one must carry `, pg_temp`.
- `src/db/technicianView.ts` — `TechnicianView` type, `viewHasJob` / `viewHasCustomer` (:52-54),
  `viewShowsMoney` (:58-64, "THE ONE MONEY QUESTION"), `getTechnicianView` (:68-89),
  `insertAccessGrant` (:106-125), `revokeAccessGrant` (:129-144), `setTechnicianViewRule`
  (:156-180). Header :11-14: "Nothing in the product writes them yet; the tests do."
- `src/db/technicianView.test.ts` — pins grant semantics (job grant also opens the customer
  :497-498; `record_and_notes` vs `record` :473-506; grant visible on next read :512-516;
  note-minted exclusion :538-587).

**The doors**
- `src/mcp/tools/shared.ts` — `viewerIdOf` (:69), `OUTSIDE_VIEW_NOTE` (:73-76),
  `losingEvidenceOf` (:581-601), `isActiveManager` (:764-767).
- `src/mcp/tools/customers.ts` — find_customer gate (:384-388, row :406), get_customer_context
  (:437-504), get_job (:525-591; money :577, price strip :591), `record_caller` definition
  (:285-354) and `handleRecordCaller` (:839-1147, registered :1261).
- `src/mcp/tools/captures.ts` — capture pages/search out-of-view replies (:721-751, :761-810),
  `record_standing_fact` refusal (:1123-1141).
- `src/db/moneyEvents.ts` — `technicianMoneyView` (:630-646), status words (:619-628).

**The desk and the tool surface**
- `src/teamLead/desk.ts` — `DESK_READ_TOOLS` allowlist (:57-62), `renderAskerState` (:115-131),
  `answerDeskQuestion` (:141-253).
- `src/teamLead/deskPrompt.ts` — `DESK_SYSTEM` (:14-15 "You READ, you never act"),
  `DESK_MAX_TOKENS` 2048 (:38), `DESK_REASONING` 'low' (:41), `DESK_BUDGET_MS` 40 000 (:50),
  `DESK_MAX_TURNS` 4 (:56), `DESK_QUESTION_MAX` 500 (:58), `DESK_NARROW_DISCLOSURE` (:84-87).
- `src/mcp/server.ts` — `TOOLS` (:100-129), `ADMIN_TOOLS` (:274-321), `TEAM_LEAD_TOOLS`
  (:344-386), `TEAM_LEAD_TOOL_SCHEMAS` (:390-398), `ADMIN_TOOL_NAMES` (:402),
  `SEAT_SHARED_TEAM_LEAD_TOOLS` (:414), `TEAM_LEAD_ONLY_TOOL_NAMES` (:425-427), `MANAGER_TOOLS`
  (:442-446), `SPINE_TOOL_NAMES` (:458); `dispatch()` gates (:564-698); `tools/list` (:834-849).
- `src/teamLead/identity.ts` — `TEAM_LEAD_REF = 'spine:team-lead'` (:7), `TEAM_LEAD_TOOL_NAMES`
  (:54-80).
- `src/mcp/tools/surface.expected.ts` — hand-written tier lists (see Constraints).
- `src/mcp/identity.ts:13-17, 41-63` — `RequestIdentity`, HMAC headers; the badge carries no tier.
- `src/mcp/httpServer.ts:984-988` — one stateless endpoint for every seat; `/control/*` routes
  :856-873.
- `src/mcp/tools/roster.ts:171-183, 857-880` — `list_team` returns `ref` (not the technician uuid).

**Messages**
- `supabase/migrations/20260901150000_office_messages.sql:20-57` — `office_messages`;
  `20260903130000_office_messages_via.sql` adds `via` (`assistant` | `chat`);
  `20260916130000_desk_answers_not_citable.sql:20-41` — `v_office_messages` drops `kind='desk'`.
- `src/db/officeMessages.ts` — `createOfficeMessage` (:53-83), `markOfficeMessagesRead`
  (:327-342), `listQueuedOfficeMessagesForHost` (:238-269).
- `src/mcp/tools/office.ts` — `inform_team_lead` (:43-72, handler :184-256), `inform_teammate`
  (:258-338).
- `supabase/migrations/20260916100000_person_pushes.sql`,
  `20260917200000_person_pushes_ops_kind.sql:33-38` — `person_pushes`, kind in
  (`schedule`,`call`,`ops`).
- `src/db/personPushes.ts:19-43` — `queuePersonPush`; `src/calls/notify.ts:10-29` —
  `notifyManagers`.
- `src/control/nudgeQueue.ts` — Leg A server side (nudges :117-222, chat office rows :232-274,
  pushes :285-321); `src/control/officeQueue.ts` — Leg B (:51-83 wrapper text, :88-152 build,
  :158-193 complete).
- `Box_Setup_Stuff/nudge-runner.{sh,timer}` (10 s), `Box_Setup_Stuff/office-runner.{sh,timer}`
  (5 min).

**Planner**
- `src/teamLead/planner.ts` — `PLANNER_ACTIONS` (:155-167), `PLANNER_TICK_MINUTES` 30 (:558),
  per-firm cadence (:575, :606-625, :4412-4429), reachability (:1270-1275, THE TEAM :1345), gap
  view (:1387), money rendering (:1514-1532, :1928-1938), office block (:3381, :3391-3444),
  outbound block (:3468-3494), `buildPlannerUserMessage` (:3505), `applyDecision` (:3598), `send`
  (:3657-3790), `observe` (:3939-3998), `runPlanner` (:4169), reads (:4356-4409), mark-read
  (:5633-5644).
- `src/teamLead/plannerPrompt.ts` — SEND (:82-101, MONEY :92-97), the "two things" detector
  sentence (:72-75), office-message handling (:112-126), asking a manager (:270-281), "THERE IS
  NO HANDOVER" (:381-395).
- `src/jobs/plannerPass.ts` — heartbeat pass (:23-38), focused observation pass (:97-140; stubs
  the inbox :126).
- `src/jobs/watchers.ts` — `runWatchers` (:276), shadow skip (:499), "every fresh gap becomes an
  OBSERVATION" (:576-595), `overdue_visit_gap` (:596-657), `job_cost_gap` (:660-727).
- `src/db/observations.ts` — `createObservation` (:46-63), `PINGED_KINDS` (:256).
- `src/writePath/attachNote.ts:79-145` — `resolveVisitForNote` (the note-minted trip);
  `src/writePath/recordFieldNote.ts:722-730, 829, 850-865`.

**Seat doctrine (on the box)**
- `Box_Setup_Stuff/bootstrap-box.sh` — AGENTS.md heredocs; office block §0l (:1194-1250;
  `inform_team_lead` / `ask_team_lead` / `inform_teammate` :1219-1240); rule 7 branches on
  "whether you have record_caller in your tool list" (:825-841).
- `docs/nemoclaw-tech-agent.md:335-350` — the view, for humans; says the seat verbs belong to this
  task.

## Data Flows

### Hop 1 — what a technician's seat receives outside the view

Every technician tool call re-reads the caller's roster row (`server.ts:564`) and the view is
computed fresh per call — `getTechnicianView` in TypeScript doors (`customers.ts:386, 528`;
`captures.ts:1125`) and `technician_view_of` inside the four SQL readers (migration :538, :719,
:801, :865). Nothing is cached, so a grant row changes the next answer. What is cached is the
tool **descriptions**, per gateway process (`server.ts:653`).

The shapes are not uniform:

| Door | Out-of-view reply |
|---|---|
| `find_customer` | row `{id, name, inView:false, note}` inside `{customers:[…]}`, exactly four keys (pinned `server.test.ts:10165`) |
| `get_customer_context` | `{customer:{id,name}, inView:false, jobs:[], note}`; for an in-view customer with hidden jobs, `jobsOutsideView: N` plus "N more job(s) … outside your view (only a manager can open them)" (:500-504) |
| `get_job` | `{id, inView:false, note}` — no name, no customer id (pinned `server.test.ts:10172-10177`) |
| `list_recent_captures` | `{inView:false, captures, …, note}`; captures = her own notes only |
| `search_captures` | `{scopeFound, query, matches, count, more, inView:false, note}` |
| `get_capture` | `{found:false, note:'no such note on this firm, or it is outside your view'}` — deliberately indistinguishable from not-found, no `inView` key |
| `record_standing_fact` | thrown error → `{content:[…], isError:true}` (`server.ts:930-933`) |

The note text (`shared.ts:73-76`): *"outside your view — you see the customers whose current work
you have a trip on. Only a manager can open this one; say so, and do not guess what it holds. Notes
you wrote yourself there stay readable: list_recent_captures shows them."* The comment above it
(:71-72) calls it the hook for "the request flow (a later task)". Nothing in the seat's AGENTS.md
(`bootstrap-box.sh`) mentions the view, `inView`, or access; the tool descriptions and this note
are the only instruction the seat has.

### Hop 2 — the desk, step by step

```
seat ──ask_team_lead{question}──▶ server.ts:701
   │ flatten, refuse empty / >500 chars / spine: callers
   │ activeManager = tier==='manager' && state==='active'   (server.ts:571)
   ▼
answerDeskQuestion (desk.ts:141)
   1. createOfficeMessage {to_planner, kind:'ask', from: asker, to: spine:team-lead, unread}  :155-163
   2. memory index (planner's MEMORY.md) — every asker                                      :170-175
   3. tools = manager ? TEAM_LEAD_TOOL_SCHEMAS ∩ DESK_READ_TOOLS : []                       :179-186
      (non-manager: their own open nudges pre-read and inlined instead)
   4. runToolLoop(DESK_SYSTEM, …) — tools dispatch as spine:team-lead                       :199-217
   5. createOfficeMessage {to_planner, kind:'desk', inReplyTo: ask.id, status:'read'}       :228-237
   6. markOfficeMessagesRead([ask.id])  (best-effort)                                       :241-245
   on any error → {answer:null, note: DESK_FALLBACK_NOTE}; the ask stays UNREAD            :247-251
   ▼
seat receives {status:'answered', answer} | {status:'kept_for_the_office', note}   server.ts:741-743
```

"Read-only" describes the **model's toolset**, not the handler: the handler already writes two
`office_messages` rows and marks one read. Because the desk's tools run as `spine:team-lead`, the
dispatch gate alone would permit `write_memory`, `write_job_note` and `record_caller`; the
`DESK_READ_TOOLS` allowlist is the only barrier (`desk.ts:26-34`). A technician's desk gets no
tools at all. The planner sees the answered pair only in its next tick's desk appendix
(`planner.ts:4940-4968`), not as an unread inbox item.

### Paths from the server to a person's seat

Managers and technicians are both rows in `technicians` (`tier` enum `manager|technician`,
`database.types.ts:3998-4004`) and ride the same two legs; no leg looks at tier.

```
LEG A — a text on the person's phone ("chat"), box timer every 10 s
  nudges(queued) ─────────────┐
  office_messages(via=chat) ──┼─▶ GET /control/nudges ─▶ nudge-runner.sh ─▶ openclaw message send
  person_pushes(queued) ──────┘   (nudgeQueue.ts)                            --channel telegram
                                  needs active + sandbox_ref + telegram_user_id (:177, :242, :290)
                                  frozen after 10 serves or 3 failures (:56, :59)

LEG B — a silent turn injected into the person's assistant ("assistant"), timer every 5 min
  office_messages(to_agent, via=assistant, queued) ─▶ GET /control/office ─▶ office-runner.sh
     wrapped "OFFICE NOTE (from the office record system, not a person): … reply via
     inform_team_lead mentioning this id: <id>"  or "NOTE FROM <name>'s assistant …"
     openclaw agent --session-key main (no --deliver: the assistant decides whether to tell)
```

| Writer | What it writes | Leg | Planner sees it? |
|---|---|---|---|
| planner `send` (`planner.ts:3771-3790`) | `office_messages` to_agent / `inform`, `via` chat or assistant; or a nudge when `countsAsTheAsk` | A or B | yes — WHAT YOU SENT block (:3468-3494) |
| `inform_teammate` (`office.ts:313-323`) | to_agent / `inform`, `via` = column default `assistant`; one side must be an active manager (:297-303) | B | **no** — the outbound block filters to the team lead's ref (`officeMessages.ts:93-100`) |
| `queuePersonPush` (`personPushes.ts:19-43`) | `person_pushes` row, kind `schedule|call|ops` | A | **no** — kept apart from `office_messages` on purpose (`20260916100000_person_pushes.sql:14-16`) |
| `notifyManagers` (`calls/notify.ts:10-29`) | a push per active manager with Telegram | A | no |

No code in `src/` calls the Telegram API directly any more; the board bot is retired
(`docs/engineering-memory.md:3211-3213`). Gateway `POST /hooks/agent` is unused
(`engineering-memory.md:5319-5320`).

### How the planner hears about things

- **Tick trigger:** `lifecycle-heart` cron every 5 min → `plannerCadenceDue` (`lifecycle.ts:501`),
  then per firm 30 min inside its approximate hours, 120 outside (`planner.ts:4412-4429`). Only
  firms with a live Telegram binding are planned (:4174).
- **Early wake:** only observations of kind `inbound_new_job`, `inbound_commitment`,
  `inbound_unmatched` (`observations.ts:256`), via the Calls-worker's 10 s ping loop
  (`calls/runWorker.ts:15, 40-52` → `observationPing.ts:38-88` → focused pass). The focused pass
  stubs `listOfficeMessages: async () => []` (`plannerPass.ts:126`). A seat message does **not**
  wake the planner — that is rung 10c, unbuilt (`engineering-memory.md:4279`, :4302-4316; measured
  22:21 → read 22:31, :5946-5948).
- **Per tick reads:** open nudges, open observations, unread `to_planner` messages
  (`planner.ts:4356-4380`); a firm with no gaps and no unread messages is skipped (:4405-4409).
  Messages are shown once (up to 30, :3381) and marked read after a successful tick (:5633-5644);
  the prompt tells it "WRITE IT IN YOUR NOTES… You see a message ONCE" (`plannerPrompt.ts:112-126`).

### Hop 3 — what a grant row does

```
access_grants row (live, same tenant, not revoked, not expired)
   ├─ job grant      → that job in view  + its customer's profile and job-less notes
   └─ customer grant → ALL that customer's jobs (finished ones too) + the profile
   opens='record'           → scope only; the content gate (channel, manager_only, hidden tags) still applies
   opens='record_and_notes' → the content gate is skipped for every capture on it (manager_only included)
   opens_money=true         → figures on what it covers (viewShowsMoney / view_money_open)
```

Source: migration :296-327 (verified). Filters: `revoked_at is null` (:303), `expires_at is null
or > now()` (:304), a job grant's job must exist on the tenant (:305).

`record_caller` is the named precedent for "one call on the manager's seat". It is a team-lead
tool shared with active managers: listed in `SEAT_SHARED_TEAM_LEAD_TOOLS` (`server.ts:414`),
included in `TEAM_LEAD_TOOL_NAMES` (`identity.ts:79`), and gated at `server.ts:640-646`:

```ts
if (SEAT_SHARED_TEAM_LEAD_TOOLS.has(name) && !identity.technicianRef.startsWith('spine:') && !activeManager) {
  throw new Error(`${name} is a manager's call — recording who a caller was needs a manager badge`);
}
```

So the planner and an active manager can both call it; nobody else. It writes via
`recordFieldNote`, is idempotent through `listL2CitingCapture`, and stamps
`actorRef: identity.technicianRef` (`customers.ts:1063-1067`). Its plan is
`thoughts/shared/plans/2026-09-08-the-citing-door-on-the-seat.md` (with a deploy step, :114-127).

### Money, end to end

- Tool side: `viewShowsMoney` (`technicianView.ts:58-64`) at `customers.ts:577, 591`; SQL twin
  `view_money_open` read as `money_amounts` (migration :571 → `context.ts:240` →
  `customers.ts:464-476`). Closed → `{status}` in words (nine strings, `moneyEvents.ts:619-628`)
  and `price_cents` stripped; open → `{status, balanceDueCents, invoicedCents}`.
- Planner side: the prompt's MONEY rule is unconditional (`plannerPrompt.ts:92-97`: "A technician
  is never told an AMOUNT … This one is on you: nothing downstream checks it"); the desk's
  `DESK_NARROW_DISCLOSURE` likewise (`deskPrompt.ts:84-87`). The planner's gap block prints ledger
  lines with dollar figures for any gap, including one about a technician (`planner.ts:1514-1519,
  1928-1938`). `buildPlannerUserMessage` (:3505) takes no settings or view argument; the only
  per-firm text in the planner's prompt is its own MEMORY.md index.
- Retraction preview: `losingEvidenceOf(impact, activeManager)` (`shared.ts:581-601`) decides
  figures by tier, not by the view.

### The note-minted trip (the contradiction detector's subject)

`resolveVisitForNote` (`attachNote.ts:79-145`), for a technician's field note on a job:

1. a visit on the note's own day with her on the crew, or with nobody on it (:91-109);
2. else **the job's one live visit, whatever day, with no crew check** (:112);
3. else, technician channels only (`mayCreate`, `recordFieldNote.ts:729`), mint a completed,
   untimed visit with her on the crew and `source_capture_id` = the note (:114-130).

The view excludes trips minted by step 3 (migration :272-274). No signal is raised in any of the
three cases: `resolved.created` is read only at `recordFieldNote.ts:829`, to skip the visit
report. In case 2, if that one live visit is `confirmed` and has started, the "happened" flip
(`recordFieldNote.ts:854-865`) marks it `completed` with no crew check.

## External Dependencies

- **Supabase (Postgres + PostgREST)** — all ledgers and the view rule; RLS on, anon/authenticated
  revoked on the three new tables (migration :86-87, :158-159).
- **Render** — the web service `TradesDatabase` (MCP tools + `/control/*` routes) and
  `lifecycle-heart` (planner, watchers) have **autoDeploy off**; Calls-worker auto-deploys
  (`docs/engineering-memory.md:2372-2375`). Deploys run no migrations.
- **OpenClaw gateway on the box** — caches each seat's `tools/list`; a new or renamed tool
  reaches a seat only after `nemoclaw <s> gateway restart` (`engineering-memory.md:3821-3824`,
  :3686-3697; the 42→43 precedent :5877-5881).
- **Telegram** — reached only through the box runners (`openclaw message send`).
- **The planner's model** via OpenRouter (not examined here beyond prompt text).

## Constraints and Invariants

- **`access_grants` is a ledger.** DELETE refused unless cascaded (`pg_trigger_depth() > 1`);
  the only UPDATE allowed is one revocation stamp (:123-156). TRUNCATE is not trapped. Changing a
  grant (e.g. shortening it) means revoke + insert.
- **Grant columns:** exactly one of `customer_id` / `job_id` (:112); `opens` in
  (`record`,`record_and_notes`); `opens_money` default false; `expires_at` null = standing;
  `reason` non-blank; `granted_by`, `requested_by`, `revoked_by` are **free text, no FK, no role
  check**; `technician_id` is an FK to `technicians(id)` with no same-tenant check (a mis-tenant
  grant inserts but opens nothing, :245-251, :302). No uniqueness: duplicate live grants coexist.
- **`technician_view_rules`:** one row per tenant; NULL field = shipped default (defaults live
  only in `technician_view_of`: channels `technician_voice/note/photo`, hidden tags `{}`, money
  `status`, scope `serving`). An empty `technician_channels` array is NOT the default — it means
  no channels (:233-236). `setTechnicianViewRule` is a **full replace** (`?? null` on every
  field), so setting one field resets the others to default.
- **Fail-closed view:** unknown technician / other firm → empty view (:245-251); a
  technician-facing read that does not pass her roster id sees nothing.
- **The desk's allowlist is deliberate:** "a denylist would hand each new one to the desk
  automatically — failing OPEN" (`desk.ts:53-56`). Tests pin it: `desk.test.ts:91,101,110`
  (`tools` empty for technician / roster-less / inactive manager), `:118` (manager set equals
  `DESK_READ_TOOLS`), `:121` (no `write_memory`/`write_job_note`), `:245` ("You READ, you never
  act"); `server.test.ts:7694-7766`; `planner.test.ts:7886-7890` ("NEVER A MONEY AMOUNT").
- **Desk budget:** 40 s total, 4 turns, inside the gateway's ~60 s MCP timeout
  (`deskPrompt.ts:42-50`).
- **`office_messages.kind`** CHECK is (`ask`,`inform`,`reply`,`desk`) (migration :26, unchanged
  since); a `to_agent` row must name a `technician_id` (:55-56).
- **`person_pushes.kind`** CHECK is (`schedule`,`call`,`ops`).
- **Tool surface is pinned by hand** in `surface.expected.ts`: `TECHNICIAN_TOOLS` 17,
  `MANAGER_ONLY_TOOLS` 26, `TEAM_LEAD_TOOLS_EXPECTED` 7 (ordered), `SEAT_SHARED_TOOLS`
  `['record_caller']`, `MANAGER_TOOLS_EXPECTED` 42. Consumers: `server.test.ts:225-240` (and
  :2483, :2763, :2886), `toolCases.test.ts:63` (`SPINE_TOOL_NAMES` = `BADGE_TOOLS`), tier-1 eval
  `toolCases.ts:408-411`. `TEAM_LEAD_TOOLS` order is the planner's prompt-cache key.
- **What a new manager-seat verb touches:** as an admin tool — a domain `admin` array,
  `MANAGER_ONLY_TOOLS`, a tier-1 case in `src/eval/toolCases.ts` (`toolCases.test.ts:67-71`
  requires one); the planner cannot reach it. As a shared tool (record_caller pattern) — a domain
  `teamLead` array, `TEAM_LEAD_TOOL_NAMES`, `SEAT_SHARED_TEAM_LEAD_TOOLS`,
  `TEAM_LEAD_TOOLS_EXPECTED`, `SEAT_SHARED_TOOLS`, name pins at `toolCases.test.ts:83-91, 101`
  and `server.test.ts:8021-8031, 8816-8817` (the latter `.toEqual(['record_caller'])`); shared
  tools get no eval case and adding one would fail "names only real tools"
  (`toolCases.test.ts:73-77, 97-100`). Either way: `docs/nemoclaw-tech-agent.md` §4,
  `docs/doorman-runbook.md:371-385`, the `bootstrap-box.sh` heredocs ("Tool VOCABULARY lives in
  three places", `engineering-memory.md:3812-3819`), and a gateway restart per tier. AGENTS.md is
  written once per sandbox with no tier branching (`nemoclaw-tech-agent.md:227-228`).
- **`ask_team_lead` is on both tier surfaces**; any change to its description moves `tools/list`
  for every seat.
- **Only the planner writes `via='chat'` office rows**; only server code writes `person_pushes`.
- **The planner's re-ask rail** is once per 24 h per inbound item (`INBOUND_REASK_MS`,
  `planner.ts:682`, enforced :3752-3767). The solo-operator doctrine "ask once; unanswered stays
  queued" (`engineering-memory.md:1177+`) is not in code; the live prompt says "THERE IS NO
  HANDOVER… a question that has gone unanswered stays yours, and you end it"
  (`plannerPrompt.ts:381-395`).
- **Detectors:** every fresh gap becomes an observation, no cap (`watchers.ts:576-595`);
  detector observations dedupe forever on `(tenant_id, kind, subject_ref)` where
  `author='detector'` (`20260904110000_observations_author.sql:80-81`); sweep detectors run only
  in live mode (`watchers.ts:499`). The planner prompt names exactly two automatic checks
  (`plannerPrompt.ts:72-75`).
- **`spine_read`** exposes 16 views (`server.ts:137-240`); none covers grants or view rules;
  `v_team` exposes `ref`, not the technician uuid a grant row needs. `list_team` also returns
  `ref` (`roster.ts:869-880`); `getTechnician(tenantId, ref)` resolves a ref to a row
  (`src/db/technicians.ts:24-33`).

## Decision Points

1. **Who performs hop 2's write.** Ruling 4 says the desk relays the request. Given the code:
   (a) give the desk model a write tool — this breaks the allowlist's read-only set and the tests
   that pin a technician's desk to zero tools; (b) have the desk *handler* perform a deterministic
   write when the question is an access request — needs a way to know it is one (a new input
   field on `ask_team_lead`, or a structured flag in the model's answer); (c) a separate
   technician verb that writes the request (how `inform_team_lead` works) — departs from "through
   the desk", and changes the technician tool count (17).
2. **What carries the request to the manager "immediately".** `person_pushes` (Leg A, ~10–15 s,
   a text; kind CHECK needs a new value; invisible to the planner); an `office_messages` to_agent
   row with `via='chat'` (Leg A; only the planner writes chat rows today; visible to the planner
   only if from its own ref); `via='assistant'` (Leg B, up to 5 min, silent, the manager's
   assistant decides); or a planner send (next tick, 30–120 min).
3. **Where the request is recorded so the planner "records the request and its outcome".** An
   `office_messages` to_planner row (kinds limited to ask/inform/reply/desk; a desk ask is marked
   read once answered, so the planner sees it only in the desk appendix); an observation
   (planner-visible as a gap; detector dedupe is per subject forever); a new request table; or
   only the eventual grant row (`requested_by`), which records granted requests and nothing
   about denied or unanswered ones.
4. **Where `grant_access` sits in the tool surface.** An admin tool (manager seats only; the
   planner cannot call it) or a shared team-lead tool on the `record_caller` pattern (planner and
   active managers — the shape the "planner may grant" ruling needs; no eval coverage for shared
   tools today).
5. **How the manager names the technician and the target.** Grant rows need the technician's
   uuid; the manager's tools expose `ref` and display name. The verb takes a ref/name and
   resolves it, or a uuid is exposed somewhere.
6. **Hop 4 — who sends "you have access now".** The grant verb's handler queues it directly
   (a `person_pushes` row or a to_agent office row, the `inform_teammate` precedent), or the
   planner sends it on its next tick after seeing the grant.
7. **What the out-of-view note says.** Today it says "Only a manager can open this one; say so" —
   no offer to request. Changing it changes every door's reply at once; the shapes also differ by
   door (`get_job` has no customer id or name, `get_capture` has no `inView` marker), which bears
   on what the seat can name in a request.
8. **Revoke and list.** `revokeAccessGrant` needs a grant id, and no read surface lists grants
   (no `spine_read` view, no manager tool).
9. **Firm-rule verb semantics.** `setTechnicianViewRule` replaces the whole row; a verb could keep
   that (every call states all four fields) or merge one field at a time.
10. **The money mismatch.** A firm's `money='amounts'` (or a grant's `opens_money`) opens figures
    on the tools, while the planner and desk prompts forbid amounts to technicians
    unconditionally and the planner's gap block prints figures for every gap. The planner prompt
    has no per-firm line today; carrying the rule would mean passing settings into
    `buildPlannerUserMessage` (or the desk message), or leaving the planner more conservative than
    the tools.
11. **The contradiction detector's trigger and home.** Which event: only a step-3 minted trip, or
    also step 2's attach to someone else's single live visit (which today can also flip that
    visit to completed). Where: a write-path observation like the inbound kinds (these ping the
    planner within seconds) or a sweep detector in `runWatchers` (next heartbeat; live mode
    only). Either way the prompt's "two things" sentence names the detectors by count.
12. **Unanswered requests.** No code implements "ask once, stays queued"; the only structural
    re-ask rail is the inbound-item 24 h one.

## Open Questions

- Is `office-runner` installed and running on every box today? It was found never installed
  until 2026-09-10 (`engineering-memory.md:5339-5346`); the file's presence is not evidence.
- Does a seat reliably relay a desk answer, or a Leg B "OFFICE NOTE", to its person? Leg B has no
  `--deliver`; the assistant decides.
- Is the 40 s desk budget enough if hop 2 adds work inside the same call?
- Will rung 10c (a seat message wakes the planner) land before or after this task? It changes how
  quickly the planner could act on a request.
- How does the seat currently phrase "outside your view" to a technician? Plan 2's owed human
  check (restart s2's gateway, ask about a served and an unserved customer) was listed as owed in
  its finding; whether it was run is not recorded here.
- Doc drift noticed while reading (not acted on): `src/mcp/tools/types.ts:9` says "six tier
  gates" (seven exist); stale tool counts in `Box_Setup_Stuff/bootstrap-box.sh:1852`,
  `docs/onboarding.md:341-342`, `Box_Setup_Stuff/doorman-architecture-memory.md:372`;
  `desk.test.ts:79` titles a suite "leak-proof by construction" while `desk.ts:50-51` says not to
  describe it that way; `docs/nemoclaw-tech-agent.md:342` says all five doors return "name + id
  with inView:false"; `calls/notify.ts:19-20` and `boardNotify.ts:288` say the box tick is "a
  minute" (it is 10 s); `planner.ts:1163-1164` cites stale line numbers.
