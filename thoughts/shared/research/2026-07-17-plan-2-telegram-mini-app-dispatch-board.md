---
date: 2026-07-17
branch: fix-booking-promise-default
commit: 97b8dcc
topic: Plan 2 (Telegram Mini App dispatch board) — focused delta research after Plan 1 landed; what the schedule core now provides, what a Mini App must still build, and the browser+Telegram seam verified against live Telegram docs
---

## Summary

This is a **focused follow-up** to [2026-07-14-scheduling-mini-app-gap-analysis.md](2026-07-14-scheduling-mini-app-gap-analysis.md),
narrowed to Plan 2 of the Telegram-schedule series — the **dispatch board**. Plain-language framing:
a "Mini App" is a normal web page that opens *inside* Telegram when someone taps a button in a
chat with a bot; Telegram hands the page a signed blob (`initData`) proving who tapped it, and the
page's backend checks that signature to trust the user. The decided v1 shape (recorded in memory
`telegram-schedule-series`) is **one global, non-AI "board" bot running as plain code on Render**,
serving a launch button + the web page to **both managers and technicians** (technicians get a
read-only day view), with tenant isolation coming from a roster lookup of the verified Telegram
user id — not from the bot.

Two things changed since the 2026-07-14 gap analysis, and they pull in opposite directions:

1. **Plan 1 landed and pre-built most of Plan 2's *data* surface.** The booking verbs, the team
   read, the version feed, and the roster↔Telegram mapping now all exist and are explicitly
   annotated as Plan 2's reuse points. The gap analysis's Decision Points **1, 2, 3, 6, and 7 are
   now resolved in code.** A dispatch board reading days and driving drag-to-move would call
   functions that already ship.
2. **The *browser + Telegram* surface is still 100% greenfield.** A repo-wide grep confirms **no
   Telegram Bot API call, no bot token, no `initData` verification, no static-file serving, and no
   CORS handling exist anywhere in `src/`.** The Render web service is still a bare `node:http`
   server whose MCP handler serves every unrouted path. Gap-analysis Decision Points **4 and 5
   remain fully open at the code level** (though 5 is decided *in principle*: a Render-owned board
   bot).

The single load-bearing unknown the gap analysis flagged — *"does the bot layer even support
`web_app` launch buttons?"* — is now **answered for the decided architecture**: because the board
bot is a **separate, Render-owned, plain-code bot** (not a NemoClaw/OpenClaw sandbox bot), it can
launch a Mini App with the **standard Bot API and no BotFather step**, and validate `initData` with
its own token (see External Dependencies for the cited algorithm). The vendor-capability question
only re-appears if someone later wants to launch the board from *inside* a per-person agent chat.

## Entry Points

Where Plan 2 work would attach, in the code as it stands today:

