-- Which capture answered this gap (plan 2026-08-22, Phase 1).
--
-- A gap goes out as a question and comes back as a note, and until now nothing
-- tied the two together: the answer landed in raw_captures with no idea what it
-- was replying to. The spine can close that loop WITHOUT a ref code in the
-- message — at record_field_note time it knows the technician, it has resolved
-- the job, and it can read its own open gaps. Exactly one open gap for that
-- person on that job is an unambiguous match; two or more is a judgment, and a
-- judgment belongs to the planner (Phase 2), so code stamps nothing.
--
-- NO FOREIGN KEY, deliberately. raw_captures is append-only and undeletable, and
-- the ladder must never become a reason a capture is pinned or a delete is
-- blocked — L1 owes the ladder nothing. Same call, same reasoning, as
-- nudge_decisions.job_id (20260820120000_nudge_decisions.sql), which is also a
-- bare uuid.
--
-- Nullable forever: most nudges never get a stamp (nobody answered, two gaps
-- shared the job, the badge had no roster row). NULL means "not attributed",
-- never "not answered" — the answer may well be sitting on the job unlinked.
alter table nudges add column if not exists answered_by_capture_id uuid;

comment on column nudges.answered_by_capture_id is
  'The raw_captures row the spine matched to this gap as its answer (plan 2026-08-22). '
  'Stamped once, first-write-wins, only when exactly ONE open gap existed for that '
  'technician on that job. No FK: L1 is append-only and owes the ladder nothing.';
