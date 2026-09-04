# Production Migration Checklist

**Purpose:** the go/no-go gate for moving TradesDatabase from the current pilot/test DB to the
fresh production DB (`lzlgysoydhknsdvovntz`), and for any future prod cutover. Work top to bottom.
Nothing ships until the **Sign-off gate** at the bottom is fully checked.

**How to use:** the three **Blockers** (B1–B3) are hard gates — a launch is not allowed while any is
open. The **Test tiers** are the evidence that the blockers and everything else actually hold. The
**Cutover runbook** is the ordered day-of sequence. The **Known-trap checklist** is the list of
mistakes this repo has already paid for — re-check each one at cutover.

> Grounding rules (from the `system-design` skill — apply throughout):
> - **Gate before the irreversible write, never after** (L1 has no delete path).
> - **Verify ground truth, not a proxy** — live commit hash over "I pushed"; schema *read-back* over
>   the migration ledger; box logs over vendor status pages.
> - **Fail closed on the safety-critical axis** — when unsure, default to the safe outcome.
> - **Migrations do not auto-apply** — Render only builds + starts; DDL is applied by hand.
> - **Keep a reversible escape hatch** on every risky step.

---

## Blocker B1 — Tenant isolation (no DB backstop today)

**Problem:** RLS is off and the app connects with the `service_role` key, which bypasses RLS. Tenant
isolation rests entirely on a hand-written `.eq('tenant_id', …)` in every accessor. One miss = a
silent cross-tenant leak. The anon/public key can also read business tables directly via PostgREST.

Fix in three layers — do all three (they cover different failure paths).

### B1 · Layer 1 — Deny-all RLS (closes the anon/public-key hole) — *cutover-blocking*
- [ ] Write migration `supabase/migrations/<ts>_rls_denyall_business_tables.sql` (loop over every
      public table; enable RLS with **no policy** + `REVOKE ALL … FROM anon, authenticated`).
- [ ] Test on the **local Docker stack** first — `npm test` stays green (local uses
      superuser/service_role → bypasses RLS → nothing breaks).
- [ ] Apply to the current hosted DB via Supabase MCP `apply_migration` (**not** `db push`).
- [ ] Verify: `get_advisors` — the "RLS disabled" advisory clears.
- [ ] Verify: probe `customers` / `jobs` / `raw_captures` with the **publishable/anon key** →
      returns 0 rows / 401.
- [ ] Note: `service_role` bypasses RLS by design, so this changes no app behavior — only the
      external door.

```sql
-- Deny-all: RLS on + no policy = anon/authenticated see nothing. service_role (the app) unaffected.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t.tablename);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated;', t.tablename);
  END LOOP;
END $$;
```

### B1 · Layer 2 — App-code isolation (Option B) — *cutover-blocking*
Covers the paths RLS **cannot** see: `service_role` runs the cron + `/admin`, where RLS is bypassed
and the app filter is the only guard.
- [ ] **B1a — centralize the tenant filter.** Funnel every read/write through one helper
      (`tenantTable(name, tenantId)` that always appends `.eq('tenant_id', …)`); ban raw
      `db.from('<table>')` outside it via lint/test. Forgetting becomes structurally impossible.
- [ ] **B1b — 2-tenant leak test in CI** (see Test Tier 2). Seed tenant A + B, act as A, attempt to
      read/write B, assert denied. Runs every push/PR → red build blocks the merge.
- [ ] Keep the existing `.eq('tenant_id')` filters — do **not** delete them when RLS lands; they are
      the `service_role` backstop (defense in depth).

### B1 · Layer 3 — Full tenant RLS policies (Option A) — *roadmap, not cutover*
Real DB-level isolation even for a forgotten filter — but only fires for a **non-`service_role`**
role, so it requires a plumbing change.
- [ ] Introduce a non-bypass DB role for tenant requests (app stops using `service_role` for
      tenant-scoped paths; `service_role` stays for admin/cron).
- [ ] Per request, wrap queries in a txn: `SET LOCAL app.tenant_id = <signed tenant id>`
      (from the HMAC identity, never a tool argument).
