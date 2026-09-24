---
date: 2026-09-23
task: Step 3 — office messages, nudges and pushes reach glue seats with zero seat model calls; the office reads seat conversations instead of asking them
research: thoughts/shared/research/2026-09-23-step-3-office-messages-and-nudges-reach-glue-seats.md
status: complete
supersedes: nothing
---

## Overview

Since the step 1 cutover, every office item for a glue seat (s5 today, any `g_` seat) fails,
because the box's bash runners deliver by `nemoclaw <ref> exec` into a container that no longer
runs. This plan makes the **seat glue** pull its own person's items with its seat token. Phone
items (nudges, `via='chat'` office rows, person pushes) go to Telegram word for word. Notes
(`via='assistant'` office rows) are never run as a model turn. Both are **attached to the
person's next message**. The glue also **uploads each conversation live**, and the office gets a
tool to **search it**, so it reads what an assistant knows instead of asking. The bash runners
stop taking items for a glue seat while that glue is pulling. The pull also carries **"your
seat changed"**.

## Decisions

- **No quiet model turn** (operator). Office traffic makes zero model calls on a glue seat. The
  rejected alternative was a silent turn per note (openclaw parity): SDK 1.0.14 has no documented
  add-without-a-turn (research, Open Question 1).
- **The office reads, never asks** (operator). The reading piece is IN step 3, because it must
  land before step 5 deletes office-runner. It also serves as step 5's planned nightly session backup.
- **Upload = words + tool calls** (operator): person text, assistant replies, and spine tool name
  + arguments + ok/failed. Tool **results are not uploaded**, since they're record data the office
  already reads, and they're the bulk.
- **Readers** (operator): the planner, and the office door when a **manager** faces it
  (`MANAGER_FACING_TOOLS`). **Never** the technician-facing door (`TECHNICIAN_FACING_TOOLS`
  unchanged).
- **Disclosure** (operator): a one-time notice from each glue seat, plus an honest-if-asked line in
  the seat preamble. Copy (no em dashes, names AI): *"Heads up from your AI assistant: the office
  can read our chats here, and your managers can ask it about them."*
- **Retention 90 days** (operator): a lifecycle prune, the `lifecycle_runs` idiom, env-overridable.
- **Seat-token routes, not the host pull** (implementation). `/seat/inbox` serves ONE technician's
  rows, so the host token (which can act for every seat on the box) never enters a glue env.
  Rejected: the glue filtering a host pull, because Render counts a serve on every item it returns
  (research, Constraint 2).
- **Runners skip a glue seat by LIVENESS, not by the `seats` row** (implementation). Each
  `/seat/inbox` GET stamps `seats.last_pulled_at`. The host pulls exclude technicians whose seat
  pulled in the last **120 s**. After `rollback.sh` stops the glue, the stamp ages out and openclaw
  gets the items back with no step. The rejected alternative, excluding by row, sends a
  rolled-back seat's items to a stopped glue (research, DP 2). Box scripts are unchanged.
- **Pull every 10 s** (implementation): the nudge timer's cadence. It's one cheap GET per seat.
  Long-polling is left for later.
- **Dedupe = a sent-id list in `state.json`** (implementation). This is the runners' marker rule:
  an id already handled is re-acked and never re-sent or re-attached. The list keeps the last 500
  ids.
- **Ack timing** (implementation): a phone item is acked after Telegram accepts it. A note is acked
  once it's saved to the pending list (`state.json` written). Both are then attached to the next
  message.
- **Pending list caps** (implementation): the 30 newest items, and each item's text cut at 1,000
  chars. An overflow is logged. It's a hole only if a seat sits silent through 30+ office items.
- **Phone text formatting** (implementation): it's sent through `TelegramClient.send`, which applies
  the same Markdown-to-HTML conversion as the assistant's own replies. The planner writes these "in
  their own assistant's voice". The openclaw byte-identity is not re-proven (research, Open
  Question 2).
- **Seat changed** (implementation). `/seat/inbox` returns the whoami fields.
  - **Telegram id or timezone differs:** the glue shuts down cleanly with exit 0, and
    `Restart=always` brings it back through whoami.
  - **403 (deactivated) or a null Telegram id (unbound):** it exits **4**, and the unit gains
    `RestartPreventExitStatus=3 4`, so it stays down, with no 10 s restart loop.
  - **401 is a NORMAL restart (exit 1), never 4** (review 5). `install.sh` mints a new token,
    which revokes the old one, before it restarts the unit. A running glue that polls in that
    window must come back on the new env file, not stay down.
