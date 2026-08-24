-- ⑤ Phase 1 review fixes (three of them change what the baseline MEANS):
--
-- 1. mv_whiplash's visit arm now applies the SAME capture filters as the
--    capture arm (join through source_capture_id): a visit whose source
--    capture is manager_only or retracted is invisible to the planner's
--    evidence read, so it must not suppress a whiplash pair. (147/258 pilot
--    captures are manager_only — this undercount was not hypothetical.)
-- 2. Manager handoffs that travel the EXPIRY/serve-cap path (nudge resolved
--    'failed' + a citing review item) are manager handoffs: mv_gap_outcomes
--    buckets them 'manager', and mv_escalation_fates now includes them with
--    handoff_kind ('escalated' = silence path, 'failed' = expiry/cap path).
-- 3. `late` was structurally dead (sweep rows leave escalate_after NULL;
--    planner escalations set it to now(); extends rewrite it to the final
--    deadline the sweep then fires on). Redefined against the ORIGINAL
--    allowance: every gap starts at the code default NUDGE_ESCALATE_HOURS=24
--    (src/jobs/watchers.ts) → late = handed off more than 48h (2x) after the
--    ask. Comment moves with the constant if it ever does.
-- 4. mv_extend_effectiveness gains `pending` (appended column): an extend
--    whose deadline is still in the future on an open gap is not a failure.

create or replace view mv_gap_outcomes as
  select n.tenant_id,
         n.id          as nudge_id,
         n.kind,
         n.asked_at,
         n.resolved_at,
         n.status,
         n.resolution,
         working_hours_between(n.asked_at, n.resolved_at, t.timezone) as working_hours_open,
         case when n.status = 'answered'  then 'answered'
              when n.status = 'escalated'
                or exists (select 1 from review_items i
                            where i.tenant_id = n.tenant_id
                              and i.detail->>'escalatedFromNudge' = n.id::text)
                   then 'manager'
              else 'abandoned' end        as outcome_bucket,
         (n.answered_by_capture_id is not null) as closed_by_technician
    from nudges n
    join tenants t on t.id = n.tenant_id
   where n.status in ('answered', 'escalated', 'cancelled', 'failed');

create or replace view mv_escalation_fates as
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
         coalesce(i.resolved_at is not null
           and working_hours_between(n.resolved_at, i.resolved_at, t.timezone) <= 12, false) as premature,
         (n.asked_at is not null
           and n.resolved_at > n.asked_at + interval '48 hours') as late,
         exists (select 1 from nudge_decisions d
                  where d.nudge_id = n.id and d.action = 'escalate'
                    and d.outcome = 'applied') as by_planner,
         n.status       as handoff_kind
    from nudges n
    join tenants t on t.id = n.tenant_id
    left join review_items i
      on i.tenant_id = n.tenant_id
     and i.detail->>'escalatedFromNudge'
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and i.detail->>'escalatedFromNudge' = n.id::text
   where n.status = 'escalated'
      or (n.status = 'failed'
          and exists (select 1 from review_items i2
                       where i2.tenant_id = n.tenant_id
                         and i2.detail->>'escalatedFromNudge' = n.id::text));

create or replace view mv_whiplash as
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
            join raw_captures vc on vc.id = v.source_capture_id
           where v.tenant_id = r.tenant_id
              and v.job_id = r.job_id
              and v.created_at > r.prev_at and v.created_at < r.decided_at
              and vc.retracts_capture_id is null
              and coalesce(vc.sensitivity, '') <> 'manager_only'
              and not exists (select 1 from raw_captures vr
                               where vr.tenant_id = vc.tenant_id
                                 and vr.retracts_capture_id = vc.id));

create or replace view mv_extend_effectiveness as
  select d.tenant_id, d.nudge_id, d.decided_at as extended_at,
         coalesce(d.escalate_after, n.escalate_after) as extended_to,
         n.status, n.resolved_at,
         (n.status = 'answered'
           and n.resolved_at is not null
           and coalesce(d.escalate_after, n.escalate_after) is not null
           and n.resolved_at <= coalesce(d.escalate_after, n.escalate_after)) as answered_in_time,
         (n.status in ('pending', 'queued', 'asked')
           and coalesce(d.escalate_after, n.escalate_after) > now()) as pending
    from nudge_decisions d
    join nudges n on n.id = d.nudge_id
   where d.action = 'extend' and d.outcome = 'applied';

revoke all on mv_gap_outcomes, mv_escalation_fates, mv_whiplash, mv_extend_effectiveness
  from anon, authenticated;
