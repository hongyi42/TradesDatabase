---
date: 2026-09-15
task: The retrieval layer, plan 2 of 4 — the technician limited view: scope (their trips, the customers they serve, those customers' current jobs), the grants ledger and its check, the firm's own rule, and the content-tag hook, all inside plan 1's one capture predicate
research: thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md
status: draft
supersedes: nothing
---

## Overview

Plan 1 (PR #242) put "which captures belong", the retraction fold and the tier gate in Postgres. Its
tier gate is content-only: a technician badge reads ANY customer on the firm. The operator's access
rulings (task 20260915-customer-context-becomes-a-table-of-cont, "TECHNICIAN VIEW + GRANT ACCESS"
1–3, 7–9) give technicians a LIMITED VIEW by default, widened per item by a manager's GRANT and per
firm by the FIRM'S RULE. This plan adds scope + grants + firm rule + a tag hook to the SAME predicate
(`capture_visible`), routes every technician read through it, and says "outside your view" in words.
The request flow (ask, desk relay, `grant_access`, message back) is parked task
20260915-the-technician-access-request-flow-tech — not here.

## Decisions

- **"Serving" (operator 1A, 2026-09-15).** A trip = a `visit_participants` row for the technician on a
  visit not `cancelled`. OWN JOBS = jobs she has a trip on (any status, any age). SERVED customers =
  customers of her own jobs that are not terminal (`TERMINAL_JOB_STATUSES`: paid, cancelled,
  declined; completed/invoiced still count). In view: own jobs + every non-terminal job of a served
  customer + granted. Customers in view: customers of own jobs + granted.
- **A trip her own note minted is not a trip (operator, 2026-09-15, Phase 2 review).** The note door
  creates a completed visit with its author on it when a job has no matching trip
  (`attachNote.ts:115-130`), so counting it let a technician open any customer's record by filing one
  note. Excluded: a visit whose `source_capture_id` is a technician-channel capture. A trip minted
  from a CALL (record_caller) still counts. The contradiction — she filed on a job she is not booked
  on — goes to a planner detector in the request-flow task, where the planner may also grant or deny.
- **Her own notes, always (operator, 2026-09-15, Phase 1 review).** A TECHNICIAN-channel capture
  stamped with her ref is in her scope wherever it sits, filed or not; authorship lifts scope only
  (content rules still apply). Technician channels only: inbound mail, send/audit and phone-line rows
  also carry a ref. Pages/search on an out-of-view scope return `in_view:false` plus those notes.
- **Outside the view = name + id, in words (operator 2B).** `find_customer`/`get_customer_context`
  → `{id, name, inView:false, note}`; `get_job` → `{id, inView:false, note}`; page/search on an
  out-of-view scope → `inView:false`, no rows; `get_capture` keeps its one `found:false`.
  `record_standing_fact` is refused on an out-of-view target (its preview shows the old value).
- **Money is a STATUS IN WORDS for a technician (operator, 2026-09-15, during implementation —
  AMENDS 3C's "door numbers either way").** `technicianMoneyView` returns `{status}` — "invoiced,
  not yet paid", "part paid, balance outstanding", "paid in full", … — and no figure at all. The
  invoice amount is what the customer was charged, and balance due equals it until something is
  paid, so either number told her the price. The retraction preview's `alsoLosesEvidence.money`
  drops `amountCents` for a technician too (she keeps eventId/job/kind, which is what
  `inform_team_lead` asks her to name). A grant still opens no money detail. The planner RELAY (its
  gap block renders ledger amounts and it writes the technician's text itself) is plan 3's, by the
  operator's call.
- **A grant opens what the manager picks (operator 3C).** `access_grants.opens` = `record` (as if she
  served it; content gate still applies) or `record_and_notes` (every capture in it, as a manager sees
  it: channel, `manager_only` and tags bypassed). Money stays `technicianMoneyView` door numbers (TS,
  untouched). One customer OR one job; `expires_at` null = standing; ledger row (who asked, who
  granted, scope, expiry, why); revocation is a one-way stamp. A direct DELETE is refused; a cascade
  from a deleted technician/customer/job is allowed (`pg_trigger_depth() > 1`), or eval world
  rebuilds would 23503.
- **Firm rule now, its verb later (operator 4B).** `technician_view_rules` + the check ship here; the
  manager-seat verb ships with `grant_access` in the request-flow task. Until then: default for every
  firm, operator SQL to change one. Accepted: no in-product path to out-of-view data until that task.
- **Rule knobs** (mine, within ruling 2): `job_scope` ∈ `own_trips` | `serving` (default) |
  `serving_history` | `whole_firm`; `technician_channels` (default the three technician channels,
  option A); `hidden_tags` (default empty). NULL = default; defaults live ONLY in
  `technician_view_of` — the rule is evaluated nowhere else, hence a table apart from `tenant_settings`.
- **One predicate, named halves** (mine): `capture_in_scope` + `capture_content_open`;
  `capture_visible` = both; `capture_restricted` = technician: in scope AND content closed, any other
  tier: `not capture_visible` (plan 1's unknown-tier count, `retrievalLayer.test.ts:286-288`, holds).
  The view is computed ONCE per call into a composite and passed in; the variable is `v_view`
  (`capture_full` already declares `v`, `customer_contents` aliases `visits v`).
- **The 3-arg `capture_visible` stays, technicians → false** (mine): plans 3/4 may call it for
  planner/manager (unchanged); a technician read that forgets the view sees nothing.
- **Fail closed** (data-security §2): technician with `p_viewer` null → empty view, and
  `customer_contents` returns `null` ("no such customer") — so old code during the deploy window and
  roster-less badges see nothing, never an error or a wider view. A viewer with an empty
  `p_terminal_statuses` raises (a caller bug).
- **Tag hook only**: `capture_tags` exists and `capture_content_open` consults it against
  `hidden_tags`; no writer. Overrides/precedence: task 20260915-the-extractor-tags-each-inbound-capture.
- **Unchanged / tests** (mine): the technician desk already has NO dispatched tools
  (`desk.ts:179-186`); write doors are not reads. `server.test.ts` runs at `whole_firm` so option-A
  tests still test content; a new describe block tests the default.
- **New tables registered by name** (eng-memory §1): `scripts/seed.mjs` truncate list and
  `scripts/spine-eval/world.mjs` `RESET_TABLES`. **Deviation, decided in Phase 3** (mine): the PILOT
  tenant-scoped list gets them as documented ABSENCES, not entries — `technician_view_rules` is firm
  CONFIGURATION (the `tenant_settings`/`tenant_profiles` precedent: a pilot rebuild must not forget a
  firm's own rule), `access_grants` goes by cascade, `capture_tags` hangs off captures a pilot keeps.

## Plain-language walkthrough

```
technician read ─► technician_view_of(firm, Jane) ── once per call ──► view
                     her trips → her jobs → customers she serves → their current jobs
                     + live grants (record | record_and_notes) + the firm's rule
every capture ─► capture_visible = in scope (on a job / customer in the view)
                                AND content open (her channels, not manager_only, no hidden tag —
                                                  or inside a record_and_notes grant)
customer or job not in view ─► "outside your view" (name + id only)
```

**Phase 1** teaches the database who Jane is serving: three small tables (the firm's rule, the grants
ledger, the tag hook), one function that works out her view, plan 1's four read functions rebuilt to
take her id, and the tools passing it. You'd notice it in the new database tests: Jane sees Mrs. Lee's
open jobs, not the Hendersons'; a grant opens the Hendersons; an expired or revoked one does not.

**Phase 2** makes the other technician doors agree: `find_customer`, `get_job` and
`record_standing_fact` apply the same view, and every refusal says "outside your view" in words.

**Phase 3** ships it: seed/world registration, docs, the pilot migration, a live eval as `tech-jane`.

## Secrets & env preflight

- **Phase 0/1:** this worktree's stack (`project_id = "TradesDatabase-retrieval-layer-2-1ed78e"`, API
  port 54821, `.env.test` present); `npx supabase status` must answer.
- **Phase 2:** none.
- **Phase 3:** `supabase-test` MCP (pilot apply + read-back); `OPENROUTER_API_KEY` in `.env` for
  `scripts/spine-eval` (copy `.env` into the worktree; absent → live eval reported as owed).

## Phase 0: integrate

`/integrate`: merge `origin/main` (never rebase), four gates, record the test count. If plan 3 or 4
landed, grep their migrations and `src` for callers of `capture_visible`, `customer_contents`,
`captures_page`, `capture_full`, `search_captures`, fold them into Phase 1, and renumber this migration
after theirs.

## Phase 1: the view, in the database

### Changes required

**`supabase/migrations/20260917120000_technician_view.sql`.** Every table: `enable row level security;
revoke all … from anon, authenticated` (`20260829120000:70-71`).
- `technician_view_rules(tenant_id uuid pk references tenants on delete cascade, job_scope text check
  (job_scope in ('own_trips','serving','serving_history','whole_firm')), technician_channels
  capture_channel[], hidden_tags text[], set_by text, created_at, updated_at)` + `set_updated_at` trigger.
- `access_grants(id uuid pk default gen_random_uuid(), tenant_id not null references tenants,
  technician_id not null references technicians on delete cascade, customer_id references customers on
  delete cascade, job_id references jobs on delete cascade, opens text not null check (opens in
  ('record','record_and_notes')), expires_at timestamptz, requested_by text, granted_by text not null,
  reason text not null check (btrim(reason) <> ''), created_at not null default now(), revoked_at
  timestamptz, revoked_by text, revoke_reason text)`; `check (num_nonnulls(customer_id, job_id) = 1)`;
  `check ((revoked_at is null) = (revoked_by is null))`; index `(tenant_id, technician_id)`. Trigger
  `access_grants_ledger` BEFORE UPDATE OR DELETE: DELETE raises unless `pg_trigger_depth() > 1`;
  UPDATE raises unless `old.revoked_at is null and new.revoked_at is not null` and every column EXCEPT
  `revoked_at, revoked_by, revoke_reason` is `not distinct from` old.
- `capture_tags(tenant_id not null references tenants, capture_id not null references raw_captures,
  tag text not null check (tag ~ '^[a-z][a-z0-9_]{0,39}$'), source text not null check (source in
  ('extractor','manager')), reason text, created_at not null default now(), primary key (capture_id, tag, source))`.
- `create type technician_view as (tenant_id uuid, all_scope boolean, job_ids uuid[], customer_ids
  uuid[], notes_job_ids uuid[], notes_customer_ids uuid[], channels capture_channel[], hidden_tags text[])`.

**`technician_view_of(p_tenant uuid, p_technician uuid, p_terminal_statuses text[]) returns
technician_view`** — `plpgsql stable security definer set search_path = public`. Arrays always non-null.
`p_technician` null, or no technician row on `p_tenant` → `(p_tenant, false, '{}',…)` BEFORE any other
check. Empty/null `p_terminal_statuses` → raise `'technician_view_of: p_terminal_statuses is
required'`. Else, every hop tenant-checked (`p.tenant_id = v.tenant_id = j.tenant_id = p_tenant`):
own_jobs = jobs of her non-cancelled visits; served = customers of non-terminal own_jobs; rule =
`coalesce` over `technician_view_rules`, defaults `'serving'` /
`{technician_voice,technician_note,technician_photo}` / `{}`. `job_ids`: `own_trips` → own_jobs;
`serving` → own_jobs ∪ non-terminal jobs of served; `serving_history` → own_jobs ∪ all jobs of served;
`whole_firm` → `all_scope = true`. `customer_ids` = customers of own_jobs. Live grants (`revoked_at is
null and (expires_at is null or expires_at > now())`, grant AND its customer/job on `p_tenant`):
customer grant → `customer_ids += c`, `job_ids +=` c's jobs; job grant → `job_ids += j`,
`customer_ids += j.customer_id`; `record_and_notes` also fills `notes_customer_ids`/`notes_job_ids`.

**Predicate functions** (`sql stable`; test a view with `(p_view).tenant_id is not null` — a composite
`is not null` is false when ANY field is null):
- `view_has_job(p_view, uuid)` / `view_has_customer(p_view, uuid)` = `all_scope or id = any(ids)`.
- `capture_in_scope(p_capture, p_tier, p_view)`: manager/planner → true; technician with a view →
  `all_scope` OR a `capture_membership` row (tenant = view's) with `job_id = any(job_ids)` OR (no
  membership with a job AND one with `customer_id = any(customer_ids)`); else false.
- `capture_content_open(p_channel, p_sensitivity, p_capture, p_tier, p_view)`: manager/planner →
  true; technician with a view → a membership in `notes_job_ids`/`notes_customer_ids` OR
  (`p_channel = any(channels)` AND `p_sensitivity is distinct from 'manager_only'` AND no
  `capture_tags` row on the capture+tenant with `tag = any(hidden_tags)`); else false.
- `capture_visible(p_channel, p_sensitivity, p_tier, p_capture, p_view)` = in_scope AND content_open;
  `capture_restricted(same args)` = per the Decisions bullet. 3-arg `capture_visible`: `create or
  replace`, body `p_tier in ('manager','planner')`, comment pointing at the 5-arg form.

**The four readers.** `drop function` the plan-1 signatures (`20260916120000:557-560`) and recreate
with the same bodies plus `v_view technician_view := case when p_caller_tier = 'technician' then
technician_view_of(p_tenant, p_viewer, p_terminal_statuses) end`; every `capture_visible(c.channel,
c.sensitivity, p_caller_tier)` → the 5-arg form with `c.id, v_view`; every `not capture_visible(…)`
feeding a `restricted_count` → `capture_restricted(…)`.
- `customer_contents(…, p_terminal_statuses text[] default '{}', p_viewer uuid default null)`:
  technician with `p_viewer` null → `null`; customer not in view → `{in_view:false, customer:{id,
  name}}`. Technician: jobs block, `jobs_total`, `older_jobs` count only `view_has_job` jobs. Add
  `in_view:true`, `jobs_outside_view` (0 for other tiers) and `in_view_job_ids` = null when the tier is
  not technician OR `all_scope`, else EVERY in-view job id of this customer (not the page's ten).
- `captures_page(…, p_include_retracted boolean default false, p_terminal_statuses text[] default null,
  p_viewer uuid default null)` and `search_captures(…, p_snippet_chars int default 240,
  p_terminal_statuses text[] default null, p_viewer uuid default null)`: after `capture_scope_found`, a
  technician whose scope parent is not in view → `{scope_found:true, in_view:false, …empty}`; else
  `in_view:true`.
- `capture_full(…, p_include_retracted boolean default false, p_terminal_statuses text[] default null,
  p_viewer uuid default null)`: the 5-arg predicate; null when not visible.
- Grants: plan 1's block (`:553-568`) for every new/recreated function, `technician_view_of` included.

**`src/db/database.types.ts`** — `npm run gen:types:local` (never `gen:types`: pilot).

**`src/db/technicianView.ts`** (new; export from `src/db/index.ts`):
```ts
export interface TechnicianView { allScope: boolean; jobIds: Set<string>; customerIds: Set<string> }
export async function getTechnicianView(tenantId: string, technicianId: string | null): Promise<TechnicianView>
export const viewHasJob = (v: TechnicianView, id: string) => v.allScope || v.jobIds.has(id);
export const viewHasCustomer = (v: TechnicianView, id: string) => v.allScope || v.customerIds.has(id);
export async function insertAccessGrant(input: { tenantId: string; technicianId: string; customerId?: string;
  jobId?: string; opens: 'record' | 'record_and_notes'; expiresAt?: string | null; requestedBy?: string | null;
  grantedBy: string; reason: string }): Promise<AccessGrant>
export async function revokeAccessGrant(id: string, tenantId: string, by: string, reason: string): Promise<boolean>
export async function setTechnicianViewRule(tenantId: string, rule: { jobScope?: string;
  technicianChannels?: CaptureChannel[]; hiddenTags?: string[] } | null, setBy: string): Promise<void> // null deletes
```
`getTechnicianView` sends `[...TERMINAL_JOB_STATUSES]`; a `null` id returns the empty view with no call.

**`src/db/context.ts`** — `getCustomerContents`, `listCapturesPage`, `getCaptureFull`, `searchCaptures`
gain a trailing `technicianId: string | null = null`, sent as `...(technicianId ? { p_viewer:
technicianId } : {})` (generated params are optional, not nullable — the `:310-314` idiom), plus
`p_terminal_statuses: [...TERMINAL_JOB_STATUSES]` on the three that lack it. In THIS phase (the SQL
returns the new shape now): `getCustomerContents` returns `CustomerContents | OutsideView | null` with
`export interface OutsideView { inView: false; customer: { id: string; name: string } }` and `export
const isOutsideView = (c: CustomerContents | OutsideView): c is OutsideView => 'inView' in c && c.inView === false`;
`CustomerContents` gains `jobsOutsideView`; `upcomingVisits` filtered when `in_view_job_ids` is non-null.
`CapturesPage` and `CaptureSearch` gain `inView: boolean`.

**`src/mcp/tools/shared.ts`** — `export const viewerIdOf = (ctx: ToolContext): string | null => ctx.caller?.id ?? null;`
and `export const OUTSIDE_VIEW_NOTE = "outside your view — you see the customers whose current work you
have a trip on. Only a manager can open this one; say so, and do not guess what it holds.";`

**Handlers** — pass `viewerIdOf(toolCtx)` at `customers.ts:374`, `captures.ts:701`, `:743`, `:757`.
`handleGetCustomerContext`: `isOutsideView(contents)` → `{customer: contents.customer, inView:false,
jobs:[], note: OUTSIDE_VIEW_NOTE}`; technicians also get `jobsOutsideView` and a note clause "N more jobs
on file are outside your view". `handleListRecentCaptures` (`:709-719`) / `handleSearchCaptures`
(`:760-766`): `!inView` → `note: OUTSIDE_VIEW_NOTE`, `inView` passed through.

**Tests**
- `src/db/technicianView.test.ts` (new; seed tenant + a second tenant; `setTechnicianViewRule(…, null)`
  in `beforeAll` AND `afterAll`; truncate `access_grants, technician_view_rules, capture_tags,
  technicians, customers, jobs, visits, raw_captures … cascade` in `afterAll`): Jane with a trip on
  Lee's open job sees it and Lee's other open job, not Lee's paid job, not Henderson; a paid job she
  worked stays in view with Lee's profile; a cancelled trip gives nothing; `own_trips` drops Lee's other
  job; `serving_history` adds the paid one; `whole_firm` sees Henderson with `in_view_job_ids` null and
  Lee's upcoming trips intact; a `record` customer grant opens Henderson's jobs but not his
  `phone_call`, `record_and_notes` opens it and a `manager_only` row; expired and revoked grants open
  nothing; a grant naming ANOTHER firm's customer opens nothing; a tag in `hidden_tags` hides a
  technician note (restricted +1); a job-less customer note is visible only with the customer in
  view; `p_viewer` null → `customer_contents` null and empty pages; a viewer with no terminal list
  raises; UPDATE of `reason` raises, a direct DELETE raises, one revoke (all three `revoked_*` set)
  succeeds, deleting the technician cascades the grant away.
- `src/db/retrievalLayer.test.ts` — helpers take `(…, tier, viewer?)` and send `p_terminal_statuses`;
  `:223` and `:260-293` give the technician a roster row + a trip; `afterAll` (`:35`) truncates
  `technicians, access_grants` too; `:286-288` (unknown tier restricted 2) stays as is.
- `src/db/context.test.ts:61-70,117,173,178,189`, `customerCaptures.test.ts:128-129,140,148`,
  `retractions.test.ts:167-173` — narrow with `as CustomerContents` (all `'manager'` calls).
- `src/mcp/server.test.ts` — `beforeAll` (`:91-117`) `setTechnicianViewRule(tenantId, {jobScope:
  'whole_firm'}, 'test')`; `afterAll` resets to `null` (tenants are never truncated).

### Automated verification
- [x] `npx supabase db reset` applies; `technician_view_of` + 5-arg `capture_visible` in the regenerated types.
- [x] `npx vitest run src/db/technicianView.test.ts src/db/retrievalLayer.test.ts src/db/context.test.ts` — twice in a row (29 passed both runs).
- [x] `npm run typecheck`, `npm run lint`, `npm test` (3185 passed = Phase 0's 3169 + 16 new).
- Live / Manual verification: none this phase (the pilot apply is Phase 3).

---

## Phase 2: the other technician doors

### Changes required

**`src/mcp/tools/customers.ts`**
- `handleFindCustomer` (`:346-363`): technician tier → one `getTechnicianView(tenantId,
  viewerIdOf(toolCtx))`; out-of-view rows → `{id, name, inView:false, note: OUTSIDE_VIEW_NOTE}` before
  the fold; in-view rows unchanged.
- `handleGetJob` (`:436-499`): after the tenant guard, technician and `!viewHasJob(view, job.id)` →
  `{id: job.id, inView:false, note: OUTSIDE_VIEW_NOTE}`.
- Descriptions `find_customer` (`:86`), `get_customer_context` (`:95-123`): one sentence each naming
  `inView:false` / `jobsOutsideView`.

**`src/mcp/tools/captures.ts`** — `handleRecordStandingFact` stage (`:1075-1092`): technician and the
target customer (or job) not in view → throw `` `that ${target} is outside your view — only a manager
can record facts on it` ``.

**Tests** — `src/mcp/server.test.ts`, new `describe('the technician limited view')` with the rule `null`
in `beforeAll`, `whole_firm` again in `afterAll`: `tech-mcp` with a trip on Lee's open job → contents
lists it + Lee's other open job, `jobsOutsideView` 1; Henderson → `find_customer` minimal row,
`get_customer_context` `inView:false` with no phone in the text, `get_job` `inView:false`,
`list_recent_captures`/`search_captures` `inView:false`, `get_capture` `found:false`,
`record_standing_fact` refused; a `record` grant → Henderson's page with `restrictedCount` for his
call; `record_and_notes` → `get_capture` on it `found:true`; under `own_trips`, Lee's upcoming trip on
the other job is not listed; a manager badge on Henderson unchanged.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` (3190 passed); `npx vitest run src/eval/toolCases.test.ts` (13 passed, surface unchanged: 17 / 42).
- Live / Manual verification: none this phase.

---

## Phase 4: money in words (added during implementation, operator ruling above)

### Changes required
- **`src/db/moneyEvents.ts`** — `technicianMoneyView(s) => { status: TechnicianMoneyStatus }`, the
  seven states derived from the summary in a fixed order (credit → nothing invoiced → outstanding →
  settled/paid). No booleans: a flag pair reconstructs a number.
- **`src/mcp/tools/shared.ts`** — `losingEvidenceOf(impact, activeManager)` strips `amountCents`
  from the retraction preview's money list for a technician; `retractedResult` passes its flag.
- **`src/mcp/tools/captures.ts`** — the stage path passes `activeManager` too.
- **`src/mcp/tools/customers.ts`** — `get_customer_context` and `get_job` descriptions say the
  technician block is words, never a figure, and that the manager has the numbers.
- **Tests** — `moneyEvents.test.ts`: every state, and `JSON.stringify(view)` contains NO digit;
  `server.test.ts`: the tier-split money case asserts `{status:'invoiced, not yet paid'}` with no
  digits, and the retraction preview names the entry without its amount.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` (3190 passed).

## Phase 3: registration, docs, the pilot, the live check

### Changes required
- `scripts/seed.mjs` truncate (`:139-243`, existence-probed like `tenant_settings`) and
  `scripts/spine-eval/world.mjs` `RESET_TABLES` (`:104-160`): `access_grants`, `technician_view_rules`,
  `capture_tags`, each with its eng-memory §1 comment; the pilot tenant-scoped list (`:219-251`):
  `technician_view_rules`, `capture_tags` (grants go by cascade).
- `docs/nemoclaw-tech-agent.md:329-331`: the limited view, grants, firm rule (verbs owed by the flow task).
- `docs/engineering-memory.md` §5: the composite `is not null` trap; "a technician read with no viewer
  sees nothing, by design"; the operator SQL for a firm's rule until the verb exists.

### Automated verification
- [ ] `npm run build`; all four gates; `npm run seed:local` completes twice.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP; `OPENROUTER_API_KEY`; seeded local eval world.
- [ ] Local: `scripts/spine-eval` cases R16, R17 and corpus Q01 as `tech-jane` (trips on `job-rich-1/2`,
      invoiced → `edge-rich` served); record pass/fail and every `inView:false` seen.
- [ ] Pilot, **before the PR merges**: `apply_migration` with the file's exact body; `NOTIFY pgrst,
      'reload schema'`; read back `select proname, pronargs from pg_proc where proname in
      ('technician_view_of','capture_in_scope','capture_content_open','capture_restricted','capture_visible')`
      (two `capture_visible` rows: 3 and 5 args) and `select count(*) from technician_view_rules` = 0.
      Merge; confirm the Render deploy is live.

### Manual verification
- [ ] After deploy, restart the s2 gateway; in Telegram as a technician seat ask about a customer whose
      work that technician has a trip on, and one they do not — judge how the refusal reads.
