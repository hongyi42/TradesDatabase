# Plan: Production DevOps Readiness (2026-08-17)

## Summary

This plan takes the HVAC-Nemoclaw / TradesDatabase pilot (~2 tenants, one AWS Lightsail box +
Render + Supabase) to production readiness with right-sized, standard DevOps practice, automated
where it helps by **n8n** (a committed decision). It is sequenced so that **active data-loss and
tenant-isolation risks are closed first** (Phase 0, no automation dependency), then **n8n is
hardened before it ever holds a real credential** (Phase 1 — load-bearing because n8n becomes the
highest-privilege system in the stack and has shipped two CVSS-10.0 RCEs in ~18 months), then the
**automation workflows are built outward from the cheapest already-shipped win** (Phase 2), then
the **CI/CD gate and release discipline** are stood up with the n8n release glue as the capstone
that hard-depends on them (Phase 3), and finally the **runbooks, cutover gate, and ops cadence**
are operationalized (Phase 4).

The plan **reuses existing assets** rather than re-deriving them: the `ops_events` incident store +
`POST /control/ops`, the cost ledger (`cost_events`/`cost_rates`/`infra_costs`/`cost_rollup_monthly`)
and its partial DeepInfra puller, the deny-all RLS pattern already proven on the cost tables, and
the (excellent, currently uncommitted) `docs/prod-migration-checklist.md`.

## Stakes Classification

**Level: HIGH**

**Rationale:**
- Touches the **live pilot database holding real, "unrecoverable" customer data** (backups/DR and an
  RLS retrofit applied to the hosted DB).
- Introduces **n8n as the single highest-privilege system in the stack** (it will decrypt Render,
  Supabase service-role, DeepInfra, Brave, AWS, and Telegram credentials behind one key), against a
  documented history of two independent CVSS-10.0 RCEs — building it insecurely *adds* a critical
  vulnerability.
- Several steps are **hard or impossible to roll back**: migrations here are forward-only by repo
  doctrine (no down-migrations; PITR is the only real undo, and it is not yet enabled); a mistaken
  RLS/GRANT change on the live DB, or a wrong prod cutover, has **wide, cross-tenant blast radius**.
- Changes the **deploy/release path itself**, and the review already surfaced live incidents from
  this area (a stale-commit deploy; a migration-vs-deploy ordering mistake).

HIGH stakes → detailed plan, granular steps, per-step verification, explicit rollback, and the
repo's `system-design` / `data-security` / `verifying-behavior` skills enforced throughout.

## Context

**Research (primary input, read in full):**
`thoughts/shared/research/2026-08-17-prod-devops-research.md` — the consolidated synthesis of three
parallel passes (codebase / external best-practice / n8n). Supporting detail:
`thoughts/shared/research/2026-08-17-prod-devops-{codebase,external,n8n}.md`.

**Governing repo skills (each constrains this plan and is cited inline):**
- `system-design` — schema changes, migrations, production changes/deploys, failure handling.
- `data-security` — RLS/tenant isolation, secret custody, PII.
- `verifying-behavior` — test-env safety, maker≠checker, codified-vs-live-vs-human triage.

**Affected areas / services:**
- Supabase: live pilot project `daqapdlkgxfrhquacprv` (misleadingly named "test" — it **is**
  production); intended-prod project `lzlgysoydhknsdvovntz` (empty, possibly paused); a **new third
  project** for staging.
- Render: web (`mcp:serve:http`), `Board_Worker`, `lifecycle-heart` cron, plus the phone feature's
  `calls-worker` / `calls-purge` (prod-deploy status unconfirmed — see Open Questions).
- AWS Lightsail box (`trades-box-1`, reachable as `ssh tradesbox`) — will also host n8n.
- Repo: `supabase/migrations/`, `src/mcp/httpServer.ts`, `src/db/*`, `Box_Setup_Stuff/*`,
  `.github/` (to be created), `docs/`.

**Working-baseline constraint (verified during planning, load-bearing):**
The local checkout is on branch `feat/phone-call-capture`, **160 commits behind `origin/main`, 0
ahead**. The `ops_events` assets the research relies on (`src/db/opsEvents.ts`,
`Box_Setup_Stuff/ops-report.sh`, `supabase/migrations/20260813000000_ops_events.sql`) are **absent
from this checkout** — they exist only on `origin/main`. **All implementation must be based on
`origin/main` (or, once identified, the actual Render-connected deploy repo), never this stale
working tree.** `docs/prod-migration-checklist.md` exists on disk (~20 KB) but is **untracked** —
never committed to any branch.

## Reused Assets (build on these — do NOT re-derive)

