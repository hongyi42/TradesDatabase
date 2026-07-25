-- Job-level duration (Plan 4b-1). Duration moves OFF the job_type lookup and
-- onto the job itself: the freeze places jobs that have no visit yet, so the
-- value must exist at the job level or the freeze's own inputs are empty.
-- NULLABLE on purpose: "never been told" must stay representable (inbound
-- capture mints jobs with nobody to ask). Readers stay fail-closed on null.
-- The LADDER is enforced in the typed layer (src/db/jobs.ts DURATION_LADDER),
-- not here, so changing a rung is an edit, not a pilot migration.
alter table jobs add column duration_minutes integer
  check (duration_minutes is null or duration_minutes > 0);
