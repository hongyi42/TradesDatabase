-- Person attribution for L1 captures: who this capture came from (badge-mapped
-- technician ref, or `connector:<toolkit>` for unattributed connector captures).
-- Nullable: raw_captures is append-only (no UPDATE path), so pre-existing rows
-- cannot be backfilled and stay NULL.
alter table raw_captures add column technician_ref text;
