-- Rung 9b — THE VISIT IS ONE OBJECT.
--
-- Two tables meant "visit" and nothing joined them:
--   * assignments — the schedule. Every *_visit tool writes here. Real technician
--     FK, lifecycle enum, exclusion constraint, and the only table schedule_events
--     points at.
--   * visits      — ONE ROW PER FIELD NOTE (recordFieldNote minted one every time),
--     never scheduled, `scheduled_at` never set by anything.
--
-- After this migration there is ONE `visits` table with the lifecycle
-- committed → placed → happened → reported, and a `visit_notes` link table
-- carrying which L1 capture reported which trip.
--
-- WHY A RENAME AND NOT A COPY (probed 2026-09-05 on the local stack, all rolled
-- back — do not re-derive):
--   * `ON DELETE SET NULL` on raw_captures.visit_id and schedule_events.assignment_id
--     TRIPS raise_append_only — Postgres implements it as an UPDATE, which the
--     append-only trigger refuses. So the 288 event-linked schedule rows can be
--     neither deleted nor moved to a new table.
--   * `DROP TABLE ... CASCADE` does NOT trip it: it drops the FK constraint, and
--     leaves the referencing rows (and their now-dangling column values) alone.
--   * `ALTER TABLE ... RENAME` keeps every FK pointing at the renamed table and
--     fires no trigger at all.
-- A rename therefore keeps every id, all of schedule_events, and every
-- subject_ref in nudges/observations/review_items valid — which a copy could not.
--
-- The 20 per-note `visits` rows are DROPPED (user, 2026-09-05: "all of the data
-- that exists in the pilot right now is test and seeded anyways"). Their notes
-- remain in L1 untouched; nothing is deleted from raw_captures.
--
-- schedule_events.assignment_id KEEPS ITS NAME this rung. It is an append-only
-- table and a column has no compatibility bridge, so renaming it would 400 every
-- schedule write made by the still-running old code between this migration and
-- the deploy. The TypeScript layer says `visitId` and maps onto the old column.

-- ── 1. Views first: they depend on both tables ───────────────────────────────
-- DROP + CREATE, never CREATE OR REPLACE — 42P16 bites when a column list
-- changes (precedent: 20260906120000_the_rails_come_out.sql).
drop view if exists mv_whiplash;
drop view if exists v_visits;
drop view if exists v_schedule;
drop view if exists v_cancelled_visits;

-- ── 2. The per-note table goes ───────────────────────────────────────────────
-- CASCADE drops raw_captures_visit_id_fkey. The raw_captures.visit_id COLUMN
-- survives with its values (retractions copy it), and is re-pointed in step 5.
drop table if exists visits cascade;

-- ── 3. The schedule becomes `visits` ─────────────────────────────────────────
alter table assignments rename to visits;
alter type assignment_status rename to visit_status;

alter index assignments_pkey              rename to visits_pkey;
alter index idx_assignments_job           rename to idx_visits_job;
alter index idx_assignments_tenant        rename to idx_visits_tenant;
alter index idx_assignments_technician    rename to idx_visits_technician;

alter table visits rename constraint assignments_check                  to visits_check;
alter table visits rename constraint assignments_job_id_fkey            to visits_job_id_fkey;
alter table visits rename constraint assignments_tenant_id_fkey         to visits_tenant_id_fkey;
alter table visits rename constraint assignments_technician_id_fkey     to visits_technician_id_fkey;
alter table visits rename constraint assignments_source_capture_id_fkey to visits_source_capture_id_fkey;

alter trigger assignments_set_updated_at on visits rename to visits_set_updated_at;

-- no_confirmed_overlap keeps its name: it is referred to by that name in
-- isOverlapViolation's comment, the schema test, and three migrations.

-- ── 4. The happened-stage columns the old table had ──────────────────────────
alter table visits
  add column started_at   timestamptz,
  add column completed_at timestamptz,
  add column labor_hours  numeric,
  add column attributes   jsonb not null default '{}'::jsonb;

comment on column visits.completed_at is
  'When the trip happened. NAIVE-LOCAL like starts_at/ends_at — the +00 is a lie (firm wall clock). Never compare it to a real UTC instant without converting first.';

-- Backfill: a row already 'completed' happened at its scheduled end. Rows with
-- no end (untimed) fall back to updated_at, converted INTO the naive-local
-- convention so the column has exactly one meaning.
update visits v
   set completed_at = coalesce(
         v.ends_at,
         ((v.updated_at at time zone tn.timezone)::timestamp) at time zone 'UTC'
       )
  from tenants tn
 where tn.id = v.tenant_id
   and v.status = 'completed'
   and v.completed_at is null;

-- NO "completed implies completed_at" CHECK, deliberately (learned from the
-- suite, rung 9b): the caller that COMPLETES a visit usually knows only that it
-- finished — the cancel_job cascade, the status machine's legal walk, and every
-- eval seeder all advance status without a time, and completed_at is naive-local
-- so they could not compute one without the tenant's timezone anyway. The stage
-- is derived from `status`; completed_at is detail we fill when a note tells us
-- when. A constraint that forces knowledge nobody has is a constraint that gets
-- worked around.

-- ── 5. Re-point L1's visit_id at the surviving table ─────────────────────────
-- Both the local stack and the pilot have ZERO raw_captures rows with a
-- visit_id, so no value is dangling. If a future database has some, this ADD
-- fails loudly — which is correct: raw_captures is append-only, so the values
-- cannot be nulled, and a human must decide.
alter table raw_captures add constraint raw_captures_visit_id_fkey
  foreign key (visit_id) references visits(id) on delete set null;

-- ── 6. visit_notes — which capture reported which trip ───────────────────────
-- WHY A TABLE AND NOT A COLUMN ON raw_captures: the L1 row is inserted BEFORE
-- the visit is resolved (every recordFieldNote caller hands in an existing
-- captureId), and L1 can never be updated afterwards. So the link has to live
-- somewhere writable, and one visit takes many notes.
create table visit_notes (
  tenant_id  uuid not null references tenants(id),
  visit_id   uuid not null references visits(id) on delete cascade,
  capture_id uuid not null references raw_captures(id),
  created_at timestamptz not null default now(),
  primary key (visit_id, capture_id)
);

create index idx_visit_notes_capture on visit_notes(capture_id);
create index idx_visit_notes_tenant_visit on visit_notes(tenant_id, visit_id);

-- APPEND-ONLY ON UPDATE ONLY, deliberately — not "update or delete" like
-- raw_captures. A link, once made, is never silently re-pointed at a different
-- trip. But blocking DELETE would make an L2 row undeletable the moment a note
-- touched it (`on delete cascade` above would raise instead of cascading) —
-- exactly the "L1 pins L2" trap this rung exists to escape, and the reason the
-- schedule had to be renamed rather than copied. The evidence itself is
-- untouched by a delete here: the capture stays in raw_captures forever.
create trigger visit_notes_append_only
  before update on visit_notes
  for each row execute function raise_append_only();

revoke all on visit_notes from anon, authenticated;

-- ── 7. The read surface ──────────────────────────────────────────────────────
-- v_schedule gains `stage` — the lifecycle as one word, so the planner can ask
-- "what is committed but not placed" in plain SQL instead of deriving it from a
-- status/starts_at pair it has to be taught. stageOf() in src/db/visits.ts is
-- the same case expression; a db test pins them equal.
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
         -- An arm that can never fire would tell a reader `stage='cancelled'`
         -- is a thing to query here, and it would always return nothing.
         case
           when v.status = 'completed' then
             case when exists (select 1 from visit_notes n where n.visit_id = v.id)
                  then 'reported' else 'happened' end
           when v.starts_at is null then 'committed'
           else 'placed'
         end            as stage,
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
    from visits v
    join tenants tn on tn.id = v.tenant_id
    join jobs j     on j.id = v.job_id
    join customers c on c.id = j.customer_id
    left join technicians t on t.id = v.technician_id
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
         t.ref           as technician_ref,
         t.display_name  as technician_name,
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
    left join technicians t on t.id = v.technician_id
   where v.tenant_id = current_setting('spine.tenant_id')::uuid
     and v.status = 'cancelled';

-- Replaces v_visits, whose whole job was bridging a note to its job. The bridge
-- is now explicit: join v_visit_notes.capture_id to v_captures.id.
create view v_visit_notes as
  select n.visit_id,
         n.capture_id,
         v.job_id,
         n.created_at
    from visit_notes n
    join visits v on v.id = n.visit_id
   where n.tenant_id = current_setting('spine.tenant_id')::uuid
     -- visit_notes.visit_id is an ID-ONLY foreign key: nothing in the schema
     -- makes the trip share the link's tenant. Every other reader re-checks in
     -- TypeScript, but this view's consumer is the planner writing raw SQL and
     -- it cannot — so the wall has to be here.
     and v.tenant_id = n.tenant_id;

-- mv_whiplash, verbatim from 20260903120000_decisions_without_a_gap.sql except
-- its visit arm: "a visit row was minted in the window" becomes "a note was
-- LINKED in the window", which is the same signal now that a visit row is a
-- trip rather than a note.
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

-- Grants do NOT survive a drop, unlike a replace — re-assert both, and the
-- revoke with them (auto_expose_new_tables grants the publishable keys SELECT
-- on every new entity, views included, unless the migration says otherwise).
grant select on v_schedule to spine_reader;
revoke all on v_schedule from anon, authenticated;
grant select on v_cancelled_visits to spine_reader;
revoke all on v_cancelled_visits from anon, authenticated;
grant select on v_visit_notes to spine_reader;
revoke all on v_visit_notes from anon, authenticated;
revoke all on mv_whiplash from anon, authenticated;

-- ── 8. The deploy bridge ─────────────────────────────────────────────────────
-- A plain single-table select is AUTO-UPDATABLE, so the still-running old code
-- keeps reading AND writing `assignments` between this migration and the moment
-- all five Render services are on the new commit. Exactly the eleven columns the
-- old code knows — the new ones stay hidden, so nothing can read them by
-- accident. Dropped by 20260906140100 once every service is live.
create view assignments as
  select id, tenant_id, job_id, technician_id, starts_at, ends_at, status,
         source_capture_id, reason, created_at, updated_at
    from visits;

revoke all on assignments from anon, authenticated;
