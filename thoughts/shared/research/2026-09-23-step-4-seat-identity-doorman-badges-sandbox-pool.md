---
date: 2026-09-23
branch: work/step-4-per-seat-tokens-replace-the-doorm
commit: c655f91
topic: Step 4 — how a seat proves who it is to the spine today (doorman, badges, HMAC headers, sandbox_pool, hosts), and what per-seat tokens would replace
supersedes: nothing
---

# Step 4: seat identity as it exists today

## Summary

A **seat** is one person's AI chat assistant (a Telegram bot plus the agent behind it). When a
seat calls a spine tool (read the schedule, file a note), Render's MCP server (the Model Context
Protocol endpoint that serves the tools) must know *which firm and which person* the call is for,
and it must not take that from anything the model could type. Today that proof travels as three
HTTP headers — `x-tenant-id`, `x-technician-ref`, and `x-identity-signature`, an HMAC (a keyed
checksum) of the first two made with one shared secret, `GATEWAY_IDENTITY_SECRET`. On the old
openclaw seats a host process on the box, the **doorman**, stamps those headers after checking a
**badge** (a random bearer token per person) against a fingerprint file, `badges.json`, that a
5-minute timer (`badge-pull.sh`) downloads from Render. Step 1's new **seat glue** skips the
doorman and signs the headers itself with the shared secret. Around this sits a second, separate
machine-identity system — the **host token** (`HOST_PULL_TOKEN` → `hosts.token_hash`) that every
box script uses for `/control/*` — and a **sandbox pool** (`sandbox_pool` table) that hands each
person a pre-built sandbox, a sandbox ref (`s5`), and a Telegram bot. Step 4 is the plan to
replace the badge/doorman/shared-secret path with one token per seat minted by Render, and to have
Render tell the seat its firm timezone. This document maps every piece that path touches.

```
TODAY — two seat paths into the same /mcp endpoint, plus the box's own machine path

 openclaw seat (s1..s4)                      seat glue (s5, step 1)
 sandbox holds badge (plaintext,             /etc/seat-glue/s5.env holds
 OpenShell provider store)                   GATEWAY_IDENTITY_SECRET (+ SEAT_TZ by hand)
        │ Authorization: Bearer <badge>              │
        ▼                                            │ signs x-identity-signature itself
 doorman.mjs (box, :3001)                            │ (src/seatGlue/identity.ts)
   sha256(badge) → badges.json[fp]                   │
   → signs HMAC(secret, "tenant.ref")                │
        │                                            │
        └──────────────► Render /mcp  ◄──────────────┘
                         identity.ts:41 verifies HMAC
                         server.ts:620 loads roster row, refuses inactive

 box scripts (badge-pull, nudge/office runners, seat-sync, recycler, box-report)
   Authorization: Bearer HOST_PULL_TOKEN ─► Render /control/*  (hosts.token_hash)
```

## Entry Points

- `src/mcp/httpServer.ts:983-995` — the catch-all MCP endpoint. Any path not matched earlier is
  the spine; `resolveIdentityFromHeaders(req.headers)` (:984) runs first, and any throw becomes a
  bare 401 (:989-995).
- `src/mcp/httpServer.ts:977` — `/composio` relay (`isRelayPath`, `src/composio/relayHandler.ts:52`),
  also identity-by-HMAC (`relayHandler.ts:489`).
- `src/mcp/httpServer.ts:838-889` — the nine `/control/*` routes, all host-token authenticated.
- `Box_Setup_Stuff/doorman.mjs` — the box-side identity stamp for openclaw sandboxes.
- `Box_Setup_Stuff/badge-pull.sh` — 5-minute timer that pulls `/control/badges`.
- `src/seatGlue/engine.ts:112-122` — where the glue attaches identity headers to its MCP server
  config.
- `scripts/assign-host.mjs` — operator CLI that creates hosts, pool rows, bots, and rotates badges.

## Key Files

### Render side — verification

