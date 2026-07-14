---
date: 2026-07-14
task: Feature C+D Phase 1 — confirm-gated, provenance-linked standing facts on customer/job rows (new spine tool)
research: thoughts/shared/research/2026-07-13-feature-cd-l3-write-surface-and-agent-memory.md
status: implemented — post-deploy live verification pending (Phase 4 live + manual items)
---

## Overview

Complete the L3 write surface: a new two-step spine tool, `record_standing_fact`, upserting a
durable key/value fact ("prefers email", "gate code 4321") onto a **customer or job** row's
existing `attributes` JSONB column, each fact wrapped with the L1 capture id that evidences it.
Read paths fold facts whose evidence capture was retracted; the synthesis serializer unwraps
facts (with capture ids) so briefings can cite them. No DB migration. This is Phase 1 of the C+D
build-schedule entry; Phase 2 (agent memory) is planned separately.

## Decisions

- **Scope: Phase 1 only** — user choice 2026-07-13. Phase 2 gets its own RPI plan after this lands.
- **Entry point: new spine tool** (`record_standing_fact`), not an extension of `record_field_note` —
  user choice. Own stage→confirm cycle via a new `ReviewKind`; the note flow stays untouched.
- **Provenance: wrapped values** — user choice. Each fact stored as
  `{value, sourceCaptureId, recordedAt}` under its key inside the existing `attributes` JSONB.
  No migration; per-key evidence enables the retraction fold.
- **Retraction: fact disappears** — user choice. Default reads hide a fact whose
  `sourceCaptureId` is retracted (mirrors visit-attribute folding). Also the **only removal
  path** — no delete tool; fix a wrong fact by re-recording the key or retracting its evidence.
- **Evidence is always a fresh L1 capture** appended at commit (raw_text = the person's verbatim
  `sourceText`, else `Standing fact: <key> = <value>`), channel `technician_note` (no enum
  migration; `metadata.standingFactKey` marks it), stamped with `customer_id` (+ `job_id` for job
  facts) so it appears in existing capture lists and retraction lookups. Citing an
  already-existing capture: out of scope v1.
- **One fact per call** — one staged action, one preview, one confirmation (recorded UX rule);
  batch = repeat calls. Value = JSON scalar (string ≤ 500 | number | boolean); keys normalize to
  snake_case (`[a-z0-9_]`, ≤ 64).
- **Concurrency: CAS read-modify-write on `updated_at`** (the `updateJobStatus` precedent) with a
  small retry loop — supabase-js `update` replaces whole JSONB, so unguarded RMW could drop a
  concurrent writer's key. No Postgres RPC.
- **Idempotency: commit-first, consume-second** with L1 externalId `fact:<confirmId>` (the
  `record_field_note` recipe); the merge is deterministic (recordedAt = the capture's
  `captured_at`), so a crash-retry converges.
- **Tier: technician-writable** (like notes); no per-key sensitivity in v1 — customer/job facts
  are the shared record (division-of-information rule). Tier-aware rows are Phase 2.
- **Tool placement: base `TOOLS`** (technician-visible) → doorman runbook count 12 → 13; doc updated.

## Plain-language walkthrough

**Phase 1 — the database helpers.** Two new functions safely write one fact into a customer's or
job's flexible `attributes` field: read the row, add the key, write back only if nobody else
changed the row in between (checked via its last-modified timestamp; retried if beaten). Plus
small helpers to *unwrap* facts (plain value out of the bundle) and *fold* (hide facts whose
evidence was retracted). Verified by new automated tests against the local database.

