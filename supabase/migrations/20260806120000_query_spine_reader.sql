-- query_spine phase 1: the read-only surface the agent may compose SQL against.
--
-- Design: thoughts/shared/plans/2026-08-04-query-spine-design.md (decisions
-- resolved 2026-08-04). This migration is layers 1-2 of that design; the tool
-- wiring and audit writes are phase 2.
--
-- WHY THIS SHAPE. Isolation in this system rests entirely on hand-written
-- `.eq('tenant_id', …)` in each accessor — RLS is off and the app connects with
-- the service-role key, which bypasses RLS anyway. A tool that lets the model
-- write SQL would be the first path where no reviewed accessor writes that
-- filter. So the filter is never in the model's SQL: it lives in these views,
-- keyed off a transaction-local GUC that the server sets from the VERIFIED HMAC
-- identity. The model cannot see it or set it.
--
-- WHY SECURITY DEFINER, WHICH IS NORMALLY A FOOTGUN. Production talks to
-- Postgres only through PostgREST (src/db/client.ts), which cannot execute
-- arbitrary SQL and wraps each request in its own transaction. Rather than add a
-- second, parallel DB path (a `pg` pool + a new secret, against CLAUDE.md's
-- "all database access goes through src/db/"), query_spine() is owned by
-- spine_reader and marked SECURITY DEFINER — so the dynamic SQL runs with
-- spine_reader's privileges, which are STRICTLY FEWER than the service_role
-- caller's. This is SECURITY DEFINER used to DROP privileges, not to grant them,
-- which inverts the usual risk.
--
-- WHY VIEWS AND NOT AN APPENDED WHERE CLAUSE. String-injecting a tenant filter
-- into model-written SQL is right in theory and wrong in practice: every
-- subquery, CTE, UNION arm and join needs its own. This repo already has the
-- lesson one level up — PostgREST embeds do not inherit tenancy. A view is
-- enforced by the planner; our string handling is not.

-- ── the role ────────────────────────────────────────────────────────────────
-- NOLOGIN: it is a privilege container, never a connection. Nothing authenticates
-- as spine_reader; it exists so query_spine() has an owner with almost nothing.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'spine_reader') then
    create role spine_reader nologin;
  end if;
end
$$;

-- postgres must be a member to reassign ownership below.
grant spine_reader to postgres;

grant usage on schema public to spine_reader;

-- Deliberately NO table grants. The views below are owned by postgres and run
-- with the OWNER's privileges (Postgres views are not security-invoker unless
-- declared so), which is exactly the containment wanted: spine_reader reads the
-- views and can never reach a base table, a future table, or a column the view
-- does not name.
revoke all on all tables in schema public from spine_reader;

-- ── views: the entire visible surface ───────────────────────────────────────
-- Columns are named ONE BY ONE, never `select *`. technicians alone carries
-- badge_hash, three composio_* ids, connected_email and telegram_user_id — the
-- exact fields list_team keeps server-side ("Roster facts only"). A `select *`
-- view would have published all of them, and a future column would join them
-- silently.

create or replace view v_team as
  select t.ref,
         t.display_name,
         t.tier,
         t.state,
         t.seat_exempt,
         t.skills,
         t.service_cities,
         t.availability,
         t.created_at
    from technicians t
   where t.tenant_id = current_setting('spine.tenant_id')::uuid;

