---
date: 2026-09-01
branch: main
commit: 48288a4
topic: "Build 6.5 ground — one send verb: the gap-keyed decision shape, the three delivery paths, the attribution machinery only `send` triggers, addressing, what escalate provided, the pin/eval couplings, and the build-8 adjacency"
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This document overturns nothing — it maps the ground
build 6.5 modifies. Conducted on `main` @ `48288a4`, where build 6 is **planned but not
implemented** (`thoughts/shared/plans/2026-09-01-intent-verbs-and-the-doctrine.md`); every "today"
below is pre-build-6 code, and the places build 6 will have changed are marked **[B6]**. The ruling
itself and the probed facts it rests on are recorded in `docs/engineering-memory.md` §6a entry 6.5
and are not re-derived here.

## Summary

The planner — the one model call that decides everything about the firm's open gaps — can only
talk to humans through verbs whose destination is fixed before it speaks: `send` texts *the person
the gap names*, `ask_agent`/`inform_agent` message *that same person's assistant*, and `escalate`
files to *the firm's managers* through a queue. It cannot choose an addressee, and it cannot say
anything that is not about a gap, because every decision it submits must carry a gap id. Build 6.5
replaces those with one `send` that reaches anyone and need not be about a gap. This document
records, factually: how tightly the decision shape is keyed to gaps (schema, validate, the log
table, every reader of the log); what each of the three existing delivery paths carries, who can
receive it, and what comes back; the attribution machinery that makes `send` — and only `send` —
"count as the ask"; how a person or role is resolved today; what escalate's queue gave that the
office channel does not (durability, a resolution state, a Telegram push); every enum, pin and eval
site a verb collapse touches; and what today's grouped send does and does not express for a
two-person visit.

## Entry Points

- `src/teamLead/plannerPrompt.ts:299-415` — `SUBMIT_PLAN_TOOL`, the wire schema; `:409` the
  `required` list that pins every decision to a gap.
- `src/teamLead/planner.ts:136-197` — `PlannerDecision` / `DroppedDecision`; `:1301` —
  `validateDecisions`; `:1980+` — `applyDecision`; `:2784-2840` — the tool-loop call.
- `src/db/nudgeDecisions.ts:74` — `recordNudgeDecisions`, the only writer of the decision log.
- `src/control/nudgeQueue.ts:70` — `buildNudgeDelivery`; `src/control/officeQueue.ts:57` —
  `buildOfficeDelivery`; `src/calls/notify.ts:11` — `notifyManagers`.
- `src/mcp/server.ts:2227` — `attributeAnswerToGap`; `:3015-3075` — `inform_teammate`;
  `:2940-2995` — `inform_team_lead`'s reply branch.
- `src/teamLead/identity.ts:37-57` — `TEAM_LEAD_TOOL_NAMES`, the deny-by-default gate.

## Key Files

| File | Role for 6.5 |
|---|---|
| `src/teamLead/plannerPrompt.ts` | The schema (`required`, per-verb fields, `nudgeIds`) and the doctrine |
| `src/teamLead/planner.ts` | Decision types, validate's gap keying, the three apply cases, the office block, the push gate |
| `src/db/nudgeDecisions.ts` + migration `20260901130000:122-144` | The log: `nudge_id`/`observation_id` pair, the CHECK that one is set |
| `src/db/nudges.ts` | `markNudgeQueued`, `markNudgeGroupQueued`, `listAskedNudgesForTechnicianJob`, `setNudgeAnsweredBy`, `listQueuedNudgesForHost` |
| `src/db/officeMessages.ts` | `createOfficeMessage`, the host-pull embed (`:140-158`) |
| `src/control/nudgeQueue.ts` / `officeQueue.ts` | The two spine-side delivery transports and their freeze doctrine |
| `Box_Setup_Stuff/nudge-runner.sh` / `office-runner.sh` | The two box-side halves |
| `src/calls/notify.ts` + `src/db/technicians.ts:133` | The role-addressed Telegram push |
| `src/mcp/server.ts` | `attributeAnswerToGap`, `inform_teammate` (planner-chosen-addressee precedent), the reply branch, `SPINE_VIEW_CATALOG` |
| `src/jobs/watchers.ts:728-775` | The alarm's per-gap attention read |
| `supabase/migrations/20260824020000` | `mv_gap_outcomes` (`:22-40`), `mv_escalation_fates` (`:42-73`), `mv_whiplash` (`:75+`) |
| `src/eval/plannerCorpus.ts`, `plannerSim.ts`, `plannerEvalGraders2.ts`, `toolCases.test.ts`, `doctrine.ts` | Every verb-named coupling |

