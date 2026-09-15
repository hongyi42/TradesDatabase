---
date: 2026-09-15
task: The retrieval layer, plan 1 of 4 — captures and the customer read: one membership definition in the database, a fixed-size contents page, paged and truncated capture reads, technician keyword search, the two briefing tools retired, and a size cap on every seat result
research: thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md
status: draft
supersedes: nothing
---

## Overview

The research found no retrieval layer: ~90 readers each re-apply "which captures belong", the
retraction fold, the tier filter, tenant checks, ordering and paging, and disagree. The operator's
problem statement is context management: tools that never dump history into an agent's window,
judged on context and latency. This plan builds the layer's core for the domain that started it,
captures and the customer record, and puts a size cap on the door every seat result leaves by.

**The ladder** (each a later `/plan`, in order): **2** the technician limited view (scope gate),
grants table + grant check, firm rule, tag-table hook; **3** the planner and the SQL views
(`v_captures` folded, evidence lines carry capture ids, gap-list cap, planner/watcher readers onto
the membership view); **4** schedule contents + pages, `list_pending_reviews`, array results
wrapped, the Composio relay through the cap, remaining readers, visit time indexes. Parked for after:
the access request flow (at this task's handoff), extractor content tags.

**Base.** `origin/main` is 7c2370c; the sibling task `20260914-fix-the-small-board-findings-listjobsfor`
(chunk-150 `findRetractionsFor`, id tiebreaks, phone normaliser) lives on a local branch and the
operator lands it first. Nothing here depends on it (`getCustomerContents` never calls
`findRetractionsFor`), but Phase 0 confirms by hash what `main` holds.

## Decisions

- **Rules live in the database** (operator ruling 1): one view + four RPC functions own membership,
  fold, tier visibility, order and paging; TypeScript owns delivery only.
- **One membership definition** (ruling 2): `capture_membership`, nine arms over the six attachment
  kinds, tenant re-checked on every hop. "A customer's captures" includes every job's;
  "customer-level" = captures with no job membership on any arm.
- **Retracted removed everywhere** (ruling 3): every function excludes retracted captures AND
  retraction rows by default; `p_include_retracted` (manager audit only) returns both, the retracted
  ones **labelled** — the existing manager-trail contract (`server.test.ts:1773-1830`). Facts and
  correspondence citing a retracted capture are folded in TS from one `retracted_evidence_ids` array
  the RPC computes, through the existing shared helpers.
- **Content gate = option A, by channel** (access ruling 8): technicians see technician-channel
  captures; everything else is manager/planner-only. Unknown tier fails closed. Plan 2 adds scope,
  grants and the firm rule to the same predicate.
- **Contents page carries the newest visible note's first 200 chars per job** (ruling 4), jobs
  capped at the 10 most recent with `olderJobs`.
- **`brief_customer` / `answer_customer_question` retired** (ruling 5); `src/synthesis/` (8 files)
  deleted. Live check owed: how a seat answers a brief-style question through contents → open.
- **`search_captures` is technician-only** (ruling 6): listed only to technicians, refused to managers
  at dispatch (the `get_schedule` precedent, `server.ts:445-449`, `:659-664`). Keyword: full-text OR
  substring, no index yet (per-customer scope; a GIN index waits for a measurement).
- **Kept keys the evals and tests grade**: `upcomingVisits[].phrase`, `openWorkNote`, `moneyByJob`
  (omitted when no shown job has money, as today), `customer.attributes` and `jobs[].attributes`
  folded, and **`jobs[]` entries are the job row spread + extras**, so `jobs.find(j => j.id === …)`
  keeps working. Removed: `recentCaptures`, `recentVisits`.
- **Money fold**: `money_events` whose `source_capture_id` is retracted are excluded in the RPC; the
  summary still runs through the shared `summarizeMoney`.
- **Visit reports merged from a since-retracted note**: not rendered here (`lastVisitAt` only); plan
  4's visit page decides how such a report is shown.
- **`get_capture` returns no `metadata`/`blob_path`/`external_id`** (the `v_captures` posture).
- **Hub size cap** (mine): `SPINE_RESULT_CAP_CHARS`, default 20,000 (the planner's
  `MAX_TOOL_RESULT_CHARS`), **read per call** (the `leanGrounding()` precedent, `shared.ts:749-754`),
  announced truncation on every dispatched result. Composio relay and wrapping of untouched
  array tools are plan 4.
- **Phase split is by tool, not by layer** (reviewer finding): each phase deletes an old reader only
  together with its callers, so every phase compiles and passes.
- **`list_recent_captures` keeps its name** (mine): booking descriptions and docs point at it.
- **`get_customer_context` stays on the planner's `CITABLE_TOOLS`/allowlist** (plan 3).

## Plain-language walkthrough

```
seat ──► get_customer_context ──► contents page (fixed size: profile, facts, 10 jobs × {status,
   │                              note count, restricted count, newest note snippet, next visit,
   │                              money}, "N older jobs", customer-level pile)
   ├──► list_recent_captures(jobId, before) ──► one page of notes, text cut at 600 chars, "N more"
   ├──► get_capture(captureId) ──► one note, full words
   └──► search_captures(query, jobId|customerId) ──► matching snippets + ids   (technicians)
                                    every result ──► hub cap: over 20k chars? cut + say so
```

**Phase 1** teaches the database the rules once. A view lists every way a capture is attached to a
customer, job or visit (six kinds today, computed three different ways by three tools). Four
database functions read through it: the contents page, a page of notes, one note, and a keyword
search. Each applies the firm check, drops retracted notes, and hides from technicians what they
may not see. You'd notice it by running the new tests: a note reachable only through a trip link,
which no seat tool finds today, is counted and listed.

**Phase 2** replaces the reader that fetched everything. `get_customer_context` returns the contents
page, the two AI-briefing tools go away, and the tests and evals that named them are rewritten. In
Telegram, "brief me on Mrs. Lee" gets a summary built from the page.

**Phase 3** rewires the drill-down: `list_recent_captures` pages, and `get_capture` and
`search_captures` are new. A follow-up "what exactly did Ben write?" opens the note the page cited.

**Phase 4** puts a size limit at the door: any tool result over 20,000 characters is cut and says so,
so nothing can flood a seat's context by accident.

## Secrets & env preflight

- **Phase 0/1:** a local Supabase stack for THIS worktree: `scripts/second-stack.sh <N>` (the
  worktree's `supabase/config.toml` still carries the default `project_id`; there is no `.env.test`);
  it writes `.env.test`. Pilot apply before merge: the `supabase-test` MCP (`apply_migration`).
- **Phase 2–4:** none beyond `.env.test`. No `.env` needed: the live-model synthesis tests are deleted.
- **Phase 2 live check:** `OPENROUTER_API_KEY` in `.env` for `scripts/spine-eval` (optional; the s2
  canary needs no repo secret).

## Phase 0: integrate

`/integrate`, merge `origin/main` (never rebase), run the four gates. `git log origin/main --oneline`
shows whether the sibling's commits (`c41d1db`, `b9898d9`, `316d4d5`) have landed; if not, proceed —
this plan does not need them — and re-merge before the PR.

## Phase 1: the rules, in the database

### What this phase does
One migration, `supabase/migrations/20260916120000_retrieval_layer_core.sql`: indexes, one view,
two helpers, four RPC functions, grants. Then `npm run gen:types:local`.

### Changes required

**Indexes** — `raw_captures (customer_id, captured_at desc, id desc)`,
`raw_captures (job_id, captured_at desc, id desc)`, `visits (source_capture_id) where source_capture_id is not null`
(lost in the 20260906140000 rename; `captureHasLinkedL2` scans fleet-wide today).

**`capture_membership` view** — columns `(tenant_id, capture_id, customer_id, job_id, visit_id, via)`,
`union all` of nine arms over `raw_captures c`, each joining its parent(s) with
`parent.tenant_id = c.tenant_id` and each further hop's tenant equal to the previous: `customer_stamp`
(c.customer_id), `job_stamp` (c.job_id → jobs.customer_id), `visit_stamp` (c.visit_id → visits →
jobs), `created_customer` (customers.source_capture_id), `created_job`, `created_visit`,
`customer_link` (customer_captures), `job_link` (job_captures), `visit_note` (visit_notes → visits →
jobs). No retraction logic in the view.

**`capture_is_live(p_capture uuid)`** — `sql stable`: true iff the row's `retracts_capture_id is null`
and no row has `retracts_capture_id = p_capture`.

**`capture_visible(p_channel capture_channel, p_sensitivity text, p_tier text)`** — `sql immutable`:
`manager`/`planner` → true; `technician` → `p_channel in ('technician_voice','technician_note','technician_photo')
and p_sensitivity is distinct from 'manager_only'`; any other tier → **false**.

**`customer_contents(p_tenant uuid, p_customer uuid, p_caller_tier text, p_recent_jobs int default 10, p_snippet_chars int default 200) returns jsonb`**
— `plpgsql security definer stable set search_path = public`. `null` unless
`customers.id = p_customer and tenant_id = p_tenant`. Shape:
```
{ customer: <row>, jobs_total, older_jobs,
  jobs: [ { job: <row>, note_count, restricted_count, last_capture_at,
            newest: {id, channel, captured_at, technician_ref, snippet, truncated} | null,
            last_visit_at, money_events: [<row>…] } … ],       -- p_recent_jobs newest by (created_at desc, id desc)
  customer_level: { note_count, restricted_count, newest },    -- membership rows with no job on any arm
  retracted_evidence_ids: [text…] }
```
Rules: a capture counts once per job (`distinct capture_id`); `note_count` = live AND visible,
`restricted_count` = live AND NOT visible; `newest` = newest visible by `(captured_at desc, id desc)`,
`snippet = left(raw_text, p_snippet_chars)`, `truncated = length(raw_text) > p_snippet_chars`;
`last_visit_at = max(completed_at) where status = 'completed'`; `money_events` = the job's rows where
`source_capture_id is null or capture_is_live(source_capture_id)`; `retracted_evidence_ids` = every
value of `jsonb_path_query(attributes, '$.*.sourceCaptureId')` and `'$.correspondence[*].captureId'`
across the customer and its jobs, **kept as text and compared as text** (`r.retracts_capture_id::text = v`)
so a non-uuid seed value cannot fail the read, returning those with a retraction row.

**`captures_page(p_tenant, p_scope text, p_scope_id uuid, p_caller_tier, p_before_at timestamptz default null, p_before_id uuid default null, p_limit int default 20, p_text_chars int default 600, p_include_retracted boolean default false) returns jsonb`**
— scope `'job'` | `'customer'` | `'customer_level'`; the scoped parent must belong to `p_tenant`, else
`{scope_found:false, captures:[]}`. Distinct captures; live unless `p_include_retracted` (then
retracted captures AND retraction rows appear, the former labelled); visible only; keyset
`(captured_at, id) < (p_before_at, p_before_id)`; order `(captured_at desc, id desc)`; `p_limit`
clamped 1..50; fetch `p_limit+1` → `has_more`. Each: `{id, channel, captured_at, technician_ref,
via: [..], text: left(raw_text, p_text_chars), text_truncated, text_chars, retracts_capture_id,
retracted: {id, reason, by, at} | null}`. Plus `total_visible`, `restricted_count`, `next_before_at`,
`next_before_id`.

**`capture_full(p_tenant, p_capture uuid, p_caller_tier, p_include_retracted boolean default false) returns jsonb`**
— `{id, channel, captured_at, technician_ref, raw_text, memberships: [{customer_id, job_id, visit_id, via}], retracted}`
or `null` (wrong tenant, not visible, or retracted without the flag). No metadata/blob/external_id.

**`search_captures(p_tenant, p_scope, p_scope_id, p_query text, p_caller_tier, p_limit int default 10, p_snippet_chars int default 240) returns jsonb`**
— same scope/tenant/live/visible rules as `captures_page`; match =
`to_tsvector('english', raw_text) @@ websearch_to_tsquery('english', p_query)` OR
`raw_text ilike '%' || <p_query with \ % _ escaped> || '%'`; order `ts_rank desc, captured_at desc, id desc`;
`p_limit` clamped 1..25, `+1` → `more`; each `{id, channel, captured_at, technician_ref, snippet:
ts_headline('english', raw_text, websearch_to_tsquery('english', p_query), 'MaxWords=40,MinWords=20,MaxFragments=1')}`.
Blank query → `{matches:[], note:'empty query'}`.

**Grants** — `revoke all on capture_membership from anon, authenticated` (never granted to
`spine_reader`: not a catalog view; `auto_expose_new_tables = true`, `config.toml:31`). Functions:
`revoke all on function … from public, anon, authenticated; grant execute on function … to service_role`
(the `tenant_cost_detail` template, `20260725150000:55-75`).

**`src/db/database.types.ts`** — `npm run gen:types:local` (never `gen:types`, which targets the pilot).

### Automated verification
- [x] `npx supabase db reset` on the worktree stack applies cleanly; the four functions appear under
      `Functions` in the regenerated types (jsonb → `Returns: Json`, the `query_spine` shape).
- [x] New `src/db/retrievalLayer.test.ts` (rpc via `getClient()`): a capture reachable ONLY via
      `visit_notes` and one ONLY via `job_captures` appear in `captures_page('job')` and count in
      `customer_contents`; a retracted capture disappears from all four functions and reappears
      labelled with `p_include_retracted`, retraction row included; a `phone_call` capture is
      restricted for `technician`, visible for `manager`; unknown tier sees nothing; a link row
      carrying another firm's `tenant_id` never appears; keyset paging over 25 captures yields 20 + 5
      with no repeat or gap; `search_captures` finds "capacitor" by word and "4321" by substring,
      within scope only; `retracted_evidence_ids` names a fact's retracted evidence.
- [x] `npm run typecheck`, `npm run lint`, `npm test` (3,142 passed = baseline 3,134 + 8 new).

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP. **Apply to the pilot before the PR merges** (Calls-worker
  auto-deploys at merge), then `NOTIFY pgrst, 'reload schema'` and a `select proname from pg_proc
  where proname in (…)` read-back.

### Manual verification
- [ ] none

---

## Phase 2: the contents page, and the briefing tools retired

### What this phase does
`src/db/context.ts` is rewritten around `customer_contents`; `getCustomerContext`, `CustomerContext`
and `src/synthesis/` go, together with every caller, test and eval that named them.

### Changes required

**`src/db/context.ts`** — keep `UpcomingVisit` and the phrase composition (`:16-53`, `:104-138`)
verbatim; replace the rest with:
```ts
export type CallerTier = 'technician' | 'manager' | 'planner';
export interface CaptureSnippet { captureId; channel; capturedAt; technicianRef; snippet; truncated }
export type JobContents = Job /* attributes folded */ & { noteCount; restrictedCount; lastCaptureAt;
  newest: CaptureSnippet | null; lastVisitAt: string | null; money: MoneySummary | null };
export interface CustomerContents { customer: Customer /* folded */; jobs: JobContents[]; jobsTotal; olderJobs;
  customerLevel: { noteCount; restrictedCount; newest: CaptureSnippet | null }; upcomingVisits: UpcomingVisit[] }
export async function getCustomerContents(tenantId, customerId, tier: CallerTier): Promise<CustomerContents | null>
```
`Promise.all([rpc('customer_contents'), getTenant → listUpcomingVisitsForCustomer])` (three bounded
round trips, no per-row fetch); fold `customer.attributes` with `foldRetractedFacts(…, retractedIds)`,
each job with `foldRetractedCorrespondence(foldRetractedFacts(…))`; `money = rows.length ?
summarizeMoney(rows) : null`; the upcoming rows through the kept phrase code. Narrow the jsonb by
hand (the `readTenantCostDetail` idiom, `src/db/costs.ts:603-620`); throw `customer_contents failed: <message>`.

**`src/mcp/tools/shared.ts`** — add `export const callerTierOf = (ctx: ToolContext): CallerTier =>
ctx.identity.technicianRef.startsWith('spine:') ? 'planner' : ctx.activeManager ? 'manager' : 'technician'`;
remove `BRIEF_FOCUSES` (`:53`) and the `BriefFocus` import (`:31`).

**`src/mcp/tools/customers.ts`**
- `get_customer_context` (`:98-123`): description = the contents page: what each field is;
  "`jobs[].newest` is the newest note's first 200 chars — `get_capture(captureId)` for the full words;
  `list_recent_captures(jobId)` pages a job's notes; `restrictedCount` = notes outside your view";
  keep the `upcomingVisits`/`phrase`/`untimed`/`openWorkNote`/`moneyByJob`/`materialCostCents`
  sentences verbatim. Handler (`:379-432`): `getCustomerContents(tenantId, id, callerTierOf(ctx))`;
  `null` → `{customer:null, jobs:[], note:'no such customer on this firm'}`; result `{customer,
  jobs: [{...jobRow(attributes folded), noteCount, restrictedCount, lastCaptureAt, newest, lastVisitAt}],
  olderJobs, customerLevelNotes, upcomingVisits, moneyByJob?, openWorkNote?}` — `moneyByJob` built
  from `job.money` (manager: summary; else `technicianMoneyView`) and **omitted when no shown job
  has money** (`server.test.ts:6889`); keep the `leanGrounding()` deletions.
- Delete `brief_customer`/`answer_customer_question` definitions (`:139-167`), handlers
  (`:499-537`), registry entries (`:1143-1144`), imports `:61-67`, `:76`, and the now-unused
  `listMoneyEventsForJobs` import (`:37`) and `dropSensitive` destructures (`:380`, `:500`, `:523`).

**`src/mcp/server.ts`** — `ServerDeps` (`:74-77`): drop `brief`/`answer`; drop the
`../synthesis/index.js` import (`:35`); fix the comment at `:94`.

**`src/mcp/tools/surface.expected.ts`** — `TECHNICIAN_TOOLS`: remove the two names.

**Delete** `src/synthesis/` (8 files). `src/model/forcedTool.ts:422` and `forcedTool.test.ts:93` are
text only — leave. Comments to fix: `src/db/customers.ts:249`, `src/db/rawCaptures.ts:209`,
`src/db/foldImpact.ts:182`, `src/db/visits.ts:1459`.

**Tests** — `src/db/context.test.ts` (four tests → contents assertions), `customerCaptures.test.ts:109-150`,
`retractions.test.ts:124-164` → `getCustomerContents`. `src/mcp/server.test.ts`: deps stubs `:114-118`,
`:162-163`; `:835-844` (contents shape); delete `:847-884`; `:895-928` keep the context half, drop
`okBrief` (`:906-907`) and the brief/answer calls (`:924-928`); `:1413-1455` (assert the retracted
note via `jobs[].noteCount` here, via the page in Phase 3); `:1583-1672`, `:1681-1721`
(`jobs[].lastVisitAt`); `:2860-2925` → the option-A rule on the contents page (`restrictedCount`
for a technician, 0 for a manager; drop the briefer stub); `:1670`, `:4012`, `:4027`, `:8933`, `:9059`
keep working because job entries keep `id`; `:8427` unchanged.

**Evals** — `src/eval/toolCases.ts`: delete X01/X02 (`:1272-1303`); `toolCases.test.ts:129-136`:
drop the two names; `src/eval/corpus.ts` Q01 (`:726-735`): `requiredOneOf: [['get_customer_context']]`;
M07 (`:1210-1212`): drop the two names from its `requiredOneOf`.

**Docs** — `docs/onboarding.md:220-226`, `docs/nemoclaw-tech-agent.md:92-96,323-324,749-750`,
`docs/doorman-runbook.md:371-376`, `.claude/skills/growth/product/tradesdatabase.md:163-164`,
`scripts/spine-eval/lib/env.mjs:117`, `scripts/spine-eval/world.mjs:299-300`,
`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:24`, `doorman-architecture-memory.md:372`,
`migration-runbook-lightsail.md:199-200` (the Box_Setup_Stuff sync rule). `engineering-memory.md`
entries are history — leave.

### Automated verification
- [x] `grep -rn "getCustomerContext\|CustomerContext\b\|synthesis/" src scripts` returns nothing
      (only the handler name `handleGetCustomerContext`, which is the tool's own).
- [x] `npm run typecheck`, `npm run lint`, `npm test` (3,127 passed); `npx vitest run src/eval/toolCases.test.ts`.

### Live verification (agent-executable)
- Prerequisites: `scripts/spine-eval` agent runner with `OPENROUTER_API_KEY`, seeded local world.
  **Runs after Phase 3, not on a Phase-2-only build**: the description already points the model at
  `get_capture` and a paging `list_recent_captures`, which arrive in Phase 3 (reviewer finding).
- [ ] Q01, M07, C05 pass on the new path; record the tool sequence.

### Manual verification (ruling 5)
- [ ] After the PR deploys: **restart the s2 gateway** (its `tools/list` cache is per process) and
      read `tools/list` back — no `brief_customer`. Then in Telegram: "give me a quick brief on
      <customer> before I go" and "anything I should know at <customer>?" — judge shape and
      formatting; note what to tune (AGENTS.md doctrine or the tool's `note` fields).

---
*Pause after this phase: its Manual verification list is non-empty.*

## Phase 3: the drill-down verbs

### What this phase does
`list_recent_captures` pages; `get_capture` and `search_captures` are added; the stamp-only readers
lose their last tool caller.

### Changes required

**`src/db/context.ts`** — add:
```ts
export async function listCapturesPage(tenantId, scope: 'job'|'customer'|'customer_level', scopeId, tier,
  opts: { beforeAt?; beforeId?; limit?; textChars?; includeRetracted? }): Promise<CapturesPage>
export async function getCaptureFull(tenantId, captureId, tier, includeRetracted = false): Promise<CaptureFull | null>
export async function searchCaptures(tenantId, scope, scopeId, query, tier, opts: { limit?; snippetChars? }): Promise<CaptureSearch>
```

**`src/mcp/tools/captures.ts`** — `list_recent_captures` (`:127-143`, `:593-638`): args `jobId |
customerId`, `before` (`"<iso>|<uuid>"` copied from a prior `next`), `limit` (≤50), `textChars`
(≤2000), `includeRetracted` (manager; keep the exact refusal text containing `'manager badge'`,
`:600-602`); handler → `listCapturesPage` with scope `'job'`/`'customer'`; result `{captures,
hasMore, next, totalVisible, restrictedCount, note}` with `note` stating emptiness or an unknown
scope in words. Add `get_capture` and `search_captures` to `BASE_TOOLS` + handlers. Remove the
now-unused imports `foldRetractions` (`:20`), `listRawCapturesForCustomer` (`:34`),
`listRawCapturesForJob` (`:35`) and the `dropSensitive` destructure (`:594`).

**`src/mcp/server.ts`** — `MANAGER_TOOLS` (`:445-449`): filter out `search_captures` beside
`get_schedule`; inverse gate (`:659-664`): refuse `search_captures` for `activeManager`
("managers search with query_spine over v_captures").

**`src/mcp/tools/surface.expected.ts`** — add `get_capture`, `search_captures` to `TECHNICIAN_TOOLS`;
`MANAGER_TOOLS_EXPECTED` filters both `get_schedule` and `search_captures`.

**Tests** — `server.test.ts`: `:384-388` (use `find_customer` as the array-shaped result);
`:921-922` (object now); `:1773-1830` (trail: `captures[].retracted` object, retraction row present);
`:4047-4053` (same); new: `get_capture` cross-tenant → not found, a technician's `get_capture` on a
`phone_call` → not found, `search_captures` refused to a manager and found by a technician, a
cursor round-trip over two pages.

**Evals** — `src/eval/toolCases.ts`: `R16 get_capture`, `R17 search_captures` (badge `tech-jane`,
`mentions('capacitor')` against `edge-rich`; R14/R15 are taken); R05's comment (`:221-232`) is now
wrong — the intake call IS in scope via `created_customer`. `corpus.ts` Q01: `requiredOneOf:
[['get_customer_context','list_recent_captures','get_capture']]`.

**Docs** — `docs/doorman-runbook.md:371-376` (17 names again), `docs/nemoclaw-tech-agent.md:286,309-310,323-324`.

### Automated verification
- [ ] `grep -rn "listRawCapturesForJob\|listRawCapturesForCustomer" src/mcp` returns nothing.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`; `npx vitest run src/eval/toolCases.test.ts`.

### Live / Manual verification
- [ ] none

---

## Phase 4: the size cap at the door

### What this phase does
Every dispatched result over the cap is cut and says so, so no tool can flood a seat's window.

### Changes required

**`src/mcp/resultCap.ts`** (new) — `export const resultCapChars = () => safeEnvInt(process.env.SPINE_RESULT_CAP_CHARS, 20_000)`
(read per call, like `leanGrounding()`; same default as `toolLoop.ts:76`);
`export function capToolResult(text: string, cap = resultCapChars()): string` → unchanged when
`≤ cap`, else `JSON.stringify({truncated:true, chars:text.length, limit:cap, note:'This result was cut
at the limit — ask for less: one job, one page (`before`), one note (get_capture), or search_captures.',
partial: text.slice(0, cap)})`.

**`src/mcp/server.ts:902`** — `text: capToolResult(JSON.stringify(grounded))`. The `now` rider stays
inside `partial`; the cap object is not re-decorated.

### Automated verification
- [ ] `src/mcp/resultCap.test.ts`: under / at / over; valid JSON out; `safeEnvInt` fallback on a
      malformed value.
- [ ] `server.test.ts`: set `process.env.SPINE_RESULT_CAP_CHARS = '400'` around ONE call (restore in
      `finally`), `get_customer_context` on a two-job customer → `truncated:true`, parseable JSON.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

### Live / Manual verification
- [ ] none
