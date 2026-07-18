---
date: 2026-07-17
task: Feature B / Plan 2 — Telegram Mini App dispatch board (global non-AI board bot + hosted page)
research: thoughts/shared/research/2026-07-17-feature-B-plan-2-mini-app-footprint-overlap.md
also: thoughts/shared/research/2026-07-17-plan-2-telegram-mini-app-dispatch-board.md
rebased: 2026-07-18 onto merged main c64d875 (Feature A live) — shape/confirm/notify updated, drag-to-assign added to v1
status: draft
---

## Overview
Build the **dispatch board**: one global, non-AI "board" bot owned by Render (plain code) that gives
managers and technicians a **web page inside Telegram** to see the team's days and (managers only)
drag-to-move / drag-to-assign / cancel visits. Plan 1 already shipped the *data* surface (booking verbs + previews,
the team read shape, the `schedule_events` version feed, and the roster↔Telegram binding). This plan
builds the **100% greenfield browser+Telegram surface** on top of it: a signed-`initData` auth path,
a same-origin REST API on the existing Render web server, a static Mini App page, a one-time launch
button, and a change-notification worker. No source file that Plan 1 or Feature A rewrites is edited
except `src/db/technicians.ts` (a new function) and `src/mcp/httpServer.ts` (new routes before the
MCP fallthrough) — so the footprint stays as disjoint from Feature A as the contract allows.

## Decisions
- **Data access fork (research DP2) → new REST endpoints, NOT the MCP tools.** Options: (a) drive the
  board through `get_team_schedule`/`book_visit` MCP tools (reuses tier-gating + confirm tokens but
  needs a browser MCP client + a forged-safe identity, and edits `src/mcp/server.ts` — the file
  Feature A rewrites); (b) new same-origin REST endpoints that call the shared `booking.ts` verbs and
  db queries directly. Chose **(b)**: keeps `server.ts` out of Feature B's footprint (the overlap doc's
  explicit goal), and the browser needs its own `initData` identity anyway.
- **Identity → global roster lookup, not `start_param` (research DP4).** The decided "one global bot,
  one launch link for everyone" model needs a **tenant-agnostic** Telegram-id→roster lookup (none
  exists today). v1 rule from memory `telegram-schedule-series`: **one firm per Telegram account** — if
  the id resolves to non-inactive rows in >1 tenant, reject as ambiguous (firm-picker is later).
- **initData verification → HMAC path** (`secret = HMAC_SHA256(BOARD_BOT_TOKEN,'WebAppData')`; authentic
  iff `hex(HMAC_SHA256(data_check_string, secret)) == hash`). The backend holds the bot token already
  (it sends notifications), so the Ed25519/public-key path buys nothing here. `auth_date` freshness
  window = **24h** (docs mandate none; our choice), rejecting stale launches.
- **Launch mechanism → `setChatMenuButton` (pure Bot API, no BotFather, no update listener).** Setting
  the chat menu button to a `web_app` at worker startup means every user who has `/start`-ed the board
  bot sees an "Open board" button — so the bot needs **no getUpdates/webhook listener** in v1. Private
  1:1 chats only (the audience), which avoids the truncated `web_app` private-chat restriction.
- **CORS → none.** The page is served **same-origin** by the same Render web service that serves the
  API, so no CORS/preflight machinery is needed. `initData` rides an `Authorization: tma <raw>` header.
- **Write scope → move + assign + cancel in v1; new-booking deferred.** Drag-to-move, drag-to-assign
  (rebase 2026-07-18: drop an Unassigned-lane visit onto a technician's lane — `moveVisit`'s optional
  `technicianRef`, shipped by Feature A, does the attach and re-engages the overlap guard server-side),
  and tap-to-cancel cover the dispatch verb set; booking a brand-new visit needs customer-picker UI
  (later).
- **Confirm model → inherit Feature A's doctrine via `preview.requiresConfirmation`; never re-derive.**
  (Rebase 2026-07-18.) Every booking preview now carries the doctrine's verdict — "confirm only what's
  irreversible or externally visible", i.e. a customer promise at stake. The board branches on that
  field: `false` → commit one-shot and toast what happened; `true` → in-UI confirm showing the
  promise-break warning. The plan's original always-confirm flow would have rebuilt on this surface
  the confirmation fatigue Feature A just removed from chat.
