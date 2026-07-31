---
date: 2026-07-30
branch: feature-run-resolve
commit: 0d45b3b
topic: Testing → production fork — every environment-coupled surface, and what standing up a parallel production environment would touch
---

## Summary

This repo currently runs one real deployment: the **pilot**. Its database is the hosted Supabase
project named "test" (`daqapdlkgxfrhquacprv`) — which is, despite the name, live production data
for the pilot customers. The **prod** Supabase project (`lzlgysoydhknsdvovntz`) exists but is
factory-fresh and empty; during this research its database connections timed out (management API
answers, SQL does not — consistent with an auto-paused idle project, unverified).

The load-bearing finding: **there is no environment switch anywhere in the code.** One Supabase
client is built at process start from `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
([client.ts:11-15](../../../src/db/client.ts#L11-L15)); no `NODE_ENV` branch, no multi-client
registry, no per-request selection exists. "Which environment am I?" is decided entirely by which
env values a process was launched with. A production fork is therefore **not a code fork** — it is
a second, parallel set of externally-configured surfaces: a second Supabase project with the same
32 migrations, a second trio of Render services with their own ~25 hand-typed env vars, a second
agent-stack host (or a repointed one), new Telegram bots, a new Composio webhook target, and a
fresh credential set for every third-party service. Nothing in `src/` needs to change to do this;
what does need attention is a small set of *operator-script guards and defaults* that currently
hardcode the pilot as the only allowed hosted target.

## Entry Points

The deployed processes (each one picks up its environment purely from env vars at launch):

| Surface | Entry point | Started by |
|---|---|---|
| Web service (MCP + webhook + board + admin) | [src/mcp/httpServer.ts:336](../../../src/mcp/httpServer.ts#L336) `main()` | Render web service → `npm run mcp:serve:http` ([package.json:13](../../../package.json#L13)) |
| Board notification worker | [src/telegram/boardWorker.ts:13](../../../src/telegram/boardWorker.ts#L13) `startBoardWorker()` | Render background worker → `npm run board:worker` ([package.json:14](../../../package.json#L14)) |
| Lifecycle cron (7 sweeps, `*/15 * * * *` UTC) | [src/jobs/lifecycle.ts:95](../../../src/jobs/lifecycle.ts#L95) `runLifecycle()` | Render cron job → `npm run job:lifecycle` ([package.json:20](../../../package.json#L20)) |
| Badge pull (host → server, every 5 min) | [Box_Setup_Stuff/badge-pull.sh:151](../../../Box_Setup_Stuff/badge-pull.sh#L151) → `GET /control/badges` ([httpServer.ts:246](../../../src/mcp/httpServer.ts#L246)) | systemd timer on trades-box-1 |
| Doorman (sandbox → Render proxy) | [Box_Setup_Stuff/doorman.mjs:9](../../../Box_Setup_Stuff/doorman.mjs#L9) (`MCP_UPSTREAM_URL`) | systemd on trades-box-1 |
| stdio MCP server (dev only, not deployed) | `dist/mcp/server.js` via `npm run mcp:serve` ([package.json:12](../../../package.json#L12)) | local shell |

## Key Files

**Environment definition**
- [.env.example](../../../.env.example) — documented template. **Stale**: missing ~17 vars the live services actually carry (`BOARD_BOT_TOKEN`, `BOARD_BOT_HANDLE`, `BOARD_PUBLIC_URL`, `BOARD_POLL_MS`, `BOARD_STATIC_DIR`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_ROUTES_SA_KEY_JSON`, `COMPOSIO_RELAY_API_KEY`, `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `DEEPINFRA_BILLING_API_KEY`, `GRACE_DAYS`, `WEB_SEARCH_DAILY_LIMIT`, `WEB_FETCH_DAILY_LIMIT`, `WEB_FETCH_MAX_URL_CHARS`, `INBOUND_DEBUG`, `INBOUND_DEBUG_FILE`, `EVAL_*`).
- `.env` (git-ignored; 17 vars) — local dev-helper env pointed at the pilot. Carries two **retired** vars (`SCHEDULE_SHEET_ID`, `GOOGLE_APPLICATION_CREDENTIALS` — retired 2026-07-15 per [.env.example:40-41](../../../.env.example#L40-L41)) and several vars the example doesn't document.
- [.env.test.example](../../../.env.test.example) / `.env.test` — exactly three vars pinning tests to the local Docker stack.
- **The full deployed env lives only in the Render dashboard** — no `render.yaml`, no Dockerfile, no Procfile, no CI config exists anywhere in the repo.

**Environment enforcement (the guards)**
- [src/testEnvGuard.ts:11-40](../../../src/testEnvGuard.ts#L11-L40) — test suite refuses any non-`127.0.0.1`/`localhost` DB (host-parse, fail-closed). Protects *any* hosted project, prod included, automatically.
- [scripts/seed.mjs:72-97](../../../scripts/seed.mjs#L72-L97) — `TEST_REF = 'daqapdlkgxfrhquacprv'`; both URLs must agree on `hosted-test` or `local`; hosted also needs `--hosted`; roster additionally needs `--with-roster`. **A prod URL is "unknown target" → hard refusal.**
- [scripts/assign-host.mjs:42-46](../../../scripts/assign-host.mjs#L42-L46), [scripts/provision-session.mjs:22-26](../../../scripts/provision-session.mjs#L22-L26), [scripts/backfill-schedule.mjs:55-68](../../../scripts/backfill-schedule.mjs#L55-L68) — same pilot-ref allowlist. These are the tools that mint `HOST_PULL_TOKEN`s and Composio sessions — **as written they cannot operate on prod at all.**
- [scripts/second-stack.sh](../../../scripts/second-stack.sh) — per-worktree local stacks; irrelevant to hosted envs but proves the repo migrations build a working schema from scratch.

**Environment consumers (runtime)**
- [src/db/client.ts:11-15](../../../src/db/client.ts#L11-L15) — the single Supabase client; service-role key only. **No anon/publishable key is used anywhere in the repo** (server-side only; RLS is bypassed by design).
- [src/mcp/identity.ts:44](../../../src/mcp/identity.ts#L44) — `GATEWAY_IDENTITY_SECRET` HMAC verification (must be byte-identical on the box's `/etc/doorman/doorman.env`).
- [src/model/forcedTool.ts:49](../../../src/model/forcedTool.ts#L49) — `MODEL_PROVIDER` selects DeepInfra-GLM vs Anthropic for all four forced-tool calls.
- [src/inbound/webhook.ts:129](../../../src/inbound/webhook.ts#L129) — `COMPOSIO_WEBHOOK_SECRET` (Standard-Webhooks HMAC).
- [src/composio/relayHandler.ts:145,184](../../../src/composio/relayHandler.ts#L145) — `COMPOSIO_RELAY_API_KEY ?? COMPOSIO_API_KEY`.
- [src/composio/pairing.ts:64](../../../src/composio/pairing.ts#L64) — `COMPOSIO_GMAIL_AUTH_CONFIG_ID`.
- [src/routes/geocode.ts:27](../../../src/routes/geocode.ts#L27), [src/routes/googleRoutes.ts:28](../../../src/routes/googleRoutes.ts#L28), [src/mcp/server.ts:5148](../../../src/mcp/server.ts#L5148) — `GOOGLE_MAPS_API_KEY`.
- [src/routes/roiClient.ts:22](../../../src/routes/roiClient.ts#L22) — `GOOGLE_ROUTES_SA_KEY_JSON` (raw one-line JSON; the GCP `project_id` is read **out of the JSON**, no separate env var).
- [src/telegram/boardApi.ts:82](../../../src/telegram/boardApi.ts#L82), [src/telegram/boardBot.ts:13,34](../../../src/telegram/boardBot.ts#L13) — `BOARD_BOT_TOKEN`, `BOARD_PUBLIC_URL` (base URL, **no `/board` suffix**), plus `BOARD_BOT_HANDLE` at [src/mcp/server.ts:1238](../../../src/mcp/server.ts#L1238).
- [src/admin/adminApi.ts:51-63](../../../src/admin/adminApi.ts#L51-L63) — `ADMIN_DASHBOARD_TOKEN` (unset ⇒ 503, fail-closed).
- [src/web/braveSearch.ts:18](../../../src/web/braveSearch.ts#L18) — `BRAVE_API_KEY`.
- [src/model/deepinfraUsage.ts:98-107](../../../src/model/deepinfraUsage.ts#L98-L107) — `DEEPINFRA_BILLING_API_KEY` (falls back to `INFERENCE_API_KEY` when pointed at DeepInfra).
- [src/mcp/httpServer.ts:31,337](../../../src/mcp/httpServer.ts#L31) — `ALLOWED_CLIENT_IPS` (unset = open), `MCP_HTTP_PORT` (**must be set to Render's assigned `PORT`** or the service never binds — [docs/doorman-runbook.md:99-101](../../../docs/doorman-runbook.md#L99-L101)).

**Agent stack (trades-box-1, AWS Lightsail, 34.211.61.184)**
- [Box_Setup_Stuff/bootstrap-box.sh:36-37](../../../Box_Setup_Stuff/bootstrap-box.sh#L36-L37) — `MCP_UPSTREAM_URL` and `PULL_URL` **default to `https://tradesdatabase.onrender.com/…`** (env-overridable). These are the only pilot-URL defaults in runtime code.
- Sandboxes carry exactly **two** credentials: `TELEGRAM_BOT_TOKEN` (injected into the onboard process env) and `TRADES_SPINE_BADGE` (minted server-side, auto-installed by badge-pull). Never in a sandbox: Supabase keys, `GATEWAY_IDENTITY_SECRET`, Composio keys, model keys.
- Host-only secrets: `GATEWAY_IDENTITY_SECRET` (`/etc/doorman/doorman.env`, must match Render), `HOST_PULL_TOKEN` (`/etc/doorman/badge-pull.env`, printed once by `assign-host.mjs create-host`; server stores only its sha256).
- Model routing is **box-wide**, not per-sandbox: one gateway inference route (`deepinfra-prod` / `zai-org/GLM-5.2`), re-asserted by `nemoclaw-inference-medic.timer` every 15 min.
- AGENTS.md contract blocks are eight heredocs inside `phase_wire` ([bootstrap-box.sh:478-863](../../../Box_Setup_Stuff/bootstrap-box.sh#L478-L863)); the freeze ritual is an **in-container OpenClaw cron**, wiped by sandbox rebuilds — not a Render cron.

**Database**
- [supabase/migrations/](../../../supabase/migrations/) — 32 files, `20260620005307_context_spine.sql` → `20260726120000_customers_geocoding.sql`. Filename order is **non-monotonic** vs authoring order (cost_* files 2026-07-25 sort before customers_geocoding 2026-07-26 but after job_duration_ladder/unplaced_visits stamped 2026-07-24): a fresh stack needs `npx supabase migration up --include-all`.
- [supabase/config.toml:31](../../../supabase/config.toml#L31) — `auto_expose_new_tables = true`: every new table is Data-API-exposed by default (this is why the cost tables got an explicit RLS migration, `20260725140000`).
- `supabase/config.toml` `[db.seed]` points at `./seed.sql`, **which does not exist** — all seeding is `scripts/seed.mjs`.

## Data Flows

How environment identity reaches every process (there is exactly one mechanism):

```
                    ┌─ WHICH ENVIRONMENT? = whichever env vars the process launched with ─┐

Local dev/scripts          Tests                      Deployed (pilot today)
─────────────────          ─────                      ──────────────────────
.env ──dotenv──►           .env ──then──              Render dashboard env ──►  web service ─┐
 process.env               .env.test (override:true)  (typed by hand,           board worker ├─► SUPABASE_URL
                            ──► assertLocalTestEnv     no file anywhere)        lifecycle cron┘      │
                                (127.0.0.1 only)                                                     ▼
                                                                                        daqapdlkgxfrhquacprv
                                                                                        (the pilot's LIVE data)

trades-box-1 (host)                                   sandboxes (per person)
───────────────────                                   ────────────────────
/etc/doorman/doorman.env   GATEWAY_IDENTITY_SECRET    TELEGRAM_BOT_TOKEN + TRADES_SPINE_BADGE only
/etc/doorman/badge-pull.env  PULL_URL + HOST_PULL_TOKEN   │
        │                                                 ▼
        └────────► https://tradesdatabase.onrender.com ◄──┘   (bootstrap default, env-overridable)
```

The deploy path for the pilot (assembled from docs; a prod fork would need its own copy of each step):

```
dev repo (hongyi42/…) main
        │  manual sync — Render deploys a SEPARATE repo, not this one (HANDOFF.md:69-72)
        ▼
Render-connected repo ──"deploy latest commit"──► 3 Render services   (never "Redeploy": re-runs OLD commit)
        │
        │  migrations are NOT auto-applied by any deploy
        ▼
Supabase MCP apply_migration (canonical for the pilot; db push unreliable due to ledger drift)
        + NOTIFY pgrst, 'reload schema'
        │
        ▼
if tool DESCRIPTIONS changed: nemoclaw <s> gateway restart on every live sandbox
byte-verify: GET /board/static/board.js identical to main; scripts/smoke-http.mjs
```

**Migration-ledger drift, measured today:** the repo's 32 filenames and the pilot's 32 ledger
entries match **1:1 by name**, but the *version numbers* differ for all 18 migrations applied
after 2026-07-04 (e.g. repo `20260704210155_scheduling_foundation` is recorded on the pilot as
`20260707064740`; repo `20260726120000_customers_geocoding` as `20260727035906`) — because MCP
applies stamp apply-time versions ([docs/engineering-memory.md:277-282](../../../docs/engineering-memory.md#L277-L282)).
Consequence recorded in engineering-memory: `db push --linked` against the *pilot* would try to
re-apply files and fail. A **fresh** project has no such history, and the local stacks prove the
repo files build the full schema from zero.

**Env vars per deployed surface** (what a prod copy of each service must carry):

| Service | Required | Optional / defaulted |
|---|---|---|
| Web | `MCP_HTTP_PORT`(=Render `PORT`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GATEWAY_IDENTITY_SECRET`, `COMPOSIO_WEBHOOK_SECRET`, `COMPOSIO_API_KEY`, `COMPOSIO_GMAIL_AUTH_CONFIG_ID`, `MODEL_PROVIDER`+`INFERENCE_API_KEY` (or `ANTHROPIC_API_KEY`), `BRAVE_API_KEY`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_ROUTES_SA_KEY_JSON`, `BOARD_BOT_TOKEN`, `BOARD_BOT_HANDLE`, `ADMIN_DASHBOARD_TOKEN` | `ALLOWED_CLIENT_IPS` (unset = open!), `COMPOSIO_RELAY_API_KEY`, `INFERENCE_BASE_URL`/`INFERENCE_MODEL`, `ANTHROPIC_MODEL`, `WEB_*` limits, `BOARD_STATIC_DIR`, `ADMIN_STATIC_DIR`, `INBOUND_DEBUG*` (leave unset) |
| Worker | `BOARD_BOT_TOKEN`, `BOARD_PUBLIC_URL` (no `/board` suffix), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `BOARD_POLL_MS` (default 30 000) |
| Cron | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COMPOSIO_API_KEY` | `GRACE_DAYS` (default 7), `DEEPINFRA_BILLING_API_KEY` (else `INFERENCE_API_KEY`+`INFERENCE_BASE_URL`+`MODEL_PROVIDER`) |

Render env values are **bare** — no dotenv quoting; `GOOGLE_ROUTES_SA_KEY_JSON` is pasted as raw
one-line JSON ([docs/engineering-memory.md:356-359](../../../docs/engineering-memory.md#L356-L359)).

## External Dependencies

Each row is a credential/config surface a production fork needs its own instance of:

| Service | Pilot state | Coupling |
|---|---|---|
| Supabase | `daqapdlkgxfrhquacprv` (pilot live) / `lzlgysoydhknsdvovntz` (empty; DB timed out during research — likely paused, unverified) | `SUPABASE_URL` + service-role key on all three Render services; MCP servers configured **outside the repo** (user-level; no `.mcp.json` checked in), prod one read-only |
| Render | 3 hand-configured services on `tradesdatabase.onrender.com`; deploys from a separate synced repo; free-tier cold start ~32 s **exceeds the agent's 30 s MCP connect timeout** | Zero IaC — the entire service config lives in the dashboard |
| Telegram | Global board bot `@DashboardMan_bot` (token + handle + menu-button URL set at worker startup) + one agent bot per sandbox (tokens in `SECRETS.env` at provision time) | `BOARD_BOT_TOKEN/HANDLE/PUBLIC_URL`; per-sandbox `TELEGRAM_BOT_TOKEN` |
| Composio | Master `COMPOSIO_API_KEY`; optional scoped relay key; webhook subscription is **SDK-only config** (`triggers.setWebhookSubscription()` — no dashboard page) pointing at `…/inbound/composio`; Gmail auth config `ac_5CdPk4l3GV2V` literally named `gmail-test` ([docs/nemoclaw-tech-agent.md:378](../../../docs/nemoclaw-tech-agent.md#L378), also defaulted in [scripts/composio-reconnect.mjs:52](../../../scripts/composio-reconnect.mjs#L52)) | Webhook secret must match the deployed service; per-person sessions minted by the lifecycle cron |
| Google Cloud | `GOOGLE_MAPS_API_KEY` (Geocoding + Routes; **key-level API restriction** was a recorded trap — enabling the API on the project is not enough, the key's allowlist must include it) + Route Optimization service account JSON (GCP project id embedded in the JSON) | Two independent credentials, one GCP project today |
| DeepInfra / NVIDIA | `INFERENCE_API_KEY` (GLM-5.2), billing key for the cost collector; box-side `deepinfra-prod` route + `nvidia-prod` rollback | Render env + box gateway config |
| Anthropic | `ANTHROPIC_API_KEY` kept as the `MODEL_PROVIDER=anthropic` revert path | Render env |
| Brave Search | `BRAVE_API_KEY`, metered | Render web env |
| AWS Lightsail | trades-box-1 (34.211.61.184) — doorman, badge-pull timer, recycler, medics, 6-sandbox fleet | Host env files point at exactly **one** upstream (`MCP_UPSTREAM_URL`/`PULL_URL` are host-global, as is `GATEWAY_IDENTITY_SECRET`) |

## Constraints and Invariants

1. **One env-var mechanism, no code switch.** Environment identity = launch-time env values. The
   same build artifact serves any environment.
2. **The name "test" lies.** `daqapdlkgxfrhquacprv` is the pilot's live DB; `raw_captures` there
   is real, unrecoverable customer mail (L1 is append-only, delete-proof by trigger). Any
   "promote to prod" work must treat the *test-named* project as the thing to protect.
3. **The operator scripts hard-refuse prod.** `seed.mjs`, `assign-host.mjs`,
   `provision-session.mjs`, `backfill-schedule.mjs` allowlist exactly {pilot ref, localhost}. A
   prod host row, prod badges, and prod Composio sessions **cannot be minted with today's
   scripts** — the doctrine "prod remains read-only" is enforced in four places that a
   production go-live inherently collides with.
4. **`testEnvGuard` protects prod automatically** (host-based localhost check) — no change
   needed there for a prod fork.
5. **One box = one environment.** `GATEWAY_IDENTITY_SECRET`, `PULL_URL`, `MCP_UPSTREAM_URL` are
   host-global files on trades-box-1; the inference route is box-wide. Nothing in the current
   config shape lets sandbox A point at the pilot and sandbox B at prod on the same host.
6. **No IaC anywhere.** All three Render services and their ~25 env vars exist only in the
   dashboard; losing the Render account loses the config. `.env.example` under-documents the
   deployed set by ~17 vars (list in Key Files).
7. **Deploys don't migrate.** DB schema moves only via explicit `apply_migration` (pilot) — and
   the ordering rule is migration first, then deploy, then `NOTIFY pgrst, 'reload schema'`
   (deploy-before-migration incident, 2026-07-19).
8. **Migration filename order ≠ chronological order** — fresh environments need
   `migration up --include-all` (or `db push`, which replays all files in filename order on an
   empty ledger).
9. **Fail-closed vs fail-open defaults worth knowing when cloning env:** `ADMIN_DASHBOARD_TOKEN`
   unset ⇒ 503 (closed); `ALLOWED_CLIENT_IPS` unset ⇒ **all IPs allowed** (open);
   Composio keys unset ⇒ relay 503s / cron steps skip cleanly; `MCP_HTTP_PORT` malformed ⇒ `NaN`
   (it's `Number(x ?? 8080)`, not the `safeEnvInt` pattern).
10. **Security posture as-built:** service-role key only, no anon key used anywhere; RLS is OFF
    on 16 of 20 pilot tables (all but the four cost tables). The Supabase advisor flags this as
    critical: anyone holding the project's **anon key** (which every Supabase project has, and
    PostgREST auto-exposes tables per `auto_expose_new_tables = true`) can read/write those
    tables directly. Today's mitigation is simply that the anon key is never distributed. This is
    a documented finding, not something this research changes.
11. **PII lives in docs:** `docs/engineering-memory.md:174-188` carries real Telegram user ids
    for four named people; `Box_Setup_Stuff/doorman-architecture-memory.md:105` and two operator
    scripts carry the Default Tenant UUID. The `.claude/worktrees/retraction-fold-impact/`
    checkout duplicates every identifier in this doc's inventory.
12. **Free-tier limits bite:** Render cold start (~32 s) already exceeds the sandbox MCP connect
    timeout (30 s); Supabase free projects auto-pause when idle (the prod project's observed
    state is consistent with this).

## Decision Points

Factual forks in the road for standing up the production environment — no recommendations here;
each option is stated in terms of what the code/config does today.

1. **Prod database: revive `lzlgysoydhknsdvovntz` or create a fresh project.** The existing prod
   project is empty and currently unreachable at the DB level (likely paused). Either way the
   schema path is the same: apply the repo's 32 migration files to an empty ledger (the local
   stacks prove they build from zero; `--include-all`/`db push` handles the non-monotonic
   ordering). Reviving means unpausing (and, if idle-pausing is to stop, a paid tier); fresh
   means new ref, new keys, and updating the user-level `supabase-prod` MCP server config.
   Relevant either way: the prod MCP server is configured **read-only** today, and applying
   migrations through it would require changing that configuration (it lives outside the repo).

2. **Where prod's DDL authority lives: repo-file replay (`supabase db push`) vs MCP
   `apply_migration`.** The pilot drifted into MCP-with-apply-time-versions and its ledger no
   longer matches filenames; a brand-new prod project starts clean, so either mechanism works on
   day one — but whichever is chosen becomes the ledger convention, and the pilot's history shows
   mixing them is what created the drift.

3. **Render: a second trio of services vs re-pointing the existing ones.** "Keep testing intact"
   implies the existing web/worker/cron stay on the pilot, so prod means three new dashboard-
   configured services (new name → new `*.onrender.com` URL) and a full re-type of the env table
   above with prod values. Open sub-choices the current setup creates: which repo/branch the new
   services build from (today Render tracks a separate manually-synced repo); and whether prod
   runs on a paid tier (the 32 s free-tier cold start already breaks sandbox MCP connects on the
   pilot).

4. **Agent stack: second Lightsail box vs flipping trades-box-1.** Because upstream URL, pull
   token, identity secret, and inference route are host-global, serving both environments from
   one box is not expressible in the current config. A prod box would re-run the 12
   `bootstrap-box.sh` phases with `MCP_UPSTREAM_URL`/`PULL_URL` overridden to the prod Render
   URL, a prod-matching `GATEWAY_IDENTITY_SECRET`, a prod `HOST_PULL_TOKEN` (minted by
   `assign-host.mjs create-host` — see point 5), new per-sandbox Telegram bot tokens, and
   re-created in-container freeze crons. Flipping the existing box instead would take the pilot's
   technicians offline.

5. **The four pilot-ref guards: how operator scripts learn about prod.** `seed.mjs`,
   `assign-host.mjs`, `provision-session.mjs`, `backfill-schedule.mjs` all refuse any hosted
   target that isn't `daqapdlkgxfrhquacprv`. Standing up prod requires *some* sanctioned write
   path for: creating the prod tenant row, roster, host row + pull token, and Composio sessions.
   The fork: extend the guards (e.g. a prod ref + its own explicit flag), or perform those writes
   by another means (SQL editor / MCP) and leave the scripts pilot-only. This decision touches
   the standing "prod remains read-only" rule in CLAUDE.md — which was written when prod was an
   empty placeholder, and which going-to-production inherently supersedes in some controlled form.

6. **Telegram identity: new bots or reuse.** The board bot's menu-button URL is set at worker
   startup from `BOARD_PUBLIC_URL` — one bot can point at one board URL, so a prod board needs
   its own bot (new token + handle) unless the pilot board is retired. Same shape per-sandbox:
   each prod sandbox needs its own agent bot token.

7. **Composio tenancy: same account with new configs vs separate workspace.** Prod needs a
   webhook subscription pointing at the prod `/inbound/composio` URL (SDK-only setting — one
   subscription per Composio project is the shape the docs describe), its own webhook secret, a
   prod Gmail auth config (the current one is named `gmail-test`), and prod-scoped relay key.
   Whether that's a second Composio project/workspace or more configs in the current one is an
   account-structure question outside the repo. External-docs rule applies: verify against
   current Composio docs before building.

8. **Google Cloud: same project with new keys vs separate prod project.** The Maps key and the
   Route Optimization service account are independent credentials; the SA JSON embeds its GCP
   project id, so a separate prod GCP project is purely an account decision — the code reads
   whatever JSON it's given. The recorded key-restriction trap (project-level enable ≠ key
   allowlist) applies to any new key minted.

9. **Data carry-over: what "fork" means for data.** Everything from testing stays where it is
   (the pilot keeps its DB). Prod starts from empty: tenant row(s), roster, scheduling config,
   and geocoded customers all need a creation path. `seed.mjs` writes *demo* data only and is
   pilot/local-gated — it is not a prod-onboarding tool as written. There is no
   customer-data-migration tooling in the repo (nothing today moves L1/L2 rows between projects).

10. **Prod security posture: keep the pilot's shape or harden at fork time.** As-built: RLS off
    on all spine tables (service-role-only access model), `/admin` bearer-token-gated on a public
    URL, `ALLOWED_CLIENT_IPS` optional. A fresh prod project is the natural moment the RLS/anon-key
    question resurfaces (the Supabase advisor flags it critically on the pilot today; blanket
    `ENABLE ROW LEVEL SECURITY` without policies would break nothing for the service-role client
    but is still a deliberate choice someone must make). Documented as the fork it is — enabling
    RLS on the 16 tables, restricting Data-API exposure, or keeping the current
    anon-key-never-leaves-the-vault posture.

## Open Questions

1. **Is `lzlgysoydhknsdvovntz` paused?** Management API answers, SQL times out (observed twice
   during this research). Needs a dashboard look; also: which org/tier is it in, and is that the
   tier prod should be on?
2. **Where exactly is the `supabase-prod` MCP read-only mode configured** (user-level MCP config,
   outside the repo) — and what does flipping it involve?
3. **What is the separate Render-connected repo** (name/owner), and can it serve two environments
   (branch per env) or would prod get its own? The repo's docs record its existence
   (HANDOFF.md:69-72) but not its identity.
4. **Full inventory of the live Render env** — the tables above are reconstructed from code reads
   and docs; the dashboard is the source of truth and nothing in the repo can confirm it
   (no export exists).
5. **Composio account structure** — whether webhook subscriptions are per-project (implying a
   second project for prod) needs verification against current Composio docs
   (repo docs record the SDK-only subscription fact as of 2026-07-02).
6. **Second Lightsail box budget/availability**, and whether the sandbox seat-pool model
   (pre-built cold sandboxes per purchased seat) transfers to prod as-is.
7. **Telegram bot naming/ownership for prod** (BotFather account, who owns the tokens) — not
   recorded in the repo.
8. **Is `DEFAULT_TENANT_ID`/`DEFAULT_TECHNICIAN_REF` needed on prod Render at all?** They're read
   only by the stdio entrypoint ([identity.ts:22-23](../../../src/mcp/identity.ts#L22-L23)); the
   deployed HTTP path uses signed headers. The pilot dashboard may or may not carry them —
   unverifiable from the repo.
