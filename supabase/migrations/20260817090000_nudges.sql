-- Team-lead nudges (plan 2026-08-15 feature B, Phase 1): the notebook of the
-- spine's voice. One row = one question the team-lead identity ever CONSIDERS
-- asking a technician about a gap — who, about what, current state. The row is
-- the durable audit of the outreach (question text, evidence context,
-- timestamps, actor): the outreach itself is deliberately NOT L1-captured
-- (user-ratified 2026-08-16 — L1 is undeletable and the 2026-07-04 outbound
-- exception does not extend by analogy), so this table must carry the whole
-- story. The technician's REPLY takes the normal record_field_note path and
-- needs nothing here.
--
-- Lifecycle: pending (watcher noticed, budget slot claimed)
--   -> queued   (model turn composed the question)
--   -> asked    (box runner delivered it through the person's own agent)
--   -> answered (activity landed / visit status changed - mechanism-verified)
--    | escalated (48h silence -> manager review item took over)
--    | cancelled (model declined to ask, or the visit was cancelled/completed)
--    | failed    (compose or delivery gave up after its attempt cap)

create table nudges (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  -- Same vocabulary as review_items.kind ('overdue_visit_gap') so the two
  -- dedup stores speak one language. Plain text: new kinds need no migration.
  kind          text not null,
  -- The gap's subject (assignment id for overdue_visit_gap) — same key the
  -- watcher's review items use.
  subject_ref   text not null,
  technician_id uuid references technicians(id),
  status        text not null default 'pending'
    check (status in ('pending','queued','asked','answered','escalated','cancelled','failed')),
  question      text,
  -- Code-built evidence the compose turn reads (customerName, jobTitle,
  -- visitDay, ... assignmentId, jobId, startsAtLocal). The model never sees
  -- anything BUT this.
  context       jsonb not null default '{}'::jsonb,
  attempts      int not null default 0,
  serve_count   int not null default 0,
  actor_ref     text not null default 'spine:team-lead',
  resolution    text,
  queued_at     timestamptz,
  asked_at      timestamptz,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger nudges_set_updated_at
  before update on nudges
  for each row execute function set_updated_at();

-- Ask once per subject, EVER — deliberately NOT partial (a resolved nudge must
-- keep blocking: an assignment's end never recurs, so re-asking is never
-- right). "Ask once, not every 5 minutes" is a database guarantee, not a
-- promise; createPendingNudge treats 23505 as "already considered".
alter table nudges
  add constraint uq_nudges_subject_ever unique (tenant_id, kind, subject_ref);

-- The watcher reads open rows per tenant every tick; the budget read filters
-- by technician over a rolling day.
create index idx_nudges_tenant_status on nudges (tenant_id, status);
create index idx_nudges_budget on nudges (tenant_id, technician_id, created_at desc);

-- RLS-with-no-policy + explicit revoke (money_events / tenant_profiles
-- posture): service_role bypasses RLS so the app is unaffected;
-- anon/authenticated get zero rows and no writes. A forged nudge row would put
-- attacker-chosen text into a message delivered AS the firm to a technician's
-- phone — this table must never be publishable-key writable.
alter table nudges enable row level security;
revoke all on nudges from anon, authenticated;

-- Backstop for Feature A's app-level once-per-assignment-EVER guarantee
-- (final-review parked item, paid now that flagOverdueVisitGap gains a second
-- caller — the escalation rung). Any-status by design: the open-only partial
-- index (one OPEN item per subject) already exists; this one makes the
-- select-then-insert race lose loudly instead of double-flagging.
create unique index uq_review_items_overdue_gap_ever
  on review_items (tenant_id, subject_ref)
  where kind = 'overdue_visit_gap';
