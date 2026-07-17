-- Technician-optional bookings (Feature A, Fix 1): a visit may sit on the
-- calendar with NOBODY attached ("book it now, assign someone later").
--
-- Dropping NOT NULL is the whole change. The two constraints that reference
-- technician_id both do the right thing with NULL on their own:
--   - the FK to technicians simply does not apply to NULL rows;
--   - the no_confirmed_overlap exclusion guard (technician_id WITH =) never
--     matches NULL against anything, so two unassigned visits at the same time
--     do NOT collide — correct: there is no technician to double-book. The
--     guard re-engages the moment a technician is attached (move_visit).
-- Unassigned rows are surfaced by get_team_schedule (unassigned:true) and the
-- listUnassignedAssignments recall read; they are invisible to per-technician
-- readers (get_schedule, identity matching) by construction.

alter table assignments alter column technician_id drop not null;