- **`src/mcp/identity.ts`** (63 lines)
  - `RequestIdentity { tenantId; technicianRef; scopes? }` (:13-17). No firm settings, no tier,
    no timezone.
  - `identityFromEnv()` (:21-27) — stdio/dev: `DEFAULT_TENANT_ID` / `DEFAULT_TECHNICIAN_REF`.
  - `resolveIdentityFromHeaders(headers)` (:41-63) — reads the three headers, recomputes
    `HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "${tenantId}.${technicianRef}")` (:54), length-guard then
    `timingSafeEqual` (:58). Comment :40: "Swapping this one function for JWT validation is the
    future Option B migration."
- **`src/mcp/server.ts`**
  - `ServerDeps.identity` (:68); deps seams `requestRetirement?` / `cancelRetirement?` (:78-79),
    imported from sandboxPool as `liveRequestRetirement` / `liveCancelRetirement` (:12-13).
  - tools/list (:940-955): `isActiveManager(deps.identity)` (`src/mcp/tools/shared.ts:775-778`)
    picks `MANAGER_TOOLS` or `TOOLS`.
  - `dispatch` (:591): `getTechnician(tenantId, identity.technicianRef)` (:620); an inactive
    caller throws (:621-623); `activeManager` (:627); then the gate sequence (cost event :634,
    `spine:` ceiling :666, team-lead-only :677, `record_caller` :696, admin :705, manager refusals
    :712/:721, sensitivity :733). Handlers get `{identity, tenantId, caller, activeManager, …}`
    (:742-753).
  - `groundingNow` (:903-932): firm timezone read via `getTenant(tenantId)` with a 10-minute
    `tzCache`, `?? 'UTC'`; every tool result carries a `now` line naming the timezone (:931,
    :998-1016).
- **`src/composio/relayHandler.ts`** (585 lines) — `handleComposioRelay` (:481). Identity by the
  same HMAC (:489), then `getTechnician` (:491-495): no row → 403 "no roster row for this badge",
  inactive → 403. Uses `technicians.composio_session_id`, mints a session on demand (:500-510).
  Rebuilds outbound headers from scratch; identity headers are never forwarded (:541, :552).
  Does **not** read `sandbox_pool`.

### Render side — badges and the control plane

- **`src/control/badges.ts`** (21 lines) — `sha256hex` (:9), `mintBadge()` (:18-21):
  `randomBytes(32)` hex, returns `{badge, hash}`. Comment :3-7: only the fingerprint is stored
  (`technicians.badge_hash`) and shipped.
- **`src/control/badgeFile.ts`** (128 lines) — `buildBadgeResponse(hostId, deps)` (:61-128), only
  caller `httpServer.ts:257`. Returns `BadgeResponse` (:19-45): `badgesFile` (fingerprint →
  `{tenantId, technicianRef, revoked}`), `newBadges[{ref, tenantId, sandboxRef, badge}]` (plaintext,
  only at mint), `bindings[{ref, sandboxRef, telegramUserId}]`, `retirements[{sandboxRef}]`,
  `menuButton` (:48-54). Mint = `mintBadge()` (:102) then `claimBadgeHash` compare-and-swap
  (`technicians.ts:279`, `.is('badge_hash', null)`).
- **`src/mcp/httpServer.ts`** (1032 lines) — the routes (table below) and the host-bearer check
  repeated inline at :250, 273, 304, 353, 382, 453, 551, 634, 718:
  `getHostByTokenHash(sha256hex(bearer))`, null → bare 401. `host.id` always comes from the token.

  | line | route | handler → work |
  |---|---|---|
  | :838 | GET `/control/badges` | `handleBadgePull` :248 → `buildBadgeResponse` |
  | :843 | POST `/control/sandboxes` | `handleSandboxReport` :542 → `completeSandboxRecycle` (:581), `clearSandboxAssignmentIfRef` (:602) |
  | :850 | POST `/control/seat-bots` | `handleSeatBotReport` :444 → `listPoolRowsForHost` (:478), `setSandboxBotId` (:512) |
  | :856 / :860 | GET / POST `/control/nudges` | `buildNudgeDelivery` / `completeNudgeDelivery` |
  | :866 / :870 | GET / POST `/control/office` | `buildOfficeDelivery` / `completeOfficeDelivery` |
  | :878 | POST `/control/ops` | `recordOpsEvent` + `notifyOpsTransition` |
  | :885 | POST `/control/metrics` | `recordHostMetrics` (:765) |

  There is no seat-glue route and no cost route; the glue's cost log is a file on the box
  (`src/seatGlue/costLog.ts:11`, :160).

