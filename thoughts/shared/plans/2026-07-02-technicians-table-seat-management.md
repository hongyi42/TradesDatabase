---
date: 2026-07-02
task: Technicians table + manager seat-management MCP tools + loose ref enforcement (Plan 1 of the self-serve onboarding cycle)
research: thoughts/shared/research/2026-07-02-self-serve-onboarding-technicians-table-surface.md
status: complete
---

## Overview

Structural core of the onboarding cycle per the user's 2026-07-02 decisions: a lifecycle-bearing
`technicians` table (per-tenant ref uniqueness across ALL rows — refs never reused; deactivated
rows kept), a tenant-scoped `review_items` queue (loose accept-and-flag, reviewed by the manager
via chat), webhook + sheet-sync integration, manager-tier admin MCP tools with server-side
seat-cap enforcement, and retirement of the legacy bare-uuid pairing mode.

**Deferred to Plan 2 (control-plane lifecycle):** badges.json generation/push (+ Telegram unbind,
sandbox freeze), Connect-Link issuance from the server (`@composio/core` runtime dep),
verify-after-connection email fetch, trigger auto-create, Composio offboarding automation,
grace-period auto-expiry, receipts + rate limits. This plan lands the states/tools those drive.

Migrations target the TEST project (`mcp__supabase-test__apply_migration`); prod is a deploy step.

*Length flag: 309 lines (>250 guideline). The cycle is already split (Plan 2 above); the overage
is the verbatim migration SQL and the existing-test breakage inventory from adversarial review —
kept because both remove implementer ambiguity.*

## Phase 1: Schema + typed DB layer

### What this phase does
Creates `technicians` and `review_items`, adds seat counts to `tenants`, enforces the seat cap in
the DB, regenerates types, adds the typed access layer. No behavior change elsewhere.

### Changes required

**`supabase/migrations/<timestamp>_technicians_and_review_items.sql`** (new; after applying,
rename the file to the apply-time ledger version, as in the 2026-07-01 plan)
```sql
create type technician_tier  as enum ('manager', 'technician');
create type technician_state as enum ('invited', 'pending_verification', 'active',
                                      'offboarding', 'offboarded');
create table technicians (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  ref          text not null,           -- the vocabulary-contract string (badge/user_id/sheet)
  display_name text not null,
  tier         technician_tier  not null default 'technician',
  state        technician_state not null default 'invited',
  sandbox_ref  text,                    -- operator-assigned cold-sandbox handle
  composio_connected_account_id text,   -- ca_* (Plan 2 writes these)
  composio_trigger_id           text,   -- ti_*
  connected_email               text,   -- verified mailbox (Plan 2)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, ref)               -- across ALL rows: refs are never reused
);
create index idx_technicians_tenant on technicians(tenant_id);

alter table tenants
  add column manager_seats    integer not null default 1,
  add column technician_seats integer not null default 0;

-- Server-side seat cap (structural, never agent-trusted). Residual concurrent-insert
-- race under read committed is accepted (one manager per tenant, chat cadence).
-- 'offboarding'/'offboarded' rows do NOT occupy a seat: confirmed deactivation frees
-- the seat immediately; reactivating at cap is blocked by this same trigger.
create function enforce_seat_cap() returns trigger language plpgsql as $$
declare cap integer; used integer;
begin
  select case when new.tier = 'manager' then manager_seats else technician_seats end
    into cap from tenants where id = new.tenant_id;
  select count(*) into used from technicians
    where tenant_id = new.tenant_id and tier = new.tier
      and state not in ('offboarding', 'offboarded') and id <> new.id;
  if used >= cap then raise exception 'seat_cap_exceeded'; end if;
  return new;
end $$;
create trigger technicians_seat_cap before insert or update of state, tier on technicians
  for each row when (new.state not in ('offboarding', 'offboarded'))
  execute function enforce_seat_cap();

create type review_status as enum ('open', 'resolved', 'dismissed');
create table review_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  kind        text not null,   -- 'sheet_ref_mismatch' | 'unknown_ref_capture'
                               -- | 'pairing_verification' | 'pending_deactivation'
  subject_ref text not null,
  suggestion  text,            -- fuzzy-match candidate, if any
  detail      jsonb not null default '{}'::jsonb,
  status      review_status not null default 'open',
  resolution  text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
-- One OPEN item per (kind, subject): repeat flags return the existing row.
create unique index uq_review_items_open on review_items (tenant_id, kind, subject_ref)
  where status = 'open';
create index idx_review_items_tenant on review_items(tenant_id);
```
Also attach the existing `set_updated_at()` trigger (`20260620012321_add_updated_at_trigger.sql`)
to `technicians`.