- **Known gap (accepted):** a long phone item is split into chunks by `TelegramClient.send`. If a
  later chunk fails, the item is reported `failed` and re-served, so the earlier chunks arrive
  twice. That is the runners' behaviour today.
- **Ben's frozen backlog is left alone** (implementation). The rows are test items, and the
  planner ends them (broken-pipe doctrine).
- **Conversation table is operational, not L1** (implementation). It's deletable and has deny-all
  RLS. Turn ids are minted by the glue, so a re-upload is a no-op (`on conflict do nothing`).

## Plain-language walkthrough

**Phase 1 (Render: a mailbox per seat).** Render gets a new door, `/seat/inbox`, that a glue
seat opens with its own key. It hands over only that person's waiting items and takes back "done"
reports. Each visit stamps the seat as live. While a seat is live, the old box scripts' mailbox
skips its items, so nothing is delivered twice. If the glue stops, the old scripts take over
after two minutes.

**Phase 2 (the glue: deliver and remember).** Every 10 seconds the glue checks its mailbox. A text
for the person goes straight to their phone. A note for the assistant goes on a small waiting list.
The next time the person writes, the glue puts the waiting items above their message: *"Since you
last spoke: you texted them '…'; the office noted '…'"*. The model sees everything at the moment
it matters, with no extra model call. The glue also sends its one-time "the office can read our
chats" notice, and restarts or stops itself if Render says the seat changed.

```
Render ──/seat/inbox──► glue ──phone item──► Telegram (Ben's phone)
                          └──every item──► waiting list ──► on top of Ben's next message ──► model
```

**Phase 3 (the glue uploads its conversation).** After each reply, the glue sends the new turns
to Render: what Ben said, what the assistant said, and which tools it used with what inputs. They
go into a new table that deletes anything older than 90 days.

**Phase 4 (the office can read it).** The office gets `read_conversation`: name a person, add
some words or leave them out, and get back short snippets, newest first. The planner's
instructions say to read, not ask. A manager asking the office "what did Ben say about the
freezer?" can be answered from the snippets.

**Phase 5 (roll out and prove it).** Apply the migrations, deploy Render, and install on s5. Then
drive the gate: a planner question reaches Ben's phone, his answer lands on the record, and the
office finds his words with `read_conversation`.

## Secrets & env preflight

- **Phases 1–4:** none new. The local stack's `.env.test` is already written for this worktree.
- **Phase 3:** `SEAT_TURN_RETENTION_DAYS` is optional (default 90) and needs no value.
- **Phase 5:** Supabase test MCP (`apply_migration`), Render MCP (workspace
  `tea-d69903h5pdvs738dm81g`, web service deploy: autoDeploy is OFF), `ssh tradesbox` + the
  operator's sudo for `install.sh s5`. All are already connected or held.

## Phase 1: Render — the seat inbox and runner exclusion

### Changes required

**`supabase/migrations/20260924120000_seat_inbox.sql`** (new): `alter table seats add column
last_pulled_at timestamptz;` plus `create index seats_host_pulled_idx on seats (host_id,
last_pulled_at) where retired_at is null;`. Then run `npm run gen:types:local` (NOT `gen:types`,
which points at the pilot).

**`src/db/nudges.ts`**
- Export `interface QueueScope { onlyTechnicianId?: string; skipTechnicianIds?: string[] }`.
- `listQueuedNudgesForHost(hostId, scope: QueueScope = {})` (:200): when `onlyTechnicianId`, add
  `.eq('technician_id', id)`; when `skipTechnicianIds.length`, add `.not('technician_id', 'in',
  \`(${ids.join(',')})\`)`. The ids come from the DB, so they're uuids and nothing typed.

**`src/db/officeMessages.ts`**: `listQueuedOfficeMessagesForHost(hostId, via, scope = {})`
(:271). Same two filters, inside the paging loop.
**`src/db/personPushes.ts`**: `listQueuedPersonPushesForHost(hostId, scope = {})` (:64). Same.
**`src/db/seats.ts`**: `touchSeatPull(seatId): Promise<void>` and
`listLiveGlueTechnicianIds(hostId, sinceIso): Promise<string[]>` (live seats on the host with
`last_pulled_at >= sinceIso`). A missing column (42703/PGRST204) returns `[]`, so Render can
deploy before the migration without breaking the runners (the `listLiveSeatBotIds` idiom, :179).
**`src/db/index.ts`**: re-export the new names.

