-- Sandbox recycling (2026-07-12): a confirmed deactivation marks the person's
-- sandbox for retirement; the box destroys + re-provisions it and reports back.
--   retire_requested_at  set by deactivate_technician_seat; cleared by a
--                        grace-period reactivation (cancel). Served to the box
--                        via the badge pull's retirements[] until completed.
--   retired_at           set when the box reports completion — the row is kept
--                        forever (claim/audit history), never deleted.
--   retired_technician_id audit copy of the claim. technician_id itself is
--                        NULLED at completion: it is UNIQUE (one live sandbox
--                        per person), and releasing it lets a reactivated
--                        person claim a fresh blank after their old sandbox
--                        was destroyed.
alter table sandbox_pool
  add column retire_requested_at timestamptz,
  add column retired_at timestamptz,
  add column retired_technician_id uuid references technicians(id);
