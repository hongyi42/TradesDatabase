---
date: 2026-07-06
branch: box-token-medic-and-accuracy-rules
commit: d47206b
topic: Prod rollout for a manager seat — what exists today between a new seat on trades-box-1 and the TRUE prod Supabase project
---

## Summary

Today the entire deployed system — the Render web service that serves the trades-spine MCP
(Model Context Protocol) server, the Render cron that runs the 15-minute lifecycle sweep, the
badge pull on trades-box-1, and every operator script — points at exactly **one** database: the
hosted "test" project `daqapdlkgxfrhquacprv`, which is the pilot's live database. The **true prod
project (`lzlgysoydhknsdvovntz`) is a blank slate**: checked live on 2026-07-06, it had been
paused since ~2026-06-27 (Supabase pauses idle free-tier projects), auto-restored when queried,
and contains **zero tables and zero migrations**. A seat has no database setting of its own —
the sandbox holds only a revocable badge, the badge goes to the host doorman, the doorman
forwards to one hardcoded Render upstream, and that Render service's `SUPABASE_URL` decides the
database for everyone. So "a manager seat connected to prod" is not a per-seat switch; it
requires a prod database with the schema applied, a control plane (web + cron) pointed at it,
a roster row + badge flow in that database, and either a second doorman path or a second box,
while today four separate code guards actively refuse to touch anything that isn't the pilot or
the local stack. This document maps all of that as it exists.

## Prod project state (live-checked 2026-07-06)

- Project ref `lzlgysoydhknsdvovntz` (URL `https://lzlgysoydhknsdvovntz.supabase.co`).
- Postgres logs show `database system was interrupted; last known up at 2026-06-27 00:44:09 UTC`,
  followed by a point-in-time restore triggered by today's MCP queries — the earlier connection
  timeouts were the database mid-recovery, not an outage.
- After restore: `list_tables` → **0 tables in `public`**, `list_migrations` → **0 migrations**,
  and the `auth`/`storage` schemas hold only stock system tables, all at 0 rows. Nothing has
  ever been deployed or stored there — it is a factory-fresh project. The repo has 12 migration files in `supabase/migrations/`
  (`20260620005307_context_spine.sql` … `20260706090000_retraction_rows.sql`; the last one is
  uncommitted on this branch as of this writing).
- Because it pauses when idle, the project will pause again if nothing connects to it.

## Entry Points

- `src/mcp/httpServer.ts:114` — `GET /control/badges`, the host badge-pull endpoint (Bearer
  host-pull-token → badges file + newly minted badges).
- `src/mcp/server.ts:425-463` — MCP tool dispatch; per-call roster lookup decides tier
  (manager = 16 tools, technician = 9).
- `src/jobs/lifecycle.ts:51-190` — `runLifecycle()`, the Render cron entry (`*/15 * * * *`):
  pairing sweep → offboarding expiry → schedule-sheet sync → Composio session provisioning →
  manager-action log ingestion.
