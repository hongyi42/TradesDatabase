-- Rung 9c, the other half of the deploy pair: the person comes OFF the visit row.
--
-- ORDER MATTERS, and it is the OPPOSITE of its sibling's (the 9a/9b idiom):
--   20260907100000  BEFORE the deploy — additive. `visits.technician_id` and its
--                   guard survive, so the five still-running Render services
--                   keep booking and moving with no idea participants exist,
--                   and the reconcile trigger keeps the new table true while
--                   they do.
--   20260907100100  AFTER every service is live — this file. Every reader and
--                   writer is on code that asks `visit_participants` who is on
--                   a trip, so the bridge has no callers left.
--
-- BOTH wrong orders, stated out loud:
--   * Applying THIS ONE EARLY 400s every schedule write made by a service still
--     on the old commit (it writes a column that no longer exists) and blanks
--     `technician_ref` on the planner's own view mid-tick.
--   * Applying its SIBLING LATE means the new code writes participants that
--     nothing maintains, and the old guard is the only overlap protection while
--     bookings are already going through the new path.
-- Locally both apply in one `supabase db reset`, which is the point: the end
-- state is the real schema, and no test ever sees the bridge.

-- ── 1. Views first: v_schedule and v_cancelled_visits both read technician_id ─
-- DROP + CREATE, never CREATE OR REPLACE — 42P16 bites the moment a column list
-- changes (precedent: 20260906120000_the_rails_come_out.sql).
--
-- mv_whiplash does NOT reference technician_id (checked via pg_depend: it uses
-- visits.id and visits.job_id only), but it is dropped and recreated VERBATIM
-- anyway: it is defined over `visits`, and a view that merely happens not to
-- touch the dropped column is not a rule anybody can rely on next time.
drop view if exists mv_whiplash;
drop view if exists v_schedule;
drop view if exists v_cancelled_visits;

