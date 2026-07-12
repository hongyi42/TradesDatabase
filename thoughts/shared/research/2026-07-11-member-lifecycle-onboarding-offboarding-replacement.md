---
date: 2026-07-11
branch: main
commit: 5591939
topic: Member lifecycle — onboarding, offboarding, and replacement flows (roster, sandbox pool, badge/binding delivery, box provisioning) as they exist today
---

## Summary

This document maps everything that happens today when a manager **adds a person to the team,
removes one, or swaps one out for another** — the substrate the upcoming "automatic sandbox
cleanup + restock" feature (the recycler) will build on. Three machines cooperate: the **spine
server** on Render (the MCP tools a manager's chat agent calls, plus a `GET /control/badges`
endpoint), the **pilot database** on Supabase (roster, seats, sandbox pool), and **trades-box-1**
(the Lightsail host running one Docker "sandbox" — a personal agent — per team member, which
polls the server every 5 minutes). Onboarding and replacement are almost entirely chat-side:
a manager adds a seat, binds a Telegram id, and a cold pre-built sandbox is claimed from a pool
automatically. Offboarding is a two-step confirmed deactivation that starts a 7-day reversible
grace period; a cron makes it permanent afterwards. The load-bearing findings for the recycler:
**(1)** a claimed pool row is never freed — churn permanently consumes sandboxes and nothing
refills the pool; **(2)** the box has no destroy/retire path at all — the only offboarding signal
it receives is a `revoked:true` badge flag; **(3)** even onboarding has one remaining manual step
(installing the minted badge into the sandbox and restarting its container); and **(4)** a
grace-period state machine with a compare-and-swap "point of no return" transition already exists
and is where permanent teardown happens today.

## Entry Points

