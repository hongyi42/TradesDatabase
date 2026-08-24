# Research: Production DevOps readiness — current deployment & ops state (2026-08-17)

## Problem Statement

Harden HVAC-Nemoclaw / TradesDatabase for a production cutover with standard DevOps practices —
monitoring/alerting, CI/CD & release flow, cost & security ops, backups & disaster recovery —
automated where possible via n8n. This document is the **current-state research** that a
hardening plan should be built on: what exists today, where the gaps are, and what's ambiguous
enough to need a live check before anyone plans against it.

## Critical caveat: the local checkout is stale — findings are grounded in `origin/main`

The working tree at `C:\Users\yuuta\Documents\HVAC-Nemoclaw\TradesDatabase` is checked out on
`feat/phone-call-capture` @ `530efe3` (2026-08-10), which is **160 commits behind**
`origin/main` @ `8ef1e68` (2026-08-17 — **today**). Reading only the working tree would have
missed an entire shipped monitoring feature (`ops_events` / `/control/ops`), a safety-relevant
change to the inference failover, a rewritten cron cadence, and ~12 new migrations. Every finding
below is sourced from `origin/main` via `git show`/`git log` (not the stale working copy), and is
cited as such. **Treat the working-tree files as out of date** — if you open
`TradesDatabase/docs/engineering-memory.md` directly in an editor you will see the 2026-07-31
version, not today's.

This staleness is itself a DevOps finding: nothing enforces that a working checkout — or, by the
same mechanism, whatever Render's separately-synced deploy repo currently holds — matches
`origin/main`. See **CI/CD gap #1**.

## Requirements (from the task)

Document, per DevOps area, current state + gaps: monitoring & alerting, CI/CD & release flow,
cost & security ops, backups & recovery. Also capture stack/runtimes, exact deployable services
and where each runs, and existing automation (cron/scheduled workers). Flag ambiguity rather than
guess. Feed a hardening effort that will be automated via **n8n**.

---

## System overview

**Stack:** TypeScript (Node, ESM `"type":"module"`/`NodeNext`), Vitest, ESLint, raw Node `http`
(no Express) for the server, `@supabase/supabase-js` (service-role key only, no ORM),
`@modelcontextprotocol/sdk` (MCP), `@composio/core`, `@anthropic-ai/sdk` (kept as a provider
fallback path), `googleapis`/`google-auth-library`. Package manifest:
`TradesDatabase/package.json` (`git show origin/main:package.json`).

**Deployable services and where each runs today:**

| Service | Entry point | Runs on | Purpose |
|---|---|---|---|
| Web | `npm run mcp:serve:http` → `src/mcp/httpServer.ts` `main()` | Render web service (`tradesdatabase.onrender.com`) | Spine MCP over HTTP, inbound email/phone webhooks, `/composio` relay, `/board`, `/admin`, `/control/badges`, `/control/sandboxes`, `/control/ops` |
| Board notification worker | `npm run board:worker` → `src/telegram/boardWorker.ts` | Render background worker | Pushes dispatch-board notifications to Telegram (digested) |
| Lifecycle cron | `npm run job:lifecycle` → `src/jobs/lifecycle.ts` | Render Cron Job | Roster/pairing lifecycle, cost backfill+rollup, Stage-0 watcher (see below) |
| Phone-call worker | `npm run calls:worker` → `src/calls/runWorker.ts` | **Code-complete; deploy status unconfirmed** | Drains `call_ingest` queue: download → AssemblyAI → redact → `recordFieldNote` |
| Phone-call purge | `npm run calls:purge` → `src/calls/purgeAudio.ts` | **Code-complete; deploy status unconfirmed** | Deletes expired call audio (Supabase Storage has no native TTL) |
| stdio MCP | `npm run mcp:serve` | Dev/local only, not deployed | — |
| Doorman | `Box_Setup_Stuff/doorman.mjs` | systemd on `trades-box-1` (AWS Lightsail, `34.211.61.184`) | Badge → signed-identity translator between sandboxes and Render |
| Per-person agent sandboxes | NemoClaw/OpenClaw containers (s2, s3, s5, s7, s8, …) | Docker on `trades-box-1` | One Telegram bot per manager/technician |

Source: `thoughts/shared/research/2026-07-30-testing-to-production-fork.md` (Entry Points table,
still accurate on `origin/main`), cross-checked against `origin/main:package.json` and
`origin/main:src/mcp/httpServer.ts`.

**Phone-call feature deploy status — flagged ambiguous, verify live.** The plan doc
(`thoughts/shared/plans/2026-08-04-phone-call-signalwire.md`, header) states as of 2026-08-06:
*"IMPLEMENTED (all 4 phases) … **NOT committed, NOT deployed**"* and its Phase-4 manual-check box
is unticked: *"confirm `calls:worker` + `calls:purge` cron schedules are live in the deploy env
— **DEFERRED: needs the deploy (Render Cron / pg_cron) — not reachable from local**."* The code
is merged into `origin/main` today (migration `20260804120000_phone_call_ingest.sql` present,
`calls:worker`/`calls:purge` scripts in `package.json`), but current `engineering-memory.md`
(2103 lines, checked 2026-08-17) contains **no entry recording an actual Render deploy or a live
SignalWire number provisioned**. Given this repo's own doctrine ("trust live probes over
docs" — `docs/onboarding.md` §11), **do not assume the phone channel is live in production
without checking the Render dashboard for a `calls-worker`/`calls-purge` service and
`call_numbers` rows on the pilot DB.**

