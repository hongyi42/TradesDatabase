-- Technician visibility horizon (Plan 4a, user decision 2026-07-22): how far
-- ahead technician-tier schedule reads may see. Per-tenant because the right
-- horizon depends on the firm (fast-filling vs slow schedules); the manager
-- tunes it from chat via set_technician_horizon (weeks). Beyond the horizon
-- the schedule is fluid (pre-freeze) and unpublished to technicians; managers
-- are never clamped. CHECK bounds mirror the tool's 1-12 week range.
alter table tenants add column technician_horizon_days int not null default 28
  check (technician_horizon_days between 7 and 84);