- [ ] Per tenant table, add per-operation policies:
      `USING (tenant_id = current_setting('app.tenant_id', true)::uuid)` for SELECT/UPDATE +
      `WITH CHECK (…)` for INSERT/UPDATE. L1 `raw_captures` = SELECT + INSERT only. Global/admin
      tables (cost_rates, hosts, sandbox_pool) stay deny-all (service_role only).
- [ ] The 2-tenant leak test (B1b) is the acceptance test for this — it must stay green through the
      migration.

---

## Blocker B2 — Cut over to the real prod DB — *cutover-blocking*

**Reframe:** the DB in use (`daqapdlkgxfrhquacprv`) is the **test/pilot** DB with **seed** customer
data. The untouched `lzlgysoydhknsdvovntz` is the real prod target. The cutover itself resolves the
old "test DB == prod DB" hazard — after it, they are separate.

- [ ] **Apply the full schema to prod** — all migrations, via Supabase MCP `apply_migration`
      (**not** `db push`; the ledger is drifted). **Verify by reading the schema back**
      (`list_tables` / SELECT the columns), not the version list.
- [ ] **Run the B1 deny-all migration on prod too** — a fresh box inherits the same open-by-default
      exposure (`auto_expose_new_tables = true`).
- [ ] **Start prod empty of customers.** Real customers onboard fresh; do not copy seed data.
- [ ] **Roster decision — CONFIRM before treating the old DB as disposable:** are the technicians on
      the old DB **real people** (real Composio OAuth pairings, real badges) or seed? If real, they
      **do not carry over** — re-pair every technician on prod (fresh OAuth) and re-mint badges.
      (Memory: a bad test once truncated the *roster* and locked out a *technician* — the
      control-plane may be real even though customer records are seed.)
- [ ] **Repoint services** — set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` → prod on: Render web,
      Render cron, and the trades-box host env.
- [ ] **Confirm the Supabase "linked" project** is now prod — so `seed --hosted` / `gen:types`
      target prod, not the old DB.
- [ ] **Backups/PITR on prod** — enable Point-In-Time Recovery (paid add-on; Dashboard → Database →
      Backups) **and run one restore drill** to a throwaway branch. An untested backup is not a
      backup. This is your only undo for hand-applied, forward-only migrations.
- [ ] **Old DB → staging** — now safe to break. `testEnvGuard` already blocks it from `npm test`
      (localhost-only), but never point `seed --hosted` at it after cutover.

---

## Blocker B3 — Make silent config failures loud — *cutover-blocking (at least #1 + #4)*

**Problem:** several settings fail silently — the system stays green while a critical job is dead.
You learn from a customer, not a monitor.

The silent ones to fix:

| Setting | If wrong/missing | What dies silently |
|---|---|---|
| `COMPOSIO_API_KEY` (cron) | swallowed → `{skipped}` | agent sessions + action logging |
| `INFERENCE_API_KEY` invalid | quiet downstream failure | AI stops extracting from emails |
| `COMPOSIO_WEBHOOK_SECRET` mismatch | all inbound 401'd | every incoming email rejected |
| `ALLOWED_CLIENT_IPS` empty | defaults to allow-all | spine open to the internet |
| `INBOUND_DEBUG` set | dumps full emails to disk | customer PII leak |

### B3 · Fix #1 — Fail-fast config validator — *do first*
- [ ] One `validateConfig()` module, called at web + cron boot. Required vars per service; any
      missing/blank → **crash loudly** instead of running half-dead.
```ts
const REQUIRED_WEB  = ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','GATEWAY_IDENTITY_SECRET',
  'INFERENCE_API_KEY','COMPOSIO_API_KEY','COMPOSIO_WEBHOOK_SECRET','BOARD_BOT_TOKEN'];
