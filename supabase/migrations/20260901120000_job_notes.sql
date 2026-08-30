-- Per-job NOTEPADS (plan 2026-08-30 "job notepads"). One piece of prose per job
-- that the PLANNER writes and re-reads — what it understands about one piece of
-- work, in its own words.
--
-- WHY NOT jobs.attributes, the spine's own elastic L3 layer. Two reasons, and
-- the first was already decided once: the nudge_decisions migration header
-- (20260820120000:12-15) keeps model-written deliberation out of L3
-- "deliberately: `get_job` renders L3 to managers as fact, and a model's
-- deliberations are the weakest evidence class there is." That still holds, and
-- it is stronger than it reads — `get_job` is in TOOLS, not ADMIN_TOOLS, so it
-- reaches EVERY badge including technicians. Second, shape: an L3 standing fact
-- is {value, sourceCaptureId, recordedAt} where value is a SCALAR, and
-- unwrapAttributes (boardRead.ts, server.ts) strips bundles to bare values
-- before rendering — at which point planner prose and a technician-evidenced
-- fact are byte-identical. Prose has no capture to cite and would be the one
-- entry that survives a retraction which invalidated it.
--
-- SO THIS IS PLANNER-PRIVATE (user, 2026-08-30): no v_* view, reached only by
-- team-lead tools. The recall_decisions pattern, chosen for the reason that
-- migration gives — the view catalog is SHARED with the manager's query_spine,
-- so exposing a notepad to one manager query exposes it to all of them. A
-- manager read can be added later as its own deliberate tool; un-exposing a
-- view cannot.
--
-- ADDRESSED BY THE JOB, not by an index. That is the whole difference from
-- planner_memory: memory is found through a MEMORY.md the planner curates and
-- is therefore bounded by what fits in every prompt; a notepad is found through
-- the record, because the job id arrives in the gap block. Memory is what the
-- planner concluded about the FIRM; a notepad is what it understands about ONE
-- piece of work.

create table job_notes (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  -- The FK with cascade is a deliberate CONTRAST with nudge_decisions, whose
  -- job_id carries no FK precisely so a trace is "not constrained by the job
  -- lifecycle" (20260820120000:29-31). A notepad is ABOUT the job; it has
  -- nothing left to be about once the job is gone.
  job_id     uuid not null references jobs(id) on delete cascade,
  content    text not null,
  -- The instant the CURRENT content was written. The default covers INSERT
  -- only; the typed layer SETS this on every write, because this is an upsert
  -- and on the conflict path a default would freeze at the first write forever.
  --
  -- It is the NODE clock, and the eval REWRITES it to the simulated clock (the
  -- nudge_decisions.decided_at precedent): this write arrives through MCP
  -- dispatch, which does not hold the tick's nowIso, so threading a clock
  -- through it for one column is not worth it. Not rewriting would render a
  -- note as "written 8h ago" one tick after it was written — or negative, on a
  -- run starting before 10:00 firm-local.
  written_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (tenant_id, job_id)
);

-- What makes the write REVERSIBLE, and therefore admissible under the team-lead
-- dispatch gate's stated rule ("nothing irreversible or externally visible may
-- ever dispatch for it"). Ten deep per job, pruned by the typed layer.
create table job_note_versions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  job_id      uuid not null references jobs(id) on delete cascade,
  content     text not null,
  replaced_at timestamptz not null default now()
);

-- `id desc` in the index AND in the prune's ORDER BY, on purpose:
-- planner_memory already paid for this — an unordered tie makes eviction
-- nondeterministic, which is "a flake nobody would diagnose".
create index idx_job_note_versions_job
  on job_note_versions (tenant_id, job_id, replaced_at desc, id desc);

-- RLS + revoke, load-bearing rather than conventional: `content` is
-- model-written text served back into the planner's tool results, and
-- supabase/config.toml still sets auto_expose_new_tables = true, so a new table
-- is published to the publishable key unless this says otherwise.
alter table job_notes enable row level security;
alter table job_note_versions enable row level security;
revoke all on job_notes from anon, authenticated;
revoke all on job_note_versions from anon, authenticated;