**Existing scheduled/automated jobs today:**

| Job | Cadence | What it does |
|---|---|---|
| Lifecycle cron (`src/jobs/lifecycle.ts`) | Render dashboard schedule (code now targets `*/5`; **the Render dashboard setting itself is still `*/15` as of the last recorded check — a code/config drift, see below**) | Pairing sweep, grace-period offboarding, Composio session provisioning, execution-log ingestion, Brave cost backfill, cost rollup, DeepInfra bill pull, **Stage-0 watcher** (overdue-visit gap detection, gated by `WATCHERS_MODE` env: unset=skipped / `shadow`=count-only / `live`=review items + manager push) |
| `nemoclaw-inference-medic.timer` | Every 5 min (systemd, on `trades-box-1`) | Asserts the GLM-5.2/DeepInfra inference route is actually serving turns (not just reachable) — **as of medic v5 (2026-08-13) it asserts and reports only; it no longer fails over to NVIDIA** (the automatic failover was deliberately deleted — see Monitoring §, below) |
| `sandbox-token-medic.service` | Boot-time (systemd) | Re-mints expired OpenShell sandbox tokens before agent revive |
| `sandbox-recycler.service` | Event-driven (kicked by badge-pull whenever the retirement queue is non-empty) | Destroys retired sandboxes, provisions fresh cold blanks |
| `badge-pull.sh` | Every 5 min (systemd timer on the box) | Host pulls `GET /control/badges` from Render; also carries `ops-report.sh`'s credentials |
| `ops-report.sh` | Triggered by the medic's `OnFailure=`/`OnSuccess=` (systemd) | **New 2026-08-12/13** — POSTs box health verdicts to `POST /control/ops` on Render (see Monitoring §) |

Sources: `docs/control-plane.md` (current, `origin/main`), `Box_Setup_Stuff/*.service`/`*.timer`
(current, `origin/main`), `docs/engineering-memory.md` lines 680–800 (`origin/main`, current).

---

## 1. Monitoring & alerting

### Current state

- **No application health-check endpoint.** `src/mcp/httpServer.ts`'s route dispatch (read in
  full, `origin/main`) has no `/health`/`/healthz`/`/status` route. Render's liveness signal for
  the web service is presumably just "process is listening on `PORT`" — there is no route that
  exercises the DB connection, the model provider, or any dependency.
- **No error tracking / APM.** Grepped `src/` for `sentry|winston|pino|bunyan|datadog|honeycomb` —
  zero hits. All logging is bare `console.log`/`console.error` to stdout, captured only by
  Render's own log viewer (no aggregation, search, or alert rules on it).
- **No uptime/synthetic monitoring service** (no UptimeRobot/Pingdom/etc. evidenced anywhere).
- **Box-side "monitoring" today is entirely self-healing, not alerting.** The systemd timers
  above (medic, token-medic, recycler) detect and *fix* drift; none of them, before 2026-08-12,
  told any human anything. This was a real, recorded, recurring incident class:
  - **DeepInfra balance running out** happened 2026-07-11, 2026-07-20, 2026-07-31, **and again
    2026-08-14** — each time the medic silently failed over (pre-v5) or held the route (v5+) and
    "nothing alerts on it" (`docs/engineering-memory.md`, current). On 2026-08-14 the trigger was
    the repo's *own* eval harness sharing the same DeepInfra balance as the production fleet —
    *"a heavy eval day can take the pilot's agents down."*
    **[Update 2026-08-17, post-research]:** the production inference route is **no longer
    DeepInfra** — `docs/engineering-memory.md` (current `origin/main`, pre-existing content, not
    one of the inspected commits) records the fleet switched to **Fireworks FAST**
    (`fireworks-prod / accounts/fireworks/routers/glm-5p2-fast`) on 2026-08-15, with DeepInfra
    demoted to the manual-rollback route; Fireworks then had its own suspension incident the same
    day (a monthly spend-cap trip, HTTP 412, ~35 min outage) — same underlying gap (no
    balance/spend alarm), different vendor and different failure shape (a hard cap, not a
    prepaid-balance drain). Separately, commit **f25bf7b** (2026-08-17, `docs/control-plane.md` +
    `docs/engineering-memory.md`) adds a related but distinct finding for the same "presence ≠
    health" gap: `hasModelCredentials()` is a presence-only check, so a stale/suspended
    `INFERENCE_API_KEY` does not skip — it burns 3 compose attempts per gap before landing in the
    manager queue as "compose failed 3x," and the pilot's cron showed **zero model usage since
    2026-08-15 18:13**, "consistent with the parked Fireworks suspension." This does not
    contradict the gap below (no balance alarm exists, for any provider) — it sharpens it: the
    live risk today is Fireworks-cap/key-validity, not literally "DeepInfra balance," and as of
    this update it may be an *active*, unresolved instance rather than only historical.
  - **medic v4 finding (2026-08-12):** the old health probe (`{"content":"hi"}`, 1 token, no
    tools) reported healthy while `nvidia-prod` 400'd every real agent turn — **6 full outage
    windows on 2026-08-12 alone**, each ~4 minutes, invisible because "the journal said success."
  - **medic v5 (2026-08-12, user decision):** the automatic NVIDIA failover was **deleted
    entirely** — it had been silently promoted from a manual break-glass rollback to a live
    safety net with nobody deciding that, and it was itself unhealthy. As of 2026-08-13 19:54:23Z
    the fleet is **single-provider (DeepInfra) with no automatic failover** — a DeepInfra outage
    now stops all agents rather than degrading to a worse provider. Deploy verified by md5 of the
    actually-running script (`ae3787ed0ccf08485de26cde8f114b3f`), not a sibling copy.
