-- Content-free audit trail for classify-before-L1 drops.
-- When the work/personal classifier drops a non-work email, the email itself is
-- NOT retained (that is the whole point of gating before append-only L1 — personal
-- mail must not be stored). Instead we record a metadata-only "receipt": enough to
-- DETECT systematic mis-drops (e.g. dropped mail from a known customer's domain) and
-- to RE-FETCH the original from the source (Gmail) by external_id if a human owner
-- later recovers it — but NO body, NO subject text, NO full sender address.
--
-- Unlike raw_captures, this table is MUTABLE and purgeable (no append-only trigger):
-- it holds no ground-truth, only short-lived audit pointers.
create table dropped_audit (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id),
  channel           capture_channel not null,
  external_id       text,              -- the source's id → re-fetch handle (the "pointer")
  sender_domain     text,              -- domain only, e.g. "acme.com" — NOT the full address
  classifier_reason text,              -- the model's short reason string (no email content)
  dropped_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '30 days')  -- purge horizon
);

-- One audit row per dropped message, per tenant — re-delivery / overlapping pull
-- windows upsert to a no-op instead of piling up duplicate receipts.
create unique index uq_dropped_audit_external_id
  on dropped_audit (tenant_id, external_id) where external_id is not null;
create index idx_dropped_audit_tenant        on dropped_audit(tenant_id);
create index idx_dropped_audit_sender_domain on dropped_audit(sender_domain);
