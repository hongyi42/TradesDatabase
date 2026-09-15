-- One number, one match (2026-09-15, research 2026-09-15-the-retrieval-and-delivery-layer
-- Finding 13). findCustomersByPhone compared customers.phone as raw text, so
-- "(206) 555-0170", "206-555-0170" and a phone call's "+12065550170" were three
-- different people to the matcher: a known caller became a stranger and the
-- planner got an inbound_unmatched ask.
--
-- A STORED GENERATED KEY, not a rewrite of `phone` (operator, 2026-09-15): the
-- stored phone keeps whatever format it was given in, and every existing row is
-- keyed by this statement with no data migration. The key is the digits, with a
-- leading US country code dropped; fewer than 7 digits is no phone at all. A
-- number stored without its area code keys as its 7 digits and matches only
-- other 7-digit spellings — guessing an area code could name the wrong person.
--
-- [0-9], NOT \D: Postgres `\D` treats non-ASCII digits (fullwidth, Arabic-Indic)
-- as digits and can depend on the locale, while the TypeScript twin's JS `\D`
-- does not. The twin is src/db/phone.ts phoneKey(); src/db/phone.test.ts runs
-- every case through both.
--
-- Hand-applied to the pilot BEFORE merge: the Calls-worker auto-deploys at merge
-- and its matcher reads this column.
alter table customers add column phone_key text generated always as (
  case
    when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
     and regexp_replace(phone, '[^0-9]', '', 'g') like '1%'
      then substr(regexp_replace(phone, '[^0-9]', '', 'g'), 2)
    when length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 7
      then regexp_replace(phone, '[^0-9]', '', 'g')
  end
) stored;

create index idx_customers_tenant_phone_key on customers (tenant_id, phone_key)
  where phone_key is not null;
