-- Deny-all RLS across every business table (prod-migration-checklist B1 · Layer 1).
--
-- WHY. RLS is off on the core spine tables (customers, jobs, visits, raw_captures,
-- and the rest), so the publishable ("anon") key can read them straight from
-- PostgREST, bypassing the /admin bearer token entirely — the same latent hole the
-- cost tables had before 20260725140000_cost_tables_rls.sql closed it. This is the
-- project's inherited posture via auto_expose_new_tables (supabase/config.toml),
-- NOT something any one feature introduced, and it is the dated debt due before
-- 2026-10-30 (docs/engineering-memory.md §4; system-design Tier 2 "dated debts").
--
-- WHY NO POLICY. The server holds ONLY the service_role key (src/db/client.ts), and
-- service_role BYPASSES row-level security. So the cron, every src/db accessor, and
-- the /admin endpoint are all unaffected — enabling RLS with no permissive policy
-- means exactly one thing: anon and authenticated get zero rows. Adding a policy
-- would be strictly worse: any policy is a door, and none of these tables has a
-- legitimate client-side reader. (Mitigating fact, verified earlier: the anon key
-- is absent from .env.example and web/ — this was a latent exposure, not a live
-- one. This makes it structurally closed regardless.)
--
-- WHY NO APP-BEHAVIOR CHANGE. Because service_role bypasses RLS, the local suite
-- (superuser/service_role) stays green and prod behavior is unchanged. This closes
-- the external Data-API door only. Full-tenant per-row policies (B1 Layer 3) are a
-- separate, later change that requires introducing a non-bypass role — NOT this
-- migration.
--
-- APPLY (system-design Tier 2 — migrations do not auto-apply, and NEVER db push):
--   1. Local Docker stack first — `npm test` must stay green.
--   2. Current hosted PILOT DB via Supabase MCP `apply_migration` (latent exposure).
--   3. Fresh PROD DB at cutover (B2) — a new box inherits the same open default.
-- VERIFY after each apply (read-back, not the version ledger): `get_advisors` clears
-- the "RLS disabled" advisory, and an anon-key probe of customers/jobs/raw_captures
-- returns 0 rows / 401.
--
-- IDEMPOTENT. ENABLE ROW LEVEL SECURITY and REVOKE are both no-ops when already in
-- effect, so re-running (or running over tables the cost/phone retrofits already
-- closed) is safe. spatial_ref_sys is excluded: it is a PostGIS-owned system table
-- that a non-owner cannot ALTER, and it holds no tenant data.

-- ── Base tables: enable RLS + revoke the Data-API grants (belt-and-braces) ────────
-- RLS alone suffices today; the REVOKE keeps the door shut even if a future
-- migration or a dashboard action toggles RLS back off (the cost-tables pattern).
do $$
declare t record;
begin
  for t in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'spatial_ref_sys'
  loop
    execute format('alter table public.%I enable row level security;', t.tablename);
    execute format('revoke all on public.%I from anon, authenticated;', t.tablename);
  end loop;
end $$;

-- ── Views: revoke the Data-API grants too (REVIEW DECISION — see note) ────────────
-- RLS is table-level, so it cannot be "enabled" on a view; a view instead runs with
-- its owner's privileges and can therefore re-expose an RLS-protected table through
-- PostgREST. The tables loop above does NOT cover this. Since the anon key is unused
-- project-wide, revoking anon/authenticated on every public view is safe and closes
-- that path. Remove this block ONLY if a view gains a legitimate client-side reader.
do $$
declare v record;
begin
  for v in
    select table_name
    from information_schema.views
    where table_schema = 'public'
  loop
    execute format('revoke all on public.%I from anon, authenticated;', v.table_name);
  end loop;
end $$;