- **Discovery (rebase 2026-07-18): the menu button only renders in chats that have `/start`-ed the
  board bot** — nothing announces it exists. v1 = the operator records the board bot's @handle at
  setup and the manager shares it with the team once (same ritual as the agent-bot handle at
  onboarding). Wiring the AI agents to advertise it would touch AGENTS.md/bootstrap — files
  deliberately outside B's footprint — so that's deferred.
- **Notification state → in-memory per-tenant last-seen version, initialized to current on boot.** No
  new table (avoids a migration overlapping Feature A). Trade-off: a restart may skip notifications for
  events during downtime — acceptable at single-replica pilot scale; documented as a v1 limitation.
- **Board worker is a SEPARATE process** (`board:worker`), not folded into the web server — keeps the
  web process stateless (Architecture A invariant) and avoids duplicate notifications if the web tier
  ever scales to >1 replica.
- **STACKED after Feature A — now LANDED; plan rebased 2026-07-18 onto merged main (`c64d875`).**
  Feature A shipped: nullable `assignments.technician_id` (unassigned bookings), the `unassigned`
  per-stop field + `unassignedOnly` recall view on `get_team_schedule`, `requiresConfirmation` on
  every preview, and `moveVisit`'s optional `technicianRef` attach. The shape/confirm/notify sections
  below now describe the shipped code. Verified in git: A touched neither `src/db/technicians.ts` nor
  `src/mcp/httpServer.ts`, so B's footprint claims hold exactly. Implementation is unblocked.

## Plain-language walkthrough
A "Mini App" is a normal web page that opens *inside* Telegram when someone taps a button in a chat
with a bot. Telegram hands the page a signed slip (`initData`) proving who tapped it; our server checks
that signature and looks the person up on the roster to learn their firm and whether they're a manager.

```
[board bot on Render]  --setChatMenuButton(web_app)-->  Telegram app
   (plain code, no AI)                                     | user taps "Open board"
                                                           v
                              GET https://<render>/board  (static page, same origin)
                                                           | page JS reads WebApp.initData
                                                           v
   page --Authorization: tma <initData>--> /board/api/day  (NEW route, before IP allowlist)
        verify HMAC(BOARD_BOT_TOKEN) --> user id --> GLOBAL roster lookup --> tenant + tier + ref
        manager -> whole team's days   |   technician -> own day only (read-only)
                                                           v
   manager drags a stop -> /board/api/move (preview) -> requiresConfirmation?
        no  (nothing promised)  -> commit now + toast what happened  [reversible: just do + say]
        yes (promise at stake)  -> show promise-break warning, one tap -> commit
        [the SAME shared verb the agent uses; every guard fires — incl. attach via technicianRef]
```

- **Phase 1** builds the two pure pieces — verifying the Telegram slip and the global roster lookup —
  with no HTTP, so they're unit-tested in isolation. You'd notice it working when a hand-crafted
  valid slip verifies and a tampered one is rejected.
- **Phase 2** serves the page and the read API. You'd notice it when opening `/board` in a browser (or
  Telegram) shows the team's day for a manager — person-less visits in an "Unassigned" lane — and only
  your own stops for a technician.
- **Phase 3** adds the launch button and the manager write path (drag-to-move, drag-to-assign, cancel),
  reusing the shared verbs so promise-break confirms, one-shot commits, and overlap guards come for
  free — the board confirms exactly when the chat agent would, and only then.
- **Phase 4** is the "your day changed" push: a small worker polls `schedule_events` and sends canned
  Telegram messages via the board bot.

## Secrets & env preflight
- **Phase 1:** `BOARD_BOT_TOKEN` in `.env` — from BotFather when the operator creates the board bot
  (`/newbot`). Tests set it per-process (like `identity.test.ts` sets `GATEWAY_IDENTITY_SECRET`), so it
  is **not** required to run the suite. *New env var.*
- **Phase 2:** `BOARD_BOT_TOKEN` (as above, to verify initData); optional `BOARD_STATIC_DIR` (defaults
  to `web/board` under `process.cwd()`).
- **Phase 3:** `BOARD_BOT_TOKEN`; `BOARD_PUBLIC_URL` — the public HTTPS base URL of the Render web
  service (e.g. `https://trades-spine.onrender.com`), used for the launch button's `web_app.url`. *New.*