### Render side — data layer

- **`src/db/sandboxPool.ts`** (357 lines), re-exported from `src/db/index.ts:17`:
  `registerSandbox` (:21), `getPoolRowByTechnician` (:52), `listFreeSandboxes` (:69, oldest
  first), `listPoolRows` (:84), `claimSandbox` (:96), `requestSandboxRetirement` (:125),
  `cancelSandboxRetirement` (:146), `listRetirementsForHost` (:167), `completeSandboxRecycle`
  (:183, throws `recycle_refused`), `setSandboxBotId` (:290), `listPoolRowsForHost` (:320),
  `listLiveBotIds` (:338, cross-tenant, the Mini App allowlist).
- **`src/db/hosts.ts`** — `createHost` (:9), `getHostByTokenHash` (:21), `getHostByName` (:31).
  Re-exported at `src/db/index.ts:18`.
- **`src/db/hostMetrics.ts`** — `recordHostMetrics` (:53), `listHostMetrics` (:92, tests only).
  Not re-exported; imported directly by `httpServer.ts:25`.
- **`src/db/technicians.ts`** (504 lines) — `getTechnician` (:25); `listTechniciansForHost` (:187,
  `eq('host_id')`); `TechnicianPatch` carries `badge_hash`, `host_id`, `sandbox_ref`,
  `telegram_user_id` (:216-224); `claimBadgeHash` (:279); `clearSandboxAssignmentIfRef`
  (:302-312); `telegram_user_id` readers :41, :66, :97, :135.
- **`src/db/tenants.ts`** — `getTenant` (:24); `setTenantTimezone` (:137). The firm timezone is
  `tenants.timezone` (default `America/Los_Angeles` from `createTenant`, comment :126-136);
  `tenant_settings` has no timezone column.

### Other Render readers of seat plumbing columns

- `src/mcp/tools/roster.ts` — `handleBindTelegram` (:718) claims a pool sandbox
  (`getPoolRowByTechnician` :782, `listFreeSandboxes`/`claimSandbox` :784-785, recycle-in-flight
  wording :796) and copies `pool.host_id`/`pool.sandbox_ref` onto the technician (:805-807),
  replying with `bot_username` (:808/:810). `handleDeactivateTechnicianSeat` (:462) reads the pool
  row (:512) and stamps retirement (:569). `handleReactivateTechnicianSeat` (:605) cancels it
  (:674) and checks `sandbox_ref`/pool row (:679). `handleListTeam` (:829) maps
  `technician_id → bot_username` from `listPoolRows` (:835) and outputs `sandboxRef` (:850).
