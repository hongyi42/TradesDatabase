-- Portal accounts — the map from "a person who signed in" to "exactly one tenant".
--
-- Plan: thoughts/shared/plans/2026-08-12-portal-real-data.md (D2), which supersedes
-- the `billing_contacts` table in the 2026-08-07 plan: same reasoning, billing
-- framing removed because the owner descoped Stripe on 2026-08-12.
--
-- WHY THIS IS NOT A COLUMN ON `technicians`. Two different facts:
--   * `technicians.connected_email` is the Composio Gmail BINDING — which mailbox
--     the agent acts on behalf of. It is null for most rows and says nothing about
--     who may administer the account.
--   * The person who administers a firm's account is routinely not on the roster
--     at all (an owner's partner doing the books). Making login an attribute of a
--     roster row would force a fake technician per customer, which would then be
--     counted by every seat and headcount query in the system.
--
-- WHY `citext`. Email is case-insensitive in practice; a `text` unique index lets
-- Ray@… and ray@… become two accounts for the same human, which for an
-- invite-only system means the second one silently fails to match an invite.
--
-- THE INVARIANT THIS TABLE EXISTS TO ENFORCE: one email resolves to at most one
-- tenant. `email` is globally unique, NOT unique-per-tenant. If the same address
-- could hold rows for two tenants, session resolution would have to pick one, and
-- "pick one" in a cross-tenant lookup is exactly the bug class this whole feature
-- is trying not to have. Multi-firm accountants are a real future need; they get a
-- deliberate design (an explicit tenant switcher with re-authorisation), not an
-- accidental one produced by a weaker constraint.

create extension if not exists citext with schema extensions;

create table portal_accounts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  -- Globally unique: see "THE INVARIANT" above. Deliberately not (tenant_id, email).
  email        extensions.citext not null unique,
  -- Supabase Auth's user id. Nullable because a row is created at INVITE time,
  -- before that person has ever completed a magic link and therefore before
  -- auth.users has a row for them. No FK: auth.users lives in a schema this
  -- project's migrations do not own, and a cross-schema FK to it would couple
  -- our DDL to Supabase's internals.
  auth_user_id uuid unique,
  -- 'owner' administers the account. 'operator' is US, not a customer — it is
  -- what gates the cross-tenant admin queue (plan D4). A customer session must
  -- never be able to obtain this value.
  role         text not null default 'owner' check (role in ('owner', 'operator')),
  invited_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

create index portal_accounts_tenant_idx on portal_accounts (tenant_id);

-- ── Close the Data-API door ────────────────────────────────────────────────
-- Same posture and same reasoning as the cost tables (20260725140000): RLS on,
-- NO policy. The service-role key bypasses RLS and is the only key the server
-- holds, so every src/db accessor is unaffected; enabling RLS with no permissive
-- policy means exactly one thing — anon and authenticated get zero rows.
--
-- It matters more here than on the cost tables. This table is the lookup that
-- decides which tenant a browser session may read, and the portal is the first
-- surface in this system that OUTSIDERS use. If the publishable anon key could
-- read or (worse) write it straight through PostgREST, an attacker could grant
-- their own address a row against someone else's tenant and the session layer
-- above would faithfully honour it.
alter table portal_accounts enable row level security;

-- Belt and braces, exactly as the cost ledger does it: revoke the Data-API grants
-- too, so the table stays closed even if a future migration or a dashboard action
-- toggles RLS back off. Also pays down another slice of the auto_expose_new_tables
-- debt (due before 2026-10-30, docs/engineering-memory.md §4).
revoke all on portal_accounts from anon, authenticated;
