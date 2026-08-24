-- ⑤ memory architecture, Phase 2 (plan 2026-08-23): gap_summaries — the
-- durable unit of planner experience. One CODE-written row per CLOSED gap:
-- its whole arc (per-verb counts incl. the 'unmentioned' filler), how it
-- ended, and what the manager did with any escalation. Append-only by
-- convention (no update path in the typed layer). The Reflector (Phase 4)
-- reads THESE, never raw decision rows — raw traces are the wrong memory
-- unit (the CL finding this whole design rests on).
--
-- manager_fate is trustworthy ONLY because of the summarize sweep's
-- escalation HOLDBACK: an escalated gap is not summarized while its review
-- item is still open (or until 7 days pass — then 'still_open'). Without
-- that, this append-only row would freeze 'none' before the manager acted.

create table gap_summaries (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  -- Cascade: a deleted nudge (test worlds, reseeds) takes its summary along —
  -- and the table is STILL named in both cleanup lists (seed.mjs, world.mjs):
  -- incidental cascade coverage is how tenant_profiles got missed (eng-mem §1).
  nudge_id                uuid not null unique references nudges(id) on delete cascade,
  job_id                  uuid,
  kind                    text not null,
  subject                 text not null,
  asked_at                timestamptz,
  closed_at               timestamptz not null,
  status                  text not null,
  resolution              text,
  working_hours_open      numeric,
  arc                     jsonb not null default '{}'::jsonb,
  considered              int not null default 0,
  extended_to             timestamptz,
  escalated               boolean not null default false,
  manager_fate            text not null default 'none'
    check (manager_fate in ('none', 'dismissed', 'resolved', 'still_open')),
  manager_resolution      text,
  manager_latency_wh      numeric,
  answered_by_capture_id  uuid,
  created_at              timestamptz not null default now()
);

create index idx_gap_summaries_tenant_created on gap_summaries (tenant_id, created_at desc);

alter table gap_summaries enable row level security;
revoke all on gap_summaries from anon, authenticated;
