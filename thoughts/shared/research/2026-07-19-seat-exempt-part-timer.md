---
date: 2026-07-19
branch: board-week-pager
commit: 38ad040
topic: Seat-exempt schedulable person ("part-timer") — roster model, seat cap, assignability, readers, Telegram/badge coupling, add verbs
---

## Summary

This documents everything the "seat-exempt part-timer" build would touch: how a person exists in
the system today. Every schedulable human is a row in the `technicians` table (the roster). That
row simultaneously carries FOUR roles that the part-timer feature wants to pull apart: (1) a
**name to schedule against** (visits point at the row), (2) a **billing seat** (a DB trigger blocks
inserting the row unless the tenant purchased capacity for its tier), (3) an **agent identity**
(badge → MCP tool access, Telegram binding → a personal AI sandbox), and (4) a **mail identity**
(Composio pairing). Today these are inseparable: the moment a roster row exists in any working
state, it burns a seat — even if it never gets a badge, sandbox, or mailbox. The live trigger for
this build: the pilot manager tried to assign "Hman (part-time)" to a visit, and the agent's only
path was `add_technician_seat`, which burns a purchased seat; the user declined and left the visit
unassigned. The good news in the code: roles (3) and (4) are **already opt-in** (badges mint only
for host-assigned rows; sandboxes claim only on `bind_telegram`; mail pairs only after
`get_connect_link`) — only role (2), the seat, is structurally fused to the row's existence.

## Entry Points

