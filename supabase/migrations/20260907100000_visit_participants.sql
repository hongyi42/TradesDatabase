-- Rung 9c — A VISIT CARRIES A CREW.
--
-- `visits.technician_id` is one nullable column, so two technicians on one trip
-- are two visits nothing joins: two gaps, two texts, and a partner row that
-- never closes (the filer's row completes, the other stays 'confirmed' forever).
-- This migration adds `visit_participants` — one row per person on a visit —
-- and moves the double-booking guard onto it.
--
-- ORDER (the 9b idiom, and it is load-bearing):
--   20260907100000  BEFORE the deploy. Everything here is ADDITIVE: the old
--                   `technician_id` column, `no_confirmed_overlap` on `visits`
--                   and `idx_visits_technician` all survive, so the five
--                   still-running Render services keep booking and moving with
--                   no idea participants exist. The reconcile trigger below is
--                   what keeps the new table true while they do.
--   20260907100100  AFTER every service is live — drops the column, its guard,
--                   its index, and the bridge arm of the trigger.
-- Applying the second one early 400s every schedule write made by a service
-- still on the old commit. Locally both apply in one `supabase db reset`, which
-- is the point: the end state is the real schema, and no test sees the bridge.
--
-- WHY THE TIMES ARE COPIED ONTO THE PARTICIPANT (the structural crux of the
-- rung). The guard is
--     EXCLUDE USING gist (technician_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
--       WHERE status = 'confirmed' AND starts_at IS NOT NULL
-- and it works ONLY because the person and the times sit on the same row. A
-- Postgres exclusion constraint cannot reference a second table. So either the
-- person stays on `visits` (a lead by another name — contra the 2026-09-01
-- ruling that a crew has no lead), or the guard moves to the participant and
-- the times come with it. App-code-only enforcement was rejected: rung 9b's
-- move path RELIES on this constraint firing to report "that slot is taken"
-- without a race, and a SELECT-then-INSERT check cannot.
--
-- PROVEN, not assumed (plan-review probe, 2026-09-06, local stack): an
-- exclusion raised from INSIDE an AFTER trigger reaches PostgREST as
-- {"code":"23P01"}, the parent UPDATE rolls back whole, and a non-overlapping
-- move syncs every participant's copy (HTTP 204). So isOverlapViolation() and
-- moveVisitRow's "nothing changed" argument survive untouched.

-- ── 1. The table ─────────────────────────────────────────────────────────────
-- starts_at/ends_at/status are DERIVED COPIES of the visit's, never written by
-- a caller: the BEFORE INSERT trigger fills them and the AFTER trigger on
-- `visits` keeps them in step. They exist for exactly one reason — to give the
-- exclusion constraint a row that knows both WHO and WHEN.
--
-- WHY A SURROGATE PRIMARY KEY AND NOT (visit_id, technician_id) — measured, not
-- preference (local stack, 2026-09-06). PostgREST reads a two-FK table whose
-- PRIMARY KEY is exactly those two FKs as a JUNCTION and synthesises a
-- many-to-many `visits ↔ technicians` relationship. That collides with the
-- existing `visits_technician_id_fkey`, and every select that embeds
-- `technicians` from `visits` — five of them in src/db/visits.ts, plus the
-- board, the customer brief and the unplaced strip that read through them —
-- starts answering HTTP 300 PGRST201 the moment this migration lands:
--     {"code":"PGRST201","details":[
--        {"cardinality":"many-to-one","relationship":"visits_technician_id_fkey…"},
--        {"cardinality":"many-to-many","relationship":"visit_participants…"}]}
-- That would break the STILL-RUNNING OLD CODE for the whole deploy window,
-- which is the one thing this migration's ordering exists to prevent. A
-- surrogate `id` with a UNIQUE (visit_id, technician_id) gives the identical
-- guarantee, and PostgREST stops synthesising the junction (probed: 200).
-- `visits → visit_participants → technicians` is a plain two-level embed and is
-- unaffected either way. The unique constraint is still what `on_conflict`
-- names, so the upserts read the same.
create table visit_participants (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  visit_id      uuid not null references visits(id) on delete cascade,
  technician_id uuid not null references technicians(id),
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- DEFAULT only so a caller need not name a value the fill trigger is about to
  -- overwrite — the generated Insert type would otherwise demand `status` from
  -- every upsert, inviting exactly the hand-written value this design forbids.
  -- The trigger sets it unconditionally on every insert; the default is never
  -- the value that lands.
  status        visit_status not null default 'proposed',
  created_at    timestamptz not null default now(),
  constraint uq_visit_participants unique (visit_id, technician_id),
  -- Same predicate as `no_confirmed_overlap` on `visits`, same reason: an
  -- untimed row is demand, not schedule — tstzrange(null,null) would block the
  -- technician's whole calendar (rung 9a, 20260724130000).
  constraint no_confirmed_overlap_participant exclude using gist
    (technician_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'confirmed' and starts_at is not null)
);

-- The per-person calendar read (listVisitsForTechnician now roots here).
create index idx_visit_participants_technician on visit_participants(technician_id, starts_at);
-- The tenant-scoped "who is on this visit" read (the visit_notes index shape).
create index idx_visit_participants_tenant_visit on visit_participants(tenant_id, visit_id);

-- ── 2. The fill trigger: a participant NEVER carries its own times ───────────
-- Callers insert (tenant_id, visit_id, technician_id) and nothing else. Copying
-- here rather than trusting the caller is what makes the derived columns safe:
-- there is no code path that can write a participant whose times disagree with
-- its visit, so the guard can never be dodged by lying about when.
--
-- ON UPDATE TOO, not just insert. Without it the guarantee above is only a
-- convention: `update visit_participants set starts_at = …` would desynchronise
-- a row from its trip and the exclusion constraint would then be checking a
-- time nobody is going. Re-deriving on every write makes it structural. The
-- sync arm below writes the same values it would derive, so it is a no-op there.
--
-- FOR SHARE, deliberately. Without the lock a participant inserted CONCURRENTLY
-- with a move commits carrying the pre-move times: the mover's sync cannot see
-- the uncommitted row, and the inserter read the old ones. That row then claims
-- a slot its trip has left, and the guard is checking a lie until the next
-- update to the visit heals it. The lock makes the move wait for the insert.
--
-- The tenant check is against the VISIT's tenant, not the technician's. The
-- link belongs to the trip; a technician row from another tenant is a roster
-- bug that the FK cannot see and this trigger deliberately does not police
-- (every reader re-checks nested tenants before printing a name — the
-- DETAIL_SELECT doctrine in src/db/visits.ts).
create or replace function visit_participants_fill()
returns trigger
language plpgsql
as $$
declare v record;
begin
  select tenant_id, starts_at, ends_at, status
    into v
    from visits
   where id = new.visit_id
     for share;
  if not found then
    raise exception 'visit_participants: visit % not found', new.visit_id;
  end if;
  if new.tenant_id <> v.tenant_id then
    raise exception 'visit_participants: tenant mismatch (row %, visit %)',
      new.tenant_id, v.tenant_id;
  end if;
  new.starts_at := v.starts_at;
  new.ends_at   := v.ends_at;
  new.status    := v.status;
  return new;
end;
$$;

create trigger visit_participants_fill
  before insert or update on visit_participants
  for each row execute function visit_participants_fill();

-- ── 3. ONE trigger on `visits`, and the order inside it is load-bearing ──────
-- Two triggers would fire ALPHABETICALLY, and "sync the times" before
-- "reconcile the person" refuses a legitimate reassign-and-move: "Ben cannot
-- make Tuesday, send Joy" would first drag BEN's participant copy onto Tuesday
-- — a slot Ben holds on another job — and raise 23P01 before he is removed.
-- So it is one function, and the person is reconciled FIRST.
--
-- Arm (1) is the DEPLOY BRIDGE. Until 20260907100100 drops the column, old code
-- (and new code, which keeps writing technician_id = the first of the crew)
-- expresses "who is on this trip" through it, and this arm materialises that
-- person as a participant. It NEVER deletes every participant — a crew's other
-- members are the typed layer's business, and a blanket delete-all would let an
-- old-code UPDATE silently drop the partner.
--
-- Arm (2) is permanent: it is the whole reason the participant knows WHEN.
--
-- THE CONFLICT TARGET IS NOT DECORATION. A bare `on conflict do nothing`
-- arbitrates over EVERY usable constraint, exclusion constraints included — so
-- it would swallow `no_confirmed_overlap_participant` and leave the relocated
-- guard unenforced on the one insert path this trigger owns: an old-code
-- `update visits set technician_id = …, starts_at = …` would move a visit onto a
-- slot that person already holds, silently, with no participant row to show for
-- it. Naming (visit_id, technician_id) restricts the DO NOTHING to the duplicate
-- case, which is all the arm ever wanted. (Phase 1 review, probed.)
create or replace function visits_reconcile_participants()
returns trigger
language plpgsql
as $$
begin
  -- (1) the bridge column → participant #1 (dropped by 20260907100100)
  if tg_op = 'INSERT' then
    if new.technician_id is not null then
      insert into visit_participants (tenant_id, visit_id, technician_id)
      values (new.tenant_id, new.id, new.technician_id)
      on conflict (visit_id, technician_id) do nothing;
    end if;
  elsif new.technician_id is distinct from old.technician_id then
    if old.technician_id is not null then
      delete from visit_participants
       where visit_id = new.id
         and technician_id = old.technician_id;
    end if;
    if new.technician_id is not null then
      insert into visit_participants (tenant_id, visit_id, technician_id)
      values (new.tenant_id, new.id, new.technician_id)
      on conflict (visit_id, technician_id) do nothing;
    end if;
  end if;

  -- (2) the times and the status follow the trip, for EVERY person on it.
  -- The `is distinct from` guard keeps an unrelated UPDATE (a reason edit, a
  -- labor-hours merge) from rewriting rows and re-checking the exclusion for
  -- nothing.
  update visit_participants p
     set starts_at = new.starts_at,
         ends_at   = new.ends_at,
         status    = new.status
   where p.visit_id = new.id
     and (p.starts_at is distinct from new.starts_at
       or p.ends_at   is distinct from new.ends_at
       or p.status    is distinct from new.status);

  return null;
end;
$$;

create trigger visits_participants_after
  after insert or update of technician_id, starts_at, ends_at, status on visits
  for each row execute function visits_reconcile_participants();

-- ── 4. Backfill ──────────────────────────────────────────────────────────────
-- Every row with a person becomes EXACTLY ONE participant. Nothing guesses:
-- the pilot's one crew-shaped booking (Henderson Family, 2026-09-02 14:00,
-- ben-shelton + manager-joy) stays two one-person visits — a migration is not
-- the place to decide that two rows were meant to be one trip (user, 2026-09-06).
--
-- This cannot raise 23P01: the visits-level guard already holds the identical
-- predicate over the identical tuples, so any set that is legal there is legal
-- here. The fill trigger supplies the times and the status.
insert into visit_participants (tenant_id, visit_id, technician_id)
select tenant_id, id, technician_id
  from visits
 where technician_id is not null;

-- ── 5. The door stays shut ───────────────────────────────────────────────────
-- auto_expose_new_tables (supabase/config.toml) grants the publishable keys
-- SELECT on every NEW table unless the migration says otherwise, and the server
-- holds only the service_role key, which bypasses RLS. So: revoke the grant AND
-- enable RLS with no policy — the belt-and-braces posture of
-- 20260824120000_rls_denyall_business_tables.sql. Nothing in the app changes.
revoke all on visit_participants from anon, authenticated;
alter table visit_participants enable row level security;
