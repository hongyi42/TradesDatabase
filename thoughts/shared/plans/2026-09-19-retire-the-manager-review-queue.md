---
date: 2026-09-19
task: Retire the manager review queue (list_pending_reviews + resolve_review) and keep review_items as the confirmation-token store
research: none (task 20260916-retire-the-manager-review-queue-keep-rev; the survey is in its notes and the Decisions below)
status: draft
supersedes: thoughts/shared/plans/2026-09-15-the-retrieval-layer-4-schedule-reviews-relay.md (its list_pending_reviews paging and review_queue_page only)
---

## Overview

Managers never ask "what's pending?", so the two queue tools reach nobody (operator, 2026-09-16). On the
pilot, every gap item in the queue is also a planner nudge, and the planner reads only nudges. Four paths
still depend on the tools:
- Gmail pairing's manager verdict moves to a `confirm_mailbox` tool.
- Three kinds still written today (`unknown_ref_capture`, `offboarding_reminder`, `call_action`) move to
  observations, the rows the planner sees and settles.

Then both tools, `review_queue_page` and the pilot's stale open items are retired. `review_items` keeps the
two-step tokens, `pairing_verification` and `availability_setup`.

## Decisions

- **Pairing (operator, 2026-09-19, D1=A):** a manager-only `confirm_mailbox(ref, verdict: right|wrong)`
  replaces `resolve_review` for this. The pairing also raises a `pairing_verification` observation, so the
  planner tells a manager. Rejected: dropping the check, which is the only catch for a wrong Google account
  feeding undeletable mail into L1.
- **Three live kinds become observations (operator, D2=A).** `availability_setup` keeps being written and
  closing itself. The add-seat note stops saying "dismiss the availability_setup item".
- **Defaults accepted (operator):** a migration drops `review_queue_page`, applied after the code deploys.
  The operator runs a script that closes the pilot's leftover open items.
- **No cancel tool for staged tokens.** Tokens expire 15 minutes after staging (`comms.ts:278`,
  `captures.ts:536/913/1411`, `customers.ts:749`, `roster.ts:381`), so not confirming is cancelling.
  The exception is `pending_deactivation`, found by the plan review. It stores no `stagedAt`, and its
  confirm (`roster.ts:519`) checks no age, so `resolve_review dismissed` was its only cancel. Phase 2
  gives it the same 15-minute expiry as `add_technician_seat` (`roster.ts:381-383`). It stays a token.
- **The manager's reply is the weak link (a named risk, from the plan review).** The planner's chat
  text reaches the manager's phone, but delivery is one-way, so the seat's session may not hold that
  text. Only `PINGED_KINDS` may pair a chat text with a quiet note to the assistant
  (`planner.ts:2750-2762`).
  - Mitigation: the pending person can be found from state. `list_team` shows `pending_verification`
    and `get_connect_link` shows the address, and `confirm_mailbox`'s description plus one AGENTS.md
    line say so.
  - Rejected: extending the quiet-note pairing to these kinds, which rewires the send rails
    (`planner.ts:2754,3106,3682`) and the ask stamp.
  - The Phase 3 manual check is the real proof.
- **Cleanup leaves escalations open (plan review).** Items carrying `escalated_from_nudge` feed the
  planner's "how did my handovers end" reading (`plannerPrompt.ts:459-462`) and
  `mv_escalation_fates`. Dismissing them all at once would forge a pattern of manager dismissals.
  "Open" is the true state, because nobody acted on them.
