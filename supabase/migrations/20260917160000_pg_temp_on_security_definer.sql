-- pg_temp goes LAST on every security definer function (retrieval-layer cleanup).
--
-- A `security definer` function runs with its OWNER's rights, so what an
-- unqualified name inside its body resolves to is a privilege question, not a
-- style one. `set search_path = public` looks complete and is not: when pg_temp
-- is not named, Postgres searches it FIRST, ahead of everything. A caller who
-- can create a temporary table could then put `pg_temp.raw_captures` in front of
-- the real table and have the function read it with the owner's rights. Naming
-- pg_temp explicitly, LAST, puts it after public where it can shadow nothing.
--
-- Flagged by plan 3's final review, which fixed its own three functions
-- (gap_evidence, job_activity_since, capture_records) and recorded the rest as
-- owed. `query_spine` already had it. These eight are the remainder of the
-- estate, read from `pg_proc` on 2026-09-17 rather than counted out of the
-- migration files — the files say NINE because plan 2 re-creates four of plan
-- 1's readers, which are the same four functions, not four more:
--
--   capture_full / captures_page / customer_contents / search_captures
--       plan 1 (20260916120000), re-created by plan 2 (20260917120000)
--   technician_view_of                  plan 2 (20260917120000)
--   review_queue_page                   plan 4 (20260917140000)
--   rollup_costs / tenant_cost_detail   older, outside the ladder, same hazard
--
-- ALTER, not `create or replace`: the search path is function metadata, so this
-- touches no body and cannot drift from what each function actually does. The
-- catch to know about — whoever next re-creates one of these must carry
-- `, pg_temp` with it, because a `create or replace` that omits it silently
-- undoes this migration with no error and no diff anyone would notice.

alter function capture_full(
  p_tenant uuid, p_capture uuid, p_caller_tier text, p_include_retracted boolean,
  p_terminal_statuses text[], p_viewer uuid
) set search_path = public, pg_temp;

alter function captures_page(
  p_tenant uuid, p_scope text, p_scope_id uuid, p_caller_tier text,
  p_before_at timestamptz, p_before_id uuid, p_limit integer, p_text_chars integer,
  p_include_retracted boolean, p_terminal_statuses text[], p_viewer uuid
) set search_path = public, pg_temp;

alter function customer_contents(
  p_tenant uuid, p_customer uuid, p_caller_tier text, p_recent_jobs integer,
  p_snippet_chars integer, p_terminal_statuses text[], p_viewer uuid
) set search_path = public, pg_temp;

alter function search_captures(
  p_tenant uuid, p_scope text, p_scope_id uuid, p_query text, p_caller_tier text,
  p_limit integer, p_snippet_chars integer, p_terminal_statuses text[], p_viewer uuid
) set search_path = public, pg_temp;

alter function technician_view_of(
  p_tenant uuid, p_technician uuid, p_terminal_statuses text[]
) set search_path = public, pg_temp;

alter function review_queue_page(
  p_tenant uuid, p_kind text, p_after_created timestamptz, p_after_id uuid,
  p_limit integer, p_detail_chars integer
) set search_path = public, pg_temp;

alter function rollup_costs(p_period_start date) set search_path = public, pg_temp;

alter function tenant_cost_detail(
  p_tenant_id uuid, p_period_start date
) set search_path = public, pg_temp;
