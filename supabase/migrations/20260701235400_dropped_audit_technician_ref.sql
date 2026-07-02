-- Person attribution for drop receipts: with per-person pairing (N connected
-- inboxes per tenant), external_id alone no longer identifies WHICH mailbox to
-- re-fetch a misclassified message from (Gmail message ids are mailbox-local).
alter table dropped_audit add column technician_ref text;
