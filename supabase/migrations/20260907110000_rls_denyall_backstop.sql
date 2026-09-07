-- Deny-all RLS backstop — close visit_notes, and stop this from recurring.
--
-- WHY. 20260824120000_rls_denyall_business_tables.sql enabled RLS with no policy
-- on every public table, which is what makes the anon/publishable key see
-- nothing (B1 Layer 1 in docs/prod-migration-checklist.md). It is a ONE-TIME
-- loop, so it only ever covered the tables that existed that day.
--
-- visit_notes was created on 2026-09-06 by 20260906140000_the_visit_is_one_object.sql.
-- That migration did `revoke all on visit_notes from anon, authenticated` (line
-- 136) but not the matching `enable row level security` — its sibling
-- 20260907100000_visit_participants.sql does both, which is the convention. The
-- table therefore sat with the grant closed but no RLS backstop.
--
-- Practical exposure was low BECAUSE the revoke landed: with no grant, anon
-- cannot read the table even with RLS off. But `auto_expose_new_tables = true`
-- in supabase/config.toml means a new table IS exposed to the Data API by
-- default, so the revoke is the only thing standing between a new table and the
-- public key. One forgotten line is a leak; that is too thin a margin for the
-- table that links customer notes to trips.
--
-- SHAPE. Rather than a one-line fix for one table, this re-runs the deny-all
-- sweep over every public table and then ASSERTS the invariant, so the same
-- omission in a future migration is caught here instead of in production.
-- Idempotent: enabling RLS that is already enabled and revoking a grant that is
-- already absent are both no-ops, and it does not touch policies — a table that
-- gains real tenant policies later (B1 Layer 3) keeps them, with RLS simply on.
--
-- service_role bypasses RLS by design, so this changes NO app behaviour. It
-- closes the external door only.

do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security;', t.relname);
    execute format('revoke all on public.%I from anon, authenticated;', t.relname);
  end loop;
end $$;

-- Post-conditions, checked INSIDE the transaction: if either fails the whole
-- migration rolls back rather than reporting success over a half-closed door.
do $$
declare
  no_rls   text;
  granted  text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into no_rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if no_rls is not null then
    raise exception 'deny-all backstop: RLS still disabled on: %', no_rls;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into granted
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and (has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('authenticated', c.oid, 'SELECT'));

  if granted is not null then
    raise exception 'deny-all backstop: anon/authenticated still hold SELECT on: %', granted;
  end if;
end $$;