-- local_day is computed HERE, from the tenant's own timezone, because getting it
-- wrong is the single most likely bug in agent-written SQL over this schema:
-- assignments.starts_at is timestamptz, and bucketing by the raw UTC date puts
-- every evening stop on the wrong day. (Verified the hard way on 2026-08-04 —
-- a hand-written query against the wrong column and no timezone conversion
-- reported an entire week's schedule as empty.)
create or replace view v_schedule as
  select a.id            as assignment_id,
         (a.starts_at at time zone tn.timezone)::date as local_day,
         a.starts_at,
         a.ends_at,
         a.status,
         a.promise_level,
         a.promised_day,
         a.locked,
         a.earliest_date,
         a.latest_date,
         t.ref           as technician_ref,
         t.display_name  as technician_name,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
         j.status        as job_status,
         c.id            as customer_id,
         c.name          as customer_name,
         c.city,
         c.postal_code
    from assignments a
    join tenants tn on tn.id = a.tenant_id
    join jobs j     on j.id = a.job_id
    join customers c on c.id = j.customer_id
    left join technicians t on t.id = a.technician_id
   where a.tenant_id = current_setting('spine.tenant_id')::uuid;

create or replace view v_jobs as
  select j.id,
         j.title,
         j.job_type,
         j.status,
         j.priority,
         j.duration_minutes,
         j.price_cents,
         j.created_at,
         j.updated_at,
         c.id   as customer_id,
         c.name as customer_name
    from jobs j
    join customers c on c.id = j.customer_id
   where j.tenant_id = current_setting('spine.tenant_id')::uuid;

-- Customer contact details ARE included: this is the firm's own customer record,
-- the same data get_customer_context already returns to a manager. What is NOT
-- included anywhere is raw_captures (verbatim customer email) — excluded by
-- decision B of the design: densest PII in the system, append-only, and not
-- needed for the questions this tool exists to answer.
create or replace view v_customers as
  select c.id,
         c.name,
         c.phone,
         c.email,
         c.address_line1,
         c.city,
         c.state,
         c.postal_code,
         c.created_at
    from customers c
   where c.tenant_id = current_setting('spine.tenant_id')::uuid;

create or replace view v_time_off as
  select t.ref as technician_ref,
         t.display_name as technician_name,
         o.starts_on,
         o.ends_on,
         o.reason
    from technician_time_off o
    join technicians t on t.id = o.technician_id
   where o.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_team, v_schedule, v_jobs, v_customers, v_time_off to spine_reader;

-- ── audit ───────────────────────────────────────────────────────────────────
-- A table, not logs (decision C): this is the one tool where the agent composes
-- its own data access, so "did anyone query customer X?" has to be answerable
-- later, under our retention. NOT raw_captures — a read is not a state-changing
-- agent action under the classifier-free carve-out, and L1 is undeletable, so a
-- query log there could never be pruned.
create table if not exists query_audit (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  technician_ref text,
  sql            text not null,
  row_count      integer,
  duration_ms    integer,
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists query_audit_tenant_created_idx
  on query_audit (tenant_id, created_at desc);

-- Same posture as the cost tables: RLS on with no policy means anon and
-- authenticated get zero rows, while the service-role key (the only key the
-- server holds) is unaffected because it bypasses RLS.
alter table query_audit enable row level security;

-- ── the entry point ─────────────────────────────────────────────────────────
create or replace function query_spine(p_tenant uuid, p_sql text, p_max_rows integer default 200)
returns jsonb
language plpgsql
security definer
-- pg_temp LAST so a temp object cannot shadow a public one for this function.
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if p_sql is null or btrim(p_sql) = '' then
    raise exception 'query_spine: empty query';
  end if;
  -- format() does no escaping, so a crafted p_sql could close the wrapper and
  -- append a statement. Two things stop that mattering: this check, and the fact
  -- that anything appended still executes as spine_reader, which holds no write
  -- privilege on anything. Belt; the role is the braces.
  if position(';' in p_sql) > 0 then
    raise exception 'query_spine: one statement only — remove the semicolon';
  end if;

  -- Transaction-local (the `true`): set from the caller's VERIFIED identity, and
  -- unset outside this call. A view referencing it with no value set raises
  -- rather than returning everything — fail closed, loudly.
  perform set_config('spine.tenant_id', p_tenant::text, true);
  perform set_config('statement_timeout', '5000', true);

  -- The subquery wrapper also means a bare `select 1; drop …` cannot parse.
  execute format(
    'select coalesce(jsonb_agg(r), ''[]''::jsonb) from (select * from (%s) sub limit %s) r',
    p_sql,
    greatest(1, least(coalesce(p_max_rows, 200), 1000))
  ) into v_result;
  return v_result;
end;
$$;

-- Ownership is the whole mechanism: the body runs as spine_reader.
--
-- Postgres requires the incoming owner to hold CREATE on the schema, so it is
-- granted for exactly this statement and revoked immediately. Ownership is
-- checked at transfer time and persists afterwards, so the revoke does not undo
-- it. Leaving the grant in place would be a real weakening: a breakout could
-- then CREATE objects in public, which is precisely what this role must never do.
grant create on schema public to spine_reader;
alter function query_spine(uuid, text, integer) owner to spine_reader;
revoke create on schema public from spine_reader;
-- REVOKE FROM anon AND authenticated BY NAME, not just from PUBLIC.
--
-- Caught live on the pilot 2026-08-06, after this migration had already been
-- applied there: the ACL read
--   spine_reader=X | anon=X | authenticated=X | service_role=X
-- Supabase's DEFAULT PRIVILEGES grant EXECUTE on a newly created function in
-- public directly to anon and authenticated. Those are separate grants, so
-- `revoke ... from public` does not remove them — it only drops the implicit
-- PUBLIC grant, which was never the mechanism.
--
-- Why that mattered here more than for most functions: query_spine takes the
-- tenant as a PARAMETER. Anyone holding the project's anon key (publishable by
-- design) could have called it with ANY tenant id and read that tenant's
-- customers, phones, emails, addresses and schedule straight through the REST
-- API — the tenant filter is honoured, but the caller chooses the tenant.
-- Latent rather than live (this project uses only the service-role key and the
-- anon key appears nowhere in it), but the same class as the cost-table exposure
-- closed in 20260725140000. Compare tenant_cost_detail, which is correctly
-- postgres|service_role only.
--
-- src/db/querySpine.test.ts asserts this ACL so it cannot regress.
revoke execute on function query_spine(uuid, text, integer) from public, anon, authenticated;
grant execute on function query_spine(uuid, text, integer) to service_role;
