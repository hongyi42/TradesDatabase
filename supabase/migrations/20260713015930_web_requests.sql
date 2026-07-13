-- Web request log (Feature E: web_search / read_webpage spine tools).
-- One table, three jobs:
--   1. per-person rolling rate caps (count rows in the window),
--   2. fetch provenance ("did OUR search return this exact URL to this person
--      recently?" — the tier that skips the URL-length cap),
--   3. the only audit trail of what agents searched/read (fetches do not
--      transit the doorman, and reads stay out of L1 by scope decision).
-- Deliberately NOT raw_captures: search queries/URLs are operational exhaust,
-- prunable later — never part of the permanent company record.
-- Rows are written for fetch ATTEMPTS (before the network call), so rejected
-- probes consume the cap and stay visible.

create table web_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  technician_ref text not null,
  kind           text not null check (kind in ('search', 'search_result', 'fetch')),
  value          text not null,          -- the query (search) or URL (search_result / fetch)
  created_at     timestamptz not null default now()
);

-- Provenance lookup: exact (person, kind, value) match inside a freshness window.
create index web_requests_provenance_idx
  on web_requests (tenant_id, technician_ref, kind, value);
-- Rate-cap lookup: count a person's rows of a kind in a rolling window.
create index web_requests_window_idx
  on web_requests (tenant_id, technician_ref, kind, created_at);
