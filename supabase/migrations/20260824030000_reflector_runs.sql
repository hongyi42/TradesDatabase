-- ⑤ Phase 4: the Reflector's run marker — written on EVERY run, including
-- zero-proposal ones (recording runs on their proposals leaves quiet runs
-- unmarked and re-fires a billed model call daily on unchanged input).
-- ops_events is unusable for this (host FK + one-open partial index).
-- References only tenants → named in BOTH cleanup lists.

create table reflector_runs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  ran_at     timestamptz not null default now(),
  proposed   int not null default 0
);

create index idx_reflector_runs_tenant_ran on reflector_runs (tenant_id, ran_at desc);

alter table reflector_runs enable row level security;
revoke all on reflector_runs from anon, authenticated;
