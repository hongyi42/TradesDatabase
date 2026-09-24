-- Step 2a (plan 2026-09-24): a manager seat's own memory — the preferences and
-- working notes a manager's assistant keeps between conversations ("invoices are
-- due in 14 days", "Sam wants exports as XLSX"). Operator, 2026-09-23: "Seat
-- memory can live on a table on Render."
--
-- SHAPED LIKE planner_memory (20260830120000), keyed ONE LEVEL DEEPER: per
-- person, not per firm. `technician_ref` is in the versions table and in its
-- index too — without it two managers' `prefs.md` histories would share one list
-- and each person's rewrites would prune the other's (plan review finding).
--
-- Written by the seat's own model through the manager-tier spine tools
-- write_my_memory / read_my_memory / list_my_memory (src/mcp/tools/memory.ts),
-- always scoped to the CALLER — a seat can never name another person.
--
-- RLS + revoke are LOAD-BEARING, exactly as on planner_memory: `content` is read
-- back into a model's context, so an unprotected INSERT through the publishable
-- key would be prompt injection into a manager's assistant. Required while
-- supabase/config.toml sets auto_expose_new_tables = true.
--
-- Both tables reference ONLY tenants, so no cascade from customers/jobs reaches
-- them: named BY NAME in every cleanup list (scripts/seed.mjs,
-- scripts/spine-eval/world.mjs, scripts/agentic-eval/run.mjs) — eng-memory §1.

create table seat_memory (
  tenant_id      uuid not null references tenants(id) on delete cascade,
  technician_ref text not null,
  -- The same path rule as planner_memory (see that migration's header for why
  -- the literal stays plain single-quoted). validateMemoryPath in
  -- src/teamLead/memory.ts answers in words before this CHECK is ever reached.
  path           text not null check (path ~ '^(MEMORY\.md|[a-z0-9][a-z0-9/_-]{0,120}\.md)$'),
  content        text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, technician_ref, path)
);

create trigger seat_memory_set_updated_at
  before update on seat_memory
  for each row execute function set_updated_at();

-- Every overwrite and every delete keeps the previous content, pruned to the 10
-- most recent per (person, path) by the typed layer (src/db/seatMemory.ts).
create table seat_memory_versions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  technician_ref text not null,
  path           text not null,
  content        text not null,
  replaced_at    timestamptz not null default now()
);

create index idx_seat_memory_versions_path
  on seat_memory_versions (tenant_id, technician_ref, path, replaced_at desc);

alter table seat_memory enable row level security;
alter table seat_memory_versions enable row level security;
revoke all on seat_memory from anon, authenticated;
revoke all on seat_memory_versions from anon, authenticated;
