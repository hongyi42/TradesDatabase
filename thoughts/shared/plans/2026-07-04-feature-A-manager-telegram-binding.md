---
date: 2026-07-04
task: "Feature A — manager binds a new technician NemoClaw to a Telegram user id from chat, no operator"
research: thoughts/shared/research/2026-07-04-feature-A-automatic-technician-telegram-binding-via-manager-nemoclaw.md
status: phases-1-3-implemented; Phase 4 unblocked (Part B done, recipe known) — not yet built
---

## Overview

Today an operator hand-types a new technician's Telegram user id into `nemoclaw onboard` on the
box. This plan moves the whole act into the manager's Telegram chat: a new manager-tier MCP tool
records the id on the roster, the server auto-claims a pre-built cold sandbox from a pool, the
existing 5-minute badge-pull channel carries the binding to the host, and the host script applies
it to the sandbox's sender allowlist. One prerequisite is unresolved: whether a running sandbox's
allowlist can be re-bound without a rebuild (the 2026-07-03 host experiment is still `PENDING`).
Phases 1–3 are safe regardless; Phase 4 is gated on that answer and produces it.

## Re-anchor 2026-07-07 (post composio-relay + scheduling — READ FIRST)

Re-verified against `main` after the two things this plan stacked behind actually landed: the
**composio-doorman relay** (PR #30, `relayHandler.ts` + `/composio*` route — deployed) and the
**scheduling foundation + `get_schedule` tool** (`5475fb8`/`fdd19c9`). Authoritative corrections —
these OVERRIDE the older inline numbers below wherever they conflict:

- **Tool-count math is now 17 → 18, not 16 → 17.** `get_schedule` landed on the *shared* `TOOLS`
  list, so on current `main` the technician surface is already **10** and the manager surface
  already **17** (asserted `server.test.ts:133,1200` = 10; `:1049,1323` = 17; comment `:1045`).
  Adding `bind_telegram` (an ADMIN tool) makes the manager surface **18**; the technician surface
  **stays 10** and is untouched by this plan. Every "16→17" / "manager 16" phrase below is stale.
- **Fixture list: +1 file, not +3.** The only NEW full-literal `Technician` site since this plan
  is `src/composio/relayHandler.test.ts` (literal ~line 35). `src/db/schema.test.ts` and
  `src/db/scheduling.test.ts` reference `service_cities` but do NOT build full `Technician`
  literals — excluded. All fixtures also gained scheduling's `availability` + `service_cities`
  columns already (commit `c8a34db`); we only add `telegram_user_id: null` beside `sandbox_ref`.
- **`server.ts` anchors shifted** (`get_schedule` + relay landed between draft and now):
  `ADMIN_TOOLS` 239→**265**, `ADMIN_TOOL_NAMES` 339→**365**, dispatch gate 478→**504**,
  `get_connect_link` case 1304→**1406** (ends ~1464, `resolve_review` starts 1465). Re-locate at
  implement time regardless — treat these as the current best anchors, not gospel.
- **`badgeFile.ts` / `technicians.ts` are stable:** `BadgeResponse` still line 18, `TechnicianPatch`
  still line 93; only the badge row-loop drifted 46→48.
- **Migration prefix `20260707000000` still sorts last** (latest committed = `20260706090000`;
  scheduling's `20260704210155` sorts earlier). No change.
- **§0b is UNBLOCKED — the relay is deployed**, so the cold-pool onboarding gap is genuinely
  resolved (cron `ensurePersonSession` + relay give any auto-claimed sandbox Composio access, no
  operator). Phase 4 docs describe the relay path (factual now, not anticipated).
- **RESOLVED 2026-07-07 — the old gate is gone:** Part A (docs) + Part B (host experiment on s2)
  settled the late-re-bind question — a running sandbox's allowlist CAN change with no rebuild and
  no device-key strip via a two-write host recipe. Phase 4 is rewritten with that recipe; it is no
  longer gated. Phases 1–3 are implemented; Phase 4 is unblocked but not yet built.

## Decisions

- **Tool shape** — Option B from the research: a standalone `bind_telegram` admin tool (mirrors
  `get_connect_link`), not an extra arg on `add_technician_seat` — the manager often gets the id
  after adding the seat, and a standalone tool also covers typo re-binds. (Assumption A1.)
- **One-shot write, no two-step confirm** — the id is not a secret and a re-call fixes a mistake
  (the research calls one-shot defensible). Re-binding is allowed and returns the previous value.
  *Re-affirmed by the user 2026-07-06* against the stage→confirm pattern that has since become
  house style (send_email, record_field_note, retract_capture): a wrong bind is reversible by
  re-calling, and the one-confirmation UX rule argues against added ceremony.
- **Column shape** — `telegram_user_id text` (nullable) on `technicians`, tool-validated as
  `^[0-9]{1,20}$`; text, not bigint (JSON/JS number precision; only ever compared). No DB
  uniqueness; the tool rejects an id already bound to another non-inactive row in the tenant
  (residual concurrent race accepted — same rationale as the seat-cap trigger).
- **Server → host carrier** — Option A: extend the badge-pull response (`buildBadgeResponse`)
  with a `bindings` array, not a new endpoint. Reuses the authenticated 5-min channel and its
  "server authoritative, host reconciles" model; additive, so `badge-pull.sh`'s empty-roster
  fail-closed guard (keyed off `.badgesFile` only) is untouched.
- **Cold-pool auto-allocation: minimal allocator IN scope** — without it an operator stays in
  every hire (research decision point 4), violating the Telegram-only principle. A `sandbox_pool`
  table is registered once per host by the operator at initial setup (allowed by the principle);
  `bind_telegram` claims the next free sandbox when the target row has none. Return-to-pool /
  freeze at offboarding stays OUT of scope (Ingredient 3). *Seat-licensing rule (user decision
  2026-07-06): SEATS are reusable, technician REFS never are* — any future return-to-pool design
  may recycle the seat/sandbox slot for a new hire, but the new hire always gets a fresh ref; a
  pool row's claim history must never let an old ref be reassigned to a new person.
- **Host-apply mechanism** — `RESOLVED 2026-07-07 (Part B)`. The pull script applies the allowlist
  automatically via the **two-write recipe** (source `sandboxes.json allowedIds` + rendered
  openclaw.json/`.config-hash` + `gateway restart`) — no operator, no rebuild, no device-key strip.
  The old "build-time-only → staging fallback" branch is moot; full operator-removal is achieved.
  See Phase 4 and research doc `2026-07-03-cold-sandbox-identity-injection.md`.
- **Unbind at offboarding** — out of scope. Deactivation already fails closed on spine tools;
  bindings ship only for non-inactive rows and the host applies additively (never unbinds).
- **Bot-token provenance** — assumed pre-built cold sandboxes already carry their per-seat bot
  token (the onboard wizard requires one at build); if false, a scope gap to raise at review (A3).

## Assumptions (non-interactive run — would otherwise have been a decision brief)
- **A1**: product-facing choices above were made by me on the research's evidence; the human
  reviewer of this draft can overturn any before `/implement`.
- **A2**: the adversarial plan review (plan.md step 7) could not run as a fresh-context subagent
  here; substituted a self-review re-checking every path, line number, and caller as read.
- **A3**: cold sandboxes carry a bot token; roster `sandbox_ref` is byte-identical to the
  `<AGENT>` name `openshell`/`nemoclaw` expect (research open question 4 — Phase 4 verifies both).
- **A4**: the names `bind_telegram` / `sandbox_pool` are mine — nothing depends on them yet.

## Plain-language walkthrough
**Phase 1 — the data model.** The roster table gains `telegram_user_id` (the numeric Telegram
account id a sandbox should listen to) and a new `sandbox_pool` table: the pre-built, unassigned
agent sandboxes on each host — a rack of blanks the operator fills once at box setup; hiring
takes one off the rack automatically.

**Phase 2 — the manager's new chat tool.** `bind_telegram`: "connect ref `jane-doe` to Telegram
user id 12345678". The server checks the caller is an active manager, validates the id, refuses
an id already bound to someone else, claims a free pool sandbox if Jane has none, and writes the
id to her roster row. This replaces messaging an operator.

**Phase 3 — carrying it to the box.** The host already phones home every 5 minutes for badge
credentials; the bindings ride the same reply — one more parcel on the existing route.

**Phase 4 — applying it on the box.** The pull script sets each sandbox's "sender allowlist" (the
one Telegram account its bot answers). Whether a running sandbox accepts this without a rebuild
is the open experiment; this phase proves that first, then wires whichever mechanism is real.

```
Manager chat ─▶ bind_telegram ─▶ roster row (telegram_user_id, sandbox from pool)
                    │ every 5 min: GET /control/badges → { badgesFile, newBadges, bindings }  ← P3
                    ▼
    host badge-pull.sh applies allowlist (← P4) ─▶ technician's NemoClaw answers that Telegram user
```

## Secrets & env preflight

- **Phases 1–3:** `.env.test` for the local Supabase stack — `already required`. Nothing new
  (tests inject identity + stub seams as `server.test.ts` already does).
- **Phase 4:** SSH to trades-box-1 (`ssh tradesbox`, already configured); the host's existing
  `HOST_PULL_TOKEN` (already on the box). No new repo secrets; OpenShell docs are public.

## Phase 1: Roster column + sandbox pool (data model & DB layer)

### What this phase does
Adds `technicians.telegram_user_id` and the `sandbox_pool` table, exposes both through the typed
DB layer, adds operator pool registration to the CLI, and updates the `Technician` test fixtures.

### Changes required

**`supabase/migrations/20260707000000_telegram_binding_and_sandbox_pool.sql`** (new — renamed
2026-07-06: the original `20260704120000` prefix collides exactly with Feature B's landed
`20260704120000_agent_action_sensitivity_sessions.sql`; the new prefix must sort after
`20260706090000_retraction_rows.sql`, which is now committed)
```sql
alter table technicians add column telegram_user_id text;
create table sandbox_pool (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  host_id       uuid not null references hosts(id),
  sandbox_ref   text not null,
  technician_id uuid unique references technicians(id), -- null = free (cold)
  created_at    timestamptz not null default now(),
  unique (host_id, sandbox_ref));
create index idx_sandbox_pool_tenant on sandbox_pool(tenant_id);
```

**`src/db/database.types.ts`** — REGENERATE from a local stack containing ALL landed migrations
(Feature B's sensitivity/sessions, scheduling `20260704210155`, retraction `20260706090000`) plus
this plan's (do not hand-edit: the `technicians` Row is now at ~line 606 and already carries
`composio_session_id`, `availability`, and `service_cities`). The regenerated file must show
`telegram_user_id: string |
null` on the Row plus Insert/Update variants, and a full `sandbox_pool` table block
(Row/Insert/Update/Relationships), mirroring the `hosts`/`technicians` style.

**`src/db/technicians.ts`** — add `telegram_user_id?: string | null` to `TechnicianPatch` (still
line 93; place it beside `composio_session_id`, which Feature B added to the same interface); add `findTechnicianByTelegramUserId(tenantId, telegramUserId): Promise<Technician | null>` —
select where tenant + id match and state not offboarding/offboarded; `.limit(1)` + first row
(no uniqueness is enforced, so `.maybeSingle()` could throw on legacy dupes).

**`src/db/sandboxPool.ts`** (new) — `registerSandbox({tenantId, hostId, sandboxRef})`;
`getPoolRowByTechnician(technicianId)` (idempotent-recovery read); `listFreeSandboxes(tenantId)`
(order by created_at); `claimSandbox(id, technicianId)` — write-if-null (`.is('technician_id',
null)`, `.maybeSingle()`), the `claimBadgeHash` pattern, so two claims cannot take one sandbox.
Export via **`src/db/index.ts`** (`export * from './sandboxPool.js';`).

**`scripts/assign-host.mjs`** — new `add-sandbox` command (`KNOWN_KEYS` entry
`['host','sandbox','tenant']`, line 44): look up the host by name, insert a pool row. Keep the
hosted-test-ref write guard untouched.

**Fixtures gaining `telegram_user_id: null`** (full-literal `Technician` builders otherwise fail
the typecheck; anchors re-verified against main 2026-07-07 — add beside `sandbox_ref:`):
`src/control/badgeFile.test.ts`:18, `src/jobs/lifecycle.test.ts`:36, `src/composio/pairing.test.ts`:26,
`src/composio/offboarding.test.ts`:24, `src/inbound/webhook.test.ts`:90,
`src/composio/outbound.test.ts`:17, `src/composio/sessions.test.ts`:22,
`src/composio/logIngest.test.ts`:19, and **NEW since draft** `src/composio/relayHandler.test.ts`:35
(the relay's technician mock). (`server.test.ts` / `httpServer.test.ts` / `technicians.test.ts`
build rows via `insertTechnician` helpers, not literals — no fixture edit. `src/db/schema.test.ts`
and `src/db/scheduling.test.ts` reference `service_cities` but build no full literal — excluded.)

**`src/db/technicians.test.ts`** + **`src/db/sandboxPool.test.ts`** (new) — local-stack tests:
`telegram_user_id` patch round-trip; claim-once semantics (second `claimSandbox` returns null);
tenant scoping of `listFreeSandboxes`.

### Automated verification
- [x] `npx supabase db reset` applies the migration on the LOCAL stack (never hosted)
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (suite pinned local by testEnvGuard);
      the new tests above pass — 318 passed / 1 skipped

### Live verification (agent-executable)
- Prerequisites: local Supabase stack (Docker) — nothing beyond the suite.
- [x] `docker exec supabase_db_TradesDatabase psql -U postgres -c "\d technicians"` shows the new
      column; `"\d sandbox_pool"` shows the table (cross-channel read-back of the migration).
      Verified 2026-07-07 by a fresh-context subagent: `telegram_user_id text` nullable, both UNIQUE
      constraints, all three FKs, `idx_sandbox_pool_tenant` all PASS. (Review round 2 fixed a missing
      `add-sandbox` CLI handler branch.)

### Manual verification
- [ ] none — continue to Phase 2.

## Phase 2: `bind_telegram` manager tool

### What this phase does
Adds the eighth admin tool — validate the id, guard the target, auto-claim a cold sandbox when
the row has none, write `telegram_user_id` — and updates the tool-surface docs (manager 17 → 18;
the technician surface stays 10 — see the re-anchor banner; the code implements 17→18).

### Changes required

**`src/mcp/server.ts`**
- New `ADMIN_TOOLS` entry (line 265): name `bind_telegram`; description says the id is numeric
  (via @userinfobot) and the binding reaches the box within ~5 min; schema: `ref` (required),
  `telegramUserId` (required). `ADMIN_TOOL_NAMES` (line 365) picks it up, so the dispatch gate at
  line 504 covers it with no extra code. (Anchors re-verified 2026-07-07 against main; still
  re-locate at implement time.)
- New `case 'bind_telegram'` after `get_connect_link` (case starts line 1406, ends ~1464;
  `resolve_review` follows at 1465):
  1. Require `ref` + `telegramUserId`; reject unless `/^[0-9]{1,20}$/.test(telegramUserId)`.
  2. `getTechnician(tenantId, ref)`; missing → error; `isInactiveState(target.state)` → error
     ("reactivate the seat first", mirroring line ~1412).
  3. `findTechnicianByTelegramUserId(...)`; a hit with a different `ref` → error naming that ref
     (self-hit = harmless re-bind).
  4. If `!target.sandbox_ref`: first `getPoolRowByTechnician(target.id)` (recovers a claim whose
     roster patch failed mid-flight), else loop `listFreeSandboxes(tenantId)` → `claimSandbox`;
     none → error "no free sandbox in the cold pool — contact support". Then
     `updateTechnician(target.id, { host_id: pool.host_id, sandbox_ref: pool.sandbox_ref })` —
     claim-first order self-heals on retry; the reverse could double-assign one sandbox.
  5. `updateTechnician(target.id, { telegram_user_id: telegramUserId })`; return `{ status:
     previous ? 'rebound' : 'bound', ref, telegramUserId, sandboxRef, previousTelegramUserId,
     note: 'applies to the box within ~5 minutes' }`.

**`src/mcp/server.test.ts`** — new tests (existing patterns): technician badge denied; happy path
writes the column; non-numeric / duplicate id and inactive target rejected; auto-allocation
claims a pool row and patches host_id/sandbox_ref; pool-empty error; re-bind returns previous id.
Also update the absolute tool-count assertions: manager **17 → 18** at lines 1049 and 1323 (the
technician count **10** at lines 133/1200 is untouched by this plan), and update the comment at
line 1045 (currently "17 tools (10 spine + 7 seat/lifecycle)") → "18 tools (10 spine + 8
seat/lifecycle)".

