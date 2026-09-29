-- Invoices and estimates as records (plan 2026-09-29-step-2e-invoices-estimates, Phase 1).
--
-- A money document is ONE record type with two kinds (invoice | estimate): lines,
-- a total, a number, a status. A draft is editable and carries no number; issuing
-- (the manager says it is final) gives it the firm's next number and writes the
-- ledger row (invoice_issued / estimate_presented) — the ledger stays the one
-- source of money truth, this table is the document behind the row. An issued
-- document changes only by void or (estimates) its outcome.

create table money_documents (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  kind            text not null check (kind in ('invoice', 'estimate')),
  -- RESTRICT, like the ledger: a job with a document behind its money is not deletable.
  job_id          uuid not null references jobs(id) on delete restrict,
  -- Stamped from the job at every save (the job's customer is the bill-to).
  customer_id     uuid not null references customers(id),
  status          text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  -- Per firm and kind: INV-1001…, EST-1001…. Drafts have none (the PDF says DRAFT).
  number_seq      integer check (number_seq is null or number_seq > 0),
  number          text,
  -- [{description, quantity, unitCents, amountCents}] — validated in the typed layer.
  lines           jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  total_cents     integer not null default 0 check (total_cents >= 0),
  notes           text,
  -- The ledger row that issuing wrote. Null on an issued document = the ledger
  -- write has not landed yet; a second issue retries it (dedupe_key makes it safe).
  money_event_id  bigint references money_events(id),
  -- A progress (deposit) invoice: set with the number at issue, and the ledger
  -- row's detail.progress is written FROM this, so a retry cannot flip it.
  progress        boolean not null default false,
  outcome         text,
  void_reason     text,
  created_by_ref  text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  issued_at       timestamptz,
  voided_at       timestamptz,
  outcome_at      timestamptz,
  constraint money_documents_outcome_check
    check (outcome is null or (kind = 'estimate' and outcome in ('accepted', 'declined'))),
  constraint money_documents_number_iff_issued check ((status = 'draft') = (number_seq is null)),
  constraint money_documents_number_pair check ((number is null) = (number_seq is null))
);

create unique index uq_money_documents_number
  on money_documents (tenant_id, kind, number_seq)
  where number_seq is not null;
create index idx_money_documents_job on money_documents (tenant_id, job_id);

create trigger money_documents_set_updated_at
  before update on money_documents
  for each row execute function set_updated_at();

alter table money_documents enable row level security;
revoke all on money_documents from anon, authenticated;

-- ── Each kind's starting number (set through set_firm_profile) ──────────────
alter table tenant_profiles
  add column invoice_start integer not null default 1001 check (invoice_start > 0),
  add column estimate_start integer not null default 1001 check (estimate_start > 0);

-- ── Files hang on documents (the 2d pattern) ────────────────────────────────
alter table file_links
  add column document_id uuid references money_documents(id) on delete cascade;
-- SAME name: files.test.ts matches it.
alter table file_links drop constraint file_links_one_target;
alter table file_links add constraint file_links_one_target
  check (num_nonnulls(customer_id, job_id, visit_id, money_event_id, document_id) = 1);
create unique index uq_file_links_document on file_links (file_id, document_id) where document_id is not null;
create index idx_file_links_document on file_links (document_id) where document_id is not null;

-- ── Files from the manager's sent email ─────────────────────────────────────
-- source_ref = gmail:<messageId>:<attachmentId>: a redelivered webhook cannot
-- store the same attachment twice.
alter table files drop constraint files_source_check;
alter table files add constraint files_source_check check (source in ('telegram', 'sandbox', 'email'));
alter table files add column source_ref text;
create unique index uq_files_source_ref on files (tenant_id, source_ref) where source_ref is not null;

-- ── capture_records gains a money arm ───────────────────────────────────────
-- A LIVE ledger row citing the capture (source_capture_id) is an answer to it —
-- the office sees "record this invoice?" answered. INSIDE the function, not in
-- the capture_membership view (the seat readers use that). A row since voided or
-- corrected is not an answer, as a cancelled job is not. Every other arm, the
-- signature, the return shape and the search path are unchanged
-- (20260917130100_planner_capture_readers.sql; pg_temp LAST, 20260917160000).
create or replace function capture_records(
  p_tenant uuid,
  p_capture_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp -- see gap_evidence
stable
as $$
begin
  return jsonb_build_object(
    'records', (
      select coalesce(jsonb_agg(r.rec order by r.capture_id, r.via, r.job_id, r.visit_id, r.customer_id, r.money_id), '[]'::jsonb)
        from (
          select m.capture_id, m.via, m.job_id, m.visit_id, m.customer_id, null::bigint as money_id,
                 jsonb_build_object(
                   'capture_id', m.capture_id,
                   'via', m.via,
                   'customer_id', m.customer_id,
                   'job_id', m.job_id,
                   'visit_id', m.visit_id
                 ) as rec
            from capture_membership m
            left join jobs j on j.id = m.job_id and j.tenant_id = m.tenant_id
            left join visits v on v.id = m.visit_id and v.tenant_id = m.tenant_id
           where m.tenant_id = p_tenant
             and m.capture_id = any(coalesce(p_capture_ids, '{}'::uuid[]))
             and m.via in ('created_customer', 'created_job', 'created_visit', 'job_link', 'visit_note')
             and not (m.via in ('created_job', 'job_link') and j.status = 'cancelled')
             and not (m.via in ('created_visit', 'visit_note') and v.status = 'cancelled')
          union all
          select e.source_capture_id, 'money', e.job_id, null::uuid, null::uuid, e.id,
                 jsonb_build_object(
                   'capture_id', e.source_capture_id,
                   'via', 'money',
                   'customer_id', null,
                   'job_id', e.job_id,
                   'visit_id', null,
                   'id', e.id::text
                 )
            from money_events e
           where e.tenant_id = p_tenant
             and e.source_capture_id = any(coalesce(p_capture_ids, '{}'::uuid[]))
             and e.kind not in ('invoice_voided', 'correction')
             and not exists (
               select 1 from money_events x
                where x.tenant_id = e.tenant_id
                  and x.corrects_event_id = e.id
                  and x.kind in ('invoice_voided', 'correction')
             )
        ) r
    ),
    'retracted', (
      select coalesce(jsonb_agg(c.id order by c.id), '[]'::jsonb)
        from raw_captures c
       where c.tenant_id = p_tenant
         and c.id = any(coalesce(p_capture_ids, '{}'::uuid[]))
         and exists (select 1 from raw_captures r where r.retracts_capture_id = c.id)
    )
  );
end;
$$;

-- The money arm looks rows up by the capture they cite; nothing indexed that before.
create index idx_money_events_source_capture on money_events (tenant_id, source_capture_id)
  where source_capture_id is not null;

-- create or replace keeps the existing grants; restated so this file reads whole.
revoke all on function capture_records(uuid, uuid[]) from public, anon, authenticated;
grant execute on function capture_records(uuid, uuid[]) to service_role;
