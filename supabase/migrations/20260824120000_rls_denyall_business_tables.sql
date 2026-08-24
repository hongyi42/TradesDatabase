-- Deny-all RLS across every business table (prod-migration-checklist B1 · Layer 1).
--
-- WHY. RLS is off on the core spine tables (customers, jobs, visits, raw_captures,
-- and the rest), so the publishable ("anon") key can read them straight from
-- PostgREST, bypassing the /admin bearer token entirely — the same latent hole the
-- cost tables had before 20260725140000_cost_tables_rls.sql closed it. This is the
-- project's inherited posture via auto_expose_new_tables (supabase/config.toml),
-- NOT something any one feature introduced.
--
-- ⚠️ READ BEFORE APPLYING — this migration REVERSES A RECORDED OWNER DECISION.
-- docs/engineering-memory.md: "anon-readable tables on the pilot are a DELIBERATE
-- posture (owner, 2026-08-06) — do not 'fix' them." The stated mitigation is that
-- the anon key appears nowhere in this project, so the exposure is by
-- key-disclosure rather than open data, and the stated trigger to revisit is "if
-- the key is ever published (a web front end, a client bundle, a doc)". Applying
-- this is therefore an OWNER CALL, not a routine hardening step. Two facts that
-- bear on it: an untracked `site/` now exists in this repo, and this migration also
-- closes a real gap the owner decision predates — `v_captures` (added
-- 20260823120000) exposes `raw_captures.raw_text` and `sensitivity`, and shipped
-- with no revoke of its own.
--
-- The same entry also CORRECTS a justification this file previously carried: the
-- 2026-10-30 date is NOT a remediation deadline. Supabase is removing the
-- `auto_expose_new_tables` option, after which NEW entities stop being auto-granted
-- to anon; EXISTING grants are unaffected. It is a change in the default for future
-- tables. Do not cite it as a reason this must land by a date.
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

-- ── Materialized views: neither loop above reaches them ──────────────────────────
-- A matview is in neither `pg_tables` nor `information_schema.views`, so without
-- this block a "deny-all" migration silently skips them. RLS cannot be enabled on
-- one at all, which makes the REVOKE the only available mechanism.
do $$
declare m record;
begin
  for m in select matviewname from pg_matviews where schemaname = 'public'
  loop
    execute format('revoke all on public.%I from anon, authenticated;', m.matviewname);
  end loop;
end $$;

-- ── Functions: the grant that REVOKE ... FROM PUBLIC does not reach ──────────────
-- Supabase's default privileges grant EXECUTE on a newly created function in
-- `public` DIRECTLY to anon and authenticated. Those are separate grants from
-- PUBLIC's, so the usual `revoke ... from public` leaves them in place. Hit live on
-- the pilot 2026-08-06 with `query_spine`, which takes the TENANT AS A PARAMETER —
-- anyone holding the publishable key could have called it for ANY tenant
-- (docs/engineering-memory.md, "revoke ... from public does NOT revoke
-- anon/authenticated on a new function").
--
-- Measured here before writing this block: `enforce_seat_cap`, `raise_append_only`
-- and `set_updated_at` still carried `anon=X | authenticated=X`. All three return
-- `trigger`, so a direct call fails and nothing is actually reachable today — this
-- is hygiene, not an open hole. It earns its place because the default applies to
-- EVERY function added later, and the next one may take arguments like query_spine
-- did.
--
-- Extension-owned functions are excluded (deptype 'e'): they are not ours to
-- re-permission and revoking on them can break the extension. Aggregates are
-- excluded by prokind — REVOKE ... ON ROUTINE does not accept them.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    -- PUBLIC as well as the two named roles, and the order matters for the reason
    -- the engineering-memory entry gives from the other direction: PUBLIC is a
    -- pseudo-role meaning EVERY role, so leaving `=X/postgres` in place lets anon
    -- execute by inheritance even after its direct grant is gone. Verified here:
    -- revoking only anon+authenticated left enforce_seat_cap, raise_append_only and
    -- set_updated_at still carrying PUBLIC's EXECUTE. Both halves are required.
    execute format('revoke all on routine %s from public, anon, authenticated;', f.sig);
  end loop;
end $$;
