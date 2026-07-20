-- Scheduling inputs (Plan 3a): the two data homes the fit-check needs that had
-- none — technician skills (the assignment qualification gate) and job priority
-- (the dispatcher triage tier).
--
-- skills: free vocabulary, stored trimmed+lowercased by the typed layer (the
-- service_cities idiom). SEMANTICS (recorded user decision 2026-07-20): an
-- empty list means "unknown", NOT "unqualified" — matching may only exclude a
-- person on a non-empty list that lacks the skill; unconfigured people remain
-- candidates flagged confirm-first. Configuration is optional per tenant.
alter table technicians add column skills text[] not null default '{}';

-- priority: closed vocabulary because scheduler code branches on it
-- (emergency → earliest slot; routine → morning bias; maintenance → the
-- sacrificial/bumpable layer). Default 'routine'; set at booking time.
create type job_priority as enum ('emergency', 'urgent', 'routine', 'maintenance');
alter table jobs add column priority job_priority not null default 'routine';
