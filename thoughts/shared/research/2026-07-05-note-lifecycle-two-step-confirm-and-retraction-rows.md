---
date: 2026-07-05
branch: box-token-medic-and-accuracy-rules
commit: d47206b
topic: Note lifecycle — two-step confirm on record_field_note + Option-B retraction rows (current state of the code they will touch)
---

## Summary

The "note lifecycle" feature (user-approved direction 2026-07-05, recorded in session memory
`spine-capture-expansion`) has two parts: (a) a structural stage→confirm step on
`record_field_note` so nothing lands in the permanent record until a person says yes, and (b)
"retraction rows" — a mistake in the append-only L1 layer (`raw_captures`, the verbatim
evidence table that can never be updated or deleted) is neutralized by *appending* a new
capture that points at the bad one (`retracts: <capture_id>`), with all normal read paths
folding retracted rows out while audit views keep everything (a ledger / reversing-entry
model). This document maps what exists today: the current `record_field_note` write path
(which writes L1 *first* and only asks questions afterwards), the two existing two-step
confirm implementations it would mirror (`send_email` and `deactivate_technician_seat`, both
built on the `review_items` table as a durable confirm-token store), every read path that
would need to fold retractions out, and the schema facts (append-only trigger, an unused
`manual_correction` channel value, the one-open-item unique index) the design will sit on.

## Entry Points

