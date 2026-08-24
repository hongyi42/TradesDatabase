-- ⑤ memory architecture, Phase 3 (plan 2026-08-23): planner_lessons — where
-- distilled lessons live. Append-only TEXT (status/strikes are the only
-- mutable columns; enforced by the typed layer having no text setter), every
-- lesson citing the gap_summaries rows that justify it, two strikes retiring
-- it. 'stale' is the 60-day proposal expiry (user ruling: proposals are
-- unlimited but must not accumulate forever).
--
-- RLS + revoke are LOAD-BEARING here beyond convention: `text` is rendered
-- into the planner's prompt (Phase 5), so an unprotected INSERT via the
-- publishable key would be direct prompt injection into the planner.
-- References only tenants → named in BOTH cleanup lists (seed.mjs,
-- world.mjs), or reseeds leave a stale active lesson haunting a fresh world.

create table planner_lessons (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  text           text not null,
  scope          text not null default 'firm' check (scope in ('firm', 'person')),
  evidence       jsonb not null check (jsonb_typeof(evidence) = 'array'
                                       and jsonb_array_length(evidence) > 0),
  status         text not null default 'proposed'
    check (status in ('proposed', 'active', 'retired', 'stale')),
  strikes        int not null default 0,
  proposed_at    timestamptz not null default now(),
  activated_at   timestamptz,
  retired_at     timestamptz,
  retired_reason text
);

create index idx_planner_lessons_tenant_status on planner_lessons (tenant_id, status);

alter table planner_lessons enable row level security;
revoke all on planner_lessons from anon, authenticated;
