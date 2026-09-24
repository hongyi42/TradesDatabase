-- Step 3 (plan 2026-09-23-step-3-office-reaches-glue-seats): a glue seat pulls its
-- own person's office items from /seat/inbox, and every pull stamps the seat live.
--
-- WHY A STAMP AND NOT THE SEATS ROW ITSELF. The box's bash runners pull the same
-- items per HOST, so while a glue is pulling they must skip its person — or one
-- item is served (and counted) twice. Keying that on "has a live seats row"
-- would break rollback: rollback.sh stops the glue but keeps the row, and the
-- person's items would then go to a glue that is no longer running. A stamp
-- ages out on its own (the host pull skips only seats pulled in the last
-- 120 s), so a stopped glue hands its items back to openclaw with no step.
--
-- Additive and safe to apply BEFORE the code: the host pull's read treats a
-- missing column as "no live glue seats" (src/db/seats.ts).

alter table seats add column last_pulled_at timestamptz;

create index seats_host_pulled_idx on seats (host_id, last_pulled_at) where retired_at is null;
