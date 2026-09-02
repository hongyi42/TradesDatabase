-- The firm's roster, WITH HISTORY (plan 2026-09-02 "one send verb", build 6.5
-- Phase 1; user ruling 2026-09-02: "the planner should probably have a record
-- of the firm's roster (with history) … so it doesn't have to go looking for
-- record that proves a person was offboarded").
--
-- DEPLOY ORDER: apply BEFORE deploying the code. Deploys run no migrations
-- (docs/engineering-memory.md), and the planner reads this table on every tick
-- once the code ships.
--
-- WHY THE TABLE EXISTS AT ALL. A technician's row is never deleted — refs are
-- never reused across humans, because L1 attribution is append-only and would
-- merge two people's history (20260702194603:21) — so WHO worked here is
-- already permanent. What was missing is WHEN anything changed:
-- `technicians.updated_at` is bumped by ANY edit (a skills change, a phone
-- binding), so it can never answer "when did they leave".
--
-- THE TRAIL STARTS EMPTY AND CANNOT BE BACKFILLED. There is no honest source
-- for a past transition — see updated_at above. Anyone who left before this
-- migration has no row here, and the planner's roster block must render
-- "left (date unknown)" for them rather than inventing a date from a column
-- that does not mean what it looks like.
create table if not exists roster_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  -- ON DELETE CASCADE, though it should never fire: a technician row is never
  -- deleted in this system (refs are never reused). It is here because a trail
  -- whose subject is gone has nothing to describe, and because leaving it off
  -- would make the roster un-deletable in test teardown for no stated benefit.
  technician_id uuid not null references technicians(id) on delete cascade,
  -- The ENUM, not text: a state that cannot exist cannot be recorded. NULL
  -- `from_state` means "we started watching here" — the row's first event,
  -- never "they came from nowhere".
  from_state    technician_state,
  to_state      technician_state not null,
  -- ALWAYS NULL for now, and that is a recorded decision rather than an
  -- oversight (user ruling 2026-09-02). The trigger below cannot see WHO made
  -- a change, and this codebase has no way to pass one down: `spine.tenant_id`
  -- is its only session setting and is set inside SQL, with no TypeScript
  -- caller. The column stays so attribution can be added later without a
  -- second migration over live rows.
  actor_ref     text,
  reason        text,
  occurred_at   timestamptz not null default now()
);

-- The planner's read is (tenant, these technician ids); the tenant-wide index
-- serves v_roster_events and any operator listing.
create index if not exists idx_roster_events_tenant on roster_events (tenant_id, occurred_at desc);
create index if not exists idx_roster_events_technician on roster_events (technician_id, occurred_at desc);

-- APPEND-ONLY BY INTENT, not by trigger. No updater is written and none should
-- be: a history rewritten in place is not a history. Deliberately NOT enforced
-- with a blocking trigger the way raw_captures is — this table is operational,
-- not L1, and a hard rail would make a future correction migration impossible
-- for no gain nobody has asked for.

-- WHY A TRIGGER AND NOT AN APP-SIDE WRITE. This was found the hard way at
-- implementation time. The plan said state changes "funnel through ONE
-- function, setTechnicianState" — they do not: that function has NO production
-- runtime callers at all (only the test suite and two scripts, seed.mjs:266 and
-- spine-eval/world.mjs:388). Every real transition goes
-- through `casTechnician` (mcp/server.ts:5443 deactivate, :5539 reactivate,
-- :7904 pairing-verified, composio/pairing.ts:123,291,
-- composio/offboarding.ts:86) or `updateTechnician` (mcp/server.ts:5744), both
-- of which take a patch OBJECT — which is why a grep for an inline `state:`
-- literal missed them. An app-side hook on the named helper would have
-- produced a trail that is FULL IN TESTS AND EMPTY IN PRODUCTION: the worst
-- failure available, because every test would have proved it working.
--
-- A trigger catches all four writers and any fifth one added later, and gets
-- the previous state for free. AFTER, so only rows that actually landed are
-- recorded — the seat-cap BEFORE trigger (20260702194603) rejects some.
create or replace function record_roster_event() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into roster_events (tenant_id, technician_id, from_state, to_state)
      values (new.tenant_id, new.id, null, new.state);
  elsif new.state is distinct from old.state then
    -- `is distinct from` and not `<>`: state is NOT NULL today, but a null on
    -- either side would make `<>` null and silently skip the event.
    insert into roster_events (tenant_id, technician_id, from_state, to_state)
      values (new.tenant_id, new.id, old.state, new.state);
  end if;
  return new;
end $$;

drop trigger if exists technicians_record_roster_event on technicians;
create trigger technicians_record_roster_event
  after insert or update on technicians
  for each row execute function record_roster_event();

-- RLS-with-no-policy + explicit revoke (the office_messages posture,
-- 20260901150000): service_role bypasses RLS so the app and this trigger are
-- unaffected; anon/authenticated get zero rows and no writes. Roster history
-- names real people and when they left — and auto_expose_new_tables still
-- publishes every new table to the publishable key unless this says otherwise.
alter table roster_events enable row level security;
revoke all on roster_events from anon, authenticated;

-- The planner's lookup (the v_nudges posture, 20260823120000:121-123): the
-- standing tenant predicate, and the refs/names it needs to read a row without
-- a second query. Unlike office-message bodies, a firm's own roster history is
-- data its managers already own, so sharing SPINE_VIEW_CATALOG with
-- `query_spine` is acceptable here — the same acceptance v_observations
-- records.
create or replace view v_roster_events as
  select e.id,
         t.ref          as technician_ref,
         t.display_name as technician_name,
         t.tier,
         e.from_state,
         e.to_state,
         e.occurred_at
    from roster_events e
    join technicians t on t.id = e.technician_id
   where e.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_roster_events to spine_reader;
-- THE VIEW NEEDS ITS OWN REVOKE — the table's is not enough. `auto_expose_new_
-- tables` (supabase/config.toml) grants the publishable keys everything on every
-- new entity, VIEWS INCLUDED, and this view is not security_invoker, so it runs
-- as its owner: without this line the tenant predicate is the only thing between
-- a publishable key and every firm's roster history. Caught by the Phase-1 ACL
-- probe; v_observations' own header (20260901130000:110-114) says it outright —
-- "every spine view is revoked; this one must not be the outlier" — and this one
-- was, until the review found it.
revoke all on v_roster_events from anon, authenticated;