- `src/teamLead/planner.ts:1229-1230` — a person's `chat` flag requires `host_id && sandbox_ref &&
  telegram_user_id`; `assistant` requires `host_id && sandbox_ref`.
- `src/control/nudgeQueue.ts:177, 210, 242, 262, 290, 308` and `src/control/officeQueue.ts:104, 140`
  — items skip unless `tech.sandbox_ref` and `telegram_user_id`; they ship `sandboxRef` to the box.
- `src/db/nudges.ts:193-223, :376-383`, `src/db/officeMessages.ts:261-313`,
  `src/db/personPushes.ts:51-96` — embedded `technicians!inner(…sandbox_ref, telegram_user_id,
  host_id…)` filtered by `technicians.host_id = host`.
- `src/teamLead/office.ts:751`, `src/mcp/tools/office.ts:329` — branch on `sandbox_ref`.
- `src/telegram/botIds.ts:57` — `listLiveBotIds()` feeds `allowed()` (:72, 5-minute TTL), used by
  `src/telegram/boardApi.ts:99` `verifySlip` to accept Mini App initData signed by a live seat bot.

### Box side (`Box_Setup_Stuff/`)

- **`doorman.mjs`** (95 lines) — env :7-11 (`DOORMAN_PORT` 3001, `DOORMAN_BIND`,
  `GATEWAY_IDENTITY_SECRET`, `MCP_UPSTREAM_URL`, `BADGES_FILE=/etc/doorman/badges.json`); fails
  closed :13-14; https-or-loopback :20-22; `/composio` keeps its path :30-31; `sign` :33 (HMAC over
  `"t.r"`, no timestamp, no body); badge lookup re-reads the file on every request :34-44 (401
  missing, 403 unknown/revoked); fresh outbound headers :56-63; streaming + headersSent guard
  :71-90.
- **`badge-pull.sh`** (383 lines) — root, timer `*:0/5` (installed by `bootstrap-box.sh:453-520`);
  env `/etc/doorman/badge-pull.env` (`PULL_URL`, `HOST_PULL_TOKEN`); pull :151; empty-roster guard
  :169-185; atomic `badges.json` write :187-206; new badges installed into the OpenShell provider
  `<sref>-telegram-bridge` as `TRADES_SPINE_BADGE` and the container restarted (`install_badge`
  :101-144); bindings → `apply-binding.sh` :251-309; retirements → recycler queue :311-358; tail
  calls `seat-sync.sh` :377-379.
- **`seat-glue/install.sh`** (116 lines) — non-secret inputs `SEAT_TENANT_ID`,
  `SEAT_TECHNICIAN_REF`, `SEAT_TELEGRAM_USER_ID`, `SEAT_TZ` from the operator's environment
  (:5, :20-25; header :8-9 says read them from the pilot's `technicians` joined to
  `tenants.timezone`). Secrets copied from files already on the box (:11-14, :73-76):
  bot token from `/root/seats/<seat>.env`, `GATEWAY_IDENTITY_SECRET` and `MCP_UPSTREAM_URL` from
  `/etc/doorman/doorman.env`, OpenRouter key from `/etc/nemoclaw/openrouter.env`. Writes
  `/etc/seat-glue/<seat>.env` (0600) (:80-94).
- **`seat-glue/seat-glue@.service`** — `User=seatglue`, `EnvironmentFile=/etc/seat-glue/%i.env`,
  `SEAT_REF=%i` (the instance name is the sandbox ref, e.g. `s5`) (:17-33).
- **`seat-glue/cutover.sh`** / **`rollback.sh`** — cutover disables the openclaw agent unit, writes
  a dead token into the provider, stops the container, enables the glue; the real bot token stays
  in `/root/seats/<seat>.env` (:16, :48-74). Rollback restores it (:23-44).
- Other `HOST_PULL_TOKEN` users: `nudge-runner.sh:60`, `office-runner.sh:53`, `seat-sync.sh:55`
  (`/control/seat-bots`), `recycle-sandbox.sh:21/54` (`/control/sandboxes`), `ops-report.sh:98`,
  `box-report.sh:113, :482`, `deploy/backup/backup-db.sh:18`; units `box-report.service:16`,
  `ops-report-medic-{ok,down}.service`.
- `apply-bakein.py:161, :176, :232, :247, :300-317` — openclaw's config sends
  `Authorization: Bearer openshell:resolve:env:TRADES_SPINE_BADGE` to both spine and relay.
- `bootstrap-box.sh` — doorman phase :357-450 (writes `GATEWAY_IDENTITY_SECRET` :388-395, "must
  MATCH Render"), badge-pull phase :453-520, egress preset `host.openshell.internal:3001`
  :637-663, verify checks :1742, :1798-1809.

### Seat glue (`src/seatGlue/`)

- **`identity.ts`** (21 lines) — `signedHeaders(secret, tenantId, technicianRef)` (:14-21), same
  algorithm as `doorman.mjs:33`. Comment :3-7: "Step 4 replaces this with a per-seat token."
- **`config.ts`** (93 lines) — `SeatConfig` (:10-24); `tz` comment :16 "Hand-set for step 1;
  retire when step 4 has Render send it"; `REQUIRED` (:26-36) includes `SEAT_TZ` and
  `GATEWAY_IDENTITY_SECRET`; IANA check :52-57; https-or-loopback :59-70.
- **`engine.ts`** (164 lines) — `startEngine` (:68-81) sets `TZ: opts.tz` in the engine process's
  env allowlist at process start (:76; comment :73-75: the identity secret must not reach the
  engine). `sessionConfig` (:83-138) puts `headers: { ...signedHeaders(...) }` on
  `mcpServers.spine` (:112-122). `openSession` (:145-162) re-supplies the whole config on resume.
- **`main.ts`** (114 lines) — `engineConfig()` copies `secret, tenantId, technicianRef, spineUrl,
  tz` (:23-35); `startEngine` with `tz` (:78).
- Self-contained rule: nothing under `src/seatGlue/` imports another `src/` module
  (`config.ts:6-8`, enforced by `selfContained.test.ts`).

## Data Flows

### A. openclaw seat → spine (badge path)

```
roster row (technicians, badge_hash null, active)
  │  GET /control/badges (host token) — buildBadgeResponse
  │    mintBadge → claimBadgeHash CAS → newBadges[{ref, tenantId, sandboxRef, badge}]
  ▼
