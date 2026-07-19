-- Seat-exempt schedulable person (user decision 2026-07-19): a roster row that
-- is a NAME ON THE SCHEDULE and nothing more — bookable on visits, visible on
-- the board, but occupying NO purchased seat and never eligible for an agent
-- sandbox, Telegram binding, or email pairing (those verbs refuse the flag).
--
-- Seat-exempt rows neither occupy a seat nor trigger the cap check; flipping
-- seat_exempt OFF re-fires the check (it is in the trigger's update-of column
-- list) so graduation to a real seat is DB-correct even though no chat verb
-- exposes the flip yet.

alter table technicians add column seat_exempt boolean not null default false;

create or replace function enforce_seat_cap() returns trigger language plpgsql as $$
declare cap integer; used integer;
begin
  select case when new.tier = 'manager' then manager_seats else technician_seats end
    into cap from tenants where id = new.tenant_id;
  select count(*) into used from technicians
    where tenant_id = new.tenant_id and tier = new.tier
      and state not in ('offboarding', 'offboarded')
      and not seat_exempt and id <> new.id;
  if used >= cap then raise exception 'seat_cap_exceeded'; end if;
  return new;
end $$;

drop trigger technicians_seat_cap on technicians;
create trigger technicians_seat_cap
  before insert or update of state, tier, seat_exempt on technicians
  for each row when (new.state not in ('offboarding', 'offboarded') and not new.seat_exempt)
  execute function enforce_seat_cap();
