---
date: 2026-06-23
branch: context-spine-basic-structure
commit: 7e61212
topic: Centralized gateway-mediated MCP server (Architecture A) — current code, seams, and constraints
---

> **Correction (2026-06-23):** an earlier draft of this doc described `src/mcp/server.ts` as a 5-tool,
> ~187-line file. The committed file is **249 lines with 7 tools** — the synthesis tools
> `brief_customer` and `answer_customer_question` were added. All line numbers and the tool inventory
> below reflect the actual file.

## Summary
The trades-spine MCP server ([src/mcp/server.ts](../../../src/mcp/server.ts)) is the single boundary a
NemoClaw agent calls to read/write the three-layer spine. As built today it is a **stdio,
single-tenant, process-pinned** server: it is launched as a child process (`node dist/mcp/server.js`),
its tenant is fixed for the whole process via the `DEFAULT_TENANT_ID` env var, and it holds the
Supabase service-role key + Anthropic key in its own environment. "Architecture A" is the planned move
to **one central server every bot calls**, reachable only by the OpenShell/NemoClaw gateway over
mTLS + a caller allowlist, where the gateway asserts `(tenant, technician)` per request via a signed
header and the server ignores any model-supplied `technicianRef`. This document records, against the
code as it exists today, the exact seams a change moves through (transport, identity resolution, tool
dispatch, the data layer's tenant scoping) and the invariants Architecture A must preserve. It makes no
recommendations — the design itself belongs to the plan that follows.

## Entry Points
- [src/mcp/server.ts:237-249](../../../src/mcp/server.ts#L237-L249) — `main()` and the direct-execution
  guard. `main()` connects a **`StdioServerTransport`** ([:239](../../../src/mcp/server.ts#L239)); this
  is the only transport wired today. The guard at [:244](../../../src/mcp/server.ts#L244)
  (`process.argv[1] === fileURLToPath(import.meta.url)`) means the stdio server starts only when the
  file is executed directly, never when imported by tests.
- [src/mcp/server.ts:213-235](../../../src/mcp/server.ts#L213-L235) — `createServer(deps)`, the
  transport-agnostic factory. Registers the `ListToolsRequestSchema` handler
  ([:219](../../../src/mcp/server.ts#L219)) and the `CallToolRequestSchema` handler
  ([:221-232](../../../src/mcp/server.ts#L221-L232), which wraps `dispatch` and serializes the result;
  errors → `isError: true`). Returns a `Server` any `Transport` can later be `connect()`-ed to.
- `package.json` script `mcp:serve` → `node dist/mcp/server.js` is the production entrypoint;
  `npm run build` (`tsc -p tsconfig.json`) produces `dist/`.

## Key Files
- [src/mcp/server.ts](../../../src/mcp/server.ts) — the MCP boundary. Exports `createServer(deps)` and
  `ServerDeps` (`{ extract?, brief?, answer? }`, [:27-31](../../../src/mcp/server.ts#L27-L31)). Defines
  `TECH_CHANNELS` ([:33](../../../src/mcp/server.ts#L33)), `BRIEF_FOCUSES`
  ([:34](../../../src/mcp/server.ts#L34)), `requireTenant()`
  ([:36-40](../../../src/mcp/server.ts#L36-L40)), the static **7-tool** `TOOLS` array
  ([:42-129](../../../src/mcp/server.ts#L42-L129)), and `dispatch(name, args, deps)`
  ([:131-211](../../../src/mcp/server.ts#L131-L211)). Imports the synthesizers from `../synthesis/index.js`
  ([:15-21](../../../src/mcp/server.ts#L15-L21)).
- [src/mcp/server.test.ts](../../../src/mcp/server.test.ts) — drives the server over the SDK's
  **`InMemoryTransport`** ([:25](../../../src/mcp/server.test.ts#L25)), not stdio/HTTP. Sets
  `process.env.DEFAULT_TENANT_ID` from a seed tenant ([:22](../../../src/mcp/server.test.ts#L22)) and
  injects a stub extractor ([:24](../../../src/mcp/server.test.ts#L24)). Confirms the server core is
  transport-independent.
- [src/synthesis/index.ts](../../../src/synthesis/index.ts) — exports `sonnetBriefer`, `sonnetAnswerer`,
  and the `Briefer`/`Answerer`/`BriefFocus` types backing the two read-synthesis tools. These are
  model-backed reads (Anthropic), injectable via `ServerDeps.brief`/`.answer`.
- [src/writePath/recordFieldNote.ts](../../../src/writePath/recordFieldNote.ts) — the channel-agnostic
  write-path behind `record_field_note`. `RecordFieldNoteInput`
  ([:19-30](../../../src/writePath/recordFieldNote.ts#L19-L30)) carries `tenantId`, `technicianRef`,
  `text`, `channel`, optional `confirmed`, optional `captureId`. L1-first + resume at
  [:58-78](../../../src/writePath/recordFieldNote.ts#L58-L78).
- [src/writePath/identityMatch.ts](../../../src/writePath/identityMatch.ts) — deterministic identity
  matching; `matchIdentity()` ([:44](../../../src/writePath/identityMatch.ts#L44)) takes `tenantId` +
  `technicianRef` + `capturedAt`.
- [src/writePath/extract.ts](../../../src/writePath/extract.ts) — `sonnetExtractor` reads
  `ANTHROPIC_API_KEY` at call time ([:74-75](../../../src/writePath/extract.ts#L74-L75)); injectable.
- [src/db/client.ts](../../../src/db/client.ts) — `getClient()` builds a **module-cached** Supabase
  client from `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  ([:9-17](../../../src/db/client.ts#L9-L17)); the comment notes the service-role key **bypasses RLS**.
- [src/db/customers.ts](../../../src/db/customers.ts) — `searchCustomers(tenantId, query)`
  ([:77-87](../../../src/db/customers.ts#L77-L87)) is tenant-scoped; `getCustomer(id)`
  ([:42-46](../../../src/db/customers.ts#L42-L46)) is **not** (barrel-exported from `../db/index.js`).
- [src/db/jobs.ts](../../../src/db/jobs.ts) — `getJob(id)`
  ([:50-54](../../../src/db/jobs.ts#L50-L54)) by `id` only, **no tenant filter**.
- [src/db/context.ts](../../../src/db/context.ts) — `getCustomerContext(customerId)`
  ([:18](../../../src/db/context.ts#L18)) aggregates customer + jobs + visits + captures by id; **no
  tenant argument**. Returns `{ customer, jobs, recentVisits, recentCaptures }`.
- [src/db/rawCaptures.ts](../../../src/db/rawCaptures.ts) — `appendRawCapture` (insert-only, L1
  append-only at [:19-20](../../../src/db/rawCaptures.ts#L19-L20)), `getRawCapture`,
  `listRawCapturesForJob`, `listRawCapturesForCustomer` — all id-scoped, **no tenant filter**.
- [.env.example](../../../.env.example) — env contract: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ANTHROPIC_API_KEY`, `DEFAULT_TENANT_ID` ("the single tenant every tool call is fixed to").
- [thoughts/shared/research/2026-06-20-open-question-agent-row-level-access-control.md](2026-06-20-open-question-agent-row-level-access-control.md)
  — prior research: NemoClaw policy controls *which tools/hosts* but **cannot** be the row-level
  boundary; identity must be a gateway-pinned value the agent cannot forge.

## Data Flows

### Tenant identity today (process-global)
`dispatch()` calls `requireTenant()` as its first line
([src/mcp/server.ts:136](../../../src/mcp/server.ts#L136)) for **every** tool; `requireTenant()` reads
`process.env.DEFAULT_TENANT_ID` ([:36-40](../../../src/mcp/server.ts#L36-L40)) — one value for the whole
process. There is no per-request tenant. The resolved `tenantId` reaches the write-path and the
tenant-scoped read (`searchCustomers`).

### Technician identity today (from tool args)
`record_field_note` reads `technicianRef` from the **tool arguments**
([src/mcp/server.ts:142-143](../../../src/mcp/server.ts#L142-L143)) — a model-supplied string, not a
gateway-pinned identity. (The 2026-06-20 doc names this as the value that must become unforgeable.)

### `record_field_note` end-to-end (write-path)
1. Dispatch validates `technicianRef`/`channel`, defaults channel to `technician_note`
   ([src/mcp/server.ts:141-160](../../../src/mcp/server.ts#L141-L160)).
2. `recordFieldNote` **L1 first**: insert verbatim row, or **reload by `captureId`** on a resume turn
   ([src/writePath/recordFieldNote.ts:58-78](../../../src/writePath/recordFieldNote.ts#L58-L78)).
3. `extract` → `matchIdentity` → on unresolved-and-unconfirmed, return `{ status, captureId, suggestion }`
   ([:93-95](../../../src/writePath/recordFieldNote.ts#L93-L95)); the resume carries the same
   `captureId` and never writes a second capture. On resolve, L2/L3 rows are written with
   `source_capture_id` provenance.

### Read tools (7 total; **5 take an agent-supplied id**)
- `find_customer` → `searchCustomers(tenantId, query)` — tenant-scoped
  ([src/mcp/server.ts:162-166](../../../src/mcp/server.ts#L162-L166)).
- `get_customer_context` → `getCustomerContext(customerId)` — id only, no tenant
  ([:167-171](../../../src/mcp/server.ts#L167-L171)).
- `get_job` → `getJob(jobId)` — id only, no tenant
  ([:172-176](../../../src/mcp/server.ts#L172-L176)).
- `list_recent_captures` → `listRawCapturesForJob`/`listRawCapturesForCustomer` — id only, no tenant
  ([:177-183](../../../src/mcp/server.ts#L177-L183)).
- `brief_customer` → `getCustomerContext(customerId)` then `(deps.brief ?? sonnetBriefer)(ctx, focus)`
  ([:184-198](../../../src/mcp/server.ts#L184-L198)). Guards only `!ctx.customer`
  ([:195](../../../src/mcp/server.ts#L195)) — **no tenant check**.
- `answer_customer_question` → `getCustomerContext(customerId)` then `(deps.answer ?? sonnetAnswerer)`
  ([:199-207](../../../src/mcp/server.ts#L199-L207)). Same `!ctx.customer`-only guard
  ([:205](../../../src/mcp/server.ts#L205)) — **no tenant check**.

### Transport seam
`createServer()` returns a `Server`; `Server.connect(transport)` accepts any SDK `Transport`. Today
`main()` connects `StdioServerTransport`; the same `Server` can be connected to a different transport
without touching `createServer`, the handlers, `dispatch`, or any tool.

## External Dependencies
- **`@modelcontextprotocol/sdk` v1.29.0** — installed; ships `StdioServerTransport` (in use),
  **`StreamableHTTPServerTransport`** (`server/streamableHttp.js`; constructor takes
  `sessionIdGenerator` — `undefined` ⇒ stateless; `handleRequest(req, res, parsedBody?)` wraps node
  `http` req/res, no express needed), a Web-standard variant, the deprecated `sse` transport, and
  `auth/middleware/bearerAuth.js` `requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl })`
  (relevant to a future Option B, unused today).
- **`@supabase/supabase-js` v2.108.x** — `createClient` with the service-role key. Sole DB path.
- **`@anthropic-ai/sdk` v0.105.x** — `claude-sonnet-4-6`, forced-tool extraction
  ([src/writePath/extract.ts:73-91](../../../src/writePath/extract.ts#L73-L91)); also backs the two
  synthesis read tools.
- **Supabase (test project)** — the spine DB; prod is read-only, writes target test only.

## Constraints and Invariants
- **Identity must be gateway-pinned, never model-chosen** (2026-06-20 doc): the row selector is an
  LLM-chosen argument, so trusting it delegates authorization to the model. Documented near-term
  mechanism: a gateway-pinned identity from env/SecretRef (today `DEFAULT_TENANT_ID` via
  `requireTenant()`), ignoring any `technicianRef` in tool args.
- **The service-role key bypasses RLS** ([src/db/client.ts:6-8](../../../src/db/client.ts#L6-L8)) — the
  MCP server's app-layer checks are the *only* authorization boundary; the DB enforces none.
- **Read-by-id functions are NOT tenant-scoped.** `getCustomer`, `getJob`, `getCustomerContext`,
  `getRawCapture`, `listJobsForCustomer`, `listVisitsForCustomer`, `listRawCapturesForJob/Customer`
  select by id/`customer_id`/`job_id` with no `tenant_id` predicate (e.g.
  [src/db/jobs.ts:50-54](../../../src/db/jobs.ts#L50-L54),
  [src/db/context.ts:18](../../../src/db/context.ts#L18)). **Five MCP tools reach these unguarded:**
  `get_job`, `get_customer_context`, `list_recent_captures`, **and both synthesis tools**
  `brief_customer`/`answer_customer_question` (they call `getCustomerContext` and guard only
  `!ctx.customer`). Only `searchCustomers`/`findCustomersByPhone`/`findCustomersByAddress` filter by
  tenant. Under one pinned tenant this is latent; with one server serving many tenants, an id from
  another tenant is not rejected. The Row types (`customers`/`jobs`/`raw_captures`/`visits`) **do**
  carry `tenant_id`, so a guard can be applied on the fetched row.
- **Tenant is process-global, not per-request** ([src/mcp/server.ts:36-40](../../../src/mcp/server.ts#L36-L40));
  the Supabase client is module-cached ([src/db/client.ts:4,15](../../../src/db/client.ts#L4)). Nothing
  threads a per-call tenant/identity.
- **L1 is append-only** ([src/db/rawCaptures.ts:19-20](../../../src/db/rawCaptures.ts#L19-L20)) — insert
  + read only; provenance lives on the L2 row, never written back onto the capture.
- **Statelessness / horizontal-scaling property.** The write-path holds no in-memory state across
  calls: a `needs_confirmation`/`needs_disambiguation` result returns a DB-persisted `captureId`
  ([src/writePath/recordFieldNote.ts:93-95](../../../src/writePath/recordFieldNote.ts#L93-L95)) and the
  resume reloads that row by id ([:62-67](../../../src/writePath/recordFieldNote.ts#L62-L67)). Any
  instance can serve the resume — no application-layer session affinity. (The SDK transport separately
  offers `sessionIdGenerator: undefined` for stateless transport operation.)
- **Only `main()` is tied to stdio** ([src/mcp/server.ts:237-240](../../../src/mcp/server.ts#L237-L240));
  `createServer`, the handlers, `dispatch`, and all seven tools are transport-agnostic. Tests confirm
  this via `InMemoryTransport`.
- **Tool surface is exactly seven:** `record_field_note`, `find_customer`, `get_customer_context`,
  `get_job`, `list_recent_captures`, `brief_customer`, `answer_customer_question`
  ([src/mcp/server.ts:42-129](../../../src/mcp/server.ts#L42-L129)). (The per-box runbook's allowlist
  predates the two synthesis tools and lists only the first five.)

## Architecture A: how each requirement maps onto the current code (factual mapping, not design)
- **One central Streamable HTTP server** lands at the transport seam only: a
  `StreamableHTTPServerTransport` `connect()`-ed to the same `createServer()` the stdio path uses
  ([src/mcp/server.ts:239](../../../src/mcp/server.ts#L239) names stdio today). The SDK ships this
  transport at v1.29.0; no new dependency is required.
- **Per-request `(tenant, technician)`** has no current carrier: tenant comes from `requireTenant()`
  (process env, [:36](../../../src/mcp/server.ts#L36)) and technician from tool args
  ([:142-143](../../../src/mcp/server.ts#L142-L143)). The single chokepoint both pass through is
  `dispatch()` ([:131-211](../../../src/mcp/server.ts#L131-L211)).
- **"Ignore `technicianRef` in args"** concerns exactly one site:
  [src/mcp/server.ts:142-143](../../../src/mcp/server.ts#L142-L143).
- **Tenant enforcement on id-based reads** spans **five** tool cases
  ([:167-207](../../../src/mcp/server.ts#L167-L207)), all using a `customerId`/`jobId` argument against
  the unguarded read functions above.
- **mTLS + allowlist** is not represented anywhere in the repo — no HTTP server, listener, or cert
  handling. Entirely new surface in front of the transport.
- **Secrets on the central host only** is already the code shape: `getClient()`/`sonnetExtractor`/the
  synthesizers read `SUPABASE_*`/`ANTHROPIC_API_KEY` from the *server process* env
  ([src/db/client.ts:11-12](../../../src/db/client.ts#L11-L12),
  [src/writePath/extract.ts:74](../../../src/writePath/extract.ts#L74)); the change is operational
  (where the process runs), not code.
- **A `resolveIdentity(req)` seam** does not exist; the nearest analog is `requireTenant()`
  ([:36-40](../../../src/mcp/server.ts#L36-L40)) — one helper yielding the pinned identity, but from a
  global env var rather than a request.

## Open Questions
- **Where the per-request identity context is established and threaded.** `dispatch()` is the single
  point all seven tools pass through, but `ServerDeps` carries only `extract`/`brief`/`answer`. How a
  resolved `(tenant, technician, scopes)` reaches `dispatch` (and whether id-based reads gain a tenant
  predicate vs. a tool-layer guard) is not determinable by reading alone.
- **Tenant enforcement mechanism.** `getJob`/`getCustomerContext`/`getRawCapture`/etc. don't filter by
  tenant — added `WHERE tenant_id` predicates, a dispatch-layer guard on the fetched row's `tenant_id`,
  or Postgres RLS (named "later" in the 2026-06-20 doc) are all open.
- **Module-cached Supabase client vs. multi-tenant.** `getClient()` caches one service-role client
  ([src/db/client.ts:4](../../../src/db/client.ts#L4)); one shared client (tenant in app code) vs.
  per-request scoped credentials is undecided.
- **Gateway → server identity wire format.** Nothing in the repo defines the signed-header / claim
  format; `docs/nemoclaw-tech-agent.md` covers only per-box stdio registration. Whether OpenShell can
  mint/attach such a header (or a bearer token for `requireBearerAuth`) is external and unverified here.
- **Transport statefulness choice.** The app layer is stateless (captureId resume) and the SDK supports
  stateless transport (`sessionIdGenerator: undefined`); which mode the central server runs is not yet
  decided in code.

## Git metadata
- Branch: `context-spine-basic-structure`
- HEAD: `7e61212 Add Stage 2 technician write-path: capture → spine via custom MCP server`
- Recent: `dbb2abe`, `c207472`, `cb236a9`, `c547542`.