**`docs/nemoclaw-tech-agent.md`** — line 95: "7 of them, for a 17-tool manager surface" →
"8 of them, for an 18-tool manager surface"; add `bind_telegram` to the enumerated seat/lifecycle
list (currently `add_technician_seat` … `resolve_review`).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass; the new `bind_telegram` tests pass
      — full suite 319 passed / 1 skipped

### Live verification (agent-executable)
- Prerequisites: local stack only (dispatch exercised in-process; no live model needed).
- [x] `psql` read-back on the local stack shows a bound row's `telegram_user_id` and the claimed
      `sandbox_pool.technician_id` (independent channel from the tool's own return value).
      Codified in `server.test.ts` (row1/row2/pool `pg.query` read-backs) + confirmed by a
      fresh-context reviewer 2026-07-07: no defects; manager-only gating, claim-first ordering,
      and re-bind previous-id all verified.

### Manual verification
- [ ] none — continue to Phase 3.

## Phase 3: Bindings ride the badge pull

### What this phase does
Extends the per-host pull payload with desired-state bindings so the box learns them on its
existing 5-minute tick; purely additive (old host scripts ignore the new field).

### Changes required

**`src/control/badgeFile.ts`** — `BadgeResponse` (line 18) gains `bindings: Array<{ ref: string;
sandboxRef: string; telegramUserId: string }>`; in the row loop (line 48) push a binding for every
row with `sandbox_ref && telegram_user_id && !isInactiveState(state)`. Inactive or unassigned rows
ship nothing (host applies additively; unbind is out of scope). `httpServer.ts` needs no change —
it serializes `buildBadgeResponse` as-is.

**`src/control/badgeFile.test.ts`** — bound active row ships a binding; inactive bound row and a
row without `sandbox_ref` do not; bindings coexist with `newBadges`.
**`src/mcp/httpServer.test.ts`** — extend the `/control/badges` test (line 56): bind the probe
row, assert `bindings` in the authenticated response (`toMatchObject` keeps old assertions valid).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass, incl. the new binding assertions
      — full suite 322 passed / 1 skipped; `npm run build` also passes

### Live verification (agent-executable)
- Prerequisites: local stack. The deployed pilot's endpoint is NOT exercised — the hosted "test"
  project is the pilot's LIVE DB (read-backs only, no verification writes).
- [x] none beyond the integration test (it already spans HTTP → DB, two channels).
      `httpServer.test.ts` binds `pull-probe` in the DB and reads the binding back over the
      authenticated `/control/badges` HTTP response. Fresh-context reviewer 2026-07-07: no defects
      (binding push precedes all mint-flow `continue`s → independence structurally guaranteed).

### Manual verification
- [ ] none — continue to Phase 4.

## Phase 4: Host-side apply (mechanism RESOLVED 2026-07-07 by Part B — no longer gated)

### What this phase does
Teaches `badge-pull.sh` to reconcile shipped bindings into each sandbox's Telegram sender allowlist,
using the two-write recipe Part B proved: **no operator, no `nemoclaw rebuild`, no device-key
strip.** Updates box docs (Box_Setup_Stuff sync rule: same change as Phase 2's
`nemoclaw-tech-agent.md` edit when committed).

### The mechanism (Part B result — full detail in the research doc + memory [[nemoclaw-telegram-allowlist-rebind]])
The allowlist lives in TWO host-editable places; a durable bind writes BOTH:
1. **Source of truth (durable across rebuilds):** `~/.nemoclaw/sandboxes.json` →
   `sandboxes.<sandboxRef>.messaging.plan.channels[channelId=telegram].inputs[inputId=allowedIds].value`
   (plain string; comma-separated for multiple ids). Confirmed 2026-07-07: no base64 blob overrides
   it, so editing this one field IS the complete source update.
2. **Rendered (what the running gateway enforces, immediate effect):**
   `/sandbox/.openclaw/openclaw.json` → `channels.telegram.allowFrom` — edit it, RECOMPUTE
   `/sandbox/.openclaw/.config-hash` (= sha256 of openclaw.json), `chmod 660` both files, then
   `nemoclaw <sandboxRef> gateway restart`. Proven on s2: the edit survives the restart, gateway
   stays healthy, NO rebuild → NO device-key strip.

Verify with `nemoclaw <sandboxRef> channels status --json` — a no-messaging drift probe: after a
correct two-write it reports `severity:"ok" / detail:"<id>"` (rendered == expected). A rendered-only
edit shows `warn: expected X; rendered Y` — the signal that the source write was missed.

### Changes required

**`Box_Setup_Stuff/badge-pull.sh`** — after the `newBadges` block: extract `jq '.bindings // []'`
(old servers keep working); diff against a root-only state file `/etc/doorman/bindings-applied.json`;
for each new/changed `{sandboxRef, telegramUserId}` run the two-write recipe as helper steps:
  (a) patch `sandboxes.json` `allowedIds` for that sandbox (jq in-place, root-only umask);
  (b) patch openclaw.json `allowFrom` + recompute `.config-hash` + `chmod 660` (via `nemoclaw <ref>
      download`/edit/`upload` + `exec`) + `nemoclaw <ref> gateway restart`;
  (c) confirm via `nemoclaw <ref> channels status --json` == the new id (severity ok, no drift)
      before marking the state file applied — per-row isolation like the badge loop; a failed or
      unconfirmed apply leaves that entry unwritten and the script exits nonzero. The empty-badges
      guard (lines 87–97) is untouched.
  **Gotchas to bake in (Part B hit both):** `nemoclaw upload` writes mode 640/644 → MUST `chmod 660`
  or the restart fails `GATEWAY_UNSAFE_CONFIG_PATH`; `nemoclaw exec` reads stdin → use `</dev/null`.

**`src/control/badgePullScript.test.ts`** — extend the harness (paths already env-overridable):
bindings in the response write/update the state file (stub each apply command via test-only env
hooks, same pattern as `ENV_FILE`); absent `bindings` key is a no-op; a failing apply — or a
`channels status` that doesn't confirm the new id — leaves that entry unwritten and exits nonzero.

**Docs** — `docs/control-plane.md`: add the binding flow to the lifecycle + rollout sections;
`Box_Setup_Stuff/doorman-architecture-memory.md`: the two-layer allowlist model + the no-rebuild
recipe (cite the research doc); `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` §4 (line 408):
the user id is roster-driven after build; in passing fix the stale "the plain 7" at guide line 333
(the non-manager surface is 10 tools today).

*Box-state notes (still apply):* the box runs GLM-5.2 via DeepInfra (`nvidia-prod` rollback only);
never health-check via `nemoclaw <name> agent` (injects into the live Telegram session); **s1 is
the live manager and s3 is Judy's beta sandbox — the script targets only roster-assigned sandboxes,
never those two by hand.**

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` (script harness covers the new block), and
      `npm run build` (pre-PR gate) all pass

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`; a **scratch/cold sandbox on the box (NOT s1/s3)**; `supabase-test`
  MCP for READ-ONLY pilot read-backs. Missing any → stop and name it (never silently degrade).
- [ ] On a scratch sandbox: the deployed script applies a test binding end to end — `channels
      status --json` flips to the new id (severity ok, no drift warn), gateway healthy, no rebuild;
      then restore. (The Part-B ladder, now driven by the script rather than by hand.)
- [ ] `journalctl -u badge-pull` shows the bindings section running; state-file content matches the
      pilot roster (read back via `supabase-test` SELECT only).

### Manual verification
- [ ] End-to-end with a real phone: manager sends "connect <ref> to <id>" in their Telegram chat;
      within ~5 min the technician's phone can talk to the new NemoClaw and an unlisted sender
      cannot. (Human judgment + a second phone — the behavioral proof Part B could not do without a
      2nd Telegram account; runs at pilot-deployment time.)

---
*Pause after this phase — its Manual verification list is non-empty (the real-phone behavioral
proof). The mechanism unknown that used to gate this phase is resolved; no re-scope risk remains.*

## File footprint

Every repo file this plan creates (N) or modifies (M) — the parallel-vs-stacked comparator:
- N `supabase/migrations/20260707000000_telegram_binding_and_sandbox_pool.sql`,
  N `src/db/sandboxPool.ts`, N `src/db/sandboxPool.test.ts`
- M `src/db/database.types.ts`, `src/db/technicians.ts`, `src/db/technicians.test.ts`,
  `src/db/index.ts`
- M `src/mcp/server.ts`, `src/mcp/server.test.ts`, `src/mcp/httpServer.test.ts`
- M `src/control/badgeFile.ts`, `src/control/badgeFile.test.ts`,
  `src/control/badgePullScript.test.ts`
- M `src/composio/pairing.test.ts`, `src/composio/offboarding.test.ts`,
  `src/inbound/webhook.test.ts`, `src/jobs/lifecycle.test.ts`, `src/composio/outbound.test.ts`,
  `src/composio/sessions.test.ts`, `src/composio/logIngest.test.ts` (fixtures: `telegram_user_id`)
- M `scripts/assign-host.mjs`
- M `Box_Setup_Stuff/badge-pull.sh`, `Box_Setup_Stuff/doorman-architecture-memory.md`,
  `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`
- M `docs/nemoclaw-tech-agent.md`, `docs/control-plane.md`
- M `thoughts/shared/research/2026-07-03-cold-sandbox-identity-injection.md` (Step-0 result)
- N `thoughts/shared/plans/2026-07-04-feature-A-manager-telegram-binding.md` (this plan)

## Parallel/stack verdict (plan-two) — EXECUTED; superseded by the 2026-07-06 re-check

*Status 2026-07-06: Plan B landed (PR #18) and this verdict is consumed. Its predicted combined
counts ("manager 16 / technician 8") are superseded — current main is manager 16 / technician 9
(`retract_capture` shipped 2026-07-06), becoming 17/9 after this plan. Build order changed by
user decision 2026-07-06: the **composio-doorman relay is implemented FIRST** (research:
`thoughts/shared/research/2026-07-06-composio-doorman-relay.md`); this plan stacks on the landed
relay. The relay's expected code footprint barely intersects this plan's (`httpServer.ts` route
vs this plan's `httpServer.test.ts`-only edit), but the doc/box-guide files overlap heavily
(`doorman-nemoclaw-setup-guide.md`, `doorman-architecture-memory.md`, `control-plane.md`,
`nemoclaw-tech-agent.md`) — re-locate every doc anchor after the relay lands.*

*Recomputed 2026-07-04 against the REWRITTEN Plan B
(`2026-07-04-feature-B-outbound-composio-sessions.md`, Composio sessions); supersedes the earlier
verdict that compared against the old spine-proxied Plan B.*

**Recommendation: STACK — implement Plan B first, then re-check/rebase Plan A on the landed
result.** Do not run the two plans as parallel worktree sessions.

**Shared files (exact-path intersection of the two File footprints):**
- `src/db/database.types.ts`
- `src/db/technicians.ts`
- `src/mcp/server.ts`
- `src/mcp/server.test.ts`
- `src/composio/pairing.test.ts` (added post-verdict: the adversarial-review fixes put it in Plan B's Phase 1; Plan A already patches its fixtures)
- `src/composio/offboarding.test.ts`
- `src/jobs/lifecycle.test.ts`
- `docs/nemoclaw-tech-agent.md`
- `docs/control-plane.md`
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`
- `Box_Setup_Stuff/doorman-architecture-memory.md`

**Reasoning (plain language):** ten files sit in both footprints, and in several of them the two
plans change the same *fact* — each branch would pass all its checks alone and still be wrong once
the other lands:

1. **Same roster table, two migrations, one generated types file.** Both plans add a database
   migration that alters the `technicians` table (A adds `telegram_user_id`, B adds
   `composio_session_id`), and both then update `src/db/database.types.ts` — B by regenerating it
   from the local database. A regeneration run in a worktree that doesn't contain A's migration
   silently produces a types file *without* A's column (and vice versa for A's hand-edit). Both
   also edit the same `TechnicianPatch` interface in `src/db/technicians.ts`.
2. **A widens the roster row type; B writes new code that builds roster rows.** A's new column
   means every "complete technician record" literal in tests must list it. A patches every such
   fixture that exists *today* — but B creates brand-new test files (`src/composio/outbound.test.ts`,
   `sessions.test.ts`, `logIngest.test.ts`) and expands `server.test.ts` / `lifecycle.test.ts` /
   `offboarding.test.ts` with fixtures A's list cannot know about. Merged, those fresh fixtures
   fail `npm run typecheck` until reconciled.
3. **Tool counts are asserted as absolute numbers.** `src/mcp/server.test.ts` asserts the manager
   surface is exactly 14 tools and the technician surface 7 today. A makes the manager count 15
   (`bind_telegram` in `ADMIN_TOOLS`); B *also* makes it 15 and technician 8 (`send_email` on the
   shared `TOOLS` list). Combined, the truth is **manager 16 / technician 8** — both branches'
   assertions pass alone and are wrong together. The same counts are hand-edited prose in the four
   shared docs, sometimes on the very lines both plans cite.
4. **Same hot region of `src/mcp/server.ts`.** Both add tool-table entries and dispatch cases, and
   both lean on the caller-roster read around line 299 (A for its state guards, B for `send_email`
   staging and the sensitivity filter). Whichever lands first shifts every line number the other
   plan cites — the second plan needs a re-check pass regardless, which is exactly the stacked
   workflow.
5. **The two features meet in the onboarding flow.** A's `bind_telegram` auto-claims a cold
   sandbox for a new hire with *no operator involved*; B assumes an operator wires each person's
   Composio session `mcp.url` into their sandbox's gateway at setup time
   (`scripts/provision-session.mjs`). Combined, a chat-only hire gets a working spine connection
   but no personal Composio session until an operator steps in — not a code conflict, but a
   product-flow gap the second plan must acknowledge (doc note or follow-up) when rebased.

No shared live-database semantics are at risk (A's `sandbox_pool` + badge-pull channel is
untouched by B; B's sessions/log-ingestion/review-items are untouched by A, and B's sensitivity
filter reads captures A never writes) — but the merge-time interaction risk is clearly not
"genuinely low", so per CLAUDE.md the stacked path applies.

**Order — B first, then A, because of how each plan can stall:**
- Plan A's Phase 4 is **gated on an unresolved experiment** (whether a running sandbox's Telegram
  allowlist can be re-bound without a rebuild — still `PENDING`). If the answer is
  "build-time-only", A pauses mid-feature and gets re-scoped. Landing A first risks rebasing
  finished work (B) onto a half-landed feature.
- Plan B's Phases 1–4 are fully local-testable, and the Phase 5 probes that need nothing extra
  (the 4310 session-restriction checks) can run today. Its *(needs pairing)* items have an
  explicit, achievable prerequisite — pair one mailbox via the existing connect-link flow (the
  live project has zero connected accounts) — whereas A's blocker is an experiment with a possibly
  bad outcome.
- B also rewrites more of the shared infrastructure (lifecycle job steps, offboarding, pairing
  client, server dispatch); landing it first means A's rebase is mostly re-checking line numbers,
  counts, and fixtures rather than redesigning.

**Risk areas to re-verify when rebasing Plan A after B lands:**
- `src/db/database.types.ts` — regenerate from a local stack containing BOTH migrations so both
  new `technicians` columns are present; check the two migration timestamps order cleanly.
- `src/db/technicians.ts` — `TechnicianPatch` will already carry `composio_session_id`; add
  `telegram_user_id` beside it (same interface, adjacent lines).
- `Technician` full-literal fixtures — extend A's Phase-1 fixture list with B's new/expanded test
  files: `src/composio/outbound.test.ts`, `src/composio/sessions.test.ts`,
  `src/composio/logIngest.test.ts`, plus B's additions in `src/mcp/server.test.ts`,
  `src/jobs/lifecycle.test.ts`, `src/composio/offboarding.test.ts`.
- `src/mcp/server.test.ts` — absolute tool-count assertions: after both land, manager = 16,
  technician = 8.
- `src/mcp/server.ts` — all of A's cited line numbers (tool tables, `ADMIN_TOOL_NAMES`, dispatch
  switch, caller read ~299) shift after B's `send_email` + sensitivity filter; re-locate before
  editing.
- Tool-count prose in `docs/nemoclaw-tech-agent.md`, `docs/control-plane.md`,
  `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`,
  `Box_Setup_Stuff/doorman-architecture-memory.md` — and B's additional count sites in
  `docs/doorman-runbook.md` and `Box_Setup_Stuff/migration-runbook-lightsail.md`.
- Onboarding interaction — RESOLVED by user decision 2026-07-06: the composio-doorman relay
  (built before this plan) replaces per-sandbox session `mcp.url` wiring entirely — Render pins
  each request to the person's session, so a `bind_telegram` auto-claimed sandbox gets Composio
  access with no operator step. Phase 4's doc edits should describe the relay path, not
  `provision-session.mjs`.