- **`call_action` keeps its immediate manager push (implementer's call; the operator may flip it).**
  None of the four new kinds is pinged. The planner sees them on its regular pass, every 30 minutes or
  every 120 off-hours (`planner.ts:558,575`). Dropping the push could delay a complaint call by up to
  2 hours. Rejected: adding `call_action` to `PINGED_KINDS`. That list drives inbound-message behaviour in
  about ten planner places (the words block, moot facts, booking citations, quiet notes;
  `planner.ts:1583,4669,4724`, `shared.ts:703`). The note tells the planner the managers were already
  alerted.
- **Dedup keys (`subject_ref`, once ever per kind for detector rows):**
  - pairing: `<ref>@<connectedAccountId>`, so re-pairing after "wrong" raises a new one
  - offboarding: `<ref>@<offboarding_started_at>`, one per episode
  - unknown ref: `<ref>`
  - call: the capture id

  One behaviour change: an unknown ref used to re-flag on every new message after it was resolved. It now
  flags once, and the planner's `recover` brings it back. The first unknown-ref event may be personal mail,
  which is dropped before L1 (`webhook.ts:375`), so that row carries no capture id.
- **`technician_id` is null on all four.** Each is a manager's question, and the person named cannot settle
  it or has left. So `send` makes the planner name a manager in `to`.
- **Code closes them when the fact settles.** `confirm_mailbox` and deactivate close the pairing
  observation; reactivate and the offboarding expiry close the reminder. All four go through a new
  `dismissOpenObservationsForRef`, which dismisses with a reason; `recover` still works. The precedent is
  `retract_capture` (`captures.ts:986-1006`). Rejected: a planner moot fact, which means more
  `planner.ts` work and leaves a window where the planner re-asks about a settled pairing.
- **No dates and no caller words in the notes.** A note renders as the planner's `about:` line
  (`planner.ts:1534-1545`). The date rail (`planner.ts:2118`) drops any message echoing a date or a phrase
  like "2 days", and a retraction cannot reach a copied quote. So `call_action` cites its capture id, and
  `v_captures` hides retracted calls.
- **`confirm_mailbox` is keyed by ref**, because the manager names a person, not an item id. It lives in
  `roster.ts` beside `get_connect_link`. `reviews.ts` is deleted, and the manager surface goes from 42 tools
  to 41.
- **Left alone:**
  - `watchers.ts`'s legacy `overdue_visit_gap` reads (`:287-290`), harmless once the items are closed
  - the `ReviewKind` union, since these kinds live on as observation kinds
  - the table name; engineering-memory's rename idea stays deferred
- **Seat instructions:** rule 2 of the office-questions block in `bootstrap-box.sh` (`:1178-1181`) tells
  seats to read `agentContext` off queue items, which nothing has minted since build 6. It is replaced by
  the `confirm_mailbox` line that the reply-loop mitigation needs. Rolling it to live seats is an operator
  step, s2 first.

## Plain-language walkthrough

Today some "a manager should know about this" events go into a list that shows up only when a manager
asks, and nobody asks. This change sends each event to the planner (the background agent that decides who
to message) and removes the two chat tools that read the list.

```
BEFORE                                          AFTER
pairing ─────────┐                              pairing ──► review item (still the gate)
unknown mailbox ─┤                                      └─► observation ──┐
removal deadline ┼─► review_items ◄── manager   unknown mailbox ──► observation ──┤
phone call ──────┘   (the queue)      must ASK  removal deadline ─► observation ──┼─► planner ─► texts
                                                phone call ─► push + observation ─┘            a manager
staged tokens ──► review_items (unchanged)      manager's "right"/"wrong" ─► confirm_mailbox
```

**Phase 1: the four events reach the planner.** Four events each add a row to the planner's observations:
a Gmail connection, mail for someone not on the roster, a removal about to become permanent, or a call
asking to change or cancel something. You can see the row in `v_observations`, and the planner's next pass
picks it up.

**Phase 2: the new confirm tool arrives and the old tools go.** A manager's assistant gets
`confirm_mailbox`. "Right" switches the person on. "Wrong" disconnects that mailbox so a fresh link can
be sent. `list_pending_reviews` and `resolve_review` disappear from the manager's tools.

**Phase 3: cleanup.** The paging database function is dropped. A script closes the stale items on the
pilot but leaves the escalations open, and it announces anyone already waiting on a mailbox check. The
docs and the seat instructions stop mentioning the queue. The manager seats are restarted so they see
the new tool.

## Secrets & env preflight

- **Phases 1–2:** nothing beyond the local stack's `.env.test`, which `scripts/second-stack.sh` already
  generated here.
- **Phase 3, pilot steps (operator):** `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in a
  root `.env`. These are already required, but this worktree has no `.env`, so copy it from the main
  checkout. The Supabase MCP (`supabase-test`) is needed for `apply_migration`.

## Phase 1: The four events become observations

### What this phase does
- Adds the observation writers and one closer to the DB layer.
- Points pairing, the inbound webhook, the offboarding sweep and the calls worker at them.
- Switches the deactivate and reactivate closers, and tells the planner what the kinds mean.
- The queue tools still exist, so everything keeps working.

### Changes required

**`src/db/observations.ts`** – add after `createObservation`. Each helper wraps it with author `detector`
and `technicianId: null`, and returns `Promise<Observation | null>`:
```ts
raisePairingObservation({ tenantId, ref, displayName, connectedAccountId, email })
  // kind 'pairing_verification', subject `${ref}@${connectedAccountId}`, context { ref, email, connectedAccountId, note }
raiseOffboardingObservation({ tenantId, ref, displayName, startedAt })   // subject `${ref}@${startedAt}`, context { ref, startedAt, note }
raiseUnknownRefObservation({ tenantId, ref, captureId: string | null })  // subject ref, context { ref, captureId, note }
raiseCallActionObservation({ tenantId, captureId, intents, priority, callerPhone: string | null })  // subject captureId
export async function dismissOpenObservationsForRef(tenantId: string, kind: ReviewKind, ref: string,
  reason: string): Promise<number>  // open→dismissed (+reason, dismissed_at) WHERE tenant, kind, status open,
                                    // author 'detector', context->>'ref' = ref; returns rows changed
```
Notes are plain sentences, with no dates and no digit followed by a time unit. Every nullable value
gets its own wording, never the literal "null":
- **pairing:** "<name> connected the mailbox <email | 'a mailbox whose address could not be read'>. A
  manager has to say whether it is really theirs before they are fully switched on (confirm_mailbox,
  from a manager's assistant)."
- **offboarding:** "<name>'s removal from the team becomes permanent soon and cannot be undone after that.
  Until then a manager can undo it (reactivate_technician_seat)."
- **unknown ref:** "Mail arrived through a mailbox connection filed under '<ref>', and nobody on the team
  has that ref." Then either "It is kept on the record as capture <id>." or, when `captureId` is null,
  "It was personal mail, so it was not kept."
- **call:** "[Urgent: ]A phone call<' from <number>' | ''> asked to: <intents> (the call router's reading;
  nothing was changed). The managers got a one-line alert when it came in. Capture <id>; spine_read
  v_captures for the words."

**`src/composio/pairing.ts`**:
- Add `raiseObservation?: typeof raisePairingObservation` to `PairingDeps` (`:82-88`).
- Right after `openReviewItem` (`:213-218`), await it with `{ tenantId: tech.tenant_id, ref: tech.ref,
  displayName: tech.display_name, connectedAccountId: active.id, email }`. It is not advisory: a throw
  leaves the trigger unset, so the healing branch retries.
- The healing branch (`:126-138`) makes the same call with `tech.composio_connected_account_id` and
  `tech.connected_email` before `ensureTriggers`. The once-ever index makes it a no-op if the row exists.

**`src/composio/offboarding.ts`**:
- Deps: `flagReminder` becomes `raiseReminder?: typeof raiseOffboardingObservation`, and `resolveItemFor`
  becomes `dismissFor?: typeof dismissOpenObservationsForRef` (`:35-36`, `:90-91`).
- The expiry close (`:193-199`) becomes `dismissFor(row.tenant_id, 'offboarding_reminder', row.ref, 'the
  removal became permanent')`.
- The reminder (`:207-213`) becomes `raiseReminder({ tenantId: row.tenant_id, ref: row.ref, displayName:
  row.display_name, startedAt: row.offboarding_started_at })`. `if (item) result.reminded++` stays.

**`src/inbound/webhook.ts`**:
- The `flagReview` dep type becomes `typeof raiseUnknownRefObservation` (`:91`, `:164`).
- It has two call sites:
  - the personal-mail path (`:375`, no L1 row) becomes `flagReview({ tenantId, ref: technicianRef,
    captureId: null })`
  - the work path (`:507-511`) becomes `flagReview({ tenantId, ref: technicianRef, captureId:
    r.captureId })`, and its `!tech && r.status !== 'duplicate'` gate stays

**`src/calls/worker.ts`**:
- `WorkerDeps.openCallActionReview` becomes `raiseCallAction: typeof raiseCallActionObservation` (`:5`,
  `:44-51`, `:66`).
- Call it at `:176-183` with `{ tenantId, captureId: result.captureId, intents: reviewIntents, priority,
  callerPhone: row.caller_phone }`.
- `notifyManagers` (`:184-188`) is unchanged.
- Fix the comments at `:148-171`, and add one on the retry path. `captureHasLinkedL2` counts any
  observation on a capture as processed (`rawCaptures.ts:198-205`). So a retry after the raise reports
  `duplicate` and skips structuring, even if a re-classification would add `new_job`.
- `src/calls/notify.ts:6`: the durable record is the observation now, not a review item.

**`src/mcp/tools/captures.ts`** (`:994-996`): the retraction loop also dismisses `call_action`. Its
`subject_ref` is the capture id, so the planner is never shown a call recorded in error.

**`src/mcp/tools/roster.ts`**:
- Deactivate (`:572-579`), in the same advisory try: also `dismissOpenObservationsForRef(tenantId,
  'pairing_verification', ref, 'the person was deactivated')`.
- Reactivate (`:644-649`): the `offboarding_reminder` review-item close becomes
  `dismissOpenObservationsForRef(tenantId, 'offboarding_reminder', ref, 'reactivated during the grace
  period')`.

**`src/db/reviewItems.ts`**:
- Delete `flagUnknownRefCapture` (`:128-164`), `openCallActionReview` (`:208-237`) and
  `flagOffboardingReminder` (`:286-327`).
- In the kind comments (`:30-42`, `:199-206`), say these are observation kinds now.

**`src/teamLead/plannerPrompt.ts`**: after the paragraph ending "they will not recognise a message they
sent themselves." (`:244-249`), add: "THINGS ONLY A MANAGER CAN SETTLE. `pairing_verification`,
`offboarding_reminder`, `unknown_ref_capture` and `call_action` items are not questions for the person
they name. The item says what happened. Whether and when a manager hears about it is yours to judge."

**Tests:**
- `observations.test.ts`: each `raise*` writes its key and context, and a second call returns null. The
  dismiss helper closes only open detector rows of that kind and ref on that tenant, and returns the count.
- `pairing.test.ts`: the file runs on stubs and a fake tenant (`:30`, `:86-96`), and the raise is not
  advisory. So first add a recording `raiseObservation` stub to `pairingDeps`, or about 15 existing
  tests fail on the tenant foreign key. Then assert the claim raises one `<ref>@<accountId>` row and
  healing re-raises idempotently.
- `offboarding.test.ts`: `:207` moves to the dismiss call, and the reminder is raised once per episode.
- `webhook.test.ts`: the work path raises with the capture id, and a duplicate does not raise. The
  personal-mail test at `:553-566` now expects `{ ref, captureId: null }`.
- `server.test.ts`: retracting a call dismisses its `call_action` observation.
- `worker.test.ts` (`:97`): `raiseCallAction` gets the intents, and `notifyManagers` still fires.
- `server.test.ts` `:2485-2533`: raise a pairing observation and assert it is dismissed after deactivate.
  Replace the `offboarding_reminder` item with `raiseOffboardingObservation` and assert it is dismissed
  after reactivate.
- Delete `reviewItems.test.ts:32-70` and `technicians.test.ts:344-380`.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass, including the tests above
- [ ] `grep -rn "flagUnknownRefCapture\|openCallActionReview\|flagOffboardingReminder" src` is empty

### Live verification (agent-executable)
- Prerequisites: this worktree's local stack (`project_id` `TradesDatabase-retire-the-manager-4eec4e`).
- [ ] The codified tests read the results back from the database. The pilot has no pairing, removal or
  unknown mailbox that could be driven for real.

### Manual verification
- (none)

---

## Phase 2: confirm_mailbox in, the queue tools out

### What this phase does
Adds the verdict tool, deletes the two queue tools and their paging reader, and fixes every description,
test and eval case that named them.

### Changes required

**`src/mcp/tools/roster.ts`**: add to the admin list and handlers:
```ts
{ name: 'confirm_mailbox',
  description: "Say whether the mailbox a team member connected is really theirs (manager only). After " +
    "approving their connect link they wait for this — list_team shows them as pending_verification, " +
    "get_connect_link shows the address. right = switch them on; wrong = disconnect it so they can " +
    "connect the right one with a fresh get_connect_link.",
  inputSchema: { type: 'object', properties: { ref: { type: 'string' },
    verdict: { type: 'string', enum: ['right', 'wrong'] } }, required: ['ref', 'verdict'] } }
```
The handler imports `unpair as liveUnpair` from `../../composio/pairing.js` and works like this:
- Validate `verdict`, then call `getTechnician(tenantId, ref)`. A missing ref throws `technician '<ref>'
  not found`, which also covers another tenant's ref.
- **Not pending** (`state !== 'pending_verification'`): close any open `pairing_verification` item
  (`'resolved', 'no longer pending'`), dismiss the observation, and return `{ status: 'not_pending', ref,
  state }`. Nobody is resurrected or unpaired (the stale rule, `reviews.ts:230-250`).
- **right:** `casTechnician(target.id, 'pending_verification', { state: 'active' })`. A seat-cap error maps
  to `seatCapMessage(target.tier)`. A CAS miss throws "'<ref>' changed state — check list_team and retry".
- **wrong:** `(deps.unpair ?? liveUnpair)(target)`.
- **Then, for both:** `resolveOpenReviewItemFor(tenantId, 'pairing_verification', ref, right ? 'resolved'
  : 'dismissed', text)`, then `dismissOpenObservationsForRef(tenantId, 'pairing_verification', ref, text)`.
  The text is "mailbox confirmed by <identity.technicianRef>" or "wrong mailbox — disconnected".
- Return `{ status: 'confirmed' | 'disconnected', ref, email: target.connected_email }`.

Also in `roster.ts`:
- `get_connect_link`'s description (`:136`) ends "…a manager then confirms the connected address with
  confirm_mailbox".
- `awaiting.note` (`:725`) becomes "already connected — confirm or reject the mailbox with
  confirm_mailbox". The `link_created` note (`:750-751`) says the same instead of "you will then get a
  verification item".
- The add-seat note (`:436-441`) drops "or … dismiss the availability_setup review item with that note".
- **Deactivation expiry.** Both `pending_deactivation` upserts (`:477-482`, `:491-496`) add
  `stagedAt: new Date().toISOString()` to `detail`. After the token read at `:519-525`, an item older
  than 15 minutes is dismissed as 'confirmation expired' and the tool throws "confirmation expired —
  call again without confirmId to restart", exactly as `:381-383` does. A legacy row without
  `stagedAt` passes; the Phase 3 script retires those. Test it in `server.test.ts` next to the existing
  deactivate tests by backdating `detail.stagedAt` through `pg`.

**Elsewhere:**
- `src/mcp/tools/reviews.ts`: delete the file.
- `src/mcp/server.ts`:
  - Remove the import (`:55`), `...reviewsTools.admin` (`:282`) and `...reviewsTools.handlers` (`:521`).
  - The `v_review_items` catalog text (`:220-222`) becomes "the confirmation tokens people have staged
    and not yet confirmed, plus the retired manager queue's history".
- `src/teamLead/plannerPrompt.ts:458`: "and the manager's queue (v_review_items)" becomes "and
  v_review_items, the retired manager queue". The HISTORY sentence stays.
- `src/db/reviewItems.ts`: delete `ReviewQueueItem`, `ReviewQueuePage` and `getReviewQueuePage`
  (`:401-480`). Keep `listOpenReviewItems`, which `technicians.test.ts:314` uses.
- `src/mcp/tools/surface.expected.ts`: remove `'list_pending_reviews'` (`:58`) and `'resolve_review'`
  (`:66`), and add `'confirm_mailbox'` in sorted position.
- `src/eval/toolCases.ts`: delete R10 (`:310-319`). F02 (`:1275-1284`) becomes `confirm_mailbox`
  `{ ref: 'nobody-by-this-ref', verdict: 'right' }`, passing on an error or `/not found/i`.

**`src/mcp/server.test.ts`**:
- **Delete:** `reviewsAll` (`:198-213`), the tests at `:855` and `:2115`, and the describe at `:10045`.
- **`:971`:**
  - Swap `confirm_mailbox` into the denied and listed arrays (`:981-982`, `:1000-1001`).
  - In the Reviews block (`:1119-1225`), drop the list, briefing, generic-resolve and
    pending_deactivation resolve/cancel parts.
  - Keep the cross-tenant probe, re-pointed: the other tenant's manager calls `confirm_mailbox({ ref:
    'mgr-test', verdict: 'right' })` and expects `not found`.
- **`:2149`:** rename to "…; confirm_mailbox verdicts" and drive `:2225-2275` through it. Keep the same
  three cases: right → active; wrong → unpair seam; stale on offboarding → no move and no unpair. Add
  read-backs that the item closed and the raised observation is dismissed.
- **Trims:** in `:2734`, drop `:2878-2898`. In `:4040`, keep "re-stage supersedes", drop the
  resolve/cancel half and rename. In `:4662`, drop `:4744-4770`. At `:4968`, fix the comment.
- **`:5795`:** read `availability_setup` with `pg` instead of `reviewsAll`, drop the "not known yet"
  dismiss step, and rename.
- **`:7619`:** `list_pending_reviews` becomes `confirm_mailbox`.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass. `expectSurface` fails by name if the tool list
  is wrong, and the `toolCases.test.ts` coverage gate needs `confirm_mailbox` covered.
- [ ] `grep -rn "list_pending_reviews\|resolve_review\|getReviewQueuePage" src` finds only historical
  comments

### Live verification (agent-executable)
- Prerequisites: the local stack.
- [ ] `server.test.ts`'s MCP round-trips cover this: listing, dispatch and database read-back. The pilot
  check is the first real pairing after deploy (Phase 3).

### Manual verification
- (none)

---

## Phase 3: Drop the page function, clean the pilot, docs

### Changes required

**`supabase/migrations/20260919120000_drop_review_queue_page.sql`**:
- Header: apply it only after the web service runs this code, because the running service calls the
  function until then.
- Body: `drop function if exists review_queue_page(uuid, text, timestamptz, uuid, int, int);`

**`src/db/database.types.ts`**:
- After applying the migration locally, run `npm run gen:types:local`. Never run `gen:types`; it is
  linked to the pilot.
- The diff must only remove `review_queue_page` (`:3869`). If it shows anything else, hand-delete that
  block instead.
- Delete **`src/db/reviewQueue.test.ts`**.

**`scripts/retire-review-queue.mjs`**:
- The header, flags (`--local`/`--hosted`, `--dry-run`) and two-URL target check mirror
  `scripts/backfill-schedule.mjs`. It imports from `dist/`, so build first.
- It works only on open items of these kinds: `sheet_ref_mismatch`, `unknown_ref_capture`,
  `offboarding_reminder`, `unlinked_call`, `call_action`, `overdue_visit_gap`, `job_cost_gap`.
- It carries over first:
  - an `offboarding_reminder` whose person is still `offboarding` gets `raiseOffboardingObservation`
  - an `unknown_ref_capture` gets `raiseUnknownRefObservation`, using the newest `raw_captures` id for
    that ref, else `null`
  - an open `pairing_verification` whose person is still `pending_verification` gets
    `raisePairingObservation`, keyed `ref@composio_connected_account_id`. Without this, someone
    already waiting at deploy is never announced: `checkPairing` is a no-op for them, and healing
    needs a null trigger id. The item itself stays open.
- It skips any item with `escalated_from_nudge` set (see Decisions) and dismisses the rest with the
  resolution "review queue retired 2026-09-19; see
  thoughts/shared/plans/2026-09-19-retire-the-manager-review-queue.md".
- It also dismisses open `pending_deactivation` rows with no `detail.stagedAt`, because those can
  never expire.
- It prints counts by kind for carried, skipped and dismissed in both modes. It never touches any
  other token, `pairing_verification` or `availability_setup`.

**Docs:**
- `docs/nemoclaw-tech-agent.md:150-151,293,564`, `docs/control-plane.md:10,18` and
  `docs/doorman-runbook.md:384`: drop or rename the queue tools.
- `docs/customer-onboarding-runbook.md:180-181`: step 4 becomes "the planner texts a manager the address;
  they answer; their assistant calls `confirm_mailbox`".
- `Box_Setup_Stuff/doorman-architecture-memory.md:373` and `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:24`:
  the manager surface is 41, and neither queue tool is named.
- `Box_Setup_Stuff/bootstrap-box.sh`: replace rule 2 (`:1178-1181`) with "A manager's yes or no about a
  mailbox somebody connected means calling confirm_mailbox (where you have it). The person is the one
  list_team shows as pending_verification."
- `docs/engineering-memory.md` (`:5518-5524`): record that the queue is retired (this plan). Add a short
  entry covering the kept push, the four observation keys, "no cancel tool, because tokens expire (and
  `pending_deactivation` now does too)", and the reply-loop risk.

### Automated verification
- [ ] Grep `project_id` first, then run `npx supabase migration up --include-all` on the local stack
- [ ] `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass
- [ ] `node -r dotenv/config scripts/retire-review-queue.mjs --local --dry-run` prints counts and writes
  nothing; `--local` dismisses the seeded items; a re-run reports 0
