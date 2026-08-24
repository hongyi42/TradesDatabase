# Research: Production DevOps Readiness (2026-08-17)

## Problem Statement

HVAC-Nemoclaw / TradesDatabase is a pilot (~2 tenants) running on one AWS Lightsail box + Render +
Supabase, and needs to move toward production readiness with standard DevOps practices —
monitoring/alerting, CI/CD & release flow, cost & security ops, backups & disaster recovery —
automated where possible using **n8n** as the automation backbone. Three parallel research passes
fed this synthesis:

1. **Current-state / codebase research** — what actually exists today, grounded in `origin/main`
   (not the stale local checkout).
2. **External best-practices research** — right-sized standard DevOps practice for a 2-3 person
   team at pilot scale (deliberately *not* the enterprise/Kubernetes answer).
3. **n8n automation research** — how to wire n8n as the glue across all four areas, plus its own
   operational risks.

This document consolidates all three into one self-contained reference. It resolves one material
mismatch between sources (the external best-practices research was conducted assuming a Python
stack; the codebase is TypeScript/Node — see **Stack Correction** below), reconciles duplicated or
single-sourced facts, and is structured so a reader with no prior context can use it as a build
gate.

---

## Executive Summary

TradesDatabase currently has **near-zero production DevOps scaffolding**: no CI, no application
health endpoint, no error tracking, no database backups, and the core business tables have no
row-level security. None of this is hypothetical risk — the DeepInfra balance has silently run
out four times causing real outages, a stale-commit deploy has already gone live once, and a
migration-ordering mistake has already happened live — **and, per a 2026-08-17 post-research
update, a second independent migration-ordering incident and an inference-provider suspension
(now on Fireworks, not DeepInfra) both recurred the same day this research was written; see the
dated update notes in the Prioritized Gap List and Deep Dives 1–2 below.** At the same time, the
team has already
shipped several **high-quality building blocks that should be reused, not re-derived**: an
incident store (`ops_events` / `POST /control/ops`), a well-designed cost ledger
(`cost_rates`/`infra_costs`/`cost_rollup_monthly`), a partially-built DeepInfra billing puller, and
a strong (but uncommitted) draft cutover checklist (`docs/prod-migration-checklist.md`).

Four findings are severe enough to treat as **do-now, independent of any n8n build**:

1. **No confirmed backup on the live pilot database**, which the repo's own docs describe as
   holding "unrecoverable" data if something goes wrong.
2. **Row-level security is off on every core business table** — tenant isolation depends entirely
   on hand-written `.eq('tenant_id', …)` filters, already flagged critically by Supabase's own
   advisor.
3. **Nobody can currently state with confidence what code is running in production** — Render
   deploys from a separate, unrecorded repository that must be manually synced, and the local
   checkout used for earlier research was found 160 commits behind `origin/main`.
4. **No restore drill has ever been run**, on any project — even if a backup existed, it would be
   untested.

n8n is a committed decision for the automation layer, not an open question, but it carries its own
material risk: it becomes the single highest-privilege system in the stack (it will hold Render,
Supabase, DeepInfra, Brave, AWS, and Telegram credentials behind one encryption key), and has
shipped multiple CVSS-10.0 remote-code-execution vulnerabilities in the last ~18 months. Building
it insecurely would *add* a critical vulnerability rather than close existing gaps — so n8n's own
hardening is a prerequisite step, not an afterthought, before any workflow touches real
credentials.

The recommended path is: fix the four CRITICAL items in parallel (mostly dashboard/config actions,
not code, not n8n), stand up a minimal CI gate using the project's *actual* toolchain
(ESLint/tsc/Vitest, not the ruff/mypy/pytest the external research assumed), harden a self-hosted
n8n instance, then build outward from the cheapest, already-shipped-schema win — an `ops_events` →
Telegram notifier — through cost alerts, independent database backups, health-check monitoring,
n8n's own backup, and only last, CI/CD release glue. Full detail, reconciliation notes, and a
severity-ranked gap list follow below.

---

## How to Read This Document

- **[Codebase]** = grounded in `origin/main` via direct file/commit inspection — highest confidence
  for "what exists today."
- **[External]** = general DevOps best-practice research, with per-claim confidence tags
  (High/Medium/Low) preserved from the source.
- **[n8n]** = n8n-specific automation-pattern research, also with confidence tags preserved.
- Where two sources agree independently, that's called out as **higher confidence**. Where only
  one source asserts something, it's explicitly flagged as **single-source** — verify before
  relying on it.

---

## Already-Shipped Assets — Do Not Re-Derive These

The team should build *on* these, not around them or from scratch:

- **`ops_events` incident store + `POST /control/ops`** (`src/mcp/httpServer.ts` line ~531,
  `supabase/migrations/20260813000000_ops_events.sql`, `src/db/opsEvents.ts`). Shipped
  2026-08-12/13. Records open/close transitions (one row per incident, partial unique index on
  `closed_at is null`), fed by `Box_Setup_Stuff/ops-report.sh` off the inference medic's
  `OnFailure=`/`OnSuccess=`. **It is explicitly documented as a STORE, not an ALARM** — the plan
  doc that shipped it says so in plain language, and current `engineering-memory.md` repeats it:
  *"STILL A STORE, NOT AN ALARM. Nothing notifies yet."* The missing half (Phase 4: post to a
  channel on open/close) is scoped in the repo's own plan doc as "one function." This is the
  single cheapest, highest-leverage n8n target in the entire review. [Codebase]
- **The cost ledger** (`cost_events`, `cost_rates` versioned by effective date, `infra_costs` flat
  monthly bills with an allocation rule, `cost_rollup_monthly` — the only thing `/admin` reads).
  Schema: `supabase/migrations/20260725120000_cost_ledger.sql`. RLS-protected, bearer-token gated,
  fail-closed if the token is unset. **An optional DeepInfra usage puller already exists**
  (`DEEPINFRA_BILLING_API_KEY`, falls back to `INFERENCE_API_KEY`) — any n8n cost-pull workflow
  should extend this, not invent a parallel table. [Codebase]
- **`docs/prod-migration-checklist.md`** — a high-quality, already-organized draft that frames RLS
  as cutover "Blocker B1," the prod-DB cutover as "B2," and fail-fast/fail-closed config validation
  as "B3," with a full test-tier checklist and cutover runbook. **It exists only in the local
  working tree** — `git status` shows it untracked (`??`), never committed to any branch, never
  reviewed. Formalizing (reviewing + committing) it is far cheaper than re-deriving its analysis.
  [Codebase]

---

## Top Operational Cautions (Read Before Building Anything)

These cut across all four areas and were flagged as the most consequential facts in the whole
review:

1. **n8n becomes the highest-privilege system in the stack.** It will hold Render API tokens, the
   Supabase service-role key, DeepInfra/Brave keys, AWS credentials, and the Telegram bot token —
   all decrypted by one `N8N_ENCRYPTION_KEY`. Two independent CVSS-10.0 RCEs shipped against n8n in
   the last ~18 months: **CVE-2026-21858** (webhook content-type confusion → arbitrary file read →
   RCE, patched 1.121.0) and **CVE-2026-25049** (JS expression-sandbox escape — fires from *any*
   field switched to "Expression" mode, not just the Code node — patched 2.4.0). Both end the same
   way: attacker reads the encryption key, decrypts every stored credential at once. GitGuardian's
   2026 research found 4,576 exposed n8n API tokens on GitHub, 36% of reachable instances still
   accepting them. Pin an explicit version, never run `:latest`, patch on disclosure, never expose
   the editor UI to the internet. [n8n, High confidence — multiple independent, recent, technically
   detailed sources]
2. **If n8n is the monitoring system, something *outside* n8n must monitor n8n.** A self-hosted
   n8n box that hangs, OOMs, or loses its Postgres connection simply stops firing every workflow —
   including the health-check, cost-alert, and backup-verification workflows — with silence as the
   only symptom. This requires an **external dead-man's-switch** (Healthchecks.io / Better Uptime /
   Cronitor, free tier is adequate) pinged by an n8n "still alive" workflow, configured to alert
   *you* if the ping doesn't arrive. This is the most-repeated single caution across the n8n
   research. [n8n, High]
