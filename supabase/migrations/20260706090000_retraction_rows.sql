-- Note lifecycle: Option-B retraction rows.
--   A mistake in append-only L1 is neutralized by APPENDING a capture with
--   channel 'retraction' whose retracts_capture_id points at the target row.
--   "Retracted" is a DERIVED property (a row is retracted iff a retraction
--   points at it) — no flag column, no update path, the append-only trigger
--   stays intact and automatically covers retraction rows too.
alter type capture_channel add value if not exists 'retraction';

alter table raw_captures add column retracts_capture_id uuid references raw_captures(id);

-- UNIQUE: at most one retraction per target, enforced structurally — a
-- concurrent double-retract must lose at insert time, not write a second
-- permanent row (both rows would be undeletable, and read paths annotate a
-- single retraction per target).
create unique index uq_raw_captures_one_retraction on raw_captures(retracts_capture_id)
  where retracts_capture_id is not null;
