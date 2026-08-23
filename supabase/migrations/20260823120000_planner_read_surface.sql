-- ④ The brain can look (plan 2026-08-23): four views join the spine_read /
-- query_spine surface, so the planner can read what people said, the trips
-- those words belong to, its own questions, and the manager's queue.
--
-- THIS EXERCISES DECISION B's REVISIT CLAUSE (query-spine design, 2026-08-04):
-- raw_captures was excluded "until a real question requires it, and treat that
-- as its own decision". The question arrived — since 2026-08-22 the planner
-- CLOSES gaps on evidence, and it could not read the evidence. The supersession
-- is recorded in thoughts/shared/research/2026-08-23-the-brain-can-look.md.
--
-- The containment mechanism is UNCHANGED and is the whole point of doing this
-- as views: spine_reader still holds NO base-table grant (20260806120000:52).
-- Views are owned by postgres and run with the OWNER's privileges, so the role
-- reads exactly the columns each view names and can never reach a base table.
-- Columns are named ONE BY ONE, never `select *` (the founding rule) —
-- v_captures deliberately omits metadata, blob_path and external_id;
-- v_review_items deliberately omits raw detail (a pending_freeze plan embeds
-- hundreds of staged rows — the same reason list_pending_reviews summarizes).
--
-- SENSITIVITY IS NOT FILTERED (user ruling 2026-08-23: the planner is the
-- central intelligence and reads everything; managers reaching this via
-- query_spine already hold the same data through list_recent_captures).
-- RETRACTIONS ARE A LABELED TRAIL, not a fold (user ruling, same day): a
-- retracted row comes back marked, with the retraction's reason, so a reader
-- can tell a withdrawn record from a true one. The left join cannot fan out:
-- uq_raw_captures_one_retraction is a unique partial index on
-- retracts_capture_id, so a capture has at most one retraction.

create view v_captures as
  select c.id,
         c.captured_at,
         c.channel,
         c.technician_ref,
         c.customer_id,
         -- The DIRECT stamp only, and usually NULL by design: identity resolves
         -- AFTER the immutable L1 append, so a note's durable job link lives on
         -- its visit (v_visits.source_capture_id). The catalog says so, loudly —
         -- filtering v_captures by job_id alone reads as "nobody said anything"
         -- on exactly the jobs where somebody did.
         c.job_id,
         c.raw_text,
         c.sensitivity,
         c.retracts_capture_id,  -- non-null = this row IS a retraction
         (r.id is not null)  as retracted,
         r.raw_text          as retraction_reason,
         r.captured_at       as retracted_at
    from raw_captures c
    left join raw_captures r
      on r.retracts_capture_id = c.id
     and r.tenant_id = c.tenant_id
   where c.tenant_id = current_setting('spine.tenant_id')::uuid;

-- The note→job bridge, and the first read anyone has over spine visits.
-- Kept as its OWN view rather than a join column inside v_captures because
-- visits→capture is not unique-enforced — a hidden join could fan the capture
-- list out; an explicit join in the reader's SQL keeps the cardinality theirs.
create view v_visits as
  select v.id,
         v.job_id,
         v.source_capture_id,
         v.technician_name,
         v.labor_hours,
         v.created_at
    from visits v
   where v.tenant_id = current_setting('spine.tenant_id')::uuid;

-- The planner's own questions and how each ended. This is what finally gives
-- nudges.resolution a reader (the ③ fail-safe's audit line had none), and what
-- lets the planner see its gaps as DATA instead of only as the pre-rendered
-- blocks code pushes at it. nudge_decisions stays deliberately view-less: this
-- catalog is shared with the manager's query_spine, and a view there would hand
-- every manager the planner's deliberations (src/mcp/server.ts, the
-- recall_decisions comment).
--
-- job_id is a SAFE CAST (the SQL twin of safeJobId, src/db/nudgeDecisions.ts):
-- context is watcher-written JSON, and a bare ::uuid over a malformed value
-- would throw for the WHOLE query. ~* (case-insensitive) matching the code twin.
create view v_nudges as
  select n.id,
         n.kind,
         n.status,
         n.subject_ref,
         t.ref          as technician_ref,
         t.display_name as technician_name,
         case when n.context->>'jobId'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (n.context->>'jobId')::uuid end as job_id,
         n.question,
         n.resolution,
         n.answered_by_capture_id,
         n.not_before,
         n.escalate_after,
         n.created_at,
         n.queued_at,
         n.asked_at,
         n.resolved_at,
         n.serve_count,
         n.attempts
    from nudges n
    left join technicians t on t.id = n.technician_id
   where n.tenant_id = current_setting('spine.tenant_id')::uuid;

-- The manager's queue. status='open' is what nobody has acted on — 85 rows on
-- the pilot the day this shipped, none ever resolved; making that VISIBLE to
-- the planner is half the reason this view exists.
create view v_review_items as
  select i.id,
         i.kind,
         i.status,
         i.subject_ref,
         i.suggestion,
         i.resolution,
         case when i.detail->>'jobId'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (i.detail->>'jobId')::uuid end as job_id,
         i.detail->>'technicianRef'       as technician_ref,
         i.detail->>'escalatedFromNudge'  as escalated_from_nudge,
         i.created_at,
         i.resolved_at
    from review_items i
   where i.tenant_id = current_setting('spine.tenant_id')::uuid;

grant select on v_captures, v_visits, v_nudges, v_review_items to spine_reader;
