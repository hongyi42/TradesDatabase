-- THE RECORD LEARNS WHO WROTE EACH ROW (plan 2026-09-02 "the record has
-- authors", build 7 Phase 1; user rulings 2026-09-02, docs/engineering-memory.md
-- §6a entry 7).
--
-- DEPLOY ORDER: apply BEFORE deploying the code, and the hazard is bigger than
-- "Phase 2 needs it". Deploys run no migrations (docs/engineering-memory.md),
-- and PHASE 1'S OWN CODE already writes this column on EVERY insert, the
-- detector's included (createObservation, src/db/observations.ts). Code ahead of
-- migration therefore fails every observation insert with PGRST204 — which is
-- NOT 23505, so `isUniqueViolation` does not swallow it and it throws into the
-- per-tenant catch in watchers.ts. The visible symptom would be detection
-- silently stopping fleet-wide, surfacing only as `tenantErrors`.
--
-- WHY A SECOND AUTHOR AT ALL. Until now exactly one thing could create an
-- observation: the detector sweep (`createObservation`'s only caller was
-- src/jobs/watchers.ts). Build 4's direction said the detector must NOT be the
-- only way a gap opens — the planner may read the record and open its own — and
-- the 2026-09-02 ruling added a second eye behind it: a seat agent's
-- `inform_team_lead` is something the planner may turn into a standing row
-- instead of a message read once and drained.
alter table observations add column if not exists author text not null default 'detector';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'observations'::regclass
       and conname = 'observations_author_check'
  ) then
    alter table observations add constraint observations_author_check
      check (author in ('detector', 'planner'));
  end if;
end $$;

-- ── THE ONCE-EVER RULE NARROWS TO THE DETECTOR ───────────────────────────────
--
-- WHAT THE INDEX IS ACTUALLY FOR, which the original header (20260901130000:66)
-- stated as one mechanism and is really two. It compensates for the DETECTOR'S
-- BLINDNESS: the sweep is stateless, runs every five minutes, and has no memory
-- of what it already noticed — without a unique key it would re-notice the same
-- overdue visit forever. The PLANNER has no such blindness: it is shown its open
-- set every tick. What brakes a duplicate open is DOCTRINE, not a database rule
-- — the plan's explicit choice, over both a partial index on open rows and a
-- per-tick cap (the cap being the silent drop build 4 deleted). Stated
-- precisely, because the first draft of this header overclaimed: the planner
-- sees its OPEN rows and the IDS of its dismissed ones, so nothing mechanical
-- stops it re-opening a subject it dismissed.
--
-- LEFT WHOLE, this index would mean ONE PLANNER OBSERVATION PER (kind, subject)
-- FOREVER — and since planner rows carry a single reserved kind, that reads as
-- "the planner may raise a concern about this job once, for the life of the
-- firm". That exact failure is already on the record in the sibling store:
-- src/db/moneyEvents.ts:253 — a cancelled cost row made a job permanently
-- un-askable, "doing the right thing was what buried it".
--
-- IT BECOMES AN INDEX because a table CONSTRAINT cannot be partial. Nothing
-- references it by name: createObservation uses a bare .insert() plus
-- isUniqueViolation (SQLSTATE 23505, which a partial unique index raises
-- identically), there is no onConflict/upsert on this table anywhere, and the
-- repo's only pg_constraint/pg_indexes assertions are in schema.test.ts and
-- jobNotes.test.ts, neither about observations.
--
-- WHAT DOES NOT CHANGE: the detector's RESULTS, row for row. Its rows default to
-- author='detector', so every existing one stays inside this index and a
-- duplicate still raises 23505.
--
-- WHAT DOES CHANGE, and the review caught it: `listObservedSubjectRefs` had to
-- learn to say `author='detector'` too. A partial index is only usable when the
-- query IMPLIES its predicate, so an author-less read stopped being able to use
-- this one — measured at 20k rows, Index Only Scan (cost 33) became a Seq Scan
-- (cost 770), twice per tenant per five-minute tick, on a table with no delete
-- path. The added filter changes no result — a planner row carries kind
-- 'planner_observation' and the read already filters on kind — and it restores
-- the plan. Stated as convention rather than guarantee, deliberately: the DB
-- permits author='planner' on a detector kind (the Phase-1 test writes exactly
-- such a row), so what keeps them apart is that `observe` hardcodes the kind,
-- not anything enforced here. Build 9's detectors are the first plausible way
-- to make that sentence false.
alter table observations drop constraint if exists uq_observations_subject_ever;
create unique index if not exists uq_observations_subject_ever
  on observations (tenant_id, kind, subject_ref) where author = 'detector';

-- The verb build 7 Phase 2 introduces. FIFTH amendment of this constraint
-- (20260821180000 → 20260822140000 → 20260901130000 → 20260901160000): every
-- existing row satisfies the superset, and drop/re-add is the established shape.
-- The CHECK is deliberately a SUPERSET of the live vocabulary, so retiring a
-- verb needs no migration and adding one does.
alter table nudge_decisions drop constraint if exists nudge_decisions_action_check;
alter table nudge_decisions add constraint nudge_decisions_action_check
  check (action in ('send', 'hold', 'close', 'escalate', 'extend', 'leave', 'unmentioned',
                    'dismiss', 'recover', 'ask_agent', 'inform_agent', 'observe'));

comment on column observations.author is
  'Who created this row: detector (the sweep) or planner. The once-ever unique '
  'index applies to detector rows ONLY — it exists to compensate for the '
  'sweep''s statelessness; what brakes a duplicate planner open is doctrine, '
  'deliberately, not a database rule.';

-- ── THE READ SURFACE LEARNS IT TOO ───────────────────────────────────────────
--
-- Not in the plan, and added because the Phase-1 verification made the omission
-- plain: a phase whose whole point is "the record learns who wrote each row"
-- would otherwise ship a read surface that cannot say. `v_observations` is
-- spine_reader's ONLY window on this table — it is what the planner's doctrine
-- points at to find dismissed rows to `recover`, and what a manager's
-- query_spine sees — so without this the planner cannot tell its own
-- observations from the detector's through the one surface it is told to use.
--
-- CREATE OR REPLACE requires existing columns to keep their name, type and
-- ORDER, so `author` is appended LAST. Grants survive a replace; both lines are
-- re-asserted anyway to keep the file self-contained on a fresh replay, and the
-- revoke is the one the auto_expose_new_tables note in 20260901130000 warns
-- about.
create or replace view v_observations as
  select o.id,
         o.kind,
         o.status,
         o.subject_ref,
         t.ref          as technician_ref,
         t.display_name as technician_name,
         case when o.context->>'jobId'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (o.context->>'jobId')::uuid end as job_id,
         o.dismiss_reason,
         o.dismissed_at,
         o.not_before,
         o.noticed_at,
         o.author
    from observations o
    left join technicians t on t.id = o.technician_id
   where o.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_observations to spine_reader;
revoke all on v_observations from anon, authenticated;
