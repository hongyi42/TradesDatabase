---
date: 2026-07-24
branch: feature/cost-dashboard
commit: 5bb7981
topic: Per-tenant API cost tracking — every billable surface, its tenant context, and what the 4a/4a.5 work changed
note: re-derived at HEAD 5bb7981 after main advanced 29 commits from the e03eb12 baseline the first pass used; the superseded 2026-07-21 drafts were discarded uncommitted.
---

## Summary

This documents every place the system spends money with an outside vendor, and what the code
knows about *which customer* that spend belongs to at the moment it happens.

Plain language: the product pays outside companies per use — a search provider (Brave), Anthropic
for four different AI features, a connector service (Composio), Google for drive-time math, and
DeepInfra for the agents' own "brain". It also pays flat monthly fees for servers (AWS Lightsail,
Render, Supabase). **Nothing in this repo records any of it** — no cost table, no usage counter,
no price or token column anywhere in 116 TypeScript files or 25 migrations.

This supersedes the 2026-07-21 research, which was written against commit `e03eb12`; `main` has
since advanced 29 commits (+6,691 lines). **Redoing it found two billable surfaces the first pass
missed** — `sonnetBriefer` and `sonnetAnswerer`, both live Anthropic spend on manager-facing
tools. There are **four** Anthropic call sites, not two.

The structural fact remains: billable surfaces split into two groups. Brave, Anthropic, Composio,
and Google calls all happen *inside this repo* on a request that already carries a verified tenant
id — attributing them is a matter of writing down what the code already has. Agent inference does
not happen in this repo at all; it runs on trades-box-1 through a gateway shared by every sandbox,
on one API key, with no per-tenant boundary to read.

## Entry Points

Every billable external call at current HEAD:

