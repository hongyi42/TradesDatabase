# Control plane — lifecycle automation (Plan 2, 2026-07-02)

How the `technicians` roster drives the real world: badges to hosts, Composio Gmail pairings,
and grace-period offboarding. Companion docs: [nemoclaw-tech-agent.md](nemoclaw-tech-agent.md)
(§4 tool surface, §7 pairing rules), [doorman-runbook.md](doorman-runbook.md) (host side).

## The lifecycle at a glance

```
add_technician_seat            get_connect_link              resolve_review
(manager chat; two-step        (manager forwards URL,        (manager confirms the
 confirm since 2026-07-17 —     person approves OAuth)        mailbox address)
 NOTHING exists until the            │                             │
 confirming call)                    │                             │
      ▼                              │                             │
   INVITED ────────────────────▶ PENDING_VERIFICATION ────────▶ ACTIVE
      ▲                          (cron's checkPairing sweep      │ deactivate_technician_seat
      │  resolve_review           writes ca_*/ti_*/email,        │ (two-step confirm; stamps the
      │  DISMISSED = wrong        opens the review item)         │  clock, DISABLES the pairing,
      │  mailbox → unpair                                        ▼  badge revokes on next pull)
      │                                                     OFFBOARDING ──── reactivate_
      │                                                          │            technician_seat
      │                              grace period (GRACE_DAYS,   │            (the undo)
      │                              default 7; reminder at      │
      │                              2 days left)                ▼  cron expiry: Composio
      └──────────────────────────────────────────────────── OFFBOARDED     objects DELETED;
                                                             (permanent; ref never reused)
```

Badges flow separately: each host polls `GET /control/badges` (see the doorman runbook —
mint-on-first-pull, fingerprint-keyed file, revocation on deactivation). The same pull response
also carries a `bindings[]` array (Feature A) — the desired Telegram sender allowlist per sandbox,
which the host applies with no rebuild (see the rollout section below).

## The heartbeat: one Render Cron Job

`src/jobs/lifecycle.ts` (`npm run job:lifecycle`) runs its isolated sweeps and prints one
JSON summary line; a failed step exits 1 so Render marks the run failed. **The schedule TARGET
is `*/5` (code merged 2026-08-16; the Render schedule itself is a dashboard setting flipped at
the watcher rollout — until that flip the cron still fires `*/15` and every tick runs heavy).**
The code carries a stateless cadence gate: the heavy sweeps below run only on quarter-hour ticks
(`getUTCMinutes() % 15 < 5` — off-cadence ticks report `{skipped:'off-cadence tick'}` per step),
while the Stage-0 **watcher** (summary field `watchers`, gated on `WATCHERS_MODE`: unset =
skipped, `shadow` = count only, `live` = review items + one batched manager push; any other
value fails LOUD) runs on every tick. **The list below numbers itself independently of the
code** — the watcher runs last and is not in it — so the cron's JSON **field names**
(`watchers`, `costRollup`, …), never list positions, are the stable reference.
**The `deepinfraUsage` field was REMOVED 2026-08-19** with the provider. In `lifecycle.ts` the
step comments keep `(6)` as a RETIRED SLOT rather than compacting the numbers, so a doc or
runbook citing a step number does not silently come to mean a different step.
Full watcher semantics + rollout state: engineering-memory §3.

1. **Pairing sweep** — every `invited`/`pending_verification` row with a link issued gets
   `checkPairing` (detects completed OAuth consents; advances the row; opens the manager's
   verification item exactly once per episode).
2. **Grace-period expiry** — NULL-clock self-heal; "2 days left" reminder (once per episode);
   past-grace teardown (trigger, account, then the person's Composio session — per-row failure
   isolation, retried next tick).
   *(The former step 3, the schedule-sheet mirror sync, retired 2026-07-15 with the
   Telegram-schedule series Plan 1: the DB owns the schedule — `assignments` + the manager
   booking tools — and the Google Sheet is no longer an input. `SCHEDULE_SHEET_ID` /
   `GOOGLE_APPLICATION_CREDENTIALS` can be removed from the cron env.)*
