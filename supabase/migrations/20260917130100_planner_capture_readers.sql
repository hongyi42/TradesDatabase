-- The retrieval layer, plan 3 Phase 2: the planner's and the watcher's readers
-- move onto the membership
-- (thoughts/shared/plans/2026-09-15-the-retrieval-layer-3-the-planner-and-the-sql-views.md).
--
-- Plan 1 (20260916120000) gave the seat tools ONE definition of "a job's
-- captures" (capture_membership), of "retracted" (capture_is_live) and of "may
-- this tier see it" (capture_visible). The planner and the watcher still walked
-- eleven hand-written PostgREST queries of their own, in three readers that
-- disagreed with it: the planner's evidence dropped manager_only rows the planner
-- is ruled to read, the watcher counted a retracted note as the technician's
-- report, the moot-fact read had no tenant filter at all, and every one shipped
-- its id list in a URL that PostgREST's gateway refuses past ~205 UUIDs.
--
-- Three functions, each taking its ids in the request BODY (no URL wall) and
-- returning ONE jsonb value (no silent 1000-row clamp). Service-role only, by
-- name, the plan-1 posture.
--
--   gap_evidence        per planner gap: its job's newest live captures since
--                       the gap's own floor, plus the exact total — so "N
--                       earlier notes not shown" is a true number.
--   job_activity_since  per job: when anything live last landed on it (the
--                       watcher's "was this visit reported" probe).
--   capture_records     per capture: what was created from it or filed it
--                       (the planner's moot fact for inbound asks), and which
--                       of those captures have been retracted.

-- ---------------------------------------------------------------------------
-- p_asks: [{"gap_id": "<id>", "job_id": "<uuid>", "since": "<iso instant>"}, …]
-- One entry out per ask, in input order. The floor is STRICT (captured_at >
-- since), the same comparison buildGapView applies. Visible = the PLANNER tier,
-- which sees everything (operator rulings 2026-08-23 and 2026-09-15).
create or replace function gap_evidence(
  p_tenant uuid,
  p_asks jsonb,
  p_per_gap int default 6,
  p_text_chars int default 2400
)
returns jsonb
language plpgsql
security definer
-- pg_temp LAST so a temp object cannot shadow a public one for this function
-- (20260806120000's posture; unnamed, pg_temp is searched FIRST).
set search_path = public, pg_temp
stable
as $$
declare
  v_per int := greatest(1, least(coalesce(p_per_gap, 6), 20));
  v_chars int := greatest(1, least(coalesce(p_text_chars, 2400), 8000));
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'gap_id', a.gap_id,
             'job_id', a.job_id,
             'total', e.total,
             'captures', e.captures
           ) order by a.ord), '[]'::jsonb)
      from (
        select t.x ->> 'gap_id' as gap_id,
               -- The uuid cast sits INSIDE a CASE guarded by the uuid regex (the
               -- plan-1 idiom): one malformed id must not fail the whole read.
               case when t.x ->> 'job_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (t.x ->> 'job_id')::uuid end as job_id,
               (t.x ->> 'since')::timestamptz as since,
               t.ord
          from jsonb_array_elements(
                 case when jsonb_typeof(p_asks) = 'array' then p_asks else '[]'::jsonb end
               ) with ordinality as t(x, ord)
      ) a
      cross join lateral (
        select count(*)::int as total,
               coalesce(jsonb_agg(jsonb_build_object(
                 'id', q.id,
                 'channel', q.channel,
                 'captured_at', q.captured_at,
                 'technician_ref', q.technician_ref,
                 'text', left(q.raw_text, v_chars),
                 'text_chars', coalesce(length(q.raw_text), 0),
                 'via', q.via
               ) order by q.captured_at, q.id) filter (where q.rn <= v_per), '[]'::jsonb) as captures
          from (
            select c.id, c.channel, c.captured_at, c.technician_ref, c.raw_text,
                   array_to_string(s.via, ',') as via,
                   row_number() over (order by c.captured_at desc, c.id desc) as rn
              from capture_scope_members(p_tenant, 'job', a.job_id) s
              join raw_captures c on c.id = s.capture_id and c.tenant_id = p_tenant
             where a.job_id is not null
               and a.since is not null
               and c.captured_at > a.since
               and capture_is_live(c.id)
               and capture_visible(c.channel, c.sensitivity, 'planner')
          ) q
      ) e
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- {"<job id>": "<latest captured_at>"} for the jobs with a live capture at or
-- after p_since (inclusive, as the watcher's floor always was). Every job arm of
-- the membership counts, by the CAPTURE's own time — so a retracted note is no
-- longer a report, and a note reached only through a link is.
create or replace function job_activity_since(
  p_tenant uuid,
  p_job_ids uuid[],
  p_since timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp -- see gap_evidence
stable
as $$
begin
  return (
    select coalesce(jsonb_object_agg(x.job_id::text, x.latest), '{}'::jsonb)
      from (
        select m.job_id, max(c.captured_at) as latest
          from capture_membership m
          join raw_captures c on c.id = m.capture_id and c.tenant_id = m.tenant_id
         where m.tenant_id = p_tenant
           and m.job_id = any(coalesce(p_job_ids, '{}'::uuid[]))
           and c.captured_at >= p_since
           and capture_is_live(c.id)
         group by m.job_id
      ) x
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- What was created from these captures, or filed them: the membership arms
-- created_customer / created_job / created_visit / job_link / visit_note, this
-- tenant only. A CANCELLED job or trip is not an answer (bookVisit rolls back a
-- shell it minted by cancelling it, and the stamp stays) — the rules the old
-- listL2CitingCapture applied per table. NOT retraction-folded: a row created
-- from a since-retracted call still exists, and "was anything created" is a
-- question about the rows. `retracted` names which of the input captures have
-- been retracted, so the planner can say so instead of quoting them.
create or replace function capture_records(
  p_tenant uuid,
  p_capture_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp -- see gap_evidence
stable
as $$
begin
  return jsonb_build_object(
    'records', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'capture_id', m.capture_id,
               'via', m.via,
               'customer_id', m.customer_id,
               'job_id', m.job_id,
               'visit_id', m.visit_id
             ) order by m.capture_id, m.via, m.job_id, m.visit_id, m.customer_id), '[]'::jsonb)
        from capture_membership m
        left join jobs j on j.id = m.job_id and j.tenant_id = m.tenant_id
        left join visits v on v.id = m.visit_id and v.tenant_id = m.tenant_id
       where m.tenant_id = p_tenant
         and m.capture_id = any(coalesce(p_capture_ids, '{}'::uuid[]))
         and m.via in ('created_customer', 'created_job', 'created_visit', 'job_link', 'visit_note')
         and not (m.via in ('created_job', 'job_link') and j.status = 'cancelled')
         and not (m.via in ('created_visit', 'visit_note') and v.status = 'cancelled')
    ),
    'retracted', (
      select coalesce(jsonb_agg(c.id order by c.id), '[]'::jsonb)
        from raw_captures c
       where c.tenant_id = p_tenant
         and c.id = any(coalesce(p_capture_ids, '{}'::uuid[]))
         and exists (select 1 from raw_captures r where r.retracts_capture_id = c.id)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
revoke all on function gap_evidence(uuid, jsonb, int, int) from public, anon, authenticated;
revoke all on function job_activity_since(uuid, uuid[], timestamptz) from public, anon, authenticated;
revoke all on function capture_records(uuid, uuid[]) from public, anon, authenticated;
grant execute on function gap_evidence(uuid, jsonb, int, int) to service_role;
grant execute on function job_activity_since(uuid, uuid[], timestamptz) to service_role;
grant execute on function capture_records(uuid, uuid[]) to service_role;
