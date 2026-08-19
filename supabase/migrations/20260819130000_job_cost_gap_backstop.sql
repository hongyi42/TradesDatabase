-- Detector #2's once-ever backstop (plan 2026-08-19, Phase 4), mirroring the
-- overdue-visit one in 20260817090000_nudges.sql:76-78.
--
-- The app-level guard in flagNudgeGap is select-then-insert, which two
-- concurrent ticks can both pass. The nudges table already has its own
-- uq_nudges_subject_ever; this is the REVIEW-ITEM half, so the escalation and
-- expiry paths cannot double-flag the same job. Any-status by design: the
-- open-only partial index (one OPEN item per subject) already exists, and this
-- makes the race lose loudly instead of silently double-flagging.
--
-- Subject is the JOB id for this kind (assignment id for overdue_visit_gap) —
-- deliberate, and it is why the two indexes are separate partial indexes rather
-- than one: the subject namespaces differ per kind.
create unique index uq_review_items_job_cost_gap_ever
  on review_items (tenant_id, subject_ref)
  where kind = 'job_cost_gap';