- `scripts/assign-host.mjs`, `scripts/provision-session.mjs`, `scripts/seed.mjs` — the three
  operator-side write paths.
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` — the box-side seat recipe (§4b onboard,
  §5 wiring, §0b/§0c instruction blocks, §6 bake-in, §7 reboot resilience).

## Key Files

**Environment guards (the "prod remains read-only" rule, every enforcement point):**
- `src/testEnvGuard.ts:11-40` — `isLocalDbUrl()` (host-based: only `127.0.0.1`/`localhost`) and
  `assertLocalTestEnv()`; invoked from `src/test.setup.ts:10` via `vitest.config.ts:7`
  (`setupFiles`), so the suite refuses to start against any non-local URL. Unit-tested to reject
  the pilot ref (`src/testEnvGuard.test.ts:18,46`).
- `scripts/seed.mjs:67-92` — requires `DATABASE_URL` and `SUPABASE_URL` to BOTH be local or BOTH
  the pilot ref; pilot additionally requires the explicit `--hosted` flag. Any other target
  (including prod) aborts before a row is written.
- `scripts/assign-host.mjs:33-40` — hard refusal: `SUPABASE_URL` must contain the pilot ref.
  Comment: *"refuse anything but the TEST project … until prod rollout is a deliberate,
  separate step."* No local fallback — this is control-plane-only.
- `scripts/provision-session.mjs:16-22` — identical guard.
- `Box_Setup_Stuff/badge-pull.sh:9-13,81-96` — the box guard: refuses to replace a non-empty
  `/etc/doorman/badges.json` with a zero-entry server response (override: `ALLOW_EMPTY_BADGES=1`).
  Added 2026-07-03 after a test run truncated the pilot roster.
- `.env.example:4-5` — *"Prod is read-only via its MCP server, so prod credentials never belong
  here."* The rule is enforced as **workspace MCP configuration + these guards**: the
  `supabase-prod` MCP server was added with `read_only=true` (recorded 2026-06-19), though its
  tool list still advertises write tools (`apply_migration`, `execute_sql`) — whether those are
  rejected server-side was not exercised in this research.
- `CLAUDE.md:31-39` — the convention itself, with the 2026-07-03 incident as the recorded reason.

**Control plane (all single-database):**
- `src/db/client.ts` — the one Supabase client; reads `process.env.SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY`. Whatever the Render service's env says is the database for every
  seat.
- `src/control/badges.ts:9-21` — `mintBadge()` / `sha256hex()`: 32-byte random badge, plaintext
  returned once in the pull response, only the fingerprint persists.
- `src/control/badgeFile.ts:33-79` — `buildBadgeResponse(hostId)`: mints on first pull for rows
  with null `badge_hash` (CAS via `claimBadgeHash`, `src/db/technicians.ts:156-170`), flags
  `revoked: true` for offboarding/offboarded rows.
- `src/composio/sessions.ts:32-91` — `sessionConfigForTier()` (manager: full catalog +
  `manageConnections: true`; technician: pinned 3-tool Gmail list, send impossible) and
  `ensurePersonSession()` (idempotent; keyed by `compositeUserId` =
  `"${tenant_id}:${ref}"`, `src/composio/pairing.ts:71-73` — note the tenant UUID is baked into
  the Composio user identity).
- `src/mcp/identity.ts:41-63` — verifies the doorman's `x-identity-signature`
  (HMAC-SHA256 over `"${tenantId}.${technicianRef}"` with `GATEWAY_IDENTITY_SECRET`).
- `docs/control-plane.md:55-91` — Render env contract. Web service: `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `GATEWAY_IDENTITY_SECRET`, `COMPOSIO_WEBHOOK_SECRET`,
  `ANTHROPIC_API_KEY`. Cron: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COMPOSIO_API_KEY`
  only.

**Roster / seats (all rows live in whichever DB the control plane points at):**
- `supabase/migrations/20260702194603_technicians_and_review_items.sql:8-51` — `technicians`
  table (tier/state enums, `badge_hash`, `host_id`, `sandbox_ref`), seat-cap trigger
  `enforce_seat_cap()` reading `tenants.manager_seats` / `technician_seats` — **migration
  defaults are 1 manager / 0 technician seats**.
- `supabase/migrations/20260703010056_control_plane_lifecycle.sql:4-9` — `hosts` table
  (`name`, `token_hash` for the pull token).
- `supabase/migrations/20260620005307_context_spine.sql:136` — seeds `'Default Tenant'`; the
  pilot's tenant UUID `82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18` is generated, so a fresh prod DB
  gets a **different** tenant UUID.
- Roster-row creation paths (only two): the manager MCP tool `add_technician_seat`
  (`src/mcp/server.ts:1011-1041`, requires an already-active manager badge) and
  `scripts/seed.mjs:121-136` (`seedRoster`, local/`--with-roster` only). Both call
  `insertTechnician` (`src/db/technicians.ts:42-62`); rows land as `'invited'`.

**Box side (trades-box-1, per-seat wiring):**
- `Box_Setup_Stuff/doorman.mjs` + setup guide §3 — the doorman: binds `172.18.0.1:3001`, ONE
  `MCP_UPSTREAM_URL` (currently `https://tradesdatabase.onrender.com/`) and ONE badges file per
  instance (`/etc/doorman/doorman.env`, systemd unit `doorman.service`). Signs identity with the
  host-only `GATEWAY_IDENTITY_SECRET`, which **must match the Render service it forwards to**.
- Setup guide §4b (lines 412-448) — the verified non-interactive seat onboard: hydrated
  messaging plan (Telegram bot token validated with `getMe` first, transported base64),
  `nemoclaw onboard --non-interactive`, manual host-side provider create+attach
  (`<AGENT>-telegram-bridge` with `TELEGRAM_BOT_TOKEN` + `TRADES_SPINE_BADGE`).
- Setup guide §5 — egress policy (5a), badge as provider credential (5b, plus the placeholder
  versioning trap), MCP config + `toolSearch:false` (5c) unless the §6 bake-in is applied.
