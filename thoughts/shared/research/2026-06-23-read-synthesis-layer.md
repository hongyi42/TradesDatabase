---
date: 2026-06-23
branch: context-spine-basic-structure
commit: 7e61212
topic: The read/synthesis layer — read-path features that surface spine data (overview build-order step 3)
---

## Summary
This documents the **read side** of the three-layer context spine: the code that reads an
already-populated record and returns it for "brief me on this customer" / "what did the last tech
say" use cases ([Three-Layer-Context-Spine-Overview.md:154-155](../../../Three-Layer-Context-Spine-Overview.md#L154-L155),
[§2:33-34](../../../Three-Layer-Context-Spine-Overview.md#L33-L34)). In practice today this is a set
of typed query functions in `src/db/`, one aggregator (`getCustomerContext`) that fans out across the
three layers and unions captures from two provenance sources, and five MCP tools in
`src/mcp/server.ts` (one write tool + four read tools) that expose them to an agent. **A key finding:
the "synthesis" half described in the overview — an AI model turning the aggregated record into a
briefing narrative, a history summary, or an on-site answer — does not exist in the codebase. What
exists is data *aggregation and retrieval*; any narrative synthesis is left to whatever agent consumes
the tool output.** No `@anthropic-ai/sdk` call exists on the read path (extraction is the only AI use,
and it is on the write path).

## Entry Points
- **MCP read tools** — [src/mcp/server.ts:32-90](../../../src/mcp/server.ts#L32-L90) (the `TOOLS`
  declarations) dispatched in [src/mcp/server.ts:92-148](../../../src/mcp/server.ts#L92-L148):
  - `find_customer` — [server.ts:123-127](../../../src/mcp/server.ts#L123-L127)
  - `get_customer_context` — [server.ts:128-132](../../../src/mcp/server.ts#L128-L132)
  - `get_job` — [server.ts:133-137](../../../src/mcp/server.ts#L133-L137)
  - `list_recent_captures` — [server.ts:138-144](../../../src/mcp/server.ts#L138-L144)
- **The aggregator** — `getCustomerContext` at [src/db/context.ts:18-42](../../../src/db/context.ts#L18-L42).
- **Direct programmatic use** — anything importing from [src/db/index.ts](../../../src/db/index.ts),
  which re-exports every read function ([index.ts:1-8](../../../src/db/index.ts#L1-L8)).

## Key Files

### `src/db/context.ts` — the aggregator (the closest thing to "synthesis")
- Exports `interface CustomerContext { customer: Customer | null; jobs: Job[]; recentVisits: Visit[]; recentCaptures: RawCapture[] }` ([context.ts:6-11](../../../src/db/context.ts#L6-L11)).
- Exports `getCustomerContext(customerId): Promise<CustomerContext>` ([context.ts:18-42](../../../src/db/context.ts#L18-L42)).
- Depends on: `getCustomer`, `listJobsForCustomer`, `listVisitsForCustomer`, `listRawCapturesForCustomer`, `getRawCapture`.
- Dependents: the MCP `get_customer_context` tool ([server.ts:128-132](../../../src/mcp/server.ts#L128-L132)); tested by [src/db/context.test.ts](../../../src/db/context.test.ts).

### `src/db/customers.ts` — customer reads
- `getCustomer(id): Promise<Customer | null>` — single row by id, `maybeSingle` (null if absent) ([customers.ts:42-46](../../../src/db/customers.ts#L42-L46)).
- `searchCustomers(tenantId, query): Promise<Customer[]>` — the backing for `find_customer`; case-insensitive `OR` across `name`/`phone`/`address_line1`, `limit 20`; strips `,()` because they are PostgREST `.or()` syntax chars ([customers.ts:77-87](../../../src/db/customers.ts#L77-L87)).
- `findCustomersByPhone` / `findCustomersByAddress` ([customers.ts:50-73](../../../src/db/customers.ts#L50-L73)) are read functions but used by the **write-path** matcher, not the read tools — noted here only to disambiguate (out of this scope).

### `src/db/jobs.ts` — job reads
- `getJob(id): Promise<Job | null>` — single row, `maybeSingle` ([jobs.ts:50-54](../../../src/db/jobs.ts#L50-L54)). Backs the `get_job` MCP tool.
- `listJobsForCustomer(customerId): Promise<Job[]>` — all jobs for a customer, **ordered `created_at` ascending** (oldest first) ([jobs.ts:56-64](../../../src/db/jobs.ts#L56-L64)).
- (`ALLOWED_TRANSITIONS` and `updateJobStatus` are write-path; not part of the read layer.)

### `src/db/visits.ts` — visit reads
- `listVisitsForJob(jobId): Promise<Visit[]>` — visits for one job, **ordered `created_at` ascending** ([visits.ts:38-46](../../../src/db/visits.ts#L38-L46)).
- `listVisitsForCustomer(customerId): Promise<Visit[]>` — visits across all of a customer's jobs. Visits carry **no** `customer_id`, so it queries `jobs` with a nested PostgREST embed `select('visits(*)')`, flattens, then sorts **`created_at` descending** (newest first) in JS ([visits.ts:50-58](../../../src/db/visits.ts#L50-L58)).

### `src/db/rawCaptures.ts` — L1 reads
- `getRawCapture(id): Promise<RawCapture | null>` — single capture by id ([rawCaptures.ts:42-46](../../../src/db/rawCaptures.ts#L42-L46)). (Read is allowed; the append-only trigger only blocks UPDATE/DELETE.)
- `listRawCapturesForJob(jobId): Promise<RawCapture[]>` — captures whose `job_id` column equals jobId, **`captured_at` descending** ([rawCaptures.ts:50-58](../../../src/db/rawCaptures.ts#L50-L58)).
- `listRawCapturesForCustomer(customerId): Promise<RawCapture[]>` — captures whose `customer_id` column equals customerId, **`captured_at` descending** ([rawCaptures.ts:61-69](../../../src/db/rawCaptures.ts#L61-L69)).
- Both list functions read **only the directly-stamped** column; captures linked to a customer/job solely via an L2 row's `source_capture_id` are **not** returned here (see Data Flows / `getCustomerContext`).

### `src/mcp/server.ts` — the agent-facing boundary
- `createServer(deps): Server` ([server.ts:150-172](../../../src/mcp/server.ts#L150-L172)) builds an MCP `Server` exposing the five `TOOLS`; `main()` connects it over stdio only when run directly ([server.ts:174-186](../../../src/mcp/server.ts#L174-L186)).
- `dispatch(name, args, deps)` ([server.ts:92-148](../../../src/mcp/server.ts#L92-L148)) routes each tool call; resolves the tenant once via `requireTenant()` ([server.ts:26-30](../../../src/mcp/server.ts#L26-L30), reading `DEFAULT_TENANT_ID`).
- Results are JSON-stringified into a single text content block; errors return `{ isError: true }` with a plain message ([server.ts:158-169](../../../src/mcp/server.ts#L158-L169)).

### `src/db/client.ts` — shared Supabase client
- `getClient()` returns the `@supabase/supabase-js` client built from `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (service-role; bypasses RLS — RLS is off in v1). Every read function above calls it.

### Tests (behavioral evidence)
- [src/db/context.test.ts](../../../src/db/context.test.ts) — asserts `getCustomerContext` aggregates customer + jobs + visits + captures, and that a tech note reachable **only** via `source_capture_id` is surfaced alongside a capture stamped with `customer_id` ([context.test.ts:26-60](../../../src/db/context.test.ts#L26-L60)); asserts `listRawCapturesForCustomer` returns newest-first ([context.test.ts:62-81](../../../src/db/context.test.ts#L62-L81)). Reads cross-channel via direct `pg`.
- [src/mcp/server.test.ts](../../../src/mcp/server.test.ts) — drives the server over the SDK in-memory transport; asserts the five-tool surface ([server.test.ts:46-57](../../../src/mcp/server.test.ts#L46-L57)) and that `get_customer_context` returns the aggregated shape ([server.test.ts:96-106](../../../src/mcp/server.test.ts#L96-L106)).

## Data Flows

### `get_customer_context` (the main read flow)
1. Agent calls MCP tool `get_customer_context({ customerId })` → [dispatch case, server.ts:128-132](../../../src/mcp/server.ts#L128-L132) → `getCustomerContext(customerId)`.
2. **Parallel fan-out** ([context.ts:19-24](../../../src/db/context.ts#L19-L24)): `getCustomer(id)`, `listJobsForCustomer(id)`, `listVisitsForCustomer(id)`, `listRawCapturesForCustomer(id)`.
3. **Capture union** ([context.ts:26-35](../../../src/db/context.ts#L26-L35)): seed a `Map<id, RawCapture>` with the `customer_id`-stamped captures; then collect `source_capture_id` from every job and visit, drop any already in the map, de-dupe with a `Set`, fetch each missing one via `getRawCapture`, and add it. This is the dual-source merge: captures reach a customer either by a directly-stamped `customer_id` **or** via an L2 row's `source_capture_id` back-link.
4. **Sort** ([context.ts:37-39](../../../src/db/context.ts#L37-L39)): `recentCaptures` sorted by `captured_at` descending.
5. Returns `{ customer, jobs, recentVisits, recentCaptures }`; the dispatcher JSON-stringifies it back to the agent.

### `find_customer`
`find_customer({ query })` → [server.ts:123-127](../../../src/mcp/server.ts#L123-L127) → `searchCustomers(tenantId, query)` → `ilike` `OR` over name/phone/address_line1, `limit 20` ([customers.ts:77-87](../../../src/db/customers.ts#L77-L87)). This is fuzzy lookup-for-display, **not** identity resolution (it never touches `matchIdentity`).

### `get_job`
`get_job({ jobId })` → [server.ts:133-137](../../../src/mcp/server.ts#L133-L137) → `getJob(jobId)` → single row or null.

### `list_recent_captures`
`list_recent_captures({ jobId? , customerId? })` → [server.ts:138-144](../../../src/mcp/server.ts#L138-L144). **`jobId` takes precedence**: if present → `listRawCapturesForJob`; else if `customerId` → `listRawCapturesForCustomer`; else throws. Returns only directly-stamped captures (no `source_capture_id` union — unlike `get_customer_context`).

## External Dependencies
- **`@modelcontextprotocol/sdk`** — `Server`, `StdioServerTransport`, request schemas ([server.ts:1-3](../../../src/mcp/server.ts#L1-L3)); `Client` + `InMemoryTransport` in tests.
- **`@supabase/supabase-js`** — all reads go through PostgREST via `getClient()` (including the nested embed `select('visits(*)')` in `listVisitsForCustomer`).
- **`pg`** — direct Postgres, **tests only** (independent read-back channel).
- **No `@anthropic-ai/sdk` / no Google APIs on the read path.** (Anthropic is used only by the write-path extractor; Google only by schedule sync.) This is the concrete evidence that AI *synthesis* is not implemented on reads.

## Constraints and Invariants
- **"Synthesis" is aggregation, not generation.** `getCustomerContext` assembles a structured bundle; there is no code that turns it into a natural-language briefing, summary, or answer. The overview's step-3 read/synthesis features (pre-visit briefing, customer-memory summary, on-site Q&A — [overview:33-34](../../../Three-Layer-Context-Spine-Overview.md#L33-L34), [§6.3](../../../Three-Layer-Context-Spine-Overview.md#L154-L155)) are only partially realized: the *gather* exists, the *synthesize* does not.
- **Dual provenance must both be read to see all captures.** Because a tech note lands in L1 with `customer_id = null` and its link lives only on the L2 row's `source_capture_id` ([context.ts:14-17](../../../src/db/context.ts#L14-L17)), only `getCustomerContext` unions both sources. The plain `list_recent_captures` / `listRawCapturesFor*` functions return the directly-stamped column **only** — so a capture linked solely via `source_capture_id` will **not** appear in `list_recent_captures` but **will** appear in `get_customer_context`. These two read tools can return different capture sets for the same customer.
- **Ordering is inconsistent by design across functions:** `listJobsForCustomer` and `listVisitsForJob` are **ascending** (oldest first); `listVisitsForCustomer`, `listRawCapturesForJob`, `listRawCapturesForCustomer`, and the unioned `recentCaptures` are **descending** (newest first). `getCustomerContext` therefore returns `jobs` oldest-first but `recentVisits`/`recentCaptures` newest-first in the same object.
- **No pagination or recency cap on the "recent" fields.** Despite the names `recentVisits`/`recentCaptures` and the tool description "recent raw captures," no `limit` is applied anywhere except `searchCustomers` (`limit 20`). `getCustomerContext` returns *all* visits and *all* captures for the customer.
- **`getCustomerContext` does not throw on a missing customer.** `getCustomer` uses `maybeSingle`, so `customer` may be `null` while the other arrays are still queried (they would be empty for a non-existent id) ([context.ts:18-42](../../../src/db/context.ts#L18-L42)).
- **Tenant scoping is uneven across read tools.** `find_customer` → `searchCustomers` is filtered by `tenant_id` ([customers.ts:81](../../../src/db/customers.ts#L81)). But `get_customer_context`, `get_job`, and `list_recent_captures` resolve **by entity id alone** — none of `getCustomer`, `getJob`, `getCustomerContext`, `listVisitsForCustomer`, `listRawCapturesFor*` filters on `tenant_id`. The MCP server pins `DEFAULT_TENANT_ID` for search and writes, but a by-id read is not re-checked against that tenant.
- **Service-role client bypasses RLS** (RLS is off in v1), so the only row-visibility boundary on reads is application code — consistent with the deferred access-control note ([thoughts/shared/research/2026-06-20-open-question-agent-row-level-access-control.md](2026-06-20-open-question-agent-row-level-access-control.md)).
- **Tool output is a JSON string in a text block** ([server.ts:162](../../../src/mcp/server.ts#L162)); the consuming agent must parse it. Errors come back as a plain message string with `isError: true`, not JSON.

## Open Questions
- **Where will the AI synthesis layer live?** No module today converts a `CustomerContext` into a briefing/summary/answer; whether that becomes a server-side function (a new Anthropic call) or is delegated entirely to the consuming agent is not determinable from the code.
- **Are the unbounded `recentVisits`/`recentCaptures` intentional?** The "recent" naming implies a cap that the code does not enforce; behavior on a long-history customer (hundreds of captures) is untested here.
- **Is the by-id-without-tenant read acceptable?** `get_customer_context`/`get_job`/`list_recent_captures` trust the caller-supplied id without re-checking `DEFAULT_TENANT_ID`. Under single-tenant v1 this is moot, but it intersects the deferred row-level access work; confirming the intended boundary needs the agent-infra/multi-tenant decision, not just reading the code.
- **Divergent capture sets between the two read tools** (`get_customer_context` unions `source_capture_id`; `list_recent_captures` does not) — whether callers are expected to know this distinction is unclear from the code/comments alone.
