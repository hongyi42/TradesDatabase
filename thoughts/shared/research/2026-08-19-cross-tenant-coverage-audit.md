---
date: 2026-08-19
branch: docs/agent-first-front-door
commit: 6d49e3b
topic: Cross-tenant coverage audit — what breaks first when a second firm exists
---

## Summary

### In plain language

Every row of business data in this system carries a `tenant_id` — a label saying *which plumbing
firm this belongs to*. "Tenant" and "firm" are the same thing; I'll use **firm** below. Today
there is one real firm in the pilot, so the labels have never had to do any work.

The question this audit asks is: **when the second firm arrives, what is actually holding the wall
up?**

The answer is short and worth reading twice:

> **Nothing in the database enforces the firm boundary. It is held up entirely by a hand-written
> filter in each of ~195 query sites, plus about a dozen hand-written re-checks in the code that
> reads them.**

I verified this three ways against the running local database, not from documentation:

1. **Row-Level Security (RLS) is not a boundary anywhere.** RLS is Postgres's built-in "this user
   may only see these rows" feature. It's switched *on* for 8 tables — and there are **zero
   policies** attached to any of them. A table with RLS on and no policies denies everyone except
   the roles that bypass RLS, and the application connects as `service_role`, which bypasses RLS.
   So RLS blocks the app not at all, and blocks the public `anon` key completely. It is a shield
   against the anonymous key, not a firm boundary.
2. **No foreign key ever couples a child row's firm to its parent's.** All 48 foreign keys point
   at a bare `id`. Nothing stops `jobs.customer_id` from pointing at another firm's customer, or
   `assignments.job_id` at another firm's job, or `money_events.job_id` at another firm's job.
3. **The typed write layer doesn't check either.** `createJob`, `createVisit` and
   `appendRawCapture` all take a `tenantId` *and* a parent id and insert both without ever asking
   whether they agree.

Here is the shape of it:

```
        WHAT THE CODE ASSUMES                    WHAT IS ACTUALLY ENFORCED
   ┌──────────────────────────────┐         ┌──────────────────────────────┐
   │  customer (firm A)           │         │  customer (firm A)           │
   │      │ 1:N                   │         │      │  FK on bare id only   │
   │  job (firm A)  ◄── same firm │         │  job (firm ?) ── may be B    │
   │      │ 1:N                   │         │      │  FK on bare id only   │
   │  visit / assignment (firm A) │         │  visit (firm ?) ── may be C  │
   │      │                       │         │      │                       │
   │  money_events (firm A)       │         │  money_events (firm ?)       │
   └──────────────────────────────┘         └──────────────────────────────┘
      "a job shares its customer's firm"        an INVARIANT BY CONVENTION
                                                 — no constraint, no assert
```

