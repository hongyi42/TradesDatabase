---
date: 2026-07-13
branch: main
commit: d949f4f
topic: Feature C+D — per-tenant agent memory on a completed L3 write surface (current-state survey)
---

## Summary

Feature C+D is a two-phase parked feature (build-schedule entry, `thoughts/shared/build-schedule.md:12-104`). Phase 1 (formerly Feature D) would add a write path that sets a **standing attribute** — a durable key/value fact like "prefers email" or "gate code 1234" — on a **customer or job** row. Phase 2 (formerly Feature C) would add a server-side **memory layer** for the tenant's agents: soft narrative knowledge that doesn't fit the customer record, stored next to the spine, surviving sandbox rebuilds, with every memory citing its L1 evidence. This document surveys what exists today: the `attributes` JSONB columns (the "L3" layer — flexible JSON on each structured row) exist on all three L2 tables and are already **read** everywhere (briefings, Q&A, context), but the only live **writer** puts extracted facts on the **visit** row created for each field note — nothing ever writes customer- or job-level attributes, and no update primitive for those rows exists at all. The stage→confirm machinery (a two-step preview-then-commit flow backed by the `review_items` table) and the retraction/audit machinery (append-only "retraction rows" that neutralize a capture) are mature, shipped patterns that any Phase-1 tool would plug into. Phase 2 has no code at all yet — only recorded design constraints and the finding (prior research, 2026-07-08) that agent-side `MEMORY.md` files are wiped by sandbox rebuilds, which is exactly why server-side storage is the goal.

## Entry Points

- **Build-schedule entry (the feature definition):** `thoughts/shared/build-schedule.md:12-104` — division-of-information rule, phase split, triggers, recorded 2026-07-04 design constraints.
- **The spine tool surface (where a Phase-1 tool would land):** `src/mcp/server.ts:131-326` (`TOOLS`, 12 technician-visible tools), `src/mcp/server.ts:331-446` (`ADMIN_TOOLS`, 8 manager-only tools), dispatch switch at `src/mcp/server.ts:611`.
- **The only L3 writer today:** `src/writePath/recordFieldNote.ts:213-220` (`createVisit` with `buildVisitAttributes`).
- **The L3 readers:** `src/synthesis/grounding.ts:27,35,46` (customer/job/visit attributes serialized into every briefing/Q&A prompt).
- **Prior research:** `thoughts/shared/research/2026-07-08-long-running-agent-tasks.md` (Phase-2 context: why agent memory must be server-side).

## Key Files

