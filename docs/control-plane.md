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
value fails LOUD) runs on every tick. Note the numbered list below predates two later steps —
the DeepInfra bill pull sits between cost backfill and rollup, and the watcher runs last; the
cron's JSON **field names** (`deepinfraUsage`, `watchers`, …), not list numbers, are the stable
reference. Full watcher semantics + rollout state: engineering-memory §3.

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
   **after** netting out what was already metered for that vendor — one DeepInfra account means
   the invoice already contains the spine's own tokens, and allocating it whole would count the
   same dollars twice).
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
     `BOARD_BOT_TOKEN` (live-mode manager pushes; absent = `pushSkipped`, never red).
     `NUDGES_MODE` (`shadow` | `live`; unset = the Stage-1 ladder is off and the watcher
     behaves exactly as Stage 0 — flip only per the Stage-1 rollout in the feature-B plan).
     In live mode, questions are composed only inside the firm-local **ask window 7 AM–7 PM,
     seven days a week** (`ASK_WINDOW_*` in `src/teamLead/compose.ts`): a gap detected in the
     evening holds as a pending nudge (`held` in the step summary) and is composed fresh —
     correct "yesterday" wording — on the first morning tick. Detection, escalation, and
     delivery of already-composed rows are NOT window-gated.
     **Inference vars on this cron (Fireworks, set 2026-08-17):** `INFERENCE_API_KEY`,
     `INFERENCE_BASE_URL=https://api.fireworks.ai/inference/v1`,
     `INFERENCE_MODEL=accounts/fireworks/routers/glm-5p2-fast`,
     `INFERENCE_CACHE_KEY=tradesdb-spine`. Leave `MODEL_PROVIDER` UNSET — it is a SELECTOR
     (only the literal `anthropic` changes anything), NOT a key field; an API key pasted there
     does nothing. Without `INFERENCE_BASE_URL` the code defaults to DeepInfra's endpoint and a
     Fireworks key fails auth there. `INFERENCE_CACHE_KEY` is what earns the $0.21/M cached
     input instead of $2.10/M — Fireworks caches per replica, so keyless hits are routing luck.
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
- `POST /control/ops` — health/incident report.
- `GET /control/nudges` + `POST /control/nudges` (Stage 1, 2026-08-16) — the voice's outbox:
  queued team-lead nudges for this host's sandboxes, served until the box acks delivery;
  the POST reports per-item `delivered`/`failed`. Box side: `nudge-runner.timer` (see
  `Box_Setup_Stuff/nudge-runner.sh`); kill switch `systemctl disable --now
  nudge-runner.timer`. Serving is NOT gated by `NUDGES_MODE` (that flag lives on the cron):
  rolling back the mode stops new nudges, but queued rows keep serving until the box timer
  is pulled or the 24h delivery deadline hands them to the manager.

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
