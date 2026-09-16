-- The retrieval layer, plan 3 Phase 1: the SQL views fold
-- (thoughts/shared/plans/2026-09-15-the-retrieval-layer-3-the-planner-and-the-sql-views.md).
--
-- SUPERSEDES the 2026-08-23 ruling recorded in 20260823120000_planner_read_surface.sql
-- ("RETRACTIONS ARE A LABELED TRAIL, not a fold"). Operator ruling 3, 2026-09-15:
-- a retracted note is REMOVED from every default read, the planner's SQL views
-- included. The one labelled exception is the manager's audit trail on the seat
-- tools (list_recent_captures / get_capture with includeRetracted), which reads
-- through captures_page / capture_full, not through these views.
--
-- And ONE link view replaces three. "Which job, customer or trip is this note
-- on" had four answers in this catalog — v_visit_notes, v_job_captures,
-- v_customer_captures, and the usually-NULL v_captures.job_id/customer_id stamps
-- the catalog had to warn the model about. capture_membership (20260916120000)
-- is the one definition every seat tool already reads; v_capture_links is that
-- definition, for SQL.

drop view v_captures;
drop view v_visit_notes;
drop view v_job_captures;
drop view v_customer_captures;

-- Live captures only. The last two terms ARE capture_is_live(c.id), copied
-- verbatim rather than called: a function referenced inside a view is
-- EXECUTE-checked against the role running the query (Postgres CREATE VIEW
-- docs), and spine_reader must not hold EXECUTE on the tenant-less capture
-- helpers — nor could capture_is_live read raw_captures as spine_reader, which
-- holds no base-table grant. src/db/spineViews.test.ts pins that this view and
-- captures_page agree on the live set, so the two copies cannot drift silently.
create view v_captures as
  select c.id,
         c.captured_at,
         c.channel,
         c.technician_ref,
         c.raw_text,
         c.sensitivity
    from raw_captures c
   where c.tenant_id = current_setting('spine.tenant_id')::uuid
     and c.retracts_capture_id is null
     and not exists (select 1 from raw_captures r where r.retracts_capture_id = c.id);

-- One row per way a LIVE capture is attached to the record. capture_membership
-- already re-checks the tenant on every hop (every one of those foreign keys is
-- id-only); the GUC scopes the rows to the caller's firm.
create view v_capture_links as
  select m.capture_id,
         m.customer_id,
         m.job_id,
         m.visit_id,
         m.via
    from capture_membership m
    join raw_captures c on c.id = m.capture_id and c.tenant_id = m.tenant_id
   where m.tenant_id = current_setting('spine.tenant_id')::uuid
     and c.retracts_capture_id is null
     and not exists (select 1 from raw_captures r where r.retracts_capture_id = c.id);

grant select on v_captures, v_capture_links to spine_reader;
revoke all on v_captures, v_capture_links from anon, authenticated;

-- query_spine, unchanged except for ONE deleted line:
--   perform set_config('statement_timeout', '5000', true);
-- It never bounded anything. MEASURED 2026-09-15 through /rpc/query_spine on the
-- local stack: `select pg_sleep(6)` returned after 6.03 s, and `pg_sleep(12)` was
-- cancelled at 8.05 s (57014). The timer for a statement is armed when the
-- statement STARTS, so a GUC changed inside the running function cannot reach
-- it. The bound that does hold is the `authenticator` role's own
-- statement_timeout=8s (pg_roles, identical on the local stack and the hosted
-- pilot; service_role and spine_reader carry none) — PostgREST's login role, so
-- it covers every RPC this server makes.
--
-- This comment sits OUTSIDE the function body on purpose: a comment inside $$
-- is part of pg_get_functiondef, which querySpine.test.ts reads to pin that the
-- dead line stays gone.
--
-- create or replace keeps the owner (spine_reader — the whole containment
-- mechanism, see 20260806120000) and the ACL; the revoke/grant pair is re-stated
-- anyway, because a missing revoke here was once a live exposure.
create or replace function query_spine(p_tenant uuid, p_sql text, p_max_rows integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if p_sql is null or btrim(p_sql) = '' then
    raise exception 'query_spine: empty query';
  end if;
  if position(';' in p_sql) > 0 then
    raise exception 'query_spine: one statement only — remove the semicolon';
  end if;

  perform set_config('spine.tenant_id', p_tenant::text, true);

  execute format(
    'select coalesce(jsonb_agg(r), ''[]''::jsonb) from (select * from (%s) sub limit %s) r',
    p_sql,
    greatest(1, least(coalesce(p_max_rows, 200), 1000))
  ) into v_result;
  return v_result;
end;
$$;

revoke execute on function query_spine(uuid, text, integer) from public, anon, authenticated;
grant execute on function query_spine(uuid, text, integer) to service_role;
