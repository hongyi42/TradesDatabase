-- Unplaced visits (Plan 4b-2): a visit may hold a DAY (or a range of days)
-- with no time yet. Times arrive when a manager or the freeze places it.
alter table assignments alter column starts_at drop not null;
alter table assignments alter column ends_at   drop not null;
alter table assignments add column earliest_date date;
alter table assignments add column latest_date   date;

-- A row is PLACED (both times, no range) or UNPLACED (range, no times).
-- Never half of each: a half-filled row would read as placed to some surfaces
-- and unplaced to others. The pre-existing `assignments_check
-- CHECK ((ends_at > starts_at))` needs no change — a CHECK is satisfied when
-- it evaluates to NULL (verified against the local stack, plan review).
alter table assignments add constraint assignment_placed_or_windowed check (
  (starts_at is not null and ends_at is not null
     and earliest_date is null and latest_date is null)
  or
  (starts_at is null and ends_at is null
     and earliest_date is not null and latest_date is not null
     and latest_date >= earliest_date)
);

-- Narrow the double-booking guard to PLACED rows: tstzrange(null,null) is
-- unbounded and overlaps everything, so an unplaced row left inside would
-- block that technician's entire calendar. Placed rows keep today's
-- protection EXACTLY — the only change is the `starts_at is not null`
-- predicate. The constraint was created inline but NAMED, so drop resolves.
alter table assignments drop constraint no_confirmed_overlap;
alter table assignments add constraint no_confirmed_overlap exclude using gist
  (technician_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status = 'confirmed' and starts_at is not null);