**`src/db/database.types.ts`** — regenerate via `mcp__supabase-test__generate_typescript_types`.

**`src/db/technicians.ts`** (new) — `getTechnician(tenantId, ref)`; `listTeam(tenantId)`;
`insertTechnician({tenantId, ref, displayName, tier})`; `setTechnicianState(id, state)`;
`isSeatCapError(err)` (message contains `seat_cap_exceeded`).

**`src/db/reviewItems.ts`** (new) — `upsertOpenReviewItem({tenantId, kind, subjectRef,
suggestion?, detail?})` → **returns the open row**: insert and return; on 23505 select and return
the existing open `(tenantId, kind, subjectRef)` row (callers, e.g. deactivate's `confirmId`,
need the id on the retry path). `listOpenReviewItems(tenantId)`;
`resolveReviewItem(id, tenantId, status: 'resolved'|'dismissed', resolution?)` — tenant-guarded,
returns the row or null.

**`src/db/index.ts`** — add `export * from './technicians.js'; export * from './reviewItems.js';`

**`scripts/seed.mjs`**
- Raise the seed tenant's capacity before roster inserts:
  `update tenants set manager_seats = 2, technician_seats = 5 where id = TENANT_ID`
  (migration defaults 1/0 would make the first technician insert hit the cap).
- Add `technicians, review_items` to the truncate at `:59` (seed must stay re-runnable;
  `unique (tenant_id, ref)` aborts the second run otherwise).
- Seed roster: `tech-jane` + `office-dispatch` (technician, active), `manager-sam` (manager,
  active — used by admin-tool tests).

**New test `src/db/technicians.test.ts`** — integration against the TEST project, self-cleaning
(pattern: `spine.test.ts`/`context.test.ts` — NOT `droppedAudit.test.ts`, a pure unit test):
duplicate ref insert → 23505; seat cap blocks the N+1th active technician and allows it after one
row is set `offboarding`; review-item open-dedup returns the same row id on repeat upsert;
resolve flips status + stamps `resolved_at`. `afterAll` truncates `technicians, review_items`.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (88/88, 18 files; also re-verified
      the `npm run seed && npx vitest run src/db/technicians.test.ts` sequence after review fix)
- [x] New `technicians.test.ts` passes (4 tests)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP.
- [x] `execute_sql` probe (self-rolling-back DO block): `dup=[unique_violation (23505) raised]
      cap=[seat_cap_exceeded]`; both tables + both triggers present; 0 probe rows left.
      Note observed: at cap, a duplicate-ref insert reports `seat_cap_exceeded` (BEFORE-trigger
      order), not 23505 — admin-tool error mapping should check the cap error first.

### Manual verification
- (none)

---
*No manual checks — continue to Phase 2 after gates pass.*

## Phase 2: Webhook person-state handling + legacy bare-uuid retirement

### What this phase does
The webhook consults the roster: offboarded person → drop with receipt; unknown ref → ingest and
flag; bare-uuid `user_id` is retired (composite required). The live legacy pairing is deleted
first so nothing still posts bare-uuid deliveries.

### Changes required

**`src/inbound/webhook.ts`**
- `InboundWebhookDeps` (`:68-74`): add `getTechnician?` and `flagReview?` (defaulting to the live
  `getTechnician` / `upsertOpenReviewItem`).
- Retire bare-uuid: after the split (`:155-157`), `if (sep === -1) return { status: 'bad_payload' };`
  `personRef` is then always defined — drop the `?? 'connector:…'` fallback at `:171`
  (`technicianRef = personRef`). Update the envelope comment (`:97-107`).
- After `tenantExists` (`:182`), inside the try (roster read throw → `transient_error`):
  ```ts
  const tech = await getTechnician(tenantId, technicianRef);
  if (tech && (tech.state === 'offboarding' || tech.state === 'offboarded')) {
    await recordDrop({ tenantId, channel: envelope.channel, externalId: envelope.externalId,
      from: meta.from, reason: 'offboarded', technicianRef });
    return { status: 'skipped_offboarded' };
  }
  ```
- Unknown ref (`!tech`): ingest, then flag **only on first ingest** —
  `if (r.status !== 'duplicate') await flagReview({ tenantId, kind: 'unknown_ref_capture',
  subjectRef: technicianRef, detail: { externalId: envelope.externalId } });`
  (a redelivery returns `duplicate` and must NOT re-open a resolved item). Wrap the flag in
  try/catch — the capture is ground truth; the flag is advisory and must not fail the ingest.
- Add `'skipped_offboarded'` to `InboundWebhookStatus` (`:82-90`).

**`src/mcp/httpServer.ts`** — `INBOUND_STATUS_CODES` (`:45-54`): add `skipped_offboarded: 200`.

