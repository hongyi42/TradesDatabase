-- Cost ledger (per-tenant API cost tracking, Phase 1).
--
-- THE LOAD-BEARING RULE: cost_events stores UNITS, never dollars. Prices live in
-- cost_rates, versioned by effective date, and join at READ time. That is what
-- lets history re-price when a vendor changes rates and what makes "what would
-- July have cost on provider X?" answerable — the question the provider-switching
-- plan is built on. A collector that writes a dollar figure here has broken the
-- design.
--
-- Not hypothetical: DeepInfra's input price moved $0.95 -> $0.93 in the three days
-- between this feature's two planning passes, and a third pricing tier appeared.
--
-- Plan: thoughts/shared/plans/2026-07-24-per-tenant-cost-dashboard.md

create extension if not exists btree_gist with schema extensions;

-- ── The price book ──────────────────────────────────────────────────────────
-- A price change is a NEW ROW (close the old one with effective_to), never an
-- UPDATE — an in-place edit would silently re-price every historical event.
create table cost_rates (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null,
  sku            text not null,
  unit           text not null,          -- what ONE unit is: 'token', 'request', 'call'
  unit_cost_usd  numeric not null check (unit_cost_usd >= 0),  -- cost of ONE unit
  effective_from date not null,
  effective_to   date,                   -- null = the current rate
  source_url     text,                   -- CLAUDE.md: cite the vendor doc
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

-- At most ONE open-ended (current) rate per SKU.
create unique index cost_rates_current_idx
  on cost_rates (provider, sku) where effective_to is null;

-- No two rates for one SKU may cover the same day. daterange defaults to the
-- half-open '[)' form, matching the rollup's join predicate exactly — so a rate
-- closed on its successor's opening date does NOT overlap, and that day is
-- priced once rather than twice.
alter table cost_rates add constraint cost_rates_no_overlap
  exclude using gist (
    provider with =,
    sku with =,
    daterange(effective_from, effective_to) with &&
  );

-- ── Metered usage ───────────────────────────────────────────────────────────
-- quantity is the RAW measured count in `unit` (4182 tokens, 1 request). Cost is
-- derived at read time as quantity * unit_cost_usd; numeric is arbitrary
-- precision, so a per-token rate of 0.00000093 multiplies exactly.
create table cost_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  technician_ref text,
  provider       text not null,
  sku            text not null,
  quantity       numeric not null check (quantity >= 0),
  unit           text not null,
  -- 'measured' = we counted it. 'allocated' = we split a bill by a proxy metric.
  -- Surfaced in the UI: an estimate must never render like a metered fact (the
  -- durationAssumption / driveMeasured:false disclosure precedent).
  method         text not null check (method in ('measured', 'allocated')),
  occurred_at    timestamptz not null default now(),
  source_ref     text,                   -- vendor id (e.g. Anthropic message id)
  metadata       jsonb,
  created_at     timestamptz not null default now()
);

create index cost_events_rollup_idx on cost_events (tenant_id, provider, occurred_at);

-- Idempotency key for replayable collectors (the Brave backfill re-reads the
-- same web_requests rows every cron tick).
--
-- sku IS part of the key on purpose: the Anthropic recorder writes TWO rows per
-- message id (input + output), so keying on source_ref alone would reject the
-- second one.
--
-- tenant_id is in the key for a forward-looking reason: today's collectors all
-- carry GLOBALLY unique vendor ids (Anthropic message ids, Composio execution
-- ids, web_requests uuids), but a future collector keyed per-tenant (say
-- '2026-07-01-daily') would, without it, silently drop every tenant after the
-- first — a quiet under-report, which for a cost ledger is the worst failure
-- shape. Widening trades that for a theoretical double-count if the SAME vendor
-- id were ever mis-attributed to two tenants, which the current id sources make
-- impossible. Cheap now, expensive once rows exist.
--
-- Deliberately NOT a partial `where source_ref is not null` index: PostgREST's
-- upsert emits `ON CONFLICT (cols) DO NOTHING` with no WHERE clause, which
-- cannot infer a partial index and fails with "no unique or exclusion constraint
-- matching the ON CONFLICT specification". A plain unique constraint has the
-- same semantics here anyway — Postgres treats NULLs as DISTINCT by default, so
-- unlimited source_ref-less rows (the spine/relay counters) still insert freely.
alter table cost_events add constraint cost_events_source_uniq
  unique (tenant_id, provider, sku, source_ref);

