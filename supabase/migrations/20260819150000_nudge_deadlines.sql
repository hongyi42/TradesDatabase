-- Deadlines as DATA (plan 2026-08-19, Phase 2).
--
-- Until now "escalate after 48 hours" was a code constant applied to every row
-- alike (NUDGE_ESCALATE_HOURS, src/jobs/watchers.ts). That is the shape the
-- team-lead planner has to change: different gaps deserve different patience,
-- and the planner is the thing that can judge which. So the deadline moves onto
-- the row, and the constant becomes its DEFAULT.
--
-- Both columns are NULLABLE ON PURPOSE. Null means "use the code default", so:
--   * every existing row keeps today's behaviour exactly, with no backfill;
--   * if the planner never runs — off, crashed, mid-rollback — every row still
--     escalates on the 48h constant. The fail-safe is the absence of a value,
--     which is the only kind of fail-safe that survives the writer being down.
--
-- TIME BASE: these are REAL UTC instants (timestamptz), like created_at /
-- asked_at / queued_at on this table. They are NOT the naive-local
-- "firm wall clock stored as if UTC" form used inside nudges.context
-- (startsAtLocal, endsAtLocal) — comparing the two would be off by the firm's
-- offset. The rule for this table: COLUMNS are real UTC, CONTEXT is naive-local.
alter table nudges
  add column not_before     timestamptz,
  add column escalate_after timestamptz;

comment on column nudges.not_before is
  'Real UTC. Written by the team-lead planner: do not COMPOSE or send this nudge '
  'before this instant. Null = no hold. NOT CLAMPED HERE — a hold set past '
  'created_at + NUDGE_DELIVERY_DEADLINE_HOURS lets the expiry sweep hand the row to '
  'the manager as never-delivered, which is the opposite of holding it. The writer '
  'must clamp; the planner does so before any decision lands.';

comment on column nudges.escalate_after is
  'Real UTC. Written by the team-lead planner: hand this to the manager once this '
  'instant passes. Null = the code default (asked_at + NUDGE_ESCALATE_HOURS). The '
  'planner escalates by setting this to now() rather than by escalating directly, '
  'so the sweep stays the ONE path that performs a rung-2 handoff.';
