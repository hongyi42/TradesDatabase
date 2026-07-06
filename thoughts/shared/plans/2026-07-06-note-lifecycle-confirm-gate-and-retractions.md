---
date: 2026-07-06
task: Note lifecycle — stage→confirm gate on record_field_note + Option-B retraction rows with folded reads
research: thoughts/shared/research/2026-07-05-note-lifecycle-two-step-confirm-and-retraction-rows.md
status: complete
---

## Overview

Two changes to how technician notes enter and leave the permanent record. (1) `record_field_note`
stops writing L1 first: the note is **staged** (held in `review_items`, nothing permanent) until
the technician gives one final yes. (2) A new `retract_capture` tool neutralizes a wrong capture
by **appending** a retraction row (`retracts_capture_id` → target) — L1 stays append-only; all
normal reads fold retracted captures (and their visits) out; managers can request the unfiltered
trail.

## Decisions

- **Gate before L1** — staged in `review_items`, L1 written only on confirm (user decision 2026-07-05; recorded in memory). The old "L1 saved on first call" contract is retired for the tool path.
- **Confirm UX: one final confirm** (user choice 2026-07-06) — identity is resolved during staging (asking "which customer?" only when ambiguous, nothing recorded); ONE final confirmation shows customer + note text.
- **Who retracts: author + managers** (user choice 2026-07-06) — a tech retracts their own captures; an active manager retracts anyone's, including connector/agent rows.
- **Full-history view: managers only** (user choice 2026-07-06) — `list_recent_captures` gains `includeRetracted`, rejected on non-manager badges; retracted rows come back labeled with their retraction.
- **L2 fallout: also fold visits** (user choice 2026-07-06) — reads hide visits whose `source_capture_id` is retracted; jobs/customers stay.
- **Inbound callers unchanged** — webhook/email ingestion keep calling `recordFieldNote` L1-first (agentless; no one to ask). The gate lives in the MCP tool path only.
- **Retraction representation** — new `capture_channel` value `'retraction'` + a real `retracts_capture_id uuid` FK column with an index (not a metadata key: folding reads filter on it; `manual_correction` stays unused — its name doesn't mean "this row neutralizes another").
- **Fold location** — inside `getCustomerContext` (covers context + both synthesis tools by construction) and at dispatch for `list_recent_captures` (the manager toggle lives there), both via one shared `foldRetractions` helper + one DB lookup `findRetractionsFor(ids)`. Cross-row derivation, so stamping alone can't be trusted.
- **Confirm-token mechanics** — mirror `send_email`'s staging (kind-per-flow review items `pending_field_note` / `pending_retraction`, subjectRef = `identity.technicianRef` — NOT `caller.ref`: record_field_note works for roster-less badges where `caller` is null, unlike send_email; one open per person, re-stage supersedes; 15-min expiry; guarded point-read validation). **Ordering is action-first, not consume-first** (deactivate's pattern, not send_email's — review finding): both commits are idempotent via `externalId` stamps (`note:<confirmId>` / `retract:<confirmId>`), so validate token → commit → consume. A crash mid-commit leaves the token open; the retried confirm re-runs the commit with the SAME externalId and the dedup/orphan-heal path yields exactly one L1 row. Consume-first would instead orphan a permanent L1 row on a mid-commit crash and mint a second one on restage.
- **No model call on confirm, and preview == commit** — the stage step stores the extractor's output AND the resolved identity (`{customerId, jobId}` or `createFrom`) in the item's `detail`; commit replays both (`extract: async () => detail.extracted`, `resolved: detail.resolved`), so confirming costs no Anthropic call, can't extract differently than what was shown, and can't re-match to a different customer (a commit-time re-match could — e.g. the schedule branch keys on the calendar day, which changes at midnight inside the 15-min window; review finding).
- **At most one retraction per target** — enforced structurally by a partial UNIQUE index on `retracts_capture_id` (review finding: a concurrent author+manager double-confirm would otherwise write two permanent retraction rows and break the singular `retraction:{...}` annotation).
- **Tool surface 8 → 9** — `retract_capture` is a technician tool (author-retraction is the common flow); every "8 tools" count in docs/tests updates in this cycle (Box_Setup_Stuff sync rule).
- **Retracting a retraction is forbidden in v1** — un-retract would need its own semantics; out of scope.
- **Audit rows are manager-only retractions, even for their author** (added at the final review gate 2026-07-06): `outbound_email`/`agent_action` captures stamp the acting person's own roster ref, so the author-or-manager rule alone would let someone scrub their own audit trail from default views — contradicting the recorded 2026-07-04 capture-all exception. Managers retain the `includeRetracted` trail either way.
- **Known accepted limitations** (surfaced at the final review gate): a retraction does not revert L2 facts the note already wrote (job status/title, created customers) — per the L2-fallout decision; a staged note that expires/supersedes is dropped from the permanent record by design (its text remains in the dismissed review item for forensics); a mid-L2 crash on confirm now surfaces as an explicit "partially recorded" error instead of a false duplicate-success.

## Plain-language walkthrough

**Phase 1 — the database learns what a retraction is.** We add one new column to the raw-capture
table (`retracts_capture_id`: "this row cancels that row") plus a new channel label `retraction`,
and teach the read helpers to *fold*: given a list of captures, drop every capture that some
retraction points at, and drop the retraction rows themselves. Also: a customer's context stops
including visits whose source note was retracted. Nothing user-visible yet — just verified plumbing.

**Phase 2 — the confirm gate.** Recording a note becomes: agent stages it (server holds it in the
same "pending items" table used for staged emails), resolves which customer it belongs to (asking
only if ambiguous), then shows one final "record this for X?" — only a yes writes the permanent
rows. You'd notice it because the agent now always shows the exact note + customer and waits.

```
 tech ──note──▶ agent ──stage──▶ server: extract + match  (NOTHING written)
                  ◀── "which customer?" (only if ambiguous) ──┘
                  ◀── "record this for HENDERSON: '…' — confirm?"
 tech ──yes──▶ agent ──confirmId──▶ server: consume token → L1 row → L2 rows
```

**Phase 3 — fixing mistakes.** New `retract_capture` tool: point at a bad capture, give a reason,
confirm — the server appends the cancelling row. From then on briefings/Q&A/context behave as if
the bad note never existed; a manager can still ask for the full labeled trail.

**Phase 4 — telling the agents and the docs.** Every place that teaches an agent or operator the
old behavior ("the note is already saved on the first call", "8 tools", the §0c "correction note"
remedy) is rewritten to the new contract, and the whole feature gets a live end-to-end check on
the local stack.

## Secrets & env preflight

- **All phases:** local Supabase stack running (`npx supabase start`, `.env.test` per `.env.test.example`) — `already required` for `npm test`.
- **Phases 2–4:** `ANTHROPIC_API_KEY` in `.env` — `already required` in production; **required here for the live verification steps** (the stdio server's stage step calls the real extractor — no stub seam exists over stdio; review finding). Unit tests still stub it and skip key-gated cases without it. No new secrets anywhere.
- **Deploy note (not a phase task):** the Phase 1 migration must be applied to the pilot DB before the code deploys (PGRST204 ordering — mitigated by conditional column spreads, same pattern as `sensitivity`).

## Phase 1: Schema + folding primitives

### What this phase does
Adds the retraction schema and the pure folding machinery, fully tested, with zero behavior change
for existing tools (nothing writes `retraction` rows yet).

### Changes required

**`supabase/migrations/20260706090000_retraction_rows.sql`** (new)
```sql
alter type capture_channel add value if not exists 'retraction';
alter table raw_captures add column retracts_capture_id uuid references raw_captures(id);
-- UNIQUE: at most one retraction per target, enforced structurally (a concurrent
-- double-retract must lose at insert, not write a second permanent row).
create unique index uq_raw_captures_one_retraction on raw_captures(retracts_capture_id)
  where retracts_capture_id is not null;
```
(No INSERT using the new enum value in this migration — same-transaction enum-use restriction.)

**`src/db/database.types.ts`** — regenerate: `npx supabase gen types typescript --local > src/db/database.types.ts` (after `npx supabase db reset`).

**`src/db/rawCaptures.ts`**
- `AppendRawCaptureInput`: add `retractsCaptureId?: string | null`; insert via conditional spread `...(input.retractsCaptureId != null ? { retracts_capture_id: input.retractsCaptureId } : {})` (PGRST204 guard, mirrors `sensitivity` at line 47).
- New `findRetractionsFor(captureIds: string[]): Promise<RawCapture[]>` — `select().in('retracts_capture_id', captureIds)`; return `[]` fast-path on empty input.
- New pure helper `foldRetractions(rows: RawCapture[], retractions: RawCapture[]): RawCapture[]` — drop rows whose `id` is any retraction's `retracts_capture_id`, and drop rows whose own `retracts_capture_id` is non-null (retraction rows never appear in folded views even if stamped into a list).

**`src/db/context.ts`**
- `getCustomerContext(customerId, opts?: { includeRetracted?: boolean })` — after assembling `recentCaptures`, call `findRetractionsFor(ids)`; unless `includeRetracted`, apply `foldRetractions` AND filter `recentVisits` to exclude visits whose `source_capture_id` is a retracted id. Default folds — all four capture-bearing tools inherit it.

**`src/db/reviewItems.ts`** — extend `ReviewKind` with `'pending_field_note' | 'pending_retraction'`; add `updateOpenReviewItemDetail(id, tenantId, detail: Json): Promise<ReviewItem | null>` (UPDATE … `eq('status','open')` guards in WHERE, returns null if not open — used by the identity-resume step).

**`src/db/spine.test.ts` (or new `src/db/retractions.test.ts`)** — new tests: append with `retractsCaptureId` lands and FK-validates; a second append targeting the same capture fails with a unique violation (`isUniqueViolation`); `findRetractionsFor` finds by target id; `foldRetractions` drops target + retraction rows; `getCustomerContext` folds captures and visits by default and includes them with `includeRetracted: true`.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (31 files / 218 tests)
- [x] new retraction-schema + folding tests pass (`src/db/retractions.test.ts`, 8 tests)
- [x] `docker exec supabase_db_TradesDatabase psql -U postgres -c "\d raw_captures"` shows `retracts_capture_id` + `uq_raw_captures_one_retraction` UNIQUE partial index + FK (evidence captured 2026-07-06)

### Live verification (agent-executable)
- Prerequisites: local stack only.
- [x] psql: UPDATE and DELETE on a retraction row both raised `raw_captures is append-only` (evidence captured 2026-07-06).

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 2: Stage→confirm on `record_field_note`

### What this phase does
Inverts the tool path to stage-first. `recordFieldNote()` itself keeps working L1-first for the
inbound callers (`src/inbound/webhook.ts:252`, `src/email/ingest.ts:102`) and becomes the commit
engine for the confirmed path.

### Changes required

**`src/mcp/server.ts`** — rewrite `case 'record_field_note'` (line 356) following the `send_email` staging shape (lines 459–587) with action-first confirm ordering:
- **Stage** (`text`/`blobPath`, no `confirmId`): validate channel (`TECH_CHANNELS` — `'retraction'` is not in it, so this tool can never mint retraction rows); run `(deps.extract ?? sonnetExtractor)` on the text (**the fallback is mandatory** — production constructs the server with no `extract` dep at server.ts:951 / httpServer.ts:161 and only tests inject a stub; import `sonnetExtractor` from `../writePath/extract.js`; review finding), then `matchIdentity` (import from `../writePath/identityMatch.js`) with `capturedAt = new Date().toISOString()`.
  - Identity unresolved → supersede any open `pending_field_note` for subjectRef = `identity.technicianRef` (**not** `caller.ref` — `caller` is null for roster-less badges, which this tool must keep serving; review finding), upsert one with `detail: {text, blobPath, channel, extracted, stagedAt}`, return `{status:'needs_identity', confirmId, suggestion?, reason?}` — question semantics unchanged from today's `needs_confirmation`/`needs_disambiguation`, but **nothing is written to L1**.
  - Identity resolved → same staging, `detail` additionally carries `resolved: {customerId?, jobId?, createFrom?}` from the `MatchResult` (tenant-guard a model-supplied `confirmed.customerId` exactly as today, server.ts:367–372), return `{status:'needs_confirmation', confirmId, preview: {customerName, text}}` echoing the ITEM's detail (racing-stage rule, like send_email:492).
- **Identity resume** (`confirmId` + `confirmed:{customerId|address}`): guarded point-read of the open item; re-run `matchIdentity` with `confirmed` against the stored `extracted`; `updateOpenReviewItemDetail` storing the full resolution as `resolved: {customerId?, jobId?, createFrom?}` (jobId and createFrom both matter: a linked schedule entry's jobId and an unlinked entry's denormalized prefill must survive to commit — a commit-time re-match could resolve differently, e.g. across midnight; review finding); return `needs_confirmation` + preview.
- **Final confirm** (`confirmId` alone): point-read (kind + subjectRef = `identity.technicianRef`) → malformed/15-min-expiry checks (mirror send_email:511–518) → **commit FIRST**: `recordFieldNote({tenantId, technicianRef: identity.technicianRef, text, blobPath, channel, resolved: detail.resolved, externalId: 'note:'+confirmId, sourceMeta: {stagedConfirmId: confirmId}}, {extract: async () => detail.extracted})` → **consume second** (`resolveReviewItem`). Action-first is safe because the commit is idempotent (`externalId` dedup + orphan heal) and makes a mid-commit crash retryable with the SAME confirmId/externalId — consume-first would permanently orphan a half-written L1 row (review finding). On commit throw the token stays open and the error says "retry with the same confirmId"; consume failure after a successful commit is advisory (the next confirm hits the externalId dedup and reports `duplicate`). Return `{status:'recorded', captureId, customerId, jobId, visitId}`.
- Update the `record_field_note` tool description + `inputSchema` (drop `captureId`, add `confirmId`; document the three-call contract).
- `resolve_review`: add the live-token guard for `pending_field_note` (resolved → error "confirm it via record_field_note, or dismiss to cancel"; mirrors lines 872–885).

**`src/writePath/recordFieldNote.ts`**
- Add pre-resolved identity plumbing so preview == commit: `RecordFieldNoteInput` gains `resolved?: { customerId?: string; jobId?: string; createFrom?: ScheduledCustomerDraft }` (import the type from `./identityMatch.js`). When present, **skip `matchIdentity` entirely**: `resolved.customerId` → that customer; else create-new from `resolved.createFrom` (reusing the existing create block, lines 153–168); `resolved.jobId` feeds the existing job-resolution chain (line 172). Extraction still runs (the replay stub) — L3 fields come from it.
- Remove the now-dead tool-resume support: drop `captureId` from `RecordFieldNoteInput` and the reload branch (lines 29–33, 71–76) — no production caller passes it after this phase. Everything else (externalId dedup, orphan heal, L2 build) is unchanged and is the commit engine.
- Result `status` union loses nothing (inbound callers still get `matched`/`needs_confirmation`/`needs_disambiguation`/`duplicate`; an unresolved inbound capture still lands L1-only — unchanged).

**`src/writePath/recordFieldNote.test.ts`** — the two resume tests at lines 107 and 156 pass `captureId` and encode the retired L1-first resume contract (review finding — typecheck breaks without this): rewrite them against the new contract (one as a `resolved:`-driven commit incl. `createFrom` create-new, one asserting `resolved` bypasses `matchIdentity` — e.g. a stale schedule day still commits the previewed customer).

**`src/mcp/server.test.ts`**
- Rewrite `record_field_note returns needs_confirmation, then resolves on resume` (line 133) into the staged contract: stage → assert **no** `raw_captures` row exists (psql read-back) → identity resume → final confirm → assert L1 + visit rows exist with `technician_name` from identity.
- New tests: confirm with forged/expired confirmId; re-stage supersedes (old confirmId dead); crash-heal — commit succeeded but consume failed (stub `deps` seam or resolve the item out-of-band), retried confirm returns `duplicate` with the SAME captureId, exactly one L1 row; a second confirm after full success errors cleanly ("confirmation not found"); `resolve_review` refuses `resolved` on `pending_field_note`; cross-tenant `confirmed.customerId` still rejected at stage (adapt line 457 test).

**`src/inbound/webhook.test.ts` / `src/email/*.test.ts`** — should pass untouched (their caller path is unchanged); run to prove it.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (31 files / 224 tests)
- [x] staged-contract tests above pass; grep confirms no `captureId` left in the tool schema

### Live verification (agent-executable)
- Prerequisites: local stack; verification subagent (fresh context, maker≠checker) driving the stdio MCP server (`node dist/mcp/server.js` with `.env.test` + identity env) via an MCP client script.
- [x] Full conversational flow verified live 2026-07-06 (real extractor): stage → psql showed 0 L1 rows → identity resume (preview `LIVE E2E Customer`) → still 0 rows → confirm → exactly 1 capture (`external_id note:<confirmId>`) + 1 visit (`source_capture_id` = captureId, labor_hours 1.5 from the replayed staged extraction) → repeat confirm rejected, counts unchanged. All 4 claims confirmed with row-level evidence.

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 3: `retract_capture` + manager full-history view

### What this phase does
Adds the 9th technician tool and enforces folding on the last read path (`list_recent_captures`).

### Changes required

**`src/mcp/server.ts`**
- Add `retract_capture` to `TOOLS`: `{captureId, reason, confirmId?}` — description states two-step + permanence + who may retract.
- New `case 'retract_capture'`:
  - Load target via `getRawCapture(captureId)`; guards: exists + `tenant_id === tenantId`; `retracts_capture_id === null` (can't retract a retraction); not already retracted (`findRetractionsFor([id])` empty); `reason` required non-empty.
  - Permission: `target.technician_ref === identity.technicianRef || activeManager` — else error "only the author or a manager can retract a capture".
  - Stage: supersede + upsert `pending_retraction` (subjectRef = `identity.technicianRef`, `detail: {captureId, reason, targetPreview: (target.raw_text ?? '').slice(0, 200), stagedAt}`); return `needs_confirmation` + echo of the item detail.
  - Confirm (`confirmId` alone): point-read + expiry + re-check the already-retracted guard → **commit first**: `appendRawCapture({tenantId, channel:'retraction', technicianRef: identity.technicianRef, rawText: reason, retractsCaptureId: detail.captureId, customerId/jobId/visitId: copied from target stamps, externalId: 'retract:'+confirmId, metadata: {retractedBy: identity.technicianRef}})` — catch `isUniqueViolation`: on `uq_raw_captures_one_retraction` a concurrent retraction won the race → consume the token as dismissed and report "already retracted"; on the externalId index it's this confirm's own retry → treat as success. Then consume (`resolveReviewItem`, advisory after a landed row). Return `{status:'retracted', captureId, retractionId}`.
- `list_recent_captures`: accept `includeRetracted?: boolean`; if set and `!activeManager` → error "includeRetracted requires a manager badge". Default: fetch rows → `findRetractionsFor` → `foldRetractions`. With toggle: return rows annotated `{...row, retracted: true, retraction: {id, reason: raw_text, by: technician_ref, at: captured_at}}` for targeted rows, retraction rows included as-is.
- `resolve_review`: live-token guard for `pending_retraction` (same pattern).
- `get_customer_context` case: no change needed (folding landed in `getCustomerContext` in Phase 1) — verify via test, and confirm `brief_customer`/`answer_customer_question` inherit it (they call the same function).

**`src/mcp/server.test.ts`**
- ALL FOUR tool-count assertions update (review finding — the plan originally named one): line 115/130 technician surface 8 → 9 (+`retract_capture`); line 801 (send_email suite) 8 → 9; lines 650 and 924 manager surface 15 → 16.
- New tests: author retracts own capture (full two-step, then `get_customer_context` no longer returns it and its visit); non-author technician rejected; manager retracts another's; double-retract blocked at stage AND at confirm (the second confirm's unique-violation path reports "already retracted", one retraction row total); `includeRetracted` rejected for technician badge, labeled trail returned for manager; retraction rows never appear in folded `list_recent_captures`.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (31 files / 230 tests)
- [x] all Phase 3 tests above pass (6-test `retract_capture + retraction folding` block incl. the racing-confirm unique-violation path)

### Live verification (agent-executable)
- Prerequisites: local stack + the Phase 2 MCP-client script.
- [x] E2E verified live 2026-07-06: record (staged, real extractor) → retract (staged+confirmed) → `get_customer_context` returned empty captures/visits while psql showed both raw rows intact (`retraction` row `external_id retract:<confirmId>`, `retracts_capture_id` = target) and the visit row present; technician `includeRetracted` rejected, folded view still served. All 5 claims confirmed with row evidence.

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 4: Docs, prompt artifacts, and the final sweep

### What this phase does
Brings every agent/operator artifact to the new contract (the `box-setup-stuff-sync` rule makes
this part of the same change, not a follow-up), then runs the full gates + build.

### Changes required

**`docs/nemoclaw-tech-agent.md`** — §5 conversation contract rewritten (stage → optional identity ask → final confirm; "the L1 note is already saved on the first call" line 107 removed); tool lists/counts at lines 87, 92 → 9 tools incl. `retract_capture`; stateless-resume note (lines 79–80) now cites the review-item token.

**`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`** — line 24 count 8 → 9 (manager 15 → 16); §0c block (lines 115–137): the remedy for a wrong recorded note becomes "record the corrected note, then retract the wrong capture via retract_capture (both confirmed)"; the parenthetical at lines 132–135 flips from "pending feature" to "shipped — the server now enforces stage→confirm structurally; these prompt rules remain defense-in-depth".

**Remaining count/list sites** — `Box_Setup_Stuff/doorman-architecture-memory.md:242`, `docs/doorman-runbook.md:242/308/321/367`, `Box_Setup_Stuff/migration-runbook-lightsail.md:114` (the "HTTP 200 + 8 tools" Gate A — NOT line 196, which is the Render env-var gotcha; review finding), `Box_Setup_Stuff/bootstrap-box.sh:493`. **The authoritative check is the sweep, not this list**: `grep -rn "8 tools\|15 tools\|record_field_note" docs/ Box_Setup_Stuff/` must come back clean of stale counts/contracts.

**Post-deploy operator note** (add to the plan-completion summary, not code): apply the migration to the pilot DB before deploying; then the manager can retract the known bad pilot rows (Maria's $1,280 condenser note) through the deployed tool itself — a product action on live data, never a test.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` (31 files / 230 tests) / `npm run build` all pass (pre-PR gate, 2026-07-06)
- [x] `grep -rn "8 tools\|15 tools\|8 trades-spine" docs/ Box_Setup_Stuff/` returns nothing; stale-contract sweep (`captureId` resume, "already saved") also clean; `bootstrap-box.sh` §0c wire updated in the same change (box-setup-stuff-sync rule)

### Live verification (agent-executable)
- Prerequisites: local stack.
- [x] Fresh `npx supabase db reset` replay passed all 5 steps 2026-07-06: 12 migrations applied, schema + unique index + append-only trigger verified on pristine DB, full record→retract→folded-context flow with psql row proof (counts 1|1|1), full suite green on the fresh stack.

### Manual verification
- [ ] Read the rewritten §0c prompt block and §5 contract as a human — do they read correctly to a non-engineer operator? (judgment call on wording)

---
*Pause after Phase 4 for the manual doc-read check.*