const REQUIRED_CRON = ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','COMPOSIO_API_KEY'];
for (const k of required) if (!process.env[k]) throw new Error(`FATAL: ${k} missing`);
```

### B3 · Fix #4 — Fail-closed defaults for the two dangerous flags — *do first*
- [ ] `ALLOWED_CLIENT_IPS` empty in prod → **refuse to boot** (force an explicit allowlist; empty
      must not mean open). Note: the Telegram board mounts *before* this allowlist (self-auth via
      initData), so this does not lock out managers/techs.
- [ ] `INBOUND_DEBUG` set in prod → **refuse to boot** (it dumps real customer emails to disk).
```ts
if (isProd && !process.env.ALLOWED_CLIENT_IPS) throw new Error('FATAL: IP allowlist empty = open');
if (isProd && process.env.INBOUND_DEBUG)       throw new Error('FATAL: INBOUND_DEBUG off in prod');
```

### B3 · Fix #2 — Loud cron skips — *next*
- [ ] A missing `COMPOSIO_API_KEY` on the cron currently → `{skipped}`, green heartbeat. Change:
      still skip, but **log a WARN + surface it in monitoring**, or gate skips behind an explicit
      `CRON_ALLOW_SKIP=1` (without it, a missing key goes red). A green heartbeat must never hide a
      dead sweep.

### B3 · Fix #3 — Active canary probe — *before real customer volume*
- [ ] Scheduled synthetic E2E that exercises the real pipe and **pages on failure**: signed test
      webhook → confirm it lands in L1; a **tiny real model completion** (not just an endpoint ping —
      the DeepInfra stall passes the ping while completions hang); one real Composio call. Run
      post-deploy + on a schedule.

---

## Test tiers (the evidence)

> The unit suite is already strong (58 files, every critical path covered against the local Docker
> stack). Spend cutover effort on the isolation, live-E2E, failure-injection, and ops layers below —
> do **not** burn the window re-running green unit tests.

### Tier 0 — Static gates (baseline)
- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm test` green against the **local** stack (confirm `testEnvGuard` blocks any hosted URL)
- [ ] `npm run build` clean
- [ ] Suite runs twice back-to-back cleanly (`fileParallelism:false`; watch cost-suite contamination)

### Tier 1 — Data integrity (the append-only spine)
- [ ] L1 append-only trigger present on the **hosted** DB (read-back, not ledger)
- [ ] Classify-before-L1 gate: non-work mail never reaches `recordFieldNote`
- [ ] Provenance: spot-check 5 real jobs — every L2 field traces to a `source_capture_id`
- [ ] Identity matching: live adversarial case — 2nd channel about an address with an open job →
      attaches, does not duplicate
- [ ] Outbound classifier-free capture lands in L1 with **keys-only** redaction (never values)
- [ ] Retraction fold removes exactly the right rows (preview == commit)

### Tier 2 — Multi-tenant isolation (B1 evidence — top risk)
- [ ] Build the **2-tenant leak test** as a permanent CI suite (table-driven over every resource ×
      read/write; add a case whenever a new table lands). Consolidate the scattered existing checks
      (`server.test.ts` id-scoping, `boardApi.test.ts` leak guards, `jobs.ts` tenant guard).
- [ ] Run it against a **hosted staging/branch** 2-tenant dataset (not the pilot).
- [ ] Accessor sweep: grep every `src/db/*` read for a missing `.eq('tenant_id')`.
- [ ] Anon-key probe on business tables → 0 rows / 401.
- [ ] Signed-identity forgery over real HTTP: tamper `x-tenant-id` without re-HMAC → rejected.
- [ ] Board: manager A cannot load tenant B's board.
- [ ] Admin cross-tenant read requires `ADMIN_DASHBOARD_TOKEN`; unset → 503.

### Tier 3 — Auth, secrets & env (B3 evidence)
- [ ] Config audit — every var present + valid on the **right** service (web / cron / box). See B3
      table + full list in `docs/control-plane.md` and `.env.example`.
- [ ] `INBOUND_DEBUG` unset in prod; `ALLOWED_CLIENT_IPS` populated.
- [ ] `GOOGLE_ROUTES_SA_KEY_JSON` **REMOVED** from the web service — rung 8 deleted the solver and
      nothing reads it (`GOOGLE_MAPS_API_KEY` stays: `find_slots` uses the Routes API).
- [ ] Break-tests: invalidate `INFERENCE_API_KEY` → loud failure + alert; mismatch
      `COMPOSIO_WEBHOOK_SECRET` → inbound 401 + you notice; unset cron `COMPOSIO_API_KEY` → visible
      skip, not hidden.