- **New 2026-08-12/13 — an incident store now exists, and is explicitly documented as NOT an
  alarm.** `POST /control/ops` (`src/mcp/httpServer.ts`, `origin/main` line 531) → `ops_events`
  table (`supabase/migrations/20260813000000_ops_events.sql`) → `src/db/opsEvents.ts`
  (`recordOpsEvent`, transition-only: one row per incident, not per 5-min tick, via a partial
  unique index `where closed_at is null`). Fed by `Box_Setup_Stuff/ops-report.sh`, wired to the
  medic's `OnFailure=`/`OnSuccess=`; auth reuses the existing host-token pattern (no new secret);
  fire-and-forget with a 5s timeout so a broken collector can never mark the medic failed. The
  plan doc (`thoughts/shared/plans/2026-08-12-ops-alerting-render.md`) states the scope decision
  in plain language: *"Scope per user decision: Render only, transition-only, Telegram deferred
  until a bot is paired… this makes it a **STORE, not an ALARM**."* Confirmed again in
  engineering-memory: *"**STILL A STORE, NOT AN ALARM.** Nothing notifies yet — deferred by user
  decision until a bot is paired."* Real-world proof this gap still bites: the 2026-08-14
  balance-out produced **three outage windows correctly recorded in `ops_events` — "silently,
  because the Phase-4 notifier doesn't exist yet."**
  - Phase 4 (the notifier: on OPEN and CLOSE, post to Telegram) is explicitly deferred, scoped as
    "one function," and is the natural place to plug in n8n instead of a hand-rolled notifier.
  - **No dead-man's switch.** If the box goes fully dark it simply stops reporting; silence today
    is indistinguishable from health. Sketched but not built (same plan doc, "Deferred" section):
    a Render-side cron asking "has each host reported in the last 15 minutes?"
- **Cost dashboard (`/admin`) is a pull surface, not an alert.** Bearer-token gated, RLS-backed
  (`src/admin/adminApi.ts`), shows per-tenant vendor spend — but nobody is paged on a spend
  anomaly or a metered-vendor crossing its price tier. `docs/phone-call-runbook.md` explicitly
  flags this as open: *"add a crossover alert if spend can grow"* for SignalWire/AssemblyAI.
- **Lifecycle cron cadence drift, live right now:** code merged 2026-08-16 targets `*/5`
  (with a cadence gate so heavy sweeps still only run on quarter-hour ticks), but *"the Render
  schedule itself is a dashboard setting flipped at the watcher rollout — **until that flip the
  cron still fires `*/15`**"* (`docs/control-plane.md`, current). This is a live example of the
  general "no IaC" problem below: a documented, merged code change has a Render dashboard
  counterpart that may or may not have been clicked.

### Gaps (ranked)

1. **No alerting channel at all for infra incidents** — `ops_events` is populated but nothing
   reads it and pages a human. This is the single highest-leverage, lowest-effort n8n target: a
   scheduled n8n workflow polling `ops_events` (or a webhook receiver in front of
   `/control/ops`) can close the documented Phase-4 gap without touching the box.
2. **No DeepInfra balance alarm / auto-top-up**, despite four recorded outages from the same
   cause. A 1-token completion probe is cited in the repo's own docs as the cheap check
   (`openshell inference set … --provider deepinfra-prod …`; a 402 body names the cause) — an
   n8n scheduled HTTP-request workflow could run this and alert before balance hits zero.
   **[Update 2026-08-17]:** generalize this gap — the live production provider is now Fireworks
   (switched 2026-08-15, see the annotated note above), which fails via a monthly spend-cap 412
   rather than a 402 balance-drain, and commit f25bf7b additionally documents a credential-validity
   variant of the same "nothing alarms on it" gap (a present-but-suspended key burns retries
   silently instead of skipping). The fix should watch provider health/spend generically, not
   DeepInfra specifically.
3. **No application health endpoint to monitor.** Any external uptime check (including one built
   in n8n) currently has nothing better to hit than the bare TCP port. Recommend a minimal
   `/health` route (DB round-trip + model-provider reachability) before wiring canaries.
4. **No dead-man's switch** for the box itself going dark.
5. **No cost/spend anomaly alerting**, and metered vendors with unbounded exposure (Brave,
   Composio overage, SignalWire, AssemblyAI) have no threshold alarm.
6. **No error tracking / APM** — failures are only visible by reading Render's raw log stream.

---

## 2. CI/CD & release flow

### Current state

- **There is no CI configuration anywhere in the repository** — confirmed on `origin/main`: no
  `.github/` directory, no other `*.yml`/`*.yaml` workflow files, no `Dockerfile`, no `Procfile`,
  no `render.yaml`. `git ls-tree -r origin/main` root listing has none of these.
