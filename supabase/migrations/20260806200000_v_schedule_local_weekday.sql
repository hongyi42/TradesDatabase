-- v_schedule gains local_weekday, for the same reason it already has local_day:
-- a value the model would otherwise have to work out, and gets wrong.
--
-- Caught live 2026-08-06. Asked "how many visits did Joy do this week?", the
-- agent did everything right — resolve_date {week:0} first, its boundaries pasted
-- into the SQL, 22 visits, verified correct — and then said:
--
--   "running from Monday the 4th through Saturday the 8th"
--
-- August 4th is a TUESDAY. The count was right, which is what makes it dangerous:
-- nothing about the answer looks suspicious.
--
-- The cause is a gap I left. local_day comes back as a bare date ('2026-08-04'),
-- the view carries no weekday, and §0f requires the agent to state the weekday
-- whenever it names a date. Given no weekday to read, it computed one. That is
-- precisely the arithmetic §0f exists to forbid, reached through a door the rule
-- did not cover — the third instance of that pattern in three days (tool search
-- hid resolve_date; SQL bypassed it; now a view hands over a bare date).
--
-- Same remedy as local_day: put the correct answer in the database, so there is
-- nothing left to derive. 'FMDay' suppresses Postgres's blank-padding, which
-- would otherwise render "Tuesday  " with trailing spaces.
--
-- DROP + CREATE rather than CREATE OR REPLACE: the latter may only APPEND
-- columns (42P16, "cannot change name of view column"), and local_weekday belongs
-- beside local_day, not stranded at the end. Migrations run in a transaction, so
-- the view never actually disappears for a reader. Nothing depends on this view,
-- so no CASCADE.
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

-- CREATE OR REPLACE VIEW preserves grants, but re-granting is cheap and makes
-- this migration safe to run against a database where the view was dropped and
-- rebuilt rather than replaced.
grant select on v_schedule to spine_reader;
