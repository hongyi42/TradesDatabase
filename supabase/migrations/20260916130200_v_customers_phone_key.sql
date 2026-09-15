-- The planner can look a caller up by NUMBER, not spelling (2026-09-15, operator).
--
-- 20260916130100 gave customers a phone_key (digits, leading US 1 dropped) and
-- moved the code-side lookups onto it, but the planner reads customers through
-- v_customers with spine_read, which exposed only the raw phone — so
-- `where phone = '+12065550170'` still missed a customer stored as
-- "(206) 555-0170". The key rides along at the END of the column list
-- (create or replace view can only append), and the catalog in
-- src/mcp/server.ts tells the planner to compare on it.
--
-- Hand-applied to the pilot BEFORE merge, after 20260916130100.
create or replace view v_customers as
  select c.id,
         c.name,
         c.phone,
         c.email,
         c.address_line1,
         c.city,
         c.state,
         c.postal_code,
         c.created_at,
         c.phone_key
    from customers c
   where c.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_customers to spine_reader;
revoke all on v_customers from anon, authenticated;