- **Phase 4:** `BOARD_BOT_TOKEN`, `BOARD_PUBLIC_URL` (same as Phase 3).
- **Preflight (downgraded at the 2026-07-18 rebase):** Feature A's rollout closed most of the old
  Plan-1 Phase-5 blocker — Render web runs merged main (`c64d875`) and the pilot DB is migrated and
  live-E2E-verified (real bookings/moves writing `schedule_events`). What remains is only the sheet-era
  backfill: pre-spine visits won't appear on the board until it runs — a data-completeness note for the
  Phase 2–4 live checks, not a build gate.

## Phase 1: initData verification + global roster lookup

### What this phase does
Two pure, HTTP-free modules the rest of the board stands on: server-side Telegram `initData`
verification, and a tenant-agnostic Telegram-id→roster lookup.

### Changes required
**`src/telegram/initData.ts`** (new)
- `verifyInitData(initDataRaw: string, botToken: string, maxAgeSec = 86400): { userId: string; user: TelegramUser; authDate: number }` — parse the URL-encoded string, pull out `hash`, build the
  data-check-string from the remaining fields sorted by key joined with `\n`, compute
  `secret = HMAC_SHA256(botToken, 'WebAppData')` then `HMAC_SHA256(dataCheckString, secret)`, compare
  hex to `hash` with `timingSafeEqual` (length-guard first, like `identity.ts:58`). Reject on bad
  signature, missing `user`/`hash`, or `auth_date` older than `maxAgeSec`. Return the numeric
  `user.id` **as a string** (matches `telegram_user_id` text/digits column).

**`src/db/technicians.ts`** (edit — new function beside `findTechnicianByTelegramUserId` at 34-45)
- `findRosterByTelegramUserIdGlobal(telegramUserId: string): Promise<{ technician: Technician } | { ambiguous: true; tenantIds: string[] } | null>` — select `technicians` by `telegram_user_id` across
  ALL tenants (no `tenant_id` filter), drop inactive via the single `isInactiveState` (352). 0 → null;
  rows spanning exactly 1 tenant → that first row; rows in >1 tenant → `{ ambiguous, tenantIds }`
  (v1 one-firm-per-account rule). Reuses `getClient()`; same error idiom as siblings.
- `listTenantIdsWithTelegramBindings(): Promise<string[]>` — distinct `tenant_id` for non-inactive rows
  with a non-null `telegram_user_id`; the Phase-4 worker's tenant set. (Kept in this file so both
  Telegram-roster helpers live together.)

### Automated verification
- [x] `npx tsc --noEmit` passes (2026-07-18, clean)
- [x] `npm run lint` passes (clean)
- [x] `npm test` passes — 492 passed / 1 skipped (43 files), 9 new tests
- [x] **new** `src/telegram/initData.test.ts`: a hand-built valid slip (compute the hash with a fixed
  token) verifies and returns the expected `userId`; tampered `hash`, missing `user`, wrong token, and
  an `auth_date` older than `maxAgeSec` each reject. *(Plus: truncated-hash length guard, tampered
  signed field, empty token, tight/wide maxAgeSec windows.)*
- [x] **new** `src/db/technicians.test.ts` cases (against the local stack): unknown id → null; one bound
  active row → that row; the same id bound in two tenants → `ambiguous`; an inactive-only match → null.
  *(Plus listTenantIdsWithTelegramBindings live-only/distinct cases.)*
- Adversarial review (fresh-context subagent): NO correctness gaps; HMAC scheme re-verified against the
  live Telegram doc (secret keyed 'WebAppData'; `signature` field correctly included in check string);
  newline-splice forgeries rejected via whole-string Number() on auth_date; length-guard-first idiom.

### Manual verification
- (none — both are codifiable)

---

## Phase 2: Board read API + static page

### What this phase does
Serve the Mini App page same-origin and a read API returning the day view — whole team for managers,
own stops for technicians — gated by verified `initData`.

