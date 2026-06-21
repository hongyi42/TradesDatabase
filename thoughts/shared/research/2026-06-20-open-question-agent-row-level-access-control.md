---
date: 2026-06-20
type: open-question (out of scope)
relates_to:
  - thoughts/shared/plans/2026-06-19-technician-write-path.md  (NOT part of this plan)
  - future: NemoClaw agent-infra plan + deferred multi-tenant / RLS work
status: open — configure later
---

## Open question
How do we control how much spine data each per-technician NemoClaw agent can read — e.g.
restrict a specific technician's agent to only the rows (customers/jobs) relevant to them, rather
than the whole tenant?

This is **deliberately out of scope** for the technician-write-path plan (which is single-tenant
with RLS off). Recording the reasoning here so it isn't lost; it belongs to the future agent-infra /
multi-tenant effort.

## Key finding: NemoClaw cannot be the row-level boundary
NemoClaw/OpenClaw policy controls **which tools** an agent may call and **which hosts** it may reach
(coarse capability). It does **not** control **which rows** a tool returns — the row selector
(`customerId`, a search string) is an argument the LLM chooses. Trusting the model to only request
"its own" rows = delegating authorization to the model, the exact anti-pattern the overview warns
against ("hardcode permission boundaries", §5). So NemoClaw stays useful for "this agent may only
call the 5 spine tools", but never for "…and only see Jane's jobs."

## Where enforcement belongs (layered, in order of trust)

| Layer | Controls | Status |
|------|----------|--------|
| NemoClaw policy | which **tools** + outbound hosts | documented in [docs/nemoclaw-tech-agent.md](../../../docs/nemoclaw-tech-agent.md) |
| **Our MCP server** | which **rows**, per agent | primary boundary; small future enhancement |
| Postgres RLS + scoped credential | rows, enforced by the DB | later, with multi-tenant work |

### Near-term: enforce in the MCP server (keyed on a gateway-pinned identity)
Today the MCP server holds the **service-role key, which bypasses RLS**, so our code is the only
boundary — which is fine if it keys off an identity the agent can't forge. We already do this for
tenant: `requireTenant()` reads `DEFAULT_TENANT_ID` from env, injected by the gateway as a SecretRef
([src/mcp/server.ts](../../../src/mcp/server.ts)). Extend the same pattern:
1. Run **one MCP server process per technician**, launched with `TECHNICIAN_REF=<tech>` injected the
   same way; add `requireTechnician()` and **ignore any `technicianRef` in tool args**.
2. **Filter every read tool** (`get_customer_context`, `find_customer`, `list_recent_captures`) to
   the technician's allowed set; `record_field_note` already uses the pinned tech.

**Prerequisite is data-modeling, not access tech:** "which rows does this tech get?" needs a defined
relationship. Today that link is only loose — `schedule_entries.technician_ref` (assignments) and
`visits.technician_name` (past visits). Deciding the rule (e.g. "jobs the tech is scheduled for or
has visited"), and possibly a first-class technician/assignments model, is the real work; the
enforcement is then a few `WHERE` clauses.

### Later: Postgres RLS (defense in depth)
The strongest boundary — the DB enforces visibility even if app code has a bug. Requires dropping the
blanket service-role key in favor of a **scoped credential** (role/JWT carrying tenant + technician
claims) per request. This is a bigger shift, tied to the multi-tenant/RLS work the spine deferred.

## Recommendation
Server-side filtering keyed on a gateway-pinned identity is the right near-term mechanism; RLS is the
eventual hardening. **Never** agent-side filtering. Revisit when the agent-infra / multi-tenant plan
is picked up.
