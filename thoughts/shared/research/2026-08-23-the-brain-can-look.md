---
date: 2026-08-23
branch: research/the-brain-can-look
commit: 12364db
topic: ④ The planner's read surface — what spine_read exposes, what the planner cannot reach and what substitutes, the sensitivity mechanism end to end, and retraction folding
supersedes: thoughts/shared/plans/2026-08-04-query-spine-design.md (decision B only)
---

> **What is superseded, and why now.** Decision B of the query-spine design excluded `raw_captures`
> from the readable surface: *"the densest PII in the system and append-only, so anything it leaks
> cannot be un-leaked… Revisit only when a real question requires it, and treat that as its own
> decision."* That revisit clause is the whole reason this document exists. The real question
> arrived: the planner now closes gaps on evidence, and it cannot read the evidence — it is handed a
> pre-rendered string by code. Decision B's *reasoning* is untouched and still correct about what L1
> contains; what changed is that a consumer now needs it. Nothing else in that design is overturned:
> the role, the views, the GUC, the audit table and the SECURITY-DEFINER-to-drop-privileges posture
> all stand exactly as written.

## Summary

**The planner can act on the record but cannot read it.** It decides, every thirty minutes, what
should happen to each open gap — and since 2026-08-22 it is the thing that *closes* those gaps. To
do that it needs to know what people said. It cannot look. `spine_read`, its one SQL tool, sees
eight views covering customers, jobs, schedule, team, money, time off, cancelled visits and the firm
profile — and **none of them covers `raw_captures` (what anyone said), `nudges` (its own open
questions), `review_items` (the manager's queue), or `nudge_decisions` (its own history)**.

What it gets instead is *pre-chewed*: code runs one query per tick, filters it, truncates it, and
pastes the result into the prompt as text. The planner cannot ask a follow-up, cannot widen the
window, and cannot see anything the filter dropped. Two filters do that dropping, both
unconditional and both invisible to the model: **captures marked `manager_only` are removed, and
retracted captures are removed.** On the pilot today that first filter hides **147 of 258 captures
— 57% of everything anyone has said.**

Plain-language terms: **L1** is `raw_captures`, the append-only verbatim record of what people said.
**A gap** is a hole in the record the ladder is chasing; its row lives in `nudges`. **A view** is a
saved query the database presents as if it were a table. **A GUC** is a per-transaction setting —
here, the tenant id, set by the server from a verified badge and unreadable by the model.

## Entry Points

| where | what begins there |
|---|---|
| [server.ts:1641](src/mcp/server.ts#L1641) | `TEAM_LEAD_TOOLS` — the planner's two own tools |
| [server.ts:1643](src/mcp/server.ts#L1643) | `spine_read` tool definition |
| [server.ts:1675](src/mcp/server.ts#L1675) | `recall_decisions` tool definition |
| [identity.ts:22](src/teamLead/identity.ts#L22) | `TEAM_LEAD_TOOL_NAMES` — the deny-by-default ceiling |
| [server.ts:2263](src/mcp/server.ts#L2263) | the `spine:` namespace gate |
| [querySpine.ts:26](src/db/querySpine.ts#L26) | `runSpineQuery` — the only caller of the DB function |
| [20260806120000_query_spine_reader.sql:179](supabase/migrations/20260806120000_query_spine_reader.sql#L179) | `query_spine()` itself |
| [planner.ts:407](src/teamLead/planner.ts#L407) | `buildGapView` — the pre-rendered substitute |
| [rawCaptures.ts:259](src/db/rawCaptures.ts#L259) | `listJobEvidenceSince` — the planner's only capture read |

## Key Files

**`supabase/migrations/20260806120000_query_spine_reader.sql`** — the foundation. Creates the
`spine_reader` NOLOGIN role (:34–40), **revokes all table grants from it** (:52), defines the first
five views, grants select on exactly those (:152), creates `query_audit` (:160) with RLS-no-policy
(:176), and defines `query_spine()` (:179) as SECURITY DEFINER owned by `spine_reader` (:224). The
header states the inversion plainly: SECURITY DEFINER is used **to drop privileges, not grant
them**. `:247` revokes execute from `anon`/`authenticated` **by name** — a live pilot finding, since
Supabase's default privileges grant execute directly to those roles and `revoke … from public` does
not remove it.

**The eight views and where each lives:**

| view | defined in |
|---|---|
| `v_team` | 20260806120000_query_spine_reader.sql:61 |
| `v_jobs` | 20260806120000_query_spine_reader.sql:108 |
| `v_customers` | 20260806120000_query_spine_reader.sql:129 |
| `v_time_off` | 20260806120000_query_spine_reader.sql:142 |
| `v_schedule` | 20260806120000:80 → 20260806200000:30 → **20260812110000:30** (current) |
| `v_cancelled_visits` | 20260812110000_v_schedule_excludes_cancelled.sql:60 |
| `v_money_events` | 20260815160000_money_events.sql:67 (grant :86) |
| `v_firm_profile` | 20260815180000_tenant_profiles.sql:39 |

**`src/db/querySpine.ts`** (74 lines) — `runSpineQuery(tenantId, sql, opts)`. Caps at
`QUERY_SPINE_DEFAULT_ROWS = 200`, ceiling `QUERY_SPINE_MAX_ROWS = 1000` (:23–24), both mirroring the
clamp inside the function so the reported `truncated` flag matches what the database did. Calls
`.rpc('query_spine', { p_tenant, p_sql, p_max_rows })` (:33). Audits **both** outcomes into
`query_audit` and never lets an audit failure change the caller's result (:44–56). Returns
`truncated: rows.length >= maxRows` (:72).

**`src/mcp/server.ts`** — `SPINE_VIEW_CATALOG` (:627) is the static column list pasted into both
tool descriptions; `SPINE_DAY_RULES` (:658) carries the local-day rule; `SPINE_QUERY_LIMITS` (:674)
the one-statement/capped/logged rules. `caller` (:2224) and `activeManager` (:2231) are resolved
once per request. `dropSensitive` (:2303) is the sensitivity filter.

**`src/db/rawCaptures.ts`** — `listJobEvidenceSince` (:259), `findRetractionsFor` (:222),
`foldRetractions` (:346), `listRawCapturesForJob` (:153), `listRawCapturesForCustomer` (:354).

**`src/composio/logIngest.ts`** — the **only** writer of `sensitivity` (:265).

## Data Flows

### What the planner asks for vs. what it is handed

```
  WHAT IT CAN QUERY (spine_read → query_spine → 8 views)
  ┌──────────────────────────────────────────────────────────┐
  │ v_customers  v_jobs  v_schedule  v_team                  │
  │ v_money_events  v_time_off  v_cancelled_visits           │
  │ v_firm_profile                                           │
  └──────────────────────────────────────────────────────────┘
      structured record only — no words, no gaps, no queue

  WHAT IT IS HANDED (code decides, once per tick, no follow-up)
  ┌──────────────────────────────────────────────────────────┐
  │ buildGapView →  evidenceText[]   ≤6 notes, ≤600 chars ea │
  │                 moneyOnRecord    one line                 │
  │                 recordFilled     one line                 │
  │                 history          count + last real action │
  └──────────────────────────────────────────────────────────┘
```

### One `spine_read` call, end to end

```
planner model
  └─ spine_read { sql }
     └─ dispatch  ── spine: gate (server.ts:2263) ── TEAM_LEAD_TOOL_NAMES?
        └─ runSpineQuery(tenantId, sql)          [querySpine.ts:26]
           └─ rpc query_spine(p_tenant, p_sql, p_max_rows)
              ├─ reject if empty / contains ';'
              ├─ set_config('spine.tenant_id', p_tenant, TRUE)   ← txn-local
              ├─ set_config('statement_timeout', '5000', TRUE)
              └─ execute  select … from ( <model sql> ) sub limit N
                          running as spine_reader — no base-table grants
           └─ insert into query_audit (sql, row_count, duration, error)
```

The tenant filter is never in the model's SQL. It lives in each view as
`where tenant_id = current_setting('spine.tenant_id')::uuid`, and a view referencing an unset GUC
**raises rather than returning everything** — fail closed, loudly.

### The planner's capture path — where the two filters sit

```
runPlanner
  └─ listEvidence = listJobEvidenceSince            [planner.ts:1148 — ONLY caller]
     └─ (1) captures job-stamped since the floor
        (2) captures reached via visits.source_capture_id
        (3) ── DROP sensitivity === 'manager_only'  [rawCaptures.ts:331]  ← 147/258 on pilot
            └─ DROP retracted + retraction rows     [rawCaptures.ts:333–337]
     └─ buildGapView                                 [planner.ts:407]
        ├─ filter to THIS gap's job, captured_at > asked_at
        ├─ .slice(-6)                                EVIDENCE_PER_GAP = 6
        └─ flat(text, 600)                           EVIDENCE_TEXT_CHARS = 600
```

**`listJobEvidenceSince` has exactly one caller — the planner** ([planner.ts:1148](src/teamLead/planner.ts#L1148)).
Both drops are therefore planner-only in effect, and neither consults identity.

### The second blinded path

`get_customer_context` is in the planner's ceiling ([identity.ts:28](src/teamLead/identity.ts#L28)),
and it is capture-bearing. Its captures pass through `dropSensitive` at
[server.ts:2667](src/mcp/server.ts#L2667), and `getCustomerContext` folds retractions at
[context.ts:148–160](src/db/context.ts#L148). So the planner is blinded on **both** of its
capture-bearing reads, by two independent mechanisms.

## External Dependencies

PostgREST (via `@supabase/supabase-js`) is the only path to Postgres — it cannot execute arbitrary
SQL, which is precisely why `query_spine()` exists as an RPC. `pg` is used in tests only. No
third-party service is involved in any read described here.

## Constraints and Invariants

1. **`spine:team-lead` has no roster row, so it is structurally a non-manager.** `getTechnician`
   returns null → `activeManager` is false ([server.ts:2224–2231](src/mcp/server.ts#L2224)). This is
   not a policy setting; it is what the identity *is*. `query_spine` was removed from the team lead's
   allowlist on 2026-08-19 for exactly this reason — it was on the list but provably unreachable,
   and [identity.ts:16–21](src/teamLead/identity.ts#L16) records that *"a name on an allowlist that
   cannot dispatch is a lie about what this identity can do."*

2. **`sensitivity` is assigned in exactly one place, from the ACTOR's tier, not from content.**
   [logIngest.ts:265](src/composio/logIngest.ts#L265): `if (!actor || actor.tier === 'manager')
   sensitivity = 'manager_only'`. It applies only to the `agent_action` channel; Gmail sends take
   `outbound_email` and stay null. The column is a bare nullable `text` with **no default and no
   CHECK constraint** ([20260704120000:15](supabase/migrations/20260704120000_agent_action_sensitivity_sessions.sql#L15)).

3. **The NULL-vs-neq hazard is currently dodged by accident.** Every filter today is in JavaScript
   (`r.sensitivity !== 'manager_only'`), where `null !== 'manager_only'` is true, so NULL rows pass.
   In SQL that inverts: `where sensitivity != 'manager_only'` drops NULLs too, which on the pilot
   would silently hide the 111 rows that are *not* sensitive. Any view must use `is distinct from`.
   [server.ts:2300](src/mcp/server.ts#L2300) records the PostgREST form of this same trap.

4. **Retraction folding is app-side only.** No view replicates it. `foldRetractions`
   ([rawCaptures.ts:346](src/db/rawCaptures.ts#L346)) drops two things, and both halves matter: rows
   a retraction points at, **and the retraction rows themselves** (`retracts_capture_id is not null`).

5. **L1 is append-only and the trigger blocks UPDATE.** Re-classifying the 147 existing
   `manager_only` rows is an UPDATE and cannot be done. Changing a default cannot reach backwards.

6. **`query_spine` refuses semicolons and wraps the model's SQL in a subquery**, so a second
   statement cannot parse; the role holds no write privilege regardless. `statement_timeout` is 5s.

7. **Row caps are reported, not silent** — `truncated` is returned and the tool description
   instructs the model to say so rather than present a partial list as complete.

## Decision Points

**1. Does `v_captures` exist at all, or does the planner read L1 through a widened tool?**
A view is consistent with everything else `spine_read` sees and lets the model write its own
question. It also means L1 becomes reachable by composed SQL for the first time — the thing decision
B declined. The alternative is to widen `listJobEvidenceSince` (one caller, two filters) and leave
the SQL surface alone; that is a far smaller change but leaves the planner unable to ask anything
code did not anticipate.

**2. How does "the planner reads everything" survive the non-manager fact?** The ruling says the
planner sees `manager_only`. But `activeManager` is false for it *by construction*, and that same
predicate gates `dropSensitive`, `includeRetracted`, and the admin tools. Options as the code stands:
carve out `spine:` refs explicitly wherever the predicate is consulted; give the identity a roster
row (which changes seat accounting and the badge model); or bypass the predicate only on the
planner's own reads and leave the tool-level gates untouched.

**3. Where does the sensitivity re-organisation land relative to ④?** The ruling — NULL by default,
gatekeeping becomes a manager instruction, person-specific facts move to seat-agent local memory —
is a separate change from giving the planner a read surface. ④ can proceed without it (if the
planner reads everything, the filter is moot for the planner) or wait for it (so the column's meaning
is settled before a view encodes it). Note the two do not conflict: the 147 existing rows cannot be
re-classified either way, because L1 forbids UPDATE.

**4. "Retraction folding should be readable also" — which of two shapes?** The repo already has both,
and they are not the same thing:
  - *Un-folded*: the planner sees retracted content as ordinary evidence. Nothing marks it.
  - *Labeled trail*: the existing `includeRetracted:true` shape
    ([server.ts:2787–2801](src/mcp/server.ts#L2787)) returns the row **plus** `retracted: true` and
    the retraction's reason. `getCustomerContext` already takes the same option at the DB layer
    ([context.ts:148](src/db/context.ts#L148)).
A retraction is a manager saying "this was recorded in error", so the two differ in whether the
planner can tell truth from withdrawn record. **This was flagged as genuinely ambiguous in the
ruling and is not resolved here.**

**5. Do `nudges` and `review_items` become readable in the same step as captures, or separately?**
They answer different questions — "what am I already chasing" and "what has been handed to a human"
— and the second is what would let the planner see that 85 gap items are sitting unresolved. Each is
one view; the cost is the catalog string the model reads on every turn, which is already ~500 tokens.

## Open Questions

- **Does a view over `raw_captures` change the audit story?** `query_audit` records the SQL, not the
  rows returned. Today "did anyone read customer X's verbatim email" is answerable because L1 is
  unreachable; with a view it becomes answerable only by re-running the logged SQL.
- **What does the catalog string cost once four more views are on it?** Decision A of the original
  design put the schema inline rather than behind a discovery hop, explicitly flagging that the
  input-vs-latency trade was the one got wrong with tool search. Phase 3 of that plan ("measure a
  real turn") is listed as still to do — no measurement exists.
- **Is `manager_only` load-bearing anywhere outside captures?** `technicianMoneyView`
  ([server.ts:2662](src/mcp/server.ts#L2662)) gates money detail on the same `activeManager`
  predicate, so a `spine:` carve-out would widen that too unless scoped deliberately.
- **Unverified by reading alone:** whether `spine_reader` can select from a view over `raw_captures`
  without any new base-table grant. The existing views prove the pattern for tables the role has no
  grant on, but this has not been tested against L1 specifically.
