---
date: 2026-07-19
task: Seat-exempt schedulable person — add a name to the schedule without occupying a technician seat
research: thoughts/shared/research/2026-07-19-seat-exempt-part-timer.md
status: complete
---

## Overview

Let a manager add a person to the roster who can be booked on visits and shows up on the schedule
and dispatch board — but occupies NO purchased seat and can NEVER get an assistant sandbox,
Telegram access, or an email pairing. Product rationale (user, 2026-07-19): "part-timer" is just a
term — this is the treatment for anyone without a technician seat; firms are encouraged to buy
(inexpensive) technician seats for real technicians, so the seat-exempt person is a schedulable
name and nothing more. Live trigger: the pilot manager tried to assign "Hman (part-time)" and the
only path burned a seat.

The research confirmed this is cheap: the agent/Telegram/mailbox roles of a roster row are already
opt-in (null until explicitly bound), and every schedule reader (get_team_schedule, board, pushes)
handles any roster row unchanged. Only the seat-cap trigger fuses "row exists" to "seat burned" —
so the build is: one flag column + a trigger carve-out + an option on the add verb + refusal gates
on the two identity verbs + copy/tests/docs.

## Decisions

- **Representation** — `seat_exempt boolean not null default false` on `technicians` (user chose
  the minimal shape over a new tier or separate table). Readers key on the row, so none change.
- **Add verb** — extend `add_technician_seat` with an optional `seatExempt` boolean; no new tool
  (tool counts 14/25 stay put; only descriptions change → gateway restart, no doc-count churn).
- **No Telegram, no input path (user decision)** — `bind_telegram` and `get_connect_link` refuse
  seat-exempt rows with a clear error. With pairing refused, no mailbox ever connects, so the
  person can never become an inbound-mail path; with no badge/host, they can never call MCP tools.