### Changes required
**`src/schedule/boardRead.ts`** (new)
- `readBoardDays({ tenantId, from, to, viewerTechnicianId? }): Promise<{ scheduleVersion: number; days: {date; stops[]}[] }>` — mirror `get_team_schedule`'s body (server.ts:2155-2262 at `c64d875`,
  post-Feature-A): `latestScheduleVersion` BEFORE the snapshot, `listAssignmentsForTenant(tenant,
  fromISO, toISO, ['confirmed'])`, `listJobsWithCustomerByIds`, `listTeam`, bucket by
  `starts_at.slice(0,10)` clamped to `[from,to]`, same per-stop shape (`assignmentId, technicianRef,
  technicianName, unassigned, customer, address, start, end, promiseLevel, promisedDay, locked,
  status, jobId`) using `formatAddress`. **Feature A semantics:** `technician_id` is nullable —
  person-less rows carry `technicianRef`/`technicianName` `null` and `unassigned: true`. When
  `viewerTechnicianId` is set, keep only stops whose `technician_id === viewerTechnicianId`
  (technician self-view; unassigned rows drop out by construction — null never equals a viewer id).
  *(This module was the designated Feature-A re-check point; the shape above IS the shipped one,
  verified at the 2026-07-18 rebase. `get_team_schedule`'s `unassignedOnly` recall view is a chat
  feature, not duplicated on the board — in-window unassigned stops surface via the lane.)*

**`src/telegram/boardApi.ts`** (new)
- `isBoardPath(url)` → `/board` prefix. `handleBoardRequest(req, res, rawBody)` router:
  - `GET /board` or `/board/` → serve `web/board/index.html`; `GET /board/static/*` → serve the asset
    (whitelist `.js`/`.css`/`.html`, resolve under `BOARD_STATIC_DIR ?? path.resolve(process.cwd(),'web/board')`, block `..`), correct `content-type`. No auth (shell only, no secrets).
  - `GET /board/api/day?from=&to=` → `authBoard(req)` (below) → `readBoardDays` with `viewerTechnicianId`
    = null for managers, the row id for technicians → JSON `{ tier, self, ...days }`. Same
    validation contract as `get_team_schedule` (YYYY-MM-DD, from≤to, 14-day cap).
  - `authBoard(req)`: read `Authorization: tma <raw>` → `verifyInitData(raw, BOARD_BOT_TOKEN)` →
    `findRosterByTelegramUserIdGlobal(userId)`. Null → 401; ambiguous → 409 `{error:'account on
    multiple firms'}`; else return `{ tenantId, technician }`. Any failure → bare 401 (no detail),
    matching the file's posture.

**`src/mcp/httpServer.ts`** (edit — inside `handle`, add BEFORE `if (!allowed(req))` at line 241, after the `/control/sandboxes` block at 240)
- ```ts
  if (isBoardPath(req.url)) {
    await handleBoardRequest(req, res, await readRawBody(req));
    return;
  }
  ```
  Placed before `allowed()` for the same reason as `/inbound/` and `/control/`: board traffic comes
  from users' public browsers, not the gateway, so the IP allowlist must not gate it. It is
  self-authenticated by `initData`.

**`web/board/index.html`, `web/board/board.js`, `web/board/board.css`** (new)
- `index.html`: loads `https://telegram.org/js/telegram-web-app.js`, `board.css`, `board.js`. *(This is
  the one allowed external script — the page runs in the real Telegram webview, not an Artifact CSP.)*
- `board.js`: `WebApp.ready()/expand()`, read `WebApp.initData`, `fetch('/board/api/day', {headers:{Authorization:'tma '+initData}})`, render days→stops (promise/lock badges from `promiseLevel`/`locked`;
  no timezone math — print `start.slice(11,16)` and `promisedDay` verbatim per the naive-local rule).
  Manager view groups stops into per-technician lanes **plus an "Unassigned" lane** for stops with
  `unassigned: true` (`technicianName` is null — never render the string "null"); technicians see own
  stops only. Apply `WebApp.themeParams`.

### Automated verification
- [ ] `npx tsc --noEmit` / `npm run lint` / `npm test` pass
- [ ] **new** `src/telegram/boardApi.test.ts` (real `createHttpServer` on an ephemeral port, local DB —
  same harness as `httpServer.test.ts`, `BOARD_BOT_TOKEN` set per-process): `GET /board` → 200 HTML;
  `GET /board/api/day` with no header → 401; with a valid manager slip → all seeded stops; with a
  technician slip → only that technician's stops; a seeded unassigned visit (null `technician_id`) →
  present for the manager with `unassigned: true` + null name/ref, absent from every technician slip;
  a `../` static path → 403/404; a board path does NOT reach the MCP handler; a non-board path still
  does (guard the route-ordering).

### Manual verification
- [ ] Open `BOARD_PUBLIC_URL/board` in a desktop browser (no Telegram) — the page loads and shows a
  clear "open inside Telegram" empty state when `initData` is absent (visual/UX judgment).

---

## Phase 3: Launch button + manager write path

