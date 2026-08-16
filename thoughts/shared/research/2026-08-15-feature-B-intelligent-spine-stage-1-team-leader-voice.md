---
date: 2026-08-15
branch: feat/date-eval-grader-formats
commit: 6d4684c
topic: "Feature B — Intelligent spine Stage 1 (\"the voice\"): team-leader outreach delivered through a person's own agent, the spine-side identity class capped at read/ask/stage, and the nudge budget / dedup / escalation ladder"
---

## Summary

Plain language first. Today the spine (the shared customer/job record) is **passive**: it answers
when an agent asks, and otherwise sits still. The only spine-side initiative is a **heartbeat** — a
Render Cron Job that runs every 15 minutes and does seven fixed, dumb sweeps (check pairings, expire
offboardings, mint Composio sessions, ingest logs, backfill costs…). It has no voice: nothing in the
spine can start a conversation with a person, except two canned-copy push paths that message a
person's Telegram **bot directly** with a fixed sentence (schedule changes, unmatched calls).

Feature B Stage 1 ("the voice") wants something different: a deterministic watcher notices a gap
(a visit's time passed, nothing came back), and then a **model turn** decides whether/whom/how to
ask, and the question is delivered **through that person's own agent** — so it arrives as their
assistant asking, with the assistant's context and tools, not as a robot broadcast. Their reply then
flows back through the ordinary capture write path and closes the gap.

This document maps what exists today that Stage 1 would sit on: the heartbeat, the identity model
(how the spine knows *who* is calling and what they may do), the tool-permission mechanism (where a
hard ceiling can actually be enforced rather than asked for in a prompt), the dedup/budget precedents
already in the codebase (review items with a one-open-per-subject unique index; ops incidents that
fold repeats into one row; the notification digest threshold), the transports that exist in both
directions between the spine and the agent box, and the capture-policy machinery that would decide
what a nudge and its reply leave behind in the permanent record.

**The single most consequential structural fact** for this feature: **every network path between the
spine and trades-box-1 today runs box → spine, never spine → box.** The spine has no push channel to
the box at all. The one existing spine→box *command* channel is a **pull**: the box's badge-pull
timer (every 5 min) asks the spine for work and the spine answers with a queue (`retirements[]`),
which it keeps serving until the box reports completion. Everything Stage 1's "transport" question
turns on sits inside that fact.

---

## Entry Points

Where this area begins today, exactly:

| Entry point | File:line | What it is |
|---|---|---|
| The pulse (spine-side clock) | [src/jobs/lifecycle.ts:95](src/jobs/lifecycle.ts#L95) `runLifecycle`, main at [:287](src/jobs/lifecycle.ts#L287) | The ONE scheduled entrypoint — Render Cron Job, `*/15 * * * *`, `npm run job:lifecycle` → `node dist/jobs/lifecycle.js` |
| Long-lived poller (alternative process shape) | [src/telegram/boardWorker.ts:13](src/telegram/boardWorker.ts#L13) `startBoardWorker` | Render Background Worker looping `pollOnce` every 30 s |
| Second long-lived worker | `src/calls/runWorker.ts` (`npm run calls:worker`) | Same shape, for phone-call transcription |
| Central HTTP surface (spine) | [src/mcp/httpServer.ts:409](src/mcp/httpServer.ts#L409) `handle` | Routes webhooks, control-plane, board, admin, relay, then falls through to MCP |
| The tool boundary the agent calls | [src/mcp/server.ts:1847](src/mcp/server.ts#L1847) `dispatch`, [:6781](src/mcp/server.ts#L6781) `createServer` | Every spine tool call passes through `dispatch` |
| Identity at the boundary | [src/mcp/identity.ts:13](src/mcp/identity.ts#L13) `RequestIdentity`, [:41](src/mcp/identity.ts#L41) `resolveIdentityFromHeaders` | The (tenant, technician) pair a tool call acts as |
| The reply write path | [src/writePath/recordFieldNote.ts:100](src/writePath/recordFieldNote.ts#L100) `recordFieldNote` | L1 → extract → match → L2/L3; where a nudge reply would land |
| Spine→box command queue (a PULL) | [src/mcp/httpServer.ts:427](src/mcp/httpServer.ts#L427) `GET /control/badges` → [src/control/badgeFile.ts:45](src/control/badgeFile.ts#L45) `buildBadgeResponse` | Box asks every 5 min; response carries a work queue |
| Box→spine report | [src/mcp/httpServer.ts:440](src/mcp/httpServer.ts#L440) `POST /control/ops` → [src/db/opsEvents.ts:62](src/db/opsEvents.ts#L62) `recordOpsEvent` | Host-token-authenticated status reports |
| The CLI transport (used by evals only) | [scripts/date-eval/run.mjs:231](scripts/date-eval/run.mjs#L231), [scripts/spine-eval/run-gateway.mjs:181](scripts/spine-eval/run-gateway.mjs#L181) | `ssh box → nemoclaw <sandbox> agent … --deliver --reply-to <chatId>` |

---

## Key Files

### The pulse and the process shapes

- **[src/jobs/lifecycle.ts](src/jobs/lifecycle.ts)** (304 lines) — the heartbeat. Header comment
  ([:19-43](src/jobs/lifecycle.ts#L19-L43)) states the contract that any new step must honour:
  *everything here is a sweep over durable state, so a missed or doubled tick is safe.* Seven steps,
  each isolated in its own `try` (one failing step is reported, never blocks the others); the summary
  is a single JSON line to stdout and `process.exit(ok ? 0 : 1)`. Steps that need a key they may not
  have report `{skipped: …}` rather than turning the cron permanently red
  ([:156](src/jobs/lifecycle.ts#L156), [:192](src/jobs/lifecycle.ts#L192),
  [:236](src/jobs/lifecycle.ts#L236)). Deps are injectable (`LifecycleDeps`,
  [:45](src/jobs/lifecycle.ts#L45)) so every step is testable without touching the network.
  Exports: `runLifecycle`, `LifecycleDeps`, `LifecycleSummary`.
- **[src/telegram/boardWorker.ts](src/telegram/boardWorker.ts)** — the other process shape: a
  separate Render Background Worker, deliberately not folded into the web tier ("the web tier stays
  stateless… a future >1-replica web tier can't double-send notifications"). Its cursor lives **in
  memory only** — a restart re-seeds at current versions and events during downtime are skipped
  (documented v1 trade for having no new table).
- **`src/calls/runWorker.ts`** — third precedent: a worker draining a queue of call recordings.

### Identity and the permission ceiling

- **[src/mcp/identity.ts](src/mcp/identity.ts)** (63 lines) — the whole identity model.
  `RequestIdentity = { tenantId, technicianRef, scopes?: string[] }`. Two sources only:
  `identityFromEnv()` (stdio/dev, pinned per process from `DEFAULT_TENANT_ID` /
  `DEFAULT_TECHNICIAN_REF`) and `resolveIdentityFromHeaders()` (central HTTP: the gateway stamps
  `x-tenant-id` / `x-technician-ref` plus an HMAC of `${tenantId}.${technicianRef}` under
  `GATEWAY_IDENTITY_SECRET`; a length-guard precedes `timingSafeEqual`). **`scopes` is declared and
  never read anywhere in `src/`** (verified by grep — the only other `scopes` hit is a Google OAuth
  call in `src/routes/roiClient.ts`). It is an unused hook, not a working mechanism.
- **[src/mcp/server.ts](src/mcp/server.ts)** (6,893 lines) — the single tool boundary. The parts that
  matter here:
  - `TOOLS` ([:249](src/mcp/server.ts#L249)) — the technician surface; `ADMIN_TOOLS`
    ([:604](src/mcp/server.ts#L604)) — manager-only; `ADMIN_TOOL_NAMES`
    ([:1567](src/mcp/server.ts#L1567)); `MANAGER_TOOLS`
    ([:1576](src/mcp/server.ts#L1576)) = base tools minus `get_schedule` plus admin tools.
  - `isActiveManager` ([:1842](src/mcp/server.ts#L1842)) — one predicate shared by the dispatch gate
    and the `tools/list` filter "so the two can never disagree".
  - `dispatch` ([:1847](src/mcp/server.ts#L1847)) — **one roster read gates every call**
    ([:1864](src/mcp/server.ts#L1864)): a deactivated roster row throws for ALL tools; the tier gate
    is applied **by tool name** ([:1896](src/mcp/server.ts#L1896)) "so no admin case can be added
    without it"; a per-call cost event is recorded *before* the tier gate
    ([:1878](src/mcp/server.ts#L1878)) so a refused call still counts.
  - `ListToolsRequestSchema` handler ([:6787](src/mcp/server.ts#L6787)) — explicitly labels
    discovery as **cosmetic**: "dispatch re-gates both directions".
  - `send_email` ([:2565](src/mcp/server.ts#L2565)) — the reference implementation of an
    externally-visible action: stage → show → confirm, token consumed **before** the send
    (at-most-once), 15-minute expiry, failure re-annotates the consumed item, and an advisory L1
    capture on `outbound_email`.
  - `groundingNow` ([:6756](src/mcp/server.ts#L6756)) — every object-shaped tool result gets a `now`
    line (firm-local date + weekday + tz), memoized 10 min.
- **[src/composio/sessions.ts](src/composio/sessions.ts)** — the *other* permission mechanism, and
  the only one that is enforced by a third party: per-person Composio sessions whose tool
  restrictions are **execution-enforced** (HTTP 400, code 4310). `sessionConfigForTier`
  ([:32](src/composio/sessions.ts#L32)) is "the ONLY place they are defined", with a hard rule that
  no code path may call `client.sessions.create` outside this module.

### Dedup, budget, escalation — the existing precedents

- **[src/db/reviewItems.ts](src/db/reviewItems.ts)** (381 lines) — the queue that already carries
  every "a human must decide" item. `ReviewKind` ([:10-53](src/db/reviewItems.ts#L10-L53)) is a
  TypeScript union over a **free-text DB column** — "new kinds must not need a migration".
  `upsertOpenReviewItem` ([:69](src/db/reviewItems.ts#L69)) relies on a **partial unique index**
  (`uq_review_items_open on (tenant_id, kind, subject_ref) where status = 'open'`,
  [supabase/migrations/20260702194603_technicians_and_review_items.sql:70](supabase/migrations/20260702194603_technicians_and_review_items.sql#L70))
  and is insert-then-catch-23505 because supabase-js cannot infer a partial index for upsert.
  Two distinct dedup *shapes* already exist here:
  - **one-open-per-subject** (the index) — repeat flags return the existing row;
  - **once-per-episode, any status** — `flagUnknownRefCapture`
    ([:100](src/db/reviewItems.ts#L100)) dedups on `detail->>externalId` and
    `flagOffboardingReminder` ([:230](src/db/reviewItems.ts#L230)) on `detail->>startedAt`, so a
    *dismissed* item stays dismissed even though the 15-min cron keeps observing the condition.
    This is the closest thing in the repo to "ask once, not every 15 minutes".
- **[src/db/opsEvents.ts](src/db/opsEvents.ts)** (113 lines) — the incident fold. `recordOpsEvent`
  ([:62](src/db/opsEvents.ts#L62)) turns a stateless repeated observation into transitions: four
  cases, three of which write nothing. The header states the doctrine verbatim: *"Suppression is the
  point. Without it a 30-minute outage is six identical rows, and any notifier built on top fires six
  times and gets muted."* Constraint worth noting: its table is **host-scoped** (`host_id` FK) with
  one-open-per-`(host, service)` — the money plan already recorded that `ops_events` therefore
  **cannot** host tenant-level cadence state.
- **[src/telegram/boardNotify.ts](src/telegram/boardNotify.ts)** (306 lines) — the attention-economics
  precedent that already ships. `DIGEST_THRESHOLD = 3` ([:44](src/telegram/boardNotify.ts#L44)):
  more than three messages owed to one recipient in one tick collapses into ONE digest
  (`digestText`, [:51](src/telegram/boardNotify.ts#L51), capped at 12 bullets to stay under
  Telegram's 4096-char limit). `pollOnce` ([:248](src/telegram/boardNotify.ts#L248)) resolves the
  whole tick before sending precisely so the collapse can happen. Also the liveness rule
  ([:85-97](src/telegram/boardNotify.ts#L85-L97)): deactivation does not clear `telegram_user_id`,
  so every push path must filter inactive rows itself or message an ex-employee.
- **[src/calls/notify.ts](src/calls/notify.ts)** (24 lines) — `notifyManagers(tenantId, text)`: the
  manager fan-out, best-effort, **never throws** ("the durable record is the review item… a Telegram
  blip must not fail the call it is notifying about").

### Capture policy (what a nudge and its reply leave behind)

- **[src/db/rawCaptures.ts](src/db/rawCaptures.ts)** (215 lines) — L1. `appendRawCapture`
  ([:33](src/db/rawCaptures.ts#L33)) is **insert only** — "no update or delete — mirroring the DB
  trigger". `AppendRawCaptureInput` ([:7-29](src/db/rawCaptures.ts#L7-L29)) is the exact field menu a
  new capture policy would have to choose from: `channel`, `rawText`, `blobPath`, `externalId`
  (per-tenant unique), `technicianRef` (**"the badge-mapped technician ref, or `connector:<toolkit>`
  for unattributed connector captures"** — a free-text namespace, no FK), `metadata` (JSONB),
  `sensitivity` (`'manager_only'` filters the row out of technician-tier reads),
  `customerId/jobId/visitId` stamps, and `retractsCaptureId`.
- **[src/writePath/recordFieldNote.ts](src/writePath/recordFieldNote.ts)** (315 lines) — the
  channel-agnostic write path a reply would take. Note the `structure` switch
  ([:189](src/writePath/recordFieldNote.ts#L189)): `structure: false` appends verbatim to L1 and
  STOPS — no extract, no match, no L2. Its comment states the rule: *"Gate before-L2, never
  before-L1."*
- **[src/email/classify.ts](src/email/classify.ts)** (57 lines) — the work-vs-personal classifier
  that gates the L1 insert for inbound mail. `CLASSIFY_SYSTEM` ends "When unsure, prefer
  isWork=false", and the comment at [:46-48](src/email/classify.ts#L46-L48) records why the boolean
  is coerced: a truthy string `"false"` would append personal mail to append-only L1.
- **Audit channels**: `AUDIT_CHANNELS = {'outbound_email','agent_action'}`
  ([src/mcp/server.ts:1647](src/mcp/server.ts#L1647)) — L1 rows that exist to hold the ACTOR
  accountable; retracting one requires a manager badge even for its author.

### Transport (both directions)

- **[src/control/badgeFile.ts](src/control/badgeFile.ts)** — `BadgeResponse`
  ([:19-38](src/control/badgeFile.ts#L19-L38)) is the pull payload: `badgesFile`, `newBadges`,
  `bindings`, and **`retirements[]` — "Sandboxes the server wants destroyed + re-provisioned…
  Served on EVERY pull until the box reports completion via POST /control/sandboxes — a lost tick
  self-heals."** This is the working shape of a spine→box work queue.
- **[Box_Setup_Stuff/badge-pull.sh](Box_Setup_Stuff/badge-pull.sh)** — the box side: root, systemd
  timer, **every 5 minutes** ([:3](Box_Setup_Stuff/badge-pull.sh#L3)); the retirements section
  ([:311](Box_Setup_Stuff/badge-pull.sh#L311)) queues each item as a file and kicks a systemd
  service, with a "PARKED (needs operator)" state so a bad item cannot re-alarm every tick.
- **[Box_Setup_Stuff/ops-report.sh](Box_Setup_Stuff/ops-report.sh)** — the box→spine report. Its
  header carries two rules a Stage-1 executor would inherit: *"THIS SCRIPT MUST NEVER BE ABLE TO
  BREAK WHAT IT WATCHES"* (separate systemd unit, **always exits 0**, hard `--max-time`) and
  *"STATELESS BY DESIGN"* (reports current status every time; the server folds repeats).
- **[scripts/date-eval/run.mjs](scripts/date-eval/run.mjs)** — the only working driver of an agent
  turn from outside the box. The command ([:231](scripts/date-eval/run.mjs#L231)):
  `ssh <host> "export PATH=…; MSG=$(echo '<b64>' | base64 -d); nemoclaw <sandbox> agent --agent main
  --session-id <sid> -m \"$MSG\" --deliver --reply-to <chatId> </dev/null 2>&1"`. Load-bearing
  details it records: base64 the message (two layers of shell quoting), `</dev/null` (`nemoclaw exec`
  eats stdin), the **reply must be read from the session trajectory, never stdout**
  ([:263-271](scripts/date-eval/run.mjs#L263-L271)), fresh session ids per run
  ([:79-89](scripts/date-eval/run.mjs#L79-L89)), and a dead-turn retry
  ([:229-243](scripts/date-eval/run.mjs#L229-L243)).
- **[scripts/spine-eval/run-gateway.mjs](scripts/spine-eval/run-gateway.mjs)** — the same transport
  spelled out one level deeper ([:181-184](scripts/spine-eval/run-gateway.mjs#L181-L184)):
  `nemoclaw <s> exec --no-tty -- bash -lc 'openclaw agent --agent main --session-id <sid> --deliver
  --reply-channel telegram --reply-to <chat> -m …'`, with the note that it must be `nemoclaw exec`
  and **not** `docker exec` because the gateway listens in a nested network namespace.
- **[src/composio/relayHandler.ts](src/composio/relayHandler.ts)** — the doorman relay: sandbox →
  doorman → this Render route → the person's Composio session. Also box→spine. Confirms the
  direction rule: the master key never leaves the control plane, and "a badge can only ever reach its
  own person's session".

### Read surfaces a watcher / team leader would use

- **[src/db/querySpine.ts](src/db/querySpine.ts)** (74 lines) — `runSpineQuery` runs the model's SQL
  as a **parameter** to a `SECURITY DEFINER` function owned by `spine_reader`; the tenant is a
  separate parameter from the verified identity, never interpolated. Every query is audited to
  `query_audit` both ways, and audit failure never changes the caller's result. Caps: default 200,
  ceiling 1000, with `truncated` reported.
- **[supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql:30](supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql#L30)**
  — `v_schedule` = the schedule that STANDS (`status in ('confirmed','completed')`), with
  `local_day`/`local_weekday` already firm-local; `v_cancelled_visits` is the sibling. The header
  documents the 2026-08-12 incident where a missing status filter inflated every count.
- **[src/db/assignments.ts](src/db/assignments.ts)** — the table an overdue-visit watcher must read.
  `Assignment` has `starts_at`/`ends_at` **nullable** (unplaced/time-TBD rows carry
  `earliest_date`/`latest_date` instead), `status` in
  `proposed|confirmed|cancelled|completed`, and `technician_id` **nullable** (unassigned bookings).
  `PlacedAssignment` ([:15](src/db/assignments.ts#L15)) exists as a compiler-checked marker for rows
  that have times.
- **[src/db/reviewItems.ts:329](src/db/reviewItems.ts#L329)** `listOpenReviewItems` — what
  `list_pending_reviews` ([src/mcp/server.ts:6583](src/mcp/server.ts#L6583)) serves; manager-only.

---

## Data Flows

### 1. What exists today: the pulse has no voice

```
Render Cron (*/15)          Render Background Worker (30s)
       │                              │
       ▼                              ▼
 runLifecycle()                  pollOnce(lastSeen)
  7 fixed sweeps                  reads schedule_events
  (pairing, offboarding,          resolves rows → canned text
   sessions, log ingest,          collapses >3 → digest
   brave, deepinfra, rollup)             │
       │                                 ▼
       ▼                          sendBoardMessage(telegramUserId, text)
 stdout JSON + exit code                 │
 (nobody is messaged)                    ▼
                                 the person's Telegram — from the BOARD BOT,
                                 fixed copy, no model, no agent context
```

Two things this diagram makes concrete: (a) the heartbeat's output is a log line, not a message;
(b) the only existing spine→human push goes to the **board bot**, bypassing the person's agent
entirely — it is a notification, not a question, and nothing can come back through it into the spine.

### 2. How a person's agent turn reaches the spine today (the normal direction)

```
Telegram ──▶ NemoClaw gateway (sandbox, nested netns)
                 │  AGENTS.md doctrine + cached tools/list
                 ▼
             spine MCP client ──▶ doorman ──▶ Render /mcp
                                                │ resolveIdentityFromHeaders
                                                │  (x-tenant-id, x-technician-ref, HMAC)
                                                ▼
                                        dispatch(name, args, {identity})
                                          ├─ roster read → deactivated? throw
                                          ├─ cost event (before the gate)
                                          ├─ ADMIN_TOOL_NAMES gate
                                          └─ the tool
```

The identity is established **at the boundary and never read from a model argument**
([src/mcp/server.ts:208-213](src/mcp/server.ts#L208-L213)) — that is the property a new identity
class must preserve.

### 3. The Stage-1 loop, mapped onto what exists

```
 ┌── deterministic watcher (SQL over the spine) ───────────────┐
 │   e.g. assignments: ends_at < now-N, status='confirmed',    │
 │        no linked capture, job status unchanged              │
 └───────────────┬─────────────────────────────────────────────┘
                 │ trigger  (free; runs on the pulse)
                 ▼
 ┌── budget + dedup gate  (SERVER-SIDE, before any model call) ┐
 │   "have we already asked this person about this subject?"   │
 │   precedent: review_items partial unique index + the        │
 │              detail->>key any-status episode dedup          │
 └───────────────┬─────────────────────────────────────────────┘
                 │
                 ▼
 ┌── the team-leader model turn ──────────────────────────────┐
 │   decides whether / whom / how; composes the question       │
 │   acts as a NEW identity: read + ask + stage ONLY           │
 └───────────────┬─────────────────────────────────────────────┘
                 │ transport  ← THE OPEN SEAM (see Decision Points)
                 ▼
 ┌── the person's own agent turn ─────────────────────────────┐
 │   openclaw agent --deliver --reply-to <chat>                │
 │   outbound plugin hooks fire (weekday guard scans the text) │
 └───────────────┬─────────────────────────────────────────────┘
                 │ Telegram
                 ▼
             the human answers in chat
                 │
                 ▼
 ┌── the ordinary write path ─────────────────────────────────┐
 │   record_field_note stage → preview → confirm               │
 │   recordFieldNote(): L1 append → extract → match → L2/L3    │
 └────────────────────────────────────────────────────────────┘
```

Every box in that diagram exists today **except** the budget gate, the team-leader identity, and the
transport hop from the spine to the box.

### 4. The one working spine→box command channel (a pull, not a push)

```
trades-box-1 (systemd timer, every 5 min)
      │  Authorization: Bearer <host token>
      ▼
GET /control/badges  ──▶ buildBadgeResponse(hostId)
      ◀──  { badgesFile, newBadges, bindings, retirements[] }
      │
      │  box acts locally (destroy + re-provision sandbox)
      ▼
POST /control/sandboxes  (same host token)
      └─▶ completeSandboxRecycle(...) → the item stops being served
```

Properties this shape already has, that a nudge outbox would want: at-least-once with self-healing
(served until reported), host-token auth reusing an existing secret, the spine never needing to reach
into the box, and a "PARKED" terminal state so a poison item cannot re-alarm forever.

---

## External Dependencies

- **OpenClaw / NemoClaw gateway** on trades-box-1 — the agent runtime. Relevant surfaces:
  `openclaw agent` (runs on the **gateway**, not embedded, unless `--local`), the flags
  `--deliver` / `--channel` / `--reply-channel` / `--reply-to` / `--session-id` / `--message-file`,
  and the outbound plugin hooks `message_sending` and `reply_payload_sending`. Recorded in
  [docs/engineering-memory.md:1796](docs/engineering-memory.md#L1796). Docs cited there:
  `https://docs.openclaw.ai/gateway/config-agents`, `https://docs.openclaw.ai/plugins/hooks`,
  `https://docs.openclaw.ai/gateway/configuration-reference#hooks`.
- **`POST /hooks/agent`** (the gateway's HTTP webhook) — documented and authenticated
  (`hooks.{enabled,token,path,mappings}`, header-only bearer auth, `sessionMode:"isolated"` default,
  returns on admission not completion). **Non-functional on trades-box-1**
  ([docs/engineering-memory.md:1801-1824](docs/engineering-memory.md#L1801-L1824)): hook runs execute
  through the cron runner, which preflights any provider whose `baseUrl` is loopback/private/`.local`.
  OpenShell's endpoint is `https://inference.local/v1`, probed with a direct `getaddrinfo` inside a
  namespace with no public DNS (everything egresses via a proxy at `10.200.0.1:3128`), so the probe
  is a **false negative on a working provider** and the run is skipped. Tested with `deliver:false`
  and `deliver:true`, 16 minutes apart, identical skip. The docs state the preflight **cannot be
  disabled**.
- **Telegram Bot API** — via `sendBoardMessage` (board bot) for spine-side pushes, and via each
  sandbox's own bot for agent replies. Bots cannot message first: the person must have started the
  chat (`sandbox_pool.bot_username` exists for exactly this).
- **Supabase / PostgREST** — all spine state. Note the silent `db-max-rows` cap (1000) that
  `listTenantIdsWithTelegramBindings` pages around ([src/db/technicians.ts:90-96](src/db/technicians.ts#L90-L96)).
- **Model provider** — GLM-5.2 through the fleet's configured inference route. As of 2026-08-15 the
  fleet is parked on `deepinfra-prod` after a Fireworks monthly-cap suspension (HTTP 412); the Render
  spine still holds the suspended Fireworks key, so spine-side model calls (briefs/classify) error
  while `resolve_date` is unaffected.
- **Composio** — per-person sessions; tool restrictions execution-enforced (code 4310).
- **Render** — Cron Job (the pulse), Web Service (the HTTP surface), Background Workers.

---

## Constraints and Invariants

Non-obvious rules this feature would be built inside. Each is load-bearing and each is stated
somewhere in the code or the doctrine.

**Identity and permissions**

1. **Identity is established at the boundary, never from a model argument**
   ([src/mcp/server.ts:208-213](src/mcp/server.ts#L208-L213)). Two sources exist:
   env-pinned and HMAC-signed headers. There is no third.
2. **`RequestIdentity.scopes` is declared and unused.** A permission ceiling expressed through it
   today would enforce nothing — the working enforcement points are the `ADMIN_TOOL_NAMES` name gate
   in `dispatch` and the Composio session config.
3. **Tier is read from an ACTIVE roster row, not from the badge**
   ([src/mcp/server.ts:1832-1845](src/mcp/server.ts#L1832-L1845)). A badge with **no** roster row
   keeps the documented plain-technician surface — i.e. the default for an unknown actor is
   *technician-level access*, which includes `record_field_note`, `send_email` (gated further by
   `requireOutboundCapable`), `retract_capture` and the web tools. A new identity class that simply
   omits a roster row inherits that surface rather than a null one.
4. **`tools/list` filtering is cosmetic; `dispatch` is the gate**
   ([src/mcp/server.ts:6787-6797](src/mcp/server.ts#L6787-L6797)). Any ceiling must live in dispatch
   (or below), never in the listing.
5. **Composio session tool restrictions are the only third-party-enforced boundary**
   (code 4310), and a bare session defaults to the **entire catalog** with `manageConnections`
   enabled ([src/composio/sessions.ts:9-12](src/composio/sessions.ts#L9-L12)).
6. **Demotion requires tearing down the Composio session**, or a stale manager session keeps the full
   catalog indefinitely ([src/mcp/server.ts:1835-1839](src/mcp/server.ts#L1835-L1839)).

**Prompt vs mechanism**

7. **GLM-5.2 does not reliably obey standing instructions** — proven repeatedly (skipped required
   fields, skipped the board link, resolved ambiguity it was told to ask about). The recorded rule:
   *"When a behavior matters, move it into the mechanism"* (required params, result-embedded
   directives, server-side resolution). Prompt rules are steering, not enforcement
   ([docs/engineering-memory.md](docs/engineering-memory.md), "Designing agent behavior").
8. **Instructed to always produce X with no material for X, the model invents one** — two live
   incidents of fabricated board links. Applied here: if a nudge template demands a citation or a
   link the payload lacks, expect a fabricated one.

**L1 / capture policy**

9. **L1 is append-only, enforced by a DB trigger** — insert only, no update, no delete
   ([src/db/rawCaptures.ts:31-33](src/db/rawCaptures.ts#L31-L33)).
10. **Filtering must gate the insert, never follow it.** `structure:false` shows the sanctioned
    shape of "keep the verbatim record, skip the structuring"
    ([src/writePath/recordFieldNote.ts:189](src/writePath/recordFieldNote.ts#L189)) — *"Gate
    before-L2, never before-L1."*
11. **The 2026-07-04 outbound exception is scoped to outbound sends and Composio execution logs** and
    is explicitly not extendable by analogy (per the direction doc's constraint 4). Non-send
    `agent_action` captures store **argument key names only, never values**.
12. **A stamped capture pins its L2 row permanently.** `raw_captures.customer_id/job_id/visit_id` are
    `on delete set null`, and the append-only trigger is `before update or delete`, so deleting a
    customer fails with the bare string `raw_captures is append-only`.
13. **`technician_ref` is free text with a reserved namespace** (`connector:<toolkit>`,
    [src/db/rawCaptures.ts:15-16](src/db/rawCaptures.ts#L15-L16)); no FK. `slugify`
    ([src/mcp/server.ts:1558](src/mcp/server.ts#L1558)) mints refs over `[a-z0-9-]` precisely so a
    minted ref can never collide with a reserved namespace. `money_events.actor_ref` and
    `schedule_events.actor_ref` are the same free-text convention (`'system'`,
    `'inference:outbound_email'`).
14. **Refs are never reused across humans** ([src/db/technicians.ts:21-23](src/db/technicians.ts#L21-L23))
    because L1 attribution is append-only and would merge two people's history.

**Scheduling / watcher data**

15. **Unplaced (time-TBD) visits have NULL `starts_at`/`ends_at`** and carry
    `earliest_date`/`latest_date` instead. Any `starts_at`-range watcher silently excludes them — the
    trap the `query_spine` description spends a paragraph on
    ([src/mcp/server.ts:1068-1072](src/mcp/server.ts#L1068-L1072)).
16. **Assignment times are naive-local by convention while `created_at` columns are true UTC.** The
    money plan records the consequence: a single cutoff is off by the firm's whole UTC offset, so
    quiet-job detection needs **two** cutoffs derived from the same firm-local moment
    ([thoughts/shared/plans/2026-08-15-money-inference-v1.md:284-287](thoughts/shared/plans/2026-08-15-money-inference-v1.md#L284-L287)).
17. **Note-only jobs create `visits`, never `assignments`** — a watcher keyed only on assignments
    misses them (same plan, [:281-283](thoughts/shared/plans/2026-08-15-money-inference-v1.md#L281-L283)).
    And the fleet-ops rule from memory: *"DB check = `assignments`, not `visits`"* for schedule state.
18. **`v_schedule` excludes cancelled AND proposed rows**; cancelled live in `v_cancelled_visits`;
    proposed appear in **no** SQL view.

**Notification / attention**

19. **Deactivation does not clear `telegram_user_id`** — every push path must filter inactive rows
    itself ([src/telegram/boardNotify.ts:91-96](src/telegram/boardNotify.ts#L91-L96)).
20. **Bots cannot message first.** A person who never pressed Start is unreachable.
21. **Suppression must be server-side and stateless-reporter-friendly** — the ops-event fold
    ([src/db/opsEvents.ts:48-61](src/db/opsEvents.ts#L48-L61)).
22. **`ops_events` cannot host tenant-level cadence** (host FK + one-open-per-`(host,service)` index);
    the recorded precedent for tenant-level settings is a column on `tenants`
    (`technician_horizon_days`, `default_job_minutes`).
23. **The board worker's cursor is in memory only** — a restart skips events during downtime. Any new
    worker inherits this trade unless it persists a cursor.

**Heartbeat discipline**

24. **Every lifecycle step must be idempotent and isolated**; a missed or doubled tick must be safe;
    a step lacking its key reports `skipped`, not an error
    ([src/jobs/lifecycle.ts:19-43](src/jobs/lifecycle.ts#L19-L43)).
25. **The whole run exits non-zero if any step failed**, which is how Render surfaces it — so adding a
    step that can fail on ordinary conditions turns the heartbeat red every 15 minutes.

**Transport**

26. **There is no spine→box push.** All existing paths are box→spine (`/control/badges` pull,
    `/control/sandboxes`, `/control/ops`, the doorman relay). The one command channel is the pull's
    `retirements[]` queue, served until acknowledged.
27. **`POST /hooks/agent` is admitted then skipped on this box** (provider preflight false-negative,
    cannot be disabled). Confirmed with `deliver` both true and false.
28. **`openclaw agent` without `--local` runs on the gateway** (full AGENTS.md, real tool policy);
    `--deliver` is what makes outbound plugin hooks fire. Verified s2+s6 2026-08-12; the earlier
    "CLI = embedded, AGENTS.md truncated" note was a pairing failure and caused three wrong
    conclusions.
29. **Reach the gateway with `nemoclaw <s> exec`, not `docker exec`** — it listens in a nested network
    namespace ([scripts/spine-eval/run-gateway.mjs:19-25](scripts/spine-eval/run-gateway.mjs#L19-L25)).
30. **Never grade stdout of a CLI turn; read the session trajectory**
    (`/sandbox/.openclaw/agents/main/sessions/<sid>.jsonl`). Stdout carries delivery errors and a
    `◇ Config warnings` box that silently becomes "the answer"
    ([scripts/date-eval/run.mjs:263-271](scripts/date-eval/run.mjs#L263-L271)).
31. **A turn can come back dead** (no assistant text) from a mid-stream provider blip; the eval
    harness retries exactly once with a **fresh** session id.
32. **`run.mjs` has no per-question ssh timeout** — a 71-minute hang was recorded on 2026-08-15 while
    the agent itself answered in 9 s. Any production driver of this transport needs its own timeout.
33. **Sessions never auto-reset** (`session.reset` unset on our sandboxes, vendor default `none`), so
    a delivered nudge lands in the person's *existing, long-running* conversation unless a session id
    is chosen deliberately; long sessions compact in the live context but the on-disk transcript stays
    verbatim (direction doc, verified 2026-08-15).
34. **Delivered text passes the weekday guard.** `reply_payload_sending` fires on `--deliver` runs, so
    a nudge naming a weekday+date is scanned like any other reply and can be flagged
    (`/sandbox/.openclaw/logs/weekday-guard.jsonl`).

**Safety posture**

35. **Fail-closed guards are written as typed, tested modules, not inline checks** —
    [src/eval/targetGuard.ts](src/eval/targetGuard.ts) is the model: "local is PROVEN, never inferred
    from the absence of evidence", and it is deliberately **not** weakened to unlock a new path; a new
    path gets its own separate gate.
36. **A monitoring/actuating path must never be able to break its subject** — separate systemd unit,
    always exit 0, hard timeout ([Box_Setup_Stuff/ops-report.sh](Box_Setup_Stuff/ops-report.sh) header).
37. **A new table referencing only `tenants` escapes every cleanup cascade** and will break the eval
    world rebuild unless named in `scripts/spine-eval/world.mjs`, `scripts/seed.mjs` and the test
    truncate lists ([docs/engineering-memory.md:41-49](docs/engineering-memory.md#L41-L49)).

---

## Decision Points

Stated factually — what the choice is, and what each option involves **given how the code works
today**. No recommendation.

### D1. Where the team-leader turn's *message* crosses from the spine to the box

The spine runs on Render; the agent runtime runs on trades-box-1. Nothing on Render can reach into
the box today.

- **(a) Render drives `ssh` → `nemoclaw … agent --deliver`.** This is exactly what
  `scripts/date-eval/run.mjs` does, from a developer laptop. Involves: giving the Render service an
  ssh key and network path to the box (no such credential exists in the codebase today — every Render
  env var in use is an API key, and every box→spine call is bearer-token authenticated the other
  way), plus a per-call timeout (constraint 32), plus trajectory read-back over the same ssh
  connection if the reply matters.
- **(b) The box pulls a nudge queue, exactly like `retirements[]`.** Involves: a new field on the
  badge-pull response (or a sibling endpoint under the same host-token auth), a box-side executor
  script in `Box_Setup_Stuff/` running the CLI locally, and a completion report
  (`POST /control/…`) so the item stops being served. Reuses `HOST_PULL_TOKEN`, inherits the
  self-healing at-least-once semantics, and matches the existing "spine never reaches into the box"
  posture. Costs: up to 5 minutes of latency at the current timer cadence, and a new box-side
  component that must obey constraint 36 (can never break what it drives).
- **(c) Fix `/hooks/agent` upstream or by config.** The recorded diagnosis names two candidate
  levers: `failureAlert.includeSkipped` (surfaces the skip, does not fix it) and giving the inference
  provider a `baseUrl` that is not loopback/private/`.local` so it stops being preflighted at all.
  The second changes fleet-wide inference config for every seat, not just this feature.
- **(d) Run the team-leader turn on the box itself.** The direction doc notes "lives inside the
  spine" is a trust-zone statement, not necessarily a daemon. Involves: the turn's spine reads going
  back through the doorman/relay with some identity, i.e. D2 becomes a badge question rather than a
  header question.

### D2. What the new identity class actually *is*, mechanically

Today there are exactly two identity sources and one enforcement point.

- **(a) A roster row with a new tier.** `technician_tier` is a Postgres enum
  (`'manager' | 'technician'`) — a third value is a migration plus a regen, and every `tier ===
  'manager'` / `tier` comparison in the codebase becomes a place the new value must be considered.
  Gains: the existing "one roster read gates every call" machinery, deactivation, the seat-cap
  trigger (which it would need to be exempt from, cf. `seat_exempt`), and a natural `actor_ref`.
- **(b) A non-roster identity + an allowlist in `dispatch`.** `dispatch` already refuses by tool
  NAME before the switch. A read/ask/stage ceiling could be a second name-set gate keyed on the
  identity being the team leader. Note constraint 3: a badge with no roster row currently gets the
  **full technician surface**, so this option is a change from deny-nothing to deny-by-default for
  that identity, and the failure mode of forgetting the gate is "the team leader can send email".
- **(c) A separate MCP server instance with its own smaller `TOOLS` array.** `createServer(deps)`
  already takes an identity and the tool list is module-level; a second entrypoint could expose a
  strict subset. Gains: the ceiling is structural (the tool literally does not exist on that server).
  Costs: a second surface to keep in sync, and `dispatch` is shared — the switch would still contain
  every case.
- **(d) Reuse `RequestIdentity.scopes`.** It exists and is unused; making it real means writing the
  enforcement from scratch and auditing every tool for scope awareness.

The direction doc's constraint 2 requires "enforced in mechanism not prompt"; (a)–(c) are mechanisms,
(d) is a mechanism that does not exist yet.

### D3. Where the nudge budget / dedup state lives

- **(a) `review_items` with a new `kind`.** The `ReviewKind` union is TypeScript-only over a free-text
  column, so a new kind needs no migration. The partial unique index gives "one open ask per
  (tenant, kind, subject)" for free, and the `detail->>key` any-status pattern
  (`flagUnknownRefCapture`, `flagOffboardingReminder`) gives "once per episode, and a dismissal
  sticks". Costs: review items are **manager-visible** through `list_pending_reviews` — a nudge
  tracked this way is, by default, something the manager can see, which is exactly the product
  decision constraint 5 says must be made explicitly rather than inherited.
- **(b) A new table.** Full control over budget windows and per-person counters. Costs: a migration,
  plus constraint 37 (name it in the world/seed/test truncate lists) if it references only `tenants`.
- **(c) A column on `tenants`** (the `money_digest_last_sent_at` shape from the money plan) for
  cadence, combined with (a) for per-subject dedup. This is the pattern the adjacent unimplemented
  feature already chose after a review blocker ruled out `ops_events`.
- **(d) `ops_events`.** Ruled out already for tenant-scoped cadence (host FK, one-open-per-service).

### D4. Whether the team-leader's outreach and the reply are captured to L1, and how

Constraint 4 of the direction doc calls this "a new capture-policy entry" and says the 2026-07-04
outbound exception does not cover it by analogy.

- **The outreach.** Options run from no capture at all, through a `sensitivity:'manager_only'`
  `agent_action`-style row (keys-only redaction is the existing convention for non-send agent
  actions), to a full verbatim row. Whatever is chosen is **permanent** (constraints 9, 12).
- **The reply.** If it arrives through `record_field_note`, it is already captured by the normal path
  with its own preview→confirm ritual. If the team leader harvests it some other way, the
  work-relevance classifier must gate **before** the L1 insert (constraint 10 + the ratified
  transcript-harvest decision).
- **Attribution.** `technician_ref` is free text with a reserved-namespace convention; an
  `actor_ref`-style value for the team leader is a naming decision with permanence attached.

### D5. What the escalation ladder's last rung surfaces to the manager

The direction doc's ladder is: spine → the person's agent session context → the human → the manager's
digest. Today there is no manager digest of unanswered items; there are three adjacent surfaces:
`list_pending_reviews` (pull), `notifyManagers` (push, one line, best-effort), and the board-notify
digest (push, collapses bursts, board-bot copy). The money plan's Phase 3 proposes a **weekly**
digest gated by a `tenants` column. Constraint 5 of the direction doc says what the manager sees
about unanswered nudges is a product decision to make explicitly. The fork is between reusing
`list_pending_reviews` (visible immediately, manager-pull, no new copy), a batched
`notifyManagers` line (push, immediate), and a periodic digest (push, ritual, needs cadence state).

### D6. Which session a delivered nudge lands in

`--session-id` makes the transcript addressable; sessions never auto-reset (constraint 33).

- **The person's ongoing session** — the nudge appears in the conversation they already have, with
  its context; the reply is naturally in context too. Risk: the eval harness found that reusing a
  session id resumes the *old* conversation and answers "same as before".
- **A fresh isolated session per nudge** — repeatable and clean (this is what both evals do), but the
  person's answer then lives in a session that has none of their history, and it is a different chat
  thread from the one they are used to.

### D7. Process shape for the team-leader turn

- **Extend `src/jobs/lifecycle.ts`** — simplest; inherits the 15-minute cadence, the isolation
  pattern and the `ok`/exit-code contract. Costs: a model call inside the heartbeat, and constraint
  25 (a step that fails on ordinary conditions turns the heartbeat red every 15 minutes).
- **A dedicated Render Background Worker** — the `boardWorker`/`callsWorker` shape; own cadence, own
  failure surface. Costs: a new deploy unit, and the in-memory-cursor trade unless persisted.
- **On the box** — see D1(d).

### D8. Watcher inventory and volume

Nothing in the repo measures gap frequency today. The archetype (visit ended, nothing came back) is
computable from `assignments` + `raw_captures` + `jobs`, but constraints 15–17 mean the query has
three known traps (NULL times on unplaced rows, naive-local vs UTC cutoffs, note-only jobs with no
assignment). Whether other gap classes (unlinked transcripts, quotes with no follow-up, jobs stuck in
a status) occur at usable volume is unmeasured. Stage 0 in the direction doc exists precisely to
calibrate this before anything speaks.

---

## Open Questions

Things reading alone cannot settle:

1. **Can Render reach trades-box-1 at all?** No ssh credential, key, or host entry for the box appears
   anywhere in `src/` or the Render-facing config in this repo. Whether outbound ssh from Render to
   the box's IP is even permitted (Lightsail firewall, key custody) is unverified. This decides D1(a)
   outright.
2. **Does a `--deliver` run into a *person's live chat* behave the way the eval's dead-target runs do?**
   Every observation to date delivered to chat id 1 (a dead target) — the hook fires, then the send
   fails. Nobody has observed the full success path end-to-end into a real chat from this transport.
3. **What does the person's agent actually *do* with an injected turn?** The AGENTS.md doctrine
   ([docs/nemoclaw-tech-agent.md §5](docs/nemoclaw-tech-agent.md)) is written for a human-initiated
   conversation. Whether the model, handed "ask your technician how the Miller visit went", asks the
   human versus tries to answer from tools versus records something is untested.
4. **Does the reply reliably come back through `record_field_note`?** The spine-eval's recorded GLM
   habit is skipping the context read and calling tools with the wrong id shape. A nudge whose reply
   must land as a note is a new scenario class the corpus does not cover.
5. **Cost per trigger.** Watcher SQL is free; a model turn is not. The heartbeat runs 96×/day across
   every tenant, and the fleet shares ONE provider balance with the evals — a heavy day has already
   taken the pilot's agents down once (2026-08-14). Nobody has estimated triggers/day at realistic
   pilot volume.
6. **Is `technician_tier` extensible in practice?** A third enum value's blast radius across
   `tier === 'manager'` comparisons, the seat-cap trigger, `no_seat_exempt_managers`, the Composio
   session config switch, and `list_team` output has not been enumerated.
7. **What is the exact disclosure moment and wording?** Constraint 5 ratifies *that* workers must be
   told; the runbook today carries two written disclosures (outbound sends are logged; nothing can be
   deleted) at
   [docs/customer-onboarding-runbook.md:65-72](docs/customer-onboarding-runbook.md#L65-L72). Whether
   the nudge disclosure joins those, appears at first agent contact, or both, is undecided.
8. **How does a nudge interact with the weekday guard's act-mode?** The guard is observe-only today;
   the plan's phase 2 is cancel-and-retry on any flag. A team-leader nudge that names a date would be
   subject to it, and `corrected:true` self-corrections must be skipped by act-mode.
9. **Does the money plan's `job_done_check` nudge collide with this?** It is an unimplemented,
   approved-pending plan that puts a *nudge* on the same heartbeat with its own dedup and digest. If
   both land, the "one budget" question is cross-feature, not per-feature.
10. **Stage 0 has not run.** Nothing in the repo has ever measured how many gaps a real pilot week
    produces, which is the input that decides whether a budget of N/day is generous or crippling.

---

## Assumptions

Recorded because this was a non-interactive run and these points would otherwise have been questions
for the user:

- **"Same direction doc" = [thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md](thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md)**,
  and "constraints 1-5" are its five numbered "Doctrine collisions to respect". Confirmed by content
  match; no other intelligent-spine document exists in the repo.
- **Transport per the task brief overrides the direction doc's own Stage 1 line.** The direction doc
  contradicts itself: its "What already exists" section says `/hooks/agent` is a **dead end on
  trades-box-1** ([lines 58-61](thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md#L58-L61)),
  while its Stage 1 bullet still says outreach is delivered "via `/hooks/agent`"
  ([line 118](thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md#L118)). This document
  treats the CLI gateway path (`openclaw agent --deliver`) as the transport, per the task brief and
  the engineering-memory entry, and records the doc's internal contradiction as a finding.
- **"Feature B" here is Stage 1 of the intelligent spine.** An unrelated 2026-07-17 plan also uses
  the label "feature-B" (the Telegram Mini App dispatch board); they are different features and the
  filename carries the topic to keep them distinguishable.
- **Scope is read-only research of what exists.** No live probing of trades-box-1, no database
  queries, no test runs were performed — per the task's ground rules. Every live-behaviour claim in
  this document is cited to a recorded verification in `docs/engineering-memory.md` or to code, and
  is dated there; nothing was re-verified in this session.
- **The pilot/fleet's current parked state is taken from the engineering memory as of 2026-08-15**
  (fleet on `deepinfra-prod`, Render spine still holding a suspended Fireworks key). It is stated
  once as context for the cost question, not relied on elsewhere.
