---
date: 2026-06-23
task: Centralize the trades-spine MCP server (Architecture A — gateway-mediated trust)
research: thoughts/shared/research/2026-06-23-centralized-mcp-server-architecture-a.md
status: complete
---

> **Final review-gate fix (beyond the 3 phases):** the `/code-review` gate caught that Phase 2 guarded
> the *read* tools but `record_field_note`'s *write* path still trusted a model-supplied
> `confirmed.customerId` (which wins outright in `matchIdentity`), allowing a cross-tenant **write**.
> Fixed in `dispatch` (server.ts) with a `getCustomer(...).tenant_id === tenantId` guard mirroring the
> read guards, plus a test. All 55 tests pass.

## Overview
Move from one stdio MCP server per Brev sandbox to a single central server every bot calls, with
per-request `(tenant, technician)` identity asserted by the gateway. Three phases: (1) a per-request
identity seam threaded through `dispatch` (ignoring model-supplied `technicianRef`); (2) enforce tenant
on the id-based read tools — the cross-tenant gap from the research; (3) a Streamable HTTP entrypoint
with a gateway-signed identity header, keeping stdio for tests/dev. The `resolveIdentity` seam is built
so a future Option B (JWT/OAuth Resource Server) swaps one function. Network mTLS + allowlist is deploy
infra (manually verified); the in-code half is the HMAC-signed identity header.

