---
date: 2026-08-15
task: Firm profile v1 — the tenant business-identity store (name, address, license numbers, disclosure footer) + the set_firm_profile manager tool
research: thoughts/shared/research/2026-08-15-invoice-creation.md
status: complete
depends: none (independent of the money plans; prerequisite for 2026-08-15-invoice-creation-v1.md).
  NOTE (landing order): the shared test closures (tool counts 43/44) bake in the money-ledger
  tool, and HEAD alone does not typecheck after the 8830e46 sweep — land money-ledger first or
  together with this.
---

## Overview

Give each firm a business-identity record — what any customer-facing document must print:
names, address, phone, email, contractor license numbers, and a free-text disclosure footer
(Texas mandates specific wording on invoices; a template is offered). Filled by the manager
from chat. The `tenants` table holds none of this today (research: 8 columns, nothing
firm-identifying is customer-facing anywhere). Split out of the invoice-creation plan for
size; it is independently useful and has no dependency on the money ledger.

## Decisions

- **New `tenant_profiles` table (1:1 tenants)**, not columns on the hot `tenants` row (read on
  every timezone lookup) and not a JSONB bag — it's validated as a unit and queried on every
  future document render ("graduates to a table" bar met).
- **`license_numbers` is a JSONB array of `{label, number}`** — firms hold several licenses
  (trade + state variants); a single column would be the one-number mistake again.
- **All fields optional; gaps warn, never block** (workflow-agnostic: display requirements are
  state-specific). `profileGaps()` names what's missing; consumers decide what to do.
- **One-shot tool, no staging** — profile edits are reversible; per the confirmation doctrine
  they commit immediately and echo the saved state.
- *(implementation)* **A no-field call is a READ** — the plan's "no separate get tool" left
  viewing unspecified; `set_firm_profile {}` echoes the current profile + gaps without
  writing, so the profile is not write-only from chat.
- *(implementation)* **RLS-with-no-policy + anon/authenticated revoke added to the migration**
  — not in the plan's snippet, but required posture for every new table since the money_events
  review finding (this row is what invoices will print; a forged write = attacker text on
  customer documents). Empty-string field values are rejected (pass null to clear), and
  licenseNumbers entries are validated strictly (non-empty label/number, no unknown keys).
- *(final review, 2026-08-15)* **Key-closed tool surface** — unknown/misspelled arg names are
  refused (3 finders): with the no-field read mode, an all-unknown-keys call would otherwise
  flip into a success-shaped read while the manager is told "saved". Schema hardened to match
  (`additionalProperties: false`, `minLength: 1`).
- *(final review)* **`v_firm_profile` + spine_reader grant added** — the table's cited posture
  (v_money_events) pairs RLS/revoke with a tenant-GUC view; without it an ad-hoc query_spine
  "what address do we have on file?" dies on a permission error. View surface is now eight
  (closure test + query_spine description updated).
- *(final review)* **`state` normalizes to the uppercase 2-letter code** ('Texas' refused with
  the fix named) — it is the key every future state-keyed rule (disclosure templates) hangs on
  and the form that prints; free-text spellings would silently miss every consumer.
- *(final review)* **One roster, one statement** — the field list is exported once
  (`PROFILE_STRING_FIELDS` + `profileEcho`, `satisfies`-pinned column names) and the handler +
  schema derive from it (a schema-roster closure test pins the fourth copy); upsert is one
  atomic `.upsert(onConflict: 'tenant_id')` per the jobTypeDurations plain-index rule.
- *(final review)* **Cleanup paths taught about the new table** — `tenant_profiles` references
  only `tenants`, so NO existing truncate cascade reaches it: added to the eval world's
  RESET_TABLES (else one C10 run pins the Eval tenants forever — FK 23503 on rebuild) and to
  seed.mjs's truncateSpine (existence-probed for migration-lagged targets).
