-- Rung 10c — A SEAT'S MESSAGE WAKES THE OFFICE, AND ACCESS NEWS STOPS LOOKING LIKE ONE.
--
-- Two additive pieces. Nothing here is destructive, and both are safe to apply
-- BEFORE the code that uses them — which is the deploy order (the 9b/9c and
-- rung 10 idiom): migration first, then lifecycle-heart, then the Calls worker.
--
--   1. office_messages.pinged_at — the claim. A 'to_planner' row has only
--      unread/read, and marking a row read to claim it would lose it if the
--      claiming pass then crashed. So the claim is its own stamp, the twin of
--      observations.pinged_at: the Calls worker's guarded claim, or a tick about
--      to show the row. It is a LEASE, not a read marker — a claim older than
--      OFFICE_CLAIM_LEASE_MS (src/teamLead/planner.ts) counts as abandoned and the
--      next tick takes the row back. No backfill: an unread row is at most one
--      tick old, and an unclaimed one is exactly what the tick already shows.
--   2. kind 'news' — an access decision told to the office (grant, decline,
--      revoke; src/mcp/tools/access.ts). It was written as 'inform', and only
--      'inform' wakes the office, so every grant would have woken a pass with
--      nothing to do. The writer knows the category for certain (operator,
--      2026-09-23), so it says so rather than leaving a model to guess.
--      'news' never wakes anything; the half-hourly tick still reads it unread.

-- ── 1. The claim ─────────────────────────────────────────────────────────────
alter table office_messages add column if not exists pinged_at timestamptz;

comment on column office_messages.pinged_at is
  'Rung 10c: a pass has CLAIMED this message (the Calls-worker''s guarded claim, or a tick about to show it). Separate from status on purpose: a crashed pass leaves it unread, and a claim older than OFFICE_CLAIM_LEASE_MS is treated as abandoned. Not a read marker.';

-- The ping loop's read: fleet-wide (the worker polls every tenant at once), so
-- deliberately no leading tenant_id. The predicate is a subset of
-- `listUnpingedOfficeMessages`'s WHERE, or the partial index goes unused.
create index if not exists idx_office_messages_unpinged
  on office_messages (created_at)
  where direction = 'to_planner' and status = 'unread' and pinged_at is null;

-- ── 2. The 'news' kind ───────────────────────────────────────────────────────
-- The check was declared inline at creation (20260901150000), so Postgres named
-- it office_messages_kind_check; replaced whole, the person_pushes_ops_kind shape.
alter table office_messages
  drop constraint if exists office_messages_kind_check;

alter table office_messages
  add constraint office_messages_kind_check
  check (kind in ('ask', 'inform', 'reply', 'desk', 'news'));

comment on column office_messages.kind is
  'Why the row exists: ask / inform / reply from a seat, desk transcript, or news (an access decision told to the office). Only inform wakes the office (rung 10c). Not authority.';