### What this phase does
Set the board bot's menu button so users can open the page, and let managers drive drag-to-move,
drag-to-assign (Unassigned lane → a technician's lane), and cancel through the shared verbs —
confirming only when `preview.requiresConfirmation` says a customer promise is at stake (Feature A's
doctrine); everything else commits one-shot and reports what happened.

### Changes required
**`src/telegram/boardBot.ts`** (new)
- Thin Bot API wrappers over `https://api.telegram.org/bot<BOARD_BOT_TOKEN>/<method>` using global
  `fetch`: `setBoardMenuButton()` → `setChatMenuButton` with `{type:'web_app', text:'Open board',
  web_app:{url: BOARD_PUBLIC_URL + '/board'}}`; `sendBoardMessage(chatId, text)` → `sendMessage`.
  Both return `{ok}`/throw on non-ok; no update listener.

**`src/telegram/boardApi.ts`** (edit)
- `POST /board/api/move` and `POST /board/api/cancel`: `authBoard` → **require `tier === 'manager'`**
  (else 403). Body `{assignmentId, date, startTime, endTime?, technicianRef?, reason}` (move — the
  optional `technicianRef` is Feature A's attach/reassign: dropping an Unassigned-lane visit onto a
  technician's lane passes that lane's ref; the overlap guard re-engages server-side) /
  `{assignmentId, reason}` (cancel). If `?preview=1` (or a `preview:true` body flag) → return
  `previewMoveVisit`/`previewCancelVisit` output **including `requiresConfirmation`** (plus
  promiseBroken, warning) and write nothing; otherwise call `moveVisit`/`cancelVisit` with
  `actorRef = technician.ref`. Surface `moveVisit`'s UNSCHEDULED failure string verbatim (do not
  swallow it — the UI must show the stranding).

