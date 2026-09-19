---
date: 2026-09-19
task: Retire the manager review queue (list_pending_reviews + resolve_review) and move email connections out of the manager's bot (get_connect_link); keep review_items as the confirmation-token store
research: none (task 20260916-retire-the-manager-review-queue-keep-rev; the survey is in its notes and the Decisions below)
status: draft
supersedes: thoughts/shared/plans/2026-09-15-the-retrieval-layer-4-schedule-reviews-relay.md (its list_pending_reviews paging and review_queue_page only)
---

## Overview

Managers never ask "what's pending?", so the two queue tools reach nobody (operator 2026-09-16). On the pilot
every gap item in the queue is also a planner nudge, and the planner reads only nudges. The operator then
moved team administration out of chat altogether (2026-09-19). Email connections, Telegram bot tokens and
team ids will live on a settings page in the schedule UI, which is not built yet.

This plan therefore does three things:
- Removes the two queue tools and `get_connect_link` from the manager's bot (42 tools → 39).
- Moves the three kinds still written today (`unknown_ref_capture`, `offboarding_reminder`, `call_action`)
  to observations, the rows the planner sees and settles.
- Retires `review_queue_page` and closes the pilot's stale open items.

`review_items` keeps the two-step tokens, `pairing_verification` and `availability_setup`.

## Decisions

- **Email connections leave the manager's bot (operator, 2026-09-19).** "The manager manages the team's
  user id, telegram bot tokens, email connections … all in one place. A settings page in the current
  schedule ui." What that means now:
  - `get_connect_link` is removed.
  - The `confirm_mailbox` tool from the first draft is dropped.
  - The mailbox check STAYS. Someone who connects waits in `pending_verification` until the settings page
    can confirm them (operator: "keep them waiting for the UI").
  - There is no interim way to mint a link (operator: "no new connections for now").
  - The settings page is parked on the board.
  - This overrides the operator's earlier D1=A. The rejected option, switching people on as soon as they
    connect, remains open for the settings page to decide.
- **The manager's own in-chat app connecting stays on (operator).** A manager's Composio session keeps
  `manageConnections`. It connects the manager's own tools and puts no mail watcher on anything, so it is
  not a way for mail to reach the record. The seat instructions must still forbid using it for Gmail,
  because a Gmail connected that way is signed in with nothing watching it (the live finding of 2026-09-07,
  `bootstrap-box.sh:863-866`).
- **The pairing machinery stays in `src/composio/pairing.ts` for the settings page.**
  - Kept: `createConnectLink`, `checkPairing` (the lifecycle sweep still finishes links already handed
    out) and `unpair`.
  - Removed: `ServerDeps.connectLink`, `ServerDeps.checkPairing` and `ServerDeps.unpair`
    (`server.ts:75-77`), because no tool uses them.
- **Three live kinds become observations (operator, D2=A).** `availability_setup` keeps being written and
  keeps closing itself. The add-seat note stops saying "dismiss the availability_setup item".
- **Defaults accepted (operator).** A migration drops `review_queue_page`, applied after the code deploys.
  The operator runs a script that closes the pilot's leftover open items.
- **No cancel tool for staged tokens.** Every token expires 15 minutes after staging (`comms.ts:278`,
  `captures.ts:536/913/1411`, `customers.ts:749`, `roster.ts:381`), so not confirming is cancelling. The
  exception is `pending_deactivation` (caught in plan review). It stores no `stagedAt` and its confirm
  (`roster.ts:519`) checks no age, so `resolve_review dismissed` was its only cancel. Phase 2 gives it the
  same 15-minute expiry as `add_technician_seat` (`roster.ts:381-383`). It also supersedes an expired open
  row when the deactivation is staged again (second review). Otherwise the dedup upsert
  (`reviewItems.ts:104-126`) would hand back the dead confirmId, and the manager's "yes" would be refused.
  It must not supersede a live row: `server.test.ts:1068-1069` pins that a repeat stage returns the same
  confirmId.