**Phase 2 — the tool the agents call.** `record_standing_fact` follows the exact two-step pattern
every risky action already uses: the first call stages the fact and returns a preview ("On
Henderson (customer): prefers_contact = email — replaces 'phone'"); nothing is written. On the
person's yes, a second call commits: evidence row into the permanent L1 log, then the fact onto
the customer/job. A crash between those steps self-heals on retry.

```
person: "remember: Hendersons prefer email"
agent ──record_standing_fact(customerId,key,value)──► spine: stages, returns preview
person: "yes"
agent ──record_standing_fact(confirmId)─────────────► spine: L1 evidence capture
                                                          └─► fact onto customer row
future briefings ◄── "prefers email" cited to that capture
```

**Phase 3 — reading it back everywhere.** Briefings, Q&A, and the customer-context tool learn to
(a) hide facts whose evidence capture was retracted and (b) show the model plain values with the
capture id alongside, so a briefing claim like "customer prefers email" carries a real citation.

**Phase 4 — docs and shipping.** Update every doc that counts or names the tool surface, the
box-side agent allowlist, the build-schedule entry, then the normal PR → deploy → live read-back
cycle. New MCP tools need a real Render deploy (tool lists are cached per process) **and** the
sandbox agent's pinned allowlist updated + restarted, or the agent can't call the new tool.

## Secrets & env preflight

- **Phases 1–3:** none new. Local Supabase stack (`.env.test`, `already required`). No model key —
  this tool makes **no** model calls (extraction isn't part of this flow).
- **Phase 4 (live verification):** deployed Render service + a technician badge/agent on
  trades-box-1 (existing); `supabase-test` MCP for pilot read-backs (`already required`, read-only).

## Phase 1: DB layer — wrapped-fact write + fold/unwrap helpers

### What this phase does
Adds the missing L2 update primitive and the pure helpers the read side will use. No behavior
change for existing callers.

### Changes required

**`src/db/standingFacts.ts`** (new)
- `export interface StandingFactBundle { value: string | number | boolean; sourceCaptureId: string; recordedAt: string }`
- `isFactBundle(v: Json)` — shape guard (object with exactly those keys).
- `unwrapAttributes(attrs: Json): Record<string, Json>` — bundles → plain values; non-bundle
  values pass through untouched (visit attributes stay plain).
- `foldRetractedFacts(attrs: Json, retractedIds: ReadonlySet<string>): Json` — drops keys whose
  bundle's `sourceCaptureId` is in the set; non-bundle values untouched.
- `factSourceIds(attrs: Json): string[]` — the bundle capture ids in an attributes object
  (readers use it to know which retractions to look up).

**`src/db/customers.ts`**, **`src/db/jobs.ts`**
- Add `setCustomerAttribute(id: string, key: string, bundle: Json): Promise<Customer>` (and the
  job twin). Structure for testability (review finding): an exported single-attempt function that
  takes the pre-read row — `trySetCustomerAttribute(row: Customer, key, bundle): Promise<Customer | null>`
  — doing `merged = { ...(row.attributes as object), [key]: bundle }` →
  `.update({ attributes: merged }).eq('id', row.id).eq('updated_at', row.updated_at).select().maybeSingle()`
  (null on CAS miss); `setCustomerAttribute` wraps it in a read → attempt loop (max 3), throwing
  `changed concurrently` when exhausted. Tests can pass a deliberately stale row to force the CAS
  miss. Tenant guarding stays the caller's job (matches module convention).

**`src/db/index.ts`** — export the new module + functions.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (local stack — 42 files, 404 passed / 1 skipped)
- [x] New `src/db/standingFacts.test.ts`: unwrap/fold/factSourceIds on wrapped, plain, and mixed
      attribute objects; fold never drops plain values
- [x] New integration test (local stack): `setCustomerAttribute` merges without clobbering an
      existing unrelated key; CAS path exercised directly — `trySetCustomerAttribute` with a
      deliberately stale row returns null (no write lands), and the wrapping retry loop then
      succeeds, with both keys surviving

### Live verification (agent-executable)
- [ ] n/a — DB-layer only; the codified tests are the sufficient check.

### Manual verification
- [ ] none

---
*No manual items — continue to Phase 2 after automated checks pass.*

## Phase 2: the `record_standing_fact` spine tool

### What this phase does
The agent-facing write path: stage → preview → confirm → commit, per the `record_field_note`/`retract_capture` recipe.

### Changes required

**`src/db/reviewItems.ts`**
- Add `'pending_standing_fact'` to the `ReviewKind` union (`:10-18`). Code-only; no migration.

**`src/mcp/server.ts`**
- `TOOLS`: add `record_standing_fact` after `retract_capture` (`:326`). Description: two-step;
  first call with `customerId` **or** `jobId`, `key`, `value`, optional `sourceText` (the
  person's exact words) → nothing recorded, returns `needs_confirmation` + preview; show the
  person exactly the preview (incl. previous value when overwriting); on explicit yes call again
  with ONLY `confirmId`. A wrong fact: re-record the key or retract the evidence capture. One
  confirmation, no permanence lecture.
- `inputSchema` properties: `customerId`, `jobId`, `key`, `value` (`["string","number","boolean"]`),
  `sourceText`, `confirmId`; `required: []`.
- Dispatch case (mirror `record_field_note`'s structure):
  - **Stage** (no `confirmId`): exactly one of customerId/jobId else throw; normalize key
    (`key.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')`, reject empty/`>64`);
    value must be scalar (string ≤ 500). Tenant-guard the target (`getCustomer`/`getJob` +
    `tenant_id` check → `'… not found'`); for a job also fetch its customer (preview + later
    `customer_id` stamp). Supersede the caller's open `pending_standing_fact` token, then
    `upsertOpenReviewItem` with detail
    `{ target, targetId, customerId, targetName, key, value, sourceText, previousValue, stagedAt }`
    (`previousValue` = unwrapped current `attributes[key]`). **Echo the item's detail**
    (racing-stage rule): `{status:'needs_confirmation', confirmId: item.id, preview:{target, targetName, key, value, previousValue}, note}`.
  - **Confirm** (`confirmId` alone): guarded `getOpenReviewItem(confirmId, tenantId, {kind, subjectRef})`;
    15-min expiry — but first check `getRawCaptureByExternalId(tenantId, 'fact:'+item.id)`; if
    landed, re-run the (idempotent) merge and report success instead of expiring. Malformed
    detail ⇒ restage error. Re-verify target row + tenant. **Commit-first:**
    (1) `appendRawCapture({ tenantId, channel:'technician_note', technicianRef: subjectRef,
    rawText: sourceText ?? 'Standing fact: <key> = <value>', externalId: 'fact:'+item.id,
    customerId, jobId (job facts), metadata:{ standingFactKey: key, target, stagedConfirmId: item.id } })`
    — on unique violation, fetch the existing row by externalId (retry path);
    (2) bundle `= { value, sourceCaptureId: capture.id, recordedAt: capture.captured_at }` →
    `setCustomerAttribute`/`setJobAttribute`; (3) consume token (advisory). On commit error:
    throw `fact NOT recorded: … retry with the SAME confirmId (do not restage)`.
    Return `{status:'recorded', captureId, target, targetId, key}`.
- `resolve_review`: add the live-token guard branch — `pending_standing_fact` + `resolved` ⇒ error
  "confirm it via record_standing_fact, or dismiss it to cancel" (after the `pending_retraction`
  branch, `:1826-1831`).

**`src/mcp/server.test.ts`** (review finding — these assertions go red otherwise)
- Update the four tool-count assertions: `:138` and `:1477` `toHaveLength(12)` → 13; `:1200` and
  `:1600` `toHaveLength(20)` → 21. Add `record_standing_fact` to the expected-name list at
  `:123-137`.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (42 files, 410 passed / 1 skipped)
- [x] New tests in `src/mcp/server.test.ts` (existing harness/stubs): stage returns preview echoing
      item detail incl. `previousValue` on overwrite; both/neither target args throw; forged
      customerId (cross-tenant) throws `customer not found`; bad key/value shapes throw; expired
      token dismisses (status read-back + dead-token retry, per phase review); **confirm** writes
      the L1 row with `external_id = fact:<confirmId>` + both
      id stamps for a job fact, and the wrapped bundle lands on the row; **crash-heal** converges:
      confirm once, re-open the consumed token via direct SQL (the `server.test.ts:284-291`
      precedent — a plain second confirm correctly gets 'confirmation not found'), confirm again →
      one capture, same bundle; `resolve_review(resolved)` on the token errors; technician
      (non-manager) badge exercises every flow (the main test client's identity is tech-mcp)

### Live verification (agent-executable)
- [ ] n/a until deploy (Phase 4) — the vitest suite drives the full stage→confirm cycle against
      the local DB, which is the same check.

### Manual verification
- [ ] none

---
*No manual items — continue to Phase 3.*

## Phase 3: read-side fold + citeable serialization

### What this phase does
Makes the retraction decision real (facts disappear) and standing facts citeable in briefings.

### Changes required

**`src/db/context.ts`**
- In the `!opts.includeRetracted` block (`:56-67`): the retraction lookup currently covers only
  `recentCaptures` ids — extend the `findRetractionsFor` call's input to
  `[...recentCaptures.map(c => c.id), ...factSourceIds(customer?.attributes), ...jobs.flatMap(j => factSourceIds(j.attributes))]`
  (deduped), then fold: `customer = { ...customer, attributes: foldRetractedFacts(customer.attributes, retractedIds) }`
  and likewise per job. Visits path unchanged.

**`src/synthesis/grounding.ts`**
- Customer/job lines (`:27`, `:35`): render bundle values as `key=value (capture <sourceCaptureId>)`,
  plain values as today — so the model can cite standing facts (`validateCitations` accepts any id
  in `recentCaptures`; evidence captures are stamped `customer_id`, so they're in that list).
  Visit line (`:46`) unchanged.

**`src/mcp/server.ts`** — `get_job` case (`:865-871`) and `find_customer` case (`:850-854`)
- `get_job`: after the tenant guard, `const ids = factSourceIds(job.attributes)`; if non-empty,
  `findRetractionsFor(ids)` → return the job with `foldRetractedFacts` applied.
- `find_customer` (review finding — otherwise a retracted fact stays visible in every name
  lookup, breaking the "fold is the removal path" decision): collect `factSourceIds` across all
  returned rows → one `findRetractionsFor` call → `foldRetractedFacts` per row before returning.
  Keeps every raw-row tool consistent with the folded context view.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (42 files, 413 passed / 1 skipped)
- [x] New tests: record a fact (Phase-2 flow) → retract its evidence capture via `retract_capture`
      → `get_customer_context`, `get_job`, and `find_customer` no longer show the key;
      `includeRetracted` audit view via `list_recent_captures` still shows the evidence capture
      labeled retracted
- [x] Grounding test: serialized prompt shows `prefers_contact="email" (capture <id>)` for a wrapped
      fact and leaves plain visit attributes untouched; overwritten fact folds only when the
      **current** bundle's capture is retracted (old capture's retraction does not hide the new value)
- [x] Phase review fix: the stage preview's `previousValue` now folds retracted facts first, so a
      retracted value is never resurfaced as "replaces X" (+ regression test)

### Live verification (agent-executable)
- [ ] n/a — codified (synthesis tests use injected stub briefers).

### Manual verification
- [ ] none

---
*No manual items — continue to Phase 4.*

## Phase 4: docs, build gate, deploy + pilot read-back

### What this phase does
Documentation consistency, the standing verification gates, and the ship checklist.

### Changes required

**`docs/doorman-runbook.md`** — "12 tools" at `:243`, `:309`, `:322`, `:369` → 13, add
`record_standing_fact` to the `:322-326` tool list, and the manager-badge count "20" in the same
block → 21 (review finding — the operator verification would read a healthy deploy as failure).

**`docs/nemoclaw-tech-agent.md`** — `:86-96` enumerates the 12-tool technician / 20-tool manager
surfaces by name: add the tool, bump both counts (review finding).

**`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`** — `:24` (tool enumeration + 20-count),
`:429`, `:989` ("200 + 12 tools" definition-of-done checks): update counts + name (review
finding). Same change as the nemoclaw doc per the recorded Box-Setup-Stuff sync rule.

**trades-box-1 (operational step, not a repo file)** — the sandbox-side OpenClaw technician
profile pins a tool **allowlist**; deployed sandboxes keep the old pinned list until the profile
is updated and the agent restarted (recorded `get_schedule`-rollout gotcha,
`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:24` — the doorman-side tools/list check does NOT
catch this). Add `record_standing_fact` to the profile allowlist and restart the pilot agent
**before** the live check below.

**`thoughts/shared/build-schedule.md`** — C+D entry (`:12-104`): mark Phase 1 planned/in-flight
with a pointer to this plan; Phase 2 stays parked with its triggers.
**`docs/Three-Layer-Context-Spine-Overview.md`** — one-line L3 note (§ ~line 45): customer/job
standing attributes are written via `record_standing_fact`, wrapped with their evidence capture id.

### Automated verification
- [x] `npm run typecheck && npm run lint && npm test && npm run build` all pass (pre-PR gate —
      42 files, 418 passed / 1 skipped after the final-review fixes: guarded drift/replay-safe
      commit, orphan-capture prevention, sourceText/hasOwn/non-object-attributes hardening,
      validateCitations widening)
- [x] PR opened (standing rule: no direct push to main)

### Live verification (agent-executable)
- Prerequisites: PR merged + **real Render deploy** (not "Redeploy", which reuses the old commit —
  recorded gotcha; MCP tool lists are cached per process); the box-side profile-allowlist update +
  agent restart above; `supabase-test` MCP (read-only); a technician badge/agent on trades-box-1.
- [ ] Post-deploy, via the agent: stage + confirm one fact on a **demo** customer; then read back
      cross-channel via `supabase-test` `execute_sql` (SELECT the customer's `attributes` and the
      `raw_captures` row with `external_id like 'fact:%'`) — evidence: the wrapped bundle and its
      capture row. Then retract it and confirm `get_customer_context` no longer shows the key.

### Manual verification
- [ ] Judge the Telegram-side UX of the preview + single confirmation (tone: one confirmation, no
      permanence lecturing) in a real chat with the pilot agent.

---
*Pause after this phase: its Manual verification list is non-empty.*
