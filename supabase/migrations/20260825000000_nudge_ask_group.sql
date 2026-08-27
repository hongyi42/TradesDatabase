-- One message may cover several gaps (plan 2026-08-25, Phase 2).
--
-- Until now the ladder was one-gap-one-message end to end: `question` is a
-- column on the row, the box serves one item per queued row, and one delivery
-- report moves one row. A job with three holes in its record therefore produced
-- three separate pings to the same person within seconds of each other.
--
-- This column is the grouping. It holds the LEAD member's own `nudges.id`, so
-- the lead is simply the row where `id = ask_group_id` and no second column is
-- needed to name it. That matters because the lead is load-bearing twice over:
-- its context prints the "(re: customer — job)" anchor the technician's agent
-- keys on, and its id becomes the delivery item id and the box's sent-marker.
-- A random uuid would have left "which row is the lead" ambiguous exactly where
-- the serve loop has to answer it.
--
-- NULL is the normal case and means "asked on its own" — every row written
-- before this migration, and every ungrouped ask after it.
--
-- NO FOREIGN KEY, deliberately. The group is a set of PEERS, not a parent and
-- its children: a self-referencing FK would constrain deletion order for no
-- gain, and the lead is not privileged in the data, only in the transport.
alter table nudges add column if not exists ask_group_id uuid;

comment on column nudges.ask_group_id is
  'The LEAD member''s own nudges.id for a gap asked as part of ONE delivered message '
  '(plan 2026-08-25). The lead is the row where id = ask_group_id. Null = asked on its own, '
  'which is the normal case. No FK: the group is a set of peers.';

-- The serve loop groups a host's queued rows by this, and the expiry sweep
-- expands a group when any member crosses its delivery deadline. Partial: the
-- overwhelming majority of rows are null and must not be indexed.
create index if not exists idx_nudges_ask_group
  on nudges (tenant_id, ask_group_id)
  where ask_group_id is not null;

-- AMENDED, not new (plan 2026-08-25, Phase 1 — deferred here because that phase
-- ships no migration). The column gained a SECOND writer: the planner's `close`
-- now derives the link from the citation the rails already verified, which is
-- valid with two or more gaps open — precisely the case the record-time path
-- declines. The original comment stated the record-time rule as if it were the
-- only one, which is now false where it is most likely to be read.
comment on column nudges.answered_by_capture_id is
  'The raw_captures row matched to this gap as its answer. TWO writers, first-write-wins: '
  '(1) at record_field_note time, only when exactly ONE gap was open for that technician on '
  'that job (src/mcp/server.ts attributeAnswerToGap); (2) at CLOSE time, derived by code from '
  'the verbatim citation the planner quoted, and only when a badge-holder spoke that capture '
  'through an assistant-write channel (src/teamLead/planner.ts). No FK: L1 is append-only and '
  'owes the ladder nothing.';
