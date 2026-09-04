-- Rung 8, Phase 2: pinning dies with the solver.
--
-- `assignments.locked` meant exactly one thing — "automatic scheduling must not
-- touch this visit" — and automatic scheduling no longer exists (Phase 1 deleted
-- run_freeze / run_resolve / undo_run and the five modules behind them). Its only
-- readers were the solver's constraint checks and display code; nothing gated on
-- it. An always-false column that the model is SHOWN in the v_schedule catalog,
-- for a concept the doctrine no longer teaches, is the learnability cost the
-- scheduling remodel exists to remove (user ruling 2026-09-03, §6a rung 8).
--
-- DEPLOY ORDER: apply BEFORE deploying the code. Deploys run no migrations, and
-- the code stops selecting `locked` the moment rung 8 ships.
--
-- DROP + CREATE, not CREATE OR REPLACE: replace cannot change a view's column
-- list (42P16 bites on removals, not body changes — see the note in
-- 20260812110000), so removing a column needs the view rebuilt. Precedent:
-- 20260806200000_v_schedule_local_weekday.sql:29 did exactly this to ADD one.
--
-- The body below is 20260812110000's verbatim, minus the `a.locked,` line;
-- column order is otherwise unchanged so every reader keeps its shape.
--
-- v_cancelled_visits does NOT select `locked` (checked), so it needs no rebuild
-- and its grant is untouched. `no_confirmed_overlap` and
-- `assignment_placed_or_windowed` do not reference the column either — dropping
-- it leaves both constraints exactly as they were.
drop view if exists v_schedule;

create view v_schedule as
  select a.id            as assignment_id,
         (a.starts_at at time zone tn.timezone)::date as local_day,
         to_char((a.starts_at at time zone tn.timezone), 'FMDay') as local_weekday,
         a.starts_at,
         a.ends_at,
         a.status,
         a.promise_level,
         a.promised_day,
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
   where a.tenant_id = current_setting('spine.tenant_id')::uuid
     and a.status in ('confirmed', 'completed');

-- The grant does NOT survive a drop, unlike a replace — re-assert it, and the
-- revoke with it (auto_expose_new_tables grants the publishable keys SELECT on
-- every new entity, views included, unless the migration says otherwise; see
-- the note in 20260901130000_observations.sql).
grant select on v_schedule to spine_reader;
revoke all on v_schedule from anon, authenticated;

alter table assignments drop column locked;