**`src/control/nudgeQueue.ts`**
- `buildNudgeDelivery(hostId, deps = {}, scope: QueueScope = {})` (:110). Pass `scope` to all
  three list calls (:117, :234, :287).
- `completeNudgeDelivery(hostId, id, report, detail, deps = {}, scope = {})` (:334). After each
  point-read (push :363, chat :380, nudge :346, group survivors :415), if `scope.onlyTechnicianId`
  and the row's `technician_id` differs → return `'ignored'`. A seat can never settle another
  seat's row on the same host.

**`src/control/officeQueue.ts`**: the same `scope` param on `buildOfficeDelivery` (:88) and
`completeOfficeDelivery` (:158), with the same technician check after the point-read (:169).

**`src/mcp/httpServer.ts`**
- `handleNudgePull` (:392) and `handleOfficePull` (:472): compute `skip = await
  listLiveGlueTechnicianIds(host.id, new Date(Date.now() - 120_000).toISOString())` and pass
  `{ skipTechnicianIds: skip }`.
- A new helper `seatOfRequest(req)`: `seatTokenOf` → `getSeatIdentityByTokenHash(sha256hex(t))`
  → `{ seat, person }` via `getTechnicianById(seat.technician_id, seat.tenant_id)`. It returns
  401 (no or unknown token), 403 (inactive or missing person), or 500 (DB), the whoami posture
  (:341-378).
- `GET /seat/inbox` → `handleSeatInboxPull`: `touchSeatPull(seat.id)`, then
  `buildNudgeDelivery(seat.host_id, {}, { onlyTechnicianId: seat.technician_id })` and
  `buildOfficeDelivery(...)` with the same scope. Response:
  `{ seat: { telegramUserId, timezone }, items: [{ id, leg: 'phone' | 'note', text }] }`. Phone
  text is the decoded `directMessageB64`; note text is the `wrapOfficeMessage` output. Phone items
  come first, then notes, each in queue order.
- `POST /seat/inbox` → `handleSeatInboxReport`: body `{ id, leg, outcome, detail? }`, with the
  16 KiB cap and uuid check copied from `handleNudgeReport` (:416-466). `leg` `'phone'` →
  `completeNudgeDelivery(seat.host_id, id, outcome, detail, {}, scope)`; `'note'` →
  `completeOfficeDelivery(...)`. Returns `{ result }`.
- Route both next to `/seat/whoami` (:985), before `allowed()`.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass
- [x] `src/control/nudgeQueue.test.ts` / `officeQueue.test.ts`: scope reaches every list call, and
      a report for another technician's row returns `'ignored'` on all four paths
- [x] `src/db/seats.test.ts` (local stack): `listLiveGlueTechnicianIds` includes a seat stamped 30
      s ago, excludes 5 minutes ago, excludes retired, and scopes by host. `src/db/nudges.test.ts`:
      the scoped and skipped lists return the right rows
- [x] `src/mcp/httpServer.test.ts`:
  - `/seat/inbox` returns 401 with no token and 403 for an inactive person.
  - It returns only the seat's own phone and note items, and stamps `last_pulled_at`.
  - A host `/control/nudges` pull made right after that excludes those items.
  - A POST with another seat's id returns `ignored`.

## Phase 2: The glue — inbox poller, remember-and-attach, seat changed, disclosure

### Changes required

**`src/seatGlue/inbox.ts`** (new, self-contained): `interface InboxItem { id: string; leg:
'phone'|'note'; text: string }`; `fetchInbox(spineUrl, token, fetchFn)` →
`{ seat: { telegramUserId: string; timezone: string }, items }`, which validates shapes like
`whoami.ts` and throws `InboxRefused(status)` on 401/403; `reportInbox(spineUrl, token, id, leg,
outcome, detail?)`.

**`src/seatGlue/state.ts`**: `SeatState` gains `pending: PendingItem[]` (`{ id, leg, text, at }`),
`handledIds: string[]` (at most 500, oldest dropped) and `disclosed: boolean`. `readState`
defaults all three for an old file. `writeState`'s tmp name becomes unique per write
(`${FILE}.${pid}.${randomUUID()}.tmp`), because the poller and the update loop now both write
(review 4).

