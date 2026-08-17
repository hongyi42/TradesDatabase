-- Phase-3 review F5: make the `spine:` identity-namespace reservation
-- STRUCTURAL. The dispatch ceiling assumes no `spine:*` ref can ever be a
-- roster row (a roster row would give it a tier, flip activeManager /
-- dropSensitive, and — worse — satisfy the Composio relay's row-exists check,
-- the one tool-execution path that routes around dispatch()). slugify only
-- protects the product path; insertTechnician and operator scripts accept
-- arbitrary refs, so the database must refuse what the ceiling assumes away.
-- (`connector:` is a capture-attribution namespace, never a roster ref — the
-- inbound webhook rejects it — so only `spine:` needs reserving here.)
alter table technicians
  add constraint technicians_ref_not_spine check (ref not like 'spine:%');
