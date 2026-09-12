-- THE CUSTOMER-LEVEL LINK — the twin of job_captures, one rung UP.
--
-- Additive and safe to apply before the code that uses it (the 9b/9c/rung-10
-- idiom): migration first, then the services. Nothing writes to this table
-- until the door stops guessing a job (plan 2026-09-11-the-door-stops-guessing).
--
-- WHY A TABLE AND NOT raw_captures.customer_id — the same reason job_captures is
-- a table (20260908100000), and it is the whole reason this rung exists. The L1
-- row is inserted BEFORE identity resolves, and L1 can never be updated
-- afterwards, so an inbound capture can never be stamped with the customer it
-- turned out to belong to. The column exists and is written at insert only
-- (src/db/rawCaptures.ts:90) — it serves the staged-confirm path, where identity
-- IS known first, and is null for every inbound capture by construction.
--
-- WHAT IT IS FOR. Until now the only homes a capture could be given after the
-- fact were a JOB (job_captures) and a TRIP (visit_notes). So a door that could
-- not tell which job a message was about had to pick one anyway — the newest
-- non-terminal — or the capture would be linked to nothing and invisible to
-- every evidence reader. That guess filed a dated promise on unrelated work and
-- the ask was then suppressed (finding 20260911-a-new-promise-to-a-known-
-- customer-is-fil). This table makes "I know WHO, not WHICH" a sayable answer.
--
-- WHAT IT IS NOT. It is NOT a citation: listL2CitingCapture deliberately does
-- not read it, because "filed under this customer" is no answer to "did anyone
-- book the visit we promised?" — the same rule the jobs arm there already
-- applies to cancelled shells. It IS a processed-marker (captureHasLinkedL2)
-- and a retraction target, or a redelivery would re-run the extractor and a
-- retraction would not follow its target onto this link.
create table customer_captures (
  tenant_id   uuid not null references tenants(id),
  customer_id uuid not null references customers(id) on delete cascade,
  capture_id  uuid not null references raw_captures(id),
  created_at  timestamptz not null default now(),
  primary key (customer_id, capture_id)
);

create index idx_customer_captures_capture on customer_captures(capture_id);
create index idx_customer_captures_tenant_customer on customer_captures(tenant_id, customer_id);

-- APPEND-ONLY ON UPDATE ONLY, exactly as job_captures and visit_notes: a link,
-- once made, is never silently re-pointed at a different customer. DELETE stays
-- open or the `on delete cascade` above would raise instead of cascading, and a
-- customer would become undeletable the moment they emailed — the "L1 pins L2"
-- trap. The evidence itself is untouched: the capture stays in raw_captures
-- forever.
create trigger customer_captures_append_only
  before update on customer_captures
  for each row execute function raise_append_only();

-- The door stays shut. auto_expose_new_tables (supabase/config.toml) grants the
-- publishable keys SELECT on every NEW table unless the migration says
-- otherwise, and the server holds only the service_role key, which bypasses
-- RLS. Both halves, the job_captures posture (20260908100000): either alone
-- leaves the Data API a door.
revoke all on customer_captures from anon, authenticated;
alter table customer_captures enable row level security;

-- The read surface — the v_job_captures twin, including its tenant wall.
--
-- `customer_id` IS an id-only foreign key, so `customers` is exactly the second
-- table whose tenant could disagree: a row stamped with OUR tenant_id pointing
-- at another firm's customer passes a filter on `c.tenant_id` alone. The
-- TypeScript reader re-checks (src/db/context.ts), but this view's consumer
-- writes raw SQL and cannot, which is why v_job_captures puts the wall here —
-- and why this one does too.
create view v_customer_captures as
  select c.customer_id,
         c.capture_id,
         c.created_at
    from customer_captures c
    join customers cu on cu.id = c.customer_id
   where c.tenant_id = current_setting('spine.tenant_id')::uuid
     and cu.tenant_id = c.tenant_id;

grant select on v_customer_captures to spine_reader;
revoke all on v_customer_captures from anon, authenticated;
