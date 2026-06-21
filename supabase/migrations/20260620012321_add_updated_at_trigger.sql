-- Maintain updated_at in the database so every update path is correct without
-- the application having to remember to stamp it. Applies to the two L2 tables
-- that carry updated_at (customers, jobs); visits has no updated_at.

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();

create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();
