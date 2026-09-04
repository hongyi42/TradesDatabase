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
-- DEPLOY ORDER: **CODE FIRST, THEN THIS MIGRATION** — the reverse of this repo's
-- usual rule, and the reverse is what is safe here. The rule exists because a
-- deploy runs no migrations, so a code change that READS a new column must wait
-- for it. This is a DROP: the code still running in the pilot writes
-- `locked: input.locked ?? false` on every insert (`createAssignment`), so
-- applying this first would break every book / move / backfill until the deploy
-- landed. The other order is strictly safe: the column keeps its
-- `not null default false`, so rung 8's code — which never names it — runs
-- happily against a database that still has it.
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

-- CLOSE THE SOLVER'S ORPHANED STAGED TOKENS. `pending_freeze` / `pending_resolve`
-- / `pending_undo` rows each embed a WHOLE staged plan, and `review_items.kind`
-- is free text with no CHECK, so nothing stops an old open one surviving. Left
-- open they are actively harmful, not merely stale: `list_pending_reviews` no
-- longer summarizes them (the summarizer died with the verbs), so one would dump
-- its entire plan into the agent's context, and `resolve_review` would now accept
-- `resolved` on it — the STAGED_ACTION_KINDS guard that refused exactly that is
-- gone too. There is no tool left to confirm them with, so dismissed is the only
-- honest end. review_items is mutable (no append-only trigger), unlike
-- schedule_events, whose historic freeze rows correctly stay.
update review_items
   set status = 'dismissed',
       resolution = 'the freeze was removed (rung 8) — this plan can no longer be confirmed',
       resolved_at = now()
 where kind in ('pending_freeze', 'pending_resolve', 'pending_undo')
   and status = 'open';