| Site | File:line | Vendor | Seam |
|---|---|---|---|
| MCP tool dispatch (choke point, not itself billable) | [src/mcp/server.ts:1285](../../../src/mcp/server.ts#L1285) | — | `ServerDeps` |
| Field-note extraction | [src/writePath/extract.ts:73](../../../src/writePath/extract.ts#L73) | Anthropic | `Extractor` |
| Inbound email work/personal classifier | [src/email/classify.ts:39](../../../src/email/classify.ts#L39) | Anthropic | `WorkClassifier` |
| **Customer briefing** *(missed in the first pass)* | [src/synthesis/briefCustomer.ts:57](../../../src/synthesis/briefCustomer.ts#L57) | Anthropic | `Briefer` |
| **Customer Q&A** *(missed in the first pass)* | [src/synthesis/answerQuestion.ts:49](../../../src/synthesis/answerQuestion.ts#L49) | Anthropic | `Answerer` |
| `web_search` → Brave | [src/web/braveSearch.ts:17](../../../src/web/braveSearch.ts#L17) | Brave | `webSearch` |
| Composio doorman relay | [src/composio/relayHandler.ts:185](../../../src/composio/relayHandler.ts#L185) | Composio | `RelayDeps.forward` |
| **Composio `GMAIL_SEND_EMAIL`** *(found in plan review)* | [src/composio/outbound.ts:48](../../../src/composio/outbound.ts#L48) | Composio | `sendEmail` |
| **Composio `GMAIL_GET_PROFILE`** *(found in plan review)* | [src/composio/pairing.ts:155](../../../src/composio/pairing.ts#L155) | Composio | `checkPairing` |
| Composio execution-log ingest (cron) | [src/composio/logIngest.ts:81,106](../../../src/composio/logIngest.ts#L81) | Composio | `LogIngestDeps` |
| Google Routes drive measurement | [src/routes/googleRoutes.ts:59](../../../src/routes/googleRoutes.ts#L59) | Google Maps | `computeRoutes` |
| Agent inference | **not in this repo** — trades-box-1 gateway | DeepInfra | — |

HTTP surfaces already mounted ([src/mcp/httpServer.ts](../../../src/mcp/httpServer.ts)):
`/inbound/` (241), `/control/badges` (245), `/control/sandboxes` (250), board paths (260),
**IP allowlist gate (290)**, Composio relay (298), MCP fallthrough. Everything above line 290
routes *before* the allowlist because its traffic is not from the gateway.

## Key Files

**All four Anthropic callers share one shape.** Each is an exported `const` implementing a
function-type seam, calling `client.messages.create` with `model: 'claude-sonnet-4-6'`,
`max_tokens: 1024`, a single forced tool, then reading `toolUse.input` and **discarding
`message.usage`**:

| Seam type | Declared | Implementation | Reached from |
|---|---|---|---|
| `Extractor` | [extract.ts:28](../../../src/writePath/extract.ts#L28) | `sonnetExtractor` :73 | `recordFieldNote`; MCP staging |
| `WorkClassifier` | [classify.ts:15](../../../src/email/classify.ts#L15) | `sonnetClassifier` :39 | [webhook.ts:220](../../../src/inbound/webhook.ts#L220) |
| `Briefer` | [briefCustomer.ts:17](../../../src/synthesis/briefCustomer.ts#L17) | `sonnetBriefer` :57 | `brief_customer` tool |
| `Answerer` | [answerQuestion.ts:11](../../../src/synthesis/answerQuestion.ts#L11) | `sonnetAnswerer` :49 | `answer_customer_question` tool |

Three of the four (`extract`, `brief`, `answer`) are already fields on `ServerDeps`
([server.ts:166](../../../src/mcp/server.ts#L166)); `classify` is injected in the webhook path.
The uniformity matters: one shared usage-recording helper can serve all four, rather than four
separate instrumentation sites.

**The extractor's production billing path is not the MCP one.**
[recordFieldNote.ts:77](../../../src/writePath/recordFieldNote.ts#L77) resolves
`deps.extract ?? sonnetExtractor`, and its two production callers —
[webhook.ts:252](../../../src/inbound/webhook.ts#L252) (inbound email) and
[email/ingest.ts:111](../../../src/email/ingest.ts#L111) — pass **no** `deps.extract`, so both make
real billable extractions. The MCP staging call at `server.ts:1365` is a third path, and the commit
path at `server.ts:1543` injects a replay stub that makes no model call. Instrumenting at the seam
rather than at call sites is what covers all three.

**Composio's billed unit does not always traverse the relay.** Two `client.tools.execute` calls
sit outside it: `outbound.ts:48` (`GMAIL_SEND_EMAIL`, reached from `server.ts:1993`) and
`pairing.ts:155` (`GMAIL_GET_PROFILE`, run by `checkPairing` on the 15-minute cron for every
invited/pending row). A relay-only collector would miss every agent-sent email and every pairing
check. `logIngest.ts:81`/`:106` are a third kind — plain API reads against the execution-log
endpoint, not tool executions.

**`src/db/webRequests.ts`** — `logWebRequests` (line 16) writes one `'search'` row per query, N
`'search_result'` rows, one `'fetch'` row per attempt. Every row carries `tenant_id` **and**
`technician_ref`. Built for rate caps and provenance, it is already a complete per-tenant Brave
usage ledger. Only `kind='search'` maps 1:1 to a Brave charge.

**`src/mcp/server.ts`** — `dispatch` (line 1285) is the single funnel; `tenantId` comes from the
signed identity header, and `activeManager` is computed at line 1309. The surface is now **35
tools** (`TOOLS` at 194, `ADMIN_TOOLS` at 498, `MANAGER_TOOLS` at 1033) — up from 31 at the prior
research, via `update_job`, `set_promise`, and the 4a/4a.5 detach/tray verbs. The Anthropic
staging call is at line 1365; the commit path at line 1543 injects `{ extract: async () => … }`,
a **replay stub that makes no model call**. The Brave `'search'` row is written at line 1856,
*before* the network call.

**`src/composio/relayHandler.ts`** — `handleComposioRelay` (112) parses the body at 146 and
forwards at **185**. Early-return paths (bad body, no session, missing key) never reach Composio.
The relay also proxies `initialize`, `notifications/initialized`, `tools/list`, and bare `GET` SSE
opens — none billable as tool calls.

**`src/jobs/lifecycle.ts`** — `LifecycleDeps` (23–29), `LifecycleSummary` (31–40), `runLifecycle`
(44). Four isolated steps; `main()` exits 1 when `ok:false`, which Render marks as a failed run.
Two steps already use a `{ skipped: string }` variant when `COMPOSIO_API_KEY` is unset.

**`src/telegram/boardApi.ts`** — the repo's only browser-facing HTTP surface, and the model for a
new one. `authBoard` (65) verifies Telegram `initData` then resolves **one roster row**;
`serveStatic` (112) does extension-whitelist + traversal rejection + resolve-and-prefix check.

**`src/telegram/rosterCache.ts`** *(new since the last research)* — memoizes the identity→roster
lookup for 60s behind board auth. Its header documents precisely what is and is not cached:
signature verification runs on every request before the cache; only successes are stored, so a
deny can never be served stale. Relevant as precedent if a new authed surface wants caching.

**`src/db/tenants.ts`** — `getTenant` returns `manager_seats`, `technician_seats`, `timezone`, and
now `technician_horizon_days` (added by Plan 4a). Seat counts are what a $/seat column needs.

**`src/db/foldImpact.ts`** — the repo's pagination pattern for scans that can exceed PostgREST's
1000-row cap (`PAGE = 1000`, loop until a short page).

## Data Flows

```
 Telegram DM
     │
     ▼
 sandbox ──badge──► doorman ──HMAC identity header──► Render
                                                        │
                              dispatch()  ◄─────────────┘   tenantId ✅ VERIFIED
                              server.ts:1285
                                   │
     ┌───────────┬─────────────────┼──────────────┬──────────────┐
     ▼           ▼                 ▼              ▼              ▼
 web_search  record_field_note  brief_customer  composio     find_slots
     │           │              answer_question  relay           │
  Brave ✅    Anthropic ✅       Anthropic ✅   Composio ✅   Google ✅
  logged to   usage discarded   usage discarded  forwarded    not counted
  web_requests                  (MISSED in the   at :185
                                 first research)

 inbound email ──► classify.ts ──► Anthropic ✅  (runs on EVERY email,
 webhook.ts:220                    usage discarded  including ones then dropped)
```

Inference never reaches this repo:

```
 sandbox s2 ─┐
 sandbox s3 ─┼─► ONE gateway on trades-box-1 ──► DeepInfra zai-org/GLM-5.2
 sandbox s5 ─┘    GATEWAY-SCOPED: one route, one key, every tenant
```

## External Dependencies

Re-verified 2026-07-24. **DeepInfra's input price changed in the three days since the last
research pass, and a new tier appeared** — concrete evidence that a stored dollar figure goes
stale on a timescale shorter than this project's own planning cycle.

| Vendor | Unit price | Source |
|---|---|---|
| DeepInfra `zai-org/GLM-5.2` **Standard** | **$0.93** /1M input *(was $0.95 on 07-21)* · $3.00 /1M output · $0.18 /1M cached | https://deepinfra.com/zai-org/GLM-5.2 |
| — **Priority** (1.5×) | $1.395 · $4.50 · $0.27 | same |
| — **Flex** (0.8×) *(newly listed)* | $0.744 · $2.40 · $0.144 | same |
| Anthropic `claude-sonnet-4-6` | $3.00 /1M input · $15.00 /1M output | Anthropic model catalog |
| Brave Search | $5 /1,000 requests (~$0.005/query); free tier removed Feb 2026 | https://costbench.com/software/ai-search-apis/brave-search-api/ |
| Composio | Free 20K calls/mo; $29→200K; $229→2M. Overage $0.299/1K ($29 tier). Premium tools 3× | https://www.usagepricing.com/blueprint/composio |
| Google Routes | `optimizeWaypointOrder` bills Compute Routes Pro, 5k free/mo | [googleRoutes.ts:7](../../../src/routes/googleRoutes.ts#L7) |
| Lightsail / Render / Supabase | flat monthly | not verified this pass |

**The cached-input arithmetic still dominates.** `engineering-memory` §4 records input:output ≈
230:1 and ~25% cached share. At that ratio input is ~98.6% of per-request cost, and cached input
($0.18) is a 5.2× discount on it. The Flex tier would cut another 20% off every line.

## Constraints and Invariants

- **PostgREST silently caps result sets at 1000 rows** (`db-max-rows`) — `engineering-memory` §3;
  pattern in [foldImpact.ts:35](../../../src/db/foldImpact.ts#L35). A scan past it under-reports
  without erroring.
- **All database access goes through `src/db/`** (CLAUDE.md).
- **Every existing surface is tenant-scoped.** MCP tools gate on a badge → one roster row; the
  board gates on signed `initData` → one roster row. No code path reads across tenants, and there
  is no operator identity mechanism.
- **`web_requests` is classified as prunable operational exhaust**, explicitly not part of the
  permanent company record (its migration's comment) — the precedent for where cost rows belong.
- **The Brave `'search'` row is written before the network call** ([server.ts:1856](../../../src/mcp/server.ts#L1856)),
  so upstream 429s and failures are counted as billable searches.
- **`logIngest` filters to state-changing slugs** for L1-capture purposes; Composio bills reads
  too, and premium tools at 3×. The two splits are not the same.
- **The migration ledger is timestamp-ordered and four migrations dated 07-22/07-23 are already
  applied to the pilot** (commit 4656866). A new migration numbered earlier than those would land
  out of order in a ledger `engineering-memory` §3 already flags as drifted.
- **`ANTHROPIC_API_KEY` on Render was found invalid 2026-07-04**, still listed as an unverified
  debt. If it is still invalid, all four Anthropic surfaces are erroring rather than billing.
- **`npm run gen:types` uses `--linked`** ([package.json:18](../../../package.json#L18)), which
  targets the pilot — not the local stack.

## Decision Points

**1. Whether one shared helper instruments all four Anthropic sites or each is instrumented
separately.** All four share an identical shape (function-type seam → `messages.create` → read
`toolUse.input`), and three are already `ServerDeps` fields. A shared helper touches four files
once; per-site instrumentation repeats the try/catch and the token-reading in each.

**2. How the seam signatures gain tenant context.** The four seam types take different arguments
(`rawText`; `email`; `context, focus`; `context, question`). Adding tenant context means either
widening each with an optional trailing parameter, or passing it some other way (e.g. a
caller-supplied recorder closure). Each existing implementation and every test stub must remain
assignable.

**3. What the inference proxy metric counts.** `dispatch` now funnels 35 tools rather than 31, so
a per-tool-call metric captures more of the agent's activity than it would have at the last
research. It still counts tool invocations, not tokens, and misses turns that call no tool.

**4. Whether Google Routes is collected.** It is a real billable surface, but its seam carries no
tenant context: `optimizeStopOrder` takes `deps: { computeRoutes? }`
([googleRoutes.ts:59](../../../src/routes/googleRoutes.ts#L59)) and `measureDriveDeltas` the same
([fit.ts:497](../../../src/schedule/fit.ts#L497)), while `cost_events.tenant_id` would be
`not null`. Collecting it therefore requires threading a tenant id through the `find_slots` hot
path. There is also no cited per-request price — the repo records only that it bills the Compute
Routes Pro SKU with 5k free calls/month.

**5. Where a cross-tenant read surface attaches.** `httpServer.ts` routes by URL prefix with the
IP allowlist at line 290; everything above that line is deliberately outside it. `boardApi`'s auth
resolves exactly one roster row and so cannot serve a cross-tenant view.

**6. Whether estimated and measured figures are distinguishable in storage.** The repo's
convention is to disclose derivation (`durationAssumption`, `driveMeasured:false`,
`skippedNoPattern`). Whether cost rows carry an equivalent marker is a schema decision.

**7. Which DeepInfra tier the price book records.** Three tiers are now published (Standard,
Priority 0.8×/1.5×). The live route's tier is not recorded anywhere in this repo.

## Open Questions

- **Which DeepInfra tier is the pilot actually on?** Determines whether the price book's figures
  are right by a factor of up to 1.9×. Visible on the DeepInfra dashboard, not in this repo.
- **Does OpenClaw record per-request token usage on the box?** Provider plugins are documented as
  owning "usage reporting" with no stated fields or paths. `engineering-memory` §5 records that
  Telegram channel turns do not emit `embedded_run_agent_end`, so per-turn events are not uniformly
  present. Requires inspection on trades-box-1 (ssh access exists).
- **Is the Render `ANTHROPIC_API_KEY` valid?** Determines whether four surfaces bill or fail.
- **Is Composio's billing unit an execution as `logIngest` counts them?** Unverified mapping.
- **What are the actual monthly Lightsail / Render / Supabase amounts?** Each needs its billing page.
- **Do any of these vendors expose a usage API** that would replace hand-entered monthly figures?
