-- Money event ledger (plan 2026-08-15-money-ledger-v1, Phase 1).
--
-- One row = one money FACT about a job (fee, estimate, approval, change order,
-- invoice, payment, credit, write-off). Append-only: a mistake is corrected by
-- a NEW row ('correction' / 'invoice_voided') referencing its target — the
-- accounting convention, and the schedule_events immutability posture. All
-- money STATE (quoted / invoiced / paid / balance due) is DERIVED in code by
-- folding events (src/db/moneyEvents.ts) — never stored, never enforced as a
-- workflow. Workflow-agnostic by ratified principle (engineering-memory §2):
-- different firms' chains are different event ORDERINGS over this one schema.

create type money_event_kind as enum (
  'fee_charged',
  'estimate_presented',
  'estimate_approved',
  'estimate_declined',
  'change_order',
  'invoice_issued',
  'invoice_voided',
  'payment_received',
  'payment_refunded',
  'credit_applied',
  'write_off',
  'correction'
);

create table money_events (
  id                bigint generated always as identity primary key,
  tenant_id         uuid not null references tenants(id),
  -- RESTRICT: a financial record blocks deleting its job (and transitively the
  -- customer cascade) — consistent with L1-stamped rows being undeletable.
  job_id            uuid not null references jobs(id) on delete restrict,
  kind              money_event_kind not null,
  -- Direction comes from `kind`, never sign. Null only where the kind carries
  -- no amount (estimate_declined) — enforced in the typed layer.
  amount_cents      integer check (amount_cents is null or amount_cents >= 0),
  currency          text not null default 'USD',
  occurred_at       timestamptz not null default now(),
  actor_ref         text,
  source_capture_id uuid references raw_captures(id),
  corrects_event_id bigint references money_events(id),
  method            text,
  external_ref      text,
  dedupe_key        text,
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

-- Append-only enforced by the DATABASE, not convention (raw_captures /
-- schedule_events precedent — reuses the shared guard).
create trigger money_events_append_only
  before update or delete on money_events
  for each row execute function raise_append_only();

-- Idempotency for inferred / spine-generated events (cost_events precedent):
-- writers mint the key; a replay collides on 23505 and converges.
create unique index uq_money_events_dedupe
  on money_events (tenant_id, dedupe_key)
  where dedupe_key is not null;

create index idx_money_events_tenant on money_events (tenant_id, id desc);
create index idx_money_events_job on money_events (job_id, id);

-- Manager-queryable view (query_spine): same tenant-GUC filter as v_schedule.
-- detail/dedupe_key/source_capture_id deliberately excluded — the view is for
-- money questions, not plumbing.
create view v_money_events as
  select m.id,
         m.job_id,
         j.title as job_title,
         c.id    as customer_id,
         c.name  as customer_name,
         m.kind,
         m.amount_cents,
         m.currency,
         m.occurred_at,
         m.actor_ref,
         m.corrects_event_id,
         m.method,
         m.external_ref
    from money_events m
    join jobs j      on j.id = m.job_id
    join customers c on c.id = j.customer_id
   where m.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_money_events to spine_reader;

-- RLS-with-no-policy + explicit revoke (cost-tables precedent, 20260725140000;
-- phone-ingest precedent, 20260804120000): service_role bypasses RLS, so the
-- app is unaffected; anon/authenticated get zero rows and no insert. This is
-- belt-and-braces against auto_expose_new_tables publishing the table to the
-- publishable key — a forged payment row would fold a balance to zero, drive a
-- status walk, and be UNDELETABLE (append-only trigger). Review finding
-- 2026-08-15: the guard was missing from this migration's first draft.
alter table money_events enable row level security;
revoke all on money_events from anon, authenticated;
revoke all on sequence money_events_id_seq from anon, authenticated;
