# Right-Sized DevOps Playbook — Pilot-to-Production for a 2-3 Person Team

**Date:** 2026-08-17
**Scope:** External research synthesis. Grounded in the actual stack: AWS Lightsail VM + Render (web service + Board_Worker + lifecycle-heart + calls-worker + calls-purge) + Supabase (hosted Postgres, **this is the live pilot DB**) + DeepInfra (GLM-5.2) + Brave Search API + Telegram Bot API. ~2 tenants, cost-sensitive, 2-3 people.
**Philosophy:** every recommendation below is deliberately *not* the enterprise/Kubernetes answer. If a practice needs a dedicated SRE to operate, it's excluded. If a practice would make an incident on a Tuesday night much worse for a 2-3 person team, it's included regardless of "enterprise-grade" status.

---

## How to read this doc

Each area has: **SET UP ONCE** → **DO REGULARLY** (cadence) → **MONITOR/ALERT ON**. Every recommendation carries a confidence tag:
- **High** = well-established practice, multiple corroborating authoritative sources, low risk of being wrong for this context.
- **Medium** = reasonable synthesis/judgment call for pilot scale where sources disagree or context-specific tradeoffs apply.
- **Low** = plausible but under-verified; sanity-check before committing budget/time.

---

## 1. Monitoring & Alerting

### Set up once

**Uptime/health checks.** Add a `/health` endpoint to the Render web service (and ideally a lightweight one for the Lightsail VM if it serves anything). Point an external synthetic monitor at it. Render's own zero-downtime deploy mechanism already gates traffic-switching on a health check responding 2xx/3xx during deploys, so the endpoint pays for itself twice ([Render – uptime best practices](https://render.com/docs/uptime-best-practices), **High**).

