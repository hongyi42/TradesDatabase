-- A question can be DISMISSED (plan 2026-09-01 "intent verbs and the doctrine",
-- build 6 Phase 3; user ruling 2026-09-01: "Can we expand dismiss and recover to
-- gaps also? … Then it should have full control on its gaps").
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code. Deploys run no
-- migrations (docs/engineering-memory.md), and the planner's dismiss/recover
-- apply path writes both of these the moment it ships.
--
-- WHY A QUESTION NEEDED AN ENDING AT ALL. `dismiss` used to reach only
-- observations — things nobody had been asked about — because an ask had its
-- own ending: `escalate`, which handed it to a manager and took it off the
-- planner's list. Build 6 Phase 1 deleted that verb. Without this migration an
-- asked gap that will never be answered and whose record will never fill has NO
-- ending at all: `close` is authorised only by a code-computed fact or a quoted
-- answer (planner.ts's close rails), and neither exists for a question that
-- simply went nowhere. It would sit open forever, counted by the unattended
-- alarm, with the planner unable to do anything about it. That is the hole this
-- closes.
--
-- THE STATUS IS A SUPERSET, never a replacement. Every historic value stays
-- legal, including 'escalated' — build 6 deleted the VERB, not the rows, and
-- mv_escalation_fates / mv_gap_outcomes still read them.
-- `if exists` / `if not exists` throughout, matching every other CHECK-widening
-- migration in this family (20260821180000, 20260822140000, 20260901130000): a
-- run that dies between these statements has to be re-runnable.
alter table nudges drop constraint if exists nudges_status_check;
alter table nudges add constraint nudges_status_check
  check (status in ('pending','queued','asked','answered','escalated','cancelled','failed','dismissed'));

-- WHERE A DISMISSED ROW CAME FROM, so `recover` can put it back exactly there
-- (user ruling 2026-09-01: "recover restores it to prior_status").
--
-- Nullable, and its NULL means something specific: "this row was dismissed
-- before the column existed, so nothing knows what it was". recoverNudge
-- refuses those rather than guessing a stage — a row recovered to the wrong
-- stage is worse than one that cannot be recovered, because 'pending' and
-- 'asked' differ in whether a human is waiting on an answer.
--
-- Set on dismiss, cleared on recover. Deliberately NOT an enum and NOT
-- FK-shaped: it holds whatever `status` held. Note that the CHECK above
-- constrains `status` ONLY — nothing at the database level stops a bad value
-- landing here, so the invariant is dismissNudge's: it copies a value it has
-- just verified is an OPEN status, and refuses outright to dismiss an already
-- dismissed row (which would store prior_status='dismissed' and make the row
-- permanently unrecoverable). A garbage value fails the status CHECK when
-- recover tries to write it back, so the failure is loud rather than silent.
alter table nudges add column if not exists prior_status text;

-- NO INDEX, deliberately. The only reader is listDismissedNudgeIds, which is
-- (tenant_id, status='dismissed') — already served by idx_nudges_tenant_status
-- (nudges.sql). prior_status is never a predicate, only a payload.

-- WHAT DOES NOT CHANGE, and this is the point of choosing a new status rather
-- than a flag column: 'dismissed' is absent from OPEN_NUDGE_STATUSES
-- (src/db/nudges.ts), so every consumer that reads open rows stops seeing a
-- dismissed question WITHOUT ANY OF THEM CHANGING —
--   * the planner's own gap read      listNudgesByStatus(OPEN_NUDGE_STATUSES)
--   * the delivery host pull          listQueuedNudgesForHost, status='queued'
--   * the sweep's alarm pass          listNudgesByStatus(['pending','queued','asked'])
--   * the terminal-write guards       markNudgeOutcome / setNudgeSchedule default
-- A boolean flag would have required every one of those to learn about it, and
-- the first one anybody forgot would keep serving a dismissed question to a
-- technician's phone.
--
-- mv_gap_outcomes is the one view that notices: its WHERE lists the four
-- terminal statuses it knows, so a dismissed ask falls OUTSIDE it entirely
-- rather than landing in the wrong bucket. Left alone on purpose — this build
-- does not otherwise touch the metric views, and "how should a dismissed
-- question be counted?" is a question for the evaluation phase, which is where
-- the whole build order is judged.