- [ ] No `.env` tracked; no plaintext badges/keys committed (fingerprints only).
- [ ] `COMPOSIO_API_KEY` + `GATEWAY_IDENTITY_SECRET` never reach a sandbox.

### Tier 4 — Agent stack / MCP / tiers
- [ ] Technician surface = exactly 14 tools (live, real tech identity).
- [ ] Manager-only tools 403 for technicians over real HTTP.
- [ ] Composio session tier gate: technician send → HTTP 400 code `4310` (execution-enforced).
- [ ] `send_email` at-most-once: crash between consume and send loses the mail (restage), never
      double-sends.
- [ ] MCP-over-HTTP end-to-end: signed identity → real tool call → tenant/tech scoping applied to the
      result (the identity-verify ↔ scoped-dispatch seam).
- [ ] Manager badge without an active manager roster row must not silently act as a technician.

### Tier 5 — Integrations, LIVE E2E (cross-channel; per `verifying-behavior` skill)
- [ ] Inbound Gmail → L1 → L2 (real work email appears + extracts; personal email dropped, audit only)
- [ ] **Live classifier quality** (`classify.ts` is LIVE-only, self-skips without a key) on realistic
      fixtures — this gates every inbound write and is unverified in CI
- [ ] Composio inbound retry race (~5s re-fire) → L1 dedup holds, no duplicate visit
- [ ] Outbound send delivers once, logged keys-only
- [ ] Telegram chat command → spine write → board reflects it; Mini App drag/book/promise/cancel →
      same `booking.ts` path, promise-ladder gate fires
- [ ] Board worker pushes dispatch notifications to a real tech (worker loop is untested code)
- [ ] DeepInfra GLM-5.2 real forced-tool calls; observe/force a stall — confirm box-side detection
      (ping passes while completions hang)
- [ ] Google Routes single-intermediate `[-1]` sentinel — key-gated live route optimization
- [ ] Badge pull on a real host: mint → pull → apply; empty-roster guard refuses to wipe a non-empty
      `badges.json`; rotate → old badge 403s within one poll

### Tier 6 — Lifecycle cron (7 sweeps)
- [ ] Local dry-run: `npm run build && node -r dotenv/config dist/jobs/lifecycle.js` → one JSON line,
      exit 0
- [ ] Per-step failure isolation; systemic failure exits 1 (Render red)
- [ ] Skip gates are **logged/visible**, not invisible
- [ ] Pairing sweep opens the manager review item exactly once per episode
- [ ] Grace-period offboarding: reminder at 2 days left (once), teardown past grace, per-row isolation
- [ ] Cost rollup: prev + current month, idempotent, no double-count (netting) — on real invoice data
- [ ] Render schedule `*/15 * * * *` UTC, at-most-one concurrent

### Tier 7 — Scheduling & booking
- [ ] One write path — every board gesture + chat command routes through `booking.ts`
- [ ] Promise-ladder gate on book/move/cancel; promise-break requires confirmation
- [ ] `no_confirmed_overlap` exclusion constraint blocks double-booking at the DB level
- [ ] `rescheduleAssignment` moves pass `status:'confirmed'` (rows created `'proposed'` are invisible)
- [ ] Naive-local time: availability uses `'UTC'` — confirm no pilot tenant spans timezones
- [ ] Pattern-less techs are invisible to find_slots — confirm live techs have patterns
- [ ] DST-boundary booking lands correctly

### Tier 8 — Cost tracking
- [ ] No double-count — infra invoice netted of already-metered spend, on one real bill
- [ ] Rate versioning — event priced at the rate in force on its day (half-open ranges)
- [ ] Brave backfill watermark idempotent (steady tick inserts nothing)
- [ ] `/admin` reads match the rollup after a cron tick

### Tier 9 — Resilience, failure injection & DR
- [ ] Deploy the **latest commit** (Render "Redeploy" re-runs the OLD commit) — confirm the live hash
- [ ] Deploy-before-migration: apply migration + `NOTIFY pgrst, 'reload schema'` before code needing
      new columns
- [ ] PostgREST 1000-row cap — every large scan paginates
- [ ] DeepInfra stall recovery (~12 min self-clear) — no data loss, captures still land in L1
- [ ] Box-reboot drill: openclaw respawned by in-container supervisor (not `docker restart`);
      `:8080` gateway revived by `nemoclaw-boot.service`; watch the stale shields-transition lock
      after a crashed `gateway restart`
