-- RUNG 10B — ONE CUSTOMER PER CALL, ENFORCED BY THE DATABASE.
--
-- `record_caller` is the first tool that lets the planner create a customer, and
-- it guards against minting twins by READING what already cites the capture
-- (listL2CitingCapture) before it writes. A read is not a lock: the window
-- between that read and the insert spans a live extractor round trip, and the
-- tool loop's deadline is a `Promise.race` — the losing call keeps running while
-- the model, told the tool timed out, retries. Two customers for one caller then
-- both cite the same capture, and a duplicate person on the record is the one
-- kind of mistake a firm's staff meet every day afterwards.
--
-- CUSTOMERS ONLY, and the asymmetry is deliberate. `bookVisit` mints a job shell
-- and, when the DB overlap guard fires, rolls it back by flipping it to
-- 'cancelled' — the `source_capture_id` stamp STAYS (listL2CitingCapture's jobs
-- arm exists to ignore exactly those rows). A unique index on
-- jobs.source_capture_id would therefore refuse the legitimate retry after a
-- rollback. The pilot already carries one such pair. Nothing rolls back a
-- customer, so it has no equivalent case: verified 2026-09-08 against the pilot
-- (78 customers cite a capture, zero duplicates).
create unique index if not exists uq_customers_one_per_capture
  on customers (source_capture_id)
  where source_capture_id is not null;

comment on index uq_customers_one_per_capture is
  'Rung 10b: at most one customer may be created from any one capture. The read-based guard in record_caller is not a lock; this is.';