**`src/db/tenants.ts`** / **`docs/nemoclaw-tech-agent.md` §7** — update comments/prose:
composite required; bare-uuid mode retired 2026-07-02.

**`src/inbound/webhook.test.ts`** — the retirement breaks ~8 existing tests, not one: `body()`'s
default `user_id` is a **bare uuid** (`:28`), so every test reaching past the split (clean-body
classifier `:138`, duplicate `:245`, bare `'acme'` → `unknown_tenant` `:224`, unknown tenant
`:284`, skipped_non_work `:298`, transient `:326`, FK `:340`) would get `bad_payload`. Fixes:
- `body()` default `user_id` → composite `'<same-uuid>:tech-test'`; the bare `'acme'` test
  becomes composite-with-non-uuid-tenant (still `unknown_tenant`).
- Extend `baseDeps()` (`:79-87`): `getTechnician` stub → an active technician row;
  `flagReview` → recorder no-op. **Without these, existing composite tests hit the live DB.**
- Delete/rewrite the `connector:gmail` attribution test (bare uuid → now `bad_payload`).
- New tests: bare uuid → `bad_payload`; offboarded ref (stub `state:'offboarded'`) → drop receipt
  carries `reason:'offboarded'` + ref, no `recordFieldNote` call; unknown ref (stub → null) →
  `ingested` + `flagReview` called; unknown ref + `duplicate` → no flag; active ref → no flag.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (96/96, 18 files; webhook suite 25)

### Live verification (agent-executable)
- Prerequisites: `COMPOSIO_API_KEY` in `.env`; `supabase-test` MCP; deployed webhook or local
  server for signed probes.
- [x] Legacy June pairing already gone — verified live 2026-07-02 before planning completed:
      `connectedAccounts.list` under the bare tenant `user_id` → 0 Gmail connections;
      `triggers.listActive({})` → 0 instances project-wide. (The 2026-07-01 plan's run-note
      "left for the user to decide" was stale.) Re-verify with the same two read-only calls
      before deploying if time has passed.
- [x] Signed probe (local server :8099, session-scoped webhook secret — the real
      `COMPOSIO_WEBHOOK_SECRET` is not in the local `.env`, only on Render): bare-uuid →
      400 `bad_payload`; composite unknown ref → 200 `ingested` (`captureId ab934d3e-…`) +
      SQL read-back: 1 `raw_captures` row (`technician_ref='probe-unknown-ref'`) and 1 open
      `unknown_ref_capture` review item. Redelivery probe: same captureId, still 1+1 rows.
      **Finding fixed during verification:** unmatched captures redeliver as `ingested` (orphan
      heal), not `duplicate`, so the flag gate was moved into `flagUnknownRefCapture` with
      per-message (`detail.externalId`) dedup — a resolved item is never re-opened by a
      redelivery of the same message. Also hardened beyond plan scope (review finding): both
      composio dev scripts now refuse to CREATE bare-uuid pairings/triggers (read-only `--wait`
      listing still accepts a bare uuid).

### Manual verification
- [ ] Read the §7 diff — invariant text matches the implemented behavior.

---
*Pause after this phase: manual §7 doc-review (the legacy-pairing deletion is already done).*

## Phase 3: Sheet-sync loose validation + fuzzy suggestions

### What this phase does
`syncScheduleFromSheet` still upserts every row (loose), but refs not in the roster raise a
`sheet_ref_mismatch` review item with a closest-active-ref suggestion.

### Changes required

**`src/schedule/refSuggest.ts`** (new) — `closestRef(bad: string, refs: string[]): string | null`:
case-insensitive Levenshtein (small local implementation, no dependency); nearest ref with
distance ≤ 2, else null.

**`src/schedule/sheetSync.ts`** — `syncScheduleFromSheet` (`:78-101`): deps gain
`{ roster?, flagReview? }` (defaults `listTeam` / `upsertOpenReviewItem`). Load refs once,
excluding `offboarding`/`offboarded` rows; for each row whose `technicianRef` is not in the set,
after the upsert: `flagReview({ tenantId, kind: 'sheet_ref_mismatch', subjectRef:
row.technicianRef, suggestion: closestRef(...), detail: { rowKey: row.rowKey } })`. Return
`{ upserted, flagged }`.

**`src/schedule/sheetSync.test.ts`** — **update the two existing tests** to pass a stub roster
containing `tech-1`/`tech-2` and a recorder `flagReview` (else they run the live flag path and
leave rows behind); add `review_items` to the `afterAll` truncate (`:19`). New tests: roster ref
→ no flag; `tehc-1` → flagged with suggestion `tech-1`; rows upserted either way (count
unchanged); repeat sync of the same bad ref doesn't error (open-dedup returns the same row).

