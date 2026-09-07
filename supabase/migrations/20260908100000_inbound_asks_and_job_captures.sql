-- Rung 10 — INBOUND ASKS BEFORE IT CREATES, AND WHAT IT CREATES CITES THE CALL.
--
-- Three additive pieces. Nothing here is destructive, and every one of them is
-- safe to apply BEFORE the code that uses it — which is the deploy order (the
-- 9b/9c idiom): migration first, then the services.
--
--   1. observations.pinged_at / .asked_at — the two markers that keep one call
--      from being asked about twice. `pinged_at` means the planner was CALLED
--      about this row; `asked_at` means a text actually went out. They are
--      deliberately separate: the focused pass claims by the first and the send
--      guards on the second, so a planner that decides to WAIT has not "asked".
--   2. job_captures — the twin of visit_notes, one rung down. An inbound
--      capture on an open job with no live trip had nowhere to link: it was
--      unstamped (identity resolves after L1, which is immutable) and attached
--      to no visit, so both evidence homes missed it and the job read silent.
--   3. v_job_captures — the spine_reader's road to the same link, so the
--      planner can ask "what correspondence is on this job" in plain SQL.

-- ── 1. The two markers ───────────────────────────────────────────────────────
alter table observations
  add column if not exists pinged_at timestamptz,
  add column if not exists asked_at  timestamptz;

comment on column observations.pinged_at is
  'Rung 10: the planner was CALLED about this observation (the Calls-worker''s guarded claim, or a heartbeat pass that showed it). Not an ask.';
comment on column observations.asked_at is
  'Rung 10: a message about this observation actually went out, stamped by the send itself under a guard so two passes can never both text.';

-- The ping loop's read, and the ONLY query this index serves: fleet-wide (the
-- worker polls every tenant at once), so there is deliberately no leading
-- tenant_id — a tenant-first index cannot serve a query that names no tenant.
-- The predicate is `listUnpingedObservations`'s WHERE, verbatim, or the partial
-- index goes unused.
create index if not exists idx_observations_unpinged
  on observations (noticed_at)
  where status = 'open' and pinged_at is null and asked_at is null;

-- THE DEDUP READ'S OWN INDEX. `captureHasObservation` asks "was this capture
-- ever noticed", by subject_ref alone — fleet-wide, any kind, any author —
-- because it runs on the write path before a tenant is even in hand. That query
-- cannot use uq_observations_subject_ever (tenant_id leads it, and its
-- `author = 'detector'` predicate is not implied), so without this it is a Seq
-- Scan on a table with NO DELETE PATH, once per inbound delivery. Exactly the
-- regression 20260904110000's header records for listObservedSubjectRefs:
-- Index Only Scan (cost 33) → Seq Scan (cost 770) at 20k rows.
create index if not exists idx_observations_subject_ref
  on observations (subject_ref);

-- ── 2. job_captures — which capture landed on which job ──────────────────────
-- WHY A TABLE AND NOT raw_captures.job_id: same reason visit_notes is a table.
-- The L1 row is inserted BEFORE identity resolves, and L1 can never be updated
-- afterwards. So the link has to live somewhere writable, and one job takes
-- many captures.
--
-- NOT `job_notes` — that name is taken (20260901120000), and it is the
-- planner's own notepad, a different thing entirely.
create table job_captures (
  tenant_id  uuid not null references tenants(id),
  job_id     uuid not null references jobs(id) on delete cascade,
  capture_id uuid not null references raw_captures(id),
  created_at timestamptz not null default now(),
  primary key (job_id, capture_id)
);

create index idx_job_captures_capture on job_captures(capture_id);
create index idx_job_captures_tenant_job on job_captures(tenant_id, job_id);

-- APPEND-ONLY ON UPDATE ONLY, exactly as visit_notes (20260906140000): a link,
-- once made, is never silently re-pointed at a different job. DELETE stays open
-- or `on delete cascade` above would raise instead of cascading, and a job
-- would become undeletable the moment a customer emailed about it — the "L1
-- pins L2" trap. The evidence itself is untouched by a delete here: the capture
-- stays in raw_captures forever.
create trigger job_captures_append_only
  before update on job_captures
  for each row execute function raise_append_only();

-- The door stays shut. auto_expose_new_tables (supabase/config.toml) grants the
-- publishable keys SELECT on every NEW table unless the migration says
-- otherwise, and the server holds only the service_role key, which bypasses
-- RLS. Both halves, the visit_participants posture (20260907100000:244-245):
-- visit_notes itself never enabled RLS because the deny-all sweep
-- (20260824120000) had already covered it, and that sweep was one-time.
revoke all on job_captures from anon, authenticated;
alter table job_captures enable row level security;

-- ── 3. The read surface ──────────────────────────────────────────────────────
-- The v_visit_notes twin (20260906140000:207): the planner joins
-- v_job_captures.capture_id to v_captures.id for the words.
create view v_job_captures as
  select c.job_id,
         c.capture_id,
         j.customer_id,
         c.created_at
    from job_captures c
    join jobs j on j.id = c.job_id
   where c.tenant_id = current_setting('spine.tenant_id')::uuid
     -- job_captures.job_id is an ID-ONLY foreign key: nothing in the schema
     -- makes the job share the link's tenant. Every TypeScript reader re-checks;
     -- this view's consumer writes raw SQL and cannot, so the wall is here.
     and j.tenant_id = c.tenant_id;

grant select on v_job_captures to spine_reader;
revoke all on v_job_captures from anon, authenticated;