3. **Session provisioning (since 2026-07-04)** — every ACTIVE roster row missing a
   `composio_session_id` gets its tier-scoped Composio session (`ensurePersonSession`,
   `src/composio/sessions.ts`; manager = full catalog + self-serve pairing, technician = pinned
   `direct_tools` list, send impossible). **Skipped cleanly when `COMPOSIO_API_KEY` is unset** —
   a cron deployed without the key reports `{skipped}` instead of going permanently red.
4. **Execution-log ingestion (since 2026-07-04)** — `runLogIngestion`
   (`src/composio/logIngest.ts`): pulls Composio's v3.1 tool-execution logs over an overlapping
   60-min window and appends state-changing actions into L1 (`outbound_email` / `agent_action`,
   keys-only redaction, `manager_only` sensitivity). Same `COMPOSIO_API_KEY` skip gate.

5. **Brave cost backfill (since 2026-07-25)** — replays `web_requests` rows with
   `kind='search'` into `cost_events`, from a WATERMARK (the newest billed Brave
   event, less a 1h overlap; from 2026-07-01 when the ledger is empty, so the
   first run after migration sweeps everything rather than the last few hours) (`backfillBraveCostEvents`,
   `src/db/costs.ts`). No live instrumentation needed: `web_requests` already carries the tenant,
   the person, and the timestamp. Reports rows **scanned** — the
   `(tenant, provider, sku, source_ref)` key makes a replay a no-op, so a steady tick inserts
   nothing.
6. **Cost rollup (since 2026-07-25)** — `rollupCosts` calls the `rollup_costs(period_start)`
   RPC for the current month **and the previous one** (invoices arrive after the month
   they cover, so a current-month-only rollup would never allocate a settled month): metered events priced at the rate in force *on the day each
   happened*, plus each `infra_costs` bill split by its own allocation rule
   (`per_spine_tool_call` divides the inference invoice by each tenant's spine tool-call count,
   **after** netting out what was already metered for that vendor — one inference account means
   the invoice already contains the spine's own tokens, and allocating it whole would count the
   same dollars twice. ⚠ Since 2026-08-19 NOTHING collects a Fireworks invoice, so there is no
   `infra_costs` row to allocate and the agent-inference line reads $0; the historical
   `deepinfra` rows and their `cost_rates` entries remain and still price correctly).
   Idempotent — it recomputes the period, so every tick refreshes what `/admin` reads.

   **Both steps report `{skipped}` rather than failing** when the cost tables are absent, so a
   deploy that lands before the migration does not turn the heartbeat red for a self-resolving
   condition. Neither needs a new environment variable.


## Render setup (dashboard, one-time)

1. **Web service** (existing): add `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_AUTH_CONFIG_ID`
   to its environment (get_connect_link + verification verdicts run there). Optional
   `COMPOSIO_RELAY_API_KEY` (a scoped project key) — the composio-doorman relay
   (`src/composio/relayHandler.ts`, since 2026-07-06) uses it for the Render→Composio leg,
   falling back to `COMPOSIO_API_KEY` when unset; with NEITHER set the relay answers a clean
   503 "not configured" (it never forwards keyless).
   **`OPS_ALERT_CHAT_ID`** (2026-08-18) — the operator's Telegram user id, where
   `POST /control/ops` incidents are pushed (`src/telegram/opsNotify.ts`, sent with the
   existing `BOARD_BOT_TOKEN`). **Unset = alerting silently OFF**: incidents are still
   recorded in `ops_events`, but nobody is told — which is precisely the gap that let eleven
   inference outages between 2026-08-13 and 2026-08-19 pass unnoticed. The recipient must
   have an existing 1:1 chat with the board bot or the send 403s.
   **Inference vars (2026-08-28):** the web service runs the four forced-tool callers
   (classify / extract / brief / answer), so it needs the SAME `INFERENCE_API_KEY`,
   `INFERENCE_BASE_URL` and `INFERENCE_MODEL` as the cron below. This was undocumented before
   the OpenRouter switch even though the requirement predates it.
   `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` stay set on BOTH services: with
   `MODEL_PROVIDER=anthropic` they are the one-variable rollback off OpenRouter entirely,
   which is the failure mode routing everything through a single aggregator introduces.
