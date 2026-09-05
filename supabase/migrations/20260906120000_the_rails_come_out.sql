-- Rung 9a, Phase 3: the rails come out of the schema.
--
-- Drops the promise ladder and the stored window from `assignments`:
--   promise_level, promised_day   — what the customer was told
--   earliest_date, latest_date    — the day range an unplaced visit held
-- plus `promised_day_when_promised` (the CHECK that paired the first two) and
-- the `promise_level` enum type itself.
--
-- WHY (user rulings 2026-09-03 and 2026-09-05): a job's lifecycle stretches and
-- shrinks as humans act, so a commitment frozen in a column is stale the moment
-- the customer calls back. The agent must look for promises where they actually
-- live — the calls, emails and notes in L1 — before it edits the schedule. A
-- visit HAS A TIME OR IT DOES NOT; "sometime next week" is a conversation with
-- the manager's agent, not a data structure.
--
-- `promised_day` was never an independent fact: it was a SHADOW COPY of the
-- window, taken at the moment placement destroyed it, because
-- `assignment_placed_or_windowed` forbade a row being placed and windowed at
-- once. Phase 2 dropped that CHECK (20260906110000). This drops what it forced
-- into existence.
--
-- ────────────────────────────────────────────────────────────────────────────
-- DEPLOY ORDER: **CODE FIRST, THEN THIS MIGRATION.**
--
-- The reverse of this repo's usual rule, and the reverse is what is safe here.
-- The usual rule exists because a deploy runs NO migrations, so code that READS
-- a new column must wait for it. This is a DROP: the code running in the pilot
-- today writes promise_level/earliest_date on every insert, so applying this
-- first would break every booking, move and backfill until the deploy landed.
-- The other order is strictly safe — rung 9a's code never names these columns,
-- so it runs happily against a database that still has them.
--
-- Phase 2's constraint drop (20260906110000) goes the OTHER way: apply it
-- BEFORE this deploy, or with it. Dropping a CHECK only widens what the table
-- accepts, so the old code is happy either way — but the NEW code is not:
-- createAssignment now inserts an untimed visit as starts_at/ends_at NULL with
-- no range, which `assignment_placed_or_windowed` rejects with 23514. Leave
-- 110000 until after the deploy and every untimed booking — this rung's
-- headline feature — errors until it lands.
--
--   20260906110000  BEFORE the deploy (or with it)
--   20260906120000  AFTER the deploy   ← this file
--
-- BOTH Render services must be on the new commit before this file is applied,
-- not just the web service: lifecycle-heart (the cron job) imports the spine
-- tool surface from src/mcp/server.ts, and the code it runs today SELECTs all
-- four columns in src/db/context.ts and src/schedule/boardRead.ts — those
-- PostgREST reads 400 the moment the columns vanish.
--
-- Before deploying, dismiss any OPEN review_items of kind 'pending_booking' or
-- 'pending_visit_move'. Phase 1 deleted those staged kinds, so resolve_review
-- no longer refuses them with "confirm it via book_visit" — it just closes them
-- and reports success. The outcome is correct (the staged intent is void:
-- book_visit is one-shot now and would not honour it), but the wording is
-- misleading. They expire in 15 minutes, so the window is small.
-- ────────────────────────────────────────────────────────────────────────────
--
-- Dropping columns UPDATES NO ROWS, so the append-only triggers on
-- raw_captures / schedule_events / money_events never fire — the trap that
-- `ON DELETE SET NULL` walks into.
--
-- BOTH views select the doomed columns, so both are DROP+CREATE — never
-- `CREATE OR REPLACE`, which raises 42P16 on column removal (precedents:
-- 20260806200000_v_schedule_local_weekday.sql:29, 20260905100000:33). The
-- bodies below are verbatim except for the four deleted lines; column order is
-- otherwise unchanged so every reader keeps its shape.
--
-- NOT TOUCHED, and easy to confuse with these:
--   * `find_slots(earliestDate, latestDate)` — same words, different thing: a
--     SEARCH RANGE ("look between these dates"), never a commitment. It stays.
--   * `no_confirmed_overlap` / `assignments_check` — neither references any
--     dropped column.

drop view if exists v_schedule;
drop view if exists v_cancelled_visits;

alter table assignments drop constraint if exists promised_day_when_promised;

alter table assignments
  drop column if exists promise_level,
  drop column if exists promised_day,
  drop column if exists earliest_date,
  drop column if exists latest_date;

-- Only `assignments` ever used it (checked against pg_attribute), so the type
-- has no remaining dependants once the column is gone.
drop type if exists promise_level;

create view v_schedule as
  select a.id            as assignment_id,
         (a.starts_at at time zone tn.timezone)::date as local_day,
         to_char((a.starts_at at time zone tn.timezone), 'FMDay') as local_weekday,
         a.starts_at,
         a.ends_at,
         a.status,
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

create view v_cancelled_visits as
  select a.id            as assignment_id,
         (a.starts_at at time zone tn.timezone)::date as local_day,
         to_char((a.starts_at at time zone tn.timezone), 'FMDay') as local_weekday,
         a.starts_at,
         a.ends_at,
         a.reason,
         a.updated_at,
         t.ref           as technician_ref,
         t.display_name  as technician_name,
         j.id            as job_id,
         j.title         as job_title,
         j.job_type,
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
     and a.status = 'cancelled';

-- Grants do NOT survive a drop, unlike a replace — re-assert both, and the
-- revoke with them (auto_expose_new_tables grants the publishable keys SELECT
-- on every new entity, views included, unless the migration says otherwise;
-- see the note in 20260901130000_observations.sql).
grant select on v_schedule to spine_reader;
revoke all on v_schedule from anon, authenticated;
grant select on v_cancelled_visits to spine_reader;
revoke all on v_cancelled_visits from anon, authenticated;