- **The write primitives (already Plan-2-labelled):** [src/schedule/booking.ts:1-6](../../src/schedule/booking.ts#L1-L6)
  — module header states verbatim that "The MCP tools (Phase 3), **the Mini App (Plan 2)**, and the
  auto-scheduler (Plan 3) all call THESE." Verbs: `bookVisit` [booking.ts:242](../../src/schedule/booking.ts#L242),
  `moveVisit` [booking.ts:419](../../src/schedule/booking.ts#L419), `cancelVisit`
  [booking.ts:517](../../src/schedule/booking.ts#L517); previews `previewBookVisit`
  [booking.ts:218](../../src/schedule/booking.ts#L218), `previewMoveVisit`
  [booking.ts:395](../../src/schedule/booking.ts#L395), `previewCancelVisit`
  [booking.ts:498](../../src/schedule/booking.ts#L498).
- **The board read (already the right shape):** `get_team_schedule` tool definition at
  [src/mcp/server.ts:519](../../src/mcp/server.ts#L519); dispatch/body at
  [src/mcp/server.ts:2063-2143](../../src/mcp/server.ts#L2063-L2143). Returns `{status, from, to,
  scheduleVersion, days:[{date, stops:[…]}]}`.
- **The version / notification feed:** `latestScheduleVersion`
  [src/db/scheduleEvents.ts:40](../../src/db/scheduleEvents.ts#L40) and `listScheduleEventsSince`
  [src/db/scheduleEvents.ts:54](../../src/db/scheduleEvents.ts#L54) — the latter's comment names it
  "Plan 2 board notifications."
- **The roster↔Telegram identity anchor:** `bind_telegram` tool dispatch at
  [src/mcp/server.ts:2809](../../src/mcp/server.ts#L2809) (writes `technicians.telegram_user_id`);
  lookup `findTechnicianByTelegramUserId` at [src/db/technicians.ts:34-45](../../src/db/technicians.ts#L34-L45).
- **The server seam a browser surface must join:** the whole routing table in
  [src/mcp/httpServer.ts:224-268](../../src/mcp/httpServer.ts#L224-L268); the MCP fallthrough that
  swallows every unrouted path is [httpServer.ts:253-260](../../src/mcp/httpServer.ts#L253-L260).
- **The identity seam a Telegram auth path would sit beside:** `resolveIdentityFromHeaders`
  [src/mcp/identity.ts:41-63](../../src/mcp/identity.ts#L41-L63) (gateway HMAC, no Telegram
  awareness).

## Key Files

**Schema (new since the gap analysis):**
- [supabase/migrations/20260714120000_schedule_core_promise_ladder.sql](../../supabase/migrations/20260714120000_schedule_core_promise_ladder.sql)
  — Plan 1's migration. Adds to `assignments`: `promise_level` enum(`none`|`day`|`time`),
  `promised_day date`, `locked boolean`, and a CHECK that a non-`none` promise has a `promised_day`.
  Creates `schedule_events` (append-only change log; `id` is a global identity sequence = the
  tenant's monotonic **version token**) with a **DB-enforced append-only trigger**
  (`schedule_events_append_only`, reusing `raise_append_only()` from `raw_captures`). *(Applied to
  the pilot DB: see Open Questions — Phase 5's live apply was still unchecked in the plan.)*

**Write primitives — `src/schedule/booking.ts` (new; Plan 1 Phase 2):**
- Pure, deterministic verbs + previews. `preview* == commit` by design (shared `resolveBooking` /
  `resolveMove` front-half). Every guard (tenant-scoping, roster resolution, overlap PRE-check,
  day-level availability *warning*) fires for whatever surface calls it — so a Mini App inherits
  them for free.
- Storage convention: **naive-local** (`naiveLocalISO`, [booking.ts:43](../../src/schedule/booking.ts#L43)),
  local wall-clock written as if UTC.
- **Default promise is now `'none'`** ([booking.ts:197](../../src/schedule/booking.ts#L197)) — a
  post-Plan-1 change (commit `97b8dcc`, current branch) that **reverses the Plan-1 written default
  of `'day'`.** A booking now promises the customer nothing unless the manager's words show a
  promise. Relevant to Plan 2 because the board's promise/lock badges render this field.
- `moveVisit` computes `promiseBroken` and re-books as `'confirmed'` (a default `'proposed'` row
  would vanish from every reader); a raced overlap after the cancel leaves the visit **UNSCHEDULED**
  and says so — a drag-to-move UI must surface that failure state, not assume success.

**Board read — `get_team_schedule` ([server.ts:2063-2143](../../src/mcp/server.ts#L2063-L2143)):**
- Manager-gated (in `ADMIN_TOOLS`). 14-day cap, firm-local default day, `['confirmed']` only.
- Reads `scheduleVersion` **before** the snapshot (deliberate: a booking landing mid-read makes a
  later "changed since vN?" check fire a false-positive rather than vouch for a stale snapshot).
- Per-stop shape: `{assignmentId, technicianRef, technicianName, customer, address, start, end,
  promiseLevel, promisedDay, locked, status, jobId}`. Underlying queries: `listAssignmentsForTenant`
  + `listJobsWithCustomerByIds` + `listTeam` + `latestScheduleVersion` — the exact set a browser
  REST endpoint would reuse if the board bypasses the agent.

**Version feed — `src/db/scheduleEvents.ts` (new):** `appendScheduleEvent`, `latestScheduleVersion`
(0 = none), `listScheduleEventsSince(tenantId, afterId, limit=100)`. This is the primitive for
"what changed since you looked" board pushes and Plan-3 version-pinned questions.

**Roster↔Telegram — `src/db/technicians.ts`:** `findTechnicianByTelegramUserId(tenantId,
telegramUserId)` [technicians.ts:34-45](../../src/db/technicians.ts#L34-L45) — **tenant-scoped**
(requires a `tenantId`), returns the first non-inactive match. `technicians.telegram_user_id` is
text/digits-only (added in `20260707000000_telegram_binding_and_sandbox_pool.sql`), only ever
compared. `bind_telegram` ([server.ts:2809](../../src/mcp/server.ts#L2809)) is the manager tool
that sets it (from `@userinfobot`'s numeric id).

**Server seam — `src/mcp/httpServer.ts` (unchanged since the gap analysis):** routes `/inbound/*`
(Composio webhook HMAC), `GET /control/badges` + `POST /control/sandboxes` (host bearer token),
`/composio*` (relay), then an **MCP fallthrough serving every other path**
([253-260](../../src/mcp/httpServer.ts#L253-L260)). No framework, static hosting, CORS, cookie, or
session machinery. Optional `ALLOWED_CLIENT_IPS` gates only the MCP/relay paths.

**Identity seam — `src/mcp/identity.ts` (unchanged):** `resolveIdentityFromHeaders` verifies an
HMAC-SHA256 over `"<tenantId>.<technicianRef>"` with `GATEWAY_IDENTITY_SECRET`; no timestamp/nonce;
comment marks it the future JWT swap point. **No Telegram `initData` verification exists.**

**Retired since the gap analysis (Plan 1 Phase 5, confirmed deleted):** `src/schedule/sheetSync.ts`,
`src/schedule/refSuggest.ts`, `src/db/scheduleEntries.ts`; the `ROUTE_DAY_SOURCE` flag is gone
([daySource.ts](../../src/routes/daySource.ts) now reads `assignments` only). The `schedule_entries`
**table** remains as frozen history (no drop migration).

## Data Flows

**1. The board READ path that already works (via the agent today; the Mini App would mirror it):**

```
manager agent → get_team_schedule(from,to)                    [server.ts:2063]
   manager-gated · 14-day cap · firm-local default day
        │
        ├─ latestScheduleVersion(tenant)      ── version token BEFORE snapshot
        ├─ listAssignmentsForTenant(tenant, fromISO, toISO, ['confirmed'])
        ├─ listJobsWithCustomerByIds(...)      ── customer + address
        └─ listTeam(tenant)                    ── technician_id → ref/name
        ▼
{ status:'ok', from, to, scheduleVersion,
  days:[ {date, stops:[ {assignmentId, technicianRef, technicianName,
          customer, address, start, end, promiseLevel, promisedDay,
          locked, status, jobId} ]} ] }
```

**2. The board WRITE path that already works (staged confirm; a drag-to-move would call the same
verbs, minus the chat two-step if the Mini App confirms in-UI):**

```
book_visit/move_visit/cancel_visit (stage) → preview + confirmId   [house two-step]
        │   (Mini App could instead call previewX() then X() directly)
        ▼
bookVisit / moveVisit / cancelVisit           [booking.ts — shared guards]
   overlap PRE-check → (mint job shell) → createAssignment('confirmed', promise, locked)
        │   DB exclusion constraint = the authority under races
        ▼
appendScheduleEvent(kind) → schedule_events   ── version bumps; feeds flow 3
```

**3. The "changed since you looked" feed (exists; unused by any surface yet):**

```
board remembers lastVersion → listScheduleEventsSince(tenant, lastVersion)   [scheduleEvents.ts:54]
        ▼  rows: {id, kind: booked|moved|move_failed|cancelled|completed|backfilled, detail, …}
   → render deltas / push canned Telegram notifications (Plan 2 to build the push side)
```

**4. The Telegram launch + auth path that DOES NOT EXIST YET (what Plan 2 must build), overlaid
with the verified Telegram algorithm:**

```
[Render-owned board bot]  ──sendMessage(inline web_app button)──►  Telegram client
        (standard Bot API, no BotFather step)                          │ user taps
                                                                       ▼
                                          opens https://<render>/board  (Mini App page, HTTPS)
                                                                       │ JS bridge hands page initData
                                                                       ▼
   page POSTs initData ──►  NEW Render route (does not exist)  ── verify:
        secret = HMAC_SHA256(BOARD_BOT_TOKEN, "WebAppData")
        check  = sorted(fields\hash) joined by '\n'
        ok if  hex(HMAC_SHA256(check, secret)) == initData.hash
                                                                       ▼
   initDataUnsafe.user.id  ──►  roster lookup  ──►  tenant + tier + technicianRef
        ⚠ findTechnicianByTelegramUserId is TENANT-SCOPED; a global bot has no tenant yet
                                                                       ▼
   authorized → serve board data (flow 1) / accept drag-to-move (flow 2)
```

## External Dependencies

**Telegram Mini Apps / Bot API — verified live 2026-07-17** against
`https://core.telegram.org/bots/webapps` and `https://core.telegram.org/bots/api` (per the repo's
"verify external services against live docs" rule). Load-bearing facts for Plan 2:

- **`initData` HMAC verification (server-side):** `secret_key = HMAC_SHA256(<bot_token>,
  "WebAppData")` — note the order: the **bot token is the *data*** and the literal string
  `"WebAppData"` is the **key**. Build the *data-check-string* from all received fields **except
  `hash`**, sorted **alphabetically by key**, each as `key=<value>`, joined by a **`\n` (0x0A)**.
  Authentic iff `hex(HMAC_SHA256(data_check_string, secret_key)) == hash`.
  — https://core.telegram.org/bots/webapps
- **Third-party Ed25519 `signature` path (exists):** `initData` also carries a `signature`
  (base64url Ed25519) validated with Telegram's **public key** and **no bot token** — data-check
  string is `"<bot_id>:WebAppData\n" + sorted(fields except hash AND signature)`. Prod public key
  `e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d`. Relevant if the board backend
  should *not* hold the bot token, or to disambiguate which bot a request is for by `bot_id`.
  — https://core.telegram.org/bots/webapps
- **`auth_date` freshness:** Telegram *recommends* checking `auth_date` to reject stale data but
  **mandates no specific expiry window** — the freshness policy is ours to choose.
  — https://core.telegram.org/bots/webapps
- **Launch buttons that need NO BotFather step (pure Bot API):** inline-keyboard `web_app` button
  (returns a `query_id`; bot replies via `answerWebAppQuery`), reply-keyboard `web_app` button
  (page returns data via `Telegram.WebApp.sendData()`), and the chat **Menu Button** set
  programmatically via `setChatMenuButton`. **BotFather required only** for: direct-link/named Mini
  App (`t.me/<bot>/<short_name>`), the "Main Mini App", and the attachment menu. For the pure-API
  buttons you pass the Mini App `url` **directly in the call** — no domain-whitelisting step.
  — https://core.telegram.org/bots/webapps ; https://core.telegram.org/bots/api
- **Which token validates:** the **same** bot's token that owns the launch button (HMAC path). One
  hosted page *can* serve multiple bots, but the backend must pick the correct token/`bot_id` per
  request — this is an inference from the algorithm, **not an explicitly documented guarantee**.
  — https://core.telegram.org/bots/webapps
- **Hosting:** the Mini App URL **must be HTTPS** with a valid certificate.
  — https://core.telegram.org/bots/webapps
- **JS bridge** (`<script src="https://telegram.org/js/telegram-web-app.js">`): `WebApp.initData`
  (raw string to validate — the *only* trustworthy field), `initDataUnsafe` (parsed, **not to be
  trusted for auth**), `themeParams`/`colorScheme`, `ready()`, `expand()`, `sendData()` (reply-
  keyboard-launch only), `close()`. — https://core.telegram.org/bots/webapps
- **Caveat carried from the verification:** the Bot API single page truncated before the verbatim
  `KeyboardButton`/`InlineKeyboardButton` `web_app` field notes; there is a *"private chats"*-style
  restriction on some `web_app` launches. Technicians sit in private 1:1 bot chats, so this is
  expected to be fine, but confirm the exact wording at `/bots/api` if it becomes load-bearing.

**Unchanged deps** (from the gap analysis): Google Routes API (`get_schedule`), Supabase via
`src/db/`, MCP SDK. **`googleapis` stays in `package.json`** (`src/email/ingest.ts` imports it) even
though the sheet sync is gone.

## Constraints and Invariants

- **Plan 1 already owns the schedule; the board is a new *surface* on existing data.** `assignments`
  is the single store; `schedule_entries` is frozen history; readers run off `assignments` only.
- **`preview == commit`** across the booking verbs — a Mini App must show what commit will write; it
  should render the preview output, not recompute its own.
- **Naive-local time storage** and **UTC-day bucketing** carry over (memory `telegram-schedule-series`).
  A board rendering "Tuesday" reads `promised_day`/`starts_at.slice(0,10)`; it must not apply
  timezone math or it will disagree with every reader.
- **`schedule_events` is append-only at the DB level** (trigger). The version token only ever moves
  forward; the board can trust it for staleness detection.
- **Identity is boundary-established, never argument-supplied.** Today that boundary is the gateway
  HMAC header. A Mini App introduces a **second, independent** identity boundary (Telegram
  `initData`) that the current `resolveIdentityFromHeaders` knows nothing about — the two must be
  reconciled (see Decision Points).
- **`findTechnicianByTelegramUserId` is tenant-scoped.** For the decided **single global board bot**,
  a verified `initData` yields only a Telegram *user id*, with **no tenant**. Resolving user id →
  tenant needs a **tenant-agnostic** lookup that does not exist today, plus a rule for the
  ambiguous "one Telegram account on two rosters" case (memory records the v1 rule: *one firm per
  account*, firm-picker later).
- **`get_team_schedule` is manager-gated**, but Plan 2's audience includes **technicians**
  (read-only day view). The technician read path today is the self-only `get_schedule`; a
  technician board view needs either that tool's data shaped for the browser or a new read scoped to
  self. Manager-vs-technician tier already lives on the roster row the Telegram lookup returns.
- **Bots cannot message first.** A person must open the board bot and `/start` before it can send
  them a launch button (same constraint the per-person bots already have; the board bot's `@handle`
  must be discoverable).
- **Product doctrine shift is now real, not hypothetical:** the Mini App is a hosted web front end —
  the first UI outside Telegram-agent-chat. Memory `telegram-only-surface` records this as a
  deliberate, decided scope extension (the Mini App still *lives inside* Telegram).

## Decision Points

Choice points the **current** code creates for Plan 2. The gap analysis's DPs 1/2/3/6/7 are now
**resolved** by Plan 1 and are not repeated; DPs 8/9 belong to Plans 3/4. What remains for Plan 2:

1. **Where the Mini App is served (gap-analysis DP4, still open).** The Render web service is a bare
   `node:http` server whose MCP handler serves every unrouted path
   ([httpServer.ts:253-260](../../src/mcp/httpServer.ts#L253-L260)). Options: (a) add browser routes
   (static asset serving, a JSON read/write API, an `initData`-verify endpoint, CORS) **before** the
   MCP fallthrough in this same process; (b) stand up a **separate** Render service/process for the
   board bot + web app, talking to the same DB via `src/db/`. Either way there is no framework,
   CORS, cookie, or session machinery to inherit.
2. **How the board reaches schedule data — through the agent, or a new browser API.** The data
   functions exist (`get_team_schedule`'s underlying queries + the `booking.ts` verbs). Fork: (a)
   the Mini App calls the **MCP tools** as the agent does (reuses tier-gating + confirm-token
   machinery, but needs an MCP client with a forged-safe identity for a browser); (b) new **REST
   endpoints** that call the shared query/verb functions directly (browser-native, but a *new* auth
   path — the `initData` identity — and it re-implements tier-gating outside the tools). The
   `get_team_schedule` shape and the `preview*/verb` split make either viable.
3. **Which bot token signs the launch, and where it lives (gap-analysis DP5, decided in principle,
   unbuilt in code).** The user decided a **new Render-owned, non-AI board bot**. Consequence per
   the verified docs: that bot can launch via pure Bot API (no BotFather step) and its token
   validates `initData`. Remaining concrete choices: **where the board bot token is stored** (a new
   Render env var, e.g. `BOARD_BOT_TOKEN`) and whether the verify endpoint uses the **HMAC path**
   (backend holds the token) or the **Ed25519 path** (backend holds only Telegram's public key +
   `bot_id`). Today Render holds **no** bot token and there is **no** initData verify code.
4. **How a global bot resolves tenant + tier from a Telegram user id.** `findTechnicianByTelegramUserId`
   is tenant-scoped ([technicians.ts:34](../../src/db/technicians.ts#L34)). Options: (a) a new
   tenant-agnostic lookup (Telegram id → roster row across all tenants) plus the "one firm per
   account" ambiguity guard the memory records; (b) keep tenant-scoped and require the tenant to be
   carried in `start_param` (the `startapp=` value in the launch link), trading the global-lookup
   build for a per-tenant launch-link build. This is the identity crux of the "one global bot"
   design and has no code today.
5. **Technician audience.** Plan 2 includes technicians (read-only day view), but the only
   team-wide read (`get_team_schedule`) is manager-gated and the self-only read (`get_schedule`)
   is a route tool. Fork: (a) a new read scoped to the verified person's own day for the board; (b)
   reuse `get_team_schedule`'s queries with a tier check that returns only self-rows for technicians.
6. **The notification "push" side.** `listScheduleEventsSince` gives the *pull* feed; a board that
   "pings when your day changes" needs the board bot to **send** Telegram messages (pure Bot API
   `sendMessage`), driven by polling the version feed or a DB trigger. No sender exists on Render
   today. (Distinct from Plan 4's *customer* notifications, which remain an open fork.)

## Open Questions

Resolved since the gap analysis (do not re-ask): which store (assignments), the ladder shape
(columns), day-vs-time coexistence (naive-local + stored `promised_day`), manager cross-person reads
(`get_team_schedule` exists), and the sheet's direction (retired). Newly answered: a plain
Render-owned bot **can** launch a Mini App with no BotFather step (cited above).

Still needing testing or a human to resolve:

- **Is Plan 1's Phase 5 live rollout actually done on the pilot?** The plan's Phase 5 *live* and
  *manual* checkboxes were unchecked: migration applied to the pilot, `--hosted` backfill run,
  Render web+cron redeploy (cron no longer running `sheetSync`), and the manager-facing "sheet is
  frozen" note. If the migration is **not** yet applied to the pilot DB, `promise_level`/`locked`/
  `schedule_events` don't exist there and a board built on them would read an older schema. **Verify
  the pilot ledger before Plan 2 assumes the columns exist.** (The current working branch is
  `fix-booking-promise-default`, a post-merge follow-up, so main + pilot state should be
  reconfirmed.)
- **Does the pilot `assignments` table have real rows yet?** If the backfill hasn't run, the board
  would render empty for the pilot regardless of code correctness.
- **The exact Bot API `web_app` private-chat restriction wording** (the truncated section) — confirm
  at `/bots/api` if the board must launch from anywhere other than a private 1:1 chat.
- **`start_param` vs global lookup** — if tenant is carried in the launch link (`startapp=`), the
  launch-link generation becomes per-tenant; confirm whether the "one global bot, one launch link
  for everyone" mental model in memory intends a single link (→ needs the global lookup) or a
  per-tenant link (→ `start_param`).
- **Board bot discovery/handle** — a person must `/start` the board bot before it can push; how the
  board bot's `@handle` is surfaced to managers and technicians (onboarding step) is unspecified.
- **Does OpenClaw/NemoClaw expose `web_app` launch buttons?** Now **only relevant** if a later layer
  wants to launch the board from inside a per-person agent chat; irrelevant to the decided v1
  (separate Render bot). Still unverified in the vendor's docs.
