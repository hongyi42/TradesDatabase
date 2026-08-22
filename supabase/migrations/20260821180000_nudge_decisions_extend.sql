-- The planner's `extend` verb (plan 2026-08-21 ①, Phase 2).
--
-- Two changes, and the FIRST is why this migration must land before the code
-- that writes it. `nudge_decisions.action` is CHECK-constrained to the four
-- verbs the table shipped with (20260820120000_nudge_decisions.sql:37), and
-- recordNudgeDecisions inserts one statement per chunk with NO partial insert —
-- so a single un-migrated 'extend' would reject up to 500 decisions in one go.
-- Same failure shape the safeJobId guard prevents one layer up (PR #160).
--
-- The constraint name is DETERMINISTIC — Postgres names an inline column check
-- <table>_<column>_check — so it is written literally rather than looked up.
-- A migration must run identically on the local stack and the pilot; a name
-- discovered from one database would be a guess about the other. Verified
-- against the pilot before writing: 'nudge_decisions_action_check'.
--
-- Drop/re-add is safe here: RLS-with-no-policies and the anon/authenticated
-- revoke are untouched, and every existing row satisfies the superset.
alter table nudge_decisions drop constraint if exists nudge_decisions_action_check;
alter table nudge_decisions add constraint nudge_decisions_action_check
  check (action in ('send', 'hold', 'close', 'escalate', 'extend'));

-- What an extend actually DID. Without this the corpus records that a deadline
-- was postponed but never how far, so no eval can ever ask whether the planner
-- postpones sensibly — which is the whole reason the decision log exists.
-- Nullable and unconstrained: every other action leaves it null, exactly as
-- not_before is null for everything but a hold.
alter table nudge_decisions add column if not exists escalate_after timestamptz;