**`src/seatGlue/seat.ts`**
- `SeatDeps` gains `inbox?: { fetch(): Promise<InboxResult>; report(id, leg, outcome, detail?):
  Promise<void> }`, `pollInboxMs?: number` (default 10 000), `onSeatChanged?: (code: 0 | 4) =>
  void`, and `who: { telegramUserId: number; tz: string }`.
- **Every state write goes through one chain** in `Seat`: `private persist(patch)`, which merges
  into `this.state` and chains `writeState` on a single promise. `handleUpdate` (:141-142) and
  `attach` (:328-331) switch to it too, so two writers never interleave a stale state (review 4).
- **Sends whose failure matters bypass `say()`**, which swallows errors (:444-448). A private
  `sendOrThrow(text)` chains `telegram.send` on `this.outbox` for ordering, but the returned
  promise rejects on a failure. The outbox itself still continues (review 6).
- `start()` (:96): if `!state.disclosed`, `sendOrThrow(DISCLOSURE)`, then persist
  `disclosed: true`. On a throw, log it and retry at the next start. Then start an unref'd interval, `pollInbox()`, when `deps.inbox` is set.
  `stop()` clears it.
- `pollInbox()`, re-entrancy guarded (one pull in flight):
  - fetch.
  - On `InboxRefused(403)` → `onSeatChanged(4)`; on `InboxRefused(401)` → `onSeatChanged(1)`.
  - If `seat.telegramUserId` is null → `onSeatChanged(4)`.
  - If `seat.telegramUserId !== String(who.telegramUserId)` or `seat.timezone !== who.tz` →
    `onSeatChanged(0)`.
  - Per item:
    - If the id is in `handledIds` → report `delivered` and continue.
    - If `phone`: `await this.sendOrThrow(text)`. On a throw, report `failed` with detail
      `"telegram send failed"` and continue.
    - Then `persist` it into `pending` (cap 30, text cut at 1 000) and `handledIds`, and report
      `delivered`.
  - A network error on fetch or report is logged, with a retry next tick.
- `deliver(prompt, attachments)` (:207): wrap at the `session.send` call only (:240), as
  `prompt: this.withPending(prompt)`. The abort-then-send recursion (:229) keeps passing the RAW
  `prompt`, so the block is never doubled. After `session.send` resolves, clear the carried ids
  from `pending` via `persist`. On a send failure `pending` stays. `withPending` renders:
  ```
  [Since your person last wrote — for you, not from them]
  - You texted them (<HH:MM firm-local>): "<text>"
  - <note text as wrapped by the office>
  [Their message]
  <prompt>
  ```
  The time is computed with `Intl.DateTimeFormat(…, { timeZone: who.tz })`: firm-local, never UTC.
- `TEXT` gains `DISCLOSURE` (the Decisions copy).

**`src/seatGlue/doctrine.ts`**: `SEAT_PREAMBLE` gains a paragraph.
- Office texts and notes arrive in a "[Since your person last wrote …]" block on top of their
  message. Texts there were already sent to them in your voice, so treat them as your own earlier
  messages. Notes are for you only.
- The office rules below still apply: an OFFICE QUESTION is answered with `inform_team_lead`.
- "The office can read your conversations with your person, including which tools you use. If
  they ask, say so plainly."
- Ported blocks are untouched. `doctrine.test.ts` stays green.

**`src/seatGlue/main.ts`**
- `seatDeps(cfg, who, client, telegram, policy, opts: { office?: boolean; onSeatChanged?:
  (code: number) => void } = {})` (:50). It wires `inbox` (`fetchInbox`/`reportInbox` with
  `cfg.spineUrl`, `cfg.seatToken`), `who` and `onSeatChanged` only when `opts.office !== false`.
  Phase 3's `transcript` wiring follows the same rule.
- `main()` passes `{ onSeatChanged: (c) => void shutdown(c) }`. `shutdown` is declared at :107,
  so move the `seatDeps` call below it, or use a holder the closure fills in.
- Export `EXIT_SEAT_GONE = 4`.
- `SeatDeps.who` stays OPTIONAL (the inbox is skipped without it), so the `seat.test.ts:93`
  fixture keeps compiling.

