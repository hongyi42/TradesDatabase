-- Firm profile (plan 2026-08-15-firm-profile-v1): the business-identity record
-- a customer-facing document prints — names, address, phone, email, contractor
-- license numbers, and a free-text disclosure footer (state rules like the TX
-- TDLR paragraph live in DATA, not code — workflow-agnostic by principle).
-- 1:1 with tenants, split from the hot tenants row (read on every timezone
-- lookup) because it is edited/validated as a unit and read on every future
-- document render. All fields optional BY DESIGN: display requirements are
-- state-specific, so gaps WARN in code (profileGaps), never block here.

create table tenant_profiles (
  tenant_id         uuid primary key references tenants(id),
  display_name      text,
  legal_name        text,
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  postal_code       text,
  phone             text,
  email             text,
  -- Array of {label, number} — firms hold several licenses (trade + state
  -- variants); a single scalar column would be the one-number mistake again.
  license_numbers   jsonb not null default '[]'::jsonb,
  disclosure_footer text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger tenant_profiles_set_updated_at
  before update on tenant_profiles
  for each row execute function set_updated_at();

-- Manager-queryable view (query_spine): same tenant-GUC filter as v_schedule /
-- v_money_events. Without it, an ad-hoc "what address do we have on file?"
-- through query_spine would die on a permission error instead of answering —
-- the posture its precedent pairs with (review finding). tenant_id itself is
-- not exposed (the GUC already scopes it); created_at is plumbing, updated_at
-- answers "when did we last change this".
create view v_firm_profile as
  select p.display_name,
         p.legal_name,
         p.address_line1,
         p.address_line2,
         p.city,
         p.state,
         p.postal_code,
         p.phone,
         p.email,
         p.license_numbers,
         p.disclosure_footer,
         p.updated_at
    from tenant_profiles p
   where p.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_firm_profile to spine_reader;

-- RLS-with-no-policy + explicit revoke (money_events / cost-tables posture):
-- service_role bypasses RLS so the app is unaffected; anon/authenticated get
-- zero rows and no writes. Belt-and-braces against auto_expose_new_tables
-- publishing the table to the publishable key — this row is what invoices
-- will PRINT, so a forged write would put attacker-chosen text (a wrong
-- license number, a tampered disclosure footer) on customer-facing documents.
alter table tenant_profiles enable row level security;
revoke all on tenant_profiles from anon, authenticated;
