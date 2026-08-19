-- The append-only guard named the WRONG TABLE (user-reported 2026-08-19).
--
-- raise_append_only() was written for raw_captures in the first migration
-- (20260620005307:25-32) and hardcodes 'raw_captures is append-only'. Two later
-- tables reuse it deliberately — schedule_events (20260714120000:48) and
-- money_events (20260815160000:53) — so blocking a money_events UPDATE reported
-- a table the writer had not touched. The BLOCK was always correct; only the
-- message lied, and it lied at exactly the wrong moment: someone debugging a
-- failed money write was pointed at L1.
--
-- TG_TABLE_NAME is populated by Postgres per trigger firing, so all three
-- tables now name themselves with no per-table duplication. No trigger is
-- redefined and no table is touched — create-or-replace on the function body
-- is picked up by the existing triggers.
--
-- Safe to change: nothing in src/ matches on the message text. The two tests
-- that assert this behaviour (schema.test.ts, scheduling.test.ts) assert the
-- write is REJECTED, not what it says.
create or replace function raise_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', TG_TABLE_NAME;
end;
$$;