- **Row state = `active` on insert** (my call) — honest in `list_team` (a person shown `invited`
  forever reads as stuck — same confusion class as pilot conflict #1). Cost is two lines: the
  lifecycle session sweep skips seat-exempt rows, and `reactivate_technician_seat` restores
  seat-exempt rows to `active` (today it restores sandbox-less people to `invited`).
- **`seatExempt` + `tier:'manager'` is rejected** (my call) — a seat-exempt manager is
  meaningless (managers exist to run agents) and would silently dodge the manager cap.
- **Confirm-token compatibility** (my call, revised per plan review) — BOTH the stage echo and
  the confirm branch treat a missing/non-true `seatExempt` in staged detail as `false` (exactly
  pre-feature behavior). No new strict staged-detail guard: a missing key then previews as
  seat-occupying AND commits as seat-occupying, so preview == commit holds by construction. (The
  first draft required `typeof staged.seatExempt === 'boolean'` at stage — the reviewer showed
  that check is either unreachable or, if moved to confirm, breaks this very compatibility.)
- **Graduation (exempt → seated) ships DB-correct but verb-less** (my call) — the trigger's
  column list includes `seat_exempt`, so flipping the flag re-runs the cap check even via
  operator SQL; a chat verb for it is deferred until asked for.
- **Types regen must use `--local`** (my call) — the repo's `gen:types` script targets the
  *linked hosted* project; running it before the pilot migration applies would generate types
  WITHOUT the new column. Use `npx supabase gen types typescript --local`.
- **Board drag-to-assign limitation stands** — a seat-exempt person with no stops that day has no
  board lane to drop onto (pre-existing, recorded limitation; chat covers it via move_visit).
- **Two-step confirm stays** for seat-exempt adds — the ref mint is still permanent
  (doctrine: irreversible ⇒ confirm), even though no seat burns.
- **Final-review deviations from the literal spec (all strengthen the plan's intent):**
  (1) `insertTechnician` DERIVES state internally (`seatExempt ⇒ 'active'`) instead of exposing a
  general `state?` override — two reviewers converged: call-site pairing lets a future caller mint
  a permanently-stuck `invited` exempt row; (2) the migration adds a `no_seat_exempt_managers`
  CHECK — the no-exempt-managers rule was app-layer-only while the cap is deliberately DB-owned
  (direct SQL could otherwise mint an uncapped manager); (3) the schedule-only fences moved ABOVE
  the `isInactiveState` checks in `bind_telegram`/`get_connect_link` — a deactivated exempt row
  otherwise answered "reactivate the seat first", steering the manager into a pointless
  board-visible reactivation; (4) copy/comment accuracy: `deactivate` notes exempt rows free no
  seat, `list_team` notes a structural-null botUsername for exempt rows, `isInactiveState`'s
  trigger-mirror comment updated, staged seat detail typed once (`StagedSeatDetail`).

## Plain-language walkthrough

**Phase 1 — the database learns "this row is free".** We add a true/false column `seat_exempt` to
the roster table, and teach the seat-counting rule (a database trigger — code that runs inside
the database on every insert) two things: don't count flagged rows against the purchased-seat cap,
and don't run the cap check when inserting one. Flipping the flag OFF later (making the person a
real seated technician) automatically re-runs the check. You'd notice it working because a test
can fill every purchased seat and still insert a flagged row — but can't un-flag it at full
capacity.

```
add_technician_seat ──► technicians row
                          seat_exempt=false ──► trigger counts it → needs a free seat
                          seat_exempt=true  ──► trigger skips it  → always fits
```

**Phase 2 — the chat verb and the fences.** The existing "add a person" tool gains a
`seatExempt` option. The confirmation preview changes honestly: instead of "this will occupy one
technician seat" it says "this will NOT occupy a seat — schedulable name only (no assistant, no
Telegram, no email)". The two verbs that grant identity — `bind_telegram` (assistant/board) and
`get_connect_link` (email pairing) — refuse flagged rows with a plain-language error, so the
boundary can't be crossed by accident. `list_team` shows the flag so the agent can answer "is
Hman a real seat?". A background job that mints agent sessions for active people learns to skip
flagged rows. Booking, moving, the board, and notifications need zero changes — verified by the
research and locked in with tests.

**Phase 3 — ship it to the pilot and prove the original scenario.** Apply the migration to the
pilot database (needs your explicit go-ahead, per the standing rule), you merge + deploy, we
restart the box gateways so the bots see the new tool descriptions, and then the real test: in
the manager chat, "add Hman as a part-timer" → confirm → assign Hman to the visit that started
all this. We verify with database read-backs (row has `seat_exempt=true`, no seat consumed,
visit assigned) and the board shows Hman's lane.

## Secrets & env preflight

- **Phase 1:** none new (local Supabase stack + `.env.test`, already required).
- **Phase 2:** none.
- **Phase 3:** none new — pilot DB via the already-connected `supabase-test` MCP; box access via
  the existing `ssh tradesbox` alias (PATH export gotcha applies).

## Phase 1: Schema + typed layer

### What this phase does
Adds the column, carves the trigger, regenerates types, and extends the typed insert so a caller
can create a seat-exempt row in state `active`.

### Changes required

**`supabase/migrations/20260719120000_seat_exempt_roster.sql`** (new)
```sql
alter table technicians add column seat_exempt boolean not null default false;

-- Seat-exempt rows neither occupy a seat nor trigger the cap check; flipping
-- seat_exempt OFF re-fires the check (update-of column list) so graduation is
-- DB-correct even with no verb exposing it yet.
create or replace function enforce_seat_cap() returns trigger language plpgsql as $$
declare cap integer; used integer;
begin
  select case when new.tier = 'manager' then manager_seats else technician_seats end
    into cap from tenants where id = new.tenant_id;
  select count(*) into used from technicians
    where tenant_id = new.tenant_id and tier = new.tier
      and state not in ('offboarding', 'offboarded')
      and not seat_exempt and id <> new.id;
  if used >= cap then raise exception 'seat_cap_exceeded'; end if;
  return new;
end $$;

drop trigger technicians_seat_cap on technicians;
create trigger technicians_seat_cap
  before insert or update of state, tier, seat_exempt on technicians
  for each row when (new.state not in ('offboarding', 'offboarded') and not new.seat_exempt)
  execute function enforce_seat_cap();
```

**`src/db/database.types.ts`** — regenerate from the LOCAL stack after applying the migration:
`npx supabase gen types typescript --local > src/db/database.types.ts` (NOT `npm run gen:types`,
which is `--linked` and would read the hosted project pre-migration).

**`src/db/technicians.ts`**
- `InsertTechnicianInput` gains `seatExempt?: boolean;` and `state?: TechnicianState;` (comment:
  state override exists for the seat-exempt add — they skip the pairing lifecycle entirely).
- `insertTechnician` insert object adds `seat_exempt: input.seatExempt ?? false` and
  `...(input.state ? { state: input.state } : {})`.

**Nine test-file `Technician` factories** (reviewer finding: regenerated types make `seat_exempt`
a REQUIRED Row property, and each factory spreads a `Partial<Technician>` over a full literal —
`boolean | undefined` fails strict typecheck, so Phase 1's gate is unmeetable without this sweep).
Add `seat_exempt: false` to the base literal in each:
`src/jobs/lifecycle.test.ts:27`, `src/inbound/webhook.test.ts:82`,
`src/composio/relayHandler.test.ts:27`, `src/composio/outbound.test.ts:9`,
`src/composio/logIngest.test.ts:11`, `src/composio/offboarding.test.ts:16`,
`src/composio/pairing.test.ts:18`, `src/composio/sessions.test.ts:14`,
`src/control/badgeFile.test.ts:11`.

### Automated verification
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (46 files, 521 passed / 1 pre-existing key-gated skip)
- [x] New tests in `src/db/technicians.test.ts`: (1) with `technician_seats` full, a
  `seatExempt: true` insert succeeds (state `active`); (2) at full cap, `update seat_exempt=false`
  on that row raises `seat_cap_exceeded` (graduation guard); (3) a seat-exempt row does not count
  toward occupancy — a seated insert still succeeds up to the cap alongside exempt rows;
  (4) `seatExempt` omitted ⇒ row has `seat_exempt=false` (existing callers unchanged).

### Live verification (agent-executable)
- Prerequisites: local Supabase stack running (`npx supabase start`).
- [x] `npx supabase migration up` applies cleanly on the local stack (evidence:
  "Applying migration 20260719120000_seat_exempt_roster.sql… Local database is up to date.";
  reviewer independently introspected the live local schema: column NOT NULL DEFAULT false,
  trigger `UPDATE OF state, tier, seat_exempt` + WHEN clause + count filter all present).

### Manual verification
- [ ] none

---
*No manual items — continue directly to Phase 2.*

## Phase 2: MCP surface, refusal gates, sweep skip

### What this phase does
Wires `seatExempt` through the add verb's stage/confirm, fences the two identity verbs, surfaces
the flag in `list_team`, fixes reactivate's restore state, and gates the Composio session sweep.

### Changes required

**`src/mcp/server.ts`**
- `add_technician_seat` tool def (:462): add `seatExempt` to `inputSchema.properties`
  (`{ type: 'boolean', description: 'true = add a schedule-only person who occupies NO seat: bookable on visits and visible on the board, but can NEVER have an assistant, Telegram, or email pairing. First call only.' }`);
  extend the description with one sentence saying the same and that tier must be technician.
- Stage branch (:2808–2864): reject non-boolean `args.seatExempt` (`typeof` check — SDK doesn't
  validate); `const seatExempt = args.seatExempt === true;` reject `seatExempt && tier === 'manager'`
  with a clear error; carry `seatExempt` in the staged `detail` and the `preview`. The existing
  malformed-staging guard (ref/displayName/tier) is UNCHANGED — the echo derives
  `staged.seatExempt === true` (missing ⇒ false, identical to confirm, so preview == commit holds
  for any detail shape). Branch the note copy on it: seat-occupying (current text) vs
  `'Nothing was added. This will NOT occupy a seat — schedule-only person (no assistant, no
  Telegram, no email). It still mints the permanent ref '<ref>'. …'`.
- Confirm branch (:2874–2923): `const seatExempt = d.seatExempt === true;` (missing ⇒ false);
  pass `seatExempt` and `...(seatExempt ? { state: 'active' as const } : {})` to `insertTechnician`.
- `bind_telegram` handler: after the inactive check (:3207–3209) add
  `if (target.seat_exempt) throw new Error(\`'${ref}' is schedule-only (no seat) — they cannot have an assistant or Telegram access\`);`
  and add one description clause noting schedule-only people are refused.
- `get_connect_link` handler: same-shaped refusal after its inactive check (:3153) —
  schedule-only people have no email pairing; matching description clause.
- `reactivate_technician_seat` (:3077): `const restoredState = target.seat_exempt || target.composio_connected_account_id ? 'active' : 'invited';`
  AND (reviewer finding) gate the `hasSandbox` note (:3108–3138): a seat-exempt row never has a
  sandbox, so without a `!target.seat_exempt` condition every seat-exempt reactivation would emit
  "no live assistant sandbox … use bind_telegram to claim a fresh one" — an instruction this
  plan's own bind_telegram gate then refuses. Suppress both no-sandbox/bind hints for seat-exempt
  rows. (The `restoredState === 'invited'` hint at :3131 already never fires once they restore to
  `'active'`.)
- `list_team` (:3292): add `seatExempt: t.seat_exempt` to the returned shape.

**`src/jobs/lifecycle.ts`**
- Session sweep (:106): `const rows = (await listInStates(['active'])).filter((r) => !r.seat_exempt);`
  (comment: seat-exempt people have no agent — never mint them a Composio session).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (46 files, 524 passed / 1 pre-existing skip)
- [x] New tests in `src/mcp/server.test.ts`: stage with `seatExempt:true` → preview carries
  `seatExempt`, note says "NOT occupy a seat"; confirm → roster row `seat_exempt=true`,
  `state='active'`; `seatExempt` non-boolean → error; `seatExempt`+`tier:'manager'` → error;
  **pre-deploy token compatibility** — craft the token via the db layer directly
  (`upsertOpenReviewItem` with `detail` lacking the `seatExempt` key, the pre-feature shape),
  confirm it → commits with `seat_exempt=false`, state default (`'invited'`); a normal
  no-`seatExempt` stage→confirm flow also lands `seat_exempt=false`; `bind_telegram` on a
  seat-exempt row → "schedule-only" error; `get_connect_link` likewise; reactivate on a
  deactivated seat-exempt row → `'active'` AND the result carries NO bind_telegram/no-sandbox
  note; `list_team` rows carry `seatExempt`.
- [x] New test in `src/schedule/booking.test.ts`: `bookVisit` with a seat-exempt technicianRef
  succeeds (assignability regression lock; also locks the pattern-less advisory warning).
- [x] New test in `src/jobs/lifecycle.test.ts`: session sweep with one active seated + one active
  seat-exempt row calls `ensureSession` only for the seated row (summary counts stay coherent).

### Live verification (agent-executable)
- Prerequisites: none beyond the local stack (all behavior is codified above).
- [ ] n/a — Phase 3 carries the live E2E.

### Manual verification
- [ ] none

---
*No manual items — continue to Phase 3.*

## Phase 3: Docs, pilot rollout, live E2E

### What this phase does
Documents the option where the add-verb contract is described, applies the migration to the pilot
DB (explicit user authorization required), and proves the original "Hman" scenario end to end.

### Changes required

**Docs (counts unchanged — sentence-level edits only):**
- `docs/doorman-runbook.md` — where `add_technician_seat` is described, add the `seatExempt`
  sentence (schedule-only person, no seat, bind/pair refused).
- `docs/nemoclaw-tech-agent.md` §4/§5 — same sentence at the seat-add contract.
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` + `Box_Setup_Stuff/doorman-architecture-memory.md`
  — same sentence (Box_Setup_Stuff sync rule: same-change update).

**Rollout steps (in order):**
1. `npm run build`; open the PR (standing rule: no direct push to main).
2. **STOP — ask the user** to authorize the pilot-DB migration by name, then apply
   `20260719120000_seat_exempt_roster.sql` via `mcp__supabase-test__apply_migration`.
3. User merges + Render **"Deploy latest commit"** (not "Redeploy" — old-commit trap).
4. Box: `ssh tradesbox` (`export PATH="$HOME/.local/bin:$PATH"`), `nemoclaw s2 gateway restart`
   (+ s3/s5 — cached tool descriptions).

### Automated verification
- [ ] `npm run build` passes
- [ ] full gate suite (`typecheck`/`lint`/`test`) green on the PR branch

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP (connected); user drives the s2 manager chat + board on
  their phone; pilot-DB write authorization for the migration (step 2 above).
- [x] Hman read-back 2026-07-19: `seat_exempt=true, state='active'`, telegram_user_id /
  sandbox_ref / badge_hash ALL null (evidence: execute_sql row in session).
- [x] Seat math: 2 seated technicians vs 5 purchased; Hman absent from the count.
- [x] Assignment read-back: Hman's visit `confirmed`, 2026-07-29 14:00–16:00, promise 'none'
  (one-shot assignment, no confirm dialog — doctrine held).
- [x] `bind_telegram` refusal live (user screenshot): "structurally blocked from having
  Telegram access… hard limit" — agent relayed the fence, claimed no sandbox.
- NOTE (rollout ordering, live-learned): the user deployed BEFORE the pilot migration — the
  first confirm failed cleanly ("Could not find the 'seat_exempt' column… no seat was added",
  token consumed, zero rows written; the two-step protected the pilot). Migration applied
  with explicit authorization 2026-07-19 + PostgREST schema-cache reload; retry succeeded.

### Manual verification
- [ ] Board (user's phone): Hman appears as a lane with the assigned visit — pending the
  user's next board glance (scheduling itself user-confirmed working).
- [x] The add-flow preview copy reads correctly in chat (screenshot: "Seat: None — no
  assistant, no Telegram bot, no email pairing").

---
*Pause after Phase 3 for the manual checks (user's phone).*