2. **New Cron Job service**, same repo/branch:
   - Build: `npm install && npm run build`
   - Command: `npm run job:lifecycle`
   - Schedule: `*/5 * * * *` (UTC; Render guarantees at most one concurrent run. `*/5` is the
     watcher-rollout target — flip it in the SAME dashboard visit that sets `WATCHERS_MODE`;
     the heavy sweeps self-gate to quarter-hour ticks, so do NOT "restore" `*/15`, which would
     merely slow the watcher.)
   - Environment — required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COMPOSIO_API_KEY`
     (without it, steps 1-2 still need it per-row for Composio calls, and steps 3-4 skip
     cleanly — see the step notes above).
     **TRAP — an env change on a Render CRON does NOT reach scheduled runs until you DEPLOY
     (hit live 2026-08-17, cost ~30 min of misdiagnosis).** Scheduled runs execute the last
     *deployed* version, which carries the environment captured at deploy time; saving a
     variable does not itself trigger a deploy, and a restart is not enough —
     "if you've recently updated your service's environment variables but haven't redeployed
     since then, restarting does _not_ incorporate those changes"
     (https://render.com/docs/deploys). What makes it genuinely deceptive: the dashboard's
     **Trigger Run** button DOES pick up the current env, so a manual test run behaves
     correctly while every scheduled run keeps using the old value — the symptom is a
     perfectly healthy log line reporting the WRONG mode. Diagnose by the scheduled run's log
     (`"watchers":{"mode":…}`), never by the dashboard field or a Trigger Run. **After ANY env
     change here — `WATCHERS_MODE`, `NUDGES_MODE`, the inference key — click Manual Deploy →
     "Deploy latest commit", then verify the next SCHEDULED run's log.**
     Optional: `GRACE_DAYS` (default 7). `WATCHERS_MODE` (`shadow` | `live`; unset = watcher
     step skipped — the shadow rollout REQUIRES setting this, see engineering-memory §3) and
     `BOARD_BOT_TOKEN` — **nothing on this cron uses it any more** (build 6 Phase 1,
     2026-09-01). The planner's count-only manager heads-up fired on applied escalations; the
     verb was deleted, so the push and its `pushSkipped` summary key went with it. The token is
     still live on OTHER services — the Calls worker and the web service's board/ops
     surfaces — and is set per-service, so do not clear it here on the strength of this line.
     Whether a generalized `send` reaching a manager needs a push of its own is build 6.5's
     decision.
     `NUDGES_MODE` (`shadow` | `live`; unset = the Stage-1 ladder is off and the watcher
     behaves exactly as Stage 0 — flip only per the Stage-1 rollout in the feature-B plan).
     **THE ASK WINDOW IS GONE** (2026-08-29). Until then, live-mode questions were composed
     only inside a firm-local 7 AM–7 PM window and an evening gap held until morning. There
     is no send-timing gate anywhere now: the PLANNER chooses the hour a message goes out.
     What replaced the window is a per-firm CADENCE (`PLANNER_TICK_MINUTES` /
     `PLANNER_TICK_MINUTES_OFF_HOURS` in `src/teamLead/planner.ts`) — half-hourly inside the
     firm's own approximate hours (`tenant_settings.approx_work_*`), 2-hourly outside them,
     and half-hourly always for a firm that has recorded none. It bounds how often the model
     is ASKED, never whether a message may go out. Detection, escalation, and
     delivery of already-composed rows are NOT window-gated.
     **Inference vars on this cron — LIVE ON OPENROUTER SINCE 2026-08-29 17:16 UTC:**
     `INFERENCE_API_KEY` (an OpenRouter key), `INFERENCE_BASE_URL=https://openrouter.ai/api/v1`,
     `INFERENCE_MODEL=z-ai/glm-5.3`, `MODEL_PROVIDER=openai`.
     **The code shipped on 2026-08-29 04:56 and the planner kept running Opus for twelve more
     hours**, because the env cutover is a SEPARATE step — seven successful ticks in that window
     all billed `anthropic`. Deploying the code is not switching the model. `MODEL_PROVIDER` is a
     SELECTOR
     (only the literal `anthropic` changes anything), NOT a key field; an API key pasted there
     does nothing. Set `INFERENCE_BASE_URL` explicitly anyway, so the service does not silently
     follow a code default that can change under it.
     **`INFERENCE_CACHE_KEY` IS NOW INERT and can be dropped.** It sent `prompt_cache_key`,
     an OpenAI-specific field OpenRouter ignores. Caching there comes from STICKY ROUTING
     instead — OpenRouter holds a model to one upstream for ~10 min to keep its cache warm,
     which needs no key. MEASURED 2026-08-28: 5888 of 5892 input tokens cached on the second
     call, $0.00805 -> $0.00155, a 5.2x reduction on the ~90% of planner input that is stable
     doctrine prefix.
     **NO `provider` block is sent, deliberately** — OpenRouter's docs state sticky routing is
     disabled by a manual provider order, so throughput-sorting the planner would buy marginal
     tps and cost that 5x. Failover is unaffected: one model id resolves to ~10 upstream
     providers (`z-ai/glm-5.3`) and OpenRouter falls through on any error, which is the whole
     reason for the move.
     **Rate ceiling to know about:** OpenRouter applies a per-model `new-account-rpm` cap
     (~20 req/min observed 2026-08-28; NOT cleared by the documented $10 lifetime-credit
     threshold — the account had $35 purchased and still hit it). The planner at twice-an-hour
     per firm is nowhere near it; bursty callers are the exposure, and OpenRouter 429s rather
     than queues.
     **When `NUDGES_MODE=live`, the cron ALSO needs the model-provider key**
     (`MODEL_PROVIDER` + `INFERENCE_API_KEY`, or `ANTHROPIC_API_KEY`): lifecycle step 9
     composes each nudge's question on this job. Without the key the step reports
     `{skipped: 'no inference credentials'}` — green, but NO question is ever written, so
     every nudge dies at the 24h delivery deadline into the manager queue. Provision the key
     in the SAME dashboard visit that sets `NUDGES_MODE=live`.
     **And provision a key that WORKS, not merely one that exists:** `hasModelCredentials()`
     is a presence check (`!!process.env.INFERENCE_API_KEY`), so a stale/suspended key does
     NOT skip the step — it runs and every compose throws, burning all 3 attempts (~15 min)
     before handing each gap to the manager with `failed: compose failed 3x`. Present-but-dead
     is worse than absent: the ladder looks enabled and the voice never speaks. Check the
     account is live (a suspended provider returns HTTP 412/402, not a credential error) and
     that the CRON service's own Environment tab carries it — web and cron are separate
     services with separate env, which has already cost one rollout.
     `SCHEDULE_SHEET_ID` / `GOOGLE_APPLICATION_CREDENTIALS`
     are no longer read (sheet sync retired 2026-07-15) and can be removed.
     It does NOT need `COMPOSIO_GMAIL_AUTH_CONFIG_ID` (only link *minting* on the web service
     reads it — the sweep never mints), `COMPOSIO_WEBHOOK_SECRET`, or
     `GATEWAY_IDENTITY_SECRET` — the job never receives webhooks or serves MCP.