- [ ] `nemoclaw rebuild` destroys the device key + resets the inference route — recovery documented,
      not run casually
- [ ] DB backups/PITR on + **restore drill done** (see B2)
- [ ] Written rollback plan for a bad deploy **and** a bad (forward-only) migration

### Tier 10 — Observability & alerting
- [ ] Cron heartbeat: a failed run goes red **and pages**; a green-but-skipped run is visible
- [ ] Inbound-mail alarm (webhook 401 or classify/extract death alerts someone)
- [ ] Model-call failure surfaces (the silent `INFERENCE_API_KEY` trap)
- [ ] Per-tenant error visibility in `/admin`
- [ ] No `console.log` of email content / PII in prod paths (`INBOUND_DEBUG` off)

### Tier 11 — Performance / latency
- [ ] First-message cold-start (~44s: container revive / MCP connect / route cold, not the model) —
      accept or add a warmer
- [ ] Board round-trip latency acceptable under real data volume
- [ ] Concurrency: multiple techs/managers acting at once while the cron runs

---

## Code gaps to close before prod (from the coverage audit)

- [ ] **`writePath/extract.ts`** — the live LLM field extractor is only ever stubbed. Highest code
      risk (feeds identity matching + L2 writes). Add tests + run live on real notes.
- [ ] **`email/classify.ts`** — real classifier is LIVE-only, self-skipping. Add a keyed CI job or a
      fixture-graded run so the inbound gate is verified in CI.
- [ ] **`telegram/boardWorker.ts`** — worker entrypoint untested. A crash = no dispatch notifications.
- [ ] `db/rawCaptures.ts`, `db/foldImpact.ts`, `db/reviewItems.ts` — load-bearing writers tested
      only transitively; add focused tests.

---

## Cutover runbook (day-of, ordered)

Rollout order is a design artifact — do exactly these steps, in order (system-design Tier 1 #9).

1. [ ] All Blockers B1/B2/B3 items above are checked, Tiers 0–8 green.
2. [ ] Prod DB: apply full schema → **read-back verify** → apply deny-all → `get_advisors` clear.
3. [ ] Enable PITR on prod + run the restore drill.
4. [ ] Roster decision executed (re-pair on prod if the old roster was real).
5. [ ] Deploy the **latest commit** to Render web + cron; confirm the live commit hash.
6. [ ] Config validator passes at boot on both services (a bad config now refuses to start).
7. [ ] Repoint env (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` → prod) on web + cron + box;
      confirm the linked Supabase project is prod.
8. [ ] Force the boundary: restart services / relaunch sandboxes so new creds + tool lists load
      (a credential in the store but absent from the process env is silently dead).
9. [ ] Live E2E smoke on prod (Tier 5): inbound email → L1 → L2; a Telegram command; a board edit;
      one badge pull.
10. [ ] Canary probe green; monitoring/alerts confirmed firing (break-test one).
11. [ ] Keep the escape hatch: old DB intact as staging, env-revert documented.

---

## Sign-off gate

Prod-ready only when **all** are true:
- [ ] **B1** — deny-all applied + verified; app-code isolation (centralized filter) in place; 2-tenant
      leak test green in CI
- [ ] **B2** — prod schema applied + read-back verified; deny-all on prod; PITR on + restore drill
      done; services repointed; roster decision executed
- [ ] **B3** — config validator live (Fix #1) + fail-closed flags (Fix #4); loud cron skips (Fix #2)
- [ ] **Tiers 0–8 green**; **Tier 5 live E2E** passed on every channel
- [ ] Code gaps 1–3 closed (`extract.ts`, `classify.ts` live, `boardWorker.ts`)
- [ ] Rollback plan written (bad deploy **and** bad migration); escape hatch verified

---

*This is a doc-only file — per the repo's doc carve-out it can be committed to `main` and pushed
directly. Keep it synced as the system changes; verify claims against code, don't assert from a stale
copy. Companion docs: `docs/engineering-memory.md`, `docs/control-plane.md`, the `system-design` and
`verifying-behavior` skills.*
