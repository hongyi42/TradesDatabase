---
date: 2026-07-02
task: Control-plane lifecycle (Plan 2) — badge generate+pull, Composio pairing/offboarding automation, verify-after-connection, grace-period expiry via a scheduled job
research: thoughts/shared/research/2026-07-02-control-plane-lifecycle-surface.md
status: draft
---

## Overview

Plan 1 built the roster ledger; nothing advances it. This plan gives it hands: badges become
DB-backed (hashes only) and flow to hosts by pull; the manager's chat can mint a Gmail Connect
Link; pairing completion is detected, the mailbox verified with the manager, and the row walks
`invited → pending_verification → active`; deactivation disables (not deletes) the pairing, and a
Render Cron Job expires the grace period into permanent `offboarded` with Composio teardown.

*Length flag: 386 lines (>300 guideline). The cycle is already split (this is Plan 2 of 2); the
overage is the decisions record plus adversarial-review fixes (9 findings baked in verbatim so
the implementer can't re-introduce them) — kept because each removes a specific failure mode.*

## Decisions

User-made (2026-07-02 decision brief):
- **Badge distribution** — host PULLS its badges.json from an authenticated server endpoint
  (fits host→server-only connectivity; revocation latency = poll interval; roster gate already
  cuts mail/tools instantly). Generate+hand-apply is the day-one fallback.
- **Badge storage** — HASHES only (sha256), in DB and in badges.json keys; the doorman hashes the
  presented badge before lookup. No live credential at rest anywhere.
- **COMPOSIO_API_KEY on the Render service** — it already holds the service-role key; tools
  return only redirect URLs, never key material.
- **Scheduler** — Render Cron Job (verified: at-most-one-concurrent-run, ~$1/mo) every 15 min.
- **Grace clock** — new `offboarding_started_at` column (`updated_at` resets on any write).
- **connected_email source** — SDK typings have NO email field on connected accounts (verified
  offline 2026-07-02), so execute `GMAIL_GET_PROFILE` pinned to the `connectedAccountId`.
  E2E also logs the raw account object once in case an untyped field exists.
- **pending_verification** — mail ingests normally; ONE `pairing_verification` review item
  (carrying the fetched address); window captures get `sourceMeta.pendingVerification: true`.

Implementation decisions (planner-made):
- **Mint-on-first-pull** — badge plaintext is generated during the host's pull request and
  returned once in that response; only the hash is stored. Lost badge → operator clears
  `badge_hash`, next pull re-mints. No plaintext at rest, no delivery queue.
- **Person→host assignment stays operator-side** (`scripts/assign-host.mjs` sets
  `host_id`+`sandbox_ref`), per the standing "sandbox provisioning is operator-side" decision.
- **Rate limit = per-person link cooldown** (`link_issued_at`; refuse re-issue within 5 min).
  Structural, replica-safe; broader rate limits stay deferred (recorded in Plan 1).
- **Pairing confirmation rides `resolve_review`** — resolving a `pairing_verification` item sets
  the row `active`; dismissing keeps it pending. No new confirm tool.
- **`reactivate_technician_seat` added** — the grace period is useless without an undo surface;
  seat-cap trigger enforces capacity on reactivation.
- **ca_*/ti_* ids are KEPT after offboarding** (history/audit); Composio objects are deleted,
  columns are not nulled. `GRACE_DAYS` env (default 7), reminder review item at 2 days left.
- **SDK facts verified offline** (installed `@composio/core` typings): `connectedAccounts.link/
  get/list/delete/enable/disable/waitForConnection`, `triggers.create/delete/enable/disable/
  listActive` (accepts `connectedAccountIds`). `link()` has no expiry option — treat URLs as
  sensitive; deliver via the manager only. **`tools.execute` requires
  `dangerouslySkipVersionCheck: true`** (no pinned toolkit version configured; without it the
  SDK throws `ComposioToolVersionRequiredError` on every call — review finding).
- **Pairing-item semantics (review findings):** `checkPairing` acts only on `state='invited'`
  (the transition is the gate — the item opens exactly once per pairing episode). Resolving a
  `pairing_verification` item advances the row ONLY from `pending_verification` (a stale item on
  an offboarding row resolves without touching state). **Dismissing = wrong mailbox**: teardown
  the pairing (delete trigger+account), clear ca/ti/email, state → `invited` so a fresh link can
  be issued. Deactivation closes any open pairing item for the ref.
- **Grace-clock self-heal:** an `offboarding` row with NULL `offboarding_started_at` (deactivated
  between phase deploys) is stamped `now()` by the expiry job and skipped that run — never NaN,
  no backfill migration needed. **Reminders fire once per episode**: any-status dedup on
  `detail->>startedAt` (the `flagUnknownRefCapture` pattern), so a dismissal sticks.

## Plain-language walkthrough

**Phase 1 — the database learns about badges and hosts.** New columns and a small `hosts` table:
each badge is stored only as a fingerprint (hash), each person can be assigned to a host machine,
and offboarding gets a start-time column so a timer can measure the grace period.

**Phase 2 — hosts fetch their own badge file.** Each host gets a token; every few minutes it asks
the server "what should my badges.json be?" — brand-new people get their badge minted in that
moment (the only time the real value exists), deactivated people show up revoked. The doorman
now compares fingerprints, so the file on disk contains no usable secrets:

```
host (every 5 min) ──token──▶ Render /control/badges ──▶ { file of hashes,
   │                                                       new badges (once) }
   └─ writes /etc/doorman/badges.json (doorman:doorman, 600)
      doorman: hash(presented badge) → lookup            ✅ revocation ≤ poll interval
```

**Phase 3 — pairing becomes a chat action.** The manager types "connect Jane's Gmail" → the
server mints a Connect Link (a Composio-hosted OAuth page) → Jane approves → the server notices,
creates the mail trigger, asks Gmail "which mailbox is this?", and opens a review item: *"Jane's
pairing connected jane.doe@gmail.com — is that right?"* Confirming makes her `active`.

**Phase 4 — deactivation gets teeth, and an undo.** Confirming a deactivation now also stamps the
clock, disables (not deletes) the Gmail pairing, and the badge shows up revoked on the next host
pull. A new `reactivate_technician_seat` tool undoes all of it during the grace week.

**Phase 5 — the heartbeat.** One small Render Cron Job every 15 minutes: notices completed
pairings, sends the "2 days left" reminder, expires finished grace periods (permanent Composio
delete + `offboarded`), and runs the schedule-sheet sync that has never had a caller.

## Secrets & env preflight

- **Phase 1:** none new (Supabase env already required).
- **Phase 2:** none — host tokens are generated by `scripts/assign-host.mjs`, shown once.
- **Phase 3:** `COMPOSIO_API_KEY` in `.env` AND on the Render service (Composio dashboard →
  Settings → API Keys; the local `.env` currently does NOT have it — collect first).
  `COMPOSIO_GMAIL_AUTH_CONFIG_ID` (= `ac_5CdPk4l3GV2V`, dashboard → Auth Configs; not secret).
- **Phase 4:** same as Phase 3.
- **Phase 5:** `GRACE_DAYS` (optional, default 7); `SCHEDULE_SHEET_ID` +
  `GOOGLE_APPLICATION_CREDENTIALS` (optional — sheet sync skips if unset); Render dashboard
  access (human) to create the Cron Job service and set env vars on both services.

## Phase 1: Schema + typed layer (hosts, badge hash, grace clock)

### What this phase does
Adds the control-plane columns/tables and their typed access. No behavior change.

### Changes required

**`supabase/migrations/<ts>_control_plane_lifecycle.sql`** (apply via
`mcp__supabase-test__apply_migration`, then rename to ledger version):
```sql
create table hosts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  token_hash text not null unique,      -- sha256 hex of the pull token
  created_at timestamptz not null default now()
);
alter table technicians
  add column badge_hash text unique,     -- sha256 hex; plaintext NEVER stored
  add column host_id uuid references hosts(id),
  add column offboarding_started_at timestamptz,
  add column link_issued_at timestamptz;
```

**`src/db/database.types.ts`** — regenerate (`mcp__supabase-test__generate_typescript_types`).

**`src/control/badges.ts`** (new) — `mintBadge(): {badge, hash}` (32 random bytes hex +
`sha256hex`), `sha256hex(s)` exported (doorman parity + host-token hashing).

**`src/db/hosts.ts`** (new) — `createHost(name, tokenHash)`, `getHostByTokenHash(tokenHash)`.
**`src/db/technicians.ts`** — add `listTechniciansForHost(hostId)`;
`listTechniciansInStates(states: TechnicianState[])` (cross-tenant control-plane read — the
expiry job and pairing sweep need it; CLAUDE.md keeps all queries in `src/db/`);
`updateTechnician(id, patch)` (typed partial: `badge_hash`, `host_id`, `sandbox_ref`,
`offboarding_started_at`, `link_issued_at`, `composio_connected_account_id`,
`composio_trigger_id`, `connected_email`, `state`) — one setter, callers stay explicit.
**`src/db/index.ts`** — export hosts.

**`scripts/assign-host.mjs`** (new, fail-closed arg parsing like composio scripts) —
`--create-host name=<n>` prints the one-time pull token (hash stored);
`assign ref=<ref> host=<name> sandbox=<sandbox_ref>`.

**New `src/db/hosts.test.ts` + extend `src/db/technicians.test.ts`** (live test project,
self-cleaning): host create/lookup by hash; updateTechnician round-trip; badge_hash uniqueness.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (113/113, 20 files; +4 new tests)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP.
- [x] `execute_sql`: rolled-back DO block — all 4 new columns writable, hosts insert OK,
      `badge_hash dup=[unique_violation (23505) raised]`; residue check 0/0. Migration in the
      ledger as `20260703010056 control_plane_lifecycle`. Adversarial review: NO FINDINGS.

### Manual verification
- (none)

---

## Phase 2: Badge pull endpoint + hash-lookup doorman

### What this phase does
`GET /control/badges` (host-token auth) returns the host's badges.json content (hash-keyed) and
mints new badges inline. Doorman + Box Setup Stuff updated to hash-lookup + a pull script.

### Changes required

**`src/control/badgeFile.ts`** (new) — `buildBadgeResponse(hostId)`:
rows = `listTechniciansForHost(hostId)`; if `badge_hash` null AND state not inactive →
`mintBadge()`, `updateTechnician` the hash, add to `newBadges: [{ref, tenantId, badge}]`;
**rows still lacking a `badge_hash` (never-minted inactive rows) are SKIPPED** — else the file
gets a literal `"null"` key; file entry `{[badge_hash]: {tenantId, technicianRef: ref, revoked:
isInactiveState(state)}}`. Returns `{badgesFile, newBadges}`.

**`src/mcp/httpServer.ts`** — in `handle()` (`:111-138`), BEFORE `allowed()` (own auth, like
`/inbound/`): `if (req.url === '/control/badges' && req.method === 'GET')` → read
`Authorization: Bearer <token>`, `getHostByTokenHash(sha256hex(token))`; unknown → 401 (no
detail); known → 200 JSON `buildBadgeResponse(host.id)`.

**`Box Setup Stuff/doorman.mjs` + `docs/doorman-runbook.md` (embedded copy `:130-177`)** —
lookup becomes `loadBadges()[sha256hex(badge)]` (**add `createHash` to the existing
`node:crypto` import — only `createHmac` is imported today**). Runbook badge-issue
section (`:179-205`, `:296-305`) rewritten: badges come from the roster via pull; manual issuance
= legacy fallback (hash the token yourself).

**`Box Setup Stuff/badge-pull.sh`** (new) + guide/architecture-memory sections (self-contained;
push to main per standing permission): every 5 min via systemd timer — curl the endpoint with the
host token (root-owned env file), on change atomically replace `/etc/doorman/badges.json` +
restore `doorman:doorman` mode 600; `newBadges` are printed to a root-only file for the host
operator/Claude to install as sandbox provider credentials (badge swap = provider-version bump —
placeholder-versioning trap note).

**New `src/control/badgeFile.test.ts` + httpServer test** — stubbed rows: mints once (second call
returns same hash, no newBadges), revoked entry for offboarding row WITH a hash, never-minted
inactive row omitted entirely (the combination case); endpoint: bad/missing token → 401, good
token → shape.

### Automated verification
- [x] gates + new tests pass (118/118, 22 files; +3 badgeFile unit, +2 endpoint integration)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; local `npm run mcp:serve:http`.
- [x] Ran live 2026-07-02: `assign-host.mjs create-host` (one-time token) + `assign` on a probe
      row; local server :8097 — no-auth 401, wrong-token 401 (bare); pull 1 returned plaintext
      badge once + fingerprint-keyed entry, pull 2 `newBadges: []`; sha256(badge) `236f42b1…`
      matched both the file key and the DB `badge_hash` read-back; probe rows deleted.
      Adversarial review: 3 MINOR (mv-atomicity fixed in badge-pull.sh; checkbox recording —
      this entry; .DS_Store left unstaged). Doorman hash-lookup exercised on a real host in
      Phase 5's E2E.

### Manual verification
- (none — real-host rollout happens with the host Claude after deploy, tracked in Phase 5)

---

## Phase 3: Composio pairing lifecycle + verify-after-connection

### What this phase does
Server-side Composio client; `get_connect_link` admin tool; pairing-completion check that writes
`ca_*`/`ti_*`/`connected_email`, opens the verification review item, and advances state;
`resolve_review` confirmation → `active`; webhook stamps window captures.

### Changes required

**`package.json`** — move `@composio/core` to `dependencies`.

**`src/composio/pairing.ts`** (new; `Composio` lazy-init so tests never need the key; all
functions take a `client` dep for stubbing):
- `createConnectLink(tech)` → `connectedAccounts.link('<tenantId>:<ref>',
  COMPOSIO_GMAIL_AUTH_CONFIG_ID)` → `redirectUrl`; sets `link_issued_at`.
- `checkPairing(tech)` — **no-op unless `tech.state === 'invited'`** (the transition is the gate:
  the review item opens exactly once per episode; a dismissed item is never re-opened by the
  cron). If an ACTIVE gmail account in `connectedAccounts.list({userIds: [composite]})`: ensure
  trigger (`triggers.listActive({connectedAccountIds: [ca]})`; create `GMAIL_NEW_GMAIL_MESSAGE
  {interval:1, labelIds:'INBOX', userId:'me'}` if absent — `triggers.create` errors on repeat),
  fetch address via `tools.execute('GMAIL_GET_PROFILE', {connectedAccountId, arguments:{},
  dangerouslySkipVersionCheck: true})` — **the skip flag is REQUIRED**: with no pinned toolkit
  version the SDK throws `ComposioToolVersionRequiredError` (review blocker; Tools.ts:893-898) —
  (log raw account object once — untyped email field check), `updateTechnician` ca/ti/email,
  state → `pending_verification`, open `pairing_verification` review item (subjectRef=ref,
  detail `{email, connectedAccountId}`).
- `unpair(tech)` — wrong-mailbox exit: `triggers.delete(ti)` then `connectedAccounts.delete(ca)`
  (404s swallowed), clear ca/ti/email, state → `invited` (fresh link can be issued; a forced
  re-`link()` on an ACTIVE account would throw `ComposioMultipleConnectedAccountsError`).

**`src/mcp/server.ts`**
- ADMIN_TOOLS + case `get_connect_link {ref}`: roster row must exist, state `invited` or
  `pending_verification`, not inactive; cooldown — `link_issued_at` < 5 min ago → error
  `link already issued — wait a few minutes`; if `checkPairing` says already ACTIVE → say so;
  else return `{url}` with instruction text "forward to the person; the link is sensitive".
- `resolve_review` case (`:451-474`): after the pending_deactivation guard, if the item is an
  open `pairing_verification`: `resolved` → advance to `active` ONLY if the row's current state
  is `pending_verification` (a stale item on an offboarding/offboarded row resolves WITHOUT
  touching state — reactivation stays `reactivate_technician_seat`'s job; map `isSeatCapError`
  to the purchase message here too), state-first then resolve; `dismissed` = wrong mailbox →
  `unpair(tech)` then resolve (exit path — review finding).

**`src/inbound/webhook.ts`** — at the `recordFieldNote` call (`:252-263`): if
`tech?.state === 'pending_verification'` add `pendingVerification: true` to `sourceMeta`
(`sourceMeta?: Json` — no signature change).

**Tests** — `src/composio/pairing.test.ts` (stubbed client: link URL returned; checkPairing
no-ops on non-invited states; idempotent on existing trigger; unpair clears ids + returns to
invited); server.test.ts: cooldown error, resolve_review resolved → active, dismissed → unpair
called; webhook.test.ts: pending stub → metadata stamp present, active stub → absent.

### Automated verification
- [x] gates + new tests pass (129/129, 23 files; +8 pairing unit, +1 server lifecycle,
      +1 webhook stamp); `npm run build` clean with `@composio/core` as a runtime dep

### Live verification (agent-executable)
- Prerequisites: `COMPOSIO_API_KEY` + `COMPOSIO_GMAIL_AUTH_CONFIG_ID` in `.env`; `supabase-test`
  MCP. OAuth consent itself is HUMAN (below).
- [x] Ran live 2026-07-02 through the REAL tool path (in-memory MCP client, identity
      `drill-mgr`, no stubs): `get_connect_link ref=pair-drill` → `link_created` with
      `https://connect.composio.dev/link/lk_…`; immediate second call → cooldown error, no
      second Composio call; read-back `link_issued_at` stamped, state still `invited`.

### Manual verification
- [ ] User opens the link with the test Gmail, approves; then agent runs `checkPairing` live and
      SQL-verifies ca_*/ti_*/connected_email + open `pairing_verification` item + state
      `pending_verification`. (Full-cycle drill continues in Phase 5's E2E.)

---
*Pause after Phase 3 for the OAuth consent drill.*

## Phase 4: Offboarding automation + grace period + reactivate

### What this phase does
Deactivation stamps the clock and disables Composio; expiry logic performs the permanent
teardown; `reactivate_technician_seat` is the undo.

### Changes required

**`src/composio/offboarding.ts`** (new, client-injectable):
- `disablePairing(tech)` — if `composio_trigger_id`: `triggers.disable`; if
  `composio_connected_account_id`: `connectedAccounts.disable`. Advisory per-call try/catch.
- `enablePairing(tech)` — mirror with `enable`.
- `teardownPairing(tech)` — `triggers.delete` then `connectedAccounts.delete` (order matters:
  trigger first so no deliveries race the account delete). Throws on failure (cron retries next
  run — idempotent: 404s from already-deleted objects are swallowed).
- `expireOffboarding(nowIso, deps)` — rows from `listTechniciansInStates(['offboarding'])`:
  **NULL `offboarding_started_at` → stamp `now()` and skip this run** (self-heal for rows
  deactivated between phase deploys — NULL math is NaN and both branches silently miss; review
  finding); remaining ≤ 2 days → open `offboarding_reminder` review item (new ReviewKind member)
  **once per episode: any-status dedup on `detail->>startedAt` = the row's clock value, the
  `flagUnknownRefCapture` pattern — else the 15-min cron re-opens a dismissed reminder ~192
  times** (review finding); remaining ≤ 0 → `teardownPairing`, state → `offboarded`, resolve the
  reminder item. Returns counts.

**`src/mcp/server.ts`**
- deactivate confirm branch (`:428` area): after `setTechnicianState(…, 'offboarding')` →
  `updateTechnician(id, {offboarding_started_at: now})` + advisory `disablePairing` + advisory
  resolve of any open `pairing_verification` item for the ref (a stale item must not survive
  into offboarding — review finding).
- ADMIN_TOOLS + case `reactivate_technician_seat {ref}`: row must be `offboarding` (offboarded →
  error `permanently offboarded — add a new seat`); state → `active` (seat-cap trigger may raise
  → map to the purchase message), clear `offboarding_started_at`, advisory `enablePairing`.

**`src/db/reviewItems.ts`** — add `'offboarding_reminder'` to `ReviewKind` (`:10-14`).

**Tool-count docs (both new admin tools now exist — manager surface is 14, technician still 7):**
`docs/doorman-runbook.md:285-286`, `docs/nemoclaw-tech-agent.md` §4, and the Box Setup Stuff
architecture memory's "Tools by tier" + Verify sections (self-contained; push to main per
standing permission) — a host operator verifying "manager lists 12" would read a correct deploy
as a failure (review finding).

**Tests** — stubbed-client: expire honors GRACE_DAYS boundary (2-day reminder once — dismissed
reminder NOT re-opened on the next run; 0-day teardown; teardown failure leaves state unchanged
for retry; NULL clock → stamped + skipped); reactivate at cap → purchase error; reactivate
offboarded → refused; deactivate stamps clock + disables + closes an open pairing item;
resolve_review on a stale pairing item (offboarding row) does not change state.

### Automated verification
- [ ] gates + new tests pass

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP.
- [ ] Probe row walked offboarding→(force clock back via SQL)→expire → SQL read-back
      `offboarded` + reminder item lifecycle. (Composio calls stubbed here; live in Phase 5.)

### Manual verification
- (none)

---

## Phase 5: Lifecycle cron job + deploy + full-cycle E2E

### What this phase does
One entrypoint the Render Cron Job runs every 15 min; deploy config; the end-to-end drill.

### Changes required

**`src/jobs/lifecycle.ts`** (new) — sequential, each step try/caught + summarized to stdout:
(1) `checkPairing` for every row in `invited`/`pending_verification` with `link_issued_at` set;
(2) `expireOffboarding(now)`; (3) if `SCHEDULE_SHEET_ID` set → `syncScheduleFromSheet(
DEFAULT_TENANT_ID, SCHEDULE_SHEET_ID)` (single-tenant interim — recorded limitation); exit 0
unless a step threw (exit 1 → Render marks the run failed).

**`package.json`** — `"job:lifecycle": "node dist/jobs/lifecycle.js"`.

**`docs/control-plane.md`** (new, brief) — the lifecycle diagram, Render setup (Cron Job service:
build `npm install && npm run build`, command `npm run job:lifecycle`, schedule `*/15 * * * *`,
env: Supabase + COMPOSIO_* + DEFAULT_TENANT_ID + GRACE_DAYS), badge-pull rollout steps.

**Tests** — `src/jobs/lifecycle.test.ts`: steps injectable; one step throwing doesn't skip the
others; exit-code contract.

### Automated verification
- [ ] gates + new tests pass; `npm run build` produces `dist/jobs/lifecycle.js`

### Live verification (agent-executable)
- Prerequisites: `.env` fully populated incl. Composio; `supabase-test` MCP.
- [ ] Run `job:lifecycle` locally against the test project: pairing check + expiry counts in
      output match SQL read-back evidence.

### Manual verification
- [ ] User creates the Render Cron Job + sets env vars (incl. COMPOSIO_API_KEY on the web
      service) per docs/control-plane.md; agent then verifies a live run's output.
- [ ] Full-cycle E2E with the host Claude + real Gmail: add seat → assign host → badge pulled
      (host) → connect link → OAuth consent → verification item → resolve → active → real email
      ingests attributed → deactivate → badge revoked on next pull + mail drops → force-expire →
      Composio objects gone (SDK list read-back) → offboarded. Evidence at every hop (DB rows,
      OCSF logs, Composio list calls).

---
*Cycle ends: badge rollout to the real host + Box Setup Stuff self-contained updates ship with
this phase's manual E2E.*