3. **n8n is not a CI system.** It has no build cache, no isolated per-run runners, no test-matrix,
   no first-class per-job secret scoping. The strong, repeated, cross-source consensus (including
   n8n's own blog) is: keep GitHub Actions (or equivalent) as the system of record for "is this
   code good"; use n8n only for what happens *after* that's already true — deploy triggers, smoke
   tests, notifications, human-approval gates. [n8n, High]
4. **Verify Supabase paid-plan-or-no-backups before anything else in this document.** Supabase's
   Free tier has **zero automatic backups** — this is directly sourced from Supabase's own docs. No
   document reviewed in this research (codebase or external) confirms which plan tier the live
   pilot project is currently on. This is arguably the single most urgent unverified fact in the
   entire synthesis, given the repo's own language describing pilot data as "unrecoverable."
   [External, High + Codebase, unconfirmed]
5. **RLS is off on every core business table** (`customers`, `jobs`, `visits`, `raw_captures`,
   etc.) — only the 4 cost tables and 2 phone-call tables have a deny-all RLS retrofit. The app
   always connects with the Supabase service-role key, which bypasses RLS by design, so tenant
   isolation today rests entirely on a hand-written `.eq('tenant_id', …)` filter in every DB
   accessor. Supabase's own advisor already flags this critically. One missed filter is a silent
   cross-tenant leak. [Codebase, High — self-diagnosed in the repo's own uncommitted checklist,
   independently corroborated by two separate codebase citations]
6. **The local checkout was found 160 commits behind `origin/main`, and Render deploys from a
   separate, unrecorded repository that must be manually synced.** Together these mean: reading the
   working tree (or any stale doc) can silently miss shipped features, and even a verified-correct
   `origin/main` says nothing about what's actually live, because Render isn't watching this repo
   directly. The identity of the deploy-connected repo is not recorded anywhere in the codebase and
   needs a human with Render dashboard access to state it. [Codebase, High]

---

## Prioritized Gap List (Severity-Ranked)

**Cross-cutting caution (not a pre-existing gap, but a risk the fix itself introduces):** building
n8n without the hardening in Caution #1/#2 above would add a new critical vulnerability rather than
close existing ones. Treat n8n's own security baseline as a zero-th step, not optional polish.

### CRITICAL — active risk today, fix independent of any n8n build

1. **No confirmed backup / PITR on the live pilot database**, whose data is described in the
   repo's own docs as "unrecoverable." *(Backups/DR)*
2. **RLS off on all core business tables** — active tenant-isolation risk. *(Security)*
3. **Production deploy provenance is unverified** — separate unrecorded deploy repo + a 160-commit
   local/`origin/main` drift found during this very research pass. *(CI/CD)*
4. **No restore drill has ever been run**, on any project — even a confirmed backup is unproven
   without this. *(Backups/DR)*

### HIGH

5. **`ops_events` has no notifier** — real incidents (e.g., the 2026-08-14 DeepInfra outage) are
   already being recorded and going unseen; the fix is scoped as "one function." *(Monitoring)*
6. **No DeepInfra balance/spend alarm** — the same failure has caused four separate recorded
   outages (2026-07-11, 07-20, 07-31, 08-14). *(Monitoring/Cost)*
   **[Update 2026-08-17]:** the production provider changed to Fireworks on 2026-08-15 (predates
   today's commits, but not previously reflected in this research); Fireworks then had its own
   spend-cap suspension the same day (same underlying gap, different failure shape — a hard
   monthly cap returning HTTP 412, not a prepaid-balance 402). Commit **f25bf7b** (2026-08-17)
   additionally documents a credential-*validity* variant of this same gap: `hasModelCredentials()`
   is presence-only, so a stale/suspended key burns 3 compose retries per gap instead of skipping,
   and the pilot's cron showed **zero model usage since 2026-08-15 18:13** — "consistent with the
   parked Fireworks suspension." Generalize this gap to "no inference-provider balance/credential
   alarm" rather than DeepInfra-specifically; as of this update it may be an active, unresolved
   instance, not only historical.
7. **No CI at all** — nothing enforces the four gates (`typecheck`, `lint`, `test`, `build`)
   `CLAUDE.md` already mandates locally; also a hard prerequisite for any n8n release automation
   to trigger off of something trustworthy. *(CI/CD)*
8. **No migration-vs-deploy ordering enforcement** — has already caused a live incident
   (2026-07-19). *(CI/CD)*
   **[Update 2026-08-17 — commit cd8d904]:** a second, independent live incident of this same
   class hit the same day this research was written — merging PR #148 made its migrations
   mandatory immediately (not at feature-flip time), and the pilot lacked them, so the un-gated
   lifecycle-watcher pre-filter read threw for every tenant and **every 5-minute cron run was
   marked FAILED** until the migrations were applied. Two independent triggers now, not one —
   this gap should be read as confirmed-recurring, not hypothetical.

### MEDIUM

9. No application `/health` endpoint — blocks canaries and Render's own deploy-time health gating.
   *(Monitoring)*
10. No dead-man's switch for the box going dark (and, once built, for n8n itself). *(Monitoring)*
11. No cost/spend anomaly alerting beyond DeepInfra — Brave, Composio overage, SignalWire,
    AssemblyAI are all metered with no threshold alarm. *(Cost)*
12. No error tracking / APM — failures are only visible via raw Render log stream. *(Monitoring)*
13. No branch protection confirmed on `main` (verify live). *(CI/CD)*
14. No automated rollback path. *(CI/CD)*
15. No secrets manager / no env inventory — ~40+ vars across 3-5 services, Render dashboard is the
    sole (unexportable) source of truth. *(Security)*
16. `auto_expose_new_tables=true` debt with a hard vendor deadline of **2026-10-30** (~2.5 months
    from today) — no evidence work has started. *(Security)*
17. No dependency/CVE scanning (no Dependabot, no `npm audit` gate). *(Security)*
    **[Update 2026-08-17 — commits b3fac08/da1a7f2]:** the 7 advisories open at research time were
    cleared same-day by a manual, one-time, targeted `package-lock.json` bump (0 vulnerabilities
    now) — but this was a human noticing and running `npm audit` by hand, not automation. The gap
    itself (no CI, no Dependabot/Renovate, no recurring scan) is unchanged; downgrade the *urgency*
    of the current symptom, not the gap's rank.
18. Single Lightsail box — manual/infrequent snapshotting, no cross-region copy, and it is a single
    point of failure for every tenant's agent/Telegram access. *(Backups/DR)*
19. No exercised runbook combining "bad deploy" + "bad migration" as one drill. *(Backups/DR)*

### LOW

20. No app-level rate limiting on inbound endpoints — `ALLOWED_CLIENT_IPS` defaults to open
    (fail-open) when unset. *(Security)*
21. No automated reminder to re-snapshot the Lightsail box after config changes. *(Backups/DR)*

---

## Stack Correction: This Is a TypeScript/Node Project, Not Python

The external best-practices research was conducted assuming a Python stack (`ruff`, `mypy`,
`pytest`, `Alembic`). The codebase research establishes the real stack: **TypeScript (Node, ESM,
`NodeNext`), Vitest, ESLint, a raw Node `http` server (no Express), `@supabase/supabase-js` with
the service-role key only (no ORM), `@modelcontextprotocol/sdk`.** [Codebase, `package.json`]
The *underlying* practices the external research recommends are sound and stack-agnostic (gated
CI, expand/contract migrations, trunk-based development); only the tooling names need translation:

| External doc recommended (Python) | Translated for this repo (Node/TS) | Notes |
|---|---|---|
| `ruff` (lint + format) | **ESLint** | Already a dependency; already run manually per `CLAUDE.md` |
| `mypy` (type check) | **`npm run typecheck`** (`tsc`) | Same |
| `pytest` (tests) | **Vitest** (`npm test`) | Same |
| `astral-sh/setup-uv` / pip-tools (CI dependency install) | `actions/setup-node` + npm cache | Mechanical GitHub Actions swap |
| Sentry **Python** SDK | Sentry **Node SDK** (`@sentry/node`) | Same product, different package |
| Dependabot `pip` ecosystem | Dependabot **`npm`** ecosystem (`package-ecosystem: "npm"`) | `.github/dependabot.yml`, plus `github-actions` ecosystem either way |
| `pip-audit` (CI vuln scan) | **`npm audit`** | As a CI job, same role |
| **Alembic** (sole migration path, reversible up/down) | **No direct equivalent exists in this repo — flagged as a gap, not a swap** | See below |

**Migration tooling is a real gap, not just a naming difference.** The repo's actual practice is
applying raw SQL files under `supabase/migrations/` via the **Supabase CLI/MCP `apply_migration`
tool** — explicitly *not* `db push`, which is documented as unreliable (it has caused the
migration ledger to drift from repo filenames, because MCP stamps apply-time versions rather than
the filename timestamp). [Codebase] There is **no automated "run pending migrations before
deploy" step anywhere** — Render only builds and starts the Node process. The documented safe
manual order is **migrate → deploy → `NOTIFY pgrst, 'reload schema'`**; doing it backwards has
already happened live (2026-07-19) and failed loudly (PostgREST "unknown column" errors) rather
than silently, but only by luck of that specific failure mode, not by design. [Codebase]

**[Update 2026-08-17, post-research]:** two commits sharpen this section. **Commit cd8d904**
records a second, independent live incident the same day: merging PR #148 made its migrations
mandatory immediately rather than at feature-flip time, and the pilot lacked them — an un-gated
lifecycle-watcher read threw for every tenant, and every 5-minute cron run was marked FAILED until
the migrations were applied hours later. **Commit ace27b2** sharpens the "migration ledger has
drifted from repo filenames" claim: comparing repo filenames against
`supabase_migrations.schema_migrations` over-reported missing migrations by 5 (7 apparent vs. 2
actually missing), because 5 had been applied directly via `execute_sql`, which writes no
migration-table record. The corrected rule, now documented in the repo: **audit the pilot by
object existence, never by the migration table** — it is not a reliable inventory. [Codebase]

Two practices from the external doc still transfer directly, and two diverge:

- **Transfers directly:** the **expand/contract (backward-compatible) pattern** — add
  columns/tables in a deploy that both old and new code tolerate, remove the old ones only in a
  later deploy — is tool-agnostic and should be adopted regardless of what applies the SQL.
  `lock_timeout`/`statement_timeout` guidance on migration runs against the live DB is likewise
  tool-agnostic and should be applied to whatever runs it (MCP or `psql`).
- **Diverges:** migrations here are **forward-only by explicit repo doctrine** — there is no
  down-migration tooling at all, which is a materially different posture than Alembic's usual
  reversible-migration assumption. The only real "undo" path is PITR (not currently enabled) or
  manual SQL correction — not a scripted downgrade. Any CI/n8n release-safety design should account
  for this: **a rollback of application code can never be assumed to imply a safe rollback of the
  schema.**

---

## Deep Dive 1: Monitoring & Alerting

### (a) Current state
No `/health`/`/healthz`/`/status` route exists in `src/mcp/httpServer.ts` — Render's liveness
signal is presumably just "process is listening on `PORT`." No error tracking/APM anywhere
(`sentry|winston|pino|bunyan|datadog|honeycomb` all zero hits in `src/`) — all logging is bare
`console.log`/`console.error` to Render's own unaggregated log viewer. No uptime/synthetic
monitoring service evidenced anywhere. Box-side systemd timers (medic, token-medic, recycler) are
entirely self-healing, not alerting — none of them told a human anything before 2026-08-12.
[Codebase]

This gap was a real, recurring incident class: **DeepInfra balance ran out on 2026-07-11,
2026-07-20, 2026-07-31, and again 2026-08-14** — each time silently (the medic pre-v5 failed over
automatically, v5+ just held the route, and "nothing alerts on it"). The 2026-08-14 trigger was the
repo's own eval harness sharing the same DeepInfra balance as production — *"a heavy eval day can
take the pilot's agents down."* Separately, **medic v4** (found 2026-08-12) had a health probe
naive enough (`{"content":"hi"}`, 1 token, no tools) that it reported healthy through **6 full
outage windows on 2026-08-12 alone**, each ~4 minutes, while `nvidia-prod` 400'd every real agent
turn. As a direct result, **medic v5 (2026-08-13) deliberately deleted the automatic NVIDIA
failover** — the fleet is now single-provider (DeepInfra), with no automatic failover, by explicit
decision after the failover itself was found to be silently unhealthy. [Codebase]

**[Update 2026-08-17, post-research]:** "single-provider (DeepInfra)" above describes the
2026-08-13 state and the automatic-failover decision, which still holds structurally — but the
*provider itself* changed two days later. `docs/engineering-memory.md` (current `origin/main`)
records the fleet moved to **Fireworks FAST** on 2026-08-15 (DeepInfra now the manual-rollback
target), and Fireworks had its own same-day suspension (a monthly spend-cap trip, HTTP 412, ~35 min
outage — same "nothing alarms on it" gap, different vendor/failure shape). Separately, commit
**f25bf7b** (2026-08-17, `docs/control-plane.md` + `docs/engineering-memory.md`) documents that
`hasModelCredentials()` is presence-only: a stale/suspended key does not skip, it burns 3 compose
retries per gap before escalating to the manager queue, and the pilot's cron showed zero model
usage since 2026-08-15 18:13 — consistent with the parked Fireworks suspension. None of this
contradicts the "no alarm exists" finding; it sharpens it and suggests the gap may be currently
live, not just historical. [Codebase]

The `ops_events` incident store shipped 2026-08-12/13 (see Already-Shipped Assets above) but is
explicitly a store, not an alarm — the 2026-08-14 balance-out incident produced three outage
windows correctly recorded in it, *"silently, because the Phase-4 notifier doesn't exist yet."*
The cost dashboard `/admin` is a pull surface, not a push alert — nobody is paged on a spend
anomaly. The lifecycle cron cadence itself shows the "no IaC" problem live: code merged 2026-08-16
targets `*/5`, but the Render dashboard schedule setting may still be `*/15` — a documented,
merged code change with an unconfirmed dashboard counterpart. [Codebase]

### (b) Gap
No alerting channel at all for infra incidents; no DeepInfra balance alarm despite four recorded
outages; no application health endpoint for any external check to exercise; no dead-man's switch
for the box; no cost/spend anomaly alerting; no error tracking/APM. [Codebase]

### (c) Standard practice to adopt
Add a `/health` route (DB round-trip + model-provider reachability, not just "process is up") and
point an external synthetic monitor at it — Render's own zero-downtime deploy mechanism already
gates traffic-switching on a health check responding 2xx/3xx, so the endpoint pays for itself
twice. [External, High] For the external monitor, **Better Stack's free tier** (10 monitors,
3-minute checks, 1 phone call, bundled status page) is the pragmatic default over UptimeRobot's
free tier, whose ToS prohibits monitoring anything revenue-generating (enforcement is inconsistent
in practice, but a needless risk to build on). [External, Medium] Instrument the web service and
all worker processes with Sentry (Node SDK — see Stack Correction) — free Developer tier gives 5K
errors/month. [External, High] **Cron/heartbeat monitoring is called out as the single
highest-leverage monitoring gap for this specific stack** — two of the deployable services
(lifecycle cron, calls-purge, and effectively the board worker) are cron/queue-shaped with no HTTP
surface to health-check; use Sentry Crons or Healthchecks.io's free tier so a missed/late run pages
you the same as a 500 would. [External, High] Route all alerts into one shared channel (Telegram,
fittingly) plus phone/push alerting for a named primary — don't adopt a formal on-call rotation
tool at 2-3 people; do explicitly name a "who responds first" person even informally. [External,
Medium] Skip formal SLO/error-budget tooling entirely at this scale; informal monthly targets
(~99% uptime) are enough. [External, Medium — pilot-scale judgment call]

### (d) Concrete n8n workflow
The generic pattern from the n8n research is a scheduled fan-out: `Schedule Trigger (5 min) → HTTP
Request(s) against health targets → Merge → IF status != 200 → Telegram; else log`. [n8n] **But
for this specific repo, the highest-leverage, lowest-effort build is not that generic pattern — it
is wiring the already-shipped `ops_events` table to Telegram**, closing the repo's own documented
"Phase 4" gap: a Postgres node (using `listRecentIncidents`/`getOpenIncident` logic, or a webhook
receiver in front of an extended `POST /control/ops`) fires on open/close transitions and posts to
Telegram. No new application schema or logic is required — only the notification half is missing,
and it's already scoped in the repo's own plan doc as "one function." [Codebase, reconciled with
n8n mechanics]

Second-highest priority: a **DeepInfra balance watchdog** — a scheduled n8n HTTP Request node
reusing either the repo's own documented 1-token-probe check or (preferably) the already-partially
built billing puller (`DEEPINFRA_BILLING_API_KEY` / DeepInfra's `POST /v1/request-costs` endpoint),
threshold-gated, alerting to Telegram before balance hits zero — directly answers a gap that has
caused four separate outages. [Codebase + n8n]

For the cron-shaped workers (Board_Worker, lifecycle-heart, calls-worker, calls-purge — none have
an HTTP surface): monitor via a "last successful run" timestamp written to Postgres, checked by an
external heartbeat/dead-man's-switch pattern, rather than "is the container running" — a
hung-but-alive worker fails more dangerously (silently) than a crashed one. [External + n8n,
converging pattern] Once a `/health` route exists, a scheduled n8n canary should exercise *both*
the endpoint *and* one real model completion — a bare ping alone would miss the documented
DeepInfra-stall class where the endpoint answers but completions hang. [Codebase]

### (e) Cost & confidence
Healthchecks.io / Better Stack free tier: **$0** to start, ~$29/mo once monitor count is outgrown.
Sentry: **$0** free tier (5K errors/mo, 1 user) → $26/mo Team once a second login or higher volume
is needed. n8n workflow marginal cost: **$0** (runs on the existing Lightsail box).
**Confidence:** High that `ops_events` needs a notifier — directly grounded in shipped code and
explicit repo-doc language. [Codebase] High on the general monitoring-stack shape (uptime + errors
+ cron heartbeats + shared-channel routing) — strong cross-source consensus. [External] Medium and
**single-source-flagged** on Render's exact webhook/API plan-gating: the n8n research asserts
Render webhooks require a Pro workspace plan or higher (so lower tiers must poll, not subscribe) —
this specific claim is not independently corroborated by either other document; verify against the
current Render plan before designing a webhook-dependent flow. [n8n, Medium]

---

## Deep Dive 2: CI/CD & Release Flow

### (a) Current state
**No CI configuration exists anywhere in the repository** — confirmed on `origin/main`: no
`.github/` directory, no other workflow YAML, no `Dockerfile`, no `Procfile`, no `render.yaml`.
[Codebase] **Render deploys from a separate, unrecorded, manually-synced repository** — documented
independently in `HANDOFF.md:69-72`, `docs/onboarding.md` §10, and a 2026-07-30 research doc:
*"merging to the dev repo's `main` does not move production. Someone must sync that repo first,
then Render → 'deploy latest commit.'"* The target repo's identity is an open question — not
recorded anywhere in this repo. [Codebase] Render's "Redeploy" button re-runs the *old* commit — a
documented, already-happened incident class (an 18-commit-stale build went live once). [Codebase]

**No automated test/lint/typecheck gate runs anywhere except a developer's own machine.** The four
gates (`npm run typecheck && npm run lint && npm test && npm run build`) are documented in
`CLAUDE.md` as mandatory "before any commit," but nothing enforces them — no CI, no git
pre-commit/pre-push hook (both a Husky search and a `package.json` grep for `husky|precommit` came
back empty). [Codebase] PR-before-`main` is a written social rule (`docs/engineering-memory.md`
§1), not a confirmed branch-protection setting — whether GitHub branch protection is actually
configured could not be determined from repo contents and is flagged for a live check. [Codebase]

**DB migrations are entirely decoupled from deploy** (see Stack Correction above for full detail on
the actual migration tooling, including a 2026-08-17 post-research update on a second live
migration-ordering incident and a sharpened "migration table is not a reliable inventory" trap).
**There is no staging environment in the normal sense** — the
Supabase project literally named "test" is the live pilot production database, and the project
actually intended as prod is empty, possibly auto-paused, with its Supabase MCP connection
configured read-only. [Codebase] Rollout classification (deploy-only / deploy + gateway restart /
deploy + full box wire-pass) is entirely manual, per-change judgment with no static check — getting
it wrong has already happened both ways. [Codebase] Working-tree/branch drift is real and was
observed live during this very research pass (160 commits behind `origin/main`). [Codebase]

### (b) Gap
No CI at all; the Render-deploys-a-separate-repo indirection (the single biggest structural release
risk — `origin/main` being "correct" says nothing about what's live); no branch protection
confirmed; no migration-vs-deploy ordering enforcement (already triggered a live incident); no
automated rollback. [Codebase]

### (c) Standard practice to adopt (stack-corrected)
**Trunk-based development**, not GitFlow — short-lived feature branches merged frequently, with
GitHub branch protection requiring PR + required status checks green. Tool-agnostic; applies as-is.
[External, High] **CI gates on every PR**: translated for this repo, that's **ESLint (lint) → `npm
run typecheck` (tsc) → Vitest (`npm test`) → `npm run build`** — which is *literally already* the
four-gate sequence `CLAUDE.md` mandates locally, so standing up CI here is "wire the existing
documented gate into GitHub Actions," not invent a new one. GitHub Actions is free for private
repos up to 2,000 min/month — plenty at this scale. [External, High, translated]

**Staging, sized for cost:** a full duplicate of all 5 Render services literally doubles the Render
bill. Right-sized: one lean shared staging web service (not a full duplicate of every worker)
pointed at a **separate, free-tier Supabase project** — reconciled against the codebase reality
that neither the mislabeled-"test" project (the live pilot DB) nor the empty/possibly-paused
intended-prod project is a real staging environment today; this means standing up (or repurposing)
a genuinely **third** project. [External High + Codebase reconciliation] Use Render PR preview
environments selectively, only when interactive verification is actually needed. [External,
High]

**DB migration discipline**, using the repo's actual tooling: keep the documented **migrate →
deploy → `NOTIFY pgrst, 'reload schema'`** order, but enforce it via a CI or n8n step rather than
memory; apply the expand/contract pattern (tool-agnostic, transfers directly); apply
`lock_timeout`/`statement_timeout` to whatever runs the SQL. Do **not** assume a scripted
"downgrade" exists — this repo's migrations are forward-only by doctrine, so a code rollback must
never be assumed to imply a safe schema rollback. [External High practice + Codebase-corrected
tooling]

**Rollback:** rely on Render's built-in one-click rollback (auto-disables autodeploy so a bad
commit can't immediately redeploy itself) — this only stays safe given the expand/contract
discipline above. [External, High, tool-agnostic] **Feature flags:** don't adopt LaunchDarkly/
Unleash yet; a `feature_flags` table keyed by tenant+flag name (or per-tenant env-var toggles) is
enough at this scale and avoids needing a redeploy to flip a flag — a greenfield recommendation,
no evidence of current use. [External, Medium] **Dependency updates:** Dependabot on the **`npm`**
ecosystem (translated) plus the `github-actions` ecosystem, weekly schedule, auto-PR; optionally
`npm audit` (translated from `pip-audit`) as a second CI signal. [External, High, translated]

### (d) Concrete n8n workflow
The consistent pattern: `GitHub push/PR event → GitHub Actions (existing/new CI, unchanged as
source of truth for "is this code good") → on success, webhook to n8n → n8n verifies branch==main
AND checks passed → HTTP Request to Render Deploy Hook or Render API POST /deploys (pinning a
specific commit closes "which commit is actually live") → poll/wait for deploy status → post-deploy
smoke test against /health (once it exists) → Telegram "deployed vX ✅" with commit SHA; on failure,
alert + optional rollback call.` [n8n] This must sit strictly **after** CI, never replace it — per
both the n8n research's own "n8n ≠ CI engine" caution and the codebase research's explicit
recommendation: *"stand up minimal CI before building anything n8n-driven on top of the release
path — n8n automating an unverified deploy just makes bad deploys faster."* [n8n + Codebase,
directly corroborating]

The **release-hygiene guardrail specific to this repo's unusual topology** (not a pattern the n8n
research covers generically, since it assumes Render watches the same repo it's automating around):
a push-to-main-triggered workflow that (a) performs or verifies the sync to whichever repo Render
is actually connected to, and (b) calls the Render API to deploy the latest commit, and (c) posts
the resulting live commit hash somewhere visible — directly closes both the "Redeploy re-runs a
stale commit" and "which repo is Render even watching" failure classes without requiring Render to
be re-plumbed. [Codebase idea, adapted with n8n mechanics] This requires first getting a human to
state which repo Render is actually connected to — see Open Questions. A **migration-order guard**
(an n8n or CI step that fails a release if pending `supabase/migrations/` files haven't been
applied first) closes the documented 2026-07-19 incident class. [Codebase]

### (e) Cost & confidence
GitHub Actions: **$0** (well within the free tier at this scale). n8n workflow marginal: **$0**.
**Confidence:** High on the CI-gate shape once translated to the actual Node toolchain — this is a
mechanical translation (ESLint/tsc/Vitest already exist and are already the documented local gate),
not a judgment call. High on trunk-based development, branch protection, and Render rollback
guidance — language-agnostic, strong cross-source consensus. **Gap, not a confidence level:**
migration tooling has no direct standard-practice mapping in the external research, since it
assumed Alembic; the repo's actual Supabase-MCP-based approach has no independent external
validation in this research pass — flagged for a dedicated look (e.g., whether lock/statement
timeout guards need to be hand-added to the SQL files or whether MCP's `apply_migration` supports
them natively).

---

## Deep Dive 3: Cost & Security Ops

### (a) Current state
**Cost:** the cost ledger is solid and already shipped (see Already-Shipped Assets). The largest
cost line — inference — is still mostly hand-entered; only DeepInfra has a partial automated
puller. Lightsail/Render/Supabase bills are entered manually via SQL/`upsertInfraCost`, no UI, no
automation. Phone-call vendors (SignalWire, AssemblyAI) are the same shape — metered per-minute, no
dollar API, counter+bill-driven — and are explicitly flagged in `docs/phone-call-runbook.md` as
needing a spend-crossover alert that doesn't exist. **No budget alarms of any kind exist.** A
**newly discovered (2026-08-14) shared-balance blast radius**: the repo's own eval/test harness
draws from the *same* DeepInfra account as production — there is no cost isolation between dev/test
and production spend for this vendor. [Codebase]

**Secrets & access:** no secrets manager anywhere — credentials live as Render dashboard bare env
vars (no quoting convention; `GOOGLE_ROUTES_SA_KEY_JSON` must be pasted as raw one-line JSON), box-
side plaintext `0600 root:root` files, and gitignored local `.env`/`.env.test`. `.env.example`
under-documents the real deployed environment by ~17 vars; the full deployed env exists only in the
Render dashboard, unexported and undocumented. App-level access control (manager/technician tiers,
server-side Composio session scoping + doorman badge tier, badges individually revocable and
sha256-fingerprinted, master key architecturally barred from ever reaching a sandbox) is real and
reasonably well-designed — this rigor exists *because* a 2026-07-03 plaintext-badge leak forced a
full rotation. **Database-level access control is the single largest, explicitly-documented open
security gap** — RLS off on every core business table, service-role key bypasses RLS by design, so
tenant isolation depends entirely on hand-written filters; Supabase's advisor already flags this
critically, and the anon key (never distributed, today's only mitigation) could read/write these
tables directly if it were ever exposed. `auto_expose_new_tables = true` is a dated debt — Supabase
is removing this flag; a GRANT/default-privileges migration is due before **2026-10-30** with no
evidence it's started. No app-level rate limiting anywhere; `ALLOWED_CLIENT_IPS` defaults to
open/fail-open when unset. No dependency-update automation (no Dependabot config possible without
`.github`, no `npm audit` gate). [Codebase] **[Update 2026-08-17 — commits b3fac08/da1a7f2]:** the
7 advisories open at research time were cleared same-day by a manual, one-time, targeted
`package-lock.json` bump (`npm audit`: 0 vulnerabilities as of 2026-08-17); `package.json` and the
SDK version were untouched. This closes the *current symptom*, not the *gap* — there is still no
CI, no Dependabot/Renovate, and no automated recurring scan. Commit cd8d904 additionally records
that `npm audit fix` is a verified no-op in this repo (the fix required the targeted
`--package-lock-only` bump instead) — useful context for the eventual CI/Dependabot design.

### (b) Gap
RLS off on all core business tables (top gap); no budget/balance alerting for any metered vendor;
no secrets manager/env inventory; the `auto_expose_new_tables` deadline; no dependency/CVE
scanning; no rate limiting on public inbound endpoints. [Codebase]

### (c) Standard practice to adopt
**DeepInfra:** set a monthly spending limit with threshold alerts (External research flags this
feature's exact UI/API mechanics as *not independently verified* — Medium confidence) — but the
codebase's own **already-partially-built usage puller** and documented 1-token-probe check are more
authoritative, code-grounded signals; prefer extending those over trusting an unverified vendor UI
claim. [External Medium + Codebase, reconciled — prefer the code-grounded source] **Brave Search
API:** removed its free tier, moved to metered billing (~$5/1,000 queries, $5/mo free credit
included) — cited in both the external and n8n research, but **both citations trace to the same
single underlying source** (implicator.ai), so despite appearing twice this is single-sourced for
the specific fact, not independently corroborated — though the broader "metered-vendor risk"
pattern is independently corroborated by this project's own pre-existing cost-tracking-model
memory. There's no clean standalone Brave usage API; the more reliable pattern is the app's own
Postgres counter (already conceptually present as an "unpriced counter" in the existing cost model)
multiplied by the known rate, cross-checked periodically against Brave's dashboard. [External High
(fact) + n8n (mechanic), single-source-flagged]

**Secrets management:** Doppler's free tier (≤3 users, syncs natively to Render + AWS) as a single
source of truth across Lightsail/Render/local, or — avoiding a new vendor — Render's native
Environment Groups + AWS SSM Parameter Store for the Lightsail box. Either way: no shared logins,
no secrets in git, rotation on any offboarding. [External, Medium] **Dependency/vuln updates:**
Dependabot on the npm + github-actions ecosystems (translated), `npm audit` as a CI job (translated
from `pip-audit`) — shares a prerequisite with the CI/CD deep dive (a `.github/` directory must
exist first). [External, High, translated] **Least-privilege/MFA:** require MFA on the four "crown
jewel" consoles (AWS, Render, Supabase, GitHub org); SSH to Lightsail via key only; scope the
service-role key to backend workers only; treat RLS as the real access-control boundary, review it
quarterly. [External, High, tool-agnostic] The RLS retrofit itself is app-level SQL/policy work,
not something n8n does directly — but once a cross-tenant-leak test exists, n8n can drive the
ongoing *verification* loop (a scheduled probe against staging, alerting on any regression).
[Codebase]

### (d) Concrete n8n workflow
Daily scheduled cost-pull: `Schedule Trigger (daily) → parallel branches per vendor (DeepInfra via
the existing partial puller / POST /v1/request-costs; Brave via the internal counter × known rate;
Render/AWS where exposed) → normalize → insert into the cost log`. **Reconciliation: feed the
repo's own existing `infra_costs`/cost-ledger schema rather than inventing a parallel
`vendor_cost_log` table** — `cost_rollup_monthly` and `/admin` already read from the existing
schema, so extending it keeps one source of truth. [n8n pattern, adapted to reuse existing schema
per Codebase] `→ IF daily cost > threshold OR day-over-day delta > X% → Telegram alert.` Alerting on
day-over-day *delta*, not just an absolute threshold, catches anomalies (e.g., a bug causing 10x
normal LLM calls) that a static monthly check would miss until the invoice arrives. [n8n]

Two smaller, cheap workflows close secondary gaps: an **env-var-manifest-diff** workflow (a
checked-in name manifest vs. a Render API export, alerting on drift) materially reduces "silent
missing var" incidents — the exact failure class `docs/prod-migration-checklist.md`'s entire B3
section is about. [Codebase] A **scheduled reminder/ticket** tied to the 2026-10-30
`auto_expose_new_tables` deadline. [Codebase]

### (e) Cost & confidence
Marginal cost: **$0** (reuses the existing box and free-tier vendor dashboards); Doppler free tier
if adopted, **$0** for ≤3 users. **Confidence:** High that RLS is the top gap — self-diagnosed in
the repo's own uncommitted checklist, flagged critically by Supabase's own advisor, and cited
independently in two separate places within the codebase research. High on Dependabot/MFA/
least-privilege once translated — mechanical, language-agnostic. Medium on DeepInfra's exact
spend-limit UI/API (the external doc flags this itself as unverified; prefer the codebase's
code-grounded partial puller as the design basis). Medium, **single-source-flagged**, on the exact
Brave free-tier-removal mechanics/date (same underlying citation reused across two documents).

---

## Deep Dive 4: Backups & Disaster Recovery

### (a) Current state
**No database backup or PITR is evidenced anywhere** for the live pilot database (Supabase project
misleadingly named "test," holding real customer data the repo's own docs recurringly describe as
"unrecoverable" if something goes wrong). No doc anywhere on `origin/main` mentions PITR being
enabled, a paid Supabase tier, or any backup cadence for this project. **No restore drill has ever
been run** — the only place one is even planned is the uncommitted checklist's Blocker B2: *"enable
PITR… and run one restore drill to a throwaway branch. An untested backup is not a backup."* **No
DB export/backup script exists in the repo** — the one lifecycle script that exists
(`calls:purge`) *deletes* expired audio; it is a retention job, not a backup mechanism, and its own
doc notes it "IS the lifecycle" since Supabase Storage has no native object-expiry, meaning there's
no separate archival copy either. Migrations are forward-only by doctrine, with no down-migration
tooling — PITR (not enabled) would be the real undo path. [Codebase]

**Box-level DR is manual and infrequent**: the one real mechanism is a human-triggered AWS Lightsail
snapshot (documented in `Box_Setup_Stuff/migration-runbook-lightsail.md`), restorable to a fresh
instance in ~2 minutes and genuinely exercised once during the Brev→Lightsail migration — but it's
entirely manual with no documented cadence, contains secrets (must be handled sensitively), is
single-account/single-region with no cross-region copy, and any config drift since the last manual
snapshot is simply lost. [Codebase] **Single point of failure at the infra layer**: exactly one
Lightsail box runs every tenant's agent sandboxes — a box outage takes every tenant's Telegram agent
access down simultaneously (spine data on Render/Supabase stays intact, but there's no agent access
without the box). No documented, exercised runbook combines "bad deploy" and "bad migration" as one
drill. Third-party SaaS state (Telegram config, Composio sessions) has no independent backup beyond
re-running provisioning scripts that are hard-gated to the pilot Supabase ref only. [Codebase]

### (b) Gap
No PITR/DB backup on the live pilot database — the single highest-severity gap in the entire
review, an active data-loss risk today, not just a future cutover blocker; no restore drill ever;
single Lightsail box with manual/infrequent snapshotting and no cross-region copy; no automated
reminder tied to "re-snapshot after config changes"; no exercised rollback runbook. [Codebase]

### (c) Standard practice to adopt
**Confirm the live pilot Supabase project is on a paid Pro plan (or above), not Free** — Free has
zero automatic backups, directly sourced from Supabase's own docs. [External, High] **Reconciled
against the codebase gap:** neither research document confirms the current plan tier — this is the
single most urgent unverified fact in this whole synthesis, and given the "unrecoverable" language
already in the repo's own docs, resolving it should not wait on anything else here. Pro ($25/mo)
gets daily automated backups, 7-day retention — floor of acceptable. **PITR** is a $100+/mo add-on
giving seconds-level RPO instead of ~24h; the external research's cost-calibrated judgment is that
this is probably *not yet* worth it at 2-tenant pilot scale (daily backups give a defensible ~24h
RPO). [External, High] **This is a genuine tension with the codebase research**, which frames
enabling PITR itself as urgent given the "unrecoverable" data language — reconciled here as: **both
sources agree the non-negotiable baseline is paid-plan + daily backups now**; PITR specifically is
a deliberate RPO-tolerance decision the team should make explicitly (given data already described
as unrecoverable), not default silently to either the cheaper or the more expensive option by
inertia.

**Independent, off-platform backup — do this regardless of Supabase's plan tier**: a nightly
logical dump (`pg_dump`/`supabase db dump`) piped to S3 (~$0.023/GB/mo), satisfying the standard
3-2-1 rule (3 copies, 2 media, 1 offsite) — this is the actual answer to "what if Supabase itself is
the problem" (account compromise, billing lapse, platform incident), not just disk failure.
[External, High] **Separate staging Supabase project**, never sharing a connection string with
prod — reconciled against the codebase reality that neither the mislabeled-"test" project (the
actual live pilot DB) nor the empty/possibly-paused intended-prod project (read-only MCP
connection) is a working staging environment today, meaning "staging" here means standing up or
repurposing a genuinely **third** project. [External High + Codebase reconciliation] **Lightsail
automatic daily snapshots** — a tool-agnostic AWS feature, applies as-is regardless of stack
language. [External, High] Informal RPO~24h / RTO~4h targets for pilot scale, tightening later.
[External, Medium — pilot-scale calibration, not a universal number] **Monthly restore drills are
explicitly called out as "the practice teams skip and shouldn't."** [External, High]

### (d) Concrete n8n workflow
`Schedule Trigger (daily, off-peak) → Execute Command: pg_dump/supabase db dump using a
read-only, backup-scoped Postgres role` — explicitly **not** the app's service-role key or any
credential n8n already holds for other purposes; the widest-privilege DB credential should stay out
of n8n's credential store if avoidable, and this workflow should only ever read, never write, to
the pilot schema, consistent with the repo's existing "never MCP-migrate the live DB" caution. [n8n
+ Codebase caution, directly aligned] `→ optional gpg encrypt → S3 node upload (dated key) → verify
upload (size sanity check — a 0-byte or truncated dump is worse than no backup, it creates false
confidence) → log {timestamp, size, sha256, status} → IF failed/undersized → loud Telegram alert;
else quiet log/summary.` [n8n]

A **separate, independent freshness-check workflow** (`S3 list objects → find most recent → IF age
> 25h → Telegram "no backup uploaded"`) — deliberately decoupled from the backup job's own
success/failure branch, so it also catches the case where the Schedule Trigger itself was silently
disabled or n8n was down when the job should have fired. [n8n] A **manually-triggered restore-drill
workflow** (Telegram-bot command → spin up a scratch Postgres/throwaway Supabase project ← latest
S3 dump → sanity queries: row counts, latest-timestamp checks → report pass/fail to Telegram) — run
monthly by hand rather than fully automating teardown/recreate; the value is proving the dump is
actually restorable, and a beautiful fully-automated pipeline nobody built is worth zero. [n8n] A
**Lightsail snapshot reminder** tied to merged PRs touching `Box_Setup_Stuff/`. [Codebase]

Use **both** Supabase's own managed backups (near-term point-in-time recovery, once confirmed
enabled) *and* this independent offsite logical dump (the vendor-independent copy, and the one
actually drilled against) — they serve different failure modes, not the same one twice. [n8n]

### (e) Cost & confidence
Supabase Pro: **$25/mo** (verify current tier — may already be an incurred cost, or may be a new
unbudgeted line item). PITR: **$100-400/mo** (deferred pending an explicit team RPO decision, not a
default). S3 storage: **~$0.023/GB/mo** (trivial at this data volume). Lightsail snapshot storage:
small, existing AWS relationship. **Confidence:** High on the overall architecture (paid-plan daily
backups + independent off-platform 3-2-1 + tested restores) — uncontested DR practice, and the
Supabase Free-tier-no-backups fact is directly sourced from Supabase's own docs. [External] **The
current Supabase plan tier is unconfirmed by either research pass** — flag as the most urgent
open question in this entire document. Medium on the RPO/RTO numeric targets — pilot-scale
calibration, not a universal standard. [External] Medium on Supabase Management API specifics for
programmatically listing/verifying backup freshness — the n8n research flags this itself as needing
verification at build time; no fully worked example was found. [n8n]

---

## Reconciled Facts Across Sources

| Fact | Sources agreeing | Confidence | Notes |
|---|---|---|---|
| Supabase Free tier has zero automatic backups | External (Supabase's own docs) | High | Directly sourced from primary vendor docs; current plan tier for this project unconfirmed by any source |
| RLS off on core business tables is the top security gap | Codebase (self-diagnosed checklist + Supabase advisor, cited independently twice) | High | Not addressed at all in External/n8n research (they weren't scoped to audit this repo's schema) |
| Trunk-based dev + gated CI + expand/contract migrations is the right shape | External + Codebase (via the mandatory-but-unenforced local gate) | High | Tooling names required translation (see Stack Correction); underlying practice is undisputed |
| n8n needs an external dead-man's-switch monitoring it | n8n (strongly, repeatedly) | High | Not addressed by the other two docs, since they don't cover n8n's own operation |
| DeepInfra balance running out is a real, recurring, high-severity failure mode | Codebase (4 recorded live incidents) + External/n8n (generic "set spend alerts" advice) | High | Codebase is the more authoritative source here — it has the incident history; External/n8n supply the generic mitigation pattern. **[Update 2026-08-17]:** provider moved to Fireworks 2026-08-15 (own same-day spend-cap suspension); commit f25bf7b adds a credential-validity variant of the same gap and notes zero pilot model-usage since 2026-08-15 18:13 — generalize the fix target, not the finding. |
| DeepInfra's exact spend-limit UI/API mechanics | External only | Medium, single-source | External doc flags this itself as unverified; Codebase's partially-built usage puller is a more authoritative, code-grounded alternative signal |
| Brave Search API dropped its free tier, moved to metered billing | External + n8n (both cite implicator.ai) | Medium — **appears in two docs but traces to one underlying source**, not independently corroborated for the specific fact | The broader "metered-vendor risk" pattern is independently corroborated by this project's pre-existing cost-tracking-model memory |
| Render webhooks require a Pro workspace plan or higher | n8n only | Medium, single-source | Not corroborated by External or Codebase research; verify against current Render plan before designing around it |
| Render deploys from a separate, unrecorded repo | Codebase (three independent internal docs: HANDOFF.md, onboarding.md, 2026-07-30 research doc) | High (internally corroborated) | Not addressed by External/n8n, which assumed a conventional single-repo deploy topology |
| PITR is/isn't urgent right now | Codebase says urgent (given "unrecoverable" data language); External says probably not yet worth it (cost-calibrated for pilot scale) | Genuine tension — flagged, not silently resolved | Both agree the paid-plan + daily-backup baseline is non-negotiable now; PITR itself needs an explicit team decision |

---

## Recommended Build & Sequencing Order

The n8n research proposes: **heartbeat → cost alerts → DB backup → health checks → n8n's own
backup → CI/CD glue.** This is a reasonable skeleton but needs three refinements: (1) it has no
explicit phase for the CRITICAL, non-n8n-automatable items that are more urgent than any n8n
workflow; (2) it doesn't call out n8n's own security hardening as a prerequisite before any
workflow touches real credentials; (3) it omits the `ops_events` → notifier build as an explicit
step even though the codebase research independently identifies it as the single fastest,
highest-value n8n build in the whole review — likely cheaper than the cost-pull workflow, since it
needs no new vendor API integration at all, just Postgres → Telegram. Refined order:

### Phase 0 — Immediate, manual, non-n8n, run in parallel starting now
These are dashboard actions or app-code changes, not automation, and are more urgent than anything
below:
- Verify the live pilot Supabase project's plan tier; upgrade to Pro (or confirm already on it) and
  confirm daily backups are actually enabled. **The single highest-priority action in this entire
  document.**
- Get a human with Render dashboard access to state which repo Render is actually deploying from,
  and confirm whether GitHub branch protection is configured on `main`.
- Begin the RLS retrofit on core business tables (real SQL/policy work).
- Review and commit `docs/prod-migration-checklist.md` — don't re-derive its analysis.

### Phase 1 — n8n bring-up, hardened before anything else touches it
Stand up self-hosted n8n on the Lightsail box (pinned version, never `:latest`; own isolated
Postgres, not the product's Supabase DB; `EXECUTIONS_DATA_PRUNE` on from day one; editor UI behind
VPN/IP-allowlist, never public; task runners in external mode if the Code node is used at all) —
*before* any workflow is wired with real credentials.

### Phase 2 — n8n workflow build order
1. **External heartbeat / dead-man's-switch for n8n itself.** Build first, literally — every
   subsequent workflow's reliability claim depends on knowing whether n8n itself is alive.
2. **`ops_events` → Telegram notifier.** Elevated ahead of the generic cost-pull workflow from the
   n8n doc's original order, because the codebase research identifies this as the single
   fastest, highest-value build in the review — the schema and transition logic are already
   shipped; this is strictly cheaper than any workflow requiring a new vendor API integration.
3. **Cost alerts** — DeepInfra balance watchdog (reusing the existing partial puller) and Brave
   spend tracking (via the internal counter pattern), feeding the *existing* cost-ledger schema
   rather than a new table.
4. **DB backup-to-S3 + freshness check.** Note: enabling Supabase's own paid-plan backups is *not*
   n8n's job — that's Phase 0. This n8n workflow is specifically the supplementary, independent,
   offsite 3-2-1 copy.
5. **Health-check fan-out** (Render/Lightsail/app health). Has a code-side prerequisite: the
   `/health` route doesn't exist yet — build it before this step, not as part of it.
6. **n8n's own workflow/credential backup.** Naturally falls here, once there's more than a
   handful of workflows worth losing.
7. **CI/CD glue** (deploy-hook trigger, smoke test, release notify) — last, agreeing with the
   original n8n-doc ordering (highest effort-to-value ratio of the set), *and* hard-gated on a
   prerequisite the codebase research is explicit about: a minimal GitHub Actions CI gate
   (translated ESLint/tsc/Vitest) must exist and be green-required before any n8n release
   automation is safe to build on top of it — automating an unverified deploy only makes bad
   deploys faster.

---

## Open Questions / Gaps to Verify at Implementation Time

From the codebase research (verify against live dashboards before finalizing any plan):
- **Phone-call feature (SignalWire/AssemblyAI) production deploy status** — code is merged to
  `origin/main`, but no doc confirms a live Render deploy of `calls-worker`/`calls-purge`, cron
  wiring, or a provisioned `call_numbers` row.
- **GitHub branch protection on `main`** — documented only as a social rule; check
  `hhesecured-web/TradesDatabase` settings directly.
- **Identity of the separate Render-connected deploy repo** — referenced repeatedly, never
  recorded; needs a person with Render dashboard access.
- **Whether the intended-prod Supabase project (`lzlgysoydhknsdvovntz`) is paused**, and under
  which org/tier — DB timeouts observed twice, consistent with free-tier auto-pause but
  unconfirmed.
- **Whether Dependabot/CVE-alerting is enabled at the GitHub repo-settings level** — invisible from
  the file tree either way.
- **Render dashboard's actual current lifecycle-cron cadence** (`*/5` vs `*/15`) — code targets
  `*/5` as of 2026-08-16, dashboard flip status unconfirmed.

From this synthesis's reconciliation work:
- **The live pilot Supabase project's current plan tier (Free vs. Pro vs. higher)** — unconfirmed
  by any of the three source documents; the most urgent single fact to resolve.
- **Render's actual current webhook plan-gating** (single-sourced by the n8n research) — verify
  before designing any webhook-dependent monitoring/release workflow.
- **DeepInfra's exact spend-limit UI/API mechanics** (single-sourced, unverified even by the
  document asserting it) — confirm directly in the DeepInfra dashboard.
- **Supabase Management API specifics for listing/verifying backup freshness programmatically** —
  flagged by the n8n research as not found with full confidence.
- **Whether Supabase MCP's `apply_migration` supports `lock_timeout`/`statement_timeout` guards
  natively, or whether these need to be hand-added to migration SQL files** — no source in this
  research pass addresses this, since the external research assumed Alembic.
- **Explicit team decision on PITR timing** — given the tension between the codebase research
  (treats it as urgent) and the external research (judges it premature at pilot cost scale), this
  needs a deliberate decision, not a default.

---

## Sources & Confidence

### Codebase research — grounded in `origin/main`
Primary files cited: `docs/engineering-memory.md`, `docs/onboarding.md` §10-11,
`docs/control-plane.md`, `docs/phone-call-runbook.md`, `HANDOFF.md`, `docs/prod-migration-checklist.md`
(untracked draft), `src/mcp/httpServer.ts`, `src/db/opsEvents.ts`,
`supabase/migrations/20260813000000_ops_events.sql`, `Box_Setup_Stuff/ops-report.sh`,
`Box_Setup_Stuff/nemoclaw-inference-medic.{service,timer}`,
`Box_Setup_Stuff/migration-runbook-lightsail.md`,
`thoughts/shared/plans/2026-08-12-ops-alerting-render.md`,
`thoughts/shared/research/2026-07-30-testing-to-production-fork.md`, `.env.example`,
`supabase/config.toml`, `package.json`. Confidence: highest of the three sources for "what exists
today" — every claim is `git show`/`git log`-sourced against `origin/main`, not the stale working
tree.

### External best-practices research
1. [Render — Best Practices for Maximizing Uptime](https://render.com/docs/uptime-best-practices)
2. [Render — How Render handles deploy failures](https://render.com/articles/how-render-handles-deploy-failures)
3. [Render — Best practices for git-based deployment in production](https://render.com/articles/best-practices-for-implementing-git-based-deployment-in-production-environments)
4. [Render Pricing 2026 breakdown](https://checkthat.ai/brands/render/pricing)
5. [Supabase — Database Backups docs](https://supabase.com/docs/guides/platform/backups)
6. [Supabase — Manage PITR usage](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery)
7. [Supabase PITR cost analysis — ReviveDB](https://revivedb.dev/blog/supabase-pitr-cost)
8. [Supabase — Branching docs](https://supabase.com/docs/guides/deployment/branching)
9. [Supabase — Managing Environments](https://supabase.com/docs/guides/deployment/managing-environments)
10. [Sentry Pricing 2026 — checkthat.ai](https://checkthat.ai/brands/sentry/pricing)
11. [Uptime monitoring tools compared 2026 — OnlineOrNot](https://onlineornot.com/uptime-monitoring-tools)
12. [Better Stack Pricing](https://betterstack.com/pricing)
13. [Trunk Based Development](https://trunkbaseddevelopment.com/)
14. [Atlassian — Trunk-based Development](https://www.atlassian.com/continuous-delivery/continuous-integration/trunk-based-development)
15. [2025 GitHub Actions setup for Python projects](https://ber2.github.io/posts/2025_github_actions_python/) — *shape reused, tooling translated (see Stack Correction)*
16. [Zero-downtime database migrations in production](https://dev.to/matthiasbruns/database-migrations-in-production-zero-downtime-strategies-that-actually-work-3e4l)
17. [Alembic migrations without downtime — Exness Tech Blog](https://medium.com/exness-blog/alembic-migrations-without-downtime-a3507d5da24d) — *pattern reused (expand/contract); tool doesn't apply here, see Stack Correction*
18. [PostgreSQL schema migration lock/statement timeout guidance](https://oneuptime.com/blog/post/2026-01-21-postgresql-schema-migrations/view)
19. [Feature flags: LaunchDarkly, Unleash, or DIY](https://www.growthbook.io/blog/unleash-alternatives)
20. [DeepInfra pricing/spending-limit overview](https://deploybase.ai/articles/deepinfra-pricing-breakdown-cost-per-token-model-comparison) — flagged by the source itself as third-party, unverified
21. [Brave Search API free-tier removal](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/) — single-sourced despite appearing in two docs, see reconciliation table
22. [Doppler secrets management for small teams](https://www.doppler.com/blog/secrets-management-tools-2025)
23. [Dependabot Python/GitHub Actions configuration guidance 2025](https://www.johal.in/dependabot-python-updates-config-github-actions-ranges-ignore-2025/) — *ecosystem translated from `pip` to `npm`*
24. [AWS Lightsail security best practices](https://www.systemsarchitect.io/services/aws-lightsail/security-best-practices)
25. [AWS Lightsail snapshot backup guidance](https://oneuptime.com/blog/post/2026-02-12-use-lightsail-snapshots-backup/view)
26. [RPO/RTO planning for small businesses — DCHost](https://www.dchost.com/blog/en/rpo-rto-and-disaster-recovery-planning-for-small-businesses/)
27. [Disaster recovery for SaaS companies — Phoenix Strategy Group](https://phoenixstrategy.group/blog/disaster-recovery-for-saas-companies-guide)
28. [Incident postmortem template — The Art of CTO](https://theartofcto.com/guides/incident-postmortem-template-blameless-post-incident-review-guide)
29. [Grafana Cloud free tier pricing 2026](https://monitoringcost.com/grafana-cloud-pricing)
30. [SRE fundamentals: SLIs, SLOs, error budgets](https://medium.com/@amishasinha_31533/service-reliability-engineering-sre-fundamentals-a-complete-guide-to-slis-slos-error-budgets-4da45b679716)

### n8n automation research
- [n8n self-hosting queue mode & ops checklist (Royfactory, Jan 2026)](https://royfactory.net/posts/ai/202601/n8n-self-hosting-docker-compose-queue-mode-checklist/)
- [n8n Docker/Nginx HTTPS setup](https://medium.com/@harman5142/how-to-install-n8n-on-linux-using-docker-and-set-up-an-nginx-reverse-proxy-with-ssl-5810a8b42e92)
- [n8n Self-Hosting Requirements (Cherry Servers, 2026)](https://www.cherryservers.com/blog/n8n-self-hosting-requirements)
- [n8n Queue Mode vs Regular Mode](https://ca.hostadvice.com/blog/web-hosting/vps/queue-mode-vs-regular-mode-in-n8n/)
- [Render Webhooks docs](https://render.com/docs/webhooks) — see single-source flag on plan-gating
- [Push, Don't Poll: Render Webhooks & Metrics Streams](https://render.com/blog/new-render-webhooks-and-metrics-streams)
- [Lightsail resource metrics docs](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-resource-health-metrics.html)
- [Monitor Lightsail with CloudWatch Agent](https://repost.aws/knowledge-center/lightsail-monitor-with-cloudwatch)
- [n8n Sentry.io integration](https://n8n.io/integrations/sentryio/)
- [How to Monitor Your VPS with n8n Health Check Workflows](https://dev.to/chasebot/how-to-monitor-your-vps-with-n8n-health-check-workflows-332l)
- [How to set up a no-code CI/CD pipeline (n8n Blog)](https://blog.n8n.io/how-to-set-up-a-ci-cd-pipeline-with-no-code/)
- [Building a CI/CD Pipeline Trigger with n8n (OpsKit)](https://opskit.tools/ci-cd-pipeline-trigger-n8n/)
- [Automating DevOps with n8n (Medium/Duckweave)](https://medium.com/@duckweave/automating-devops-with-n8n-ccf3846e37b6)
- [CI/CD for n8n: Git, environments and safer releases (LumaDock)](https://lumadock.com/tutorials/n8n-cicd)
- [n8n: A Great Starting Point, But Not Where Real Engineering Lives (dev.to)](https://dev.to/thevenice/n8n-a-great-starting-point-but-not-where-real-engineering-lives-cji)
- [Render Deploy Hooks docs](https://render.com/docs/deploy-hooks)
- [DeepInfra Get Request Costs API](https://docs.deepinfra.com/api-reference/logs-&-metrics/get-request-costs)
- [Brave Search API rate limiting docs](https://api-dashboard.search.brave.com/documentation/guides/rate-limiting)
- [n8n Security: Encryption Key Compromise (GitGuardian)](https://blog.gitguardian.com/n8n-security-encryption-key-compromise/)
- [Ni8mare RCE CVE-2026-21858 (Cyera)](https://www.cyera.com/research/ni8mare-unauthenticated-remote-code-execution-in-n8n-cve-2026-21858)
- [n8n Sandbox Escape CVE-2026-25049 (Pillar Security)](https://www.pillar.security/blog/n8n-sandbox-escape-critical-vulnerabilities-in-n8n-exposes-hundreds-of-thousands-of-enterprise-ai-systems-to-complete-takeover)
- [n8n Production Security Hardening Checklist (MassiveGRID)](https://massivegrid.com/blog/n8n-security-hardening-checklist/)
- [n8n Task Runners docs](https://docs.n8n.io/hosting/configuration/task-runners/)
- [n8n Hardening Task Runners docs](https://docs.n8n.io/hosting/securing/hardening-task-runners/)
- [n8n Backup Strategy (MassiveGRID)](https://massivegrid.com/blog/n8n-backup-disaster-recovery/)
- [Download logical backups with physical backups enabled (Supabase docs)](https://supabase.com/docs/guides/troubleshooting/download-logical-backups)
- [n8n Execute Command node docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand)
- [Postgres and S3 n8n integration](https://n8n.io/integrations/postgres/and/s3/)
- [Dead Man's Switch for n8n Workflows (n8n Community)](https://community.n8n.io/t/dead-mans-switch-for-n8n-workflows-get-alerted-when-a-scheduled-job-goes-silent-google-sheets-slack/307950)
- [n8n Error Trigger & Error Workflow guide (Watchflow)](https://www.watchflow.io/blog/n8n-error-trigger-error-workflow/)
- [Why Cron Jobs Fail Silently (Watchflow)](https://www.watchflow.io/blog/why-cron-jobs-fail-silently/)
- [How to set default Error Workflow for new workflows (n8n Community feature request)](https://community.n8n.io/t/how-to-set-default-error-workflow-for-new-workflows/7598)
- [n8n official monitoring docs](https://docs.n8n.io/deploy/host-n8n/keep-n8n-running/monitor-n8n)
- [Export Workflows from n8n (RapidDev)](https://www.rapidevelopers.com/n8n-tutorial/how-to-export-workflows-from-n8n)
- [n8n-git CLI tool (GitHub)](https://github.com/tcoretech/n8n-git)
- [Git backup of workflows and credentials (n8n workflow template)](https://n8n.io/workflows/1053-git-backup-of-workflows-and-credentials/)
- [Back Up n8n Workflows guide (RapidDev)](https://www.rapidevelopers.com/n8n-tutorial/how-to-back-up-n8n-workflows)

### Source documents for this synthesis
| Document | Focus | Confidence anchor |
|---|---|---|
| `thoughts/shared/research/2026-08-17-prod-devops-codebase.md` | Current-state, `origin/main`-grounded | Highest — direct file/commit inspection |
| `thoughts/shared/research/2026-08-17-prod-devops-external.md` | Right-sized standard DevOps practice | High shape, mixed vendor-specific confidence; assumed Python (corrected above) |
| `thoughts/shared/research/2026-08-17-prod-devops-n8n.md` | n8n-specific wiring patterns and n8n's own operational risk | High on patterns and security findings; medium on exact vendor API specifics |

### Overall confidence & gaps
High confidence in the overall shape of all four areas (uptime + errors + cron heartbeats; gated
CI/CD with expand/contract migrations; least-privilege + dependency scanning; paid-plan backups +
independent 3-2-1 + tested restores) — consistent across authoritative and practitioner sources,
and directly load-bearing against this repo's own incident history. Medium confidence on several
specific vendor-API mechanics flagged inline above (DeepInfra spend-limit UX, Render webhook plan
gating, Supabase Management API backup-listing) — all explicitly flagged for verification at
implementation time, not to be trusted as final. Not covered by any of the three research passes:
container/image-level security scanning (not obviously relevant, this stack isn't containerized on
Lightsail as described) and formal compliance frameworks (reasonably out of scope at 2-tenant pilot
scale).
