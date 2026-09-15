-- The retrieval layer, core (plan 2026-09-15-the-retrieval-layer-1-captures-and-the-customer-read).
--
-- Until this migration, "which captures belong to this job / this customer" was
-- answered by six different unions in TypeScript (research
-- 2026-09-15-the-retrieval-and-delivery-layer §2), the retraction fold was
-- hand-copied at least five times, the manager-only filter was applied per
-- handler, and every reader shipped id lists back out in URLs that fail at
-- ~205 UUIDs. The operator ruled 2026-09-15 that the rules live HERE, once:
--
--   capture_membership   every way a capture is attached to the record — nine
--                        arms over the six attachment kinds (two stamps, three
--                        source_capture_id parents, three link tables), tenant
--                        re-checked on every hop because every one of those
--                        foreign keys is id-only.
--   capture_is_live      retracted? A capture is retracted iff a retraction row
--                        points at it; retraction rows are never "live" either.
--   capture_visible      the tier gate. Option A (operator 2026-09-15): a
--                        technician sees technician-channel captures; email,
--                        calls, outbound mail and agent actions are manager- and
--                        planner-only by default. An unknown tier sees NOTHING.
--                        Plan 2 adds scope (their jobs, their customers), grants
--                        and the firm's own rule to this same predicate.
--   customer_contents    the contents page: profile, jobs with counts and the
--                        newest visible note's opening, the customer-level pile,
--                        money rows, and the ids of retracted evidence — one call,
--                        fixed size, no matter how long the history is.
--   captures_page        one page of a scope's captures, keyset-paged, text cut.
--   capture_full         one capture, full words.
--   search_captures      keyword search inside a scope (technicians' search).
--
-- Every function takes the tenant as a parameter from the VERIFIED identity
-- (the tenant_cost_detail / query_spine posture): service_role only, revoked
-- from anon and authenticated BY NAME (Supabase's default privileges grant
-- EXECUTE to both on every new function — see 20260806120000's note).

-- ---------------------------------------------------------------------------
-- Indexes the reads below lean on. visits(source_capture_id) belonged to the
-- OLD visits table dropped in 20260906140000; the renamed table never got one,
-- so captureHasLinkedL2 has been scanning it fleet-wide on every inbound
-- pre-check.
create index if not exists idx_raw_captures_customer_captured
  on raw_captures (customer_id, captured_at desc, id desc);
create index if not exists idx_raw_captures_job_captured
  on raw_captures (job_id, captured_at desc, id desc);
create index if not exists idx_visits_source_capture
  on visits (source_capture_id) where source_capture_id is not null;

-- ---------------------------------------------------------------------------
-- One row per (capture, attachment). A capture attached three ways yields three
-- rows; readers take `distinct capture_id`. NOT retraction-aware: the fold is
-- applied by every reader below (capture_is_live), so the audit path can ask
-- for retracted rows through the same membership.
create view capture_membership as
  select c.tenant_id, c.id as capture_id, cu.id as customer_id,
         null::uuid as job_id, null::uuid as visit_id, 'customer_stamp'::text as via
    from raw_captures c
    join customers cu on cu.id = c.customer_id and cu.tenant_id = c.tenant_id
  union all
  select c.tenant_id, c.id, j.customer_id, j.id, null::uuid, 'job_stamp'
    from raw_captures c
    join jobs j on j.id = c.job_id and j.tenant_id = c.tenant_id
  union all
  select c.tenant_id, c.id, j.customer_id, j.id, v.id, 'visit_stamp'
    from raw_captures c
    join visits v on v.id = c.visit_id and v.tenant_id = c.tenant_id
    join jobs j on j.id = v.job_id and j.tenant_id = v.tenant_id
  union all
  select c.tenant_id, c.id, cu.id, null::uuid, null::uuid, 'created_customer'
    from raw_captures c
    join customers cu on cu.source_capture_id = c.id and cu.tenant_id = c.tenant_id
  union all
  select c.tenant_id, c.id, j.customer_id, j.id, null::uuid, 'created_job'
    from raw_captures c
    join jobs j on j.source_capture_id = c.id and j.tenant_id = c.tenant_id
  union all
  select c.tenant_id, c.id, j.customer_id, j.id, v.id, 'created_visit'
    from raw_captures c
    join visits v on v.source_capture_id = c.id and v.tenant_id = c.tenant_id
    join jobs j on j.id = v.job_id and j.tenant_id = v.tenant_id
  union all
  select c.tenant_id, c.id, cu.id, null::uuid, null::uuid, 'customer_link'
    from raw_captures c
    join customer_captures l on l.capture_id = c.id and l.tenant_id = c.tenant_id
    join customers cu on cu.id = l.customer_id and cu.tenant_id = l.tenant_id
  union all
  select c.tenant_id, c.id, j.customer_id, j.id, null::uuid, 'job_link'
    from raw_captures c
    join job_captures l on l.capture_id = c.id and l.tenant_id = c.tenant_id
    join jobs j on j.id = l.job_id and j.tenant_id = l.tenant_id
  union all
  select c.tenant_id, c.id, j.customer_id, j.id, v.id, 'visit_note'
    from raw_captures c
    join visit_notes l on l.capture_id = c.id and l.tenant_id = c.tenant_id
    join visits v on v.id = l.visit_id and v.tenant_id = l.tenant_id
    join jobs j on j.id = v.job_id and j.tenant_id = v.tenant_id;

-- Not a catalog view: never granted to spine_reader (plan 3 decides what the
-- planner's SQL sees). auto_expose_new_tables would otherwise hand it to the
-- REST roles.
revoke all on capture_membership from anon, authenticated;

-- ---------------------------------------------------------------------------
create or replace function capture_is_live(p_capture uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from raw_captures c
     where c.id = p_capture
       and c.retracts_capture_id is null
       and not exists (select 1 from raw_captures r where r.retracts_capture_id = c.id)
  );
$$;

-- The tier gate. `p_sensitivity is distinct from 'manager_only'` keeps the one
-- existing stamp honoured for technicians (NULL-vs-<> trap: most rows are NULL).
create or replace function capture_visible(p_channel capture_channel, p_sensitivity text, p_tier text)
returns boolean
language sql
immutable
as $$
  select case
    when p_tier in ('manager', 'planner') then true
    when p_tier = 'technician'
      then p_channel in ('technician_voice', 'technician_note', 'technician_photo')
       and p_sensitivity is distinct from 'manager_only'
    else false
  end;
$$;

-- Does the scoped parent exist ON THIS TENANT? A cross-tenant id reads as an
-- unknown scope, never as another firm's captures.
create or replace function capture_scope_found(p_tenant uuid, p_scope text, p_scope_id uuid)
returns boolean
language sql
stable
as $$
  select case p_scope
    when 'job' then exists (select 1 from jobs where id = p_scope_id and tenant_id = p_tenant)
    when 'customer' then exists (select 1 from customers where id = p_scope_id and tenant_id = p_tenant)
    when 'customer_level' then exists (select 1 from customers where id = p_scope_id and tenant_id = p_tenant)
    else false
  end;
$$;

-- The distinct captures of a scope, with every arm they were reached by.
-- 'customer' = the customer's own captures AND every job's; 'customer_level' =
-- the pile with no job membership on any arm (the door knew WHO, not WHICH).
create or replace function capture_scope_members(p_tenant uuid, p_scope text, p_scope_id uuid)
returns table (capture_id uuid, via text[])
language sql
stable
as $$
  select m.capture_id, array_agg(distinct m.via order by m.via)
    from capture_membership m
   where m.tenant_id = p_tenant
     and case p_scope
           when 'job' then m.job_id = p_scope_id
           when 'customer' then m.customer_id = p_scope_id
           when 'customer_level' then m.customer_id = p_scope_id
             and not exists (select 1 from capture_membership m2
                              where m2.tenant_id = p_tenant
                                and m2.capture_id = m.capture_id
                                and m2.job_id is not null)
           else false
         end
   group by m.capture_id;
$$;

-- ---------------------------------------------------------------------------
create or replace function customer_contents(
  p_tenant uuid,
  p_customer uuid,
  p_caller_tier text,
  p_recent_jobs int default 10,
  p_snippet_chars int default 200
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer customers%rowtype;
  v_recent int := greatest(1, least(coalesce(p_recent_jobs, 10), 50));
  v_snip int := greatest(1, least(coalesce(p_snippet_chars, 200), 2000));
  v_jobs_total int;
  v_jobs jsonb;
  v_level jsonb;
  v_retracted jsonb;
begin
  select * into v_customer from customers where id = p_customer and tenant_id = p_tenant;
  if not found then
    return null;
  end if;

  select count(*) into v_jobs_total
    from jobs where customer_id = p_customer and tenant_id = p_tenant;

  -- The jobs block: the p_recent_jobs newest, each with its counts, its newest
  -- visible note's opening, its last completed trip, and its money rows (minus
  -- any that cite a retracted capture — the fold covers money too).
  select coalesce(jsonb_agg(x.job_json order by x.created_at desc, x.id desc), '[]'::jsonb)
    into v_jobs
    from (
      select j.created_at, j.id,
             jsonb_build_object(
               'job', to_jsonb(j),
               'note_count', stats.note_count,
               'restricted_count', stats.restricted_count,
               'last_capture_at', stats.last_capture_at,
               'newest', newest.snip,
               -- A trip MINTED by a since-retracted note goes with the note
               -- (the old recentVisits fold); a booked trip a note merely
               -- reported keeps its place (rung 9b).
               'last_visit_at', (select max(v.completed_at) from visits v
                                  where v.job_id = j.id and v.tenant_id = j.tenant_id
                                    and v.status = 'completed'
                                    and (v.source_capture_id is null or capture_is_live(v.source_capture_id))),
               'money_events', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)
                                  from money_events m
                                 where m.job_id = j.id and m.tenant_id = j.tenant_id
                                   and (m.source_capture_id is null or capture_is_live(m.source_capture_id)))
             ) as job_json
        from (select * from jobs
               where customer_id = p_customer and tenant_id = p_tenant
               order by created_at desc, id desc
               limit v_recent) j
        cross join lateral (
          select count(*) filter (where capture_visible(c.channel, c.sensitivity, p_caller_tier)) as note_count,
                 count(*) filter (where not capture_visible(c.channel, c.sensitivity, p_caller_tier)) as restricted_count,
                 max(c.captured_at) filter (where capture_visible(c.channel, c.sensitivity, p_caller_tier)) as last_capture_at
            from capture_scope_members(p_tenant, 'job', j.id) s
            join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
           where capture_is_live(c.id)
        ) stats
        left join lateral (
          select jsonb_build_object(
                   'id', c.id, 'channel', c.channel, 'captured_at', c.captured_at,
                   'technician_ref', c.technician_ref,
                   'snippet', left(c.raw_text, v_snip),
                   'truncated', coalesce(length(c.raw_text), 0) > v_snip
                 ) as snip
            from capture_scope_members(p_tenant, 'job', j.id) s
            join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
           where capture_is_live(c.id)
             and capture_visible(c.channel, c.sensitivity, p_caller_tier)
           order by c.captured_at desc, c.id desc
           limit 1
        ) newest on true
    ) x;

  -- The customer-level pile.
  with lvl as (
    select c.*
      from capture_scope_members(p_tenant, 'customer_level', p_customer) s
      join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
     where capture_is_live(c.id)
  )
  select jsonb_build_object(
           'note_count', (select count(*) from lvl where capture_visible(channel, sensitivity, p_caller_tier)),
           'restricted_count', (select count(*) from lvl where not capture_visible(channel, sensitivity, p_caller_tier)),
           'newest', (select jsonb_build_object(
                         'id', id, 'channel', channel, 'captured_at', captured_at,
                         'technician_ref', technician_ref,
                         'snippet', left(raw_text, v_snip),
                         'truncated', coalesce(length(raw_text), 0) > v_snip)
                        from lvl
                       where capture_visible(channel, sensitivity, p_caller_tier)
                       order by captured_at desc, id desc
                       limit 1)
         )
    into v_level;

  -- Evidence ids cited by standing facts ({value, sourceCaptureId, recordedAt})
  -- and correspondence entries ({captureId, …}) that have been retracted. Kept
  -- as TEXT; the cast to uuid sits INSIDE a CASE guarded by the uuid regex, so
  -- one malformed seed value cannot fail the whole read (a sibling AND-term
  -- would not do: Postgres promises no evaluation order between WHERE terms).
  -- The TypeScript reader folds with the shared helpers
  -- (foldRetractedFacts / foldRetractedCorrespondence) — one definition.
  with attrs as (
    select v_customer.attributes as attributes
    union all
    select j.attributes from jobs j where j.customer_id = p_customer and j.tenant_id = p_tenant
  ),
  cited as (
    select jsonb_path_query(a.attributes, '$.*.sourceCaptureId') #>> '{}' as v from attrs a
    union all
    select jsonb_path_query(a.attributes, '$.correspondence[*].captureId') #>> '{}' from attrs a
  )
  select coalesce(jsonb_agg(distinct cited.v), '[]'::jsonb)
    into v_retracted
    from cited
   where exists (
           select 1 from raw_captures r
            where r.retracts_capture_id = (
              case when cited.v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                   then cited.v::uuid end));

  return jsonb_build_object(
    'customer', to_jsonb(v_customer),
    'jobs_total', v_jobs_total,
    'older_jobs', greatest(v_jobs_total - jsonb_array_length(v_jobs), 0),
    'jobs', v_jobs,
    'customer_level', v_level,
    'retracted_evidence_ids', v_retracted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- One page. The cursor is (captured_at, id) of the last row served — a TOTAL
-- order, so a page boundary can never repeat or skip a row. p_include_retracted
-- (the manager audit trail) returns retracted captures labelled with their
-- retraction, and the retraction rows themselves, as ordinary rows.
create or replace function captures_page(
  p_tenant uuid,
  p_scope text,
  p_scope_id uuid,
  p_caller_tier text,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit int default 20,
  p_text_chars int default 600,
  p_include_retracted boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_chars int := greatest(1, least(coalesce(p_text_chars, 600), 4000));
  v_rows jsonb;
  v_has_more boolean;
  v_total int;
  v_restricted int;
  v_last jsonb;
begin
  if not capture_scope_found(p_tenant, p_scope, p_scope_id) then
    return jsonb_build_object('scope_found', false, 'captures', '[]'::jsonb, 'has_more', false,
                              'total_visible', 0, 'restricted_count', 0);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'channel', p.channel, 'captured_at', p.captured_at,
           'technician_ref', p.technician_ref, 'via', to_jsonb(p.via),
           'text', left(p.raw_text, v_chars),
           'text_truncated', coalesce(length(p.raw_text), 0) > v_chars,
           'text_chars', coalesce(length(p.raw_text), 0),
           'retracts_capture_id', p.retracts_capture_id,
           'retracted', (select jsonb_build_object('id', r.id, 'reason', r.raw_text,
                                                   'by', r.technician_ref, 'at', r.captured_at)
                           from raw_captures r where r.retracts_capture_id = p.id)
         ) order by p.captured_at desc, p.id desc), '[]'::jsonb)
    into v_rows
    from (
      select c.*, s.via
        from capture_scope_members(p_tenant, p_scope, p_scope_id) s
        join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
       where (p_include_retracted or capture_is_live(c.id))
         and capture_visible(c.channel, c.sensitivity, p_caller_tier)
         and (p_before_at is null
              or (p_before_id is null and c.captured_at < p_before_at)
              or (p_before_id is not null and (c.captured_at, c.id) < (p_before_at, p_before_id)))
       order by c.captured_at desc, c.id desc
       limit v_limit + 1
    ) p;

  v_has_more := jsonb_array_length(v_rows) > v_limit;
  if v_has_more then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(e, n)
     where t.n <= v_limit;
  end if;
  v_last := case when jsonb_array_length(v_rows) > 0 then v_rows -> (jsonb_array_length(v_rows) - 1) end;

  select count(*) filter (where capture_visible(c.channel, c.sensitivity, p_caller_tier)),
         count(*) filter (where not capture_visible(c.channel, c.sensitivity, p_caller_tier))
    into v_total, v_restricted
    from capture_scope_members(p_tenant, p_scope, p_scope_id) s
    join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
   where (p_include_retracted or capture_is_live(c.id));

  return jsonb_build_object(
    'scope_found', true,
    'captures', v_rows,
    'has_more', v_has_more,
    'next_before_at', case when v_has_more then v_last -> 'captured_at' end,
    'next_before_id', case when v_has_more then v_last -> 'id' end,
    'total_visible', v_total,
    'restricted_count', v_restricted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- One capture, full words. No metadata, blob_path or external_id (the
-- v_captures posture: email headers are addresses a seat never needs).
create or replace function capture_full(
  p_tenant uuid,
  p_capture uuid,
  p_caller_tier text,
  p_include_retracted boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v raw_captures%rowtype;
begin
  select * into v from raw_captures where id = p_capture and tenant_id = p_tenant;
  if not found then
    return null;
  end if;
  if not capture_visible(v.channel, v.sensitivity, p_caller_tier) then
    return null;
  end if;
  if not p_include_retracted and not capture_is_live(v.id) then
    return null;
  end if;
  return jsonb_build_object(
    'id', v.id, 'channel', v.channel, 'captured_at', v.captured_at,
    'technician_ref', v.technician_ref, 'raw_text', v.raw_text,
    'retracts_capture_id', v.retracts_capture_id,
    'memberships', (select coalesce(jsonb_agg(jsonb_build_object(
                        'customer_id', m.customer_id, 'job_id', m.job_id,
                        'visit_id', m.visit_id, 'via', m.via) order by m.via), '[]'::jsonb)
                      from capture_membership m
                     where m.capture_id = v.id and m.tenant_id = p_tenant),
    'retracted', (select jsonb_build_object('id', r.id, 'reason', r.raw_text,
                                            'by', r.technician_ref, 'at', r.captured_at)
                    from raw_captures r where r.retracts_capture_id = v.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Keyword search inside a scope: full-text (word forms: "leaking" finds "leak")
-- OR substring (codes and part numbers: "4321"). Scans the scope's rows; a GIN
-- index waits for a measurement that says it is needed.
create or replace function search_captures(
  p_tenant uuid,
  p_scope text,
  p_scope_id uuid,
  p_query text,
  p_caller_tier text,
  p_limit int default 10,
  p_snippet_chars int default 240
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
  v_limit int := greatest(1, least(coalesce(p_limit, 10), 25));
  v_snip int := greatest(1, least(coalesce(p_snippet_chars, 240), 2000));
  v_tsq tsquery;
  v_like text;
  v_rows jsonb;
  v_more boolean;
begin
  if v_q = '' then
    return jsonb_build_object('scope_found', true, 'query', v_q, 'matches', '[]'::jsonb,
                              'count', 0, 'more', false, 'note', 'empty query');
  end if;
  if not capture_scope_found(p_tenant, p_scope, p_scope_id) then
    return jsonb_build_object('scope_found', false, 'query', v_q, 'matches', '[]'::jsonb,
                              'count', 0, 'more', false);
  end if;

  v_tsq := websearch_to_tsquery('english', v_q);
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'channel', p.channel, 'captured_at', p.captured_at,
           'technician_ref', p.technician_ref,
           -- No <b>…</b> markers: the snippet goes to a model, not a browser.
           'snippet', left(ts_headline('english', p.raw_text, v_tsq,
                                       'MaxWords=40,MinWords=20,MaxFragments=1,StartSel="",StopSel=""'), v_snip),
           'rank', p.rank
         ) order by p.rank desc, p.captured_at desc, p.id desc), '[]'::jsonb)
    into v_rows
    from (
      select c.*, ts_rank(to_tsvector('english', c.raw_text), v_tsq) as rank
        from capture_scope_members(p_tenant, p_scope, p_scope_id) s
        join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
       where capture_is_live(c.id)
         and capture_visible(c.channel, c.sensitivity, p_caller_tier)
         and c.raw_text is not null
         and (to_tsvector('english', c.raw_text) @@ v_tsq
              or c.raw_text ilike v_like escape '\')
       order by rank desc, c.captured_at desc, c.id desc
       limit v_limit + 1
    ) p;

  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then
    select coalesce(jsonb_agg(t.e order by t.n), '[]'::jsonb) into v_rows
      from jsonb_array_elements(v_rows) with ordinality as t(e, n)
     where t.n <= v_limit;
  end if;

  return jsonb_build_object(
    'scope_found', true,
    'query', v_q,
    'matches', v_rows,
    'count', jsonb_array_length(v_rows),
    'more', v_more
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Service-role only, by name (see the header). The helpers are plain functions
-- but take a tenant parameter too, so they get the same posture.
revoke all on function capture_is_live(uuid) from public, anon, authenticated;
revoke all on function capture_visible(capture_channel, text, text) from public, anon, authenticated;
revoke all on function capture_scope_found(uuid, text, uuid) from public, anon, authenticated;
revoke all on function capture_scope_members(uuid, text, uuid) from public, anon, authenticated;
revoke all on function customer_contents(uuid, uuid, text, int, int) from public, anon, authenticated;
revoke all on function captures_page(uuid, text, uuid, text, timestamptz, uuid, int, int, boolean) from public, anon, authenticated;
revoke all on function capture_full(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function search_captures(uuid, text, uuid, text, text, int, int) from public, anon, authenticated;
grant execute on function capture_is_live(uuid) to service_role;
grant execute on function capture_visible(capture_channel, text, text) to service_role;
grant execute on function capture_scope_found(uuid, text, uuid) to service_role;
grant execute on function capture_scope_members(uuid, text, uuid) to service_role;
grant execute on function customer_contents(uuid, uuid, text, int, int) to service_role;
grant execute on function captures_page(uuid, text, uuid, text, timestamptz, uuid, int, int, boolean) to service_role;
grant execute on function capture_full(uuid, uuid, text, boolean) to service_role;
grant execute on function search_captures(uuid, text, uuid, text, text, int, int) to service_role;