**Manager-facing (MCP tools, called by the manager's chat agent):**
- `src/mcp/server.ts:510` — `dispatch()`, the single tool dispatcher. Admin tools are gated at
  `src/mcp/server.ts:537-539` (`'admin tools require a manager badge'`); every call re-reads the
  caller's roster row and rejects deactivated badges at `src/mcp/server.ts:527-529`.
- Tool declarations: `add_technician_seat` `src/mcp/server.ts:271-287`, `deactivate_technician_seat`
  `:288-302`, `list_team` `:303-311`, `reactivate_technician_seat` `:319-330`, `get_connect_link`
  `:331-343`, `bind_telegram` `:344-366`, `resolve_review` `:367-384`.
- Handlers: add `src/mcp/server.ts:1230-1261`, deactivate `:1262-1360`, reactivate `:1361-1438`,
  connect-link `:1439-1484`, bind_telegram `:1485-1563`, list_team `:1564-1581`, resolve_review
  `:1585-1653`.

**Server → box channel (the only one):**
- `GET /control/badges` — `src/mcp/httpServer.ts:148-151` (route), `:120-138` (handler,
  bearer-token host auth). Response built by `buildBadgeResponse()` in
  `src/control/badgeFile.ts:38-95`.

**Scheduled:**
- Render cron `*/15 * * * *` → `src/jobs/lifecycle.ts:51-171` (`runLifecycle`): pairing sweep,
  **grace-period expiry** (`expireOffboarding`, `src/composio/offboarding.ts:81-218`), sheet sync,
  Composio session sweep, log ingest.
- Box systemd timer, every 5 min → `/usr/local/sbin/badge-pull.sh`
  (`Box_Setup_Stuff/badge-pull.sh`, installed by `bootstrap-box.sh` phase_badgepull
  `Box_Setup_Stuff/bootstrap-box.sh:366-422`).

**Operator-only:**
- `scripts/assign-host.mjs` — `create-host` (:78-87), `add-sandbox` (:88-130), `assign` (:143-157),
  `set-badge` (:158-171), `rotate-badge` (:172-183). Hard-guarded to the pilot DB ref only
  (`scripts/assign-host.mjs:42-47`); runs with the service-role key from an operator laptop.
- `Box_Setup_Stuff/bootstrap-box.sh:188-267` — `phase_provision`, the scripted cold-sandbox build
  (run as root on the box). Phase dispatch list at `bootstrap-box.sh:781-796`.

## Key Files

| Path | Role |
|---|---|
| `src/mcp/server.ts` | All MCP tools. 10 technician tools (`TOOLS`, :103-266) + 8 manager tools (`ADMIN_TOOLS`, :271-384). Two-step confirms persisted in `review_items` so any stateless replica can serve the confirming call. |
| `src/mcp/identity.ts` | `RequestIdentity` (:13-17); HMAC-verified `x-tenant-id`/`x-technician-ref` headers from the box doorman (:41-63). |
| `src/mcp/httpServer.ts` | HTTP entry: Composio webhook, `/control/badges`, MCP streamable HTTP. All auth failures → bare 401. |
| `src/db/technicians.ts` | Roster CRUD. `casTechnician` (:151-169) — compare-and-swap used by **every** lifecycle transition. `isInactiveState` (:308-310) = `offboarding \|\| offboarded`, the single "no longer participates" definition. `claimBadgeHash` (:175-189) write-if-null badge mint claim. |
| `src/db/sandboxPool.ts` | The cold-sandbox rack. `registerSandbox` (:18), `getPoolRowByTechnician` (:47), `listFreeSandboxes` (:61, FIFO), `listPoolRows` (:75), `claimSandbox` (:87, write-if-still-null). **No release/unclaim function exists.** |
| `src/db/hosts.ts` | `createHost`, `getHostByTokenHash` (badge-pull auth), `getHostByName`. |
| `src/control/badgeFile.ts` | Builds the pull payload `{badgesFile, newBadges, bindings}`. Badge status = `revoked: isInactiveState(state)` (:88-92). Bindings ship only for active, bound, sandboxed rows (:52-62) — "additive; unbind is out of scope" (:28-29). |
| `src/control/badges.ts` | `mintBadge()` — 32 random bytes; only the sha256 is ever stored. |
| `src/composio/offboarding.ts` | The grace machine: `graceDays()` (env `GRACE_DAYS`, default 7, :22-28), reminder at ≤2 days, expiry CAS `offboarding→offboarded` **before** destructive Composio teardown (:149-183), leaked-session retry pass (:100-124). |
| `src/jobs/lifecycle.ts` | The one scheduled entrypoint (Render cron); five isolated sweep steps. |
| `scripts/assign-host.mjs` | Operator CLI: host registration (prints the pull token exactly once), pool registration (`add-sandbox … bot=@handle`), badge rotation. Laptop-only by design; refuses any DB but the pilot ref. |
| `Box_Setup_Stuff/badge-pull.sh` | Root, every 5 min. Installs `badgesFile` wholesale (atomic replace, empty-roster refusal guard :98-114); appends minted plaintext badges to `/root/pending-badges.jsonl` (**install is manual**, :17-30); reconciles `bindings[]` via `apply-binding.sh` with per-row applied-state journal `/etc/doorman/bindings-applied.json` (:143-204). |
| `Box_Setup_Stuff/apply-binding.sh` | Runs as `ubuntu`. Two-write allowlist recipe: source-of-truth `~/.nemoclaw/sandboxes.json` `allowedIds` + rendered `openclaw.json` per-account `allowFrom = [$t]` (**whole-array replace**, :59-63) + `.config-hash` + `gateway restart`; verify via `channels status --json` (exit 12 on mismatch). |
| `Box_Setup_Stuff/bootstrap-box.sh` | All box phases. `phase_provision` (:188-267): getMe preflight → env-exported bot token (**load-bearing**) → non-interactive onboard → hard assertions (provider attached; token registered in the openclaw process env ≤120s; getUpdates polling ≤180s) → DeepInfra route flip. `phase_verify` (:656-754) includes the credential-freshness drift probe. **No destroy/retire/recycle phase exists** (dispatch :781-796). |
| `Box_Setup_Stuff/doorman.mjs` | Per-request badge gate on the box: sha256 the presented badge, look up fingerprint in `badges.json` (re-read every request → **revocation is instant**), 403 on `revoked:true` (:33-34); forwards HMAC-signed identity headers. |
| `supabase/migrations/20260702194603_technicians_and_review_items.sql` | `technicians` table + states enum (:4-23), `tenants.manager_seats/technician_seats` (:29-32), seat-cap trigger (:38-51). |
| `supabase/migrations/20260703010056_control_plane_lifecycle.sql` | `hosts` table (:4-9); `badge_hash`, `host_id`, `offboarding_started_at`, `link_issued_at` columns (:11-15). |
| `supabase/migrations/20260707000000_telegram_binding_and_sandbox_pool.sql` | `telegram_user_id` (:9, deliberately not unique); `sandbox_pool` (:16-25). |
| `supabase/migrations/20260711200000_sandbox_pool_bot_username.sql` | `sandbox_pool.bot_username` (:10) — set at registration or never. |
| `docs/nemoclaw-tech-agent.md` | Agent-stack reference: manager tool surface (:93-106), credential lifecycle (:191-201), cold-pool Composio relay (:214-219). |

## Data Flows

### 1. Onboarding a new member (mostly chat-side; one manual step remains)

```
manager chat: add_technician_seat "Judy Doe"
  └─ insertTechnician → row state 'invited', ref 'judy-doe' minted (server.ts:1230-1261)
     seat-cap trigger may reject: 'no free technician seats — deactivate someone or purchase a seat'

manager chat: bind_telegram ref=judy-doe telegramUserId=NNN   (server.ts:1485-1563)
  ├─ duplicate-id guard (JS-level; skips inactive rows, technicians.ts:34-45)
  ├─ no sandbox yet → claim from pool:
  │    getPoolRowByTechnician (crash recovery) else
  │    listFreeSandboxes FIFO → claimSandbox (UPDATE … WHERE technician_id IS NULL)
  │    pool empty → ERROR 'no free sandbox in the cold pool — contact support to add capacity'
  ├─ ONE roster write: telegram_user_id (+ host_id + sandbox_ref if claimed)
  └─ returns botUsername + "open @bot and send /start" note

≤5 min later, box badge-pull tick (badge-pull.sh, root, systemd timer):
  GET /control/badges  (Bearer host pull token → sha256 → hosts.token_hash)
  ├─ badgesFile: replaced wholesale on /etc/doorman/badges.json (atomic, owner doorman)
  ├─ newBadges:  minted plaintext → /root/pending-badges.jsonl
  │              ★ MANUAL: operator pastes `openshell provider update <AGENT>-telegram-bridge
  │                --credential TRADES_SPINE_BADGE=…` then RESTARTS THE CONTAINER
  │                (credentials register into the openclaw process env at launch only)
  └─ bindings[]: diff vs bindings-applied.json → sudo -u ubuntu apply-binding.sh <ref> <tgid>
                 (two-write allowlist + gateway restart + verify — fully automatic)

technician's phone: open @bot → /start → agent answers; spine calls pass the doorman badge gate
```

Composio access needs no wiring: the composio-doorman relay reads the person's
`composio_session_id` per request (`docs/nemoclaw-tech-agent.md:214-219`); the 15-min cron mints
sessions for every `active` row (`src/jobs/lifecycle.ts:120-153`). Gmail pairing is a separate
manager-driven flow (`get_connect_link` → OAuth → `pairing_verification` review item →
`resolve_review` CAS to `active`).

### 2. Offboarding (deactivate → grace → permanent)

```
manager chat: deactivate_technician_seat ref=X          (server.ts:1262-1360)
  step 1 → {needs_confirmation, confirmId}   (persisted as review_items 'pending_deactivation')
  step 2 (with confirmId):
    CAS state → 'offboarding' + offboarding_started_at stamped    ← SEAT FREES IMMEDIATELY
    advisory: disablePairing (Composio trigger+account OFF — reversible)
    advisory: teardownSession (deleted, not disabled — a live manager session can mint accounts)

immediate server-side effects:
  every MCP call with X's badge → 'this badge belongs to a deactivated team member' (server.ts:527-529)
  webhook drops X's inbound mail (roster gate)

≤5 min, next box pull:
  badgesFile entry flips revoked:true (badgeFile.ts:88-92) → doorman 403s instantly (doorman.mjs:33-34)
  X's binding stops SHIPPING (badgeFile.ts:56) — but the box never removes the applied allowlist entry

≤7 days (GRACE_DAYS): reactivate_technician_seat = the undo
  CAS 'offboarding' → 'active' (or 'invited' if never paired), clock cleared, pairing re-enabled
  seat-cap trigger re-fires (reactivation can fail at cap)

after grace, cron tick (offboarding.ts:126-216):
  reminder review item at ≤2 days left
  expiry: CAS 'offboarding' → 'offboarded'  ← THE POINT OF NO RETURN (a racing reactivation wins)
          then deleteComposioPairing + session delete (ids kept for audit)
  'offboarded' is terminal: reactivate refuses — "add a new seat instead"

NEVER happens, anywhere:
  sandbox_pool row freed · sandbox destroyed/stopped · allowlist entry removed ·
  roster sandbox_ref/telegram_user_id cleared · box told anything beyond revoked:true
```

### 3. Replacement (what the manager can do today, and where it dead-ends)

```
deactivate old ─→ seat frees instantly ─→ add_technician_seat new ─→ bind_telegram new
                                                                        │
                                              pool has a free blank ────┤──── pool EMPTY (today)
                                              claim it, done ~5 min          'contact support to
                                              (fully chat-side)               add capacity' — DEAD END
```

Every replacement permanently consumes one blank: the old member's pool row stays claimed forever
(`claimSandbox` requires `technician_id IS NULL`; nothing ever nulls it — `src/db/sandboxPool.ts`
has register/claim/list only). The old sandbox keeps running idle: badge revoked, bindings absent,
but container up, old member's Telegram id still in its allowlist, agent workspace (its memory)
intact. Current pilot state: s4 claimed by offboarding `office-dispatch`, pool empty.

### 4. Restocking a blank (operator-only, ~10 min, two halves that don't talk)

```
BOX HALF (root on trades-box-1):                SERVER HALF (operator laptop):
  BotFather: create bot, get token+handle         node -r dotenv/config scripts/assign-host.mjs
  (MANUAL — Telegram has NO bot-creation API)       add-sandbox host=trades-box-1 sandbox=s5
  secrets env file + hydrated plan b64              bot=@handle [tenant=…]
  sudo ./bootstrap-box.sh provision s5 …          → registerSandbox INSERT (pilot-ref-guarded,
  (~8-10 min: onboard + hard assertions             service-role key, laptop-only)
   + DeepInfra route flip)
```

`phase_provision` does **zero** server-side registration; `add-sandbox` does **zero** box-side
work. The operator is the bridge. `bot_username` is captured at `add-sandbox` time or never
(no update path). The `sandbox_ref` must be new: `unique (host_id, sandbox_ref)` means a rebuilt
sandbox can only re-enter the pool under a fresh ref or after its old row is deleted by hand.

## External Dependencies

- **Supabase** (hosted pilot `daqapdlkgxfrhquacprv` = the LIVE pilot DB; local Docker stack for
  tests) — all access via service-role key through `src/db/`.
- **Composio** — pairing (connected accounts, triggers), per-person sessions; disable/enable is
  the reversible half of offboarding, delete the permanent half.
- **Telegram Bot API** — `getMe` preflight in provision; `getUpdates` polling by the bridge.
  **Bot creation is BotFather-only (no API)** — the one step no script can perform.
- **Render** — web service (MCP + `/control/badges`) and the 15-min lifecycle cron. Pull timeout
  note: cold spin-up ~32s exceeds badge-pull's 30s curl cap → one failed tick warms it
  (`badge-pull.sh:49-52`).
- **NemoClaw / OpenShell (NVIDIA vendor stack)** — `nemoclaw onboard/rebuild/download/upload/
  gateway restart/channels status`, `openshell provider|sandbox|inference`. Known vendor hazards:
  rebuild can strip the device private key; credentials register into the openclaw process env at
  container launch only.
- **systemd/docker on the box** — badge-pull timer (5 min), doorman service, per-agent revive
  units, boot medics.

## Constraints and Invariants

- **Refs are never reused across humans** — `unique (tenant_id, ref)` spans offboarded rows
  (`20260702194603:21`); L1 attribution is append-only, so recycling a ref would merge two
  people's history. Seats and sandboxes are slots; refs are people.
- **Seats free at `offboarding`, not at expiry** — the seat-cap trigger's occupancy set excludes
  `offboarding`/`offboarded` (`20260702194603:38-51`), so a manager can hire the replacement the
  moment deactivation is confirmed, 7 days before teardown.
- **A pool claim is forever** — `claimSandbox` is write-if-null; no unclaim exists; `technician_id`
  is UNIQUE (one sandbox per person, ever). Pool depth shrinks by one per churn event.
- **Every lifecycle transition is CAS-guarded** (`casTechnician`) — deactivate, reactivate,
  pairing verification, and the expiry claim; the expiry CAS runs **before** destructive teardown
  so a racing reactivation wins (`offboarding.ts:149-153`). Any recycler action keyed to a state
  must follow the same claim-before-destroy order.
- **Badge revocation is automatic and instant; everything else about removal is not.** The badge
  file is regenerated from the roster every pull (hand edits don't stick); the doorman re-reads it
  per request. But bindings are additive-only (`badgeFile.ts:28-29`, `badge-pull.sh:145`), no
  unbind tool exists despite bind_telegram's error text saying "unbind them first"
  (`server.ts:1508`), and the box receives no positive retire/destroy instruction — ever.
- **`apply-binding.sh` replaces the whole `allowFrom` array** (`:59-63`) — a re-bind removes the
  old id as a side effect; it is the closest existing thing to an unbind primitive.
- **Credential writes need a container restart** — provider credentials register into the openclaw
  process env at launch only (`docs/nemoclaw-tech-agent.md:191-201`); this is why badge install is
  paired with a restart and why `phase_verify` has a freshness probe.
- **Badge install is manual today** — minted plaintext lands in `/root/pending-badges.jsonl` and
  waits for an operator paste + restart (`badge-pull.sh:17-30`). Onboarding's allowlist half is
  automatic; its credential half is not.
- **`GET /control/badges` is the only server→box channel**, authenticated by a per-host bearer
  token (sha256 stored). Old boxes tolerate new payload keys (`.bindings // []` idiom,
  `badge-pull.sh:145`). There is no box→server write path at all.
- **Server-side pool/host registration is operator-laptop-only** — `assign-host.mjs` requires the
  service-role key and refuses any DB but the pilot ref (`:42-47`).
- **Provision needs secrets in the process env** — `TELEGRAM_BOT_TOKEN` export is load-bearing
  (onboard reads env, never the plan); NVIDIA key comes from a root-only env file (stale-key
  incident recorded 2026-07-11 for `/root/s4-nvidia.env`).
- **The sandbox holds the agent's memory** — workspace `AGENTS.md`/`MEMORY.md` live in the
  container and die with it (rebuild already wipes them; `bootstrap-box.sh wire` re-appends the
  standard blocks). Spine data (L1/L2/L3) lives in the DB and is untouched by any sandbox event.
- **`sandboxes.json` stores the bot token in plaintext** on the box (pre-existing security note,
  `thoughts/shared/research/2026-07-03-cold-sandbox-identity-injection.md:173-175`) — meaning a
  retired sandbox's bot token is recoverable box-side.
- **MCP tool descriptions are fetched once per agent process** — any description change requires
  sandbox container restarts to be seen (recorded gotcha, 2026-07-11).
- **Prior scope decisions on record:** "Return-to-pool / freeze at offboarding stays OUT of scope"
  (`thoughts/shared/plans/2026-07-04-feature-A-manager-telegram-binding.md:69-76`), "Unbind at
  offboarding — out of scope" (`:82-84`), and the target state was already named in
  `thoughts/shared/research/2026-07-03-cold-sandbox-identity-injection.md:47-55`: "deactivation
  propagates sender-unbind + sandbox freeze; the seat returns to the cold pool for the next hire."
  Seat-licensing rule (user decision 2026-07-06): a recycled slot may serve a new hire, but the
  new hire always gets a fresh ref.

## Decision Points

Choice points the current code creates for the recycler feature, stated factually:

1. **When destruction fires.** Candidate hooks that exist today: (a) deactivation confirm
   (`server.ts:1315-1318`) — but the 7-day grace period makes deactivation reversible, and
   destroying the sandbox erases the agent's workspace memory, which reactivation currently gets
   back for free; (b) the expiry CAS `offboarding→offboarded` (`offboarding.ts:149`) — the
   existing point of no return, where Composio teardown already happens; (c) a new signal of its
   own. `GRACE_DAYS` is env-tunable (default 7), so "how fast the pool refills after a swap" and
   "how long a mistake is undoable" are currently the same knob.

2. **How the box learns.** The only channel is the 5-min authenticated pull. Options the code
   shapes: extend the `/control/badges` payload with a retirement list (the `bindings[]`
   precedent — old boxes ignore unknown keys), add a separate control endpoint, or have the box
   infer retirement from absence (it currently ignores absence by design). The pull handler and
   response builder are small and dependency-injected (`httpServer.ts:120-138`,
   `badgeFile.ts:38-47`).

3. **How the new blank gets registered server-side.** `registerSandbox` is only reachable from an
   operator laptop today. A box-driven restock needs either a new authenticated box→server write
   (the host pull token exists but is only used for the GET), or the operator stays in the loop
   for the registration half even if the build half is automatic.

4. **Where the new bot identity comes from.** BotFather has no API. The code allows three shapes:
   reuse the retired sandbox's own token (recoverable from `sandboxes.json` plaintext; frees no
   one to create anything, but the handle outlives the person association and the departed member
   retains the chat in their client); a pre-created token vault the box draws from (bots created
   in batches ahead of time — the manual step moves to vault refills); or per-recycle manual
   BotFather work (status quo). `bot_username` currently has no update path — set at registration
   or never (`sandboxPool.ts:15-17`).

5. **What "destroy" means box-side.** No teardown exists in any script. The vendor surface offers
   `nemoclaw rebuild` (wipes workspace/config but has the device-key-strip hazard and keeps the
   same agent name) versus destroying and onboarding a fresh agent under a new name via
   `phase_provision` (~8-10 min, hard-asserted). `unique (host_id, sandbox_ref)` forces a choice:
   a recycled sandbox re-enters the pool as a new ref (new row) or the old pool row is deleted —
   there is no third option under the current schema.

6. **What happens to the retired pool row and roster residue.** Today the claimed pool row,
   `technicians.sandbox_ref`, `telegram_user_id`, and the box-side allowlist entry all persist
   after offboarding. A recycler either deletes the pool row, adds a state column to mark it
   retired, or leaves it and only ever appends new rows — and separately decides whether it is
   also the missing unbind mechanism (the whole-array `allowFrom` replace in `apply-binding.sh`
   is the available primitive) or whether unbind ships as its own step.

7. **Whether badge install joins the automation.** The recycler's end state (a claimed blank
   serving a new member) still passes through the one manual onboarding step: pending-badge paste
   + container restart. The pieces are individually scripted (`openshell provider update`,
   `docker restart`, the freshness probe in `phase_verify`); the current design deliberately keeps
   the plaintext handling manual (`badge-pull.sh:17-30`).