- Setup guide §0c — two required AGENTS.md instruction blocks (accuracy rules +
  confirm-before-permanent-writes), re-appended after any rebuild.
- Setup guide §0b — the manager Composio session wiring is **BLOCKED as designed** (verified
  2026-07-05): the session `mcp.url` alone gets HTTP 401, and the only working auth header is
  the master `COMPOSIO_API_KEY`, which must never enter a sandbox. Until the composio-doorman
  relay (agreed design, RPI pending) exists, manager sandboxes get NO direct Composio MCP entry
  — on the pilot AND on any prod deployment alike. Manager seats still get the 16 spine tools.
- Setup guide §7 — reboot resilience: `nemoclaw-agent-revive` per-agent units,
  `sandbox-token-medic`, 30-day JWT TTL source edit. All per-sandbox, database-agnostic.

## Data Flows

The seat's request path — the database is decided at the LAST hop, by the Render service's env:

```
Telegram user
   │
   ▼
sandbox <AGENT> on trades-box-1 (holds only TRADES_SPINE_BADGE)
   │  Authorization: Bearer <badge>
   ▼
doorman @172.18.0.1:3001  ── ONE upstream per instance ──►  Render web service
   (badge → fingerprint lookup,                              (verifies HMAC identity,
    signs x-identity-signature                                looks up roster row → tier,
    with GATEWAY_IDENTITY_SECRET)                             reads/writes via
                                                              SUPABASE_URL env)
                                                                   │
                                                                   ▼
                                                     ONE Supabase project
                                                     (today: pilot daqapdlkgxfrhquacprv)
```

Seat provisioning (the pilot-verified sequence, for reference):

```
1. Roster row exists (seed, or a manager's add_technician_seat)   [in the target DB]
2. assign-host.mjs create-host (once per box) + assign ref→host+sandbox
3. Box badge-pull (5-min timer) hits /control/badges → mints badge → pending-badges.jsonl
4. §4b non-interactive onboard on the box (bot token, sandbox build)
5. openshell provider create/attach + badge install (§5b) + egress policy (§5a)
6. §0c blocks (+§0b manager block) appended to AGENTS.md; boot <AGENT> revive unit
7. Render cron (≤15 min) mints the person's Composio session (ensurePersonSession)
```

Every step from 1-3 and 7 reads/writes the control-plane database; none of it exists for prod.

## External Dependencies

- **Supabase** — pilot project (live), prod project (empty, auto-pauses when idle), local Docker
  stack. Data API grants: the pilot was created under the legacy auto-expose behaviour; the local
  stack fakes parity via `auto_expose_new_tables = true` in `supabase/config.toml:19-31`, a flag
  **Supabase removes 2026-10-30**. The planned replacement (an explicit GRANT/default-privileges
  migration, tracked in `thoughts/shared/plans/2026-07-03-local-test-stack-and-roster-safety.md:85`)
  does not exist yet. A fresh prod project is created under the NEW behaviour — migration-created
  tables get no Data API grants, so **without the GRANT migration, every supabase-js call against
  prod fails `permission denied`**. For prod, the GRANT work is a prerequisite, not a follow-up.
- **Render** — one web service + one cron job (`tradesdatabase.onrender.com`), both env-pinned to
  the pilot. Free-tier cold start ~32s exceeds the agent's 30s MCP connect timeout (setup guide §8).
- **Composio** — sessions keyed by `"${tenant_id}:${ref}"`; master `COMPOSIO_API_KEY` is
  control-plane-only; §0b sandbox wiring blocked pending the composio-doorman relay.