- *(surfaced, not changed — for the invoice-creation plan)* The TX TDLR template lives in the
  tool description per this plan's own text; the altitude reviewer argues state templates
  belong in state-keyed data (stale-legal-text + description-bloat risk) — revisit when part C
  builds the disclosure layer. Likewise "no separate get tool" was kept as planned; the
  get_availability precedent (106s discovery failure) argues a named `get_firm_profile` may
  earn its place later.

## Plain-language walkthrough

A new `tenant_profiles` table stores the firm's letterhead data. A manager chat tool
(`set_firm_profile`) sets any subset of fields ("our license number is TACLA12345E — add it");
the reply echoes the full saved profile plus warnings for likely-required missing fields, and
offers the Texas TDLR disclosure template in its description. Nothing else changes until a
consumer (the invoice plan) starts printing it.

## Secrets & env preflight

- **Phase 1:** none new. Local Supabase stack running (`npx supabase start`, `.env.test`).

## Phase 1: `tenant_profiles` + `set_firm_profile` tool

### What this phase does
Creates the firm-identity store and the manager tool that fills it.

### Changes required

**`supabase/migrations/<timestamp>_tenant_profiles.sql`** (new; pick the timestamp at
implementation time — `20260815120000` is already taken by `fireworks_rates.sql`)
- `create table tenant_profiles (tenant_id uuid primary key references tenants(id),
  display_name text, legal_name text, address_line1 text, address_line2 text, city text,
  state text, postal_code text, phone text, email text, license_numbers jsonb not null
  default '[]'::jsonb, disclosure_footer text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());` + `set_updated_at` trigger
  ([20260620012321 pattern](supabase/migrations/20260620012321_add_updated_at_trigger.sql)).

**`src/db/tenantProfiles.ts`** (new) — `getTenantProfile(tenantId)`,
`upsertTenantProfile(tenantId, patch)` (insert-catch-23505-then-update; partial-patch
semantics — only supplied fields change; explicit `null` clears), pure
`profileGaps(profile): string[]` (names missing invoice-header fields). Export from
[src/db/index.ts](src/db/index.ts); regenerate `database.types.ts`
(`npx supabase db reset` + `npm run gen:types:local`) or typecheck fails on the new table.

**`src/mcp/server.ts`** — `set_firm_profile` in `ADMIN_TOOLS` (one-shot): field args +
`licenseNumbers` (array of `{label, number}`) + `disclosureFooter`; the description offers the
TX TDLR footer template. Reply echoes the saved profile + gaps (no separate get tool).

### Automated verification
- [x] `npm run typecheck` / `lint` / `test` / `build` pass — full suite 1712 passed / 0
  failed (2026-08-15, after the final-review fix batch; includes the closure-count updates:
  manager surface 42→43, tool corpus 43→44, view surface seven→eight, eval case C10 added)
- [x] `tenantProfiles.test.ts`: upsert patch semantics (set, partial update, explicit-null
  clear), gaps list shape — plus trim/empty-string rejection, license entry validation,
  FK error SQLSTATE, tenant isolation, and the RLS/zero-privilege posture test
- [x] `server.test.ts`: technician refused (admin gate); manager set→echo round-trip incl.
  license array — plus no-field read, partial-patch pg read-back, coerced-to-absent guards

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [x] Tool write → psql read-back of `tenant_profiles`; evidence: row values.
  *(2026-08-15, fresh-context verifier against the real `dist/mcp/server.js` over stdio:
  manager tools/list carries the tool (43); write → partial patch → no-field read all echoed
  correctly; psql read-back row matched exactly — `Live Verify Heating | TX | 512-555-0199 |
  [{"label": "TX TACL", "number": "TACLA55555E"}]`; technician surface excludes the tool (14)
  and a direct call is refused "admin tools require a manager badge"; fixtures self-cleaned,
  zero residue.)*

### Manual verification
- [ ] none

---
*No manual items. The invoice-creation plan consumes this table. Note: this plan and part A
both edit `src/mcp/server.ts` + `src/db/index.ts` — overlapping footprint, so STACK them
(either order), per the concurrent-features rule; don't run two /implement sessions on them.*