**`src/seatGlue/drive.ts:129`**: call `seatDeps(..., { office: false })`. A driven run uses the
real seat token against a scripted Telegram. It must never drain the person's real inbox, send the
disclosure to a fake, or upload scripted turns as their conversation (review 3).
**`Box_Setup_Stuff/seat-glue/seat-glue@.service`**: `RestartPreventExitStatus=3 4`, plus a comment
line for 4. **`cutover.sh:28-31`**: replace the KNOWN GAP comment with one line naming step 3.

### Automated verification
- [x] typecheck / lint / test; `selfContained.test.ts` stays green (inbox.ts imports only siblings)
- [x] `src/seatGlue/inbox.test.ts`: parses a good body; throws on a bad shape; 401/403 → `InboxRefused`
- [x] `src/seatGlue/seat.test.ts` (fake Telegram + engine + inbox):
  - A phone item is sent once and reported `delivered`. A second serve of the same id is
    re-acked, not re-sent.
  - A note is never sent to Telegram and never triggers `session.send`.
  - The next text reaches the engine with both items on top, and `pending` is empty after.
  - A failed Telegram send → `failed` report and no pending entry.
  - The disclosure is sent once across two `start()`s.
  - A tz or Telegram mismatch → `onSeatChanged(0)`; a 403 or a null Telegram id →
    `onSeatChanged(4)`; a 401 → `onSeatChanged(1)`.
  - Items stay pending when `session.send` throws.
  - Abort-then-send: the second text reaches the engine with the "[Since …]" block exactly
    once.
  - The disclosure is NOT marked sent when Telegram rejects it.
  - A poll that lands while an update is mid-flight leaves both the offset and `pending` in
    `state.json`, with neither write lost.
- [x] `drive.test.ts` (or a `main.ts` unit test): `seatDeps(..., { office: false })` has no
      `inbox` or `transcript`
- [x] `src/seatGlue/state.test.ts`: an old-shape `state.json` reads with the three defaults

## Phase 3: Conversation upload and the 90-day prune

### Changes required

**`supabase/migrations/20260924130000_seat_turns.sql`** (new): table `seat_turns`.
- Columns: `id uuid primary key` (glue-minted), `tenant_id uuid not null references tenants on
  delete cascade`, `technician_id uuid not null references technicians on delete cascade`,
  `seat_id uuid not null references seats on delete cascade`, `session_id text not null`, `at
  timestamptz not null`, `role text not null check (role in ('person','assistant','tool'))`,
  `text text check (char_length(text) <= 8000)`, `tool text`, `args jsonb`, `ok boolean`,
  `created_at timestamptz default now()`.
- Index `(tenant_id, technician_id, at desc)`.
- RLS on; revoke from anon and authenticated (the seats migration idiom). The header says it's
  operational, not L1, deletable, and pruned at 90 days. Regenerate types locally.