- **AWS Lightsail** — trades-box-1 (static IP, SSH `tradesbox`).
- **NVIDIA NIM** — `z-ai/glm-5.2` inference for sandboxes.
- **Telegram** — one bot token per seat (the seat's entire UI).

## Constraints and Invariants

- **One database per control plane.** `SUPABASE_URL` on Render is the only database selector;
  seats cannot be pointed individually.
- **One upstream per doorman instance.** `/etc/doorman/doorman.env` has a single
  `MCP_UPSTREAM_URL` and a single badges file; the badge-pull unit has a single `PULL_URL` +
  `HOST_PULL_TOKEN`. A prod-connected seat on the same box cannot share the pilot doorman.
- **`GATEWAY_IDENTITY_SECRET` pairs a doorman with a Render service.** A second control plane
  needs its own secret on both ends.
- **Badges are meaningless across databases.** A badge's fingerprint lives in a `technicians`
  row; tier is decided server-side by that row. A prod-connected manager needs an ACTIVE
  `tier='manager'` row in the PROD database — the pilot roster is invisible to a prod control
  plane.
- **Seat caps default to 1 manager / 0 technicians** (migration default) — a fresh prod tenant
  can hold one manager row without touching `setTenantSeats`.
- **Tenant UUIDs differ per database.** The pilot default-tenant UUID is hardcoded as a fallback
  in `assign-host.mjs:79` and `provision-session.mjs:41`; against prod those fallbacks would be
  wrong even if the ref-guards were lifted.
- **Composio user identity embeds the tenant UUID** — a prod roster generates distinct Composio
  user_ids/sessions from the pilot's, even for the same human.
- **L1 is append-only in any database** — the same trigger + conventions apply from migration 1;
  a prod DB inherits the no-delete property immediately.
- **The prod "read-only" status lives in config and convention** — the MCP server's
  `read_only=true` setting plus the four script guards; the underlying Supabase project itself
  has no write protection of its own.
- **Prod pauses when idle** (free tier); it un-paused itself today only because it was queried.

## Decision Points

1. **Where the prod control plane runs.** The code supports one `SUPABASE_URL` per deployment.
   Options given today's shape: (a) a second Render web service + cron with prod env
   (`SUPABASE_URL`, service-role key, its own `GATEWAY_IDENTITY_SECRET`, `COMPOSIO_API_KEY`), or
   (b) retargeting the existing Render service — which moves the ENTIRE pilot (every existing
   seat, webhook, badge pull) to prod at once, not just the new seat.
2. **How the new seat's doorman path is wired.** On trades-box-1, options are a second doorman
   instance (new port, own env file, own badges.json, own badge-pull unit/token, plus the §5a
   egress policy and §5c/§6 MCP URL for the new sandbox pointing at the new port) — or a second
   box bootstrapped from `bootstrap-box.sh` with prod URLs. The current bootstrap defaults
   (`bootstrap-box.sh:28-29`) hardcode the pilot Render URL.
3. **What happens to the four write-guards.** `assign-host.mjs`, `provision-session.mjs`, and
   `seed.mjs` all hard-refuse non-pilot targets, and `.env.example` forbids prod credentials in
   `.env`. Any prod control plane needs a decision on how these scripts learn about a second
   allowed ref (and where prod credentials live), since today "prod rollout is a deliberate,
   separate step" is encoded as a refusal, not a flag.
4. **Schema + grants on prod.** Prod needs all 12 migrations (one still uncommitted on this
   branch) AND the not-yet-written GRANT/default-privileges migration, because a fresh project
   lacks the legacy auto-expose behaviour the pilot relies on. Sequencing relative to the
   2026-10-30 flag removal is part of this choice.
5. **Composio tenancy for prod.** Same Composio org/project with new composite user_ids (pilot
   and prod sessions coexist under one master key), or a separate Composio project with its own
   `COMPOSIO_API_KEY`. Either way the §0b sandbox wiring stays blocked until the
   composio-doorman relay ships.
6. **Prod project keep-alive.** An idle prod pauses; the badge-pull (5-min) and cron (15-min)
   would keep it awake once a control plane exists — until then anything scheduled against it
   meets a paused database.
7. **What data prod starts with.** `seed.mjs` refuses prod by design; the only in-band roster
   path is `add_technician_seat`, which itself requires an existing active manager badge — a
   bootstrap-order fact: the FIRST prod roster row must come from some out-of-band write (the
   pilot used seeding).

## Open Questions

- Which Supabase plan is the prod project on, and is auto-pause acceptable for it? (Paused +
  restore-on-demand added ~60s of unavailability today.)
- Does the prod project's region/tier match the pilot's (relevant for Render→Supabase latency
  and the 30s MCP connect timeout)?
- Is there an existing Render account plan for a second service, and does the free-tier cold
  start (~32s > agent timeout) matter more or less for prod?
- Who holds prod's `SUPABASE_SERVICE_ROLE_KEY` and where would it live, given `.env.example`
  forbids prod credentials in the repo checkout's `.env`?
- Is the intended manager a new human (new Telegram bot + token) or an existing person also
  present on the pilot (same human, but necessarily a distinct badge, roster row, Composio
  user_id, and sandbox)?
- Should the uncommitted `20260706090000_retraction_rows.sql` land before any prod schema
  application, so prod never exists in a pre-retraction shape?
- `supabase/config.toml`'s `project_id`/ports serve the LOCAL stack only — nothing in the repo
  links the CLI to either hosted project; how migrations would be applied to prod (CLI link vs
  MCP `apply_migration`) is unrecorded.
