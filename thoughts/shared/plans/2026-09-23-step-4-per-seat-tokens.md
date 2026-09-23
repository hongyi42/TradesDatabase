---
date: 2026-09-23
task: Step 4 (4a + 4b) — per-seat tokens replace the glue's shared secret; a glue seat exists without the sandbox pool
research: thoughts/shared/research/2026-09-23-step-4-seat-identity-doorman-badges-sandbox-pool.md
status: draft
supersedes: nothing
---

## Overview

Seat s5 (Ben's seat glue) signs its identity with `GATEWAY_IDENTITY_SECRET`, the one secret that
can act as anyone in any firm. This plan gives every glue seat its own revocable token, has Render
verify it, lets the glue learn its firm, person and timezone from Render at start, and gives a glue
seat a home (`seats` + `seat_bots`) that does not depend on `sandbox_pool`. The doorman, badges and
the pool keep serving s1-s4 untouched; their removal moves into step 5 (operator, 2026-09-23).

## Decisions

- **Scope: 4a + 4b now; removal moves to step 5** (operator). Doorman, badges, `badge-pull`,
  `sandbox_pool`, `/control/{badges,sandboxes,seat-bots}`, the HMAC path and `hosts` are untouched.
- **A seat is a `seats` row** (operator): firm, person, box, `seat_ref`, bot, token fingerprint.
  **Only glue seats get rows** (plan review): OpenClaw seats stay in `sandbox_pool` +
  `technicians.sandbox_ref` until step 5 moves each one and creates its row. Copying them in now
  meant keeping two records in step through recycles, rebinds and rollbacks (review findings 2-4, 7).
- **Bots are their own record, `seat_bots`** (operator: keep bot granularity open). A seat points
  at a bot (`bot_ref`, nullable: s5's bot stays in the pool row). One live seat per bot for now
  (partial unique index); step 5 drops it if bots go per firm or one-for-all. Pool bots are NOT
  copied in, so a glue bind can never take a bot an OpenClaw sandbox owns.
- **Token delivery = C: `install.sh` fetches it once** (operator). `POST /control/seat-token`,
  authenticated by the box's host token, mints for a seat on THAT box and returns it once. Rerun =
  rotate. Manual per seat while bots are per person; the provisioner is a named step-5 gap.
- **The glue asks Render at start** (operator): `GET /seat/whoami` returns firm, person, Telegram
  id and timezone. Named hole: a timezone or Telegram-id change reaches the glue on restart.
- **Token format** (implementation): `st_` + 32 random bytes hex; Render stores only
  `sha256hex(token)` (`src/control/badges.ts:9`). No expiry; revoked by re-minting or retiring.
- **No verification cache** (implementation): one indexed lookup per call; revocation is immediate.
- **Both identity paths accepted** (implementation): `Authorization: Bearer st_…` → seat token;
  otherwise the HMAC headers. Nothing sends `Authorization` to `/mcp` today (doorman rebuilds
  headers, `doorman.mjs:55-63`), so the branch cannot misread an existing caller.
- **Badges stay for any seat that still has a pool sandbox** (review 7): `buildBadgeResponse`
  skips only glue seats with NO pool row on that host (the `g_…` seats). s5 keeps its badge, so
  `rollback.sh` still works, and step 5 can install a seat before cutover without its OpenClaw
  side losing the spine.
- **`bind_telegram` order** (review 3-4): today's branches are unchanged and run first (existing
  `sandbox_ref` → rebind; recover a pool claim). New: reuse a half-written glue seat; else claim a
  free `seat_bots` row → a glue seat; else today's free-pool claim. The glue path writes
  `telegram_user_id`, `host_id`, `sandbox_ref = seat_ref` in one roster write, so the planner flags
  (`planner.ts:1229-1230`), `reactivate`'s check (`roster.ts:679`) and the cost rollup see a seat.
- **Glue seat refs** `g_` + 8 hex (implementation): matches `install.sh`'s `^[a-z0-9_]+$`, never
  collides with pool refs.
- **Foreign keys cascade** (review 5, 14, 15): `seats` → tenants/technicians/hosts and `seat_bots`
  → hosts `on delete cascade`; `seats.bot_ref` → `seat_bots` `on delete set null`, so existing test
  cleanups and the eval resets keep working.
- **Named holes** (accepted, build fast): a glue seat gets no nudges/office notes until step 3
  (same as s5 today; items report `failed`); deactivating a glue seat keeps its bot (bot recovery
  decided with the bot model in step 5); a manager bound onto a glue seat runs technician doctrine
  until step 2 lands; bot tokens for new glue seats are placed by hand at
  `/root/bots/<bot_username>.env`.

## Plain-language walkthrough

```
install.sh s5 ──host token──► POST /control/seat-token ──► Render mints, keeps only fingerprint
      └── writes SEAT_TOKEN into /etc/seat-glue/s5.env (never printed)
glue start ──Bearer SEAT_TOKEN──► GET /seat/whoami ──► {firm, person, telegram id, timezone}
glue turn  ──Bearer SEAT_TOKEN──► /mcp ──► fingerprint → seats row → person
s1-s4      ──badge──► doorman ──HMAC──► /mcp        (unchanged until step 5)
```

**Phase 1 — the seat record.** Two new tables: `seat_bots` (a Telegram bot and its box) and
`seats` (a person's glue assistant). An operator command creates s5's row. You'd notice it by one
`seats` row for s5 on the pilot.

**Phase 2 — Render accepts seat tokens.** The identity check learns a second key. Two new routes:
the box mints a token for its own seat; a seat asks "who am I". You'd notice it in the tests.

**Phase 3 — Ben's glue switches.** The glue drops the master secret, asks Render who it is, and
sends its token on every tool call; `install.sh` fetches the token. You'd notice it by Ben's bot
answering a schedule question with the secret gone from the box's seat file.

**Phase 4 — a seat without the pool.** Binding a new person can claim a registered bot instead of
a sandbox; the team list, the Mini App's bot allowlist, the badge file and the roster health check
know about glue seats. You'd notice it by binding a test person locally and seeing a `g_…` seat.

**Phase 5 — the record.** Engineering memory and the retirement plan say what changed and what
step 5 now owns.

## Secrets & env preflight

- **Phase 1:** none new. Pilot migration via the Supabase test MCP (`apply_migration`, connected).
  The s5 row is a pilot write the operator runs with `!` (memory `pilot-db-is-a-test-surface`).
- **Phase 2:** none new. `GATEWAY_IDENTITY_SECRET` stays on Render (already required).
- **Phase 3:** box: `HOST_PULL_TOKEN` + `PULL_URL` in `/etc/doorman/badge-pull.env` (present).
  Render MCP for the deploy (workspace `tea-d69903h5pdvs738dm81g`). Local driver run needs
  `OPENROUTER_API_KEY` in this worktree's `.env` (a fresh worktree has none; copy from main).
  `GATEWAY_IDENTITY_SECRET` is REMOVED from `/etc/seat-glue/s5.env`.
- **Phase 4:** `SANDBOX_BOT_TOKEN` (env, from BotFather) only when registering a real bot;
  already required by `wire-bot`. None for the local checks.
- **Phase 5:** none.

## Phase 1: The seat record

### Changes required

**Merge `origin/main` first** (#280 added `20260923120000_office_messages_pinged_at.sql` and
changed `database.types.ts`).

**`supabase/migrations/20260923200000_seats.sql`** (new; later than every file on main)
- `seat_bots(id uuid pk default gen_random_uuid(), tenant_id uuid null references tenants(id) on
  delete cascade` (null = any firm)`, host_id uuid not null references hosts(id) on delete cascade,
  bot_id text null unique check (bot_id ~ '^[0-9]{1,20}$'), bot_username text not null,
  created_at timestamptz not null default now(), retired_at timestamptz null,
  unique (host_id, bot_username))`.
- `seats(id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants(id) on
  delete cascade, technician_id uuid not null references technicians(id) on delete cascade,
  host_id uuid not null references hosts(id) on delete cascade, seat_ref text not null check
  (seat_ref ~ '^[a-z0-9_]+$'), bot_ref uuid null references seat_bots(id) on delete set null,
  token_hash text null unique, token_minted_at timestamptz null, created_at, retired_at)`.
- Partial unique indexes `where retired_at is null`, named so code can tell them apart:
  `seats_live_technician_key (technician_id)`, `seats_live_host_ref_key (host_id, seat_ref)`,
  `seats_live_bot_key (bot_ref)`.
- RLS on; `revoke all … from anon, authenticated` (the `20260901140000_host_metrics.sql` idiom).
- No backfill.

**`src/db/seats.ts`** (new, re-exported from `src/db/index.ts`)
- `getSeatByTechnician(technicianId)`, `getSeatByHostRef(hostId, seatRef)` — live rows only.
- `getSeatIdentityByTokenHash(hash): Promise<{ seat: Seat; technicianRef: string } | null>` —
  live seat with `technicians!inner(ref, tenant_id)`; returns null unless the embedded
  `tenant_id` equals `seat.tenant_id` (embeds don't inherit tenancy — data-security §1).
- `mintSeatToken(seatId, hash)` — sets `token_hash`, `token_minted_at = now()`.
- `createSeat({ tenantId, technicianId, hostId, seatRef, botRef })` — throws an Error carrying
  `code` and `constraint` (from the PostgREST message) so callers tell a bot race from a person race.
- `listFreeSeatBots(tenantId)` — live bots with `tenant_id = tenantId or null`, no live seat
  pointing at them, oldest first. `listSeatBotHandles(tenantId): Map<technicianId, botUsername>`.
- `listLiveSeatBotIds()` — returns `[]` on 42P01 / PGRST205 (table missing: schema behind code),
  like `listLiveBotIds`'s 42703 fallback (`sandboxPool.ts:338-356`).
- `listPoollessSeatRefs(hostId): Promise<string[]>` — live seat refs on the host with no live
  `sandbox_pool` row of the same `(host_id, sandbox_ref)`.
- `registerSeatBot({ hostId, tenantId, botId, botUsername })`.

**`scripts/assign-host.mjs`** — `add-glue-seat host=<name> ref=<ref> seat=<seatRef> [tenant=]`:
creates the `seats` row for an EXISTING person whose `sandbox_ref` equals `seat` (s5, and each
seat step 5 moves); `bot_ref` null. Add to the command table (`:105-113`).

**`src/db/database.types.ts`** — `npm run gen:types -- --local` (never bare: it targets the pilot).

**Reset lists** (engineering memory §1: name every table): add `seats`, `seat_bots` to
`scripts/spine-eval/world.mjs:104-168` and `PILOT_TENANT_SCOPED` (`:218-253`, `seats` before
`technicians`), and `scripts/agentic-eval/run.mjs:166-172`.

### Automated verification
- [x] gates pass (`typecheck`, `lint`, `test`) on this worktree's stack
- [x] `src/db/seats.test.ts`: create/read; bot race → `seats_live_bot_key`; second live seat for a
  person → `seats_live_technician_key`; retired seat never resolves by token; **two-tenant case**:
  a token whose seat and person disagree on tenant resolves to null; `listPoollessSeatRefs`
  excludes a ref that has a pool row; `listLiveSeatBotIds` → `[]` when the table is absent (stub)
- [x] `supabase db reset` applies cleanly after the merge

### Live verification (agent-executable)
- Prerequisites: Supabase test MCP. `apply_migration`, then `notify pgrst, 'reload schema'`
  (engineering memory :1861-1864). Operator runs `node scripts/assign-host.mjs add-glue-seat
  host=trades-box-1 ref=ben-shelton seat=s5` with `!` from the worktree root.
- [x] pilot: `select seat_ref, bot_ref, token_hash is null from seats` → one row `s5, null, true`

---

## Phase 2: Render accepts seat tokens

### Changes required

**`src/control/badges.ts`** — `mintSeatToken(): MintedBadge` (`st_` + `randomBytes(32)` hex).

**`src/mcp/identity.ts`** — `RequestIdentity` gains `seatRef?: string`. New
`async resolveIdentity(headers)`: `Bearer st_…` → `getSeatIdentityByTokenHash(sha256hex(t))`,
null → throw `'unknown seat token'`; else `resolveIdentityFromHeaders(headers)` (unchanged).

**`src/mcp/httpServer.ts`**
- `:984` and **`src/composio/relayHandler.ts:489`** → `await resolveIdentity(req.headers)` (both
  already in async functions; throws still reach the bare-401 catches).
- `handleSeatToken` — `POST /control/seat-token`, routed next to `:850`, before `allowed()`; host
  bearer check as `handleBadgePull` (:250-256); body `{ seatRef }` via `readBody`, validated
  `^[a-z0-9_]+$`; `getSeatByHostRef(host.id, seatRef)` → 404; person inactive → 409; mint, store,
  200 `{ token, seatRef, tenantId, technicianRef, botUsername }`, `cache-control: no-store`.
  `botUsername`: `seat_bots` via `bot_ref`, else the pool row's (`getPoolRowByTechnician`), else null.
- `handleSeatWhoami` — `GET /seat/whoami`, before `allowed()`; seat token required (HMAC → 401);
  inactive → 403; 200 `{ seatRef, tenantId, technicianRef, telegramUserId, timezone }`, timezone
  `getTenant(tenantId)?.timezone ?? 'UTC'`, `telegramUserId` null if unbound.

### Automated verification
- [x] gates pass
- [x] `src/mcp/identity.test.ts`: token resolves; unknown/retired rejects; HMAC unchanged; both
  present → token wins
- [x] `src/mcp/httpServer.test.ts`: seat-token 401 (none/bad host token), 404 for a seat on another
  host (create that host with `createHost`; its cleanup cascades), 409 inactive; second mint → first
  token 401s on `/mcp`; whoami 401 for HMAC, right timezone, 403 inactive; `tools/list` over `/mcp`
  with a token returns the technician tool list

---

## Phase 3: Ben's glue switches to its token

### Changes required

**`src/seatGlue/config.ts`** — `REQUIRED` drops `SEAT_TENANT_ID`, `SEAT_TECHNICIAN_REF`,
`SEAT_TELEGRAM_USER_ID`, `SEAT_TZ`, `GATEWAY_IDENTITY_SECRET`; adds `SEAT_TOKEN` (`^st_[0-9a-f]{64}$`).
`SeatConfig` loses `tenantId, technicianRef, telegramUserId, tz, secret`, gains `seatToken`.

**`src/seatGlue/whoami.ts`** (new; node globals only, so `selfContained.test.ts` holds) —
`fetchWhoami(spineUrl, token, fetchFn = fetch): Promise<SeatWho>` with `SeatWho = { seatRef,
tenantId, technicianRef, telegramUserId: number, tz }`; `new URL('/seat/whoami', spineUrl)`;
throws on non-200, a null/invalid Telegram id, or an invalid IANA zone (checks moved from
`config.ts:47-57`).

**`src/seatGlue/identity.ts`** — `seatHeaders(token): { authorization: string }` replaces
`signedHeaders`. **`engine.ts`** — `EngineConfig.secret` → `seatToken`; `:121` →
`headers: { ...seatHeaders(cfg.seatToken) }`.

**`src/seatGlue/main.ts`** — `engineConfig(cfg, who)` and `seatDeps(cfg, who, client, telegram,
policy)` take tenant/ref/Telegram id/tz from `who`; `main` calls `fetchWhoami` after `loadConfig`,
exits 1 if it fails or `who.seatRef !== cfg.seatRef` (systemd retries; never guesses an identity).
`selfcheck` (:64) uses `'UTC'`.

**`src/seatGlue/drive.ts:121-128`** — same: `fetchWhoami`, then `ScriptedTelegram(who.telegramUserId, …)`,
`startEngine({ tz: who.tz })`, `seatDeps(cfg, who, …)`.

**`Box_Setup_Stuff/seat-glue/install.sh`** — no env inputs. New order: build `$NEXT` (:58-63) →
selfcheck (:102) → **mint**: read `HOST_PULL_TOKEN`/`PULL_URL` from `/etc/doorman/badge-pull.env`,
`curl -fsS --max-time 30 -X POST "${PULL_URL%/badges}/seat-token"` with `{"seatRef":"$SEAT"}`,
response in a variable, `token`/`botUsername` parsed with `$NODE -e` → write
`/etc/seat-glue/$SEAT.env.new` (0600: `TELEGRAM_BOT_TOKEN` from `/root/bots/<botUsername>.env`
else `/root/seats/$SEAT.env`, `SEAT_TOKEN`, `SPINE_MCP_URL`, `OPENROUTER_API_KEY`) → swap code
(:103-106) → `mv` the env into place → restart (:111-113). A failure before the `mv` leaves the
old code and old env, which still work (HMAC path). A failure after the mint and before the
restart leaves a revoked token in the running glue: rerun `install.sh` (it re-mints). Header
comment rewritten; `unset` every secret variable.

**`Box_Setup_Stuff/seat-glue/cutover.sh` / `rollback.sh`** — header notes only: cutover now needs
the seat's `seats` row (`add-glue-seat`); rollback is unchanged (the badge survives, see Decisions).

**Tests** — `config.test.ts`, `identity.test.ts` updated; `whoami.test.ts` new (non-200, null id,
bad zone, fetch injected); every test building a `SeatConfig`/`seatDeps` updated.

### Automated verification
- [x] gates pass; `npm run build` emits `dist/seatGlue/whoami.js`
- [x] `grep -rn GATEWAY_IDENTITY_SECRET src/seatGlue Box_Setup_Stuff/seat-glue` → nothing
- [x] `httpServer.test.ts`: `fetchWhoami` against the test server with a minted token returns the
  seeded person and tenant timezone (the glue's real client, Render's real route)
- [x] local driver: mint for a seeded seat, then `SEAT_TOKEN=… SPINE_MCP_URL=http://127.0.0.1:<port>/
  node dist/seatGlue/drive.js <one-turn script>`; the local server logs a spine call as that person

### Live verification (agent-executable)
- Prerequisites: Render MCP; `ssh tradesbox` (check `who` for other operators before `sudo`);
  Phase 1 applied on the pilot and s5's row created.
- [ ] merge, deploy the web service (autoDeploy is off); `/health` `commit` = the merge commit
- [ ] `stage.sh`, copy, `sudo bash install.sh s5`; `sudo grep -c GATEWAY_IDENTITY_SECRET
  /etc/seat-glue/s5.env` → 0; journal `seat-glue: s5 polling Telegram (…, tz America/Los_Angeles)`
- [ ] pilot: `select token_minted_at from seats where seat_ref='s5'` → just now

### Manual verification
- [ ] operator asks Ben's bot "what's on my schedule tomorrow?"; the reply names real visits;
  Render logs show the spine call as `ben-shelton`

---
*Pause here: the manual check needs the operator's phone.*

## Phase 4: A glue seat without the pool

### Changes required

**`src/mcp/tools/roster.ts` `handleBindTelegram` (:718)** — fences :722-765 unchanged. Branches
in order: (1) `target.sandbox_ref` set → today's rebind (:809-811), `botUsername` from the seat's
bot if it has a glue seat, else the pool row; (2) `getSeatByTechnician` live → reuse it (a
half-written bind) and write the mirror; (3) `getPoolRowByTechnician` recovery (:782) → today's
path; (4) each `listFreeSeatBots(tenantId)` → `createSeat({ hostId: bot.host_id, seatRef: 'g_' +
randomBytes(4).toString('hex'), botRef: bot.id })`; `seats_live_bot_key` → next bot,
`seats_live_technician_key` → reread and reuse; (5) today's free-pool claim (:784-803); (6) today's
errors. Glue branches write `telegram_user_id`, `host_id`, `sandbox_ref = seat_ref` in one
`updateTechnician`; note `'an operator starts the assistant on the box (install.sh <seatRef>); then
the person opens <bot> and sends /start'`.

**`handleListTeam` (:829)** — bot handle from `listSeatBotHandles`, else the pool map.

**`src/db/sandboxPool.ts` `listLiveBotIds` (:338)** — union with `listLiveSeatBotIds()`.

**`src/control/badgeFile.ts`** — new dep `listPoolless?: typeof listPoollessSeatRefs` (default the
accessor); skip rows whose `sandbox_ref` it returns (no binding, no mint, no `badgesFile` entry).
Every existing call in `badgeFile.test.ts` gets `listPoolless: async () => []`.

**`scripts/roster-health.mjs:144-146`** — a `sandbox_ref` with a live glue seat is not an orphan.

**`scripts/assign-host.mjs`** — `register-bot host=<name> [tenant=<uuid>]`: `SANDBOX_BOT_TOKEN`
from env, `getMe` (reuse `wire-bot`'s :276-300), `registerSeatBot`; prints the handle and where the
token goes on the box (`/root/bots/<handle>.env`, 0600 root).

### Automated verification
- [ ] gates pass
- [ ] `src/mcp/server.test.ts` (bind_telegram, `tg-host` fixtures :2027-2496): existing cases
  unchanged (`tg-a` legacy, `rcy-s2` recycle); free seat bot → `g_…` seat + mirror; two binds on one
  bot → second takes the next bot or the pool; half-written glue seat reused; no bots → pool path
- [ ] `list_team` shows the seat bot handle; `botIds` admits a seat bot id
- [ ] `badgeFile.test.ts`: a pool-less glue seat ships nothing; a glue seat with a pool row (s5)
  still ships its badge and binding

---

## Phase 5: The record

- `docs/engineering-memory.md` — §2 "Step 1 built": timezone hole closed, secret off the glue.
  New entry "Step 4: seat tokens": routes, only glue seats have rows, the badge rule, `install.sh`
  rotates, the named holes above.
- Memory `openclaw-retirement-plan.md`: 4a + 4b done; step 5 now owns removal (doorman, badges,
  `badge-pull`, `sandbox_pool`, `/control/{badges,sandboxes,seat-bots}`, `badge_hash`, the HMAC
  path, the `hosts` question), a `seats` row per moved seat, the bot model, the provisioner.
- `npm run decisions:index`; gates pass.