3. Local dry-run: `npm run build && node -r dotenv/config dist/jobs/lifecycle.js`.

## The host's control routes (all host-pull-token bearer auth, bare 401)

- `GET /control/badges` — the roster-driven badge file + retirements + bindings (below).
- `POST /control/sandboxes` — recycle-completion report.
- `POST /control/ops` — health/incident report. The reporter is stateless (it sends its
  current status every tick) and `recordOpsEvent` folds those into ONE incident, so a
  transition to `opened`/`closed` — never a `suppressed` tick — pushes a Telegram alert to
  `OPS_ALERT_CHAT_ID`. The alert is best-effort and fires AFTER the 200: monitoring must
  never delay or break what it watches.
- `GET /control/nudges` + `POST /control/nudges` (Stage 1, 2026-08-16) — the voice's outbox:
  queued team-lead nudges for this host's sandboxes, served until the box acks delivery;
  the POST reports per-item `delivered`/`failed`. Box side: `nudge-runner.timer` (see
  `Box_Setup_Stuff/nudge-runner.sh`); kill switch `systemctl disable --now
  nudge-runner.timer`. Serving is NOT gated by `NUDGES_MODE` (that flag lives on the cron):
  rolling back the mode stops new nudges, but queued rows keep serving until the box timer
  is pulled or the 24h delivery deadline hands them to the manager.