- **`call_action` keeps its immediate push to managers (implementer's call; the operator may flip it).**
  None of the three kinds is pinged, so the planner sees them only on its regular pass: every 30 minutes,
  or every 120 off-hours (`planner.ts:558,575`). Without the push a complaint call could wait up to
  2 hours. Rejected: adding `call_action` to `PINGED_KINDS`. That list drives inbound-message behaviour in
  about ten planner places (words block, moot facts, booking citations, quiet notes;
  `planner.ts:1583,4669,4724`, `shared.ts:703`).
- **Dedup keys** (`subject_ref`; detector rows are unique per kind, ever):
  - offboarding: `<ref>@<offboarding_started_at>`, one row per episode.
  - unknown ref: `<ref>`. The first event may be personal mail, which is dropped before L1
    (`webhook.ts:375`), so that row carries no capture id. Today a resolved item re-flags on each new
    message; now there is one row per ref, and the planner's `recover` brings it back.
  - call: the capture id.
- **`technician_id` is null on all three.** Each is a question for a manager, and the person named either
  cannot settle it or has left. With no `technician_id`, `send` makes the planner name a manager in `to`.
- **Code closes the offboarding reminder when its fact settles.** Reactivation or expiry calls
  `dismissOpenObservationsForRef`; `recover` still works. A retraction also dismisses its `call_action`.
  The precedent is `retract_capture` (`captures.ts:986-1006`). Only `open` rows need closing, because these
  kinds carry no `technician_id`, and a send can become "the ask" only when it goes to the gap's own person
  (`planner.ts:2902-2945`). So these rows never turn `asked` or hand over to a nudge. The second review
  suggested closing nudges too; checked and not needed.
- **Accepted edge, already recorded:** if someone is deactivated while still unconfirmed and then
  reactivated, they come back `active` without a confirmation (`roster.ts:615-617`, "the manager drove both
  actions"). That is the one route past the wait, and it is left as is.
- **No dates and no caller words in the notes.**
  - A note renders as the planner's `about:` line (`planner.ts:1534-1545`).
  - The date rail (`planner.ts:2118`) drops any message that echoes a date or a phrase like "2 days".
  - A retraction cannot reach a quote copied into a note, so `call_action` cites its capture id instead.
    `v_captures` already hides retracted calls.
- **Cleanup leaves escalations open (plan review).** Items carrying `escalated_from_nudge` feed the
  planner's "how did my handovers end" reading (`plannerPrompt.ts:459-462`) and `mv_escalation_fates`.
  Dismissing them all at once would forge a pattern of managers dismissing them. Nobody acted on them, so
  open is their true state.
- **Left alone:**
  - `watchers.ts`'s legacy `overdue_visit_gap` reads (`:287-290`).
  - The `ReviewKind` union.
  - The table name.
  - People already in `pending_verification`, who wait for the settings page.
- **Seat instructions.** In `bootstrap-box.sh`:
  - Rule 8's Gmail line (`:850-853`, `:863-866`) now says connecting a mailbox is not done in chat.
  - Rule 2 of the office-questions block (`:1178-1181`, `agentContext` on queue items, which nothing has
    minted since build 6) is deleted.
  - Rolling these to live seats is an operator step, s2 first.

## Plain-language walkthrough

Today some "a manager should know about this" events go into a list that only shows up if a manager asks
for it, and nobody asks. Email connecting also happens in chat, which the operator wants moved to a
settings page later. This change routes the events to the planner (the background agent that decides whom
to message), and takes the list tools and the connect-link tool out of the manager's chat.

```
BEFORE                                              AFTER
unknown mailbox ─┐                                  unknown mailbox ──► observation ──┐
removal deadline ┼─► review_items ◄── manager       removal deadline ─► observation ──┼─► planner ─► may text
phone call ──────┘   (the queue)      must ASK      phone call ─► push + observation ─┘            a manager
pairing ──────────► review item ◄── resolve_review  pairing ─► review item, waits for the settings page
get_connect_link in the manager's chat              (no new connections until that page exists)
staged tokens ────► review_items                    staged tokens ──► review_items (unchanged)
```

**Phase 1: the three events reach the planner.** Each of these adds a row to the planner's observations:
mail from someone not on the roster, a removal about to become permanent, or a phone call asking to
change or cancel something. You can see it in `v_observations`, and the planner's next pass picks it up.

**Phase 2: the manager's chat loses three tools.** `list_pending_reviews`, `resolve_review` and
`get_connect_link` go, and a manager's assistant asked to connect Gmail says it's not available in chat.
A staged deactivation now lapses after 15 minutes like every other confirmation.

**Phase 3: cleanup.**
- The paging database function is dropped.
- A script closes the stale pilot items and leaves the escalations open.
- Docs and seat instructions stop mentioning the removed tools.
- Manager seats restart so they see the shorter tool list.

## Secrets & env preflight

- **Phases 1–2:** none beyond this worktree's local-stack `.env.test` (already generated).
- **Phase 3, pilot steps (operator):**
  - `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a root `.env`. They're already
    required, but this worktree has none, so copy the main checkout's.
  - The Supabase MCP (`supabase-test`), to run `apply_migration`.

## Phase 1: The three events become observations

Line ranges in this plan locate code. Delete by symbol, not by range, because several ranges touch their
neighbours.

### Changes required

**`src/db/observations.ts`**: add these after `createObservation`. Each helper wraps it with author
`detector` and `technicianId: null`, and returns `Promise<Observation | null>`:
```ts
raiseOffboardingObservation({ tenantId, ref, displayName, startedAt })   // subject `${ref}@${startedAt}`, context { ref, startedAt, note }
raiseUnknownRefObservation({ tenantId, ref, captureId: string | null })  // subject ref, context { ref, captureId, note }
raiseCallActionObservation({ tenantId, captureId, intents, priority, callerPhone: string | null })  // subject captureId
export async function dismissOpenObservationsForRef(tenantId: string, kind: ReviewKind, ref: string,
  reason: string): Promise<number>  // open→dismissed (+reason, dismissed_at) WHERE tenant, kind, status open,
                                    // author 'detector', context->>'ref' = ref; returns rows changed
```
Notes are plain sentences. They contain no dates, no digit followed by a time unit, and never the literal
"null":
- **offboarding:** "<name>'s removal from the team becomes permanent soon and cannot be undone after that.
  Until then a manager can undo it (reactivate_technician_seat)."
- **unknown ref:** "Mail arrived through a mailbox connection filed under '<ref>', and nobody on the team
  has that ref." Then one of:
  - "It is kept on the record as capture <id>."
  - "Its first message was personal mail, so that one was not kept." (when `captureId` is null; the
    row is keyed per ref, so it must not claim nothing from the ref is ever kept)
- **call:** "[Urgent: ]A phone call[ from <number>] asked to: <intents> (the call router's reading; nothing
  was changed). The managers got a one-line alert when it came in. Capture <id>; spine_read v_captures for
  the words."

**`src/composio/offboarding.ts`**:
- Deps (`:35-36`, `:90-91`): `flagReminder` becomes `raiseReminder?: typeof raiseOffboardingObservation`,
  and `resolveItemFor` becomes `dismissFor?: typeof dismissOpenObservationsForRef`.
- Expiry close (`:193-199`): `dismissFor(row.tenant_id, 'offboarding_reminder', row.ref, 'the removal
  became permanent')`.
- Reminder (`:207-213`): `raiseReminder({ tenantId: row.tenant_id, ref: row.ref, displayName:
  row.display_name, startedAt: row.offboarding_started_at })`. `if (item) result.reminded++` stays.

**`src/inbound/webhook.ts`**:
- The `flagReview` dep type becomes `typeof raiseUnknownRefObservation` (`:91`, `:164`).
- The personal-mail path (`:375`) calls it with `{ tenantId, ref: technicianRef, captureId: null }`.
- The work path (`:507-511`) calls it with `{ tenantId, ref: technicianRef, captureId: r.captureId }`,
  inside the unchanged `!tech && r.status !== 'duplicate'` gate.

**`src/calls/worker.ts`**:
- `WorkerDeps.openCallActionReview` becomes `raiseCallAction: typeof raiseCallActionObservation` (`:5`,
  `:44-51`, `:66`). It is called at `:176-183` with `{ tenantId, captureId: result.captureId, intents:
  reviewIntents, priority, callerPhone: row.caller_phone }`.
- `notifyManagers` is unchanged.
- Fix the comments at `:148-171`, and add one: `captureHasLinkedL2` counts any observation as processed
  (`rawCaptures.ts:198-205`). So a retry after the raise reports `duplicate` and skips structuring, even
  if a re-classification would add `new_job`.
- `src/calls/notify.ts:6`: the durable record is the observation now.

**`src/mcp/tools/captures.ts`** (`:994-996`): the retraction loop also dismisses `call_action`, whose
`subject_ref` is the capture id.

**`src/mcp/tools/roster.ts`** (reactivate, `:644-649`): the `offboarding_reminder` review-item close
becomes `dismissOpenObservationsForRef(tenantId, 'offboarding_reminder', ref, 'reactivated during the
grace period')`.

**`src/db/reviewItems.ts`**:
- Delete `flagUnknownRefCapture` (`:128-164`), `openCallActionReview` (`:208-237`) and
  `flagOffboardingReminder` (`:286-327`).
- In the kind comments (`:30-42`, `:199-206`), say these are observation kinds now.

**`src/teamLead/plannerPrompt.ts`**: after the paragraph ending "they will not recognise a message they
sent themselves." (`:244-249`), add: "THINGS ONLY A MANAGER CAN SETTLE. `offboarding_reminder`,
`unknown_ref_capture` and `call_action` items are not questions for the person they name. The item says
what happened. Whether and when a manager hears about it is yours to judge."

**Tests:**
- `observations.test.ts`: each `raise*` writes its key and context, and a second call returns null. The
  dismiss helper closes only the open detector rows of that kind and ref on that tenant, and returns the
  count. The file never truncates (`:24-31`), so refs carry the run id and created ids go into
  `createdIds`.
- `offboarding.test.ts`:
  - Move the `:207` expectation to the dismiss call.
  - At `:104-107` and `:191`, assert `{ ref, displayName, startedAt }`, not `subjectRef`.
  - The reminder is raised once per episode.
- `webhook.test.ts`:
  - The `flagRecorder` (`:118-129`) and `:431-435` switch to `{ ref, captureId }`.
  - The work path raises with the capture id; a duplicate does not raise.
  - The personal-mail test (`:553-566`) expects `{ ref, captureId: null }`.
- `worker.test.ts`: `:97` becomes `raiseCallAction`, and `:217-219` drops `snippet`. It gets the intents,
  and `notifyManagers` still fires.
- `server.test.ts`:
  - `:2512-2533`: raise `raiseOffboardingObservation` in place of the review item, and assert it is
    dismissed after reactivate.
  - New: retracting a call dismisses its `call_action`.
- Delete `reviewItems.test.ts:32-70` and `technicians.test.ts:344-380`.

### Automated verification
- [x] `npm run typecheck`, `npm run lint` and `npm test` pass, including the tests above.
- [x] `grep -rn "flagUnknownRefCapture\|openCallActionReview\|flagOffboardingReminder" src` is empty.

### Live verification (agent-executable)
- Prerequisites: this worktree's local stack (`project_id` `TradesDatabase-retire-the-manager-4eec4e`).
- [x] Covered by the codified tests, which read results back from the DB. The pilot has no removal or
  unknown mailbox to drive live.

### Manual verification
- (none)

---

## Phase 2: Three tools leave the manager's chat

### Changes required

**`src/mcp/tools/roster.ts`**:
- Delete `get_connect_link`: its definition (`:131-142`), handler (`:699-752`), registry entry (`:964`)
  and the `checkPairing`/`createConnectLink` imports (`:17-18`).
- Reactivate note (`:680`): "no mailbox was ever paired — pairing a mailbox moves to the settings page,
  which is not built yet". It must still match `/pair/i` for `toolCases.ts:1150`. Update the comments
  at `:619-622`.
- The add-seat note (`:436-441`) drops "or … dismiss the availability_setup review item with that note".
- **Deactivation expiry:**
  - Both `pending_deactivation` upserts (`:477-482`, `:491-496`) add `stagedAt: new
    Date().toISOString()` to `detail`.
  - **At stage** (`:491-496`): if the returned row's `detail.stagedAt` is more than 15 minutes old,
    dismiss it ('confirmation expired') and upsert again. A live row is returned unchanged.
  - **At confirm**, after the token read (`:519-525`): an item older than 15 minutes is dismissed as
    'confirmation expired', and the call throws "confirmation expired — call again without confirmId to
    restart", exactly as `:381-383` does.
  - A legacy row without `stagedAt` passes; Phase 3 retires those rows.

**Elsewhere:**
- `src/mcp/tools/reviews.ts`: delete.
- `src/mcp/server.ts`:
  - Remove the reviews import (`:55`), `...reviewsTools.admin` (`:282`) and `...reviewsTools.handlers`
    (`:521`).
  - Remove the `connectLink`/`checkPairing`/`unpair` deps (`:75-77`) and their imports (`:23-25`).
  - Change the `v_review_items` text (`:220-222`) to "confirmation tokens people have staged and not yet
    confirmed, plus the retired manager queue's history".
- `src/teamLead/plannerPrompt.ts:458`: "and the manager's queue (v_review_items)" becomes "and
  v_review_items, the retired manager queue".
- `src/db/reviewItems.ts`: delete `ReviewQueueItem`, `ReviewQueuePage` and `getReviewQueuePage`
  (`:401-480`). Keep `listOpenReviewItems`.
- `src/composio/outbound.ts:33`: "'<ref>' has no paired mailbox — pair one via get_connect_link first"
  becomes "'<ref>' has no paired mailbox yet — connecting one moves to the settings page". Keep the
  substring "no paired mailbox", which `server.test.ts:2912` and `outbound.test.ts:89,126,191` assert.
- `src/db/technicians.ts:14`: fix the comment.
- `src/mcp/tools/surface.expected.ts`: remove `'get_connect_link'` (`:56`), `'list_pending_reviews'`
  (`:58`) and `'resolve_review'` (`:66`).
- `src/eval/toolCases.ts`: delete R10, F02 and the `get_connect_link` case X06 (`:1356-1366`; X09 starts
  at `:1368`).
- `src/eval/toolCases.test.ts:133`: drop `'get_connect_link'` from `externalTools`.

**`src/mcp/server.test.ts`**:
- **Delete:**
  - `reviewsAll` (`:198-214`)
  - the tests at `:855` and `:2115`
  - the WHOLE pairing-lifecycle describe (`:2148-2282`). A describe with no tests left fails vitest
    ("No test found in suite"; `passWithNoTests` is not set).
  - the describe at `:10045`
  - the `get_connect_link` refusals at `:1340-1342` and `:1375-1377` (the `bind_telegram` ones stay)
- **The deactivate/reactivate test.** It relied on the deleted describe for its rows AND its seats.
  That describe raised seats to 2 managers and 6 technicians (`:2151`, `:2206`); without it, 3 of 3
  technician seats are taken. So its setup must, in order:
  1. Call `setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 6 })`.
  2. Insert `pair-probe` (then update it to active, with `ca_probe` and a connected email), `pair-two` and
     `pair-early`, both left invited.
  3. Set up the stale `pairing_verification` item (`:2485-2512`).

  The at-cap block (`:2584-2600`) counts `pair-early`, and the describes after it inherit this end
  state.
  - Drop the `checkPairing`/`connectLink` stubs (`:2440-2441`) and the `carlLink` probe (`:2580-2582`).
    Carl's invited state (`:2576-2579`) is proof enough.
  - Add two cases, each with `detail.stagedAt` backdated through `pg`:
    - a confirm on that token is refused as expired
    - staging again returns a DIFFERENT confirmId, and confirming that one succeeds
- **`:971`:**
  - Remove the two queue tools from the denied and listed arrays (`:981-982`, `:1000-1001`).
  - In the Reviews block (`:1119-1225`), drop the list, briefing, generic-resolve, pending_deactivation
    resolve/cancel and cross-tenant resolve parts. Nothing is left to probe once `resolve_review` is gone.
- **Trims:**
  - `:2734`: drop `:2878-2900`.
  - `:4040`: keep "re-stage supersedes". Drop the resolve/cancel half AND `:4065-4068`, because an
    uncancelled `b` would commit `k_two`. Rename the test.
  - `:4662`: drop `:4744-4770`.
  - `:4968`: update the comment.
- **`:5795`:** read `availability_setup` with a `pg` query instead of `reviewsAll`, drop the "not known
  yet" dismiss step, and rename the test.
- **`:7619`:** drop the `list_pending_reviews` entry.

### Automated verification
- [x] `npm run typecheck`, `npm run lint` and `npm test` pass. `expectSurface` fails by name if the tool
  list is wrong.
- [x] `grep -rn "list_pending_reviews\|resolve_review\|get_connect_link\|getReviewQueuePage" src` finds only
  historical comments.

### Live verification (agent-executable)
- Prerequisites: the local stack.
- [x] Covered by `server.test.ts`'s MCP round-trips, which check listing, dispatch and DB read-back.

### Manual verification
- (none)

---

## Phase 3: Drop the page function, clean the pilot, docs

### Changes required

**`supabase/migrations/20260919120000_drop_review_queue_page.sql`**:
- Header: apply only after the web service is running this code, because the running service calls the
  function until then.
- Body: `drop function if exists review_queue_page(uuid, text, timestamptz, uuid, int, int);`
- **`src/db/database.types.ts`:** after applying the migration locally, run `npm run gen:types:local`
  (never `gen:types`, which points at the pilot). The diff must only remove `review_queue_page`
  (`:3869`); otherwise hand-delete that block.
- Delete **`src/db/reviewQueue.test.ts`**.

**`src/admin/retireReviewQueue.ts`** — the cleanup logic goes in a module so it can be tested:
`retireReviewQueue({ dryRun }): Promise<Report>`. It works across EVERY tenant, not
`backfill-schedule.mjs`'s single `getTenantByName('Default Tenant')`, and only through `src/db/`.
- It handles open items of these kinds: `sheet_ref_mismatch`, `unknown_ref_capture`,
  `offboarding_reminder`, `unlinked_call`, `call_action`, `overdue_visit_gap`, `job_cost_gap`.
- It carries two kinds forward first:
  - an `offboarding_reminder` whose person is still `offboarding` → `raiseOffboardingObservation`
  - an `unknown_ref_capture` whose ref is STILL off the roster (`getTechnician` finds nobody) →
    `raiseUnknownRefObservation`, with the newest `raw_captures` id for that ref or `null`. A ref that has
    since joined is just dismissed.
- It skips any item with `escalated_from_nudge` set. It dismisses the rest with the resolution "review
  queue retired 2026-09-19; see thoughts/shared/plans/2026-09-19-retire-the-manager-review-queue.md".
- It also dismisses open `pending_deactivation` rows that have no `detail.stagedAt`.
- The report gives counts of carried, skipped and dismissed by kind. It never touches any other token,
  `pairing_verification` or `availability_setup`.

**`src/admin/retireReviewQueue.test.ts`**: `pg` fixtures, then an assertion on each row's after-state.
`seed.mjs` writes no `review_items`, so a run against the seed would prove nothing. The fixtures:
- one open row of each handled kind
- one with `escalated_from_nudge`
- an `offboarding_reminder` whose person is still offboarding
- an `unknown_ref_capture` with a matching `raw_captures` row, and one whose ref has since joined
- a legacy `pending_deactivation`
- a live token, a `pairing_verification` and an `availability_setup`

The test also checks that a dry run writes nothing and that a second run reports 0.

**`scripts/retire-review-queue.mjs`**: a thin wrapper around the module. It mirrors
`backfill-schedule.mjs`'s header, flags (`--local`/`--hosted`, `--dry-run`) and two-URL target check. It
imports from `dist/`, so build first.

**Docs:**
- Remove or reword the three tools in:
  - `docs/nemoclaw-tech-agent.md:144-151,248-260,293,564`
  - `docs/control-plane.md:10,17-18,54,102`
  - `docs/doorman-runbook.md:384,390`
- `docs/customer-onboarding-runbook.md:176-181`: Gmail pairing is paused until the settings page exists.
- Change the manager count to 39 in `Box_Setup_Stuff/doorman-architecture-memory.md:373` and
  `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:24`.
- `Box_Setup_Stuff/bootstrap-box.sh`:
  - Rule 8's Gmail line (`:850-853`) becomes: "GMAIL is not connected in chat any more; connecting,
    re-connecting or fixing a mailbox moves to the settings page, which is not built yet. Say so plainly.
    Never connect Gmail any other way, COMPOSIO_MANAGE_CONNECTIONS included."
  - Keep the half-connected warning (`:863-866`), re-pointed at that rule.
  - Drop "the office … asks a manager to confirm the mailbox" (`:859-862`).
  - Delete office-questions rule 2 (`:1178-1181`) and renumber rule 3.
- `docs/engineering-memory.md`:
  - At the "Consequence to plan for" paragraph (`:5543` in this worktree), record that the queue is
    retired (this plan).
  - Add a short entry covering the kept push, the three observation keys, "no cancel tool; tokens expire
    (and `pending_deactivation` now does too)", and "pairing waits for the settings page".

### Automated verification
- [ ] Grep `project_id`, then run `npx supabase migration up --include-all` on the local stack.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
- [ ] `src/admin/retireReviewQueue.test.ts` passes: the fixtures' after-states, the dry run and the
  idempotent re-run.
- [ ] `npm run build && node -r dotenv/config scripts/retire-review-queue.mjs --local --dry-run` runs
  end to end. This is only a wrapper smoke test.
- [ ] Run `npm run decisions:index` and commit the regenerated files.

### Live verification (agent-executable)
Rollout after merge, in this order:
- [ ] The operator deploys the web service by hand (it does not auto-deploy). Read the lifecycle cron's
  `autoDeploy` from the Render API and deploy the cron too, because it runs the offboarding sweep.
- [ ] `tools/list` for a manager badge on the pilot shows none of the three removed tools. This proves
  the server only, because each gateway caches its tool list (engineering-memory `:3835`, `:6962`).
- [ ] The operator restarts every manager seat's gateway (`nemoclaw <seat> gateway restart`, s2 first).
  Prove it by behaviour, never by `status`: ask the manager bot to connect someone's Gmail. It must say
  that happens on the settings page and must not produce a link.
- [ ] The operator applies the drop (Supabase MCP `apply_migration`, then `notify pgrst, 'reload
  schema'`). Read back: no `review_queue_page` in `pg_proc`.
- [ ] The operator runs the cleanup with `!` from the worktree root: `--hosted --dry-run`, then `--hosted`.
  Read back: open `review_items` hold only token kinds, `pairing_verification`, `availability_setup` and
  the skipped escalations.

### Manual verification
- [ ] The operator refreshes the rule-8 and office-questions blocks on live seats (s2 first), then md5s each
  box's `bootstrap-box.sh` against the repo.