| Asset | Location (on `origin/main`) | How this plan reuses it |
|---|---|---|
| `ops_events` incident store + `POST /control/ops` | `src/mcp/httpServer.ts` ~L531, `src/db/opsEvents.ts`, `supabase/migrations/20260813000000_ops_events.sql`, `Box_Setup_Stuff/ops-report.sh` | Phase 2.1 adds only the missing "notify on open/close" half (the repo's own scoped "Phase 4: one function"). |
| Cost ledger + partial DeepInfra puller | `supabase/migrations/20260725120000_cost_ledger.sql`, `upsertInfraCost`, `DEEPINFRA_BILLING_API_KEY` | Phases 2.2–2.3 extend the puller and feed the **existing** `infra_costs`/ledger schema — no new table. |
| Deny-all RLS pattern (proven) | `supabase/migrations/20260725140000_cost_tables_rls.sql` | Phase 0.7 clones this exact `ENABLE RLS` + `REVOKE ALL FROM anon, authenticated` (no policy) pattern onto core business tables. |
| Prod cutover checklist (uncommitted) | `docs/prod-migration-checklist.md` (B1/B2/B3 + Test Tiers 0–11 + cutover runbook + sign-off gate) | Phase 0.6 reviews + commits it; Phases 0/4 execute against its B1/B2/B3 and Tier 9/10 items rather than re-deriving them. |
| Ops-alerting plan doc | `thoughts/shared/plans/2026-08-12-ops-alerting-render.md` | Source for the ops_events notifier scope. |

## n8n Security Cautions (load-bearing, NOT optional polish)

These are prerequisites, encoded as Phase 1 steps, because doing them wrong adds a critical
vulnerability instead of closing one:
- **Pin an explicit version, never `:latest`.** Two independent CVSS-10.0 RCEs shipped recently:
  **CVE-2026-21858** (webhook content-type confusion → arbitrary file read → RCE, patched 1.121.0)
  and **CVE-2026-25049** (JS expression-sandbox escape from *any* field in Expression mode, patched
  2.4.0). Pin to a version ≥ the current patched release and patch on disclosure. Both bugs end the
  same way: attacker reads `N8N_ENCRYPTION_KEY` and decrypts **every** stored credential at once.
- **Isolate n8n's Postgres** from the product's Supabase DB.
- **Never expose the editor UI to the internet** (IP-allowlist / VPN behind a reverse proxy).
- **Something outside n8n must monitor n8n** (external dead-man's-switch) — a hung/OOMed n8n stops
  firing every workflow silently, including the monitoring ones.
- **n8n is not a CI engine.** GitHub Actions is the system of record for "is this code good"; n8n
  only does what happens *after* that is already true.

## Success Criteria

- [ ] Live pilot Supabase plan tier confirmed; **daily automated backups verified enabled**; PITR
      decision made explicitly and acted on.
- [ ] A **real restore drill** has been run to a throwaway environment and passed.
- [ ] **RLS enabled (deny-all)** on every core business table of the live pilot DB; Supabase advisor
      "RLS disabled" cleared; anon-key probe returns 0 rows / 401; app behavior unchanged.
- [ ] **Deploy provenance documented**: the repo Render actually deploys from is recorded; the live
      commit hash is confirmable; the local-vs-`origin/main` drift is reconciled.
- [ ] `docs/prod-migration-checklist.md` reviewed and committed to `main`.
- [ ] n8n self-hosted on Lightsail: pinned version, isolated Postgres, editor not public, HTTPS,
      `EXECUTIONS_DATA_PRUNE` on, encryption key + workflows/creds backed up, external dead-man's
      switch firing.
- [ ] `ops_events` → Telegram notifier live; a real incident open/close pages a human.
- [ ] Inference-provider watchdog live — **provider-agnostic** (covers whichever provider is live:
      DeepInfra / Fireworks / …), checking **both** balance/cost (threshold **and** day-over-day
      delta) **and credential validity** (an authenticating probe, NOT mere key-presence —
      `hasModelCredentials()` is presence-only); other metered vendors covered by the
      internal-counter pattern into the **existing** ledger.
- [ ] Nightly `pg_dump` → S3 (3-2-1) with an **independent** freshness check; both alert on failure.
- [ ] `/health` endpoint (DB round-trip + real model completion) live; n8n canary exercises it;
      cron-shaped workers have a "last successful run" heartbeat.
- [ ] GitHub Actions CI gate (eslint + tsc + vitest + build) green-required on `main`; branch
      protection confirmed; **2-tenant leak test** in CI; Dependabot + `npm audit`.
- [ ] A real staging environment exists (third Supabase project + one lean staging web service).
- [ ] Migration-vs-deploy ordering is **enforced**, not remembered (a **confirmed-recurring**
      incident class — 2026-07-19 **and** 2026-08-15/PR #148); rollback procedure written;
      release checklist in place; n8n release glue pins and reports the live commit SHA.
- [ ] Incident runbook, cutover readiness gate, and daily/weekly/monthly ops cadence documented.
- [ ] Every research-doc open question is resolved or carried as a checked "verified at
      implementation time" item.

---

## Verification Approach (applies to every step — per `verifying-behavior`)

1. **Test-env safety is non-negotiable.** All verification **writes** go to the **local Docker
   Supabase stack** (`npx supabase start`, `.env.test`) — the only writable test env — or a
   **throwaway/scratch** DB. The hosted `daqapdlkgxfrhquacprv` project **is the live pilot DB**:
   read-back / inspection only, **never** verification writes. Prod `lzlgysoydhknsdvovntz` is
   read-only.
2. **Maker ≠ checker.** Any live/agent-driven verification runs in a **fresh-context subagent that
   did not write the change**, exercises the real flow, and **reads back through an independent
   channel** (e.g. change writes via the app's DB client; verifier reads via `supabase-test` MCP
   `execute_sql` SELECT or `ssh tradesbox` logs).
3. **Triage each check** into: **codified test** (default; unit/integration), **agent-executable
   live E2E** (only when the success signal is objective + cross-channel-checkable), or **human**
   (visual/judgment). Keep the pyramid: many codified, few live.
4. **Missing-capability rule.** Preflight the MCP/creds a check needs; if missing, **STOP and name
   what to set up** — never silently degrade to an ad-hoc manual checklist.
5. **Health checks distinguish reachability from function** — a canary does a **real completion, not
   a ping** (`system-design` Tier 4; the medic ping passed while completions hung).

---

## Implementation Steps

### Phase 0 — Manual Criticals (no n8n dependency; front-loaded; steps run largely in parallel)

> These close active risk *today* and are dashboard/SQL/process actions, not automation. Governed by
> `data-security` (0.7–0.9) and `system-design` Tier 2/3 (migrations, deploy provenance).

#### Step 0.1: Establish the correct working baseline

- **Files**: N/A (git/process)
- **Action**: Base all subsequent work on `origin/main` (fetch + create a fresh working branch from
  it), **not** the 160-behind `feat/phone-call-capture` checkout. Record, in the plan's Status
  section, the `origin/main` HEAD SHA used as the baseline. Confirm the `ops_events` assets
  (`src/db/opsEvents.ts`, `Box_Setup_Stuff/ops-report.sh`, the `20260813000000_ops_events.sql`
  migration) are present on that baseline.
- **Verify**: `git rev-list --left-right --count origin/main...HEAD` shows `0	0` (working branch is
  at `origin/main`); `ls src/db/opsEvents.ts Box_Setup_Stuff/ops-report.sh` both exist.
- **Complexity**: Small

#### Step 0.2: Confirm live-pilot Supabase plan tier + verify daily automated backups (MOST URGENT)

- **Files**: N/A (Supabase dashboard / Management API)
- **Action**: Determine the current plan tier of `daqapdlkgxfrhquacprv`. If Free (zero automatic
  backups), upgrade to **Pro** ($25/mo → daily backups, 7-day retention). Confirm daily automated
  backups are actually enabled and a backup has been taken.
- **Verify**: Dashboard → Database → Backups shows ≥1 completed daily backup with a timestamp <25h
  old; plan tier recorded in Status. **This is the single highest-priority action in the plan** —
  do not gate it behind anything else.
- **Complexity**: Small

#### Step 0.3: Make the explicit PITR / RPO decision (do not default silently)

- **Files**: `docs/prod-migration-checklist.md` (B2 note)
- **Action**: The research flags a genuine tension (codebase: PITR urgent given "unrecoverable"
  data; external: ~24h RPO from daily backups is defensible at 2-tenant scale, PITR $100+/mo may be
  premature). Make a **deliberate team decision** and record RPO/RTO targets (research suggests
  informal RPO~24h / RTO~4h as a starting point). If PITR is chosen, enable it (Dashboard →
  Database → Backups).
- **Verify**: Decision + RPO/RTO targets written into the checklist; if PITR enabled, dashboard
  shows it active.
- **Complexity**: Small

#### Step 0.4: Run a real restore drill (proves the backup — untested backup ≠ backup)

- **Files**: N/A (throwaway env)
- **Action**: Restore the most recent backup (Supabase backup or the Phase-2 `pg_dump`, whichever
  exists first) into a **throwaway Supabase branch / scratch Postgres** — never prod, never the live
  pilot. Run sanity queries there (row counts on `customers`/`jobs`/`raw_captures`, latest-timestamp
  check). Time the restore (RTO evidence).
- **Verify** (live E2E, maker≠checker, writes to scratch only): a fresh-context verifier restores,
  runs the sanity SELECTs on the **scratch** DB, and reports actual row counts + restore duration —
  not "looks fine". Records pass/fail + measured RTO.
- **Complexity**: Medium

#### Step 0.5: Establish and document deploy provenance

- **Files**: `docs/onboarding.md` §10 / `HANDOFF.md` (record the finding)
- **Action**: Get a human with Render dashboard access to state **which repository each Render
  service actually deploys from** (documented repeatedly as a separate, unrecorded, manually-synced
  repo). Record the repo identity, the sync procedure, and the current live commit SHA of each
  service. Reconcile: `origin/main` HEAD vs the deploy-repo HEAD vs the live commit — note any drift.
- **Verify**: The deploy-repo identity + sync steps are written down; the live commit SHA of the web
  service is confirmed via the Render dashboard (not inferred). `system-design` Tier 3: "verify the
  live commit hash" — Render "Redeploy" re-runs the OLD commit.
- **Complexity**: Small

#### Step 0.6: Formalize (review + commit) `docs/prod-migration-checklist.md`

- **Files**: `docs/prod-migration-checklist.md`
- **Action**: Review the untracked draft, correct anything stale against `origin/main`, and commit
  it to `main` (its own footer confirms it's a doc-only file safe to commit directly). Do **not**
  re-derive its B1/B2/B3 analysis — this plan builds on it.
- **Verify**: `git ls-files --error-unmatch docs/prod-migration-checklist.md` succeeds (now tracked);
  it is present on `origin/main`.
- **Complexity**: Small

#### Step 0.7: Write the deny-all RLS migration for core business tables (RED = local test stays green)

- **Files**: `supabase/migrations/<ts>_rls_denyall_business_tables.sql` (new)
- **Action**: Clone the proven pattern from `20260725140000_cost_tables_rls.sql` and checklist B1
  Layer 1: a `DO $$ … FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
  EXECUTE 'ALTER TABLE … ENABLE ROW LEVEL SECURITY' + 'REVOKE ALL … FROM anon, authenticated' …`
  with **no policy** (service_role bypasses RLS by design, so app behavior is unchanged; anon/
  authenticated get zero rows). This covers `customers`, `jobs`, `visits`, `raw_captures`, and every
  other currently-`rls=false` public table.
- **Test cases (the RED evidence — codified, local Docker stack):**
  - `npm test` stays **green** on the local stack (local uses superuser/service_role → bypasses RLS
    → nothing breaks). This is the regression proof that the app path is unaffected.
  - The existing 58-file suite runs twice back-to-back cleanly (checklist Tier 0).
- **Verify**: migration file written; `npm test` green locally before any hosted apply.
- **Complexity**: Medium

#### Step 0.8: Apply deny-all RLS to the hosted pilot DB + read-back verify (GREEN)

- **Files**: N/A (Supabase MCP)
- **Action**: Apply via Supabase MCP **`apply_migration`** — **not** `db push` (`system-design`
  Tier 2: the ledger is drifted; never run `db push --linked`'s repair). Then
  `NOTIFY pgrst, 'reload schema'`. **Open-question step (verify at impl time):** whether
  `apply_migration` supports `lock_timeout`/`statement_timeout` natively or they must be hand-added
  to the SQL — confirm before applying against the live DB (`ALTER … ENABLE RLS` takes a brief
  ACCESS EXCLUSIVE lock; keep it bounded).
- **Verify** (read-back, independent channel — reads only, allowed on the live DB):
  - `get_advisors` → the "RLS disabled" advisory **clears** for the covered tables.
  - Probe `customers` / `jobs` / `raw_captures` with the **publishable/anon key** → **0 rows / 401**.
  - Spot-check the app still reads/writes normally (service_role path) — the cron rollup, a `src/db`
    accessor, `/admin` all unaffected.
- **Verify (maker≠checker)**: a fresh-context verifier runs the anon-key probe + `get_advisors` and
  reports the actual advisory state and probe HTTP codes.
- **Complexity**: Medium

#### Step 0.9: Layer-2 app-code isolation — centralize the tenant filter + build the 2-tenant leak test

- **Files**: `src/db/*` (a `tenantTable(name, tenantId)` helper), `src/**/__tests__/tenantLeak.test.ts` (new)
- **Action** (per `data-security` #1 and checklist B1 Layer 2 — the paths RLS can't see, since the
  app runs as service_role): funnel tenant reads/writes through one helper that always appends
  `.eq('tenant_id', …)`; keep existing filters as the backstop (do not delete). Build the
  **2-tenant leak test** (table-driven over every resource × read/write) — this is the acceptance
  test for the RLS blocker and will be wired as a required CI job in Phase 3.
- **Test cases (RED, codified, local stack):** seed tenant A + B; acting as A, attempt to read and
  write every B resource → **all denied**; adding a new table without a filter must **fail** this
  test. Identity is read from the verified HMAC header, never a tool arg (`data-security` #1).
- **Verify**: leak test exists and is red before the helper/filters land, green after; forging
  `x-tenant-id` without re-HMAC is rejected.
- **Complexity**: Large

> **Phase 0 checkpoint:** backups verified + PITR decided + restore drilled; deploy provenance
> documented; checklist committed; RLS deny-all live on the pilot DB with advisor cleared and app
> unaffected; leak test green. These are independent of everything below and must all pass before
> cutover.

---

### Phase 1 — n8n Hardening (prerequisite before ANY credentialed workflow)

> Governed by `data-security` #3 (secret custody) and the n8n security cautions above. No workflow
> in Phase 2/3 may hold a real credential until this phase's checkpoint passes.

#### Step 1.1: Provision an isolated Postgres for n8n

- **Files**: `Box_Setup_Stuff/n8n/docker-compose.yml` (new)
- **Action**: Stand up a **dedicated Postgres** container/volume for n8n on the Lightsail box —
  **not** the product's Supabase DB. n8n uses it for its own workflow/execution/credential storage.
- **Verify**: n8n connects to its own Postgres; the product Supabase connection string appears
  **nowhere** in n8n's env.
- **Complexity**: Small

#### Step 1.2: Deploy n8n on Lightsail, pinned version, prune on, encryption key backed up

- **Files**: `Box_Setup_Stuff/n8n/docker-compose.yml`, `Box_Setup_Stuff/n8n/.env` (0600 root:root)
- **Action**: Pin an explicit n8n image tag ≥ the current patched release (past CVE-2026-21858 @
  1.121.0 and CVE-2026-25049 @ 2.4.0) — **never `:latest`**. Set `EXECUTIONS_DATA_PRUNE=true` (+
  `EXECUTIONS_DATA_MAX_AGE`) from day one. Generate `N8N_ENCRYPTION_KEY` and back it up in the
  secrets store (fingerprint-only references in any doc/log per `data-security` #3 — never paste the
  key).
- **Verify**: `docker inspect` shows the pinned tag (not `latest`); n8n boots; prune env present;
  the encryption key is recoverable from the secrets store (test by describing its fingerprint, not
  its value).
- **Complexity**: Medium

#### Step 1.3: Reverse proxy + HTTPS; editor UI never public; owner auth

- **Files**: `Box_Setup_Stuff/n8n/nginx.conf` (new), n8n env
- **Action**: Put nginx + TLS in front of n8n. **Restrict the editor UI** to an IP-allowlist / VPN
  (never open to the internet). Enable the owner account / auth; `N8N_SECURE_COOKIE=true`. Only the
  specific webhook paths needed by Phase 3's CI/CD glue may be reachable externally, and those are
  signature-gated (`system-design` Tier 4: guard inbound boundaries — signature + replay window +
  length check).
- **Verify**: the editor URL is unreachable from a non-allowlisted IP (curl from off-box → refused);
  TLS valid; unauthenticated editor access denied.
- **Complexity**: Medium

#### Step 1.4: Task-runner hardening + credential-custody documentation

- **Files**: `Box_Setup_Stuff/n8n/README.md` (new), n8n env
- **Action**: If the Code node / Expression evaluation is used at all, run **task runners in
  external mode** (isolates the sandbox that CVE-2026-25049 escaped). Document the credential-custody
  model: which credentials n8n holds, that they are all behind one encryption key, and the patch-on-
  disclosure policy. Apply least privilege — the backup workflow's DB role is read-only and
  backup-scoped (see 2.7), and the service-role key is *not* stored in n8n unless a workflow truly
  needs it.
- **Verify**: task-runner mode confirmed in config; custody doc lists every stored credential + its
  scope.
- **Complexity**: Small

#### Step 1.5: External dead-man's-switch monitoring n8n itself (build before any monitoring workflow)

- **Files**: n8n workflow `n8n-heartbeat` (export committed under `Box_Setup_Stuff/n8n/workflows/`)
- **Action**: Create a free-tier external monitor (Healthchecks.io / Better Stack / Cronitor) and an
  n8n "still alive" workflow that pings it on a schedule. Configure the monitor to alert **you** if
  the ping does **not** arrive (dead-man's-switch) — this is what catches a hung/OOMed n8n that would
  otherwise silently stop firing every other workflow.
- **Verify** (live E2E): stop the n8n heartbeat workflow → the external monitor fires an alert within
  its grace window; re-enable → alert clears. This is the objective, cross-channel signal.
- **Complexity**: Small

#### Step 1.6: Back up n8n's own workflows + credentials

- **Files**: n8n workflow `n8n-selfbackup`, target git repo / S3 (encrypted)
- **Action**: Schedule an export of n8n's workflows and (encrypted) credentials to git/S3 (e.g. the
  n8n-git pattern), so a box loss doesn't lose the automation layer. Store the encryption key
  separately from the backup.
- **Verify**: a backup artifact exists and is dated <25h old; a test import into a scratch n8n
  restores the workflows.
- **Complexity**: Small

> **Phase 1 checkpoint:** n8n is pinned, isolated, non-public, HTTPS, prune-on, self-backed-up, and
> an external dead-man's-switch watches it. Only now may credentialed workflows be built.

---

### Phase 2 — n8n Automation Workflows

> Build order within the phase is cheapest-highest-value first. Every workflow routes alerts to the
> shared Telegram channel and names a "who responds first" primary (informal, not a rotation tool).
> The **CI/CD glue is intentionally NOT here** — it depends on the Phase 3 GitHub Actions gate, so it
> lives at the end of Phase 3 (the one deliberate deviation from the task's grouping, per the
> research doc's hard-gate: "automating an unverified deploy just makes bad deploys faster").

#### Step 2.1: `ops_events` → Telegram notifier (highest-value, no new schema)

- **Files**: n8n workflow `ops-events-notifier`; optional tiny extension to `POST /control/ops`
  in `src/mcp/httpServer.ts` (~L531)
- **Action**: Close the repo's own documented "Phase 4" gap — the store exists, only the alarm is
  missing (`engineering-memory.md`: *"STILL A STORE, NOT AN ALARM"*). **Primary approach (no app
  code):** an n8n Postgres node polls `ops_events` for open/close transitions (reusing the
  `getOpenIncident` / `listRecentIncidents` logic) and posts to Telegram on each transition.
  **Alternative:** extend `POST /control/ops` to also POST to a signature-gated n8n webhook. Prefer
  the store-reuse approach — no new application schema or logic.
- **Test cases:** insert a synthetic open row into `ops_events` on the **local stack** → notifier
  posts an "incident opened" Telegram message; flip `closed_at` → posts "resolved". De-dup: one
  message per transition (the store already has a partial unique index on `closed_at is null`).
- **Verify** (live E2E, maker≠checker): a fresh-context verifier writes a scratch open/close to a
  **non-pilot** ops_events (local stack) and confirms the Telegram messages arrive with the incident
  fields. Backfill check: the pattern would have paged on the 2026-08-14 balance-out windows.
- **Complexity**: Small

#### Step 2.2: Inference-provider balance + credential-validity watchdog (reuse the partial puller)

- **Files**: n8n workflow `inference-watchdog`
- **Action**: Scheduled n8n workflow, **provider-agnostic** — target whichever inference provider is
  live, not DeepInfra-specifically (production switched **DeepInfra → Fireworks FAST on 2026-08-15**;
  the live provider will move again). Reuse the existing partial puller (`DEEPINFRA_BILLING_API_KEY`
  / DeepInfra `POST /v1/request-costs`) where it applies, add the equivalent Fireworks balance/spend
  check, or fall back to the repo's documented 1-token-probe. Alert to Telegram **before** balance
  hits zero, on an **absolute threshold OR a day-over-day delta** (catches a 10x-calls bug a monthly
  check would miss). **Also probe credential VALIDITY, not mere presence** — `hasModelCredentials()`
  is presence-only, so a stale/suspended key reads as "present" and compose burns 3 retries instead
  of skipping; the probe must confirm the key actually authenticates. Directly answers the failure
  that caused recorded outages across **both** providers (DeepInfra balance-out 07-11/07-20/07-31/
  08-14 → HTTP 402; Fireworks spend-cap 2026-08-15 → HTTP 412), the eval-harness shared-balance blast
  radius, and the **zero-model-usage-since-2026-08-15-18:13** signal (a silent-stall class a
  usage-heartbeat would catch).
- **Open-question step:** confirm each live provider's exact spend-limit UI/API mechanics (DeepInfra
  **and** Fireworks; research flags this single-sourced/unverified) — prefer the code-grounded
  puller/probe over the vendor UI claim.
- **Test cases:** mocked low balance / mocked cost spike → Telegram alert fires; a mocked
  **invalid/suspended credential** → alert fires (not silent); normal balance + valid key → quiet
  log only.
- **Verify**: threshold, delta, **and** credential-invalid all trigger in a dry run against mocked
  inputs.
- **Complexity**: Medium

#### Step 2.3: Broader daily cost-pull → feed the EXISTING ledger (no new table)

- **Files**: n8n workflow `cost-pull-daily`
- **Action**: Daily fan-out per vendor: DeepInfra (as 2.2), Brave via the **internal Postgres counter
  × known rate** (there is no clean Brave usage API; the counter already exists conceptually as an
  "unpriced counter"), Render/AWS where exposed. Normalize and insert into the **existing**
  `infra_costs` / cost-ledger schema via `upsertInfraCost` — **not** a parallel `vendor_cost_log`
  table (`cost_rollup_monthly` and `/admin` already read the existing schema; keep one source of
  truth). Alert on daily-cost threshold or day-over-day delta.
- **Test cases:** a dry run inserts a priced row into a **local** `infra_costs` and `/admin` reflects
  it after a rollup tick; idempotent re-run inserts nothing new (watermark).
- **Verify** (cross-channel): verifier reads back the inserted `infra_costs` row via
  `supabase-test` MCP SELECT on the local/scratch stack.
- **Complexity**: Medium

#### Step 2.4: Add a `/health` endpoint (real function, not reachability) — RED before GREEN

- **Files**: `src/mcp/httpServer.ts`, `src/mcp/__tests__/health.test.ts` (new)
- **Action**: Add `GET /health` that does a **DB round-trip + model-provider reachability**, and a
  deeper `GET /health?deep=1` (or a separate canary path) that forces a **tiny real model
  completion** — not just "process is up" (`system-design` Tier 4; the medic ping passed through 6
  real outage windows). Render's zero-downtime deploy gate can then use it too.
- **Test cases (RED, codified):**
  - DB reachable + provider reachable → `200` with a JSON status body.
  - DB round-trip fails (mocked) → `503`.
  - provider unreachable (mocked) → `503` with which check failed.
- **Verify**: tests exist and fail first, pass after the route lands; `npm run typecheck/lint/test/
  build` all green.
- **Complexity**: Medium

#### Step 2.5: n8n health-check fan-out canary (depends on 2.4)

- **Files**: n8n workflow `health-canary`
- **Action**: `Schedule Trigger (5 min) → HTTP Request(s) against /health on the Render web service +
  a Lightsail reachability check → Merge → IF non-2xx OR the deep canary's completion fails →
  Telegram; else quiet log`. The canary must exercise **both** the endpoint **and** one real model
  completion (misses the inference-provider-stall class otherwise — the same class as the
  2026-08-15 zero-usage stall).
- **Open-question step:** verify Render's current webhook plan-gating before designing any
  webhook-*dependent* variant — poll if webhooks require a plan tier you're not on (research flags
  this single-sourced).
- **Test cases:** point the canary at a deliberately-down target → Telegram alert; healthy target →
  no alert.
- **Verify** (live E2E): temporarily stop the staging web service → alert fires; restart → clears.
- **Complexity**: Small

#### Step 2.6: Cron-worker "last successful run" heartbeats

- **Files**: small write in each worker entrypoint (`Board_Worker`, `lifecycle-heart`,
  `calls-worker`, `calls-purge`); n8n workflow `worker-heartbeat-check`
- **Action**: Each cron/queue-shaped worker (no HTTP surface) writes a `last_success_at` timestamp to
  Postgres on a clean run. An n8n workflow (or the external dead-man's-switch) checks freshness and
  alerts if a worker's timestamp is stale — a hung-but-alive worker fails more dangerously (silently)
  than a crashed one. Loud cron skips per checklist B3 Fix #2 (a green heartbeat must never hide a
  dead sweep).
- **Test cases:** stale timestamp (mocked) → alert; fresh → quiet.
- **Verify** (cross-channel): verifier reads the `last_success_at` row after a local worker run.
- **Complexity**: Medium

#### Step 2.7: Nightly `pg_dump` → S3 backup (independent 3-2-1 copy)

- **Files**: n8n workflow `db-backup-s3`
- **Action**: `Schedule Trigger (daily, off-peak) → Execute Command: pg_dump/supabase db dump using a
  read-only, backup-scoped Postgres role` — **explicitly NOT** the service-role key or any credential
  n8n holds for another purpose (`data-security` #3 least privilege; keep the widest-privilege DB
  credential out of n8n if avoidable; read-only, never writes to the pilot schema). `→ optional gpg
  encrypt → S3 upload (dated key) → size sanity check (a 0-byte/truncated dump is worse than none) →
  log {timestamp, size, sha256, status} → IF failed/undersized → loud Telegram; else quiet`. This is
  the vendor-independent copy that answers "what if Supabase itself is the problem", separate from
  Phase 0's Supabase-managed backups.
- **Test cases:** a successful dump uploads a non-zero object + logs sha256; a simulated 0-byte dump
  triggers the loud alert.
- **Verify** (live E2E): run once → confirm a dated, non-zero object in S3 and a log row; this dump
  is also the input to the Step 0.4 / monthly restore drill.
- **Complexity**: Medium

#### Step 2.8: Independent backup freshness-check (decoupled from 2.7's own branch)

- **Files**: n8n workflow `db-backup-freshness`
- **Action**: A **separate** workflow: `S3 list objects → newest → IF age > 25h → Telegram "no
  backup uploaded"`. Deliberately decoupled from 2.7's success/failure branch so it also catches the
  case where 2.7's Schedule Trigger was silently disabled or n8n was down when the job should have
  fired.
- **Open-question step:** verify Supabase Management API specifics if also checking the managed-backup
  freshness programmatically (research flags no fully-worked example found).
- **Test cases:** newest object aged >25h (or bucket empty) → alert; fresh object → quiet.
- **Verify**: with the bucket artificially stale, the alert fires independently of 2.7's state.
- **Complexity**: Small

#### Step 2.9: Manually-triggered restore-drill workflow (run monthly by hand)

- **Files**: n8n workflow `restore-drill` (manual/Telegram trigger)
- **Action**: Telegram-bot command → restore the latest S3 dump into a **scratch Postgres / throwaway
  Supabase branch** → sanity queries (row counts, latest-timestamp) → report pass/fail to Telegram.
  Keep teardown manual — the value is *proving restorability*, not a perfectly automated pipeline
  nobody finishes. Never restore onto prod or the pilot.
- **Verify** (live E2E, writes to scratch only): a run restores + reports actual row counts; feeds the
  Phase 4 monthly cadence.
- **Complexity**: Medium

#### Step 2.10: Secondary drift/deadline workflows

- **Files**: n8n workflows `env-manifest-diff`, `auto-expose-deadline-reminder`; checked-in
  `docs/env-manifest.md` (var **names** only)
- **Action**: (a) **env-var manifest diff** — a checked-in manifest of expected env-var *names* per
  service vs a Render API export → alert on drift (the exact "silent missing var" class checklist B3
  is about; `.env.example` under-documents by ~17 vars). Names only, never values (`data-security`
  #3). (b) A **scheduled reminder** tied to the `auto_expose_new_tables` GRANT deadline of
  **2026-10-30** (`system-design` Tier 2: dated debts carry a date + trigger).
- **Test cases:** remove a required name from the manifest (or the Render export) → drift alert; in
  sync → quiet.
- **Verify**: an intentional mismatch fires exactly one alert; the deadline reminder is scheduled.
- **Complexity**: Small

---

### Phase 3 — CI/CD & Release Discipline

> GitHub Actions is the CI **system of record**. n8n only triggers deploy + smoke + notify, and only
> *after* the gate is green. Steps 3.1–3.3 are the hard prerequisite for the n8n release glue (3.8).

#### Step 3.1: GitHub Actions CI gate (the four documented gates)

- **Files**: `.github/workflows/ci.yml` (new)
- **Action**: On every PR/push: `actions/setup-node` + npm cache + `npm ci`, then run the exact
  gates `CLAUDE.md` already mandates locally — **`npm run lint` (eslint) → `npm run typecheck` (tsc
  --noEmit) → `npm test` (vitest run) → `npm run build` (tsc -p tsconfig.json)**. This is a
  mechanical wiring of the existing local gate, not a new one (the external research's ruff/mypy/
  pytest names are corrected to the real Node/TS toolchain per the research's Stack Correction).
  GitHub Actions is free for private repos to 2,000 min/mo — ample here.
- **Test cases:** a PR that fails lint/type/test/build → CI **red**; a clean PR → CI **green**.
- **Verify**: open a throwaway PR that breaks a type → the workflow fails on the typecheck job;
  fix → green.
- **Complexity**: Small

#### Step 3.2: Wire the 2-tenant leak test as a required job; add Dependabot + `npm audit`

- **Files**: `.github/workflows/ci.yml`, `.github/dependabot.yml` (new)
- **Action**: Add the Step 0.9 **2-tenant leak test** as a required CI job (red build blocks merge —
  forgetting a tenant filter fails a test, not reaches prod; `data-security` #1). Add Dependabot on
  the **`npm`** and **`github-actions`** ecosystems (weekly, auto-PR — ecosystem translated from the
  external doc's `pip`). Add an `npm audit` CI job as a second vuln signal (translated from
  `pip-audit`).
- **Open-question step:** verify whether Dependabot/CVE alerting is already enabled at the GitHub
  repo-settings level (invisible from the file tree).
- **Test cases:** leak-test regression → CI red; Dependabot opens a PR on a known-outdated dep.
- **Verify**: the leak-test job appears in required checks; a Dependabot PR appears within a week.
- **Complexity**: Small

#### Step 3.3: Confirm + configure branch protection on `main`

- **Files**: N/A (GitHub repo settings — verify on the **actual deploy repo** from Step 0.5 as well
  as `hhesecured-web/TradesDatabase`)
- **Action**: **Open-question step (verify first):** branch protection is documented only as a social
  rule; check the live setting via the GitHub API/settings. Then require PR + required status checks
  (the 3.1/3.2 jobs) green before merge to `main`. Trunk-based: short-lived branches, frequent merges.
- **Verify**: a direct push to `main` is rejected; a PR without green checks cannot merge.
- **Complexity**: Small

#### Step 3.4: Stand up a real staging environment

- **Files**: N/A (Supabase + Render dashboards); `render.yaml` optional
- **Action**: Create a **genuinely third** Supabase project (free tier) for staging — neither the
  mislabeled-"test" project (the live pilot DB) nor the empty/possibly-paused intended-prod project is
  a staging env today. Add **one lean shared staging web service** on Render (not a full duplicate of
  all 5 services — that doubles the bill) pointed at the staging Supabase. Use Render PR preview
  environments selectively, only when interactive verification is needed.
- **Open-question step:** confirm whether intended-prod `lzlgysoydhknsdvovntz` is paused + its org/
  tier before deciding to repurpose vs stand up new.
- **Verify**: the staging web service boots against the third Supabase project; the 2-tenant leak
  test can run against a hosted staging 2-tenant dataset (checklist Tier 2).
- **Complexity**: Medium

#### Step 3.5: Enforce migration-vs-deploy ordering (closes a CONFIRMED-RECURRING incident class — 2026-07-19 + 2026-08-15)

> **Elevated priority (2026-08-17):** this is no longer a one-off. Commit `cd8d904` records a
> **second** live incident — PR #148's merge made migrations mandatory *immediately*, and every
> 5-min lifecycle-cron run failed until they were applied (worse than 07-19: it silently degraded a
> metric while marking the whole job failed). Two incidents in ~4 weeks = a recurring class; treat
> this as high-priority and **consider pulling it forward** ahead of the rest of Phase 3 (its only
> hard dependency is the CI gate, Step 3.1). It also pairs with the deploy-provenance work in
> Phase 0 — both are "git ≠ what's live" failures.

- **Files**: `.github/workflows/ci.yml` job or n8n step; `scripts/check-pending-migrations.mjs` (new)
- **Action**: A CI/n8n step that **fails a release if pending `supabase/migrations/` files have not
  been applied first**. Encode the documented safe order **migrate → deploy →
  `NOTIFY pgrst, 'reload schema'`** (`system-design` Tier 2: the safe order fails noisily). Apply the
  expand/contract pattern (add-tolerant columns first, remove later — tool-agnostic). Document that
  migrations are **forward-only** — a code rollback must **never** be assumed to imply a safe schema
  rollback. **Audit applied-state by object existence, NOT by the `schema_migrations` table** —
  commit `ace27b2` proved that table under-reports (migrations applied via raw `execute_sql` leave no
  ledger row; it over-reported missing migrations by 5 of 7). The pending-check must diff actual DB
  objects, not trust the migration ledger.
- **Open-question step:** confirm whether MCP `apply_migration` supports `lock_timeout`/
  `statement_timeout` natively or they must be hand-added to the SQL.
- **Test cases:** a PR that adds a migration file but the deploy target hasn't applied it → guard
  **fails**; all-applied → passes.
- **Verify**: the guard blocks a deliberately-out-of-order release in a dry run.
- **Complexity**: Medium

#### Step 3.6: Rollback procedure (works within forward-only-schema reality)

- **Files**: `docs/runbooks/rollback.md` (new)
- **Action**: Document Render's built-in one-click rollback (which auto-disables autodeploy so a bad
  commit can't immediately redeploy itself) as the code-rollback path, gated on the expand/contract
  discipline. Explicitly state the schema caveat: no down-migrations exist; the only schema undo is
  PITR (if enabled per 0.3) or manual SQL correction. Include "confirm the live commit hash after
  rollback" (`system-design` Tier 3).
- **Verify**: a code-only rollback is exercised on **staging** (deploy a benign change, roll it back,
  confirm the live hash reverts).
- **Complexity**: Small

#### Step 3.7: Release checklist

- **Files**: `docs/runbooks/release-checklist.md` (new)
- **Action**: A short pre-release checklist: CI green on `main`; migrations applied (3.5 guard) +
  schema read-back verified; deploy the **latest** commit (not Render "Redeploy" of the old one) +
  confirm the live hash; rollout-class named (deploy-only / +gateway restart / +full box wire-pass —
  `system-design` Tier 1 #9); post-deploy smoke on `/health`; alerts confirmed firing.
- **Verify**: the checklist is used for one real release end-to-end.
- **Complexity**: Small

#### Step 3.8: n8n CI/CD glue — the capstone (HARD-GATED on 3.1–3.3)

- **Files**: n8n workflow `release-deploy`
- **Action**: `GitHub Actions success (branch==main, checks passed) → signature-gated webhook to n8n
  → n8n (a) performs/verifies the sync to whichever repo Render is actually connected to (Step 0.5),
  (b) calls the Render Deploy API pinning a specific commit SHA (closes "which commit is live"), (c)
  polls deploy status, (d) post-deploy smoke test against /health, (e) posts the resulting **live
  commit hash** to Telegram "deployed vX ✅ <SHA>"; on failure → alert + optional one-click
  rollback.` This is the repo-topology guardrail that closes both "Redeploy re-runs a stale commit"
  and "which repo is Render even watching" — without re-plumbing Render. It sits strictly **after**
  CI, never replaces it (n8n ≠ CI engine).
- **Verify** (live E2E on staging first): a merge to the staging branch drives an automated staging
  deploy; the Telegram message's SHA matches the actually-live commit (confirmed via Render
  dashboard, independent channel). Only after staging proves out is it enabled for prod.
- **Complexity**: Large

> **Phase 3 checkpoint:** CI gate green-required with the leak test; branch protection on; staging
> real; migration order enforced; rollback + release checklist written; release glue reports the true
> live SHA. Bad deploys are now caught before they ship, and every deploy's live commit is known.

---

### Phase 4 — Cross-cutting: Runbooks, Cutover Gate, Ops Cadence

#### Step 4.1: Incident-response runbook (bad-deploy + bad-migration as one drill)

- **Files**: `docs/runbooks/incident-response.md` (new)
- **Action**: A blameless incident runbook that combines the "bad deploy" and "bad (forward-only)
  migration" recovery paths into one exercised drill (checklist Tier 9). Point into the existing
  diagnosis recipes rather than duplicating: `engineering-memory.md §2` (model/inference stall
  recipe), `§5` ("the walls" — zombie seat, `web.fetch` masking a dead MCP, shields-lock,
  rebuild-destroys-device-key), and the checklist Tier 9 DR/rollback items. Name the "who responds
  first" primary and the shared Telegram alert channel.
- **Verify**: run the combined bad-deploy + bad-migration drill once on **staging** end-to-end;
  record it as exercised.
- **Complexity**: Medium

#### Step 4.2: Production-readiness cutover gate (extend the committed checklist)

- **Files**: `docs/prod-migration-checklist.md` (extend the Sign-off gate)
- **Action**: Fold the DevOps outcomes of Phases 0–3 into the checklist's existing B1/B2/B3 +
  Sign-off gate so cutover has one authoritative go/no-go: RLS deny-all applied + advisor clear +
  leak test green (B1); prod schema applied + read-back verified + deny-all on prod + PITR decision +
  restore drill + services repointed + roster decision (B2); config validator (checklist B3 Fix #1)
  + fail-closed flags (Fix #4) + loud cron skips (Fix #2) + active canary (Fix #3); CI green; backups
  + freshness + monitoring confirmed firing (break-test one).
- **Open-question step:** confirm the phone-call feature (`calls-worker`/`calls-purge`) prod-deploy +
  cron wiring + provisioned `call_numbers` row status before cutover.
- **Verify**: every Sign-off-gate box is checkable with the automation from Phases 0–3 in place.
- **Complexity**: Small

#### Step 4.3: Daily / weekly / monthly ops cadence

- **Files**: `docs/runbooks/ops-cadence.md` (new)
- **Action**: Right-sized, low-maintenance cadence for 2–3 people:
  - **Daily:** glance the shared Telegram alert channel; triage any ops_events / cost / health /
    backup-freshness alert.
  - **Weekly:** review + merge Dependabot PRs; review the cost trend (`/admin` + ledger) for
    day-over-day anomalies; confirm the external dead-man's-switch is green.
  - **Monthly:** run the restore-drill workflow (2.9) and record pass + measured RTO; take/verify a
    Lightsail snapshot; review RLS/access + MFA on the four crown-jewel consoles (AWS, Render,
    Supabase, GitHub); check the `auto_expose_new_tables` deadline (2026-10-30) status.
  - Skip formal SLO/error-budget tooling; informal ~99% uptime target.
- **Verify**: the cadence doc exists and the first monthly cycle is executed.
- **Complexity**: Small

#### Step 4.4: Lightsail automatic daily snapshots + snapshot-after-config-change reminder

- **Files**: n8n workflow `lightsail-snapshot-reminder`; AWS Lightsail setting
- **Action**: Enable Lightsail **automatic daily snapshots** (tool-agnostic AWS feature). Add an n8n
  reminder tied to merged PRs touching `Box_Setup_Stuff/` to re-snapshot after box config changes
  (config drift since the last manual snapshot is otherwise lost). Snapshots contain secrets — handle
  per `data-security` #3.
- **Verify**: Lightsail shows automatic daily snapshots enabled; a PR touching `Box_Setup_Stuff/`
  triggers the reminder.
- **Complexity**: Small

---

## Test Strategy

Per `verifying-behavior`: default to codified tests, use live E2E only where the signal is objective
and cross-channel-checkable, hand genuinely-human checks to a person. All writes → local Docker
stack or scratch; the hosted pilot DB is read-back only.

### Automated Tests

| Test Case | Type | Input | Expected Output |
|---|---|---|---|
| App path unaffected by deny-all RLS | Integration (local stack) | `npm test` after RLS migration | All green (service_role bypasses RLS) |
| Anon-key locked out of business tables | Live read-back (pilot, read-only) | anon-key GET `customers`/`jobs`/`raw_captures` | 0 rows / 401 |
| RLS advisor cleared | Live read-back | `get_advisors` on pilot | "RLS disabled" advisory gone |
| 2-tenant leak test | Integration (local/staging) | act as tenant A, read/write B | All denied; new unfiltered table → red |
| Identity forgery rejected | Integration | tamper `x-tenant-id` without re-HMAC | Rejected |
| `/health` shallow | Unit (mocked) | DB+provider reachable / DB down / provider down | 200 / 503 / 503 |
| `/health` deep canary | Live E2E (staging) | forced tiny completion | 200 on success, 503 on stall |
| ops_events notifier | Integration + live E2E | insert open row / flip closed_at (local) | Telegram "opened" / "resolved", one per transition |
| Inference watchdog (provider-agnostic) | Integration (mocked) | low balance / cost spike / invalid-or-suspended credential | Telegram alert; normal + valid key → quiet |
| Cost-pull into existing ledger | Integration (local) + cross-channel read-back | dry-run vendor pull | priced row in `infra_costs`; idempotent re-run inserts nothing |
| pg_dump→S3 | Live E2E | run backup | non-zero dated S3 object + sha256 log; 0-byte → loud alert |
| Backup freshness (independent) | Integration | newest object >25h / empty bucket | alert fires regardless of backup job state |
| Migration-order guard | CI job | PR with unapplied migration | release blocked |
| CI gate | CI | PR breaking lint/type/test/build | red; clean → green |
| Dead-man's-switch (n8n) | Live E2E | stop heartbeat workflow | external monitor alerts within grace window |

### Manual / Human Verification

- [ ] Supabase plan tier + daily backup enablement (dashboard) — Step 0.2.
- [ ] Restore drill: actual row counts + measured RTO on a scratch env — Step 0.4 / 2.9.
- [ ] Deploy-repo identity + live commit SHA stated by a human with Render access — Step 0.5.
- [ ] n8n editor UI unreachable from a non-allowlisted IP; TLS valid — Step 1.3.
- [ ] Branch protection rejects a direct push to `main` — Step 3.3.
- [ ] Release glue's Telegram SHA matches the live commit (independent Render-dashboard check) — 3.8.
- [ ] One combined bad-deploy + bad-migration drill on staging — Step 4.1.

---

## Open Questions — Verify at Implementation Time (carried from the research doc)

Each is attached to the step that consumes it; none may be assumed:

1. **Live pilot Supabase plan tier (Free/Pro/higher)** — *most urgent single fact.* → Step 0.2.
2. **PITR timing** — explicit team RPO decision, not a default. → Step 0.3.
3. **Which repo Render actually deploys from** — needs Render dashboard access. → Step 0.5.
4. **GitHub branch protection actual state on `main`.** → Step 3.3.
5. **Whether intended-prod `lzlgysoydhknsdvovntz` is paused + its org/tier.** → Step 3.4.
6. **Render webhook plan-gating** (single-sourced) — before any webhook-dependent flow. → Step 2.5.
7. **DeepInfra spend-limit UI/API mechanics** (single-sourced/unverified) — prefer the code-grounded
   puller. → Step 2.2.
8. **Supabase Management API for programmatic backup-freshness listing.** → Step 2.8.
9. **Whether MCP `apply_migration` supports `lock_timeout`/`statement_timeout`** natively or they
   must be hand-added to the SQL. → Steps 0.8 / 3.5.
10. **Dependabot/CVE alerting current enable state** at repo-settings level. → Step 3.2.
11. **Lifecycle cron cadence `*/5` vs `*/15`** — code vs Render dashboard drift. → Step 4.2 / ops cadence.
12. **Phone-call feature (`calls-worker`/`calls-purge`) prod-deploy + cron + `call_numbers` status.**
    → Step 4.2.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| RLS deny-all breaks the app if any path doesn't use service_role | Outage / lockout | Local `npm test` stays green **first** (0.7); apply via MCP `apply_migration` + read-back verify (0.8); keep existing `.eq('tenant_id')` filters as backstop; MODEL of the exact pattern already proven on cost tables |
| n8n compromised → all credentials decrypted at once | Catastrophic, cross-vendor | Phase 1 hardening is a hard prerequisite: pinned patched version, isolated Postgres, non-public editor, external mode task runners, least-privilege creds, encryption key backed up separately |
| n8n itself hangs → all monitoring goes silent | Undetected outages | External dead-man's-switch (1.5) built **before** any monitoring workflow; independent backup-freshness check (2.8) decoupled from the backup job |
| Migration applied out of order vs deploy | PostgREST "unknown column" (already happened 2026-07-19) | Enforce migrate→deploy→NOTIFY via CI/n8n guard (3.5); expand/contract; forward-only caveat documented |
| Stale-commit deploy | Old code live (already happened) | Deploy latest commit + confirm live hash (0.5, 3.7); n8n glue pins + reports the SHA (3.8) |
| Backup exists but is unrestorable | False confidence, real data loss | Real restore drill now (0.4) + monthly (2.9); size sanity + freshness checks (2.7/2.8) |
| Verification writes hit the live pilot DB | Real lockout (roster truncation precedent 2026-07-03) | `verifying-behavior` §1: writes only to local Docker/scratch; pilot is read-back only; maker≠checker |
| Backup DB credential stored in n8n widens blast radius | Larger credential exposure | Read-only, backup-scoped Postgres role only; never the service-role key (2.7, `data-security` #3) |
| Secrets pasted into docs/logs/n8n | Leak → full rotation (2026-07-03 precedent) | Fingerprints only; names-not-values in the env manifest (2.10); encryption key referenced by fingerprint |
| Cost of adding tiers (Supabase Pro, PITR, monitors) | Budget pressure at pilot scale | Right-sized: Supabase Pro $25/mo floor; PITR deferred to an explicit decision; monitors/Sentry/GitHub Actions/S3 all on free tiers or ~$0 marginal |

## Rollback Strategy

- **RLS migration (0.7/0.8):** if the anon-lockout inadvertently affects an app path, the escape
  hatch is a single `ALTER TABLE … DISABLE ROW LEVEL SECURITY` on the affected table (service_role is
  unaffected by design, so this should not be needed — but it is a one-statement reversal). Reversible
  escape hatch per `system-design` Tier 1 #10.
- **Code/deploys (Phases 2–3):** Render one-click rollback (auto-disables autodeploy); confirm the
  reverted live hash. **Schema is forward-only** — a code rollback does **not** undo a migration; the
  only schema undo is PITR (0.3) or manual SQL correction (documented in `docs/runbooks/rollback.md`,
  Step 3.6).
- **n8n (Phase 1):** workflows/creds are backed up (1.6); a bad n8n change is reverted by re-importing
  the last good export; the box itself is recoverable from a Lightsail snapshot (4.4).
- **Everything in Phases 2–4 is additive** (new workflows, new CI, new docs) — disabling a workflow
  or reverting a `.github/` file fully removes it with no data impact.

## Status

- [ ] Plan approved
- [ ] Baseline `origin/main` HEAD SHA recorded (Step 0.1)
- [ ] Implementation started
- [ ] Phase 0 complete (criticals closed)
- [ ] Phase 1 complete (n8n hardened)
- [ ] Phase 2 complete (automation workflows)
- [ ] Phase 3 complete (CI/CD & release discipline)
- [ ] Phase 4 complete (runbooks, cutover gate, cadence)
- [ ] Implementation complete

---

*Source of truth: `thoughts/shared/research/2026-08-17-prod-devops-research.md`. Governed by the
`system-design`, `data-security`, and `verifying-behavior` skills. Planning methodology:
`rpikit:writing-plans`. This plan is a contract — review and approve before any `/implement`.*
