-- ⑤ Phase 4 review find F2: a FAILED model call must not advance the
-- ≥5-new-summaries watermark, or one transient provider blip starves a quiet
-- firm's distillation forever. ok=false marks a failure marker: ranToday
-- counts ANY marker (the one-billed-attempt-per-day bound holds), but
-- newSinceLastRun anchors on the last SUCCESSFUL run.
alter table reflector_runs add column ok boolean not null default true;
