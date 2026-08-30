-- Build 3 of the harness rebuild (plan 2026-08-30 "the planner's memory"): the
-- planner gets a memory it writes and organises ITSELF — markdown files, per
-- firm, in a table shaped like a filesystem.
--
-- WHY A TABLE AND NOT FILES. Render's disk is ephemeral: real files written by
-- the lifecycle cron evaporate with the container. A table is the only durable
-- filesystem this runtime has.
--
-- WHAT THIS REPLACES. planner_lessons + reflector_runs, dropped in the same
-- build's Phase 3. That system never reached a prompt — 3 proposed rows on the
-- pilot, zero active, and renderLessonsBlock returns '' unless a human
-- activates one. The replacement inverts the authorship: the MODEL writes, and
-- the record corrects it every tick (reconcile-first doctrine) instead of a
-- human gating every sentence.
--
-- RLS + revoke are LOAD-BEARING beyond convention, exactly as on
-- planner_lessons: `content` is rendered into the planner's prompt, so an
-- unprotected INSERT via the publishable key is direct prompt injection into
-- the thing that decides what gets sent to a firm's technicians. Required
-- because supabase/config.toml still sets auto_expose_new_tables = true.
--
-- All three reference ONLY tenants, so no cascade from customers/jobs/nudges
-- reaches them: they are named BY NAME in every cleanup list (scripts/seed.mjs,
-- scripts/spine-eval/world.mjs, scripts/agentic-eval/run.mjs) — eng-memory §1,
-- the tenant_profiles trap.

create table planner_memory (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  -- The path IS the filing system, and its shape is the only structure we
  -- impose. Lowercase-only charset makes `MEMORY.md` STRUCTURALLY RESERVED —
  -- the index can never be shadowed by a lookalike the planner minted.
  --
  -- Kept a PLAIN single-quoted literal on purpose: an E'…' string would eat the
  -- backslash and turn `\.` into "any character", quietly admitting `xxmd`.
  -- Verified live: MEMORY.md and firm/pacing.md pass; Memory.md, A.md, ../x.md,
  -- x.txt and a newline-forged "x.md\nMEMORY.md" all fail (Postgres `$` matches
  -- end-of-string, not end-of-line, so the forgery cannot slip through).
  --
  -- `a//b.md` DOES pass here — collapsing empty segments is
  -- validateMemoryPath's job in src/teamLead/memory.ts, not the CHECK's. The
  -- CHECK is the last line, not the only one.
  path       text not null check (path ~ '^(MEMORY\.md|[a-z0-9][a-z0-9/_-]{0,120}\.md)$'),
  content    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, path)
);

create trigger planner_memory_set_updated_at
  before update on planner_memory
  for each row execute function set_updated_at();

-- Every overwrite and every delete keeps the previous content. The planner is
-- the only author and nothing reviews its writes before they land, so this is
-- what makes a memory write REVERSIBLE — which is precisely the property that
-- lets the first write verb through the team-lead dispatch gate's stated rule
-- ("nothing irreversible or externally visible").
--
-- Pruned to the 10 most recent per path by the typed layer, so the table is
-- bounded by (files x 10) rather than by write frequency — the user ruling
-- being "nothing stops the 48 rewrites a day".
create table planner_memory_versions (
  id          uuid primary key default gen_random_uuid(),
  -- The FK is REQUIRED, not decorative: without it a tenant delete leaves
  -- orphan version rows holding that firm's text forever.
  tenant_id   uuid not null references tenants(id) on delete cascade,
  path        text not null,
  content     text not null,
  replaced_at timestamptz not null default now()
);

create index idx_planner_memory_versions_path
  on planner_memory_versions (tenant_id, path, replaced_at desc);

-- "When did I last think about this firm?" — ONE ROW PER FIRM, upserted, not an
-- append-only log. The prompt needs only the last success; per-tick history
-- already lives in lifecycle_runs.summary for 90 days, and one row means no
-- retention problem to solve later.
--
-- last_success_at is separate from last_ran_at because of the lesson
-- reflector_runs paid for in a follow-up migration: a FAILED call advancing the
-- watermark starves the firm, since the next tick then believes it just ran.
--
-- The INSTANT IS ALWAYS SUPPLIED BY THE CALLER, never DB now(). The eval drives
-- a simulated clock (the same reason plannerSim rewrites nudge_decisions
-- .decided_at), and a marker on wall-clock time would make every simulated tick
-- read as "you last planned in 2026" against a 2025 scenario.
create table planner_runs (
  tenant_id       uuid primary key references tenants(id) on delete cascade,
  last_ran_at     timestamptz not null,
  last_success_at timestamptz
);

alter table planner_memory enable row level security;
alter table planner_memory_versions enable row level security;
alter table planner_runs enable row level security;
revoke all on planner_memory from anon, authenticated;
revoke all on planner_memory_versions from anon, authenticated;
revoke all on planner_runs from anon, authenticated;