badge-pull.sh (root, every 5 min)
  │  badges.json ← badgesFile (fingerprint → {tenantId, technicianRef, revoked})
  │  provider "<sref>-telegram-bridge" ← TRADES_SPINE_BADGE=<plaintext>; docker restart
  ▼
sandbox (openclaw) ── Bearer <badge> ──► doorman :3001
  │  sha256 → badges.json lookup (re-read per request)
  │  x-tenant-id / x-technician-ref / x-identity-signature
  ▼
Render /mcp → resolveIdentityFromHeaders → createServer → dispatch → getTechnician
```

Revocation: deactivation sets the roster state; the next pull ships `revoked: true`
(`badgeFile.ts:121-125`), and the doorman re-reads the file per request. Rotation:
`assign-host.mjs rotate-badge` sets `badge_hash = null` (:568-590), the next pull re-mints.

### B. seat glue → spine (step 1)

```
/etc/seat-glue/s5.env  (SEAT_TENANT_ID, SEAT_TECHNICIAN_REF, SEAT_TZ, GATEWAY_IDENTITY_SECRET …)
  │ loadConfig (config.ts:40)
  ▼
main.ts engineConfig → sessionConfig: mcpServers.spine.headers = signedHeaders(secret, t, r)
  │ (the engine process receives the three header VALUES, never the secret)
  ▼
Render /mcp → identity.ts:41 → dispatch → getTechnician (server.ts:620; inactive → refused)
```

Engineering-memory §2 "Step 1 built" (:1782-1787) records Render logging every spine call as
`ben-shelton` — the live proof this path is accepted. Revocation of the glue: the signature is a
pure function of `tenantId.technicianRef` with no expiry, so the header value is valid forever;
the only per-person stop is `dispatch`'s inactive-caller refusal (`server.ts:621-623`) and the
relay's (`relayHandler.ts:491-495`). The only way to invalidate the header value itself is
rotating `GATEWAY_IDENTITY_SECRET` on Render and on every holder (doorman.env, each glue env).

### C. Firm timezone

Stored in `tenants.timezone`, written only by `set_timezone` → `setTenantTimezone`
(`src/mcp/tools/schedule.ts:1770-1804`, `tenants.ts:137`). Read per call on Render
(`server.ts:907-932` with a 10-minute cache; `schedule.ts:634, 684, 931, 1598, 2034`;
`access.ts:251`; `context.ts:232`). Every tool result already names it in the `now` line
(`server.ts:931`). On the box the glue's `SEAT_TZ` is typed by the operator at install
(`install.sh:20-25`, :80-94) and becomes the engine process's `TZ` at start (`engine.ts:76`).
Nothing on Render sends it to the box today.

### D. Seat creation (the pool)

```
operator: assign-host.mjs create-host  → hosts row, HOST_PULL_TOKEN printed once
          assign-host.mjs add-sandbox  → sandbox_pool row (host, sandbox_ref)
          assign-host.mjs wire-bot     → sandbox_pool.bot_id / bot_username
manager:  bind_telegram (roster.ts:718) → claimSandbox → technicians.{host_id, sandbox_ref,
          telegram_user_id}
