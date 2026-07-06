---
date: 2026-07-01
branch: main
commit: a82ec44
topic: Repo-wide debt audit — rule violations and dead weight across 8 categories
---

## Summary

Read-only audit of the working tree (including uncommitted changes) against the repo's own rules:
DB access confined to `src/db/`, classify-before-L1 on append-only `raw_captures`, dead code,
cross-module duplication, test hygiene/prod safety, uncited external-service claims, shipped
TODO/workaround markers, and ESM import hygiene. Six parallel read-only agents each swept one
category cluster; every reported finding was confirmed by reading the surrounding code, and the
top-severity findings were independently re-verified against the exact lines before inclusion.

**Result: 0 breaks-an-invariant, 3 correctness-risk, 10 hygiene.** Three categories are entirely
clean: post-insert filtering of `raw_captures` (category 2 — the classify gate is strictly
pre-insert on both paths), TODO/FIXME/HACK markers (category 7 — zero grep hits repo-wide), and
ESM import hygiene (category 8 — all 118 relative imports carry explicit `.js` extensions). This
is consistent with the RPI workflow doing its job; the list below is not padded.

## Scope and method

- **Audited:** `src/**/*.ts` (26 non-test + 17 test files), `scripts/*.mjs` (5),
  `Box Setup Stuff/doorman.mjs`, `supabase/migrations/*.sql` (6, incl. uncommitted
  `20260701231454_raw_capture_technician_ref.sql`), `docs/`, `CLAUDE.md`, `README.md`,
  `Three-Layer-Context-Spine-Overview.md`, and the load-bearing `thoughts/` artifacts
  (composio research/plans, 2026-06-30 phone-call docs, 2026-07-01 identity docs).
- **Excluded:** `dist/` (gitignored, 0 tracked files — confirmed via `git ls-files dist`),
  `node_modules/`, point-in-time `thoughts/` narrative not backing current code.
- Six agents: (1+2) DB boundary + append-only gate, (3) dead code, (4) duplication,
  (5) test hygiene, (6) uncited claims, (7+8) markers + ESM. Instructions required reading
  surrounding code before reporting and treating empty categories as valid answers.

## Findings — ranked by severity

### Breaks-an-invariant

None found.

### Correctness-risk

**CR-1 — Shipped per-person dedup relies on an uncited, not-yet-live-verified Gmail claim (cat. 6)**
- `thoughts/shared/plans/2026-07-01-per-person-composio-identity.md:20-22` states: "Gmail API
  `message_id`s are mailbox-local, so two employees receiving the same thread should produce
  distinct `external_id`s; the per-tenant dedup index is unchanged." No citation; the plan defers
  to "Phase 4's live check observes this," and Phase 4 has not run.
- Code that depends on it is already live: the composite `user_id` split at
  `src/inbound/webhook.ts:150-156` (verified), with the dedup index
  `uq_raw_captures_external_id (tenant_id, external_id)` deliberately left per-tenant.
- Failure mode if the claim is wrong: two employees of one tenant receiving the same thread
  collide on `external_id`; the second delivery returns `status:'duplicate'` and that person's
  copy — including its `technician_ref` attribution — is silently and permanently dropped
  (L1 is append-only; no recovery path).

**CR-2 — `npm test` truncates whatever `.env` points at; the test path lacks the ref guard `seed.mjs` has (cats. 1+5)**
- `src/test.setup.ts:1-3` is only `import 'dotenv/config'` (verified — whole file). Five test
  files then run `TRUNCATE ... raw_captures ... cascade` over a direct `pg.Client` in `afterAll`:
  `src/writePath/recordFieldNote.test.ts:23`, `src/mcp/server.test.ts:42`,
  `src/schedule/sheetSync.test.ts:19`, `src/email/ingest.test.ts:24`,
  `src/writePath/identityMatch.test.ts:30`. (TRUNCATE is statement-level, so the row-level
  append-only trigger does not fire.)
- Contrast: `scripts/seed.mjs:32-42` hard-refuses unless BOTH `DATABASE_URL` and `SUPABASE_URL`
  contain the test ref `daqapdlkgxfrhquacprv` — the repo already judged this failure mode worth a
  guard for the exact same destructive operation.
