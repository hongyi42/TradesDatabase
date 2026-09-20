-- A technician's request to open part of the record, and the text that carries it.
--
-- Access plan B (thoughts/shared/plans/2026-09-19-access-plan-b-the-request-flow-
-- through-the-office.md). Plan A gave a MANAGER the verbs to open a record; this
-- is the other direction -- the technician asks, the desk filters, and what the
-- desk will not open itself becomes a request that waits for a manager.
--
-- TWO CHANGES, and neither adds a table.
--
-- 1. 'access' JOINS THE PUSH KINDS. The managers are texted once when a request
--    is filed, and the technician is texted the answer. Same addressee shape
--    (one person), same verbatim body, same serve/ack ledgers, same delivery
--    leg as a schedule change or a call -- `kind` was documented at creation as
--    "not authority, not routing; it exists so an operator reading the table
--    knows why a message was owed", and an access answer is owed for its own
--    reason. (The 'ops' amendment, 20260917200000, is the precedent.)
--
-- 2. A REQUEST IS AN OBSERVATION, not a fifth queue. It is something the record
--    has noticed and nobody has settled, which is exactly what observations are
--    for: the planner already reads its open set every tick, so a forwarded
--    request appears in the planner's list with no new read, and the planner can
--    chase the manager or tell the technician it is still waiting. author is
--    'planner' (the desk writes it wearing the office's name), and subject_ref
--    is a fresh uuid -- a LABEL, not a dedup key.
--
-- WHY THE INDEX BELOW, THEN. The dedup that matters here is not "this subject
-- was ever noticed" but "this person already has this exact ask OPEN". A
-- technician whose seat retries, or who asks twice in a morning, must not text
-- every manager twice and must not leave two rows a manager could answer
-- separately. So the key is the request's own shape --
-- <technicianId>:<jobId | c:customerId>:<wants>, written into
-- context->>'requestKey' -- and the index is PARTIAL on the unsettled statuses:
-- once a request is answered (status 'dismissed') the same ask may be made
-- again, which is the point. A grant expires; the need comes back.
--
-- THIS CHANGES WHAT A NULL FROM createObservation MEANS. Since build 7
-- (20260904110000) uq_observations_subject_ever has been partial on
-- author='detector', so a planner-authored row could not collide and null meant
-- exactly "the detector had already noticed this subject". This index is the
-- first unique rule that applies to a PLANNER row, so null now also means "this
-- person already has this ask open" -- which is why openAccessRequest
-- (src/db/accessRequests.ts) translates it into "already asked", in words, and
-- why the comment on createObservation names both cases.
--
-- The expression must be written exactly as the reader writes it: PostgreSQL
-- matches an expression index by the expression's parse tree, so
-- `context->>'requestKey'` here and `.eq('context->>requestKey', …)` in
-- PostgREST are the same expression, while `context->'requestKey'` (jsonb, not
-- text) is a different one and would silently use no index at all.
alter table person_pushes
  drop constraint if exists person_pushes_kind_check;

alter table person_pushes
  add constraint person_pushes_kind_check
  check (kind in ('schedule', 'call', 'ops', 'access'));

comment on column person_pushes.kind is
  'Why the message was owed: schedule change, inbound call, an ops incident, or an access '
  'request/answer. Not authority, not routing.';

create unique index if not exists uq_open_access_request
  on observations (tenant_id, (context->>'requestKey'))
  where kind = 'access_request' and status in ('open', 'asked');

comment on index uq_open_access_request is
  'One OPEN access request per (firm, requestKey): a retried or repeated ask converges on the '
  'row that is already waiting instead of texting every manager twice. Partial on the unsettled '
  'statuses on purpose -- once answered, the same ask may be made again.';
