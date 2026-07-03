---
date: 2026-07-02
branch: technicians-table-seat-management
commit: b2682a6
topic: Control-plane lifecycle (Plan 2) — the as-is state of everything Plan 2 will automate; badge lifecycle, Composio pairing/offboarding surfaces, verify-after-connection hooks, grace-period offboarding, scheduling machinery, receipts and rate limits
---

## Summary

Plan 1 (implemented, PR #13, live-E2E-verified 2026-07-02) built the *database* lifecycle: a
`technicians` roster with tier/state, seat caps enforced by a DB trigger, a manager review queue,
and five chat admin tools. What it deliberately did **not** build is the bridge between that
database and the real world. Today, when a manager adds a seat, a row appears with
`state='invited'` — and then **every subsequent step is a human at a terminal**: minting the badge
(a random token hand-pasted into a root-owned file on each host machine), provisioning the sandbox
(the isolated container the technician's chat agent runs in), pairing their Gmail through Composio
(two dev scripts plus a browser OAuth consent), and updating the schedule sheet. Offboarding is
the mirror image: the chat tool flips the row to `offboarding` and mail starts dropping with
receipts, but the badge stays valid until someone hand-edits the host file, the Gmail pairing
keeps polling until someone deletes it via SDK calls, and **nothing ever moves the row to
`offboarded`** — there is no scheduler anywhere in the system to run a grace-period expiry (or
anything else: the schedule-sheet sync function has no caller either). This document maps each of
those manual seams precisely, because Plan 2's job is to replace them with code.

## Entry Points

- `src/mcp/server.ts:347` — `add_technician_seat`: the only automated onboarding step. Mints the
  ref (`slugify`, `:211-216`), inserts the row (`state='invited'`), and stops.
- `src/mcp/server.ts:379` — `deactivate_technician_seat`: the only automated offboarding step.
  Two-step confirm via `review_items`, then `setTechnicianState(id, 'offboarding')` (`:428`) — the
  single caller of `setTechnicianState` in the codebase.
- `src/inbound/webhook.ts:199-214` — the roster gate: where `offboarding`/`offboarded` state
  actually takes effect (mail dropped with a receipt) and where unknown refs get flagged.
- `scripts/composio-reconnect.mjs:92` / `scripts/composio-trigger.mjs:58` — the ONLY code that
  creates Composio pairings/triggers today (operator-run dev scripts, `node -r dotenv/config`).
- `docs/doorman-runbook.md:298-305` ("Ongoing ops") — the badge issue/revoke procedure: `openssl
  rand -hex 32` plus a hand edit of `/etc/doorman/badges.json` on the host.
- `Box Setup Stuff/doorman-nemoclaw-setup-guide.md` — the full manual sandbox-provisioning
  procedure a host-side Claude executes (badge as provider credential at `:358-368`).

## Key Files

### Server side (this repo, deployed on Render)

| File | Role for Plan 2 |
|---|---|
| `supabase/migrations/20260702194603_technicians_and_review_items.sql` | The lifecycle schema. `technician_state` enum (`:5-6`): `invited → pending_verification → active → offboarding → offboarded` — an *intended* order the DB does not enforce (any state can be set to any other). Four Plan-2 placeholder columns exist with **zero writers**: `sandbox_ref`, `composio_connected_account_id` (ca_*), `composio_trigger_id` (ti_*), `connected_email` (`:15-18`). Seat-cap trigger counts only rows NOT in (`offboarding`,`offboarded`) (`:44-45`) |
| `src/db/technicians.ts` | `setTechnicianState(id, state)` (`:64`) — a bare update, no transition validation, no timestamp beyond the generic `updated_at`. `isInactiveState` (`:90-92`) is the single shared definition of "no longer participates" — **only** `offboarding`/`offboarded`; `invited` and `pending_verification` count as participating everywhere |
| `src/db/reviewItems.ts` | The review queue. `ReviewKind` includes `'pairing_verification'` (`:13`) — **type-only today: nothing produces or consumes it**. `upsertOpenReviewItem` (`:30`) gives one-open-item dedup; `getOpenReviewItem` (`:102`) is the confirm-token point read; `flagUnknownRefCapture` (`:69`) has per-message dedup on `detail->>externalId` |
| `src/db/tenants.ts` | `createTenant` (`:21`) / `setTenantSeats` (`:39`) exist as typed writes (used by tests/seed) — no MCP/tool surface calls them; tenant provisioning and seat purchases remain out-of-band |
| `src/mcp/server.ts` | Admin tools + tier gate (`isActiveManager` `:227`, name-keyed gate `:245`). `list_team` already returns `sandboxRef` (`:445`) but hides Composio ids by design (`:439`). **No rate limiting of any kind** |
| `src/mcp/httpServer.ts` | The deployed entrypoint (stateless, per-request identity). Auth layers: gateway HMAC header, optional `ALLOWED_CLIENT_IPS` (`:20-26`), webhook HMAC + 300s replay window. **No rate limiting, no request accounting** |
| `src/inbound/webhook.ts` | Roster gate order (`:199`): `getTechnician` first (roster hit doubles as tenant check), `tenantExists` only on miss; inactive → `recordDrop(reason:'offboarded')` + `skipped_offboarded` (`:204-214`); unknown ref → ingest + advisory flag (both work and non-work paths, `:241-247`, `:269-279`) |
| `src/schedule/sheetSync.ts` | `syncScheduleFromSheet` — **has no caller anywhere** (no cron, no script, no route; only tests). The `sheet_ref_mismatch` flagging built in Plan 1 Phase 3 never runs in production |
| `scripts/composio-reconnect.mjs` | The pairing flow to automate: fail-closed arg parsing, bare-uuid creation refused (`:44-50`), same-ref guard against live connections (`:72-83`), `connectedAccounts.delete(id)` on `--replace` (`:86-89`), `connectedAccounts.link(userId, 'ac_5CdPk4l3GV2V')` → `redirectUrl` (`:92-95`), `--wait` polls `connectedAccounts.list({userIds})` for ACTIVE + granted scope (`:55-65`) |
| `scripts/composio-trigger.mjs` | Trigger creation to automate: `triggers.create(USER_ID, 'GMAIL_NEW_GMAIL_MESSAGE', {triggerConfig: {interval: 1, labelIds: 'INBOX', userId: 'me'}})` (`:58-64`). **Not idempotent** (create twice → error); no list/delete surface for triggers exists anywhere in the repo |
| `package.json` | `@composio/core ^0.13.1` is a **devDependency** — `src/` never imports it. Server-side Connect-Link issuance makes it a runtime dependency (already noted in Plan 1's overview). No scheduler/cron dependency exists; scripts are typecheck/lint/test/build/serve/seed only |
| `.env.example` | Custody rules: `COMPOSIO_API_KEY` is control-plane, "mints access for ALL tenants", today needed only by the dev scripts (`:56-59`) — the deployed Render service does NOT hold it. `COMPOSIO_WEBHOOK_SECRET` semantics + SDK-only subscription management (`:46-54`) |

### Host side (Box Setup Stuff — the machines Plan 2 must reach)

| File | Facts that constrain the push channel |
|---|---|
| `docs/doorman-runbook.md` | Badge file shape: `{"<64-hex-badge>": {tenantId, technicianRef, revoked}}` (`:193-197`); re-read on every request so **distribution = file replacement, no restart** (`:203-205`); revoke = set `"revoked": true` (`:298-305`). The doorman systemd unit runs with `ProtectSystem=strict` + `ReadOnlyPaths=/etc/doorman` (`:222-223`) — **the doorman itself cannot write its own badge file**; any updater is a separate writer. HMAC payload has no timestamp/nonce — a leaked signature never expires; badge revocability is the containment (`:318-322`) |
| `Box Setup Stuff/doorman-architecture-memory.md` | Badge↔roster two-part rule (server row + host badge must agree; a manager badge without an active manager row silently degrades to 7 tools). badges.json ownership gotcha: after ANY edit, restore `doorman:doorman` + mode 600 or `loadBadges()` silently 403s every badge. Placeholder versioning trap: a provider credential write (e.g. swapping `TRADES_SPINE_BADGE`) bumps the provider version and can strand other channels' placeholders — a badge *push* that touches the OpenShell provider store re-arms this until the refresher patch lands |
| `Box Setup Stuff/doorman-nemoclaw-setup-guide.md` | The sandbox side of a badge swap: `openshell provider update <AGENT>-telegram-bridge --credential TRADES_SPINE_BADGE=<badge>` (`:362-364`) — a secret-store write, blocked in restricted Claude sessions. Sandbox config holds only the canonical placeholder; the egress proxy substitutes at request time. Telegram sender allowlist (the "unbind" target) lives in the bridge/provider config, host-side |

### What "receipts" means today

- `dropped_audit` rows (`recordDrop`): content-free receipts (sender domain, reason,
  `technician_ref`) for non-work drops and — since Plan 1 — `reason='offboarded'` drops. They are
  queryable but **no tool or surface shows them to a manager**; `list_pending_reviews` reads
  `review_items` only.
- `review_items`: the only manager-facing surface, and it is **pull-only** — the manager's agent
  must call `list_pending_reviews`. No push/notification mechanism exists anywhere (the
  "review-items ping a confirmation note" behavior discussed in planning is an agent-prompting
  concern, not built infrastructure).

## Data Flows

### Onboarding after Plan 1 — where automation stops

```
Manager (Telegram chat)                    SERVER (automated)          HUMAN (manual, today)
──────────────────────                     ──────────────────          ─────────────────────
"Add Jane Doe"
  └─▶ add_technician_seat ────────────────▶ roster row: state=invited
                                            seat occupied, ref minted
                                            ⛔ automation ends here
                                                                       1. openssl rand -hex 32
                                                                          → hand-edit badges.json
                                                                          on EVERY relevant host
                                                                       2. nemoclaw onboard / assign
                                                                          a cold sandbox; provider
                                                                          credential = the badge
                                                                       3. composio-reconnect.mjs
                                                                          user=<tenant>:jane-doe
                                                                          → send URL to Jane
                                                                          → Jane approves OAuth
                                                                          → --wait confirms ACTIVE
                                                                       4. composio-trigger.mjs
                                                                          user=… --create
                                                                       5. UPDATE technicians SET
                                                                          state='active' BY HAND
                                                                          (no code path does this)
```

Concrete gap observed in the live E2E (2026-07-02): "Testy McTestface" was added and stayed
`state='invited'` for his whole life — **no code transitions `invited → pending_verification`,
`pending_verification → active`, or `invited → active`**. The seed script sidesteps this by
inserting rows as `active` directly. Nothing writes `composio_connected_account_id`,
`composio_trigger_id`, `connected_email`, or `sandbox_ref`.

Consequence of `isInactiveState` covering only the offboarding states: a person in `invited` or
`pending_verification` is treated **exactly like `active`** on every surface — their mail ingests
without any flag (webhook `:204` checks inactive only; `tech` is truthy so the unknown-ref flag
never fires), their ref counts as valid for sheet validation, and their seat is occupied. The
designed verify-after-connection behavior ("captures flagged until the manager confirms the
mailbox") has its review kind (`pairing_verification`) and its state (`pending_verification`)
defined, but no producer, no consumer, and no webhook awareness.

### Offboarding after Plan 1 — same shape

```
deactivate_technician_seat (two-step confirm)
  └─▶ state='offboarding'  ✅ seat freed (trigger excludes it)
       │                   ✅ mail now drops w/ dropped_audit receipt (webhook)
       │                   ✅ sheet-sync treats ref as unknown (would flag — if sync ran)
       │
       ⛔ everything below is manual / missing:
       ├─ badge revoke: hand-edit badges.json per host ("revoked": true)
       ├─ Composio: connectedAccounts.delete(ca_*) — only exists inside the
       │  reconnect script's --replace path; trigger delete has NO surface at all
       ├─ Telegram unbind + sandbox freeze: host-side provider/config edits, undocumented
       └─ offboarding → offboarded: NO transition exists. No grace-period concept,
          no expiry job, no reminder receipt. Rows stay 'offboarding' forever.
```

Note the timestamp problem for any future grace period: the only time marker on a state change is
the row's generic `updated_at` (set by the shared `set_updated_at()` trigger), which **any**
subsequent update overwrites — e.g. Plan 2 writing `composio_connected_account_id = null` during
teardown would reset the clock a grace-period job measures from. The `pending_deactivation`
review item does record `resolved_at` (when the manager confirmed), but that row's `detail` is the
only durable record linking the confirmation to the state change.

### Badge lifecycle — the file is the database

The badge↔identity mapping exists in exactly one kind of place: `/etc/doorman/badges.json` on
each host. The server-side `technicians` table has **no badge column** — the server cannot
enumerate which badges exist, which host holds them, or whether a roster state change has actually
been reflected in any badge file. The "badge ↔ roster two-part action" (architecture memory) is
coordinated entirely by humans. Facts that shape any generate+push design:

- One file per host; multiple sandboxes' badges live in the same file (tech-jane + manager-sam
  today, the latter now `revoked:true`).
- The doorman re-reads per request → distribution is atomic-file-replacement; no process restart.
- The doorman *service* cannot write the file (`ReadOnlyPaths`); a pusher writes as another user
  and must restore `doorman:doorman` mode 600 (live-observed failure mode: silent 403 of ALL
  badges).
- Connectivity is one-directional: hosts reach Render (that is the whole doorman design); nothing
  in the repo gives Render a way to reach a host, and no host registry/inventory exists anywhere
  in the system (the repo records one box, `nemoclaw-box` via brev, in prose only).
- Rotating a sandbox's badge additionally requires the host-side provider-credential update
  (`openshell provider update … TRADES_SPINE_BADGE=…`) — a secret-store write that also bumps the
  provider version (see the placeholder-versioning trap; benign only while configs hold canonical
  placeholders).

### Composio lifecycle — what the SDK calls look like today

All Composio access is via `@composio/core` with `COMPOSIO_API_KEY` from `.env`, in dev scripts
only. Verified call shapes (live-exercised during the per-person cycle):

- Pair: `c.connectedAccounts.link(userId, 'ac_5CdPk4l3GV2V')` → `{ redirectUrl }`; the human
  approves; `c.connectedAccounts.list({ userIds: [userId] })` shows `status === 'ACTIVE'` and
  `data.scope` (the granted scopes) once done (`composio-reconnect.mjs:55-65,92-95`).
- Unpair: `c.connectedAccounts.delete(it.id)` (`composio-reconnect.mjs:86-89`) — proven live in
  the replace path and the Phase 4 cleanup.
- Trigger create: `composio.triggers.create(userId, 'GMAIL_NEW_GMAIL_MESSAGE', { triggerConfig:
  { interval: 1, labelIds: 'INBOX', userId: 'me' } })` (`composio-trigger.mjs:58-64`). Trigger
  list/delete: **no repo surface**; the prior cycle's cleanup used ad-hoc `triggers.listActive({})`
  SDK calls (recorded in the 2026-07-01 plan's run notes).
- Webhook subscription: one per project (`ws_mfL3RD8klzYo`), SDK-only management
  (`triggers.setWebhookSubscription()`), no dashboard page (`.env.example:49-50`).

The connected account's **email address** does not appear anywhere in these call results as
recorded; whether `connectedAccounts.get/list` exposes it (vs. executing `GMAIL_GET_PROFILE`
through the account) is the standing open question from the prior research, still unresolved.

### Scheduling machinery — there is none

`syncScheduleFromSheet` is exported and tested but never called: no cron, no worker, no interval,
no script, no HTTP route triggers it. The deployed service runs `node dist/mcp/httpServer.js` and
nothing else. The only prior art on recurring work is a *warning* (`nemoclaw-tech-agent.md
§6:119-122`: "Before enabling the cron, add idempotency" — about the superseded direct-Gmail
fetcher). Any Plan 2 job (grace-period expiry, badge-state reconciliation, sheet sync) needs a
scheduling home that does not exist yet.

## External Dependencies

- **Composio** (`@composio/core ^0.13.1`, devDependency): connected accounts (link/list/delete),
  triggers (getType/create; list/delete unexplored), webhook subscription. Auth config
  `gmail-test` = `ac_5CdPk4l3GV2V` (Composio-managed OAuth, 11 scopes incl. full
  `https://mail.google.com/`). Per CLAUDE.md, every load-bearing claim about current Composio
  behavior must be re-verified against live docs at plan time.
- **Render**: hosts the HTTP server (public URL + `ALLOWED_CLIENT_IPS` + HMAC). Whether Render
  offers native cron jobs / background workers for a scheduler is a vendor question (not recorded
  in the repo).
- **Supabase (test project)**: all lifecycle tables; `pg_cron`-style in-database scheduling is a
  vendor capability question (not used anywhere today).
- **Host stack (doorman / OpenShell / NemoClaw / brev)**: entirely outside `src/`; reachable
  today only by a human (or host-side Claude) with shell access; hosts dial out to Render, never
  the reverse.
- **Google Sheets** (`googleapis`): the sheet reader used by the caller-less sync.

## Constraints and Invariants

1. **The state enum is ordered by intent, not by enforcement.** `setTechnicianState` writes any
   state; the only DB-level transition guard is the seat-cap trigger blocking re-activation at
   cap. Plan 2 automation (e.g. `offboarding → offboarded`) inherits this free-form machine.
2. **Only `offboarding`/`offboarded` change behavior.** `invited` and `pending_verification` are
   behaviorally identical to `active` on the webhook, sheet validation, and tool-gating paths
   (`isActiveManager` requires exactly `'active'`, so a `pending_verification` manager has no
   admin tools — the one exception).
3. **`pairing_verification` is a stub**: a union member in `ReviewKind` with zero producers and
   zero consumers.
4. **Refs are never reused** (`unique (tenant_id, ref)` across ALL rows) — offboarding automation
   must never delete roster rows; history attribution depends on them.
5. **The badge table is the host file.** No server-side representation of badges exists; the
   server cannot know badge state. Badge values are live credentials (never printed/logged —
   session security rule).
6. **The doorman cannot write its own badge file** (`ReadOnlyPaths=/etc/doorman`), and any writer
   must restore `doorman:doorman` mode 600 or every badge 403s silently.
7. **Connectivity is host→server only.** A "push" to hosts has no transport today; no host
   registry exists.
8. **`COMPOSIO_API_KEY` custody**: control-plane secret, currently confined to operator dev
   scripts; the deployed Render service does not hold it. Server-side Connect-Link issuance or
   offboarding automation changes that custody boundary.
9. **L1 is append-only; classification gates the insert** (CLAUDE.md) — any new inbound behavior
   during `pending_verification` must decide *before* writing, not clean up after.
10. **Trigger creation is not idempotent** and there is no pairing inventory beyond the (unwritten)
    `ca_*`/`ti_*` columns — Plan 2 is what makes those columns the inventory.
11. **`updated_at` is the only state-change timestamp** and any update resets it — unusable alone
    as a grace-period clock (see Data Flows).
12. **No rate limits exist anywhere** (admin tools, webhook, MCP endpoint). Existing guards are
    authenticity (HMACs), replay (300s webhook window), and tier gating only. Receipts to the
    manager are pull-only (`list_pending_reviews`); `dropped_audit` receipts have no
    manager-facing surface.
13. **A badge swap on a host bumps the OpenShell provider version** — until the
    placeholder-refresher patch is applied to `~/.nemoclaw/source`, any push design that rotates
    provider credentials after a container reboot can strand other channels (Telegram) via the
    versioning trap.

## Decision Points

Choice points the current code creates for Plan 2, stated factually:

1. **Badge distribution transport.** Hosts reach the server; the server cannot reach hosts, and
   no host inventory exists. The fork: (a) a host-side puller (each host periodically fetches its
   badges.json — needs an authenticated endpoint on the server plus a writer on the host that
   preserves ownership/mode), (b) an operator/host-Claude-mediated push (the server *generates*
   the file, a human or host agent applies it — closest to today's practice), or (c) standing up
   real server→host connectivity (new infrastructure, e.g. SSH from a control plane). Each option
   also decides where "which hosts exist" is recorded.
2. **Server-side badge representation.** To generate badges.json, badge values must live (or be
   derivable) server-side. The fork: store badge tokens in the `technicians` table (plaintext
   secret in the DB), store only hashes (host file then can't be *generated* from the DB alone),
   or derive badges deterministically (e.g. HMAC of tenant+ref with a control-plane key — the
   doorman compares literal strings, so derivation must happen at generation time only).
3. **`COMPOSIO_API_KEY` placement.** Connect-Link issuance from the manager's chat (the designed
   UX: "get connect link" tool) requires the key at request time. The fork: put the key on the
   Render MCP service (expands custody to the public-facing process), or run pairing/offboarding
   in a separate control-plane worker the MCP server talks to (new component), or keep issuance
   operator-mediated (no custody change, less self-serve).
4. **Scheduling home.** Grace-period expiry, sheet sync, and any reconciliation need a scheduler;
   none exists. The fork: in-process `setInterval` in `httpServer.ts` (single-replica assumption —
   the server is otherwise stateless/horizontal), a Render cron job invoking a script (vendor
   capability to verify), Supabase `pg_cron` (in-database, vendor capability to verify), or an
   external scheduler.
5. **Grace-period clock source.** `updated_at` resets on any update. The fork: add a dedicated
   column (e.g. `offboarding_started_at`), or read the resolved `pending_deactivation` review
   item's `resolved_at`, or log transitions to a new table.
6. **Verify-after-connection data source.** `connected_email` must come from somewhere: whether
   Composio's connected-account API exposes the mailbox address, or the server must execute
   `GMAIL_GET_PROFILE` through the paired account (requires tool-execution capability, not just
   account management). Unresolved pending live-docs verification (see Open Questions).
7. **What `pending_verification` gates.** Today it gates nothing. The designed behavior ("captures
   flagged until the manager confirms the mailbox") requires choosing where the flag producer
   lives: in the webhook (flag every capture while state is `pending_verification`) and/or a
   one-time `pairing_verification` review item created at pairing time — and whether mail during
   that window ingests normally, ingests-and-flags, or is held.

## Open Questions

Vendor questions — per CLAUDE.md these must be answered from **live Composio/Render/Supabase
docs at plan time**, never from this document alone:

1. Does the Composio connected-accounts API (get/list) expose the connected Gmail address, or is
   executing `GMAIL_GET_PROFILE` the only way to learn it? (Carried from the prior research doc,
   still unresolved.)
2. Connect Link lifecycle: `link()` redirect-URL validity window, single- vs multi-use, and
   whether pending links can be listed/expired/revoked. (Prior doc treats expiry as
   "undocumented — treat as sensitive".)
3. Trigger delete/list API shapes (`triggers.delete`? per-user filtering on `listActive`?), and
   whether deleting a connected account cascades to its triggers or leaves orphans that keep
   erroring.
4. Composio `user_id` length/charset constraints on composite ids (carried, still open).
5. Whether the single project-wide webhook subscription (`ws_mfL3RD8klzYo`) constrains
   multi-environment setups (test vs prod endpoints).
6. Render: does the platform offer cron jobs / background workers suitable for the expiry job,
   and does Supabase's `pg_cron` extension exist/enabled on the test project?

System questions resolvable by testing or by the user:

7. How many hosts exist today and what identifies them (the repo names one brev box in prose;
   badge push needs an authoritative list).
8. Whether `triggers.create` returns the `ti_*` id in a stable field shape suitable for the
   `composio_trigger_id` column (the script prints the raw object; the shape isn't recorded).
9. Whether the manager's "receipts" should surface `dropped_audit` rows (offboarded-mail drops)
   through `list_pending_reviews` or a new tool — currently they are invisible to the manager.