- Mitigations that exist today: the prod project ref appears nowhere in the repo; `.env.example:1-5`
  says test-only; prod access is normally via the read-only MCP server. The gap is
  defense-in-depth only — a human mis-populating `.env` with prod credentials would let `npm test`
  irreversibly truncate the prod spine tables with the service-role key. (Two agents converged on
  this finding independently; one rated it hygiene on "no rule currently broken" grounds — ranked
  correctness-risk here because the blast radius is total and the fix is a one-line assertion in
  `test.setup.ts`.)

**CR-3 — Latent conflict: `ON DELETE SET NULL` FKs on `raw_captures` vs the append-only trigger (cat. 2, adjacent)**
- `supabase/migrations/20260620005307_context_spine.sql:95-97` declares
  `customer_id/job_id/visit_id references ... on delete set null`, but the trigger at lines
  117-119 (`before update or delete on raw_captures`) raises on every row UPDATE — and in
  Postgres a cascading SET NULL executes as a row UPDATE. Verified both sites.
- Consequence: deleting any customer/job/visit that a capture is stamped with will fail with
  "raw_captures is append-only" instead of nulling the pointer. Nothing breaks today (the write
  path inserts captures with those FKs null; only seed data stamps them, and the db layer exposes
  no delete for these entities), but a future delete feature trips on this schema tension.

### Hygiene

**H-1 — Anthropic forced-tool-call scaffold copy-pasted 4×, with the model id hardcoded in each (cat. 4)**
- `src/writePath/extract.ts:73-91`, `src/email/classify.ts:39-59`,
  `src/synthesis/answerQuestion.ts:49-70`, `src/synthesis/briefCustomer.ts:57-81` — identical
  ~18-line scaffold (env check with identical error string, client construction,
  `model: 'claude-sonnet-4-6'` hardcoded, forced `tool_choice`, identical tool_use-block
  find-predicate, identical no-block throw). Only system prompt/tool schema differ (intended).
  A model bump must touch four files or they silently diverge; `max_tokens` already differs
  (256 vs 1024 — appears intentional). Sub-item: the `citations` JSON-schema block and the
  `validateCitations` post-step are near-verbatim duplicated between `answerQuestion.ts:27-39`
  and `briefCustomer.ts:35-47`.

**H-2 — Classify-before-L1 gate orchestration written twice (cat. 4)**
- `src/email/ingest.ts:87-113` (Gmail pull) and `src/inbound/webhook.ts:172-205` (Composio push)
  implement the same ~20-line sequence: classify → non-work → `upsertDroppedAudit` + skip → else
  `recordFieldNote` with byte-identical audit-receipt and `sourceMeta` shapes. The leaf logic IS
  shared (`formatEmailRawText`, classifier, `upsertDroppedAudit`, `recordFieldNote` all imported
  by both); only the orchestration is duplicated. Existing drift (appears intentional but
  unguarded): webhook passes `occurredAt`, ingest doesn't (pull-path emails lose the message
  timestamp); ingest threads a `deps.extract` override, webhook doesn't. Rated hygiene, but this
  duplication guards the repo's hardest invariant — any future gate change must be made twice or
  the two routes diverge in what they permanently retain.

**H-3 — Internally contradicted, uncited Composio polling claim (cat. 6)**
- `docs/nemoclaw-tech-agent.md:210-211`: "managed-auth polling is ≥15 min (not real-time)" —
  uncited, and directly contradicted by `scripts/composio-trigger.mjs:36` which sets
  `interval: 1, // poll every minute` on the live trigger (both verified). One of the two is
  wrong or stale; the dependent dedup code is safe either way, but this is exactly the
  "uncited one-liner propagates" pattern CLAUDE.md's case study warns about.

**H-4 — Uncited vendor claims backing shipped architecture decisions (cat. 6)**
- `docs/nemoclaw-tech-agent.md:186,201` — "Gmail read scope is all-or-nothing; no 'work-only'
  scope exists" (premise for classify-before-L1 and the Composio token trust boundary). No
  Google OAuth scopes URL.
- `docs/nemoclaw-tech-agent.md:171-175,180-183` — Composio Execution Allowlist is per-auth-config
  global-only (why per-person control lives at the doorman). "Decided 2026-07-01," no doc URL.