**`web/board/board.js`** (edit)
- Drag a stop (between days/times, or from the Unassigned lane onto a technician's lane = assign) /
  tap "cancel" → POST with `preview` first, then branch on the preview's `requiresConfirmation`:
  `false` → POST the commit immediately and toast what happened ("Moved to Thu 12:00–13:00 — now with
  Jane" — say what you did, never silent); `true` → render the promise-break warning as an in-UI
  confirm, commit only on the tap. Never confirm a reversible internal change; never ask twice. On the
  UNSCHEDULED error, show the raw failure and refetch the day. Re-render from `/board/api/day` after
  any commit (read the new `scheduleVersion`).

**`src/telegram/boardWorker.ts`** (new — startup half; poll loop lands in Phase 4)
- `main()` calls `setBoardMenuButton()` once (idempotent), logs, then (Phase 4) enters the poll loop.

**`package.json`** (edit)
- Add `"board:worker": "node dist/telegram/boardWorker.js"` (Render Background Worker start command).

### Automated verification
- [ ] `npx tsc --noEmit` / `npm run lint` / `npm test` pass
- [ ] **new** `src/telegram/boardBot.test.ts`: `setBoardMenuButton`/`sendBoardMessage` build the correct
  URL + JSON body and handle `{ok:false}` — with global `fetch` stubbed (`vi.fn`), no network.
- [ ] `boardApi.test.ts` additions: technician slip → `POST /board/api/move` 403; manager `preview=1` →
  preview shape **with `requiresConfirmation`** (`false` for an unpromised visit, `true` when the move
  breaks a promised day), no DB write (assert row unchanged); manager commit → row moved + a `moved`
  `schedule_events` row (cross-channel read-back via `pg`, like `httpServer.test.ts`); **assign:**
  commit with `technicianRef` on an unassigned row → row gains that `technician_id`; the same drop
  onto a lane holding a clashing confirmed visit → the overlap-guard failure surfaces (no write).

### Live verification (agent-executable)
- Prerequisites: local Supabase stack + `createHttpServer` on an ephemeral port (codified above covers
  the write path). A real Telegram launch is human-only (below).

### Manual verification
- [ ] In Telegram, `/start` the board bot, tap the menu button, drag an unpromised visit to another
  day — it commits in one gesture and the toast says what happened (no confirm); drag a promised
  visit — the promise-break confirm appears first. Drop an Unassigned-lane visit onto a technician —
  the stop gains the name and the day re-renders (real-device UX).

---

## Phase 4: Change notifications

### What this phase does
A worker that turns `schedule_events` into canned Telegram pushes so a person learns their day changed.

### Changes required
**`src/telegram/boardNotify.ts`** (new)
- `pollOnce(lastSeen: Map<tenantId, number>)`: for each `listTenantIdsWithTelegramBindings()`, read
  `listScheduleEventsSince(tenant, lastSeen ?? latestScheduleVersion(tenant))`; for each event,
  resolve the affected people and `sendBoardMessage(userId, canned(kind, detail))` to each that has a
  `telegram_user_id`. **Feature A rebase — two null-technician realities:** (a) `assignment_id` →
  `getAssignmentForTenant` → `technician_id` can be **null** (unassigned booking/move) — skip that
  recipient cleanly, never crash; (b) a `moved` event hangs off the NEW row (booking.ts:543-554 at
  `c64d875`), so a reassignment must ALSO notify the person the visit was taken FROM — the event's
  `detail.previousAssignmentId` points at the old (cancelled) row, which still holds the old
  `technician_id`; resolve both rows and message old + new when they differ. Advance `lastSeen` to
  the max id seen. Canned text per `kind` (booked/moved/move_failed/cancelled). Best-effort per
  message (one failure never blocks the rest).
- On first run per tenant, seed `lastSeen = latestScheduleVersion` (notify only about post-boot events).

**`src/telegram/boardWorker.ts`** (edit)
- After `setBoardMenuButton()`, loop `pollOnce` on an interval (e.g. `BOARD_POLL_MS ?? 30000`), carrying
  the `lastSeen` map in memory. `run_in_background`-style long process; errors logged, never fatal.

### Automated verification
- [ ] `npx tsc --noEmit` / `npm run lint` / `npm test` pass
- [ ] **new** `src/telegram/boardNotify.test.ts` (local DB, `sendBoardMessage` stubbed): after a
  `bookVisit` for a Telegram-bound technician, one `pollOnce` sends exactly one message to that
  technician's id with the booked-copy; a second `pollOnce` with no new events sends nothing (last-seen
  advanced); an event for an unbound technician sends nothing; an UNASSIGNED booking (null technician)
  sends nothing and does not throw; a move reassigning bound tech A's visit to bound tech B sends one
  message to EACH (A: taken off the visit; B: it's now theirs).

### Manual verification
- [ ] With the worker running against the pilot, move a real visit and confirm the affected technician
  receives one Telegram message (real-device, cross-channel).

---

## File footprint
**New:**
- `src/telegram/initData.ts`
- `src/telegram/initData.test.ts`
- `src/telegram/boardApi.ts`
- `src/telegram/boardApi.test.ts`
- `src/telegram/boardBot.ts`
- `src/telegram/boardBot.test.ts`
- `src/telegram/boardWorker.ts`
- `src/telegram/boardNotify.ts`
- `src/telegram/boardNotify.test.ts`
- `src/schedule/boardRead.ts`
- `web/board/index.html`
- `web/board/board.js`
- `web/board/board.css`

**Modified:**
- `src/mcp/httpServer.ts` — board routes before the IP allowlist / MCP fallthrough
- `src/db/technicians.ts` — `findRosterByTelegramUserIdGlobal` + `listTenantIdsWithTelegramBindings`
- `src/db/technicians.test.ts` — global-lookup cases
- `package.json` — `board:worker` script

**Overlap with Feature A (settled at the 2026-07-18 rebase): none.** Feature A as merged touched
neither `src/db/technicians.ts` nor `src/mcp/httpServer.ts` (verified in git), so the exact-path
intersection is empty and `isInactiveState` is exactly as this plan assumes. The contract coupling
(per-stop shape, confirm model) is resolved by this rebase: `boardRead.ts` above specifies A's
shipped shape (incl. `unassigned`/nullable refs) and the write path branches on the shipped
`requiresConfirmation`. `src/mcp/server.ts`, `src/schedule/booking.ts`, and the assignments migration
remain **not** in B's footprint (fork (b) keeps them out).

## Assumptions
- **Non-interactive run:** I could not run the plan command's adversarial-review subagent (no Task tool
  in this harness). I did a self-review against every file the plan modifies; a human adversarial review
  before `/implement` is still recommended per the RPI gate.
- **Telegram/Bot API facts** (initData HMAC, `setChatMenuButton` needs no BotFather, HTTPS required,
  `auth_date` policy is ours) are taken as verified in the two research docs (live-checked 2026-07-17);
  not re-derived.
- **Render deploys the full repo** (so `web/board/*` at repo root is present at `process.cwd()`); the
  web service is a single replica (justifies the separate stateless-web / stateful-worker split and the
  in-memory notification state). If the web tier scales, revisit the worker's singleton assumption.
- **`Authorization: tma <raw>`** is the transport for `initData` (Telegram's documented convention);
  the page and API are same-origin so no CORS is configured.
- **Feature A is merged and live** (PR #48, `c64d875`; pilot migrated + live-E2E-verified 2026-07-18).
  The re-check this plan called for was performed at the 2026-07-18 rebase: the shape, confirm-model,
  and notifier sections above describe the shipped code, verified against `src/mcp/server.ts` and
  `src/schedule/booking.ts` at that commit.
- **v1 write scope = move + cancel** (new-booking deferred); **notifications are best-effort** and may
  skip events during a worker restart.

## Parallel/stack verdict (plan-two)
**Recommendation: STACKED — land Feature A (foundation) first, then re-check/rebase this plan.**

**[RESOLVED 2026-07-18: Feature A merged (`c64d875`) and this plan is rebased. The reasoning below is
the historical record of the plan-two comparison — its predictions about A's shape changes came true
and are now folded into the phases above; the risk areas are all addressed (shape rebased, null-tech
handling in Phases 2–4, verb signatures confirmed additive, Plan-1-Phase-5 blocker downgraded in the
preflight). Implementation is unblocked.]**

**Reasoning.** Exact-path file intersection with Feature A is empty, but the two plans are semantically
coupled through the schedule **per-stop read shape** and the **`assignments.technician_id` column type** —
enough that parallel implementation would produce a silent divergence rather than a clean merge:
- This plan's new `src/schedule/boardRead.ts` is a deliberate hand-copy of `get_team_schedule`'s per-stop
  object (server.ts:2091-2143). Feature A **rewrites that object** (Phase 2 adds
  `unassigned: technician_id === null`) and **changes the column** (Phase 1 drops `NOT NULL`, so
  person-less rows resolve `technicianRef`/`technicianName` to null). Built in parallel on today's
  foundation, `boardRead.ts` would omit `unassigned` and its `technician_id === viewerTechnicianId`
  self-view filter would be written against a column that A makes nullable. A textual merge would not flag
  this — the duplicate just goes stale.
- The write path is already insulated: this plan drives moves/cancels through the `booking.ts` verbs
  directly (Decision "fork (b)"), and A's `booking.ts` edits are additive (`endTimeDefaulted`, optional
  `technicianRef`, `previewCancelVisit` gains `promiseLevel`), so B's verb callers survive A unchanged.
- The `src/db/technicians.ts` overlap this plan flagged is **resolved, not blocking**: A's final plan
  leaves `technicians.ts` and `isInactiveState` **untouched** (A Decision 2 + footprint), so this plan's
  new `findRosterByTelegramUserIdGlobal`/`listTenantIdsWithTelegramBindings` and their `isInactiveState`
  call are unaffected. Hence no exact-path conflict — but the read-shape coupling above still forces
  A-first.

This matches this plan's own "STACKED after Feature A" decision. The coupled surface is centralized in
`boardRead.ts` + `board.js`'s render, so once A lands, only those need re-checking. **Do not `/implement`
this before Feature A merges.**

**Shared files (exact-path intersection): none.** Coupling travels through different files: A edits
`src/mcp/server.ts` `get_team_schedule` and adds the nullable-technician migration; this plan duplicates
that shape in new `src/schedule/boardRead.ts`. Both plans touch `src/db/technicians.ts` only additively
(this plan adds functions; A adds none) — no conflict.

**Risk areas.**
- `src/schedule/boardRead.ts` — rebase onto Feature A's final per-stop shape (`unassigned` field, null
  `technicianRef`/`technicianName`) before/at integration; it is the single re-check module by design.
- Null-technician (unassigned) rows from A's migration — handle in the self-view filter, the manager-view
  render, and `board.js` (null `technicianName`); technician self-view already excludes them correctly
  (null never equals a viewer id).
- `booking.ts` verb signatures the board write path calls (`previewMoveVisit`/`moveVisit`/
  `previewCancelVisit`/`cancelVisit`) — A's changes are additive; confirm no required-arg drift at merge.
- Prerequisite (orthogonal to A): Plan 1 Phase-5 pilot rollout (backfill + Render redeploy) still
  unchecked — required for this plan's live E2E, not for building/testing on the local stack.