> **Note:** `src/mcp/server.ts` is the **249-line, 7-tool** version. The two synthesis tools,
> `brief_customer` ([:184-198](../../src/mcp/server.ts#L184-L198)) and
> `answer_customer_question` ([:199-207](../../src/mcp/server.ts#L199-L207)), **also call
> `getCustomerContext(customerId)` unguarded** ([:193](../../src/mcp/server.ts#L193),
> [:204](../../src/mcp/server.ts#L204)) and must be tenant-guarded in Phase 2.

## Phase 1: Per-request identity seam

### What this phase does
Replace the process-global tenant (`requireTenant()`) and model-supplied `technicianRef` with one
`RequestIdentity` passed per request via `deps`. stdio/tests inject it directly; no transport change.
`record_field_note` sources `technicianRef` from identity and the field leaves its schema.

### Changes required

**`src/mcp/identity.ts`** (new)
- `export interface RequestIdentity { tenantId: string; technicianRef: string; scopes?: string[] }`
- `export function identityFromEnv(): RequestIdentity` — reads `DEFAULT_TENANT_ID` +
  `DEFAULT_TECHNICIAN_REF`; throws if either unset (replaces `requireTenant`'s throw).

**`src/mcp/server.ts`**
- `ServerDeps` ([:27-31](../../src/mcp/server.ts#L27-L31)): add `identity?: RequestIdentity` (keep
  `extract`/`brief`/`answer`).
- Delete `requireTenant()` ([:36-40](../../src/mcp/server.ts#L36-L40)). In `dispatch`
  ([:131-211](../../src/mcp/server.ts#L131-L211)) replace `const tenantId = requireTenant();`
  ([:136](../../src/mcp/server.ts#L136)) with
  `const identity = deps.identity; if (!identity) throw new Error('identity is required'); const { tenantId } = identity;`
- `record_field_note` schema: remove the `technicianRef` property ([:52](../../src/mcp/server.ts#L52))
  and from `required` ([:62](../../src/mcp/server.ts#L62)). In its dispatch case
  ([:141-161](../../src/mcp/server.ts#L141-L161)) delete the `str('technicianRef')` read + guard
  ([:142-143](../../src/mcp/server.ts#L142-L143)) and pass `technicianRef: identity.technicianRef`
  ([:152](../../src/mcp/server.ts#L152)).
- `main()` ([:237-240](../../src/mcp/server.ts#L237-L240)): `createServer({ identity: identityFromEnv() })`.

**`src/mcp/server.test.ts`**
- `createServer({ extract: …, identity: { tenantId, technicianRef: 'tech-mcp' } })`
  ([:24](../../src/mcp/server.test.ts#L24)). Drop the now-unused `process.env.DEFAULT_TENANT_ID = …`
  line ([:22](../../src/mcp/server.test.ts#L22)) — nothing in `src/db` reads it (verified: `getClient`
  reads only `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`).
- Drop `technicianRef` from the `record_field_note` call args
  ([:71-75](../../src/mcp/server.test.ts#L71-L75), [:80-84](../../src/mcp/server.test.ts#L80-L84)); add
  an assertion that the created visit's `technician_name` equals the injected identity ref.

### Automated verification
- [x] `npx tsc --noEmit` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (updated `server.test.ts`) — 46 tests pass
- [x] new assertion: visit `technician_name` comes from injected identity, not call args

### Manual verification
- (none — fully codified)

---

## Phase 2: Tenant-scope the id-based read tools

### What this phase does
Close the cross-tenant read gap: `get_job`, `get_customer_context`, `list_recent_captures`,
`brief_customer`, `answer_customer_question` take an agent-supplied id but the underlying reads have no
tenant predicate. Guard in `dispatch` using the `tenant_id` on each fetched row (verified present on the
`customers`/`jobs`/`raw_captures` Row types). One ownership check gates each aggregate.

### Changes required

**`src/mcp/server.ts`** (`dispatch` read cases; add `getCustomer` to the db import at
[:5-12](../../src/mcp/server.ts#L5-L12))
- `get_customer_context` ([:167-171](../../src/mcp/server.ts#L167-L171)):
  `const ctx = await getCustomerContext(customerId);
  if (!ctx.customer || ctx.customer.tenant_id !== tenantId) return { customer: null, jobs: [], recentVisits: [], recentCaptures: [] };
  return ctx;`
- `get_job` ([:172-176](../../src/mcp/server.ts#L172-L176)):
  `const job = await getJob(jobId); return job && job.tenant_id === tenantId ? job : null;`
- `list_recent_captures` ([:177-183](../../src/mcp/server.ts#L177-L183)): for `jobId` →
  `const job = await getJob(jobId); if (!job || job.tenant_id !== tenantId) return []; return listRawCapturesForJob(jobId);`
  for `customerId` →
  `const c = await getCustomer(customerId); if (!c || c.tenant_id !== tenantId) return []; return listRawCapturesForCustomer(customerId);`
- `brief_customer` ([:195](../../src/mcp/server.ts#L195)) **and** `answer_customer_question`
  ([:205](../../src/mcp/server.ts#L205)): change the existing `if (!ctx.customer) throw …` to
  `if (!ctx.customer || ctx.customer.tenant_id !== tenantId) throw new Error('customer not found');`
  (reuse the already-fetched `ctx`; no double fetch).

**`src/mcp/server.test.ts`**
- New block: create a customer + job under the seed tenant, then drive each of the five read tools with
  `identity.tenantId` = a different uuid (`'00000000-0000-0000-0000-000000000000'`) → `get_job` `null`,
  `get_customer_context` empty aggregate, `list_recent_captures` `[]`, `brief_customer` /
  `answer_customer_question` `isError` true; with the correct tenant → rows returned. Inject stub
  `brief`/`answer` so the synthesis tools don't call the model.

### Automated verification
- [x] `npx tsc --noEmit` passes
- [x] `npm run lint` passes
- [x] `npm test` passes — 47 tests pass
- [x] new cross-tenant test covers **all five** id-based read tools (incl. both synthesis tools)

### Manual verification
- (none — fully codified)

---

## Phase 3: Streamable HTTP entrypoint + gateway-signed identity

### What this phase does
Add a central HTTP entrypoint (`node:http` — `StreamableHTTPServerTransport.handleRequest(req, res,
body)` wraps node req/res; no express/new dependency) running **stateless**
(`sessionIdGenerator: undefined`): per request, verify the gateway's signed identity header, build a
`RequestIdentity`, and serve via a fresh `createServer({ identity })`. stdio `main()` untouched. mTLS +
private-network allowlist is deploy infra; the in-code integrity check is a shared-secret HMAC.

### Changes required

**`src/mcp/identity.ts`**
- `export function resolveIdentityFromHeaders(headers: NodeJS.Dict<string | string[]>): RequestIdentity`
  — read `x-tenant-id`, `x-technician-ref`, `x-identity-signature`; require all three + a set
  `GATEWAY_IDENTITY_SECRET` (throw otherwise). Compute
  `createHmac('sha256', secret).update(`${tenantId}.${technicianRef}`).digest()`. **Length-guard before
  compare** (`crypto.timingSafeEqual` throws `RangeError` on unequal buffer lengths): convert the header
  hex to a Buffer, `if (sig.length !== expected.length) throw new Error('bad signature');` then
  `if (!timingSafeEqual(sig, expected)) throw new Error('bad signature');`.

**`src/mcp/httpServer.ts`** (new)
- `node:http` server. Per request, inside one `try/catch` (any throw → `res.writeHead(401); res.end()`):
  optional source allowlist (`ALLOWED_CLIENT_IPS` comma list; skip if unset), read+`JSON.parse` the body,
  `const identity = resolveIdentityFromHeaders(req.headers);`, then
  `const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcp = createServer({ identity }); await mcp.connect(transport); await transport.handleRequest(req, res, body);`
- Listen on `Number(process.env.MCP_HTTP_PORT ?? 8080)`. Same direct-exec guard as `server.ts`
  ([:244](../../src/mcp/server.ts#L244)).

**`package.json`** — add `"mcp:serve:http": "node dist/mcp/httpServer.js"`.

**`.env.example`** — add `DEFAULT_TECHNICIAN_REF=` (stdio/dev), `GATEWAY_IDENTITY_SECRET=` (🔒 shared
with the gateway), `MCP_HTTP_PORT=8080`, `ALLOWED_CLIENT_IPS=` with comments.

**`docs/nemoclaw-tech-agent.md`** — add "Centralized deployment (Architecture A)": one host runs
`mcp:serve:http`; gateway reaches it over mTLS on a private network + IP allowlist; gateway sets
`x-tenant-id`, `x-technician-ref`, HMAC `x-identity-signature`, **and** `Accept: application/json,
text/event-stream` + `Content-Type: application/json` (stateless `handleRequest` returns 406/415
otherwise); secrets only on the central host; stateless ⇒ horizontally scalable (captureId resume needs
no affinity). mTLS/private-network is infra, not in this repo.

### Automated verification
- [x] `npx tsc --noEmit`, `npm run lint`, `npm test` pass (54 tests)
- [x] new unit test for `resolveIdentityFromHeaders`: valid signature → identity; **wrong-length**
      signature, tampered same-length signature, wrong secret, and each missing header all throw (7/7)
- [x] `npm run build` succeeds (produces `dist/mcp/httpServer.js`)

### Live verification (agent-executable)
- Prerequisites: test Supabase via `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`),
  `GATEWAY_IDENTITY_SECRET` set, built `dist`, a free port. Drive it with the SDK `Client` +
  `StreamableHTTPClientTransport` (sets the `Accept`/`Content-Type` headers automatically) or raw POSTs
  carrying both headers; `initialize` and `tools/list` are **two sequential POSTs**.
- [x] Signed header → `tools/list` returns the 7 tools. (Observed: record_field_note, find_customer,
      get_customer_context, get_job, list_recent_captures, brief_customer, answer_customer_question.)
- [x] Tampered `x-identity-signature` (signed with WRONG-TENANT) → POST rejected (401), no tool runs.
- [x] `record_field_note` with a valid signed header → read back over `pg`: L1 `raw_captures` row exists
      (`channel=technician_voice`) and L2 `visits.technician_name == 'tech-live-verify'` (the header
      `x-technician-ref`). HTTP-in → DB-out confirmed. (Created rows self-cleaned except one append-only
      L1 row, which the append-only trigger correctly blocks from DELETE; the test DB's `afterAll`
      truncate clears it on the next run.)

### Manual verification
- [ ] mTLS + private-network/IP-allowlist between gateway and server is provisioned and a direct
      (non-gateway) connection is refused — infra check, not codifiable in this repo.

---
*Pause after Phase 3 for the manual infra check; Phases 1–2 are fully codified and need no pause.*