## Open Questions

- **Vendor teardown semantics.** What exactly does the NemoClaw CLI offer for removing an agent
  (`destroy`? `remove`?), and does it free the agent name, the container, the gateway JWT state,
  and the docker resources cleanly? Nothing in this repo has ever torn a sandbox down; this needs
  a live experiment on a scratch sandbox.
- **Bot-token reuse behavior.** If a retired sandbox's token is reused by a freshly onboarded
  agent, does the old container's poller conflict (two `getUpdates` consumers) during the overlap
  window? Requires a live check; the code never runs two consumers of one token today.
- **Provision under a timer.** `phase_provision` takes ~8-10 min; badge-pull's systemd oneshot
  fires every 5 min. Whether a box-side recycler runs inside that unit (blocking ticks) or as its
  own unit with a journal (the `bindings-applied.json` pattern) is unexplored territory — no
  long-running box job exists today.
- **Reactivation vs. an already-recycled sandbox.** If destruction fires before `offboarded`
  (option 1a), what should `reactivate_technician_seat` do when the person's sandbox no longer
  exists? Today reactivation assumes the sandbox is intact (only the Composio session needs
  re-wiring, `server.ts:1330-1338` comment).
- **Secrets for unattended provisions.** The NVIDIA key currently comes from a root-only env file
  the operator refreshes by hand (it went stale once already, 2026-07-11); an unattended recycler
  needs a defined source of truth for it and for the messaging-plan file.
- **Pilot residue cleanup.** Whether the existing stuck state (s4 claimed by offboarding
  `office-dispatch`; demo `judy-testing` row invited/unbound) is migrated by the new feature or
  cleaned by hand before it ships.