| File | Role |
|---|---|
| `src/db/customers.ts` | Customer L2 access. `CreateCustomerInput.attributes` (`:16`) accepted, inserted (`:33`). Exports create/get/find/search — **no update function of any kind**. |
| `src/db/jobs.ts` | Job L2 access. `CreateJobInput.attributes` (`:35`), inserted (`:49`). The only L2 update in the codebase is `updateJobStatus` (`:93-121`) — a CAS-guarded (compare-and-swap: write only if the row still holds the value we validated) status transition. No attribute update. |
| `src/db/visits.ts` | Visit L2 access. `createVisit` (`:18`) takes `attributes` (`:14`) — the one live L3 write. |
| `src/writePath/recordFieldNote.ts` | The channel-agnostic write path: L1 append → extract → identity match → customer/job/visit build. Calls `createCustomer` (`:182-191`) and `createJob` (`:203-209`) **without** `attributes`; only `createVisit` (`:213-220`) gets `buildVisitAttributes(extracted)` (`:243-253` — extracted long-tail facts + workPerformed + followUp). |
| `src/writePath/extract.ts` | Claude Sonnet extraction (`sonnetExtractor`, model `claude-sonnet-4-6`). `ExtractedFields.attributes` (`:23`) is the model-proposed long-tail bag ("gate codes, pets, access notes" — system prompt `:30-36`). |
| `src/mcp/server.ts` | The single agent-facing boundary. Stage→confirm implementations: `record_field_note` (`:612-849`), `send_email` (`:1111-1239`), `retract_capture` (`:1240-1375`). Tier gate (`:589-609`), sensitivity filter `dropSensitive` (`:608-609`). |
| `src/db/reviewItems.ts` | The stage→confirm substrate. `ReviewKind` union (`:10-18`) is compile-time only — the DB column is plain text, so **a new kind needs no migration**. Partial unique index = at most one open item per (tenant, kind, subject). Token lookups put every guard in the WHERE clause (`getOpenReviewItem`, `:206-222`). |
| `src/db/rawCaptures.ts` | L1 access: insert-only module (`appendRawCapture` `:33`), external-id dedup (`:84`), retraction reads (`findRetractionsFor` `:175`, `foldRetractions` `:188`), completeness marker (`captureHasLinkedVisit` `:158`). |
| `src/db/context.ts` | `getCustomerContext`: customer + jobs + visits + unioned captures; folds retractions and **drops visits whose source capture was retracted** (`:56-67`) — how visit-level L3 facts disappear on retraction. |
| `src/synthesis/grounding.ts` | Serializes the full context — **including `customer.attributes` and `job.attributes`** — into the synthesis prompt; validates citations against real capture ids (`validateCitations` `:78-95`). |
| `src/synthesis/briefCustomer.ts`, `src/synthesis/answerQuestion.ts` | The grounded readers (brief_customer / answer_customer_question tools). Every claim must cite a captureId. |
| `src/mcp/identity.ts` | `RequestIdentity {tenantId, technicianRef}` — env-pinned (stdio) or gateway-HMAC headers (HTTP). The tenancy/person plumbing any memory table would key on. |
| `supabase/migrations/20260620005307_context_spine.sql` | Original schema: `attributes jsonb not null default '{}'` on customers (`:53`), jobs (`:68`), visits (`:84`); one `source_capture_id` back-link per L2 row; append-only trigger on raw_captures (`:117-119`). |
| `supabase/migrations/20260706090000_retraction_rows.sql` | Option-B retractions: `retracts_capture_id` + one-retraction-per-target unique index. "Retracted" is derived, never a flag update. |
| `supabase/migrations/20260704120000_agent_action_sensitivity_sessions.sql` | `raw_captures.sensitivity` (`'manager_only'`) — the only tier-sensitivity column in the schema; exists **only on L1**, not on L2 rows or review_items. |
| `docs/doorman-runbook.md:322-326` | Verification counts **exactly 12** technician tools and 8 admin tools — a new base tool changes a number an operational runbook asserts. |

## Data Flows

### Today's only L3 write (visit-level)

```
technician text ──► record_field_note (stage)                    [server.ts:634]
                      ├─ extract (Sonnet) → ExtractedFields       [extract.ts:73]
                      ├─ matchIdentity → resolved / needs_identity
                      └─ review_items row (kind pending_field_note,
                         staged copy = note of record)            [server.ts:670]
technician "yes" ──► record_field_note (confirmId alone)          [server.ts:794]
                      └─ recordFieldNote(resolved, externalId note:<confirmId>)
                           ├─ L1 appendRawCapture (verbatim)      [recordFieldNote.ts:114]
                           ├─ createCustomer  ── attributes NOT passed ─ {} [.:182]
                           ├─ createJob       ── attributes NOT passed ─ {} [.:203]
                           ├─ createVisit     ── attributes = extracted long-tail ✅ [.:213]
                           └─ updateJobStatus (only if legal transition)   [.:224]
```

Every extracted durable fact ("gate code 1234") lands on **that trip's visit row**. A fact about the customer ends up scattered across whichever visits' notes happened to mention it — the gap Phase 1 exists to close.

### The read side (already complete for customer/job attributes)

```
get_customer_context / brief_customer / answer_customer_question
  └─ getCustomerContext ─► serializeContextForPrompt
        CUSTOMER: … | attributes={…}     ← customer.attributes  [grounding.ts:27]
        JOBS:  … attributes={…}          ← job.attributes       [grounding.ts:35]
        VISITS: … attributes={…}         ← visit.attributes     [grounding.ts:46]
```

Anything Phase 1 writes onto a customer/job row would surface in briefings and Q&A **with zero reader changes** — the serializer already prints those (always-empty) objects.

### The stage→confirm pattern (what a Phase-1 tool would reuse)

All three confirm-gated tools follow the same shape:

