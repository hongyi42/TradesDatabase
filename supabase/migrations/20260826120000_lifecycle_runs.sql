-- The lifecycle cron's own execution record — one row per tick.
--
-- WHY THIS EXISTS: the heartbeat's only record of itself was a line of JSON on
-- stdout, kept as long as Render keeps the log (~30d) and unqueryable. Every
-- OTHER surface in the system is keyed to a business object (a nudge, a
-- decision, a gap), so a tick with nothing to do wrote nothing ANYWHERE — and
-- "no rows" was indistinguishable from "the cron has been dead since Tuesday".
-- That is the exact shape that hid a dead manager-push for 30 days.
-- Research: thoughts/shared/research/2026-08-25-planner-tick-observability.md
--
-- TENANT-AGNOSTIC BY DESIGN. One tick sweeps every tenant, so there is no single
-- firm it belongs to and there is deliberately NO tenant_id / FK here. Two
-- consequences, both intended:
--   * it is DELIBERATELY ABSENT from the tenant cleanup lists (scripts/seed.mjs,
--     scripts/spine-eval/world.mjs, scripts/agentic-eval/run.mjs). eng-memory §1
--     says register every new table by name; this one is registered by an
--     explicit exclusion comment at each list rather than a delete, because an
--     ops log about the PROCESS must survive a tenant being wiped.
--   * that is only safe because of what the row is guaranteed NOT to hold. The
--     writer (redactForRecord, src/jobs/lifecycle.ts) replaces the planner's
--     per-decision arrays — which carry the technician's question, the quoted
--     reply and the model's reasoning — with their COUNTS before the insert.
--     Anything added to LifecycleSummary later that carries free text must be
--     redacted there too, or it lands in a row with no tenant to scope it.
--     PRECISELY: the guarantee is "no planner-authored or customer-authored free
--     text". It is NOT "no identifier can ever appear here" — step errors are
--     vendor/Postgres messages, capped at 500 chars but not rewritten, and such
--     a message can incidentally quote a value (a 23505 echoes the conflicting
--     key). That trade is deliberate: an unreadable error is an unfixable step,
--     and the same text already goes to stdout. Rows are pruned at 90 days.
--
-- Append-only by convention, like reflector_runs and gap_summaries next door: a
-- tick either happened or it did not, and there is no accessor to rewrite one.
-- The ONE mutation is the 90-day prune (pruneLifecycleRuns), which deletes whole
-- rows and never edits them.

create table lifecycle_runs (
  id           uuid primary key default gen_random_uuid(),
  -- The nowIso handed to runLifecycle: the clock the cadence gates actually read
  -- (heavyTick = minute % 15, plannerTick = minute % 30). NOT the DB clock — a
  -- tick's identity is the instant it believed it was running at.
  started_at   timestamptz not null,
  -- Written by the APP, not left to now(), and that is load-bearing:
  -- cost_events.occurred_at is stamped with the app's clock too
  -- (src/db/costs.ts:68 always sends an explicit value, never the default), so
  -- both ends of this window and the events inside it share ONE clock. Closing
  -- the window with the database clock instead would measure the interval
  -- against a different host's time and skew every tick-to-spend join by
  -- whatever the two drift apart — and would make the CHECK below reject a fast
  -- off-cadence tick whenever the DB clock lagged. The default stays only as a
  -- backstop for a hand-written row.
  -- Render guarantees at most one concurrent lifecycle run, so these windows
  -- never overlap and a model call falls inside exactly one tick.
  finished_at  timestamptz not null default now(),
  ok           boolean not null,
  -- The whole LifecycleSummary, redacted to counts. JSONB rather than promoted
  -- columns: the summary's shape changes with every new step, and a schema that
  -- must migrate in lockstep with it would go stale silently. The field NAMES
  -- are the stable reference (see the header of src/jobs/lifecycle.ts).
  summary      jsonb not null,
  created_at   timestamptz not null default now(),
  check (finished_at >= started_at)
);

-- The one access pattern: "what happened in the last N hours", newest first,
-- and the gap scan that walks consecutive rows looking for a missing cron.
create index idx_lifecycle_runs_started on lifecycle_runs (started_at desc);

alter table lifecycle_runs enable row level security;
revoke all on lifecycle_runs from anon, authenticated;