- [src/mcp/server.ts:356](../../../src/mcp/server.ts#L356) — `record_field_note` dispatch case (tool definition at [src/mcp/server.ts:84](../../../src/mcp/server.ts#L84)). The only technician-facing entry to the note write path.
- [src/writePath/recordFieldNote.ts:60](../../../src/writePath/recordFieldNote.ts#L60) — `recordFieldNote()`, the channel-agnostic write path (L1 → extract → match → L2/L3).
- [src/mcp/server.ts:459](../../../src/mcp/server.ts#L459) — `send_email` dispatch case: the existing stage→confirm pattern the pending feature is recorded as mirroring.
- [src/mcp/server.ts:620](../../../src/mcp/server.ts#L620) — `deactivate_technician_seat`: the second two-step confirm implementation (different consume ordering, see Data Flows).
- Inbound (agentless) callers of the same write path: [src/inbound/webhook.ts:252](../../../src/inbound/webhook.ts#L252) (Composio Gmail webhook) and [src/email/ingest.ts:102](../../../src/email/ingest.ts#L102) (direct Gmail pull, dev/test path).

## Key Files

| File | Role |
|---|---|
| [src/writePath/recordFieldNote.ts](../../../src/writePath/recordFieldNote.ts) | The write path. Exports `recordFieldNote(input, deps)` → `{status: 'matched'\|'needs_confirmation'\|'needs_disambiguation'\|'duplicate', captureId, …}`. L1 insert happens at step (1), before extraction or matching. |
| [src/writePath/identityMatch.ts](../../../src/writePath/identityMatch.ts) | Deterministic customer/job resolution: confirmed customerId → unique phone/address match → schedule suggestion → ask. Produces the `needs_confirmation` / `needs_disambiguation` statuses. |
| [src/writePath/extract.ts](../../../src/writePath/extract.ts) | `sonnetExtractor` — the model call that proposes candidate fields from raw text. Injectable so tests stub it. |
| [src/db/rawCaptures.ts](../../../src/db/rawCaptures.ts) | L1 module: `appendRawCapture` (insert only — no update/delete exported, mirroring the DB trigger), `getRawCapture`, `getRawCaptureByExternalId`, `captureHasLinkedL2`, `listRawCapturesForJob`, `listRawCapturesForCustomer`. |
| [src/db/reviewItems.ts](../../../src/db/reviewItems.ts) | The confirm-token / review-queue store. `ReviewKind` union at [line 10](../../../src/db/reviewItems.ts#L10) (`pending_outbound_send`, `pending_deactivation`, …) — a plain string column in the DB, so **new kinds need no migration**. Key ops: `upsertOpenReviewItem` (one open row per tenant+kind+subject), `getOpenReviewItem` (guarded point read = token validation), `resolveReviewItem` (consume), `annotateResolvedReviewItem` (rewrite a consumed token's resolution after a downstream failure). |
| [src/db/context.ts](../../../src/db/context.ts) | `getCustomerContext` — the aggregated read backing `get_customer_context`, `brief_customer`, `answer_customer_question`. Unions captures stamped with `customer_id` AND captures linked from L2 rows via `source_capture_id`. |
| [src/synthesis/grounding.ts](../../../src/synthesis/grounding.ts) | `serializeContextForPrompt` (renders every capture, tagged with its id, into the synthesis prompt) and `validateCitations` (a citation is valid iff its captureId is present in `context.recentCaptures`). |
| [src/mcp/server.ts](../../../src/mcp/server.ts) | Tool surface + dispatch. Contains `dropSensitive` ([line 352](../../../src/mcp/server.ts#L352)) — the existing precedent for an in-memory per-row read filter applied to every capture-bearing read at dispatch. |
| [src/composio/logIngest.ts](../../../src/composio/logIngest.ts) | The other L1 writer: Composio execution logs → `agent_action` / `outbound_email` captures (capture-all, keys-only redaction; Gmail/Excel read slugs skipped). |
| [supabase/migrations/20260620005307_context_spine.sql](../../../supabase/migrations/20260620005307_context_spine.sql) | Base schema. Append-only trigger `raw_captures_append_only` (lines 116–119); `capture_channel` enum (lines 16–22) — **includes a `manual_correction` value that no code uses today**; L2 `source_capture_id` back-links (lines 106–114). |
| [supabase/migrations/20260702194603_technicians_and_review_items.sql](../../../supabase/migrations/20260702194603_technicians_and_review_items.sql) | `review_items` DDL (lines 56–68) + partial unique index `uq_review_items_open` on `(tenant_id, kind, subject_ref) where status='open'` (line 70). |
| [supabase/migrations/20260704120000_agent_action_sensitivity_sessions.sql](../../../supabase/migrations/20260704120000_agent_action_sensitivity_sessions.sql) | Adds `agent_action` channel value + `raw_captures.sensitivity` column ('manager_only' filtering). |
| [src/mcp/server.test.ts](../../../src/mcp/server.test.ts) | Encodes today's contract: `record_field_note returns needs_confirmation, then resolves on resume` (line 133) asserts the L1 row exists after the *first* call; cross-tenant confirmed.customerId rejection (line 457). |
| [docs/nemoclaw-tech-agent.md](../../../docs/nemoclaw-tech-agent.md) | Agent conversation contract §5 (lines 102–109): "The L1 note is already saved on the first call; the resume never writes a second capture." Stateless-resume note at lines 79–80. |
| [Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md](../../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md) | §0c (lines 115–137): the shipped Layer-1 prompt block ("Permanent-record writes — confirm FIRST") and the note that Layer 2 (structural stage→confirm) is the recorded pending feature. |

## Data Flows

### 1. `record_field_note` today — L1 lands before any confirmation

```
Agent call #1: record_field_note({text, channel})
  server.ts:356  channel guard → tenant-guard confirmed.customerId (if any)
  recordFieldNote()
    (1) appendRawCapture(...)            ← L1 IS NOW PERMANENT (no confirm has happened)
    (2) extract(rawText)                 ← model proposes fields
    (3) matchIdentity(...)               ← deterministic: confirmed > phone > address > schedule
    (4) not matched & nothing confirmed  → return {status:'needs_confirmation'|'needs_disambiguation',
                                                   captureId, suggestion?}
Agent asks the technician, then
Agent call #2: record_field_note({captureId, confirmed:{address|customerId}})
    (1') getRawCapture(captureId)        ← reload, never a second L1 row
    (2'-3') re-extract, re-match with confirmed
    (5) resolve/create customer → job → visit (each L2 row stamped source_capture_id)
    (6) legal status transition only     → return {status:'matched', customerId, jobId, visitId}
```

The existing "confirmation" is **identity resolution after the fact**, not a gate before
recording. This is exactly the live-incident gap recorded in memory: jane's agent supplied a
wrongly-inferred customer, the match succeeded, and the wrong-customer capture is permanent.
The tool description ([server.ts:86](../../../src/mcp/server.ts#L86)), the agent doc §5, and
the test at [server.test.ts:133](../../../src/mcp/server.test.ts#L133) all encode
"L1 saved on first call" as the contract.

Inbound callers ([webhook.ts:252](../../../src/inbound/webhook.ts#L252),
[email/ingest.ts:102](../../../src/email/ingest.ts#L102)) drive the *same* function with
`externalId` dedup and orphan-heal; there is no agent in the loop there, and an unmatched
inbound capture simply stays L1-only (raw kept, no L2) until it can be matched.

### 2. `send_email` — the existing stage→confirm shape (server.ts:459–587)

```
call #1 {to,subject,body}                          call #2 {confirmId ONLY}
  requireOutboundCapable(caller)                     guarded point read: getOpenReviewItem(
  dismiss any prior open staged send                   confirmId, tenant, kind, subjectRef=caller.ref)
  upsertOpenReviewItem(                              15-min expiry check (detail.stagedAt)
    kind:'pending_outbound_send',                    CONSUME token FIRST (resolveReviewItem)
    subjectRef: caller.ref,                          then send; on send failure:
    detail:{to,subject,body,stagedAt})                 annotateResolvedReviewItem(...) + error
  return {status:'needs_confirmation',               then advisory L1 capture (outbound_email)
    confirmId, <echo of the STAGED row>}             return {status:'sent', ...}
```

Properties the pattern provides: durable token (any replica can serve the confirm — stateless),
one open token per person (partial unique index; re-stage supersedes), forged/foreign token
matches nothing (all guards in the WHERE clause), staged copy is the payload of record (fresh
args on the confirm call are ignored), at-most-once (consume-first), and
`resolve_review` refuses to mark a live token 'resolved' ([server.ts:880](../../../src/mcp/server.ts#L880))
so it can only be cancelled (dismissed) out-of-band.

`deactivate_technician_seat` uses the same store with the **opposite ordering** — state change
first, token cleanup second ([server.ts:666](../../../src/mcp/server.ts#L666)) — because there
a retry must stay possible if the state write fails, whereas a send must never run twice.

### 3. Read paths that surface L1 captures (where retraction folding would apply)

```
                        ┌── list_recent_captures ── listRawCapturesForJob/ForCustomer ──┐
 raw_captures ──────────┤                                                               ├─→ dropSensitive() → agent
 (L1, append-only)      └── get_customer_context ─┐                                     │
                                                  ├─ getCustomerContext() (context.ts) ─┘
                            brief_customer ───────┤      │
                            answer_customer_q ────┘      └─→ serializeContextForPrompt()
                                                             → model → validateCitations()
```

Four tools surface captures; all funnel through two DB functions
(`listRawCapturesForJob`, `listRawCapturesForCustomer`) plus the union logic in
`getCustomerContext`. All four already pass through one per-row post-filter at dispatch:
`dropSensitive` (manager-only rows hidden from technician badges) — an in-memory filter keyed
on a *column of the row itself*. A retracted-ness fold differs structurally: it is a
*cross-row derived property* (row X is retracted iff some later row points at X), so the
folding read must also fetch/join the retraction rows to compute it.

Aggregates today are computed **agent-side** from these same reads (the live-proven
"retraction-folded $1,730 summary row" in the Excel scenario was the agent reading captures
and folding by hand per its prompt) — there is no server-side aggregation endpoint.

### 4. All L1 writers (any of their rows could become a retraction target)

| Writer | Channel(s) | Attribution |
|---|---|---|
| `recordFieldNote` via MCP tool | `technician_voice/note/photo` | badge identity |
| `recordFieldNote` via webhook / email ingest | `email` | `connector:gmail` or roster ref |
| `send_email` confirm step (advisory capture) | `outbound_email` | caller ref |
| `runLogIngestion` (Composio audit sweep) | `agent_action`, `outbound_email` | roster ref |

## External Dependencies

- **Anthropic model** (`sonnetExtractor`, `sonnetBriefer`, `sonnetAnswerer`) — extraction and synthesis; all injectable for tests.
- **Supabase / PostgREST** via `@supabase/supabase-js` (typed layer in `src/db/`). PostgREST-specific constraints shape the code: partial unique indexes can't be upserted onto (insert-then-catch-23505 pattern), and naming a column the deployed schema lacks fails the whole insert (the `sensitivity` spread at [rawCaptures.ts:47](../../../src/db/rawCaptures.ts#L47)).
- **MCP SDK** (`@modelcontextprotocol/sdk`) — note the SDK does **not** validate tool args against `inputSchema`; every guard is hand-written in dispatch.
- **Composio** — peripheral here (log ingestion writer, webhook caller).

## Constraints and Invariants

1. **L1 is append-only, enforced twice**: the DB trigger `raw_captures_append_only` (UPDATE or DELETE raises) and the module shape (`rawCaptures.ts` exports no update/delete). This is why the rejected alternative (a mutable `retracted` flag column) is structurally impossible without weakening the trigger — and why Option B (append a pointing row) is the only shape compatible with the current schema.
2. **The current confirm-resume contract is load-bearing in three places outside the code**: the tool description shown to every agent, `docs/nemoclaw-tech-agent.md` §5 ("The L1 note is already saved on the first call"), and the shipped §0c prompt block in every sandbox (which tells agents to confirm *before* calling, precisely because the server doesn't gate yet). Changing when L1 lands changes documented behavior deployed to sandboxes.
3. **Stateless resume**: today's resume token is `captureId` (a DB row id), so any replica serves any request. A stage→confirm gate cannot use `captureId` as its token if staging stops writing L1 — the durable-token store for that case is `review_items` (as `send_email` does).
4. **One open review item per (tenant, kind, subject_ref)** — partial unique index. For `pending_outbound_send` the subject is the caller's ref, giving "one staged send per person, re-stage supersedes". The same index shape would impose the same one-at-a-time semantics on any staged-note kind keyed the same way.
5. **`ReviewKind` is a plain text column** — adding a kind is a TypeScript union edit, no migration.
6. **`capture_channel` already contains `manual_correction`** (base migration line 19), unused by any code — enum groundwork that predates the retraction decision. Adding a *new* enum value is also cheap (`alter type … add value`, two prior examples).
7. **Identity-match confirmation and record-confirmation are different questions.** Today's `needs_confirmation`/`needs_disambiguation` ask "*which* customer?"; the pending feature asks "*may I record this at all?*". The current flow can require **two round-trips already** (ask → resume); a record-confirm gate is a third question that must compose with them.
8. **Inbound callers must keep working agentless.** `webhook.ts` and `email/ingest.ts` call `recordFieldNote` with no human in the loop; the incident and user decision target technician notes (the MCP tool path, `TECH_CHANNELS`). Whatever gate is added sits either in the tool dispatch or behind a flag in `recordFieldNote` — the function is shared.
9. **Citations only cite what's in context** (`validateCitations`): folding retracted captures out of `recentCaptures` automatically removes their citability, but also means a briefing can no longer *mention* that a note was retracted unless retraction rows themselves are surfaced somehow.
10. **L2 rows built from a bad capture are a separate problem from the L1 row.** `recordFieldNote` creates customer/job/visit rows stamped `source_capture_id`. L2 is *mutable* (normal tables) — the Option-B decision as recorded covers folding L1 reads; it does not say what happens to a visit/job/customer whose source capture gets retracted.
11. **Known bad data already exists in the pilot**: Maria's record carries an erroneous $1,280 condenser note that belongs to Tom (live DB, `daqapdlkgxfrhquacprv` — read-backs only from here; all tests run against the local stack per `testEnvGuard`).
12. **The Excel "spine originates, sheet displays" pattern depends on this feature**: regenerating a summary sheet from the spine is only trustworthy if the regeneration read is retraction-folded.

## Decision Points

1. **Where the confirm gate sits relative to the L1 write.** The user decision says "confirmation before recording to L1", which inverts today's L1-first flow: staging would hold the note (plausibly in a `review_items` row, like `send_email`'s staged copy) and L1 would be written only on confirm. The alternative shape — keep L1-first and gate only the L2 attachment — preserves the existing contract but leaves the incident class (permanent wrong rows) unsolved. The choice determines whether the `captureId`-based resume survives or is replaced by a `confirmId`-based one.
2. **How record-confirmation composes with identity confirmation.** Today: ask-which-customer → resume. Pending: also ask may-I-record. Options visible in the code: one combined confirmation at the end (stage carries the resolved customer + note; a single yes both confirms identity and authorizes the write — one extra round-trip at most), or two sequential gates (identity first, then record — up to three round-trips). Note extraction (`extract`) currently needs the L1 row's text but takes plain `rawText` — it can run on staged text without an L1 row existing.
3. **Consume ordering on confirm.** `send_email` consumes the token first (at-most-once beats retryability); `deactivate` changes state first (retryability beats at-most-once, because the action is idempotent). A confirmed note-write is closer to deactivate (appendRawCapture with a deterministic external id could be made idempotent) but the code forces an explicit choice.
4. **Representation of a retraction row.** Channel: the unused existing `manual_correction` value vs a new dedicated enum value (e.g. `retraction`). Pointer: `retracts: <capture_id>` in `metadata` JSONB (no migration, but folding reads then filter on a JSON key with no index) vs a real nullable `retracts_capture_id` column + index (migration; the append-only trigger doesn't block adding columns). The memory record specifies content (`retracts` + reason + who) but not representation.
5. **Where folding happens.** Options in the current structure: inside the two `listRawCaptures*` DB functions (every caller folds by default; audit access then needs a bypass parameter or separate function), in `getCustomerContext`, or at dispatch alongside `dropSensitive` (per-tool control, but each new read tool must remember to apply it — the same drift risk a review finding already flagged for the manager predicate). Cross-row derivation means the fold needs the retraction rows in hand wherever it runs.
6. **What audit visibility looks like.** "Audit views see everything" — today no tool distinguishes audit from normal reads. Options the surface allows: a manager-only tool/parameter that skips the fold, or retracted rows surfaced but marked. Interacts with the Telegram-only principle (memory: every feature must be reachable through agent chat — there is no other UI).
7. **Who may retract, and is retraction itself gated.** The memory records that the technician-changes-their-note flow runs *both* the corrected note and the retraction behind the confirm gate. Undecided in code terms: whether retracting someone else's capture is allowed (tier check — `caller.tier` is already loaded on every dispatch), and whether inbound/agent-action captures (not authored by a person) are retractable at all.
8. **What happens to L2 rows sourced from a retracted capture.** Fold-time exclusion of the visit/job (derive from `source_capture_id`), explicit compensating L2 mutation at retraction time (L2 is mutable), or nothing in v1. The recorded decision is silent here; visits carry L3 attributes (labor hours, work performed) that flow into briefings independently of the capture list.

## Open Questions

- Does the confirm gate apply only to `TECH_CHANNELS` via the MCP tool, or to every `recordFieldNote` caller? (Inbound email/webhook has no human to ask; presumed tool-only, but not recorded.)
- Should a staged note expire like a staged send (15 min), and is one-staged-note-per-person (the natural consequence of the `uq_review_items_open` index keyed on caller ref) acceptable when a technician dictates several notes back-to-back?
- Retraction of a capture that an open citation/briefing referenced: is a stale citation (id no longer in context) acceptable, or does anything need to re-derive?
- The pilot's existing bad rows (Maria/$1,280): backfill retraction rows manually once the mechanism exists, or leave them? (Live-DB write — outside test scope, manager/operator action.)
- `manual_correction` enum value: was it reserved for exactly this (no doc says), and does reusing it vs adding `retraction` matter to any downstream consumer? No code reads channel values semantically today except `logIngest` slug filters and `TECH_CHANNELS` validation.
- The sandbox §0c prompt block instructs agents to offer a "recorded-in-error correction note" as the remedy today — once structural retraction exists, that block and `Box_Setup_Stuff` must change in the same cycle (the `box-setup-stuff-sync` rule); confirming the full list of prompt artifacts that reference the old contract needs a sweep of `Box_Setup_Stuff/`.