1. **Stage:** validate + tenant-guard args → dismiss the caller's prior open token of that kind ("one staged item per person") → `upsertOpenReviewItem(kind, subjectRef, detail)` → echo the **item's** detail, not local args (two racing stages can return the other call's row) → `{status:'needs_confirmation', confirmId}`.
2. **Confirm:** `getOpenReviewItem` with id+tenant+kind+subject+open all in the WHERE clause (forged token ⇒ not found) → 15-minute expiry (checking first whether a commit already landed under the token's `externalId` stamp) → commit.
3. **Ordering:** idempotent commits go **commit-first, consume-second** (notes: L1 externalId `note:<confirmId>`; retractions: `retract:<confirmId>` + the one-retraction-per-target index make retries converge on one row). Non-idempotent sends go **consume-first** (at-most-once).
4. `resolve_review` refuses `resolved` on live confirm tokens (`server.ts:1803-1831`) — one branch per pending kind; a new kind needs its own branch.

### Retraction and what it does / does not undo

A retraction is an appended L1 row (`channel='retraction'`, `retracts_capture_id` → target). Read paths fold: retracted captures, retraction rows themselves, and **visits whose source capture is retracted** all vanish from default views (`context.ts:56-67`) — so today, retracting a note also removes its visit-level L3 facts. But facts a note wrote onto the **job/customer** record (status transitions, created shells) are explicitly **not** reverted — recorded scope decision (`build-schedule.md:137-143`, and the `retract_capture` tool description says so to users, `server.ts:302-312`).

## External Dependencies

- **`@anthropic-ai/sdk`** — `sonnetExtractor` (extraction), `sonnetBriefer`/`sonnetAnswerer` (synthesis), all `claude-sonnet-4-6`, all injectable seams for tests.
- **`@modelcontextprotocol/sdk`** — the MCP server (stdio + central HTTP with gateway-HMAC identity).
- **Supabase (PostgREST via `getClient`)** — all persistence. Note: supabase-js `update({attributes: …})` **replaces** a JSONB column wholesale; there is no merge primitive in the current db layer.
- **OpenClaw / GLM-5.2 via DeepInfra** (Phase-2 context, not in this repo): the agents' runtime. Anthropic platform memory/compaction features are **not available** there (prior research, Dimension 1) — the repo's server-side spine is the only durable store the agents share.

## Constraints and Invariants

- **L1 is append-only** (DB trigger + module discipline). A memory or attribute write's *evidence* lives in L1 forever; only inbound captures are classify-gated, outbound/audit captures are capture-all (recorded exceptions in CLAUDE.md).
- **The `attributes` columns exist everywhere but are written nowhere except visits.** `createCustomer`/`createJob` accept the field; the grep across `src/` shows no live caller passes it. Both columns are `{}` on every row in practice.
- **No generic L2 update primitive exists.** The entire codebase's L2 update surface is `updateJobStatus` — CAS-guarded, status only. Phase 1 requires a new db-layer function; the CAS pattern (`jobs.ts:107-119`) is the in-repo precedent for concurrency-safe updates.
- **One `source_capture_id` per L2 row, stamped at creation.** There is no per-key provenance: a standing attribute added later from a different capture has no schema home for its evidence link. The confirm-gated, "cites the L1 capture" requirement in the build-schedule entry is **not representable in the current schema** without a shape decision (see Decision Points).
- **Preview == commit.** The staged copy in `review_items.detail` is the record of note; commit reads only it (extraction replayed from staged detail, `server.ts:820`). Identity resolution travels from stage to commit (`ResolvedIdentity`) so a re-match can't change the outcome.
- **The visit is always the last L2 write**, making `captureHasLinkedVisit` the crash-completeness marker (`rawCaptures.ts:152-167`). Any Phase-1 change that appends more L2 writes into `recordFieldNote`'s sequence interacts with this invariant.
- **Tier machinery exists but only for L1 reads and admin tools.** `technicians.tier` gates ADMIN_TOOLS at dispatch; `raw_captures.sensitivity='manager_only'` rows are post-filtered from every capture-bearing read for non-managers (`dropSensitive`, typed so a narrowed select fails compile). Nothing equivalent exists on L2 rows, attributes keys, or review items — Phase 2's "manager-only memories" has a pattern to copy, not a mechanism to reuse.
- **Tool-count is operationally load-bearing:** the doorman runbook asserts exactly 12 technician tools / 8 admin tools (`docs/doorman-runbook.md:322-326`). MCP tool descriptions are also cached per gateway process (deploy gotcha recorded in session memory).
- **ReviewKind is migration-free** (plain text column, TS union) — adding e.g. `pending_attribute_write` is a code-only change.
- **`new Date()`/`Date.now()` are used freely in the server** (staging timestamps, expiry) — the 15-minute staging expiry applies uniformly to all confirm-gated tools.
- **Phase-2 prior findings (2026-07-08):** agent-authored `MEMORY.md` does not survive a sandbox rebuild (only host-re-appended AGENTS.md blocks come back); the §0d batching block now instructs agents to distill task learnings into `MEMORY.md`, so losable memories will start accumulating — that arms the recorded secondary trigger for building Phase 2.

## Decision Points

Stated factually — these are the forks the current code creates for the upcoming plan:

1. **Where the Phase-1 write enters.** Two shapes fit the existing machinery: (a) a **new spine tool** (e.g. `record_customer_fact`) with its own `pending_*` ReviewKind and stage→confirm cycle — self-contained, but changes the runbook's 12-tool count if technician-visible; or (b) **extending `record_field_note`'s flow** so extraction can route facts to customer/job instead of the visit — no new tool, but complicates a carefully-hardened staged flow and its preview.
2. **The missing DB primitive and its merge semantics.** supabase-js `update` replaces the whole JSONB object. Options given the code today: read-modify-write with a CAS guard (the `updateJobStatus` precedent, guarding on the previously-read attributes value), or a Postgres-side merge (RPC / `jsonb_set` in a database function — a new pattern for this repo, which currently has no RPCs from the typed layer).
3. **Per-key provenance shape.** The build-schedule requires each standing attribute to cite its L1 capture. Nothing in the schema supports that. Options visible from the code: wrap values in the JSONB itself (`{"prefersEmail": {"value": true, "sourceCaptureId": "…"}}` — but `grounding.ts` serializes attributes raw into prompts, so the wrapper becomes what the model reads); a sidecar table (new migration, new read joins); or stamping evidence only on the L1 side (capture carries `customer_id` + the key names in metadata — weaker: not queryable per key).
4. **Retraction behavior for standing attributes.** Visit-level L3 facts disappear when their note is retracted (fold at read). Customer/job-level facts have no fold path, and the recorded scope decision says retraction does not revert L2 side effects. Phase 1 must pick a side: follow the visit model (needs per-key provenance so a key can be dropped when its capture is retracted) or the job-status model (retraction leaves the attribute; manual correction is the fix) — the latter matches the existing scope decision but weakens the evidence-link story.
5. **Idempotency of the attribute commit.** Note commits are idempotent via the L1 externalId stamp; an attribute upsert has no structural equivalent (writing the same key twice is naturally idempotent for same-value, but a crash between L1 evidence append and the L2 merge leaves an evidence row with no attribute — the analog of the "partial record" case `record_field_note` handles at `server.ts:714-741`).
6. **Tier sensitivity scope (bridges to Phase 2).** `sensitivity` exists only on `raw_captures`. If manager-only standing attributes (or memories) are wanted, the marking has to be designed fresh — per-row on a memory table is straightforward (copy the dropSensitive pattern); per-key inside a customer's attributes JSONB has no precedent.
7. **Phase-2 storage shape (all recorded open questions still open).** Nothing in code constrains the memory table beyond: tenancy keys (`RequestIdentity`), the citation discipline (`validateCitations` is the precedent for enforcing evidence links deterministically), the tier pattern, and the recorded constraints — memory never replaces L2, every memory cites L1 evidence ids, retrieval must be selective (not load-everything). Per-person vs per-tenant scope and write discipline (confirm-gated like notes?) are decided by nothing in the code today.

## Open Questions

- Do any customer/job rows in the pilot DB carry non-empty `attributes` from seeds or manual writes? (Read-back needed; code says they can't come from the app.)
- Concurrency behavior of a read-modify-write JSONB merge under PostgREST at real load — needs a test, not reading.
- Has the §0d batching block actually produced `MEMORY.md` distillations on trades-box-1 yet (i.e. is the Phase-2 secondary trigger armed in practice)? Box-side, not visible in this repo.
- Whether `get_customer_context`'s response size stays reasonable once customers carry many standing attributes — the serializer prints the whole object into every synthesis prompt.
- The Phase-2 retrieval story ("selective recall, not load-everything") has no analog anywhere in the codebase — whether it needs embedding/search infrastructure or a simple keyed lookup is undetermined by anything that exists.