- [ ] `npm run decisions:index` after the doc edits, then commit the regenerated files

### Live verification (agent-executable)
Rollout after merge, in this order:
- [ ] The operator deploys the web service by hand; it does not auto-deploy. Read the lifecycle cron's
  `autoDeploy` from the Render API, and deploy it too, because it runs the pairing and offboarding sweeps.
- [ ] `tools/list` for a manager badge on the pilot shows `confirm_mailbox` and neither queue tool.
  That only proves the SERVER, because each gateway caches its tool list (engineering-memory `:1552`,
  `:3821`).
- [ ] The operator restarts every manager seat's gateway (`nemoclaw <seat> gateway restart`, s2
  first). Proof is behavioural, never `status`: message the manager bot to confirm a ref that is not
  pending. It must answer from `confirm_mailbox` (`not_pending`), not say the tool is missing.
- [ ] The operator applies the drop (Supabase MCP `apply_migration`, then `notify pgrst, 'reload
  schema'`). Read back: no `review_queue_page` in `pg_proc`.
- [ ] The operator runs the cleanup with `!` from the worktree root: `--hosted --dry-run`, then
  `--hosted`. Read back: open `review_items` hold only token kinds, `pairing_verification`,
  `availability_setup` and the skipped escalations. Every pending person has a `pairing_verification`
  observation.

### Manual verification
- [ ] The next real Gmail pairing on the pilot: the planner texts a manager, the manager answers, the seat
  calls `confirm_mailbox`, and the person goes active. This needs a human at Google's consent screen.
- [ ] The operator refreshes the office-questions block on the live seats (s2 first), then md5s each box's
  `bootstrap-box.sh` against the repo.