box:      badge-pull → binding applied, badge installed; seat-sync → POST /control/seat-bots
```

## External Dependencies

- `node:crypto` (HMAC-SHA256, sha256, `randomBytes`, `timingSafeEqual`) — both sides.
- `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` (stateless, `httpServer.ts:985`).
- `@github/copilot-sdk` 1.0.14 in the glue — MCP servers take a static `headers` object per
  session config (`engine.ts:112-122`); the config is re-supplied on resume (`engine.ts:142`).
- OpenShell provider store (badge storage for openclaw sandboxes).
- Composio (the relay's downstream; `COMPOSIO_RELAY_API_KEY ?? COMPOSIO_API_KEY`).
- Telegram (Mini App initData verified against live seat bot ids, `botIds.ts`).
- Supabase (all tables above). No `render.yaml` in the repo; env vars are set on the service.

## Constraints and Invariants

1. **Identity is established at the boundary, never from a tool argument** (`identity.ts:3-6`).
2. **Render trusts any holder of `GATEWAY_IDENTITY_SECRET` to act as any person in any firm.**
   The HMAC carries no seat, host, expiry, or nonce (`identity.ts:54`, `doorman.mjs:33`). Holders
   today: Render's env, `/etc/doorman/doorman.env`, `/etc/seat-glue/s5.env`.
3. **Two machine identities, not one.** Seats use the HMAC path; box scripts use the host token
   (`hosts.token_hash`). Retiring badges does not touch the host token; every runner, seat-sync,
   the recycler, box-report, ops-report and the DB backup use it.
4. **A plaintext credential exists once.** Badges and the host token are shown once and stored as
   sha256 fingerprints (`badges.ts:3-7`, `badge-pull.sh:8`, `bootstrap-box.sh:475`). Engineering
   memory :463-464: a 2026-07-03 badge leak forced rotating every badge.
5. **Revocation today depends on the roster row.** The doorman path adds a file-level revoke; the
   glue path has only `dispatch`'s inactive check.
6. **Seat identity on the box is `sandbox_ref`.** The glue's systemd instance name, the bot token
   file (`/root/seats/<seat>.env`), the provider name, the nudge/office item address, and
   `ops_secrets.bot_tokens`' key are all the sandbox ref.
7. **Bot id and username live only on `sandbox_pool`** (and in `ops_secrets.bot_tokens`, keyed by
   host name, never read by application code, migration `20260915100000`). `technicians` has no
   bot columns. `listLiveBotIds` (the Mini App allowlist) reads `sandbox_pool`.
8. **`hosts` has dependents outside the seat path:** `ops_events.host_id` (not null FK,
   migration `20260813000000:35`), `host_metrics` (cascade FK, `20260901140000`), and the latest
   `monitoring.health` view, which aggregates `host_metrics` joined to `hosts`
   (`20260901140000`), read by `deploy/n8n/monitor-health.sh`.
9. **`technicians.sandbox_ref` feeds the cost rollup's `per_sandbox` weighting**
   (`20260725130000_cost_rollup_fn.sql:198`, redefined `20260730120000:231`).
10. **Deploys run no migrations** and the web service does not auto-deploy (memory
    `deploy-does-not-migrate`); dropping columns or tables opens a schema-vs-code window that
    merging alone does not close.
11. **The glue is self-contained** (`config.ts:6-8`); anything it needs from Render arrives over
    HTTP or its env file, never an import.
12. **The engine's `TZ` is fixed per process** (`engine.ts:76`); a timezone change reaches the
    engine only on restart.
13. **The doorman still serves s1-s4 until step 5** cuts every seat over (retirement plan table:
    step 5 "each seat's bot moved to the glue"). The HMAC check must keep accepting the doorman's
    headers until then.

## Decision Points

1. **What the per-seat token is.**
   - *Opaque random bearer, stored as a fingerprint* — same shape as badges and the host token
     (`mintBadge`, `getHostByTokenHash`). Render looks the fingerprint up on every request, so
     revoking or rotating is one row write. Costs a DB read per call (the tz read already does
     one, cached).
   - *Self-contained signed token* (JWT-like, the "Option B" of `identity.ts:40`) carrying
     tenant, person, seat, and possibly timezone. No lookup per call; revocation needs an expiry
     plus refresh or a deny list, and the signing key is Render-only.
2. **Where the fingerprint lives.** Reuse `technicians.badge_hash` (already unique, CAS-minted,
   rotatable with `rotate-badge`) or a new seat-owned column/table. `badge_hash` is per person;
   a person with two seats (not a case today) would need the table.
3. **How the token reaches the glue.**
   - *Printed once by an operator CLI and pasted into `/etc/seat-glue/<seat>.env`* (like
     `HOST_PULL_TOKEN`).
   - *Pulled by the box with the host token* (like `newBadges` in `/control/badges`), then written
     into the glue's env file by a root script.
   - *Minted at `bind_telegram`* and delivered by either route above.
4. **How the timezone reaches the glue.** Inside the token (static until re-mint); from a
   token-authenticated "who am I" route the glue calls at startup (the engine's `TZ` is set at
   process start, `engine.ts:76`); or not at all — tool results already carry the firm's timezone
   in the `now` line (`server.ts:931`), and the engine `TZ` only affects the engine process's own
   clock.
5. **What a seat is once the pool is gone** (the operator's open question from the retirement
   plan). Today "seat" is spread across `technicians.{host_id, sandbox_ref, telegram_user_id}`
   and `sandbox_pool.{bot_id, bot_username, retire_*}`. Readers that would need a new home:
   `bind_telegram`'s claim (`roster.ts:782-807`), `list_team`'s bot names (`roster.ts:835`),
   the Mini App allowlist (`botIds.ts:57`), the planner's `chat`/`assistant` flags
   (`planner.ts:1229-1230`), nudge/office addressing (`nudgeQueue.ts`, `officeQueue.ts`,
   `nudges.ts`, `officeMessages.ts`, `personPushes.ts`), the cost rollup, and deactivate/reactivate
   retirement stamps (`roster.ts:512, 569, 674, 679`).
6. **Transition shape for the HMAC path.** Keep `resolveIdentityFromHeaders` accepting the
   doorman's HMAC alongside the new token until step 5 retires the last openclaw seat, or cut s1-s4
   over first. Keeping both means `GATEWAY_IDENTITY_SECRET` stays on Render and in doorman.env
   until step 5, but leaves the glue's env.
7. **The `/composio` relay.** It uses the same HMAC (`relayHandler.ts:489`). The glue does not
   call it today; the manager seat (step 2) may. Token support there is either part of step 4 or
   left on the HMAC path.
8. **What happens to `hosts`.** The retirement table lists "hosts/hostMetrics" under step 4, but
   the host token authenticates every box script, and `ops_events` / `host_metrics` /
   `monitoring.health` depend on `hosts` (Constraint 8). Options: keep hosts as "the box" (its
   machine identity) and retire only the seat use of `host_id`; or retire it with its dependents.
9. **Order of schema removal.** `sandbox_pool` (4 creating/altering migrations plus
   `ops_secrets.bot_tokens` mirroring it), `technicians.badge_hash` / `host_id` / `sandbox_ref`.
   Dropping them in step 4 versus leaving columns unused until step 6 decides how large the
   schema-ahead-of-code window is (Constraint 10).

## Open Questions

- Does the Copilot SDK re-read `mcpServers.headers` on `resumeSession`? `openSession` re-supplies
  the config (`engine.ts:142`), so a rotated token would reach a resumed session — but whether a
  live session picks up a new header without resume is untested.
- Is anything besides `server.ts:621-623` and the relay relied on to stop a deactivated glue
  seat? (The glue has no badges.json to flip.)
- Should the glue refuse to start on a Render-sent timezone that disagrees with its env, or is the
  env value retired entirely? Depends on Decision 4.
- `seat-sync.sh` posts bot ids to `/control/seat-bots` from `/root/seats/*.env`; once the pool is
  gone, where does Render learn a seat's bot id (needed by the Mini App allowlist)?
- Which seats remain on openclaw at the moment step 4 lands (s1-s4 per memory; s2 moves in
  step 2)? This sets how long the HMAC path must coexist.
- Engineering memory :4150-4161 names two docs that embed byte-identical copies of `doorman.mjs`
  (`docs/doorman-runbook.md`, `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`); not opened here.