**`src/schedule/refSuggest.test.ts`** (new) — unit: exact/1-edit/2-edit match; no match > 2.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (103/103, 19 files; incl.
      refSuggest unit tests + a live flag-path test proving one open item across repeat syncs).
      Review fixes applied: per-row flag write is advisory (try/catch — a failed flag never
      aborts the import) and roster-read hard-fail is documented as deliberate.

### Live verification (agent-executable)
- (none — the sheet reader stays stubbed; live Sheets behavior unchanged)

### Manual verification
- (none)

---
*No manual checks — continue to Phase 4.*

## Phase 4: Manager-tier admin MCP tools

### What this phase does
Five seat-management tools on the trades-spine server, gated server-side by the caller's roster
tier (looked up from `technicians` — doorman/badge scheme unchanged). Deactivation is a two-step
confirm-resume persisted in `review_items` (stateless-replica safe).

### Changes required

**`src/mcp/server.ts`**
- `requireManager(identity)`: `getTechnician(tenantId, identity.technicianRef)`; throw
  `'admin tools require a manager badge'` unless the row exists, `tier === 'manager'`, and
  `state === 'active'`. (`dispatch` is already async — `:129-133`.)
- New `TOOLS` entries + `dispatch` cases (all call `requireManager` first; all writes scoped by
  `identity.tenantId`):
  - `add_technician_seat { displayName, tier? ('technician' default) }` — mint
    `ref = slugify(displayName)` (lowercase; non-alphanumeric → `-`; collapse/trim; reject empty
    and `connector:*`); `insertTechnician(...)` → state `invited`; return the row. Map 23505 →
    `ref '<ref>' is taken — disambiguate (add a middle name or employee id)`; seat-cap error →
    `no free <tier> seats — deactivate someone or purchase a seat`.
  - `deactivate_technician_seat { ref, confirmId? }` — without `confirmId`: upsert a
    `pending_deactivation` review item for `ref`, return `{ status: 'needs_confirmation',
    confirmId: <row id>, ref, displayName }` (repeat call returns the same id — open-dedup).
    With `confirmId`: load the item (tenant-guarded, `open`, matching `ref`), resolve it, set
    state `offboarding`, return `{ status: 'deactivated', ref }`. The seat frees immediately
    (`offboarding` doesn't count against the cap). Refuse the caller's own ref
    (`cannot deactivate yourself`).
  - `list_team {}` → `listTeam(tenantId)` (refs/names/tiers/states — no Composio ids).
  - `list_pending_reviews {}` → `listOpenReviewItems(tenantId)`.
  - `resolve_review { reviewItemId, resolution ('resolved'|'dismissed'), note? }` →
    `resolveReviewItem` (null → `review item not found`).

**`src/mcp/server.test.ts`** (exists — extend in place) — stubbed *identity*, **live roster**
(`requireManager` reads the DB): `beforeAll` inserts an active manager + technician row for the
seed tenant and sets known seat counts; extend the `afterAll` truncate (`:42`) with
`technicians, review_items` (re-runs would trip `unique (tenant_id, ref)`). Tests:
technician-tier identity on any admin tool → error; add seat mints slug + returns row; duplicate
display name → disambiguation error; cap exhausted → purchase error; deactivate w/o `confirmId`
→ `needs_confirmation`, target still active; repeat → same `confirmId`; with `confirmId` → state
`offboarding`; self-deactivation refused; cross-tenant `resolve_review` → not found.

**`docs/nemoclaw-tech-agent.md` §4** — add the five admin tools to the *manager* profile
allowlist note (technician profile unchanged).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (104/104, 19 files)
- [x] `npm run build` (pre-PR gate)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; local `npm run mcp:serve:http` + `GATEWAY_IDENTITY_SECRET`
  to sign manager/technician identity headers (curl probes).
- [x] Live HTTP probes (local :8098, session-scoped gateway secret — the real secret lives on
      the deployed pair): technician identity lists exactly 7 tools and gets
      `admin tools require a manager badge` on add; manager identity lists 12 and add returned
      the roster row (`ref probe-person, state invited`), confirmed by independent pg read-back;
      forged identity signature → HTTP 401, nothing leaked. Probe row deleted; roster re-seeded
      and verified after a concurrent test-suite truncate.
      Beyond-plan addition (flagged): `tools/list` is tier-filtered (managers see 12, technicians
      the unchanged 7), so the doorman docs' "7 tools" verification stays true for technician
      badges; doorman-runbook + Box Setup Stuff notes updated per the sync rule.

### Manual verification
- (none — injection hardening here is structural and covered by the tests)

---
*No manual checks — cycle continues in Plan 2 (badge push channel + Composio lifecycle).*