## `GET /health` — what commit is actually live (no auth)

The only unauthenticated route on the web service, because its two consumers cannot hold a
token: Render's own zero-downtime deploy gate, and any external uptime monitor.

```bash
curl -s https://<web-service-host>/health
# {"status":"ok","commit":"<sha>","checks":{"db":"ok"}}
```

- **`commit`** is `RENDER_GIT_COMMIT` — the exact SHA serving traffic. `"unknown"` means the var
  was not injected (check the service env). This is the answer to "what code is running in
  prod", and it is the *only* one that reads the live system instead of a written record.
- **`status`/`checks.db`** come from a real `select` against the database, not a bare 200. A
  liveness check that answers while the DB is unreachable would let Render cut traffic to a
  broken deploy; `503` holds the old instance instead. Distinguish reachability from function.
- **Read it back after every deploy.** Render's "Redeploy" re-runs the *old* commit, and the
  services deploy from the **`Yu-C1` fork**, not from `origin` — so a merge on origin changes
  nothing here until the fork is synced (`docs/engineering-memory.md`, §"Render deploys from a
  FORK"). Compare this SHA against what you expect; the deploy button is not evidence.

## Badge rollout to a host (per host, one-time)

1. Server side: `node -r dotenv/config scripts/assign-host.mjs create-host name=<host>` —
   the pull token prints ONCE.
2. Assign people: `… assign ref=<ref> host=<host> sandbox=<sandbox_ref>`. Register any badge
   that already exists on the host: `… set-badge ref=<ref> hash=<sha256>` — unregistered
   entries are ERASED by the first pull.
3. Host side: upgrade the doorman to the fingerprint-lookup version (legacy hosts: the atomic
   rekey+restart step in doorman-runbook.md), then deploy `Box_Setup_Stuff/badge-pull.sh` per
   its header (root env file with the token, 5-min systemd timer). New badges land in
   `/root/pending-badges.jsonl` for provider-credential install.

Leaked badge: `… rotate-badge ref=<ref>` (old badge 403s within one poll; replacement mints in
that pull). Hand edits to badges.json on a pull host last at most one poll interval.

Empty-roster guard (2026-07-03, post-incident): `badge-pull.sh` refuses to replace a non-empty
badges.json with a 0-entry response — the systemd unit fails loudly and the last good file stays.
A deliberate full-roster wipe requires `ALLOW_EMPTY_BADGES=1` in `/etc/doorman/badge-pull.env`
(remove it again afterwards). The guard is covered by `src/control/badgePullScript.test.ts`.

Telegram bindings (Feature A): the manager's `bind_telegram` tool sets `telegram_user_id` on a
roster row; `badge-pull.sh` ships those as `bindings[]` and reconciles each into the sandbox's
allowlist via `Box_Setup_Stuff/apply-binding.sh` — a two-write recipe (host source-of-truth
`sandboxes.json` + rendered `openclaw.json` + `gateway restart`) that needs **no rebuild and no
device-key strip**, so it runs unattended. Applied state: `/etc/doorman/bindings-applied.json`;
a failed apply is isolated and retried next tick. Mechanism verified on a scratch sandbox
2026-07-07 (research doc `thoughts/shared/research/2026-07-03-cold-sandbox-identity-injection.md`).

## Operational notes

- **Connect links are ephemeral** (observed: expired within ~25 minutes) — the manager should
  forward one immediately and re-issue if it sits unused (5-min per-person cooldown applies).
- Deactivation cuts access instantly regardless of the cron (webhook roster gate + admin-tool
  tier gate read the DB row); the cron only handles the *scheduled* parts (reminder, teardown).
- `ca_*`/`ti_*` columns are kept after offboarding (audit); the Composio objects are deleted.
- Refs are never reused. Reactivating an offboarded person is impossible by design — add a
  new seat (new ref) instead.