-- ── Fixed monthly infrastructure ────────────────────────────────────────────
-- Flat bills with no per-request event: Lightsail, Render, Supabase — and the
-- DeepInfra invoice, whose 'per_spine_tool_call' rule is what turns inference
-- into a per-tenant number without per-tenant metering (routing is
-- gateway-scoped, so no provider-side split exists to read).
create table infra_costs (
  id           uuid primary key default gen_random_uuid(),
  vendor       text not null,
  item         text not null,
  period_start date not null,
  period_end   date not null,
  amount_usd   numeric not null check (amount_usd >= 0),
  allocation   text not null check (allocation in (
                 'per_active_seat', 'per_sandbox', 'per_tenant_equal',
                 'per_spine_tool_call', 'unallocated')),
  source       text not null default 'invoice' check (source in ('invoice', 'estimate')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (period_end >= period_start),
  unique (vendor, item, period_start)     -- the upsert's conflict target
);

create trigger infra_costs_set_updated_at
  before update on infra_costs
  for each row execute function set_updated_at();

-- ── The rollup the dashboard reads ──────────────────────────────────────────
-- Aggregation happens in Postgres (Phase 3's rollup_costs), never by scanning
-- raw rows over PostgREST: db-max-rows silently caps responses at 1000, so an
-- unpaginated read would under-report without erroring.
create table cost_rollup_monthly (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  period_start date not null,
  provider     text not null,
  method       text not null check (method in ('measured', 'allocated')),
  cost_usd     numeric not null default 0,
  quantity     numeric not null default 0,
  computed_at  timestamptz not null default now(),
  primary key (tenant_id, period_start, provider, method)
);

-- ── Seed the price book ─────────────────────────────────────────────────────
-- Rates verified against live vendor docs on 2026-07-24. effective_from is
-- 2026-07-01: the earliest real data is web_requests, which began 2026-07-13, so
-- this covers every backfillable row without claiming to know pre-July prices
-- (Brave's Feb-2026 free-tier removal makes that a real distinction).
--
-- ⚠ These literal (provider, sku) strings are the SHARED VOCABULARY that
-- src/inference/providers.ts joins to in the provider-switching plan. Renaming
-- one silently breaks that join — update both plans together.
--
-- Two vendors are deliberately ABSENT:
--   * 'spine' — an allocation COUNTER, not a billed vendor. The rollup's measured
--     pass inner-joins cost_rates, so spine rows drop out naturally there while
--     still driving the per_spine_tool_call allocation.
--   * 'google' — Google Routes is billable but its seam carries no tenant id
--     (optimizeStopOrder takes only { computeRoutes }), and cost_events.tenant_id
--     is NOT NULL, so no collector exists in v1. An unseeded vendor is honest; a
--     seeded one with no events renders a $0 line that reads as "no spend"
--     rather than "not measured".
--
-- DeepInfra tier: STANDARD. Priority is 1.5x and Flex is 0.8x across the board —
-- if the account is on another tier, close these rows and open new ones.
insert into cost_rates (provider, sku, unit, unit_cost_usd, effective_from, source_url) values
  -- DeepInfra GLM-5.2: $0.93 / $3.00 / $0.18 per 1M tokens (Standard tier).
  ('deepinfra', 'glm-5.2-input',        'token', 0.00000093, '2026-07-01', 'https://deepinfra.com/zai-org/GLM-5.2'),
  ('deepinfra', 'glm-5.2-output',       'token', 0.00000300, '2026-07-01', 'https://deepinfra.com/zai-org/GLM-5.2'),
  ('deepinfra', 'glm-5.2-cached-input', 'token', 0.00000018, '2026-07-01', 'https://deepinfra.com/zai-org/GLM-5.2'),
  -- Anthropic Sonnet 4.6: $3.00 / $15.00 per 1M tokens.
  ('anthropic', 'claude-sonnet-4-6-input',  'token', 0.00000300, '2026-07-01', 'https://docs.claude.com/en/docs/about-claude/pricing'),
  ('anthropic', 'claude-sonnet-4-6-output', 'token', 0.00001500, '2026-07-01', 'https://docs.claude.com/en/docs/about-claude/pricing'),
  -- Brave Search: $5 per 1,000 requests (Search plan; free tier removed Feb 2026).
  ('brave', 'search', 'request', 0.00500000, '2026-07-01', 'https://brave.com/search/api/'),
  -- Composio: $0.299 per 1,000 calls (overage rate, $29 tier). Premium tools
  -- bill at 3x — not modelled in v1; the call sites cannot tell them apart.
  ('composio', 'tool_call', 'call', 0.00029900, '2026-07-01', 'https://composio.dev/pricing');