- `docs/doorman-runbook.md:13-14,244-247,322` — "Render doesn't offer mTLS" / "web services are
  public by default" (why HMAC+IP-allowlist was chosen over mTLS). No Render URL. Also an
  in-repo tension: `Box Setup Stuff/doorman-architecture-memory.md:23-24` declares IP-allowlist
  reasoning stale while `doorman-runbook.md` Step 4 still instructs setting `ALLOWED_CLIENT_IPS`.
- `docs/doorman-runbook.md:36-39` — OpenClaw headers are static literals / cannot HMAC per
  request (the doorman's raison d'être). Partially offset by a source-level check recorded in
  `doorman-architecture-memory.md:60-61` and a live-verified CONFIRMED marker; a version-pinned
  upstream reference would close it. Code is correct in all four cases; the decision provenance
  is what's missing.

**H-5 — Phone-call research/plan (draft) contains zero citations for the vendor claims it turns on (cat. 6)**
- `thoughts/shared/research/2026-06-30-phone-call-input-feature.md` (286 lines, no URLs):
  Vapi BYO-bucket → Supabase Storage (`:235,239-241` — the claim the provider choice turned on;
  plan Phase 2 depends at `2026-06-30-phone-call-input-short-two-tier.md:78`), AssemblyAI
  remote-URL async ingest + diarization (`:224-225`; plan Phase 3 `:124`), and "Supabase Storage
  has no native object-expiry lifecycle" (`:272`; plan Phase 4 exists entirely because of it).
  No code exists yet (no `src/calls/`), so hygiene now — becomes correctness-risk the moment
  `/implement` runs without re-verifying these upstream. (The plan does correctly flag the Vapi
  webhook-signature scheme as UNCERTAINTY; these claims deserve the same treatment.)

**H-6 — `src/index.ts` is a vestigial placeholder with a stale comment (cat. 3)**
- Lines 1-3: comment + `export {}` only; nothing imports it, `package.json` has no
  `main`/`exports` pointing at it. Comment says "(added in Phase 3)" about work long since
  shipped.

**H-7 — Two working scripts referenced nowhere (cat. 3)**
- `scripts/smoke-http.mjs` — substantial end-to-end HTTP MCP smoke tool; no npm script, doc,
  or runbook names it (exhaustive grep). `scripts/verify-sig.mjs` — offline HMAC checker for
  `INBOUND_DEBUG=1` captures; the env flag is documented, the companion script never named.
  Candidates for a doc mention or npm script, not deletion.

**H-8 — Test files hand-write DB access (documented convention, noted for the record) (cats. 1+5)**
- Five integration-test files use `getClient().from('tenants')` lookups plus a direct `pg.Client`
  for raw-SQL read-backs and `afterAll` TRUNCATEs (file:line list under CR-2). Arguably
  deliberate: raw read-backs give independent verification of the layer under test, and the db
  layer intentionally exposes no delete, so TRUNCATE is the only reset path — documented at
  `src/db/spine.test.ts:22-27` and `scripts/seed.mjs:3-5,13-14`. Same pattern in
  `scripts/smoke-http.mjs` (also leaves one L1 row per run by design, header-documented).

**H-9 — Trivial duplication within `src/mcp/` (cat. 4)**
- `src/mcp/identity.ts:29-32` (`header()`) and `src/mcp/httpServer.ts:89-90` (`pick`) — identical
  string-or-array header normalization one-liner under two names in the same directory.