- **Render deploys from a *different, separately-synced* repository, not this GitHub repo.**
  Documented in three independent places (`HANDOFF.md:69-72`, `docs/onboarding.md` §10,
  `thoughts/shared/research/2026-07-30-testing-to-production-fork.md` line 109-122): *"merging to
  the dev repo's `main` does **not** move production. Someone must sync that repo first, then
  Render → 'deploy latest commit'."* The research doc lists the target repo's identity as an
  **open question** ("What is the separate Render-connected repo (name/owner)… not recorded in
  the repo"). This is a real, unmitigated single point of manual failure in the release path.
- **Render's "Redeploy" button re-runs the OLD commit** — a documented, already-happened
  incident class (an 18-commit-stale build went live once; HANDOFF.md, engineering-memory). The
  correct action, "deploy latest commit" + confirm the live commit hash in the dashboard, is
  pure tribal knowledge with no tooling enforcing it.
- **No automated test/lint/typecheck gate runs anywhere except a developer's own machine.** The
  four gates (`npm run typecheck && npm run lint && npm test && npm run build`) are documented in
  `CLAUDE.md` as mandatory "before any commit," but nothing enforces them — no CI, no git
  pre-commit/pre-push hook (`find … -iname "*husky*"` and a `package.json` grep for
  `husky|precommit` both came back empty). Compliance depends entirely on the operator (human or
  agent) actually running and reading the output, which `CLAUDE.md` itself has to explicitly
  demand ("show the actual command output — never assert success without it").
- **PR-before-`main` is a written social rule, not a branch-protection setting.**
  `docs/engineering-memory.md` §1: *"Every code change goes through a PR before `main`… 'You may
  commit' authorizes a commit, **not** a push… enforced socially, not by tooling."* Whether
  GitHub branch protection is actually configured on `hhesecured-web/TradesDatabase` could not be
  verified from the repo contents alone — **flagged for a live check** (`gh api
  repos/.../branches/main/protection` or the GitHub UI).
- **DB migrations are entirely decoupled from deploy.** Render only builds+starts the Node
  process; nothing applies Supabase migrations automatically. The pilot's actual practice is
  Supabase MCP `apply_migration` (not `db push`, which is unreliable — the pilot's migration
  ledger has drifted from repo filenames because MCP applies stamp apply-time versions, not the
  filename timestamp). The documented safe order is **migrate → deploy → `NOTIFY pgrst, 'reload
  schema'`**; getting it backwards ("deploy-before-migration") has happened live (2026-07-19) and
  fails *safely but noisily* (PostgREST "unknown column" errors) rather than silently — but only
  because of luck in that particular failure mode, not a designed guarantee.
  **[Update 2026-08-17, post-research — commit cd8d904]:** a **second, sharper** live incident of
  this exact gap, now named as a trap: *"MERGING Stage 1 makes its migrations MANDATORY
  IMMEDIATELY, not at flip time."* PR #148 merged and deployed (`8ef1e68`) before the pilot had
  the corresponding migrations; an un-gated pre-filter read in the lifecycle watcher threw for
  every tenant, tripping the systemic-failure detector (`tenantErrors === tenants` ⇒ `ok=false`)
  — **every 5-minute cron run was marked FAILED** until the migrations were applied hours later
  (resolved same day). This is a materially worse failure mode than the 2026-07-19 incident (that
  one failed loudly on a single code path; this one silently degraded a metric — `gapsFound` kept
  incrementing after the point of failure — while marking the whole cron job failed). Also
  separately recorded (commit cd8d904, later applied per **ace27b2**): PR #146's migrations
  (`money_events`, `tenant_profiles`) sat unapplied on the pilot for a stretch after merge, same
  "merge != migrated" class — applied 2026-08-17.
  **[Update 2026-08-17 — commit ace27b2]:** the "migration ledger has drifted from repo filenames"
  claim above is confirmed but needs a sharper caveat — comparing repo filenames against
  `supabase_migrations.schema_migrations` **over-reported missing migrations by 5** (7 apparent
  vs. 2 actually missing), because 5 migrations had been applied directly via `execute_sql`, which
  writes no migration-table record at all. New documented rule: **audit the pilot by object
  existence (`information_schema`/`pg_roles`/`pg_proc`), never by the migration table** — the
  table is not a reliable inventory, not merely a renamed one.
- **No staging environment in the normal sense.** The Supabase project literally named "test"
  (`daqapdlkgxfrhquacprv`) is the **live pilot production database** — the repo's single most
  repeated trap. The project actually intended as prod (`lzlgysoydhknsdvovntz`) is empty,
  possibly auto-paused (Supabase free-tier idle behavior, unverified/observed twice as a DB
  timeout during research), and its Supabase MCP connection is configured **read-only** —
  reconfiguring that is itself a manual step nobody has done yet.
- **Rollout classification is entirely manual, per change, by the developer's judgment.**
  `docs/onboarding.md` §10 encodes a table of "what a change needs" (deploy-only / deploy +
  gateway-restart-per-tier / deploy + full box wire-pass) — there's no static check that infers
  this from a diff; getting it wrong either ships a stale fleet or forces needless restarts, and
  both have happened.
- **Working-tree/branch drift is real and currently observed**, as noted at the top of this
  document — the checked-out branch was 160 commits behind `origin/main`.

### Gaps (ranked)

1. **No CI at all.** Nothing runs typecheck/lint/test/build automatically on push or PR. This is
   the standard first fix (GitHub Actions or equivalent) and is a prerequisite for any
   n8n-driven release automation to have something trustworthy to trigger off of.
2. **The Render-deploys-a-separate-repo indirection** is the single biggest structural release
   risk: it means `origin/main` being "correct" says nothing about what's live. Either eliminate
   the indirection (point Render directly at this repo) or, short of that, an n8n workflow
   triggered on push-to-main that (a) performs/verifies the sync to the deploy repo and (b) calls
   the Render API to deploy the latest commit and posts the resulting live commit hash somewhere
   visible — directly closes the "Redeploy re-runs stale commit" and "which repo is Render even
   watching" failure classes.
3. **No branch protection confirmed.** Verify live; if absent, this is a cheap GitHub-native fix,
   not an n8n one.
4. **No migration-vs-deploy ordering enforcement.** An n8n (or CI) step that fails a release if
   pending migrations aren't applied first would close a documented, already-triggered incident
   class. **[Update 2026-08-17 — commit cd8d904]:** this class triggered again the same day this
   research was written (PR #148 merge → every lifecycle cron run failing until the migration was
   applied) — see the annotated note in the Current-state section above. Raise this gap's
   effective priority: two independent live incidents now (2026-07-19, 2026-08-17), not one.
5. **No automated rollback.** No scripted "redeploy previous known-good commit" or "revert last
   migration" path exists; recovery today is entirely manual and undocumented outside the
   uncommitted `docs/prod-migration-checklist.md` (see Backups § below for its status).

---

## 3. Cost & security ops

### Current state — cost

- **Cost-ledger design is solid and already shipped**: `cost_events` (units, never dollars) +
  `cost_rates` (versioned by effective date) + `infra_costs` (flat monthly bills, allocation
  rule) + `cost_rollup_monthly` (the only thing `/admin` reads). Schema:
  `supabase/migrations/20260725120000_cost_ledger.sql`. Driven by the lifecycle cron's Brave
  backfill + rollup steps; RLS-protected (migration `20260725140000`); `/admin` is bearer-token
  gated (`ADMIN_DASHBOARD_TOKEN`, unset ⇒ 503 fail-closed).
- **The largest cost line (inference) is still hand-entered.** `infra_costs` has no automated
  vendor-billing collector for most providers except an optional DeepInfra usage puller
  (`DEEPINFRA_BILLING_API_KEY`, falls back to `INFERENCE_API_KEY`). Lightsail/Render/Supabase
  bills are entered manually via SQL/`upsertInfraCost` — no UI, no automation.
  (`HANDOFF.md`, "Still open — operational, not code" §1-2, still true on `origin/main`.)
  Phone-call vendors (SignalWire, AssemblyAI) are the same shape — metered per-minute, no dollar
  API, counter+bill-driven, and explicitly flagged as needing a spend-crossover alert that
  doesn't exist yet (`docs/phone-call-runbook.md`).
- **No budget alarms of any kind** — confirmed by the DeepInfra-balance incident history above,
  which is fundamentally a cost-ops gap wearing a monitoring hat: nothing watches vendor account
  balance/spend rate and warns before it becomes an outage.
- **Shared-balance blast radius, newly discovered (2026-08-14):** the repo's own eval/test
  harness draws from the *same* DeepInfra account as production. There is no cost isolation
  between "dev/test spend" and "production spend" for this vendor.

### Current state — secrets & access

- **No secrets manager.** Credentials live as: (a) Render dashboard env vars, entered as **bare
  values** with no quoting convention (a documented trap: `GOOGLE_ROUTES_SA_KEY_JSON` must be
  pasted as raw one-line JSON, no wrapping quotes); (b) box-side plaintext files
  (`/etc/doorman/doorman.env`, `/etc/doorman/badge-pull.env`, `0600 root:root`); (c) `.env`/
  `.env.test`, git-ignored locally. No AWS Secrets Manager, Vault, or equivalent anywhere in the
  stack.
- **`.env.example` under-documents the real deployed environment.** Confirmed still true on
  `origin/main` (119 lines): the 2026-07-30 research doc lists ~17 vars the live Render services
  actually carry that the template doesn't mention (`BOARD_BOT_TOKEN`, `BOARD_PUBLIC_URL`,
  `GOOGLE_MAPS_API_KEY`, `GOOGLE_ROUTES_SA_KEY_JSON`, `COMPOSIO_RELAY_API_KEY`,
  `DEEPINFRA_BILLING_API_KEY`, `WATCHERS_MODE`, and more). **The full deployed env exists only in
  the Render dashboard** — no export, no source of truth in the repo.