For the external monitor: **Better Stack's free tier** (10 monitors, 3-minute checks, 1 phone call, plus a bundled status page) is the pragmatic default over UptimeRobot's free tier — UptimeRobot's free plan is generous (50 monitors/5-min checks) but its terms of service **prohibit monitoring anything that generates revenue**, which a paying pilot arguably is ([uptime tool comparison](https://onlineornot.com/uptime-monitoring-tools), **Medium** — ToS enforcement is inconsistent in practice, but it's a needless risk to build on a ToS-violating free tier). Better Stack also gives you incident management and a status page in the same free account, which matters for a tiny team (see "alert routing" below). Cost: **$0 to start**, ~$29/mo once you outgrow the free monitor count ([Better Stack pricing](https://betterstack.com/pricing), **High**).

**Error tracking.** Instrument the Render web service *and* all four workers (Board_Worker, lifecycle-heart, calls-worker, calls-purge) with the Sentry Python SDK. Sentry's free Developer tier gives 5K errors/month, 1 user, enough to validate before paying ([Sentry pricing 2026](https://checkthat.ai/brands/sentry/pricing), **High**). Upgrade to Team ($26/mo) once a second person needs their own login or volume exceeds 5K/month — likely the first real spend in this category. Set Sentry's release tagging so every deploy is attributable — this pays for itself the first time a bad deploy causes an error spike and you need to know *which* deploy.

**Cron/heartbeat monitoring — this is the piece teams skip and shouldn't.** lifecycle-heart and calls-purge are background/cron workers with no HTTP surface to health-check; a silently-dead cron job is invisible to uptime monitoring. Use **Sentry Crons** (check-ins, included in the free/Team tier you're already paying for) or **Healthchecks.io free tier** (20 checks, cron/heartbeat-only, no card required) so a missed or late run pages you the same as a 500 error would ([Healthchecks.io vs alternatives](https://onlineornot.com/uptime-monitoring-tools), **High** — this is the single highest-leverage monitoring gap for this stack specifically, given two of the five Render services are cron-shaped).

**Log aggregation.** Don't stand up a dedicated log stack at 2 tenants. Render retains service logs natively; that's sufficient for now. If/when you need cross-service search or longer retention, Better Stack's Logs product bundles into the same account as the uptime/incident tooling above rather than adding a fourth vendor ([log tooling comparison](https://last9.io/blog/log-monitoring-tools-for-developers/), **Medium**). Revisit only when "grep the Render dashboard" stops being fast enough — don't pre-build this.

**Metrics/dashboards.** Render exposes basic CPU/memory per service; Supabase's own dashboard exposes DB CPU/connections/disk. At 2 tenants this is enough — do **not** stand up Prometheus/Grafana self-hosted. If you outgrow the built-in dashboards, Grafana Cloud's free tier (10K active series, 14-day retention, 3 users, no card) is the next step, not before ([Grafana Cloud free tier](https://monitoringcost.com/grafana-cloud-pricing), **Medium**).

**Alert routing & on-call for 2-3 people.** Do not adopt a formal PagerDuty-style rotation tool at this size — it's overhead without benefit when everyone is effectively on-call. Route all alerts (uptime, Sentry, cron heartbeats) into one shared channel (Slack or a dedicated Telegram group — appropriately, given the product) *and* enable phone/push alerting for at least one designated primary at any given time, using Better Stack's bundled on-call/incident feature (free tier includes phone call alerting) so alerts don't silently die in an unread channel ([Better Stack](https://betterstack.com/pricing), **Medium**). Explicitly name a weekly "who responds first" person even informally — diffused responsibility across 2-3 people is a real failure mode, not a theoretical one.

**SLOs at pilot scale.** Skip formal error-budget tooling and burn-rate alerting entirely — that's built for teams managing many services against contractual SLAs ([SRE fundamentals](https://medium.com/@amishasinha_31533/service-reliability-engineering-sre-fundamentals-a-complete-guide-to-slis-slos-error-budgets-4da45b679716), **Medium**, judgment call for pilot scale). Instead set **informal targets you check monthly, not alert on in real time**: 99% monthly uptime on the web/webhook endpoint (~7h/month allowed) and "Telegram replies within N seconds" as a felt-sense SLI rather than a formal SLO. Revisit formal SLOs when you have paying-tenant contracts that reference uptime.

### Do regularly

- **Daily (~5 min, passive):** glance at the shared alerts channel; skim new Sentry issues. Nothing to do if nothing fired.
- **Weekly:** triage/close Sentry issues; check Render per-service memory/CPU isn't creeping toward its plan limit; check Supabase connection count and DB size trend.
- **Monthly:** review uptime % against the informal SLO; review whether any alert fired repeatedly (that's a signal to fix root cause, not just acknowledge); prune noisy/low-value alerts.

### Monitor / alert on

- HTTP 5xx rate and new/regressed error groups (Sentry alert rules)
- Uptime check failures on the web service and Telegram webhook path (Better Stack → shared channel + phone)
- Missed/late cron check-ins for lifecycle-heart and calls-purge (Sentry Crons / Healthchecks.io)
- Render deploy failures (Render supports Slack notifications on deploy events — wire this in)
- Supabase CPU/connection/disk thresholds (Supabase dashboard, available from Pro plan)

**Confidence:** High on the overall shape (uptime + errors + cron heartbeats + shared-channel routing is the standard pilot-stage stack across every source consulted); Medium on specific vendor picks (Better Stack vs UptimeRobot-paid is a defensible either-way call).

---

## 2. CI/CD & Release Flow

### Set up once

**Branching model: trunk-based, not GitFlow.** For a 2-3 person team, GitFlow's long-lived develop/release branches are pure overhead. Trunk-based development — short-lived feature branches (hours to a day or two) merged frequently into `main` — is explicitly the right fit at this team size and is a prerequisite for CI/CD working well at all ([trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/), [Atlassian](https://www.atlassian.com/continuous-delivery/continuous-integration/trunk-based-development), **High**). Turn on GitHub branch protection on `main`: require PR + required status checks green before merge.

**CI gates.** GitHub Actions workflow on every PR: **ruff** (lint + format check) → **mypy** (type check) → **pytest** (unit/integration tests). Use `astral-sh/setup-uv` (or pip-tools) for fast, reproducible dependency installs; keep it as one shared setup step reused across jobs ([2025 Python GitHub Actions setup](https://ber2.github.io/posts/2025_github_actions_python/), **High**). GitHub Actions is free for private repos up to 2,000 min/month on the Free plan — plenty at this scale. Make all three checks required-to-merge, not advisory.

**Staging vs prod — sized for cost.** Render bills every environment as a real running instance, so a full duplicate staging stack (web + all 4 workers) literally doubles your Render bill ([Render pricing](https://checkthat.ai/brands/render/pricing), **High**). Right-sized approach for 2 tenants:
- One lean shared **staging** Render web service (not a full duplicate of all workers) pointed at a **separate Supabase project on the free tier** (no prod data — Supabase explicitly recommends separate projects for dev/prod over relying on its Branching feature for this purpose) ([Supabase branching guidance](https://supabase.com/docs/guides/deployment/branching), **High**).
- Use Render's PR preview environments *selectively*, only for the web service, only when a change needs interactive verification — not as a standing always-on environment for every branch.
- This gets you a real pre-prod smoke-test target without paying for 5 duplicated services 24/7.

**DB migration discipline — this is the highest-stakes item in this whole document given the live-DB reality.**
- Alembic as the sole path to schema change; migrations reviewed in PR like any other code, and a schema change touching a shared/high-traffic table gets a second set of eyes even on a 2-3 person team.
- Run migrations as an explicit separate step (Render's pre-deploy command, or a manual CLI invocation) *before* the new app code goes live — never let a migration run implicitly bundled inside app boot.
- Adopt the **expand/contract (backward-compatible) pattern**: add new columns/tables in one deploy that both old and new code can tolerate; only remove the old column/code in a *later* deploy once nothing references it. This is what makes Render's one-click rollback actually safe — a code rollback should never require a matching DB rollback ([zero-downtime migration guidance](https://dev.to/matthiasbruns/database-migrations-in-production-zero-downtime-strategies-that-actually-work-3e4l), [Alembic zero-downtime](https://medium.com/exness-blog/alembic-migrations-without-downtime-a3507d5da24d), **High**).
- Set `lock_timeout` and `statement_timeout` on migration runs against the live DB so a migration fails fast and loud instead of silently holding a lock against production traffic ([Postgres lock/statement timeout guidance](https://oneuptime.com/blog/post/2026-01-21-postgresql-schema-migrations/view), **High**).
- Never point a migration tool at the prod connection string by ambient default — name env vars unambiguously (`PROD_DATABASE_URL` vs `DEV_DATABASE_URL`) and require an explicit confirmation flag for anything destructive.

**Rollback.** Rely on Render's built-in one-click rollback as the primary mechanism — triggering it auto-disables autodeploy so a bad commit can't immediately re-deploy itself ([Render deploy-failure handling](https://render.com/articles/how-render-handles-deploy-failures), **High**). This only stays safe if migrations follow the expand/contract rule above; otherwise a code rollback can point new-old code at a schema it no longer understands.

**Feature flags.** Don't adopt LaunchDarkly or even self-hosted Unleash yet — both are more machinery than a 2-tenant pilot needs, and the multi-tenant structure you already have gives you a natural flag axis for free. A simple `feature_flags` table in Supabase (keyed by tenant + flag name, read at runtime) or per-tenant env-var toggles is enough, and a DB-table approach avoids needing a redeploy to flip a flag ([feature-flag tooling comparison](https://www.growthbook.io/blog/unleash-alternatives), **Medium** — "simple env vars beats a fancy system used poorly" is a consistent theme across sources). Revisit Unleash only if flag count or team size grows meaningfully.

**Release checklist.** See the cross-cutting production-readiness checklist below; for *every* release (not just the cutover), keep it to: CI green → migration reviewed separately if present → deploy → 10-15 min watching Sentry/logs → smoke-test the Telegram flow for one real tenant.

### Do regularly

- **Every PR:** CI must pass; schema/migration-touching PRs get a second reviewer even if trivial-looking.
- **Every deploy:** manual smoke test (send a real Telegram message, confirm a response) + watch error tracking for ~15 min post-deploy.
- **Weekly:** clear stale/open branches — trunk-based development only works if branches don't linger.
- **Monthly:** review deploy frequency and rollback count informally (a DORA-lite gut check, not a dashboard) — rising rollback rate is a signal to slow down or add a staging smoke-test step.

### Monitor / alert on

- CI failure rate / flakiness trend
- Deploy failures (Render → Slack notification)
- Post-deploy error-rate spikes, tied to Sentry release tags so a regression is traceable to a specific deploy

**Confidence:** High on branching model, CI gate shape, and migration discipline (strong consensus across sources and directly load-bearing given the live-DB constraint). Medium on the exact staging-environment shape — that's a cost/rigor tradeoff call, not a settled best practice.

---

## 3. Cost & Security Ops

### Set up once

**Cost monitoring for metered vendors.**
- **DeepInfra (GLM-5.2):** DeepInfra supports setting a monthly spending limit with threshold alerts and hard caps to prevent runaway billing from a bug or usage spike ([DeepInfra pricing/limits](https://deploybase.ai/articles/deepinfra-pricing-breakdown-cost-per-token-model-comparison), **Medium** — feature exists, exact UI/API details weren't independently verified in this pass; confirm current mechanics in the DeepInfra dashboard before relying on it). Set alerts at 50/80/100% of your expected monthly budget, not just a single cap.
- **Brave Search API:** Brave **removed its free tier** and moved to metered credit billing ($5/1K search queries, with $5 in monthly credits included) ([Brave Search API pricing change](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/), **High**, this is a concrete, recent, load-bearing fact — confirm your current spend against it, since this directly affects the existing cost-tracking model). Watch the credit balance in Brave's dashboard and treat it the same as an LLM budget line.
- **AWS Lightsail:** cost is fixed/predictable by plan, but set an **AWS Budgets** alert anyway — it's free and catches surprise charges from snapshot storage growth or data-transfer overage that the flat instance price doesn't cover.
- **Render:** per-service pricing is fixed and predictable at this scale (Starter ~$7/mo per web/worker service, cron jobs bill per-minute with a ~$1/mo floor) — no dedicated alerting needed beyond glancing at the monthly invoice, but factor in that adding a staging environment roughly doubles per-service Render spend ([Render pricing breakdown](https://checkthat.ai/brands/render/pricing), **High**).

This whole area should plug directly into the cost-tracking model already documented in this repo (`cost_rates`/`infra_costs`, the unpriced-counter gap for metered vendors) — the Brave free-tier removal in particular is exactly the kind of "silent crossover" that model was built to catch.

**Secrets management.** At 2-3 people spread across two hosting platforms (Lightsail + Render) plus local dev, secret drift between environments is the realistic failure mode, not a sophisticated attack. Two reasonable defaults:
- **Doppler free tier** (up to 3 users, syncs to Render natively, plus AWS) as a single source of truth across Lightsail, Render, and local dev — sized exactly for this team ([Doppler for small teams](https://www.doppler.com/blog/secrets-management-tools-2025), **Medium**), *or*
- If avoiding a new vendor: Render's native Environment Groups (shared vars across the 5 Render services) + AWS Systems Manager Parameter Store or Secrets Manager for the Lightsail box, with a hard rule that `.env`/`.pem`/`.key` files are gitignored everywhere and secrets are rotated on any team-member offboarding.

Either way: no shared logins, no secrets in git, no secrets pasted into Slack/Telegram history.

**Dependency/vuln updates.** Enable **Dependabot** via `.github/dependabot.yml` for the `pip` ecosystem and for GitHub Actions itself, weekly schedule, auto-PR ([Dependabot Python config](https://www.johal.in/dependabot-python-updates-config-github-actions-ranges-ignore-2025/), **High**). This is free and near-zero-maintenance. Optionally add `pip-audit` as a CI job for a second signal beyond Dependabot's advisory database. Merge security-flagged PRs within days, not the normal weekly-batch cadence for routine bumps.

**Least-privilege access.** For this stack there are exactly four "crown jewel" consoles: AWS, Render, Supabase, GitHub org. Require MFA on all four. On AWS specifically: no root-key usage for daily work, SSH to the Lightsail VM via key only (password auth disabled) ([Lightsail security best practices](https://www.systemsarchitect.io/services/aws-lightsail/security-best-practices), **High**). On Supabase: keep the `service_role` key scoped to backend workers only, never shipped to anything client-facing, and treat RLS policies as the actual access-control boundary, not an afterthought. Every teammate gets their own login everywhere — offboarding should be "revoke this person's access," never "rotate a shared password."

**Backups-as-security.** Treat the independent off-platform backup (Section 4) as a security control as much as a DR control — it's your recovery path if the Supabase account itself is ever compromised, not just if a disk fails.

**Incident basics.** Distinguish a *security* incident (suspected leaked secret, unauthorized access) from an *ops* incident (site down): for security incidents, rotate the credential immediately and investigate after, don't wait for root cause first.

### Do regularly

- **Weekly:** review and merge Dependabot PRs (security-flagged ones fast-tracked); glance at DeepInfra + Brave spend-to-date against monthly budget.
- **Monthly:** reconcile actual AWS + Render + Supabase + DeepInfra + Brave invoices against expected baseline — this is where silent cost creep on metered vendors gets caught; review the access list across all four consoles and remove anything stale.
- **Quarterly:** rotate long-lived API keys/credentials on a schedule (not just on personnel change); check for outstanding OS package updates on the Lightsail box; review Supabase RLS policies against the current schema to catch any new table that shipped without a policy.

### Monitor / alert on

- DeepInfra spend threshold alerts (50/80/100%)
- Brave Search credit balance and query volume trend
- Dependabot alerts, severity-tiered (critical/high → same-day; medium/low → weekly batch)
- AWS Budgets alert
- Unusual Supabase auth activity if/when tenant-facing auth exists

**Confidence:** High on Dependabot, MFA, and least-privilege basics (uncontested standard practice). High-but-verify on the Brave free-tier removal specifically — it's recent (2026) and directly changes this project's cost assumptions, worth confirming current state against the live Brave dashboard rather than trusting this doc's snapshot. Medium on the specific secrets-tooling pick (Doppler vs native env groups) — either is defensible.

---

## 4. Backups & Disaster Recovery

This is the area where getting it wrong is least recoverable, so it gets the most direct opinion.

### Set up once

**The single highest-priority action in this entire document:** confirm the live pilot Supabase project is on a **paid plan (Pro or above)**, not Free. Supabase's Free tier has **no automatic backups at all** — recovery in a Free-tier incident depends entirely on whatever manual `db dump` exports someone remembered to run ([Supabase backups docs](https://supabase.com/docs/guides/platform/backups), **High**, directly verified from Supabase's own documentation). Given this repo's own memory notes flag the hosted "supabase-test" project as the actual live pilot DB, this is worth confirming explicitly rather than assuming. Pro ($25/mo) gets daily automated backups with 7-day retention — the floor of acceptable for a database that real tenants depend on.

**Point-in-Time Recovery (PITR)** is a $100/mo add-on for 7-day granularity (scaling to $200/$400 for 14/28 days), requires a compute upgrade, and gives seconds-level recovery granularity (~2 min worst-case RPO) instead of once-daily snapshots ([Supabase PITR pricing](https://revivedb.dev/blog/supabase-pitr-cost), **High**). At 2 tenants and pilot revenue, this is very likely **not yet worth it** — daily backups give a defensible RPO of ~24h, which is a reasonable target at this stage (see RPO/RTO targets below). Revisit PITR once tenant count, revenue, or actual write volume make a full day of potential data loss unacceptable.

**Independent, off-platform backup — do this regardless of Supabase's plan tier.** Supabase's own backups live inside Supabase's infrastructure; they don't protect against the account itself being compromised, a billing lapse, or a Supabase-side platform incident affecting your project specifically. Set up a **second, independent backup path**: a nightly `pg_dump` (can literally run as one more scheduled job on the existing Lightsail box, or as a lightweight addition to the Render cron pattern already in use for lifecycle-heart/calls-purge) piped to AWS S3 (~$0.023/GB/month — trivially cheap at this data volume). This satisfies the standard **3-2-1 rule** (3 copies, 2 media types, 1 offsite) and is the actual answer to "what if Supabase itself is the problem" ([DR practical guidance](https://phoenixstrategy.group/blog/disaster-recovery-for-saas-companies-guide), **High** — 3-2-1 is uncontested standard practice; the specific implementation choice here is a reasonable, cheap way to hit it on this stack).

**Lightsail VM snapshots.** Even though the VM is likely mostly stateless (workers reading from Supabase), enable Lightsail's built-in automatic daily snapshots for the instance itself, to protect against config drift or anything hand-set-up outside of version control ([Lightsail snapshot backup guidance](https://oneuptime.com/blog/post/2026-02-12-use-lightsail-snapshots-backup/view), **High**). The real fix long-term is making sure the VM's setup is fully reproducible from a documented runbook or IaC rather than a hand-configured snowflake — snapshots are the safety net, not the primary defense, while that's still true.

**Protect the live DB from accidental destruction.** Keep a fully **separate Supabase project** for staging/dev (Supabase's own guidance explicitly recommends this over relying on the Branching feature to substitute for a real production boundary) — never let local or staging tooling default-connect to the prod connection string ([Supabase environment guidance](https://supabase.com/docs/guides/deployment/managing-environments), **High**). Name env vars unambiguously and consider a lightweight "type the project name to confirm" guard on any destructive CLI script that could touch prod.

**RPO/RTO targets — write these down even informally.** For pilot scale with ~2 tenants, a defensible default is **RPO ~24h** (matches the daily-backup cadence) and **RTO ~4h** (time to notice, restore, and verify) ([practical RPO/RTO framing for small SaaS](https://www.dchost.com/blog/en/rpo-rto-and-disaster-recovery-planning-for-small-businesses/), **Medium** — this is a judgment call calibrated to pilot scale rather than a universal number; many sources suggest tighter RPOs for "real" SaaS, but that assumes a cost tolerance this pilot doesn't have yet). Tighten toward RPO ~1h (via PITR) once tenant count or revenue justifies the $100/mo.

### Do regularly

- **Weekly:** verify the previous automated backup actually completed — check the Supabase dashboard's backup list *and* confirm the independent pg_dump→S3 job's last-run log. An unverified backup is not a backup.
- **Monthly — the single most valuable and most commonly skipped practice here:** do a real **restore drill**. Pull the latest backup into a throwaway Supabase project or local Postgres instance and run a sanity check (row counts, spot-check one tenant's data). This is explicitly called out across DR sources as the practice teams skip and shouldn't ([tested restore drills guidance](https://www.dchost.com/blog/en/rpo-rto-and-disaster-recovery-planning-for-small-businesses/), **High**).
- **Quarterly:** full DR drill — simulate "the prod DB is gone," restore from the *independent* off-platform backup (not Supabase's own), actually time it, compare against the RTO target, and update the runbook with whatever broke or surprised you.
- **On every schema change:** confirm the new migration is captured cleanly in the next backup cycle — don't let a backup silently go stale relative to the current schema.

### Monitor / alert on

- Backup job failure — both Supabase's own daily backup and the independent pg_dump cron (wire the latter into the same Sentry Crons / Healthchecks.io heartbeat pattern used for lifecycle-heart and calls-purge, so a silently-broken backup job fails the same way a silently-broken app cron would)
- Backup storage growth trend (catch runaway growth before it's a cost surprise)
- Lightsail snapshot success/failure

### Runbook: "the DB is down or corrupted"

1. **Scope it first.** Check Supabase's status page to rule out a platform-wide incident before assuming it's self-inflicted.
2. **If it's a Supabase platform incident:** no direct remediation available — monitor their status page, and make sure the app fails gracefully (the Telegram bot should catch DB errors and reply something like "temporarily unavailable," not hang or crash the worker).
3. **If it's self-inflicted (bad migration, accidental delete/drop):** stop all writers immediately — pause or scale the Render workers to zero to prevent compounding the damage — before attempting any restore.
4. **Restore:** prefer Supabase's own PITR/daily-backup restore if available and sufficient; otherwise restore the latest independent pg_dump into a fresh Supabase project and re-point `DATABASE_URL`.
5. **Before resuming traffic:** run data-integrity spot checks (row counts, a known tenant's recent records) — don't just restore and immediately flip traffic back on.
6. **After:** write down the actual data-loss window and compare it against the RPO target; blameless postmortem within 48h.
7. **Communicate:** have a canned tenant-facing status message ready (Telegram announcement) for any outage that crosses ~30 minutes — don't compose it for the first time mid-incident.

**Confidence:** High on the overall architecture (paid-plan daily backups + independent off-platform 3-2-1 backup + separate staging project + tested restores is uncontested DR practice, and the Supabase Free-tier no-backup fact is directly sourced from their docs). Medium on the specific RPO/RTO numbers, which are a pilot-scale calibration rather than a universal standard.

---

## Cross-Cutting: Lightweight Incident Response Runbook

- **Severity levels:** SEV1 (all tenants down, or any data-loss risk) / SEV2 (single tenant or feature degraded) / SEV3 (cosmetic, non-urgent).
- **Roles, scaled to 2-3 people:** don't formalize incident-commander/scribe roles for SEV2/SEV3 — whoever notices it owns it through resolution or explicitly hands it off. For SEV1, name one person as "driver" out loud in the incident channel specifically to prevent two people applying conflicting fixes simultaneously.
- **Comms:** post start-of-incident and resolution in the shared channel always; for SEV1, post progress updates every 15-30 min even if the update is "still investigating."
- **Postmortem:** blameless, written within 48h for every SEV1 and any repeated SEV2. Keep it to half a page: what happened, impact, timeline, root cause, action items with an owner and a date. A postmortem that never gets written might as well not have happened — the value is entirely in the action items landing ([postmortem guidance](https://theartofcto.com/guides/incident-postmortem-template-blameless-post-incident-review-guide), **High**).

## Cross-Cutting: Production-Readiness Checklist (for the pilot→production cutover)

- [ ] `/health` endpoint live on the web service, wired to an external uptime monitor
- [ ] Sentry wired into the web service **and all four workers**; one test error confirmed captured end-to-end
- [ ] Cron heartbeat monitoring live on lifecycle-heart and calls-purge
- [ ] Supabase confirmed on a **paid plan** with daily backups enabled (not Free)
- [ ] Independent off-platform `pg_dump` → S3 backup running, and **restore-tested at least once**
- [ ] CI required checks (ruff, mypy, pytest) blocking merge to `main`
- [ ] Rollback tested at least once for real, not just assumed to work
- [ ] Secrets confirmed out of git history; anything used during dev/demo rotated before go-live
- [ ] MFA enabled on AWS, Render, Supabase, and the GitHub org
- [ ] Dependabot enabled for `pip` and GitHub Actions ecosystems
- [ ] Cost alerts configured on DeepInfra spend, Brave Search credit balance, and AWS Budgets
- [ ] A staging Supabase project fully separate from prod (no shared connection strings, ever)
- [ ] A confirmation guard exists on any destructive script that could touch the prod DB
- [ ] This runbook doc exists somewhere every teammate knows to find it

## Cross-Cutting: Ops Calendar

**Daily (~5 min, passive):** glance at the shared alerts channel; skim new Sentry issues. Nothing required if nothing fired.

**Weekly (~30-45 min):** review/merge Dependabot PRs (security ones fast-tracked); triage Sentry error trends; verify last night's backup actually completed; check DeepInfra/Brave spend against budget; clear stale open branches/PRs.

**Monthly (~1-2 hrs):** restore drill (pull latest backup into a throwaway instance, sanity-check it); full invoice reconciliation across AWS/Render/Supabase/DeepInfra/Brave; access-list review across the four crown-jewel consoles; uptime/SLO gut-check against the informal 99% target.

**Quarterly (~half a day):** full DR drill simulating total DB loss, timed against the RTO target, with the runbook updated afterward; credential rotation; Lightsail OS package/vuln check; prune stale feature flags; sanity-check whether any free tier has been quietly outgrown (Supabase, Sentry, Better Stack, GitHub Actions minutes).

---

## Sources

1. [Render — Best Practices for Maximizing Uptime](https://render.com/docs/uptime-best-practices) — primary vendor docs, authoritative for Render-specific health-check/deploy behavior.
2. [Render — How Render handles deploy failures](https://render.com/articles/how-render-handles-deploy-failures) — primary vendor docs on rollback mechanics.
3. [Render — Best practices for git-based deployment in production](https://render.com/articles/best-practices-for-implementing-git-based-deployment-in-production-environments) — vendor guidance, includes forward-only migration recommendation.
4. [Render Pricing 2026 breakdown](https://checkthat.ai/brands/render/pricing) — third-party pricing aggregation, cross-checked against vendor site.
5. [Supabase — Database Backups docs](https://supabase.com/docs/guides/platform/backups) — primary vendor docs, directly fetched and verified (Free tier has no automatic backups; Pro = daily/7-day retention).
6. [Supabase — Manage PITR usage](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery) — primary vendor docs on PITR mechanics/billing.
7. [Supabase PITR cost analysis — ReviveDB](https://revivedb.dev/blog/supabase-pitr-cost) — third-party pricing breakdown, consistent with vendor docs.
8. [Supabase — Branching docs](https://supabase.com/docs/guides/deployment/branching) — primary vendor docs, explicitly recommends separate projects over branching-as-prod-substitute.
9. [Supabase — Managing Environments](https://supabase.com/docs/guides/deployment/managing-environments) — primary vendor docs on dev/staging/prod separation.
10. [Sentry Pricing 2026 — checkthat.ai](https://checkthat.ai/brands/sentry/pricing) — third-party pricing aggregation.
11. [Uptime monitoring tools compared 2026 — OnlineOrNot](https://onlineornot.com/uptime-monitoring-tools) — includes the UptimeRobot commercial-use ToS caveat.
12. [Better Stack Pricing](https://betterstack.com/pricing) — primary vendor pricing page.
13. [Trunk Based Development — trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/) — canonical reference on the practice.
14. [Atlassian — Trunk-based Development](https://www.atlassian.com/continuous-delivery/continuous-integration/trunk-based-development) — corroborating authoritative source.
15. [2025 GitHub Actions setup for Python projects](https://ber2.github.io/posts/2025_github_actions_python/) — current (2025) practitioner reference for ruff/mypy/pytest CI shape.
16. [Zero-downtime database migrations in production](https://dev.to/matthiasbruns/database-migrations-in-production-zero-downtime-strategies-that-actually-work-3e4l) — expand/contract pattern guidance.
17. [Alembic migrations without downtime — Exness Tech Blog](https://medium.com/exness-blog/alembic-migrations-without-downtime-a3507d5da24d) — Alembic-specific corroboration.
18. [PostgreSQL schema migration lock/statement timeout guidance](https://oneuptime.com/blog/post/2026-01-21-postgresql-schema-migrations/view) — timeout configuration for safe migrations.
19. [Feature flags: LaunchDarkly, Unleash, or DIY — practitioner comparison](https://www.growthbook.io/blog/unleash-alternatives) — "simple env vars over enterprise tooling" theme, corroborated across multiple sources in this search.
20. [DeepInfra pricing/spending-limit overview](https://deploybase.ai/articles/deepinfra-pricing-breakdown-cost-per-token-model-comparison) — third-party summary; **verify exact spending-limit UX directly in the DeepInfra dashboard**, not independently confirmed via primary docs in this pass.
21. [Brave Search API free-tier removal](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/) — recent (2026), directly load-bearing for this project's existing cost-tracking assumptions.
22. [Doppler secrets management for small teams](https://www.doppler.com/blog/secrets-management-tools-2025) — vendor blog, cross-checked against G2/comparison sources for the 3-user free tier claim.
23. [Dependabot Python/GitHub Actions configuration guidance 2025](https://www.johal.in/dependabot-python-updates-config-github-actions-ranges-ignore-2025/) — practical `.github/dependabot.yml` setup reference.
24. [AWS Lightsail security best practices](https://www.systemsarchitect.io/services/aws-lightsail/security-best-practices) — SSH key-only access, MFA, firewall hardening guidance.
25. [AWS Lightsail snapshot backup guidance](https://oneuptime.com/blog/post/2026-02-12-use-lightsail-snapshots-backup/view) — automated daily-snapshot recommendation.
26. [RPO/RTO planning for small businesses — DCHost](https://www.dchost.com/blog/en/rpo-rto-and-disaster-recovery-planning-for-small-businesses/) — practical small-scale RPO/RTO framing and 3-2-1 backup rule.
27. [Disaster recovery for SaaS companies — Phoenix Strategy Group](https://phoenixstrategy.group/blog/disaster-recovery-for-saas-companies-guide) — SaaS-specific DR guidance corroborating restore-drill and 3-2-1 practices.
28. [Incident postmortem template — The Art of CTO](https://theartofcto.com/guides/incident-postmortem-template-blameless-post-incident-review-guide) — blameless postmortem format reference.
29. [Grafana Cloud free tier pricing 2026](https://monitoringcost.com/grafana-cloud-pricing) — third-party pricing breakdown for the optional metrics-stack escalation path.
30. [SRE fundamentals: SLIs, SLOs, error budgets](https://medium.com/@amishasinha_31533/service-reliability-engineering-sre-fundamentals-a-complete-guide-to-slis-slos-error-budgets-4da45b679716) — background for the "skip formal SLOs at pilot scale" judgment call.

## Overall Confidence & Gaps

- **High confidence:** the shape of all four areas (uptime + errors + cron heartbeats; trunk-based CI/CD with expand/contract migrations; Dependabot + MFA + least-privilege; paid-plan backups + independent off-platform 3-2-1 + tested restores) is consistent across every authoritative and practitioner source consulted, and several load-bearing facts (Supabase Free has no backups, Brave dropped its free tier, Render doubles cost per duplicated environment) were confirmed against primary vendor sources.
- **Medium confidence / judgment calls flagged inline:** specific vendor picks where multiple tools are defensible (Better Stack vs UptimeRobot-paid; Doppler vs native env groups); the informal RPO/RTO numbers, which are calibrated to pilot scale rather than pulled from a universal standard.
- **Gap — not independently verified:** the exact current DeepInfra spending-limit/alert UX (source was a third-party summary, not DeepInfra's own docs) — confirm directly in the dashboard before relying on it as the sole cost guardrail.
- **Not covered by this research pass:** container/image-level security scanning (not obviously relevant given this stack isn't containerized on Lightsail as described), and formal compliance frameworks (SOC 2 etc.) — reasonably out of scope at 2-tenant pilot scale, but flagging the omission explicitly.