## Area 1 — the decision shape

### Every decision names a gap

`SUBMIT_PLAN_TOOL` (`plannerPrompt.ts:299`): `decisions` is an array whose items require
`['nudgeId', 'action', 'confidence', 'reason']` (`:409`). `nudgeId` is described as "the gap id,
copied exactly from the list you were given" (`:313-316`). The per-verb fields are `agentMessage`
(`:328-337`, ask/inform_agent), `notBefore` (`:338-342`, hold), `nudgeIds` (`:343-352`, send —
"every gap this ONE message covers… same person and the same job"), `question` (`:353-362`, send —
"the ENTIRE message the TECHNICIAN receives… delivered verbatim"), `handoffNote` (`:363-371`,
escalate **[B6: deleted]**), `agentContext` (`:372-379`, escalate **[B6: deleted]**), `basis` /
`citation` (close).

`PlannerDecision` (`planner.ts:136-180`) mirrors it: `nudgeId: string` is non-optional; every
other field is per-verb. `DroppedDecision` (`:184-197`) also carries `nudgeId: string`, plus
`nudgeIds` "so the siblings of a refused grouped send" do not fall to the filler.

### Validate keys every decision to a shown view

`validateDecisions(args, views, nowMs, recoverable)` (`:1301-1310`). For each entry:
`views.get(nudgeId)` → "names a gap that was not in this plan" if absent (`:1377-1380`); a `seen`
set → "a second decision for the same gap" (`:1381-1384`); then the action must be in
`PLANNER_ACTIONS` (`:1385-1388`). `recover` alone is checked against the `recoverable` set
*before* the view lookup (`:1357-1372`), because a dismissed row is not in the shown views — the
one existing case of a decision about something not on the list, and it is still keyed to a row id.

### The log stores a gap id, or nothing

