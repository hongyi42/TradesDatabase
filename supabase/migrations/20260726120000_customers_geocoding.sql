-- Plan 4b-3 Phase 2: solver coordinates for customers.
-- Google's Route Optimization API takes lat/lng (or place IDs) only — never
-- free-text addresses — so the freeze needs stored coordinates. Real columns,
-- not L3 attributes: solver hot path, structural not elastic (plan decision).
-- All nullable; null = not yet geocoded, or the address was unlocatable (left
-- null so the next solve retries after an address fix). Filled LAZILY the
-- first time a solve needs the customer (src/routes/geocode.ts), never on
-- create. Any future writer of the address columns must also null these three
-- in the same update (no such writer exists as of 2026-07-26 — audited).
alter table customers
  add column lat double precision,
  add column lng double precision,
  add column geocoded_at timestamptz;
