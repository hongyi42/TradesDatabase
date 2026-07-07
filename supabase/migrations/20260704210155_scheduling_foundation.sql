-- Scheduling foundation (Plan 1 of the auto-scheduling series):
-- tenant timezone + duration fallback, technician availability + service cities,
-- time-off exceptions, per-job-type durations, and the assignments table with a
-- database-enforced double-booking guard.
--
-- Applied to the TEST project via mcp__supabase-test__apply_migration on
-- 2026-07-04; this file mirrors the applied ledger entry (version 20260704210155).

-- Firm-local time interpretation + duration fallback.
alter table tenants
  add column timezone text not null default 'America/Los_Angeles',
  add column default_job_minutes integer not null default 120
    check (default_job_minutes > 0);

-- Weekly working pattern (firm-local times) + covered cities (soft area signal).
-- availability NULL = never configured -> scheduler treats as unschedulable.
-- Shape: {"mon":[["08:00","17:00"]], ... "sun":[]} — validated in the typed layer.
alter table technicians
  add column availability jsonb,
  add column service_cities text[] not null default '{}';

-- Date-ranged exceptions (vacation/sick/emergency). Whole days (user decision).
create table technician_time_off (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  technician_id uuid not null references technicians(id) on delete cascade,
  starts_on     date not null,
  ends_on       date not null,
  reason        text,
  created_at    timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index idx_time_off_technician on technician_time_off(technician_id, starts_on);
create index idx_time_off_tenant     on technician_time_off(tenant_id);

-- Manager-editable per-type duration defaults ("maintenance 60, install 480").
create table job_type_durations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  job_type   text not null,
  minutes    integer not null check (minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, job_type)
);
create index idx_job_type_durations_tenant on job_type_durations(tenant_id);
create trigger job_type_durations_set_updated_at
  before update on job_type_durations
  for each row execute function set_updated_at();

-- The schedule itself. Times are IMMUTABLE per row (reschedule = cancel + insert);
-- status is the only mutable business field. History = the accumulated rows.
create type assignment_status as enum ('proposed', 'confirmed', 'cancelled', 'completed');
create extension if not exists btree_gist with schema extensions;
create table assignments (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  job_id            uuid not null references jobs(id) on delete cascade,
  technician_id     uuid not null references technicians(id),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  status            assignment_status not null default 'proposed',
  reason            text,             -- stamped on cancel (why it was undone)
  source_capture_id uuid references raw_captures(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Structural double-booking guard: no two CONFIRMED assignments may overlap
  -- for one technician. proposed rows may overlap (alternative proposals).
  constraint no_confirmed_overlap exclude using gist
    (technician_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'confirmed')
);
create index idx_assignments_tenant     on assignments(tenant_id);
create index idx_assignments_job        on assignments(job_id);
create index idx_assignments_technician on assignments(technician_id, starts_at);
create trigger assignments_set_updated_at
  before update on assignments
  for each row execute function set_updated_at();