The codebase clearly *knows* this. Two read paths carry explicit "the FK is id-only, re-check the
tenant" comments and do the re-check ([context.ts:101-103](src/db/context.ts#L101-L103),
[watchers.ts:568-571](src/jobs/watchers.ts#L568-L571)), and one — the dispatch board — is written
defensively throughout and has a **hostile test fixture** that mints the violation with raw SQL and
proves the board withholds the foreign data
([boardApi.test.ts:862-868](src/telegram/boardApi.test.ts#L862-L868)). That is the standard the rest
of the repo should be held to, and mostly isn't.

### The good news first, because there is a lot of it

This is a well-defended codebase and I want to be precise about that, because the ranked gaps below
are a short list against a long list of things that are right:

- **Identity never comes from a tool argument.** `(firm, person)` is resolved from an HMAC-signed
  header at the boundary ([identity.ts:41-63](src/mcp/identity.ts#L41-L63)) and every tool reads it
  from there. A model that invents a `tenantId` gets nowhere.
- **Every one of the 5 `/control/*` host routes takes the host id from the bearer TOKEN, never the
  request body** — the exact property the audit brief asked me to check
  ([httpServer.ts:244,267,298,355,439](src/mcp/httpServer.ts#L244)). The comments even say so.
- **The cross-firm-by-design surfaces re-scope correctly.** The nudge transport writes back with
  `row.tenant_id` on every call ([nudgeQueue.ts:84,91,131,136,143](src/control/nudgeQueue.ts#L84));
  the sandbox recycler inherits the retired row's firm and refuses a mismatch, with the comment
  "the box cannot invent tenants" ([sandboxPool.ts:239,257](src/db/sandboxPool.ts#L239)); the call
  worker threads `row.tenant_id` through all eight downstream calls.
- **Money's write path is the strictest code in the repo** — `appendMoneyEvent` re-checks the job's
  firm *and* the referenced event's firm before it writes
  ([moneyEvents.ts:98-116](src/db/moneyEvents.ts#L98-L116)) — and it is covered by a real
  second-firm test ([server.test.ts:7365-7377](src/mcp/server.test.ts#L7365-L7377)).
- **`query_spine`, the ad-hoc SQL path, is properly locked down**: `SECURITY DEFINER` owned by a
  low-privilege `spine_reader` role, firm passed as a parameter from verified identity, and I
  confirmed on the database that its grants are `spine_reader | service_role` only — the
  2026-08-06 anon-grant fix is holding.
- **There is a live cross-firm leak probe in the spine eval**: a canary customer
  ("Zylatha Pemberton-Quist") planted in a second firm that must never surface for the first, probed
  through `search_customers`, `get_job` and `query_spine`
  ([toolCases.ts:446-477](src/eval/toolCases.ts#L446-L477)).

### Three corrections to the brief's premises

I checked these against the code rather than taking them as given:

1. **"`findRosterByTelegramUserIdGlobal` … That handler has no test" — it does, and a thorough
   one.** [technicians.test.ts:230-278](src/db/technicians.test.ts#L230-L278) covers unknown → null,
   one live match, **a genuine two-firm ambiguity asserting both firm ids**, disambiguation by
   offboarding, the same-firm duplicate case, and inactive-only → null. Its caller
   ([boardApi.ts:91-105](src/telegram/boardApi.ts#L91-L105)) turns `ambiguous` into a 409 with
   distinct copy for the two-firm vs duplicate-row cases. This is one of the best-covered
   identity paths in the repo, not a gap.
2. **`src/db/costGapCandidates.test.ts` does not exist on this branch.** It lives only in the
   `.claude/worktrees/pacing-planner` worktree (branch `feat/nudge-pacing-planner`), unmerged. It
   can't serve as a held-against exemplar here.
3. **The recorded claim that the `v_*` views "fail closed because anon cannot set the GUC" is
   wrong about the mechanism** — see gap #2. They do fail closed over HTTP, but for a different
   reason, and the difference matters.

### The one thing to fix before onboarding firm #2

If only one item from this audit gets done: **make the firm boundary structural rather than
conventional**, by adding composite `(tenant_id, id)` unique keys on the parent tables and
composite foreign keys on the children. That single change converts every gap in the "Collision"
and "Leakage" classes below from *"a future bug can do this"* to *"the database will refuse."* It is
also the only remedy that protects `raw_captures`, which has **no delete path** — a cross-firm stamp
there is permanent (gap #1).

---

## Key Files

**The boundary is defined here**

| File | Role |
|---|---|
| [src/mcp/identity.ts:41-63](src/mcp/identity.ts#L41-L63) | The only place `(firm, person)` enters the system. HMAC over `"<tenantId>.<technicianRef>"`. |
| [src/mcp/httpServer.ts:490-608](src/mcp/httpServer.ts#L490-L608) | Route table. Which routes authenticate with what, and in which order. |
| [src/db/client.ts](src/db/client.ts) | The `service_role` client — bypasses RLS, so app code *is* the boundary. |

**Exemplars — hold everything else against these**

| File | Why it's the standard |
|---|---|
| [src/schedule/boardRead.ts:182-237](src/schedule/boardRead.ts#L182-L237) | Re-checks the firm on the job, on the customer *and* on the technician of every embed, and gates derived fields on the checked row, not the raw one. |
| [src/telegram/boardApi.test.ts:862-868](src/telegram/boardApi.test.ts#L862-L868) | The only test in the repo that **mints the invariant violation by raw SQL** ("the verbs would never mint it") and asserts the read withholds it. |
| [src/db/sandboxPool.ts:178-268](src/db/sandboxPool.ts#L178-L268) | Cross-firm-by-design write that inherits the row's own firm and refuses any mismatch. |
| [src/db/moneyEvents.ts:98-116](src/db/moneyEvents.ts#L98-L116) | Explicit parent-firm re-check before an irreversible write, with a no-existence-oracle error message. |

**Where the gaps are**

| File | Gap |
|---|---|
| [src/db/rawCaptures.ts:33-67](src/db/rawCaptures.ts#L33-L67) | L1 append takes 4 parent ids, verifies none. Undeletable. |
| [src/db/context.ts:79-88](src/db/context.ts#L79-L88) | Takes no `tenantId` at all — guard lives entirely at each caller. |
| [scripts/assign-host.mjs:132,153](scripts/assign-host.mjs#L132) | Hardcoded default firm + unguarded roster write of `host_id`/`sandbox_ref`. |
| [src/control/badgeFile.ts:26-36](src/control/badgeFile.ts#L26-L36) | Host payload keys badges, bindings and retirements on `sandboxRef` alone. |
| [src/db/nudges.ts:139-169](src/db/nudges.ts#L139-L169) | The `!inner` embed host filter — correct, and untested with a second host. |
| `supabase/migrations/20260806120000_query_spine_reader.sql` | Grants `anon`/`authenticated` full DML on the eight `v_*` views. |

---

## Constraints and Invariants

### What the database actually enforces (verified by query, not by reading migrations)

**Uniqueness that is firm-scoped (correct):** `technicians (tenant_id, ref)`,
`raw_captures (tenant_id, external_id)`, `call_ingest (tenant_id, external_id)`,
`money_events (tenant_id, dedupe_key)`, `nudges (tenant_id, kind, subject_ref)`,
`review_items (tenant_id, kind, subject_ref)`, `job_type_durations (tenant_id, job_type)`,
`schedule_entries (tenant_id, external_row_key)`, `cost_events (tenant_id, provider, sku, source_ref)`,
`cost_rollup_monthly (tenant_id, period_start, provider, method)`, `dropped_audit (tenant_id, external_id)`.

**Uniqueness that is deliberately global (also correct):** `technicians.badge_hash` — a badge is a
global credential, so a global unique is exactly right. `call_numbers.phone_number` — a dialed
number routes to exactly one firm. `hosts.name`, `hosts.token_hash`.
`sandbox_pool (host_id, sandbox_ref)` — a sandbox ref is a *host* resource, so host-scoped, not
firm-scoped, is the right key.

**Uniqueness that does NOT exist and is assumed anyway:**

| Column | What exists | What code assumes |
|---|---|---|
| `technicians.telegram_user_id` | plain index only | one person → one firm (handled: `ambiguous`) |
| `technicians.sandbox_ref` | **nothing at any scope** | unique per host (gap #3) |
| `tenants.name` | **nothing** | unique (`getTenantByName` documents this) |

**Composite foreign keys: zero.** All 48 FKs reference a bare `id`. Confirmed by
`select … from pg_constraint where contype='f'`.

**RLS:** on for `call_ingest`, `call_numbers`, `cost_events`, `cost_rates`, `cost_rollup_monthly`,
`infra_costs`, `money_events`, `nudges`, `query_audit`, `tenant_profiles`. **`pg_policies` returns
zero rows.** RLS here is an anon-key shield, not a firm boundary.

**Views:** all eight `v_*` filter the *driving* table on `current_setting('spine.tenant_id')`, and
join `jobs`/`customers`/`technicians`/`tenants` **without** re-filtering the joined side — so a
cross-firm parent link would surface through them. Correct given the invariant; unenforced given the
FKs.

### The invariants the code relies on

1. **A child row shares its parent's firm.** Not enforced anywhere. Re-checked in exactly three
   places: [boardRead.ts:187,193,195](src/schedule/boardRead.ts#L187),
   [context.ts:103](src/db/context.ts#L103), [watchers.ts:571](src/jobs/watchers.ts#L571).
2. **A UUID is an unguessable capability.** Load-bearing for ~20 by-id accessors that take no
   `tenantId`. Holds for UUID tables. **Does not hold for `money_events.id`, which is a sequential
   `bigint`** — verified in `information_schema`.
3. **`technicians.sandbox_ref` is unique within a host.** True via the pool path only; the operator
   script bypasses it (gap #3).
4. **One `GATEWAY_IDENTITY_SECRET` for the whole system.** Any holder can mint an identity for any
   firm (gap #6).

---

## Coverage table — every feature area

"Enforced where" = what would actually stop a cross-firm read/write.
"2-firm test" = does a test exist that **fails if the scoping is removed**. I answered this by
locating the specific assertion, not by the presence of a `createTenant` call.

| Feature area | Enforced where | 2-firm test | Severity if firm #2 existed today |
|---|---|---|---|
| **L1 `raw_captures` append** | caller only | **no** | **Critical** — undeletable, no delete path |
| **Badge mint / doorman identity** | host payload keyed on `sandboxRef` | **no** | **Critical** — identity substitution across firms |
| **Operator host/sandbox assignment** | nothing | **no** (script, untested) | **High** — silent wrong-firm write |
| `v_*` views + `anon` grants | GUC + PostgREST's inability to `SET` | partial (`querySpine.test.ts:249`) | **High** — read *and* write if any SET path appears |
| **Money ledger write** | code re-check, both parents | **yes** (`server.test.ts:7365`) | Low |
| Money `correctsEventId` firm check | code re-check | no (redundant w/ job check) | Low |
| **Nudge transport (host pull/ack)** | `!inner` embed on `technicians.host_id` | **no second host** | **High** — wrong-firm ack/delivery |
| Nudge DB accessors | `.eq('tenant_id')` on every write | **yes** (`nudges.test.ts:149`) | Low |
| **Dispatch board reads** | query + 3 embed re-checks | **yes, hostile fixture** | Low |
| Board auth (Telegram → firm) | roster lookup, `ambiguous` refuses | **yes** (`technicians.test.ts:230`) | Low |
| Board roster cache | 60s TTL, success-only | partial | Low (documented window) |
| **`getCustomerContext`** | **callers only** — fn takes no firm | query yes / embed re-check **no** | Medium |
| MCP id-based read tools | code re-check on all 5 | **yes** (`server.test.ts:594`) | Low |
| `record_field_note` confirm path | code re-check on `customerId` | **yes** (`server.test.ts:1008`) | Low |
| Write path `getJob(match.jobId)` | upstream `matchIdentity` only | no | Medium |
| Scheduling reads/writes | `getAssignmentForTenant` everywhere | **yes** (`scheduling.test.ts:979,627`) | Low |
| Freeze / resolve / undo | firm threaded through | no | Medium |
| Standing facts | code re-check | **yes** (`server.test.ts:2932`) | Low |
| Retractions / fold impact | code re-check at tool | no | Medium |
| Review items | `.eq('tenant_id')` + firm-scoped dedup | **yes** (`reviewItems.test.ts:128`) | Low |
| **Inbound Gmail webhook** | firm parsed from signed body's `user_id` | **yes** (`webhook.test.ts:229-314`) | Low |
| **Phone: voice → recording** | firm from dialed number; signed URL | no (mocked, one fake firm) | Medium |
| **Phone: call worker** | `row.tenant_id` threaded | **no** (one fake firm) | Medium |
| Composio relay | `getTechnician(identity.tenantId, ref)` | no | Low |
| Composio log ingest | composite `user_id`, UUID-validated | no | Low |
| Composio pairing / sessions | `compositeUserId(tech)` | no | Low |
| Sandbox pool claim/recycle | host+firm re-check on recycle | **yes** (`sandboxPool.test.ts:53`) | Low |
| Lifecycle cron | per-row firm from each technician | no | Medium (see eng-mem §5 trap) |
| Watchers (gap detection) | per-firm loop + job re-check | **no** (fully mocked, `'t1'`) | Medium |
| Team-lead compose | `n.tenant_id` per row | no | Medium |
| Board notification worker | per-firm loop + per-firm cursor | **no** | Medium |
| Cost ledger append | per-row firm | **yes** (`costs.test.ts:103`) | Low |
| Admin cost dashboard | cross-firm **by design**, shared token | yes | Low (correct design) |
| `query_spine` RPC | definer role + GUC views + ACL | **yes** (`querySpine.test.ts:147,249`) | Low |
| Firm profile | `.eq('tenant_id')` + RLS | **yes** (`tenantProfiles.test.ts:142,150`) | Low |
| Web search daily cap | `(tenant_id, technician_ref)` index | **yes** (`server.test.ts:2621`) | Low |
| Geocoding | none (`ensureCoordsById` takes no firm) | no | Low (coords only) |
| Time off | technician UUID | no | Low |
| Ops events / alerting | host-scoped **by design**, non-firm | yes | Low (correct design) |
| Deep links / day source | firm threaded | no | Low |

---

## Ranked gaps

Ranked by blast radius — identity, credentials, money and L1 above display-only reads — not by age.

---

### 1. L1 append accepts four parent ids and verifies none — and L1 cannot be undone

**[src/db/rawCaptures.ts:33-67](src/db/rawCaptures.ts#L33-L67)**, specifically the
`customer_id` / `job_id` / `visit_id` fields at lines 58-60 and `retracts_capture_id` at line 58.

`appendRawCapture` takes `tenantId` **and** `customerId`, `jobId`, `visitId`, `retractsCaptureId`,
and inserts all of them without asking whether any parent belongs to that firm. There is no
composite FK to catch it either.

**What breaks:** a capture stamped with another firm's `customer_id` is permanent. `raw_captures`
is append-only by a DB trigger — no UPDATE, no DELETE. Per the recorded engineering memory, a
stamped capture also makes its customer **permanently undeletable** (the `on delete set null` is an
UPDATE, which the trigger also blocks). So this single write is the one place in the system where a
firm-boundary mistake has **no remedy at all**: you cannot delete the row, cannot unstamp it, and
cannot delete the customer it points at. Every other gap on this list is recoverable.

**Reachable today?** No — I traced every caller. `recordFieldNote` gets its ids from
`matchIdentity`, which is firm-scoped on all three lookup paths
([identityMatch.ts:64,69,97](src/writePath/identityMatch.ts#L64)); the MCP `retract_capture` path
re-checks `target.tenant_id !== tenantId` before staging
([server.ts:2720,2818](src/mcp/server.ts#L2720)). This is a defense-in-depth gap, not a live bug.
It ranks first because the cost of the invariant ever slipping is unbounded and unfixable.

**A test that catches it:** call `appendRawCapture({tenantId: A, customerId: <a firm-B customer>})`
and assert it **throws** rather than inserting. Today it inserts happily — I confirmed there is no
guard in the function and no constraint in the schema.

**Remedy:** either assert the parent's firm inside `appendRawCapture` (matching
`appendMoneyEvent`'s shape exactly), or — better — a composite FK
`(tenant_id, customer_id) → customers (tenant_id, id)`.

---

### 2. `anon` can set the tenant GUC and read *and write* every firm through the `v_*` views

**`supabase/migrations/20260806120000_query_spine_reader.sql`** (the view grants).

The eight `v_*` views are granted `arwdDxtm` — **all DML, not just SELECT** — to both `anon` and
`authenticated`. I verified the grants with `pg_class.relacl`.

The recorded engineering memory states these "fail closed (SQLSTATE 42704) because **anon cannot
set the GUC**". **That is the wrong mechanism.** I verified on the local stack:

```sql
begin;
set local role anon;
select set_config('spine.tenant_id', '<any firm id>', true);   -- SUCCEEDS
select count(*) from public.v_customers;                        -- 4 rows, names/addresses
update public.v_customers set name = 'PWNED-BY-ANON' where true; -- UPDATE 4
rollback;                                                        -- (verified rolled back: 0 rows)
```

Custom GUCs containing a dot are settable by any role in Postgres. `anon` has the privilege.

**What actually makes it fail closed** is that PostgREST offers no way to issue `SET` — I confirmed
this too: `GET /rest/v1/v_customers` with the anon key returns
`{"code":"42704","message":"unrecognized configuration parameter \"spine.tenant_id\""}` while
`GET /rest/v1/customers` with the same key returns rows (the ratified anon-readable posture).

**Why it matters with firm #2:** the protection is an accident of the HTTP layer, not a privilege
boundary, and the docs record it as the latter — so the next person to add a `set_config` helper
RPC, a pooler/session-mode client, or any direct-SQL path with the anon role silently converts these
views into a **cross-firm read *and write* surface over every firm's book of business**. Today the
blast radius is the pilot's demo data; with N firms it is all of them. Note also that the owner's
2026-08-06 ratification covered anon **read** exposure; `arwdDxtm` grants **write**, which was
almost certainly not the intent.

**A test that catches it:** assert the view ACL, exactly as `querySpine.test.ts` already asserts the
function ACL — `anon` and `authenticated` must hold **no** privileges on any `v_*`
(`spine_reader=r` is all that is needed). It should fail today.

---

### 3. Two firms on one agent box can collide on `sandbox_ref` and cross-install badges

**[scripts/assign-host.mjs:132,153](scripts/assign-host.mjs#L132)** ·
**[src/control/badgeFile.ts:26,31,36](src/control/badgeFile.ts#L26)** ·
**`Box_Setup_Stuff/badge-pull.sh:220,305,312`**

The badge pull is cross-firm by design — one box serves several firms — and each `badgesFile` entry
correctly carries its own `tenantId`. But the three *action* payloads are keyed on `sandboxRef`
**alone**, with no firm and no host qualifier:

```
buildBadgeResponse(hostId)  ──►  newBadges  [{ ref, tenantId, sandboxRef, badge }]
                                 bindings   [{ ref, sandboxRef, telegramUserId }]   ◄── no tenantId
                                 retirements[{ sandboxRef }]                        ◄── no tenantId

box side (badge-pull.sh):  badge  → installed into sandbox <sandboxRef>
                           binding→ BINDINGS_FILE map sandboxRef → telegramUserId
                           retire → queue file NAMED by sandboxRef
```

`technicians.sandbox_ref` has **no unique constraint at any scope** (verified in `pg_indexes`). The
product path is safe because `sandbox_pool` is `UNIQUE (host_id, sandbox_ref)` and
`listFreeSandboxes` is firm-scoped, so two firms' pools on one host are disjoint by ref. But
[assign-host.mjs:153](scripts/assign-host.mjs#L153) writes `{host_id, sandbox_ref}` straight onto
the roster with **no pool row and no uniqueness check** — this is the documented operator path, and
per the engineering memory it is how s2/s3/s7 were actually provisioned. `server.ts:4439,4596`
acknowledge these "legacy assignment (roster sandbox_ref, no pool row)" rows explicitly.

**What breaks:** two roster rows in different firms with the same `(host_id, sandbox_ref)` produce
two `newBadges` entries for one sandbox. The box installs one over the other. The doorman maps
badge → `{tenantId, technicianRef}`, so **the losing person's agent now authenticates as the other
firm's technician** — full read/write at that person's tier, inside a firm they have no relationship
with. The same collision misroutes the Telegram binding and destroys the wrong sandbox on retirement.

**Compounding it:** [assign-host.mjs:132](scripts/assign-host.mjs#L132) hardcodes
`args.tenant || '82bbc6f8-…'` (the pilot's Default Tenant). Since `technicians.ref` is unique only
per firm, an operator who omits `tenant=` while wiring firm B's `mike` silently resolves **firm A's
`mike`** and repoints that person at firm B's box.

**A test that catches it:** register two firms' technicians on one host with the same `sandbox_ref`,
call `buildBadgeResponse(hostId)`, and assert either that it refuses or that `newBadges` /
`bindings` / `retirements` entries are uniquely keyed. Better: a DB-level
`UNIQUE (host_id, sandbox_ref)` on `technicians` (partial, where `sandbox_ref is not null`) so the
collision cannot be written at all.

---

### 4. The nudge transport's host embed filter has no second-host test

**[src/db/nudges.ts:139-169](src/db/nudges.ts#L139-L169)**

`listQueuedNudgesForHost` and `getQueuedNudgeForHost` are the repo's cleanest example of the
"filter the embed, not the parent" shape the audit brief asks about:

```ts
'*, technicians!inner(id,ref,state,sandbox_ref,telegram_user_id,host_id,tenant_id)'
  .eq('status','queued')
  .eq('technicians.host_id', hostId)   // ◄── row-level ONLY because of !inner
```

The `!inner` is what makes the embedded filter row-level rather than embed-level. The code is
correct and the comment explains exactly why. **There is no test with a second host.**
`httpServer.test.ts:414-470` seeds one firm and one host; `nudgeQueue.test.ts` is unit-level with
injected fakes, so the PostgREST embed semantics — the only thing that can actually be wrong here —
are never exercised.

**What breaks if `!inner` is lost** (a refactor, a `select()` rewrite): PostgREST turns the embedded
filter into a left-join filter, returning parent rows with `technicians: null`. `buildNudgeDelivery`
fails closed on that (`if (!tech) continue`), but `completeNudgeDelivery` does **not** — it only
checks `if (!row)`, so a truthy row with a null embed proceeds to
`markNudgeAsked(row.id, row.tenant_id)`. **Host A could then ack another firm's nudge on another
host**, marking a question as asked that was never delivered, and silently orphaning that firm's
gap. `nudges.technician_id → technicians(id)` has no firm coupling either, so nothing downstream
catches it.

*Inferred, not verified:* I could not demonstrate the `!inner`-vs-plain semantics empirically —
the local stack's spine tables were empty after the last suite run, and seeding them would have
collided with another session's tests (24 containers were up). The claim rests on PostgREST's
documented embed semantics. **The verified half is that no second-host test exists.**

**A test that catches it:** two hosts, each with a technician (ideally in different firms), one
queued nudge each. Assert host A's token pulls only its own, and that `POST /control/nudges` with
host A's token and host B's nudge id returns `ignored` and leaves the row `queued`.

---

### 5. `getCustomerContext` takes no firm, and its embed re-check is untested

**[src/db/context.ts:79-88](src/db/context.ts#L79-L88)** and
**[src/db/context.ts:103](src/db/context.ts#L103)**

`getCustomerContext(customerId)` takes no `tenantId`. It returns the customer record, all their
jobs, all their visits, and **all their raw L1 captures** for whatever UUID it is handed. Its own
comment is honest about it: *"the caller still rejects cross-tenant customers wholesale."*

Today all four callers do guard ([server.ts:2195,2378,2394](src/mcp/server.ts#L2195) and the
team-lead path), and that is covered by `server.test.ts:594`. Two observations:

- The guard runs **after** the fetch. `brief_customer` pulls another firm's entire customer dossier
  into process memory, then throws. Not a leak, but it means a timing difference distinguishes a
  real foreign customer from a nonexistent id.
- **The firm-shaped accessor signature is the actual gap**: a fifth caller that forgets is a
  full-dossier leak with nothing else to stop it, and nothing in the type system flags the omission.

Separately, the embed re-check at line 103 —
`.filter((r) => r.jobs?.tenant_id === customer.tenant_id)`, added precisely because the FK is
id-only — **is not covered.** I checked the test the brief cites as an exemplar
([context.test.ts:139-168](src/db/context.test.ts#L139-L168)): it builds two firms with *well-formed*
data and asserts no cross-firm bookings appear. That passes because
`listUpcomingAssignmentsForCustomer` is firm-scoped **in the query**. **Deleting line 103 does not
fail that test** — it only fires on a genuine cross-firm `assignments.job_id`, which the test never
mints. The query filter is tested; the re-check that exists *because the query filter isn't enough*
is not.

**A test that catches it:** the `boardApi.test.ts:862` pattern — raw-SQL an assignment in firm A
pointing at a firm-B job, then assert `getCustomerContext` omits it. And change the signature to
`getCustomerContext(tenantId, customerId)` so the guard cannot be forgotten.

---

### 6. One `GATEWAY_IDENTITY_SECRET` for every firm and every box

**[src/mcp/identity.ts:44-62](src/mcp/identity.ts#L44-L62)**

The signature is `HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "<tenantId>.<technicianRef>")`, with **one**
secret shared by the Render service and every host that talks to it. There is no per-firm and no
per-host key.

The custody rule is good and correctly enforced: the secret lives only on the host, never in a
sandbox. But the *authorization* consequence is worth naming before firm #2:

> Any holder of that secret can mint a valid identity for **any firm in the system**, including
> firms that have never been on that box.

A host's `badgesFile` only contains its own technicians, so a host *knows* only its own firms — but
knowing and being able to sign are different things. The spine performs no check that
`technicianRef` belongs to `tenantId`; a signed header for a firm with no matching roster row still
dispatches, at plain-technician tier by the documented "badge with NO roster row keeps the
technician surface" rule ([server.ts:1864-1873](src/mcp/server.ts#L1864-L1873)).

**What breaks:** with one firm this is moot. With N firms on M boxes, compromise of **any single
box** yields read access to **every firm in the system**, not just the firms on that box. The blast
radius scales with the number of boxes while the key count stays at one.

**A test that catches it:** none can — this is a design property, not a bug. The mitigations are a
per-host secret (so a host can only sign for firms it serves) or the already-planned Option B JWT
migration that `identity.ts:40` names. Worth an explicit decision before the second box exists,
because rotating a shared secret across M hosts later is a coordinated outage.

---

### 7. `createJob` / `createVisit` accept a parent id without checking its firm

**[src/db/jobs.ts:58](src/db/jobs.ts#L58)** · **[src/db/visits.ts:18](src/db/visits.ts#L18)**

Both take `tenantId` and a parent id (`customerId`, `jobId`) and insert both unconditionally. There
is no composite FK. `boardApi.test.ts:871-873` notes this in passing — *"createJob validates no
relationship — no raw SQL needed"* — i.e. a test already relies on being able to mint the violation
through the public API.

The `getJob(match.jobId)` at [recordFieldNote.ts:251](src/writePath/recordFieldNote.ts#L251) is the
same class: it adopts a job with no firm re-check, then creates a visit against it and may call
`updateJobStatus(job.id, signal)` on it. Safe today only because `matchIdentity` is firm-scoped on
every path.

**A test that catches it:** `createJob({tenantId: A, customerId: <firm B customer>})` must throw.
Same for `createVisit`. Both succeed today.

---

### 8. Watchers, the team-lead compose loop, and the board notifier: cross-firm fan-outs with single-firm tests

- **[src/jobs/watchers.ts:242-660](src/jobs/watchers.ts#L242)** — loops every firm, and
  [line 571](src/jobs/watchers.ts#L571) carries the defensive job re-check. `watchers.test.ts` is
  fully mocked against a single fake firm `'t1'`; the injected `listJobs` only ever returns `'t1'`
  rows, so **deleting line 571 fails nothing.**
- **[src/teamLead/compose.ts:267-352](src/teamLead/compose.ts#L267)** — loops every firm, composes a
  question **through a model turn** with that firm's customer names in context, writes back with
  `n.tenant_id`. No two-firm test. This is the path where a firm-mixing bug puts firm A's customer
  name into a message delivered to firm B's technician.
- **[src/telegram/boardNotify.ts:244-303](src/telegram/boardNotify.ts#L244)** — loops every firm
  with a per-firm cursor map. `boardNotify.test.ts` uses one firm, so the cursor keying is untested.

**A test that catches them:** one shared fixture — two firms with identical-shaped data — run
through each loop, asserting every push/nudge/review-item lands in its own firm. The mocked-deps
style makes this cheap: return rows for both firms from the fakes and assert the partition.

---

### 9. Test infrastructure: 8 suites pick their firm nondeterministically, from 120 leaked firms

I queried the local stack: **`select count(*) from tenants` returns 120.** Grouped by name pattern:

```
Undo Verb Tenant    23      ctx-other-<n>       22
Fact Other Tenant   23      Money Other Tenant  22
Web Iso <n>         23      + 6 real fixtures
```

Every two-firm test creates a second firm and never removes it, because `src/test.setup.ts` does not
clean `tenants` (a documented consequence in eng-mem §5). Meanwhile these eight suites pick their
firm with an **unordered** `.limit(1).single()`:

`context.test.ts:17` · `moneyEvents.test.ts:174` · `nudges.test.ts:28` · `retractions.test.ts:23` ·
`reviewItems.test.ts:16` · `spine.test.ts:19` · `email/ingest.test.ts:18` ·
`writePath/recordFieldNote.test.ts:22`

An unordered `limit(1)` over 120 rows returns whatever the heap yields. These pass only because the
physical order happens to be stable; a `VACUUM FULL`, a restore, or enough churn flips them. The
suites that were already burned by this fixed it — `technicians.test.ts:34`, `tenantProfiles.test.ts:24`
and `server.test.ts:45` all pick **by name** with a comment explaining why. The other eight didn't
get the memo.

This is squarely in scope: it is the mechanism by which a second firm first breaks something, and it
will break the test suite before it breaks production.

**Fix:** `getTenantByName('Default Tenant')` in all eight, plus a `tenants` cleanup in
`test.setup.ts` scoped to fixture-name prefixes.

---

### 10. The repo's own tenant-isolation gate points at a document that has never existed

**`.claude/skills/data-security/SKILL.md:23,32,54`**

The data-security skill — the mandatory gate for any DB accessor — states the rule this whole audit
is measuring against:

> *"When you add a table or accessor: add its tenant filter **and** a case to the 2-tenant leak test
> (checklist Tier 2). Forgetting the filter must fail a test, not reach prod."*

It cites `docs/prod-migration-checklist.md` three times (B1, Tier 2, Tier 3) as the authority.
**That file does not exist**, and `git log --all -- '*prod-migration-checklist*'` returns nothing —
it has never existed in this repo's history. There is also no single canonical "2-tenant leak test"
file for a new accessor to add a case to; the ~14 isolation assertions are scattered across 12
suites in whatever style each feature chose.

This is the process root cause of the uneven coverage in the table above: the rule is right, the
enforcement artifact is missing, so compliance depended on whoever was writing that day.

**Fix:** create the checklist, or point the skill at a real canonical leak test
(`src/db/tenantIsolation.test.ts` with one case per accessor family would make gaps 1, 5, 7 and 8
mechanically visible).

---

### 11. Lower-severity, listed for completeness

| Gap | Where | Note |
|---|---|---|
| `money_events.id` is a sequential `bigint`, not a UUID | verified in `information_schema` | Cross-firm ids are *guessable* here, unlike everywhere else. `appendMoneyEvent` guards correctly; only the assumption is weaker. |
| `corrects_event_id` firm check untested | [moneyEvents.ts:113-117](src/db/moneyEvents.ts#L113) | The `target.job_id !== input.jobId` clause catches every cross-firm case anyway, so the firm clause is redundant defense. Honest severity: low. |
| Roster cache serves a stale firm for ≤60s after a move | [rosterCache.ts:15-18](src/telegram/rosterCache.ts#L15) | Documented and accepted. Note an account that *becomes* ambiguous still resolves to the first firm for the rest of the TTL. |
| `tenants.name` has no unique constraint | [tenants.ts:41-47](src/db/tenants.ts#L41) | `maybeSingle()` errors loudly on a duplicate — documented, and the right call. But `seed.mjs:429` and `backfill-schedule.mjs:81` both hardcode `'Default Tenant'`. |
| Phone worker + `resolveTenantByNumber` single-firm tests | `phoneWebhook.test.ts`, `worker.test.ts` | All fakes return `'T1'`. `claimNextPendingCall()` is a genuinely cross-firm queue pop; the worker threads `row.tenant_id` correctly but nothing proves it. |
| `ensureCoordsById` takes no firm | [geocode.ts:99](src/routes/geocode.ts#L99) | Coordinates only; ids come from a firm-scoped solve. |
| One `COMPOSIO_WEBHOOK_SECRET` / `SIGNALWIRE_API_TOKEN` across firms | `webhook.ts:138`, `phoneWebhook.ts:53` | The HMAC authenticates the *body/URL*, not the firm — both correctly derive the firm from a value we ourselves registered (`user_id`, dialed number). Sound today; would need revisiting if a firm ever brings its own vendor account. |
| `resolveIdentityFromHeaders` signs `"<tenantId>.<ref>"` with `.` as delimiter | [identity.ts:54](src/mcp/identity.ts#L54) | Not exploitable — `tenantId` is a UUID and cannot contain `.`. Noted only so a future non-UUID key doesn't reintroduce ambiguity. |

---

## Decision Points

**D1 — Make the boundary structural, or keep it conventional and test it harder?**

*Structural (recommended).* Add `UNIQUE (tenant_id, id)` on `customers`, `jobs`, `visits`,
`assignments`, `technicians`, then composite FKs on every child. It is a mechanical migration; the
data already satisfies it. It closes gaps 1, 5, 7 and the `v_*` join exposure **at once**, and it is
the only remedy that protects `raw_captures`, where a mistake is permanent.
*Trade-off:* one migration on the pilot, plus wider FK indexes. Given the repo's own doctrine —
"encoded as a DB constraint where it must be structural" (data-security §5.5) — this is what that
rule is asking for.

*Conventional* means adding ~8 guards and ~10 tests and re-adding them forever, with no backstop.

**D2 — What to do about the `v_*` grants?**

Recommend revoking `anon`/`authenticated` on all eight views (leave `spine_reader=r`) and asserting
the ACL in `querySpine.test.ts`, alongside the existing function-ACL assertion. This is a one-line
migration with no behavioural change — nothing legitimate uses those grants. Separately, correct the
engineering-memory entry: the views fail closed because **PostgREST cannot issue `SET`**, not
because `anon` lacks the privilege.

**D3 — Per-host identity secret, or accept the shared one until Option B?**

Recommend deciding *before* the second box exists, not after. A per-host `GATEWAY_IDENTITY_SECRET`
(host name → secret map on Render) is a small change now and a coordinated multi-host outage later.

**D4 — Where does the canonical 2-firm leak test live?**

Recommend one file, `src/db/tenantIsolation.test.ts`, with a shared two-firm fixture and one case
per accessor family, using the `boardApi.test.ts:862` hostile-fixture pattern (raw SQL to mint the
violation the verbs won't). Then point the data-security skill at it instead of the missing
checklist. This makes "did you add a leak case?" a diff-visible question.

**D5 — Sequencing.**

Gaps 9 and 10 are cheap and unblock everything else (a trustworthy suite + a real gate). Gap 2 is a
one-line migration. Gaps 1/5/7 collapse into D1. Gap 3 needs the `technicians` unique index **before**
a second firm shares a box. Gaps 4 and 8 are test work that can follow.

---

## Open Questions

1. **Does the pilot database match the local stack on the `v_*` grants and the GUC behaviour?** I
   did not touch the hosted project, per the audit's rules. The grant check is a read-only
   `pg_class.relacl` query and should be run there before relying on the local result — the
   engineering memory already warns that the pilot's migration ledger under-reports, so its grants
   must be read from `information_schema`, not inferred.
2. **Is the "legacy assignment" path (roster `sandbox_ref` with no pool row) still in use, or is it
   purely historical?** Gap #3's severity depends on it. `server.ts:4439,4596` still branch on it and
   `assign-host.mjs` still offers it, but if every live row now has a pool row, the unique index is
   trivially safe to add.
3. **Will a second firm get its own agent box, or share `trades-box-1`?** Gap #3 only bites on a
   shared host; gap #6 only scales on separate hosts. The two remedies are different, and the answer
   decides which is urgent.
4. **Was the `arwdDxtm` grant on the `v_*` views deliberate?** The 2026-08-06 ratification I can
   find covers anon **read** exposure on base tables. Write-through on auto-updatable views looks
   like a Supabase default that was never examined.
5. **Should `getCustomerContext` change signature to take `tenantId`?** It is the only major read
   accessor whose guard is entirely external. Four call sites; a mechanical change — but it touches
   the brief/answer synthesis path, so worth a deliberate yes.

---

## Verification provenance

**Audited tree:** `docs/agent-first-front-door` @ `6d49e3b`, working tree clean apart from
`docs/engineering-memory.md` and untracked `thoughts/` artifacts. **No source file was modified.**
This branch is behind `origin/main` (`bf6230c`); I diffed the two and reviewed the main-only
surfaces (`opsNotify.ts` — deliberately non-firm host alerting, correct; the `httpServer.ts` hook
into it; the PR #153 nudge-cap removal, which does not touch any firm-scoping code).

**VERIFIED against the running local database** (`supabase_db_TradesDatabase`, port 54322 — the
hosted pilot and prod were never contacted):
- the full table / `tenant_id` column inventory
- every unique index and constraint (`pg_indexes`, `pg_constraint`)
- all 48 foreign keys — **none composite**
- RLS status per table and `pg_policies` — **zero policies**
- all eight `v_*` definitions and their ACLs
- `query_spine` / `tenant_cost_detail` / `rollup_costs` ownership, `SECURITY DEFINER` flag and ACLs
- `money_events.id` is `bigint`, not `uuid`
- **`anon` can `set_config('spine.tenant_id', …)` and both SELECT and UPDATE through `v_customers`**
  (in a transaction, rolled back; confirmed 0 rows changed afterwards)
- **PostgREST as `anon` returns 42704 on `v_customers` and rows on `customers`**
- **120 rows in `tenants`**, grouped by leaked-fixture name pattern

**VERIFIED against code** (read in full, not sampled): all 195 `.from()` call sites classified for a
firm filter; every one of the ~20 firm-less by-id accessors traced to all of its callers;
`identity.ts`, `httpServer.ts`, `badgeFile.ts`, `nudgeQueue.ts`, `nudges.ts`, `moneyEvents.ts`,
`context.ts`, `rawCaptures.ts`, `boardApi.ts`, `boardRead.ts`, `sandboxPool.ts`, `phoneWebhook.ts`,
`signalwire.ts`, `relayHandler.ts`, `logIngest.ts`, `technicians.ts`, `assign-host.mjs`,
`badge-pull.sh`; and the specific test assertions cited in the coverage table — I read each one and
asked whether deleting the filter would fail it, rather than counting `createTenant` calls.

**INFERRED, not verified** — flagged where it appears:
- PostgREST's `!inner`-vs-plain embed semantics in gap #4 (documented behaviour; the local spine
  tables were empty and seeding them would have collided with a concurrent session's suite). The
  *absence of a second-host test* is verified.
- Reachability judgements ("safe today because upstream is firm-scoped") in gaps 1 and 7 are from
  reading every caller; a caller reached only through dynamic dispatch would have been missed.
- The engineering-memory claim about the pilot's anon posture is quoted, not re-verified — I did not
  touch the hosted project.

**Not run:** `npm test`. `docker ps -q | wc -l` returned **24** at the start (two local Supabase
stacks up — the primary and the `pacing-planner` worktree's), which is the documented contention
condition that produces failures that move between runs. Nothing in this audit depends on a suite
result; every coverage claim is from reading the assertion.

**Plans enumerated:** all 63 in `thoughts/shared/plans/`, footprints extracted and cross-referenced
against the code. Five plans name files that do not exist on this branch (`src/db/invoices.ts`,
`src/money/*` from invoice-creation-v1; `src/db/scheduleEntries.ts`; `src/llm/glm.ts`;
`src/inference/providers.ts`) — unbuilt or since removed, so out of scope. Per the audit's method,
no file is reported as safe on the strength of a plan.
