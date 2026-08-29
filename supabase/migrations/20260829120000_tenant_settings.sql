-- Per-firm operating settings (plan 2026-08-29 "the firm is data", Build 2 of
-- the harness rebuild). Sixteen-odd numbers in src/ encode "how a trades firm
-- works" GLOBALLY, for every firm. This is where a firm's own values live.
--
-- SPLIT FROM tenant_profiles ON PURPOSE (user, 2026-08-29). That table is
-- letterhead identity — address, license numbers, the disclosure footer — read
-- rarely and rendered into human copy. These are read by CODE on every tick.
-- Different lifetime, different reader, different blast radius.
--
-- EVERY COLUMN NULLABLE, and that is the design, not laziness: absent means
-- "use the code default", so an empty table is byte-for-byte today's behaviour.
-- The defaults live in ONE place — resolveSettings() in src/db/tenantSettings.ts
-- — never duplicated as column defaults here, or the two would drift and the
-- SQL copy would win silently.

create table tenant_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,

  -- APPROXIMATE, and the word is load-bearing — it is named so nobody mistakes
  -- it for a guarantee. Nobody can know a firm's hours exactly, and the user
  -- ruling that created this column says so: "who said a firm would have fixed
  -- working hours at all?" (2026-08-29).
  --
  -- It drives planner CADENCE ONLY: how often we THINK about a firm. Getting it
  -- wrong costs wasted ticks, never a withheld message.
  --
  -- It is NOT a send gate. There is none — the 7am-7pm ask window is deleted in
  -- this same build (user: "the planner should just be able to choose when a
  -- message is sent, period").
  --
  -- It is NOT the working-hours METRIC either. workingHoursBetween() and its SQL
  -- twin working_hours_between() keep their own fixed 7-19 convention, because a
  -- yardstick that moves per firm stops being a yardstick — and gap_summaries
  -- .working_hours_open is STORED, so changing that convention would silently
  -- restate every row already written.
  approx_work_start_hour int check (approx_work_start_hour between 0 and 23),
  approx_work_end_hour   int check (approx_work_end_hour   between 1 and 24),

  -- The three DETECTION parameters, and ONLY those. The selection rule is not
  -- taste: a constant belongs here only if EVERY call-site that reads it holds a
  -- tenant id.
  --
  -- Deliberately ABSENT — do not add them without reading this:
  --   * nudge_escalate_hours / nudge_delivery_deadline_hours are read on BOTH
  --     sides of a mirrored rule (the sweep in watchers.ts AND currentDeadlineMs
  --     /holdCeilingMs in planner.ts, which are pure functions with no tenant in
  --     scope). Moving only the sweep's side manufactures exactly the failure
  --     planner.ts warns about: `extend` reporting success while the sweep
  --     escalates on a different clock. They move in build 6, together.
  --   * planner_silence_hours exists solely for the sweep's fail-safe liveness
  --     check, which build 5 deletes — a column for it would need a second
  --     migration to remove it again.
  overdue_hours    int check (overdue_hours    > 0),
  lookback_hours   int check (lookback_hours   > 0),
  max_new_per_tick int check (max_new_per_tick > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tenant_settings_set_updated_at
  before update on tenant_settings
  for each row execute function set_updated_at();

-- RLS-with-no-policy + explicit revoke — the tenant_profiles / cost-tables
-- posture. service_role bypasses RLS so the app is unaffected; anon and
-- authenticated get zero rows and no writes. Belt-and-braces against
-- auto_expose_new_tables publishing a NEW table to the publishable key: a forged
-- write here would change how often, and on what thresholds, the firm's own
-- detectors fire.
alter table tenant_settings enable row level security;
revoke all on tenant_settings from anon, authenticated;