-- The planner asks this view "what is on the schedule". ONE ROW PER TRIP, with
-- the crew as ARRAYS — never one row per participant. A row per person would
-- make `count(*)` count PEOPLE again, which is exactly the confusion this rung
-- removes: two technicians on one job at one time is one trip, one drive, one
-- thing the customer is waiting for. Join v_visit_participants when the
-- question really is about people.
--
-- The array order is the participant tiebreak (created_at, then technician_id)
-- — the same order src/db/visits.ts's orderParticipants applies, so the agent's
-- SQL and the app's objects name the crew in the same sequence.
create view v_schedule as
  select v.id            as visit_id,
         (v.starts_at at time zone tn.timezone)::date as local_day,
         to_char((v.starts_at at time zone tn.timezone), 'FMDay') as local_weekday,
         v.starts_at,
         v.ends_at,
         v.completed_at,
         v.status,
         -- No 'cancelled' arm: this view is confirmed+completed by definition
         -- (the WHERE below), and a cancelled visit lives in v_cancelled_visits.
         case
           when v.status = 'completed' then
             case when exists (select 1 from visit_notes n where n.visit_id = v.id)
                  then 'reported' else 'happened' end
           when v.starts_at is null then 'committed'
           else 'placed'
         end            as stage,
         (select array_agg(t.ref order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_refs,
         (select array_agg(t.display_name order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_names,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
         j.status        as job_status,
         c.id            as customer_id,
         c.name          as customer_name,
         c.city,
         c.postal_code
    from visits v
    join tenants tn on tn.id = v.tenant_id
    join jobs j     on j.id = v.job_id
    join customers c on c.id = j.customer_id
   where v.tenant_id = current_setting('spine.tenant_id')::uuid
     and v.status in ('confirmed', 'completed');

create view v_cancelled_visits as
  select v.id            as visit_id,
         (v.starts_at at time zone tn.timezone)::date as local_day,
         to_char((v.starts_at at time zone tn.timezone), 'FMDay') as local_weekday,
         v.starts_at,
         v.ends_at,
         v.reason,
         v.updated_at,
         (select array_agg(t.ref order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_refs,
         (select array_agg(t.display_name order by p.created_at, p.technician_id)
            from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and p.tenant_id = v.tenant_id
             and t.tenant_id = v.tenant_id) as technician_names,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
         c.id            as customer_id,
         c.name          as customer_name,
         c.city,
         c.postal_code
    from visits v
    join tenants tn on tn.id = v.tenant_id
    join jobs j     on j.id = v.job_id
    join customers c on c.id = j.customer_id
   where v.tenant_id = current_setting('spine.tenant_id')::uuid
     and v.status = 'cancelled';

-- ONE ROW PER PERSON PER TRIP — the join table the planner needs when the
-- question is about people ("how many visits did Ben go on last week").
--
-- TWO walls, and both are load-bearing (the v_visit_notes shape):
--   * the GUC scopes the participant rows to the caller's tenant;
--   * `p.tenant_id = v.tenant_id` re-checks the trip, because visit_id is an
--     ID-ONLY foreign key and nothing in the schema makes a link's trip share
--     its tenant. Every other reader re-checks that in TypeScript; the planner
--     writes raw SQL and cannot, so the wall has to be here.
create view v_visit_participants as
  select p.visit_id,
         t.ref          as technician_ref,
         t.display_name as technician_name,
         p.created_at,
         v.job_id,
         v.starts_at,
         v.status
    from visit_participants p
    join visits v on v.id = p.visit_id
    join technicians t on t.id = p.technician_id
   where p.tenant_id = current_setting('spine.tenant_id')::uuid
     and v.tenant_id = p.tenant_id
     and t.tenant_id = p.tenant_id;

-- mv_whiplash, verbatim from 20260906140000 (which took it verbatim from
-- 20260903120000_decisions_without_a_gap.sql).
create view mv_whiplash as
  with real_decisions as (
    select d.tenant_id,
           coalesce(d.nudge_id, d.observation_id) as nudge_id,
           d.job_id, d.action, d.decided_at,
           lag(d.action)     over w as prev_action,
           lag(d.decided_at) over w as prev_at
      from nudge_decisions d
     where d.action not in ('unmentioned', 'leave')
       and d.outcome in ('applied', 'shadow')
       and coalesce(d.nudge_id, d.observation_id) is not null
    window w as (partition by d.tenant_id, coalesce(d.nudge_id, d.observation_id)
                 order by d.decided_at)
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
           select 1 from visit_notes n
            join visits v on v.id = n.visit_id
            join raw_captures vc on vc.id = n.capture_id
           where n.tenant_id = r.tenant_id
              and v.job_id = r.job_id
              and n.created_at > r.prev_at and n.created_at < r.decided_at
              and vc.retracts_capture_id is null
              and coalesce(vc.sensitivity, '') <> 'manager_only'
              and not exists (select 1 from raw_captures vr
                               where vr.tenant_id = vc.tenant_id
                                 and vr.retracts_capture_id = vc.id));

-- Grants do NOT survive a drop, unlike a replace — re-assert them, and the
-- revoke with them (auto_expose_new_tables grants the publishable keys SELECT
-- on every new entity, views included, unless the migration says otherwise).
grant select on v_schedule to spine_reader;
revoke all on v_schedule from anon, authenticated;
grant select on v_cancelled_visits to spine_reader;
revoke all on v_cancelled_visits from anon, authenticated;
grant select on v_visit_participants to spine_reader;
revoke all on v_visit_participants from anon, authenticated;
revoke all on mv_whiplash from anon, authenticated;

-- ── 2. The trigger loses its bridge arm ──────────────────────────────────────
-- Arm (1) existed to turn `visits.technician_id` into participant #1 while old
-- code was still writing it. There is no such code and no such column now. Arm
-- (2) — the times and status following the trip — is permanent: it is the whole
-- reason a participant row knows WHEN, and therefore the reason the exclusion
-- constraint can live on it at all.
create or replace function visits_reconcile_participants()
returns trigger
language plpgsql
as $$
begin
  update visit_participants p
     set starts_at = new.starts_at,
         ends_at   = new.ends_at,
         status    = new.status
   where p.visit_id = new.id
     and (p.starts_at is distinct from new.starts_at
       or p.ends_at   is distinct from new.ends_at
       or p.status    is distinct from new.status);
  return null;
end;
$$;

-- The trigger no longer needs to fire on technician_id — there is no such
-- column. DROP + CREATE, because `create trigger` cannot change the column list.
drop trigger if exists visits_participants_after on visits;
create trigger visits_participants_after
  after insert or update of starts_at, ends_at, status on visits
  for each row execute function visits_reconcile_participants();

-- ── 3. The column, its guard and its index ───────────────────────────────────
-- `no_confirmed_overlap` is dropped, not weakened: the identical predicate now
-- lives on visit_participants as `no_confirmed_overlap_participant`, where the
-- row knows both WHO and WHEN. Dropping the column would take the constraint
-- and the index with it, but naming them makes the intent reviewable.
alter table visits drop constraint if exists no_confirmed_overlap;
drop index if exists idx_visits_technician;
alter table visits drop column if exists technician_id;