`nudge_decisions` was created with `nudge_id uuid not null` (`20260817090000:27` — wait: the
creating migration is the one grep'd at `:23-53`; `nudge_id … not null references nudges(id) on
delete cascade`). Build 4 relaxed it: `alter column nudge_id drop not null` and added
`observation_id` with `check (nudge_id is not null or observation_id is not null)`
(`20260901130000:125-129`). The writer sets exactly one from `subject` (`nudgeDecisions.ts:79-83`).
`job_id` is denormalised, nullable, no FK (`20260817090000:32`). **There is no row shape for a
decision about nothing** — the CHECK forbids both ids null.

The `unmentioned` filler (`planner.ts:124`, `UNMENTIONED_CAP = 200` at `:133`) is code's own
per-gap tick mark, also keyed to a gap.

### Every reader of the log assumes a gap

- `historyLine` (`planner.ts:742`) — per gap, "the last REAL action, scanning backwards".
- `recall_decisions` → `listDecisionsForNudge` (`nudgeDecisions.ts:186`, single-id `.or()` over
  both columns) and `listDecisionsForNudges` (`:123`, two bound `.in()` reads).
- The alarm pass (`watchers.ts:744-775`): `listDecisions(tenantId, candidateIds)` per gap;
  `attendedWithin(id, …)` is keyed by gap id.
- `mv_whiplash` (`20260824020000:75+`) windows by `coalesce(d.nudge_id, d.observation_id)`
  (`20260901130000:158,165`); `mv_escalation_fates` `exists (… d.nudge_id = n.id …)` (`:59-61`);
  `mv_gap_outcomes` joins `nudges` (`:22-40`).
- `summary.byAction` (`planner.ts:294,2846`) counts action strings — gap-agnostic, but only ever
  sees decisions that validate accepted, which are all gap-keyed.

### Decision vs dispatched tool

Two things happen inside a tick that are not gap decisions, and both are **tools**, not decisions:
`write_memory` and `write_job_note` (`identity.ts:45-53`). The gate's stated rule (`identity.ts:11-15`):
"nothing irreversible or externally visible may ever dispatch for it; enforcement is mechanism (the
gate), never prompt text." The header then argues why `write_memory` passes ("not irreversible…
not externally visible: no person receives anything. Contrast `send`, which is still not a tool for
this identity — the planner PROPOSES it and code performs it after the loop, through
applyDecision", `:19-30`). So today's architecture has two write channels: **decisions** (proposed
in `submit_plan`, validated, applied by code after the loop, recorded per gap) and **tools**
(dispatched mid-loop through the gate, internal and reversible only). A message to a person is
"externally visible", which the gate header names as the reason `send` is a decision and not a tool.

The tick's whole shape (`runPlanner`, `:2319+`): open nudges + open observations → views →
`buildPlannerUserMessage` → loop → `validateDecisions` → `applyDecision` per accepted decision →
`recordNudgeDecisions`. A firm with no gaps and no unread office messages skips planning
(the gapless rule, `:2750-2760` region: "a gapless firm with unread messages PLANS").

## Area 2 — the three delivery paths

```
(a) send          planner ─► nudges 'queued' ─► /control/nudges pull ─► nudge-runner.sh
                  ─► `openclaw message send --channel telegram` ─► the PERSON's chat, verbatim
                  ◄─ record_field_note ◄─ the person replies to their assistant

(b) ask_agent /   planner ─► office_messages 'to_agent','queued' ─► /control/office pull
    inform_agent  ─► office-runner.sh ─► `openclaw agent --session-key main` (NO --deliver)
                  ─► the ASSISTANT's main session; it decides whether to involve its person
                  ◄─ inform_team_lead(replyToMessageId) ◄─ the assistant

(c) notifyManagers  code ─► listManagersWithTelegram ─► sendBoardMessage ─► each manager's
                    Telegram. No queue, no ledger, NO reply path.
```

### (a) `send` — verbatim to the person

- **Writer:** relic `pending` → `markNudgeQueued` (`nudges.ts:143-152`, resets `attempts: 0`);
  `noticed` → `createNudgeFromObservation` born `'queued'` with the observation's own uuid
  (`:78-101`); groups → `markNudgeGroupQueued` (`:272`, lead must be a member `:283-285`,
  `ask_group_id = leadId` `:291`).
- **What it carries:** `question` — `QUESTION_MAX_CHARS = 500`, `+250` per extra grouped gap,
  ceiling `1200` (`planner.ts:1277-1279`); the date rail (`cleanQuestionDraft`, `:1287-1300`) and
  the footer-impersonation check (`:1295-1297`).
- **Who can receive:** `listQueuedNudgesForHost` embeds
  `technicians!inner(id,ref,state,sandbox_ref,telegram_user_id,host_id,tenant_id)` filtered by
  `technicians.host_id = hostId` (`nudges.ts:170-181`). `buildNudgeDelivery` then skips — "frozen,
  not failed" — if `!tech || isInactiveState(tech.state) || !tech.sandbox_ref ||
  !tech.telegram_user_id` (`nudgeQueue.ts:131-133`). `isInactiveState` = `offboarding|offboarded`
  (`technicians.ts:462-464`). So a receiver needs: a roster row on a host, a sandbox, a Telegram
  binding, and a non-inactive state. **A seat-exempt person has no `sandbox_ref` → never served.**
  A manager with a sandbox and Telegram is served like anyone else; tier is never read here.
- **Delivery item** (`NudgeDeliveryItem`, `nudgeQueue.ts:43-54`): `id, sandboxRef, replyTo` (= the
  Telegram user id), `sessionId, directMessageB64`. The box (`nudge-runner.sh:142-149`) decodes and
  runs `openclaw message send --channel telegram --target $reply_to -m "$(cat $msgfile)" --json` —
  "VERBATIM… zero inference" (`:3-10`); the weekday-guard hook fires on this path (`:36-37`).
- **Ledger:** `serve_count` incremented before shipping (`:165`), `attempts` on the box's failure
  report (`:241-254`); frozen at `MAX_SERVE_COUNT = 10` / `MAX_DELIVERY_ATTEMPTS = 3`
  (`:33,36,140-161`), on a leaderless group (`:126-137`), on inactive/unbound (`:131-133`), on a
  tampered empty question (`:139`). Status flips `queued → asked` on the box's `delivered` report
  (the `asked_at` stamp) — this is the transition the whole of Area 3 hangs on.
- **What comes back:** the person answers their assistant; `record_field_note` writes L1 and calls
  `attributeAnswerToGap` (Area 3). Nothing else closes the loop — the planner sees the note as an
  evidence line next tick.

### (b) `ask_agent` / `inform_agent` — to the assistant

- **Writer:** `applyDecision` (`planner.ts:2208-2245`): `createOffice({direction:'to_agent',
  kind: ask|inform, fromRef: TEAM_LEAD_REF, toRef: ctxStr(n,'technicianRef') ?? n.technician_id,
  technicianId: n.technician_id, nudgeId: n.id, status:'queued'})`. Refused with "the record names
  no person for it" when `!view.nudge.technician_id` (`:1470-1478`). **No `seat_exempt` check at
  this apply site** — a gap whose person is seat-exempt queues and then freezes silently at serve
  time (`officeQueue.ts:69-71`, `!tech.sandbox_ref`). Contrast `inform_teammate`, which refuses
  up front (Area 4).
- **What it carries:** `agentMessage`, `maxLen: 500` at validate (`:1478-1481`), date-railed;
  `OFFICE_MESSAGE_BODY_MAX = 2000` at the accessor (body is CUT, not refused).
- **Who can receive:** the host pull embeds the same `technicians!inner(…)` (`officeMessages.ts:140`)
  filtered by host; `buildOfficeDelivery` skips on `!tech || isInactiveState || !tech.sandbox_ref`
  (`officeQueue.ts:69-71`). **No Telegram binding required** — the turn lands in the agent's main
  session, "NOTHING pings the human" (`:14-18`). So a manager with a sandbox but no Telegram is
  reachable here and not by (a). A seat-exempt person is not reachable.
- **Delivery item** (`OfficeDeliveryItem`, `:28-33`): `id, sandboxRef, kind, directMessageB64`
  where the body is `wrapOfficeMessage` (`:45-62`): an office row is framed "OFFICE QUESTION /
  OFFICE NOTE (from the office record system, not a person)" with, for an ask, "reply via
  inform_team_lead and mention this id: <id>"; a seat-sender row is framed "NOTE FROM <name>'s
  assistant (relayed through the office queue, not a person speaking)". The box
  (`office-runner.sh:32,115-127`) runs `openclaw agent --session-key main --message-file … --json`,
  **no `--deliver`**, `timeout 630` above the gateway's 600 s turn clock.
- **Ledger:** same caps, same freeze doctrine, imported from `nudgeQueue` (`officeQueue.ts:12`);
  status `queued → delivered` on the box's report (`:113-119`), `attempts` bumped on failure, **no
  `failed` status flip** — "the row FREEZES" (`:127-131`).
- **What comes back:** the assistant calls `inform_team_lead(note, replyToMessageId)`
  (`server.ts:2953-2995`): the id is validated as a UUID and resolved **inside this tenant**
  (`:2958-2962`), must be `direction === 'to_agent' && to_ref === identity.technicianRef`
  (`:2968`), and on success the reply row is `kind:'reply', in_reply_to, nudge_id: <copied from
  the ask>` (`:2985-2995`); otherwise it degrades to a plain `inform` with the id noted in the body
  (`:2973-2975`). The next tick's OFFICE MESSAGES block renders replies with ", in reply to your
  ask on gap <id>" (`planner.ts:1867-1872`).

### (c) `notifyManagers` — a push with no reply path

`notifyManagers(tenantId, text)` (`calls/notify.ts:11-23`): for each `listManagersWithTelegram`
row — `tier='manager' AND state='active' AND telegram_user_id IS NOT NULL`
(`technicians.ts:133-143`) — `sendBoardMessage(m.telegram_user_id, text)`, errors logged and
swallowed. No row is written anywhere; nothing records that it was sent; there is no id to reply
to. **This is the only path that reaches a manager who has no sandbox.** Callers today: the call
worker only (`calls/worker.ts:166,194,226`). The planner's own manager push is a separate gate —
`hasPushToken = !!process.env.BOARD_BOT_TOKEN` (`planner.ts:2319`), `summary.pushSkipped = true`
when absent (`:3074-3077`) — and it fires on `itemOpened` from an applied escalate **[B6: deleted
with the verb]**.

### Reachability, stated plainly

| receiver | (a) send | (b) office | (c) push |
|---|---|---|---|
| active person with sandbox + Telegram | yes | yes | if manager |
| active manager, sandbox, no Telegram | no | yes | no |
| active manager, Telegram, no sandbox | no | no | **yes** |
| seat-exempt helper (no sandbox, no seat) | **no** | **no** | no |
| offboarding / offboarded | no | no | no |

## Area 3 — "counts as the ask": the attribution machinery only `send` triggers

The `queued → asked` flip (with `asked_at`) is what makes a gap *asked*. From there:

- `listAskedNudgesForTechnicianJob(tenantId, technicianId, jobId)` (`nudges.ts:465-480`): status
  `'asked'`, this technician, `context->>jobId = jobId`.
- `attributeAnswerToGap` (`server.ts:2227-2250`), called from `record_field_note` with
  `answeredByTechnicianId: caller?.id` (`:2703,2857,2908`): fail-closed on a roster-less badge or
  no job (`:2237`); reads the asked list; **stamps only when `open.length === 1`** (`:2240-2242`) —
  "A person can only answer a question they were asked" (`:457-458`); two asked gaps for one person
  on one job → no stamp. `setNudgeAnsweredBy` is first-write-wins (`.is('answered_by_capture_id',
  null)`, `:504-516`).
- The stamp is shown as `<-- LINKED TO THIS GAP` on the evidence line (`planner.ts:1046`) and
  defines `mv_gap_outcomes.closed_by_technician = (n.answered_by_capture_id is not null)`
  (`20260824020000:38`).
- The planner-side citation stamp is separately gated by `TECHNICIAN_SPOKEN_CHANNELS`
  (`planner.ts:807-811`: `technician_note|technician_voice|technician_photo`) — "The evidence
  stays SHOWN to the planner either way; only the stamp is withheld" (`:805-806`).
- The freshness filter is **job-scoped**, not person-scoped: `hasActivitySince(jobId, startsAt)`
  compares the job's latest capture/visit time to the visit start (`watchers.ts:460-461`); it gates
  *minting*, and it is why one person's note on a two-person visit stops both gaps being created.

### The 5.5 ruling — office answers never fill the record

Enforced by **absence plus doctrine**, not by a guard: no code path writes `nudges` from an office
reply (the reply branch writes only `office_messages`, `server.ts:2985-2995`); the block's header
tells the planner "they never close or fill anything by themselves, and a message id takes no
decision entry — decide only about gaps" (`planner.ts:1857-1859`). A reply reaches the record only
if the planner then `close`s the gap with a citation — and the citation rail matches against the
**evidence lines**, which are L1 captures, not office rows (**[B6 Phase 4]** widens the haystack to
tool results, not to office messages). So an office reply today cannot be cited either.

### What a generalized send would have to decide per message

Whether the message **is the ask of record** — i.e. whether it should (1) flip a gap to
`asked`/`asked_at`, (2) enter `listAskedNudgesForTechnicianJob`'s result set so the person's next
note may be stamped to it, and (3) print as the gap's question. Only path (a) does these today;
paths (b) and (c) do none.

### `uq_nudges_subject_ever` — two roles

`unique (tenant_id, kind, subject_ref)` on `nudges` (`20260817090000:56`). Role 1: "ask once,
ever" — a second `send` about the same subject 23505s. Role 2, historically, the detector's dedup —
the observations migration records that "uq_nudges_subject_ever said 'ask once, ever' and doubled
as the detector's dedup; splitting the objects splits the rules" (`20260901130000:66-70`), with
`uq_observations_subject_ever` (`:73`) now carrying the detector half. The nudges index therefore
still forbids a second ask about a subject even though its dedup duty has moved. The pre-ask
`listNudgedSubjectRefs` read (`nudges.ts:118-123`) still consults it as a fresh-filter twin.

## Area 4 — addressing

### How a person is resolved at each apply site

Every apply site starts from the gap: `n.technician_id` (the FK) and `ctxStr(n, 'technicianRef')`
(the display ref in context). `send` refuses without `technician_id` (`planner.ts:1508-1513`);
`ask_agent` the same (`:1470-1478`). The technician row itself is read only at **serve** time,
through the host-pull embed (Area 2) — the planner never resolves tier, state, seat, or binding.

### `inform_teammate` — the planner-chosen-addressee precedent

The one place a **caller-supplied ref** is resolved to a message addressee (`server.ts:3015-3072`):
own-seat refusal (`:3016-3018`); `getTechnician(tenantId, mateRef)` — tenant-scoped by
construction (`technicians.ts:24-33`, `.eq('tenant_id', …).eq('ref', …)`) — and inactive refusal
(`:3019-3022`); **`seat_exempt` refused up front** ("has no assistant (schedule-only)…",
`:3026-3031`); the tier rule "a manager endpoint means an ACTIVE manager, on either side"
(`mateActiveManager`, `:3035-3041`); body cap; then `createOfficeMessage({direction:'to_agent',
kind:'inform', technicianId: mate.id, tier: caller?.tier, status:'queued'})` (`:3050-3060`); and an
honest reachability note when `!mate.sandbox_ref` (`:3064-3070`). A hallucinated ref or a ref from
another tenant both resolve to `null` → "no active teammate".

### "The manager role"

`listManagersWithTelegram` (`technicians.ts:133-143`) is the only role resolver, and it requires a
Telegram binding. In a solo firm it returns the one manager (who is also the technician); in a
three-manager firm all three. There is no "pick one manager" helper, and `office_messages` cannot
address a role — `technician_id` is singular and required for `to_agent` rows
(`20260901150000:36,55-56`).

### Inform-never-direct

Doctrine: "never instructions to you" (`plannerPrompt.ts:285`, pinned); the office block's
"information not instruction" (`planner.ts:1857`); `wrapOfficeMessage`'s "(from the office record
system, not a person)" / "not a person speaking" (`officeQueue.ts:50-61`); AGENTS.md §0l
(`bootstrap-box.sh:1090-1110`). Mechanism: `tier` on `office_messages` is "metadata only, never
authority" (`20260901150000:38-40`); the reply branch writes `tier: caller?.tier` with the comment
"Sender metadata, never authority" (`server.ts:2988-2990`). **A message FROM the planner carries no
tier** (`fromRef: TEAM_LEAD_REF`, `tier` unset at `planner.ts:2228-2245`); a message TO a manager
vs a technician is framed identically by `wrapOfficeMessage` — tier is never read on the outbound
side.

## Area 5 — what escalate provided that the office channel does not

**[B6 deletes `escalate`; this area records what goes with it.]**

| property | escalate (review_items) | office channel | push |
|---|---|---|---|
| persistence | a row that stays `open` until a human acts (`resolveReviewItem`, `reviewItems.ts:451-463`, `.eq('status','open')`) | `queued → delivered`; then nothing — no "answered"/"unanswered" state | none |
| human resolution state | `resolved` / `dismissed` + `resolution` text + `resolved_at` | none; a reply is a separate row keyed `in_reply_to` | none |
| self-cleaning | the item sweep auto-resolves an item whose gap was satisfied (`watchers.ts:392-415`, `escalatedFromNudge` in detail) | none | n/a |
| surfaces | `list_pending_reviews` (`server.ts:911`), `resolve_review` (`:1259`), the Telegram board, `v_review_items` in the planner's catalog (`:809-811`) | the OFFICE MESSAGES block next tick; **no view** — `v_nudges` exists (`:805-808`, incl. `serve_count, attempts`) but there is no `v_office_messages` | none |
| observability | `mv_escalation_fates` (`20260824020000:42-73`): `fate` (no_item / still_open / resolved / dismissed), `working_hours_to_fate`, `premature` (≤12 wh), `late` (>48 h after ask), `by_planner` | `delivered_at`; replies via `in_reply_to`; nothing computes "asked N hours ago, no reply" | none |
| reaches a manager with no sandbox | via the board, if they look | no | yes |
| notification | `notifyManagers` on `itemOpened`, gated by `BOARD_BOT_TOKEN` (`planner.ts:2319,3074`) | none — the injected turn is silent by design (`office-runner.sh:13-16`) | is the notification |

**`BOARD_BOT_TOKEN` on lifecycle-heart — unverified.** The Render service record
(`crn-d93iq7a8qa3s73ap6260`) does not expose environment variables through `get_service`; the
2026-08-25 finding ("recorded dead") stands as the last observation. Incidental: the service shows
`autoDeploy: "yes"`, trigger `commit`, branch `main` — recorded as a finding only.

**How a tick would know a sent message went unanswered — today, it cannot.** The office block shows
unread inbound rows and answered *desk* pairs (`buildOfficeMessagesBlock`, `planner.ts:1844-1886`);
it does not list the planner's own outbound asks that have no reply. The only outbound-side signals
are `office_messages.status` (`delivered`) and `delivered_at`, readable by no planner view. The
nudge side has `v_nudges` with `asked_at` and the `asksUnattended` alarm (`watchers.ts:728-733`,
≥24 h asked with no applied judgment) — an alarm about the *planner's* attention, not the
*person's* silence.

## Area 6 — the enum/pin sites and eval couplings

- **Four must-agree sites:** `PLANNER_ACTIONS` (`planner.ts:101-111`, nine), the `submit_plan`
  enum (`plannerPrompt.ts:319-320`), `PLANNER_JUDGMENT_ACTIONS` (`watchers.ts:137-150`), and
  `nudge_decisions_action_check` — **four amendments so far** (`20260821180000`,
  `20260822140000`, `20260901130000`, `20260901160000`), each a drop/re-add superset. Pins:
  `planner.test.ts:3147-3158` (enum == actions), `watchers.test.ts:1142-1146` (judgment set).
  **[B6: seven verbs; `escalate`/`leave` join `'extend'` in `attentionActions`, `watchers.ts:756`.]**
- **`applyDecision`** (`planner.ts:1980+`) is a `switch` with a non-nullable return — a verb
  added to `PLANNER_ACTIONS` without a case fails typecheck.
- **Two tool surfaces, separately pinned.** The *seat* surface: 17 technician tools
  (`server.test.ts:189,2326`), 46 manager tools (`:2046,2449`), 47 tool-eval cases
  (`toolCases.test.ts:46`, "+inform_team_lead +ask_team_lead +inform_teammate (build 5.5)"). Those
  three are the **inbound** half and are seat TOOLS, not planner verbs; collapsing
  `ask_agent`/`inform_agent` as *verbs* changes none of these counts. The *planner* surface is
  `TEAM_LEAD_TOOL_NAMES` (`identity.ts:37-57`, eight names) + `TEAM_LEAD_TOOLS` schemas, pinned
  together (`identity.ts:44-47`).
- **Corpus** (`plannerCorpus.ts`): `action:'send'` ×4, `actionNot:'send'` ×1,
  `action:'leave'` ×1, **no** `ask_agent`/`inform_agent` expectations. (Escalate's 24 are recorded
  in the build-6 plan.)
- **Sim** (`plannerSim.ts`): `office_inform` (`:901-916`) writes a `to_planner` row directly;
  `deliver` (`:932-948`) flips `pending|queued → asked` directly (the transport is not exercised);
  `manager_resolve` (`:950-977`) finds an item via `detail->>escalatedFromNudge` **[B6: dead]**.
- **Graders** (`plannerEvalGraders2.ts:172,250`): name `'escalate'` only.
- **Box-side doctrine:** AGENTS.md §0l (`bootstrap-box.sh:1090-1110`) names the *framings*
  ("OFFICE QUESTION… injected by the office's planner") and the seat tools (`inform_team_lead`),
  never the planner's verb names; `doctrine.ts` `EXPECTED_SECTIONS` (`:28-40+`) pins section
  headings only.

## Area 7 — build 8 adjacency

- **Today's group send** (`nudgeIds`): one message, one lead, delivered to **one person's chat**
  — the rail refuses "gaps that are not the same person on the same job — one message can only be
  anchored to one job and delivered to one person" (`planner.ts:1610-1614`); one stage per group
  (`:1601-1607`); lead must be a member (`:1550`, `nudges.ts:283-285`). It expresses *several gaps
  → one person*, never *one gap → several people*.
- **`office_messages` is single-addressee:** `technician_id uuid references technicians(id)` with
  `check (direction = 'to_planner' or technician_id is not null)` (`20260901150000:36,55-56`);
  `to_ref text not null` (`:30`). Several people means several rows.
- **A crew has no lead** (§6a entry 8): one person's note satisfies the visit for everyone. The
  job-scoped freshness filter already behaves that way for minting (Area 3). Attribution does not:
  `attributeAnswerToGap` stamps only when exactly one asked gap exists for *that person* on the job
  (`server.ts:2240`) — with two people each holding their own asked gap, each note stamps its own
  gap and the other stays unanswered.

## External Dependencies

OpenClaw CLI on the boxes (`openclaw message send`, `openclaw agent --session-key main`);
Telegram Bot API via `sendBoardMessage` (`BOARD_BOT_TOKEN`); Supabase/PostgREST for every store.
No new external service is implicated.

## Constraints and Invariants

- `decisions[].nudgeId` is required by schema, by type, by validate, and by the log's CHECK; no
  layer admits a gap-less decision.
- The identity gate's rule — nothing externally visible dispatches as a tool — is why every
  human-reaching action is a post-loop *decision*, applied by code.
- `uq_nudges_subject_ever` forbids a second `send` about a subject, independent of its retired
  dedup role.
- `asked`/`asked_at` is set by the **box's delivered report**, not by the planner; attribution and
  `mv_gap_outcomes` key on it.
- The office channel has no resolution state and no planner-readable view; the nudge channel has
  `v_nudges` and `asksUnattended`; the push has nothing.
- `office_messages` and `nudges` both require a specific `technician_id`; only `notifyManagers`
  addresses a role.
- Reachability differs per path (Area 2 table); a seat-exempt person is reachable by none.
- Tier is never read on any outbound path; it rides inbound as metadata only.

## Decision Points

(a) **Verb shape.** One `send` with parameters (`to`, `as` person-vs-assistant, `message`,
optional `about` gap, `counts_as_the_ask`) — vs keeping separate verbs per path. Given today's
code, "as the person" means path (a)'s machinery (nudges row, `question`, verbatim runner, Telegram
required) and "as the assistant" means path (b)'s (office row, injected turn, sandbox required);
the two have different writers, caps, receivers and freeze rules.

(b) **Does `send` absorb `ask_agent`/`inform_agent`?** They differ from `send` only in table,
framing and receiver requirements. The seat-side tools (`inform_team_lead`, `ask_team_lead`,
`inform_teammate`) are the inbound half and are pinned separately (17/46/47); a verb collapse does
not touch them.

(c) **The gap-less decision.** Options the code shapes: make `nudgeId` optional in the schema and
relax the log's CHECK (every reader in Area 1 then meets null ids); a separate top-level `messages`
array beside `decisions` with its own recorder; or a dispatched **tool** through the identity gate
— which the gate's own header currently rules out for anything a person receives. Where a gap-less
send is recorded: `nudge_decisions` cannot hold it today; `office_messages` can (`nudge_id`
nullable) for path (b) only; path (a) has no gap-less row shape (`nudges` needs `kind`,
`subject_ref`).

(d) **Durability.** What outlives a tick when a message goes unanswered: the planner re-asking on
its own judgment (needs `uq_nudges_subject_ever` addressed for path (a), nothing for path (b)); a
planner-readable "unanswered outbound" view over `office_messages` (none exists); or nothing.

(e) **Observability.** What replaces `mv_escalation_fates`' resolved-vs-dismissed and
`working_hours_to_fate`: `delivered_at` + reply rows are the only office-side signals; a reply is a
free-text row, not a status.

(f) **Addressee validation.** A planner-supplied ref must resolve inside the tenant
(`getTechnician`'s scoping), be non-inactive, and — per path — have a sandbox and/or Telegram;
`inform_teammate` is the existing precedent, including the up-front `seat_exempt` refusal that the
planner's `ask_agent` apply site lacks. A role (`managers`) has one resolver, Telegram-gated.

(g) **"Counts as the ask."** A flag on the message vs derived from `about`: only path (a)'s
`queued → asked` flip enters attribution; a message about a gap that does not flip it leaves the
gap `noticed`/`pending` with no `asked_at`, no attribution, and no `question` printed.

(h) **Re-ask vs `uq_nudges_subject_ever`.** A second path-(a) send about a subject 23505s; a
second path-(b) send does not. The index's dedup role has moved to observations; its ask-once role
has not been ruled on.

(i) **One message to several people.** Today: several gaps → one person (groups) is expressible;
one gap → several people is not, on either channel; attribution is per-person-per-job.

## Open Questions

- Is `BOARD_BOT_TOKEN` set on lifecycle-heart now? `get_service` does not expose env; last
  observation 2026-08-25 was "absent". Verifiable only from the Render dashboard or a tick summary's
  `pushSkipped`.
- lifecycle-heart shows `autoDeploy: yes` on `main`, yet its tick summaries carry the pre-build-4
  shape (`nudgesCreated`, `nudgeMode`) and the pilot DB has no `observations` table. Which commit is
  actually running is not determinable from the repo — recorded, not investigated.
- Does the assistant reliably involve its person on an office `ask`? The runner lands a silent turn;
  whether the agent then messages the human is the agent's judgment under AGENTS.md §0l. Not
  measurable from the spine today (no reply ⇒ indistinguishable from "read and ignored").