**H-10 — Minor uncited-but-inert claims (cat. 6, completeness)**
- `docs/nemoclaw-tech-agent.md:30` (iMessage/Apple bots), `:193-195` (Microsoft Graph
  scopes/OneDrive requirement — no Graph code exists),
  `thoughts/shared/research/2026-06-30-phone-call-input-feature.md:110-115` (no Twilio toolkit,
  names GitHub Discussion #3013 but no URL). Nothing breaks if any of these is wrong.

## Categories checked clean

- **Cat. 2 — post-insert filtering of `raw_captures`: CLEAN.** Full trace: webhook gate at
  `src/inbound/webhook.ts:172-189` (non-work → content-free `dropped_audit` receipt, L1 insert
  never reached); same pattern at `src/email/ingest.ts:87-101`;
  `src/writePath/recordFieldNote.ts` dedup is pre-insert lookup (`:91-97`) plus an
  insert-then-catch-23505 backstop (`:110-123`) that reuses the existing row and never
  updates/deletes/flags a capture; `src/db/rawCaptures.ts` exposes insert + read-only lookups
  only. Append-only trigger confirmed at `20260620005307_context_spine.sql:117-119`
  (function `:25-32`); later migrations don't weaken it.
- **Cat. 7 — markers: CLEAN.** Case-insensitive grep for TODO/FIXME/HACK/XXX/WORKAROUND/TEMP
  across `src/`, `scripts/`, `Box Setup Stuff/`, `supabase/migrations/`: zero hits.
- **Cat. 8 — ESM hygiene: CLEAN.** All 118 relative-import lines in `src/**/*.ts` carry `.js`
  extensions (incl. side-effect imports, re-exports, dynamic imports); no `require()`,
  `__dirname`/`__filename`, `module.exports`, or `.ts`-extension imports; `package.json`
  `"type":"module"` + tsconfig NodeNext confirmed.
- **Cat. 1, non-test code: CLEAN.** No `createClient`/`.from(`/`.rpc(`/pg imports anywhere in
  `src/` outside `src/db/` (non-test); `doorman.mjs` touches no DB;
  `composio-reconnect.mjs`/`composio-trigger.mjs`/`verify-sig.mjs` touch no DB; `seed.mjs`
  writes via the typed layer apart from its guarded TRUNCATE.
- **Cat. 3, mostly clean:** no fully dead exports (26 non-test files enumerated against all
  import sites); no provable unreachable branches (borderline: the `Buffer.from` catch arm at
  `src/inbound/webhook.ts:54-58` is unreachable-in-practice, self-acknowledged as deliberate
  defensiveness). All 5 fixtures exports consumed. `dist/` untracked. Test-only exports noted
  (`ingestEmail`, `syncScheduleFromSheet`, `listVisitsForJob`, etc.) are documented pending
  seams, not orphans.
- **Cat. 4, compared clean:** `gmail.ts` vs `ingest.ts` rawText shaping (already factored into
  `src/email/format.ts`); the two HMAC verifiers (genuinely different protocols); classifier
  (single implementation, shared); address normalization, sender parsing, `user_id` split
  (single sites); `server.ts` per-tool tenant guards (intentionally different failure semantics).
- **Cat. 5, clean:** all 7 DB-writing test files clean up in `afterAll`; the raw_captures
  wrinkle is handled (TRUNCATE bypasses row triggers — documented) or avoided
  (`schema.test.ts:89-104` rolls back its append-only probe); env-mutating tests restore state;
  live-Sonnet tests are `skipIf`-gated and DB-free; the prod ref `lzlgysoydhknsdvovntz` appears
  nowhere in the repo; `supabase/.temp/project-ref` links the CLI to test.
- **Cat. 6, documents clean:** `CLAUDE.md`, `README.md`, `Three-Layer-Context-Spine-Overview.md`,
  the Box Setup Stuff guides (vendor-ish statements carry VERIFIED/CONFIRMED live-observation
  markers with dates), `2026-06-25-composio-connector-layer.md` (unverified claims explicitly
  labeled), `2026-07-01-composio-identity-pairing-model.md` (open questions filed as such), and
  the shipped webhook code itself cites its vendor doc
  (`src/inbound/webhook.ts:14-17` → docs.composio.dev/docs/webhook-verification).

## Open Questions

1. **CR-1:** Are Gmail API message IDs actually mailbox-local? Needs the deferred Phase 4 live
   check (two people, same thread) or a citation from Gmail API docs — before more code builds
   on per-person dedup.
2. **H-3:** Which is true — Composio managed-auth polling floor ≥15 min, or the `interval: 1`
   the live trigger was created with? Resolve against current Composio docs and fix whichever
   artifact is wrong.
3. **CR-3:** Is the intended semantics for deleting L2 entities "blocked if any capture points
   at them" (then `on delete set null` should become explicit `restrict` to say so) or "pointer
   nulled" (then the trigger needs a carve-out)? Reading alone can't decide intent.
4. **H-4 (doorman):** Is the `ALLOWED_CLIENT_IPS` step in `doorman-runbook.md` live guidance or
   stale, given `doorman-architecture-memory.md:23-24` declares that reasoning dead?