**`src/db/seatTurns.ts`** (new):
- `insertSeatTurns(rows)`: an upsert with `ignoreDuplicates: true`.
- `searchSeatTurns({ tenantId, technicianId, query?, days, limit })`: `ilike('text', %q%)` with
  `%`/`_`/`\` escaped when a query is given, or also matching `tool`. Newest first, limit ≤ 40.
- `pruneSeatTurns(beforeIso)`: `count: 'exact'`, the `pruneLifecycleRuns` idiom
  (`lifecycleRuns.ts:76-84`).
- Export from `src/db/index.ts`.

**`src/mcp/httpServer.ts`**: `POST /seat/conversation` via `seatOfRequest`, routed next to
`/seat/inbox`, BEFORE `allowed()` (:1104), because box egress IPs rotate (review 10). It takes a
256 KiB body cap. Body `{ turns: [{ id, sessionId, at, role, text?, tool?, args?, ok? }] }`, at most 200 turns.
It validates each turn: uuid id, ISO `at`, known role, text ≤ 8000 (cut, not refused, the office
body idiom), and args stored only when JSON ≤ 4000 chars (else `{ truncated: true }`). Tenant,
technician and seat come from the TOKEN, never the body. Returns `{ stored }`.

**`src/seatGlue/transcript.ts`** (new, self-contained): `class Transcript` with the three events
below, plus `flush()`. `flush()` POSTs the unsent turns and drops them on 2xx. The unsent queue is
persisted to `<stateDir>/transcript-outbox.json`, capped at 2,000 turns (oldest dropped, logged).
- `person(text, sessionId)`: the person's own words only, never the "[Since …]" block.
- `assistant(text, sessionId)`
- `toolStart(callId, name, args)` / `toolDone(callId, ok)`

**`src/seatGlue/seat.ts`**
- `handle()` (:162), not `deliver`, records the person's words. That's the text, the
  `[voice note] …` form, or `(photo)` / the caption, never bytes. Recording in `deliver` would
  double it on the abort-then-send recursion (review 7).
- `releaseHeldText` records each sent text.
- `onEvent`: `tool.execution_start` records `toolStart(data.toolCallId, data.mcpToolName ??
  data.toolName, data.arguments)` only when `SPINE_NAMES.has(data.mcpServerName)`. That's
  `engine.ts:63`, and `SPINE_NAMES` holds SERVER names, so the filter is on `mcpServerName`,
  never the tool name (review 8). Both fields are in 1.0.14's `ToolExecutionStartData`.
  `tool.execution_complete` records `toolDone(id, data.success)`.
- The transcript outbox file uses the same unique-tmp write and a single write chain. `session.idle` → `void
  transcript.flush()`.
- The poll interval also retries `flush()`.
- `SeatDeps.transcript?`, wired in `main.ts` with `cfg.spineUrl`/`cfg.seatToken`.

**`src/jobs/lifecycle.ts`**: a `seatTurns` prune in the heavy block, right after the
`lifecycleRuns` prune (:448-470), with its own `LifecycleSummary.seatTurns` field (never
renumbered).
- `let seatTurns = OFF_CADENCE`, added to the returned summary (:655-666).
- The default is 90 days, and `SEAT_TURN_RETENTION_DAYS` overrides it.
- `pruneSeatTurns` throws with `{ cause: error }` so the missing-table check reads it as skipped.
- `LifecycleDeps.pruneSeatTurns?`.
- **`src/jobs/lifecycle.test.ts:73-79`: add `pruneSeatTurns: async () => 0` to `COST_STUBS`**, or
  every lifecycle test runs a real DELETE (review 9).

### Automated verification
- [x] typecheck / lint / test / `npm run build`
- [x] `src/db/seatTurns.test.ts` (local): insert is idempotent on id; search is scoped to
      tenant + technician, honours days, matches a tool name, and escapes `%`; prune counts
- [x] `httpServer.test.ts`: `/seat/conversation` stores under the token's technician even when
      the body names another; 401 without a token; 413 over the cap
- [x] `src/seatGlue/transcript.test.ts`: flush drops on 2xx and keeps on 5xx; the outbox survives
      a new instance; the cap drops the oldest
- [x] `seat.test.ts`: a reply with one spine tool call yields person → tool(ok) → assistant turns,
      and no "[Since …]" text is recorded as the person's
- [x] `src/jobs/lifecycle.test.ts`: the prune runs with a 90-day cutoff and `skipped` on a missing table

## Phase 4: The office reads conversations

### Changes required

**`src/mcp/tools/seatConversation.ts`** (new domain module; `DomainTools` in `types.ts:63`):
`teamLead: [READ_CONVERSATION]` and a `read_conversation` handler.
- Args: `person` (a roster ref, exactly as THE TEAM prints it), `query?`, `days?` (default 7,
  max 90: a count, so the model never writes a date), and `limit?` (default 20, max 40).
- It resolves `person` with `getTechnician(tenantId, ref)`; unknown → throw with the valid-ref
  hint.
- It returns `{ status, person, turns: [{ at, role, snippet ≤ 300 chars, tool?, ok? }] }`.
- `note` when empty: "Nothing in the last N days. They may be on an assistant that does not
  upload yet (only the new seats do), or simply have not talked about it."
- The description says it's what their assistant saw and said: evidence, quotable only as "they
  told their assistant …"; the record stays the source of truth.

**`src/mcp/server.ts`**: import it; append `...seatConversationTools.teamLead` LAST in
`TEAM_LEAD_TOOLS` (:439-441). The order is cached, and appending keeps the prefix stable. Add the
handlers to the handler spread (:572-579).
**`src/teamLead/identity.ts`**: add `'read_conversation'` to `TEAM_LEAD_TOOL_NAMES` (:53).
**Pinned tool lists, appended last in each** (review 2):
- `src/mcp/server.test.ts:7909-7918`
- `src/eval/toolCases.test.ts:83-91`
- `src/mcp/tools/surface.expected.ts:84-92`. This one is documentation only: nothing imports
  `TEAM_LEAD_TOOLS_EXPECTED`, so it verifies nothing.

**`src/teamLead/plannerPrompt.test.ts:21-29`** pins the prompt's sha256, allowing only the ACCESS
paragraph to differ (review 1). Add each new or changed sentence below as a `NEW_…`/`OLD_…` pair
to that test's restore step (the `NEW_ACCESS_HEAD` idiom), so the pin still proves nothing ELSE
moved. Never re-baseline the hash.
**`src/teamLead/office.ts`**: add to `MANAGER_FACING_TOOLS` (:93) only.

**`src/teamLead/plannerPrompt.ts`**
- In the `as` explanation (:109-112 and the schema text :629-634), add: "an assistant note is
  read when that person next writes to their assistant, so it may wait hours."
- Add one line where assistants are discussed: "To learn what someone's assistant knows or was
  told, read it with `read_conversation`; do not send their assistant a question."
- Doctrine says what, not how: no worked examples.

**`src/teamLead/officePrompt.ts`**: one line in the manager-facing section. A manager may be told
what a technician said to their assistant, from `read_conversation`, in the office's own words.

### Automated verification
- [x] typecheck / lint / test
- [x] `server.test.ts`: the surface pins pass with the new name. A technician badge and a
      manager badge calling `read_conversation` are refused (the `spine:`-only gate, :666).
      The team-lead identity reads only its own tenant's rows.
- [x] `src/teamLead/office.test.ts`: `officeToolsFor({kind:'manager'})` includes it;
      `{kind:'technician'}` does not
- [x] the identity/schema pairing test in `src/mcp/server.test.ts` (near :7846, which pins
      `TEAM_LEAD_TOOL_NAMES` ⇄ `TEAM_LEAD_TOOLS`) passes

## Phase 5: Roll out on s5 and drive the gate

1. Apply both migrations to the pilot with the Supabase test MCP `apply_migration`, then `notify
   pgrst, 'reload schema'`. They're additive, and the code tolerates their absence either way.
2. Merge the PR and deploy the web service via the Render MCP. `/health` `commit` = the merge
   commit, and `/control/nudges` still answers the box (runner journal shows no 5xx).
3. Run `stage.sh`, `scp`, then the operator runs `sudo bash /tmp/seat-glue-stage/install.sh s5`. It
   re-mints the token, installs the unit with `RestartPreventExitStatus=3 4`, and restarts. The
   journal shows the inbox poll, and Ben's phone gets the disclosure once.

### Live verification (agent-executable)
- Prerequisites: Supabase test MCP, Render MCP, `ssh tradesbox` (read-only journal).
- [x] `seats.last_pulled_at` for s5 advances every ~10 s. `office-runner` and `nudge-runner`
      journals show no new s5 failures.
- [ ] (not run live — same phone leg as the chat item below; covered by unit + integration tests) Insert a `person_pushes` row for Ben via the push path, i.e. a board move on the pilot,
      driven. It reaches `delivered` within 20 s.
- [x] A driven planner `send` `as:"chat"` + `as:"assistant"` to Ben: both rows `delivered`, with
      zero seat model calls in the glue's cost log for that window.

### Manual verification
- [x] **The gate, on the phone:** (PASSED 2026-09-24 16:30 UTC — note a23ea11b on visit b7c8b837, nudge answered_by set)
  - A planner question arrives on Ben's Telegram. The operator answers it.
  - `record_field_note` lands on the named job and the nudge gets `answered_by_capture_id`. The
    seat's reply shows it understood the question: the "[Since …]" block worked.
  - `read_conversation` (run by a driven planner tick, or the manager office door) returns
    snippets of that exchange.
- [x] The disclosure copy reads well, and it arrived exactly once.

---
*Pause after Phase 5's manual list. Phases 1–4 have no manual checks and run straight through.*

## Outcome (2026-09-24)

Live on the pilot: web + lifecycle-heart at d06ba6f (#283), migrations applied, s5 glue installed
06:51 UTC. Driven: an office text and an office note to Ben were delivered in 3.3 s / 4.3 s, served
once, with zero seat model calls. Gate: the operator answered on the phone; the seat saw the office's
text on top of the reply, filed the note on the right visit (completing it), the open nudge got
answered_by_capture_id, and all four turns reached seat_turns. Follow-ups merged: #284 (npm audit fix)
and #285 (a manager's conversation is private, operator 2026-09-24): both awaiting deploy, and #285
must be live before step 2 moves a manager seat onto the glue.