- [src/mcp/server.ts:2800](../../../src/mcp/server.ts#L2800) — `add_technician_seat` handler: the
  ONLY way a manager creates a roster row from chat (two-step confirm; mints the permanent ref).
- [src/schedule/booking.ts:62](../../../src/schedule/booking.ts#L62) — `resolveTechnician`: the
  single gate deciding "can this ref be put on a visit."
- [supabase/migrations/20260702194603_technicians_and_review_items.sql:38](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L38)
  — `enforce_seat_cap()` trigger: the structural seat coupling itself.
- [src/mcp/server.ts:937](../../../src/mcp/server.ts#L937) — `dispatch()`: per-request roster
  gate + tier gates (who may call which tool).
- [src/telegram/boardApi.ts:51](../../../src/telegram/boardApi.ts#L51) — `authBoard`: the Mini App
  identity path (Telegram id → roster row → tier decides view).

## Key Files

| File | Role for this feature |
|---|---|
| [src/db/technicians.ts](../../../src/db/technicians.ts) | Typed roster layer. `getTechnician`, `insertTechnician` (surfaces trigger errors via SQLSTATE), `isSeatCapError` (:314), `isInactiveState` (:413 — THE occupancy definition), `listTeam`, Telegram lookups (:34, :59), `setTechnicianAvailability` (:373), `WeeklyPattern` |
| [supabase/migrations/20260702194603_technicians_and_review_items.sql](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql) | `technicians` table, `technician_tier` enum ('manager','technician'), `technician_state` enum ('invited','pending_verification','active','offboarding','offboarded'), `tenants.manager_seats`/`technician_seats` (:30–32), `enforce_seat_cap` trigger (:38–51) |
| [supabase/migrations/20260717120000_technician_optional_bookings.sql](../../../supabase/migrations/20260717120000_technician_optional_bookings.sql) | `assignments.technician_id` is NULLABLE — unassigned visits exist; FK + overlap guard self-adapt to NULL |
| [src/schedule/booking.ts](../../../src/schedule/booking.ts) | `resolveTechnician` (:62), `availabilityWarning` (:74, advisory-only), book/move/cancel verbs + previews — the shared write path for chat AND board |
| [src/db/assignments.ts](../../../src/db/assignments.ts) | `createAssignment` (technicianId nullable, :22), technician-keyed reader (:212), tenant reader (:192), `listUnassignedAssignments` (:247) |
| [src/mcp/server.ts](../../../src/mcp/server.ts) | Tool defs (TOOLS :159, ADMIN_TOOLS :460, `MANAGER_TOOLS` :711, `TIERS` :155); dispatch gates (:954–976); `get_schedule` (:1377), `get_team_schedule` (:2213, techById :2277), `book_visit` (:2322), `add_technician_seat` (:2800), `deactivate`/`reactivate` (:2925/:3046), `bind_telegram` (:3194), `list_team` (:3283) |
| [src/schedule/boardRead.ts](../../../src/schedule/boardRead.ts) | Board day view; `techById` from `listTeam` (:94), viewer self-filter (:87–89), `unassigned:true` stops |
| [web/board/board.js](../../../web/board/board.js) | Client lane grouping keyed by `technicianRef` (:190–200); a lane exists only if that person has ≥1 stop that day (recorded drag-to-assign limitation); drop sets `body.technicianRef` (:389) |
| [src/control/badgeFile.ts](../../../src/control/badgeFile.ts) | Badge pull: mints ONLY for rows `listTechniciansForHost` returns (host_id set) that are non-inactive (:80); bindings ship only with sandbox_ref AND telegram_user_id (:72) |
| [src/telegram/boardApi.ts](../../../src/telegram/boardApi.ts) | Board auth by global Telegram-id roster lookup (:60); `tier === 'manager'` picks team view + write access (:162, :206) |
| [src/telegram/boardNotify.ts](../../../src/telegram/boardNotify.ts) | Push worker: notifies only rows with `telegram_user_id`, skipping inactive (:37–49); null technician = skip cleanly |
| [src/routes/daySource.ts](../../../src/routes/daySource.ts) | `listDayStops` (:41) — get_schedule's per-ref read; ref with no roster row = empty schedule, never a crash |
| [src/schedule/availability.ts](../../../src/schedule/availability.ts) | `isTechnicianAvailableOn` (:38): null pattern = fail-closed "not schedulable" for the (Plan-3) scheduler; manual booking only gets a warning |
| [src/jobs/lifecycle.ts](../../../src/jobs/lifecycle.ts) | Cron sweeps: pairing only for rows with `link_issued_at` (:61); Composio sessions only for `'active'` rows (:106) |
| [src/db/tenants.ts](../../../src/db/tenants.ts) | Seat capacity accessors: `createTenant` seats (:48), `setTenantSeats` (:66) |
| [thoughts/shared/research/2026-07-17-technician-optional-and-confirmation-policy.md](2026-07-17-technician-optional-and-confirmation-policy.md) | Feature-A research; Decision Point 3 (:238) named this feature's fork (b) |

## Data Flows

### What one roster row means today (the four fused roles)

```
                       technicians row (tenant_id, ref, tier, state)
                                        │
   ┌──────────────┬─────────────────────┼───────────────────────┬──────────────┐
   │ (1) SCHEDULE │ (2) SEAT            │ (3) AGENT IDENTITY    │ (4) MAILBOX  │
   │ name on      │ enforce_seat_cap    │ badge_hash + host_id  │ composio_*   │
   │ assignments. │ trigger: EXISTS in  │ (badge pull mints)    │ cols, set by │
   │ technician_id│ a working state ⇒   │ telegram_user_id +    │ get_connect_ │
   │ (nullable)   │ occupies one seat   │ sandbox_ref (set by   │ link pairing │
   │              │ of its tier         │ bind_telegram)        │ flow         │
   │  OPT-IN: a   │  STRUCTURAL: fires  │  OPT-IN: null until   │  OPT-IN: null│
   │  visit may   │  on INSERT — you    │  a manager binds;     │  until link  │
   │  also be     │  cannot create the  │  badge mints only     │  issued      │
   │  unassigned  │  row without a seat │  when host_id set     │              │
   └──────────────┴─────────────────────┴───────────────────────┴──────────────┘
```

Only role (2) is unconditional. A row that is never bound and never paired already behaves as a
"name to schedule against" — it just can't be created without burning a seat.

### The seat-cap trigger, precisely

[Migration 20260702194603:38–51](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql#L38):

- Fires `BEFORE INSERT OR UPDATE OF state, tier` — only those two columns retrigger it on update.
- `WHEN (new.state not in ('offboarding','offboarded'))` — transitions INTO a working state check
  the cap (this is what blocks reactivation at capacity); transitions out never do.
- Occupancy count: rows with same `tenant_id`, same `tier`, `state not in ('offboarding','offboarded')`,
  excluding the row itself. Cap: `manager_seats` if `new.tier = 'manager'` **else
  `technician_seats`** — a hypothetical third tier value would today be counted against
  `technician_seats` by that `else`.
- The JS mirror of the occupancy set is `isInactiveState`
  ([technicians.ts:413](../../../src/db/technicians.ts#L413)) — the comment records it "mirrors the
  DB seat-cap trigger's occupancy set," so the two are maintained as one definition.

### Assignability — every place the decision is made

```
manager says "put Hman on Tuesday 9–11"
        │
        ▼
book_visit / move_visit handler (server.ts:2322 / :2525)
        │  technicianRef optional; present-but-empty = error (:2336)
        ▼
resolveTechnician (booking.ts:62)          ← THE gate
        │  getTechnician(tenantId, ref)  → not found? "not on the roster"
        │  isInactiveState(state)?       → "deactivated — reactivate the seat first"
        │  (bookable today = invited | pending_verification | active — any tier;
        │   managers can be booked onto visits like anyone else)
        ▼
overlappingConfirmed pre-check (booking.ts:98) — per technician_id
        ▼
availabilityWarning (booking.ts:74) — ADVISORY only; null pattern ⇒
        "no working pattern configured yet" warning, booking proceeds
        ▼
createAssignment (assignments.ts:37) — technician_id nullable
        ▼
DB no_confirmed_overlap exclusion (migration 20260704210155:70) —
        `technician_id WITH =` never matches NULL: unassigned rows exempt
```

The board's move/cancel POSTs ([boardApi.ts:263–277](../../../src/telegram/boardApi.ts#L263))
call the same `moveVisit`/`cancelVisit`, so this chain is the single assignability authority for
every surface, chat and browser alike.

### How readers group by technician

- **get_team_schedule** ([server.ts:2277](../../../src/mcp/server.ts#L2277)) and
  **readBoardDays** ([boardRead.ts:94](../../../src/schedule/boardRead.ts#L94)) both build
  `techById = new Map(listTeam(tenantId)...)` — **every roster row, any tier, any state** — then
  annotate stops with `technicianRef`/`technicianName` (null + `unassigned:true` when
  `technician_id` is null). A part-timer row would flow through both readers with zero changes.
- **Board lanes** are built client-side by grouping stops on `technicianRef`
  ([board.js:190–200](../../../web/board/board.js#L190)); a person with no stops that day has NO
  lane (already recorded as the drag-to-assign limitation — you cannot drag a visit onto someone's
  empty day).
- **get_schedule** (technicians' route view, [server.ts:1413](../../../src/mcp/server.ts#L1413) →
  [daySource.ts:41](../../../src/routes/daySource.ts#L41)) is keyed by the **badge identity's
  ref** — a person with no badge can never invoke it, and per-technician readers never see
  null-technician rows by construction.
- **boardNotify** pushes only to rows with `telegram_user_id` that are non-inactive
  ([boardNotify.ts:41–48](../../../src/telegram/boardNotify.ts#L41)); an unbound person is skipped
  silently ("nobody to notify"), never an error.

### Telegram / badge / sandbox coupling — what is opt-in vs automatic

```
roster row created ──► NOTHING else happens automatically.
        │
        ├─ badge:    minted only when host_id is set — buildBadgeResponse walks
        │            listTechniciansForHost(hostId) (badgeFile.ts:63), and host_id
        │            is only ever set by bind_telegram's sandbox claim (server.ts:3260)
        │            or an operator. No host ⇒ no badge ⇒ no MCP tool access, ever.
        │
        ├─ sandbox:  bind_telegram (server.ts:3194) is the ONLY chat path that sets
        │            telegram_user_id — and when the row has no sandbox_ref it
        │            AUTO-CLAIMS a cold pool sandbox (:3236-3263), setting
        │            host_id + sandbox_ref in the same patch. There is NO
        │            "bind Telegram without claiming a sandbox" verb today.
        │
        ├─ board:    authBoard (boardApi.ts:51) needs only telegram_user_id on a
        │            live row — tier 'technician' gets the read-only self view,
        │            tier 'manager' gets team view + writes. No badge involved.
        │
        └─ mailbox:  get_connect_link stamps link_issued_at; the cron pairing
                     sweep (lifecycle.ts:61) filters on link_issued_at — a row
                     never issued a link is invisible to the sweep.
```

Consequence for a part-timer: leaving all identity columns null already yields "a name on the
schedule with no agent, no badge, no bot, no mailbox" — and the lifecycle cron ignores such a row
completely (pairing sweep needs `link_issued_at`; the Composio session sweep
([lifecycle.ts:106](../../../src/jobs/lifecycle.ts#L106)) only touches `'active'` rows). The one
thing that cannot be avoided today is the seat, and the one convenience that cannot be granted
without a sandbox is Telegram (board access / push), because `bind_telegram` always claims one.

### The add verb (onboarding path)

`add_technician_seat` ([server.ts:2800](../../../src/mcp/server.ts#L2800)):

1. **Stage** — `displayName` (+ optional `tier`, validated against `TIERS = ['manager','technician']`,
   [server.ts:155](../../../src/mcp/server.ts#L155)); ref minted by `slugify(displayName)`;
   duplicate pre-check; stages a `pending_seat_add` review item; returns `needs_confirmation`.
   The confirm requirement is doctrine-anchored: the description (:464) says two-step **because**
   it "mints a permanent never-reused ref … and occupies one purchased seat."
2. **Confirm** — token lookup, 15-min expiry, consume-first, then `insertTechnician`. Error
   mapping: seat-cap → "no free ‹tier› seats — deactivate someone or purchase a seat"; unique
   violation → "ref taken."

State lifecycle after insert: row starts `'invited'` and stays there unless the pairing flow
(`get_connect_link` → sweep → manager verification) advances it, or deactivation moves it to
`offboarding`/`offboarded`. Nothing requires a row to ever leave `'invited'`; booking works in
that state (the live bot booked invited Ben on 2026-07-17).

Roster surfacing: `list_team` ([server.ts:3283](../../../src/mcp/server.ts#L3283)) returns every
row with ref/displayName/tier/state/sandboxRef/botUsername — a part-timer row appears
automatically, with `sandboxRef`/`botUsername` null.

### Availability / working pattern

- Columns exist per technician: `availability` (jsonb weekly pattern) + `service_cities`
  (migration 20260704210155:18–20), `technician_time_off` table (:23).
- Typed setters exist ([technicians.ts:373, :392](../../../src/db/technicians.ts#L373)) but **no
  MCP tool exposes them** — none of the 26 tools sets availability or time off. Patterns are
  seeded/operator-written today.
- Semantics split: for manual booking, a null pattern only produces the advisory warning "no
  working pattern configured yet" ([booking.ts:90–92](../../../src/schedule/booking.ts#L90));
  for the scheduler, `isTechnicianAvailableOn` fails closed — null pattern = never available
  ([availability.ts:44–45](../../../src/schedule/availability.ts#L44)). A part-timer without a
  configured pattern is therefore manually bookable but invisible to Plan-3 auto-scheduling.

## External Dependencies

- **Supabase/PostgREST** — the seat-cap trigger error surfaces through PostgREST error messages
  (`isSeatCapError` string-matches `'seat_cap_exceeded'`); SQLSTATE preservation idiom throughout.
- **Composio** — only via the lifecycle sweeps and pairing flow; a row with no link and non-active
  state makes zero Composio calls.
- **Telegram Bot API** — board auth (initData HMAC against `BOARD_BOT_TOKEN`) and boardNotify
  pushes; both keyed off `telegram_user_id` on the roster row.
- **Sandbox pool / trades-box-1** — `bind_telegram`'s auto-claim consumes a finite pre-built
  sandbox (`sandbox_pool`, technician_id null = free); pool blanks are a purchased-seat-shaped
  resource ([seat-based licensing memory]).

## Constraints and Invariants

- **Refs are permanent and never reused across humans** (unique `(tenant_id, ref)` across ALL
  rows including offboarded — L1 attribution is append-only). Any add verb mints forever.
- **`isInactiveState` is the single occupancy/participation definition** — it drives the seat
  trigger's JS mirror, the dispatch gate (server.ts:955), the inbound mail gate
  ([webhook.ts:204](../../../src/inbound/webhook.ts#L204)), the Composio relay gate
  ([relayHandler.ts:124](../../../src/composio/relayHandler.ts#L124)), boardNotify liveness,
  badge revocation ([badgeFile.ts:107](../../../src/control/badgeFile.ts#L107)), and both
  Telegram lookups. Touching lifecycle states means touching all of these at once — deliberately
  (the comment calls it "a one-place decision").
- **The trigger only re-fires on `UPDATE OF state, tier`** — if seat exemption became a mutable
  column, flipping it would NOT re-check the cap unless the trigger's column list changes.
- **The trigger's cap lookup is a two-way branch** (`manager` else `technician_seats`) — any new
  tier value silently inherits the technician cap unless the function changes.
- **`bookingRequiresConfirmation` doctrine** (booking.ts:141): confirm only what is irreversible
  or externally visible. `add_technician_seat`'s confirm is justified by ref-permanence + seat
  burn; ref-permanence survives even for a seat-exempt add.
- **Tests run only against the local Supabase stack**; a schema change ships as a migration file
  applied to local first, then the pilot DB via explicit hosted apply (CLAUDE.md; the
  technician-optional migration followed exactly this path). Pilot DB writes need explicit user
  authorization naming the change.
- **Tool-surface counts are asserted in tests and docs**: technician list = 14, manager = 25
  (`server.test.ts` length assertions; docs/doorman-runbook.md; docs/nemoclaw-tech-agent.md §4;
  scripts/smoke-http.mjs expects 14). Any new tool moves these numbers everywhere at once.
- **Gateway caches tools/list per process** — a new/changed tool needs the wire-run + gateway
  restart recipe (sandbox-tool-allowlist-reality memory); AGENTS.md contract lines are the other
  half of a rollout.
- **Board lanes only exist for people with stops** — adding schedulable people does not by itself
  make them drag targets on an empty day.

## Decision Points

1. **How to represent seat exemption.** Three shapes the current code makes visible:
   - *(a) New `technician_tier` enum value* (e.g. `part_timer`): `ALTER TYPE ... ADD VALUE`;
     `enforce_seat_cap` must learn a cap for it (today's `else` lumps it with technicians —
     a seat-exempt tier wants the trigger to skip counting entirely); `TIERS` (server.ts:155)
     gates `add_technician_seat`'s tier arg; all `tier === 'manager'` checks are unaffected;
     `boardApi` would give it the technician read-only view as-is.
   - *(b) Boolean column on `technicians`* (e.g. `seat_exempt`): trigger changes = exclude
     exempt rows from the count AND skip firing for exempt rows; if the flag is mutable, the
     trigger's `UPDATE OF state, tier` column list must grow to include it; readers unaffected
     (they key on the row, not the flag); `list_team`/`add_technician_seat` decide whether to
     surface it.
   - *(c) Separate table*: every reader that builds `techById` from `listTeam`, both booking
     resolution paths, board auth, and the FK on `assignments.technician_id` would need a union
     type — the widest footprint by far given `assignments.technician_id` references
     `technicians(id)`.

2. **Which lifecycle state a part-timer row lives in.** Today's states all mean something to the
   agent-identity machinery. A part-timer parked in `'invited'` forever is inert to both cron
   sweeps (no link_issued_at, not 'active') and fully bookable. Making it `'active'` would make
   the Composio session sweep attempt to mint it a session every 15 min (lifecycle.ts:106) unless
   that sweep learns to skip it. A new state value would ripple into `isInactiveState`'s
   complement set and the seat trigger's WHEN clause.

3. **The add verb.** Reuse `add_technician_seat` (a tier/flag argument; the two-step confirm
   currently reads "occupies one purchased seat" — the preview copy and confirm rationale would
   need to reflect exemption, while ref-permanence still argues for keeping the confirm) vs a
   separate verb (e.g. `add_schedulable_person`) — which adds a 26th/27th tool and moves every
   asserted tool count + docs + AGENTS.md contract lines + gateway cache refresh.

4. **Telegram/board access for part-timers.** `bind_telegram` is the only `telegram_user_id`
   writer and always auto-claims a sandbox when none exists — binding a part-timer today would
   consume a pool blank (an agent they're not supposed to have). Forks: leave part-timers
   unbound (no board view, no push — boardNotify skips them cleanly); add a no-sandbox binding
   mode/verb (board auth + push already work off `telegram_user_id` alone); or accept the
   sandbox claim. The board's technician view and the push worker need zero changes in any fork.

5. **Whether a part-timer can graduate to a seated technician later.** The ref is permanent and
   the row is the identity anchor; a tier/flag flip is an `UPDATE` that (with shape (a) or a
   trigger-covered flag in shape (b)) re-fires the seat check at flip time. No verb exposes such
   a flip today (`deactivate`/`reactivate` move state, never tier).

6. **Availability setup for part-timers.** No chat-facing setter exists for `availability` /
   `technician_time_off` for anyone. A part-timer with a null pattern books manually with only a
   warning but is fail-closed invisible to Plan-3 auto-scheduling — the decision is whether this
   build adds a pattern setter (new tool: same count/doc/cache ripples as DP-3) or leaves
   patterns operator-seeded and lets Plan 3 own that surface.

## Open Questions

- Product/billing stance: is board (Mini App) access intended for part-timers, and if so is it
  free (the board bot is global and costs no sandbox) — or is Telegram visibility precisely what
  distinguishes a paid seat? (Decides DP-4.)
- Does the pilot's actual part-timer ("Hman") need push notifications when visits are assigned to
  them, or is the manager relaying by phone acceptable for v1?
- Should part-timer refs be visually distinguished in `list_team` / board lanes (e.g. a
  "part-time" tag), or is displayName enough? (Pure copy/UI decision; no structural constraint.)
- Migration sequencing on the pilot DB: local migration + tests first, then hosted apply needs
  the explicit user authorization step (standing rule) — timing relative to Plan-3 research is a
  scheduling decision outside this document's scope.
