---
date: 2026-07-01
task: Per-person Composio pairing — composite user_id, person attribution on inbound captures, L1 technician_ref column
research: thoughts/shared/research/2026-07-01-composio-identity-pairing-model.md
status: complete
---

## Overview

Implements the four decisions from the identity research: (1) Composio `user_id` becomes the
composite `"<tenantUuid>:<technicianRef>"` (Option A — one connected account + one trigger per
person); (2) inbound captures are attributed to the person, not the channel (`technicianRef` =
the person's ref, falling back to `connector:<toolkit>` for legacy bare-uuid `user_id`s);
(3) `raw_captures` gains a real `technician_ref` column (nullable — L1 is append-only, so
existing rows cannot be backfilled); (4) per-person capability control stays at the gateway
(doorman badges) — Composio's Execution Allowlist is only the global ceiling; no Composio-side
per-person config is attempted.

Known considerations (documented, not blocking):
- Gmail API `message_id`s are mailbox-local, so two employees receiving the same thread should
  produce distinct `external_id`s; the per-tenant dedup index is unchanged. Phase 4's live check
  observes this.
- The orphan-heal path reuses an existing L1 row; its `technician_ref` is whatever the first
  delivery wrote (append-only — cannot be corrected). Acceptable: both deliveries carry the same
  composite `user_id`, so the value is identical in practice.
- `visits.technician_name` already receives `technicianRef` (`recordFieldNote.ts:190`) — person
  attribution on visits falls out of Phase 2 with no schema change.
- Prod migration: test project only in this plan; applying to prod is a deploy step (prod is
  read-only from this repo's tooling).

## Phase 1: L1 person attribution — `raw_captures.technician_ref`

### What this phase does
Adds a nullable `technician_ref text` column to `raw_captures`, threads it through the typed DB
layer and the write-path, so every NEW capture (MCP note or inbound connector) permanently records
who it came from. No behavior change for readers; existing rows stay `NULL`.

### Changes required

**`supabase/migrations/20260701000000_raw_capture_technician_ref.sql`** (new; use a real
timestamp for the prefix)
```sql
-- Person attribution for L1 captures. Nullable: raw_captures is append-only (no
-- UPDATE path), so pre-existing rows cannot be backfilled and stay NULL.
alter table raw_captures add column technician_ref text;
```
Apply to the TEST project (`mcp__supabase-test__apply_migration`), never prod.

**`src/db/database.types.ts`**
- Regenerate via `mcp__supabase-test__generate_typescript_types` after applying the migration
  (adds `technician_ref: string | null` to `raw_captures` Row/Insert/Update).

**`src/db/rawCaptures.ts`**
- `AppendRawCaptureInput` (line 7): add `technicianRef?: string | null;` with a comment noting
  it is the person (badge ref) or `connector:<toolkit>` for unattributed connector captures.
- `appendRawCapture` insert object (line 27): add `technician_ref: input.technicianRef ?? null,`.

**`src/writePath/recordFieldNote.ts`**
- In the fresh-insert branch (line 101), pass `technicianRef` into `appendRawCapture`:
  ```ts
  landed = await appendRawCapture({
    tenantId,
    channel,
    technicianRef,
    ...
  });
  ```
  (`technicianRef` is already destructured at line 65.) The resume (`input.captureId`) and
  orphan-heal branches reload existing rows — no change.

**`src/synthesis/fixtures.ts`**
- `capture()` (lines 55-69) builds a complete `RawCapture` object literal; the regenerated Row
  type makes `technician_ref` a required (nullable) property. Add `technician_ref: null,` to the
  literal or `tsc --noEmit` fails. (Consumers: `grounding.test.ts:13-14`, `sampleContext()`.)

**`scripts/seed.mjs`**
- Add `technicianRef` to the four `appendRawCapture` calls (lines 69/102/125/168) so the seeded
  playground demonstrates the column — e.g. `'tech-jane'` for the voice note at line 102 (its
  visit already says `technicianName: 'tech-jane'` at line 114); `'connector:gmail'`-style or a
  person ref for the others as fits each capture. Optional field — no compile risk.

**`src/writePath/recordFieldNote.test.ts`**
- Extend an existing matched-note test (e.g. the `'tech-jane'` case at line ~44): read back
  `technician_ref` from the inserted `raw_captures` row via the existing `pg` client and assert
  it equals `'tech-jane'`.

### Automated verification
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (78/78, 17 files)
- [x] New assertion: raw_captures row carries `technician_ref = 'tech-jane'` (direct pg read-back)

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP server (already configured).
- [x] `mcp__supabase-test__execute_sql`: returned `technician_ref | YES | text`. Note: migration
      file renamed to `20260701231454_…` to match the apply-time ledger version (review finding).

### Manual verification
- (none)

---
*No manual checks — continue to Phase 2 after gates pass.*

## Phase 2: Composite `user_id` parsing + person attribution in the webhook

### What this phase does
Teaches `handleInboundWebhook` to parse `metadata.user_id` as either a bare tenant uuid (legacy —
current live trigger) or the composite `"<tenantUuid>:<technicianRef>"`. Composite → captures and
visits are attributed to the person; bare → the existing `connector:<toolkit>` fallback. Malformed
composites are rejected as `bad_payload` (deterministic, no retry).

### Changes required

**`src/inbound/webhook.ts`**
- After extracting `userId` (line 133) and the existing `if (!userId || …)` guard (line 136),
  replace the direct `const tenantId = userId;` (line 148) with a parse:
  ```ts
  // Composio user_id is either a bare tenant uuid (legacy: whole-business pairing)
  // or "<tenantUuid>:<technicianRef>" (per-person pairing, one connected account
  // per person). Split on the FIRST colon; the ref may itself contain colons.
  const sep = userId.indexOf(':');
  const tenantId = sep === -1 ? userId : userId.slice(0, sep);
  const personRef = sep === -1 ? undefined : userId.slice(sep + 1);
  if (sep !== -1 && (!tenantId || !personRef)) return { status: 'bad_payload' };
  ```
- At the `recordFieldNote` call (line 184):
  `technicianRef: personRef ?? \`connector:\${toolkit.toLowerCase()}\`,`
- `tenantExists(tenantId)` (line 158) and `recordDrop({ tenantId, … })` (line 171) are unchanged —
  they receive the split tenant part. Drops stay tenant-keyed (content-free receipt; no person
  column on `dropped_audit`).
- Update the envelope comment (lines 95-98): "The tenant is metadata.user_id" → user_id is bare
  tenant uuid or `"<tenant>:<technicianRef>"`, split on first colon.

**`src/db/tenants.ts`**
- Fix the header comment (lines 3-4): the webhook no longer uses `user_id` "verbatim as
  tenant_id" — it validates the tenant part of the (possibly composite) user_id.

**`src/inbound/webhook.test.ts`**
- New tests (reuse `body()` / `sign()` / `recorder()` helpers):
  1. `user_id: 'tenant-uuid-1:alice'` → `ingested`; `rec.calls[0]` has
     `tenantId: 'tenant-uuid-1'`, `technicianRef: 'alice'`.
  2. Composite id: `tenantExists` stub records its argument; assert it was called with
     `'tenant-uuid-1'` (not the composite).
  3. Bare `user_id: 'tenant-uuid-1'` (existing default body) still yields
     `technicianRef: 'connector:gmail'` (already asserted at line 131 — keep green).
  4. `user_id: 'tenant-uuid-1:'` and `user_id: ':alice'` → `bad_payload`, recordFieldNote not called.
  5. Ref containing a colon: `'tenant-uuid-1:crew:alice'` → `technicianRef: 'crew:alice'`.
  6. Non-work composite → `skipped_non_work`; drop receipt has `tenantId: 'tenant-uuid-1'`.

### Automated verification
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (82/82; legacy bare-uuid test untouched and green)
- [x] New tests 1–6 above pass (1+2 folded into one recorded-stub test)

### Live verification (agent-executable)
- (covered end-to-end in Phase 4; nothing live is needed for the pure parsing change)

### Manual verification
- (none)

---
*No manual checks — continue to Phase 3.*

## Phase 3: Onboarding tooling + design docs

### What this phase does
Parameterizes the dev pairing scripts for per-person `user_id`s, documents `COMPOSIO_API_KEY`,
and updates §7 of the tech-agent doc so the recorded invariant matches the implemented identity
model (composite user_id; gateway-side capability control).

### Changes required

**`scripts/composio-reconnect.mjs`**
- Replace the hardcoded `TENANT` (line 9) default with a `user=<id>` argv override (same pattern
  as `composio-trigger.mjs:14-15`), keeping the current test-tenant uuid as the default. The
  value passed to `connectedAccounts.link()` and `list({ userIds })` may now be composite.

**`scripts/composio-trigger.mjs`**
- No functional change (already accepts `user=`). Update the header comment (lines 9-10) to note
  per-person pairing passes `user=<tenantUuid>:<technicianRef>`.

**`.env.example`**
- Add under the Composio block (after line 51): `COMPOSIO_API_KEY=` with a comment — dev-scripts
  only (`scripts/composio-*.mjs`); control-plane secret, never in a sandbox.

**`docs/nemoclaw-tech-agent.md`** (§7 Multi-tenant model, lines 129-140)
- Revise the first bullet: one business = one tenant uuid, but Composio `user_id` is now
  **per person**: `"<tenantUuid>:<technicianRef>"`; one connected account + one trigger per
  person; the webhook splits on the first colon; bare-uuid `user_id`s remain valid
  (attributed `connector:<toolkit>`). Keep "never `user_id="default"`".
- Add one bullet under "Secret custody + gateway wiring": per-person *capability* control lives
  at the gateway (doorman badge → `{tenantId, technicianRef}`; future per-tier tool allowlist) —
  Composio's per-auth-config Execution Allowlist is shared by all tenants/people and is only the
  global ceiling (decision 4, 2026-07-01).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (82/82)
- [x] Reconnect script without `COMPOSIO_API_KEY` fails cleanly before any network call
      (note: `@composio/core` devDependency is not installed locally — Phase 4 needs `npm install`).
      Review fix applied: `user=` parsing uses `||` so a bare/empty value falls back to the default
      instead of feeding the delete loop an empty filter.

### Live verification (agent-executable)
- (none — script behavior against live Composio is Phase 4)

### Manual verification
- [x] Read the §7 diff: the invariant text matches what Phase 2 implemented (no doc/code drift).
      (User approved §7 on 2026-07-01.)

---
*Pause after this phase: manual doc-review is listed.*

## Phase 4: Live E2E — one person paired, end to end

### What this phase does
Proves the composite pairing against real Composio + the test spine: connect a Gmail account
under a composite `user_id`, create its trigger, send a work-shaped email, and verify the L1 row
lands with the split tenant + person attribution. Also opportunistically answers research open
question #2 (does the envelope carry a `connected_account_id`?) from the captured payload.

### Changes required
- None (verification only). Optionally save the captured envelope (INBOUND_DEBUG output) under
  `thoughts/shared/research/` as an addendum.

### Automated verification
- [x] All CLAUDE.md gates still pass (`typecheck`, `lint`, `test` 84/84, `build` — re-run 2026-07-02 after the E2E)

### Live verification (agent-executable)
- Prerequisites: **`COMPOSIO_API_KEY` in `.env`** (user is obtaining); the deployed webhook
  endpoint (or a local server + tunnel) with `COMPOSIO_WEBHOOK_SECRET` set; `supabase-test` MCP;
  a throwaway/test Gmail account to connect; ability to send an email to it.
- [x] Seed the test spine first (`npm run seed`) so `matchIdentity` has a customer to resolve.
- [x] `node -r dotenv/config scripts/composio-reconnect.mjs user=<testTenantUuid>:e2e-alice` →
      OAuth approved → `--wait` shows the connection ACTIVE under the composite user_id.
      (Both scripts need `-r dotenv/config` — neither loads `.env` itself.)
      (Run expanded to TWO people: `e2e-alice` + `e2e-bob`, distinct throwaway mailboxes.)
- [x] `node -r dotenv/config scripts/composio-trigger.mjs user=<testTenantUuid>:e2e-alice --create`
      succeeds. (Both refs; triggers `ti_DmiUZFATaABC` / `ti_UFUWZS2tZfRI`.)
- [x] Send a work-shaped email whose body contains a seeded customer's unique phone or address
      (so extract → match resolves and a visit is created — an unmatched work email is still
      `ingested` but L1-only); within the poll interval, webhook returns `ingested`.
- [x] `mcp__supabase-test__execute_sql`: the new `raw_captures` row has
      `tenant_id = <testTenantUuid>`, `technician_ref = 'e2e-alice'`, `channel = 'email'`,
      non-null `external_id`; the linked visit has `technician_name = 'e2e-alice'`.
- [ ] Capture one raw envelope with `INBOUND_DEBUG=1`; record whether `metadata` includes a
      connected-account identifier (closes research open question #2).
      (NOT captured — `INBOUND_DEBUG` was not enabled on the deployed service during the run;
      open question #2 stays open.)
- [x] Cleanup: delete the test trigger + connected account; tests' truncate handles spine rows.
      (Both triggers + both E2E accounts deleted 2026-07-02; legacy June pairing
      `ca_HfiWAMe4IZkZ` left for the user to decide.)

### Manual verification
- [x] Approve the OAuth consent screen in a browser (inherently human; confirm it shows the
      Composio-managed app, not an unverified-app warning). (User approved both consents
      2026-07-02; no warning reported.)

---
*Pause after this phase for the human OAuth step and final review.*

### Phase 4 run notes (2026-07-02)

Run expanded from one person to two (`e2e-alice` = one throwaway Gmail, `e2e-bob` = another),
plus a CC test. Evidence (test-DB read-back, tenant `82bbc6f8-…`):

- 4 L1 captures, one per (mailbox × email): alice×2, bob×2. All `tenant_id` correct, all
  `technician_ref` matching the mailbox's composite ref — cross-mailbox isolation holds.
- The email CC'd to both mailboxes produced **two** captures with **distinct** `external_id`s
  (Gmail message ids are mailbox-local), each attributed to its own person — as designed.
- Every capture's linked visit has `technician_name` = the person's ref; identity match resolved
  all three seeded customers (Maria / Tom / Acme) from phone/address in the bodies.
- 0 drop receipts (all four classified as work). L1 dedup held: no duplicate captures despite
  Composio delivery retries.
- Known pre-existing issue observed (NOT a regression): 3 of 4 captures got a duplicate visit
  ~5–6s apart — Composio retries (~5s cadence) while the handler is still awaiting the two
  Sonnet calls race the orphan-heal path into a second extract→L2 run. Documented in
  `thoughts/shared/research/2026-06-29-async-webhook-ingestion.md`; fix belongs to the async
  ingestion work, not this plan.
- Environment fixes needed to get deliveries flowing (all config, no code): the Composio
  webhook subscription (`ws_mfL3RD8klzYo`, SDK-managed via `triggers.setWebhookSubscription()`,
  no dashboard page) still pointed at the dead June dev tunnel → repointed to
  `https://tradesdatabase.onrender.com/inbound/composio`; `COMPOSIO_WEBHOOK_SECRET` was unset on
  Render → set (raw string, no `whsec_` prefix); Render was running pre-merge code → fixed by
  merging PR #7 + redeploy, confirmed by signed probes (composite fake-uuid: 503→422).
