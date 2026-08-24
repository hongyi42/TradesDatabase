-- ⑤ memory architecture, Phase 1 (plan 2026-08-23): the planner's baseline
-- metrics — operator telemetry, computed from tables that already exist.
--
-- These views are DELIBERATELY NOT in SPINE_VIEW_CATALOG and get NO
-- spine_reader grant: the catalog is shared with the manager's query_spine,
-- and planner telemetry is operator-facing. Views cannot carry RLS and have
-- no GUC fail-closed guard, so without the revokes below they would be a
-- cross-tenant PostgREST read surface on the publishable key (the recorded
-- query_spine-ACL failure class, 2026-08-06). The revokes ARE the mechanism;
-- querySpine.test.ts-style ACL assertions pin them.
--
-- Working hours, pinned ONE way (plan Decision): overlap with the 7am-7pm
-- firm-local ask window, computed from REAL-UTC columns + tenants.timezone
-- via `at time zone` — never from naive-local context values. "Within one
-- working day" = <= 12 working hours.

create function working_hours_between(from_ts timestamptz, to_ts timestamptz, tz text)
returns numeric
language sql stable
as $$
  select case
    when from_ts is null or to_ts is null or to_ts <= from_ts then null
    else coalesce((
      select round((sum(
        greatest(0::numeric, extract(epoch from (
          least(d + interval '19 hours', to_ts at time zone tz)
          - greatest(d + interval '7 hours', from_ts at time zone tz)
        ))::numeric / 3600.0)
      ))::numeric, 2)
      from generate_series(
        date_trunc('day', from_ts at time zone tz),
        date_trunc('day', to_ts at time zone tz),
        interval '1 day'
      ) as d
    ), 0)
  end
$$;

-- Per closed gap: how it ended and how long it stayed open in working hours.
create view mv_gap_outcomes as
  select n.tenant_id,
         n.id          as nudge_id,
         n.kind,
         n.asked_at,
         n.resolved_at,
         n.status,
         n.resolution,
         working_hours_between(n.asked_at, n.resolved_at, t.timezone) as working_hours_open,
         case when n.status = 'answered'  then 'answered'
              when n.status = 'escalated' then 'manager'
              else 'abandoned' end        as outcome_bucket,
         (n.answered_by_capture_id is not null) as closed_by_technician
    from nudges n
    join tenants t on t.id = n.tenant_id
   where n.status in ('answered', 'escalated', 'cancelled', 'failed');

-- Per ESCALATED gap (sweep- or planner-driven; the sweep writes no decision
-- row, so this anchors on the nudge): what the manager's queue did with it.
-- The review-item link is detail->>'escalatedFromNudge' — a JSONB key, NOT a
-- column — joined as TEXT behind the v_review_items regex-guard idiom (a bare
-- ::uuid cast over one malformed value kills the whole query).
-- premature = the item resolved/dismissed within 12 working hours of the
-- escalation (both live specimens of 2026-08-23 land here); late = the
-- escalation fired after 2x the gap's own escalate_after allowance.
create view mv_escalation_fates as
  select n.tenant_id,
         n.id           as nudge_id,
         n.kind,
         n.resolved_at  as escalated_at,
         i.id           as item_id,
         case when i.id is null then 'no_item'
              when i.status = 'open' then 'still_open'
              else i.status::text end as fate,
         i.resolution,
         i.resolved_at  as item_resolved_at,
         working_hours_between(n.resolved_at, i.resolved_at, t.timezone) as working_hours_to_fate,
         (i.resolved_at is not null
           and working_hours_between(n.resolved_at, i.resolved_at, t.timezone) <= 12) as premature,
         (n.escalate_after is not null and n.asked_at is not null
           and n.resolved_at > n.escalate_after + (n.escalate_after - n.asked_at)) as late,
         exists (select 1 from nudge_decisions d
                  where d.nudge_id = n.id and d.action = 'escalate'
                    and d.outcome = 'applied') as by_planner
    from nudges n
    join tenants t on t.id = n.tenant_id
    left join review_items i
      on i.tenant_id = n.tenant_id
     and i.detail->>'escalatedFromNudge'
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and i.detail->>'escalatedFromNudge' = n.id::text
   where n.status = 'escalated';

-- Consecutive REAL decisions on one gap whose verb flipped with no new
-- evidence in between. Evidence mirrors the planner's own read
-- (listJobEvidenceSince): a job-stamped capture that is neither a retraction,
-- retracted, nor manager_only — OR a visit minted on the job from a capture.
-- 'unmentioned' is filler and 'leave' is watching, not a position — neither
-- side of a flip. Pairs with no job link are excluded (evidence unjudgeable).
create view mv_whiplash as
  with real_decisions as (
    select d.tenant_id, d.nudge_id, d.job_id, d.action, d.decided_at,
           lag(d.action)     over w as prev_action,
           lag(d.decided_at) over w as prev_at
      from nudge_decisions d
     where d.action not in ('unmentioned', 'leave')
       and d.outcome in ('applied', 'shadow')
    window w as (partition by d.tenant_id, d.nudge_id order by d.decided_at)
  )
  select r.tenant_id, r.nudge_id, r.job_id,
         r.prev_action, r.action,
         r.prev_at, r.decided_at,
         round((extract(epoch from (r.decided_at - r.prev_at)) / 3600.0)::numeric, 2)
           as hours_between
    from real_decisions r
   where r.prev_action is not null
     and r.prev_action <> r.action
     and r.job_id is not null
     and not exists (
           select 1 from raw_captures rc
            where rc.tenant_id = r.tenant_id
              and rc.job_id = r.job_id
              and rc.captured_at > r.prev_at and rc.captured_at < r.decided_at
              and rc.retracts_capture_id is null
              and coalesce(rc.sensitivity, '') <> 'manager_only'
              and not exists (select 1 from raw_captures rr
                               where rr.tenant_id = rc.tenant_id
                                 and rr.retracts_capture_id = rc.id))
     and not exists (
           select 1 from visits v
            where v.tenant_id = r.tenant_id
              and v.job_id = r.job_id
              and v.source_capture_id is not null
              and v.created_at > r.prev_at and v.created_at < r.decided_at);

-- Extends that WORKED: the gap was answered before the extended deadline.
-- The deadline is the decision's own escalate_after (its first-ever reader),
-- falling back to the nudge's current one.
create view mv_extend_effectiveness as
  select d.tenant_id, d.nudge_id, d.decided_at as extended_at,
         coalesce(d.escalate_after, n.escalate_after) as extended_to,
         n.status, n.resolved_at,
         (n.status = 'answered'
           and n.resolved_at is not null
           and coalesce(d.escalate_after, n.escalate_after) is not null
           and n.resolved_at <= coalesce(d.escalate_after, n.escalate_after)) as answered_in_time
    from nudge_decisions d
    join nudges n on n.id = d.nudge_id
   where d.action = 'extend' and d.outcome = 'applied';

-- The mechanism, not politeness (see header).
revoke all on mv_gap_outcomes, mv_escalation_fates, mv_whiplash, mv_extend_effectiveness
  from anon, authenticated;
revoke all on function working_hours_between(timestamptz, timestamptz, text)
  from anon, authenticated, public;