- **Access control (app-level) is real and reasonably well-designed**: two tiers
  (manager/technician) enforced server-side via per-person Composio session scoping + doorman
  badge tier, never client-trusted. Badges are individually revocable, fingerprint-logged
  (sha256) rather than plaintext, and the Composio master key / `GATEWAY_IDENTITY_SECRET` are
  architecturally barred from ever reaching a sandbox (the badge is a proxy token, not the real
  secret) — this custody rule exists *because* a 2026-07-03 plaintext-badge leak forced a full
  rotation.
- **Database-level access control is the single largest, explicitly-documented open security
  gap.** RLS is **off** on every core business table (`customers`, `jobs`, `visits`,
  `raw_captures`, etc.) — only the 4 cost tables (2026-07-25) and the 2 phone-call tables
  (2026-08-04) have had a deny-all RLS retrofit, each migration's own comment naming this as
  paying down a slice of a known debt. The app always connects with the Supabase **service_role**
  key, which bypasses RLS by design, so tenant isolation today rests entirely on a hand-written
  `.eq('tenant_id', …)` filter in every DB accessor — *"one miss = a silent cross-tenant leak"*
  (repo's own words, both in `docs/prod-migration-checklist.md` and in
  `thoughts/shared/research/2026-07-30-testing-to-production-fork.md` point 10, which further
  notes the Supabase advisor already flags this **critically**, and that the project's anon key —
  which every Supabase project has — could read/write these tables directly if it were ever
  exposed; today's only mitigation is that the anon key is never distributed).
- **A dated debt with a real deadline:** `auto_expose_new_tables = true`
  (`supabase/config.toml`) — Supabase is removing this flag; the repo's own notes say a
  GRANT/default-privileges migration is **due before 2026-10-30** or fresh local stacks break.
  No evidence in current `engineering-memory.md` that this has been started.
- **No app-level rate limiting anywhere.** Grepped `src/` — the only rate-limit references are
  about *vendors* rate-limiting *us* (Google Geocoding, Brave), not any throttle we apply to
  inbound traffic. `ALLOWED_CLIENT_IPS` exists as a coarse allowlist in front of the MCP path but
  **defaults to open when unset** (empty = allow-all, a documented fail-open default).
- **No dependency-update automation.** No Dependabot/Renovate config (no `.github` at all to hold
  one); no `npm audit` gate (no CI to run it in). Not independently confirmed whether GitHub's
  native Dependabot alerts are turned on at the repo-settings level (outside what the file tree
  can show) — **flagged for a live check**.
  **[Update 2026-08-17, post-research — commits b3fac08 / da1a7f2]:** the 7 advisories that
  existed at research time have since been cleared, via a **manual, one-time, targeted lockfile
  bump** (`npm update --package-lock-only` on 8 patch/minor transitive packages under
  `@modelcontextprotocol/sdk`; `package.json` and the SDK version itself untouched;
  `package-lock.json` only). `npm audit` now reports 0 vulnerabilities as of 2026-08-17. **This
  does not close the underlying gap** — there is still no CI, no Dependabot/Renovate config, and
  no automated recurring scan; the fix required a human to notice, decide, and run `npm audit`
  by hand. Commit cd8d904 also records that `npm audit fix` is a verified no-op in this repo
  (the advisories needed the targeted `--package-lock-only` bump instead), which is useful
  context for whoever designs the eventual CI/Dependabot job. Net effect: the *symptom* (open
  advisories) is fixed for now; the *gap* (no ongoing scanning) is unchanged.
- **A local, uncommitted draft already frames much of this as launch blockers.**
  `TradesDatabase/docs/prod-migration-checklist.md` exists **only in the local working tree**
  (`git status` shows it `??` — untracked, never committed to any branch). It is high quality and
  already organizes RLS (its "Blocker B1"), the prod DB cutover ("B2"), and fail-fast config
  validation / fail-closed defaults ("B3") as go/no-go gates, with a full test-tier checklist and
  cutover runbook. **Treat it as a strong draft to formalize, not as shipped doctrine** — it has
  not been reviewed or merged, and several other engineers/sessions working from `origin/main`
  would never see it.

### Gaps (ranked)

1. **RLS off on all core business tables** — the top security gap, already self-diagnosed in the
   uncommitted checklist as cutover Blocker B1. Real work, not an n8n task, but n8n can drive the
   *verification* loop (a scheduled workflow that runs the "2-tenant leak" probe against staging
   and alerts on any regression, once that test exists).
2. **No budget/balance alerting** for any metered vendor — see Monitoring § above; this is the
   most n8n-native fix on the whole list (scheduled HTTP check + threshold + notify).
3. **No secrets manager / no env inventory** — the Render dashboard is the only source of truth
   for ~40+ env vars across 3-5 services, undocumented and unexportable. Even a low-effort fix
   (an n8n workflow that periodically diffs a checked-in env-var *name* manifest against what a
   Render API export reports, alerting on drift) would materially reduce "silent missing var"
   incidents, which this repo has hit more than once (`docs/prod-migration-checklist.md`'s
   entire B3 section is about exactly this failure class).
4. **`auto_expose_new_tables` debt with a hard vendor deadline** (2026-10-30) — needs tracking,
   not automation; a good candidate for an n8n reminder/ticket workflow tied to that date.
5. **No dependency/CVE scanning.** **[Update 2026-08-17 — commits b3fac08/da1a7f2]:** a one-time
   manual lockfile bump cleared the 7 advisories open at research time (0 vulnerabilities as of
   2026-08-17), but no automated/recurring scan (CI `npm audit` gate, Dependabot, Renovate) exists
   — the gap is about *ongoing* coverage, which is unchanged; only the current symptom is fixed.
6. **No rate limiting on public inbound endpoints.**

---

## 4. Backups & disaster recovery

### Current state

- **No database backup or PITR is evidenced anywhere for the live pilot database.** The pilot's
  Supabase project (misleadingly named "test," ref `daqapdlkgxfrhquacprv`) holds real customer
  data, and the repo's own recurring description of it is that its `raw_captures` are
  **"unrecoverable"** if something goes wrong — language that only makes sense if no backup
  exists. No doc anywhere (`engineering-memory.md`, `control-plane.md`, `doorman-runbook.md`,
  current on `origin/main`) mentions PITR being enabled, a Supabase paid tier, or any backup
  cadence for this project. Supabase PITR is a **paid add-on that must be explicitly turned on**;
  nothing in the repo claims it has been.
- **No restore drill has ever been run.** The only place a restore drill is even planned is the
  uncommitted `docs/prod-migration-checklist.md` (Blocker B2: *"enable Point-In-Time Recovery…
  **and run one restore drill** to a throwaway branch. An untested backup is not a backup."*) —
  and that document itself is untracked, unreviewed, describing future work, not current state.
- **No DB export/backup script exists in the repo.** `scripts/` has no `pg_dump`/backup-related
  file; the one data-lifecycle script that exists (`calls:purge` /
  `src/calls/purgeAudio.ts`) *deletes* expired call-recording audio — it is a retention/deletion
  job, not a backup mechanism, and its own doc notes *"Supabase Storage has no native
  object-expiry — `calls:purge` IS the lifecycle."* (i.e., that script is the only thing standing
  between call audio and the retention window; there's no separate archival copy either.)
- **Migrations are forward-only** by explicit doctrine (`system-design` skill, cited in the
  uncommitted checklist: *"migrations do not auto-apply… keep a reversible escape hatch on every
  risky step"*) — there is no down-migration tooling. A bad migration's only recorded recovery
  path is manual SQL correction; PITR (not yet enabled) would be the real undo.
- **Box-level DR is manual and infrequent.** `Box_Setup_Stuff/migration-runbook-lightsail.md`
  documents the one real DR mechanism that exists: an **AWS Lightsail snapshot**, taken by a
  human ("Phase 5 — snapshot the golden image… **Re-snapshot after meaningful config changes**"),
  restorable to a fresh instance in ~2 minutes. This genuinely works (it was exercised during the
  Brev→Lightsail migration itself) but: (a) it is entirely manual/human-triggered, with no
  documented cadence or automation; (b) the snapshot **contains secrets** (doorman.env, pull
  token) and must be handled as sensitive; (c) it is single-account, single-region, with no
  cross-region copy; (d) any box config drift since the last manual snapshot is simply lost.
- **Single point of failure at the infra layer:** exactly **one** Lightsail box
  (`trades-box-1`) runs every tenant's agent sandboxes. There is no second box, no load
  balancing, no automatic host failover — a box outage takes every tenant's Telegram agent access
  down simultaneously (the spine data itself stays intact on Render/Supabase, since the box only
  hosts the agent front-end, but there is no agent access without it). Confirmed structurally:
  `GATEWAY_IDENTITY_SECRET`, `PULL_URL`, `MCP_UPSTREAM_URL`, and the inference route are all
  **host-global** files/config — nothing in the current config shape lets two boxes share load or
  fail over to each other (`thoughts/shared/research/2026-07-30-testing-to-production-fork.md`,
  Constraint 5).
- **No documented, exercised runbook combining "bad deploy" and "bad migration" as one drill.**
  The closest thing is the uncommitted checklist's Tier 9 ("Resilience, failure injection & DR")
  and its "Cutover runbook" — neither has been run.
- **Third-party SaaS state (Telegram bot config, Composio webhook subscription, Composio
  sessions) has no independent backup** beyond what can be re-derived by re-running the
  provisioning scripts (`scripts/assign-host.mjs`, `scripts/provision-session.mjs`) against the
  DB — those scripts are also **hard-gated to the pilot Supabase ref only**, so they cannot
  currently be pointed at a prod project without code changes (same research doc, point 5 in
  "Decision Points").

### Gaps (ranked)

1. **No PITR / DB backup on the live pilot database holding real, currently-described-as-
   unrecoverable customer data.** This is the single highest-severity gap in the entire review —
   it is a data-loss risk today, not just a cutover blocker for the *future* prod project.
   Enabling Supabase PITR (a dashboard/paid-tier action) and running one restore drill should be
   treated as urgent, independent of the rest of the cutover work.
2. **No restore drill, ever**, on any project.
3. **Single Lightsail box, manual/infrequent snapshotting, no automation, no cross-region copy.**
4. **No automated reminder tied to "re-snapshot after meaningful config changes"** — this is
   currently trusted to human memory. A natural n8n fit: trigger a snapshot-reminder workflow off
   of merged PRs touching `Box_Setup_Stuff/`.
5. **No rollback runbook has been exercised** for a bad deploy or a bad migration together.

---

## n8n automation opportunities (mapped to the gaps above)

These are the places where the *current* system already exposes (or nearly exposes) a clean
integration point an n8n workflow could sit on, closing a documented, real gap without new
application code:

1. **Incident notifier (closes the biggest Monitoring gap).** `ops_events` already models
   open/close transitions cleanly via `src/db/opsEvents.ts` (`listRecentIncidents`,
   `getOpenIncident`). An n8n workflow polling that table (or receiving a webhook if
   `POST /control/ops` is extended to fan out) on open/close and posting to Slack/Telegram/email
   is *exactly* the deferred "Phase 4" the repo's own plan describes as "one function."
2. **DeepInfra balance watchdog.** A scheduled n8n HTTP-request workflow running the repo's own
   documented 1-token-probe check, alerting before the balance hits zero — directly answers a
   gap hit **four separate times** in the project's history.
3. **Cost/spend threshold alerts.** Poll `/admin/api/costs` (bearer-token) on a schedule; alert
   on a per-tenant or per-vendor spend crossing a threshold — closes the explicitly-flagged
   "add a crossover alert if spend can grow" item in `docs/phone-call-runbook.md`.
4. **Release-hygiene guardrail.** A GitHub-triggered n8n workflow on push-to-main that reminds/
   verifies the manual sync to Render's separately-connected deploy repo, then calls the Render
   API to deploy the latest commit and posts the resulting live commit hash — closes the
   "Redeploy re-runs stale commit" and "which repo is Render watching" failure classes without
   requiring Render to be re-plumbed.
5. **Dead-man's switch.** A scheduled n8n workflow checking "has each host reported to
   `/control/ops` in the last N minutes" — the exact mechanism the plan doc sketches and defers.
6. **Manual-step reminders as scheduled tickets:** monthly infra-invoice hand-entry into
   `infra_costs`; the `auto_expose_new_tables` deadline (2026-10-30); "re-snapshot the Lightsail
   box after config changes."
7. **Canary probe (B3 Fix #3 in the uncommitted checklist).** Once a minimal `/health` route
   exists, an n8n scheduled workflow can be the canary — hit it, and separately exercise one real
   model completion (a ping alone would miss the documented DeepInfra-stall class where the
   endpoint answers but completions hang).

---

## Ambiguous / unverifiable items — flagged rather than guessed

- **Phone-call feature (SignalWire/AssemblyAI) production deploy status** — code is merged to
  `origin/main`, but no doc confirms a live Render deploy of `calls-worker`/`calls-purge`, cron
  wiring, or a provisioned `call_numbers` row. Verify against the Render dashboard directly.
- **GitHub branch protection on `main`** — the PR-before-main rule is documented as a *social*
  rule; whether it's also a configured branch-protection rule could not be determined from the
  repo. Check `hhesecured-web/TradesDatabase` settings directly.
- **Identity of the separate Render-connected deploy repo** — referenced repeatedly
  (`HANDOFF.md`, `onboarding.md`, the 2026-07-30 research doc) but its name/owner is not recorded
  anywhere in this repo. Needs a person with Render dashboard access to state it.
- **Whether `lzlgysoydhknsdvovntz` (the intended prod Supabase project) is paused, and under
  which Supabase org/tier** — the 2026-07-30 research doc observed DB timeouts twice, consistent
  with auto-pause on an idle free-tier project, but did not confirm it via the dashboard.
- **Whether Dependabot/CVE-alerting is enabled at the GitHub repo-settings level** — invisible
  from the file tree since there's no `.github` directory either way.
- **Render dashboard's actual current lifecycle-cron cadence** (`*/5` vs `*/15`) — the code
  targets `*/5` as of 2026-08-16 but the dashboard flip was, per the last written record, still
  pending. Check the Render Cron Job schedule field directly.

---

## Key file references

| File (path relative to `TradesDatabase/`, all read from `origin/main` unless noted) | Relevance |
|---|---|
| `docs/engineering-memory.md` | Primary current-state doc; §3 "Environments & infrastructure," medic v4/v5 + ops-alerting entries (~lines 680-800), DeepInfra shared-balance finding (~lines 1969-1980) |
| `docs/onboarding.md` §10-11 | Deploy topology, rollout classes, trap taxonomy |
| `docs/control-plane.md` | Current lifecycle-cron sweep list incl. watcher + cadence-flip drift |
| `docs/phone-call-runbook.md` | Phone-feature ops/regulatory checklist, cost crossover-alert gap |
| `HANDOFF.md` | Cost-dashboard shipped record; deploy-topology trap (separate Render repo) |
| `docs/prod-migration-checklist.md` | **Untracked/uncommitted local draft** — RLS/prod-cutover/PITR blockers already organized; not yet reviewed or merged |
| `src/mcp/httpServer.ts` | All HTTP routes incl. `/control/ops` (line ~531), confirms no `/health` route exists |
| `src/db/opsEvents.ts` | Incident transition logic (`recordOpsEvent`, `listRecentIncidents`) |
| `supabase/migrations/20260813000000_ops_events.sql` | Incident-store schema + design rationale in comments |
| `Box_Setup_Stuff/ops-report.sh` | Box-side health reporter (fire-and-forget, always exits 0) |
| `Box_Setup_Stuff/nemoclaw-inference-medic.{service,timer}` | Existing self-healing (not alerting) automation |
| `Box_Setup_Stuff/migration-runbook-lightsail.md` | The only DR mechanism today (manual snapshot) |
| `thoughts/shared/plans/2026-08-12-ops-alerting-render.md` | Full design + explicit "store not alarm" scope decision |
| `thoughts/shared/research/2026-07-30-testing-to-production-fork.md` | Exhaustive environment/secrets/deploy-topology inventory; RLS-off finding (point 10) |
| `.env.example` | Confirmed still under-documents ~17 real deployed vars |
| `supabase/config.toml` | `auto_expose_new_tables = true`, the dated (2026-10-30) debt |
| `package.json` | Full script inventory (deployable entry points, eval tooling) |

## Recommendations (initial, for the planning phase)

1. Treat **PITR on the live pilot DB** as an urgent, standalone action — not gated on the rest of
   the cutover plan.
2. Formalize `docs/prod-migration-checklist.md` (commit it, get it reviewed) — it already does
   most of the security/cutover gap analysis; don't re-derive it from scratch.
3. Stand up minimal CI (typecheck/lint/test/build on PR) before building anything n8n-driven on
   top of the release path — n8n automating an unverified deploy just makes bad deploys faster.
4. The single fastest, highest-value n8n build is the **ops_events → notification channel**
   (item 1 in the n8n section) — the schema, transition logic, and box-side reporting are already
   shipped; only the "tell a human" half is missing, and it's already-scoped as "one function."
5. Resolve the "which repo does Render actually deploy" question with a human before automating
   anything in the release path around it.

## Open Questions

See "Ambiguous / unverifiable items" above — all six should be answered by a human with Render/
GitHub/Supabase dashboard access before a hardening plan is finalized.
