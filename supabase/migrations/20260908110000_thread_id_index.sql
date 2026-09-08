-- RUNG 10B — THE EMAIL THREAD BECOMES AN IDENTITY KEY, AND ITS READ IS ON THE
-- HOT PATH. `findCustomersByThread` (src/db/rawCaptures.ts) runs inside the
-- inbound webhook request, once per threaded email:
--
--   select id, customer_id, job_id from raw_captures
--    where tenant_id = $1 and metadata->>'threadId' = $2
--
-- Nothing could serve that filter: raw_captures is indexed on tenant_id,
-- external_id and the three provenance columns only, and a jsonb `->>` is an
-- EXPRESSION, so the planner falls back to re-reading every capture the tenant
-- has ever taken. L1 is append-only, so that set only ever grows — the read gets
-- slower every day it runs, which is the worst shape a hot-path read can have.
--
-- PARTIAL on the key's presence: only inbound email carries a threadId (calls,
-- technician notes and photos never do), so the index stays a fraction of the
-- table. `metadata->>'threadId' is not null` rather than the `?` operator so the
-- predicate reads the same way as the query it serves.
--
-- Composite, tenant first: every caller is tenant-scoped, and the tenant column
-- is what keeps one firm's threads out of another's lookup.
create index if not exists idx_raw_captures_thread_id
  on raw_captures (tenant_id, (metadata ->> 'threadId'))
  where metadata ->> 'threadId' is not null;

comment on index idx_raw_captures_thread_id is
  'Rung 10b: serves the thread identity key (findCustomersByThread), read inside the inbound webhook request. Partial — only email captures carry metadata.threadId.';
